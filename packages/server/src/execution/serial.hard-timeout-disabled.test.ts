/**
 * serial.ts 硬超时**可禁用**契约测试（`AGENT_HARD_TIMEOUT_MS <= 0`）。
 *
 * 靶心 = 文档两处承诺「毫秒，设为 0 禁用」（`.env.example` 层级 2 / `serial.ts` 层级 2
 * 注释），实现却是「设为 0 ⇒ 下一宏任务 abort」：旧解析
 * `parseInt(process.env.AGENT_HARD_TIMEOUT_MS || '')` 只挡 NaN，`0` / 负数**原样**进
 * `setTimeout`，整条执行链当场被关掉，且 abort reason 标成 `timeout` ⇒ 排障的人顺着
 * 「超时」往下查，真因是配置。同族的 CLI 空闲超时兑现了这句承诺
 * （`cli-utils.ts:452` / `:538` 的 `<= 0 ⇒ return () => {}`），本值没有。
 *
 * 修复后语义：`<= 0`（0 与负数同义）⇒ 本层禁用、race 不挂超时成员；取值改走
 * `env-number.ts` 唯一入口（坏值 warn + 回退 30min）。
 *
 * ── 为什么整链 `vi.resetModules()` 重载，而不是 `vi.hoisted` 设一次 env ──
 * 该常量**刻意**在模块加载时解析（改成每次现读，会让配错 env 的每次执行都刷一条
 * warn），于是「同一文件里验证 `0` / `-1` / 未设 / 空串 / `abc` 五种取值」只能靠重载
 * 模块图。只 reload `serial.js` 不够：它会拿到一份**新的** `db/index.js` 模块实例，
 * 而测试侧 `setDb()` 打在旧实例上 ⇒ 引擎查不到库（空库假红）。故 test-helpers / db /
 * repository / dispatch / serial 整链一起重载。mock 实例经 `vi.hoisted` 建在模块图
 * **之外**，工厂重跑返回同一批 `vi.fn`（否则 `h.chatStream` 换不到新适配器上）。
 * 生产代码**没有**为可测性开任何口子——env 是唯一入口，本文件只是按需重放加载期。
 *
 * 边界与 `serial.test.ts` 同款：真实 SQLite + 真实 dispatch，只 mock 最外层
 * （LLM registry / git / summarizer / handoff / memory / diff / 信号表 / logger）。
 * 反例对照：`serial.test.ts` 的「硬超时 → reason=timeout」用例走的是**默认 30min**
 * 路径，本文件不碰它——那条绿 = 默认行为未被本改动动过（A1 的另一半）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type {
  AgentConfig,
  Message,
  SystemNoticePayload,
  TypingUpdatePayload,
} from '@cat-study/shared'
import type { ExecutionEngine, ExecutionEngineTestHooks } from './serial.js'
import type { EngineBus, HandoffBus } from './bus.js'

// ═══ mock 实例建在模块图之外（vi.resetModules 不会重建它们）═══

const h = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  chatStream: vi.fn(),
  /** 本文件跑之前进程里该变量的原值——A4 的复位基准（本仓测试环境实测为未设） */
  originalEnv: process.env.AGENT_HARD_TIMEOUT_MS,
}))

vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    // 硬超时落不落日志、以及 envNumber 的坏值 warn，都只在这条通道上可见
    info: h.logInfo,
    warn: h.logWarn,
    error: h.logError,
  }),
  setLogLevel: vi.fn(),
}))

vi.mock('../llm/registry.js', () => ({
  getAdapterForAgent: vi.fn(() => ({ chatStream: h.chatStream })),
}))

vi.mock('../llm/git-utils.js', () => ({
  gitCommit: vi.fn(),
  getSessionWorktreePath: vi.fn(() => null),
  ensureSessionWorktree: vi.fn(() => null),
  ensureAgentWorktree: vi.fn(() => null),
  snapshotPackageDeps: vi.fn(() => ({})),
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
  retrieveMemoryContext: vi.fn().mockResolvedValue({
    text: '',
    reason: 'no-hit',
    sections: [],
    stats: {},
  }),
  buildKnowledgeContext: vi.fn().mockResolvedValue(''),
  currentRetrievalParams: vi.fn(() => ({ topK: 3, maxDistance: 0.6, probeN: 20 })),
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
  collectCommitDiffs: vi.fn().mockResolvedValue(null),
  GIT_TIMEOUT_MS: 5000,
}))

