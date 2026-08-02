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
    skillModules: [],
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
      await dispatchModule.dispatch('session-1', makeMessage({ id: 'msg-5', mentions: ['店长'] }), [
        mockAgent,
      ])
      expect(dispatchModule.getAgentState('agent-1')!.queueLength).toBe(3)
      expect(bridge).toHaveBeenCalledTimes(1)
      expect(bridge.mock.calls[0][0]).toBe('session-1')
      expect(bridge.mock.calls[0][2]).toContain('队列已满')
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
})
