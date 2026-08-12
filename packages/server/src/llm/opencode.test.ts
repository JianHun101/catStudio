import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import { dirname } from 'node:path'
import { existsSync } from 'node:fs'
import type { Chunk } from '@cat-study/shared'

// Mock cli-utils 以阻止模块加载时的 resolveBin() 调用
vi.mock('./cli-utils.js', () => ({
  resolveBin: vi.fn(() => 'C:/Users/test/AppData/Roaming/npm/opencode.cmd'),
  messagesToPrompt: vi.fn(() => 'User: hello\n\nAssistant: hi'),
  attachIdleTimeout: vi.fn(() => () => {}),
  spawnSupervised: vi.fn(),
  getWorkspaceDir: vi.fn(() => '/tmp/workspace'),
}))

// Logger mock：log 对象用 vi.hoisted 共享——测试用例需断言 log.info 调用参数（日志口径用例）
const logMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

// Mock logger
vi.mock('../logger.js', () => ({
  createLogger: () => logMocks,
}))

import { OpencodeAdapter } from './opencode.js'
import { spawnSupervised, messagesToPrompt } from './cli-utils.js'

/** 收集 async generator 的值 */
async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = []
  for await (const item of gen) {
    results.push(item)
  }
  return results
}

/**
 * 构造 fake CLI 子进程：stdout/stderr 为手工 Readable（时序可控，不自动 end），
 * 解析逻辑真实跑在流上（不 mock 内部解析）；kill/on 为 vi.fn 记录调用。
 * on/once 同时真实注册事件回调；emitClose/emitError 为测试辅助——手动派发
 * close/error 事件，模拟「close 晚于 stdout EOF」等真实时序（竞态用例依赖）。
 */
function fakeChild(overrides: Partial<{ exitCode: number | null; killed: boolean }> = {}) {
  const stdout = new Readable({ read() {} })
  const stderr = new Readable({ read() {} })
  const listeners = new Map<string, Set<(...args: any[]) => void>>()
  const register = (event: string, cb: (...args: any[]) => void) => {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event)!.add(cb)
  }
  const emitClose = (code: number | null) => {
    child.exitCode = code
    for (const cb of listeners.get('close') ?? []) cb(code)
  }
  const emitError = (err: Error) => {
    for (const cb of listeners.get('error') ?? []) cb(err)
  }
  const child = {
    stdout,
    stderr,
    kill: vi.fn(),
    on: vi.fn(register),
    once: vi.fn(register),
    emitClose,
    emitError,
    exitCode: null,
    killed: false,
    ...overrides,
  }
  return child
}

