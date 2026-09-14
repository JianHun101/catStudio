/**
 * dispatch/index.ts（C1 v3 重构后）——模块级槽位状态已收进 engine 闭包。
 *
 * 本文件测试调度决策行为（原 dispatch 模块测试迁入）：FIFO 队列 / dispatch_state
 * 持久化 / B 触发合并 / 队列上限 / stale handoff / OQ1 完成路径守卫 /
 * 撤回停止（cancel/clear/isAny）/ disposeSession。全部经 engine.execute 单入口
 * 驱动（决策(直跑/入队)→token→执行→finally），配合假 bus + 受控适配器。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentConfig, DispatchCommand, Message } from '@cat-study/shared'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository } from '../db/repository/index.js'
import { createExecutionEngine } from '../execution/serial.js'
import type { ExecutionEngine } from '../execution/serial.js'
import type { EngineBus, HandoffBus } from '../execution/bus.js'
import { getAdapterForAgent } from '../llm/registry.js'
import { isStaleHandoffRequest } from './index.js'

// Mock LLM registry（测试只打边界）
vi.mock('../llm/registry.js', () => ({
  getAdapterForAgent: vi.fn(),
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
}))

vi.mock('../eval/sampler.js', () => ({ maybeScoreSample: vi.fn() }))
vi.mock('../eval/verdict-parser.js', () => ({ recordReviewVerdict: vi.fn() }))
vi.mock('../llm/route-signals.js', () => ({ consumeRouteSignals: vi.fn(() => []) }))

// 顶层收尾的脏文件清理用真实 execSync 会命中真实仓库——恒返回空串
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execSync: vi.fn(() => '') }
})

const DEFAULT_AGENT: AgentConfig = {
  id: 'agent-1',
  name: '店长',
  avatar: '🐱',
  systemPrompt: 'You are a cat.',
  llmProvider: 'deepseek',
  llmModel: 'deepseek-v4-pro',
  llmApiKey: 'sk-test',
}
const DEFAULT_AGENT2: AgentConfig = { ...DEFAULT_AGENT, id: 'agent-2', name: 'ds猫' }

function makeMessage(overrides?: Partial<Message>): Message {
  return {
    id: 'msg-1',
    sessionId: 'session-1',
    agentId: null,
    role: 'user',
    content: '你好',
    mentions: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

/** 受控适配器：默认立即产出「收到」；flow.gate 可暂停（busy 期间入队测试） */
function makeAdapter(flow?: { chunks?: string[]; gate?: Promise<void> }) {
  const chatStream = vi.fn(async function* () {
    const chunks = flow?.chunks ?? ['收到']
    for (const c of chunks) {
      yield { content: c, kind: 'text' }
      if (flow?.gate) await flow.gate
    }
  })
  vi.mocked(getAdapterForAgent).mockReturnValue({ chatStream } as any)
  return chatStream
}

function createFakeBus(): { bus: EngineBus & HandoffBus; calls: { agentMessages: Message[] } } {
  const calls: { agentMessages: Message[] } = { agentMessages: [] }
  const bus: EngineBus & HandoffBus = {
    emitMessage: (m) => calls.agentMessages.push(m),
    emitSystemNotice: () => {},
    emitTyping: () => {},
    emitAgentMessageStatus: () => {},
    emitMessageUpdated: () => {},
    emitContextWindowStats: () => {},
    emitSessionHandoff: () => {},
    emitHandoffFailed: () => {},
  }
  return { bus, calls }
}

/** 落库一条用户消息（dispatch_state 默认 NULL） */
function insertUserMsg(id: string, sessionId = 'session-1', mentions = '[]'): void {
  getDb()
    .prepare(
      `INSERT INTO messages (id, session_id, role, content, mentions)
       VALUES (?, ?, 'user', '你好', ?)`
    )
    .run(id, sessionId, mentions)
}

function getDispatchState(msgId: string): string | null {
  const row = getDb().prepare('SELECT dispatch_state FROM messages WHERE id = ?').get(msgId) as {
    dispatch_state: string | null
  }
  return row?.dispatch_state ?? null
}

