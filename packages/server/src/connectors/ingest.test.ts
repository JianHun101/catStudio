/**
 * 链锚贯通（T-E）：ingest 首轮生成锚。
 *
 * 锚 = `messages.task_id`，首轮值 = 该轮 `trace_id`（显式传入优先）。旧实现落的是
 * 调用方的 `taskId || null`——traceId 上一行就生成了却没落列，链首锚恒为空，而
 * episodes / flow-advance / recovery / reply 四处消费方全按 task_id 查 → 空锚静默失配。
 *
 * 边界 mock 只打最外层（LLM registry / git / summarizer / handoff / memory /
 * diff 采集 / eval 采样 / 信号表）——真实 SQLite + 真实 ingest + 真实执行引擎，
 * 组 3 用真引擎跑完整两跳 A2A（验收 ③ 的行为级钉子，不是推演）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentConfig, Message } from '@cat-study/shared'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository } from '../db/repository/index.js'
import { __test_reset as __resetDispatch } from '../dispatch/index.js'
import { setExecutionBus, setExecutionEngine, __test_reset } from '../execution/registry.js'
import { createExecutionEngine } from '../execution/serial.js'
import type {
  AgentTriggerMsg,
  ExecutionEngine,
  ExecutionEngineTestHooks,
} from '../execution/serial.js'
import type { EngineBus, HandoffBus } from '../execution/bus.js'
import { getAdapterForAgent } from '../llm/registry.js'
import { ingestUserMessage } from './ingest.js'

// ═══ 边界 mock（真实 DB / ingest / dispatch / 执行引擎保留） ═══

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

// resolveHandoffTarget 一并 stub：本文件测的是链锚，不是交接路由（真实现读 DB 也可，
// 但 mock 块是文件级的，缺这个导出会让 ingest 的 import 落空）
vi.mock('../handoff/index.js', () => ({
  resolveHandoffTarget: vi.fn(() => null),
  shouldHandoff: vi.fn(() => false),
  performHandoff: vi.fn().mockResolvedValue(undefined),
  injectSummaryIntoSystem: vi.fn((s: string) => s),
  generateFullSummary: vi.fn(),
}))

vi.mock('../git/diff-collector.js', () => ({
  collectCommitDiffs: vi.fn().mockResolvedValue(null),
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
const IMPL_NAME = 'ds猫'

/** 捕获型假 bus：NEW_MESSAGE 载荷按类型化数组收集（杀 any[] 嗅探） */
function createFakeBus(): { bus: EngineBus & HandoffBus; broadcast: Message[] } {
  const broadcast: Message[] = []
  const noop = () => {}
  const bus: EngineBus & HandoffBus = {
    emitMessage: (m) => broadcast.push(m),
    emitSystemNotice: noop,
    emitTyping: noop,
    emitAgentMessageStatus: noop,
    emitMessageUpdated: noop,
    emitContextWindowStats: noop,
    emitSessionHandoff: noop,
    emitHandoffFailed: noop,
  }
  return { bus, broadcast }
}

/** 假引擎：只捕获派发入参（本文件不断言执行行为，除组 3 换真引擎） */
function createStubEngine(dispatches: { triggerMsg: AgentTriggerMsg; traceId: string }[]) {
  return {
    executeAgentsSerial: vi.fn(
      async (_s: string, _a: AgentConfig[], triggerMsg: AgentTriggerMsg, traceId: string) => {
        dispatches.push({ triggerMsg, traceId })
        return false
      }
    ),
  } as unknown as ExecutionEngine & ExecutionEngineTestHooks
}

/** 该消息行的锚（task_id）——null 即空锚 */
function anchorOf(messageId: string): string | null {
  const row = getDb().prepare(`SELECT task_id FROM messages WHERE id = ?`).get(messageId) as
    { task_id: string | null } | undefined
  return row?.task_id ?? null
}

function ingest(content: string, taskId?: string) {
  return ingestUserMessage({
    sessionId: SESSION,
    content,
    mentions: [IMPL_NAME],
    ...(taskId ? { taskId } : {}),
  })
}

