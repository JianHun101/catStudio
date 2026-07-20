import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DeepSeekAdapter } from './deepseek.js'

/**
 * Mock fetch 返回可读流，适配 DeepSeek SSE 格式。
 * 每个 chunk 是 `data: {"choices":[{"delta":{"content":"..."}}]}\n\n`
 */
function mockFetchSSE(
  chunks: string[],
  options?: { status?: number; delayPerChunk?: number }
): Response {
  const status = options?.status ?? 200
  const encoder = new TextEncoder()
  let closed = false

  const stream = new ReadableStream({
    start(controller) {
      let i = 0
      async function enqueue() {
        for (const chunk of chunks) {
          if (closed) return
          if (options?.delayPerChunk) {
            await new Promise((r) => setTimeout(r, options.delayPerChunk))
          }
          controller.enqueue(encoder.encode(chunk))
          i++
        }
        controller.close()
      }
      enqueue()
    },
    cancel() {
      closed = true
    },
  })

  const headers = new Headers()
  headers.set('Content-Type', 'text/event-stream')

  return {
    ok: status >= 200 && status < 300,
    status,
    body: stream,
    text: async () => JSON.stringify({ error: 'mock error' }),
    headers,
    // Polyfill minimal fetch Response for test
  } as unknown as Response
}

