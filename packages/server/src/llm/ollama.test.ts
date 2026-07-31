import { describe, it, expect, vi } from 'vitest'
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
    expect(fetchSpy).toHaveBeenCalled()
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
})
