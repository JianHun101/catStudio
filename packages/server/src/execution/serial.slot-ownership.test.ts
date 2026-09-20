/**
 * serial.ts `executeRun` finally 槽位**归属校验**测试 — R7（除根：R6 §A 追因产物）。
 *
 * 靶心 = `serial.ts` 「`if (s && s.status === 'busy')`」那道闸——R6 前它见 busy 就收，
 * **不校验这个 busy 槽位是不是本帧的**。竞态链（逐环有行号，R7 票面 §1.1）：
 *
 *   ① 本帧正常路径已自收口（`:806` finalizeRun ⇒ 槽位 idle）；
 *   ② 本帧仍挂在 `:1093` 的 `Promise.all([drainP, dispatchP])` 上（A2A 子树还在跑）；
 *   ③ 该 await 窗口内新触发走 `:1772` 决策段见 idle ⇒ 标 busy 开跑；
 *   ④ 本帧 await 结束 → return → finally 见 busy —— **那是别人的槽位**。
 *
 * 危害不是「诊断难看」，是**把正在跑的那笔收口掉**：误标 idle + 误写 `failed` 行 +
 * 误弹队列 ⇒ 单槽位 FIFO 被击穿，同 agent+session 双执行。
 *
 * 本文件两条判据互为正反面，缺一不可（R7 票面 §2.2 B1/B2）：
 * - **B1**（本文件）：窗口内他人接管 ⇒ 本帧 finally **不得**收口；
 * - **B2**（本文件）：本帧真抛且槽位仍是自己的 ⇒ 仍**兜底收口**（`finally` 的原意，
 *   不得因加校验而卡死）。
 *
 * 边界与 `serial.crash-diagnostic.test.ts` / `serial.crash-label.test.ts` 同款：
 * 真实 SQLite（`createTestDb()` + `initDb()`）+ 真实 dispatch，只 mock 最外层
 * （LLM registry / git / summarizer / memory / handoff / diff / 信号表 / logger）。
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

/** 退役的旧兜底词（R6 前）：误收口把它当「崩溃」落库，本票起新代码路径不得再落 */
const LEGACY_LITERAL = 'execute crash'
/** 归属校验命中时的 warn 日志名（`serial.ts` finally 段）——判「跳过收口」的观测点 */
const SKIP_LOG = 'slot busy but owned by another trigger — finalize skipped'

const h = vi.hoisted(() => ({
  logWarn: vi.fn(),
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
    warn: h.logWarn,
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
  isA2aMemoryEnabled: vi.fn(() => false),
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

// ═══ 假 bus ═══

const notices: SystemNoticePayload[] = []
/** 非 null 时 `emitSystemNotice` 抛出该值（B2 用它把异常送进 `executeRun` 的 catch） */
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
/** 无可用 key 的猫（`agentHasUsableApiKey` 判否 ⇒ 走 `:500` 分支，B2 的入口） */
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

let createEngine: ExecutionEngine

describe('R7 · executeRun finally 归属校验：本帧无权收他人的口', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    notices.length = 0
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

  it('B1 · 本帧 await 窗口内他人接管槽位 ⇒ 本帧 finally 不得收口（B3 真空性反对照的红点）', async () => {
    const childGate = gate() // 撑开 frame#1 的 dispatchP（A2 子链）
    const victimGate = gate() // 让 frame#1 收尾时 A1 槽位仍 busy（接管者还没跑完）

    let call = 0
    h.chatStream.mockImplementation(async function* () {
      call += 1
      if (call === 1) {
        // frame#1：A1 的回复 @ 吐槽猫 ⇒ dispatchP 挂住 frame#1
        yield { content: '我先把这条转给吐槽猫。\n\n@吐槽猫 请看这条', kind: 'text' }
        return
      }
      if (call === 2) {
        // A2 子链：被闸门扣住 ⇒ frame#1 一直挂在 :1093 的 Promise.all 上
        await childGate.promise
        yield { content: '收到', kind: 'text' }
        return
      }
      // call >= 3：窗口内抢下槽位的那笔执行（B1 里的「他人」）
      await victimGate.promise
      yield { content: '收到', kind: 'text' }
    })

    insertUserMessage('msg-r7-first')
    const frame1 = createEngine.execute(cmd('msg-r7-first', 'trace-r7-first'))

    // frame#1 在 :806 收口后槽位已 idle，但本帧仍等 A2 子链——这就是生产窗口
    await waitFor(() => call >= 2 && slotStatus() === 'idle', 'A1 槽位 idle 且 A2 子链已启动')
    expect(slotStatus()).toBe('idle') // 判据前置：窗口真的开着

    insertUserMessage('msg-r7-second')
    const frame2 = createEngine.execute(cmd('msg-r7-second', 'trace-r7-second'))
    await waitFor(() => call >= 3 && slotStatus() === 'busy', 'A1 第二笔执行接管槽位')

    childGate.open() // frame#1 的 dispatchP 落地 ⇒ executeOneAgent 返回 ⇒ 进 finally
    await frame1

    // ── B1 三条判据 ──
    // ① 接管者仍在跑（本帧没有把它掐掉）
    expect(call).toBe(3)
    // ② 槽位仍 busy——没被本帧误标 idle（FIFO 保证没被击穿）
    expect(slotStatus()).toBe('busy')
    // ③ 接管者的执行行没被写成 failed（这才是危害面：误收口把 failed 写到别人的行上）
    const victimRow = logOf('msg-r7-second')
    expect(victimRow.status).toBe('running')
    expect(victimRow.error_message).toBeNull()
    // 判别力锚：R7 前这一行是 failed / 旧词（B3 回退校验后红在这里）
    expect(victimRow.status).not.toBe('failed')
    expect(victimRow.error_message).not.toBe(LEGACY_LITERAL)

    // 跳过有留痕（不静默），且两侧 trigger 都记下来了——排障要知道「谁抢了谁的」
    const skip = h.logWarn.mock.calls.find((c) => c[0] === SKIP_LOG)
    expect(skip).toBeTruthy()
    expect(skip?.[1]?.slotOwnerTriggerMessageId).toBe('msg-r7-second')
    expect(skip?.[1]?.thisTriggerMessageId).toBe('msg-r7-first')
    // 没有走过收口 ⇒ 不该有 'execution failed' 落库留痕
    expect(h.logError.mock.calls.find((c) => c[0] === 'execution failed')).toBeUndefined()

    victimGate.open()
    await frame2.catch(() => undefined)
  })

  it('B2 · 本帧真抛且槽位仍是自己的 ⇒ 仍兜底收口（加校验不许把槽位卡死）', async () => {
    // 通路构造：`:500` 的无 key 分支在 `executeOneAgent` 的内层 try（`:544`）**之外**
    // ⇒ 该分支里 `emitSystemNotice` 抛错会逃到 `executeRun` 的 catch。此刻槽位未被
    // 任何收口触碰过 ⇒ `currentTriggerMessageId` 仍是本帧的 ⇒ 归属校验必须放行。
    noticeThrow = new Error('boom-b2')
    insertUserMessage('msg-r7-b2')

    await createEngine.execute(cmd('msg-r7-b2', 'trace-r7-b2', A3))

    const row = logOf('msg-r7-b2')
    expect(row.status).toBe('failed')
    expect(row.error_message).toBe('boom-b2')
    // 兜底真的兑现了：槽位复位，没卡在 busy（finally 存在的原意）
    expect(slotStatus(A3)).toBe('idle')
    expect(h.logWarn.mock.calls.find((c) => c[0] === SKIP_LOG)).toBeUndefined()
  })
})
