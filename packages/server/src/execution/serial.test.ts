/**
 * serial.ts 假 bus 形态 a 测试（3.5 刀落地）：真实 SQLite + 真实 dispatch + 假 bus。
 *
 * 背景：socketio.test.ts 5902 行 mock 掉 dispatch 全部接线——「dispatch 标 busy →
 * connector 执行」的配对链从未被真实测试过（配对仅靠注释维持，事故史实锤）。
 * 本文件边界 mock 只打最外层（LLM registry / git / summarizer / handoff / memory /
 * diff 采集 / eval 采样 / 信号表），dispatch 与执行引擎真实配对；断言打假 bus 的
 * 类型化数组（杀死 any[] 嗅探模式）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type {
  AgentConfig,
  ContextWindowStats,
  DispatchCommand,
  HandoffEvent,
  HandoffFailedPayload,
  Message,
  MessageAgentStatusPayload,
  MessageUpdatedPayload,
  SystemNoticePayload,
  TypingUpdatePayload,
} from '@cat-study/shared'
import { ProviderTokenPool } from './token-pool.js'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository } from '../db/repository/index.js'
import { __test_reset } from '../dispatch/index.js'
import { getAdapterForAgent } from '../llm/registry.js'
import { createExecutionEngine } from './serial.js'
import { resolveMentionLimit, DEFAULT_MAX_MENTIONS_PER_AGENT } from './serial.js'
import { maybeScoreSample } from '../eval/sampler.js'
import { ensureAgentWorktree, gitCommit } from '../llm/git-utils.js'
import type { ExecutionEngine, ExecutionEngineTestHooks } from './serial.js'
import type { EngineBus, HandoffBus } from './bus.js'

// ═══ 边界 mock（真实 dispatch / SQLite / 纯函数保留） ═══

// 日志按边界 mock：T-K 的交付面之一是"配额拦截从 info 抬到 warn"，可观测面就是这条
// warn——不 mock 就只能断言"跳数变少"（那测的是拦截行为，不是**可观测性**那条修复）。
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
  // T-1 Phase 2：① 的提交作用域只认 worktree——默认 null ⇒ 不提交。
  // 需要「真有 commit」的用例（T-M 写回面）自行 mockReturnValue 覆盖。
  //
  // T-2 Phase I：解析点由 `ensureSessionWorktree` 换成**按角色分派**的
  // `ensureAgentWorktree`（store → 会话 worktree / 其余 → 各家猫 worktree）。
  // 本工厂是**部分导出**——漏键 ⇒ 消费方拿到 undefined、调用即 TypeError。
  ensureSessionWorktree: vi.fn(() => null),
  ensureAgentWorktree: vi.fn(() => null),
  snapshotPackageDeps: vi.fn(() => ({})),
  diffNewPackages: vi.fn(() => []),
  // T-1 Phase 2：serial.ts 清理段改带 `cleanGitEnv()`（与 gitCommit 对称）。
  // 本工厂是**部分导出**——漏键 ⇒ serial.ts 拿到 undefined、调用即 TypeError，
  // 而清理段自带 `catch {}` 会把它静默吞掉（表现为「清理莫名没跑」）。
  cleanGitEnv: vi.fn(() => ({ ...process.env })),
}))

// T-2 Phase I-b 形态 G：`reply.ts` 的 **execution cwd 解析点**从
// `ensureAgentWorktree`（git-utils）换成了 `ensureExecutionWorktree`（worktree-fanin，
// 审查者额外做一次分支合并）。**边界 mock 随解析点一起搬**——不搬的话本文件的
// `ensureAgentWorktree` 桩会漏过去（`vi.clearAllMocks()` 清调用不清 `mockReturnValue`，
// 见 1204/1242 设过的值），而真 `worktree-fanin` 会对 `/tmp/...` 这种假路径跑真 git。
// 这是本文件第二次跟着解析点搬家（前一次见下方 git-utils 工厂注释）。
vi.mock('../llm/worktree-fanin.js', () => ({
  ensureExecutionWorktree: vi.fn(() => null),
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
  // R2 段五起 reply.ts 消费这个常量（`diff.collect` 的超时判据）——替身必须镜像
  // 真模块**被消费的导出面**：漏一个 = 调用点当场 TypeError，回复整条发不出去
  // （与 memory/index.js 替身缺 currentRetrievalParams 同款，实测踩过）
  GIT_TIMEOUT_MS: 5000,
}))

// 顶层收尾的脏文件清理用真实 execSync 会命中真实仓库——恒返回空串（"干净"跳过）
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execSync: vi.fn(() => '') }
})

vi.mock('../eval/sampler.js', () => ({
  maybeScoreSample: vi.fn(),
}))

vi.mock('../eval/verdict-parser.js', () => ({
  recordReviewVerdict: vi.fn(),
}))

vi.mock('../llm/route-signals.js', () => ({
  consumeRouteSignals: vi.fn(() => []),
}))

vi.mock('../llm/user-request-signals.js', () => ({
  consumeUserRequestSignals: vi.fn(() => []),
}))

// ═══ 假 bus ═══

interface BusCalls {
  agentMessages: Message[]
  systemNotices: SystemNoticePayload[]
  typing: TypingUpdatePayload[]
  statuses: MessageAgentStatusPayload[]
  messageUpdated: MessageUpdatedPayload[]
  contextStats: ContextWindowStats[]
  handoffs: HandoffEvent[]
  handoffFailed: HandoffFailedPayload[]
}

/** 假 bus 形态 a：类型化方法收集调用（引擎物理上发不出未类型化事件） */
function createFakeBus(): { bus: EngineBus & HandoffBus; calls: BusCalls } {
  const calls: BusCalls = {
    agentMessages: [],
    systemNotices: [],
    typing: [],
    statuses: [],
    messageUpdated: [],
    contextStats: [],
    handoffs: [],
    handoffFailed: [],
  }
  const bus: EngineBus & HandoffBus = {
    emitMessage: (m) => calls.agentMessages.push(m),
    emitSystemNotice: (n) => calls.systemNotices.push(n),
    emitTyping: (u) => calls.typing.push(u),
    emitAgentMessageStatus: (_sessionId, s) => calls.statuses.push(s),
    emitMessageUpdated: (_sessionId, u) => calls.messageUpdated.push(u),
    emitContextWindowStats: (s) => calls.contextStats.push(s),
    emitSessionHandoff: (e) => calls.handoffs.push(e),
    emitHandoffFailed: (p) => calls.handoffFailed.push(p),
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

const makeMessage = (overrides?: Partial<Message>): Message => ({
  id: 'msg-1',
  sessionId: 'session-1',
  agentId: null,
  role: 'user',
  content: '你好',
  mentions: [],
  createdAt: new Date().toISOString(),
  ...overrides,
})

/** 受控适配器：产出固定流（gate 可暂停——中断/撤回用例在流中段介入） */
function makeAdapter(flow?: { chunks: string[]; gate?: Promise<void> }): ReturnType<typeof vi.fn> {
  const chatStream = vi.fn(async function* () {
    if (flow) {
      for (const c of flow.chunks) {
        yield { content: c, kind: 'text' }
        if (flow.gate) await flow.gate
      }
    } else {
      yield { content: '收到', kind: 'text' }
    }
  })
  vi.mocked(getAdapterForAgent).mockReturnValue({ chatStream } as any)
  return chatStream
}

/** 完整配对链：落库触发消息 → dispatch 标 busy → 引擎执行 */
async function runPaired(
  engine: ExecutionEngine & ExecutionEngineTestHooks,
  triggerId: string,
  traceId: string,
  depth = 0
): Promise<boolean> {
  const db = getDb()
  db.prepare(
    `INSERT INTO messages (id, session_id, role, content, mentions)
     VALUES (?, 'session-1', 'user', '你好', '[]')`
  ).run(triggerId)
  // C1 v3 单入口：executeAgentsSerial 内部走 execute(cmd)——决策(标 busy)+执行一次搞定。
  // 原 dispatch + executeAgentsSerial 两步合并（execute 决策段惰性创建槽位）
  return engine.executeAgentsSerial(
    'session-1',
    [DEFAULT_AGENT],
    { id: triggerId, content: '你好', mentions: [] },
    traceId,
    depth
  )
}

/** 读取该触发消息的最新 execution_log 行 */
function getLog(triggerId: string): any {
  return getDb()
    .prepare(
      `SELECT * FROM execution_logs WHERE triggered_by_message_id = ? ORDER BY started_at DESC LIMIT 1`
    )
    .get(triggerId) as any
}

describe('serial — 假 bus 形态 a（真实 dispatch 配对）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __test_reset()
    const db = createTestDb()
    setDb(db)
    initRepository(db)
    db.prepare(
      `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
       VALUES (?, ?, '🐱', 'You are a cat.', 'deepseek', 'deepseek-v4-pro', 'sk-test')`
    ).run('agent-1', '店长')
    db.prepare(
      `INSERT INTO sessions (id, title, agent_ids, broadcast_mode)
       VALUES ('session-1', '测试会话', '["agent-1"]', 0)`
    ).run()
  })

  afterEach(() => {
    resetDb()
  })

  it('配对链全绿：dispatch 标 busy → 引擎推 LLM → 回复落库 + NEW_MESSAGE + 槽位释放 + 审计', async () => {
    makeAdapter()
    const { bus, calls } = createFakeBus()
    const engine = createExecutionEngine(bus)

    const anyClaude = await runPaired(engine, 'msg-1', 'trace-1')

    // 回复经 bus 发到"客户端"且内容完整
    expect(calls.agentMessages).toHaveLength(1)
    expect(calls.agentMessages[0]).toMatchObject({
      sessionId: 'session-1',
      agentId: 'agent-1',
      role: 'agent',
      content: '收到',
    })
    // C5：agent 耗时随广播注入（durationMs = Date.now() - startedAt，广播对象瞬态）
    expect(calls.agentMessages[0].durationMs).toEqual(expect.any(Number))
    // 回复已落库（runAgentReply 真实写库）
    const row = getDb()
      .prepare(`SELECT * FROM messages WHERE role = 'agent' AND session_id = 'session-1'`)
      .get() as any
    expect(row).toBeDefined()
    expect(row.content).toBe('收到')
    // 状态推进：thinking → replying → done
    expect(calls.statuses.map((s) => s.status)).toEqual(['thinking', 'replying', 'done'])
    // 槽位释放回 idle（真实 dispatch completeExecution 跑通）
    expect(engine.getSlot('agent-1', 'session-1')).toMatchObject({ status: 'idle' })
    // 审计落库：completed + 洞 A 判据 message_id 写回
    const log = getLog('msg-1')
    expect(log.status).toBe('completed')
    expect(log.message_id).toBe(calls.agentMessages[0].id)
    // dispatch_state 收口 done（重启恢复不重复调度）
    const state = getDb()
      .prepare(`SELECT dispatch_state FROM messages WHERE id = 'msg-1'`)
      .get() as any
    expect(state.dispatch_state).toBe('done')
    // deepseek 非 Claude → 不编辑源文件 → 顶层收尾无脏文件清理义务
    expect(anyClaude).toBe(false)
  })

  it('忙→闲收敛：idle 槽位保留 sessionId——socket 桥接收到 idle 也能路由到目标会话房间', async () => {
    makeAdapter()
    const { bus } = createFakeBus()
    const engine = createExecutionEngine(bus)
    const bridgeStates: Array<{ status: string; sessionId: string | null }> = []
    engine.setAgentStateBridge((s) => bridgeStates.push(s))

    await runPaired(engine, 'msg-idle-conv', 'trace-idle-conv')

    // 回归核心：桥接必须收到 idle 且带 sessionId——socketio.ts 的 `if (state.sessionId)`
    // 门控才放行、路由到 session:<id> 房间；否则忙灯永不收回（删全量推送兜底后 idle
    // 是唯一收敛通道，此断言防止再次漏网）
    expect(bridgeStates.some((s) => s.status === 'idle' && s.sessionId === 'session-1')).toBe(true)
    // snapshot/拉取同形状：idle 槽位保留 sessionId（all-agent-states 兜底也不丢会话维度）
    expect(engine.getSlot('agent-1', 'session-1')).toMatchObject({
      status: 'idle',
      sessionId: 'session-1',
    })
  })

  it('LLM 抛错 → 失败漏斗：系统提示 + execution_logs failed + 槽位释放（finalizeRun 统一收口）', async () => {
    vi.mocked(getAdapterForAgent).mockReturnValue({
      chatStream: vi.fn(async function* () {
        throw new Error('boom')
      }),
    } as any)
    const { bus, calls } = createFakeBus()
    const engine = createExecutionEngine(bus)

    await runPaired(engine, 'msg-1', 'trace-1')

    // 错误经系统提示可见（执行者不可见，用户可见）
    expect(
      calls.systemNotices.some(
        (n) => n.content.includes('暂时无法回复') && n.content.includes('boom')
      )
    ).toBe(true)
    // 无回复落库、无 NEW_MESSAGE
    expect(calls.agentMessages).toHaveLength(0)
    expect(
      getDb().prepare(`SELECT COUNT(*) AS n FROM messages WHERE role = 'agent'`).get() as any
    ).toMatchObject({ n: 0 })
    // 审计 failed + 分类
    const log = getLog('msg-1')
    expect(log.status).toBe('failed')
    expect(log.error_message).toBe('boom')
    // 槽位释放（异常不卡 slot——卡死槽位事故族回归）
    expect(engine.getSlot('agent-1', 'session-1')).toMatchObject({ status: 'idle' })
  })

  it('AGENT_INTERRUPT 同款：引擎 abortAgent → 流提前返回 → failed/interrupted 收口，无回复', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    // 产出首块后挂起——测试在 typing 落定后 abort（模拟停止按钮）
    makeAdapter({ chunks: ['部分'], gate })
    const { bus, calls } = createFakeBus()
    const engine = createExecutionEngine(bus)

    const runP = runPaired(engine, 'msg-int', 'trace-int')
    await vi.waitFor(() => expect(calls.typing.length).toBeGreaterThan(0))
    expect(engine.abortAgent('agent-1')).toBe(true)
    release()
    await runP

    // 中断提示可见、无终稿落库（部分内容不冒充正常回复走 A2A）
    expect(calls.systemNotices.some((n) => n.content.includes('已停止（用户中断）'))).toBe(true)
    expect(calls.agentMessages).toHaveLength(0)
    // 中断走失败路径收口（execution_logs 记 failed/interrupted）
    const log = getLog('msg-int')
    expect(log.status).toBe('failed')
    expect(log.error_message).toBe('interrupted')
    expect(engine.getSlot('agent-1', 'session-1')).toMatchObject({ status: 'idle' })
  })

  it('MESSAGE_RETRACT 同款：引擎 setRetraction → 流中途退出 → 无回复落库、标记自清理', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    makeAdapter({ chunks: ['正在写', ' 完成'], gate })
    const { bus, calls } = createFakeBus()
    const engine = createExecutionEngine(bus)

    const runP = runPaired(engine, 'msg-ret', 'trace-ret')
    await vi.waitFor(() => expect(calls.typing.length).toBeGreaterThan(0))
    engine.setRetraction('msg-ret')
    release()
    await runP

    // 撤回 → 无终稿（NEW_MESSAGE 与 DB 双无）
    expect(calls.agentMessages).toHaveLength(0)
    expect(
      getDb().prepare(`SELECT COUNT(*) AS n FROM messages WHERE role = 'agent'`).get() as any
    ).toMatchObject({ n: 0 })
    // 槽位照常释放（撤回不是失败也不是卡死）
    expect(engine.getSlot('agent-1', 'session-1')).toMatchObject({ status: 'idle' })
  })

  it('no-key 守卫：deepseek 无 key → 配置提示、不进 LLM、槽位与队列收口', async () => {
    const { bus, calls } = createFakeBus()
    const engine = createExecutionEngine(bus)
    // C1 v3：execute 从 DB 查 agent 配置（生产同款——ingest/recovery 的 agents 本就
    // 来自 DB）。守卫读执行者配置 → 把 DB 中 agent-1 的 key 置空走 no-key 守卫
    const noKeyAgent: AgentConfig = { ...DEFAULT_AGENT, llmApiKey: '' }
    const db = getDb()
    db.prepare(`UPDATE agents SET llm_api_key = '' WHERE id = 'agent-1'`).run()
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, mentions)
       VALUES ('msg-nokey', 'session-1', 'user', '你好', '[]')`
    ).run()
    await engine.executeAgentsSerial(
      'session-1',
      [noKeyAgent],
      { id: 'msg-nokey', content: '你好', mentions: [] },
      'trace-nokey'
    )

    expect(calls.systemNotices.some((n) => n.content.includes('还没有配置 API Key'))).toBe(true)
    // 守卫拦在 LLM 之前
    expect(getAdapterForAgent).not.toHaveBeenCalled()
    expect(calls.agentMessages).toHaveLength(0)
    // 收口仍走统一漏斗（无 key 也标 done 释放槽位，排队命令不弃）
    expect(engine.getSlot('agent-1', 'session-1')).toMatchObject({ status: 'idle' })
    const log = getLog('msg-nokey')
    expect(log.status).toBe('completed')
  })

  // ── V1（票丑）：单计成立。计数点是「A2A 派发预留」⇒ 派发 N 次 ⇒ 桶 === N，
  // 而**不是**「执行 N 次」。故本用例改走 **A2A 派发路径**、断言对象由执行者桶
  // 改为**目标桶**——`__setMentionCount` 播种不算（那测不到计数时点本身）。
  // 判红能力：把计数点改回「执行完成处再计一次」的双计 ⇒ 同构造读到 2 / 4。
  it('V1 单计成立：A2A 派发 N 次 ⇒ 目标桶 === N（跨 run 累加），顶层收尾按 trace 清空', async () => {
    const db = getDb()
    db.prepare(
      `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
       VALUES ('agent-2', 'ds猫', '🐱', 'You are a cat.', 'deepseek', 'deepseek-v4-pro', 'sk-test')`
    ).run()
    db.prepare(`UPDATE sessions SET agent_ids = ? WHERE id = 'session-1'`).run(
      JSON.stringify(['agent-1', 'agent-2'])
    )
    // 第 1/3 次调用（agent-1 执行）@ds猫 → 一次派发；其余（ds猫 自己执行）普通回复，不递归
    let call = 0
    const chatStream = vi.fn(async function* () {
      call++
      yield { content: call === 1 || call === 3 ? '@ds猫 继续' : '收到', kind: 'text' }
    })
    vi.mocked(getAdapterForAgent).mockReturnValue({ chatStream } as any)
    const { bus } = createFakeBus()
    const engine = createExecutionEngine(bus)

    const runOnce = async (triggerId: string, depth: number): Promise<boolean> => {
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions)
         VALUES (?, 'session-1', 'user', '你好', '[]')`
      ).run(triggerId)
      return engine.executeAgentsSerial(
        'session-1',
        [DEFAULT_AGENT],
        { id: triggerId, content: '你好', mentions: [] },
        'trace-persist',
        depth
      )
    }

    // run1：depth=1（A2A 链）执行一次 → 派发 ds猫 一次 ⇒ 目标桶 1
    await runOnce('msg-p1', 1)
    expect(engine.__getMentionCount('trace-persist', 'agent-2')).toBe(1)
    // 执行者桶恒 0——单计后执行者永不自计（旧的「执行成功 +1」已删）
    expect(engine.__getMentionCount('trace-persist', 'agent-1')).toBe(0)
    // run2：同 trace 再来一次 ⇒ 计数跨 run 累加（engine 级字段）
    await runOnce('msg-p2', 1)
    expect(engine.__getMentionCount('trace-persist', 'agent-2')).toBe(2)
    // depth=0 顶层收尾 → 该 trace 配额清空（防无限循环计数泄漏）
    await runOnce('msg-p3', 0)
    expect(engine.__getMentionCount('trace-persist', 'agent-2')).toBe(0)
  })

  it('实例态隔离：引擎间零共享（模块态 → 实例态的核心承诺）', () => {
    const a = createExecutionEngine(createFakeBus().bus)
    const b = createExecutionEngine(createFakeBus().bus)

    a.__setMentionCount('trace-iso', 'agent-1', 3)
    a.setRetraction('msg-x')

    // b 看不到 a 的任何实例态
    expect(b.__getMentionCount('trace-iso', 'agent-1')).toBe(0)
    expect(b.abortAgent('agent-1')).toBe(false) // a 未跑 b 的注册表（且 b 无 run）
    // a 自身状态在
    expect(a.__getMentionCount('trace-iso', 'agent-1')).toBe(3)
    expect(a.abortAgent('agent-1')).toBe(false) // 撤回标记不产生 abort 注册表项
  })

  it('__test_reset 全量清空实例态（测试用例间隔离钩子）', () => {
    const engine = createExecutionEngine(createFakeBus().bus)
    engine.__setMentionCount('trace-r', 'agent-1', 5)
    engine.setRetraction('msg-r')

    engine.__test_reset()

    expect(engine.__getMentionCount('trace-r', 'agent-1')).toBe(0)
  })

  it('思考展示结构分离：typing 推 segments 分段 + thinkingContent 存纯文本（无 [思考] 前缀）', async () => {
    // 混合流：text → thinking（纯文本）→ text（正文含 [思考] 字面量——不该被当思考吞掉）
    const chatStream = vi.fn(async function* () {
      yield { content: '正文开始', done: false, kind: 'text' }
      yield { content: '这是思考过程', done: false, kind: 'thinking' }
      yield { content: '正文里说[思考]不是标记', done: false, kind: 'text' }
    })
    vi.mocked(getAdapterForAgent).mockReturnValue({ chatStream } as any)
    const { bus, calls } = createFakeBus()
    const engine = createExecutionEngine(bus)

    await runPaired(engine, 'msg-thinking', 'trace-thinking')

    // typing 推送：segments 结构分段（kind 驱动，无文本标记）+ content 兼容字段仍在
    expect(calls.typing.length).toBeGreaterThan(0)
    const lastTyping = calls.typing[calls.typing.length - 1]
    expect(lastTyping.segments).toEqual([
      { kind: 'text', content: '正文开始' },
      { kind: 'thinking', content: '这是思考过程' },
      { kind: 'text', content: '正文里说[思考]不是标记' },
    ])
    expect(lastTyping.content).toBe('正文开始这是思考过程正文里说[思考]不是标记')

    // 落库：thinking_content 纯思考文本（无 [思考] 前缀）；content 只含文本 chunk（思考不入库）
    const row = getDb()
      .prepare(`SELECT * FROM messages WHERE role = 'agent' AND session_id = 'session-1'`)
      .get() as any
    expect(row.thinking_content).toBe('这是思考过程')
    expect(row.content).toBe('正文开始正文里说[思考]不是标记')
  })

  it('工具语义拆分：tool chunk 独立分段 + tool_content 落库（正文/思考/工具三通道分离）', async () => {
    // 混合流：text → tool(running) → thinking → tool(completed 同 id) → text
    const chatStream = vi.fn(async function* () {
      yield { content: '开始', done: false, kind: 'text' }
      yield {
        content: 'bash: 运行中',
        done: false,
        kind: 'tool',
        tool: { id: 'c1', name: 'bash', status: 'running', input: { command: 'ls' } },
      }
      yield { content: '静想', done: false, kind: 'thinking' }
      yield {
        content: 'bash: 完成',
        done: false,
        kind: 'tool',
        tool: {
          id: 'c1',
          name: 'bash',
          status: 'completed',
          input: { command: 'ls' },
          output: 'a.txt',
        },
      }
      yield { content: '正文', done: false, kind: 'text' }
    })
    vi.mocked(getAdapterForAgent).mockReturnValue({ chatStream } as any)
    const { bus, calls } = createFakeBus()
    const engine = createExecutionEngine(bus)

    await runPaired(engine, 'msg-tool', 'trace-tool')

    // typing segments：tool 按 id 合并成单段（running→completed 原地更新，不产生重复卡）；
    // wire 轻量只带 id/name/status（io 只进落库）
    const lastTyping = calls.typing[calls.typing.length - 1]
    expect(lastTyping.segments).toEqual([
      { kind: 'text', content: '开始' },
      {
        kind: 'tool',
        content: 'bash: 完成',
        tool: { id: 'c1', name: 'bash', status: 'completed' },
      },
      { kind: 'thinking', content: '静想' },
      { kind: 'text', content: '正文' },
    ])
    // content 兼容字段不含 tool（正文+思考仅两通道），工具不进旧前端 content 解析面
    expect(lastTyping.content).toBe('开始静想正文')

    // 落库：content 只含文本、thinking_content 纯思考、tool_content 结构化 JSON——
    // 工具记录按 id 合并成单条（running→completed 状态推进）
    const row = getDb()
      .prepare(`SELECT * FROM messages WHERE role = 'agent' AND session_id = 'session-1'`)
      .get() as any
    expect(row.content).toBe('开始正文')
    expect(row.thinking_content).toBe('静想')
    const tools = JSON.parse(row.tool_content)
    expect(tools).toHaveLength(1)
    // 夹具 chunk 未带 isError → 记录无该键（JSON 序列化省略 undefined；
    // 真实适配器恒带布尔 isError，见 opencode/serve/cli 工具 chunk 形状）
    expect(tools[0]).toEqual({
      id: 'c1',
      name: 'bash',
      status: 'completed',
      input: { command: 'ls' },
      output: 'a.txt',
    })

    // 落库 segments（insertAgentMessage 第 9 参写回 messages.segments）：非空 JSON 字符串、
    // 结构与最终 typing.segments 一致（text/tool/thinking 三通道交错序；tool 段只带 wire 轻量
    // 字段 id/name/status，io 走 tool_content 独立列）。缺此断言则 reply.ts 第 9 参位漂移
    // （如参数调序/拼接错列）无回归保护——历史折叠块交错还原的权威源就断在这里。
    expect(typeof row.segments).toBe('string')
    expect(row.segments.length).toBeGreaterThan(0)
    expect(JSON.parse(row.segments)).toEqual(lastTyping.segments)
  })
})

