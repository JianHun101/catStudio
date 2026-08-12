import { describe, it, expect, vi, beforeEach } from 'vitest'
import { spawn } from 'node:child_process'
import { OllamaAdapter } from './ollama.js'

/**
 * Mock fetch 返回 NDJSON 流（Ollama /api/chat stream 格式：每行一个 JSON，
 * 无 `data:` 前缀，与 deepseek 的 SSE 不同）。
 */
/** 捕获最后一次请求体，供断言 images 字段使用 */
const requestBodyHolder = { lastBody: null as any }

function mockFetchNDJSON(chunks: string[]): {
  response: Response
  holder: typeof requestBodyHolder
} {
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })

  const headers = new Headers()
  headers.set('Content-Type', 'application/x-ndjson')

  return {
    response: {
      ok: true,
      status: 200,
      body: stream,
      headers,
    } as unknown as Response,
    holder: requestBodyHolder,
  }
}

/** stub fetch：捕获请求体 JSON 并返回 NDJSON mock 响应 */
function stubFetch(chunks: string[]): { holder: typeof requestBodyHolder } {
  const { response, holder } = mockFetchNDJSON(chunks)
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    holder.lastBody = JSON.parse(init?.body as string)
    return response as any
  })
  return { holder }
}

/** 收集 async generator 的所有值 */
async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = []
  for await (const item of gen) {
    results.push(item)
  }
  return results
}

// ─── spawn mock（自动拉起路径） ───────────────────────────

/** 迷你 ChildProcess：支持 on('error')/emit('error')/unref，默认不触发 error */
interface SpawnChildMock {
  on(ev: string, fn: (err: Error) => void): SpawnChildMock
  emit(ev: string, ...args: unknown[]): void
  unref: ReturnType<typeof vi.fn>
}

function makeSpawnChild(): SpawnChildMock {
  let errorHandler: ((err: Error) => void) | null = null
  return {
    on(ev, fn) {
      if (ev === 'error') errorHandler = fn
      return this
    },
    emit(ev, ...args) {
      if (ev === 'error' && errorHandler) errorHandler(args[0] as Error)
    },
    unref: vi.fn(),
  }
}

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  // 默认实现：返回不触发 error 的迷你 child（拉起成功路径）；失败用例自行覆盖
  vi.mocked(spawn).mockImplementation(makeSpawnChild as any)
})

const RAW_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYAAAAAMAASsJTYQA'
const DATA_URL = `data:image/png;base64,${RAW_B64}`

