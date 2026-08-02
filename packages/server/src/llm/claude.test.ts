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

  it('buildEnv keeps DeepSeek tier fallbacks when no baseUrl (regression)', () => {
    const adapter = new ClaudeAdapter({
      apiKey: 'sk-test-key',
      model: 'claude-sonnet-4-6',
      effortLevel: 'high',
    })

    const env = (adapter as any).buildEnv() as Record<string, string>

    // DeepSeek 路径逐键保持现状：HAIKU/SUBAGENT 兜底 flash，无 FABLE 覆盖，无 ENABLE_TOOL_SEARCH
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('deepseek-v4-flash')
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('deepseek-v4-flash')
    expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBeUndefined()
    expect(env.ENABLE_TOOL_SEARCH).toBeUndefined()
  })

  it('buildEnv targets custom endpoint with model tier fallbacks (Kimi K3)', () => {
    const adapter = new ClaudeAdapter({
      apiKey: 'sk-kimi-key',
      model: 'kimi-k3[1m]',
      baseUrl: 'https://api.moonshot.ai/anthropic',
      effortLevel: 'max',
    })

    const env = (adapter as any).buildEnv() as Record<string, string>

    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-kimi-key')
    expect(env.ANTHROPIC_MODEL).toBe('kimi-k3[1m]')
    // 非 DeepSeek 端点：HAIKU/SUBAGENT/FABLE 全量兜底主模型
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kimi-k3[1m]')
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('kimi-k3[1m]')
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('kimi-k3[1m]')
    expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe('kimi-k3[1m]')
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('kimi-k3[1m]')
    // Kimi 端点不支持 Tool Search
    expect(env.ENABLE_TOOL_SEARCH).toBe('false')
    expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBe('max')
  })
})
