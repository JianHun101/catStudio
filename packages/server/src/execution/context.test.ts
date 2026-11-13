/**
 * context.ts 测试（第 1 刀从 socketio.test.ts 迁出，断言原样）。
 *
 * getRelevantMessages — 消息可见性过滤（纯函数）。
 */

import { describe, it, expect } from 'vitest'
import { estimateTokens } from '@cat-study/shared'
import {
  getRelevantMessages,
  buildFoldNotice,
  buildSummaryBlockMessage,
  estimateFoldedContextTokens,
  parseCompressedSummaries,
  SUMMARY_PREFIX,
} from './context.js'

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
      const msgs = [userMsg('你们两个看看', ['店长', 'ds猫'])]
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

describe('buildFoldNotice — 折叠声明（字段契约 + 反向断言）', () => {
  const META = {
    sessionId: 'sess-abc',
    coveredToId: 'msg-200',
    coveredToAt: '2026-11-12T08:00:00.123Z',
  }

  it('声明含会话标识、覆盖边界消息 id、边界时间、有损声明、回查工具与 before 游标', () => {
    const notice = buildFoldNotice(META)

    expect(notice).toContain('sess-abc')
    expect(notice).toMatch(/折叠范围.*本会话对话消息.*#msg-200/)
    expect(notice).toContain(META.coveredToAt)
    expect(notice).toContain('有损')
    expect(notice).toContain('原文完整保存在本会话')
    expect(notice).toContain('system 通知不参与折叠与回查')
    expect(notice).toContain('query_session_messages')
    expect(notice).toContain('before=msg-200')
    expect(notice).toContain('仅供审计，无需在回答中提及')
  })

  it('反向断言：不出现 sessionId= / 传入会话 id / 查其他会话（不提示跨会话通道）', () => {
    const notice = buildFoldNotice(META)

    expect(notice).not.toContain('sessionId=')
    expect(notice).not.toContain('传入会话 id')
    expect(notice).not.toContain('查其他会话')
  })

  it('不写全局条数、不写 #1–#N 区间（per-agent 折叠面不同，边界才是全局统一的）', () => {
    const notice = buildFoldNotice(META)

    expect(notice).not.toMatch(/#1[–-]?#?\d*/)
    expect(notice).not.toMatch(/共\s*\d+\s*条/)
  })

  it('旧条目无 coveredToId → 写「边界未记录」，不编造边界与游标值', () => {
    const notice = buildFoldNotice({ sessionId: 'sess-abc' })

    expect(notice).toContain('边界未记录')
    expect(notice).toContain('query_session_messages')
    expect(notice).toContain('before')
    expect(notice).not.toContain('before=')
    expect(notice).not.toMatch(/#\s*\d+/)
    expect(notice).toContain('system 通知不参与折叠与回查')
  })
})

describe('buildSummaryBlockMessage — 输出顺序', () => {
  it('SUMMARY_PREFIX → 折叠声明 → 分隔线 → 摘要，顺序钉死', () => {
    const notice = buildFoldNotice({
      sessionId: 'sess-abc',
      coveredToId: 'msg-200',
      coveredToAt: '2026-11-12T08:00:00.123Z',
    })
    const msg = buildSummaryBlockMessage('摘要正文', notice)
    const content = msg.content as string

    expect(msg.role).toBe('user')
    const prefixIdx = content.indexOf(SUMMARY_PREFIX)
    const noticeIdx = content.indexOf('折叠范围')
    const sepIdx = content.indexOf('────────')
    const summaryIdx = content.indexOf('摘要正文')

    expect(prefixIdx).toBe(0)
    expect(noticeIdx).toBeGreaterThan(prefixIdx)
    expect(sepIdx).toBeGreaterThan(noticeIdx)
    expect(summaryIdx).toBeGreaterThan(sepIdx)
  })

  it('无声明时保持旧形状（前缀 + 摘要）', () => {
    expect(buildSummaryBlockMessage('摘要正文').content).toBe(`${SUMMARY_PREFIX}\n摘要正文`)
  })
})

describe('estimateFoldedContextTokens — join 分支折叠窗口估算', () => {
  const SYSTEM = 'You are a cat.'
  const LONG = '猫'.repeat(1000) // 1500 token + 50 开销
  const MAX = 128_000

  function msgs(count: number) {
    return Array.from({ length: count }, (_, i) => ({ role: 'user', content: LONG }))
  }

  /** 与生产一致的就绪条目形状（content 非空 = ready） */
  function entry(content: string, coveredThrough = 20) {
    return {
      id: `s-${content.length}`,
      createdAt: '2026-08-01T00:00:00Z',
      tokenCount: 10,
      content,
      coveredThrough,
    }
  }

  function rawOf(messages: any[]) {
    return estimateTokens(SYSTEM) + messages.reduce((s, m) => s + estimateTokens(m.content) + 50, 0)
  }

  it('有就绪块且 raw ≥ 60% → 返回 system + 摘要块 + 最近窗口，且严格小于 raw', () => {
    const messages = msgs(20) // raw = 4 + 20×1550 = 31,004；0.6×40,000 = 24,000
    const summary = '摘要内容'
    const folded = estimateFoldedContextTokens({
      systemPrompt: SYSTEM,
      messages,
      // 末尾一条 pending（content 空）不得顶掉就绪块
      summaryEntries: [entry(summary), entry('')],
      maxTokens: 40_000,
    })

    // 公式面：system + 摘要块 + 最近 10 条（单条 1550 < 30k 预算 ⇒ 恰保留 10 条）
    const kept = messages.slice(-10)
    const expected =
      estimateTokens(SYSTEM) +
      estimateTokens(buildSummaryBlockMessage(summary).content) +
      kept.reduce((s, m) => s + estimateTokens(m.content) + 50, 0)

    expect(folded).toBe(expected)
    expect(folded).toBeLessThan(rawOf(messages))
    expect(folded).toBeLessThan(rawOf(messages) * 0.6)
  })

  it('无就绪块 → 逐字等于 raw', () => {
    const messages = msgs(20)
    expect(
      estimateFoldedContextTokens({
        systemPrompt: SYSTEM,
        messages,
        summaryEntries: [],
        maxTokens: 40_000,
      })
    ).toBe(rawOf(messages))
  })

  it('只有 pending（content 空）→ 逐字等于 raw', () => {
    const messages = msgs(20)
    expect(
      estimateFoldedContextTokens({
        systemPrompt: SYSTEM,
        messages,
        summaryEntries: [entry(''), entry('')],
        maxTokens: 40_000,
      })
    ).toBe(rawOf(messages))
  })

  it('JSON 损坏（解析为空数组）→ 逐字等于 raw', () => {
    const messages = msgs(20)
    expect(parseCompressedSummaries('{not-json')).toEqual([])
    expect(
      estimateFoldedContextTokens({
        systemPrompt: SYSTEM,
        messages,
        summaryEntries: parseCompressedSummaries('{not-json'),
        maxTokens: 40_000,
      })
    ).toBe(rawOf(messages))
  })

  it('raw < 8k → 即使有就绪块也返回 raw（执行期此时不压缩）', () => {
    const messages = msgs(3) // raw ≈ 4,654 < 8,000
    expect(
      estimateFoldedContextTokens({
        systemPrompt: SYSTEM,
        messages,
        summaryEntries: [entry('摘要内容')],
        maxTokens: MAX,
      })
    ).toBe(rawOf(messages))
  })

  it('raw ≥ 8k 但低于 60% 阈值 → 即使有就绪块也返回 raw', () => {
    const messages = msgs(10) // raw ≈ 15,504；0.6×128,000 = 76,800
    expect(rawOf(messages)).toBeGreaterThanOrEqual(8_000)
    expect(
      estimateFoldedContextTokens({
        systemPrompt: SYSTEM,
        messages,
        summaryEntries: [entry('摘要内容')],
        maxTokens: MAX,
      })
    ).toBe(rawOf(messages))
  })
})