describe('OllamaAdapter', () => {
  it('yields content chunks from NDJSON stream', async () => {
    const { response } = mockFetchNDJSON([
      JSON.stringify({ message: { content: '你好' }, done: false }) + '\n',
      JSON.stringify({ message: { content: '，世界' }, done: false }) + '\n',
      JSON.stringify({ done: true }) + '\n',
    ])
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response as any)

    const adapter = new OllamaAdapter({ model: 'qwen3.5:9b' })
    const chunks = await collect(
      adapter.chatStream([{ role: 'user', content: 'hi' }], { model: 'qwen3.5:9b' })
    )

    expect(chunks).toHaveLength(3)
    expect(chunks[0]).toEqual({ content: '你好', done: false })
    expect(chunks[1]).toEqual({ content: '，世界', done: false })
    expect(chunks[2]).toEqual({ content: '', done: true })
    // 正常路径零额外开销：仅一次 /api/chat，无探测无拉起
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('strips dataURL prefix before sending images to /api/chat', async () => {
    const { holder } = stubFetch([JSON.stringify({ done: true }) + '\n'])

    const adapter = new OllamaAdapter({ model: 'qwen3.5:9b' })
    await collect(
      adapter.chatStream(
        [{ role: 'user', content: '图', images: [DATA_URL, `${DATA_URL}extra`] }],
        { model: 'qwen3.5:9b' }
      )
    )

    const body = holder.lastBody
    expect(body.messages[0].images).toEqual([RAW_B64, `${RAW_B64}extra`])
    expect(body.messages[0].images[0]).not.toContain('data:')
  })

  it('passes raw base64 images through unchanged', async () => {
    const { holder } = stubFetch([JSON.stringify({ done: true }) + '\n'])

    const adapter = new OllamaAdapter({ model: 'qwen3.5:9b' })
    await collect(
      adapter.chatStream([{ role: 'user', content: '图', images: [RAW_B64] }], {
        model: 'qwen3.5:9b',
      })
    )

    expect(holder.lastBody.messages[0].images).toEqual([RAW_B64])
  })

  it('omits images field when no images present', async () => {
    const { holder } = stubFetch([JSON.stringify({ done: true }) + '\n'])

    const adapter = new OllamaAdapter({ model: 'qwen3.5:9b' })
    await collect(
      adapter.chatStream([{ role: 'user', content: '纯文本' }], { model: 'qwen3.5:9b' })
    )

    expect(holder.lastBody.messages[0].images).toBeUndefined()
  })

  it('surfaces non-2xx API errors', async () => {
    const response = {
      ok: false,
      status: 400,
      body: null,
      text: async () => JSON.stringify({ error: 'illegal base64 data' }),
    } as unknown as Response
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response as any)

    const adapter = new OllamaAdapter({ model: 'qwen3.5:9b' })
    await expect(
      collect(adapter.chatStream([{ role: 'user', content: 'hi' }], { model: 'qwen3.5:9b' }))
    ).rejects.toThrow('Ollama API error 400')
  })

  // ─── 自动拉起（店长契约：仅 fetch 连接失败后触发，正常路径零额外延迟） ───

  it('auto-starts ollama on connection failure and retries once', async () => {
    const { response } = mockFetchNDJSON([JSON.stringify({ done: true }) + '\n'])
    let chatCalls = 0
    let tagsCalls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      if (String(url).endsWith('/api/chat')) {
        chatCalls++
        if (chatCalls === 1) throw new TypeError('fetch failed')
        return response as any
      }
      // /api/tags：拉起前探测失败（确认不可达）→ 轮询探测成功（就绪）
      tagsCalls++
      return { ok: tagsCalls > 1 } as Response
    })

    const adapter = new OllamaAdapter({ model: 'qwen3.5:9b' })
    const chunks = await collect(
      adapter.chatStream([{ role: 'user', content: 'hi' }], { model: 'qwen3.5:9b' })
    )

    expect(chunks).toEqual([{ content: '', done: true }])
    expect(chatCalls).toBe(2) // 失败一次 + 拉起后重试一次
    expect(tagsCalls).toBeGreaterThanOrEqual(2) // 拉起前探测 + 轮询就绪探测
    expect(spawn).toHaveBeenCalledTimes(1) // 幂等：只拉起一次
  })

  it('retries without spawning when probe succeeds', async () => {
    const { response } = mockFetchNDJSON([JSON.stringify({ done: true }) + '\n'])
    let chatCalls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      if (String(url).endsWith('/api/chat')) {
        chatCalls++
        if (chatCalls === 1) throw new TypeError('fetch failed')
        return response as any
      }
      return { ok: true } as Response // 服务可达（瞬时故障）→ 不拉起直接重试
    })

    const adapter = new OllamaAdapter({ model: 'qwen3.5:9b' })
    const chunks = await collect(
      adapter.chatStream([{ role: 'user', content: 'hi' }], { model: 'qwen3.5:9b' })
    )

    expect(chunks).toEqual([{ content: '', done: true }])
    expect(chatCalls).toBe(2)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('falls back to original error when ollama cannot be started', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))
    // 命令不存在：spawn 触发 error 事件（ENOENT）→ 静默降级，抛回原 fetch failed
    const child = makeSpawnChild()
    vi.mocked(spawn).mockReturnValue(child as any)
    process.nextTick(() => child.emit('error', new Error('spawn ollama ENOENT')))

    const adapter = new OllamaAdapter({ model: 'qwen3.5:9b' })
    await expect(
      collect(adapter.chatStream([{ role: 'user', content: 'hi' }], { model: 'qwen3.5:9b' }))
    ).rejects.toThrow('fetch failed')
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('does not auto-start for non-local baseUrl', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))

    const adapter = new OllamaAdapter({
      model: 'qwen3.5:9b',
      baseUrl: 'http://192.168.1.10:11434',
    })
    await expect(
      collect(adapter.chatStream([{ role: 'user', content: 'hi' }], { model: 'qwen3.5:9b' }))
    ).rejects.toThrow('fetch failed')
    expect(fetchMock).toHaveBeenCalledTimes(1) // 仅原请求，无探测无重试
    expect(spawn).not.toHaveBeenCalled()
  })

  it('does not auto-start on timeout abort', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }))

    const adapter = new OllamaAdapter({ model: 'qwen3.5:9b' })
    await expect(
      collect(adapter.chatStream([{ role: 'user', content: 'hi' }], { model: 'qwen3.5:9b' }))
    ).rejects.toThrow('Ollama API 请求超时')
    expect(fetchMock).toHaveBeenCalledTimes(1) // abort 不触发拉起
    expect(spawn).not.toHaveBeenCalled()
  })

  it('forwards external abort to stream phase after auto-start retry', async () => {
    // 重试成功后的流式阶段：外部 abort 必须立即中断（不等 30s chunkTimer）。
    // 挂起流只在 controller abort 时 reject——若监听器被提前移除（回归），
    // abort 不转发、read() 永不 resolve，测试会超时失败，能真实捕获回归。
    const externalController = new AbortController()
    const encoder = new TextEncoder()
    let markReadStarted!: () => void
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve
    })

    const stream = new ReadableStream<Uint8Array>({
      pull(_readCtrl) {
        markReadStarted() // read() 已进入挂起（流式阶段进行中）
        return new Promise((_resolve, reject) => {
          const onAbort = () => {
            externalController.signal.removeEventListener('abort', onAbort)
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          }
          externalController.signal.addEventListener('abort', onAbort)
        })
      },
    })

    const retryResponse = {
      ok: true,
      status: 200,
      body: stream,
      headers: new Headers(),
    } as unknown as Response

    let chatCalls = 0
    let tagsCalls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      if (String(url).endsWith('/api/chat')) {
        chatCalls++
        if (chatCalls === 1) throw new TypeError('fetch failed')
        return retryResponse
      }
      tagsCalls++
      return { ok: tagsCalls > 1 } as Response // 拉起前探测失败 → 轮询就绪
    })

    const adapter = new OllamaAdapter({ model: 'qwen3.5:9b' })
    const chunks: { content: string; done: boolean }[] = []
    const consumer = (async () => {
      for await (const c of adapter.chatStream([{ role: 'user', content: 'hi' }], {
        model: 'qwen3.5:9b',
        signal: externalController.signal,
      })) {
        chunks.push(c)
      }
    })()

    await readStarted // 确认流式阶段已挂起，再触发外部中断（消除时序竞态）
    externalController.abort()
    await consumer

    expect(chunks).toEqual([{ content: '', done: true }])
    expect(chatCalls).toBe(2) // 失败一次 + 拉起后重试一次
    expect(spawn).toHaveBeenCalledTimes(1)
  })
})
