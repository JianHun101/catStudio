/**
 * hints.ts 测试（第 1 刀从 socketio.test.ts 迁出，断言原样）。
 *
 * hint 角色判定 / resolveRolePlaceholders 用 agentsRepo 查真实 DB——
 * 复用 socketio.test.ts 外屋 beforeEach 同款 harness（真实 SQLite + 店长 seed）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository } from '../db/repository/index.js'
import {
  formatAudienceTag,
  formatAgentMessage,
  formatUserMessage,
  buildReviewLoopHint,
  buildHandoffTriggerHint,
  buildTriggerFocusHint,
  resolveRolePlaceholders,
} from './hints.js'

describe('hints', () => {
  beforeEach(async () => {
    vi.clearAllMocks()

    // 设置测试 DB 并填入基础数据
    const db = createTestDb()
    setDb(db)
    initRepository(db)

    // Seed: 一个 agent（店长，role 默认 unknown——「DB 无 reviewer」用例依赖此默认）
    db.prepare(
      `
      INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
    ).run('agent-1', '店长', '🐱', 'You are a cat.', 'deepseek', 'deepseek-v4-pro', 'sk-test')
  })

  afterEach(() => {
    resetDb()
  })

  // ─── hint 角色判定 — agents 表 role 字段接入 ──────────
  // 原 skillModules（含 code-review）判定拆除，切 role === 'reviewer'（一对一已实锤）。
  // buildReviewLoopHint / buildHandoffTriggerHint 内部用 agentsRepo 查真实 DB。

  describe('hint 角色判定 — role 字段接入（skillModules 判定拆除）', () => {
    /** 插入 reviewer（吐槽猫）与 implementer（ds猫） */
    function seedHintAgents(db: any) {
      db.prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'agent-2',
        '吐槽猫',
        '😼',
        'You are a cat.',
        'deepseek',
        'deepseek-v4-flash',
        'sk-test',
        'reviewer'
      )
      db.prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'agent-3',
        'ds猫',
        '🐯',
        'You are a cat.',
        'deepseek',
        'deepseek-v4-flash',
        'sk-test',
        'implementer'
      )
    }

    it('buildReviewLoopHint：reviewer（role）发 ⚠️建议修改 且 @实施猫 → 注入循环指令（真名动态装配）', async () => {
      seedHintAgents(getDb())
      const hint = buildReviewLoopHint({ name: 'ds猫', role: 'implementer' }, [
        {
          role: 'agent',
          agent_id: 'agent-2',
          content: '⚠️建议修改 需要改 X',
          mentions: JSON.stringify(['ds猫']),
        },
      ])
      expect(hint).not.toBeNull()
      expect(hint!).toContain('吐槽猫') // 真名由运行时动态装配（规则说角色，运行时给名字）
      expect(hint!).toContain('继续审查循环')
      expect(hint!).toContain('✅可合并')
    })

    it('buildReviewLoopHint：发送者非 reviewer（implementer 消息）→ 不注入（role 判定等价旧 skillModules 判据）', async () => {
      seedHintAgents(getDb())
      const hint = buildReviewLoopHint({ name: 'ds猫', role: 'implementer' }, [
        {
          role: 'agent',
          agent_id: 'agent-3',
          content: '⚠️建议修改 需要改 X',
          mentions: JSON.stringify(['ds猫']),
        },
      ])
      // 发送者 agent-3 是 implementer 不是 reviewer → 走发送者检查 continue → 不注入
      expect(hint).toBeNull()
    })

    it('buildReviewLoopHint：reviewer 自己 → 不注入（审查者不需要循环指令）', async () => {
      seedHintAgents(getDb())
      const hint = buildReviewLoopHint({ name: '吐槽猫', role: 'reviewer' }, [
        {
          role: 'agent',
          agent_id: 'agent-3',
          content: '⚠️建议修改 需要改 X',
          mentions: JSON.stringify(['吐槽猫']),
        },
      ])
      expect(hint).toBeNull()
    })

    it('buildReviewLoopHint：✅可合并 → 不注入（审查通过循环结束）', async () => {
      seedHintAgents(getDb())
      const hint = buildReviewLoopHint({ name: 'ds猫', role: 'implementer' }, [
        {
          role: 'agent',
          agent_id: 'agent-2',
          content: '✅可合并 通过',
          mentions: JSON.stringify(['ds猫']),
        },
      ])
      expect(hint).toBeNull()
    })

    it('buildHandoffTriggerHint：DB 有 reviewer → 注入 @吐槽猫 发起代码审查（真名动态装配）', async () => {
      seedHintAgents(getDb())
      const hint = buildHandoffTriggerHint('@店长 请补填以下交接文档')
      expect(hint).not.toBeNull()
      expect(hint!).toContain('吐槽猫')
      expect(hint!).toContain('发起代码审查')
    })

    it('buildHandoffTriggerHint：DB 无 reviewer → 不注入', async () => {
      // beforeEach 只插入 agent-1（店长，role 默认 unknown）——无 reviewer
      const hint = buildHandoffTriggerHint('@店长 请补填以下交接文档')
      expect(hint).toBeNull()
    })

    it('buildHandoffTriggerHint：非补填请求消息 → 不注入', async () => {
      seedHintAgents(getDb())
      const hint = buildHandoffTriggerHint('普通派活消息')
      expect(hint).toBeNull()
    })
  })

  // ─── resolveRolePlaceholders — 纯函数单测 ──────────
  // 三占位符替换语义钉死：@作者→触发者（authorName 存在才替换）、
  // @架构师→store 角色名、@审查者→reviewer 角色名（角色缺失保留字面零回归）。

  describe('resolveRolePlaceholders — 纯函数单测', () => {
    it('三占位符同时替换：@作者→触发者、@架构师→store 名、@审查者→reviewer 名', async () => {
      const db = getDb()
      db.prepare(`UPDATE agents SET role = 'store' WHERE id = 'agent-1'`).run()
      db.prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'agent-2',
        '吐槽猫',
        '😼',
        'You are a cat.',
        'deepseek',
        'deepseek-v4-flash',
        'sk-test',
        'reviewer'
      )

      const out = resolveRolePlaceholders(
        '请审核只 @审查者。✅可合并 → 行首@架构师 请收口；⚠️/❌ → 行首@作者。',
        'ds猫'
      )
      expect(out).toContain('@吐槽猫')
      expect(out).toContain('@店长')
      expect(out).toContain('@ds猫')
      expect(out).not.toContain('@架构师')
      expect(out).not.toContain('@审查者')
      expect(out).not.toContain('@作者')
    })

    it('角色缺失 → 保留字面（零回归：老库无 store/reviewer 角色时不替换）', async () => {
      // beforeEach 的 agent-1 店长 role 默认 'unknown'——无任何 store/reviewer 角色
      const out = resolveRolePlaceholders(
        '请审核只 @审查者。✅可合并 → 行首@架构师 请收口；结论归 @作者。',
        'ds猫'
      )
      expect(out).toContain('@架构师')
      expect(out).toContain('@审查者')
      expect(out).toContain('@ds猫') // @作者 有 authorName 仍替换
    })

    it('authorName 缺失 → @作者 保留字面（用户消息触发场景）', async () => {
      const db = getDb()
      db.prepare(`UPDATE agents SET role = 'store' WHERE id = 'agent-1'`).run()
      const out = resolveRolePlaceholders('你是审查者，结论 @作者 通知。')
      expect(out).toContain('@作者') // authorName undefined → 不替换
      expect(out).not.toContain('@店长') // 但 @架构师 占位符不在 prompt 中
    })

    it('无 @ 前缀的叙述不受影响（"是项目架构师"不误替换）', async () => {
      const db = getDb()
      db.prepare(`UPDATE agents SET role = 'store' WHERE id = 'agent-1'`).run()
      const out = resolveRolePlaceholders('你是项目架构师，负责整体设计。')
      expect(out).toBe('你是项目架构师，负责整体设计。')
    })

    it('无占位符 → 原样返回', async () => {
      const prompt = '你是审查者，逐项核对。'
      expect(resolveRolePlaceholders(prompt)).toBe(prompt)
    })
  })

  // ─── 上下文卫生补测 — buildTriggerFocusHint 纯函数单测 ─────────
  // 原 socketio.test.ts 块：空输入/截断/锚点文案钉死。

  describe('buildTriggerFocusHint 纯函数单测', () => {
    it('空输入 → 返回 null', async () => {
      expect(buildTriggerFocusHint('')).toBeNull()
      expect(buildTriggerFocusHint(null as any)).toBeNull()
    })

    it('≤120 字 → 锚点含全文、无省略号', async () => {
      const content = 'A'.repeat(120)
      const hint = buildTriggerFocusHint(content)
      expect(hint).not.toBeNull()
      expect(hint!).toContain('本轮需要你回复的是最后一条消息')
      expect(hint!).toContain(content)
      expect(hint!).not.toContain('…')
    })

    it('>120 字 → 截断 120 字 + 省略号', async () => {
      const content = 'B'.repeat(200)
      const hint = buildTriggerFocusHint(content)
      expect(hint).not.toBeNull()
      expect(hint!).toContain('B'.repeat(120))
      expect(hint!).toContain('…')
      expect(hint!).not.toContain('B'.repeat(121))
    })

    it('锚点文案钉死（最后一条消息 + 不重复回答历史）', async () => {
      const hint = buildTriggerFocusHint('你好')
      expect(hint!).toContain('本轮需要你回复的是最后一条消息')
      expect(hint!).toContain('不要重复回答其中已回复过的问题')
    })
  })
})

