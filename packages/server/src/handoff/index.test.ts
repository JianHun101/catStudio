import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { shouldHandoff, injectSummaryIntoSystem } from './index.js'

describe('handoff', () => {
  describe('shouldHandoff', () => {
    const originalEnv = { ...process.env }

    afterEach(() => {
      process.env = { ...originalEnv }
    })

    it('returns true when tokens >= 90% of max', () => {
      process.env.HANDOFF_ENABLED = 'true'
      process.env.MAX_CONTEXT_TOKENS = '6000'
      process.env.HANDOFF_THRESHOLD = '0.9'
      // 5400 >= 6000 * 0.9 = 5400
      expect(shouldHandoff(5400)).toBe(true)
      expect(shouldHandoff(6000)).toBe(true)
    })

    it('returns false when tokens < 90% of max', () => {
      process.env.HANDOFF_ENABLED = 'true'
      process.env.MAX_CONTEXT_TOKENS = '6000'
      process.env.HANDOFF_THRESHOLD = '0.9'
      expect(shouldHandoff(5399)).toBe(false)
      expect(shouldHandoff(0)).toBe(false)
    })

    it('returns false when handoff is disabled', () => {
      process.env.HANDOFF_ENABLED = 'false'
      process.env.MAX_CONTEXT_TOKENS = '6000'
      process.env.HANDOFF_THRESHOLD = '0.9'
      expect(shouldHandoff(10000)).toBe(false)
    })

    it('respects custom threshold', () => {
      process.env.HANDOFF_ENABLED = 'true'
      process.env.MAX_CONTEXT_TOKENS = '8000'
      process.env.HANDOFF_THRESHOLD = '0.8'
      expect(shouldHandoff(6400)).toBe(true)
      expect(shouldHandoff(6399)).toBe(false)
    })

    it('triggers at 90% with realistic 128K context (regression test)', () => {
      // 验证：128K 模型，截断前消息总 token 数 ≥115200 时应触发交接。
      // 这是对 bug #handoff-deadlock 的回归测试：
      //   截断将消息锁死在预算内，截断后检查永远达不到 90%（115200）。
      //   修复后 socketio.ts 在截断前计算消息总 token 并传给 shouldHandoff。
      process.env.HANDOFF_ENABLED = 'true'
      process.env.MAX_CONTEXT_TOKENS = '128000'
      process.env.HANDOFF_THRESHOLD = '0.9'

      // 截断后典型值（~75000）不应触发
      expect(shouldHandoff(75000)).toBe(false)

      // 截断前典型值（~120000）应触发
      expect(shouldHandoff(120000)).toBe(true)

      // 正好 90%（115200）应触发
      expect(shouldHandoff(115200)).toBe(true)
      // 差 1 token 不应触发
      expect(shouldHandoff(115199)).toBe(false)
    })
  })

  describe('injectSummaryIntoSystem', () => {
    it('returns original prompt when summary is null', () => {
      const prompt = 'You are a helpful cat'
      expect(injectSummaryIntoSystem(prompt, null)).toBe(prompt)
    })

    it('returns original prompt when summary is empty string', () => {
      const prompt = 'You are a helpful cat'
      expect(injectSummaryIntoSystem(prompt, '')).toBe(prompt)
    })

    it('returns original prompt when summary is invalid JSON', () => {
      const prompt = 'You are a helpful cat'
      expect(injectSummaryIntoSystem(prompt, 'not-json')).toBe(prompt)
    })

    it('injects summary text into system prompt', () => {
      const prompt = 'You are a cat named 店长'
      const summary = JSON.stringify({
        text: '用户问了天气和猫粮的问题',
        lastMessageId: 'msg-1',
        tokenCount: 30,
        roundCount: 5,
      })
      const result = injectSummaryIntoSystem(prompt, summary)
      expect(result).toContain('You are a cat named 店长')
      expect(result).toContain('【对话历史摘要】')
      expect(result).toContain('用户问了天气和猫粮的问题')
      expect(result).toContain('请基于以上摘要理解对话上下文')
    })

    it('handles summary JSON without text field', () => {
      const prompt = 'You are a cat'
      const summary = JSON.stringify({ other: 'data' })
      expect(injectSummaryIntoSystem(prompt, summary)).toBe(prompt)
    })
  })
})
