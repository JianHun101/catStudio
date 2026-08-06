/**
 * internal 路由测试（MCP 结构化路由 v4 信号入口）。
 *
 * 覆盖校验顺序（店长裁决二钉死）：body 基本校验 400 → lookup 活跃流 404 →
 * token 精确匹配 401 → 复合键 sessionId 409 → 目标预校验 422（会话成员 +
 * 角色白名单）→ 入 Map 200。活跃流来自 mock getActiveStream（真实模块的
 * 标签语义由 route-signals.test.ts 单测覆盖，此处只测端点校验链）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTestDb, buildTestApp } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository } from '../db/repository/index.js'
import type { FastifyInstance } from 'fastify'
import { consumeRouteSignals, __test_resetRouteSignals } from '../llm/route-signals.js'

// Mock socketio connector：getActiveStream 受控返回活跃流（token 精确匹配用）
vi.mock('../connectors/socketio.js', () => ({
  getActiveStream: vi.fn(),
}))

/** 插入会话 fixture：store 店长 + implementer 实施猫（角色白名单判定用） */
const insertFixture = () => {
  const db = getDb()
  db.prepare(
    `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, llm_base_url, effort_level, skill_modules, role)
     VALUES (?, ?, '🐱', 'prompt', 'deepseek', 'model', 'key', '', 'high', '[]', ?)`
  ).run('agent-store', '店长', 'store')
  db.prepare(
    `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, llm_base_url, effort_level, skill_modules, role)
     VALUES (?, ?, '🐱', 'prompt', 'deepseek', 'model', 'key', '', 'high', '[]', ?)`
  ).run('agent-impl', '实施猫', 'implementer')
  db.prepare(
    `INSERT INTO sessions (id, title, agent_ids, created_at, updated_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))`
  ).run('session-1', '测试会话', JSON.stringify(['agent-store', 'agent-impl']))
}

const VALID_TOKEN = 'token-abc-123'

/** 合法请求体（发送者 = 实施猫，目标 = 店长——implementer 白名单 {store, reviewer} 内） */
const goodBody = () => ({
  sessionId: 'session-1',
  agentId: 'agent-impl',
  msgId: 'msg-1',
  targetCats: ['店长'],
})