// ═══ Pure utility functions (no DB/mock dependencies) ═══

describe('formatAudienceTag', () => {
  it('returns "对你" when agent is mentioned', () => {
    expect(formatAudienceTag(['店长', 'ds猫'], '店长')).toBe('对你')
  })

  it('returns "对大家" when agent is not mentioned', () => {
    expect(formatAudienceTag(['ds猫'], '店长')).toBe('对大家')
  })

  it('returns "对大家" for empty mentions', () => {
    expect(formatAudienceTag([], '店长')).toBe('对大家')
  })

  it('多人 @mention 中包含当前 agent → 对你', () => {
    expect(formatAudienceTag(['吐槽猫', '店长', 'ds猫'], '吐槽猫')).toBe('对你')
    expect(formatAudienceTag(['店长', '吐槽猫'], '吐槽猫')).toBe('对你')
  })

  it('当前 agent 不在 @mention 中 → 对大家', () => {
    expect(formatAudienceTag(['店长'], '吐槽猫')).toBe('对大家')
    expect(formatAudienceTag(['店长', 'ds猫'], '吐槽猫')).toBe('对大家')
  })

  it('名称精确匹配，不部分命中', () => {
    expect(formatAudienceTag(['小吐槽猫'], '吐槽猫')).toBe('对大家')
    expect(formatAudienceTag(['吐槽'], '吐槽猫')).toBe('对大家')
  })
})

