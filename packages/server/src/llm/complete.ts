/**
 * DeepSeek 非流式补全工具 — 用于摘要生成等不需要流式输出的场景。
 *
 * 直接调用 DeepSeek Chat Completions API（不通过 LLMAdapter 接口），
 * 返回完整文本。使用便宜模型（deepseek-chat）以降低成本。
 *
 * ⚠️ 推理模型配额语义（2026-08-10 实测实锤）：
 * deepseek-v4-flash 是推理模型——非流式请求的 max_tokens 是「推理 + 回答」的
 * 总预算。思考过程写入 reasoning_content 吃光配额 → content 为空 +
 * finish_reason:"length"（实测非流式 5/5 空响应，流式 3/3 正常；8/10 模型行为
 * 变更后 handoff/summarizer/memory:rewrite 三处非流式调用全灭）。
 * 修复：请求体显式 thinking: { type: 'disabled' } 关思考，配额全给答案；
 * 空响应重试 1 次防 API 偶发。流式路径（chatStream）不受影响。
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
    // 默认 1024→2048：昨天成功案例 completionTokens 到 1500+，1024 可能截断摘要
    maxTokens = 2048,
    temperature = 0.3,
    timeoutMs = 30_000,
  } = options

  // 单次 AbortController 覆盖两次尝试的总预算（重试不翻倍超时）
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  /** 单次请求尝试：HTTP 错误直接抛；content 为空返回 ''（由外层决定重试） */
  const attempt = async (): Promise<string> => {
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
        // 推理模型关思考——reasoning 吃 max_tokens 预算导致 content 空 + length 截断
        thinking: { type: 'disabled' },
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const errText = await response.text().catch(() => 'unknown')
      throw new Error(`Chat completion API error ${response.status}: ${errText}`)
    }

    const data = (await response.json()) as any
    const content = data.choices?.[0]?.message?.content
    const usage = data.usage
    if (usage) {
      log.debug('completion usage', {
        model,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
      })
    }
    return typeof content === 'string' ? content : ''
  }

  try {
    let content = await attempt()
    if (!content) {
      // 空响应重试 1 次（300ms 退避）——防 API 偶发空回；仍空才判失败
      log.warn('chat completion returned empty content, retrying once', { model })
      await new Promise((resolve) => setTimeout(resolve, 300))
      content = await attempt()
    }
    if (!content) {
      throw new Error('Chat completion API returned empty response')
    }
    return content
  } finally {
    clearTimeout(timer)
  }
}
