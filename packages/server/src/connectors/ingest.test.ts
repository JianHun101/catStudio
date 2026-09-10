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
import { resolveHandoffTarget } from '../handoff/index.js'
import {
  ingestUserMessage,
  buildDeliveryGateError,
  deriveChainExistence,
  isReviewDelivery,
} from './ingest.js'

// ═══ 边界 mock（真实 DB / ingest / dispatch / 执行引擎保留） ═══

// 日志按边界 mock：N-3 的**唯一可观测面**就是那条 warn（"不适用"与"确认不存在"
// 今天行为等价，差别只在日志与类型）——不 mock 就只能断言"两者都放行"，
// 那是恒真的假绿门（同 T-J 的「验证面必须与被判面同面」）。
const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }))
vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: logWarn,
    error: vi.fn(),
  }),
  setLogLevel: vi.fn(),
}))

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
    // T-F 返工 OQ-4：`origin` 已必填（fail-loud，D15）。本组模拟**用户消息**，
    // 走 human 档（允许空锚）——补的是必填字段字面量，判据与断言未动。
    origin: 'human',
    ...(taskId ? { taskId } : {}),
  })
}

/** 真实 SQLite + 真 ingest 的基座（两组共用：T-E 链锚 / T-F 入口主闸） */
function setupFixture(): void {
  __test_reset()
  __resetDispatch()
  logWarn.mockClear()
  const db = createTestDb()
  setDb(db)
  initRepository(db)
  db.prepare(
    `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
     VALUES ('agent-impl', ?, '🐱', 'You are a cat.', 'deepseek', 'deepseek-v4-pro', 'sk-test', 'implementer')`
  ).run(IMPL_NAME)
  // reviewer 与 implementer 两个角色：A2A 边表 reviewer→implementer 存在，
  // 组 3 的两跳（吐槽猫 → ds猫）走它；组 1/2 只用 ds猫。T-F 组另靠 reviewer 角色
  // 判定「审查类投递」（按 role 不按猫名）。
  db.prepare(
    `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
     VALUES ('agent-reviewer', '吐槽猫', '🐱', 'You are a cat.', 'deepseek', 'deepseek-v4-pro', 'sk-test', 'reviewer')`
  ).run()
  db.prepare(
    `INSERT INTO sessions (id, title, agent_ids)
     VALUES ('session-1', '测试会话', '["agent-impl","agent-reviewer"]')`
  ).run()
}

