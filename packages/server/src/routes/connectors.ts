/**
 * 连接器 REST API — 外部平台（QQ/NapCat OneBot v11）↔ 猫咖会话的绑定管理与消息接入。
 *
 * - POST/GET/DELETE /api/connectors/bindings — 群号/QQ ↔ session 映射增查删
 * - POST /api/connectors/onebot/webhook — 收 OneBot v11 HTTP 上报
 *   （立即 200 防 NapCat 超时重投，事件过滤与摄入放异步处理）
 */
import { createHash } from 'node:crypto'
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

  // ─── OneBot v11 webhook ────────────────────────

  app.post('/api/connectors/onebot/webhook', async (req, reply) => {
    if (!onebotEnabled()) {
      return reply.status(503).send({ error: 'OneBot connector is disabled' })
    }
    // P3 审查观察点 #3：webhook 暴露公网可被伪造注入——设置 ONEBOT_TOKEN 后要求鉴权。
    // 双路径（任一合法即过）：
    // 1. Authorization: Bearer <token>——既有路径（P3 测试钉死的契约）
    // 2. x-signature: sha1=<sha1(JSON.stringify(body))>——NapCat HTTP 上报实际发送的头
    //    （OneBot v11 标准上报签名；napcat.mjs 实锤 httpClient 只用 x-signature、
    //    WebSocket Client 才用 Bearer——P3 只测了 Bearer 路径，真实环境 401 必现，
    //    「测试输入源与真实环境不一致」第三次变体：出站 mock 无鉴权→403、入站 mock 带 Bearer→401）
    // 注：sha1 是纯 body 摘要（token 不参与）——完整性校验而非强认证，伪造者可自算；
    //     但 OneBot 标准如此（go-cqhttp 同款），与 Bearer 并存是 NapCat 兼容的必要妥协
    const token = onebotToken()
    if (token) {
      const auth = req.headers.authorization
      const authOk = typeof auth === 'string' && auth === `Bearer ${token}`
      if (!authOk) {
        const signature = req.headers['x-signature']
        const bodyJson = JSON.stringify(req.body) ?? ''
        const digest = createHash('sha1').update(bodyJson).digest('hex')
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

  // 3. 绑定查找：群用 group_id，私聊用 user_id
  const externalId = String(messageType === 'group' ? event.group_id : event.user_id)
  const binding = bindingsRepo.getConnectorBinding(PLATFORM_QQ, messageType, externalId)
  if (!binding) return // 无绑定的群/私聊静默忽略

  // 4. roster：绑定会话的 agent 名单（文本 @猫名 匹配用）
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

  // 5. 摄入（QQ 群友消息是真实对话 → 进向量记忆库，与前端消息同等对待）
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
