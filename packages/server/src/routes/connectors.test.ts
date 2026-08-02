/**
 * connectors 路由测试（P2 AC2/AC3）。
 *
 * 覆盖：绑定管理 CRUD + 校验；webhook 四类 payload（@机器人+@猫名 / 纯@机器人 /
 * 无绑定群 / 自己发的消息）+ 非 message 事件 + 私聊 + saveMemory 断言 + 503 开关。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTestDb, buildTestApp } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository, connectorBindings as bindingsRepo } from '../db/repository/index.js'
import type { FastifyInstance } from 'fastify'
import { saveMessageMemory } from '../memory/index.js'

// Mock socketio connector（ingest 顶层 import 需要可解析；getIO null → 广播/执行跳过）
vi.mock('../connectors/socketio.js', () => ({
  getIO: vi.fn(() => null),
  createSocketIO: vi.fn(),
  rowToAgent: vi.fn(),
  executeAgentsSerial: vi.fn(() => Promise.resolve()),
}))

// Mock memory——断言 webhook 摄入显式传 saveMemory: true（吐槽猫审查观察点 #1 的护栏：
// "saveMemory=false 不被调用" 的测试钉死由 webhook 侧 "saveMemory=true 必被调用" 保证）
vi.mock('../memory/index.js', () => ({
  saveMessageMemory: vi.fn(() => Promise.resolve()),
}))

/** 插入绑定 fixture：agent-ds（ds猫）→ session-qq-1，绑定 qq/group/555 */
const insertBoundFixture = () => {
  const db = getDb()
  db.prepare(
    `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, llm_base_url, effort_level, skill_modules)
     VALUES (?, ?, '🐱', 'prompt', 'deepseek', 'model', 'key', '', 'high', '[]')`
  ).run('agent-ds', 'ds猫')
  db.prepare(
    `INSERT INTO sessions (id, title, agent_ids, broadcast_mode, created_at, updated_at)
     VALUES (?, ?, ?, 0, datetime('now'), datetime('now'))`
  ).run('session-qq-1', 'QQ 群绑定会话', JSON.stringify(['agent-ds']))
  bindingsRepo.upsertConnectorBinding('qq', 'group', '555', 'session-qq-1')
}

/** 构造群消息事件（默认 @机器人 + @ds猫） */
const groupEvent = (overrides: Record<string, unknown> = {}) => ({
  post_type: 'message',
  message_type: 'group',
  self_id: 10000,
  user_id: 999,
  group_id: 555,
  message: [
    { type: 'at', data: { qq: 10000 } },
    { type: 'text', data: { text: ' @ds猫 帮我看看' } },
  ],
  sender: { user_id: 999, nickname: '小明' },
  ...overrides,
})

const countMessages = (): number => {
  const row = getDb().prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }
  return row.c
}

