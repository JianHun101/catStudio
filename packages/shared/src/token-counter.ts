/**
 * Token 计数工具 — 统一 token 估算逻辑。
 *
 * 设计原则：
 * - 默认使用字符估算（零依赖，所有适配器通用）
 * - tiktoken 精确计数为可选能力（仅 DeepSeek HTTP 适配器使用）
 * - Claude CLI 适配器**禁止**使用 tiktoken（Anthropic tokenizer ≠ OpenAI tokenizer）
 *
 * 估算公式（中英混合）：
 *   tokenCount = ceil(chineseChars × 0.75 + nonChinese × 0.25)
 *   中文 1 字 ≈ 0.6-0.8 token，取 0.75
 *   英文/代码 ~4 字符/token，取 0.25
 *   实测精度 ±15%，配合 handoff 90% 保底足够
 */

import type { LLMMessage } from './types.js'

/** Unicode 中日韩统一表意文字范围 */
const CJK_RE = /[一-鿿㐀-䶿豈-﫿]/g

/** tiktoken 懒引用（避免硬依赖，通过 Function 构造绕过编译期模块解析） */
let tiktokenModule: any = null

async function getTiktoken(): Promise<any> {
  if (tiktokenModule) return tiktokenModule
  try {
    // 使用 Function 构造器做动态 import，避免 TypeScript 编译期要求模块存在
    tiktokenModule = (await Function('return import("tiktoken")')()) as any
  } catch {
    throw new Error(
      'tiktoken is not installed. Run `pnpm add tiktoken` or use TOKEN_COUNT_METHOD=estimate'
    )
  }
  return tiktokenModule
}

/**
 * 字符估算 token 数。
 * 中文 1 字 ≈ 0.75 token，非中文 ~4 字符/token → 0.25/字符
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const chineseChars = (text.match(CJK_RE) || []).length
  const nonChinese = text.length - chineseChars
  return Math.ceil(chineseChars * 0.75 + nonChinese * 0.25)
}

/**
 * 使用 tiktoken 精确计数（需要安装 tiktoken 包）。
 * 仅适用于 OpenAI-compatible tokenizer（DeepSeek 复用 OpenAI tokenizer）。
 * **禁止**用于 Claude 模型 — Anthropic 使用自有 tokenizer。
 */
export async function countTokensTiktoken(text: string, model: string = 'gpt-4o'): Promise<number> {
  const tiktoken = await getTiktoken()
  const enc = tiktoken.encoding_for_model(model) as {
    encode(text: string): Uint32Array
    free(): void
  }
  const count = enc.encode(text).length
  enc.free()
  return count
}

/**
 * 根据配置选择计数方式。
 * method='tiktoken' 时使用精确计数，否则使用字符估算。
 */
export async function countTokens(
  text: string,
  method: 'estimate' | 'tiktoken' = 'estimate',
  tiktokenModel?: string
): Promise<number> {
  if (method === 'tiktoken') {
    return countTokensTiktoken(text, tiktokenModel)
  }
  return estimateTokens(text)
}

/**
 * 批量估算一组 LLM 消息的 token 数。
 * 返回总计和每条消息的估算值。
 */
export function estimateMessageTokens(messages: LLMMessage[]): {
  total: number
  perMessage: number[]
  systemTokens: number
  userTokens: number
  assistantTokens: number
} {
  const perMessage: number[] = []
  let systemTokens = 0
  let userTokens = 0
  let assistantTokens = 0

  for (const m of messages) {
    const tokens = estimateTokens(m.content)
    perMessage.push(tokens)

    switch (m.role) {
      case 'system':
        systemTokens += tokens
        break
      case 'user':
        userTokens += tokens
        break
      case 'assistant':
        assistantTokens += tokens
        break
    }
  }

  return {
    total: systemTokens + userTokens + assistantTokens,
    perMessage,
    systemTokens,
    userTokens,
    assistantTokens,
  }
}

/**
 * 检查 token 使用率。
 * @param used 已使用 token 数
 * @param limit 预算上限
 * @returns 使用率 0-1，以及是否超过阈值
 */
export function checkTokenBudget(
  used: number,
  limit: number
): { ratio: number; isWarning: boolean; isCritical: boolean } {
  const ratio = limit > 0 ? used / limit : 0
  return {
    ratio,
    isWarning: ratio >= 0.7, // 70% — 接近上限
    isCritical: ratio >= 0.9, // 90% — 需要交接
  }
}
