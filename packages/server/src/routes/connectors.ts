/**
 * 连接器 REST API — 外部平台（QQ/NapCat OneBot v11）↔ 猫咖会话的绑定管理与消息接入。
 *
 * - POST/GET/DELETE /api/connectors/bindings — 群号/QQ ↔ session 映射增查删
 * - POST /api/connectors/onebot/webhook — 收 OneBot v11 HTTP 上报
 *   （立即 200 防 NapCat 超时重投，事件过滤与摄入放异步处理）
 */
import { createHmac } from 'node:crypto'
import { connect } from 'node:net'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'
import {
  connectorBindings as bindingsRepo,
  sessions as sessionsRepo,
  agents as agentsRepo,
} from '../db/repository/index.js'
import { ingestUserMessage } from '../connectors/ingest.js'
import { parseOneBotMessage, type OneBotMessageEvent } from '../connectors/onebot.js'
import { createLogger } from '../logger.js'

const log = createLogger('connectors')

/** 当前接入的外部平台标识（绑定表 platform 字段）——OneBot 承载的即 QQ */
const PLATFORM_QQ = 'qq'

/**
 * P4 #4: externalId 归一化——QQ 群号/QQ 号天然是数字（调用方传 JSON number 直接 400 是
 * 不对称缺口：入站侧统一 String() 归一化查询）。接受 string | number，String() 归一化 +
 * 纯数字校验（/^\d+$/）。存储仍 string——与入站查询（handleOneBotEvent 同款归一化）对称。
 * @returns 合法时返回归一化 string；缺失/类型非法/含非数字 返回 null
 */
function normalizeExternalId(externalId: unknown): string | null {
  if (typeof externalId !== 'string' && typeof externalId !== 'number') return null
  const s = String(externalId)
  return /^\d+$/.test(s) ? s : null
}

// ─── P4 #5: webhook 消息去重 ────────────────────────
// NapCat 网络层重投（200 未达超时重投）会让同一条消息处理两次 → 重复摄入 +
// agent 重复回复 + 重复记忆。进程内 LRU 去重与进程生命周期匹配（重启后重投窗口早过，
// 无需落 DB）。边界：message_id 缺失/undefined/null → 跳过查重不误杀。
// 已知残余（非回归）：200 丢失 + 重启恰好落在 NapCat 重投窗口（秒级~10s）内双瞬态
// 叠加时可能双处理——修复前就存在的行为（原来压根无去重），内存方案不做持久化。
const DEDUP_TTL_MS = 10 * 60 * 1000 // 10 分钟
const DEDUP_MAX_SIZE = 1000 // 容量上限，驱逐最旧
/** message_id → 首次处理时间戳（Date.now() 逐条记，check/insert 时顺带清过期项） */
const dedupSeen = new Map<string, number>()

/**
 * 去重检查 + 标记。必须在 handleOneBotEvent 入口第一个 await 之前同步完成——
 * 重投窗口内两条请求并发到达（200 未达超时重投是秒级窗口），JS 单线程下
 * 同步段 check+insert 天然原子，无竞态。
 */
function isDuplicateMessage(event: OneBotMessageEvent): boolean {
  const raw = event.message_id
  // 缺失/非 string|number → 跳过查重不误杀（notice 等事件无 message_id 自然跳过）
  if (raw === undefined || raw === null) return false
  const key = String(raw) // OneBot v11 标准 message_id 为 number——归一化后键稳定
  const now = Date.now()
  // 顺带清过期项（不能只有容量驱逐——否则「过期后可再次处理」无法验证/发生）
  for (const [k, ts] of dedupSeen) {
    if (now - ts >= DEDUP_TTL_MS) dedupSeen.delete(k)
  }
  if (dedupSeen.has(key)) return true
  dedupSeen.set(key, now)
  // 容量上限：驱逐最旧（Map 迭代序 = 插入序）。极端高频（>100 条/分）下驱逐
  // 会早于 TTL 到期——但重投窗口是秒级，驱逐最旧条目，影响趋零
  if (dedupSeen.size > DEDUP_MAX_SIZE) {
    const oldest = dedupSeen.keys().next().value
    if (oldest !== undefined) dedupSeen.delete(oldest)
  }
  return false
}

