/**
 * DeepSeek 非流式补全工具 — 用于摘要生成等不需要流式输出的场景。
 *
 * 直接调用 DeepSeek Chat Completions API（不通过 LLMAdapter 接口），
 * 返回完整文本。使用便宜模型（deepseek-chat）以降低成本。
 */

import { createLogger } from '../logger.js'

const log = createLogger('complete')

export interface CompleteOptions {
  /** API Key */
  apiKey: string
  /** 模型名称 */
  model?: string
  /** 基础 URL */
  baseUrl?: string
  /** 最大输出 token 数 */
  maxTokens?: number
  /** 温度 */
  temperature?: number
  /** 超时（毫秒） */
  timeoutMs?: number
}

/**
 * 调用 DeepSeek API 进行非流式补全，返回完整文本。
 * 失败时抛出异常，调用方负责处理。
 */
export async function chatComplete(
  systemPrompt: string,
  userPrompt: string,
  options: CompleteOptions
): Promise<string> {
  const {
    apiKey,
    model = 'deepseek-chat',
    baseUrl = 'https://api.deepseek.com',
    maxTokens = 1024,
    temperature = 0.3,
    timeoutMs = 30_000,
  } = options

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: maxTokens,
        temperature,
        stream: false,
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => 'unknown')
      throw new Error(`Chat completion API error ${response.status}: ${errText}`)
    }

    const data = (await response.json()) as any
    const content = data.choices?.[0]?.message?.content
    if (!content) {
      throw new Error('Chat completion API returned empty response')
    }

    const usage = data.usage
    if (usage) {
      log.debug('completion usage', {
        model,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
      })
    }

    return content
  } finally {
    clearTimeout(timer)
  }
}
