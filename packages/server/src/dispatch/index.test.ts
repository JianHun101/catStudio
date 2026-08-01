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
})