/** 测试钩子：清空去重表（仅测试用，生产路径不调用） */
export function __test_resetOneBotDedup(): void {
  dedupSeen.clear()
}

function onebotEnabled(): boolean {
  return process.env.ONEBOT_ENABLED !== 'false'
}

/** webhook 鉴权 token——设置后要求 Authorization: Bearer <token>；留空不校验（向后兼容） */
function onebotToken(): string {
  return process.env.ONEBOT_TOKEN || ''
}

/**
 * 白名单模式——ONEBOT_ALLOWLIST 配置且非空时，发送者 QQ 号必须在白名单内才处理
 * （群聊 + 私聊统一；配置即启用，未配置/空串 → 关闭，现状兼容）。
 * 解析：逗号分隔 QQ 号，trim + 过滤空段 + 去重；每次调用现解析（消息频率低，不缓存）
 */
function onebotAllowlist(): Set<string> {
  const raw = process.env.ONEBOT_ALLOWLIST || ''
  const ids = new Set<string>()
  for (const part of raw.split(',')) {
    const trimmed = part.trim()
    if (trimmed) ids.add(trimmed)
  }
  return ids
}

// ─── NapCat 生命周期薄桥 ─────────────────────────
// 架构决策（2026-08）：NapCat 是独立程序，server 永不 spawn——连接器进程生命周期归
// 部署脚本层（开发 dev.js / 生产守护进程）。本文件只做两件薄事：GET status（只读
// 探测，零副作用）+ POST control（写 .napcat-request 请求文件，dev.js 轮询执行启停）。
// 请求文件定位与 restart-request.ts 同款：RESTART_FILES_DIR ?? cwd（pnpm dev 时
// cwd=ROOT 与 dev.js 轮询路径一致；测试经 vitest env 隔离）。函数内动态求值而非
// 模块顶层常量——测试可 vi.stubEnv 即时隔离，生产路径行为一致。
const NAPCAT_PROBE_TIMEOUT_MS = 1500

function napcatRequestFile(): string {
  return resolve(process.env.RESTART_FILES_DIR ?? process.cwd(), '.napcat-request')
}

/** .napcat-config.json 定位——与 napcatRequestFile 同款 RESTART_FILES_DIR ?? cwd（测试隔离现成） */
function napcatConfigFile(): string {
  return resolve(process.env.RESTART_FILES_DIR ?? process.cwd(), '.napcat-config.json')
}

/**
 * 读 .napcat-config.json（页面「NapCat 启动路径」保存的配置，dev.js loadNapcatConfig 同契约）。
 * 容错：无文件/坏 JSON/字段缺失 → { napcatPath: '' }——配置缺失不是错误态，launchReady
 * 判定与 GET config 都依赖「读失败 = 未配置」的降级语义。
 */
function readNapcatConfig(): { napcatPath: string } {
  try {
    const file = napcatConfigFile()
    if (!existsSync(file)) return { napcatPath: '' }
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    return { napcatPath: typeof parsed.napcatPath === 'string' ? parsed.napcatPath : '' }
  } catch {
    return { napcatPath: '' }
  }
}

