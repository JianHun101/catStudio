import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentConfig, Message } from '@cat-study/shared'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository } from '../db/repository/index.js'

// Mock redis to avoid real connections
vi.mock('../db/redis.js', () => ({
  getRedis: vi.fn(() => null),
  isRedisAvailable: vi.fn(() => false),
  connectRedis: vi.fn(),
  closeRedis: vi.fn(),
}))

describe('dispatch', () => {
  let dispatchModule: typeof import('./index.js')
  const mockAgent: AgentConfig = {
    id: 'agent-1',
    name: '店长',
    avatar: '🐱',
    systemPrompt: 'test',
    llmProvider: 'deepseek',
    llmModel: 'deepseek-v4-pro',
    llmApiKey: 'sk-test',
  }
  const mockAgent2: AgentConfig = {
    ...mockAgent,
    id: 'agent-2',
    name: 'ds猫',
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

  async function seedTestData() {
    const { getDb } = await import('../db/index.js')
    const ddb = getDb()
    ddb
      .prepare(
        `
      INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
      VALUES (?, ?, '🐱', 'prompt', 'deepseek', 'deepseek-v4-pro', 'sk')
    `
      )
      .run('agent-1', '店长')
    ddb
      .prepare(
        `
      INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
      VALUES (?, ?, '🐱', 'prompt', 'deepseek', 'deepseek-v4-pro', 'sk')
    `
      )
      .run('agent-2', 'ds猫')
    ddb
      .prepare("INSERT INTO sessions (id, title, agent_ids) VALUES ('session-1', 'test', '[]')")
      .run()
  }

  beforeEach(async () => {
    // ⚠ setDb MUST come before import, because the imported dispatch module
    // chains through db/index.ts which will call getDb() on import
    setDb(createTestDb())
    initRepository(getDb())
    dispatchModule = await import('./index.js')
    await seedTestData()
  })

  afterEach(() => {
    dispatchModule.__test_reset?.()
    resetDb()
  })

  describe('initAgentSlot', () => {
    it('creates an idle slot for an agent', () => {
      dispatchModule.initAgentSlot('agent-1')
      const state = dispatchModule.getAgentState('agent-1')
      expect(state).toBeDefined()
      expect(state!.status).toBe('idle')
      expect(state!.queueLength).toBe(0)
      expect(state!.sessionId).toBeNull()
    })
  })

  describe('getAgentState', () => {
    it('returns undefined for unknown agent', () => {
      expect(dispatchModule.getAgentState('unknown')).toBeUndefined()
    })

    it('returns correct state after init', () => {
      dispatchModule.initAgentSlot('agent-1')
      expect(dispatchModule.getAgentState('agent-1')?.agentId).toBe('agent-1')
    })
  })

  describe('getAllAgentStates', () => {
    it('returns empty array when no agents initialized', () => {
      expect(dispatchModule.getAllAgentStates()).toEqual([])
    })

    it('returns all initialized agent states', () => {
      dispatchModule.initAgentSlot('agent-1')
      dispatchModule.initAgentSlot('agent-2')
      expect(dispatchModule.getAllAgentStates()).toHaveLength(2)
    })
  })

  describe('dispatch', () => {
    it('sets idle slot to busy', async () => {
      dispatchModule.initAgentSlot('agent-1')
      const msg = makeMessage({ mentions: ['店长'] })

      await dispatchModule.dispatch('session-1', msg, [mockAgent])

      const state = dispatchModule.getAgentState('agent-1')
      expect(state!.status).toBe('busy')
      expect(state!.sessionId).toBe('session-1')
    })

    it('queues command when slot is busy', async () => {
      dispatchModule.initAgentSlot('agent-1')
      const msg1 = makeMessage({ id: 'msg-1', mentions: ['店长'] })
      const msg2 = makeMessage({ id: 'msg-2', mentions: ['店长'] })

      await dispatchModule.dispatch('session-1', msg1, [mockAgent])
      expect(dispatchModule.getAgentState('agent-1')!.status).toBe('busy')

      await dispatchModule.dispatch('session-1', msg2, [mockAgent])
      const state = dispatchModule.getAgentState('agent-1')
      expect(state!.status).toBe('busy')
      expect(state!.queueLength).toBe(1)
    })

    it('dispatches only to mentioned agents', async () => {
      dispatchModule.initAgentSlot('agent-1')
      dispatchModule.initAgentSlot('agent-2')

      const msg = makeMessage({ mentions: ['店长'] })
      await dispatchModule.dispatch('session-1', msg, [mockAgent, mockAgent2])

      expect(dispatchModule.getAgentState('agent-1')!.status).toBe('busy')
      expect(dispatchModule.getAgentState('agent-2')!.status).toBe('idle')
    })

    it('dispatches to all agents when no mentions', async () => {
      dispatchModule.initAgentSlot('agent-1')
      dispatchModule.initAgentSlot('agent-2')

      const msg = makeMessage({ mentions: [] })
      await dispatchModule.dispatch('session-1', msg, [mockAgent, mockAgent2])

      expect(dispatchModule.getAgentState('agent-1')!.status).toBe('busy')
      expect(dispatchModule.getAgentState('agent-2')!.status).toBe('busy')
    })

    it('returns a traceId', async () => {
      dispatchModule.initAgentSlot('agent-1')
      const msg = makeMessage({ mentions: ['店长'] })
      const traceId = await dispatchModule.dispatch('session-1', msg, [mockAgent])
      expect(traceId).toBeDefined()
      expect(typeof traceId).toBe('string')
    })

    it('skips unknown agents gracefully', async () => {
      const msg = makeMessage({ mentions: ['unknown'] })
      const traceId = await dispatchModule.dispatch('session-1', msg, [mockAgent])
      expect(traceId).toBeDefined()
    })
  })

  describe('completeExecution', () => {
    it('sets slot to idle after completion when queue is empty', async () => {
      dispatchModule.initAgentSlot('agent-1')
      const msg = makeMessage({ mentions: ['店长'] })
      await dispatchModule.dispatch('session-1', msg, [mockAgent])

      const next = await dispatchModule.completeExecution('agent-1', true)
      expect(next).toBeUndefined()
      expect(dispatchModule.getAgentState('agent-1')!.status).toBe('idle')
      expect(dispatchModule.getAgentState('agent-1')!.sessionId).toBeNull()
    })

    it('returns next queued command after completion', async () => {
      dispatchModule.initAgentSlot('agent-1')
      const msg1 = makeMessage({ id: 'msg-1', mentions: ['店长'] })
      const msg2 = makeMessage({ id: 'msg-2', mentions: ['店长'] })

      await dispatchModule.dispatch('session-1', msg1, [mockAgent])
      await dispatchModule.dispatch('session-1', msg2, [mockAgent])

      const next = await dispatchModule.completeExecution('agent-1', true)
      expect(next).toBeDefined()
      expect(next!.triggerMessageId).toBe('msg-2')
      expect(dispatchModule.getAgentState('agent-1')!.status).toBe('busy')
    })

    it('handles failed execution', async () => {
      dispatchModule.initAgentSlot('agent-1')
      const msg = makeMessage({ mentions: ['店长'] })
      await dispatchModule.dispatch('session-1', msg, [mockAgent])

      const next = await dispatchModule.completeExecution('agent-1', false, {
        errorMessage: 'LLM timeout',
      })
      expect(next).toBeUndefined()
      expect(dispatchModule.getAgentState('agent-1')!.status).toBe('idle')
    })

    it('returns undefined for unknown agent', async () => {
      const next = await dispatchModule.completeExecution('unknown', true)
      expect(next).toBeUndefined()
    })
  })

  describe('FIFO queue', () => {
    it('processes queue in FIFO order', async () => {
      dispatchModule.initAgentSlot('agent-1')
      const msg1 = makeMessage({ id: 'msg-1', mentions: ['店长'] })
      const msg2 = makeMessage({ id: 'msg-2', mentions: ['店长'] })
      const msg3 = makeMessage({ id: 'msg-3', mentions: ['店长'] })

      await dispatchModule.dispatch('session-1', msg1, [mockAgent])
      await dispatchModule.dispatch('session-1', msg2, [mockAgent])
      await dispatchModule.dispatch('session-1', msg3, [mockAgent])

      expect(dispatchModule.getAgentState('agent-1')!.queueLength).toBe(2)

      const next1 = await dispatchModule.completeExecution('agent-1', true)
      expect(next1!.triggerMessageId).toBe('msg-2')
      expect(dispatchModule.getAgentState('agent-1')!.queueLength).toBe(1)

      const next2 = await dispatchModule.completeExecution('agent-1', true)
      expect(next2!.triggerMessageId).toBe('msg-3')
      expect(dispatchModule.getAgentState('agent-1')!.queueLength).toBe(0)

      const next3 = await dispatchModule.completeExecution('agent-1', true)
      expect(next3).toBeUndefined()
      expect(dispatchModule.getAgentState('agent-1')!.status).toBe('idle')
    })
  })

  // ─── P0 队列持久化：dispatch_state 落库 ──────────
  // setDispatchState 是 UPDATE 语义——消息必须先存在于 DB 才能断言状态。

  describe('dispatch_state 持久化（P0）', () => {
    /** 插入一条用户消息（dispatch_state 默认 NULL） */
    function insertMsg(id: string): void {
      getDb()
        .prepare(
          `INSERT INTO messages (id, session_id, role, content, mentions)
           VALUES (?, ?, 'user', '你好', '[]')`
        )
        .run(id, 'session-1')
    }

    function getDispatchState(msgId: string): string | null {
      const row = getDb()
        .prepare('SELECT dispatch_state FROM messages WHERE id = ?')
        .get(msgId) as { dispatch_state: string | null }
      return row?.dispatch_state ?? null
    }

    it('AC1+AC2: 空闲直跑 → running；忙时入队 → queued', async () => {
      dispatchModule.initAgentSlot('agent-1')
      insertMsg('msg-1')
      insertMsg('msg-2')

      await dispatchModule.dispatch('session-1', makeMessage({ id: 'msg-1', mentions: ['店长'] }), [
        mockAgent,
      ])
      expect(getDispatchState('msg-1')).toBe('running')

      await dispatchModule.dispatch('session-1', makeMessage({ id: 'msg-2', mentions: ['店长'] }), [
        mockAgent,
      ])
      expect(getDispatchState('msg-2')).toBe('queued')
    })

    it('AC3: completeExecution 收尾 → done；弹出队列命令 → running', async () => {
      dispatchModule.initAgentSlot('agent-1')
      insertMsg('msg-1')
      insertMsg('msg-2')

      await dispatchModule.dispatch('session-1', makeMessage({ id: 'msg-1', mentions: ['店长'] }), [
        mockAgent,
      ])
      await dispatchModule.dispatch('session-1', makeMessage({ id: 'msg-2', mentions: ['店长'] }), [
        mockAgent,
      ])

      const next = await dispatchModule.completeExecution('agent-1', true)

      expect(getDispatchState('msg-1')).toBe('done')
      expect(getDispatchState('msg-2')).toBe('running')
      expect(next!.triggerMessageId).toBe('msg-2')
    })

    it('队列清空后 completeExecution → 全部 done，槽位回 idle', async () => {
      dispatchModule.initAgentSlot('agent-1')
      insertMsg('msg-1')
      insertMsg('msg-2')

      await dispatchModule.dispatch('session-1', makeMessage({ id: 'msg-1', mentions: ['店长'] }), [
        mockAgent,
      ])
      await dispatchModule.dispatch('session-1', makeMessage({ id: 'msg-2', mentions: ['店长'] }), [
        mockAgent,
      ])

      await dispatchModule.completeExecution('agent-1', true) // 弹 msg-2 → running
      await dispatchModule.completeExecution('agent-1', true) // 队列空 → idle

      expect(getDispatchState('msg-1')).toBe('done')
      expect(getDispatchState('msg-2')).toBe('done')
      expect(dispatchModule.getAgentState('agent-1')!.status).toBe('idle')
    })
  })

  describe('clearAgentQueue — 用户中断清队', () => {
    /** 插入一条用户消息（dispatch_state 默认 NULL） */
    function insertMsg(id: string): void {
      getDb()
        .prepare(
          `INSERT INTO messages (id, session_id, role, content, mentions)
           VALUES (?, ?, 'user', '你好', '[]')`
        )
        .run(id, 'session-1')
    }

    function getDispatchState(msgId: string): string | null {
      const row = getDb()
        .prepare('SELECT dispatch_state FROM messages WHERE id = ?')
        .get(msgId) as { dispatch_state: string | null }
      return row?.dispatch_state ?? null
    }

    it('有排队命令 → 清空队列、queueLength 归零、dispatch_state 全部标 done（重启恢复不复活）', async () => {
      dispatchModule.initAgentSlot('agent-1')
      insertMsg('msg-1')
      insertMsg('msg-2')
      insertMsg('msg-3')

      // msg-1 空闲直跑 → running；msg-2/msg-3 排队 → queued
      await dispatchModule.dispatch('session-1', makeMessage({ id: 'msg-1', mentions: ['店长'] }), [
        mockAgent,
      ])
      await dispatchModule.dispatch('session-1', makeMessage({ id: 'msg-2', mentions: ['店长'] }), [
        mockAgent,
      ])
      await dispatchModule.dispatch('session-1', makeMessage({ id: 'msg-3', mentions: ['店长'] }), [
        mockAgent,
      ])
      expect(dispatchModule.getAgentState('agent-1')!.queueLength).toBe(2)

      const cleared = dispatchModule.clearAgentQueue('agent-1')

      expect(cleared).toBe(2)
      expect(dispatchModule.getAgentState('agent-1')!.queueLength).toBe(0)
      // 正在执行的 msg-1 保持 running（由执行循环的 abort 检查收口）；
      // 被清的排队消息全部 done——recoverQueuedMessages 只按 queued/running 复活，不会重新调度
      expect(getDispatchState('msg-1')).toBe('running')
      expect(getDispatchState('msg-2')).toBe('done')
      expect(getDispatchState('msg-3')).toBe('done')
    })

    it('无排队命令 → 返回 0，幂等无副作用', async () => {
      dispatchModule.initAgentSlot('agent-1')
      insertMsg('msg-1')
      await dispatchModule.dispatch('session-1', makeMessage({ id: 'msg-1', mentions: ['店长'] }), [
        mockAgent,
      ])

      expect(dispatchModule.clearAgentQueue('agent-1')).toBe(0)
      expect(dispatchModule.getAgentState('agent-1')!.queueLength).toBe(0)
      expect(getDispatchState('msg-1')).toBe('running') // 执行中的命令不受影响
    })

    it('未知 agent → 返回 0，不报错', () => {
      expect(dispatchModule.clearAgentQueue('agent-ghost')).toBe(0)
    })
  })

  // ─── B 触发合并（A2A 风暴治理）：depth>0 且同 session 已有排队命令 → 并入 pendingTriggers ──

  describe('B 触发合并 — pendingTriggers', () => {
    it('A2A 触发（depth>0）同 session 已有排队命令 → 不入队，并入 pendingTriggers', async () => {
      dispatchModule.initAgentSlot('agent-1')
      await dispatchModule.dispatch('session-1', makeMessage({ id: 'msg-1', mentions: ['店长'] }), [
        mockAgent,
      ])
      await dispatchModule.dispatch('session-1', makeMessage({ id: 'msg-2', mentions: ['店长'] }), [
        mockAgent,
      ])
      expect(dispatchModule.getAgentState('agent-1')!.queueLength).toBe(1)

      // A2A 链触发（depth=1）→ 并入排队中的 msg-2，不入队
      await dispatchModule.dispatch(
        'session-1',
        makeMessage({ id: 'msg-3', mentions: ['店长'] }),
        [mockAgent],
        'trace-a2a',
        1
      )
      expect(dispatchModule.getAgentState('agent-1')!.queueLength).toBe(1) // 未新增排队

      // 弹出 msg-2 时 pendingTriggers 完整到达
      const next = await dispatchModule.completeExecution('agent-1', true)
      expect(next!.triggerMessageId).toBe('msg-2')
      expect(next!.pendingTriggers).toEqual(['msg-3'])
    })

    it('depth=0（用户顶层）→ 不合并，照常排队', async () => {
      dispatchModule.initAgentSlot('agent-1')
      await dispatchModule.dispatch('session-1', makeMessage({ id: 'msg-1', mentions: ['店长'] }), [
        mockAgent,
      ])
      for (const id of ['msg-2', 'msg-3']) {
        await dispatchModule.dispatch('session-1', makeMessage({ id, mentions: ['店长'] }), [
          mockAgent,
        ])
      }
      expect(dispatchModule.getAgentState('agent-1')!.queueLength).toBe(2)
    })

    it('不同 sessionId → 不合并，照常入队', async () => {
      dispatchModule.initAgentSlot('agent-1')
      await dispatchModule.dispatch('session-1', makeMessage({ id: 'msg-1', mentions: ['店长'] }), [
        mockAgent,
      ])
      await dispatchModule.dispatch('session-1', makeMessage({ id: 'msg-2', mentions: ['店长'] }), [
        mockAgent,
      ])

      // 另一会话的 A2A 触发（depth=1）→ 队列里没有同 session 命令 → 独立入队
      await dispatchModule.dispatch(
        'session-2',
        makeMessage({ id: 'msg-3', mentions: ['店长'] }),
        [mockAgent],
        'trace-other-session',
        1
      )
      expect(dispatchModule.getAgentState('agent-1')!.queueLength).toBe(2)
    })

    it('并发安全：并入判定与写入同同步块无 await——并入后立即消费，pendingTriggers 完整到达', async () => {
      dispatchModule.initAgentSlot('agent-1')
      await dispatchModule.dispatch('session-1', makeMessage({ id: 'msg-1', mentions: ['店长'] }), [
        mockAgent,
      ])
      await dispatchModule.dispatch('session-1', makeMessage({ id: 'msg-2', mentions: ['店长'] }), [
        mockAgent,
      ])

      // 不 await 的 dispatch 调用：A2A 并入路径无 await（slot busy → else 分支
      // 同步完成判定+并入），函数体在首个 await 前同步执行完并入
      const p = dispatchModule.dispatch(
        'session-1',
        makeMessage({ id: 'msg-3', mentions: ['店长'] }),
        [mockAgent],
        'trace-race',
        1
      )
      // 立即消费：q.shift 也是同步——若并入先发生，弹出命令必带 pendingTriggers
      const next = await dispatchModule.completeExecution('agent-1', true)
      await p
      expect(next!.triggerMessageId).toBe('msg-2')
      expect(next!.pendingTriggers).toEqual(['msg-3'])
    })
  })

  // ─── 冻结改动补测：队列上限 + 命令自持 traceId/depth ──

  describe('MAX_QUEUE_PER_AGENT — 队列上限（冻结改动补测）', () => {
    it('队列满 → 拒绝入队并通知（systemMessageBridge），不静默丢弃', async () => {
      const { setSystemMessageBridge } = dispatchModule
      const bridge = vi.fn()
      setSystemMessageBridge(bridge)
      dispatchModule.initAgentSlot('agent-1')

      await dispatchModule.dispatch('session-1', makeMessage({ id: 'msg-1', mentions: ['店长'] }), [
        mockAgent,
      ])
      for (const id of ['msg-2', 'msg-3', 'msg-4']) {
        await dispatchModule.dispatch('session-1', makeMessage({ id, mentions: ['店长'] }), [
          mockAgent,
        ])
      }
      expect(dispatchModule.getAgentState('agent-1')!.queueLength).toBe(3)

      // 第 5 条被拒：不入队 + 系统消息通知
      getDb()
        .prepare(
          `INSERT INTO messages (id, session_id, role, content, mentions)
           VALUES (?, ?, 'user', '你好', '[]')`
        )
        .run('msg-5', 'session-1')
      await dispatchModule.dispatch('session-1', makeMessage({ id: 'msg-5', mentions: ['店长'] }), [
        mockAgent,
      ])
      expect(dispatchModule.getAgentState('agent-1')!.queueLength).toBe(3)
      expect(bridge).toHaveBeenCalledTimes(1)
      expect(bridge.mock.calls[0][0]).toBe('session-1')
      expect(bridge.mock.calls[0][2]).toContain('队列已满')
      // 拒绝 = terminal：消息标 done，不得留在 NULL 面——否则 30min 后被重放
      // 静默补派（与「请稍后再试」矛盾）+ 用户手动重发会同一意图执行两次
      const rejected = getDb()
        .prepare('SELECT dispatch_state FROM messages WHERE id = ?')
        .get('msg-5') as { dispatch_state: string | null }
      expect(rejected.dispatch_state).toBe('done')
    })

    it('多目标消息：满目标不覆盖兄弟目标已写的 queued（重启恢复不丢排队执行）', async () => {
      const { setSystemMessageBridge } = dispatchModule
      setSystemMessageBridge(() => {})
      dispatchModule.initAgentSlot('agent-1') // 店长：busy + 队列有空间
      dispatchModule.initAgentSlot('agent-2') // ds猫：busy + 队列满

      // agent-1：msg-a1 直跑 busy、msg-a2 排队 → queueLength 1（有空间）
      await dispatchModule.dispatch(
        'session-1',
        makeMessage({ id: 'msg-a1', mentions: ['店长'] }),
        [mockAgent]
      )
      await dispatchModule.dispatch(
        'session-1',
        makeMessage({ id: 'msg-a2', mentions: ['店长'] }),
        [mockAgent]
      )
      // agent-2：msg-b1 直跑 busy、msg-b2/b3/b4 排队 → queueLength 3（满）
      await dispatchModule.dispatch(
        'session-1',
        makeMessage({ id: 'msg-b1', mentions: ['ds猫'] }),
        [mockAgent2]
      )
      for (const id of ['msg-b2', 'msg-b3', 'msg-b4']) {
        await dispatchModule.dispatch('session-1', makeMessage({ id, mentions: ['ds猫'] }), [
          mockAgent2,
        ])
      }
      expect(dispatchModule.getAgentState('agent-1')!.queueLength).toBe(1)
      expect(dispatchModule.getAgentState('agent-2')!.queueLength).toBe(3)

      // 多目标消息 @[店长, ds猫]：店长先迭代（queued）→ ds猫后迭代（满拒绝）
      // ——done 不得覆盖 queued（否则重启时 recoverQueuedMessages 捞不到店长
      // 的排队命令，排队执行静默丢失；02d3165 引入的回归）
      getDb()
        .prepare(
          `INSERT INTO messages (id, session_id, role, content, mentions)
           VALUES (?, ?, 'user', '多目标', '["店长","ds猫"]')`
        )
        .run('msg-multi', 'session-1')
      await dispatchModule.dispatch(
        'session-1',
        makeMessage({ id: 'msg-multi', mentions: ['店长', 'ds猫'] }),
        [mockAgent, mockAgent2]
      )
      expect(dispatchModule.getAgentState('agent-1')!.queueLength).toBe(2)
      expect(dispatchModule.getAgentState('agent-2')!.queueLength).toBe(3)
      const multi = getDb()
        .prepare('SELECT dispatch_state FROM messages WHERE id = ?')
        .get('msg-multi') as { dispatch_state: string | null }
      expect(multi.dispatch_state).toBe('queued')
    })
  })

  describe('命令自持 traceId/depth（冻结改动补测）', () => {
    it('出队命令用自身 traceId 与 depth，不继承执行者', async () => {
      dispatchModule.initAgentSlot('agent-1')
      await dispatchModule.dispatch(
        'session-1',
        makeMessage({ id: 'msg-1', mentions: ['店长'] }),
        [mockAgent],
        'trace-exec',
        2
      )
      await dispatchModule.dispatch(
        'session-1',
        makeMessage({ id: 'msg-2', mentions: ['店长'] }),
        [mockAgent],
        'trace-queued',
        1
      )

      const next = await dispatchModule.completeExecution('agent-1', true)
      expect(next!.traceId).toBe('trace-queued')
      expect(next!.depth).toBe(1)
      expect(next!.pendingTriggers).toEqual([])
    })
  })

  // ─── 交接请求去重（stale handoff request skip）───
  // 契约：触发消息含「请补填以下交接文档」+「Commit: sha」时，同 session 已有
  // 完整文档（含 Commit: <sha> 且不含 TODO 占位）→ 请求 stale → 跳过执行不唤醒猫。
  // 检查时点必须是执行前（dequeue 后）——请求入队时文档可能还没落库。

  describe('stale handoff request skip', () => {
    const SHA = 'a0ade7d'
    /** 请求内容：hook 投递的交接文档补填请求（含 sha + TODO 占位） */
    const fillRequest = (id: string) =>
      makeMessage({
        id,
        mentions: ['店长'],
        content: `@ds猫 请补填以下交接文档中 TODO 标注的部分（Why / Tradeoff / Open Questions）。\n\n## 2. Why\n<!-- TODO: 补填 -->\n\n> Commit: ${SHA}`,
      })
    /** 完整文档：作者补填后的交接文档（含 Commit: sha，无 TODO） */
    const fullDoc = (id: string) =>
      makeMessage({
        id,
        role: 'agent',
        agentId: 'agent-1',
        mentions: ['吐槽猫'],
        content: `# 工作交接\n> Commit: ${SHA}\n> Message: catstudy [uuid] feat: ...\n\n## 2. Why — 关键决策\n已补填。`,
      })

    function insertMsg(msg: Message): void {
      getDb()
        .prepare(
          `INSERT INTO messages (id, session_id, agent_id, role, content, mentions)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          msg.id,
          msg.sessionId,
          msg.agentId ?? null,
          msg.role,
          msg.content,
          JSON.stringify(msg.mentions)
        )
    }

    function getDispatchState(msgId: string): string | null {
      const row = getDb()
        .prepare('SELECT dispatch_state FROM messages WHERE id = ?')
        .get(msgId) as { dispatch_state: string | null }
      return row?.dispatch_state ?? null
    }

    it('① 空闲直跑路径：会话已有完整文档 + 新到请求 → 跳过执行（槽位不 busy、无执行、标 done）', async () => {
      dispatchModule.initAgentSlot('agent-1')
      insertMsg(fullDoc('doc-1'))
      insertMsg(fillRequest('req-1'))

      await dispatchModule.dispatch('session-1', fillRequest('req-1'), [mockAgent])

      // 槽位仍 idle（未执行）；请求标 done（防重启恢复复活）
      expect(dispatchModule.getAgentState('agent-1')!.status).toBe('idle')
      expect(getDispatchState('req-1')).toBe('done')
    })

    it('① 队列路径：请求排队期间完整文档落库 → dequeue 后跳过（不返回执行、标 done）', async () => {
      dispatchModule.initAgentSlot('agent-1')
      insertMsg(makeMessage({ id: 'busy-1', mentions: ['店长'] }))
      insertMsg(fillRequest('req-1'))
      insertMsg(fullDoc('doc-1'))

      // busy-1 直跑 → busy；req-1 排队
      await dispatchModule.dispatch(
        'session-1',
        makeMessage({ id: 'busy-1', mentions: ['店长'] }),
        [mockAgent]
      )
      await dispatchModule.dispatch('session-1', fillRequest('req-1'), [mockAgent])
      expect(dispatchModule.getAgentState('agent-1')!.queueLength).toBe(1)

      // 执行中期间完整文档落库（03:20 场景）→ dequeue 时跳过 req-1
      const next = await dispatchModule.completeExecution('agent-1', true)
      expect(next).toBeUndefined() // 不返回执行
      expect(getDispatchState('req-1')).toBe('done')
      expect(dispatchModule.getAgentState('agent-1')!.status).toBe('idle')
    })

    it('① 队列路径：stale 请求后还有正常命令 → 跳过 stale，继续弹正常命令', async () => {
      dispatchModule.initAgentSlot('agent-1')
      insertMsg(makeMessage({ id: 'busy-1', mentions: ['店长'] }))
      insertMsg(fillRequest('req-1'))
      insertMsg(fullDoc('doc-1'))
      insertMsg(makeMessage({ id: 'msg-2', mentions: ['店长'] }))

      await dispatchModule.dispatch(
        'session-1',
        makeMessage({ id: 'busy-1', mentions: ['店长'] }),
        [mockAgent]
      )
      await dispatchModule.dispatch('session-1', fillRequest('req-1'), [mockAgent])
      await dispatchModule.dispatch('session-1', makeMessage({ id: 'msg-2', mentions: ['店长'] }), [
        mockAgent,
      ])

      const next = await dispatchModule.completeExecution('agent-1', true)
      expect(next!.triggerMessageId).toBe('msg-2') // 跳过 req-1，弹出 msg-2
      expect(getDispatchState('req-1')).toBe('done')
    })

    it('② 无完整文档 → 照常执行（idle 直跑 + 队列弹出）', async () => {
      dispatchModule.initAgentSlot('agent-1')
      insertMsg(fillRequest('req-1'))
      insertMsg(fillRequest('req-2'))

      // 空闲直跑：请求正常执行
      await dispatchModule.dispatch('session-1', fillRequest('req-1'), [mockAgent])
      expect(dispatchModule.getAgentState('agent-1')!.status).toBe('busy')
      expect(getDispatchState('req-1')).toBe('running')

      // 队列路径：req-1 执行期间第二个请求排队 → 弹出执行（无文档不跳过）
      await dispatchModule.dispatch('session-1', fillRequest('req-2'), [mockAgent])
      const next = await dispatchModule.completeExecution('agent-1', true)
      expect(next!.triggerMessageId).toBe('req-2')
      expect(getDispatchState('req-2')).toBe('running')
    })

    it('③ 普通 @ 消息不受影响（无「请补填以下交接文档」前缀 → 不过检查）', async () => {
      dispatchModule.initAgentSlot('agent-1')
      insertMsg(fullDoc('doc-1'))
      // 普通消息即使内容里恰好有 Commit: sha 字样也不受影响（无请求前缀）
      const normal = makeMessage({
        id: 'msg-normal',
        mentions: ['店长'],
        content: `这个 Commit: ${SHA} 的改动请看一下`,
      })
      insertMsg(normal)
      await dispatchModule.dispatch('session-1', normal, [mockAgent])
      expect(dispatchModule.getAgentState('agent-1')!.status).toBe('busy')
    })

    it('④ 防自证：会话只有请求自身（含 sha + 含 TODO）→ 不误判已补填，照常执行', async () => {
      dispatchModule.initAgentSlot('agent-1')
      insertMsg(fillRequest('req-1'))

      await dispatchModule.dispatch('session-1', fillRequest('req-1'), [mockAgent])
      expect(dispatchModule.getAgentState('agent-1')!.status).toBe('busy')
    })

    it('④ 防自证：作者补填后的完整文档（含 Commit sha、无 TODO）不被误判为"请求"', async () => {
      dispatchModule.initAgentSlot('agent-1')
      // 完整文档自身作为触发消息（作者补填后 @ 吐槽猫 请审查）——不含请求前缀
      const doc = fullDoc('doc-self')
      doc.content = `@吐槽猫 请审查 ${SHA}。\n\n# 工作交接\n> Commit: ${SHA}\n已补填。`
      doc.mentions = ['店长'] // 让 dispatch 命中 mockAgent（agent-1）
      insertMsg(doc)
      await dispatchModule.dispatch('session-1', doc, [mockAgent])
      expect(dispatchModule.getAgentState('agent-1')!.status).toBe('busy')
    })

    it('同 session 限定：其他会话的完整文档不作证据（N6 session 限定语义）', async () => {
      dispatchModule.initAgentSlot('agent-1')
      // 另一会话需先存在（FK）
      getDb()
        .prepare("INSERT INTO sessions (id, title, agent_ids) VALUES ('session-2', 'test', '[]')")
        .run()
      const docOther = fullDoc('doc-other')
      docOther.sessionId = 'session-2'
      insertMsg(docOther)
      insertMsg(fillRequest('req-1'))

      await dispatchModule.dispatch('session-1', fillRequest('req-1'), [mockAgent])
      expect(dispatchModule.getAgentState('agent-1')!.status).toBe('busy')
      expect(getDispatchState('req-1')).toBe('running')
    })

    it('F1 守卫：stale 请求带 pendingTriggers（B 合并的 A2A 触发）→ 不跳过，照常弹出执行', async () => {
      dispatchModule.initAgentSlot('agent-1')
      insertMsg(makeMessage({ id: 'busy-1', mentions: ['店长'] }))
      insertMsg(fillRequest('req-1'))
      insertMsg(fullDoc('doc-1'))

      // busy-1 直跑 → busy；req-1 排队（请求期间完整文档已落库 → 已是 stale）
      await dispatchModule.dispatch(
        'session-1',
        makeMessage({ id: 'busy-1', mentions: ['店长'] }),
        [mockAgent]
      )
      await dispatchModule.dispatch('session-1', fillRequest('req-1'), [mockAgent])
      expect(dispatchModule.getAgentState('agent-1')!.queueLength).toBe(1)

      // A2A 触发（depth=1，同 session）→ B 合并并入 req-1.pendingTriggers（不入队）
      await dispatchModule.dispatch(
        'session-1',
        makeMessage({ id: 'a2a-1', mentions: ['店长'] }),
        [mockAgent],
        'trace-a2a',
        1
      )
      expect(dispatchModule.getAgentState('agent-1')!.queueLength).toBe(1) // 未新增排队

      // dequeue 时 req-1 虽 stale（文档已补填）但带合并触发 → 不跳过，照常弹出执行
      // （合并时已告知用户「将一并处理」，跳过会让 A2A 触发静默蒸发）
      const next = await dispatchModule.completeExecution('agent-1', true)
      expect(next!.triggerMessageId).toBe('req-1')
      expect(next!.pendingTriggers).toEqual(['a2a-1']) // 合并触发完整到达（不蒸发）
      expect(getDispatchState('req-1')).toBe('running') // 未被标 done（正常执行）
    })

    it('F1 混合队列：带 pendingTriggers 的 stale 照常弹出，其后纯 stale 仍跳过', async () => {
      dispatchModule.initAgentSlot('agent-1')
      insertMsg(makeMessage({ id: 'busy-1', mentions: ['店长'] }))
      insertMsg(fillRequest('req-1'))
      insertMsg(fillRequest('req-2'))
      insertMsg(fullDoc('doc-1'))

      await dispatchModule.dispatch(
        'session-1',
        makeMessage({ id: 'busy-1', mentions: ['店长'] }),
        [mockAgent]
      )
      await dispatchModule.dispatch('session-1', fillRequest('req-1'), [mockAgent])
      await dispatchModule.dispatch('session-1', fillRequest('req-2'), [mockAgent])

      // A2A 触发并入排队中的第一个命令（req-1）
      await dispatchModule.dispatch(
        'session-1',
        makeMessage({ id: 'a2a-1', mentions: ['店长'] }),
        [mockAgent],
        'trace-a2a',
        1
      )

      // 第一次弹出：req-1 带 pendingTriggers → 不跳过
      const next1 = await dispatchModule.completeExecution('agent-1', true)
      expect(next1!.triggerMessageId).toBe('req-1')
      expect(next1!.pendingTriggers).toEqual(['a2a-1'])

      // 第二次弹出：req-2 纯 stale（无合并触发）→ 跳过标 done；队列空 → undefined
      const next2 = await dispatchModule.completeExecution('agent-1', true)
      expect(next2).toBeUndefined()
      expect(getDispatchState('req-2')).toBe('done')
    })

    it('isStaleHandoffRequest 导出契约：非请求消息 / 无 sha → false', () => {
      const asCmd = (triggerContent: string) =>
        ({
          sessionId: 'session-1',
          triggerMessageId: 'm-any',
          triggerContent,
        }) as any
      expect(dispatchModule.isStaleHandoffRequest(asCmd('你好'))).toBe(false)
      expect(
        dispatchModule.isStaleHandoffRequest(
          asCmd('请补填以下交接文档中 TODO 标注的部分（Why / Tradeoff / Open Questions）。')
        )
      ).toBe(false)
    })
  })
})
