/**
 * serial.ts × R2 段五**引擎接线面**测试（票 §九 的 2 / 4 / 6 / 7 / 9 / 10 / 12 /
 * 13 / 14 / 19 / 23 / 24 / 25 / 26）。
 *
 * 与 `serial.test.ts` 的边界差异（**就是本文件独立存在的原因**）：本文件的库是
 * `createTestDb()` + **`initDb()`** 造出来的「完整迁移后的库」——R2 两表真在。
 * `serial.test.ts` 的夹具不跑 `initDb()`（它测的是调度配对，段表不需要），
 * 把那 159 个用例的 DB 环境整体换掉是拿无关风险换方便。
 * 采集器自身行为在 `execution/trace.test.ts`；落库面在 `db/repository/spans.test.ts`。
 *
 * 其余边界（LLM registry / git / summarizer / handoff / memory / diff / 信号表）
 * 一律 mock——它们与「段落在哪、时长对不对」无关。
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

// ═══ 边界 mock（真实 dispatch / SQLite / 采集器 / 写口保留） ═══

const h = vi.hoisted(() => ({
  logWarn: vi.fn(),
  gitCommit: vi.fn(),
  collectCommitDiffs: vi.fn(),
  retrieveMemoryContext: vi.fn(),
  buildKnowledgeContext: vi.fn(),
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
  // T-2 Phase I：提交作用域解析改为按角色分派（store → 会话 worktree / 其余 → 猫
  // worktree）。**替身必须镜像真模块被消费的导出面**——漏键 ⇒ 消费方拿到 undefined、
  // 调用即 TypeError（与上面 cleanGitEnv 那条同款，实测踩过）。默认 null ⇒ 不提交。
  ensureAgentWorktree: vi.fn(() => null),
  snapshotPackageDeps: vi.fn(() => []),
  diffNewPackages: vi.fn(() => []),
  // T-1 Phase 2：serial.ts 清理段改带 `cleanGitEnv()`（与 gitCommit 对称）。
  // 本工厂是**部分导出**——漏键 ⇒ serial.ts 拿到 undefined、调用即 TypeError，
  // 而清理段自带 `catch {}` 会把它静默吞掉（表现为「清理莫名没跑」）。
  cleanGitEnv: vi.fn(() => ({ ...process.env })),
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
const A2 = agent('agent-2', 'flash猫')
const A3 = agent('agent-3', 'ds猫')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor 超时：${label}`)
    await sleep(4)
  }
}

/** 完整配对链：落库触发消息 → 引擎执行（与 serial.test.ts 的 runPaired 同形） */
async function runRound(
  engine: ExecutionEngine & ExecutionEngineTestHooks,
  triggerId: string,
  traceId: string,
  opts?: { agents?: AgentConfig[]; taskId?: string; depth?: number }
): Promise<boolean> {
  getDb()
    .prepare(
      `INSERT INTO messages (id, session_id, role, content, mentions, task_id)
       VALUES (?, 'session-1', 'user', '你好', '[]', ?)`
    )
    .run(triggerId, opts?.taskId ?? null)
  return engine.executeAgentsSerial(
    'session-1',
    opts?.agents ?? [A1],
    {
      fromAgent: false,
      id: triggerId,
      content: '你好',
      mentions: [],
      ...(opts?.taskId ? { taskId: opts.taskId } : {}),
    },
    traceId,
    opts?.depth ?? 0
  )
}

const logOf = (triggerId: string): any =>
  getDb().prepare('SELECT * FROM execution_logs WHERE triggered_by_message_id = ?').get(triggerId)

const spanNames = (executionId: string): string[] =>
  spansRepo.getSpansByExecution(executionId).map((r) => r.name)

const spanByName = (executionId: string, name: string): any =>
  spansRepo.getSpansByExecution(executionId).find((r) => r.name === name)

