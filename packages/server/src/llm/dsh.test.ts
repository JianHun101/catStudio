import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { readFileSync, existsSync } from 'node:fs'
import type { Chunk } from '@cat-study/shared'

// Mock cli-utils 以阻止模块加载时的 resolveJsEntry() 调用
// vi.hoisted：mock 工厂被提升到 const 声明之前，直接引用 DSH_ENTRY 会 TDZ 抛错
// → dsh.ts 模块加载时 resolveJsEntry() 抛错被 catch → DSH_ENTRY='' 走「未安装」早退
const DSH_ENTRY = vi.hoisted(
  () => 'C:/Users/test/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js'
)
// `importOriginal` 展开保留未被覆盖的真实导出：`terminateChild` 走真身（票① 的
// abort→终止链回归必须穿真实 helper，mock 掉就成了「断言自己调了自己」）。
vi.mock('./cli-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cli-utils.js')>()
  return {
    ...actual,
    resolveJsEntry: vi.fn(() => DSH_ENTRY),
    messagesToPrompt: vi.fn(() => 'User: hello\n\nAssistant: hi'),
    attachIdleTimeout: vi.fn(() => () => {}),
    spawnSupervised: vi.fn(),
    getWorkspaceDir: vi.fn(() => '/tmp/workspace'),
  }
})

// Logger mock：log 对象用 vi.hoisted 共享
const logMocks = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../logger.js', () => ({
  createLogger: () => logMocks,
}))

import { DshAdapter } from './dsh.js'
import {
  spawnSupervised,
  messagesToPrompt,
  attachIdleTimeout,
  __test_setPlatform,
} from './cli-utils.js'

/** 收集 async generator 的值 */
async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = []
  for await (const item of gen) {
    results.push(item)
  }
  return results
}

/**
 * 等一个 macrotask。fakeChild 的 Readable push 后 data 事件在 setImmediate 派发
 * （macrotask），而 close 的 promise 续延是 microtask 先跑——不 tick 的话 generator
 * 读 stdout/stderr 时 data 事件尚未派发（生产环境真实 I/O 无此时序问题，纯测试构造）。
 */
function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r))
}

/**
 * 构造 fake CLI 子进程：stdout/stderr 为手工 Readable（时序可控，不自动 end），
 * kill/on/once 为 vi.fn 记录调用；emitClose/emitError 手动派发 close/error 事件。
 */
function fakeChild(
  overrides: Partial<{ exitCode: number | null; signalCode: string | null; killed: boolean }> = {}
) {
  const stdout = new Readable({ read() {} })
  const stderr = new Readable({ read() {} })
  // stdin 用 EventEmitter 忠实模拟可写流的错误面：真实 ChildProcess 上 stdin 是
  // stream.Writable，CLI 早退时 pending write 以 EOF/EPIPE 派发 'error'；无监听则
  // 抛成 uncaughtException（server 直接退出）。夹具必须能派发该事件才测得到守卫。
  const stdin = new EventEmitter()
  const listeners = new Map<string, Set<(...args: any[]) => void>>()
  const register = (event: string, cb: (...args: any[]) => void) => {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event)!.add(cb)
  }
  const emitClose = (code: number | null) => {
    child.exitCode = code
    // 真实进程退出时 stdout/stderr 必然 end；readline 事件流迭代依赖 stdout EOF，
    // 夹具在派发 close 前一并结束两条流（否则迭代器永久挂起）。
    stdout.push(null)
    stderr.push(null)
    for (const cb of listeners.get('close') ?? []) cb(code)
  }
  const emitError = (err: Error) => {
    for (const cb of listeners.get('error') ?? []) cb(err)
  }
  const child = {
    stdout,
    stderr,
    stdin,
    kill: vi.fn(),
    on: vi.fn(register),
    once: vi.fn(register),
    emitClose,
    emitError,
    exitCode: null,
    killed: false,
    // 真实 ChildProcess 上 `signalCode` 恒有定义（null | 信号名），存活判据
    // `exitCode/signalCode 双 null` 依赖它——夹具缺这个字段会让「还活着」恒假，
    // 终止链静默不发信号（夹具必须忠实于真实对象形状，否则测的是假东西）。
    signalCode: null,
    ...overrides,
  }
  return child
}

/**
 * chatStream 声明返回 AsyncIterable，但实现是 async generator（有 .next()）——
 * 测试需要手动驱动各 yield 点，这里断言收窄为 AsyncGenerator。
 */
