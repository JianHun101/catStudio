import { describe, it, expect } from 'vitest'
import {
  estimateTokens,
  estimateMessageTokens,
  checkTokenBudget,
  countTokens,
} from './token-counter.js'

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('estimates pure Chinese text', () => {
    // 6 个中文字 × 1.5 = 9.0 → ceil = 9
    expect(estimateTokens('你好世界猫咪')).toBe(9)
  })

  it('estimates pure English text', () => {
    // "Hello world" = 11 chars × 0.25 = 2.75 → ceil = 3
    expect(estimateTokens('Hello world')).toBe(3)
  })

  it('estimates mixed Chinese + English', () => {
    // "你好Hello" = 2 CJK + 5 non-CJK
    // 2 × 1.5 + 5 × 0.25 = 3.0 + 1.25 = 4.25 → ceil = 5
    expect(estimateTokens('你好Hello')).toBe(5)
  })

  it('estimates code snippets reasonably', () => {
    const code = 'function foo() { return 42; }'
    // 31 chars × 0.25 = 7.75 → ceil = 8
    expect(estimateTokens(code)).toBe(8)
  })

  it('handles emoji and special chars as non-Chinese', () => {
    // "🐱 店长" = 1 emoji + space + 2 CJK = 3 non-CJK + 2 CJK
    // 2 × 1.5 + 3 × 0.25 = 3.0 + 0.75 = 3.75 → ceil = 4
    expect(estimateTokens('🐱 店长')).toBe(4)
  })

  it('Chinese estimate is ~1.5 tokens per character (conservative)', () => {
    // 200 个纯中文 ≈ 300 tokens（200 × 1.5）
    const chinese = '喵'.repeat(200)
    const tokens = estimateTokens(chinese)
    expect(tokens).toBe(300)
  })
})

describe('estimateMessageTokens', () => {
  it('returns zero for empty messages', () => {
    const result = estimateMessageTokens([])
    expect(result.total).toBe(0)
    expect(result.systemTokens).toBe(0)
    expect(result.userTokens).toBe(0)
    expect(result.assistantTokens).toBe(0)
  })

  it('separates tokens by role', () => {
    const result = estimateMessageTokens([
      { role: 'system', content: '你是猫' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: '喵' },
    ])
    // system: "你是猫" = 3 CJK × 1.5 = 4.5 → 5
    // user: "Hello" = 5 non-CJK × 0.25 = 1.25 → 2
    // assistant: "喵" = 1 CJK × 1.5 = 1.5 → 2
    expect(result.systemTokens).toBe(5)
    expect(result.userTokens).toBe(2)
    expect(result.assistantTokens).toBe(2)
    expect(result.total).toBe(9)
    expect(result.perMessage).toEqual([5, 2, 2])
  })
})

describe('checkTokenBudget', () => {
  it('returns low ratio for under budget', () => {
    const result = checkTokenBudget(3000, 6000)
    expect(result.ratio).toBeCloseTo(0.5)
    expect(result.isWarning).toBe(false)
    expect(result.isCritical).toBe(false)
  })

  it('triggers warning at 70%', () => {
    const result = checkTokenBudget(4200, 6000)
    expect(result.isWarning).toBe(true)
    expect(result.isCritical).toBe(false)
  })

  it('triggers critical at 90%', () => {
    const result = checkTokenBudget(5400, 6000)
    expect(result.isWarning).toBe(true)
    expect(result.isCritical).toBe(true)
  })

  it('handles zero limit gracefully', () => {
    const result = checkTokenBudget(100, 0)
    expect(result.ratio).toBe(0)
    expect(result.isWarning).toBe(false)
    expect(result.isCritical).toBe(false)
  })
})

describe('countTokens', () => {
  it('defaults to estimate when method is not tiktoken', async () => {
    const result = await countTokens('你好世界')
    // 4 CJK × 1.5 = 6
    expect(result).toBe(6)
  })
})
