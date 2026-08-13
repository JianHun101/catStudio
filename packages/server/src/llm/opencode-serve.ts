import type { Chunk, ChatOptions, LLMMessage } from '@cat-study/shared'
import type { LLMAdapter } from './adapter.js'
import { resolveBin, messagesToPrompt, spawnSupervised, getWorkspaceDir } from './cli-utils.js'
import { createLogger } from '../logger.js'
import type { ChildProcess } from 'node:child_process'
import { request as httpRequest } from 'node:http'

const log = createLogger('opencode-serve')

interface OpencodeServeConfig {
  model: string
  /** 额外环境变量（per-agent 配置，如 HTTPS_PROXY 代理；registry 已宽容解析，此处收对象） */
  envExtra?: Record<string, string>
}

/** opencode CLI 二进制路径（模块加载时解析，与 opencode.ts 同款语义） */
let OPENCODE_BIN: string
try {
  OPENCODE_BIN = resolveBin('opencode', 'opencode-ai')
} catch (err: any) {
  log.warn('opencode CLI 未安装', { error: err.message })
  OPENCODE_BIN = ''
}

/** serve 端口分配基准：每实例递增（多 model 实例并行常驻，端口互不冲突） */
let NEXT_PORT = 4100

/** serve 启动就绪探测：总超时与轮询间隔 */
const READY_TIMEOUT_MS = 30_000
const READY_POLL_MS = 300

/** 文件类工具清单：permission ruleset 中 pattern 限工作目录内的工具（店长契约基础版） */
const FILE_TOOLS = ['read', 'edit', 'write', 'apply_patch', 'patch']

/** 长驻 serve 进程句柄 */
interface ServeHandle {
  child: ChildProcess
  port: number
  baseUrl: string
  /** 进程启动 cwd（session 的 path.cwd 跟随它，实测确认） */
  cwd: string
}

/** opencode serve 的 SSE 事件（GET /event 全局流，1.18.16 实测结构） */
interface ServeEvent {
  id?: string
  type?: string
  properties?: Record<string, any>
}

/** 拆 `provider/model` 字符串为 serve session 契约的 {providerID, modelID} */
function splitModel(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf('/')
  if (slash < 0) return { providerID: model, modelID: model }
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
}

/**
 * 构造 session 级 permission ruleset（店长契约基础版）。
 *
 * 实测事实：headless serve 无 ruleset 时工具调用默认全放行（read 越界读
 * C:\Windows\win.ini 直接 running、零 permission 请求事件）——安全敞口。
 * 本基础版注入两条策略：
 * - 文件类工具（read/edit/write/apply_patch/patch）：pattern 限工作目录内 allow
 *   （pattern 用绝对路径 + /** glob；pattern 匹配语义与未匹配规则的默认行为
 *   未实测——真机验收「写文件+读回」任务会暴露，见交接文档 OQ）
 * - bash：allow 全放行 + 审计（工具事件解析层 log 记录调用，见 mapEvent）
 *
 * 注意：ruleset 注入本身已实测（POST /session 带六条规则 200 通过并回显）。
 */
function buildPermissionRuleset(cwd: string) {
  const normalized = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  return [
    ...FILE_TOOLS.map((tool) => ({
      permission: tool,
      pattern: `${normalized}/**`,
      action: 'allow' as const,
    })),
    { permission: 'bash', pattern: '*', action: 'allow' as const },
  ]
}

/**
 * POST JSON 并等待完整响应——node:http 实现，替代 fetch（message 发送专用）。
 *
 * 为什么不用 fetch：undici（fetch 底层）默认 headersTimeout=300s，而 serve 的
 * message API 是「整轮 agent 完成才响应」语义（实测：短任务 3.3s 返回 200、
 * 长任务 2s 无响应头）——gpt-5.6-luna 长思考 5.1 分钟 > 300s，undici 掐断
 * 连接 → TypeError: fetch failed → serve 检测客户端断连 cancel 执行（店长四步
 * 实测实锤，luna猫 验收失败根因）。node:http 默认无客户端超时（socket
 * timeout 0），天然避开该机制。其余调用点（/session 创建、/event 订阅、
 * abort、DELETE）都是快响应/事件流场景，保持 fetch 不动。
 *
 * signal 语义对齐 fetch：abort → req.destroy(AbortError) → reject——外层取消
 * =用户取消，serve cancel 执行是预期行为，走 chatStream 现有 AbortError 路径。
 */