function drive<T>(gen: AsyncIterable<T>): AsyncGenerator<T> {
  return gen as AsyncGenerator<T>
}

/** 启动 generator 并在 close await 处挂起（spawn 同步执行完毕，可查 spawn 参数） */
function startGen(gen: AsyncIterable<Chunk>) {
  return drive(gen).next()
}

/**
 * 驱动一次完整事件流：先启动 generator（保证 close / stdout EOF 监听在 emitClose
 * 前注册），再灌 stdout NDJSON 与 stderr、派发 close，最后收齐全部非 done chunk。
 */
async function runToCompletion(
  gen: AsyncIterable<Chunk>,
  child: ReturnType<typeof fakeChild>,
  stdoutText: string,
  exitCode: number | null,
  stderrText = ''
): Promise<Chunk[]> {
  const driven = drive(gen)
  const first = driven.next()
  if (stdoutText) child.stdout.push(stdoutText)
  if (stderrText) child.stderr.push(stderrText)
  await tick()
  child.emitClose(exitCode)
  const chunks: Chunk[] = []
  let r = await first
  while (!r.done) {
    // Chunk.done 是载荷字段（generator 仍以 value 产出后才真正 return）——
    // 只滤掉终态空 done chunk；错误 chunk（done:true 但有正文）必须保留
    if (!(r.value.done && r.value.content === '')) chunks.push(r.value)
    r = await driven.next()
  }
  return chunks
}

