/**
 * 记忆入库筛选 — 纯函数测试，无 DB 依赖。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { evaluateMemoryContent } from './filter.js'

afterEach(() => {
  delete process.env.MEMORY_FILTER_ENABLED
  delete process.env.MEMORY_MIN_CONTENT_LENGTH
})

describe('evaluateMemoryContent', () => {
  describe('过短（应答词/寒暄）', () => {
    it('skips short acknowledgements', () => {
      for (const c of [
        '好',
        '嗯',
        '好的',
        '嗯嗯',
        '收到',
        'OK',
        '继续',
        '早上好',
        '晚安',
        '谢谢',
        '辛苦了',
      ]) {
        const r = evaluateMemoryContent(c)
        expect(r.store).toBe(false)
        expect(r.reason).toBe('too_short')
      }
    })

    it('stores content at the length boundary', () => {
      expect(evaluateMemoryContent('我喜欢猫')).toEqual({ store: true, reason: null })
      expect(evaluateMemoryContent('四个字啦')).toEqual({ store: true, reason: null })
    })

    it('respects MEMORY_MIN_CONTENT_LENGTH override', () => {
      process.env.MEMORY_MIN_CONTENT_LENGTH = '2'
      expect(evaluateMemoryContent('好的').store).toBe(true)
    })

    it('returns too_short for empty content', () => {
      expect(evaluateMemoryContent('')).toEqual({ store: false, reason: 'too_short' })
      expect(evaluateMemoryContent('   ')).toEqual({ store: false, reason: 'too_short' })
    })
  })

  describe('纯填充', () => {
    it('skips filler content', () => {
      for (const c of ['哈哈哈哈哈', '😄😄😄😄', '。。。。。', '呵呵呵呵', '哦哦哦哦']) {
        const r = evaluateMemoryContent(c)
        expect(r.store).toBe(false)
        expect(r.reason).toBe('filler')
      }
    })
  })

  describe('一次性指令', () => {
    it('skips one-time requests with openers', () => {
      for (const c of [
        '帮我修一下登录bug',
        '麻烦查一下天气',
        '请你看看这个',
        '帮我写首诗',
        '帮忙review下这个PR',
      ]) {
        const r = evaluateMemoryContent(c)
        expect(r.store).toBe(false)
        expect(r.reason).toBe('one_time_command')
      }
    })

    it('skips imperative commands with suffixes', () => {
      for (const c of [
        '修一下这个bug',
        '看看前端代码',
        '查查文档',
        '写个脚本',
        '跑一遍测试',
        '检查一下配置',
      ]) {
        const r = evaluateMemoryContent(c)
        expect(r.store).toBe(false)
        expect(r.reason).toBe('one_time_command')
      }
    })

    it('does not over-match verbs without command shape', () => {
      for (const c of [
        '改天请你吃饭',
        '我喜欢散步',
        '我想吃日料',
        '写作是我的爱好',
        '改变主意了',
      ]) {
        expect(evaluateMemoryContent(c).store).toBe(true)
      }
    })
  })

  describe('长期/偏好标记覆盖', () => {
    it('stores content with standing/preference markers', () => {
      for (const c of [
        '以后都用中文回复',
        '每次改代码先跑测试',
        '不要用英文回复',
        '我不喜欢辣的',
        '以后帮我留意天气',
        '请以后都不要用英文',
        '我平时喜欢散步',
        '记得每天喂猫',
      ]) {
        expect(evaluateMemoryContent(c).store).toBe(true)
      }
    })

    it('stores plain preference statements', () => {
      for (const c of ['我喜欢日料，特别是寿司', '我不吃辣的', '我是做设计的']) {
        expect(evaluateMemoryContent(c).store).toBe(true)
      }
    })

    it('prefers standing markers over command features', () => {
      // "帮我" + "以后" 同时出现 → 长期约定优先，存储
      expect(evaluateMemoryContent('以后帮我留意天气').store).toBe(true)
      // 对比: 无长期标记的同形指令 → 跳过
      expect(evaluateMemoryContent('帮我留意天气').store).toBe(false)
    })
  })
})
