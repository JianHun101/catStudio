/**
 * skill-loader.ts 测试（clowder 路线第一段：仓库源库 + server 运行时注入）。
 *
 * 两个层次：
 * 1. 纯函数单测（resolveSkillsForContext / loadSkill / buildSkillContextBlock）——
 *    零 DB 依赖，直接打解析与读源语义（读的是仓库真实 skills/ 源库）。
 * 2. 组装式模块测试（真实 SQLite + 真实 reply 组装 + 假 bus + mock LLM 边界）——
 *    跑 implementer agent 的完整 reply，断言 llmMessages[0].content 真的含 SKILL.md
 *    关键段，并对 opencode/ollama/dsh 三种 provider 同样生效——注入发生在 provider
 *    之前的 prompt 组装层，与执行体无关（这是「worktree 物理断点整体绕开」的行为验证）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentConfig } from '@cat-study/shared'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository } from '../db/repository/index.js'
import { __test_reset } from '../dispatch/index.js'
import { getAdapterForAgent } from '../llm/registry.js'
import { createExecutionEngine } from './serial.js'
import type { EngineBus, HandoffBus } from './bus.js'
import { resolveSkillsForContext, loadSkill, buildSkillContextBlock } from './skill-loader.js'

// ═══ 组装式测试的边界 mock（镜像 serial.test.ts——只打最外层） ═══

vi.mock('../llm/registry.js', () => ({
  getAdapterForAgent: vi.fn(() => null),
}))

vi.mock('../llm/git-utils.js', () => ({
  gitCommit: vi.fn(),
  getSessionWorktreePath: vi.fn(() => null),
  ensureSessionWorktree: vi.fn(() => null),
  snapshotPackageDeps: vi.fn(() => ({})),
  diffNewPackages: vi.fn(() => []),
}))

vi.mock('../summarizer/index.js', () => ({
  updateRunningSummary: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../memory/index.js', () => ({
  buildMemoryContext: vi.fn().mockResolvedValue(''),
  buildKnowledgeContext: vi.fn().mockResolvedValue(''),
}))

vi.mock('../handoff/index.js', () => ({
  shouldHandoff: vi.fn(() => false),
  performHandoff: vi.fn().mockResolvedValue(undefined),
  injectSummaryIntoSystem: vi.fn((s: string) => s),
  generateFullSummary: vi.fn(),
}))

vi.mock('../git/diff-collector.js', () => ({
  collectCommitDiffs: vi.fn().mockResolvedValue(null),
}))

// 顶层收尾的脏文件清理用真实 execSync 会命中真实仓库——恒返回空串（"干净"跳过）
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execSync: vi.fn(() => '') }
})

vi.mock('../eval/sampler.js', () => ({ maybeScoreSample: vi.fn() }))
vi.mock('../eval/verdict-parser.js', () => ({ recordReviewVerdict: vi.fn() }))
vi.mock('../llm/route-signals.js', () => ({ consumeRouteSignals: vi.fn(() => []) }))
vi.mock('../llm/user-request-signals.js', () => ({ consumeUserRequestSignals: vi.fn(() => []) }))

// ═══ 纯函数单测 ═══

describe('resolveSkillsForContext — role 默认 + 阶段信号（白名单求交去重）', () => {
  it('implementer 默认 → implement + quality-gate（实施猫两端：拿单实施 + 提交前自查）', () => {
    expect(resolveSkillsForContext({ role: 'implementer' })).toEqual(['implement', 'quality-gate'])
  })

  it('store 默认 → spec-gate（架构师 spec→拆票前门）', () => {
    expect(resolveSkillsForContext({ role: 'store' })).toEqual(['spec-gate'])
  })

  it('reviewer / vision / 未知角色 / 缺省 → 空（不背实施流程技能）', () => {
    expect(resolveSkillsForContext({ role: 'reviewer' })).toEqual([])
    expect(resolveSkillsForContext({ role: 'vision' })).toEqual([])
    expect(resolveSkillsForContext({ role: 'some-future-role' })).toEqual([])
    expect(resolveSkillsForContext({})).toEqual([])
  })

  it('implementer + 触发含「请审查」→ 追加 request-review（与 role 默认并存不重复）', () => {
    expect(
      resolveSkillsForContext({ role: 'implementer', triggerContent: '请审查这段代码' })
    ).toEqual(['implement', 'quality-gate', 'request-review'])
  })

  it('reviewer / vision + 阶段信号关键词 → 仍空（信号只对开发链角色生效，防转述噪音）', () => {
    expect(resolveSkillsForContext({ role: 'reviewer', triggerContent: '请审查这段代码' })).toEqual(
      []
    )
    expect(
      resolveSkillsForContext({ role: 'vision', triggerContent: 'quality-gate 自查 规格检查' })
    ).toEqual([])
  })

  it('implementer + 触发含 spec-gate 关键词 → 追加 spec-gate（前门信号跨角色场景）', () => {
    expect(
      resolveSkillsForContext({ role: 'implementer', triggerContent: '先过 spec-gate 再拆票' })
    ).toEqual(['implement', 'quality-gate', 'spec-gate'])
  })

  it('store + 触发含 spec-gate 关键词 → 不重复（默认已有，结果仍单个）', () => {
    expect(
      resolveSkillsForContext({ role: 'store', triggerContent: '跑一遍 spec-gate 规格检查' })
    ).toEqual(['spec-gate'])
  })

  it('implementer + 触发含多处关键词 → 白名单求交（未知技能名永不注入）', () => {
    expect(
      resolveSkillsForContext({
        role: 'implementer',
        triggerContent: '发起审查 + code-review 也提一下',
      })
    ).toEqual(['implement', 'quality-gate', 'request-review']) // code-review 不在白名单 → 不进
  })
})

describe('loadSkill — 仓库 skills/ 源库读取与降级守卫', () => {
  it('读真实 quality-gate SKILL.md 关键段', () => {
    const md = loadSkill('quality-gate')
    expect(md).toContain('提交审查前的自查门')
  })

  it('读真实 implement SKILL.md 关键段', () => {
    const md = loadSkill('implement')
    expect(md).toContain('Implement the work described')
  })

  it('路径守卫：非法名返回空串（防穿越到 skills/ 外）', () => {
    expect(loadSkill('..')).toBe('')
    expect(loadSkill('../env')).toBe('')
    expect(loadSkill('a/b')).toBe('')
    expect(loadSkill('-x')).toBe('')
    expect(loadSkill('')).toBe('')
    expect(loadSkill('QUALITY-GATE')).toBe('') // 大写不在允许字符集
  })

  it('未知技能名返回空串（读缺失降级，不抛）', () => {
    expect(loadSkill('no-such-skill-xyz')).toBe('')
  })
})

describe('buildSkillContextBlock — 拼装与降级', () => {
  it('implementer → 区块以 [技能指引] 开头且含两技能关键段', () => {
    const block = buildSkillContextBlock({ role: 'implementer' })
    expect(block.startsWith('\n\n[技能指引]')).toBe(true)
    expect(block).toContain('## 技能：quality-gate')
    expect(block).toContain('## 技能：implement')
    expect(block).toContain('提交审查前的自查门') // quality-gate 正文
  })

  it('reviewer / vision / 未知角色 → 空串（零注入，system prompt 零变更）', () => {
    expect(buildSkillContextBlock({ role: 'reviewer', triggerContent: '请审查这段代码' })).toBe('')
    expect(buildSkillContextBlock({ role: 'vision' })).toBe('')
    expect(buildSkillContextBlock({ role: 'ghost' })).toBe('')
  })
})

// ═══ 组装式：reply.ts 技能注入行为验证 ═══
// 注：引擎执行时 agent 配置由 DB 行重建（serial.ts execute: getAgentById），
// 因此每轮先 UPDATE agents 行（role/provider/name），再落触发消息跑完整 reply。

describe('reply.ts 技能注入 — 仓库源库 + server 运行时组装', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __test_reset()
    const db = createTestDb()
    setDb(db)
    initRepository(db)
    db.prepare(
      `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
       VALUES (?, ?, '🐯', 'You are a cat.', 'opencode', 'opencode-go/deepseek-v4-flash', '', 'implementer')`
    ).run('agent-1', 'ds猫')
    db.prepare(
      `INSERT INTO sessions (id, title, agent_ids, broadcast_mode)
       VALUES ('session-1', '测试会话', '["agent-1"]', 0)`
    ).run()
  })

  afterEach(() => {
    resetDb()
  })

  /** 覆盖 agent 行的运行期字段（引擎以 DB 为准） */
  function updateAgentRow(patch: {
    role: string
    name: string
    llmProvider: string
    llmApiKey: string
    llmModel?: string
  }): void {
    getDb()
      .prepare(
        `UPDATE agents SET role = ?, name = ?, llm_provider = ?, llm_api_key = ?, llm_model = ? WHERE id = 'agent-1'`
      )
      .run(patch.role, patch.name, patch.llmProvider, patch.llmApiKey, patch.llmModel ?? '')
  }

  /**
   * 落触发消息并跑 agent 完整 reply，返回 chatStream 捕获的 llmMessages。
   * 受控适配器产出「收到」；捕获的首参即 runAgentReply 组装产物（被测对象）。
   */
  async function runAndCapture(
    patch: {
      role: string
      name: string
      llmProvider: string
      llmApiKey: string
      llmModel?: string
    },
    triggerContent: string,
    triggerId: string
  ): Promise<Array<{ role: string; content: string }>> {
    __test_reset()
    updateAgentRow(patch)
    getDb()
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions)
         VALUES (?, 'session-1', 'user', ?, '[]')`
      )
      .run(triggerId, triggerContent)

    const chatStream = vi.fn(async function* () {
      yield { content: '收到', kind: 'text' }
    })
    vi.mocked(getAdapterForAgent).mockReturnValue({ chatStream } as any)
    const bus: EngineBus & HandoffBus = {
      emitMessage: () => {},
      emitSystemNotice: () => {},
      emitTyping: () => {},
      emitAgentMessageStatus: () => {},
      emitMessageUpdated: () => {},
      emitContextWindowStats: () => {},
      emitSessionHandoff: () => {},
      emitHandoffFailed: () => {},
    }
    const engine = createExecutionEngine(bus)
    const row = getDb().prepare(`SELECT * FROM agents WHERE id = 'agent-1'`).get() as any
    const agent: AgentConfig = {
      id: 'agent-1',
      name: row.name,
      avatar: row.avatar,
      systemPrompt: row.system_prompt,
      llmProvider: row.llm_provider,
      llmModel: row.llm_model || undefined,
      llmApiKey: row.llm_api_key,
      role: row.role,
    }

    await engine.executeAgentsSerial(
      'session-1',
      [agent],
      { id: triggerId, content: triggerContent, mentions: [] },
      `trace-${triggerId}`,
      0
    )
    const calls = chatStream.mock.calls as unknown as Array<
      [Array<{ role: string; content: string }>]
    >
    return calls[0][0]
  }

  const IMPLEMENTER = { role: 'implementer', name: 'ds猫', llmProvider: 'opencode', llmApiKey: '' }

  it('implementer 完整 reply：system prompt 含 quality-gate/implement 关键段（行为可验证）', async () => {
    const messages = await runAndCapture(IMPLEMENTER, '你好', 'msg-skill-wire')
    const systemContent = messages[0].content
    expect(systemContent).toContain('[技能指引]') // 注入区块头
    expect(systemContent).toContain('提交审查前的自查门') // quality-gate 关键段
    expect(systemContent).toContain('Implement the work described') // implement 关键段
    expect(systemContent).not.toContain('## 技能：spec-gate') // role 默认不误注入 store 侧技能
  })

  it('provider 无关：opencode / ollama / dsh 三种执行体注入结果一致', async () => {
    for (const provider of ['opencode', 'ollama', 'dsh'] as const) {
      const patch = {
        role: 'implementer',
        name: 'ds猫',
        llmProvider: provider,
        // opencode/ollama 免 key（agentHasUsableApiKey 白名单）；dsh 需 key
        llmApiKey: provider === 'dsh' ? 'sk-test' : '',
        llmModel: provider === 'dsh' ? 'deepseek-chat' : 'opencode-go/deepseek-v4-flash',
      }
      const messages = await runAndCapture(patch, '你好', `msg-${provider}`)
      const systemContent = messages[0].content
      expect(systemContent).toContain('[技能指引]')
      expect(systemContent).toContain('提交审查前的自查门')
      expect(systemContent).toContain('Implement the work described')
    }
  })

  it('reviewer 完整 reply：system prompt 零技能注入（内容含审查关键词也不触发）', async () => {
    // 触发消息带「请审查 + quality-gate」关键词——reviewer 不应被注入任何技能
    const messages = await runAndCapture(
      { role: 'reviewer', name: '吐槽猫', llmProvider: 'opencode', llmApiKey: '' },
      '请审查这段代码，quality-gate 自查过了吗',
      'msg-reviewer'
    )
    expect(messages[0].content).not.toContain('[技能指引]')
  })
})
