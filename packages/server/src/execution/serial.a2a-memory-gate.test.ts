/**
 * T-1 `a2a-memory-gate`：a2a（触发者是猫）时不检索【相关记忆】。
 *
 * **本文件为什么与 `serial.spans.test.ts` 分开**：那一份把 `memory/index.js` 整个
 * 换成 partial 替身，而本票要验的两件事正好需要**真模块**——
 *   ① `MEMORY_A2A_ENABLED` 这道 env 开关（真 `shouldSkipA2aMemory`）；
 *   ② 「门一开，`rewriteRetrievalQueries` 连跑都没跑」（改写在被替身换掉的
 *      `retrieveMemoryContext` **内部**，替身一换就永远证不了这句话）。
 * 故此处只 mock `memory/embedding.js`（不 mock 就没法免掉 sidecar 冷启动）与
 * `memory/query-rewrite.js`（替身即观测点），`memory/index.js` 走真的。
 *
 * 其余边界（LLM registry / git / summarizer / handoff / diff / 信号表）与
 * `serial.spans.test.ts` 同一套替身——它们与本票无关。
 *
 * 判据源是 **DB `messages.role`**（不是 `authorName` 真值推断、不是 content 里的 @）：
 * 故每条用例都**真落一行触发消息**再跑，不塞字面量进 `executeAgentsSerial`——
 * 字面量进不了 `buildTriggerMsg`（它是从 `cmd.triggerMessageId` 反查 DB 的），
 * 只测到「参数搬运」而测不到判据本身。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentConfig, DispatchCommand, Message } from '@cat-study/shared'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb, initDb } from '../db/index.js'
import { initRepository, spans as spansRepo } from '../db/repository/index.js'
import { __test_reset } from '../dispatch/index.js'
import { createExecutionEngine } from './serial.js'
import type { ExecutionEngine, ExecutionEngineTestHooks } from './serial.js'
import type { EngineBus, HandoffBus } from './bus.js'
import { ensureAgentWorktree } from '../llm/git-utils.js'

// ═══ 边界 mock ═══

const h = vi.hoisted(() => ({
  logWarn: vi.fn(),
  gitCommit: vi.fn(),
  collectCommitDiffs: vi.fn(),
  rewriteRetrievalQueries: vi.fn(),
  chatStream: vi.fn(),
}))

vi.mock('../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: h.logWarn, error: vi.fn() }),
  setLogLevel: vi.fn(),
}))

vi.mock('../llm/registry.js', () => ({
  getAdapterForAgent: vi.fn(() => ({ chatStream: h.chatStream })),
}))

vi.mock('../llm/git-utils.js', () => ({
  gitCommit: h.gitCommit,
  getSessionWorktreePath: vi.fn(() => null),
  ensureSessionWorktree: vi.fn(() => null),
  ensureAgentWorktree: vi.fn(() => null),
  snapshotPackageDeps: vi.fn(() => []),
  diffNewPackages: vi.fn(() => []),
  cleanGitEnv: vi.fn(() => ({ ...process.env })),
}))

vi.mock('../summarizer/index.js', () => ({
  updateRunningSummary: vi.fn().mockResolvedValue(undefined),
}))

// 嵌入链：不 mock 就会真去 spawn sidecar。返回「不可用」——检索链按既有降级路径
// 退成纯关键词通道（这正是「门开时改写跑了没有」可观测的前提：链真的往下走了）。
// ⚠️ `isMemoryEnabled` **按 env 委托**（逐字同款 `EmbeddingClient.isEnabled()`：
// `MEMORY_ENABLED !== 'false'`），不是恒 `true`——记忆总开关是本票 F3 的自变量，
// 写成常量会让「总开关关」那条用例变成一条永不触发的门（本文件所在 project 的
// `test.env.MEMORY_ENABLED` 正是 `'false'`，见 `vitest.config.ts`）。
vi.mock('../memory/embedding.js', () => ({
  isMemoryEnabled: () => process.env.MEMORY_ENABLED !== 'false',
  embedText: async () => ({ ok: false, reason: 'test-unavailable' }),
  getEmbeddingStatus: () => ({ ok: false, reason: 'test-unavailable' }),
}))

// 改写器替身 = 验收 1/5 的观测点（真改写要打 LLM）。
vi.mock('../memory/query-rewrite.js', () => ({
  rewriteRetrievalQueries: h.rewriteRetrievalQueries,
}))

vi.mock('../handoff/index.js', () => ({
  shouldHandoff: vi.fn(() => false),
  performHandoff: vi.fn().mockResolvedValue(undefined),
  injectSummaryIntoSystem: vi.fn((s: string) => s),
  generateFullSummary: vi.fn(),
}))

vi.mock('../git/diff-collector.js', () => ({
  collectCommitDiffs: h.collectCommitDiffs,
  GIT_TIMEOUT_MS: 5000,
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

// ═══ 假 bus ═══

function createFakeBus(): EngineBus & HandoffBus {
  return {
    emitMessage: (_m: Message) => {},
    emitSystemNotice: () => {},
    emitTyping: () => {},
    emitAgentMessageStatus: () => {},
    emitMessageUpdated: () => {},
    emitContextWindowStats: () => {},
    emitSessionHandoff: () => {},
    emitHandoffFailed: () => {},
  }
}

// ═══ 夹具 ═══

function agent(id: string, name: string): AgentConfig {
  return {
    id,
    name,
    avatar: '🐱',
    systemPrompt: 'You are a cat.',
    llmProvider: 'deepseek',
    llmModel: 'deepseek-v4-pro',
    llmApiKey: 'sk-test',
  }
}
const A1 = agent('agent-1', '店长')

/** 落一行触发消息（role 由调用方给——本票的**唯一自变量**）+ 跑一轮执行 */
async function runRound(
  engine: ExecutionEngine & ExecutionEngineTestHooks,
  triggerId: string,
  role: 'user' | 'agent',
  traceId: string
): Promise<void> {
  getDb()
    .prepare(
      `INSERT INTO messages (id, session_id, role, content, mentions)
       VALUES (?, 'session-1', ?, '你好', '[]')`
    )
    .run(triggerId, role)
  await engine.executeAgentsSerial(
    'session-1',
    [A1],
    {
      id: triggerId,
      content: '你好',
      mentions: [],
      // 本对象的 fromAgent **不进 makeCmd**：reply 侧读的是执行体重建的那一份
      // （DB 反查）。此处随便填，正是为了证明「这条链不看入参」——见验收 6 用例。
      fromAgent: false,
    },
    traceId
  )
}

