import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
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
 */
function fakeChild(overrides: Partial<{ exitCode: number | null; killed: boolean }> = {}) {
  const stdout = new Readable({ read() {} })
  const stderr = new Readable({ read() {} })
  return {
    stdout,
    stderr,
    kill: vi.fn(),
    on: vi.fn(),
    exitCode: null,
    killed: false,
    ...overrides,
  }
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
    child.stdout.push(JSON.stringify({ type: 'text', text: 'hello ' }) + '\n')
    child.stdout.push(JSON.stringify({ type: 'text', text: 'world' }) + '\n')
    child.stdout.push(JSON.stringify({ type: 'done' }) + '\n')
    child.stdout.push(null)

    const chunks = await collect(gen)
    expect(chunks).toEqual([
      { content: 'hello ', done: false, kind: 'text' },
      { content: 'world', done: false, kind: 'text' },
      { content: '', done: true },
    ])
  })

  it('spawns with run --format json -q -m and passes prompt via stdin', async () => {
    const adapter = new OpencodeAdapter({ model: 'anthropic/claude-sonnet-4-5' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'anthropic/claude-sonnet-4-5',
    })
    child.stdout.push(null)
    await collect(gen)

    const args = vi.mocked(spawnSupervised).mock.calls.at(-1)![1] as string[]
    expect(args).toEqual(['run', '--format', 'json', '-q', '-m', 'anthropic/claude-sonnet-4-5'])
    const opts = vi.mocked(spawnSupervised).mock.calls.at(-1)![2] as {
      input?: string
      cwd?: string
    }
    expect(opts.input).toBe(messagesToPrompt([{ role: 'user', content: 'hi' }]))
    expect(opts.cwd).toBe('/tmp/workspace')
  })

  it('uses options.model when provided (overrides constructor model — 多猫不串台)', async () => {
    // 缓存键按 model 隔离后实例与 model 一一对应，但 chatStream 仍以 options.model
    // 优先（socketio.ts 每轮传当轮 agent.llmModel）——双保险：即使缓存键未来被误改，
    // 同一实例服务不同 model 的猫时 spawn 参数仍取当轮 model（deepseek.ts/ollama.ts 同款惯例）
    const adapter = new OpencodeAdapter({ model: 'anthropic/claude-sonnet-4-5' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'openai/gpt-5',
    })
    child.stdout.push(null)
    await collect(gen)

    const args = vi.mocked(spawnSupervised).mock.calls.at(-1)![1] as string[]
    expect(args).toEqual(['run', '--format', 'json', '-q', '-m', 'openai/gpt-5'])
  })

  it('logs effective model (options.model || this.model) when options override constructor', async () => {
    // 店长观察项①：启动日志与 abort 日志记生效 model（与 spawn 参数同值），
    // 排查时日志不再误导为构造 model（缓存键按 model 隔离后实例与 model 一一对应）
    const adapter = new OpencodeAdapter({ model: 'anthropic/claude-sonnet-4-5' })
    const child = fakeChild()
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
    const child = fakeChild()
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

  // ─── error 事件 ─────────────────────────────

  it('yields error chunk on error event (nested error.message)', async () => {
    const adapter = new OpencodeAdapter({ model: 'anthropic/claude-sonnet-4-5' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'anthropic/claude-sonnet-4-5',
    })
    child.stdout.push(JSON.stringify({ type: 'error', error: { message: 'unknown model' } }) + '\n')
    child.stdout.push(null)

    const chunks = await collect(gen)
    expect(chunks[0].content).toContain('unknown model')
    expect(chunks.at(-1)?.done).toBe(true)
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
      child.stdout.push(JSON.stringify({ type: 'text', text: 'hi' }) + '\n')
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

  it('yields friendly error when child fails to spawn (ENOENT-like, exitCode null)', async () => {
    const adapter = new OpencodeAdapter({ model: 'anthropic/claude-sonnet-4-5' })
    const child = fakeChild() // exitCode null = 进程未能启动
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'anthropic/claude-sonnet-4-5',
    })
    child.stdout.push(null)

    const chunks = await collect(gen)
    expect(chunks[0].content).toContain('opencode CLI 无法启动')
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
    child.stdout.push(JSON.stringify({ type: 'text', text: 'hi' }) + '\n')
    child.stdout.push(null)

    const chunks = await collect(gen)
    expect(chunks).toEqual([
      { content: 'hi', done: false, kind: 'text' },
      { content: '', done: true },
    ])
  })
})
