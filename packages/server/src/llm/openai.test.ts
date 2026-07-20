import { describe, it, expect, vi, afterEach } from 'vitest'

// Mock cli-utils 以阻止模块加载时的 resolveBin() 调用
vi.mock('./cli-utils.js', () => ({
  resolveBin: vi.fn(() => '/usr/local/bin/codex'),
  messagesToPrompt: vi.fn(() => 'User: hello\n\nAssistant: hi'),
  parseCodexOutput: vi.fn(),
  ensureProxy: vi.fn(),
  attachIdleTimeout: vi.fn(() => () => {}),
  attachExitError: vi.fn(),
}))

// Mock logger
vi.mock('../logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}))

import { OpenAIAdapter } from './openai.js'

/** 收集 async generator 的值 */
async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = []
  for await (const item of gen) {
    results.push(item)
  }
  return results
}

describe('OpenAIAdapter', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ─── 构造 ────────────────────────────────────

  it('stores provider name', () => {
    const adapter = new OpenAIAdapter({ apiKey: 'sk-test', model: 'gpt-4o' })
    expect(adapter.provider).toBe('openai')
  })

  // ─── 外部取消 ────────────────────────────────

  it('yields done immediately when signal is already aborted', async () => {
    const adapter = new OpenAIAdapter({ apiKey: 'sk-test', model: 'gpt-4o' })
    const controller = new AbortController()
    controller.abort()

    const chunks = await collect(
      adapter.chatStream([{ role: 'user', content: 'hi' }], {
        model: 'gpt-4o',
        signal: controller.signal,
      })
    )

    expect(chunks).toEqual([{ content: '', done: true }])
  })
})