describe('Connector Routes', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    process.env.ONEBOT_ENABLED = 'true'
    vi.clearAllMocks()
    setDb(createTestDb())
    initRepository(getDb())
    app = await buildTestApp()
    const { connectorRoutes } = await import('./connectors.js')
    await app.register(connectorRoutes)
  })

  afterEach(async () => {
    await app.close()
    resetDb()
    delete process.env.ONEBOT_ENABLED
  })

  describe('绑定管理 CRUD', () => {
    it('POST creates a binding', async () => {
      const db = getDb()
      db.prepare(
        `INSERT INTO sessions (id, title, agent_ids, created_at, updated_at)
         VALUES ('session-b', 's', '[]', datetime('now'), datetime('now'))`
      ).run()
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/bindings',
        payload: {
          platform: 'qq',
          externalType: 'group',
          externalId: '123',
          sessionId: 'session-b',
        },
      })
      expect(res.statusCode).toBe(201)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.binding.session_id).toBe('session-b')
      expect(body.binding.external_type).toBe('group')
      expect(body.binding.external_id).toBe('123')
    })

    it('POST validation: 400 for missing fields / bad externalType', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/bindings',
        payload: { platform: 'qq' },
      })
      expect(res.statusCode).toBe(400)

      const res2 = await app.inject({
        method: 'POST',
        url: '/api/connectors/bindings',
        payload: { platform: 'qq', externalType: 'channel', externalId: '1', sessionId: 's' },
      })
      expect(res2.statusCode).toBe(400)
    })

    it('POST with nonexistent session → 404', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/bindings',
        payload: { platform: 'qq', externalType: 'group', externalId: '1', sessionId: 'no-such' },
      })
      expect(res.statusCode).toBe(404)
    })

    it('GET lists bindings, optionally filtered by platform', async () => {
      insertBoundFixture()
      const db = getDb()
      db.prepare(
        `INSERT INTO sessions (id, title, agent_ids, created_at, updated_at)
         VALUES ('session-c', 'c', '[]', datetime('now'), datetime('now'))`
      ).run()
      bindingsRepo.upsertConnectorBinding('wechat', 'group', '9', 'session-c')

      const all = await app.inject({ method: 'GET', url: '/api/connectors/bindings' })
      expect(JSON.parse(all.body).bindings).toHaveLength(2)

      const qq = await app.inject({ method: 'GET', url: '/api/connectors/bindings?platform=qq' })
      const qqBody = JSON.parse(qq.body)
      expect(qqBody.bindings).toHaveLength(1)
      expect(qqBody.bindings[0].platform).toBe('qq')
    })

    it('DELETE removes a binding; DELETE missing → 404', async () => {
      insertBoundFixture()
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/connectors/bindings',
        payload: { platform: 'qq', externalType: 'group', externalId: '555' },
      })
      expect(res.statusCode).toBe(200)
      expect(bindingsRepo.getConnectorBinding('qq', 'group', '555')).toBeUndefined()

      const res2 = await app.inject({
        method: 'DELETE',
        url: '/api/connectors/bindings',
        payload: { platform: 'qq', externalType: 'group', externalId: '555' },
      })
      expect(res2.statusCode).toBe(404)
    })
  })

  describe('OneBot webhook', () => {
    it('AC3: ONEBOT_ENABLED=false → 503', async () => {
      process.env.ONEBOT_ENABLED = 'false'
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/onebot/webhook',
        payload: groupEvent(),
      })
      expect(res.statusCode).toBe(503)
      expect(countMessages()).toBe(0)
    })

    it('AC2-1: @机器人+@猫名 → 落库子会话、mentions、昵称前缀，且 saveMemory=true 被调用', async () => {
      insertBoundFixture()
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/onebot/webhook',
        payload: groupEvent(),
      })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body).ok).toBe(true)

      const rows = getDb().prepare('SELECT * FROM messages').all() as any[]
      expect(rows).toHaveLength(1)
      expect(rows[0].session_id).toBe('session-qq-1')
      expect(JSON.parse(rows[0].mentions)).toEqual(['ds猫'])
      expect(rows[0].content).toBe('[小明]: @ds猫 帮我看看')

      // 吐槽猫观察点 #1 护栏：OneBot 真实对话必须进向量记忆库
      expect(saveMessageMemory).toHaveBeenCalledWith(
        'session-qq-1',
        '[小明]: @ds猫 帮我看看',
        expect.any(String),
        []
      )
    })

    it('AC2-2: 纯@机器人无猫名 → mentions=[] 广播', async () => {
      insertBoundFixture()
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/onebot/webhook',
        payload: groupEvent({
          message: [
            { type: 'at', data: { qq: 10000 } },
            { type: 'text', data: { text: '在吗' } },
          ],
        }),
      })
      expect(res.statusCode).toBe(200)
      const rows = getDb().prepare('SELECT * FROM messages').all() as any[]
      expect(rows).toHaveLength(1)
      expect(JSON.parse(rows[0].mentions)).toEqual([])
      expect(rows[0].content).toBe('[小明]: 在吗')
    })

    it('AC2-3: 无绑定群 → 200 静默忽略，不落库', async () => {
      insertBoundFixture()
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/onebot/webhook',
        payload: groupEvent({ group_id: 7777 }),
      })
      expect(res.statusCode).toBe(200)
      expect(countMessages()).toBe(0)
    })

    it('AC2-4: 自己发的消息（user_id===self_id）→ 200 静默忽略，不落库', async () => {
      insertBoundFixture()
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/onebot/webhook',
        payload: groupEvent({ user_id: 10000 }),
      })
      expect(res.statusCode).toBe(200)
      expect(countMessages()).toBe(0)
    })

    it('非 message 事件（notice）→ 200 静默忽略，不落库', async () => {
      insertBoundFixture()
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/onebot/webhook',
        payload: {
          post_type: 'notice',
          notice_type: 'group_increase',
          self_id: 10000,
          user_id: 999,
        },
      })
      expect(res.statusCode).toBe(200)
      expect(countMessages()).toBe(0)
    })

    it('群聊未@机器人 → 200 静默忽略，不落库', async () => {
      insertBoundFixture()
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/onebot/webhook',
        payload: groupEvent({ message: [{ type: 'text', data: { text: '闲聊' } }] }),
      })
      expect(res.statusCode).toBe(200)
      expect(countMessages()).toBe(0)
    })

    it('私聊事件走 user_id 绑定查找 → 落库', async () => {
      const db = getDb()
      db.prepare(
        `INSERT INTO sessions (id, title, agent_ids, created_at, updated_at)
         VALUES ('session-qq-p', 'p', '[]', datetime('now'), datetime('now'))`
      ).run()
      bindingsRepo.upsertConnectorBinding('qq', 'private', '999', 'session-qq-p')
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/onebot/webhook',
        payload: {
          post_type: 'message',
          message_type: 'private',
          self_id: 10000,
          user_id: 999,
          message: [{ type: 'text', data: { text: '你好' } }],
          sender: { user_id: 999, nickname: '小红' },
        },
      })
      expect(res.statusCode).toBe(200)
      const rows = getDb().prepare('SELECT * FROM messages').all() as any[]
      expect(rows).toHaveLength(1)
      expect(rows[0].session_id).toBe('session-qq-p')
      expect(rows[0].content).toBe('[小红]: 你好')
    })

    it('非法 body（无 payload）→ 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/onebot/webhook',
      })
      expect(res.statusCode).toBe(400)
    })
  })
})