describe('OpencodeAdapter', () => {
  beforeEach(() => {
    // 隔离各测试间的 mock 调用历史（not.toHaveBeenCalled / mock.calls.at(-1) 依赖）
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  // ─── 构造 ────────────────────────────────────

  it('stores provider name', () => {
    const adapter = new OpencodeAdapter({ model: 'anthropic/claude-sonnet-4-5' })
    expect(adapter.provider).toBe('opencode')
  })

  // ─── 外部取消（前置已 abort）─────────────────

  it('yields done immediately when signal is already aborted', async () => {
    const adapter = new OpencodeAdapter({ model: 'anthropic/claude-sonnet-4-5' })
    const controller = new AbortController()
    controller.abort()

    const chunks = await collect(
      adapter.chatStream([{ role: 'user', content: 'hi' }], {
        model: 'anthropic/claude-sonnet-4-5',
        signal: controller.signal,
      })
    )

    expect(chunks).toEqual([{ content: '', done: true }])
    expect(spawnSupervised).not.toHaveBeenCalled()
  })

  // ─── 正常流式（text 事件 → Chunk + done）─────

  it('streams text events as chunks and finishes with done', async () => {
    const adapter = new OpencodeAdapter({ model: 'anthropic/claude-sonnet-4-5' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'anthropic/claude-sonnet-4-5',
    })
    // 1.18.16 实测结构：text 事件文本在 part.text（顶层无 text 字段）——
    // 旧解析直取 event.text 永不命中 → 空 done（luna 猫空回复根因）
    child.stdout.push(JSON.stringify({ type: 'text', part: { id: 'p1', text: 'hello ' } }) + '\n')
    child.stdout.push(JSON.stringify({ type: 'text', part: { id: 'p2', text: 'world' } }) + '\n')
    child.stdout.push(JSON.stringify({ type: 'done' }) + '\n')
    child.stdout.push(null)

    const chunks = await collect(gen)
    expect(chunks).toEqual([
      { content: 'hello ', done: false, kind: 'text' },
      { content: 'world', done: false, kind: 'text' },
      { content: '', done: true },
    ])
  })

  it('spawns with run --format json --thinking -m and passes prompt as positional message (no stdin, no -q)', async () => {
    const adapter = new OpencodeAdapter({ model: 'anthropic/claude-sonnet-4-5' })
    const child = fakeChild({ exitCode: 0 })
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'anthropic/claude-sonnet-4-5',
    })
    child.stdout.push(null)
    await collect(gen)

    const args = vi.mocked(spawnSupervised).mock.calls.at(-1)![1] as string[]
    // prompt 作为 positional message 尾部追加——opencode run 不读 stdin（1.18.16
    // help 无任何 stdin 选项，stdin 传参实测空转 exit 0 无输出，luna 猫「无法启动」根因）；
    // --thinking 实测必需——无它时推理模型的 reasoning 事件被过滤（tokens.reasoning>0
    // 但事件流只有 step_start/text/step_finish 三行，鸡兔同笼对照实测）
    expect(args).toEqual([
      'run',
      '--format',
      'json',
      '--thinking',
      '-m',
      'anthropic/claude-sonnet-4-5',
      'User: hello\n\nAssistant: hi',
    ])
    const opts = vi.mocked(spawnSupervised).mock.calls.at(-1)![2] as {
      input?: string
      cwd?: string
    }
    // 不再走 stdin——opencode run 不消费 stdin（positional 传参）；spawnSupervised
    // 无 input 时自动 end stdin 不挂起
    expect(opts.input).toBeUndefined()
    expect(opts.cwd).toBe('/tmp/workspace')
  })

  it('uses options.model when provided (overrides constructor model — 多猫不串台)', async () => {
    // 缓存键按 model 隔离后实例与 model 一一对应，但 chatStream 仍以 options.model
    // 优先（socketio.ts 每轮传当轮 agent.llmModel）——双保险：即使缓存键未来被误改，
    // 同一实例服务不同 model 的猫时 spawn 参数仍取当轮 model（deepseek.ts/ollama.ts 同款惯例）
    const adapter = new OpencodeAdapter({ model: 'anthropic/claude-sonnet-4-5' })
    const child = fakeChild({ exitCode: 0 })
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'openai/gpt-5',
    })
    child.stdout.push(null)
    await collect(gen)

    const args = vi.mocked(spawnSupervised).mock.calls.at(-1)![1] as string[]
    expect(args).toEqual([
      'run',
      '--format',
      'json',
      '--thinking',
      '-m',
      'openai/gpt-5',
      'User: hello\n\nAssistant: hi',
    ])
  })

  it('logs effective model (options.model || this.model) when options override constructor', async () => {
    // 店长观察项①：启动日志与 abort 日志记生效 model（与 spawn 参数同值），
    // 排查时日志不再误导为构造 model（缓存键按 model 隔离后实例与 model 一一对应）
    const adapter = new OpencodeAdapter({ model: 'anthropic/claude-sonnet-4-5' })
    const child = fakeChild({ exitCode: 0 })
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'openai/gpt-5',
    })
    child.stdout.push(null)
    await collect(gen)

    expect(logMocks.info).toHaveBeenCalledWith(
      '启动 opencode CLI',
      expect.objectContaining({ model: 'openai/gpt-5' })
    )
  })

  it('passes cwd through to spawnSupervised (session worktree)', async () => {
    const adapter = new OpencodeAdapter({ model: 'anthropic/claude-sonnet-4-5' })
    const child = fakeChild({ exitCode: 0 })
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'anthropic/claude-sonnet-4-5',
      cwd: 'D:/catStudy-sessions/wt-abc',
    })
    child.stdout.push(null)
    await collect(gen)

    const opts = vi.mocked(spawnSupervised).mock.calls.at(-1)![2] as { cwd?: string }
    expect(opts.cwd).toBe('D:/catStudy-sessions/wt-abc')
  })

  it('injects envExtra into spawn env and keeps process.env keys (per-agent proxy)', async () => {
    // luna 猫代理场景：构造 envExtra 后 spawn 收到完整合并 env——注入变量在场 +
    // process.env 其他键（PATH 等）不被丢弃（spawn 传部分 env 会丢整个 process.env）
    const adapter = new OpencodeAdapter({
      model: 'anthropic/claude-sonnet-4-5',
      envExtra: { HTTPS_PROXY: 'http://127.0.0.1:7897', NO_PROXY: 'localhost,127.0.0.1' },
    })
    const child = fakeChild({ exitCode: 0 })
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'anthropic/claude-sonnet-4-5',
    })
    child.stdout.push(null)
    await collect(gen)

    const opts = vi.mocked(spawnSupervised).mock.calls.at(-1)![2] as {
      env?: Record<string, string>
    }
    expect(opts.env).toBeDefined()
    expect(opts.env!.HTTPS_PROXY).toBe('http://127.0.0.1:7897')
    expect(opts.env!.NO_PROXY).toBe('localhost,127.0.0.1')
    // process.env 保留（PATH 是 Windows 子进程存活必需品）
    expect(opts.env!.PATH).toBe(process.env.PATH)
    // 未配置 envExtra 的构造器 → spawn env 不含注入变量（存量行为）
    const plain = new OpencodeAdapter({ model: 'anthropic/claude-sonnet-4-5' })
    const gen2 = plain.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'anthropic/claude-sonnet-4-5',
    })
    const child2 = fakeChild({ exitCode: 0 })
    vi.mocked(spawnSupervised).mockReturnValue(child2 as any)
    child2.stdout.push(null)
    await collect(gen2)
    const opts2 = vi.mocked(spawnSupervised).mock.calls.at(-1)![2] as {
      env?: Record<string, string>
    }
    expect(opts2.env).toBeDefined()
    expect(opts2.env!.HTTPS_PROXY).toBeUndefined()
    expect(opts2.env!.PATH).toBe(process.env.PATH)
  })

  // ─── error 事件 ─────────────────────────────

  it('yields error chunk on error event (error.data.message — 1.18.16 实测结构)', async () => {
    // 实测结构：详情在 error.data.message（嵌套两层）——旧解析只取 error.message
    // 取不到 → 永远 fallback「opencode 错误」，403 等详情全丢（无代理实测印证）
    const adapter = new OpencodeAdapter({ model: 'anthropic/claude-sonnet-4-5' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'anthropic/claude-sonnet-4-5',
    })
    child.stdout.push(
      JSON.stringify({
        type: 'error',
        error: { data: { message: 'Upstream request failed: [403] Forbidden' } },
      }) + '\n'
    )
    child.stdout.push(null)

    const chunks = await collect(gen)
    expect(chunks[0].content).toContain('Upstream request failed: [403] Forbidden')
    expect(chunks.at(-1)?.done).toBe(true)
  })

  it('falls back to top-level text when part.text is absent (其他版本兼容)', async () => {
    // 兜底链：part.text 为主（1.18.16 实测），顶层 text 兼容其他版本输出——
    // 两个字段都缺失时才跳过该行（不 yield 不报错）
    const adapter = new OpencodeAdapter({ model: 'anthropic/claude-sonnet-4-5' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'anthropic/claude-sonnet-4-5',
    })
    child.stdout.push(JSON.stringify({ type: 'text', text: 'legacy reply' }) + '\n')
    child.stdout.push(null)

    const chunks = await collect(gen)
    expect(chunks).toEqual([
      { content: 'legacy reply', done: false, kind: 'text' },
      { content: '', done: true },
    ])
  })

  // ─── reasoning 事件（--thinking 开启后输出，1.18.16 实测结构）──────────

  it('yields [思考] thinking chunk on reasoning event (part.text — 1.18.16 实测结构)', async () => {
    // 实测结构：reasoning 与 text 事件同构——文本在 part.text（顶层无 text）：
    // {"type":"reasoning","part":{"type":"reasoning","text":"..."}}；
    // 转 [思考] 前缀 chunk 对齐 claude.ts:222 / pi.ts:155 契约
    // （kind:'thinking' 前端折叠展示，socketio.ts:2706 不落库不参与上下文）
    const adapter = new OpencodeAdapter({ model: 'anthropic/claude-sonnet-4-5' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'anthropic/claude-sonnet-4-5',
    })
    child.stdout.push(
      JSON.stringify({
        type: 'reasoning',
        part: { id: 'r1', type: 'reasoning', text: 'Let me solve step by step' },
      }) + '\n'
    )
    child.stdout.push(JSON.stringify({ type: 'text', part: { id: 'p1', text: 'answer' } }) + '\n')
    child.stdout.push(null)

    const chunks = await collect(gen)
    expect(chunks).toEqual([
      { content: '[思考] Let me solve step by step', done: false, kind: 'thinking' },
      { content: 'answer', done: false, kind: 'text' },
      { content: '', done: true },
    ])
  })

  it('reasoning falls back to top-level text when part.text is absent (兼容)', async () => {
    const adapter = new OpencodeAdapter({ model: 'anthropic/claude-sonnet-4-5' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'anthropic/claude-sonnet-4-5',
    })
    child.stdout.push(JSON.stringify({ type: 'reasoning', text: 'legacy thinking' }) + '\n')
    child.stdout.push(null)

    const chunks = await collect(gen)
    expect(chunks).toEqual([
      { content: '[思考] legacy thinking', done: false, kind: 'thinking' },
      { content: '', done: true },
    ])
  })

  // ─── images 透传（base64 dataURL 落盘 → -f 传参，实测视觉模型支持）────

  it('materializes last user images to temp files and passes -f args (视觉模型实测支持)', async () => {
    const adapter = new OpencodeAdapter({ model: 'anthropic/claude-sonnet-4-5' })
    const child = fakeChild({ exitCode: 0 })
    const { readFileSync } = await import('node:fs')
    // 在 spawn 回调里断言落盘内容——此时 materializeImages 已 await 完成（文件在）；
    // collect 后 finally 已 rm，测试侧再读必然 ENOENT（清理断言见下一用例）
    vi.mocked(spawnSupervised).mockImplementation((...callArgs) => {
      const spawnArgs = callArgs[1] as string[]
      const fIdx = spawnArgs.indexOf('-f')
      expect(fIdx).toBeGreaterThan(-1)
      // 每张图一对 -f <path>；扩展名按 MIME 映射（png / jpeg→jpg）
      expect(spawnArgs[fIdx + 1]).toMatch(/opencode-img-.*\.png$/)
      expect(spawnArgs[fIdx + 2]).toBe('-f')
      expect(spawnArgs[fIdx + 3]).toMatch(/opencode-img-.*\.jpg$/)
      // prompt 仍为尾部 positional（-f 只插在 -m 之后）
      expect(spawnArgs.at(-1)).toBe('User: hello\n\nAssistant: hi')
      // 落盘内容 = base64 解码后的字节（dataURL 前缀已剥离）
      expect(readFileSync(spawnArgs[fIdx + 1]).toString()).toBe('hello')
      expect(readFileSync(spawnArgs[fIdx + 3]).toString()).toBe('world')
      return child as any
    })

    // 两条 user 消息：最后一条带图（只取最后一条的图——opencode run 单 message 形态）
    const gen = adapter.chatStream(
      [
        { role: 'user', content: '历史消息' },
        {
          role: 'user',
          content: '看这张图',
          images: ['data:image/png;base64,aGVsbG8=', 'data:image/jpeg;base64,d29ybGQ='],
        },
      ],
      { model: 'anthropic/claude-sonnet-4-5' }
    )
    child.stdout.push(null)
    await collect(gen)
  })

  it('cleans up image temp dir after stream (finally rm)', async () => {
    const adapter = new OpencodeAdapter({ model: 'anthropic/claude-sonnet-4-5' })
    const child = fakeChild({ exitCode: 0 })
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream(
      [{ role: 'user', content: '图', images: ['data:image/png;base64,aGVsbG8='] }],
      { model: 'anthropic/claude-sonnet-4-5' }
    )
    child.stdout.push(null)
    await collect(gen)

    const args = vi.mocked(spawnSupervised).mock.calls.at(-1)![1] as string[]
    const fIdx = args.indexOf('-f')
    const dir = dirname(args[fIdx + 1])
    // finally 已 await rm——临时目录不残留
    expect(existsSync(dir)).toBe(false)
  })

  // ─── abort 转发链（8a64187 教训：断言「abort 确实触发 kill」而非挂起后超时）───

  it('abort during streaming kills child with SIGTERM (abort forwarding chain)', async () => {
    vi.useFakeTimers()
    try {
      const adapter = new OpencodeAdapter({ model: 'anthropic/claude-sonnet-4-5' })
      const child = fakeChild()
      vi.mocked(spawnSupervised).mockReturnValue(child as any)

      const controller = new AbortController()
      // chatStream 返回 AsyncIterable，运行时是 async generator——next() 需要 cast
      const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
        model: 'anthropic/claude-sonnet-4-5',
        signal: controller.signal,
      }) as AsyncGenerator<Chunk>

      // 第一行 text 事件被消费后 generator 挂起等待下一行——
      // 此时 abort 监听器已挂、流循环已进入，abort 触发 kill 与流时序解耦
      child.stdout.push(JSON.stringify({ type: 'text', part: { text: 'hi' } }) + '\n')
      const first = await gen.next()
      expect(first.value).toEqual({ content: 'hi', done: false, kind: 'text' })

      controller.abort()
      // 核心断言：abort 事件确实转发了 kill（不是挂起后超时兜底）
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')

      // 结束流 → 循环退出 → 收尾 done（aborted 路径不产出后续错误）
      child.stdout.push(null)
      const rest: Chunk[] = []
      for await (const c of gen) rest.push(c)
      expect(rest.at(-1)?.done).toBe(true)

      // 推进 5s 让 SIGKILL 兜底 timer 触发完毕，避免 pending timer 挂住测试进程
      vi.advanceTimersByTime(5000)
    } finally {
      vi.useRealTimers()
    }
  })

  // ─── 未安装提示 ─────────────────────────────

  it('yields friendly install hint when CLI is not installed (resolveBin fails)', async () => {
    // resetModules 会重新执行 vi.mock factory 创建新 mock 实例——必须先拿到新
    // cli-utils 模块再改其 resolveBin 实现，opencode.js 加载时才会走到 catch 分支
    vi.resetModules()
    const freshCliUtils = await import('./cli-utils.js')
    vi.mocked(freshCliUtils.resolveBin).mockImplementation(() => {
      throw new Error('not found')
    })
    const { OpencodeAdapter: FreshAdapter } = await import('./opencode.js')
    const adapter = new FreshAdapter({ model: 'anthropic/claude-sonnet-4-5' })

    const chunks = await collect(
      adapter.chatStream([{ role: 'user', content: 'hi' }], {
        model: 'anthropic/claude-sonnet-4-5',
      })
    )

    expect(chunks[0].content).toContain('opencode CLI 未安装')
    expect(chunks[0].content).toContain('npm i -g opencode-ai')
    // 新模块实例的 spawnSupervised 本次测试内无调用
    expect(freshCliUtils.spawnSupervised).not.toHaveBeenCalled()
  })

  // ─── spawn 失败 / 无输出路径 ────────────────

  it('yields cannot-start error with reason on spawn error event (ENOENT-like)', async () => {
    // 文案归位：exitCode null 不再自动判「无法启动」（成功退出无输出也会撞 null
    // 竞态窗口）——只有 spawn 'error' 事件（进程从未启动，ENOENT 类）才报该文案
    const adapter = new OpencodeAdapter({ model: 'anthropic/claude-sonnet-4-5' })
    const child = fakeChild() // exitCode null + spawn error
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'anthropic/claude-sonnet-4-5',
    })
    const chunksPromise = collect(gen)
    // 等 generator 推进到 spawn + error 监听注册——materializeImages 的 await
    // 让 spawn 延后到 microtask（generator 惰性，第一次 next 才执行）；提前
    // emitError 会漏掉监听（无监听者 → spawnFailed 标记丢失 → 误入 wait close）
    await vi.waitFor(() => {
      expect(vi.mocked(spawnSupervised)).toHaveBeenCalled()
    })
    await vi.waitFor(() => {
      expect(vi.mocked(child.on)).toHaveBeenCalledWith('error', expect.any(Function))
    })
    // spawn error 先派发（spawnFailed=true）再 EOF——与真实时序一致（error 事件
    // 在 spawn 阶段），且避免 generator 误入 wait close 5s race 拖垮测试
    child.emitError(new Error('spawn ENOENT'))
    child.stdout.push(null)

    const chunks = await chunksPromise
    expect(chunks[0].content).toContain('opencode CLI 无法启动')
    expect(chunks[0].content).toContain('spawn ENOENT')
    expect(chunks.at(-1)?.done).toBe(true)
  })

  it('yields error with stderr summary on non-zero exit without output', async () => {
    const adapter = new OpencodeAdapter({ model: 'anthropic/claude-sonnet-4-5' })
    const child = fakeChild({ exitCode: 1 })
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'anthropic/claude-sonnet-4-5',
    })
    child.stderr.push('opencode: unknown model')
    // 等一个 tick 确保 stderr data 已被收集（data 事件异步派发），再结束 stdout
    await new Promise((r) => setTimeout(r, 0))
    child.stdout.push(null)

    const chunks = await collect(gen)
    expect(chunks[0].content).toContain('opencode CLI 启动失败 (exit code 1)')
    expect(chunks[0].content).toContain('opencode: unknown model')
    expect(chunks.at(-1)?.done).toBe(true)
  })

  it('yields empty done on exit 0 without output (no false cannot-start)', async () => {
    // 文案归位覆盖点：exit 0 无输出 = 空响应，不报错（旧代码 exitCode null 竞态
    // 把成功退出误报「无法启动」；exitCode 已定 0 时直接走空 done，不进入 wait）
    const adapter = new OpencodeAdapter({ model: 'anthropic/claude-sonnet-4-5' })
    const child = fakeChild({ exitCode: 0 })
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'anthropic/claude-sonnet-4-5',
    })
    child.stdout.push(null)

    const chunks = await collect(gen)
    expect(chunks).toEqual([{ content: '', done: true }])
  })

  it('waits for close before judging exitCode (close later than stdout EOF)', async () => {
    // 竞态修复核心用例：stdout EOF（流循环退出）时 close 未派发、exitCode 仍
    // null——旧代码在此误读 null 报「无法启动」（server 日志 19:46:05 实证）；
    // 新代码先等 close 再判定，exit 0 走空 done
    const adapter = new OpencodeAdapter({ model: 'anthropic/claude-sonnet-4-5' })
    const child = fakeChild() // exitCode null + 无 spawn error → 进入 wait close
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'anthropic/claude-sonnet-4-5',
    })
    const chunksPromise = collect(gen)
    child.stdout.push(null)
    // 轮询等 wait close 的 once('close') 挂上（流循环退出后），再派发 close——
    // 模拟真实时序：close 晚于 stdout EOF；若直接 emitClose 会漏掉 wait 注册
    await vi.waitFor(() => {
      expect(vi.mocked(child.once)).toHaveBeenCalledWith('close', expect.any(Function))
    })
    child.emitClose(0) // 模拟 close 晚到：exit 0

    const chunks = await chunksPromise
    expect(chunks).toEqual([{ content: '', done: true }])
  })

  it('truncates prompt beyond Windows command-line limit with warning', async () => {
    // Windows 32K 命令行限制防御：positional prompt 超阈值截断 + warn——
    // 旧代码 stdin 传参无此限制，本用例为新增路径的静态防护断言
    vi.mocked(messagesToPrompt).mockReturnValue('x'.repeat(40000))
    const adapter = new OpencodeAdapter({ model: 'anthropic/claude-sonnet-4-5' })
    const child = fakeChild({ exitCode: 0 })
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'anthropic/claude-sonnet-4-5',
    })
    child.stdout.push(null)
    await collect(gen)

    const args = vi.mocked(spawnSupervised).mock.calls.at(-1)![1] as string[]
    const promptArg = args.at(-1) as string
    expect(promptArg.length).toBeLessThanOrEqual(30000)
    expect(logMocks.warn).toHaveBeenCalledWith(
      'prompt 超过命令行长度阈值，已截断',
      expect.objectContaining({ promptLen: 40000, max: 30000 })
    )
  })

  // ─── maxTokens/temperature 忽略（不阻塞流式）──

  it('ignores maxTokens/temperature and streams normally (CLI config controls them)', async () => {
    const adapter = new OpencodeAdapter({ model: 'anthropic/claude-sonnet-4-5' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'anthropic/claude-sonnet-4-5',
      maxTokens: 100,
      temperature: 0.5,
    })
    child.stdout.push(JSON.stringify({ type: 'text', part: { text: 'hi' } }) + '\n')
    child.stdout.push(null)

    const chunks = await collect(gen)
    expect(chunks).toEqual([
      { content: 'hi', done: false, kind: 'text' },
      { content: '', done: true },
    ])
  })
})
