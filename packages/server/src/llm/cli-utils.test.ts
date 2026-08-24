import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'node:path'
import {
  resolveJsEntry,
  messagesToPrompt,
  messagesToPromptBounded,
  spawnSupervised,
  ensureProxy,
  stopProxyIfSpawned,
  __test_reset,
} from './cli-utils.js'
import type { LLMMessage } from '@cat-study/shared'

// ─── spawnSupervised env 合并测试 ────────────────

const spawnMock = vi.hoisted(() => vi.fn())
const existsSyncMock = vi.hoisted(() => vi.fn())
const execSyncMock = vi.hoisted(() => vi.fn())
const readFileSyncMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: spawnMock, execSync: execSyncMock }
})
// 注意：cli-utils.ts 是 `import fs from 'node:fs'`（default import）——只替换具名
// 导出 existsSync 时 default 仍是真实 fs，mock 不生效（吐槽猫审查实证：三个用例
// 实际全跑 supervisor 分支）。必须同时替换 default 对象上的 existsSync/readFileSync
//（readFileSync 供 resolveJsEntry 读 package.json）。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    default: { ...actual, existsSync: existsSyncMock, readFileSync: readFileSyncMock },
    existsSync: existsSyncMock,
    readFileSync: readFileSyncMock,
  }
})

function fakeSpawnedChild() {
  return {
    stdin: { end: vi.fn(), write: vi.fn() },
    stdout: {},
    stderr: {},
    on: vi.fn(),
    kill: vi.fn(),
    unref: vi.fn(),
  }
}

describe('spawnSupervised env 合并（per-agent 注入正确性前提）', () => {
  const ORIG_PROXY = process.env.HTTPS_PROXY

  beforeEach(() => {
    vi.clearAllMocks()
    spawnMock.mockReturnValue(fakeSpawnedChild())
  })

  afterEach(() => {
    // 恢复 process.env（test 2 设置了冲突值）
    if (ORIG_PROXY === undefined) delete process.env.HTTPS_PROXY
    else process.env.HTTPS_PROXY = ORIG_PROXY
  })

  it('直接 spawn 分支：opts.env 覆盖 process.env，且 process.env 键全保留', () => {
    // 旧实现 env: opts.env——传部分 env 会整个丢 process.env（PATH 丢失 → CLI 起不来）
    existsSyncMock.mockReturnValue(false) // supervisor 脚本缺失 → 直接 spawn 分支

    spawnSupervised('opencode', ['run', '--format', 'json'], {
      label: 'test',
      env: { HTTPS_PROXY: 'http://127.0.0.1:7897' },
    })

    const call = spawnMock.mock.calls.at(-1)!
    expect(call[0]).toBe('opencode') // 分支判定：第一参数是 bin 而非 process.execPath
    const receivedEnv = call[2].env as Record<string, string>
    expect(receivedEnv.HTTPS_PROXY).toBe('http://127.0.0.1:7897') // opts.env 生效
    expect(receivedEnv.PATH).toBe(process.env.PATH) // process.env 键保留（不丢）
  })

  it('supervisor 分支：opts.env 覆盖 process.env（不被反向覆盖），并带父 PID 标记', () => {
    // 旧实现 {...opts.env, ...process.env} 顺序颠倒——opts.env 的注入值会被 process.env
    // 同键覆盖（若 server 恰好也有该键），注入静默失效
    existsSyncMock.mockReturnValue(true) // supervisor 脚本存在 → supervisor 分支
    process.env.HTTPS_PROXY = 'http://127.0.0.1:wrong' // 冲突值：process.env 也有该键

    spawnSupervised('opencode', ['run'], {
      label: 'test',
      env: { HTTPS_PROXY: 'http://127.0.0.1:7897' },
    })

    const call = spawnMock.mock.calls.at(-1)!
    expect(call[0]).toBe(process.execPath) // 分支判定：第一参数是 node 而非 bin
    const receivedEnv = call[2].env as Record<string, string>
    expect(receivedEnv.HTTPS_PROXY).toBe('http://127.0.0.1:7897') // opts.env 胜出（不被 process.env 反向覆盖）
    expect(receivedEnv.PATH).toBe(process.env.PATH) // process.env 键保留
    expect(receivedEnv.CATSTUDY_SUPERVISOR_PARENT_PID).toBe(String(process.pid))
  })

  it('不传 env 时等价于 process.env（undefined 展开零副作用）', () => {
    existsSyncMock.mockReturnValue(false)
    spawnSupervised('opencode', ['run'], { label: 'test' })

    const call = spawnMock.mock.calls.at(-1)!
    expect(call[0]).toBe('opencode') // 分支判定：直接 spawn
    const receivedEnv = call[2].env as Record<string, string>
    expect(receivedEnv.PATH).toBe(process.env.PATH)
  })
})

