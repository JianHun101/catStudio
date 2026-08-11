import type { Chunk, ChatOptions, LLMMessage } from '@cat-study/shared'
import type { LLMAdapter } from './adapter.js'

interface DeepSeekConfig {
  apiKey: string
  model: string
  baseUrl?: string
}

/**
 * DeepSeek API 适配器。
 * 使用 Chat Completions API (/v1/chat/completions)，DeepSeek 的主力端点。
 */
export class DeepSeekAdapter implements LLMAdapter {
  readonly provider = 'deepseek'
  private apiKey: string
  private model: string
  private baseUrl: string

  constructor(config: DeepSeekConfig) {
    this.apiKey = config.apiKey
    this.model = config.model
    this.baseUrl = config.baseUrl || 'https://api.deepseek.com'
  }

  async *chatStream(messages: LLMMessage[], options: ChatOptions): AsyncIterable<Chunk> {
    const externalSignal = options.signal

    if (externalSignal?.aborted) {
      yield { content: '', done: true }
      return
    }

    const chatMessages = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }))

    const body: any = {
      model: options.model || this.model,
      messages: chatMessages,
      max_tokens: options.maxTokens || 2048,
      temperature: options.temperature ?? 0.7,
      stream: true,
    }

    const controller = new AbortController()
    // 总超时：覆盖请求建立 + 流式读取全程（推理模型深度思考/长输出也受此预算约束，超时即 abort）
    const timeoutMs = options.timeoutMs || 300_000 // 5 分钟默认

    // 外部信号：转发 abort 事件到内部 controller
    const onExternalAbort = () => controller.abort()
    externalSignal?.addEventListener('abort', onExternalAbort)

    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err: any) {
      clearTimeout(timer)
      externalSignal?.removeEventListener('abort', onExternalAbort)
      if (err.name === 'AbortError') {
        if (externalSignal?.aborted) {
          throw new Error('请求被取消')
        }
        throw new Error(`DeepSeek API 请求超时 (${timeoutMs / 1000}s)`)
      }
      throw err
    }
    if (!response.ok) {
      clearTimeout(timer)
      externalSignal?.removeEventListener('abort', onExternalAbort)
      const err = await response.text()
      throw new Error(`DeepSeek API error ${response.status}: ${err}`)
    }

    // 流读取超时：每个 chunk 之间最长等 30 秒（可经 chunkTimeoutMs 覆盖——推理模型深度思考停顿可超 30s）
    const streamTimeoutMs = options.chunkTimeoutMs || 30_000
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        if (externalSignal?.aborted) {
          yield { content: '', done: true }
          return
        }

        let readResult: ReadableStreamReadResult<Uint8Array>
        try {
          const chunkTimer = setTimeout(() => controller.abort(), streamTimeoutMs)
          try {
            readResult = await reader.read()
          } finally {
            clearTimeout(chunkTimer)
          }
        } catch (err: any) {
          if (err.name === 'AbortError') {
            if (externalSignal?.aborted) {
              yield { content: '', done: true }
              return
            }
            throw new Error('DeepSeek API 流读取超时')
          }
          throw err
        }

        const { done, value } = readResult
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data: ')) continue

          const data = trimmed.slice(6)
          if (data === '[DONE]') {
            yield { content: '', done: true }
            return
          }

          try {
            const parsed = JSON.parse(data)
            const delta = parsed.choices?.[0]?.delta
            if (delta?.content) {
              yield { content: delta.content, done: false }
            }
          } catch {
            // skip unparseable
          }
        }
      }
    } finally {
      // 总超时与外部信号监听统一在流结束时清理（总超时覆盖流式全程，不只请求建立）
      clearTimeout(timer)
      externalSignal?.removeEventListener('abort', onExternalAbort)
    }

    yield { content: '', done: true }
  }
}