describe('formatAgentMessage', () => {
  it('formats basic agent message without mentions or model', () => {
    const result = formatAgentMessage('店长', '你好，我是店长。')
    expect(result).toBe('Direct message from 店长\n\n你好，我是店长。')
  })

  it('includes reply-to mentions', () => {
    const result = formatAgentMessage('ds猫', '我来处理。', ['店长'])
    expect(result).toBe('Direct message from ds猫; reply to 店长\n\n我来处理。')
  })

  it('includes multiple mention targets', () => {
    const result = formatAgentMessage('吐槽猫', '代码已审查。', ['店长', 'ds猫'])
    expect(result).toBe('Direct message from 吐槽猫; reply to 店长, ds猫\n\n代码已审查。')
  })

  it('includes model when provided', () => {
    const result = formatAgentMessage('店长', '分析完成。', [], 'deepseek-v4-pro')
    expect(result).toBe('Direct message from 店长 [deepseek-v4-pro]\n\n分析完成。')
  })

  it('includes both model and mentions', () => {
    const result = formatAgentMessage('店长', '修正完毕。', ['吐槽猫'], 'claude-opus-4-8')
    expect(result).toBe('Direct message from 店长 [claude-opus-4-8]; reply to 吐槽猫\n\n修正完毕。')
  })

  it('未知猫咪回退名也正常格式化', () => {
    expect(formatAgentMessage('未知猫咪', '喵~')).toBe('Direct message from 未知猫咪\n\n喵~')
  })
})

describe('formatUserMessage', () => {
  it('formats last user message with mentions and audience', () => {
    const result = formatUserMessage('你好', ['店长'], '对你', true)
    expect(result).toBe('【当前待回复】用户（@了店长）对你：你好')
  })

  it('formats last user message without mentions', () => {
    const result = formatUserMessage('大家好啊', [], '对大家', true)
    expect(result).toBe('【当前待回复】用户对大家：大家好啊')
  })

  it('formats non-last user message', () => {
    const result = formatUserMessage('上一句话', ['店长'], '对你', false)
    expect(result).toBe('用户（@了店长）：上一句话')
  })

  it('formats non-last message without mentions', () => {
    const result = formatUserMessage('普通消息', [], '对大家', false)
    expect(result).toBe('用户：普通消息')
  })

  it('joins multiple mention names', () => {
    const result = formatUserMessage('帮我看看', ['店长', 'ds猫', '吐槽猫'], '对大家', false)
    expect(result).toBe('用户（@了店长、ds猫、吐槽猫）：帮我看看')
  })
})
