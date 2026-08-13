import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { Readable } from 'node:stream'
import { createServer } from 'node:http'
import type { Chunk } from '@cat-study/shared'

// Mock cli-utils 以阻止模块加载时的 resolveBin() 调用
vi.mock('./cli-utils.js', () => ({
  resolveBin: vi.fn(() => 'C:/Users/test/AppData/Roaming/npm/opencode.exe'),
  messagesToPrompt: vi.fn(() => 'User: hello\n\nAssistant: hi'),
  spawnSupervised: vi.fn(),
  getWorkspaceDir: vi.fn(() => 'D:/workspace'),
}))

// Logger mock：log 对象用 vi.hoisted 共享——测试用例需断言 log.info 调用参数（审计用例）
const logMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../logger.js', () => ({
  createLogger: () => logMocks,
}))

import { OpencodeServeAdapter } from './opencode-serve.js'
import { spawnSupervised } from './cli-utils.js'

/** 收集 async generator 的值 */
async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = []
  for await (const item of gen) {
    results.push(item)
  }
  return results
}

/**
 * 构造 fake serve 子进程（长驻：exitCode 恒 null，除非测试覆盖）。
 * on/once 真实注册事件回调；emitError 模拟 spawn error 派发。
 */
function fakeChild(overrides: Partial<{ exitCode: number | null }> = {}) {
  const stderr = new Readable({ read() {} })
  const listeners = new Map<string, Set<(...args: any[]) => void>>()
  const register = (event: string, cb: (...args: any[]) => void) => {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event)!.add(cb)
  }
  const emitError = (err: Error) => {
    for (const cb of listeners.get('error') ?? []) cb(err)
  }
  const child = {
    stderr,
    kill: vi.fn(),
    on: vi.fn(register),
    once: vi.fn(register),
    emitError,
    exitCode: null,
    killed: false,
    ...overrides,
  }
  return child
}

/** opencode serve 的 SSE 事件（GET /event 实测结构：{id,type,properties:{sessionID,...}}） */
function sseEvent(type: string, properties: Record<string, any>): string {
  return `data: ${JSON.stringify({ id: 'evt_test', type, properties })}\n\n`
}

/** 可手动推事件的 SSE 流（node Readable → web stream） */
function makeEventStream(): {
  stream: ReadableStream<Uint8Array>
  push: (s: string) => void
  end: () => void
} {
  const nodeStream = new Readable({ read() {} })
  return {
    stream: Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>,
    push: (s: string) => nodeStream.push(s),
    end: () => nodeStream.push(null),
  }
}

const TEST_SESSION = 'ses_test1'

/** 默认 fetch mock：按 URL 路由（就绪探测 /doc、session、message、event、abort、delete） */
function stubFetch(
  overrides: {
    sessionStatus?: number
    eventStream?: ReadableStream<Uint8Array>
    /** /doc 连接拒绝（真实 spawn ENOENT 场景：进程从未启动，探测必然连不上） */
    docUnreachable?: boolean
  } = {}
) {
  const calls: { url: string; init?: RequestInit }[] = []
  const eventStream = overrides.eventStream ?? makeEventStream().stream
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const method = init?.method ?? 'GET'
    const u = String(url)

    if (method === 'GET' && u.endsWith('/doc')) {
      if (overrides.docUnreachable) throw new TypeError('fetch failed')
      return new Response('{}', { status: 200 })
    }
    if (method === 'POST' && u.endsWith('/session')) {
      return new Response(JSON.stringify({ id: TEST_SESSION }), {
        status: overrides.sessionStatus ?? 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    // 注意：POST /message 不在 fetch mock 里——适配器走 node:http（postJson），
    // 由下方 fleet 真实 http server 承接（messageServerConfig/messageRequests）
    if (method === 'GET' && u.endsWith('/event')) {
      return new Response(eventStream, { status: 200 })
    }
    if (method === 'POST' && u.includes('/abort')) {
      return new Response('{}', { status: 200 })
    }
    if (method === 'DELETE') {
      return new Response('{}', { status: 200 })
    }
    return new Response('not found', { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, calls }
}

// ─── 真实 http server 接管 POST message ──────────────────────────
// postJson（node:http 实现）不走 fetch mock——message 发送相关用例必须由真实
// http server 承接，验证真实 socket 路径：挂起响应（无响应头）不被短超时掐断
// + abort 中断在途请求。
//
// 端口占用说明：共享模块 NEXT_PORT 从 4100 起每次 startServer 递增，而 4100
// 被生产 serve 长期占用（长驻适配器实例缓存，server 运行期间不释放）。
// beforeAll 的预热 chatStream（session 500 路径，全 fetch mock 化、零真实
// 连接）先消耗 4100——测试用例实际从 4101 起。fleet 绑定 4100-4129，已占用
// 端口 listen 失败静默跳过（CI 无生产 serve 时 4100 也能绑上，无碍）。
const FLEET_START = 4100
const FLEET_END = 4129

/** message POST 的响应配置（beforeEach 重置） */
const messageServerConfig: { status: number; delayMs: number; hang: boolean } = {
  status: 200,
  delayMs: 0,
  hang: false,
}

/** 真实 server 收到的请求记录（按端口） */
const messageRequests: { port: number; method: string; url: string; body: string }[] = []

const fleetServers: ReturnType<typeof createServer>[] = []

beforeAll(async () => {
  for (let port = FLEET_START; port <= FLEET_END; port++) {
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c.toString()))
      req.on('end', () => {
        messageRequests.push({ port, method: req.method ?? '', url: req.url ?? '', body: raw })
        if (messageServerConfig.hang) {
          // 永不响应（无响应头挂起）——供 abort 用例驱动在途请求中断。
          // 注意不可在 req 'close' 里 res.destroy()：IncomingMessage 的 'close'
          // 在请求体收完即触发（非客户端断连），会立即掐断连接。客户端
          // destroy 时 socket 自行关闭，无需服务端清理。
          return
        }
        const respond = () => {
          res.writeHead(messageServerConfig.status, { 'Content-Type': 'application/json' })
          res.end('{}')
        }
        if (messageServerConfig.delayMs > 0) setTimeout(respond, messageServerConfig.delayMs)
        else respond()
      })
    })
    server.on('error', () => {}) // 已占用端口（EADDRINUSE）静默——见端口占用说明
    await new Promise<void>((resolve) => {
      server.once('error', resolve) // listen 失败也放行（端口被生产 serve 占用）
      server.listen(port, '127.0.0.1', resolve)
    })
    fleetServers.push(server)
  }

  // 预热消耗 4100：一次「session 创建失败」的 chatStream——startServer 把
  // NEXT_PORT 从 4100 推进到 4101（全 fetch mock、无真实连接，不触碰真实 serve）
  const preheatStream = makeEventStream()
  stubFetch({ sessionStatus: 500, eventStream: preheatStream.stream })
  const preheatChild = fakeChild()
  vi.mocked(spawnSupervised).mockReturnValueOnce(preheatChild as any)
  const preheatAdapter = new OpencodeServeAdapter({ model: 'opencode-go/gpt-5.6-luna' })
  await collect(
    preheatAdapter.chatStream([{ role: 'user', content: 'preheat' }], {
      model: 'opencode-go/gpt-5.6-luna',
    })
  )
  vi.unstubAllGlobals()
})

