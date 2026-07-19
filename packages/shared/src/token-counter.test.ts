import { describe, it, expect } from 'vitest'
import { estimateTokens, estimateMessageTokens, checkTokenBudget } from './token-counter.js'

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('estimates pure Chinese text', () => {
    // 6 个中文字 × 0.75 = 4.5 → ceil = 5
    expect(estimateTokens('你好世界猫咪')).toBe(5)
  })

  it('estimates pure English text', () => {
    // "Hello world" = 11 chars × 0.25 = 2.75 → ceil = 3
    expect(estimateTokens('Hello world')).toBe(3)
  })

  it('estimates mixed Chinese + English', () => {
    // "你好Hello" = 2 CJK + 5 non-CJK
    // 2 × 0.75 + 5 × 0.25 = 1.5 + 1.25 = 2.75 → ceil = 3
    expect(estimateTokens('你好Hello')).toBe(3)
  })

  it('estimates code snippets reasonably', () => {
    const code = 'function foo() { return 42; }'
    // 31 chars × 0.25 = 7.75 → ceil = 8
    expect(estimateTokens(code)).toBe(8)
  })

  it('handles emoji and special chars as non-Chinese', () => {
    // "🐱 店长" = 1 emoji + space + 2 CJK = 3 non-CJK + 2 CJK
    // 2 × 0.75 + 3 × 0.25 = 1.5 + 0.75 = 2.25 → ceil = 3
    expect(estimateTokens('🐱 店长')).toBe(3)
  })

  it('Chinese estimate is always at least 1 per 2 chars', () => {
    // 200 个纯中文 ≈ 150 tokens（远小于 200，证明不是 1:1）
    const chinese = '喵'.repeat(200)
    const tokens = estimateTokens(chinese)
    expect(tokens).toBe(150) // 200 × 0.75
    expect(tokens).toBeLessThan(200)
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
    // system: "你是猫" = 3 CJK × 0.75 = 2.25 → 3
    // user: "Hello" = 5 non-CJK × 0.25 = 1.25 → 2
    // assistant: "喵" = 1 CJK × 0.75 = 0.75 → 1
    expect(result.systemTokens).toBe(3)
    expect(result.userTokens).toBe(2)
    expect(result.assistantTokens).toBe(1)
    expect(result.total).toBe(6)
    expect(result.perMessage).toEqual([3, 2, 1])
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