/** 把一串文本变成 SSE data 块 */
function sseChunks(texts: string[]): string[] {
  return texts.map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`)
}

/** 收集 async generator 的所有值 */
async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = []
  for await (const item of gen) {
    results.push(item)
  }
  return results
}

describe('DeepSeekAdapter', () => {
  const config = { apiKey: 'sk-test', model: 'deepseek-chat' }
  let adapter: DeepSeekAdapter

  beforeEach(() => {
    adapter = new DeepSeekAdapter(config)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ─── 正常流式 ────────────────────────────────

  it('yields content chunks from SSE stream', async () => {
    const response = mockFetchSSE(sseChunks(['你好', '，世界']))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response as any)

    const chunks = await collect(
      adapter.chatStream([{ role: 'user', content: 'hi' }], { model: 'deepseek-chat' })
    )

    // 应包含两个内容块 + 一个 done=true 块
    expect(chunks).toHaveLength(3)
    expect(chunks[0]).toEqual({ content: '你好', done: false })
    expect(chunks[1]).toEqual({ content: '，世界', done: false })
    expect(chunks[2]).toEqual({ content: '', done: true })
  })

  it('handles empty messages array', async () => {
    const response = mockFetchSSE(sseChunks(['empty response']))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response as any)

    const chunks = await collect(adapter.chatStream([], { model: 'deepseek-chat' }))

    expect(chunks.length).toBeGreaterThan(0)
    // 至少有一个 done=true 的结束块
    expect(chunks.some((c) => c.done)).toBe(true)
  })

  // ─── [DONE] 信号 ─────────────────────────────

  it('handles [DONE] signal correctly', async () => {
    const response = mockFetchSSE([
      ...sseChunks(['part1']),
      'data: [DONE]\n\n',
      ...sseChunks(['should not appear']),
    ])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response as any)

    const chunks = await collect(
      adapter.chatStream([{ role: 'user', content: 'hi' }], { model: 'deepseek-chat' })
    )

    // [DONE] 后应停止，不应有后续内容
    expect(chunks).toHaveLength(2) // part1 + done
    expect(chunks[0].content).toBe('part1')
    expect(chunks[1]).toEqual({ content: '', done: true })
  })

  // ─── 外部取消 ────────────────────────────────

  it('yields done immediately when signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    const chunks = await collect(
      adapter.chatStream([{ role: 'user', content: 'hi' }], {
        model: 'deepseek-chat',
        signal: controller.signal,
      })
    )

    expect(chunks).toEqual([{ content: '', done: true }])
  })

  // ─── HTTP 错误 ───────────────────────────────

  it('throws on HTTP error', async () => {
    const response = mockFetchSSE([], { status: 500 })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response as any)

    await expect(
      collect(adapter.chatStream([{ role: 'user', content: 'hi' }], { model: 'deepseek-chat' }))
    ).rejects.toThrow(/DeepSeek API error 500/)
  })

  it('throws on 401 unauthorized', async () => {
    const response = mockFetchSSE([], { status: 401 })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response as any)

    await expect(
      collect(adapter.chatStream([{ role: 'user', content: 'hi' }], { model: 'deepseek-chat' }))
    ).rejects.toThrow(/DeepSeek API error 401/)
  })

  it('throws on 429 rate limited', async () => {
    const response = mockFetchSSE([], { status: 429 })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response as any)

    await expect(
      collect(adapter.chatStream([{ role: 'user', content: 'hi' }], { model: 'deepseek-chat' }))
    ).rejects.toThrow(/DeepSeek API error 429/)
  })

  // ─── 格式化的请求体 ──────────────────────────

  it('sends correct request body', async () => {
    const response = mockFetchSSE(sseChunks(['ok']))
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response as any)

    await collect(
      adapter.chatStream(
        [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
        ],
        { model: 'deepseek-chat', maxTokens: 512, temperature: 0.5 }
      )
    )

    const callArgs = fetchSpy.mock.calls[0]
    const body = JSON.parse(callArgs[1]!.body as string)

    expect(body.model).toBe('deepseek-chat')
    expect(body.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ])
    expect(body.max_tokens).toBe(512)
    expect(body.temperature).toBe(0.5)
    expect(body.stream).toBe(true)
  })

  it('uses custom baseUrl when provided', async () => {
    const customAdapter = new DeepSeekAdapter({
      apiKey: 'sk-test',
      model: 'deepseek-chat',
      baseUrl: 'https://custom.api.com',
    })
    const response = mockFetchSSE(sseChunks(['ok']))
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response as any)

    await collect(
      customAdapter.chatStream([{ role: 'user', content: 'hi' }], { model: 'deepseek-chat' })
    )

    const url = fetchSpy.mock.calls[0][0] as string
    expect(url).toContain('https://custom.api.com/v1/chat/completions')
  })

  // ─── 畸形的 SSE 数据 ─────────────────────────

  it('skips unparseable SSE data lines', async () => {
    const response = mockFetchSSE([
      'data: {not valid json}\n\n',
      ...sseChunks(['valid chunk']),
      'data: {also bad]\n\n',
    ])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response as any)

    const chunks = await collect(
      adapter.chatStream([{ role: 'user', content: 'hi' }], { model: 'deepseek-chat' })
    )

    // 只有 valid chunk + done
    expect(chunks).toHaveLength(2)
    expect(chunks[0].content).toBe('valid chunk')
  })

  it('skips empty lines and non-data lines', async () => {
    const response = mockFetchSSE([
      '\n',
      '   \n',
      ':comment line\n',
      ...sseChunks(['content']),
      'event: error\ndata: {"error":"ignored"}\n\n',
    ])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response as any)

    const chunks = await collect(
      adapter.chatStream([{ role: 'user', content: 'hi' }], { model: 'deepseek-chat' })
    )

    // 只有 content + done；event:error 的 data 行会被解析（以 "data:" 开头），
    // 但其 delta 为 undefined（无 choices），不会 yield 内容块
    expect(chunks).toHaveLength(2)
    expect(chunks[0].content).toBe('content')
  })

  // ─── 边界情况 ─────────────────────────────────

  it('handles messages with system role', async () => {
    const response = mockFetchSSE(sseChunks(['system acknowledged']))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response as any)

    const chunks = await collect(
      adapter.chatStream(
        [
          { role: 'system', content: 'you are helpful' },
          { role: 'user', content: 'hi' },
        ],
        { model: 'deepseek-chat' }
      )
    )

    expect(chunks[0].content).toBe('system acknowledged')
  })

  it('emits done:true at end of complete stream', async () => {
    const response = mockFetchSSE(sseChunks(['one', 'two', 'three']))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response as any)

    const chunks = await collect(
      adapter.chatStream([{ role: 'user', content: 'hi' }], { model: 'deepseek-chat' })
    )

    // 最后一项必须是 done:true
    const last = chunks[chunks.length - 1]
    expect(last.done).toBe(true)
  })

  // ─── 默认选项 ─────────────────────────────────

  it('applies default temperature when not specified', async () => {
    const response = mockFetchSSE(sseChunks(['ok']))
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response as any)

    await collect(adapter.chatStream([{ role: 'user', content: 'hi' }], { model: 'deepseek-chat' }))

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string)
    // 默认 temperature 0.7
    expect(body.temperature).toBe(0.7)
  })

  it('uses override model from options', async () => {
    const response = mockFetchSSE(sseChunks(['ok']))
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response as any)

    await collect(adapter.chatStream([{ role: 'user', content: 'hi' }], { model: 'deepseek-r1' }))

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string)
    expect(body.model).toBe('deepseek-r1')
  })
})
