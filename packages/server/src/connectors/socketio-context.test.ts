/**
 * 上下文构建（消息过滤 + 受众标签）单元测试。
 *
 * 测试对象：formatAudienceTag + getRelevantMessages。
 * 这两个是纯函数，不依赖 IO——直接测，不需要 mock。
 */

import { describe, it, expect } from 'vitest'
import {
  formatAudienceTag,
  formatAgentMessage,
  formatUserMessage,
  getRelevantMessages,
} from './socketio.js'

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

    // ═══ formatAgentMessage — agent 消息格式化 ═══

    describe('formatAgentMessage', () => {
      it('基本格式：Direct message from + 换行 + 内容', () => {
        expect(formatAgentMessage('店长', '好的')).toBe('Direct message from 店长\n\n好的')
      })

      it('携带 mentions 时显示 reply to', () => {
        expect(formatAgentMessage('吐槽猫', '不行，重做', ['店长'])).toBe(
          'Direct message from 吐槽猫; reply to 店长\n\n不行，重做'
        )
      })

      it('携带 model 时显示模型名', () => {
        expect(formatAgentMessage('店长', '喵', [], 'deepseek-v4-pro')).toBe(
          'Direct message from 店长 [deepseek-v4-pro]\n\n喵'
        )
      })

      it('完整格式：mentions + model', () => {
        expect(formatAgentMessage('吐槽猫', '通过', ['店长', '服务员'], 'deepseek-v4-pro')).toBe(
          'Direct message from 吐槽猫 [deepseek-v4-pro]; reply to 店长, 服务员\n\n通过'
        )
      })

      it('未知猫咪回退名也正常格式化', () => {
        expect(formatAgentMessage('未知猫咪', '喵~')).toBe('Direct message from 未知猫咪\n\n喵~')
      })
    })

    // ═══ formatUserMessage — 用户消息格式化 ═══

    describe('formatUserMessage', () => {
      it('最后一条消息 @mention 了当前 agent → 携带 audience 标签', () => {
        expect(formatUserMessage('hello', ['店长'], '对你', true)).toBe(
          '用户（@了店长）对你：hello'
        )
      })

      it('非最后一条消息 → 不携带 audience 标签', () => {
        expect(formatUserMessage('hello', ['店长'], '对你', false)).toBe('用户（@了店长）：hello')
      })

      it('无 @mention 非最后一条 → 纯用户', () => {
        expect(formatUserMessage('hi', [], '', false)).toBe('用户：hi')
      })

      it('无 @mention 最后一条 → 携带 audience', () => {
        expect(formatUserMessage('hi', [], '对大家', true)).toBe('用户对大家：hi')
      })

      it('多人 @mention', () => {
        expect(formatUserMessage('看看', ['店长', '服务员'], '对大家', false)).toBe(
          '用户（@了店长、服务员）：看看'
        )
      })

      it('audience 不会出现在非最后一条消息中', () => {
        // 即使传了 audience，非最后一条也应该忽略
        expect(formatUserMessage('test', [], '对你', false)).toBe('用户：test')
      })
    })

    // ═══ 原 getRelevantMessages 混合消息测试（接上） ═══

    it('非广播模式下定向其他 agent 的用户消息被丢弃', () => {
      const msgs = [userMsg('店长过来', ['店长']), userMsg('吐槽猫过来', ['吐槽猫'])]
      const result = getRelevantMessages(msgs, AGENT_ID, AGENT_NAME, false)
      expect(result).toHaveLength(1)
      expect(result[0].content).toBe('吐槽猫过来')
    })
  })
})

// ═══ Agent System Prompt 内容验证 ═══

import { buildDemoAgents } from '../seed-data.js'

