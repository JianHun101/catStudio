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
import { maybeScoreSample } from '../eval/sampler.js'
import type { ExecutionEngine, ExecutionEngineTestHooks } from './serial.js'
import type { EngineBus, HandoffBus } from './bus.js'

// ═══ 边界 mock（真实 dispatch / SQLite / 纯函数保留） ═══

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

vi.mock('../handoff/index.js', () => ({
  shouldHandoff: vi.fn(() => false),
  performHandoff: vi.fn().mockResolvedValue(undefined),
  injectSummaryIntoSystem: vi.fn((s: string) => s),
  generateFullSummary: vi.fn(),
}))

vi.mock('../git/diff-collector.js', () => ({
  collectCommitDiffs: vi.fn().mockResolvedValue(null),
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

  it('mention 配额跨 run 存活（engine 级字段），顶层收尾按 trace 清空', async () => {
    makeAdapter()
    const { bus } = createFakeBus()
    const engine = createExecutionEngine(bus)

    // depth=1（A2A 链）执行两次同 trace → 计数跨 run 累加
    await runPaired(engine, 'msg-p1', 'trace-persist', 1)
    expect(engine.__getMentionCount('trace-persist', 'agent-1')).toBe(1)
    await runPaired(engine, 'msg-p2', 'trace-persist', 1)
    expect(engine.__getMentionCount('trace-persist', 'agent-1')).toBe(2)
    // depth=0 顶层收尾 → 该 trace 配额清空（防无限循环计数泄漏）
    await runPaired(engine, 'msg-p3', 'trace-persist', 0)
    expect(engine.__getMentionCount('trace-persist', 'agent-1')).toBe(0)
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
    // reviewer（发送者）+ store（兜底收件人）+ vision（被拦目标）
    const insert = db.prepare(
      `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
       VALUES (?, ?, '🐱', 'You are a cat.', 'deepseek', 'deepseek-v4-pro', 'sk-test', ?)`
    )
    insert.run('agent-reviewer', '吐槽猫', 'reviewer')
    insert.run('agent-store', '店长', 'store')
    insert.run('agent-vision', '图测猫', 'vision')
    db.prepare(
      `INSERT INTO sessions (id, title, agent_ids, broadcast_mode)
       VALUES ('session-1', '测试会话', '["agent-reviewer","agent-store","agent-vision"]', 0)`
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

  it('reviewer @ 图测猫（被拦）→ 提示发送者 + store 猫收到 UI 提示（人类可见，不进 agent 上下文）', async () => {
    makeAdapter({ chunks: ['⚠️建议修改\n\n@图测猫 请看看'] })
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
    expect(toStore[0].content).toContain('图测猫')
    expect(toStore[0].content).toContain('悬空')
    // ③ 被拦目标未被路由（无 A2A 子链）
    const visionLog = getDb()
      .prepare(`SELECT * FROM execution_logs WHERE agent_id = 'agent-vision'`)
      .get()
    expect(visionLog).toBeUndefined()
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

  it('reviewer↔implementer 互 @ 成环 → mention 配额截断，不无限递归（派活单实测项）', async () => {
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
      JSON.stringify(['agent-reviewer', 'agent-store', 'agent-vision', 'agent-impl'])
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

    // 环被截断而非无限：截断者是 **mention 配额**（MAX_MENTIONS_PER_AGENT=5，
    // serial.ts:678 调度点预留 + :498 执行后计数双计），**不是 depth=10 门**——
    // 实测第 8 跳 ds猫 被 `agent-to-agent mention limit filtered` 拦下，此时
    // depth 仅 6，远未触门。护栏作用在 policy.allowed 之后——补边不放宽风暴防护。
    expect(chatStream.mock.calls.length).toBeGreaterThan(1) // 环确实转起来了
    expect(chatStream.mock.calls.length).toBe(7)
  }, 60000)
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