/** 读该触发消息的最新 execution_log 行 */
function getLog(triggerId: string): any {
  return getDb()
    .prepare(
      `SELECT * FROM execution_logs WHERE triggered_by_message_id = ? ORDER BY started_at DESC LIMIT 1`
    )
    .get(triggerId) as any
}

describe('dispatch（C1 v3 引擎决策行为）', () => {
  let engine: ExecutionEngine
  let bus: EngineBus & HandoffBus
  let calls: { agentMessages: Message[] }

  beforeEach(() => {
    vi.clearAllMocks()
    const db = createTestDb()
    setDb(db)
    initRepository(db)
    db.prepare(
      `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
       VALUES (?, ?, '🐱', 'You are a cat.', 'deepseek', 'deepseek-v4-pro', 'sk-test')`
    ).run('agent-1', '店长')
    db.prepare(
      `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
       VALUES (?, ?, '🐱', 'You are a cat.', 'deepseek', 'deepseek-v4-pro', 'sk-test')`
    ).run('agent-2', 'ds猫')
    db.prepare(
      `INSERT INTO sessions (id, title, agent_ids, broadcast_mode)
       VALUES ('session-1', '测试会话', '["agent-1","agent-2"]', 0)`
    ).run()
    db.prepare(
      `INSERT INTO sessions (id, title, agent_ids, broadcast_mode)
       VALUES ('session-2', '会话二', '["agent-1"]', 0)`
    ).run()
    const fb = createFakeBus()
    bus = fb.bus
    calls = fb.calls
    engine = createExecutionEngine(bus)
  })

  afterEach(() => {
    resetDb()
  })

  describe('execute 决策：idle 直跑 / busy 入队', () => {
    it('idle 槽位 → 标 busy + 执行（回复落库 + 槽位回 idle + running→done）', async () => {
      makeAdapter()
      insertUserMsg('msg-1')
      await engine.execute({
        sessionId: 'session-1',
        agentId: 'agent-1',
        triggerMessageId: 'msg-1',
        triggerContent: '你好',
        mentions: [],
        traceId: 'trace-1',
        depth: 0,
        pendingTriggers: [],
      })

      expect(calls.agentMessages).toHaveLength(1)
      expect(getDispatchState('msg-1')).toBe('done')
      expect(engine.getSlot('agent-1', 'session-1')).toMatchObject({ status: 'idle' })
      const log = getLog('msg-1')
      expect(log.status).toBe('completed')
    })

    it('busy 槽位 → 第二条命令入队（FIFO），第一条完成后排空执行', async () => {
      let release!: () => void
      const gate = new Promise<void>((r) => {
        release = r
      })
      // 首块后挂起——msg-1 保持 busy，msg-2 入队
      makeAdapter({ chunks: ['第一'], gate })
      insertUserMsg('msg-1')
      insertUserMsg('msg-2')

      const p1 = engine.execute({
        sessionId: 'session-1',
        agentId: 'agent-1',
        triggerMessageId: 'msg-1',
        triggerContent: '你好',
        mentions: [],
        traceId: 'trace-1',
        depth: 0,
        pendingTriggers: [],
      })
      await vi.waitFor(() => {
        expect(engine.getSlot('agent-1', 'session-1')?.status).toBe('busy')
      })
      // msg-2 到达 → 入队
      await engine.execute({
        sessionId: 'session-1',
        agentId: 'agent-1',
        triggerMessageId: 'msg-2',
        triggerContent: '你好',
        mentions: [],
        traceId: 'trace-1',
        depth: 0,
        pendingTriggers: [],
      })
      expect(engine.getSlot('agent-1', 'session-1')?.queueLength).toBe(1)
      expect(getDispatchState('msg-2')).toBe('queued')

      // 释放 gate → msg-1 完成 → 弹出 msg-2 执行
      release()
      await p1
      await vi.waitFor(() => {
        expect(calls.agentMessages.length).toBeGreaterThanOrEqual(2)
      })
      expect(engine.getSlot('agent-1', 'session-1')).toMatchObject({ status: 'idle' })
      expect(getDispatchState('msg-1')).toBe('done')
      expect(getDispatchState('msg-2')).toBe('done')
    })

    it('dispatches only to mentioned agents（mentions 过滤在调用方——ingest 算 targets）', async () => {
      makeAdapter()
      insertUserMsg('msg-1', 'session-1', '["店长"]')
      // C1 v3：过滤是调用方职责（ingest 只把被 @ 的 agent 传进来）——这里模拟 ingest
      // 已过滤后的列表（只传店长）
      await engine.executeAgentsSerial(
        'session-1',
        [DEFAULT_AGENT],
        { id: 'msg-1', content: '你好', mentions: ['店长'] },
        'trace-1',
        0
      )
      await vi.waitFor(() => {
        expect(getDispatchState('msg-1')).toBe('done')
      })
      // 只 agent-1 执行（agent-2 未被传入 → 无槽位活动）
      expect(getLog('msg-1').agent_id).toBe('agent-1')
      expect(engine.getSlot('agent-2', 'session-1')).toBeUndefined()
    })

    it('skips unknown agent gracefully', async () => {
      makeAdapter()
      insertUserMsg('msg-1')
      await engine.execute({
        sessionId: 'session-1',
        agentId: 'agent-ghost',
        triggerMessageId: 'msg-1',
        triggerContent: '你好',
        mentions: [],
        traceId: 'trace-1',
        depth: 0,
        pendingTriggers: [],
      })
      expect(getDispatchState('msg-1')).toBeNull() // 未知 agent 不落 running
    })
  })

  describe('execute 决策：跨会话同猫并行（agentId+sessionId 键控）', () => {
    it('会话 A、B 同时 @同一只猫 → 两条流并行、互不阻塞', async () => {
      const chatStream = vi.fn(async function* () {
        yield { content: 'A', kind: 'text' }
      })
      vi.mocked(getAdapterForAgent).mockReturnValue({ chatStream } as any)
      insertUserMsg('msg-a', 'session-1')
      insertUserMsg('msg-b', 'session-2')

      await Promise.all([
        engine.execute({
          sessionId: 'session-1',
          agentId: 'agent-1',
          triggerMessageId: 'msg-a',
          triggerContent: '你好',
          mentions: [],
          traceId: 'trace-a',
          depth: 0,
          pendingTriggers: [],
        }),
        engine.execute({
          sessionId: 'session-2',
          agentId: 'agent-1',
          triggerMessageId: 'msg-b',
          triggerContent: '你好',
          mentions: [],
          traceId: 'trace-b',
          depth: 0,
          pendingTriggers: [],
        }),
      ])

      // 两条独立槽位都执行完成
      expect(calls.agentMessages).toHaveLength(2)
      expect(getDispatchState('msg-a')).toBe('done')
      expect(getDispatchState('msg-b')).toBe('done')
    })
  })

  describe('execute 决策：B 触发合并（A2A 风暴治理）', () => {
    it('depth>0 且同 session 已有排队命令 → 不入队，并入 pendingTriggers', async () => {
      let release!: () => void
      const gate = new Promise<void>((r) => {
        release = r
      })
      makeAdapter({ chunks: ['第一'], gate })
      insertUserMsg('msg-1')
      insertUserMsg('msg-2')

      const p1 = engine.execute({
        sessionId: 'session-1',
        agentId: 'agent-1',
        triggerMessageId: 'msg-1',
        triggerContent: '你好',
        mentions: [],
        traceId: 'trace-1',
        depth: 0,
        pendingTriggers: [],
      })
      await vi.waitFor(() => {
        expect(engine.getSlot('agent-1', 'session-1')?.status).toBe('busy')
      })
      await engine.execute({
        sessionId: 'session-1',
        agentId: 'agent-1',
        triggerMessageId: 'msg-2',
        triggerContent: '你好',
        mentions: [],
        traceId: 'trace-1',
        depth: 0,
        pendingTriggers: [],
      })
      expect(engine.getSlot('agent-1', 'session-1')?.queueLength).toBe(1)

      // A2A 触发（depth=1）→ 并入排队中的 msg-2，不入队
      await engine.execute({
        sessionId: 'session-1',
        agentId: 'agent-1',
        triggerMessageId: 'msg-3',
        triggerContent: 'A2A',
        mentions: [],
        traceId: 'trace-a2a',
        depth: 1,
        pendingTriggers: [],
      })
      const slot = engine.getSlot('agent-1', 'session-1')!
      expect(slot.queueLength).toBe(1) // 未新增排队

      release()
      await p1
      // msg-1 完成后排空执行 msg-2（合并触发不静默蒸发——msg-2 照常执行）
      await vi.waitFor(() => {
        expect(calls.agentMessages.length).toBeGreaterThanOrEqual(2)
      })
      // 并入的触发在出队时注入 msg-2 的触发内容（执行日志可证——drain 段点名）
      expect(engine.getSlot('agent-1', 'session-1')).toMatchObject({ status: 'idle' })
      expect(getDispatchState('msg-2')).toBe('done')
    })

    it('不同 sessionId → 不合并，独立入队', async () => {
      let release!: () => void
      const gate = new Promise<void>((r) => {
        release = r
      })
      makeAdapter({ chunks: ['第一'], gate })
      insertUserMsg('msg-1')
      insertUserMsg('msg-2')

      const p1 = engine.execute({
        sessionId: 'session-1',
        agentId: 'agent-1',
        triggerMessageId: 'msg-1',
        triggerContent: '你好',
        mentions: [],
        traceId: 'trace-1',
        depth: 0,
        pendingTriggers: [],
      })
      await vi.waitFor(() => {
        expect(engine.getSlot('agent-1', 'session-1')?.status).toBe('busy')
      })
      await engine.execute({
        sessionId: 'session-1',
        agentId: 'agent-1',
        triggerMessageId: 'msg-2',
        triggerContent: '你好',
        mentions: [],
        traceId: 'trace-1',
        depth: 0,
        pendingTriggers: [],
      })

      // 另一会话 A2A 触发（depth=1）→ 队列里没有同 session 命令 → 独立入队（跨会话槽位）
      await engine.execute({
        sessionId: 'session-2',
        agentId: 'agent-1',
        triggerMessageId: 'msg-3',
        triggerContent: 'A2A',
        mentions: [],
        traceId: 'trace-other',
        depth: 1,
        pendingTriggers: [],
      })
      expect(engine.getSlot('agent-1', 'session-1')!.queueLength).toBe(1)
      expect(engine.getSlot('agent-1', 'session-2')!.queueLength).toBe(0) // session-2 槽位独立

      release()
      await p1
    })
  })

  describe('MAX_QUEUE_PER_AGENT — 队列上限', () => {
    it('队列满 → 拒绝入队并通知（systemMessageBridge），消息标 done 不静默', async () => {
      let release!: () => void
      const gate = new Promise<void>((r) => {
        release = r
      })
      makeAdapter({ chunks: ['第一'], gate })
      const notices: Array<[string, string, string]> = []
      ;(engine as any).setSystemMessageBridge((sid: string, aid: string, c: string) =>
        notices.push([sid, aid, c])
      )
      insertUserMsg('msg-1')
      insertUserMsg('msg-2')
      insertUserMsg('msg-3')
      insertUserMsg('msg-4')
      insertUserMsg('msg-5')

      const p1 = engine.execute({
        sessionId: 'session-1',
        agentId: 'agent-1',
        triggerMessageId: 'msg-1',
        triggerContent: '你好',
        mentions: [],
        traceId: 'trace-1',
        depth: 0,
        pendingTriggers: [],
      })
      await vi.waitFor(() => {
        expect(engine.getSlot('agent-1', 'session-1')?.status).toBe('busy')
      })
      for (const id of ['msg-2', 'msg-3', 'msg-4']) {
        await engine.execute({
          sessionId: 'session-1',
          agentId: 'agent-1',
          triggerMessageId: id,
          triggerContent: '你好',
          mentions: [],
          traceId: 'trace-1',
          depth: 0,
          pendingTriggers: [],
        })
      }
      expect(engine.getSlot('agent-1', 'session-1')!.queueLength).toBe(3)

      // 第 5 条被拒：不入队 + 系统消息通知 + done（terminal 防重放）
      await engine.execute({
        sessionId: 'session-1',
        agentId: 'agent-1',
        triggerMessageId: 'msg-5',
        triggerContent: '你好',
        mentions: [],
        traceId: 'trace-1',
        depth: 0,
        pendingTriggers: [],
      })
      expect(engine.getSlot('agent-1', 'session-1')!.queueLength).toBe(3)
      expect(notices).toHaveLength(1)
      expect(notices[0][2]).toContain('队列已满')
      expect(getDispatchState('msg-5')).toBe('done')

      release()
      await p1
    })
  })

  describe('撤回/停止 — cancelQueuedCommand / clearAgentQueue / isAnyAgentExecutingMessage', () => {
    it('cancelQueuedCommand：移除匹配 triggerMessageId 的排队命令，返回移除数', async () => {
      let release!: () => void
      const gate = new Promise<void>((r) => {
        release = r
      })
      makeAdapter({ chunks: ['第一'], gate })
      insertUserMsg('msg-1')
      insertUserMsg('msg-2')

      const p1 = engine.execute({
        sessionId: 'session-1',
        agentId: 'agent-1',
        triggerMessageId: 'msg-1',
        triggerContent: '你好',
        mentions: [],
        traceId: 'trace-1',
        depth: 0,
        pendingTriggers: [],
      })
      await vi.waitFor(() => {
        expect(engine.getSlot('agent-1', 'session-1')?.status).toBe('busy')
      })
      await engine.execute({
        sessionId: 'session-1',
        agentId: 'agent-1',
        triggerMessageId: 'msg-2',
        triggerContent: '你好',
        mentions: [],
        traceId: 'trace-1',
        depth: 0,
        pendingTriggers: [],
      })

      expect(engine.cancelQueuedCommand('msg-2')).toBe(1)
      expect(engine.getSlot('agent-1', 'session-1')!.queueLength).toBe(0)
      expect(engine.cancelQueuedCommand('msg-2')).toBe(0) // 幂等

      release()
      await p1
    })

    it('clearAgentQueue：清空 agent 全部会话槽位队列，逐条标 done（重启恢复不复活）', async () => {
      let release!: () => void
      const gate = new Promise<void>((r) => {
        release = r
      })
      makeAdapter({ chunks: ['第一'], gate })
      insertUserMsg('msg-1')
      insertUserMsg('msg-2')
      insertUserMsg('msg-3')

      const p1 = engine.execute({
        sessionId: 'session-1',
        agentId: 'agent-1',
        triggerMessageId: 'msg-1',
        triggerContent: '你好',
        mentions: [],
        traceId: 'trace-1',
        depth: 0,
        pendingTriggers: [],
      })
      await vi.waitFor(() => {
        expect(engine.getSlot('agent-1', 'session-1')?.status).toBe('busy')
      })
      await engine.execute({
        sessionId: 'session-1',
        agentId: 'agent-1',
        triggerMessageId: 'msg-2',
        triggerContent: '你好',
        mentions: [],
        traceId: 'trace-1',
        depth: 0,
        pendingTriggers: [],
      })

      const cleared = engine.clearAgentQueue('agent-1')
      expect(cleared).toBe(1)
      expect(engine.getSlot('agent-1', 'session-1')!.queueLength).toBe(0)
      expect(getDispatchState('msg-2')).toBe('done') // 被清队列命令标 done
      expect(getDispatchState('msg-1')).toBe('running') // 执行中的不受影响

      release()
      await p1
    })

    it('isAnyAgentExecutingMessage：执行中返回 true，仅排队返回 false', async () => {
      let release!: () => void
      const gate = new Promise<void>((r) => {
        release = r
      })
      makeAdapter({ chunks: ['第一'], gate })
      insertUserMsg('msg-1')
      insertUserMsg('msg-2')

      const p1 = engine.execute({
        sessionId: 'session-1',
        agentId: 'agent-1',
        triggerMessageId: 'msg-1',
        triggerContent: '你好',
        mentions: [],
        traceId: 'trace-1',
        depth: 0,
        pendingTriggers: [],
      })
      await vi.waitFor(() => {
        expect(engine.getSlot('agent-1', 'session-1')?.status).toBe('busy')
      })
      await engine.execute({
        sessionId: 'session-1',
        agentId: 'agent-1',
        triggerMessageId: 'msg-2',
        triggerContent: '你好',
        mentions: [],
        traceId: 'trace-1',
        depth: 0,
        pendingTriggers: [],
      })

      expect(engine.isAnyAgentExecutingMessage('msg-1')).toBe(true)
      expect(engine.isAnyAgentExecutingMessage('msg-2')).toBe(false) // 仅排队

      release()
      await p1
    })
  })

  describe('isStaleHandoffRequest — 交接去重判据（T-J）', () => {
    const SHA = 'a1b2c3d' // 模板落的是 shortHash（7 位），COMMIT_SHA_RE 取它

    /** 交接文档**体**（照 handoff-gen 模板剪裁：§1–§5 行首小节 + Commit 行） */
    const buildDocBody = (sha: string, whySection = '因为 C。') =>
      [
        '# 工作交接',
        '',
        '## 1. What — 改了什么',
        '',
        `> Commit: ${sha}`,
        '',
        '改动：把 A 改成 B。'.repeat(60),
        '',
        '## 2. Why — 关键决策',
        '',
        whySection,
        '',
        '## 3. Tradeoff — 放弃了什么',
        '',
        '放弃了 D。',
        '',
        '## 4. Open Questions — 不确定的点',
        '',
        '我动了 E，请重点查 F。',
        '',
        '## 5. Reviewer Checklist',
        '',
      ].join('\n')

    /** 补填请求消息（handoff-gen buildHandoffMessage 形状：前缀 + 内嵌整份文档）。
     *  模板同款的 `> Commit: <sha>` 行显式放在触发内容里：判据从**触发内容**取被审
     *  的 sha（`COMMIT_SHA_RE` 取首个匹配），本单要能构造"请求点的 sha ≠ 会话里那份
     *  文档的 sha"，缺了这行就构造不出来。 */
    const buildRequest = (sha: string, doc: string) =>
      [
        '@吐槽猫 请补填以下交接文档中 TODO 标注的部分（Why / Tradeoff / Open Questions）。',
        '',
        `> Commit: ${sha}`,
        '',
        '补填规则：',
        '- **Why**（关键决策）：从 commit message 和文件改动推导每个关键决策及理由。',
        '',
        '---',
        '',
        doc,
      ].join('\n')

    const insertMsg = (id: string, content: string, sessionId = 'session-1') => {
      getDb()
        .prepare(
          `INSERT INTO messages (id, session_id, role, content, mentions)
           VALUES (?, ?, 'user', ?, '[]')`
        )
        .run(id, sessionId, content)
    }

    const cmd = (triggerMessageId: string, triggerContent: string): DispatchCommand => ({
      sessionId: 'session-1',
      agentId: 'agent-1',
      triggerMessageId,
      triggerContent,
      mentions: [],
      traceId: 'trace-1',
      depth: 0,
      pendingTriggers: [],
    })

    it('阴性对照：正文**引用**真占位形态（行中、带注释符）→ 仍判 stale=true（现状 false）', () => {
      // 形状逐字对齐实测样本 0319b7f3-d973-4778-9f49-d4a8850ece76（len 6757）：
      // 引用落在**过程叙述行的行中**，带注释符，**不顶行**（实测注释符偏移 799、
      // 裸串 804，列 804）。
      const prose =
        '复核记录：模板占位实测确为注释形态（<!-- TODO: 补填 —）——故判据须同时带注释符与行首锚定。'
      // 文档体本身是**已补填**的（§2 已有真内容），引用只在过程叙述里
      const doc = buildDocBody(SHA) + '\n' + prose + '\n'
      insertMsg('msg-trigger', buildRequest(SHA, doc))
      insertMsg('msg-filled-doc', doc)

      // fixture 形状自证：引用确在行中（列 > 0）——防止有人把引用挪到行首，
      // 让"半吊子实现"（只收窄注释形态、不加行首锚定）也能全绿
      const refIdx = doc.indexOf('<!-- TODO: 补填')
      expect(refIdx - (doc.lastIndexOf('\n', refIdx) + 1)).toBeGreaterThan(0)

      expect(isStaleHandoffRequest(cmd('msg-trigger', buildRequest(SHA, doc)))).toBe(true)
    })

    it('正例不破：模板真占位（行首、未补填）→ 仍判 false', () => {
      const unfilled = buildDocBody(SHA, '<!-- TODO: 补填 — 说明核心设计决策及理由。 -->')
      insertMsg('msg-trigger', buildRequest(SHA, unfilled))
      // 另一条消息里是同一份**未补填**文档（占位行首在位）→ 不算"已补填"
      insertMsg('msg-doc-copy', buildRequest(SHA, unfilled))
      expect(isStaleHandoffRequest(cmd('msg-trigger', buildRequest(SHA, unfilled)))).toBe(false)
    })

    it('防自证：触发消息自身不作证据（排除 id）', () => {
      // 会话里只有触发请求它自己（内嵌一份**已补填**文档）→ 不能自证已补填
      const filled = buildDocBody(SHA)
      const req = buildRequest(SHA, filled)
      insertMsg('msg-trigger', req)
      expect(isStaleHandoffRequest(cmd('msg-trigger', req))).toBe(false)
    })

    it('验收④：引用 `Commit: <sha>` 的台账/更正消息不算完整文档', () => {
      const filled = buildDocBody(SHA)
      const ledger = [
        '# 台账',
        '',
        `更正：${SHA} 那条的结论我重新核过，Commit: ${SHA} 确有归属执行。`,
        '',
        '## 复核记录',
        '',
        '逐条 grep 复核后成立。'.repeat(40),
        '',
        '## 附注',
        '',
        '无。',
        '',
      ].join('\n')
      // 台账长度过阈值、也有 `## ` 小节——但**没有三个固定小节名**（判据的核心）
      insertMsg('msg-trigger', buildRequest(SHA, ledger))
      insertMsg('msg-ledger', ledger)
      expect(isStaleHandoffRequest(cmd('msg-trigger', buildRequest(SHA, ledger)))).toBe(false)

      // 对照：同一会话里放回**真文档体** → 立刻 true（证明上面不是恒假的空断言）
      insertMsg('msg-filled-doc', filled)
      expect(isStaleHandoffRequest(cmd('msg-trigger', buildRequest(SHA, ledger)))).toBe(true)
    })

    it('锚不匹配：文档体是**别的** sha → false（不认错链）', () => {
      const otherDoc = buildDocBody('b9c8d7e')
      insertMsg('msg-trigger', buildRequest(SHA, otherDoc))
      insertMsg('msg-other-doc', otherDoc)
      expect(isStaleHandoffRequest(cmd('msg-trigger', buildRequest(SHA, otherDoc)))).toBe(false)
    })

    it('跨会话不串：文档在别的 session → false', () => {
      const filled = buildDocBody(SHA)
      insertMsg('msg-trigger', buildRequest(SHA, filled))
      insertMsg('msg-doc-other-session', filled, 'session-2')
      expect(isStaleHandoffRequest(cmd('msg-trigger', buildRequest(SHA, filled)))).toBe(false)
    })
  })

  describe('disposeSession — 会话关闭清空槽位', () => {
    it('dispose 后该会话所有槽位移除（内存不涨），snapshot 不膨胀', async () => {
      makeAdapter()
      insertUserMsg('msg-a', 'session-1')
      insertUserMsg('msg-b', 'session-2')
      await Promise.all([
        engine.execute({
          sessionId: 'session-1',
          agentId: 'agent-1',
          triggerMessageId: 'msg-a',
          triggerContent: '你好',
          mentions: [],
          traceId: 'trace-a',
          depth: 0,
          pendingTriggers: [],
        }),
        engine.execute({
          sessionId: 'session-2',
          agentId: 'agent-1',
          triggerMessageId: 'msg-b',
          triggerContent: '你好',
          mentions: [],
          traceId: 'trace-b',
          depth: 0,
          pendingTriggers: [],
        }),
      ])
      expect(engine.snapshot().length).toBeGreaterThanOrEqual(1)

      engine.disposeSession('session-1')
      expect(engine.getSlot('agent-1', 'session-1')).toBeUndefined()
      // session-2 槽位不受影响
      expect(engine.getSlot('agent-1', 'session-2')).toBeDefined()
    })
  })
})
