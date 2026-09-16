/**
 * serial.ts review 钩子接线测试（契约③ X2 · OQ2 补钉）。
 *
 * 与 serial.test.ts 的边界差异：**不 mock verdict-parser / flow-advance**——
 * 验证的是接线本身「reviewer 行首 ✅ → recordReviewVerdict 真实解析落库 →
 * advanceFlowAfterVerdict 真实推进 flow_state」，而不是两者各自被 mock 后的
 * 孤立行为（serial.test.ts 的 mock 使该接线在单测中从未被真实触发）。
 *
 * 其余边界（LLM registry / git / summarizer / handoff / memory / diff / sampler /
 * 信号表）照旧 mock——它们与本契约无关。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentConfig } from '@cat-study/shared'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository } from '../db/repository/index.js'
import { getFlowState } from '../db/repository/flowStates.js'
import { __test_reset } from '../dispatch/index.js'
import { getAdapterForAgent } from '../llm/registry.js'
import { createExecutionEngine } from './serial.js'
import type { ExecutionEngine, ExecutionEngineTestHooks } from './serial.js'
import type { EngineBus, HandoffBus } from './bus.js'

// ═══ 边界 mock（真实 dispatch / SQLite / verdict-parser / flow-advance 保留） ═══

vi.mock('../llm/registry.js', () => ({
  getAdapterForAgent: vi.fn(() => null),
}))

vi.mock('../llm/git-utils.js', () => ({
  gitCommit: vi.fn(),
  getSessionWorktreePath: vi.fn(() => null),
  ensureSessionWorktree: vi.fn(() => null),
  // T-2 Phase I：提交作用域解析改为按角色分派（store → 会话 worktree / 其余 → 猫
  // worktree）。**替身必须镜像真模块被消费的导出面**——漏键 ⇒ 消费方拿到 undefined、
  // 调用即 TypeError（与上面 cleanGitEnv 那条同款，实测踩过）。默认 null ⇒ 不提交。
  ensureAgentWorktree: vi.fn(() => null),
  snapshotPackageDeps: vi.fn(() => ({})),
  diffNewPackages: vi.fn(() => []),
  // T-1 Phase 2：serial.ts 清理段改带 `cleanGitEnv()`（与 gitCommit 对称）。本工厂是
  // **部分导出**——漏键 ⇒ serial.ts 拿到 undefined、调用即 TypeError，而清理段自带
  // `catch {}` 会把它静默吞掉（表现为「清理莫名没跑」）
  cleanGitEnv: vi.fn(() => ({ ...process.env })),
}))

vi.mock('../summarizer/index.js', () => ({
  updateRunningSummary: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../memory/index.js', () => ({
  // 记忆注入一律 stub 成「没命中」（票辛后入口返回结构化结果，reason 带痕）
  retrieveMemoryContext: vi.fn().mockResolvedValue({
    text: '',
    reason: 'no-hit',
    sections: [],
    stats: {},
  }),
  buildKnowledgeContext: vi.fn().mockResolvedValue(''),
  // R1（P2）起 `execution/reply.ts` 还消费这个导出（超时/抛错路径取参数快照的
  // 单一来源）。partial factory 缺它 = 调用点当场 TypeError，回复整条发不出去
  // ——实测踩过。**替身必须镜像真模块被消费的导出面**。
  currentRetrievalParams: vi.fn(() => ({ topK: 3, maxDistance: 0.6, probeN: 20 })),
}))

vi.mock('../handoff/index.js', () => ({
  shouldHandoff: vi.fn(() => false),
  performHandoff: vi.fn().mockResolvedValue(undefined),
  injectSummaryIntoSystem: vi.fn((s: string) => s),
  generateFullSummary: vi.fn(),
}))

vi.mock('../git/diff-collector.js', () => ({
  collectCommitDiffs: vi.fn().mockResolvedValue(null),
  // R2 段五：替身镜像真模块被消费的导出面（`diff.collect` 的超时判据）
  GIT_TIMEOUT_MS: 5000,
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execSync: vi.fn(() => '') }
})

vi.mock('../eval/sampler.js', () => ({
  maybeScoreSample: vi.fn(),
}))

vi.mock('../llm/route-signals.js', () => ({
  consumeRouteSignals: vi.fn(() => []),
}))

vi.mock('../llm/user-request-signals.js', () => ({
  consumeUserRequestSignals: vi.fn(() => []),
}))

// ═══ 夹具 ═══

const SESSION = 'session-1'
const SHA = 'b'.repeat(40)
const TASK = 'task-src-chain' // 源链 trace（verdict 消息 task_id 指向它）
const EXEC_TRACE = 'trace-review-exec'

const REVIEWER: AgentConfig = {
  id: 'agent-reviewer',
  name: '吐槽猫',
  avatar: '🐱',
  systemPrompt: 'You are a cat.',
  llmProvider: 'deepseek',
  llmModel: 'deepseek-v4-pro',
  llmApiKey: 'sk-test',
  role: 'reviewer',
}

function createFakeBus(): EngineBus & HandoffBus {
  const noop = () => {}
  return {
    emitMessage: noop,
    emitSystemNotice: noop,
    emitTyping: noop,
    emitAgentMessageStatus: noop,
    emitMessageUpdated: noop,
    emitContextWindowStats: noop,
    emitSessionHandoff: noop,
    emitHandoffFailed: noop,
  }
}

describe('serial — review 钩子接线（契约③ X2 · 不 mock verdict-parser/flow-advance）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __test_reset()
    const db = createTestDb()
    setDb(db)
    initRepository(db)
    // reviewer（执行者）+ store（reviewer 的合法 @ 目标）+ 实施猫（源链执行行 FK）
    db.prepare(
      `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
       VALUES ('agent-reviewer', '吐槽猫', '🐱', 'You are a cat.', 'deepseek', 'deepseek-v4-pro', 'sk-test', 'reviewer')`
    ).run()
    db.prepare(
      `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
       VALUES ('agent-store', '店长', '🐱', 'You are a cat.', 'deepseek', 'deepseek-v4-pro', 'sk-test', 'store')`
    ).run()
    db.prepare(
      `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
       VALUES ('agent-impl', 'ds猫', '🐱', 'You are a cat.', 'deepseek', 'deepseek-v4-pro', 'sk-test', 'implementer')`
    ).run()
    db.prepare(
      `INSERT INTO sessions (id, title, agent_ids, broadcast_mode)
       VALUES ('session-1', '测试会话', '["agent-reviewer","agent-store","agent-impl"]', 0)`
    ).run()
    // 源链实施行：trace_id = 源链 task_id，commit_hash 已写回（handoff-gen 提交后写回语义）
    db.prepare(
      `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, trace_id, commit_hash)
       VALUES ('exec-src', 'session-1', 'agent-impl', 'msg-impl', 'completed', ?, ?)`
    ).run(TASK, SHA)
  })

  afterEach(() => {
    resetDb()
  })

  it('reviewer 行首 ✅ + @店长 → verdict 真实落库 approve + flow_state 推进至 closed', async () => {
    // 第一次调用产出审查结论（verdict 行首 ✅ + @店长 判定式收口），
    // 第二次（A2A 唤起店长）产出普通回复，避免递归 @
    let call = 0
    const chatStream = vi.fn(async function* () {
      call++
      if (call === 1) {
        yield { content: '✅可合并\n\n@店长 请收口', kind: 'text' }
      } else {
        yield { content: '收到，我来收口', kind: 'text' }
      }
    })
    vi.mocked(getAdapterForAgent).mockReturnValue({ chatStream } as any)

    const db = getDb()
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, mentions, task_id)
       VALUES ('msg-review-req', 'session-1', 'user', '请审查', '["吐槽猫"]', ?)`
    ).run(TASK)

    const engine: ExecutionEngine & ExecutionEngineTestHooks =
      createExecutionEngine(createFakeBus())
    await engine.executeAgentsSerial(
      SESSION,
      [REVIEWER],
      { id: 'msg-review-req', content: '请审查', mentions: ['吐槽猫'], taskId: TASK },
      EXEC_TRACE,
      0
    )

    // ① verdict 真实解析落库（verdict-parser 未被 mock）
    const verdictRow = db
      .prepare(
        `SELECT v.verdict, v.reviewer_agent_id FROM review_verdicts v
         JOIN messages m ON v.message_id = m.id
         WHERE m.task_id = ?`
      )
      .get(TASK) as { verdict: string; reviewer_agent_id: string } | undefined
    expect(verdictRow).toBeDefined()
    expect(verdictRow!.verdict).toBe('approve')
    expect(verdictRow!.reviewer_agent_id).toBe('agent-reviewer')

    // ② 状态机真实推进（flow-advance 未被 mock）：源链 commit 走到终态
    expect(getFlowState(SESSION, SHA)?.state).toBe('closed')

    // ③ 判定式收口已投（reviewer @店长）→ 状态机不补 closeout 投递
    const fallbackCount = db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND content LIKE '%状态机兜底%'`
      )
      .get(SESSION) as { n: number }
    expect(fallbackCount.n).toBe(0)
  })

  it('reviewer 回复无行首结论标记 → verdict 不落库、状态机不推进（钩子空转不误触发）', async () => {
    const chatStream = vi.fn(async function* () {
      yield { content: '看过了，没什么问题\n@店长 你看着办', kind: 'text' }
    })
    vi.mocked(getAdapterForAgent).mockReturnValue({ chatStream } as any)

    const db = getDb()
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, mentions, task_id)
       VALUES ('msg-review-req', 'session-1', 'user', '请审查', '["吐槽猫"]', ?)`
    ).run(TASK)

    const engine = createExecutionEngine(createFakeBus())
    await engine.executeAgentsSerial(
      SESSION,
      [REVIEWER],
      { id: 'msg-review-req', content: '请审查', mentions: ['吐槽猫'], taskId: TASK },
      EXEC_TRACE,
      0
    )

    const verdictCount = db.prepare(`SELECT COUNT(*) AS n FROM review_verdicts`).get() as {
      n: number
    }
    expect(verdictCount.n).toBe(0)
    expect(getFlowState(SESSION, SHA)).toBeUndefined()
  })
})