describe('DshAdapter', () => {
  // 平台钉死为 POSIX：`terminateChild`（本文件用真身）在 win32 走 `taskkill /T` 树杀、
  // 根本不发信号——宿主平台不钉死则「本机 win32 / CI linux」跑的是两个分支。
  // win32 分支由 cli-utils.test.ts 显式覆盖。
  let restorePlatform: () => void

  beforeEach(() => {
    vi.clearAllMocks()
    restorePlatform = __test_setPlatform('linux')
  })

  afterEach(() => {
    restorePlatform()
    vi.restoreAllMocks()
  })

  // ─── 构造 ────────────────────────────────────

  it('stores provider name', () => {
    const adapter = new DshAdapter({ model: 'deepseek-chat' })
    expect(adapter.provider).toBe('dsh')
  })

  // ─── 外部取消（前置已 abort）─────────────────

  it('yields done immediately when signal is already aborted', async () => {
    const adapter = new DshAdapter({ model: 'deepseek-chat' })
    const controller = new AbortController()
    controller.abort()

    const chunks = await collect(
      adapter.chatStream([{ role: 'user', content: 'hi' }], {
        model: 'deepseek-chat',
        signal: controller.signal,
      })
    )

    expect(chunks).toEqual([{ content: '', done: true }])
    expect(spawnSupervised).not.toHaveBeenCalled()
  })

  // ─── 成功路径（NDJSON 事件流 → 逐条 chunk）────

  it('yields text chunk from NDJSON event on exit 0', async () => {
    const adapter = new DshAdapter({ model: 'deepseek-chat', apiKey: 'sk-key' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = drive(
      adapter.chatStream([{ role: 'user', content: 'hi' }], {
        model: 'deepseek-chat',
      })
    )
    const pending = startGen(gen)
    child.stdout.push(JSON.stringify({ type: 'text', text: '这是最终答案' }) + '\n')
    await tick() // data 事件派发后再 close（见 tick 注释）
    child.emitClose(0)

    const chunks = [await pending, await gen.next()].map((r) => r.value)
    expect(chunks).toEqual([
      { content: '这是最终答案', done: false, kind: 'text' },
      { content: '', done: true },
    ])
  })

  // ─── A1：事件映射（权威断言）──────────────────

  it('A1: maps thinking/text/tool_call/tool_result in order and dedupes final', async () => {
    const adapter = new DshAdapter({ model: 'deepseek-chat' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const events = [
      { type: 'session', sessionId: 'session-1', cwd: '/tmp' },
      { type: 'status', phase: 'turn_start', turn: 1 },
      { type: 'status', phase: 'step_start', turn: 1, step: 1 },
      { type: 'thinking', text: '先想一下' },
      { type: 'text', text: '我先执行命令。' },
      { type: 'tool_call', callId: 'call_1', tool: 'pwsh', input: { command: 'echo hi' } },
      { type: 'tool_result', callId: 'call_1', status: 'completed', result: 'hi\r\n' },
      { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: {} },
      { type: 'status', phase: 'step_start', turn: 1, step: 2 },
      { type: 'thinking', text: '' }, // 空串 thinking（实机第二步实证）→ 跳过
      { type: 'text', text: '完成' },
      { type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } },
      { type: 'final', text: '完成' }, // 与最后一条 text 重复 → 不得重复产出
    ]
    const chunks = await runToCompletion(
      adapter.chatStream([{ role: 'user', content: 'hi' }], { model: 'deepseek-chat' }),
      child,
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
      0
    )

    expect(chunks.map((c) => c.kind)).toEqual(['thinking', 'text', 'tool', 'tool', 'text'])
    expect(chunks[0].content).toBe('先想一下')
    expect(chunks[1].content).toBe('我先执行命令。')
    // running / completed 两 chunk 共用同一 callId（下游按 id 合并单条记录）
    expect(chunks[2].tool).toEqual({
      id: 'call_1',
      name: 'pwsh',
      status: 'running',
      input: { command: 'echo hi' },
    })
    expect(chunks[3].tool).toEqual({
      id: 'call_1',
      name: 'pwsh',
      status: 'completed',
      output: 'hi\r\n',
      isError: false,
    })
    // final 去重：'完成' 只出现一次（来自 text 事件，不是 final）
    expect(chunks.filter((c) => c.content === '完成')).toHaveLength(1)
    expect(chunks[4]).toEqual({ content: '完成', done: false, kind: 'text' })
  })

  it('A1b: yields text from a lone final event (no text event)', async () => {
    const adapter = new DshAdapter({ model: 'deepseek-chat' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const chunks = await runToCompletion(
      adapter.chatStream([{ role: 'user', content: 'hi' }], { model: 'deepseek-chat' }),
      child,
      JSON.stringify({ type: 'final', text: '答案' }) + '\n',
      0
    )

    expect(chunks).toEqual([{ content: '答案', done: false, kind: 'text' }])
  })

  // ─── A3：退出码权威 + 诊断兜底优先级 ───────────

  it('A3: exit != 0 uses CLI error event message when stderr has only supervisor lines', async () => {
    const adapter = new DshAdapter({ model: 'deepseek-chat' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const chunks = await runToCompletion(
      adapter.chatStream([{ role: 'user', content: 'hi' }], { model: 'deepseek-chat' }),
      child,
      JSON.stringify({ type: 'error', message: "unknown option '--patch'" }) + '\n',
      1,
      '[supervisor] pid=1234\n[supervisor] spawn ok\n'
    )

    expect(chunks).toEqual([
      { content: "dsh CLI 启动失败 (exit code 1): unknown option '--patch'", done: true },
    ])
    expect(chunks[0].content).not.toContain('[supervisor]')
  })

  it('A3b: exit != 0 falls back to turn_end reason message when stderr is empty', async () => {
    const adapter = new DshAdapter({ model: 'deepseek-chat' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const events = [
      { type: 'text', text: '部分输出' },
      {
        type: 'status',
        phase: 'turn_end',
        turn: 1,
        reason: { kind: 'error', message: 'model overloaded' },
      },
    ]
    const chunks = await runToCompletion(
      adapter.chatStream([{ role: 'user', content: 'hi' }], { model: 'deepseek-chat' }),
      child,
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
      1
    )

    // 流式语义：已产出的 text 不能撤回；错误 chunk 收尾并使用 turn_end 诊断
    expect(chunks.at(-1)).toEqual({
      content: 'dsh CLI 启动失败 (exit code 1): model overloaded',
      done: true,
    })
  })

  // ─── A4：解析容错 ─────────────────────────────

  it('A4: tolerates non-JSON/blank/unknown lines and still yields valid events', async () => {
    const adapter = new DshAdapter({ model: 'deepseek-chat' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const stdout =
      [
        'not json',
        '',
        JSON.stringify({ type: 'text', text: 'ok' }),
        JSON.stringify({ type: 'mystery', foo: 1 }),
      ].join('\n') + '\n'
    const chunks = await runToCompletion(
      adapter.chatStream([{ role: 'user', content: 'hi' }], { model: 'deepseek-chat' }),
      child,
      stdout,
      0
    )

    expect(chunks).toEqual([{ content: 'ok', done: false, kind: 'text' }])
    // 非法行计数一次落到 debug；合法事件照常产出、未知 type 静默忽略
    expect(logMocks.debug).toHaveBeenCalledWith('dsh stdout 含无法解析的行', { lines: 1 })
    expect(logMocks.warn).not.toHaveBeenCalled()
  })

  it('exit 0 + 全非 JSON stdout → warn + 纯文本兜底（防格式漂移静默空回复）', async () => {
    const adapter = new DshAdapter({ model: 'deepseek-chat' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const chunks = await runToCompletion(
      adapter.chatStream([{ role: 'user', content: 'hi' }], { model: 'deepseek-chat' }),
      child,
      '纯文本答案\n',
      0
    )

    expect(chunks).toEqual([{ content: '纯文本答案', done: false, kind: 'text' }])
    expect(logMocks.warn).toHaveBeenCalledWith(
      'dsh stdout 不是可解析的事件流，按纯文本兜底',
      expect.objectContaining({ lines: 1 })
    )
  })

  // ─── A5：截断保真 ─────────────────────────────

  it('A5: propagates truncated flag on tool_result and logs truncated thinking/text', async () => {
    const adapter = new DshAdapter({ model: 'deepseek-chat' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const events = [
      { type: 'thinking', text: '想', truncated: true },
      { type: 'text', text: '答', truncated: true },
      { type: 'tool_call', callId: 'c1', tool: 'bash', input: {} },
      { type: 'tool_result', callId: 'c1', status: 'completed', result: 'out', truncated: true },
    ]
    const chunks = await runToCompletion(
      adapter.chatStream([{ role: 'user', content: 'hi' }], { model: 'deepseek-chat' }),
      child,
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
      0
    )

    expect(chunks.map((c) => c.kind)).toEqual(['thinking', 'text', 'tool', 'tool'])
    expect(chunks[3].tool?.truncated).toBe(true)
    expect(logMocks.debug).toHaveBeenCalledWith('dsh thinking 事件被截断', {
      bytes: Buffer.byteLength('想'),
    })
    expect(logMocks.debug).toHaveBeenCalledWith('dsh text 事件被截断', {
      bytes: Buffer.byteLength('答'),
    })
  })

  it('yields empty done on exit 0 with empty stdout (空响应不报错)', async () => {
    const adapter = new DshAdapter({ model: 'deepseek-chat' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = drive(
      adapter.chatStream([{ role: 'user', content: 'hi' }], {
        model: 'deepseek-chat',
      })
    )
    const pending = startGen(gen)
    child.emitClose(0)

    const r = await pending
    expect(r.value).toEqual({ content: '', done: true })
    // generator 已耗尽（done chunk 是最后 yield）
    expect((await gen.next()).done).toBe(true)
  })

  // ─── stderr 分流（exit code 才是权威判据）────

  it('does not warn on exit 0; degrades supervisor + reasoning + warning stderr to debug', async () => {
    const adapter = new DshAdapter({ model: 'deepseek-chat' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = drive(
      adapter.chatStream([{ role: 'user', content: 'hi' }], {
        model: 'deepseek-chat',
      })
    )
    const pending = startGen(gen)
    const stderrText =
      '[supervisor] pid=1234\n' +
      'dsh: reasoning: 先想想\n' +
      'dsh: reasoning: 再想想\n' +
      'some non-fatal warning\n'
    child.stdout.push(JSON.stringify({ type: 'text', text: '最终答案' }) + '\n')
    child.stderr.push(stderrText)
    await tick()
    child.emitClose(0)

    const r = await pending
    expect(r.value).toEqual({ content: '最终答案', done: false, kind: 'text' })
    await gen.next()
    // exit 0 = 权威的 completed：supervisor 管道行 / 推理增量 / 非致命 warning 一律不进 warn
    expect(logMocks.warn).not.toHaveBeenCalled()
    // 降级为一条 debug，带字节数 + 截断 head（供排障，不打扰运行面）
    expect(logMocks.debug).toHaveBeenCalledTimes(1)
    expect(logMocks.debug).toHaveBeenCalledWith('dsh stderr (exit 0)', {
      // UTF-8 字节数，不是 UTF-16 code unit（中文 reasoning 下 length 会低报约 3×）
      bytes: Buffer.byteLength(stderrText),
      head: stderrText.slice(0, 500),
    })
  })

  // ─── 失败路径 ─────────────────────────────────

  it('yields error chunk on non-zero exit with supervisor lines stripped from detail', async () => {
    const adapter = new DshAdapter({ model: 'deepseek-chat' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'deepseek-chat',
    })
    const pending = startGen(gen)
    child.stderr.push(
      '[supervisor] pid=1234\n[supervisor] spawn ok\nModel returned an error: boom\n'
    )
    await tick() // data 事件派发后再 close
    child.emitClose(1)

    const r = await pending
    expect(r.value).toEqual({
      content: 'dsh CLI 启动失败 (exit code 1): Model returned an error: boom',
      done: true,
    })
    // supervisor 启动行是管道噪声，不得出现在用户可见错误文案里
    expect((r.value as Chunk).content).not.toContain('[supervisor]')
    // error 日志同样用剥后文本（真实错误不被噪声挤出截断窗口）
    expect(logMocks.error).toHaveBeenCalledWith('dsh 退出', {
      exitCode: 1,
      stderr: 'Model returned an error: boom',
    })
  })

  it('yields unable-to-start chunk when spawn fails (ENOENT 类)', async () => {
    const adapter = new DshAdapter({ model: 'deepseek-chat' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'deepseek-chat',
    })
    const pending = startGen(gen)
    child.emitError(new Error('ENOENT'))
    child.emitClose(null)

    const r = await pending
    expect(r.value).toEqual({ content: 'dsh CLI 无法启动: ENOENT', done: true })
  })

  // ─── stdin 错误守卫（P2：CLI 早退 EPIPE/EOF 不得崩 server）────

  it('registers stdin error guard: early CLI exit (EPIPE/EOF) does not crash the process', async () => {
    const adapter = new DshAdapter({ model: 'deepseek-chat' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'deepseek-chat',
    })
    const pending = startGen(gen)

    // 守卫在 spawn 返回后立即注册——真实进程里 write 已在 spawnSupervised 内同步完成、
    // 错误异步派发；无监听时 EventEmitter 的 'error' 直接抛成 uncaughtException。
    expect(child.stdin.listenerCount('error')).toBe(1)
    const stdinErr = Object.assign(new Error('write EOF'), { code: 'EPIPE' })
    expect(() => child.stdin.emit('error', stdinErr)).not.toThrow()
    expect(logMocks.debug).toHaveBeenCalledWith('dsh stdin 写入失败', {
      code: 'EPIPE',
      error: 'write EOF',
    })

    // 主判定不变：退出码仍是权威 → 非零退出照常产出启动失败 chunk
    child.emitClose(1)
    const r = await pending
    expect(r.value).toEqual({ content: 'dsh CLI 启动失败 (exit code 1)', done: true })
  })

  // ─── 超时/取消（运行中 abort → kill 子进程 + done）────

  it('kills child on abort mid-run and yields done', async () => {
    const adapter = new DshAdapter({ model: 'deepseek-chat' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)
    const controller = new AbortController()

    const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'deepseek-chat',
      signal: controller.signal,
    })
    const pending = startGen(gen)
    controller.abort()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    child.emitClose(null)

    const r = await pending
    expect(r.value).toEqual({ content: '', done: true })
  })

  // ─── 运行时长遥测（P0）+ idle timeout 移除（P1）────

  it('logs periodic "dsh 运行中" progress every 30s and clears the timer on close', async () => {
    vi.useFakeTimers()
    try {
      const adapter = new DshAdapter({ model: 'deepseek-chat' })
      const child = fakeChild()
      vi.mocked(spawnSupervised).mockReturnValue(child as any)

      const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
        model: 'deepseek-chat',
      })
      const pending = startGen(gen)

      // 30s 后第一条周期日志（elapsedSec 随 fake 时钟推进）
      await vi.advanceTimersByTimeAsync(30_000)
      const first = logMocks.info.mock.calls.filter((c) => c[0] === 'dsh 运行中')
      expect(first).toHaveLength(1)
      expect(first[0][1]).toMatchObject({ elapsedSec: expect.any(Number) })

      // 再 30s → 第二条且 elapsedSec 递增（遥测语义：运行时长可见）
      await vi.advanceTimersByTimeAsync(30_000)
      const second = logMocks.info.mock.calls.filter((c) => c[0] === 'dsh 运行中')
      expect(second).toHaveLength(2)
      expect(second[1][1].elapsedSec).toBeGreaterThanOrEqual(second[0][1].elapsedSec)

      child.emitClose(0)
      const r = await pending
      expect(r.value).toEqual({ content: '', done: true })
      // 三路径（正常/abort/spawn-error）都汇到 close 统一清理，不留泄漏 timer
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('logs completion with totalSec and exitCode on close', async () => {
    const adapter = new DshAdapter({ model: 'deepseek-chat' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = drive(
      adapter.chatStream([{ role: 'user', content: 'hi' }], {
        model: 'deepseek-chat',
      })
    )
    const pending = startGen(gen)
    child.emitClose(0)
    await pending
    await gen.next()

    const completion = logMocks.info.mock.calls.find((c) => c[0] === 'dsh 完成')
    expect(completion).toBeDefined()
    expect(completion![1]).toMatchObject({ totalSec: expect.any(Number), exitCode: 0 })
  })

  it('no longer attaches idle timeout (超时策略不变; wall-clock 由 30min hard timeout 兜底)', async () => {
    const adapter = new DshAdapter({ model: 'deepseek-chat' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = drive(
      adapter.chatStream([{ role: 'user', content: 'hi' }], {
        model: 'deepseek-chat',
      })
    )
    const pending = startGen(gen)
    child.emitClose(0)
    await pending
    await gen.next()

    expect(attachIdleTimeout).not.toHaveBeenCalled()
  })

  // ─── spawn 参数形态 ───────────────────────────

  it('spawns node <dsh-entry> --profile headless --json, prompt via stdin (no positional, no context)', async () => {
    const adapter = new DshAdapter({ model: 'deepseek-chat', apiKey: 'sk-key' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = drive(
      adapter.chatStream([{ role: 'user', content: 'hi' }], {
        model: 'deepseek-chat',
      })
    )
    const pending = startGen(gen)

    const [bin, args, opts] = vi.mocked(spawnSupervised).mock.calls.at(-1)!
    // 纯 JS CLI 用 node.exe spawn（避免 .cmd 包装 EINVAL，CLAUDE.md「node path/to/cli.mjs」）
    expect(bin).toBe(process.execPath)
    expect(args[0]).toBe(DSH_ENTRY)
    // 命令行只留 flags：无 positional（题面不占命令行，Windows 32K 限制解除）
    expect(args.slice(1)).toEqual(['--profile', 'headless', '--json'])
    expect(args.at(-1)).toBe('--json')
    expect(args).not.toContain('--patch')
    // 题面唯一传输通道 = stdin（spawnSupervised.input）
    expect(opts.input).toBe('User: hello\n\nAssistant: hi')
    // 凭证注入：apiKey 以 DEEPSEEK_API_KEY 进 spawn env（DS_KEY 复用）
    expect(opts.env!.DEEPSEEK_API_KEY).toBe('sk-key')
    // 官方 seam：headless 确定性放行（unconditional，适配器钉死）
    expect(opts.env!.DSH_PERMISSION_MODE).toBe('danger-full-access')

    child.emitClose(0)
    await pending
    await gen.next()
  })

  it('passes >32K prompt through stdin in full (no truncation, Windows 32K 限制解除)', async () => {
    // 40000 个中文字符（~120KB UTF-8）——旧 positional 形态必超 Windows CreateProcess
    // 32K 命令行限制；stdin 通道下必须原样全量进 input，且不得再走 messagesToPromptBounded。
    // 首尾哨兵 + 长度断言：只测长度会漏「中间被替换/保尾砍头」，只测首尾会漏中段丢失。
    const hugePrompt = '头' + '猫'.repeat(39998) + '尾'
    vi.mocked(messagesToPrompt).mockReturnValueOnce(hugePrompt)
    const adapter = new DshAdapter({ model: 'deepseek-chat' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = drive(
      adapter.chatStream([{ role: 'user', content: 'hi' }], {
        model: 'deepseek-chat',
      })
    )
    const pending = startGen(gen)

    const [bin, args, opts] = vi.mocked(spawnSupervised).mock.calls.at(-1)!
    expect(bin).toBe(process.execPath)
    // 命令行只有 flags，超长题面一个字符都不进 args
    expect(args.slice(1)).toEqual(['--profile', 'headless', '--json'])
    expect(opts.input).toBe(hugePrompt)
    expect(opts.input!.length).toBe(40000)
    expect(opts.input!.startsWith('头')).toBe(true)
    expect(opts.input!.endsWith('尾')).toBe(true)
    // 截断告警已随 positional 形态一并退役
    expect(logMocks.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('命令行长度'),
      expect.anything()
    )

    child.emitClose(0)
    await pending
    await gen.next()
  })

  it('falls back to DS_KEY when apiKey is placeholder local (72f6e3c 同族回归修复)', async () => {
    // local 占位符视为「未配置真实 key」——72f6e3c 同族回归：非空就注入会把占位符当真
    // key 注入（opencode flash猫 local 实锤），dsh 对称修复，占位符 fallback 到 .env DS_KEY
    const prev = process.env.DS_KEY
    process.env.DS_KEY = 'sk-real-from-env'
    try {
      const adapter = new DshAdapter({ model: 'deepseek-chat', apiKey: 'local' })
      const child = fakeChild()
      vi.mocked(spawnSupervised).mockReturnValue(child as any)

      const gen = drive(
        adapter.chatStream([{ role: 'user', content: 'hi' }], {
          model: 'deepseek-chat',
        })
      )
      const pending = startGen(gen)

      const [, , opts] = vi.mocked(spawnSupervised).mock.calls.at(-1)!
      expect(opts.env!.DEEPSEEK_API_KEY).toBe('sk-real-from-env')

      child.emitClose(0)
      await pending
      await gen.next()
    } finally {
      if (prev === undefined) delete process.env.DS_KEY
      else process.env.DS_KEY = prev
    }
  })

  it('does not override DEEPSEEK_API_KEY when apiKey is empty (credentials 落盘兜底)', async () => {
    // apiKey 为空时不注入（条件注入）——不写空串覆盖继承 env（process.env 有则保留、
    // 无则保持 undefined）；空串会覆盖 dsh credentials 落盘兜底（有凭证的安装失效）
    const adapter = new DshAdapter({ model: 'deepseek-chat' }) // 无 apiKey
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = drive(
      adapter.chatStream([{ role: 'user', content: 'hi' }], {
        model: 'deepseek-chat',
      })
    )
    const pending = startGen(gen)

    const [, , opts] = vi.mocked(spawnSupervised).mock.calls.at(-1)!
    // 与继承 env 一致（未注入空串覆盖）——测试环境 process.env 可能带真实 DS_KEY
    expect(opts.env!.DEEPSEEK_API_KEY).toBe(process.env.DEEPSEEK_API_KEY)

    child.emitClose(0)
    await pending
    await gen.next()
  })

  // ─── MCP 结构化路由（context → per-spawn patch overlay）────

  it('passes --patch with mcp-catstudy config + env inline when context present', async () => {
    const adapter = new DshAdapter({ model: 'deepseek-chat' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = drive(
      adapter.chatStream([{ role: 'user', content: 'hi' }], {
        model: 'deepseek-chat',
        context: {
          sessionId: 's1',
          agentId: 'a1',
          msgId: 'm1',
          token: 'tok123',
          triggerAuthorName: '店长',
          triggerMsgId: 'trigger-msg-1',
        },
      })
    )
    const pending = startGen(gen)

    const args = vi.mocked(spawnSupervised).mock.calls.at(-1)![1]
    const opts = vi.mocked(spawnSupervised).mock.calls.at(-1)![2]
    const patchIdx = args.indexOf('--patch')
    expect(patchIdx).toBeGreaterThan(-1)
    const patchPath = args[patchIdx + 1]
    // 命令行只留 flags（--profile/--patch/--json），题面走 stdin
    expect(args).toEqual([DSH_ENTRY, '--profile', 'headless', '--patch', patchPath, '--json'])
    // ⚠️ 位置红线：--json 必须在 --patch 之后（提前会让 patch 被当 app 参数）
    expect(args.indexOf('--patch')).toBeLessThan(args.indexOf('--json'))
    expect(args.at(-1)).toBe('--json')
    expect(opts.input).toBe('User: hello\n\nAssistant: hi')

    const content = readFileSync(patchPath, 'utf8')
    // MCP client 行（官方实证 schema：mcp__<serverName>__* 工具面）
    expect(content).toContain('@deepseek-ai/dsh-mcp-client')
    expect(content).toContain('serverName: catstudy')
    // env 字面量内联（guaranteed 路径，非 !!js 引用）
    expect(content).toContain("CATSTUDY_SIGNAL_TOKEN: 'tok123'")
    expect(content).toContain("CATSTUDY_SESSION_ID: 's1'")
    expect(content).toContain("CATSTUDY_AGENT_ID: 'a1'")
    expect(content).toContain("CATSTUDY_MSG_ID: 'm1'")
    expect(content).toContain('CATSTUDY_TRIGGER_AUTHOR_NAME')
    expect(content).toContain("'店长'")
    // triggerMsgId 的消费者是猫自己（提交 commit 的 shell，继承进程 env）——
    // 走进程 env 注入（对齐 opencode/claude），不进 MCP patch env（OQ1 硬伤修复）
    expect(content).not.toContain('CATSTUDY_TRIGGER_MSG_ID')
    expect(opts.env!.CATSTUDY_TRIGGER_MSG_ID).toBe('trigger-msg-1')
    // 模型行：裸 `- id:` 行写覆盖（非 insert）——agent-default-model 已在 headless
    // 底座挂载，insert 会 duplicate loader entry id 炸；patch config 整块替换非合并，
    // provider/model 均必填
    expect(content).toContain(
      `- id: agent-default-model
  config:
    provider: deepseek-official
    model: 'deepseek-chat'`
    )
    // 不是 insert 形态（insert 会重复 id 炸）
    expect(content).not.toContain('- insert:\n    - id: agent-default-model')
    // approval row 不得塞回 patch（走 DSH_PERMISSION_MODE seam，单独 policy: never 会
    // 触发 permission-presets 校验 match no preset）——钉死该不变式
    expect(content).not.toContain('approval')

    // 完成 → patch 文件 finally 清理
    child.emitClose(0)
    await pending
    await gen.next()
    expect(existsSync(patchPath)).toBe(false)
  })

  it('context 无 triggerMsgId 时 patch env 不含 CATSTUDY_TRIGGER_MSG_ID（有值才 push）', async () => {
    // 测试隔离：注入 shell 的 CATSTUDY_TRIGGER_MSG_ID 会经 ...process.env 透传进
    // opts.env——清理后再断言（对齐 claude.test.ts regression baseline 范式）
    const saved = process.env.CATSTUDY_TRIGGER_MSG_ID
    delete process.env.CATSTUDY_TRIGGER_MSG_ID
    try {
      const adapter = new DshAdapter({ model: 'deepseek-chat' })
      const child = fakeChild()
      vi.mocked(spawnSupervised).mockReturnValue(child as any)

      const gen = drive(
        adapter.chatStream([{ role: 'user', content: 'hi' }], {
          model: 'deepseek-chat',
          context: {
            sessionId: 's1',
            agentId: 'a1',
            msgId: 'm1',
            token: 'tok123',
          },
        })
      )
      const pending = startGen(gen)

      const args = vi.mocked(spawnSupervised).mock.calls.at(-1)![1]
      const opts = vi.mocked(spawnSupervised).mock.calls.at(-1)![2]
      const patchIdx = args.indexOf('--patch')
      expect(patchIdx).toBeGreaterThan(-1)
      const patchPath = args[patchIdx + 1]
      const content = readFileSync(patchPath, 'utf8')
      // 基础五变量仍在，triggerMsgId 缺省不写（patch env 与进程 env 双侧都不注入）
      expect(content).toContain("CATSTUDY_MSG_ID: 'm1'")
      expect(content).not.toContain('CATSTUDY_TRIGGER_MSG_ID')
      expect(opts.env!.CATSTUDY_TRIGGER_MSG_ID).toBeUndefined()

      child.emitClose(0)
      await pending
      await gen.next()
    } finally {
      if (saved !== undefined) process.env.CATSTUDY_TRIGGER_MSG_ID = saved
    }
  })

  // ─── A8：静态守卫——事件流在位、截断逻辑不得回流 ─────────────

  it('A8: dsh.ts 走 --json 事件流，且不含截断 helper / 全量 stdout 拼接', () => {
    const source = readFileSync(new URL('./dsh.ts', import.meta.url), 'utf8')
    // 事件流形态在位（--json flag + 四类事件分支）
    expect(source).toContain("'--json'")
    for (const type of ['thinking', 'tool_call', 'tool_result', 'final']) {
      expect(source).toContain(`'${type}'`)
    }
    // 题面全量走 stdin：截断 helper 不得回流；stdout 不得再全量拼接
    expect(source).not.toContain('messagesToPromptBounded')
    expect(source).not.toContain('PROMPT_ARG_MAX')
    expect(source).not.toContain('stdout +=')
  })

  it('does not pass --patch when context is absent', async () => {
    const adapter = new DshAdapter({ model: 'deepseek-chat' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = drive(
      adapter.chatStream([{ role: 'user', content: 'hi' }], {
        model: 'deepseek-chat',
      })
    )
    const pending = startGen(gen)

    const args = vi.mocked(spawnSupervised).mock.calls.at(-1)![1]
    expect(args).not.toContain('--patch')

    child.emitClose(0)
    await pending
    await gen.next()
  })
})