// 顶层收尾的脏文件清理用真实 execSync 会命中真实仓库——恒返回空串（"干净"跳过）
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execSync: vi.fn(() => '') }
})

vi.mock('../eval/sampler.js', () => ({ maybeScoreSample: vi.fn() }))
vi.mock('../llm/route-signals.js', () => ({ consumeRouteSignals: vi.fn(() => []) }))
vi.mock('../llm/user-request-signals.js', () => ({ consumeUserRequestSignals: vi.fn(() => []) }))

// verdict-parser 是**部分工厂**的老踩点（serial.test.ts 第四次踩时改的 importOriginal）：
// 只列 recordReviewVerdict ⇒ serial.ts 拿到的 parseReviewVerdict 是 undefined。
vi.mock('../eval/verdict-parser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../eval/verdict-parser.js')>()
  return { ...actual, recordReviewVerdict: vi.fn() }
})

// ═══ 整链重载 ═══

/**
 * 按指定 env 值重载整条模块链，返回各层句柄。
 *
 * `envValue === undefined` ⇒ **真删除**该变量（不是置空串），覆盖「未设置」这一面。
 */
async function loadStack(envValue: string | undefined) {
  vi.unstubAllEnvs()
  if (envValue === undefined) delete process.env.AGENT_HARD_TIMEOUT_MS
  else vi.stubEnv('AGENT_HARD_TIMEOUT_MS', envValue)

  vi.resetModules()
  return {
    testHelpers: await import('../test-helpers.js'),
    db: await import('../db/index.js'),
    repository: await import('../db/repository/index.js'),
    dispatch: await import('../dispatch/index.js'),
    serial: await import('./serial.js'),
  }
}

type Stack = Awaited<ReturnType<typeof loadStack>>

// ═══ 假 bus ═══

interface BusCalls {
  agentMessages: Message[]
  systemNotices: SystemNoticePayload[]
  typing: TypingUpdatePayload[]
  statuses: string[]
}

function createFakeBus(): { bus: EngineBus & HandoffBus; calls: BusCalls } {
  const calls: BusCalls = { agentMessages: [], systemNotices: [], typing: [], statuses: [] }
  const bus: EngineBus & HandoffBus = {
    emitMessage: (m) => calls.agentMessages.push(m),
    emitSystemNotice: (n) => calls.systemNotices.push(n),
    emitTyping: (u) => calls.typing.push(u),
    emitAgentMessageStatus: (_s, st) => calls.statuses.push(st.status),
    emitMessageUpdated: () => {},
    emitContextWindowStats: () => {},
    emitSessionHandoff: () => {},
    emitHandoffFailed: () => {},
  }
  return { bus, calls }
}

// ═══ 夹具 ═══

const DEFAULT_AGENT: AgentConfig = {
  id: 'agent-1',
  name: '店长',
  avatar: '🐱',
  systemPrompt: 'You are a cat.',
  llmProvider: 'deepseek',
  llmModel: 'deepseek-v4-pro',
  llmApiKey: 'sk-test',
}

interface Run {
  stack: Stack
  engine: ExecutionEngine & ExecutionEngineTestHooks
  calls: BusCalls
  /** race 落定后的引擎返回值（`execute` 单接口的返回值，与 serial.test.ts 同口径） */
  runP: Promise<boolean>
  /** `runP` 是否已落定——「推进 60min 仍未被中断」的判据 */
  settled: () => boolean
  /** 放行挂在流中途的生成器 */
  release: () => void
  logOf: (triggerId: string) => any
}

/**
 * 起一轮「首块已产出、随后挂起」的执行。
 *
 * 挂起形态是必须的：只有执行真的**悬在半途**，「推进 60min 没被掐断」才有意义
 * （若生成器已自然结束，超时 timer 再响也只是打在空气上，用例恒绿）。
 */