describe('connectors/ingest — 链锚贯通（T-E）', () => {
  beforeEach(setupFixture)

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
      origin: 'human', // T-F 返工 OQ-4：origin 必填，本跳模拟用户消息（human 档）
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

/**
 * 投递契约主闸（T-F）。
 *
 * 判据**全部读入参**，不读落库列——T-E 之后 `messages.task_id` 由服务端自动生成、
 * 落库列恒非空，任何"按 DB 列判 agent 缺锚"的写法都是死码（T-E 审查 OQ-1 落锤）。
 * 结构推导（链在不在）是唯一一处 DB 查询，且**只**在「审查类 + 声明建链」时才发起。
 */
describe('connectors/ingest — 投递契约主闸（T-F）', () => {
  beforeEach(setupFixture)

  afterEach(() => {
    __test_reset()
    __resetDispatch()
    resetDb()
  })

  // ── 判据（纯函数：结构推导结果由调用方传入，四方向各一例 + 降级） ──

  const gate = (o: Partial<Parameters<typeof buildDeliveryGateError>[0]>) =>
    buildDeliveryGateError({
      origin: 'agent',
      taskId: 'anchor-a',
      chainType: 'first',
      isReview: false,
      chainExistence: 'absent',
      ...o,
    })

  it('主闸①：人类入口空锚 → 放行（用户消息天然是链首轮）', () => {
    expect(gate({ origin: 'human', taskId: undefined })).toBeNull()
    // 纯函数的 `origin` 仍可空（非 `'agent'` ⇒ 放行）：OQ-4 之后这是**防御性契约**，
    // 不再是可达状态——`IngestInput.origin` 必填，四个生产入口全部显式标注。
    expect(gate({ origin: undefined, taskId: undefined })).toBeNull()
  })

  it('主闸②：agent 投递缺锚 → 400（非审查类也拦）', () => {
    const err = gate({ taskId: undefined })
    expect(err?.status).toBe(400)
    expect(err?.error).toContain('缺链锚')
  })

  it('主闸③：审查类缺 chainType → 400（对账位必填）', () => {
    const err = gate({ isReview: true, chainType: undefined })
    expect(err?.status).toBe(400)
    expect(err?.error).toContain('chainType')
  })

  it('主闸④：审查类声明 followup 但锚为空 → 400（漏带锚，走特异性分支而非通用缺锚）', () => {
    const err = gate({ isReview: true, chainType: 'followup', taskId: undefined })
    expect(err?.status).toBe(400)
    expect(err?.error).toContain('followup')
  })

  it('主闸⑤：审查类声明 first 但链已存在 → 400（静默挂错链）', () => {
    const err = gate({ isReview: true, chainType: 'first', chainExistence: 'exists' })
    expect(err?.status).toBe(400)
    expect(err?.error).toContain('first')
  })

  it('主闸⑥：结构推导查不动 → 以声明为准放行（降级方向与 B3 一致：不把合法投递判死）', () => {
    expect(gate({ isReview: true, chainType: 'first', chainExistence: 'unknown' })).toBeNull()
  })

  it('主闸⑦：审查类声明 first + 链不存在 → 放行（真建链）', () => {
    expect(gate({ isReview: true, chainType: 'first', chainExistence: 'absent' })).toBeNull()
    // followup 带锚 = 链内更新，放行
    expect(gate({ isReview: true, chainType: 'followup' })).toBeNull()
  })

  it('主闸⑧（N-3）：`undefined`（不适用）与 `absent`（确认不存在）都是放行——但可区分', () => {
    // 行为今天等价（两者都不命中 `exists` 拒绝分支），差别在**语义与日志**：
    // `absent` = 探过了、确认链不存在；`undefined` = 本条压根不需要探针。
    // 旧实现用 `'absent'` 表达"不适用"（假数据），下一个消费方无从分辨。
    expect(gate({ isReview: true, chainType: 'first', chainExistence: undefined })).toBeNull()
    expect(gate({ isReview: true, chainType: 'first', chainExistence: 'absent' })).toBeNull()
    // 对照：只有 `exists` 会拒——证明上面两条不是"恒真的空断言"
    expect(gate({ isReview: true, chainType: 'first', chainExistence: 'exists' })?.status).toBe(400)
  })

  it('主闸⑨（N-3）：该探针而未探（传 undefined）→ 放行但记 warn（不再静默）', () => {
    logWarn.mockClear()
    expect(gate({ isReview: true, chainType: 'first', chainExistence: undefined })).toBeNull()
    expect(logWarn).toHaveBeenCalledWith(
      'chainType=first 但调用方未提供结构推导——以声明为准放行（调用方缺探针）',
      { taskId: 'anchor-a' }
    )
    // 区分性：`unknown`（外部查询失败，正常降级）走的是另一条文案——两者不可混同
    logWarn.mockClear()
    gate({ isReview: true, chainType: 'first', chainExistence: 'unknown' })
    expect(logWarn).toHaveBeenCalledWith('chainType=first 且结构推导查不动——以声明为准放行', {
      taskId: 'anchor-a',
    })
  })

  it('审查类判定按 role（不按猫名）：点名 reviewer 角色才要求 chainType', () => {
    expect(isReviewDelivery(['吐槽猫'])).toBe(true)
    expect(isReviewDelivery([IMPL_NAME])).toBe(false)
    expect(isReviewDelivery([])).toBe(false)
  })

  // ── 结构推导（真 DB） ──

  it('结构推导：空锚 → absent（无需查询）；有消息 → exists；无消息 → absent', () => {
    expect(deriveChainExistence(SESSION, undefined)).toBe('absent')
    expect(deriveChainExistence(SESSION, 'anchor-never-used')).toBe('absent')

    getDb()
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions, task_id)
         VALUES ('m-chain', ?, 'user', 'hi', '[]', 'anchor-existing')`
      )
      .run(SESSION)
    expect(deriveChainExistence(SESSION, 'anchor-existing')).toBe('exists')
  })

  // ── 组装（真 SQLite + 真 ingest）：拒绝发生在 INSERT 之前，零副作用 ──

  it('组装：agent 缺锚被拒 → 400 且不落库、不派发', async () => {
    const { bus, broadcast } = createFakeBus()
    const dispatches: { triggerMsg: AgentTriggerMsg; traceId: string }[] = []
    setExecutionBus(bus)
    setExecutionEngine(createStubEngine(dispatches))

    const res = await ingestUserMessage({
      sessionId: SESSION,
      content: '请审查',
      mentions: [IMPL_NAME],
      origin: 'agent',
    })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.status).toBe(400)
    expect(dispatches).toHaveLength(0)
    expect(broadcast).toHaveLength(0)
    const count = getDb().prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number }
    expect(count.n).toBe(0)
  })

  it('组装：审查类声明 first 但链已存在（真查）→ 400', async () => {
    getDb()
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions, task_id)
         VALUES ('m-old', ?, 'user', '旧轮', '[]', 'anchor-live')`
      )
      .run(SESSION)

    const res = await ingestUserMessage({
      sessionId: SESSION,
      content: '返工投递',
      mentions: ['吐槽猫'],
      taskId: 'anchor-live',
      origin: 'agent',
      chainType: 'first',
    })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.status).toBe(400)
  })

  it('组装 N-2：已交接会话 → 探针查**落地子会话**（链在子会话 ⇒ `first` 被拒）', async () => {
    const CHILD = 'session-child'
    getDb()
      .prepare(
        `INSERT INTO sessions (id, title, agent_ids, handoff_from)
         VALUES (?, '子会话', '[]', ?)`
      )
      .run(CHILD, SESSION)
    // 链的消息全在**子**会话，父会话 0 行——旧实现探父会话必判 `absent` ⇒ 漏拦（fail-open）
    getDb()
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions, task_id)
         VALUES ('m-in-child', ?, 'user', '链上旧轮', '[]', 'anchor-handed-off')`
      )
      .run(CHILD)
    vi.mocked(resolveHandoffTarget).mockReturnValueOnce({
      oldSessionId: SESSION,
      newSessionId: CHILD,
      summary: '',
    })

    const res = await ingestUserMessage({
      sessionId: SESSION, // 投递打的是**父**会话
      content: '返工投递',
      mentions: ['吐槽猫'],
      taskId: 'anchor-handed-off',
      origin: 'agent',
      chainType: 'first',
    })
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.status).toBe(400)
    // 拒绝仍零副作用：只有 fixture 那一条，父/子会话都没多出消息
    const count = getDb().prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number }
    expect(count.n).toBe(1)
  })

  it('组装：审查类带锚 + followup → 放行（链内更新是合法投递）', async () => {
    const { bus, broadcast } = createFakeBus()
    const dispatches: { triggerMsg: AgentTriggerMsg; traceId: string }[] = []
    setExecutionBus(bus)
    setExecutionEngine(createStubEngine(dispatches))

    const res = await ingestUserMessage({
      sessionId: SESSION,
      content: '@吐槽猫 复申',
      mentions: ['吐槽猫'],
      taskId: 'anchor-live',
      origin: 'agent',
      chainType: 'followup',
    })
    if (!res.ok) throw new Error(`ingest 失败：${res.error}`)
    expect(anchorOf(res.messageId)).toBe('anchor-live')
    expect(broadcast).toHaveLength(1)
  })
})