// ─── resolveJsEntry ───────────────────────────────

describe('resolveJsEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // win32 分支（本机平台；非 win32 直接返回 binName，见 cli-utils.ts）
  const PKG_ROOT = path.join(
    'C:/Users/test/AppData/Roaming/npm',
    'node_modules',
    '@deepseek-ai/dsh'
  )

  it('resolves JS entry from bin field (object form)', () => {
    execSyncMock.mockReturnValue('C:/Users/test/AppData/Roaming/npm\n')
    readFileSyncMock.mockReturnValue(JSON.stringify({ bin: { dsh: 'lib/bin.js' } }))
    expect(resolveJsEntry('@deepseek-ai/dsh', 'dsh')).toBe(path.join(PKG_ROOT, 'lib/bin.js'))
  })

  it('resolves JS entry from bin field (string form)', () => {
    execSyncMock.mockReturnValue('C:/Users/test/AppData/Roaming/npm\n')
    readFileSyncMock.mockReturnValue(JSON.stringify({ bin: 'lib/bin.js' }))
    expect(resolveJsEntry('@deepseek-ai/dsh', 'dsh')).toBe(path.join(PKG_ROOT, 'lib/bin.js'))
  })

  it('throws when package.json cannot be read (CLI 未安装)', () => {
    execSyncMock.mockReturnValue('C:/Users/test/AppData/Roaming/npm\n')
    readFileSyncMock.mockImplementation(() => {
      throw new Error('ENOENT')
    })
    expect(() => resolveJsEntry('@deepseek-ai/dsh', 'dsh')).toThrow('无法找到 dsh 的 JS 入口')
  })

  it('throws when bin field lacks the command name', () => {
    execSyncMock.mockReturnValue('C:/Users/test/AppData/Roaming/npm\n')
    readFileSyncMock.mockReturnValue(JSON.stringify({ bin: { other: 'lib/other.js' } }))
    expect(() => resolveJsEntry('@deepseek-ai/dsh', 'dsh')).toThrow('无法找到 dsh 的 JS 入口')
  })
})

// ─── messagesToPrompt ─────────────────────────────

describe('messagesToPrompt', () => {
  it('returns empty string for empty array', () => {
    expect(messagesToPrompt([])).toBe('')
  })

  it('formats a system message', () => {
    const messages: LLMMessage[] = [{ role: 'system', content: '你是一只暹罗猫' }]
    expect(messagesToPrompt(messages)).toBe('你是一只暹罗猫\n\n---\n')
  })

  it('formats a user message', () => {
    const messages: LLMMessage[] = [{ role: 'user', content: '你好' }]
    expect(messagesToPrompt(messages)).toBe('User: 你好')
  })

  it('formats an assistant message', () => {
    const messages: LLMMessage[] = [{ role: 'assistant', content: '你好喵~' }]
    expect(messagesToPrompt(messages)).toBe('Assistant: 你好喵~')
  })

  it('joins multiple messages with double newlines', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: '你是一只猫' },
      { role: 'user', content: '今天天气？' },
      { role: 'assistant', content: '阳光很好喵' },
    ]
    const result = messagesToPrompt(messages)
    expect(result).toBe('你是一只猫\n\n---\n\n\nUser: 今天天气？\n\nAssistant: 阳光很好喵')
  })

  it('handles multi-line content', () => {
    const messages: LLMMessage[] = [{ role: 'user', content: '第一行\n第二行' }]
    expect(messagesToPrompt(messages)).toBe('User: 第一行\n第二行')
  })

  it('handles system message without content', () => {
    const messages: LLMMessage[] = [{ role: 'system', content: '' }]
    expect(messagesToPrompt(messages)).toBe('\n\n---\n')
  })
})

