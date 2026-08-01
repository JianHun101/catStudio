import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTestDb, buildTestApp } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository } from '../db/repository/index.js'
import type { FastifyInstance } from 'fastify'

// Mock getIO from socketio connector (used by session DELETE)
vi.mock('../connectors/socketio.js', () => {
  const mockEmit = vi.fn()
  return {
    getIO: vi.fn(() => ({ emit: mockEmit })),
    createSocketIO: vi.fn(),
  }
})

describe('Session Routes', () => {
  let app: FastifyInstance
  let agentId1 = 'agent-001'
  let agentId2 = 'agent-002'

  beforeEach(async () => {
    setDb(createTestDb())
    initRepository(getDb())
    app = await buildTestApp()

    // 创建两个测试 Agent
    const db = (await import('../db/index.js')).getDb()
    db.prepare(
      `
      INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
      VALUES (?, ?, '🐱', 'prompt', 'deepseek', 'deepseek-v4-pro', 'sk-test')
    `
    ).run(agentId1, '店长阿暹')
    db.prepare(
      `
      INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
      VALUES (?, ?, '🐱', 'prompt', 'deepseek', 'deepseek-v4-pro', 'sk-test')
    `
    ).run(agentId2, '阿橘')

    // Import and register routes (must be after mock is set up)
    const { sessionRoutes } = await import('./sessions.js')
    await app.register(sessionRoutes)
  })

  afterEach(async () => {
    await app.close()
    resetDb()
  })

  describe('POST /api/sessions', () => {
    it('creates a session and returns 201', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: '测试会话', agentIds: [agentId1, agentId2] },
      })
      expect(res.statusCode).toBe(201)
      const body = JSON.parse(res.body)
      expect(body.title).toBe('测试会话')
      expect(body.agentIds).toEqual([agentId1, agentId2])
      expect(body.id).toBeDefined()
    })

    it('returns 400 for invalid agent IDs', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: '测试', agentIds: ['nonexistent'] },
      })
      expect(res.statusCode).toBe(400)
    })

    it('returns 400 for empty title', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: '', agentIds: [agentId1] },
      })
      expect(res.statusCode).toBe(400)
    })

    it('returns 400 for empty agentIds', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: '测试', agentIds: [] },
      })
      expect(res.statusCode).toBe(400)
    })
  })

  describe('GET /api/sessions', () => {
    it('returns empty array when no sessions', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/sessions' })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual([])
    })

    it('returns all sessions', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: 'S1', agentIds: [agentId1] },
      })
      await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: 'S2', agentIds: [agentId2] },
      })

      const res = await app.inject({ method: 'GET', url: '/api/sessions' })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toHaveLength(2)
    })
  })

  describe('GET /api/sessions/:id', () => {
    it('returns session with agent details', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: '详情测试', agentIds: [agentId1] },
      })
      const { id } = JSON.parse(create.body)

      const res = await app.inject({ method: 'GET', url: `/api/sessions/${id}` })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.title).toBe('详情测试')
      expect(body.agents).toBeDefined()
      expect(body.agents).toHaveLength(1)
      expect(body.agents[0].name).toBe('店长阿暹')
    })

    it('returns 404 for nonexistent session', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/sessions/nonexistent' })
      expect(res.statusCode).toBe(404)
    })
  })

  describe('PATCH /api/sessions/:id', () => {
    it('toggles broadcast mode', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: '广播测试', agentIds: [agentId1] },
      })
      const { id } = JSON.parse(create.body)
      expect(JSON.parse(create.body).broadcastMode).toBe(false)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/sessions/${id}`,
        payload: { broadcastMode: true },
      })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body).broadcastMode).toBe(true)
    })

    it('returns 404 for nonexistent session', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/sessions/nonexistent',
        payload: { broadcastMode: true },
      })
      expect(res.statusCode).toBe(404)
    })
  })

  describe('DELETE /api/sessions/:id', () => {
    it('deletes a session and returns ok', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: '删除测试', agentIds: [agentId1] },
      })
      const { id } = JSON.parse(create.body)

      const res = await app.inject({ method: 'DELETE', url: `/api/sessions/${id}` })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ ok: true })

      // 确认已删除
      const get = await app.inject({ method: 'GET', url: `/api/sessions/${id}` })
      expect(get.statusCode).toBe(404)
    })

    it('cascades to messages and execution_logs', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: '级联测试', agentIds: [agentId1] },
      })
      const { id } = JSON.parse(create.body)

      // 手动插入消息和执行日志
      const db = (await import('../db/index.js')).getDb()
      db.prepare(
        "INSERT INTO messages (id, session_id, role, content) VALUES ('m1', ?, 'user', 'hello')"
      ).run(id)
      db.prepare(
        `
        INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status)
        VALUES ('log1', ?, ?, 'm1', 'completed')
      `
      ).run(id, agentId1)

      // 删除
      const res = await app.inject({ method: 'DELETE', url: `/api/sessions/${id}` })
      expect(res.statusCode).toBe(200)

      // 确认消息和日志已级联删除
      const msg = db.prepare("SELECT * FROM messages WHERE id = 'm1'").get()
      expect(msg).toBeUndefined()
      const logRow = db.prepare("SELECT * FROM execution_logs WHERE id = 'log1'").get()
      expect(logRow).toBeUndefined()
    })

    it('returns 404 for nonexistent session', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/api/sessions/nonexistent' })
      expect(res.statusCode).toBe(404)
    })
  })

  describe('DELETE /api/sessions/:id/messages', () => {
    it('clears messages and execution_logs, keeps session', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: '清空测试', agentIds: [agentId1] },
      })
      const { id } = JSON.parse(create.body)

      const db = (await import('../db/index.js')).getDb()
      db.prepare(
        "INSERT INTO messages (id, session_id, role, content) VALUES ('m1', ?, 'user', 'hello')"
      ).run(id)
      db.prepare(
        "INSERT INTO messages (id, session_id, role, content) VALUES ('m2', ?, 'agent', 'hi')"
      ).run(id)
      db.prepare(
        `
        INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status)
        VALUES ('log1', ?, ?, 'm1', 'completed')
      `
      ).run(id, agentId1)

      const res = await app.inject({ method: 'DELETE', url: `/api/sessions/${id}/messages` })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.messagesRemoved).toBe(2)
      expect(body.executionLogsRemoved).toBe(1)

      // 确认消息和日志已删除
      const msgs = db.prepare('SELECT * FROM messages WHERE session_id = ?').all(id)
      expect(msgs).toHaveLength(0)
      const logs = db.prepare('SELECT * FROM execution_logs WHERE session_id = ?').all(id)
      expect(logs).toHaveLength(0)

      // 确认会话仍存在
      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)
      expect(session).toBeDefined()
    })

    it('returns ok for session with no messages', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { title: '空清空测试', agentIds: [agentId1] },
      })
      const { id } = JSON.parse(create.body)

      const res = await app.inject({ method: 'DELETE', url: `/api/sessions/${id}/messages` })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body).ok).toBe(true)
      expect(JSON.parse(res.body).messagesRemoved).toBe(0)
    })

    it('returns 404 for nonexistent session', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/api/sessions/nonexistent/messages' })
      expect(res.statusCode).toBe(404)
    })
  })
})
