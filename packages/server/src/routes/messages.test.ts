import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTestDb, buildTestApp } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository } from '../db/repository/index.js'
import type { FastifyInstance } from 'fastify'

// Mock socketio connector（GET 路由不调用，但 messages.ts 顶层 import 需要可解析）
vi.mock('../connectors/socketio.js', () => ({
  getIO: vi.fn(() => null),
  createSocketIO: vi.fn(),
  rowToAgent: vi.fn(),
  executeAgentsSerial: vi.fn(() => Promise.resolve()),
}))

describe('Message Routes', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    setDb(createTestDb())
    initRepository(getDb())
    app = await buildTestApp()
    const { messageRoutes } = await import('./messages.js')
    await app.register(messageRoutes)
  })

  afterEach(async () => {
    await app.close()
    resetDb()
  })

  describe('GET /api/messages/:id（handoff uuid 反查）', () => {
    it('returns sessionId for an existing message', async () => {
      const db = getDb()
      db.prepare(
        `INSERT INTO sessions (id, title, agent_ids, created_at, updated_at)
         VALUES (?, ?, '[]', datetime('now'), datetime('now'))`
      ).run('session-debug-1', 'debug')
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions)
         VALUES (?, ?, 'user', 'hello', '[]')`
      ).run('6cfecca8-ba78-4039-a12c-71313afd29cd', 'session-debug-1')

      const res = await app.inject({
        method: 'GET',
        url: '/api/messages/6cfecca8-ba78-4039-a12c-71313afd29cd',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.id).toBe('6cfecca8-ba78-4039-a12c-71313afd29cd')
      expect(body.sessionId).toBe('session-debug-1')
      expect(body.role).toBe('user')
    })

    it('returns 404 for unknown message', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/messages/nonexistent-id',
      })
      expect(res.statusCode).toBe(404)
      const body = JSON.parse(res.body)
      expect(body.error).toBeDefined()
    })
  })
})
