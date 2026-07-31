import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
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

  describe('POST /api/messages（REST 注入通道图片守卫）', () => {
    // 对齐 socketio.test.ts 的 SEND_MESSAGE 守卫覆盖（前缀/大小/数量三重防线）
    const insertSession = (id: string) => {
      const db = getDb()
      db.prepare(
        `INSERT INTO sessions (id, title, agent_ids, created_at, updated_at)
         VALUES (?, ?, '[]', datetime('now'), datetime('now'))`
      ).run(id, 'rest-test')
    }

    const postMessage = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/messages', payload })

    const lastStoredImages = (sessionId: string): string[] => {
      const row = getDb()
        .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(sessionId) as any
      return JSON.parse(row.images)
    }

    it('drops images without data:image/ prefix (server guard)', async () => {
      insertSession('session-rest-guard-1')
      const res = await postMessage({
        sessionId: 'session-rest-guard-1',
        content: '防垃圾',
        mentions: [],
        images: ['data:image/png;base64,OK', 'not-an-image', 'javascript:alert(1)'],
      })
      expect(res.statusCode).toBe(201)
      // 非法前缀被过滤，只保留合法 data:image/ 项（与 socket 侧同构）
      expect(lastStoredImages('session-rest-guard-1')).toEqual(['data:image/png;base64,OK'])
    })

    it('drops oversized images (>3MB) (server guard)', async () => {
      // Fastify 默认 bodyLimit 1MB 会先于路由 413 拒绝（双层防线），
      // 这里放大 bodyLimit 以触达路由自身的 3MB 单图守卫
      const bigApp = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 })
      const { messageRoutes } = await import('./messages.js')
      await bigApp.register(messageRoutes)
      try {
        insertSession('session-rest-guard-2')
        const oversized = 'data:image/png;base64,' + 'A'.repeat(3 * 1024 * 1024) // 超过 3MB 上限
        const res = await bigApp.inject({
          method: 'POST',
          url: '/api/messages',
          payload: {
            sessionId: 'session-rest-guard-2',
            content: '防滥用',
            mentions: [],
            images: ['data:image/png;base64,small', oversized],
          },
        })
        expect(res.statusCode).toBe(201)
        const stored = lastStoredImages('session-rest-guard-2')
        expect(stored).toEqual(['data:image/png;base64,small'])
        expect(stored).not.toContain(oversized)
      } finally {
        await bigApp.close()
      }
    })

    it('truncates images to 4 (server guard)', async () => {
      insertSession('session-rest-guard-3')
      const res = await postMessage({
        sessionId: 'session-rest-guard-3',
        content: '防滥用',
        mentions: [],
        images: [
          'data:image/png;base64,1',
          'data:image/png;base64,2',
          'data:image/png;base64,3',
          'data:image/png;base64,4',
          'data:image/png;base64,5',
        ],
      })
      expect(res.statusCode).toBe(201)
      const stored = lastStoredImages('session-rest-guard-3')
      expect(stored).toHaveLength(4)
      expect(stored).not.toContain('data:image/png;base64,5')
    })
  })
})
