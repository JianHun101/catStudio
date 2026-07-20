import { describe, it, expect, vi, afterEach } from 'vitest'

// Mock cli-utils 以阻止模块加载时的 resolveBin() 调用
vi.mock('./cli-utils.js', () => ({
  resolveBin: vi.fn(() => '/usr/local/bin/claude'),
  messagesToPrompt: vi.fn(() => 'User: hello\n\nAssistant: hi'),
  parseClaudeCodeOutput: vi.fn(),
  attachIdleTimeout: vi.fn(() => () => {}),
  spawnSupervised: vi.fn(),
}))

// Mock logger
vi.mock('../logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}))

import { ClaudeAdapter } from './claude.js'

/** 收集 async generator 的值 */
async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = []
  for await (const item of gen) {
    results.push(item)
  }
  return results
}

describe('ClaudeAdapter', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ─── 构造 ────────────────────────────────────

  it('stores provider name', () => {
    const adapter = new ClaudeAdapter({ apiKey: 'sk-test', model: 'claude-sonnet-4-6' })
    expect(adapter.provider).toBe('claude')
  })

  // ─── 外部取消 ────────────────────────────────

  it('yields done immediately when signal is already aborted', async () => {
    const adapter = new ClaudeAdapter({ apiKey: 'sk-test', model: 'claude-sonnet-4-6' })
    const controller = new AbortController()
    controller.abort()

    const chunks = await collect(
      adapter.chatStream([{ role: 'user', content: 'hi' }], {
        model: 'claude-sonnet-4-6',
        signal: controller.signal,
      })
    )

    expect(chunks).toEqual([{ content: '', done: true }])
  })

  // ─── buildEnv ─────────────────────────────────

  it('buildEnv sets all required environment variables', () => {
    const adapter = new ClaudeAdapter({
      apiKey: 'sk-test-key',
      model: 'claude-sonnet-4-6',
      effortLevel: 'high',
    })

    // 通过私有方法访问（用 any 绕过 TypeScript 检查）
    const env = (adapter as any).buildEnv() as Record<string, string>

    expect(env.DEEPSEEK_API_KEY).toBe('sk-test-key')
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-test-key')
    expect(env.ANTHROPIC_MODEL).toBe('claude-sonnet-4-6')
    expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBe('high')
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1')
  })
})
