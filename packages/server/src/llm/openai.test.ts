import { describe, it, expect, vi, afterEach } from 'vitest'

// Mock cli-utils 以阻止模块加载时的 resolveBin() 调用。
// `importOriginal` 展开保留未被覆盖的真实导出（`terminateChild` 走真身）——
// 部分工厂必须镜像消费方真正 import 的导出面，漏键即「调用点拿到 undefined」。
vi.mock('./cli-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cli-utils.js')>()
  return {
    ...actual,
    resolveBin: vi.fn(() => '/usr/local/bin/codex'),
    messagesToPrompt: vi.fn(() => 'User: hello\n\nAssistant: hi'),
    parseCodexOutput: vi.fn(),
    ensureProxy: vi.fn(),
    attachIdleTimeout: vi.fn(() => () => {}),
    attachExitError: vi.fn(),
  }
})

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