afterAll(async () => {
  await Promise.all(
    fleetServers.map(
      (s) =>
        new Promise<void>((resolve) => {
          if (!s.listening) return resolve()
          s.close(() => resolve())
        })
    )
  )
})

describe('OpencodeServeAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // 响应配置重置：每个用例独立（挂起/500/永不响应）
    messageServerConfig.status = 200
    messageServerConfig.delayMs = 0
    messageServerConfig.hang = false
    messageRequests.length = 0
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  // ─── 构造 ────────────────────────────────────

  it('stores provider name', () => {
    const adapter = new OpencodeServeAdapter({ model: 'opencode-go/gpt-5.6-luna' })
    expect(adapter.provider).toBe('opencode')
  })

  // ─── 外部取消（前置已 abort）─────────────────

  it('yields done immediately when signal is already aborted', async () => {
    const { fetchMock } = stubFetch()
    const adapter = new OpencodeServeAdapter({ model: 'opencode-go/gpt-5.6-luna' })
    const controller = new AbortController()
    controller.abort()

    const chunks = await collect(
      adapter.chatStream([{ role: 'user', content: 'hi' }], {
        model: 'opencode-go/gpt-5.6-luna',
        signal: controller.signal,
      })
    )

    expect(chunks).toEqual([{ content: '', done: true }])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(spawnSupervised).not.toHaveBeenCalled()
  })

  // ─── 未安装提示 ─────────────────────────────

  it('yields friendly install hint when CLI is not installed (resolveBin fails)', async () => {
    vi.resetModules()
    const freshCliUtils = await import('./cli-utils.js')
    vi.mocked(freshCliUtils.resolveBin).mockImplementation(() => {
      throw new Error('not found')
    })
    const { OpencodeServeAdapter: FreshAdapter } = await import('./opencode-serve.js')
    const adapter = new FreshAdapter({ model: 'opencode-go/gpt-5.6-luna' })

    const chunks = await collect(
      adapter.chatStream([{ role: 'user', content: 'hi' }], {
        model: 'opencode-go/gpt-5.6-luna',
      })
    )

    expect(chunks[0].content).toContain('opencode CLI 未安装')
    expect(chunks[0].content).toContain('npm i -g opencode-ai')
    expect(freshCliUtils.spawnSupervised).not.toHaveBeenCalled()
  })

  // ─── 正常流式（session → message → SSE → idle → done）─────

  it('streams assistant text deltas and finishes with done on session.idle', async () => {
    const stream = makeEventStream()
    stubFetch({ eventStream: stream.stream })
    const adapter = new OpencodeServeAdapter({ model: 'opencode-go/gpt-5.6-luna' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'opencode-go/gpt-5.6-luna',
    })
    const chunksPromise = collect(gen)

    // 等事件流订阅建立（GET /event 被 fetch）再推事件——否则事件先于订阅丢失
    await vi.waitFor(() => {
      expect(vi.mocked(spawnSupervised)).toHaveBeenCalled()
    })

    // 1.18.16 实测事件序：message.updated（assistant 登记）→ part.delta 流式 → session.idle
    stream.push(
      sseEvent('message.updated', {
        sessionID: TEST_SESSION,
        info: { id: 'msg_a1', role: 'assistant' },
      })
    )
    stream.push(
      sseEvent('message.part.delta', {
        sessionID: TEST_SESSION,
        part: { id: 'prt_1', messageID: 'msg_a1', type: 'text', field: 'text', delta: 'hello ' },
      })
    )
    stream.push(
      sseEvent('message.part.delta', {
        sessionID: TEST_SESSION,
        part: { id: 'prt_1', messageID: 'msg_a1', type: 'text', field: 'text', delta: 'world' },
      })
    )
    stream.push(sseEvent('session.idle', { sessionID: TEST_SESSION }))

    const chunks = await chunksPromise
    expect(chunks).toEqual([
      { content: 'hello ', done: false, kind: 'text' },
      { content: 'world', done: false, kind: 'text' },
      { content: '', done: true },
    ])
  })

  // ─── message 长等待（node:http 无 undici 300s 掐断）─────

  it('waits for delayed message response on node:http path (no 300s-style cutoff)', async () => {
    // undici（fetch 底层）默认 headersTimeout=300s：message API「整轮完成才
    // 响应」+ gpt-5.6-luna 长思考 5.1min > 300s → 掐断 → fetch failed（luna猫
    // 验收失败根因，店长四步实测实锤）。node:http 默认无客户端超时——真实
    // server 挂起 1.5s（无响应头）后才 200，适配器必须正常等待并继续消费
    // 事件流（300s 本身无法在单测内等，此用例验证真实 socket 路径不被短
    // 超时掐断、且响应后链路正常推进）
    messageServerConfig.delayMs = 1500
    const stream = makeEventStream()
    stubFetch({ eventStream: stream.stream })
    const adapter = new OpencodeServeAdapter({ model: 'opencode-go/gpt-5.6-luna' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'opencode-go/gpt-5.6-luna',
    })
    const chunksPromise = collect(gen)
    await vi.waitFor(() => {
      expect(vi.mocked(spawnSupervised)).toHaveBeenCalled()
    })

    // 消息挂起期间推事件（缓冲在流里，consumeEvents 建立后统一读取）
    stream.push(
      sseEvent('message.updated', {
        sessionID: TEST_SESSION,
        info: { id: 'msg_a1', role: 'assistant' },
      })
    )
    stream.push(
      sseEvent('message.part.delta', {
        sessionID: TEST_SESSION,
        part: { id: 'prt_1', messageID: 'msg_a1', type: 'text', field: 'text', delta: 'after ' },
      })
    )
    stream.push(
      sseEvent('message.part.delta', {
        sessionID: TEST_SESSION,
        part: { id: 'prt_1', messageID: 'msg_a1', type: 'text', field: 'text', delta: 'delay' },
      })
    )
    stream.push(sseEvent('session.idle', { sessionID: TEST_SESSION }))

    const chunks = await chunksPromise
    expect(chunks).toEqual([
      { content: 'after ', done: false, kind: 'text' },
      { content: 'delay', done: false, kind: 'text' },
      { content: '', done: true },
    ])
    // 真实 server 确已收到 message 请求（node:http 路径发生）
    expect(messageRequests.some((r) => r.url.includes('/message'))).toBe(true)
  })

  // ─── session 创建契约（model 拆分 + permission ruleset）───

  it('creates session with split model and permission ruleset (contract)', async () => {
    const stream = makeEventStream()
    const { calls } = stubFetch({ eventStream: stream.stream })
    const adapter = new OpencodeServeAdapter({ model: 'opencode-go/gpt-5.6-luna' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'openai/gpt-5',
    })
    const chunksPromise = collect(gen)

    // 等 session 创建请求发出（在 GET /event 订阅之前）
    await vi.waitFor(() => {
      expect(calls.some((c) => c.init?.method === 'POST' && c.url.endsWith('/session'))).toBe(true)
    })

    const sessCall = calls.find((c) => c.init?.method === 'POST' && c.url.endsWith('/session'))!
    const body = JSON.parse(String(sessCall.init?.body))
    // options.model 优先（与 run 适配器同惯例）；'openai/gpt-5' → {providerID, modelID} 拆分
    expect(body.model).toEqual({ id: 'gpt-5', providerID: 'openai' })
    // permission ruleset 基础版：5 个文件工具限 cwd 内 allow + bash 全放行 allow（留审计）
    expect(body.permission).toEqual([
      { permission: 'read', pattern: 'D:/workspace/**', action: 'allow' },
      { permission: 'edit', pattern: 'D:/workspace/**', action: 'allow' },
      { permission: 'write', pattern: 'D:/workspace/**', action: 'allow' },
      { permission: 'apply_patch', pattern: 'D:/workspace/**', action: 'allow' },
      { permission: 'patch', pattern: 'D:/workspace/**', action: 'allow' },
      { permission: 'bash', pattern: '*', action: 'allow' },
    ])

    // 收尾：推 idle 让事件流正常结束（否则 consumeEvents 挂起、测试进程卡住）
    await vi.waitFor(() => {
      expect(vi.mocked(spawnSupervised)).toHaveBeenCalled()
    })
    stream.push(
      sseEvent('message.updated', {
        sessionID: TEST_SESSION,
        info: { id: 'msg_a1', role: 'assistant' },
      })
    )
    stream.push(sseEvent('session.idle', { sessionID: TEST_SESSION }))
    await chunksPromise
  })

  it('sends flattened prompt and image file parts in message (dataURL 直传不落盘)', async () => {
    stubFetch()
    const adapter = new OpencodeServeAdapter({ model: 'opencode-go/gpt-5.6-luna' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream(
      [
        { role: 'user', content: '历史消息', images: ['data:image/png;base64,aGVsbG8='] },
        { role: 'user', content: 'hi', images: ['data:image/jpeg;base64,d29ybGQ='] },
      ],
      { model: 'opencode-go/gpt-5.6-luna' }
    )
    const chunksPromise = collect(gen)

    // message 走 node:http → 由 fleet 真实 server 承接（fetch mock 收不到）
    await vi.waitFor(() => {
      expect(messageRequests.some((r) => r.url.includes('/message'))).toBe(true)
    })

    const msgReq = messageRequests.find((r) => r.url.includes('/message'))!
    expect(msgReq.method).toBe('POST')
    expect(msgReq.url).toBe(`/session/${TEST_SESSION}/message`)
    const body = JSON.parse(msgReq.body)
    // 历史平铺成单条 text（与 run 模式 messagesToPrompt 对齐）
    expect(body.parts[0]).toEqual({ type: 'text', text: 'User: hello\n\nAssistant: hi' })
    // 全部 messages 的图片 → FilePartInput（run 模式只传最后一条 user 的图，
    // serve 全量带上；mime 从 dataURL 前缀解析，url 直传 dataURL 无需落盘）
    expect(body.parts[1]).toEqual({
      type: 'file',
      mime: 'image/png',
      url: 'data:image/png;base64,aGVsbG8=',
    })
    expect(body.parts[2]).toEqual({
      type: 'file',
      mime: 'image/jpeg',
      url: 'data:image/jpeg;base64,d29ybGQ=',
    })
  })

  // ─── 过滤规则（全局流 session 过滤 + assistant 过滤）─────

  it('filters out user message parts (own text snapshot in stream)', async () => {
    // 实测：用户消息自己的 part 快照也在事件流里（noReply 消息产生
    // message.part.updated{part.text='hello'}）——不过滤会把用户输入当回复输出
    const stream = makeEventStream()
    stubFetch({ eventStream: stream.stream })
    const adapter = new OpencodeServeAdapter({ model: 'opencode-go/gpt-5.6-luna' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'opencode-go/gpt-5.6-luna',
    })
    const chunksPromise = collect(gen)
    await vi.waitFor(() => {
      expect(vi.mocked(spawnSupervised)).toHaveBeenCalled()
    })

    stream.push(
      sseEvent('message.updated', {
        sessionID: TEST_SESSION,
        info: { id: 'msg_user1', role: 'user' },
      })
    )
    // 用户消息自己的 text 快照——messageID 不在 assistant 集合 → 不产出
    stream.push(
      sseEvent('message.part.updated', {
        sessionID: TEST_SESSION,
        part: { id: 'prt_u1', messageID: 'msg_user1', type: 'text', text: 'hi' },
      })
    )
    // assistant 回复正常产出
    stream.push(
      sseEvent('message.updated', {
        sessionID: TEST_SESSION,
        info: { id: 'msg_a1', role: 'assistant' },
      })
    )
    stream.push(
      sseEvent('message.part.delta', {
        sessionID: TEST_SESSION,
        part: { id: 'prt_1', messageID: 'msg_a1', type: 'text', field: 'text', delta: 'reply' },
      })
    )
    stream.push(sseEvent('session.idle', { sessionID: TEST_SESSION }))

    const chunks = await chunksPromise
    expect(chunks).toEqual([
      { content: 'reply', done: false, kind: 'text' },
      { content: '', done: true },
    ])
  })

  it('filters out events from other sessions (global stream)', async () => {
    // GET /event 无 session 过滤参数（实测契约），多会话共享实例时事件全量
    // 广播——按 properties.sessionID 过滤是正确性前提（不串会话上下文）
    const stream = makeEventStream()
    stubFetch({ eventStream: stream.stream })
    const adapter = new OpencodeServeAdapter({ model: 'opencode-go/gpt-5.6-luna' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'opencode-go/gpt-5.6-luna',
    })
    const chunksPromise = collect(gen)
    await vi.waitFor(() => {
      expect(vi.mocked(spawnSupervised)).toHaveBeenCalled()
    })

    // 其他会话的 assistant delta——不得产出
    stream.push(
      sseEvent('message.updated', {
        sessionID: 'ses_other',
        info: { id: 'msg_x1', role: 'assistant' },
      })
    )
    stream.push(
      sseEvent('message.part.delta', {
        sessionID: 'ses_other',
        part: { id: 'prt_x1', messageID: 'msg_x1', type: 'text', field: 'text', delta: 'leak' },
      })
    )
    // 本会话的正常回复
    stream.push(
      sseEvent('message.updated', {
        sessionID: TEST_SESSION,
        info: { id: 'msg_a1', role: 'assistant' },
      })
    )
    stream.push(
      sseEvent('message.part.delta', {
        sessionID: TEST_SESSION,
        part: { id: 'prt_1', messageID: 'msg_a1', type: 'text', field: 'text', delta: 'mine' },
      })
    )
    stream.push(sseEvent('session.idle', { sessionID: TEST_SESSION }))

    const chunks = await chunksPromise
    expect(chunks).toEqual([
      { content: 'mine', done: false, kind: 'text' },
      { content: '', done: true },
    ])
  })

  // ─── reasoning（[思考] chunk + part.id 去重）─────

  it('yields [思考] thinking chunk on reasoning part and dedupes by part id', async () => {
    // serve 模式无需 --thinking 默认输出 reasoning（run 模式才需要开关，实测）；
    // updated 快照可能对同一 part 多次推送——按 part.id 去重只发一次
    const stream = makeEventStream()
    stubFetch({ eventStream: stream.stream })
    const adapter = new OpencodeServeAdapter({ model: 'opencode-go/gpt-5.6-luna' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream([{ role: 'user', content: '鸡兔同笼' }], {
      model: 'opencode-go/gpt-5.6-luna',
    })
    const chunksPromise = collect(gen)
    await vi.waitFor(() => {
      expect(vi.mocked(spawnSupervised)).toHaveBeenCalled()
    })

    stream.push(
      sseEvent('message.updated', {
        sessionID: TEST_SESSION,
        info: { id: 'msg_a1', role: 'assistant' },
      })
    )
    // 同一 reasoning part 两次 updated（快照增长）——只产出一次 [思考]
    stream.push(
      sseEvent('message.part.updated', {
        sessionID: TEST_SESSION,
        part: { id: 'prt_r1', messageID: 'msg_a1', type: 'reasoning', text: 'Let me solve' },
      })
    )
    stream.push(
      sseEvent('message.part.updated', {
        sessionID: TEST_SESSION,
        part: { id: 'prt_r1', messageID: 'msg_a1', type: 'reasoning', text: 'Let me solve step' },
      })
    )
    // 加密思考（reasoningEncryptedContent 场景）：text 空 → 跳过不产出
    stream.push(
      sseEvent('message.part.updated', {
        sessionID: TEST_SESSION,
        part: { id: 'prt_r2', messageID: 'msg_a1', type: 'reasoning', text: '' },
      })
    )
    stream.push(
      sseEvent('message.part.delta', {
        sessionID: TEST_SESSION,
        part: { id: 'prt_1', messageID: 'msg_a1', type: 'text', field: 'text', delta: 'answer' },
      })
    )
    stream.push(sseEvent('session.idle', { sessionID: TEST_SESSION }))

    const chunks = await chunksPromise
    expect(chunks).toEqual([
      { content: '[思考] Let me solve', done: false, kind: 'thinking' },
      { content: 'answer', done: false, kind: 'text' },
      { content: '', done: true },
    ])
  })

  // ─── 工具调用审计（bash 允许但留审计）─────

  it('logs tool call for audit and yields no chunk (bash allowed but audited)', async () => {
    const stream = makeEventStream()
    stubFetch({ eventStream: stream.stream })
    const adapter = new OpencodeServeAdapter({ model: 'opencode-go/gpt-5.6-luna' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream([{ role: 'user', content: '写个文件' }], {
      model: 'opencode-go/gpt-5.6-luna',
    })
    const chunksPromise = collect(gen)
    await vi.waitFor(() => {
      expect(vi.mocked(spawnSupervised)).toHaveBeenCalled()
    })

    stream.push(
      sseEvent('message.updated', {
        sessionID: TEST_SESSION,
        info: { id: 'msg_a1', role: 'assistant' },
      })
    )
    // tool part 实测结构：{type:'tool', tool:'bash', state:{status,input}}——input 是对象
    stream.push(
      sseEvent('message.part.updated', {
        sessionID: TEST_SESSION,
        part: {
          id: 'prt_t1',
          messageID: 'msg_a1',
          type: 'tool',
          tool: 'bash',
          state: { status: 'completed', input: { command: 'ls', workdir: 'D:/workspace' } },
        },
      })
    )
    stream.push(sseEvent('session.idle', { sessionID: TEST_SESSION }))

    const chunks = await chunksPromise
    // 工具事件不产出 chunk——只有收尾 done
    expect(chunks).toEqual([{ content: '', done: true }])
    // 审计日志：tool + status + input（序列化截断）
    expect(logMocks.info).toHaveBeenCalledWith(
      'opencode-serve 工具调用',
      expect.objectContaining({
        tool: 'bash',
        status: 'completed',
        input: expect.stringContaining('"command":"ls"'),
      })
    )
  })

  // ─── abort 转发（POST /session/{id}/abort）─────

  it('aborts serve-side session on abort signal (POST abort forwarding)', async () => {
    const stream = makeEventStream()
    const { calls } = stubFetch({ eventStream: stream.stream })
    const adapter = new OpencodeServeAdapter({ model: 'opencode-go/gpt-5.6-luna' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const controller = new AbortController()
    const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'opencode-go/gpt-5.6-luna',
      signal: controller.signal,
    }) as AsyncGenerator<Chunk>

    // 先驱动 generator（惰性：next 才执行到 spawn），再等 spawn + 订阅建立
    const firstNext = gen.next()
    await vi.waitFor(() => {
      expect(vi.mocked(spawnSupervised)).toHaveBeenCalled()
    })
    stream.push(
      sseEvent('message.updated', {
        sessionID: TEST_SESSION,
        info: { id: 'msg_a1', role: 'assistant' },
      })
    )
    stream.push(
      sseEvent('message.part.delta', {
        sessionID: TEST_SESSION,
        part: { id: 'prt_1', messageID: 'msg_a1', type: 'text', field: 'text', delta: 'hi' },
      })
    )
    const first = await firstNext
    expect(first.value).toEqual({ content: 'hi', done: false, kind: 'text' })

    controller.abort()
    stream.end()

    const rest: Chunk[] = []
    for await (const c of gen) rest.push(c)
    expect(rest.at(-1)?.done).toBe(true)

    // 核心断言：abort 转发到 serve 侧（POST /session/{id}/abort）——中断仍在跑的 agent 循环
    expect(
      calls.some(
        (c) => c.init?.method === 'POST' && c.url.includes(`/session/${TEST_SESSION}/abort`)
      )
    ).toBe(true)
  })

  // ─── 长驻进程复用（懒启动一次）─────

  it('reuses long-lived serve process across calls (spawn once)', async () => {
    const stream1 = makeEventStream()
    const fetchMock1 = stubFetch({ eventStream: stream1.stream })
    const adapter = new OpencodeServeAdapter({ model: 'opencode-go/gpt-5.6-luna' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen1 = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'opencode-go/gpt-5.6-luna',
    })
    const p1 = collect(gen1)
    await vi.waitFor(() => {
      expect(vi.mocked(spawnSupervised)).toHaveBeenCalled()
    })
    stream1.push(
      sseEvent('message.updated', {
        sessionID: TEST_SESSION,
        info: { id: 'msg_a1', role: 'assistant' },
      })
    )
    stream1.push(
      sseEvent('message.part.delta', {
        sessionID: TEST_SESSION,
        part: { id: 'prt_1', messageID: 'msg_a1', type: 'text', field: 'text', delta: 'first' },
      })
    )
    stream1.push(sseEvent('session.idle', { sessionID: TEST_SESSION }))
    await p1

    // 第二轮：进程仍存活（exitCode null）→ 复用，不重新 spawn
    const stream2 = makeEventStream()
    vi.unstubAllGlobals()
    const fetchMock2 = stubFetch({ eventStream: stream2.stream })
    const gen2 = adapter.chatStream([{ role: 'user', content: 'again' }], {
      model: 'opencode-go/gpt-5.6-luna',
    })
    const p2 = collect(gen2)
    await vi.waitFor(() => {
      expect(fetchMock2.fetchMock).toHaveBeenCalled()
    })
    stream2.push(
      sseEvent('message.updated', {
        sessionID: TEST_SESSION,
        info: { id: 'msg_a2', role: 'assistant' },
      })
    )
    stream2.push(
      sseEvent('message.part.delta', {
        sessionID: TEST_SESSION,
        part: { id: 'prt_2', messageID: 'msg_a2', type: 'text', field: 'text', delta: 'second' },
      })
    )
    stream2.push(sseEvent('session.idle', { sessionID: TEST_SESSION }))
    const chunks2 = await p2
    expect(chunks2[0]).toEqual({ content: 'second', done: false, kind: 'text' })

    // spawn 只发生一次（长驻复用）——serve 生命周期契约
    expect(spawnSupervised).toHaveBeenCalledTimes(1)
    void fetchMock1
  })

  // ─── 死亡重启（进程退出后下次调用重新 spawn）─────

  it('restarts serve after process death (spawn again on new port, not dead handle reuse)', async () => {
    // 缺陷回归：ensureServer 旧实现 readyPromise 成功路径从不置 null——进程
    // 死亡后第二轮调用命中已 resolve 的旧 Promise → 返回死亡句柄 → 重启永不
    // 发生（吐槽猫探针实证）。修复：清死亡引用后重新 spawn（新端口新进程）。
    const stream1 = makeEventStream()
    const { calls: calls1 } = stubFetch({ eventStream: stream1.stream })
    const adapter = new OpencodeServeAdapter({ model: 'opencode-go/gpt-5.6-luna' })
    const child1 = fakeChild()
    const child2 = fakeChild()
    vi.mocked(spawnSupervised)
      .mockReturnValueOnce(child1 as any)
      .mockReturnValue(child2 as any)

    // 第一轮：正常完成（spawn 1 次，句柄存活）
    const gen1 = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'opencode-go/gpt-5.6-luna',
    })
    const p1 = collect(gen1)
    await vi.waitFor(() => {
      expect(vi.mocked(spawnSupervised)).toHaveBeenCalled()
    })
    stream1.push(
      sseEvent('message.updated', {
        sessionID: TEST_SESSION,
        info: { id: 'msg_a1', role: 'assistant' },
      })
    )
    stream1.push(
      sseEvent('message.part.delta', {
        sessionID: TEST_SESSION,
        part: { id: 'prt_1', messageID: 'msg_a1', type: 'text', field: 'text', delta: 'first' },
      })
    )
    stream1.push(sseEvent('session.idle', { sessionID: TEST_SESSION }))
    await p1

    // 模拟进程死亡：真实语义 = 进程退出后 exitCode 变非 null
    ;(child1 as any).exitCode = 1

    // 第二轮：死亡 → 重启（第二次 spawn，新 fakeChild 存活）+ 正常回复
    const stream2 = makeEventStream()
    vi.unstubAllGlobals()
    const { calls: calls2 } = stubFetch({ eventStream: stream2.stream })
    const gen2 = adapter.chatStream([{ role: 'user', content: 'again' }], {
      model: 'opencode-go/gpt-5.6-luna',
    })
    const p2 = collect(gen2)
    await vi.waitFor(() => {
      expect(vi.mocked(spawnSupervised)).toHaveBeenCalledTimes(2)
    })
    stream2.push(
      sseEvent('message.updated', {
        sessionID: TEST_SESSION,
        info: { id: 'msg_a2', role: 'assistant' },
      })
    )
    stream2.push(
      sseEvent('message.part.delta', {
        sessionID: TEST_SESSION,
        part: { id: 'prt_2', messageID: 'msg_a2', type: 'text', field: 'text', delta: 'second' },
      })
    )
    stream2.push(sseEvent('session.idle', { sessionID: TEST_SESSION }))
    const chunks2 = await p2
    expect(chunks2[0]).toEqual({ content: 'second', done: false, kind: 'text' })

    // 核心断言：重启发生（第二次 spawn）且走新进程的新端口——不是复用死亡
    // 句柄的旧 baseUrl（旧代码下 secondSess.url === firstSess.url 即失败）
    expect(spawnSupervised).toHaveBeenCalledTimes(2)
    const firstSess = calls1.find((c) => c.init?.method === 'POST' && c.url.endsWith('/session'))!
    const secondSess = calls2.find((c) => c.init?.method === 'POST' && c.url.endsWith('/session'))!
    expect(secondSess.url).not.toBe(firstSess.url)
  })

  // ─── 错误路径 ────────────────────────────────

  it('yields error message when session creation fails (HTTP 500)', async () => {
    stubFetch({ sessionStatus: 500 })
    const adapter = new OpencodeServeAdapter({ model: 'opencode-go/gpt-5.6-luna' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const chunks = await collect(
      adapter.chatStream([{ role: 'user', content: 'hi' }], {
        model: 'opencode-go/gpt-5.6-luna',
      })
    )

    expect(chunks[0].content).toContain('opencode serve 会话创建失败')
    expect(chunks.at(-1)?.done).toBe(true)
  })

  it('aborts pending SSE subscription when message send fails (connection leak fix)', async () => {
    // msgResp 非 200 早退路径：GET /event 订阅已发起（先订阅后发消息的防丢
    // 事件时序）但 Promise 无人 await——不显式断连则连接泄漏挂到服务端超时
    // （吐槽猫探针实证）。修复：早退时 abort。断言 /event 请求的 signal 被置为
    // aborted。
    // message 500 由 fleet 真实 server 返回（postJson 走 node:http）
    messageServerConfig.status = 500
    const stream = makeEventStream()
    const { calls } = stubFetch({ eventStream: stream.stream })
    const adapter = new OpencodeServeAdapter({ model: 'opencode-go/gpt-5.6-luna' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const chunks = await collect(
      adapter.chatStream([{ role: 'user', content: 'hi' }], {
        model: 'opencode-go/gpt-5.6-luna',
      })
    )

    expect(chunks[0].content).toContain('opencode serve 消息发送失败')
    expect(chunks[0].content).toContain('HTTP 500')
    expect(chunks.at(-1)?.done).toBe(true)
    // /event 请求未显式传 method（mock 内部默认 GET，记录的原生 init 无 method
    // 字段）——URL 后缀已足够唯一（/doc、/abort 均不同后缀）
    const eventCall = calls.find((c) => c.url.endsWith('/event'))!
    expect(eventCall.init?.signal?.aborted).toBe(true)
  })

  it('interrupts in-flight message POST on signal abort (AbortError → empty done)', async () => {
    // signal 传导：abort → req.destroy(AbortError) → postJson reject → 走现有
    // AbortError 路径（静默空 done，不产出错误文案）。serve cancel 执行是
    // 预期行为（外层取消=用户取消）。真实 server 挂起不响应——不中断则本
    // 用例永远等不到结束。
    messageServerConfig.hang = true
    const { calls } = stubFetch()
    const adapter = new OpencodeServeAdapter({ model: 'opencode-go/gpt-5.6-luna' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const controller = new AbortController()
    const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'opencode-go/gpt-5.6-luna',
      signal: controller.signal,
    })
    const chunksPromise = collect(gen)

    // 等 message 请求已到达真实 server（在途挂起）
    await vi.waitFor(() => {
      expect(messageRequests.some((r) => r.url.includes('/message'))).toBe(true)
    })
    controller.abort()

    const chunks = await chunksPromise
    expect(chunks).toEqual([{ content: '', done: true }])
    // 兜底清理仍发生：finally 非 idle 完成 → POST abort + DELETE（fetch mock 记录）
    expect(
      calls.some(
        (c) => c.init?.method === 'POST' && c.url.includes(`/session/${TEST_SESSION}/abort`)
      )
    ).toBe(true)
    expect(
      calls.some((c) => c.init?.method === 'DELETE' && c.url.includes(`/session/${TEST_SESSION}`))
    ).toBe(true)
  })

  it('yields cannot-start error on serve spawn error (fast fail, not 30s timeout)', async () => {
    // spawn error 快速失败：不监听时 exitCode 恒 null 且无 /doc 响应，
    // 会空转满 30s 就绪超时才报错（文案还误导为「启动超时」）
    // docUnreachable 模拟真实 ENOENT 场景：进程从未启动 → 探测连接拒绝
    stubFetch({ docUnreachable: true })
    const adapter = new OpencodeServeAdapter({ model: 'opencode-go/gpt-5.6-luna' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'opencode-go/gpt-5.6-luna',
    })
    const chunksPromise = collect(gen)
    // 等 spawn + error 监听注册后再派发（与 spawn 阶段真实时序一致）
    await vi.waitFor(() => {
      expect(vi.mocked(spawnSupervised)).toHaveBeenCalled()
    })
    await vi.waitFor(() => {
      expect(vi.mocked(child.on)).toHaveBeenCalledWith('error', expect.any(Function))
    })
    child.emitError(new Error('spawn ENOENT'))

    const chunks = await chunksPromise
    expect(chunks[0].content).toContain('opencode serve 无法启动')
    expect(chunks[0].content).toContain('spawn ENOENT')
    expect(chunks.at(-1)?.done).toBe(true)
  })

  it('cleans up session after stream (DELETE on idle finish, no abort)', async () => {
    // idle 正常完成 → 不 POST abort（已自然结束）→ DELETE 清理（serve 侧持久化，
    // 不清理会随长驻进程无限积累）
    const stream = makeEventStream()
    const { calls } = stubFetch({ eventStream: stream.stream })
    const adapter = new OpencodeServeAdapter({ model: 'opencode-go/gpt-5.6-luna' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'opencode-go/gpt-5.6-luna',
    })
    const chunksPromise = collect(gen)
    await vi.waitFor(() => {
      expect(vi.mocked(spawnSupervised)).toHaveBeenCalled()
    })
    stream.push(
      sseEvent('message.updated', {
        sessionID: TEST_SESSION,
        info: { id: 'msg_a1', role: 'assistant' },
      })
    )
    stream.push(
      sseEvent('message.part.delta', {
        sessionID: TEST_SESSION,
        part: { id: 'prt_1', messageID: 'msg_a1', type: 'text', field: 'text', delta: 'hi' },
      })
    )
    stream.push(sseEvent('session.idle', { sessionID: TEST_SESSION }))
    await chunksPromise

    const deletes = calls.filter(
      (c) => c.init?.method === 'DELETE' && c.url.includes(`/session/${TEST_SESSION}`)
    )
    expect(deletes.length).toBeGreaterThan(0)
    // idle 完成后不 abort（完成态无需中断）
    expect(calls.some((c) => c.init?.method === 'POST' && c.url.includes('/abort'))).toBe(false)
  })

  it('aborts serve-side session on stream interrupt (断连兜底非 idle 完成)', async () => {
    // 非 idle 终止（SSE 断连）：已产出内容保留 + POST abort 中断仍在跑的执行
    const stream = makeEventStream()
    const { calls } = stubFetch({ eventStream: stream.stream })
    const adapter = new OpencodeServeAdapter({ model: 'opencode-go/gpt-5.6-luna' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'opencode-go/gpt-5.6-luna',
    })
    const chunksPromise = collect(gen)
    await vi.waitFor(() => {
      expect(vi.mocked(spawnSupervised)).toHaveBeenCalled()
    })
    stream.push(
      sseEvent('message.updated', {
        sessionID: TEST_SESSION,
        info: { id: 'msg_a1', role: 'assistant' },
      })
    )
    stream.push(
      sseEvent('message.part.delta', {
        sessionID: TEST_SESSION,
        part: { id: 'prt_1', messageID: 'msg_a1', type: 'text', field: 'text', delta: 'partial' },
      })
    )
    stream.end() // 断连（无 idle）

    const chunks = await chunksPromise
    // 已产出内容保留 + done 收尾（不产出错误文案）
    expect(chunks[0]).toEqual({ content: 'partial', done: false, kind: 'text' })
    expect(chunks.at(-1)).toEqual({ content: '', done: true })
    // 断连兜底：POST abort（serve 侧可能仍在跑）
    expect(
      calls.some(
        (c) => c.init?.method === 'POST' && c.url.includes(`/session/${TEST_SESSION}/abort`)
      )
    ).toBe(true)
  })
})
