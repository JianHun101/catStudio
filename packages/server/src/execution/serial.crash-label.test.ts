/**
 * serial.ts `executeRun` finally 兜底词测试 — R6 §A 立词（OQ-1：给谎报的标签正名），
 * R7 分流（同一行的三条互斥通路各说各的）。
 *
 * 靶心 = `serial.ts` finally 里 `errorMessage:` 那个三选一表达式
 * （`messageOf(execError) ?? (execError === undefined ? '<槽位词>' : '<取值词>')`）：
 *
 * - 旧词 `'execute crash'` 同时背负**两种互斥情形**——「真崩」与「没崩、只是槽位
 *   在收口后被别的执行接管了」。全库那批 `error_message = 'execute crash'` 里，
 *   `execError` 恒为 undefined（`executeRun` 的 catch 伴生日志 0 条）⇒ 那些行
 *   **没有一行是崩溃**，正名即修谎报。
 * - R7 除根后，「槽位是别人的」那条通路**根本不再进收口**（归属校验拦下，见
 *   `serial.slot-ownership.test.ts` 的 B1），故本文件只覆盖**归属是自己的**剩下的两条：
 *   R6 §A 那个「没崩但落词」的竞态用例已随语义搬到 B1，不在此处重复。
 *
 * 本文件覆盖的互斥通路（存在理由 = 它们不许共用一词）：
 * - `execError` 有值且 `messageOf` 取得到（A2）= 本帧真的抛了 ⇒ 逐字原样；
 * - `execError` 有值但 `messageOf` 返回 undefined（A1）= 抛了非 Error 且取不出信息
 *   ⇒ 取值词，**不得**落成「没抛」的槽位词（那是与旧词同型的谎报）；
 * - 正常路径（A2b）= 不落任何兜底词。
 *
 * 边界与 `serial.crash-diagnostic.test.ts` 同款：真实 SQLite（`createTestDb()` +
 * `initDb()`）+ 真实 dispatch，只 mock 最外层（LLM registry / git / summarizer /
 * memory / handoff / diff / 信号表 / logger）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { DispatchCommand, Message, SystemNoticePayload } from '@cat-study/shared'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb, initDb } from '../db/index.js'
import { initRepository } from '../db/repository/index.js'
import { __test_reset } from '../dispatch/index.js'
import { createExecutionEngine } from './serial.js'
import type { ExecutionEngine } from './serial.js'
import type { EngineBus, HandoffBus } from './bus.js'
import { ensureAgentWorktree } from '../llm/git-utils.js'

/** 「正常返回却仍占着槽位」词（`serial.ts` finally 三选一 —— `execError === undefined` 支） */
const SLOT_BUSY_LITERAL = 'slot busy after executeOneAgent returned'
/** 「抛了非 Error 且取不出信息」词（`serial.ts` finally 三选一 —— 末支，R7 新增分流） */
const NO_MESSAGE_LITERAL = 'execute threw a value with no extractable message'
/** 旧词：本票把它从「兜底」降级为「历史存量标签」，新代码路径不得再落 */
const LEGACY_LITERAL = 'execute crash'

const h = vi.hoisted(() => ({
  logError: vi.fn(),
  gitCommit: vi.fn(),
  collectCommitDiffs: vi.fn(),
  retrieveMemoryContext: vi.fn(),
  buildKnowledgeContext: vi.fn(),
  chatStream: vi.fn(),
}))

vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: h.logError,
  }),
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

vi.mock('../llm/worktree-fanin.js', () => ({
  ensureExecutionWorktree: vi.fn(() => null),
}))

vi.mock('../summarizer/index.js', () => ({
  updateRunningSummary: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../memory/index.js', () => ({
  retrieveMemoryContext: h.retrieveMemoryContext,
  buildKnowledgeContext: h.buildKnowledgeContext,
  currentRetrievalParams: vi.fn(() => ({ topK: 3, maxDistance: 0.6, probeN: 20 })),
  // T-1：a2a 记忆门新增的两个被消费导出——同一条规矩（见上），partial factory
  // 缺一个就是调用点 TypeError。默认值镜像生产：门**关**、跳过结果形状同构。
  shouldSkipA2aMemory: vi.fn(() => false),
  skippedRetrievalResult: vi.fn(() => ({
    text: '',
    reason: 'skipped-a2a',
    sections: [],
    stats: {},
  })),
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

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execSync: vi.fn(() => '') }
})

vi.mock('../eval/sampler.js', () => ({ maybeScoreSample: vi.fn() }))
vi.mock('../eval/verdict-parser.js', () => ({ recordReviewVerdict: vi.fn() }))
vi.mock('../llm/route-signals.js', () => ({ consumeRouteSignals: vi.fn(() => []) }))
vi.mock('../llm/user-request-signals.js', () => ({ consumeUserRequestSignals: vi.fn(() => []) }))

// ═══ 假 bus（A2 用例需要它「抛」——见该用例注释）═══

let notices: SystemNoticePayload[] = []
/** 非 null 时 `emitSystemNotice` 抛出该值（模拟桥接层故障） */
let noticeThrow: unknown = null

function createFakeBus(): EngineBus & HandoffBus {
  return {
    emitMessage: (_m: Message) => {},
    emitSystemNotice: (n: SystemNoticePayload) => {
      if (noticeThrow) throw noticeThrow
      notices.push(n)
    },
    emitTyping: () => {},
    emitAgentMessageStatus: () => {},
    emitMessageUpdated: () => {},
    emitContextWindowStats: () => {},
    emitSessionHandoff: () => {},
    emitHandoffFailed: () => {},
  }
}

// ═══ 夹具 ═══