/** TCP 端口探测（status 的 running 字段）——短超时，适配前端 3s 轮询节奏 */
function probePort(
  host: string,
  port: number,
  timeoutMs = NAPCAT_PROBE_TIMEOUT_MS
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

export async function connectorRoutes(app: FastifyInstance): Promise<void> {
  // ─── 绑定管理 ──────────────────────────────────

  app.post('/api/connectors/bindings', async (req, reply) => {
    const body = req.body as any
    if (!body || typeof body !== 'object') {
      return reply.status(400).send({ error: 'Request body is required' })
    }
    const { platform, externalType, sessionId } = body
    if (typeof platform !== 'string' || !platform) {
      return reply.status(400).send({ error: 'platform is required (string)' })
    }
    if (externalType !== 'group' && externalType !== 'private') {
      return reply.status(400).send({ error: "externalType must be 'group' or 'private'" })
    }
    // P4 #4: externalId 接受 string | number（QQ 群号/QQ 号天然是数字），归一化 + 纯数字校验
    const externalId = normalizeExternalId(body.externalId)
    if (!externalId) {
      return reply.status(400).send({ error: 'externalId is required (numeric string or number)' })
    }
    if (typeof sessionId !== 'string' || !sessionId) {
      return reply.status(400).send({ error: 'sessionId is required (string)' })
    }
    const session = sessionsRepo.getSessionById(sessionId)
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' })
    }
    const binding = bindingsRepo.upsertConnectorBinding(
      platform,
      externalType,
      externalId,
      sessionId
    )
    return reply.status(201).send({ ok: true, binding })
  })

  app.get('/api/connectors/bindings', async (req, reply) => {
    const { platform } = req.query as { platform?: string }
    const bindings = bindingsRepo.listConnectorBindings(
      typeof platform === 'string' && platform ? platform : undefined
    )
    return reply.send({ ok: true, bindings })
  })

  app.delete('/api/connectors/bindings', async (req, reply) => {
    const body = req.body as any
    if (!body || typeof body !== 'object') {
      return reply.status(400).send({ error: 'Request body is required' })
    }
    const { platform, externalType } = body
    if (typeof platform !== 'string' || !platform) {
      return reply.status(400).send({ error: 'platform is required (string)' })
    }
    if (externalType !== 'group' && externalType !== 'private') {
      return reply.status(400).send({ error: "externalType must be 'group' or 'private'" })
    }
    // P4 #4: externalId 接受 string | number（与 POST 同款归一化 + 纯数字校验）
    const externalId = normalizeExternalId(body.externalId)
    if (!externalId) {
      return reply.status(400).send({ error: 'externalId is required (numeric string or number)' })
    }
    const removed = bindingsRepo.deleteConnectorBinding(platform, externalType, externalId)
    if (!removed) {
      return reply.status(404).send({ error: 'Binding not found' })
    }
    return reply.send({ ok: true })
  })

  // ─── NapCat 生命周期薄桥（零 spawn） ─────────────

  // 只读状态：env 值 + apiBase 端口可达性探测。TOKEN 只返回服务端脱敏的掩码，
  // 完整 token 永不出 server。running 是瞬时探测（1.5s 超时），前端启停后 3s×10
  // 轮询本接口等状态翻转。
  app.get('/api/connectors/onebot/status', async (req, reply) => {
    const apiBase = process.env.ONEBOT_API_BASE || 'http://127.0.0.1:3000'
    let host = '127.0.0.1'
    let port = 3000
    try {
      const u = new URL(apiBase)
      host = u.hostname
      port = parseInt(u.port, 10) || 80
    } catch {}
    const token = process.env.ONEBOT_TOKEN || ''
    const launchCmd = (process.env.NAPCAT_LAUNCH_CMD || '').trim()
    // launchReady = 启动命令就绪：模板非空且（无 {NAPCAT_PATH} 占位符 → 完整命令行直接
    // 就绪；含占位符 → 页面保存的路径已配置）。前端 start 按钮禁用态与引导文案以此为准。
    let launchReady = false
    if (launchCmd) {
      launchReady = !launchCmd.includes('{NAPCAT_PATH}') || !!readNapcatConfig().napcatPath.trim()
    }
    const running = await probePort(host, port)
    return reply.send({
      ok: true,
      enabled: onebotEnabled(),
      apiBase,
      running,
      launchCmdConfigured: !!launchCmd,
      launchReady,
      tokenConfigured: !!token,
      tokenMasked: token ? `${token.slice(0, 4)}****` : '',
    })
  })

  // 启停控制：校验 action 后写 .napcat-request 请求文件（dev.js fs.watch + 5s 兜底
  // 轮询消费，执行后删除）。动作本身在 dev.js 侧幂等（start 有端口探测、stop 无 pid
  // 文件即 no-op）——重复写文件无害，202 即「已受理」。
  app.post('/api/connectors/napcat/control', async (req, reply) => {
    const body = req.body as any
    if (!body || typeof body !== 'object' || (body.action !== 'start' && body.action !== 'stop')) {
      return reply.status(400).send({ error: "action must be 'start' or 'stop'" })
    }
    const file = napcatRequestFile()
    mkdirSync(dirname(file), { recursive: true }) // 测试隔离目录可能不存在（生产 cwd 已存在 no-op）
    writeFileSync(
      file,
      JSON.stringify({ action: body.action, createdAt: new Date().toISOString() }, null, 2)
    )
    return reply.status(202).send({ ok: true })
  })

  // ─── NapCat 启动路径配置（.napcat-config.json，dev.js 启动时读） ────────
  // 路径存配置文件而非 .env：.env 启动时读取、改需重启；配置文件每次拉起时动态读，
  // 页面保存后点「启动」立即生效。浏览器 file input 拿不到本地绝对路径（安全沙箱），
  // 故页面是路径输入框 + server stat 存在性校验，不是文件选择器。server 只读写 JSON
  // 零 spawn（与写 .napcat-request 同族）。

  app.get('/api/connectors/napcat/config', async (req, reply) => {
    const { napcatPath } = readNapcatConfig()
    let pathExists: boolean | null = null
    if (napcatPath.trim()) {
      try {
        pathExists = statSync(napcatPath.trim()).isFile()
      } catch {
        pathExists = false // stat 失败 = 路径不存在（文件被删/盘未挂载）
      }
    }
    return reply.send({ ok: true, napcatPath, pathExists })
  })

  app.post('/api/connectors/napcat/config', async (req, reply) => {
    const body = req.body as any
    if (!body || typeof body !== 'object' || typeof body.napcatPath !== 'string') {
      return reply.status(400).send({ error: 'napcatPath is required (string)' })
    }
    const napcatPath = body.napcatPath.trim()
    if (!napcatPath) {
      return reply.status(400).send({ error: 'napcatPath is required' })
    }
    try {
      statSync(napcatPath) // 存在性校验（stat 抛错 = 不存在）——不校验可执行性，那属启动时
    } catch {
      return reply.status(400).send({ error: '路径不存在' })
    }
    const file = napcatConfigFile()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(
      file,
      JSON.stringify({ napcatPath, updatedAt: new Date().toISOString() }, null, 2)
    )
    return reply.send({ ok: true, napcatPath })
  })

  // ─── OneBot v11 webhook ────────────────────────

  app.post('/api/connectors/onebot/webhook', async (req, reply) => {
    if (!onebotEnabled()) {
      return reply.status(503).send({ error: 'OneBot connector is disabled' })
    }
    // P3 审查观察点 #3：webhook 暴露公网可被伪造注入——设置 ONEBOT_TOKEN 后要求鉴权。
    // 双路径（任一合法即过）：
    // 1. Authorization: Bearer <token>——既有路径（P3 测试钉死的契约）
    // 2. x-signature: sha1=<HMAC-SHA1(token, body)>——NapCat HTTP 上报实际发送的头
    //    （OneBot v11 标准上报签名；napcat.mjs 实锤 httpClient 只用 x-signature、
    //    WebSocket Client 才用 Bearer——P3 只测了 Bearer 路径，真实环境 401 必现，
    //    「测试输入源与真实环境不一致」第三次变体：出站 mock 无鉴权→403、入站 mock 带 Bearer→401）
    // 注：x-signature 是 HMAC-SHA1(key=token, body)——token 参与计算，是真实认证；
    //     OneBot v11 标准如此（napcat.mjs 源码实锤 _L = createHmac，go-cqhttp 同款）。
    //     历史教训：eff72eb 曾误判为 createHash 纯摘要（token 不参与）致 401 必现——源码解读必须追 import 定义
    const token = onebotToken()
    if (token) {
      const auth = req.headers.authorization
      const authOk = typeof auth === 'string' && auth === `Bearer ${token}`
      if (!authOk) {
        const signature = req.headers['x-signature']
        const bodyJson = JSON.stringify(req.body) ?? ''
        const digest = createHmac('sha1', token).update(bodyJson).digest('hex')
        // 前缀大小写不敏感（OneBot 标准 NapCat 发小写 sha1=）——归一化前缀后再比摘要
        const sigOk =
          typeof signature === 'string' &&
          signature.toLowerCase().startsWith('sha1=') &&
          signature.slice(5).toLowerCase() === digest
        if (!sigOk) {
          return reply.status(401).send({ error: 'Unauthorized' })
        }
      }
    }
    const event = req.body as OneBotMessageEvent | undefined
    if (!event || typeof event !== 'object') {
      return reply.status(400).send({ error: 'Event body is required' })
    }

    // 立即 200——NapCat 上报超时会重投；事件过滤/绑定查找/摄入放异步处理
    reply.send({ ok: true })

    try {
      await handleOneBotEvent(event)
    } catch (err: any) {
      // 处理失败不回 5xx（响应已发）——记录日志，NapCat 侧视为已接收
      log.error('onebot event processing failed', { error: err.message })
    }
  })
}

