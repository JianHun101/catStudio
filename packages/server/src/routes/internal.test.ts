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
import { initRepository, knowledge as knowledgeRepo } from '../db/repository/index.js'
import { vectorToBlob } from '../memory/index.js'
import type { FastifyInstance } from 'fastify'
import { consumeRouteSignals, __test_resetRouteSignals } from '../llm/route-signals.js'

// Mock socketio connector：getActiveStream 受控返回活跃流（token 精确匹配用）
vi.mock('../connectors/socketio.js', () => ({
  getActiveStream: vi.fn(),
}))

// Mock embedding：knowledge-search 端点检索依赖 embedText（真实实现会触发
// ~100MB 模型下载）——测试返回固定 4-dim 向量（同向于 k-near fixture），
// 配合知识表 fixture 命中。vi.hoisted：internal.ts 的 import 链会立即触发
// factory（internal.ts → memory/index.ts → embedding.js），普通 const 声明
// 会 ReferenceError（hoisting 时未初始化）
const { mockEmbedText } = vi.hoisted(() => ({
  mockEmbedText: vi.fn(async () => [1, 0, 0, 0]),
}))
vi.mock('../memory/embedding.js', () => ({
  embedText: mockEmbedText,
}))

/** 插入会话 fixture：store 店长 + implementer 实施猫 + reviewer 吐槽猫（角色白名单判定用） */
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
    `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, llm_base_url, effort_level, skill_modules, role)
     VALUES (?, ?, '🐱', 'prompt', 'deepseek', 'model', 'key', '', 'high', '[]', ?)`
  ).run('agent-reviewer', '吐槽猫', 'reviewer')
  db.prepare(
    `INSERT INTO sessions (id, title, agent_ids, created_at, updated_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now'))`
  ).run('session-1', '测试会话', JSON.stringify(['agent-store', 'agent-impl', 'agent-reviewer']))
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

  describe('triggerAuthorName（OQ③ 补丁）', () => {
    /** reviewer 投递 body：target 实施猫（implementer）——正常会被角色白名单拦 */
    const reviewerBody = (over: Record<string, unknown> = {}) => ({
      sessionId: 'session-1',
      agentId: 'agent-reviewer',
      msgId: 'msg-r1',
      targetCats: ['实施猫'],
      ...over,
    })
    const mockActive = async () =>
      vi.mocked((await import('../connectors/socketio.js')).getActiveStream).mockReturnValue({
        sessionId: 'session-1',
        messageId: 'reply-1',
        content: '',
        token: VALID_TOKEN,
      })

    it('验收1a：reviewer 带 triggerAuthorName（= 请求人）→ 200 入 Map（特殊边放行）', async () => {
      await mockActive()
      const res = await app.inject({
        method: 'POST',
        url: '/api/internal/route-signals',
        payload: reviewerBody({ triggerAuthorName: '实施猫' }),
        headers: { 'x-signal-token': VALID_TOKEN },
      })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body).ok).toBe(true)
      const signals = consumeRouteSignals('session-1', 'agent-reviewer', 'msg-r1')
      expect(signals).toHaveLength(1)
      expect(signals[0].targetCats).toEqual(['实施猫'])
    })

    it('验收1b：对照——不带 triggerAuthorName → 仍 422（既有行为零回归）', async () => {
      await mockActive()
      const res = await app.inject({
        method: 'POST',
        url: '/api/internal/route-signals',
        payload: reviewerBody(),
        headers: { 'x-signal-token': VALID_TOKEN },
      })
      expect(res.statusCode).toBe(422)
      expect(JSON.parse(res.body).reason).toContain('role-not-allowed')
      // 未入 Map
      expect(consumeRouteSignals('session-1', 'agent-reviewer', 'msg-r1')).toHaveLength(0)
    })

    it('triggerAuthorName 非字符串 → 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/internal/route-signals',
        payload: reviewerBody({ triggerAuthorName: 123 }),
        headers: { 'x-signal-token': VALID_TOKEN },
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).reason).toContain('triggerAuthorName')
    })
  })

  describe('knowledge-search 端点', () => {
    const insertKnowledgeFixture = () => {
      knowledgeRepo.upsertKnowledge(
        'k-near',
        '提交规范：commit 必须带 catstudy [uuid] 标记',
        vectorToBlob([1, 0, 0, 0]),
        'docs/CONTEXT.md',
        ['git']
      )
      knowledgeRepo.upsertKnowledge(
        'k-far',
        '完全无关的知识条目',
        vectorToBlob([0, 1, 0, 0]),
        'docs/roadmap.md',
        ['other']
      )
    }
    const mockActive = async () =>
      vi.mocked((await import('../connectors/socketio.js')).getActiveStream).mockReturnValue({
        sessionId: 'session-1',
        messageId: 'reply-1',
        content: '',
        token: VALID_TOKEN,
      })

    describe('body 基本校验（400）', () => {
      it('缺 query 拒', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/knowledge-search',
          payload: { sessionId: 'session-1', agentId: 'agent-impl', msgId: 'msg-1' },
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(400)
        expect(JSON.parse(res.body).reason).toContain('query')
      })

      it('query 非字符串拒', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/knowledge-search',
          payload: { sessionId: 'session-1', agentId: 'agent-impl', msgId: 'msg-1', query: 123 },
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(400)
      })

      it('topK 越界（0 / 11 / 非整数）拒', async () => {
        for (const bad of [0, 11, 2.5]) {
          const res = await app.inject({
            method: 'POST',
            url: '/api/internal/knowledge-search',
            payload: {
              sessionId: 'session-1',
              agentId: 'agent-impl',
              msgId: 'msg-1',
              query: 'x',
              topK: bad,
            },
            headers: { 'x-signal-token': VALID_TOKEN },
          })
          expect(res.statusCode).toBe(400)
        }
      })
    })

    describe('鉴权链（404/401/409 与 route-signals 同款）', () => {
      it('无活跃流 → 404 + reason', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/knowledge-search',
          payload: { sessionId: 'session-1', agentId: 'agent-impl', msgId: 'msg-1', query: 'x' },
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(404)
        expect(JSON.parse(res.body).reason).toContain('无活跃流')
      })

      it('token 不匹配 → 401', async () => {
        await mockActive()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/knowledge-search',
          payload: { sessionId: 'session-1', agentId: 'agent-impl', msgId: 'msg-1', query: 'x' },
          headers: { 'x-signal-token': 'wrong-token' },
        })
        expect(res.statusCode).toBe(401)
      })

      it('sessionId 不匹配 → 409', async () => {
        await mockActive()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/knowledge-search',
          payload: {
            sessionId: 'session-other',
            agentId: 'agent-impl',
            msgId: 'msg-1',
            query: 'x',
          },
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(409)
      })
    })

    describe('检索成功路径（200）', () => {
      it('命中 → 200 + results 含 content/source/distance', async () => {
        await mockActive()
        insertKnowledgeFixture()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/knowledge-search',
          payload: {
            sessionId: 'session-1',
            agentId: 'agent-impl',
            msgId: 'msg-1',
            query: '提交规范',
          },
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.ok).toBe(true)
        expect(body.results).toHaveLength(1)
        expect(body.results[0]).toMatchObject({
          id: 'k-near',
          content: expect.stringContaining('catstudy [uuid]'),
          source: 'docs/CONTEXT.md',
          distance: 0,
        })
      })

      it('topK 透传生效（默认 3 → 显式 1 截断）', async () => {
        await mockActive()
        insertKnowledgeFixture()
        // 两条同向条目 + topK=1 → 只返回 1 条
        knowledgeRepo.upsertKnowledge('k-near2', '第二条同向', vectorToBlob([1, 0, 0, 0]), 's2', [
          'a',
        ])
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/knowledge-search',
          payload: {
            sessionId: 'session-1',
            agentId: 'agent-impl',
            msgId: 'msg-1',
            query: 'x',
            topK: 1,
          },
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(200)
        expect(JSON.parse(res.body).results).toHaveLength(1)
      })

      it('嵌入失败（空向量）→ 200 + 空结果（降级不阻塞）', async () => {
        await mockActive()
        mockEmbedText.mockResolvedValueOnce([])
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/knowledge-search',
          payload: { sessionId: 'session-1', agentId: 'agent-impl', msgId: 'msg-1', query: 'x' },
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(200)
        expect(JSON.parse(res.body)).toEqual({ ok: true, results: [] })
      })

      it('空命中 → 200 + 空结果', async () => {
        await mockActive()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/knowledge-search',
          payload: { sessionId: 'session-1', agentId: 'agent-impl', msgId: 'msg-1', query: 'x' },
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(200)
        expect(JSON.parse(res.body)).toEqual({ ok: true, results: [] })
      })
    })
  })
})
