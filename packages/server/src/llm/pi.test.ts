import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PiAdapter } from './pi.js'
import type { LLMMessage } from '@cat-study/shared'

// ─── Mock logger ────────────────────────────────────────────────
// log 对象用 vi.hoisted 共享——测试用例需断言 log.warn 调用（maxTokens/temperature 忽略提示）
const logMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../logger.js', () => ({
  createLogger: () => logMocks,
}))

// ─── Mock pi SDK ───────────────────────────────────────────────

// 模块级状态：让 mock 函数和测试用例共享引用
const mockState = {
  subscriber: null as ((event: Record<string, unknown>) => void) | null,
  promptRejects: false,
  disposeCalled: false,
  abortCalled: false,
  unsubscribeCalled: false,
  systemPrompt: '',
}

vi.mock('@earendil-works/pi-coding-agent', () => ({
  ModelRuntime: {
    create: vi.fn(() =>
      Promise.resolve({
        credentialStore: {
          modify: vi.fn((_provider: string, fn: () => Promise<unknown>) => fn()),
        },
        getModel: vi.fn((_provider: string, _modelId: string) => ({ id: 'deepseek-chat' })),
        getModels: vi.fn(() => [][Symbol.iterator]()),
        authPath: '/tmp/mock-auth.json',
      })
    ),
  },
  createAgentSession: vi.fn(() => {
    const session = {
      agent: { state: { systemPrompt: '' } },
      subscribe: vi.fn((fn: (event: Record<string, unknown>) => void) => {
        mockState.subscriber = fn
        return () => {
          mockState.unsubscribeCalled = true
        }
      }),
      prompt: vi.fn(() => {
        if (mockState.promptRejects) {
          return Promise.reject(new Error('mock prompt error'))
        }
        // prompt resolve 后，pi 内部触发 agent_end。
        // 用 setImmediate 确保 generator 已经进入 await 状态。
        return new Promise<void>((resolve) => {
          setImmediate(() => {
            mockState.subscriber?.({ type: 'agent_end' })
            resolve()
          })
        })
      }),
      abort: vi.fn(() => {
        mockState.abortCalled = true
        return Promise.resolve()
      }),
      dispose: vi.fn(() => {
        mockState.disposeCalled = true
      }),
    }
    return Promise.resolve({ session })
  }),
}))

// ─── Helpers ───────────────────────────────────────────────────

function createAdapter(): PiAdapter {
  return new PiAdapter({ apiKey: 'test-key', model: 'deepseek-chat' })
}

function makeMessages(systemPrompt?: string, userContent = '你好'): LLMMessage[] {
  const msgs: LLMMessage[] = []
  if (systemPrompt) {
    msgs.push({ role: 'system', content: systemPrompt })
  }
  msgs.push({ role: 'user', content: userContent })
  return msgs
}

async function drain<T extends { done: boolean }>(stream: AsyncIterable<T>): Promise<T[]> {
  const chunks: T[] = []
  for await (const chunk of stream) {
    chunks.push(chunk)
  }
  return chunks
}

// ─── Tests ────────────────────────────────────────────────────