describe('connectors/ingest — 链锚贯通（T-E）', () => {
  beforeEach(() => {
    __test_reset()
    __resetDispatch()
    const db = createTestDb()
    setDb(db)
    initRepository(db)
    db.prepare(
      `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
       VALUES ('agent-impl', ?, '🐱', 'You are a cat.', 'deepseek', 'deepseek-v4-pro', 'sk-test', 'implementer')`
    ).run(IMPL_NAME)
    // reviewer 与 implementer 两个角色：A2A 边表 reviewer→implementer 存在，
    // 组 3 的两跳（吐槽猫 → ds猫）走它；组 1/2 只用 ds猫
    db.prepare(
      `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
       VALUES ('agent-reviewer', '吐槽猫', '🐱', 'You are a cat.', 'deepseek', 'deepseek-v4-pro', 'sk-test', 'reviewer')`
    ).run()
    db.prepare(
      `INSERT INTO sessions (id, title, agent_ids)
       VALUES ('session-1', '测试会话', '["agent-impl","agent-reviewer"]')`
    ).run()
  })

  afterEach(() => {
    __test_reset()
    __resetDispatch()
    resetDb()
  })

  it('① 无显式锚的用户消息 → 落库锚非空，且 = 该轮执行的 trace_id', async () => {
    const { bus, broadcast } = createFakeBus()
    const dispatches: { triggerMsg: AgentTriggerMsg; traceId: string }[] = []
    setExecutionBus(bus)
    setExecutionEngine(createStubEngine(dispatches))

    const res = await ingest('你好')
    if (!res.ok) throw new Error(`ingest 失败：${res.error}`)

    expect(dispatches).toHaveLength(1)
    const anchor = anchorOf(res.messageId)
    expect(anchor).toBeTruthy()
    // 旧实现此处为 null（落的是调用方的 `taskId || null`，traceId 没落列）
    expect(anchor).toBe(dispatches[0].traceId)
    // 广播载荷与落库同源：不引入第二个值（验收 ②「首轮回复锚 = 触发消息锚」的前提）
    expect(broadcast).toHaveLength(1)
    expect(broadcast[0].taskId).toBe(anchor)
  })

  it('② 显式锚原样落库、原样进触发消息，不被本轮 traceId 顶替', async () => {
    const { bus, broadcast } = createFakeBus()
    const dispatches: { triggerMsg: AgentTriggerMsg; traceId: string }[] = []
    setExecutionBus(bus)
    setExecutionEngine(createStubEngine(dispatches))

    const EXPLICIT = 'trace-src-chain'
    const res = await ingest('请审查', EXPLICIT)
    if (!res.ok) throw new Error(`ingest 失败：${res.error}`)

    expect(anchorOf(res.messageId)).toBe(EXPLICIT)
    expect(broadcast[0].taskId).toBe(EXPLICIT)
    // 锚 ≠ 本轮 trace（两者本就是不同的值）——证明锚来自显式传入，不是 traceId 覆盖
    expect(dispatches[0].traceId).not.toBe(EXPLICIT)
  })

  it('③ 触发消息的锚恒非空 → 下游 `|| traceId` 只对存量空锚降级，A2A 两跳不换锚', async () => {
    const { bus, broadcast } = createFakeBus()
    setExecutionBus(bus)

    // 真引擎（非 stub）：两跳 A2A 全程真实走 serial → reply 继承链
    const engine = createExecutionEngine(bus)
    let inflight: Promise<boolean> | undefined
    const wrapper = {
      executeAgentsSerial: (
        sessionId: string,
        agents: AgentConfig[],
        triggerMsg: AgentTriggerMsg,
        traceId: string,
        depth?: number
      ) => {
        inflight = engine.executeAgentsSerial(sessionId, agents, triggerMsg, traceId, depth)
        return inflight
      },
    } as unknown as ExecutionEngine & ExecutionEngineTestHooks
    setExecutionEngine(wrapper)

    // 第 1 跳：吐槽猫 回「@ds猫 继续」→ A2A 子链；第 2 跳 ds猫 终止
    let call = 0
    const chatStream = vi.fn(async function* () {
      call++
      yield { content: call === 1 ? `@${IMPL_NAME} 继续` : '收到', kind: 'text' }
    })
    vi.mocked(getAdapterForAgent).mockReturnValue({ chatStream } as any)

    const res = await ingestUserMessage({
      sessionId: SESSION,
      content: '@吐槽猫 请审查',
      mentions: ['吐槽猫'],
    })
    if (!res.ok) throw new Error(`ingest 失败：${res.error}`)
    await inflight

    const rows = getDb()
      .prepare(
        `SELECT role, agent_id, task_id FROM messages WHERE session_id = ? ORDER BY rowid ASC`
      )
      .all(SESSION) as { role: string; agent_id: string | null; task_id: string | null }[]

    const userRow = rows.find((r) => r.role === 'user')
    const agentRows = rows.filter((r) => r.role === 'agent')
    expect(userRow?.task_id).toBeTruthy()
    // 两跳回复都真实落库（A2A 确实转起来了——否则下面断言是空集恒真）
    expect(agentRows).toHaveLength(2)
    for (const row of agentRows) expect(row.task_id).toBe(userRow!.task_id)
    // 广播口径与落库一致（reply.ts:883 用 `triggerMsg.taskId || undefined`）
    expect(broadcast.filter((m) => m.role === 'agent').map((m) => m.taskId)).toEqual([
      userRow!.task_id,
      userRow!.task_id,
    ])
  }, 60000)
})