const executionIdOf = (triggerId: string): string =>
  (
    getDb()
      .prepare('SELECT id FROM execution_logs WHERE triggered_by_message_id = ?')
      .get(triggerId) as { id: string }
  ).id

const memorySpan = (triggerId: string): any =>
  spansRepo.getSpansByExecution(executionIdOf(triggerId)).find((r) => r.name === 'memory.retrieval')

const retrievalEvent = (triggerId: string): any =>
  getDb()
    .prepare('SELECT * FROM retrieval_events WHERE execution_id = ?')
    .get(executionIdOf(triggerId))

describe('serial × T-1 a2a 记忆门', () => {
  const savedEnv = process.env.MEMORY_A2A_ENABLED
  const savedMaster = process.env.MEMORY_ENABLED

  beforeEach(() => {
    vi.clearAllMocks()
    __test_reset()
    delete process.env.MEMORY_A2A_ENABLED
    // **显式**打开记忆总开关（不是继承 project 的 `MEMORY_ENABLED:'false'`）：
    // 门与总开关是合取关系（F3），不显式打开的话本文件的门控用例全部退化成
    // 「测一条永不触发的门」——绿得毫无信息量。F3 那条用例再单独关掉它。
    process.env.MEMORY_ENABLED = 'true'
    const db = createTestDb()
    setDb(db)
    initDb()
    initRepository(db)
    db.prepare(
      `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
       VALUES ('agent-1', '店长', '🐱', 'p', 'deepseek', 'deepseek-v4-pro', 'sk-test')`
    ).run()
    db.prepare(
      `INSERT INTO sessions (id, title, agent_ids, broadcast_mode)
       VALUES ('session-1', '测试会话', '["agent-1"]', 0)`
    ).run()

    h.rewriteRetrievalQueries.mockResolvedValue([])
    h.collectCommitDiffs.mockResolvedValue(null)
    h.gitCommit.mockReturnValue(null)
    vi.mocked(ensureAgentWorktree).mockReturnValue(null)
    h.chatStream.mockImplementation(async function* () {
      yield { content: '收到', kind: 'text' }
    })
  })

  afterEach(() => {
    resetDb()
    if (savedEnv === undefined) delete process.env.MEMORY_A2A_ENABLED
    else process.env.MEMORY_A2A_ENABLED = savedEnv
    if (savedMaster === undefined) delete process.env.MEMORY_ENABLED
    else process.env.MEMORY_ENABLED = savedMaster
  })

  // ─── 验收 1 / 4 / 5：a2a（DB role='agent'）+ 开关关 ⇒ 整段跳过 ───

  it('验收 1/5 · a2a 触发 + 开关关 → 不检索、不跑改写（`rewriteRetrievalQueries` 零调用）', async () => {
    const engine = createExecutionEngine(createFakeBus())
    await runRound(engine, 'msg-agent', 'agent', 'trace-a2a-off')

    expect(h.rewriteRetrievalQueries).not.toHaveBeenCalled()
  })

  it('验收 4 · 跳过时 span status === `skipped`（不是 ok、不是 error），且不计 error', async () => {
    const engine = createExecutionEngine(createFakeBus())
    await runRound(engine, 'msg-agent', 'agent', 'trace-a2a-off')

    const span = memorySpan('msg-agent')
    expect(span).toBeTruthy()
    expect(span.status).toBe('skipped')
    // `deriveErrorType` 对 skipped 返回 null ⇒ `error_type` 不该有值
    // （落 'error' 会是「跑挂了」的假读数，落 'ok' 是「跑过且零命中」的假读数）
    expect(span.error_type ?? null).toBeNull()
  })

  it('契约 3 · 跳过**不静默**：`retrieval_events` 落一行 reason=skipped-a2a，且参数快照非 null', async () => {
    const engine = createExecutionEngine(createFakeBus())
    await runRound(engine, 'msg-agent', 'agent', 'trace-a2a-off')

    const ev = retrievalEvent('msg-agent')
    expect(ev).toBeTruthy()
    expect(ev.reason).toBe('skipped-a2a')
    // 「形状与其它空结果同构」的承重面：`recordRetrievalTrace` 按 `stats?.xxx` 取值，
    // 形状一分叉这三列就全是 null——「跳过一次」与「参数没记上」当场不可区分。
    expect(ev.threshold_max_distance).not.toBeNull()
    expect(ev.param_top_k).not.toBeNull()
    expect(ev.param_probe_n).not.toBeNull()
  })

  // ─── 验收 2 / 6：用户触发（DB role='user'）⇒ 现状不变 ───

  it('验收 2/6 · 用户触发（DB role=user）→ 照常检索（改写被调用一次）', async () => {
    const engine = createExecutionEngine(createFakeBus())
    await runRound(engine, 'msg-user', 'user', 'trace-user')

    expect(h.rewriteRetrievalQueries).toHaveBeenCalledTimes(1)
    // 传进去的是剥掉 @mention 后的内容（`retrieveMemoryContext` 的口径）
    expect(h.rewriteRetrievalQueries).toHaveBeenCalledWith('你好')
    expect(memorySpan('msg-user').status).toBe('ok')
    expect(retrievalEvent('msg-user').reason).not.toBe('skipped-a2a')
  })

  it('验收 6（反向对照）· 入参 fromAgent 被忽略：判据只认 DB role', async () => {
    // `runRound` 的入参 fromAgent 恒 false，而本用例的 DB 行 role='agent'——
    // 若实现改成「读入参」，本用例会当场变绿（= 检索发生），红得正是地方。
    const engine = createExecutionEngine(createFakeBus())
    await runRound(engine, 'msg-agent-2', 'agent', 'trace-a2a-off-2')

    expect(h.rewriteRetrievalQueries).not.toHaveBeenCalled()
    expect(retrievalEvent('msg-agent-2').reason).toBe('skipped-a2a')
  })

  // ─── 验收 3：开关可逆 ───

  it('验收 3 · a2a 触发 + `MEMORY_A2A_ENABLED=1` → 检索照跑（开关可逆）', async () => {
    process.env.MEMORY_A2A_ENABLED = '1'
    const engine = createExecutionEngine(createFakeBus())
    await runRound(engine, 'msg-agent-on', 'agent', 'trace-a2a-on')

    expect(h.rewriteRetrievalQueries).toHaveBeenCalledTimes(1)
    expect(memorySpan('msg-agent-on').status).toBe('ok')
    expect(retrievalEvent('msg-agent-on').reason).not.toBe('skipped-a2a')
  })

  // ─── F3（店长裁决，第③轮返工）：总开关关时门**不生效** ───
  // 契约 3 变更：`skipped-a2a` **仅在记忆总开关为开时**使用；总开关关时一律
  // `not-enabled`（reason 与 span status 都与用户触发同口径）——门在那种场景下
  // **没有决定任何事**，把原因归给它与「span 不许撒谎」是同一把尺子。

  it('F3 · 总开关关 + a2a → `not-enabled`（非 `skipped-a2a`），与用户侧同口径', async () => {
    process.env.MEMORY_ENABLED = 'false'
    const engine = createExecutionEngine(createFakeBus())
    await runRound(engine, 'msg-master-off-a2a', 'agent', 'trace-master-off-a2a')
    await runRound(engine, 'msg-master-off-user', 'user', 'trace-master-off-user')

    // 判据组：a2a 轮次不许记 `skipped-a2a`（门未生效），走的是模块自己的 not-enabled
    const a2aEv = retrievalEvent('msg-master-off-a2a')
    expect(a2aEv.reason).toBe('not-enabled')
    expect(memorySpan('msg-master-off-a2a').status).toBe('ok')
    // 不静默面照旧：走正常路径的 not-enabled 行参数快照同样非 null
    expect(a2aEv.param_top_k).not.toBeNull()
    // 对照组：**同口径**——用户侧在总开关关时也是 `not-enabled` / `ok`
    // （这一对断言是「合取项」的证伪面：门若在总开关关时仍生效，判据组当场变红）
    expect(retrievalEvent('msg-master-off-user').reason).toBe('not-enabled')
    expect(memorySpan('msg-master-off-user').status).toBe('ok')
    // `not-enabled` 在改写器**之前**返回 ⇒ 改写零调用（这一条不是本门省的）
    expect(h.rewriteRetrievalQueries).not.toHaveBeenCalled()
  })

  // ─── 边界：门只作用于【相关记忆】，【知识库】不动 ───

  it('边界 · 【知识库】不被本门波及（跳过那轮仍走 knowledge.retrieval 段）', async () => {
    const engine = createExecutionEngine(createFakeBus())
    await runRound(engine, 'msg-agent-kb', 'agent', 'trace-a2a-kb')

    const names = spansRepo.getSpansByExecution(executionIdOf('msg-agent-kb')).map((r) => r.name)
    expect(names).toContain('knowledge.retrieval')
  })

  // ─── F4（审查返工补网）：drain 那条构造点同判据 ───
  // 上面 7 条全走 `executeAgentsSerial → makeCmd → buildTriggerMsg`，**没有一条走 drain**。
  // 而 `drainQueuedCommand` 是判据的**第二构造点**：它直接调 `executeOneAgent`、
  // 不经 `execute()`，故 `buildTriggerMsg` 在那条路上根本不跑，reply 侧读到的
  // `fromAgent` 就是 drain 自己反查 DB 算的那一份。缺了这条，等于「单点判据防分叉」
  // 的设计意图在第二个点上没有回归网（改坏它没有任何用例会红）。

  it('F4 · drain（出队补执行）那条构造点同判据：queued 触发 role=agent ⇒ 同样跳过', async () => {
    const engine = createExecutionEngine(createFakeBus())
    const db = getDb()
    // ⚠️ **两条**被 drain 的命令（一 user 一 agent），不是一条：
    // 直接跑的第一条走的是 `execute() → executeRun → buildTriggerMsg`，**不经 drain**
    // ——只放一条对照在首位，断言取到的会是「另一条构造点」，本用例就退化成单侧
    // （实测：把 drain 的 fromAgent 写死 `true` 时它不会红）。三条命令 = head 直跑 +
    // 两条入队，drain 链式续排（`executeOneAgent` 收尾段再 drain 下一条）。
    for (const [id, role] of [
      ['msg-drain-head', 'user'],
      ['msg-drain-user', 'user'],
      ['msg-drain-a2a', 'agent'],
    ] as const) {
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions)
         VALUES (?, 'session-1', ?, '你好', '[]')`
      ).run(id, role)
    }
    const cmd = (triggerMessageId: string, traceId: string): DispatchCommand => ({
      sessionId: 'session-1',
      agentId: A1.id,
      triggerMessageId,
      triggerContent: '你好',
      mentions: [],
      traceId,
      depth: 0,
      pendingTriggers: [],
    })

    // depth=0：不走 A2A 的「并入 queued 命令」合并分支，确保后两条**真的入队**。
    // `execute` 的决策段全同步（第一个 await 之前完成标忙/入队）⇒ 三行调用返回时
    // 槽位已被 head 占住、另两条在队列里。
    const p1 = engine.execute(cmd('msg-drain-head', 'trace-drain-head'))
    const p2 = engine.execute(cmd('msg-drain-user', 'trace-drain-user'))
    const p3 = engine.execute(cmd('msg-drain-a2a', 'trace-drain-a2a'))
    // **结构见证**（本用例真走在 drain 路径上的凭据，不是靠断言事后猜）：
    expect(engine.getSlot(A1.id, 'session-1')?.queueLength).toBe(2)
    // head 的 await 覆盖整条 drain 链（drain 在 `executeOneAgent` 收尾段被 await）
    await Promise.all([p1, p2, p3])

    // 判据组：被 drain 的那轮按 DB role='agent' 跳过
    expect(retrievalEvent('msg-drain-a2a').reason).toBe('skipped-a2a')
    expect(memorySpan('msg-drain-a2a').status).toBe('skipped')
    // 对照组：**同样被 drain** 的用户轮照常检索 ⇒ 两组断言打在同一个构造点上，
    // 恒真的门（写死 true / 写死 false）在此必红一半，探针非单侧。
    expect(retrievalEvent('msg-drain-user').reason).not.toBe('skipped-a2a')
    expect(memorySpan('msg-drain-user').status).toBe('ok')
  }, 20000)
})