describe('agent system prompts', () => {
  const agents = buildDemoAgents()

  it('所有 agent 的 systemPrompt 包含共享角色边界', () => {
    for (const agent of agents) {
      expect(agent.systemPrompt).toContain('只扮演自己的角色')
      expect(agent.systemPrompt).toContain('禁止代写或预判其他 Agent')
    }
  })

  it('所有 agent 的 systemPrompt 以共享前置声明开头', () => {
    for (const agent of agents) {
      expect(agent.systemPrompt).toMatch(/^你是一只拥有人工智能的猫/)
    }
  })

  it('店长和服务员的 systemPrompt 包含反镜像规则', () => {
    for (const name of ['店长', '服务员']) {
      const agent = agents.find((a) => a.name === name)!
      expect(agent.systemPrompt).toContain('用自己的话表达')
    }
  })

  it('店长和客服的 systemPrompt 包含开发铁律关键词', () => {
    for (const name of ['店长', '服务员']) {
      const agent = agents.find((a) => a.name === name)!
      expect(agent.systemPrompt).toContain('出口检查')
      expect(agent.systemPrompt).toContain('依赖安装')
    }
  })

  it('店长的 systemPrompt 包含角色标识', () => {
    const agent = agents.find((a) => a.name === '店长')!
    expect(agent.systemPrompt).toContain('暹罗猫')
    expect(agent.systemPrompt).toContain('温和从容')
  })

  it('吐槽猫的 systemPrompt 包含审查铁律关键词', () => {
    const tucao = agents.find((a) => a.name === '吐槽猫')!
    expect(tucao.systemPrompt).toContain('依赖审查')
    expect(tucao.systemPrompt).toContain('Review指南')
  })

  it('吐槽猫的 systemPrompt 包含审查员角色', () => {
    const tucao = agents.find((a) => a.name === '吐槽猫')!
    expect(tucao.systemPrompt).toContain('英短蓝猫')
    expect(tucao.systemPrompt).toContain('Code Reviewer')
  })

  it('精简后的 prompt 不应包含冗余 markdown 格式符', () => {
    for (const agent of agents) {
      expect(agent.systemPrompt).not.toContain('**出口检查**')
      expect(agent.systemPrompt).not.toContain('**代码审查**')
      expect(agent.systemPrompt).not.toContain('**依赖安装**')
      expect(agent.systemPrompt).not.toContain('## 开发铁律')
      expect(agent.systemPrompt).not.toContain('## 审查铁律')
    }
  })

  it('精简后的 prompt 不应包含 markdown 列表序号', () => {
    for (const agent of agents) {
      expect(agent.systemPrompt).not.toMatch(/\d\.\s+(必要性|安全性|影响)/)
    }
  })

  // ═══ @作者 占位符验证 ═══
  // @作者 在 seed-data 中是字面占位符，运行时由 runAgentReply 替换为实际触发者名字

  it('吐槽猫的 systemPrompt 包含 @作者 占位符', () => {
    const tucao = agents.find((a) => a.name === '吐槽猫')!
    expect(tucao.systemPrompt).toContain('@作者')
    // 应该有 2 处：出口检查 + 代码审查
    const matches = tucao.systemPrompt.match(/@作者/g)
    expect(matches).not.toBeNull()
    expect(matches!.length).toBeGreaterThanOrEqual(2)
  })

  it('店长和服务员的 systemPrompt 不含 @作者（只有吐槽猫有）', () => {
    for (const name of ['店长', '服务员']) {
      const agent = agents.find((a) => a.name === name)!
      expect(agent.systemPrompt).not.toContain('@作者')
    }
  })

  it('@作者 替换正则能正确替换为实际 agent 名', () => {
    const tucao = agents.find((a) => a.name === '吐槽猫')!
    const replaced = tucao.systemPrompt.replace(/@作者/g, '@店长')
    // 替换后不应再有 @作者
    expect(replaced).not.toContain('@作者')
    // 应该有 @店长 出现（原来 @作者 的位置）
    expect(replaced).toContain('@店长')
    // 原来的 @引用 规则不应受影响
    expect(replaced).toContain('@猫名 必须行首独占一行')
  })

  // ═══ 精简后 prompt 关键规则完整性 ═══

  it('精简后的 IRON_LAWS_CODER 仍包含所有出口检查+审查+依赖+引用规则', () => {
    for (const name of ['店长', '服务员']) {
      const agent = agents.find((a) => a.name === name)!
      expect(agent.systemPrompt).toContain('出口检查')
      expect(agent.systemPrompt).toContain('自问')
      expect(agent.systemPrompt).toContain('行首@对方')
      expect(agent.systemPrompt).toContain('@吐槽猫')
      expect(agent.systemPrompt).toContain('依赖安装')
      expect(agent.systemPrompt).toContain('禁止直接安装')
      expect(agent.systemPrompt).toContain('行首独占一行')
    }
  })

  it('精简后的 IRON_LAWS_REVIEWER 仍包含所有审查铁律', () => {
    const tucao = agents.find((a) => a.name === '吐槽猫')!
    expect(tucao.systemPrompt).toContain('出口检查')
    expect(tucao.systemPrompt).toContain('结论清晰吗')
    expect(tucao.systemPrompt).toContain('代码审查')
    expect(tucao.systemPrompt).toContain('Checklist')
    expect(tucao.systemPrompt).toContain('可合并')
    expect(tucao.systemPrompt).toContain('建议修改')
    expect(tucao.systemPrompt).toContain('需重做')
    expect(tucao.systemPrompt).toContain('依赖审查')
    expect(tucao.systemPrompt).toContain('必要性')
    expect(tucao.systemPrompt).toContain('安全性')
    expect(tucao.systemPrompt).toContain('影响')
    expect(tucao.systemPrompt).toContain('审查维度')
    expect(tucao.systemPrompt).toContain('边界与安全')
  })
})