describe('PiAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockState.subscriber = null
    mockState.promptRejects = false
    mockState.disposeCalled = false
    mockState.abortCalled = false
    mockState.unsubscribeCalled = false
    mockState.systemPrompt = ''
  })

  // ── 构造 ─────────────────────────────────────────────────

  it('provider 应为 "pi"', () => {
    expect(createAdapter().provider).toBe('pi')
  })

  // ── 早期退出 ────────────────────────────────────────────

  it('已 abort 的信号应直接返回 done', async () => {
    const controller = new AbortController()
    controller.abort()

    const chunks = await drain(
      createAdapter().chatStream(makeMessages(), {
        model: 'deepseek-chat',
        signal: controller.signal,
      })
    )

    expect(chunks).toEqual([{ content: '', done: true }])
  })

  it('仅有 system 消息应直接返回 done', async () => {
    const chunks = await drain(
      createAdapter().chatStream([{ role: 'system', content: '只有系统提示' }], {
        model: 'deepseek-chat',
      })
    )

    expect(chunks).toEqual([{ content: '', done: true }])
  })

  // ── 正常流程 ────────────────────────────────────────────

  it('应产出 done chunk', async () => {
    const chunks = await drain(
      createAdapter().chatStream(makeMessages(), { model: 'deepseek-chat' })
    )
    const last = chunks[chunks.length - 1]
    expect(last.done).toBe(true)
  })

  it('应设置 system prompt 到 session', async () => {
    const piModule = await import('@earendil-works/pi-coding-agent')
    await drain(
      createAdapter().chatStream(makeMessages('你是猫咖店长'), { model: 'deepseek-chat' })
    )
    // systemPrompt 在 prompt() 调用前通过 session.agent.state 设置
    const { session } = (await vi.mocked(piModule.createAgentSession).mock.results[0]!.value) as any
    expect(session.agent.state.systemPrompt).toBe('你是猫咖店长')
  })

  it('应调用 session.prompt', async () => {
    const piModule = await import('@earendil-works/pi-coding-agent')
    await drain(
      createAdapter().chatStream(makeMessages('', '你好世界'), { model: 'deepseek-chat' })
    )
    const { session } = (await vi.mocked(piModule.createAgentSession).mock.results[0]!.value) as any
    expect(session.prompt).toHaveBeenCalled()
  })

  it('prompt 参数应包含用户消息', async () => {
    const piModule = await import('@earendil-works/pi-coding-agent')
    await drain(
      createAdapter().chatStream(makeMessages('', '你好世界'), { model: 'deepseek-chat' })
    )
    const { session } = (await vi.mocked(piModule.createAgentSession).mock.results[0]!.value) as any
    const promptArg = session.prompt.mock.calls[0][0] as string
    expect(promptArg).toContain('你好世界')
  })

  // ── maxTokens/temperature 忽略 ───────────────────────────

  it('maxTokens/temperature 被忽略时 log.warn 提示（判据与 claude.ts 同款：实际是否消费）', async () => {
    await drain(
      createAdapter().chatStream(makeMessages(), {
        model: 'deepseek-chat',
        maxTokens: 100,
        temperature: 0.5,
      })
    )
    expect(logMocks.warn).toHaveBeenCalledWith(expect.stringContaining('被 pi 适配器忽略'))
  })

  // ── 错误处理 ────────────────────────────────────────────

  it('prompt rejection 应产出错误 done chunk', async () => {
    mockState.promptRejects = true
    const chunks = await drain(
      createAdapter().chatStream(makeMessages(), { model: 'deepseek-chat' })
    )
    const last = chunks[chunks.length - 1]
    expect(last.done).toBe(true)
    expect(last.content).toContain('mock prompt error')
  })

  // ── 清理 ───────────────────────────────────────────────

  it('完成后应调用 session.dispose()', async () => {
    await drain(createAdapter().chatStream(makeMessages(), { model: 'deepseek-chat' }))
    expect(mockState.disposeCalled).toBe(true)
  })

  it('prompt 异常后也应调用 session.dispose()', async () => {
    mockState.promptRejects = true
    await drain(createAdapter().chatStream(makeMessages(), { model: 'deepseek-chat' }))
    expect(mockState.disposeCalled).toBe(true)
  })

  it('abort 后应调用 session.dispose()', async () => {
    // abort 在 session 创建之后、agent_end 之前触发。
    // 通过劫持 createAgentSession 在 session 创建后立即 abort。
    const controller = new AbortController()
    const piModule = await import('@earendil-works/pi-coding-agent')
    const origImpl = vi.mocked(piModule.createAgentSession).getMockImplementation()!

    vi.mocked(piModule.createAgentSession).mockImplementationOnce(async (opts) => {
      const result = await origImpl(opts)
      // session 已创建，在 prompt 返回前 abort
      controller.abort()
      return result
    })

    await drain(
      createAdapter().chatStream(makeMessages(), {
        model: 'deepseek-chat',
        signal: controller.signal,
      })
    )
    expect(mockState.disposeCalled).toBe(true)
  })

  it('完成后应调用 unsubscribe()', async () => {
    await drain(createAdapter().chatStream(makeMessages(), { model: 'deepseek-chat' }))
    expect(mockState.unsubscribeCalled).toBe(true)
  })
})