// ═══ 收口链回作者通路修复（修法②）：被拦 @ 的 store UI 提示 ═══
// 裁决 (a)：这是 UI 提示（人类可见），**不触达 store agent 上下文**——
// emitSystemNotice 不落库 + agent 上下文过滤 role != 'system'。

describe('serial — 被拦 @ 的 store UI 提示（人类可见，不进 agent 上下文）', () => {
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

  beforeEach(() => {
    vi.clearAllMocks()
    __test_reset()
    const db = createTestDb()
    setDb(db)
    initRepository(db)
    // reviewer（发送者）+ store（兜底收件人）+ 第二位 reviewer（被拦目标）
    // 被拦目标用一个**真正不在 reviewer 边表里**的角色：reviewer 边表 = {store,
    // implementer}，故取 reviewer 自身（原 vision 已随角色退役，2026-09-13 单A）
    const insert = db.prepare(
      `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
       VALUES (?, ?, '🐱', 'You are a cat.', 'deepseek', 'deepseek-v4-pro', 'sk-test', ?)`
    )
    insert.run('agent-reviewer', '吐槽猫', 'reviewer')
    insert.run('agent-store', '店长', 'store')
    insert.run('agent-reviewer-2', '副审查猫', 'reviewer')
    db.prepare(
      `INSERT INTO sessions (id, title, agent_ids, broadcast_mode)
       VALUES ('session-1', '测试会话', '["agent-reviewer","agent-store","agent-reviewer-2"]', 0)`
    ).run()
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, mentions)
       VALUES ('msg-1', 'session-1', 'user', '请审查', '[]')`
    ).run()
  })

  afterEach(() => {
    resetDb()
    vi.unstubAllEnvs()
  })

  it('reviewer @ 另一只 reviewer（被拦）→ 提示发送者 + store 猫收到 UI 提示（人类可见，不进 agent 上下文）', async () => {
    makeAdapter({ chunks: ['⚠️建议修改\n\n@副审查猫 请看看'] })
    const { bus, calls } = createFakeBus()
    const engine = createExecutionEngine(bus)

    await engine.executeAgentsSerial(
      'session-1',
      [REVIEWER],
      { id: 'msg-1', content: '请审查', mentions: [] },
      'trace-1',
      0
    )

    // ① 原有行为保留：发送者收到违规提示
    const toSender = calls.systemNotices.filter((n) => n.agentId === 'agent-reviewer')
    expect(toSender.some((n) => n.content.includes('不在你的角色允许范围内'))).toBe(true)
    // ② UI 提示：store 猫（人）能看到——被拦的结论不再无声消失。
    //    注意只断言「发过」（假 bus 被 push），不代表店长 agent 读到了
    //    （emitSystemNotice 不落库 + agent 上下文过滤 system）——见裁决 (a)。
    const toStore = calls.systemNotices.filter((n) => n.agentId === 'agent-store')
    expect(toStore).toHaveLength(1)
    expect(toStore[0].content).toContain('吐槽猫')
    expect(toStore[0].content).toContain('副审查猫')
    expect(toStore[0].content).toContain('悬空')
    // ③ 被拦目标未被路由（无 A2A 子链）
    const blockedLog = getDb()
      .prepare(`SELECT * FROM execution_logs WHERE agent_id = 'agent-reviewer-2'`)
      .get()
    expect(blockedLog).toBeUndefined()
  })

  it('reviewer @ 店长（合法）→ 不发 UI 提示', async () => {
    let call = 0
    const chatStream = vi.fn(async function* () {
      call++
      // 第一次 = 吐槽猫结论；第二次 = A2A 唤起的店长（普通回复，避免递归）
      yield { content: call === 1 ? '✅可合并\n\n@店长 请收口' : '收到', kind: 'text' }
    })
    vi.mocked(getAdapterForAgent).mockReturnValue({ chatStream } as any)
    const { bus, calls } = createFakeBus()
    const engine = createExecutionEngine(bus)

    await engine.executeAgentsSerial(
      'session-1',
      [REVIEWER],
      { id: 'msg-1', content: '请审查', mentions: [] },
      'trace-1',
      0
    )

    expect(calls.systemNotices.filter((n) => n.agentId === 'agent-store')).toHaveLength(0)
    expect(calls.systemNotices.some((n) => n.content.includes('不在你的角色允许范围内'))).toBe(
      false
    )
  })

  it('reviewer↔implementer 互 @ 成环 → **depth 闸**截断（单计后配额不再是环截断者），不无限递归', async () => {
    // 隔离 token 池：PROVIDER_TOKEN_CAP=0（不限制）——本用例只验证风暴护栏本体
    // （配额）截断环，不混入 token 池的排队时序。注：原注释写「默认 cap=2 时该环
    // 会先在 token 池上死锁」，描述的是 A 方案修复前的缺陷（executeRun 持 token
    // 期间做 A2A 递归 → 环 = 嵌套持有 = 互等），该缺陷已修（token 只包 LLM 段，
    // 见 token-pool 死锁根治单）；隔离保留只为让断言只反映配额截断。
    vi.stubEnv('PROVIDER_TOKEN_CAP', '0')
    const db = getDb()
    db.prepare(
      `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
       VALUES ('agent-impl', 'ds猫', '🐱', 'You are a cat.', 'deepseek', 'deepseek-v4-pro', 'sk-test', 'implementer')`
    ).run()
    db.prepare(`UPDATE sessions SET agent_ids = ? WHERE id = 'session-1'`).run(
      JSON.stringify(['agent-reviewer', 'agent-store', 'agent-reviewer-2', 'agent-impl'])
    )
    // 每跳互 @ 对方：reviewer→ds猫→reviewer→…（边表补 implementer 后成环可达）
    let call = 0
    const chatStream = vi.fn(async function* () {
      call++
      yield { content: call % 2 === 1 ? '@ds猫 继续' : '@吐槽猫 继续', kind: 'text' }
    })
    vi.mocked(getAdapterForAgent).mockReturnValue({ chatStream } as any)
    const { bus } = createFakeBus()
    const engine = createExecutionEngine(bus)

    await engine.executeAgentsSerial(
      'session-1',
      [REVIEWER],
      { id: 'msg-1', content: '请审查', mentions: [] },
      'trace-loop',
      0
    )

    // ── V2（票丑）：环用例按**新语义重钉**，不追旧读数。
    // 截断者是 **depth 闸**（`MAX_AGENT_DISPATCH_DEPTH=10`），**不是**配额——
    // 裁决 a：depth = 链长上限 / 配额 = per-agent 预算，两闸各司其职。
    //
    // ⚠️ **跳数口径钉死**：「跳数」= **chatStream / LLM 执行调用数**（与旧
    // `toBe(7)` 同计量），**不是**「派发尝试序号」。单计 + `limit=5` 下：
    // 两猫的桶各被派发 5 次（8 次预留后 ds猫/吐槽猫 各 5），实测执行 10 跳
    // （depth 0..9 各一次）；第 **11** 跳（`depth=10` 的那次派发）被 depth 闸拦下。
    // **两个数字（10 / 11）一起断死**，禁止只断其一、禁止与「派发尝试序号」混用。
    // 附注：现网形态（执行 7 / 第 8 次尝试被拦）在单计下**无整数 `limit` 可复现**
    // （单计被拦尝试恒为 `2L+1` = 奇数，现网是偶数）⇒ 只能按新语义重测。
    expect(chatStream.mock.calls.length).toBeGreaterThan(1) // 环确实转起来了
    expect(chatStream.mock.calls.length).toBe(10) // ← 10 跳
    const depthWarns = logWarn.mock.calls.filter(
      (c) => c[0] === 'agent dispatch depth limit reached'
    )
    expect(depthWarns).toHaveLength(1) // ← 第 11 跳：恰一次、唯一截断点
    expect(depthWarns[0][1]).toEqual({ traceId: 'trace-loop', depth: 10 })
    // 配额 warn **零触发**：单计 + limit=5 下配额不是截断者（旧用例断言它触发，
    // 正是被裁决 a 推翻的那条——`limit` 不再是「轮次」的折半口径）
    expect(
      logWarn.mock.calls.filter((c) => c[0] === 'agent-to-agent mention limit filtered')
    ).toHaveLength(0)
    // `limit` 仍在契约内（配置面未动）：本 trace 的可派发预算就是默认阈值
    expect(DEFAULT_MAX_MENTIONS_PER_AGENT).toBe(5)
  }, 60000)
})

// ═══ A2A 配额阈值可配（T-K） ═══

describe('serial — A2A 配额阈值可配（T-K）', () => {
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

  beforeEach(() => {
    vi.clearAllMocks()
    __test_reset()
    const db = createTestDb()
    setDb(db)
    initRepository(db)
    const insert = db.prepare(
      `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
       VALUES (?, ?, '🐱', 'You are a cat.', 'deepseek', 'deepseek-v4-pro', 'sk-test', ?)`
    )
    insert.run('agent-reviewer', '吐槽猫', 'reviewer')
    insert.run('agent-impl', 'ds猫', 'implementer')
    db.prepare(
      `INSERT INTO sessions (id, title, agent_ids, broadcast_mode)
       VALUES ('session-1', '测试会话', '["agent-reviewer","agent-impl"]', 0)`
    ).run()
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, mentions)
       VALUES ('msg-1', 'session-1', 'user', '请审查', '[]')`
    ).run()
  })

  afterEach(() => {
    resetDb()
    vi.unstubAllEnvs()
  })

  it('阈值解析：0 / 负数 / 非法 / 空 → 默认值；正数原样（**不**开放"不限"）', () => {
    expect(DEFAULT_MAX_MENTIONS_PER_AGENT).toBe(5)
    expect(resolveMentionLimit(undefined)).toBe(5)
    expect(resolveMentionLimit('')).toBe(5)
    expect(resolveMentionLimit('0')).toBe(5) // 与 PROVIDER_TOKEN_CAP 的「0=不限」刻意不同
    expect(resolveMentionLimit('-3')).toBe(5)
    expect(resolveMentionLimit('abc')).toBe(5)
    expect(resolveMentionLimit('1')).toBe(1)
    expect(resolveMentionLimit('12')).toBe(12)
  })

  // ── V4（票丑）：**反例为红** + 配额仍是真拦截者。
  // 判红能力：把计数点改回「执行完成处再计一次」的双计 ⇒ 本用例实跑为红
  // （桶读到 2/2 而非 1/1）。故断言**桶值本身**，不能只断跳数——单计/双计在
  // `limit=1` 下跳数恰好都是 3，只断跳数会空洞通过。
  it('V4 MAX_MENTIONS_PER_AGENT=1 → 第二次派发即被**配额**拦（3 跳 / depth 远未触门）', async () => {
    // 隔离 token 池（同既有环截断用例：本用例只验配额，不混排队时序）
    vi.stubEnv('PROVIDER_TOKEN_CAP', '0')
    vi.stubEnv('MAX_MENTIONS_PER_AGENT', '1')
    // 每跳互 @ 对方：reviewer→ds猫→reviewer→…（与既有用例同构，只换阈值）
    let call = 0
    const chatStream = vi.fn(async function* () {
      call++
      yield { content: call % 2 === 1 ? '@ds猫 继续' : '@吐槽猫 继续', kind: 'text' }
    })
    vi.mocked(getAdapterForAgent).mockReturnValue({ chatStream } as any)
    const { bus } = createFakeBus()
    const engine = createExecutionEngine(bus)

    // depth=1 起跑（而非 0）：depth=0 的顶层收尾会 `clearMentionCountsForTrace`
    // 清空本 trace 的桶 ⇒ 桶值不可观测。depth=1 只是「本条链是 A2A 链」的标记，
    // 配额机制与 depth=0 同（计数点在派发预留，与发送者 depth 无关）。
    await engine.executeAgentsSerial(
      'session-1',
      [REVIEWER],
      { id: 'msg-1', content: '请审查', mentions: [] },
      'trace-limit-1',
      1
    )

    // 单计：`limit=1` ⇒ 每猫最多被派发 **1** 次。实测 3 跳
    // （reviewer 顶层 → ds猫 → reviewer），第 3 跳末 reviewer 的回复要再派 ds猫 时
    // 其桶已 = 1 ≥ limit ⇒ `continue` 拦下，第 4 跳不发生。
    expect(chatStream.mock.calls.length).toBe(3)
    expect(logWarn).toHaveBeenCalledWith(
      'agent-to-agent mention limit filtered',
      expect.objectContaining({ limit: 1, skippedCount: 1, remainingCount: 0 })
    )
    // 桶值 === 派发次数（各 1）——**本断言即单计/双计的判别面**：
    // 双计下 ds猫 预留 1 + 执行成功 1 = 2、吐槽猫 同理 = 2（跳数不变，桶值变）。
    expect(engine.__getMentionCount('trace-limit-1', 'agent-impl')).toBe(1)
    expect(engine.__getMentionCount('trace-limit-1', 'agent-reviewer')).toBe(1)
    // 截断确来自**配额**而非 depth 闸顺手兜住（防「用例空洞通过」）：
    // 截断时 depth 仅 2，远未触门 ⇒ depth 闸 warn 全程零触发。
    expect(
      logWarn.mock.calls.filter((c) => c[0] === 'agent dispatch depth limit reached')
    ).toHaveLength(0)
    // 被拦目标无新执行记录：ds猫 的 execution_log 恰 1 行（首次派发那次），
    // 第 2 次派发被拦 ⇒ 零行增量
    const implRows = getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM execution_logs WHERE agent_id = 'agent-impl' AND trace_id = ?`
      )
      .get('trace-limit-1') as { n: number }
    expect(implRows.n).toBe(1)
  }, 60000)

  // ── V7（票丑）：语义变更有**机器判据**（不只是改注释）。
  // 票面 ③：归一后计的是**派发次数**（含入队后未执行/失败的派发——「预留不退回」
  // 是既有语义），而 `:656-662` 旧注释主张的「未执行的排队任务不消耗配额」在单计下
  // **与原意相反**。⛔ 只改注释不加判据 ⇒ 本票不通过 —— 本用例即那句旧主张的下葬凭证。
  it('V7 调度即计数：目标槽位忙 ⇒ 派发入队**未执行**，配额仍 +1', async () => {
    vi.stubEnv('PROVIDER_TOKEN_CAP', '0')
    const IMPL: AgentConfig = {
      id: 'agent-impl',
      name: 'ds猫',
      avatar: '🐱',
      systemPrompt: 'You are a cat.',
      llmProvider: 'deepseek',
      llmModel: 'deepseek-v4-pro',
      llmApiKey: 'sk-test',
      role: 'implementer',
    }
    // ds猫 的流挂起占槽；吐槽猫 的流 @ds猫（触发 A2A 派发）
    let signalStreaming = () => {}
    const streaming = new Promise<void>((r) => {
      signalStreaming = r
    })
    let releaseGate = () => {}
    const gate = new Promise<void>((r) => {
      releaseGate = r
    })
    vi.mocked(getAdapterForAgent).mockImplementation((agent: any) =>
      agent?.id === 'agent-impl'
        ? ({
            chatStream: vi.fn(async function* () {
              yield { content: '占槽中', kind: 'text' }
              signalStreaming() // 首段已消费、流挂起——槽位保持 busy
              await gate
              yield { content: '完成', kind: 'text' }
            }),
          } as any)
        : ({
            chatStream: vi.fn(async function* () {
              yield { content: '@ds猫 继续', kind: 'text' }
            }),
          } as any)
    )
    const db = getDb()
    for (const id of ['msg-v7-busy', 'msg-v7-send']) {
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions)
         VALUES (?, 'session-1', 'user', '请处理', '[]')`
      ).run(id)
    }
    const { bus } = createFakeBus()
    const engine = createExecutionEngine(bus)
    const implRows = (): number =>
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM execution_logs WHERE agent_id = 'agent-impl' AND trace_id = 'trace-v7'`
          )
          .get() as { n: number }
      ).n

    // ① ds猫 起跑并挂起——槽位 busy 确立。depth=1 起跑：depth=0 的顶层收尾会清桶，
    //    桶值就不可观测了（计数点本身与 depth 无关，见 V4 同款说明）
    const busyRun = engine.executeAgentsSerial(
      'session-1',
      [IMPL],
      { id: 'msg-v7-busy', content: '请处理', mentions: [] },
      'trace-v7',
      1
    )
    await streaming

    // ② 吐槽猫 执行 → 回复 @ds猫 → A2A 派发；ds猫 槽位忙 ⇒ depth>0 走**入队**分支，
    //    本次派发**不执行**——但配额预留已落（票丑的全部要点就在这个时点）
    await engine.executeAgentsSerial(
      'session-1',
      [REVIEWER],
      { id: 'msg-v7-send', content: '请审查', mentions: [] },
      'trace-v7',
      1
    )

    // ③ 断言取在 drain **之前**：派发已入队未执行，桶仍 +1
    //    （旧语义「未执行的排队任务不消耗配额」在此读到 0 —— 判别面）
    expect(engine.__getMentionCount('trace-v7', 'agent-impl')).toBe(1)
    expect(engine.getSlot('agent-impl', 'session-1')?.queueLength).toBe(1)
    expect(implRows()).toBe(1) // 只有 ① 那次占槽运行，派发那次零执行记录

    // ④ 放闸 → 收口时 drain 出队执行（depth 沿用入队时的 2，仍是 A2A 链）⇒
    //    桶**不再**变化：单计下执行者永不自计（「执行完成再计一次」的双计在此读到 2）
    releaseGate()
    await busyRun
    expect(engine.__getMentionCount('trace-v7', 'agent-impl')).toBe(1)
    expect(implRows()).toBe(2) // drain 补执行落审计——证明第 ④ 步确实执行过
  }, 60000)
})

// ═══ 票子：A2A 配额拦截的**可见面** ═══
// 动机（Decisions 38 二 / 39 二）：桶耗尽时此前**只有一行 `log.warn`** ⇒ 生产上等于
// 静默，链上无人在能感知（2026-09-12 实测两点：12:55:02 ds猫 的审查请求 / 12:59:37
// 店长的补投，两次撞同一堵墙，被拦方故障窗口 6 分钟）。本组用例把「发送者提示 +
// store 广播」钉成机器判据——**存在任一路径仍静默 ⇒ 票子失败**。
//
// 场景构造：预置被 @ 目标（ds猫）的桶至上限 ⇒ 该 @ **第 1 跳**就被配额闸拦下，
// 不必跑长环（省时，且不引入 depth 门等其它截断源的干扰）。预置走测试钩子
// `__setMentionCount`——**不触碰生产计数点**：票丑归一后唯一计数点是 A2A 调度点的
// 预留（锚点 `+ 1) // 预留配额`），本组只读它的结果、不播它的种。

