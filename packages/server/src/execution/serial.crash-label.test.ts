/**
 * serial.ts `executeRun` finally 兜底词测试 — R6 §A（OQ-1：给谎报的标签正名）。
 *
 * 靶心 = `serial.ts:1735`（R6 改点）那行 `messageOf(execError) ?? '<兜底词>'`：
 *
 * - 旧词 `'execute crash'` 同时背负**两种互斥情形**——「真崩」与「没崩、只是槽位
 *   在收口后被别的执行接管了」。全库 19 行 `error_message = 'execute crash'` 里，
 *   `execError` 恒为 undefined（`executeRun` 的 catch 伴生日志 0 条）⇒ 19 行
 *   **没有一行是崩溃**，正名即修谎报。
 * - 本文件把「没崩但那行确实落过兜底词」这条路径**经公开 API 稳定复现**：
 *   frame#1 在 `:805` 收口后槽位 idle，本帧仍挂在 A2A `dispatchP` 上；窗口内新触发
 *   抢下槽位（生产同形：猫还在跑 A2A 子树，用户又发了一条）；frame#1 返回 → 进
 *   finally → `s.status === 'busy'`（**别人的**槽位）→ 落兜底词。
 *
 * 两条通路必须能分开（本文件的存在理由）：
 * - `execError === undefined`（A1）= 没崩，槽位是别人的 ⇒ 新词；
 * - `execError` 有值（A2）= 本帧真的抛了 ⇒ `messageOf(execError)` 逐字原样。
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

/** 正名后的兜底词（`serial.ts` 改点）——两处引用同一字面量，避免测试内自相矛盾 */
const SLOT_BUSY_LITERAL = 'slot busy after executeOneAgent returned'
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

/** 一次性闸门：撑开并发窗口，让「谁先谁后」由测试显式决定 */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>((r) => {
    open = r
  })
  return { promise, open }
}

/** 真实计时器轮询（执行链全是真 promise + 真 await，不上 fake timers） */
async function waitFor(pred: () => boolean, label: string, ticks = 500): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 0))
  }
  throw new Error(`waitFor 超时：${label}`)
}

const slotStatus = (agentId = A1): string | undefined =>
  createEngine.getSlot(agentId, 'session-1')?.status

/** 本文件所有用例共用一个 engine 实例的槽位视图——`beforeEach` 里重建 */
let createEngine: ExecutionEngine

describe('R6 §A · executeRun finally 兜底词：没崩不许说崩', () => {
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

  it('A1 · executeOneAgent 正常返回但槽位已被新执行接管 ⇒ 落新词', async () => {
    const childGate = gate() // 撑开 frame#1 的 dispatchP（A2 子链）
    const nextGate = gate() // 让 frame#1 收尾时 A1 槽位仍 busy（新执行还没跑完）

    let call = 0
    h.chatStream.mockImplementation(async function* () {
      call += 1
      if (call === 1) {
        // frame#1：A1 的回复 @ 吐槽猫 ⇒ dispatchP 挂住 frame#1
        yield { content: '我先把这条转给吐槽猫。\n\n@吐槽猫 请看这条', kind: 'text' }
        return
      }
      if (call === 2) {
        // A2 子链：被闸门扣住 ⇒ frame#1 一直挂在 :1092 的 Promise.all 上
        await childGate.promise
        yield { content: '收到', kind: 'text' }
        return
      }
      // call >= 3：窗口内抢下槽位的那笔执行
      await nextGate.promise
      yield { content: '收到', kind: 'text' }
    })

    insertUserMessage('msg-r6-first')
    const frame1 = createEngine.execute(cmd('msg-r6-first', 'trace-r6-first'))

    // frame#1 在 :805 收口后槽位已 idle，但本帧仍等 A2 子链——这就是生产窗口
    await waitFor(() => call >= 2 && slotStatus() === 'idle', 'A1 槽位 idle 且 A2 子链已启动')
    expect(slotStatus()).toBe('idle') // 判据前置：窗口真的开着

    insertUserMessage('msg-r6-second')
    const frame2 = createEngine.execute(cmd('msg-r6-second', 'trace-r6-second'))
    await waitFor(() => call >= 3 && slotStatus() === 'busy', 'A1 第二笔执行接管槽位')

    childGate.open() // frame#1 的 dispatchP 落地 ⇒ executeOneAgent 返回 ⇒ 进 finally
    await frame1

    // 危害面（A-2 追因的核心结论）：兜底收口释放的是**别人的**槽位——受害执行
    // （msg-r6-second）此刻仍在跑（nextGate 未开），槽位却已 idle ⇒ 单槽位 FIFO
    // 保证被击穿，下一笔触发可与它并发（同一 agent+session 双执行）。
    expect(call).toBe(3)
    expect(slotStatus()).toBe('idle')

    const row = logOf('msg-r6-second')
    expect(row.status).toBe('failed')
    expect(row.error_message).toBe(SLOT_BUSY_LITERAL)
    // 判别力锚：改点前该列是旧词（「谎报成崩溃」正是本票要拆掉的那一层）
    expect(row.error_message).not.toBe(LEGACY_LITERAL)
    // 存量 19 行同款签名：兜底路径不传 latency / reply id（这两列必为 NULL）
    expect(row.latency_ms).toBeNull()
    expect(row.message_id).toBeNull()

    nextGate.open()
    await frame2.catch(() => undefined)
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
    const crashLog = h.logError.mock.calls.find(
      (c) => c[0] === 'execute crashed — releasing slot in finally'
    )
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
