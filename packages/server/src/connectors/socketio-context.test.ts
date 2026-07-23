/**
 * 上下文构建（消息过滤 + 受众标签）单元测试。
 *
 * 测试对象：formatAudienceTag + getRelevantMessages。
 * 这两个是纯函数，不依赖 IO——直接测，不需要 mock。
 */

import { describe, it, expect } from 'vitest'
import { formatAudienceTag, getRelevantMessages } from './socketio.js'

// ═══ 辅助：构造测试消息 ═══

function userMsg(content: string, mentions: string[] = []) {
  return {
    id: `u-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content,
    mentions: JSON.stringify(mentions),
  }
}

function agentMsg(content: string, agentId: string, mentions: string[] = []) {
  return {
    id: `a-${Math.random().toString(36).slice(2, 8)}`,
    role: 'agent',
    agent_id: agentId,
    content,
    mentions: JSON.stringify(mentions),
  }
}

// ═══ formatAudienceTag — 受众标签 ═══

describe('formatAudienceTag', () => {
  it('无 @mention → 对大家', () => {
    expect(formatAudienceTag([], '吐槽猫')).toBe('对大家')
    expect(formatAudienceTag([], '店长')).toBe('对大家')
  })

  it('当前 agent 被 @mention → 对你', () => {
    expect(formatAudienceTag(['吐槽猫'], '吐槽猫')).toBe('对你')
  })

  it('多人 @mention 中包含当前 agent → 对你', () => {
    expect(formatAudienceTag(['吐槽猫', '店长', '服务员'], '吐槽猫')).toBe('对你')
    expect(formatAudienceTag(['店长', '吐槽猫'], '吐槽猫')).toBe('对你')
  })

  it('当前 agent 不在 @mention 中 → 对大家', () => {
    expect(formatAudienceTag(['店长'], '吐槽猫')).toBe('对大家')
    expect(formatAudienceTag(['店长', '服务员'], '吐槽猫')).toBe('对大家')
  })

  it('名称精确匹配，不部分命中', () => {
    expect(formatAudienceTag(['小吐槽猫'], '吐槽猫')).toBe('对大家')
    expect(formatAudienceTag(['吐槽'], '吐槽猫')).toBe('对大家')
  })
})

// ═══ getRelevantMessages — 消息可见性过滤 ═══

describe('getRelevantMessages', () => {
  const AGENT_ID = 'agent-tucao'
  const AGENT_NAME = '吐槽猫'
  const OTHER_ID = 'agent-dianzhang'
  const OTHER_NAME = '店长'

  describe('用户消息', () => {
    it('无 @mention（广播）→ 所有 agent 可见', () => {
      const msgs = [userMsg('大家早上好', [])]
      const result = getRelevantMessages(msgs, AGENT_ID, AGENT_NAME, false)
      expect(result).toHaveLength(1)
    })

    it('@mention 了当前 agent → 可见', () => {
      const msgs = [userMsg('帮我review', ['吐槽猫'])]
      const result = getRelevantMessages(msgs, AGENT_ID, AGENT_NAME, false)
      expect(result).toHaveLength(1)
      expect(result[0].content).toBe('帮我review')
    })

    it('@mention 了其他 agent → 当前 agent 不可见', () => {
      const msgs = [userMsg('店长接客', ['店长'])]
      const result = getRelevantMessages(msgs, AGENT_ID, AGENT_NAME, false)
      expect(result).toHaveLength(0)
    })

    it('@mention 了多个 agent，包含当前 → 可见', () => {
      const msgs = [userMsg('你们两个看看', ['店长', '吐槽猫'])]
      const result = getRelevantMessages(msgs, AGENT_ID, AGENT_NAME, false)
      expect(result).toHaveLength(1)
    })

    it('@mention 了多个 agent，不包含当前 → 不可见', () => {
      const msgs = [userMsg('你们两个看看', ['店长', '服务员'])]
      const result = getRelevantMessages(msgs, AGENT_ID, AGENT_NAME, false)
      expect(result).toHaveLength(0)
    })
  })

  describe('Agent 回复', () => {
    it('自己的回复 → 可见（作为 assistant）', () => {
      const msgs = [agentMsg('我来看看', AGENT_ID)]
      const result = getRelevantMessages(msgs, AGENT_ID, AGENT_NAME, false)
      expect(result).toHaveLength(1)
    })

    it('其他 agent 回复，非广播模式 → 不可见（除非 @mention 了当前）', () => {
      const msgs = [agentMsg('没问题', OTHER_ID)]
      const result = getRelevantMessages(msgs, AGENT_ID, AGENT_NAME, false)
      expect(result).toHaveLength(0)
    })

    it('其他 agent 回复中 @mention 了当前 agent → 可见（review 链）', () => {
      const msgs = [agentMsg('@吐槽猫 你看看', OTHER_ID, ['吐槽猫'])]
      const result = getRelevantMessages(msgs, AGENT_ID, AGENT_NAME, false)
      expect(result).toHaveLength(1)
      expect(result[0].content).toBe('@吐槽猫 你看看')
    })

    it('广播模式下 → 所有 agent 回复可见', () => {
      const msgs = [agentMsg('没问题', OTHER_ID)]
      const result = getRelevantMessages(msgs, AGENT_ID, AGENT_NAME, true)
      expect(result).toHaveLength(1)
    })

    it('广播模式下自己的回复也可见', () => {
      const msgs = [agentMsg('我来看看', AGENT_ID)]
      const result = getRelevantMessages(msgs, AGENT_ID, AGENT_NAME, true)
      expect(result).toHaveLength(1)
    })
  })

  describe('混合消息', () => {
    it('正确过滤混合场景：用户广播 + 定向 + agent 回复', () => {
      const msgs = [
        userMsg('早上好', []), // 广播 → 可见
        userMsg('店长接客', ['店长']), // 定向店长 → 不可见
        userMsg('吐槽猫 review', ['吐槽猫']), // 定向吐槽猫 → 可见
        agentMsg('好的', OTHER_ID), // 非广播 → 不可见
        agentMsg('收到 @吐槽猫', OTHER_ID, ['吐槽猫']), // @了吐槽猫 → 可见
        agentMsg('review结果来了', AGENT_ID), // 自己的 → 可见
      ]
      const result = getRelevantMessages(msgs, AGENT_ID, AGENT_NAME, false)
      expect(result).toHaveLength(4)
      expect(result.map((m: any) => m.content)).toEqual([
        '早上好',
        '吐槽猫 review',
        '收到 @吐槽猫',
        'review结果来了',
      ])
    })

    it('广播模式下：所有 agent 回复可见 + 用户消息仍按 mention 过滤', () => {
      // 广播模式只影响 agent 回复——所有 agent 回复都可见。
      // 用户消息仍然按 mention 过滤：定向 @店长 的消息吐槽猫看不到。
      const msgs = [
        userMsg('早上好', []), // 无 @mention → 可见
        userMsg('店长接客', ['店长']), // 定向店长 → 吐槽猫不可见
        agentMsg('好的', OTHER_ID), // 广播模式 → 可见
        agentMsg('收到', AGENT_ID), // 广播模式 → 可见
      ]
      const result = getRelevantMessages(msgs, AGENT_ID, AGENT_NAME, true)
      expect(result).toHaveLength(3)
      expect(result.map((m: any) => m.content)).toEqual(['早上好', '好的', '收到'])
    })

    it('非广播模式下定向其他 agent 的用户消息被丢弃', () => {
      const msgs = [userMsg('店长过来', ['店长']), userMsg('吐槽猫过来', ['吐槽猫'])]
      const result = getRelevantMessages(msgs, AGENT_ID, AGENT_NAME, false)
      expect(result).toHaveLength(1)
      expect(result[0].content).toBe('吐槽猫过来')
    })
  })
})