describe('serial — A2A 配额拦截的可见面（票子）', () => {
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
  const STORE: AgentConfig = {
    ...REVIEWER,
    id: 'agent-store',
    name: '店长',
    role: 'store',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    __test_reset()
    const db = createTestDb()
    setDb(db)
    initRepository(db)
    // 发送者（reviewer）+ store（兜底收件人）+ 被拦目标（implementer）
    const insert = db.prepare(
      `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
       VALUES (?, ?, '🐱', 'You are a cat.', 'deepseek', 'deepseek-v4-pro', 'sk-test', ?)`
    )
    insert.run('agent-reviewer', '吐槽猫', 'reviewer')
    insert.run('agent-store', '店长', 'store')
    insert.run('agent-impl', 'ds猫', 'implementer')
    db.prepare(
      `INSERT INTO sessions (id, title, agent_ids, broadcast_mode)
       VALUES ('session-1', '测试会话', '["agent-reviewer","agent-store","agent-impl"]', 0)`
    ).run()
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, mentions)
       VALUES ('msg-1', 'session-1', 'user', '请审查', '[]')`
    ).run()
  })

  afterEach(() => {
    resetDb()
    vi.unstubAllEnvs()
  })

  it('桶耗尽 → 发送者收到明确提示 + store 面广播实测出现（Z1/Z2）', async () => {
    makeAdapter({ chunks: ['⚠️建议修改\n\n@ds猫 请返工'] })
    const { bus, calls } = createFakeBus()
    const engine = createExecutionEngine(bus)
    engine.__setMentionCount('trace-quota', 'agent-impl', DEFAULT_MAX_MENTIONS_PER_AGENT)

    await engine.executeAgentsSerial(
      'session-1',
      [REVIEWER],
      { id: 'msg-1', content: '请审查', mentions: [] },
      'trace-quota',
      0
    )

    // Z1：发送者侧可见（非仅日志）——且只发一条（防重复投递）
    const toSender = calls.systemNotices.filter((n) => n.agentId === 'agent-reviewer')
    expect(toSender).toHaveLength(1)
    expect(toSender[0].content).toContain('ds猫')
    expect(toSender[0].content).toContain('未派发')
    expect(toSender[0].content).toContain('配额')
    // Z2：store 面广播**实测出现**（不是只写了代码）。
    //     与 role-not-allowed 同口径：UI 提示（人类可见），**不进 agent 上下文**
    //     （emitSystemNotice 不落库 + agent 上下文过滤 system）——见裁决 (a)。
    const toStore = calls.systemNotices.filter((n) => n.agentId === 'agent-store')
    expect(toStore).toHaveLength(1)
    expect(toStore[0].content).toContain('吐槽猫')
    expect(toStore[0].content).toContain('ds猫')
    expect(toStore[0].content).toContain('悬空')
    // 可见面是**增加**、不是替换：warn 仍在（文件日志 + UI 双通道）
    expect(logWarn).toHaveBeenCalledWith(
      'agent-to-agent mention limit filtered',
      expect.objectContaining({ traceId: 'trace-quota', skippedCount: 1 })
    )
    // 被拦目标确实没被派发
    expect(
      getDb().prepare(`SELECT * FROM execution_logs WHERE agent_id = 'agent-impl'`).get()
    ).toBeUndefined()
  }, 60000)

  it('配额拦截不落执行表：行数增量 = 发送者自身那一次执行（Z4）', async () => {
    makeAdapter({ chunks: ['⚠️建议修改\n\n@ds猫 请返工'] })
    const { bus } = createFakeBus()
    const engine = createExecutionEngine(bus)
    engine.__setMentionCount('trace-quota-rows', 'agent-impl', DEFAULT_MAX_MENTIONS_PER_AGENT)

    const countRows = (): number =>
      (getDb().prepare(`SELECT COUNT(*) AS n FROM execution_logs`).get() as { n: number }).n
    const before = countRows()

    await engine.executeAgentsSerial(
      'session-1',
      [REVIEWER],
      { id: 'msg-1', content: '请审查', mentions: [] },
      'trace-quota-rows',
      0
    )

    // 拦截本身零执行记录：增量只来自发送者自己那一次运行（被拦的 A2A 目标没有行）。
    // 落表会污染「是否被派发」的判据——`execution_logs` 两列语义相反，
    // `triggered_by_message_id` 才是判据面（票面契约③）。
    expect(countRows() - before).toBe(1)
  }, 60000)

  it('会话内无 store 成员 → 只发发送者提示，不发 store 广播（不崩、不空投）', async () => {
    getDb()
      .prepare(`UPDATE sessions SET agent_ids = ? WHERE id = 'session-1'`)
      .run(JSON.stringify(['agent-reviewer', 'agent-impl']))
    makeAdapter({ chunks: ['⚠️建议修改\n\n@ds猫 请返工'] })
    const { bus, calls } = createFakeBus()
    const engine = createExecutionEngine(bus)
    engine.__setMentionCount('trace-quota-nostore', 'agent-impl', DEFAULT_MAX_MENTIONS_PER_AGENT)

    await engine.executeAgentsSerial(
      'session-1',
      [REVIEWER],
      { id: 'msg-1', content: '请审查', mentions: [] },
      'trace-quota-nostore',
      0
    )

    expect(calls.systemNotices.filter((n) => n.content.includes('未派发'))).toHaveLength(1)
    expect(calls.systemNotices.filter((n) => n.content.includes('悬空'))).toHaveLength(0)
  }, 60000)

  it('发送者本身是 store → 提示自己但不给自己发 store 广播（同 role-not-allowed 口径）', async () => {
    makeAdapter({ chunks: ['@ds猫 继续'] })
    const { bus, calls } = createFakeBus()
    const engine = createExecutionEngine(bus)
    engine.__setMentionCount('trace-quota-self', 'agent-impl', DEFAULT_MAX_MENTIONS_PER_AGENT)

    await engine.executeAgentsSerial(
      'session-1',
      [STORE],
      { id: 'msg-1', content: '请继续', mentions: [] },
      'trace-quota-self',
      0
    )

    // 两条通知的收件人都是 agent-store，故按**文案**区分（发送者提示含「未派发」，
    // store 广播含「悬空」）——只发前者。
    const toStore = calls.systemNotices.filter((n) => n.agentId === 'agent-store')
    expect(toStore).toHaveLength(1)
    expect(toStore[0].content).toContain('未派发')
    expect(toStore[0].content).not.toContain('悬空')
  }, 60000)
})

// ═══ T-M：depth=0 自动提交的「歧义拒写」可观测面 ═══
// `execution/serial.ts` 的 depth=0 收尾块在 `updateExecutionLogCommitHash` 回报
// `skippedAmbiguous` 时打 warn——这条 warn 是「拒写」唯一的可观测面（不静默拦截正是
// T-K 治的形态）。此前**零覆盖**：`gitCommit` mock 恒返 undefined ⇒ 整个收尾块不执行，
// 拒写分支与 warn 从未被跑过（T-M 实测裁定的那半段等于没钉子）。

describe('serial — T-M 自动提交歧义拒写（可观测面）', () => {
  const TRIGGER = 'msg-tm'
  const TRACE = 'trace-tm'

  function seedBase(): void {
    const db = getDb()
    const addAgent = (id: string, name: string) =>
      db
        .prepare(
          `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
           VALUES (?, ?, '🐱', 'You are a cat.', 'deepseek', 'deepseek-v4-pro', 'sk-test')`
        )
        .run(id, name)
    addAgent('agent-1', '店长')
    addAgent('agent-2', 'ds猫')
    db.prepare(
      `INSERT INTO sessions (id, title, agent_ids, broadcast_mode)
       VALUES ('session-1', '测试会话', '["agent-1"]', 0)`
    ).run()
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, mentions)
       VALUES (?, 'session-1', 'user', '你好', '[]')`
    ).run(TRIGGER)
  }

  /** 该触发消息下已写了 commit_hash 的行数（拒写 ⇒ 0；照写 ⇒ >0） */
  function writtenRows(): number {
    const r = getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM execution_logs
         WHERE triggered_by_message_id = ? AND commit_hash IS NOT NULL`
      )
      .get(TRIGGER) as { n: number }
    return r.n
  }

  beforeEach(() => {
    vi.clearAllMocks()
    __test_reset()
    const db = createTestDb()
    setDb(db)
    initRepository(db)
    seedBase()
  })

  afterEach(() => {
    resetDb()
  })

  it('同 uuid 跨猫执行行 → 拒写 + warn（commit_hash 全留空）；旧实现无此日志、必红', async () => {
    makeAdapter()
    vi.mocked(gitCommit).mockReturnValue('cafe1234567890abcdef')
    // T-1 Phase 2：① 只在 `ensureSessionWorktree` 给出路径时才调 `gitCommit`——
    // 不给路径则「本轮无提交」，下面的写回分支根本走不到，断言会变成空转
    vi.mocked(ensureAgentWorktree).mockReturnValue('/tmp/catStudy-sessions/wt-tm')
    const { bus } = createFakeBus()
    const engine = createExecutionEngine(bus)
    // 同一触发消息下已有**另一只猫**的执行行 ⇒ distinctAgentCount=2 ⇒ 消歧失败
    // （正是 b365ee9b/486f79ab 同 uuid 双猫那条实测形态的最小复现）
    getDb()
      .prepare(
        `INSERT INTO execution_logs
           (id, session_id, agent_id, triggered_by_message_id, status, trace_id, started_at)
         VALUES ('log-other-cat', 'session-1', 'agent-2', ?, 'completed', ?, '2026-09-10 10:00:00')`
      )
      .run(TRIGGER, TRACE)

    await engine.executeAgentsSerial(
      'session-1',
      [DEFAULT_AGENT],
      { id: TRIGGER, content: '你好', mentions: [] },
      TRACE,
      0
    )

    expect(logWarn).toHaveBeenCalledWith(
      'auto-commit hash not written back — executor ambiguous',
      expect.objectContaining({
        traceId: TRACE,
        triggerMessageId: TRIGGER,
        commitHash: 'cafe1234567890abcdef',
        writtenRows: 0,
      })
    )
    // 拒写落点：归属留空（读侧反查返 undefined → 调用方兜底 @店长），不制造"看似精确"的错归属
    expect(writtenRows()).toBe(0)
  })

  it('单猫轮次 → 照写 + 无 warn（阴性对照：warn 不得恒发）', async () => {
    makeAdapter()
    vi.mocked(gitCommit).mockReturnValue('cafe1234567890abcdef')
    // 同上：① 需 `ensureSessionWorktree` 给出路径才会真提交
    vi.mocked(ensureAgentWorktree).mockReturnValue('/tmp/catStudy-sessions/wt-tm1')
    const { bus } = createFakeBus()
    const engine = createExecutionEngine(bus)

    await engine.executeAgentsSerial(
      'session-1',
      [DEFAULT_AGENT],
      { id: TRIGGER, content: '你好', mentions: [] },
      TRACE,
      0
    )

    expect(logWarn).not.toHaveBeenCalledWith(
      'auto-commit hash not written back — executor ambiguous',
      expect.anything()
    )
    expect(writtenRows()).toBeGreaterThan(0)
  })
})

// ═══ ProviderTokenPool 死锁根治（A 方案：token 只包 LLM 段） ═══
// 事故（2026-09-09 09:48:23）：executeRun 从 acquire 持 token 到整棵 A2A 子树结束
// 才在 finally 释放，而 A2A 派发是 await 嵌套子执行 → 父持 token 等子、子等 token。
// 链深 ≥ cap 时第 cap+1 跳永久互等（cap=8 → 第 9 跳），日志静默 7m47s。
// 本组用例是行为级钉子：旧实现下 ①⑦⑧ 会在 token 池上互等直到 vitest 超时。

describe('serial — token 作用域收窄（A 方案死锁根治）', () => {
  const STORE: AgentConfig = {
    id: 'agent-store',
    name: '店长',
    avatar: '🐱',
    systemPrompt: 'S_MARK',
    llmProvider: 'deepseek',
    llmModel: 'deepseek-v4-pro',
    llmApiKey: 'sk-test',
    role: 'store',
  }
  const REVIEWER: AgentConfig = {
    id: 'agent-reviewer',
    name: '吐槽猫',
    avatar: '🐱',
    systemPrompt: 'R_MARK',
    llmProvider: 'deepseek',
    llmModel: 'deepseek-v4-pro',
    llmApiKey: 'sk-test',
    role: 'reviewer',
  }
  const IMPL: AgentConfig = {
    id: 'agent-impl',
    name: 'ds猫',
    avatar: '🐱',
    systemPrompt: 'I_MARK',
    llmProvider: 'deepseek',
    llmModel: 'deepseek-v4-pro',
    llmApiKey: 'sk-test',
    role: 'implementer',
  }
  const IMPL2: AgentConfig = {
    id: 'agent-impl2',
    name: 'flash猫',
    avatar: '🐱',
    systemPrompt: 'I2_MARK',
    llmProvider: 'deepseek',
    llmModel: 'deepseek-v4-pro',
    llmApiKey: 'sk-test',
    role: 'implementer',
  }

  const POOL_KEY = 'deepseek:sk-test'

  beforeEach(() => {
    vi.clearAllMocks()
    __test_reset()
    const db = createTestDb()
    setDb(db)
    initRepository(db)
    const insert = db.prepare(
      `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
       VALUES (?, ?, '🐱', ?, 'deepseek', 'deepseek-v4-pro', 'sk-test', ?)`
    )
    insert.run(STORE.id, STORE.name, STORE.systemPrompt, 'store')
    insert.run(REVIEWER.id, REVIEWER.name, REVIEWER.systemPrompt, 'reviewer')
    insert.run(IMPL.id, IMPL.name, IMPL.systemPrompt, 'implementer')
    insert.run(IMPL2.id, IMPL2.name, IMPL2.systemPrompt, 'implementer')
    db.prepare(
      `INSERT INTO sessions (id, title, agent_ids, broadcast_mode)
       VALUES ('session-1', '测试会话', ?, 0)`
    ).run(JSON.stringify([STORE.id, REVIEWER.id, IMPL.id, IMPL2.id]))
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, mentions)
       VALUES ('msg-1', 'session-1', 'user', '请审查', '[]')`
    ).run()
  })

  afterEach(() => {
    resetDb()
    vi.unstubAllEnvs()
  })

  /** 按 system prompt 标记分派回复——并发批内无法靠调用序号区分 agent */
  function makeMarkedAdapter(): ReturnType<typeof vi.fn> {
    const chatStream = vi.fn(async function* (messages: Array<{ content?: string }>) {
      const sys = String(messages?.[0]?.content ?? '')
      if (sys.includes('S_MARK')) yield { content: '@flash猫 继续', kind: 'text' }
      else if (sys.includes('R_MARK')) yield { content: '@ds猫 继续', kind: 'text' }
      else yield { content: '收到', kind: 'text' }
    })
    vi.mocked(getAdapterForAgent).mockReturnValue({ chatStream } as any)
    return chatStream
  }

  const logsOf = (): any[] =>
    getDb()
      .prepare(`SELECT agent_id, status FROM execution_logs ORDER BY started_at, rowid`)
      .all() as any[]

  it('① 死锁回归钉子：cap=1 下父执行 A2A 派发子执行 → 两者都 completed', async () => {
    vi.stubEnv('PROVIDER_TOKEN_CAP', '1')
    const chatStream = makeMarkedAdapter()
    const { bus, calls } = createFakeBus()
    const engine = createExecutionEngine(bus)

    await engine.executeAgentsSerial(
      'session-1',
      [REVIEWER],
      { id: 'msg-1', content: '请审查', mentions: [] },
      'trace-deadlock',
      0
    )

    // 旧实现：父持 token 等子、子等 token → 本用例在 vitest 超时处失败
    expect(chatStream).toHaveBeenCalledTimes(2)
    const logs = logsOf()
    expect(logs.map((l) => l.agent_id)).toEqual([REVIEWER.id, IMPL.id])
    expect(logs.every((l) => l.status === 'completed')).toBe(true)
    // 父子各落一条回复（A2A 链真实跑完）
    expect(calls.agentMessages).toHaveLength(2)
    expect(engine.getSlot(IMPL.id, 'session-1')).toMatchObject({ status: 'idle' })
  }, 20000)

  it('③ 作用域断言：子执行 acquire 时该 key 在飞数为 0（旧实现为 1）', async () => {
    const origAcquire = ProviderTokenPool.prototype.acquire
    const observed: number[] = []
    const spy = vi.spyOn(ProviderTokenPool.prototype, 'acquire').mockImplementation(function (
      this: ProviderTokenPool,
      key: string
    ) {
      observed.push(this.activeCount(key))
      return origAcquire.call(this, key)
    })
    try {
      makeMarkedAdapter()
      const { bus } = createFakeBus()
      const engine = createExecutionEngine(bus)

      await engine.executeAgentsSerial(
        'session-1',
        [REVIEWER],
        { id: 'msg-1', content: '请审查', mentions: [] },
        'trace-scope',
        0
      )

      // 父 acquire 时 0、子 acquire 时也是 0——编排段（A2A 派发）不持 token。
      // 旧实现：父的 executeRun 持 token 到子树结束 → 子 acquire 时观测到 1。
      expect(observed).toEqual([0, 0])
      expect(engine.__getTokenActiveCount(POOL_KEY)).toBe(0)
    } finally {
      spy.mockRestore()
    }
  }, 20000)

  it('⑦ 多链并发：cap=2 下两条独立 A2A 链同时执行 → 全部 completed，无队头阻塞', async () => {
    vi.stubEnv('PROVIDER_TOKEN_CAP', '2')
    const chatStream = makeMarkedAdapter()
    const { bus } = createFakeBus()
    const engine = createExecutionEngine(bus)

    await engine.executeAgentsSerial(
      'session-1',
      [STORE, REVIEWER],
      { id: 'msg-1', content: '请审查', mentions: [] },
      'trace-multi',
      0
    )

    // 4 个节点（2 父 + 2 子）全跑完：cap=2 恰好被两条父链占满，旧实现下子链
    // acquire 会永久等待（父链都在 await 子链）
    expect(chatStream).toHaveBeenCalledTimes(4)
    const logs = logsOf()
    expect(new Set(logs.map((l) => l.agent_id)).size).toBe(4)
    expect(logs.every((l) => l.status === 'completed')).toBe(true)
    expect(engine.__getTokenActiveCount(POOL_KEY)).toBe(0)
  }, 20000)

  it('⑧ drain 占位断言：出队命令自行 acquire，父已释放（LLM 段外 activeCount=0）', async () => {
    vi.stubEnv('PROVIDER_TOKEN_CAP', '1')
    const origAcquire = ProviderTokenPool.prototype.acquire
    const observed: number[] = []
    const spy = vi.spyOn(ProviderTokenPool.prototype, 'acquire').mockImplementation(function (
      this: ProviderTokenPool,
      key: string
    ) {
      observed.push(this.activeCount(key))
      return origAcquire.call(this, key)
    })
    try {
      const chatStream = makeAdapter()
      const { bus } = createFakeBus()
      const engine = createExecutionEngine(bus)
      const db = getDb()
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions)
         VALUES ('msg-d1', 'session-1', 'user', '一', '[]')`
      ).run()
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions)
         VALUES ('msg-d2', 'session-1', 'user', '二', '[]')`
      ).run()
      const cmd = (triggerMessageId: string): DispatchCommand => ({
        sessionId: 'session-1',
        agentId: IMPL.id,
        triggerMessageId,
        triggerContent: '你好',
        mentions: [],
        traceId: 'trace-drain',
        depth: 0,
        pendingTriggers: [],
      })

      const p1 = engine.execute(cmd('msg-d1'))
      const p2 = engine.execute(cmd('msg-d2')) // 槽位已 busy → 入队
      await Promise.all([p1, p2])

      // 两条命令各自 acquire 一次，且 acquire 时在飞数均为 0——编排段（finalize/
      // drain）不持 token。旧实现：父在 executeRun 持 token 到子树结束、drain 不
      // acquire（rides 父锁）→ 观测只有 1 次且 cap=1 下第二条永久互等。
      expect(chatStream).toHaveBeenCalledTimes(2)
      expect(observed).toEqual([0, 0])
      expect(engine.__getTokenActiveCount(POOL_KEY)).toBe(0)
      const logs = logsOf()
      expect(logs.map((l) => l.status)).toEqual(['completed', 'completed'])
    } finally {
      spy.mockRestore()
    }
  }, 20000)
})