async function startGated(
  envValue: string | undefined,
  triggerId: string,
  traceId: string
): Promise<Run> {
  vi.clearAllMocks()
  // 必须在 loadStack 之前 clear：`abc` 用例的 envNumber warn 就发生在模块求值期
  const stack = await loadStack(envValue)

  const db = stack.testHelpers.createTestDb()
  stack.db.setDb(db)
  stack.repository.initRepository(db)
  stack.dispatch.__test_reset()

  db.prepare(
    `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
     VALUES ('agent-1', '店长', '🐱', 'You are a cat.', 'deepseek', 'deepseek-v4-pro', 'sk-test')`
  ).run()
  db.prepare(
    `INSERT INTO sessions (id, title, agent_ids, broadcast_mode)
     VALUES ('session-1', '测试会话', '["agent-1"]', 0)`
  ).run()

  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  h.chatStream.mockImplementation(async function* () {
    yield { content: '部分', kind: 'text' }
    await gate
    yield { content: '后续', kind: 'text' }
  })

  const { bus, calls } = createFakeBus()
  const engine = stack.serial.createExecutionEngine(bus)

  db.prepare(
    `INSERT INTO messages (id, session_id, role, content, mentions)
     VALUES (?, 'session-1', 'user', '你好', '[]')`
  ).run(triggerId)

  let done = false
  const runP = engine.executeAgentsSerial(
    'session-1',
    [DEFAULT_AGENT],
    { fromAgent: false, id: triggerId, content: '你好', mentions: [] },
    traceId,
    0
  )
  // 超时路径下 runP **不 reject**（race 的拒绝被 serial.ts 的失败漏斗吞掉并收口），
  // 这里仍挂两侧回调：只挂 resolve 侧的话，真 reject 会变成未处理拒绝噪声。
  runP.then(
    () => {
      done = true
    },
    () => {
      done = true
    }
  )

  return {
    stack,
    engine,
    calls,
    runP,
    release,
    settled: () => done,
    logOf: (id: string) =>
      db
        .prepare(
          `SELECT * FROM execution_logs WHERE triggered_by_message_id = ? ORDER BY started_at DESC LIMIT 1`
        )
        .get(id) as any,
  }
}

/** 排空微任务 / 0ms 计时器直到 `pred` 成立（不依赖真实等待） */
async function drainUntil(pred: () => boolean, steps = 300): Promise<void> {
  for (let i = 0; i < steps && !pred(); i++) await vi.advanceTimersByTimeAsync(0)
}

/** 推到 `runP` 落定（放行后让生成器续延与收口段跑完） */
async function settle(run: Run): Promise<void> {
  for (let i = 0; i < 300 && !run.settled(); i++) await vi.advanceTimersByTimeAsync(0)
  await run.runP
}

/** 硬超时路径的唯一可观测面：reply.ts abort 分支的日志 payload */
const timedOutLog = (): boolean =>
  h.logInfo.mock.calls.some(
    (c) =>
      c[0] === 'agent reply aborted' &&
      typeof c[1] === 'object' &&
      c[1] !== null &&
      (c[1] as { reason?: string }).reason === 'timeout'
  )

// ═══ 用例 ═══