describe('internal route-signals', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    vi.clearAllMocks()
    __test_resetRouteSignals()
    setDb(createTestDb())
    initRepository(getDb())
    insertFixture()
    app = await buildTestApp()
    const { internalRoutes } = await import('./internal.js')
    await app.register(internalRoutes)
    // 默认：无活跃流（每个用例按需覆盖）
    vi.mocked((await import('../connectors/socketio.js')).getActiveStream).mockReturnValue(
      undefined
    )
  })

  afterEach(async () => {
    await app.close()
    resetDb()
  })

  describe('body 基本校验（400）', () => {
    it('缺 targetCats 拒', async () => {
      // 显式 unknown 记录以允许 delete（TS2790：delete 操作数须 optional）
      const body: Record<string, unknown> = { ...goodBody() }
      delete body.targetCats
      const res = await app.inject({
        method: 'POST',
        url: '/api/internal/route-signals',
        payload: body,
        headers: { 'x-signal-token': VALID_TOKEN },
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).reason).toContain('targetCats')
    })

    it('targetCats 空数组拒', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/internal/route-signals',
        payload: { ...goodBody(), targetCats: [] },
        headers: { 'x-signal-token': VALID_TOKEN },
      })
      expect(res.statusCode).toBe(400)
    })

    it('clientMessageId 非字符串拒', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/internal/route-signals',
        payload: { ...goodBody(), clientMessageId: 123 },
        headers: { 'x-signal-token': VALID_TOKEN },
      })
      expect(res.statusCode).toBe(400)
    })
  })

  describe('活跃流与 token（404/401）', () => {
    it('无活跃流 → 404 + reason 回模型', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/internal/route-signals',
        payload: goodBody(),
        headers: { 'x-signal-token': VALID_TOKEN },
      })
      expect(res.statusCode).toBe(404)
      expect(JSON.parse(res.body).reason).toContain('无活跃流')
    })

    it('token 不匹配 → 401', async () => {
      vi.mocked((await import('../connectors/socketio.js')).getActiveStream).mockReturnValue({
        sessionId: 'session-1',
        messageId: 'reply-1',
        content: '',
        token: VALID_TOKEN,
      })
      const res = await app.inject({
        method: 'POST',
        url: '/api/internal/route-signals',
        payload: goodBody(),
        headers: { 'x-signal-token': 'wrong-token' },
      })
      expect(res.statusCode).toBe(401)
      expect(JSON.parse(res.body).reason).toContain('token')
    })

    it('缺 x-signal-token 头 → 401', async () => {
      vi.mocked((await import('../connectors/socketio.js')).getActiveStream).mockReturnValue({
        sessionId: 'session-1',
        messageId: 'reply-1',
        content: '',
        token: VALID_TOKEN,
      })
      const res = await app.inject({
        method: 'POST',
        url: '/api/internal/route-signals',
        payload: goodBody(),
      })
      expect(res.statusCode).toBe(401)
    })
  })

  describe('复合键与目标预校验（409/422）', () => {
    it('活跃流在别的会话 → 409', async () => {
      vi.mocked((await import('../connectors/socketio.js')).getActiveStream).mockReturnValue({
        sessionId: 'session-other',
        messageId: 'reply-1',
        content: '',
        token: VALID_TOKEN,
      })
      const res = await app.inject({
        method: 'POST',
        url: '/api/internal/route-signals',
        payload: goodBody(),
        headers: { 'x-signal-token': VALID_TOKEN },
      })
      expect(res.statusCode).toBe(409)
    })

    it('目标不在会话成员 → 422 + 点名', async () => {
      vi.mocked((await import('../connectors/socketio.js')).getActiveStream).mockReturnValue({
        sessionId: 'session-1',
        messageId: 'reply-1',
        content: '',
        token: VALID_TOKEN,
      })
      const res = await app.inject({
        method: 'POST',
        url: '/api/internal/route-signals',
        payload: { ...goodBody(), targetCats: ['不存在的猫'] },
        headers: { 'x-signal-token': VALID_TOKEN },
      })
      expect(res.statusCode).toBe(422)
      expect(JSON.parse(res.body).reason).toContain('不存在的猫')
    })

    it('角色白名单拦截（implementer @ implementer）→ 422', async () => {
      vi.mocked((await import('../connectors/socketio.js')).getActiveStream).mockReturnValue({
        sessionId: 'session-1',
        messageId: 'reply-1',
        content: '',
        token: VALID_TOKEN,
      })
      const res = await app.inject({
        method: 'POST',
        url: '/api/internal/route-signals',
        payload: { ...goodBody(), targetCats: ['实施猫'] },
        headers: { 'x-signal-token': VALID_TOKEN },
      })
      expect(res.statusCode).toBe(422)
      expect(JSON.parse(res.body).reason).toContain('role-not-allowed')
    })
  })

  describe('成功路径（200 入 Map）', () => {
    it('全过 → 200 + 信号可被同 msgId 消费', async () => {
      vi.mocked((await import('../connectors/socketio.js')).getActiveStream).mockReturnValue({
        sessionId: 'session-1',
        messageId: 'reply-1',
        content: '',
        token: VALID_TOKEN,
      })
      const res = await app.inject({
        method: 'POST',
        url: '/api/internal/route-signals',
        payload: goodBody(),
        headers: { 'x-signal-token': VALID_TOKEN },
      })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body).ok).toBe(true)

      const signals = consumeRouteSignals('session-1', 'agent-impl', 'msg-1')
      expect(signals).toHaveLength(1)
      expect(signals[0].targetCats).toEqual(['店长'])
      expect(signals[0].msgId).toBe('msg-1')
    })

    it('同流重复投递合并目标去重（storeRouteSignal 语义经端点生效）', async () => {
      vi.mocked((await import('../connectors/socketio.js')).getActiveStream).mockReturnValue({
        sessionId: 'session-1',
        messageId: 'reply-1',
        content: '',
        token: VALID_TOKEN,
      })
      const send = () =>
        app.inject({
          method: 'POST',
          url: '/api/internal/route-signals',
          payload: goodBody(),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
      await send()
      const res2 = await app.inject({
        method: 'POST',
        url: '/api/internal/route-signals',
        payload: { ...goodBody(), targetCats: ['店长', '店长'] },
        headers: { 'x-signal-token': VALID_TOKEN },
      })
      expect(res2.statusCode).toBe(200)
      const signals = consumeRouteSignals('session-1', 'agent-impl', 'msg-1')
      expect(signals).toHaveLength(1)
      expect(signals[0].targetCats).toEqual(['店长'])
    })
  })
})
