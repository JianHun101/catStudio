/**
 * T-1 `a2a-memory-gate`：a2a（触发者是猫）时不检索【相关记忆】。
 *
 * **本文件为什么与 `serial.spans.test.ts` 分开**：那一份把 `memory/index.js` 整个
 * 换成 partial 替身，而本票要验的两件事正好需要**真模块**——
 *   ① `MEMORY_A2A_ENABLED` 这道 env 开关（真 `isA2aMemoryEnabled`）；
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
import type { AgentConfig, Message } from '@cat-study/shared'
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
vi.mock('../memory/embedding.js', () => ({
  isMemoryEnabled: () => true,
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

  beforeEach(() => {
    vi.clearAllMocks()
    __test_reset()
    delete process.env.MEMORY_A2A_ENABLED
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

  // ─── 边界：门只作用于【相关记忆】，【知识库】不动 ───

  it('边界 · 【知识库】不被本门波及（跳过那轮仍走 knowledge.retrieval 段）', async () => {
    const engine = createExecutionEngine(createFakeBus())
    await runRound(engine, 'msg-agent-kb', 'agent', 'trace-a2a-kb')

    const names = spansRepo.getSpansByExecution(executionIdOf('msg-agent-kb')).map((r) => r.name)
    expect(names).toContain('knowledge.retrieval')
  })
})