// ─── messagesToPromptBounded ──────────────────────

describe('messagesToPromptBounded', () => {
  it('returns empty string for empty array', () => {
    expect(messagesToPromptBounded([], 100)).toBe('')
  })

  it('matches messagesToPrompt byte-for-byte when total ≤ maxLen', () => {
    const messages: LLMMessage[] = [
      { role: 'system', content: '你是一只猫' },
      { role: 'user', content: '今天天气？' },
      { role: 'assistant', content: '阳光很好喵' },
      { role: 'user', content: '【当前待回复】再问一次' },
    ]
    expect(messagesToPromptBounded(messages, 10000)).toBe(messagesToPrompt(messages))
  })

  it('keeps system head + last trigger message, drops oldest mid, stays ≤ maxLen', () => {
    // 超限序列：system + 最旧历史(长) + 较旧历史(短) + 末尾「【当前待回复】」触发消息。
    // maxLen=200 卡在「保较旧、丢最旧」区间——若旧逻辑 slice(0,max) 保头砍尾，
    // 会只剩 system 前缀、把末尾触发消息砍掉（本用例正是钉死方向性修复）
    const messages: LLMMessage[] = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: '最旧历史 ' + 'a'.repeat(500) },
      { role: 'user', content: '较旧历史 ' + 'b'.repeat(50) },
      { role: 'user', content: '【当前待回复】最新任务' },
    ]
    const result = messagesToPromptBounded(messages, 200)
    expect(result.startsWith('SYS\n\n---\n')).toBe(true)
    expect(result.endsWith('User: 【当前待回复】最新任务')).toBe(true)
    expect(result.length).toBeLessThanOrEqual(200)
    expect(result).toContain('较旧历史')
    expect(result).not.toContain('最旧历史')
  })

  it('keeps last trigger message when there is no system message', () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: '旧问题 ' + 'a'.repeat(500) },
      { role: 'user', content: '【当前待回复】当前' },
    ]
    // 无 system：中间历史整条丢弃后，只剩末尾触发消息（保尾不保头）
    expect(messagesToPromptBounded(messages, 100)).toBe('User: 【当前待回复】当前')
  })

  it('keeps a single oversized message intact (整条消息不切碎)', () => {
    // 单条消息本身就超 maxLen：head/tail 保底，整条保留（不字符硬切）
    const messages: LLMMessage[] = [{ role: 'user', content: 'x'.repeat(5000) }]
    expect(messagesToPromptBounded(messages, 100)).toBe('User: ' + 'x'.repeat(5000))
  })
})

// ─── stopProxyIfSpawned ─────────────────────────────

describe('stopProxyIfSpawned', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __test_reset()
    spawnMock.mockReturnValue(fakeSpawnedChild())
    existsSyncMock.mockReturnValue(true) // 代理脚本存在（codex_proxy.py 命中）→ 走 spawn 分支
  })

  /** netstat 探测：无监听（execSync 抛错）→ 视为未运行，触发 spawn */
  const mockNoProxyRunning = () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('no listening')
    })
  }
  /** netstat 探测：有监听（execSync 成功）→ 复用已有代理，不 spawn */
  const mockProxyRunning = () => {
    execSyncMock.mockReturnValue('  LISTENING  9090')
  }

  it('kills only the child it spawned', () => {
    mockNoProxyRunning()
    ensureProxy('test-key')
    expect(spawnMock).toHaveBeenCalledTimes(1)

    const child = spawnMock.mock.results[0].value
    stopProxyIfSpawned()
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when nothing was spawned (probe found existing proxy)', () => {
    mockProxyRunning()
    ensureProxy('test-key')
    expect(spawnMock).not.toHaveBeenCalled()

    stopProxyIfSpawned()
  })

  it('is a no-op on second call (handle already cleared)', () => {
    mockNoProxyRunning()
    ensureProxy('test-key')
    expect(spawnMock).toHaveBeenCalledTimes(1)

    const child = spawnMock.mock.results[0].value
    stopProxyIfSpawned()
    stopProxyIfSpawned()
    expect(child.kill).toHaveBeenCalledTimes(1)
  })
})
