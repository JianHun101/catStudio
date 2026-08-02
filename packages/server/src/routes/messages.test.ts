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

  describe('GET /api/messages/:id/executor（实施者反查，handoff-gen 动态补填人）', () => {
    const insertFixture = (triggeredBy: string) => {
      const db = getDb()
      db.prepare(
        `INSERT INTO sessions (id, title, agent_ids, created_at, updated_at)
         VALUES (?, ?, '[]', datetime('now'), datetime('now'))`
      ).run('session-exec-1', 'debug')
      db.prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, llm_base_url, effort_level, skill_modules)
         VALUES (?, ?, '🐯', 'prompt', 'claude', 'model', 'key', '', 'high', '[]')`
      ).run('agent-ds', 'ds猫')
      db.prepare(
        `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, started_at)
         VALUES (?, ?, ?, ?, 'completed', datetime('now'))`
      ).run('log-1', 'session-exec-1', 'agent-ds', triggeredBy)
    }

    it('returns executor agentName for a message with execution log', async () => {
      insertFixture('6cfecca8-ba78-4039-a12c-71313afd29cd')
      const res = await app.inject({
        method: 'GET',
        url: '/api/messages/6cfecca8-ba78-4039-a12c-71313afd29cd/executor',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.agentId).toBe('agent-ds')
      expect(body.agentName).toBe('ds猫')
    })

    it('returns 404 when no execution log exists for the message', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/messages/6cfecca8-ba78-4039-a12c-71313afd29cd/executor',
      })
      expect(res.statusCode).toBe(404)
    })

    it('returns the latest execution when multiple agents were triggered', async () => {
      const db = getDb()
      insertFixture('6cfecca8-ba78-4039-a12c-71313afd29cd')
      db.prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, llm_base_url, effort_level, skill_modules)
         VALUES (?, ?, '😼', 'prompt', 'claude', 'model', 'key', '', 'high', '[]')`
      ).run('agent-reviewer', '吐槽猫')
      db.prepare(
        `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, started_at)
         VALUES (?, ?, ?, ?, 'failed', datetime('now', '+1 minute'))`
      ).run('log-2', 'session-exec-1', 'agent-reviewer', '6cfecca8-ba78-4039-a12c-71313afd29cd')
      const res = await app.inject({
        method: 'GET',
        url: '/api/messages/6cfecca8-ba78-4039-a12c-71313afd29cd/executor',
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.agentName).toBe('吐槽猫')
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
      // 双层防线：生产 Fastify 默认 bodyLimit 1MB 会先于路由 413 拒绝整个请求体，
      // 路由的 3MB 单图守卫（与 socket 侧同构）是兜底——生产 REST 实际单图上限是 1MB，
      // 严于 socket 的 3MB；若 REST 真要传大图，需同步调 bodyLimit 才够
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

  describe('POST /api/messages（已交接会话路由兜底，方案 A）', () => {
    const insertSession = (
      id: string,
      opts: { handoffFrom?: string; runningSummary?: string | null } = {}
    ) => {
      getDb()
        .prepare(
          `INSERT INTO sessions (id, title, agent_ids, handoff_from, running_summary, created_at, updated_at)
           VALUES (?, 'test', '[]', ?, ?, datetime('now'), datetime('now'))`
        )
        .run(id, opts.handoffFrom ?? null, opts.runningSummary ?? null)
    }

    const insertMessage = (id: string, sessionId: string) => {
      getDb()
        .prepare(
          `INSERT INTO messages (id, session_id, role, content, mentions)
           VALUES (?, ?, 'user', 'hello', '[]')`
        )
        .run(id, sessionId)
    }

    const postMessage = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/messages', payload })

    it('AC4: 发往已交接旧会话 → 消息落子会话，响应带 redirectedTo', async () => {
      insertSession('old-session')
      insertSession('child-session', {
        handoffFrom: 'old-session',
        runningSummary: JSON.stringify({ text: '总结' }),
      })
      insertMessage('m-1', 'child-session')

      const res = await postMessage({ sessionId: 'old-session', content: '还在吗', mentions: [] })

      expect(res.statusCode).toBe(201)
      const body = JSON.parse(res.body)
      expect(body.redirectedTo).toBe('child-session')
      // 消息落子会话（1 条 fixture + 1 条新消息）；旧会话无新消息
      const childCount = getDb()
        .prepare('SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?')
        .get('child-session') as any
      expect(childCount.cnt).toBe(2)
      const oldCount = getDb()
        .prepare('SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?')
        .get('old-session') as any
      expect(oldCount.cnt).toBe(0)
    })

    it('AC5: 未交接会话 → 消息留在原会话，响应无 redirectedTo', async () => {
      insertSession('normal-session')

      const res = await postMessage({
        sessionId: 'normal-session',
        content: '普通消息',
        mentions: [],
      })

      expect(res.statusCode).toBe(201)
      const body = JSON.parse(res.body)
      expect(body.redirectedTo).toBeUndefined()
      const count = getDb()
        .prepare('SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?')
        .get('normal-session') as any
      expect(count.cnt).toBe(1)
    })
  })
})