describe('serial — mentions 写回时机（P0：不依赖 drain/A2A await）', () => {
  const STORE: AgentConfig = {
    id: 'agent-store',
    name: '店长',
    avatar: '🐱',
    systemPrompt: 'S_MARK',
    llmProvider: 'deepseek',
    llmModel: 'deepseek-v4-pro',
    llmApiKey: 'sk-test',
    role: 'store',
  }
  const REVIEWER: AgentConfig = {
    id: 'agent-reviewer',
    name: '吐槽猫',
    avatar: '🐱',
    systemPrompt: 'R_MARK',
    llmProvider: 'deepseek',
    llmModel: 'deepseek-v4-pro',
    llmApiKey: 'sk-test',
    role: 'reviewer',
  }
  const IMPL2: AgentConfig = {
    id: 'agent-impl2',
    name: 'flash猫',
    avatar: '🐱',
    systemPrompt: 'I2_MARK',
    llmProvider: 'deepseek',
    llmModel: 'deepseek-v4-pro',
    llmApiKey: 'sk-test',
    role: 'implementer',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    __test_reset()
    const db = createTestDb()
    setDb(db)
    initRepository(db)
    const insert = db.prepare(
      `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
       VALUES (?, ?, '🐱', ?, 'deepseek', 'deepseek-v4-pro', 'sk-test', ?)`
    )
    insert.run(STORE.id, STORE.name, STORE.systemPrompt, 'store')
    insert.run(REVIEWER.id, REVIEWER.name, REVIEWER.systemPrompt, 'reviewer')
    insert.run(IMPL2.id, IMPL2.name, IMPL2.systemPrompt, 'implementer')
    db.prepare(
      `INSERT INTO sessions (id, title, agent_ids, broadcast_mode)
       VALUES ('session-1', '测试会话', ?, 0)`
    ).run(JSON.stringify([STORE.id, REVIEWER.id, IMPL2.id]))
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, mentions)
       VALUES ('msg-1', 'session-1', 'user', '请审查', '[]')`
    ).run()
  })

  afterEach(() => {
    resetDb()
    vi.unstubAllEnvs()
  })

  /** 该 agent 最早一条回复的 mentions 列 */
  const mentionsOf = (agentId: string): string[] => {
    const row = getDb()
      .prepare(`SELECT mentions FROM messages WHERE role='agent' AND agent_id=? ORDER BY rowid`)
      .get(agentId) as any
    return row ? JSON.parse(row.mentions) : []
  }

  it('① 写回不依赖 drain：嵌套执行未完成时，父回复的 mentions 已落库', async () => {
    // 场景：父执行（reviewer）回复 @flash猫，同时自己槽位上排了第二条命令 →
    // completeExecution 弹出 → drain 嵌套执行。旧实现的写回点排在 drain 之后，
    // 父执行卡在 drain 期间该消息 mentions 仍为 '[]'（链一断即永久丢失——
    // 实证 7daf017c / 163a981f / 1b1e33c5 至今为空）。
    let nestedStarted!: () => void
    const nestedStartedP = new Promise<void>((r) => (nestedStarted = r))
    let releaseNested!: () => void
    const releaseNestedP = new Promise<void>((r) => (releaseNested = r))
    let call = 0
    const chatStream = vi.fn(async function* () {
      call++
      if (call === 1) {
        yield { content: '@flash猫 继续', kind: 'text' }
      } else {
        nestedStarted()
        await releaseNestedP
        yield { content: '收到', kind: 'text' }
      }
    })
    vi.mocked(getAdapterForAgent).mockReturnValue({ chatStream } as any)
    const { bus } = createFakeBus()
    const engine = createExecutionEngine(bus)
    const db = getDb()
    for (const id of ['msg-p1', 'msg-p2']) {
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions)
         VALUES (?, 'session-1', 'user', '请审查', '[]')`
      ).run(id)
    }
    const cmd = (triggerMessageId: string): DispatchCommand => ({
      sessionId: 'session-1',
      agentId: REVIEWER.id,
      triggerMessageId,
      triggerContent: '请审查',
      mentions: [],
      traceId: 'trace-p0-writeback',
      depth: 0,
      pendingTriggers: [],
    })

    const p1 = engine.execute(cmd('msg-p1'))
    const p2 = engine.execute(cmd('msg-p2')) // 槽位 busy → 入队
    await nestedStartedP // 父执行已进入 drain，嵌套执行挂起

    // 旧实现：写回排在 drain 之后 → 此刻为 []
    expect(mentionsOf(REVIEWER.id)).toEqual([IMPL2.name])

    releaseNested()
    await Promise.all([p1, p2])
    // 编排段收场后仍非空（写回不被后续 drain 覆盖或清除）
    expect(mentionsOf(REVIEWER.id)).toEqual([IMPL2.name])
  }, 20000)

  it('② 父执行异常中断：写回已落库，不随编排段异常丢失', async () => {
    // 旧实现：maybeScoreSample（finalizeRun 之后、写回点之前）抛错 → 进 catch →
    // 写回点永不执行，该回复 mentions 永久为 '[]'。
    // 新实现：写回在 finalizeRun/编排段之前，异常路径照样保留。
    makeAdapter({ chunks: ['@flash猫 继续'] })
    vi.mocked(maybeScoreSample).mockImplementationOnce(() => {
      throw new Error('boom: post-execution error')
    })
    const { bus } = createFakeBus()
    const engine = createExecutionEngine(bus)

    await engine.executeAgentsSerial(
      'session-1',
      [REVIEWER],
      { id: 'msg-1', content: '请审查', mentions: [] },
      'trace-p0-ex',
      0
    )

    expect(mentionsOf(REVIEWER.id)).toEqual([IMPL2.name])
  }, 20000)
})