describe('serial × R2 段五（引擎接线面）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __test_reset()
    const db = createTestDb()
    setDb(db)
    initDb() // ← 本文件与 serial.test.ts 的边界差异：完整迁移后的库（R2 两表真在）
    initRepository(db)
    db.prepare(
      `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
       VALUES ('agent-1', '店长', '🐱', 'p', 'deepseek', 'deepseek-v4-pro', 'sk-test'),
              ('agent-2', 'flash猫', '🐱', 'p', 'deepseek', 'deepseek-v4-pro', 'sk-test'),
              ('agent-3', 'ds猫', '🐱', 'p', 'deepseek', 'deepseek-v4-pro', 'sk-test')`
    ).run()
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
    // 替身必须镜像真模块的**回调契约**：真 `buildKnowledgeContext` 每条出口都报命中数，
    // 漏报会被判成 `status='error'`（那是有意的 fail-loud——契约破了要看得见）
    h.buildKnowledgeContext.mockImplementation(async (_c: string, onHits?: (n: number) => void) => {
      onHits?.(0)
      return ''
    })
    h.collectCommitDiffs.mockResolvedValue(null)
    h.gitCommit.mockReturnValue(null)
    // T-1 Phase 2：① 的提交作用域只认 `ensureSessionWorktree`。默认置 null（= 无 worktree
    // ⇒ 不提交），需要「真有 commit」的用例自行覆盖——与 `h.gitCommit` 同款「每用例显式
    // 置默认」：`clearAllMocks` 清调用**不清实现**，上个用例的实现会残留到本用例
    vi.mocked(ensureAgentWorktree).mockReturnValue(null)
    h.chatStream.mockImplementation(async function* () {
      yield { content: '收到', kind: 'text' }
    })
  })

  afterEach(() => {
    resetDb()
  })

  // ─── 验收 14 / 2 / 13 / 25：一次正常执行的完整时间轴 ────
  it('验收 14 · 一次正常执行至少产出 invoke_agent + token_wait + assemble + memory + llm.chat 五行', async () => {
    const engine = createExecutionEngine(createFakeBus())
    await runRound(engine, 'msg-1', 'trace-1')

    const names = spanNames(logOf('msg-1').id)
    for (const n of [
      'invoke_agent',
      'dispatch.token_wait',
      'context.assemble',
      'memory.retrieval',
      'llm.chat',
    ]) {
      expect(names).toContain(n)
    }
    // 空闲直跑（没进过队列）⇒ **没有** queue_wait——不是漏采，是它压根没排队
    expect(names).not.toContain('dispatch.queue_wait')
  })

  it('验收 2 · 恰一个 `parent_span_id IS NULL`，其余 parent 均指向本次执行内的 span', async () => {
    const engine = createExecutionEngine(createFakeBus())
    await runRound(engine, 'msg-1', 'trace-1')

    const rows = spansRepo.getSpansByExecution(logOf('msg-1').id)
    const roots = rows.filter((r) => r.parent_span_id === null)
    expect(roots).toHaveLength(1)
    expect(roots[0].name).toBe('invoke_agent')
    const ids = new Set(rows.map((r) => r.span_id))
    for (const r of rows) {
      if (r.parent_span_id !== null) expect(ids.has(r.parent_span_id)).toBe(true)
    }
  })

  it('验收 13 · §4.4 那条 SQL 原样跑通，按 `start_at` 升序出全段时间轴', async () => {
    const engine = createExecutionEngine(createFakeBus())
    await runRound(engine, 'msg-1', 'trace-1')
    const executionId = logOf('msg-1').id

    const rows = getDb()
      .prepare(
        `SELECT s.name, s.start_at, s.duration_ms, s.status,
                (SELECT COUNT(*) FROM retrieval_events r WHERE r.execution_id = s.execution_id) AS has_detail
         FROM spans s WHERE s.execution_id = ? ORDER BY s.start_at`
      )
      .all(executionId) as Array<{ name: string; start_at: string; status: string }>

    expect(rows.length).toBeGreaterThanOrEqual(5)
    expect(rows.map((r) => r.start_at)).toEqual([...rows.map((r) => r.start_at)].sort())
    expect(rows[0].name).toBe('invoke_agent') // 根段先起
    for (const r of rows) expect(r.status).toBe('ok')
  })

  it('验收 25 · `reply.persist` 有行且 `duration_ms >= 0`', async () => {
    const engine = createExecutionEngine(createFakeBus())
    await runRound(engine, 'msg-1', 'trace-1')
    const row = spanByName(logOf('msg-1').id, 'reply.persist')
    expect(row).toBeTruthy()
    expect(row.duration_ms).toBeGreaterThanOrEqual(0)
  })

  // ─── 验收 9：链锚 ─────────────────────────────────────
  it('验收 9 · `chain_id` == 该执行的链锚（触发消息带 task_id 时取它）', async () => {
    const engine = createExecutionEngine(createFakeBus())
    await runRound(engine, 'msg-1', 'trace-1', { taskId: 'task-123' })
    for (const r of spansRepo.getSpansByExecution(logOf('msg-1').id)) {
      expect(r.chain_id).toBe('task-123')
    }
  })

  it('验收 9 · 触发消息无锚 ⇒ 链锚退到本轮 traceId（与回复侧 `|| traceId` 同构）', async () => {
    const engine = createExecutionEngine(createFakeBus())
    await runRound(engine, 'msg-1', 'trace-fallback')
    for (const r of spansRepo.getSpansByExecution(logOf('msg-1').id)) {
      expect(r.chain_id).toBe('trace-fallback')
    }
  })

  // ─── 验收 10：与 retrieval_events 同源同值 ──────────────
  it('验收 10 · `memory.retrieval`.duration_ms == 同行 retrieval_events.retrieval_ms', async () => {
    h.retrieveMemoryContext.mockResolvedValue({
      text: '\n\n【相关记忆】\n1. 正文',
      reason: 'ok',
      sections: [],
      stats: {
        queries: 1,
        candidateChunks: 1,
        sections: 2,
        droppedSections: 0,
        contextTokens: 12,
        budgetTokens: 8000,
        truncated: false,
        retrievalMs: 37,
        thresholdMaxDistance: 0.6,
        paramTopK: 3,
        paramProbeN: 20,
        queryTraces: [],
        candidates: [],
        blockedByStatus: 0,
        droppedByThreshold: 0,
      },
    })
    const engine = createExecutionEngine(createFakeBus())
    await runRound(engine, 'msg-1', 'trace-1')
    const executionId = logOf('msg-1').id

    const span = spanByName(executionId, 'memory.retrieval')
    const ev = getDb()
      .prepare('SELECT * FROM retrieval_events WHERE execution_id = ?')
      .get(executionId) as any
    expect(ev).toBeTruthy()
    // **同源同一变量**（§4.5 双写）：两侧都取内测值 37，不是各自的墙钟
    expect(ev.retrieval_ms).toBe(37)
    expect(span.duration_ms).toBe(37)
    expect(span.item_count).toBe(2)
  })

  // ─── 验收 12：知识库命中数 ─────────────────────────────
  it('验收 12 · `knowledge.retrieval`.item_count == 实际命中数', async () => {
    h.buildKnowledgeContext.mockImplementation(async (_c: string, onHits?: (n: number) => void) => {
      onHits?.(3)
      return '\n\n【知识库】\n1. a\n2. b\n3. c'
    })
    const engine = createExecutionEngine(createFakeBus())
    await runRound(engine, 'msg-1', 'trace-1')

    const row = spanByName(logOf('msg-1').id, 'knowledge.retrieval')
    expect(row.item_count).toBe(3)
    expect(row.status).toBe('ok')
  })

  it('验收 12 · 空手而归 ⇒ `item_count = 0`（不是 NULL——分得出「没命中」与「没跑」）', async () => {
    h.buildKnowledgeContext.mockImplementation(async (_c: string, onHits?: (n: number) => void) => {
      onHits?.(0)
      return ''
    })
    const engine = createExecutionEngine(createFakeBus())
    await runRound(engine, 'msg-1', 'trace-1')

    const row = spanByName(logOf('msg-1').id, 'knowledge.retrieval')
    expect(row.item_count).toBe(0)
    expect(row.status).toBe('ok')
  })

  // ─── 验收 6：排队段在排队路径上有行 ────────────────────
  it('验收 6 · `dispatch.queue_wait` 在排队路径上有行且 `duration_ms > 0`', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    h.chatStream.mockImplementation(async function* () {
      yield { content: '收到', kind: 'text' }
      await gate
    })
    const engine = createExecutionEngine(createFakeBus())

    const p1 = runRound(engine, 'msg-1', 'trace-1')
    await waitFor(() => engine.getSlot('agent-1', 'session-1')?.status === 'busy', '槽位忙')
    const p2 = runRound(engine, 'msg-2', 'trace-2')
    await waitFor(
      () => (engine.getSlot('agent-1', 'session-1')?.queueLength ?? 0) === 1,
      'msg-2 入队'
    )
    await sleep(12) // 让「在队列里等」这件事真的发生一段时间
    release()
    await Promise.all([p1, p2])

    const queued = spanByName(logOf('msg-2').id, 'dispatch.queue_wait')
    expect(queued).toBeTruthy()
    expect(queued.duration_ms).toBeGreaterThan(0)
    // 直跑的那次没有这一段
    expect(spanByName(logOf('msg-1').id, 'dispatch.queue_wait')).toBeUndefined()
  })

  // ─── 验收 7：token 池等待 ─────────────────────────────
  it('验收 7 · 池满时 `dispatch.token_wait.duration_ms > 0`；池空时仍写行（可为 0）', async () => {
    const savedCap = process.env.PROVIDER_TOKEN_CAP
    process.env.PROVIDER_TOKEN_CAP = '1' // 池容量 1：同 provider 两只猫并发 ⇒ 后者必等
    try {
      h.chatStream.mockImplementation(async function* () {
        yield { content: '收到', kind: 'text' }
        await sleep(40)
      })
      const engine = createExecutionEngine(createFakeBus())
      await runRound(engine, 'msg-1', 'trace-1', { agents: [A1, A2] })

      const waited = [logOf('msg-1')].length // 触发消息一条，执行行两条
      expect(waited).toBe(1)
      const rows = getDb()
        .prepare('SELECT * FROM execution_logs WHERE triggered_by_message_id = ?')
        .all('msg-1') as any[]
      expect(rows).toHaveLength(2)

      const waits = rows.map((r) => spanByName(r.id, 'dispatch.token_wait'))
      for (const w of waits) expect(w).toBeTruthy() // 池空那趟也留行
      // 恰好一趟真等了（cap=1 下单批两只猫必然排队），且时长 > 0
      const maxWait = Math.max(...waits.map((w) => w.duration_ms))
      expect(maxWait).toBeGreaterThan(0)
      expect(waits.filter((w) => w.duration_ms === 0).length).toBe(1)
    } finally {
      if (savedCap === undefined) delete process.env.PROVIDER_TOKEN_CAP
      else process.env.PROVIDER_TOKEN_CAP = savedCap
    }
  })

  // ─── 验收 19：并发批内三个执行体互不串台 ────────────────
  it('验收 19 · 并发批内 3 个执行体各持一个采集器，三者的 span 互不串台', async () => {
    h.chatStream.mockImplementation(async function* () {
      yield { content: '收到', kind: 'text' }
      await sleep(8)
    })
    const engine = createExecutionEngine(createFakeBus())
    await runRound(engine, 'msg-1', 'trace-1', { agents: [A1, A2, A3] })

    const logs = getDb()
      .prepare('SELECT * FROM execution_logs WHERE triggered_by_message_id = ?')
      .all('msg-1') as any[]
    expect(logs).toHaveLength(3)

    for (const l of logs) {
      const rows = spansRepo.getSpansByExecution(l.id)
      expect(rows.length).toBeGreaterThanOrEqual(5)
      const rootId = spansRepo.getRootSpanId(l.id)!
      const ids = new Set(rows.map((r) => r.span_id))
      for (const r of rows) {
        expect(r.agent_id).toBe(l.agent_id) // 身份面自持，没串到别只猫
        if (r.span_id !== rootId) expect(r.parent_span_id).toBe(rootId)
      }
      expect(ids.has(rootId)).toBe(true)
    }
    // 三个 execution_id 各成一段完整时间轴，无一行落在别人的执行下
    expect(new Set(logs.map((l) => l.id)).size).toBe(3)
  })

  // ─── 验收 23：压缩/截断段 ─────────────────────────────
  it('验收 23 · 走压缩/软截断路径时 `context.compress` 有行，且 item_count 反映截断后条数', async () => {
    // 塞 10 条长消息（每条 200 汉字 ≈ 350 token），再把上下文预算压到 1600
    // ⇒ 必走软截断（`preTruncationTokens` ≈ 3500 仍低于 SUMMARY_MIN_TOKENS=8000，
    // 故只走截断分支、不触碰摘要生成）
    const db = getDb()
    const ins = db.prepare(
      `INSERT INTO messages (id, session_id, role, content, mentions, created_at)
       VALUES (?, 'session-1', 'user', ?, '[]', datetime('now', ?))`
    )
    for (let i = 0; i < 10; i++) ins.run(`seed-${i}`, '汉'.repeat(200), `-${100 - i} seconds`)

    const saved = process.env.MAX_CONTEXT_TOKENS
    process.env.MAX_CONTEXT_TOKENS = '1600'
    try {
      const engine = createExecutionEngine(createFakeBus())
      await runRound(engine, 'msg-1', 'trace-1')

      const executionId = logOf('msg-1').id
      const assemble = spanByName(executionId, 'context.assemble')
      const compress = spanByName(executionId, 'context.compress')
      expect(compress).toBeTruthy()
      expect(assemble.item_count).toBeGreaterThan(compress.item_count) // 截断真发生了
      expect(compress.item_count).toBeGreaterThan(0)
    } finally {
      if (saved === undefined) delete process.env.MAX_CONTEXT_TOKENS
      else process.env.MAX_CONTEXT_TOKENS = saved
    }
  })

  // ─── 验收 24：diff 采集段（含 5s 超时路径）──────────────
  it('验收 24 · `diff.collect` 有行；有 diff 时 status=ok 且 item_count=块数', async () => {
    h.collectCommitDiffs.mockResolvedValue([{ id: 'diff-1', kind: 'diff', v: 1 }])
    const engine = createExecutionEngine(createFakeBus())
    await runRound(engine, 'msg-1', 'trace-1')

    const row = spanByName(logOf('msg-1').id, 'diff.collect')
    expect(row).toBeTruthy()
    expect(row.status).toBe('ok')
    expect(row.item_count).toBe(1)
  })

  it('验收 24 · 跑满 5s（GIT_TIMEOUT_MS）⇒ status=timeout（真墙钟，不是改小常量的自证）', async () => {
    // `collectCommitDiffs` 内部吞掉超时并返回 null ⇒ 外部只能靠「本段跑满」判据。
    // 这里让假采集器真等满 5000ms，验证的就是**判据本身**。
    h.collectCommitDiffs.mockImplementation(async () => {
      await sleep(5100)
      return null
    })
    const engine = createExecutionEngine(createFakeBus())
    await runRound(engine, 'msg-1', 'trace-1')

    const row = spanByName(logOf('msg-1').id, 'diff.collect')
    expect(row.status).toBe('timeout')
    expect(row.duration_ms).toBeGreaterThanOrEqual(5000)
  }, 20000)

  // ─── 验收 26：轮次自动提交段 ──────────────────────────
  it('验收 26 · 有 commit ⇒ `git.auto_commit` 有行（挂在本次执行的根段下）', async () => {
    // T-1 Phase 2：① 只在 `ensureSessionWorktree` 给出路径时才提交（不再有「无 cwd 兜底」）
    vi.mocked(ensureAgentWorktree).mockReturnValue('/tmp/catStudy-sessions/wt-spans')
    h.gitCommit.mockReturnValue('abc1234')
    const engine = createExecutionEngine(createFakeBus())
    await runRound(engine, 'msg-1', 'trace-1')

    const executionId = logOf('msg-1').id
    const rootId = spansRepo.getRootSpanId(executionId)!
    const commit = spanByName(executionId, 'git.auto_commit')
    expect(commit).toBeTruthy()
    expect(commit.parent_span_id).toBe(rootId)
    expect(commit.chain_id).toBe('trace-1')
    expect(commit.agent_id).toBe('agent-1')
    // 补记的段没有造出第二个根
    expect(
      spansRepo.getSpansByExecution(executionId).filter((r) => r.parent_span_id === null)
    ).toHaveLength(1)
  })

  it('验收 26 · 无改动（gitCommit 返回 null）⇒ 该段可缺（缺 ≠ 失败）', async () => {
    h.gitCommit.mockReturnValue(null)
    const engine = createExecutionEngine(createFakeBus())
    await runRound(engine, 'msg-1', 'trace-1')
    expect(spanByName(logOf('msg-1').id, 'git.auto_commit')).toBeUndefined()
    expect(logOf('msg-1').status).toBe('completed') // 缺段不影响执行结局
  })

  // ─── 验收 4：写库失败绝不抛（引擎层）────────────────────
  it('验收 4 · 段表整个不可用 ⇒ 执行仍成功收尾、槽位仍释放（写库失败绝不抛）', async () => {
    getDb().exec('DROP TABLE span_llm; DROP TABLE spans')
    const engine = createExecutionEngine(createFakeBus())
    await runRound(engine, 'msg-1', 'trace-1')

    expect(logOf('msg-1').status).toBe('completed')
    expect(engine.getSlot('agent-1', 'session-1')).toMatchObject({ status: 'idle' })
    // 留痕（不静默）：写失败走 logger.warn
    expect(h.logWarn).toHaveBeenCalled()
  })

  // ─── 根段状态随执行结局 ────────────────────────────────
  it('执行失败 ⇒ 根段 status=error + error_message（失败漏斗不丢时间轴）', async () => {
    h.chatStream.mockImplementation(async function* () {
      throw new Error('boom: 上游 402')
    })
    const engine = createExecutionEngine(createFakeBus())
    await runRound(engine, 'msg-1', 'trace-1')

    expect(logOf('msg-1').status).toBe('failed')
    const root = spanByName(logOf('msg-1').id, 'invoke_agent')
    expect(root.status).toBe('error')
    expect(root.error_message).toContain('boom')
  })
})