describe('AGENT_HARD_TIMEOUT_MS · 禁用语义（`<= 0`）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    // A4 env 卫生：本文件的每个用例都自己 stub，跑完必须复位——不把
    // `AGENT_HARD_TIMEOUT_MS=0` 留给同进程的其它文件（那会让 serial.test.ts 的
    // 30min 用例静默假红）。
    vi.unstubAllEnvs()
    delete process.env.AGENT_HARD_TIMEOUT_MS
  })

  // ─── A2：`=0` ⇒ 禁用 ────────────────────────────────

  it('A2 `=0`：执行悬在流中途推进 60min 仍不被中断，放行后正常产出回复', async () => {
    const run = await startGated('0', 'msg-off-0', 'trace-off-0')
    await drainUntil(() => run.calls.typing.length > 0)
    // 前置：执行确实**悬着**（首块已出、生成器卡在 gate 上）——否则本用例恒真
    expect(run.calls.typing.length).toBeGreaterThan(0)
    expect(run.settled()).toBe(false)

    // 默认值是 30min：旧实现推进到这里必然 abort('timeout') + reject + 槽位收口
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)

    expect(run.settled()).toBe(false)
    expect(timedOutLog()).toBe(false)
    expect(run.calls.systemNotices.some((n) => n.content.includes('执行超时'))).toBe(false)
    expect(run.engine.getSlot('agent-1', 'session-1')).toMatchObject({ status: 'busy' })

    // 放行 → 禁用 ≠ 执行被废：回复照常落库 + 收口 completed
    run.release()
    await settle(run)
    expect(run.calls.agentMessages).toHaveLength(1)
    expect(run.calls.agentMessages[0]!.content).toBe('部分后续')
    expect(run.logOf('msg-off-0').status).toBe('completed')
    expect(run.engine.getSlot('agent-1', 'session-1')).toMatchObject({ status: 'idle' })
  })

  // ─── A3：`=-1` 同 A2（反例对照）──────────────────────
  // 只判 `=== 0` 的实现会在这里红：负数原样进 setTimeout ⇒ Node 视作 1ms 立即触发。

  it('A3 `=-1`：与 `=0` 同义（禁用），推进 60min 仍不被中断', async () => {
    const run = await startGated('-1', 'msg-off-neg', 'trace-off-neg')
    await drainUntil(() => run.calls.typing.length > 0)
    expect(run.calls.typing.length).toBeGreaterThan(0)

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)

    expect(run.settled()).toBe(false)
    expect(timedOutLog()).toBe(false)
    expect(run.calls.systemNotices.some((n) => n.content.includes('执行超时'))).toBe(false)

    run.release()
    await settle(run)
    expect(run.calls.agentMessages).toHaveLength(1)
    expect(run.logOf('msg-off-neg').status).toBe('completed')
  })

  // ─── A1：默认不变（未设 / 空串 / 坏值 ⇒ 30min）──────

  const DEFAULTS: Array<[string, string | undefined]> = [
    ['未设置', undefined],
    ['空串', ''],
    ['坏值 abc', 'abc'],
  ]

  for (const [label, value] of DEFAULTS) {
    it(`A1 ${label}：回默认 30min——边界差 1ms 不触发、再推 1ms 触发（reason=timeout）`, async () => {
      const run = await startGated(value, 'msg-default', 'trace-default')
      await drainUntil(() => run.calls.typing.length > 0)
      expect(run.calls.typing.length).toBeGreaterThan(0)

      // 边界下沿：1799999ms 还没到 → 不许触发
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 - 1)
      expect(run.settled()).toBe(false)
      expect(timedOutLog()).toBe(false)

      // 边界上沿：+1ms → 必须触发
      await vi.advanceTimersByTimeAsync(1)
      expect(run.settled()).toBe(true)
      // race 在超时那刻就落定，但 reply.ts 的 abort 分支要等生成器**从挂起点恢复**
      // 才走得到（它卡在 gate 上）——放行 + 排空续延，否则断言跑在日志落定之前
      // （serial.test.ts 的同款用例同一顺序：advance → release → await → 排空）
      run.release()
      await run.runP
      for (let i = 0; i < 50; i++) await vi.advanceTimersByTimeAsync(0)

      expect(timedOutLog()).toBe(true)
      expect(run.calls.systemNotices.some((n) => n.content.includes('执行超时'))).toBe(true)
      expect(run.logOf('msg-default').status).toBe('failed')
    })
  }

  it('A1 坏值 `abc` 走 env-number 唯一入口：warn 带变量名，而非静默回退', async () => {
    await startGated('abc', 'msg-warn', 'trace-warn')
    expect(
      h.logWarn.mock.calls.some(
        (c) => typeof c[0] === 'string' && c[0].includes('AGENT_HARD_TIMEOUT_MS')
      )
    ).toBe(true)
  })

  // ─── A4：env 卫生 ────────────────────────────────────

  // 放在最后：位置在前的用例的 afterEach 已复位，此处读到的就是「本文件跑完留给
  // 同进程下一份文件的值」。跨文件那半只能实证（与 serial.test.ts 同批跑双绿——
  // 本文件若泄漏 `=0`，那边依赖 30min 默认的用例会静默假红）。
  it('A4 env 卫生：跑完不在进程里留下 AGENT_HARD_TIMEOUT_MS', () => {
    expect(process.env.AGENT_HARD_TIMEOUT_MS).toBe(h.originalEnv)
  })
})