const A1 = 'agent-1'
const A2 = 'agent-2'
/** 无可用 key 的猫（`agentHasUsableApiKey` 判否 ⇒ 走 `:500` 分支） */
const A3 = 'agent-3'

function insertAgent(id: string, name: string, apiKey = 'sk-test'): void {
  getDb()
    .prepare(
      `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
       VALUES (?, ?, '🐱', 'You are a cat.', 'deepseek', 'deepseek-v4-pro', ?)`
    )
    .run(id, name, apiKey)
}

function insertUserMessage(id: string, content = '你好'): void {
  getDb()
    .prepare(
      `INSERT INTO messages (id, session_id, role, content, mentions, task_id)
       VALUES (?, 'session-1', 'user', ?, '[]', NULL)`
    )
    .run(id, content)
}

/** 与 `execute()` 决策段入参同形（`makeCmd` 的测试侧构造） */
function cmd(triggerMessageId: string, traceId: string, agentId = A1): DispatchCommand {
  return {
    sessionId: 'session-1',
    agentId,
    triggerMessageId,
    triggerContent: '你好',
    mentions: [],
    traceId,
    depth: 0,
    pendingTriggers: [],
  }
}

const logOf = (triggerId: string): any =>
  getDb()
    .prepare('SELECT * FROM execution_logs WHERE triggered_by_message_id = ?')
    .get(triggerId) as any

/** 本文件所有用例共用一个 engine 实例的槽位视图——`beforeEach` 里重建 */
let createEngine: ExecutionEngine

describe('R6 §A 立词 + R7 分流 · executeRun finally 兜底词：三条互斥通路不共用一词', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    notices = []
    noticeThrow = null
    __test_reset()
    const db = createTestDb()
    setDb(db)
    initDb()
    initRepository(db)
    insertAgent(A1, '店长')
    insertAgent(A2, '吐槽猫')
    insertAgent(A3, '无钥猫', 'sk-your-api-key-here')
    db.prepare(
      `INSERT INTO sessions (id, title, agent_ids, broadcast_mode)
       VALUES ('session-1', '测试会话', '["agent-1","agent-2","agent-3"]', 0)`
    ).run()

    h.retrieveMemoryContext.mockResolvedValue({
      text: '',
      reason: 'no-hit',
      sections: [],
      stats: {},
    })
    h.buildKnowledgeContext.mockImplementation(async (_c: string, onHits?: (n: number) => void) => {
      onHits?.(0)
      return ''
    })
    h.collectCommitDiffs.mockResolvedValue(null)
    h.gitCommit.mockReturnValue(null)
    vi.mocked(ensureAgentWorktree).mockReturnValue(null)
    h.chatStream.mockImplementation(async function* () {
      yield { content: '收到', kind: 'text' }
    })
    createEngine = createExecutionEngine(createFakeBus())
  })

  afterEach(() => {
    resetDb()
  })

  it('A1 · 抛了非 Error 且取不出信息 ⇒ 落取值词（不谎报成「没抛」）', async () => {
    // `messageOf({})` 恒 undefined（`String` 给 `'[object Object]'`、JSON 给 `'{}'`，
    // 两条零信息判据都命中）——此刻帧**确实抛了**。若沿用「槽位在返回后仍 busy」那个词，
    // 就是把「真抛」说成「没抛」，与旧词 `'execute crash'` 同型的谎报，故 R7 分流。
    noticeThrow = {}
    insertUserMessage('msg-r6-a1')

    await createEngine.execute(cmd('msg-r6-a1', 'trace-r6-a1', A3))

    const row = logOf('msg-r6-a1')
    expect(row.status).toBe('failed')
    expect(row.error_message).toBe(NO_MESSAGE_LITERAL)
    expect(row.error_message).not.toBe(SLOT_BUSY_LITERAL)
    expect(row.error_message).not.toBe(LEGACY_LITERAL)
    // 伴生日志佐证「确实走了 catch」（抛的确实是那个取不出信息的对象）
    const crashLog = h.logError.mock.calls.find((c) => c[0] === 'execute crashed')
    expect(crashLog).toBeTruthy()
    expect(crashLog?.[1]?.error).toBeUndefined()
  })

  it('A2 · execError 有值时逐字落库（`??` 左值通路零回归）', async () => {
    // 通路构造：`:500` 的无 key 分支在 `executeOneAgent` 的内层 try（`:544`）**之外**
    // ⇒ 该分支里 `emitSystemNotice` 抛错会逃到 `executeRun` 的 catch（execError 有值）
    // ⇒ finally 落 `messageOf(execError)`。这是本行唯一能拿到「左值非空」的可达入口。
    noticeThrow = new Error('x')
    insertUserMessage('msg-r6-a2')

    await createEngine.execute(cmd('msg-r6-a2', 'trace-r6-a2', A3))

    const row = logOf('msg-r6-a2')
    expect(row.status).toBe('failed')
    expect(row.error_message).toBe('x') // 逐字一致（票面 A2）
    expect(row.error_message).not.toBe(SLOT_BUSY_LITERAL)
    expect(row.error_message).not.toBe(LEGACY_LITERAL)

    // 伴生日志佐证「确实走了 catch」：execError 有值这条路真的被点亮了
    const crashLog = h.logError.mock.calls.find((c) => c[0] === 'execute crashed')
    expect(crashLog?.[1]?.error).toBe('x')
  })

  it('A2b · 同一只猫正常回复路径零回归（不落任何兜底词）', async () => {
    insertUserMessage('msg-r6-clean')
    await createEngine.execute(cmd('msg-r6-clean', 'trace-r6-clean'))

    const row = logOf('msg-r6-clean')
    expect(row.status).toBe('completed')
    expect(row.error_message).toBeNull()
  })
})