/**
 * 处理一条 OneBot 事件：过滤 → 绑定查找 → 解析 → 摄入。
 * 所有不符合条件的输入在此静默返回（无绑定群/私聊、自消息、非 message 事件、
 * 群聊未 @机器人）——webhook 仍已 200，NapCat 不会重投。
 */
async function handleOneBotEvent(event: OneBotMessageEvent): Promise<void> {
  // P4 #5: 去重放最入口（过滤之前）——notice 事件无 message_id 自然跳过。
  // 同步段 check+insert 在第一个 await 前完成（入口到 ingestUserMessage 之间
  // 零 await），重投窗口内并发到达的两条请求无竞态
  if (isDuplicateMessage(event)) {
    log.info('duplicate onebot event skipped', { messageId: String(event.message_id) })
    return
  }
  // 1. 只处理 message 事件（notice/request 等忽略）
  if (event.post_type !== 'message') return
  // 2. 防自循环：机器人自己发的消息忽略
  if (event.user_id !== undefined && String(event.user_id) === String(event.self_id)) return

  const messageType = event.message_type
  if (messageType !== 'group' && messageType !== 'private') return

  // 3. 白名单模式（配置且非空时开启）：发送者 QQ 号必须在白名单内——群聊 + 私聊统一
  // （授权检查独立于绑定，放绑定查找前更早短路；白名单外静默忽略 + log.info 留痕供排查）
  const allowlist = onebotAllowlist()
  if (allowlist.size > 0 && !allowlist.has(String(event.user_id))) {
    log.info('sender not in allowlist, skipped', { userId: String(event.user_id) })
    return
  }

  // 4. 绑定查找：群用 group_id，私聊用 user_id
  const externalId = String(messageType === 'group' ? event.group_id : event.user_id)
  const binding = bindingsRepo.getConnectorBinding(PLATFORM_QQ, messageType, externalId)
  if (!binding) return // 无绑定的群/私聊静默忽略

  // 5. roster：绑定会话的 agent 名单（文本 @猫名 匹配用）
  const session = sessionsRepo.getSessionById(binding.session_id)
  if (!session) {
    // 绑定指向的会话已被删除（绑定无 FK，成为孤儿）——静默忽略
    log.warn('binding points to missing session', {
      bindingId: binding.id,
      sessionId: binding.session_id,
    })
    return
  }
  const roster = sessionsRepo
    .getSessionAgentIds(binding.session_id)
    .map((id) => agentsRepo.getAgentById(id)?.name)
    .filter((n): n is string => !!n)

  const parsed = parseOneBotMessage(event, { roster, selfId: event.self_id, messageType })
  if (!parsed) return

  // 6. 摄入（QQ 群友消息是真实对话 → 进向量记忆库，与前端消息同等对待）
  const result = await ingestUserMessage({
    sessionId: binding.session_id,
    content: parsed.content,
    mentions: parsed.mentions,
    saveMemory: true,
  })
  if (!result.ok) {
    log.warn('onebot ingest failed', {
      sessionId: binding.session_id,
      status: result.status,
      error: result.error,
    })
  }
}
