import type { Chunk, ChatOptions, LLMMessage } from '@cat-study/shared'
import type { LLMAdapter } from './adapter.js'

interface OllamaConfig {
  model: string
  baseUrl?: string
}

/**
 * Ollama 本地模型适配器。
 * 使用原生 /api/chat 端点（stream: true 时每行一个 JSON，无 `data:` 前缀，
 * 与 OpenAI 兼容的 SSE 格式不同——这是和 deepseek.ts 解析逻辑的关键差异）。
 *
 * 视觉支持：LLMMessage.images（base64 dataURL 数组，如 data:image/png;base64,...）
 * 会在发送前剥掉 `;base64,` 前缀再透传给 /api/chat 的 images 字段
 * （qwen3.5:9b 等多模态模型可用）——Ollama 要求裸 base64，带前缀会报
 * "illegal base64 data" 400。无 images 时按纯文本发送。
 */
const toOllamaImage = (img: string): string => {
  const marker = ';base64,'
  const idx = img.indexOf(marker)
  return idx >= 0 ? img.slice(idx + marker.length) : img
}
export class OllamaAdapter implements LLMAdapter {
  readonly provider = 'ollama'
  private model: string
  private baseUrl: string

  constructor(config: OllamaConfig) {
    this.model = config.model
    this.baseUrl = config.baseUrl || 'http://127.0.0.1:11434'
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
      // 视觉图片：剥掉 dataURL 前缀（Ollama 只要裸 base64），多模态模型
      // （qwen3.5:9b 等）识别，纯文本模型忽略此字段
      ...(m.images && m.images.length > 0 ? { images: m.images.map(toOllamaImage) } : {}),
    }))

    const body: any = {
      model: options.model || this.model,
      messages: chatMessages,
      stream: true,
      options: {
        temperature: options.temperature ?? 0.7,
        num_predict: options.maxTokens || 2048,
      },
    }

    const controller = new AbortController()
    const timeoutMs = options.timeoutMs || 300_000 // 5 分钟，兼容推理模型思考时间

    // 外部信号：转发 abort 事件到内部 controller
    const onExternalAbort = () => controller.abort()
    externalSignal?.addEventListener('abort', onExternalAbort)

    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
        throw new Error(`Ollama API 请求超时 (${timeoutMs / 1000}s)`)
      }
      throw err
    }
    clearTimeout(timer)

    if (!response.ok) {
      externalSignal?.removeEventListener('abort', onExternalAbort)
      const err = await response.text()
      throw new Error(`Ollama API error ${response.status}: ${err}`)
    }

    // 流读取超时：每个 chunk 之间最长等 30 秒
    const streamTimeoutMs = 30_000
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      if (externalSignal?.aborted) {
        externalSignal?.removeEventListener('abort', onExternalAbort)
        yield { content: '', done: true }
        return
      }

      let readResult: ReadableStreamReadResult<Uint8Array>
      try {
        const chunkTimer = setTimeout(() => controller.abort(), streamTimeoutMs)
        readResult = await reader.read()
        clearTimeout(chunkTimer)
      } catch (err: any) {
        externalSignal?.removeEventListener('abort', onExternalAbort)
        if (err.name === 'AbortError') {
          if (externalSignal?.aborted) {
            yield { content: '', done: true }
            return
          }
          throw new Error('Ollama API 流读取超时')
        }
        throw err
      }

      const { done, value } = readResult
      if (done) break

      // Ollama NDJSON 流：每行一个完整 JSON 对象，无 `data:` 前缀
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        try {
          const parsed = JSON.parse(trimmed)
          const content = parsed.message?.content
          if (content) {
            yield { content, done: false }
          }
          if (parsed.done) {
            externalSignal?.removeEventListener('abort', onExternalAbort)
            yield { content: '', done: true }
            return
          }
        } catch {
          // skip unparseable
        }
      }
    }

    externalSignal?.removeEventListener('abort', onExternalAbort)
    yield { content: '', done: true }
  }
}