function postJson(
  url: string,
  body: unknown,
  signal?: AbortSignal
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = httpRequest(
      new URL(url),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(payload)),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          signal?.removeEventListener('abort', onAbort)
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') })
        })
      }
    )
    const onAbort = () => req.destroy(new DOMException('The operation was aborted', 'AbortError'))
    req.on('error', (err) => {
      // node:http 的 error message 自带 connect ECONNREFUSED 详情（比 fetch failed 诊断友好）
      signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    if (signal) {
      if (signal.aborted) {
        // 已 abort 的 signal：立即中断（对齐 fetch 语义——请求不发出）
        req.destroy(new DOMException('The operation was aborted', 'AbortError'))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    req.end(payload)
  })
}

/**
 * 收集 messages 里所有图片 → serve FilePartInput 数组。
 *
 * serve 的图片契约与 run 模式不同：FilePartInput {type:'file', mime, url}，
 * url 直接支持 data: base64 URL（实测 64x64 红图正确识别）——无需落盘、
 * 无 Windows 32K 命令行限制。全部图片附着在唯一一条发送消息上
 * （历史平铺成单条 text，图片无法与具体轮次关联——与 run 模式
 * messagesToPrompt 平铺模型对齐；但 run 只传最后一条 user 的图，
 * serve 可全量带上，能力更强）。
 */
function collectImageParts(messages: LLMMessage[]): { type: 'file'; mime: string; url: string }[] {
  const parts: { type: 'file'; mime: string; url: string }[] = []
  for (const m of messages) {
    for (const dataUrl of m.images ?? []) {
      const mimeMatch = /^data:(image\/[\w+-]+)/.exec(dataUrl)
      if (mimeMatch) {
        parts.push({ type: 'file', mime: mimeMatch[1], url: dataUrl })
      } else {
        // 无 MIME 前缀的裸 dataURL 跳过（无法构造合法 FilePartInput）——罕见路径
        log.warn('跳过无 MIME 前缀的图片 dataURL')
      }
    }
  }
  return parts
}

/**
 * opencode serve 适配器（headless agent 模式）。
 *
 * 与 opencode.ts（run 单轮适配器）的形态差异（店长阶段 2 拍板，实测报告依据）：
 * - run：每次调用 spawn 一个短命子进程（NDJSON stdout 流式）
 * - serve：长驻 HTTP server（懒启动，每 provider:model 一个实例 = 一个进程），
 *   HTTP POST 发消息 + SSE 订阅事件流；agent 工具循环在 opencode 内部自动
 *   多轮推进（实测 bash→apply_patch→read 全自动），猫咖只发消息 + 收事件
 *
 * chatStream 契约不变（AsyncIterable<Chunk>），registry 按 provider:model:envExtra
 * 缓存实例——「每 provider:model 一个长驻进程」由缓存键天然满足。
 *
 * 事件映射（店长契约，1.18.16 实测结构）：
 * - message.part.delta（assistant 消息，field=text）→ text chunk 实时产出
 * - message.part.updated（type=reasoning，text 非空）→ [思考] chunk
 *   （kind:'thinking' 前端折叠展示、不入库——对齐 claude.ts:222 / pi.ts:155）
 * - session.idle → 一轮完成 → done
 * - abort → POST /session/{id}/abort（中断 serve 侧执行）+ SSE 断连
 *
 * 安全：session 创建时注入 permission ruleset（见 buildPermissionRuleset）。
 * 上下文：每轮 chatStream 一个全新 session（serve 侧不积累历史，猫咖的
 * messages 参数是唯一上下文权威——多会话共享实例时不串上下文）。
 */
export class OpencodeServeAdapter implements LLMAdapter {
  readonly provider = 'opencode'
  private model: string
  private envExtra: Record<string, string>
  private serve: ServeHandle | null = null
  /** 就绪 Promise：并发首次调用共享同一次启动，不重复 spawn */
  private readyPromise: Promise<ServeHandle> | null = null

  constructor(config: OpencodeServeConfig) {
    this.model = config.model
    this.envExtra = config.envExtra ?? {}
  }

  /** 懒启动长驻 serve 进程（进程存活即复用；死亡下次调用重启） */
  private async ensureServer(): Promise<ServeHandle> {
    // 存活守卫：进程未退出（exitCode === null）直接复用句柄
    if (this.serve && this.serve.child.exitCode === null) return this.serve
    // 走到这 = 无句柄或进程已死。清掉死亡引用：serve 句柄 + 已 resolve 的旧
    // readyPromise——旧 Promise 已指向死亡句柄，不清理则第二守卫命中它直接
    // 返回死亡句柄，「死亡重启」永不发生（吐槽猫探针实证）。
    // 并发契约：只清「已 resolve 且进程已死」的状态，不误杀 in-flight 启动——
    // startServer 就绪前 this.serve 恒为 null（此处先清、就绪后才赋值），
    // 启动进行中时 readyPromise 为 pending，由下方守卫原样复用。
    if (this.serve) {
      this.serve = null
      this.readyPromise = null
    }
    if (this.readyPromise) return this.readyPromise
    this.readyPromise = this.startServer().catch((err) => {
      this.readyPromise = null // 启动失败可重试（下次调用重新 spawn）
      throw err
    })
    return this.readyPromise
  }

  private async startServer(): Promise<ServeHandle> {
    const port = NEXT_PORT++
    const baseUrl = `http://127.0.0.1:${port}`
    const cwd = getWorkspaceDir()

    log.info('启动 opencode serve', { port, model: this.model })

    // 长驻进程也用 supervisor 包装（防孤儿：server 被强杀时 serve 随之退出，
    // 端口不泄漏）；cwd = 工作目录（serve 进程启动目录即 session 的 path.cwd，
    // 实测确认——工具执行边界由 permission ruleset 承担）
    const child = spawnSupervised(
      OPENCODE_BIN,
      ['serve', '--port', String(port), '--hostname', '127.0.0.1'],
      {
        label: 'opencode-serve',
        cwd,
        env: { ...process.env, ...this.envExtra },
      }
    )

    let stderr = ''
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    // spawn 失败（ENOENT 等）：快速失败——不监听的话 exitCode 恒 null 且无
    // /doc 响应，要空转满 30s 就绪超时才报错（文案还误导为「启动超时」）
    let spawnFailed = ''
    child.on('error', (err) => {
      spawnFailed = err.message
    })

    // 就绪探测：轮询 GET /doc（轻量端点）直到 200 或超时；
    // 进程中途退出（端口被占/启动失败）直接报错，不空转等满超时
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (spawnFailed) {
        throw new Error(`opencode serve 无法启动: ${spawnFailed}`)
      }
      if (child.exitCode !== null) {
        const detail = stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ''
        throw new Error(`opencode serve 启动失败 (exit code ${child.exitCode})${detail}`)
      }
      try {
        const resp = await fetch(`${baseUrl}/doc`, { signal: AbortSignal.timeout(2000) })
        if (resp.ok) {
          this.serve = { child, port, baseUrl, cwd }
          log.info('opencode serve 就绪', { port, pid: child.pid })
          return this.serve
        }
      } catch {
        // 未就绪（连接拒绝/超时）——继续轮询
      }
      await new Promise((r) => setTimeout(r, READY_POLL_MS))
    }
    throw new Error(`opencode serve 启动超时 (${READY_TIMEOUT_MS / 1000}s)`)
  }

  async *chatStream(messages: LLMMessage[], options: ChatOptions): AsyncIterable<Chunk> {
    const signal = options.signal

    if (signal?.aborted) {
      yield { content: '', done: true }
      return
    }

    if (!OPENCODE_BIN) {
      yield {
        content: 'opencode CLI 未安装。请先运行: npm i -g opencode-ai && opencode auth login',
        done: true,
      }
      return
    }

    let sessionId: string | null = null
    let serve: ServeHandle | null = null
    let finished = false // idle 正常完成（不 abort）；断连/异常走 abort 兜底
    // 事件流订阅的 AbortController——函数级声明：message 发送抛错（用户 abort /
    // 网络错误）走 catch 早退时订阅已发起（先订阅后发消息时序），必须断连，
    // 否则 SSE 连接泄漏（serve 侧 ~10s heartbeat 保活，挂到 serve 进程死亡）
    let eventAbort: AbortController | null = null

    try {
      serve = await this.ensureServer()
      const modelStr = options.model || this.model
      const { providerID, modelID } = splitModel(modelStr)

      // 1. 创建 session（model + permission ruleset 注入）
      const sessResp = await fetch(`${serve.baseUrl}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: { id: modelID, providerID },
          permission: buildPermissionRuleset(serve.cwd),
        }),
      })
      if (!sessResp.ok) {
        const detail = (await sessResp.text().catch(() => '')).slice(0, 300)
        yield {
          content: `opencode serve 会话创建失败 (HTTP ${sessResp.status})${detail ? `: ${detail}` : ''}`,
          done: true,
        }
        return
      }
      const session = (await sessResp.json()) as { id?: string }
      sessionId = session.id ?? null
      if (!sessionId) {
        yield { content: 'opencode serve 会话创建失败: 响应缺少 session id', done: true }
        return
      }

      // 2. 先发起全局事件流订阅（不 await——SSE 长连接响应头到达才 resolve），
      //    再发消息——防事件丢失（消息响应快时事件先于订阅建立到达）。
      //    eventAbort（函数级声明）供所有早退路径断连：订阅已发起却丢弃会
      //    连接泄漏挂到服务端超时（吐槽猫探针实证），必须显式 abort；no-op
      //    catch 防早退路径下 abort 引起的 rejection 无人消费（unhandled rejection）。
      eventAbort = new AbortController()
      const eventRespPromise = fetch(`${serve.baseUrl}/event`, {
        signal: eventAbort.signal,
      })
      eventRespPromise.catch(() => {})

      // 3. 发送消息（历史平铺成单条 text + 全部图片 file parts）。
      //    postJson 而非 fetch：message API 是「整轮 agent 完成才响应」语义，
      //    undici 默认 headersTimeout=300s 会掐断长思考轮次（见 postJson 注释）
      const prompt = messagesToPrompt(messages)
      const imageParts = collectImageParts(messages)
      const msgResp = await postJson(
        `${serve.baseUrl}/session/${sessionId}/message`,
        { parts: [{ type: 'text', text: prompt }, ...imageParts] },
        signal
      )
      if (msgResp.status < 200 || msgResp.status >= 300) {
        eventAbort.abort() // 断开已发起的 SSE 订阅——不 abort 连接泄漏到服务端超时
        const detail = msgResp.text.slice(0, 300)
        yield {
          content: `opencode serve 消息发送失败 (HTTP ${msgResp.status})${detail ? `: ${detail}` : ''}`,
          done: true,
        }
        return
      }

      // 4. 消费事件流 → 映射 chunk
      const eventResp = await eventRespPromise
      if (!eventResp.ok || !eventResp.body) {
        yield {
          content: `opencode serve 事件流不可用 (HTTP ${eventResp.status})`,
          done: true,
        }
        return
      }

      finished = yield* this.consumeEvents(
        eventResp.body,
        sessionId,
        signal,
        options.chunkTimeoutMs
      )

      // 断连/超时等非 idle 终止：已产出的内容保留，但不产出错误文案
      // （serve 侧执行可能仍在跑，finally 会 abort 兜底）
    } catch (err: any) {
      // 早退路径断连事件流订阅（订阅已发起；不断则 SSE 连接泄漏——serve 侧
      // ~10s heartbeat 保活，挂到 serve 进程死亡）
      eventAbort?.abort()
      if (signal?.aborted || err?.name === 'AbortError') {
        yield { content: '', done: true }
        return
      }
      // cause 附详情：node:http 的 connect ECONNREFUSED / undici 的 fetch failed
      // 根因都在 cause 链上——旧文案只有瘦「fetch failed」，luna猫 故障排查时
      // 无详情可读（店长教训）
      const detail = err?.cause?.message ? `: ${err.cause.message}` : ''
      yield { content: `opencode serve 调用失败: ${err.message}${detail}`, done: true }
      return
    } finally {
      // 清理：未 idle 完成 → POST abort 中断 serve 侧仍在跑的执行（abort 幂等
      // 语义未实测，仅非完成态调用）；随后 DELETE session（serve 侧持久化，
      // 不清理会随长驻进程无限积累）。失败静默——清理是 best-effort。
      if (sessionId && serve) {
        if (!finished) {
          await fetch(`${serve.baseUrl}/session/${sessionId}/abort`, { method: 'POST' }).catch(
            () => {}
          )
        }
        await fetch(`${serve.baseUrl}/session/${sessionId}`, { method: 'DELETE' }).catch(() => {})
      }
    }

    if (signal?.aborted) {
      yield { content: '', done: true }
      return
    }
    yield { content: '', done: true }
  }

  /**
   * 消费 SSE 事件流并产出 Chunk。返回 true = session.idle 正常完成。
   *
   * 过滤三原则（1.18.16 实测结构）：
   * - 全局流按 properties.sessionID 过滤（GET /event 无 session 过滤参数，
   *   多会话共享实例时事件全量广播）
   * - assistant 消息过滤：用户消息自己的 part 快照也在流里（实测 noReply
   *   消息产生 message.part.updated{part.text='hello'}）——按 message.updated
   *   的 info.role 维护 assistant 消息 ID 集合，只产出 assistant 的 part
   * - reasoning 按 part.id 去重（updated 快照可能对同一 part 多次推送）
   */
  private async *consumeEvents(
    body: ReadableStream<Uint8Array>,
    sessionId: string,
    signal: AbortSignal | undefined,
    chunkTimeoutMs?: number
  ): AsyncGenerator<Chunk, boolean, unknown> {
    const assistantMsgIds = new Set<string>()
    const reasoningSeen = new Set<string>()
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    // abort → 断开 SSE 读循环（reader.cancel 让挂起的 read 以 done 返回）
    const onAbort = () => {
      reader.cancel().catch(() => {})
    }
    signal?.addEventListener('abort', onAbort)

    // 流读取超时：chunk 间最长停顿（serve 有 ~10s server.heartbeat 周期推送，
    // 默认 30s 不误杀；可经 chunkTimeoutMs 覆盖——推理模型思考停顿场景）
    const streamTimeoutMs = chunkTimeoutMs || 30_000

    let finished = false
    try {
      while (true) {
        if (signal?.aborted) break

        const chunkTimer = setTimeout(() => reader.cancel().catch(() => {}), streamTimeoutMs)
        let readResult: ReadableStreamReadResult<Uint8Array>
        try {
          readResult = await reader.read()
        } catch {
          break // cancel 触发——abort 或超时，循环终止
        } finally {
          clearTimeout(chunkTimer)
        }

        const { done, value } = readResult
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data: ')) continue
          let event: ServeEvent
          try {
            event = JSON.parse(trimmed.slice(6))
          } catch {
            continue
          }
          const props = event.properties ?? {}
          // 全局流按 session 过滤
          if (props.sessionID && props.sessionID !== sessionId) continue

          const chunk = this.mapEvent(event, assistantMsgIds, reasoningSeen)
          if (chunk) yield chunk
          if (event.type === 'session.idle') {
            finished = true
            break
          }
        }
        if (finished) break
      }
    } catch (err: any) {
      // 兜底：异常中断时已产出的内容保留，返回非完成态（finally 走 abort 清理）
      log.warn('opencode serve 事件流中断', { sessionId, error: err.message })
    } finally {
      signal?.removeEventListener('abort', onAbort)
      reader.cancel().catch(() => {})
    }
    return finished
  }

  /** 单事件 → Chunk（null = 不产出）。assistant 过滤 + reasoning 去重在此。 */
  private mapEvent(
    event: ServeEvent,
    assistantMsgIds: Set<string>,
    reasoningSeen: Set<string>
  ): Chunk | null {
    const props = event.properties ?? {}

    switch (event.type) {
      case 'message.updated': {
        // 维护 messageID → role 映射：assistant 消息的 part 才产出（用户消息
        // 自己的 part 快照也在流里，不过滤会把用户输入当回复输出）
        const info = props.info
        if (info?.role === 'assistant' && typeof info.id === 'string') {
          assistantMsgIds.add(info.id)
        }
        return null
      }
      case 'message.part.delta': {
        const part = props.part
        // assistant 消息的文本增量 → text chunk（field=text 实测结构）
        if (
          typeof part?.messageID === 'string' &&
          assistantMsgIds.has(part.messageID) &&
          part.field === 'text' &&
          typeof part.delta === 'string' &&
          part.delta
        ) {
          return { content: part.delta, done: false, kind: 'text' }
        }
        return null
      }
      case 'message.part.updated': {
        const part = props.part
        if (typeof part?.messageID !== 'string' || !assistantMsgIds.has(part.messageID)) {
          return null
        }
        if (part.type === 'reasoning') {
          // 思考：serve 模式无需 --thinking 默认输出（run 模式才需要开关，实测）；
          // gpt-5.6-luna 部分思考是加密形态（reasoningEncryptedContent、text 空）——
          // 以 text 非空为条件，空思考跳过；按 part.id 去重（快照可能多次推送）
          if (typeof part.text === 'string' && part.text && !reasoningSeen.has(part.id)) {
            reasoningSeen.add(part.id)
            return { content: `[思考] ${part.text}`, done: false, kind: 'thinking' }
          }
          return null
        }
        if (part.type === 'tool') {
          // bash 允许但留审计（店长契约）：工具执行状态落日志，不产出 chunk
          // input 实测是对象（bash: {command, workdir} / read: {filePath, ...}），
          // 序列化截断落日志，防大对象刷屏
          log.info('opencode-serve 工具调用', {
            tool: part.tool,
            status: part.state?.status,
            input: part.state?.input ? JSON.stringify(part.state.input).slice(0, 500) : undefined,
          })
          return null
        }
        return null
      }
      case 'session.idle':
        // 完成信号（会话进入 idle = 一轮结束）——consumeEvents 循环在此终止
        return null
      default:
        // server.connected / session.updated / server.heartbeat 等：静默跳过
        return null
    }
  }
}