describe('serial — 形态 D：drain 与 A2A 派发并发（票 dispatch-deferral §五-2）', () => {
  const REVIEWER: AgentConfig = {
    id: 'agent-reviewer',
    name: '吐槽猫',
    avatar: '🐱',
    systemPrompt: 'R_MARK',
    llmProvider: 'deepseek',
    llmModel: 'deepseek-v4-pro',
    llmApiKey: 'sk-test',
    role: 'reviewer',
  }
  const IMPL2: AgentConfig = {
    id: 'agent-impl2',
    name: 'flash猫',
    avatar: '🐱',
    systemPrompt: 'I2_MARK',
    llmProvider: 'deepseek',
    llmModel: 'deepseek-v4-pro',
    llmApiKey: 'sk-test',
    role: 'implementer',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    __test_reset()
    const db = createTestDb()
    setDb(db)
    initRepository(db)
    const insert = db.prepare(
      `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
       VALUES (?, ?, '🐱', ?, 'deepseek', 'deepseek-v4-pro', 'sk-test', ?)`
    )
    insert.run(REVIEWER.id, REVIEWER.name, REVIEWER.systemPrompt, 'reviewer')
    insert.run(IMPL2.id, IMPL2.name, IMPL2.systemPrompt, 'implementer')
    db.prepare(
      `INSERT INTO sessions (id, title, agent_ids, broadcast_mode)
       VALUES ('session-1', '测试会话', ?, 0)`
    ).run(JSON.stringify([REVIEWER.id, IMPL2.id]))
    for (const id of ['msg-d1', 'msg-d2']) {
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions)
         VALUES (?, 'session-1', 'user', '请审查', '[]')`
      ).run(id)
    }
  })

  afterEach(() => {
    resetDb()
    vi.unstubAllEnvs()
  })

  const cmd = (triggerMessageId: string): DispatchCommand => ({
    sessionId: 'session-1',
    agentId: REVIEWER.id,
    triggerMessageId,
    triggerContent: '请审查',
    mentions: [],
    traceId: 'trace-form-d',
    depth: 0,
    pendingTriggers: [],
  })

  /** 竞速：`p` 决出即 true；超时 false —— 用于「另一侧理应发生」的判定 */
  const settlesWithin = (p: Promise<void>, ms = 1000): Promise<boolean> =>
    Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))])

  it('V5 并发（主判据）：drain 子树挂起期间，A2A 目标已开跑（派发不等待 drain）', async () => {
    // 构造（票面 §四-V1/V5）：执行者（reviewer）本轮回复 @flash猫，同时自己槽位上
    // 排了第二条命令 ⇒ completeExecution 弹出 → drain。闸门挂住 **drain**，观察 A2A 目标。
    // 形态 D：两子树并发 ⇒ 闸门未放行时目标已开跑。
    // 反向对照（串行实现 `claudeRan = await drainQueuedCommand(...)`）：目标在放行前
    //   **零**次 chatStream 调用 ⇒ 本格变红（读数见报告 §V5「先红后绿」）。
    vi.stubEnv('PROVIDER_TOKEN_CAP', '4') // 两子树并发各持一 token（默认 2 恰好够，显式抬高防脆）
    let nestedStarted!: () => void
    const nestedStartedP = new Promise<void>((r) => (nestedStarted = r))
    let releaseNested!: () => void
    const releaseNestedP = new Promise<void>((r) => (releaseNested = r))
    let targetStarted!: () => void
    const targetStartedP = new Promise<void>((r) => (targetStarted = r))
    let parentRuns = 0
    let targetRuns = 0
    const chatStream = vi.fn(async function* (messages: Array<{ content?: string }>) {
      const sys = String(messages?.[0]?.content ?? '')
      if (sys.includes('I2_MARK')) {
        targetRuns++
        targetStarted()
        yield { content: '收到', kind: 'text' }
        return
      }
      parentRuns++
      if (parentRuns === 1) {
        yield { content: '@flash猫 继续', kind: 'text' }
        return
      }
      nestedStarted() // 排队命令（drain）已开跑——闸门在此挂住，直到 releaseNested
      await releaseNestedP
      yield { content: '收到', kind: 'text' }
    })
    vi.mocked(getAdapterForAgent).mockReturnValue({ chatStream } as any)
    const { bus } = createFakeBus()
    const engine = createExecutionEngine(bus)

    const p1 = engine.execute(cmd('msg-d1'))
    const p2 = engine.execute(cmd('msg-d2')) // 槽位 busy → 入队
    await nestedStartedP // 父执行已进入 drain，且 drain 被闸门挂住

    // ★ 断言取在闸门内：串行实现此处恒 false（这正是本格要钉的差）
    expect(await settlesWithin(targetStartedP)).toBe(true)
    expect(targetRuns).toBe(1)

    releaseNested()
    await Promise.all([p1, p2])
    expect(targetRuns).toBe(1) // 放行后不重复派发
    expect(parentRuns).toBe(2) // 父执行 + 被 drain 的排队命令各一次
  }, 20000)

  it('V3 不回归：A2A 子树挂起期间，排队命令已开跑（drain 不干等 A2A）', async () => {
    // 镜像格：闸门改挂 **A2A 目标**，观察排队命令。挡的是候选 B/C 那类「把派发挪到
    // drain 之前」的反向实现——那种实现下排队命令干等 A2A 嵌套链（d448413a：5.9 分钟干挂）。
    // ⚠️ 覆盖边界（不许当已证）：**本格不区分 D 与串行原实现**——串行下 drain 本就在前，
    //    同样绿。它是非回归守卫，判别 D 的是 V5。
    vi.stubEnv('PROVIDER_TOKEN_CAP', '4')
    let targetStarted!: () => void
    const targetStartedP = new Promise<void>((r) => (targetStarted = r))
    let releaseTarget!: () => void
    const releaseTargetP = new Promise<void>((r) => (releaseTarget = r))
    let queuedStarted!: () => void
    const queuedStartedP = new Promise<void>((r) => (queuedStarted = r))
    let parentRuns = 0
    const chatStream = vi.fn(async function* (messages: Array<{ content?: string }>) {
      const sys = String(messages?.[0]?.content ?? '')
      if (sys.includes('I2_MARK')) {
        targetStarted()
        await releaseTargetP // A2A 目标长跑（模拟 d448413a 的嵌套链）
        yield { content: '收到', kind: 'text' }
        return
      }
      parentRuns++
      if (parentRuns === 1) {
        yield { content: '@flash猫 继续', kind: 'text' }
        return
      }
      queuedStarted() // 排队命令（drain）已开跑
      yield { content: '收到', kind: 'text' }
    })
    vi.mocked(getAdapterForAgent).mockReturnValue({ chatStream } as any)
    const { bus } = createFakeBus()
    const engine = createExecutionEngine(bus)

    const p1 = engine.execute(cmd('msg-d1'))
    const p2 = engine.execute(cmd('msg-d2'))
    await targetStartedP // A2A 子树已开跑且被闸门挂住

    expect(await settlesWithin(queuedStartedP)).toBe(true)

    releaseTarget()
    await Promise.all([p1, p2])
    expect(parentRuns).toBe(2)
  }, 20000)
})
