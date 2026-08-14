import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import { readFileSync, existsSync } from 'node:fs'
import type { Chunk } from '@cat-study/shared'

// Mock cli-utils 以阻止模块加载时的 resolveJsEntry() 调用
// vi.hoisted：mock 工厂被提升到 const 声明之前，直接引用 DSH_ENTRY 会 TDZ 抛错
// → dsh.ts 模块加载时 resolveJsEntry() 抛错被 catch → DSH_ENTRY='' 走「未安装」早退
const DSH_ENTRY = vi.hoisted(
  () => 'C:/Users/test/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js'
)
vi.mock('./cli-utils.js', () => ({
  resolveJsEntry: vi.fn(() => DSH_ENTRY),
  messagesToPrompt: vi.fn(() => 'User: hello\n\nAssistant: hi'),
  attachIdleTimeout: vi.fn(() => () => {}),
  spawnSupervised: vi.fn(),
  getWorkspaceDir: vi.fn(() => '/tmp/workspace'),
}))

// Logger mock：log 对象用 vi.hoisted 共享
const logMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../logger.js', () => ({
  createLogger: () => logMocks,
}))

import { DshAdapter } from './dsh.js'
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

describe('DshAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
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

  // ─── 成功路径（headless 一次性 stdout → 最终答案 chunk）────

  it('yields final answer chunk from stdout on exit 0', async () => {
    const adapter = new DshAdapter({ model: 'deepseek-chat', apiKey: 'sk-key' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = drive(
      adapter.chatStream([{ role: 'user', content: 'hi' }], {
        model: 'deepseek-chat',
      })
    )
    const pending = startGen(gen)
    child.stdout.push('这是最终答案\n')
    await tick() // data 事件派发后再 close（见 tick 注释）
    child.emitClose(0)

    const chunks = [await pending, await gen.next()].map((r) => r.value)
    expect(chunks).toEqual([
      { content: '这是最终答案', done: false, kind: 'text' },
      { content: '', done: true },
    ])
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

  // ─── 失败路径 ─────────────────────────────────

  it('yields error chunk on non-zero exit with stderr detail', async () => {
    const adapter = new DshAdapter({ model: 'deepseek-chat' })
    const child = fakeChild()
    vi.mocked(spawnSupervised).mockReturnValue(child as any)

    const gen = adapter.chatStream([{ role: 'user', content: 'hi' }], {
      model: 'deepseek-chat',
    })
    const pending = startGen(gen)
    child.stderr.push('Model returned an error: boom')
    await tick() // data 事件派发后再 close
    child.emitClose(1)

    const r = await pending
    expect(r.value).toEqual({
      content: 'dsh CLI 启动失败 (exit code 1): Model returned an error: boom',
      done: true,
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

  // ─── spawn 参数形态 ───────────────────────────

  it('spawns node <dsh-entry> --profile headless with task as positional (no context)', async () => {
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
    expect(args.slice(1)).toEqual(['--profile', 'headless', 'User: hello\n\nAssistant: hi'])
    expect(args).not.toContain('--patch')
    // 凭证注入：apiKey 以 DEEPSEEK_API_KEY 进 spawn env（DS_KEY 复用）
    expect(opts.env!.DEEPSEEK_API_KEY).toBe('sk-key')
    // 官方 seam：headless 确定性放行（unconditional，适配器钉死）
    expect(opts.env!.DSH_PERMISSION_MODE).toBe('danger-full-access')

    child.emitClose(0)
    await pending
    await gen.next()
  })

  it('truncates prompt at PROMPT_ARG_MAX (32K 命令行保护)', async () => {
    vi.mocked(messagesToPrompt).mockReturnValueOnce('x'.repeat(40000))
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
    expect(args.at(-1)!.length).toBe(30000)

    child.emitClose(0)
    await pending
    await gen.next()
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
        },
      })
    )
    const pending = startGen(gen)

    const args = vi.mocked(spawnSupervised).mock.calls.at(-1)![1]
    const patchIdx = args.indexOf('--patch')
    expect(patchIdx).toBeGreaterThan(-1)
    // launcher flags 在前，task 最后
    expect(args[patchIdx + 2]).toBe('User: hello\n\nAssistant: hi')
    const patchPath = args[patchIdx + 1]

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

    // 完成 → patch 文件 finally 清理
    child.emitClose(0)
    await pending
    await gen.next()
    expect(existsSync(patchPath)).toBe(false)
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
