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
import type { EmbedResult } from '../memory/embedding-client.js'
import type { FastifyInstance } from 'fastify'
import { consumeRouteSignals, __test_resetRouteSignals } from '../llm/route-signals.js'
import {
  consumeUserRequestSignals,
  __test_resetUserRequestSignals,
} from '../llm/user-request-signals.js'

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
  // 票丁后返回形态为 {ok, vector}（失败 = 带 reason 的对象，不再返回空数组）
  mockEmbedText: vi.fn(async (): Promise<EmbedResult> => ({ ok: true, vector: [1, 0, 0, 0] })),
}))
vi.mock('../memory/embedding.js', () => ({
  embedText: mockEmbedText,
}))

// Mock create-pr：端点只做「角色白名单 + 透传」，createPr 业务逻辑由
// git/create-pr.test.ts 单测覆盖——真实 gh/git 绝不在端点测试执行
vi.mock('../git/create-pr.js', () => ({
  createPr: vi.fn(),
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
    __test_resetUserRequestSignals()
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
    // 默认：createPr 成功（业务失败分支用例按需覆盖）
    vi.mocked((await import('../git/create-pr.js')).createPr).mockResolvedValue({
      ok: true,
      number: 123,
      url: 'https://github.com/org/repo/pull/123',
    } as any)
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

  describe('reviewer 目标放行（边表 + triggerAuthorName 例外）', () => {
    /** reviewer 投递 body：target 实施猫（implementer）——边表内，放行 */
    const reviewerBody = (over: Record<string, unknown> = {}) => ({
      sessionId: 'session-1',
      agentId: 'agent-reviewer',
      msgId: 'msg-r1',
      targetCats: ['实施猫'],
      ...over,
    })
    /** 插入第二位 reviewer（**真正不在 reviewer 边表里的角色**：reviewer 边表 =
     *  {store, implementer}，reviewer 自身不在其中）并加入会话成员——1a/1c 共用。
     *  原用 vision 图测猫，随角色退役改为 reviewer（2026-09-13 单A）。 */
    const insertSecondReviewerCat = () => {
      const db = getDb()
      db.prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, llm_base_url, effort_level, skill_modules, role)
         VALUES ('agent-reviewer-2', '副审查猫', '🐱', 'prompt', 'deepseek', 'model', 'key', '', 'high', '[]', 'reviewer')`
      ).run()
      db.prepare(`UPDATE sessions SET agent_ids = ? WHERE id = 'session-1'`).run(
        JSON.stringify(['agent-store', 'agent-impl', 'agent-reviewer', 'agent-reviewer-2'])
      )
    }
    const mockActive = async () =>
      vi.mocked((await import('../connectors/socketio.js')).getActiveStream).mockReturnValue({
        sessionId: 'session-1',
        messageId: 'reply-1',
        content: '',
        token: VALID_TOKEN,
      })

    it('验收1a：reviewer @ 另一位 reviewer 带 triggerAuthorName（= 请求人）→ 200 入 Map（特殊边放行）', async () => {
      // 边表补 implementer 后，用 implementer 当 target 已无法隔离「特殊边」——
      // 边表本身就放行（见 1b，两者的 200 无法区分归因）。改用非边表角色
      // reviewer 自身验证例外边：只有 triggerAuthorName 命中才 200（与 1c 的无
      // triggerAuthorName → 422 成对，否则例外边只剩负例、正例零覆盖）。
      await mockActive()
      insertSecondReviewerCat()
      const res = await app.inject({
        method: 'POST',
        url: '/api/internal/route-signals',
        payload: reviewerBody({ targetCats: ['副审查猫'], triggerAuthorName: '副审查猫' }),
        headers: { 'x-signal-token': VALID_TOKEN },
      })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body).ok).toBe(true)
      const signals = consumeRouteSignals('session-1', 'agent-reviewer', 'msg-r1')
      expect(signals).toHaveLength(1)
      expect(signals[0].targetCats).toEqual(['副审查猫'])
    })

    it('验收1b：reviewer @ 实施猫 不带 triggerAuthorName → 仍 200（边表放行，不依赖触发者）', async () => {
      // 收口链回作者通路修复：边表补 reviewer→implementer 后，触发者是用户/店长
      // 时也能投回作者（原行为 422——「作者」概念在白名单里根本不存在）
      await mockActive()
      const res = await app.inject({
        method: 'POST',
        url: '/api/internal/route-signals',
        payload: reviewerBody(),
        headers: { 'x-signal-token': VALID_TOKEN },
      })
      expect(res.statusCode).toBe(200)
      expect(consumeRouteSignals('session-1', 'agent-reviewer', 'msg-r1')[0].targetCats).toEqual([
        '实施猫',
      ])
    })

    it('验收1c：reviewer @ 另一位 reviewer（非边表角色）不带 triggerAuthorName → 仍 422（不放开）', async () => {
      await mockActive()
      insertSecondReviewerCat()
      const res = await app.inject({
        method: 'POST',
        url: '/api/internal/route-signals',
        payload: reviewerBody({ targetCats: ['副审查猫'] }),
        headers: { 'x-signal-token': VALID_TOKEN },
      })
      expect(res.statusCode).toBe(422)
      // 钉完整串（票乙 P2 顺带收紧）：本笔把 422 串从「一句拼所有 reason」改成
      // 「按 reason 分句」，纯 role-not-allowed 时的输出必须与改动前**逐字节恒等**
      // ——这条断言就是那个「零漂移」声称的探针，`toContain` 证不了它。
      expect(JSON.parse(res.body).reason).toBe(
        '目标不在角色允许范围内（副审查猫:role-not-allowed）——请改投文本行首 @ 或调整目标'
      )
      // 未入 Map
      expect(consumeRouteSignals('session-1', 'agent-reviewer', 'msg-r1')).toHaveLength(0)
    })

    it('验收1d（票乙单目标闸）：reviewer 一次投 2 个合法目标 → 422，不静默剥除', async () => {
      // 文本路径（serial.ts）由白名单按**审查结论**剥到 1 个；MCP 路径没有正文、
      // 判不出结论，故沿用既有 422 契约把球踢回模型，由它自己收敛到一个目标重投。
      // 两个目标都在 reviewer 边表内（店长 store / 实施猫 implementer）——422 的
      // 唯一来源是单目标闸，不是角色边表（后者由 1c 覆盖，两者 reason 不同）。
      // 钉**完整串**（审查 ⚠️ P2）：只钉 `toContain('count-limit')` 时，串里的
      // 前导句写错也照样绿——正是本笔要修的那个缺陷能溜过测试的原因。
      // 无 triggerAuthorName ⇒ 结论不可得档 → 保实施侧（剥店长）。
      await mockActive()
      const res = await app.inject({
        method: 'POST',
        url: '/api/internal/route-signals',
        payload: reviewerBody({ targetCats: ['店长', '实施猫'] }),
        headers: { 'x-signal-token': VALID_TOKEN },
      })
      expect(res.statusCode).toBe(422)
      expect(JSON.parse(res.body).reason).toBe(
        '一条回复最多 @ 1 个目标，请收敛到一个目标重投（店长:count-limit）'
      )
      // 未入 Map——422 不是「部分成功」
      expect(consumeRouteSignals('session-1', 'agent-reviewer', 'msg-r1')).toHaveLength(0)
    })

    it('验收1e（票乙 P2）：role-not-allowed 与 count-limit 同轮 → 两因各说各的，不合并成一句假话', async () => {
      // 混合态可达：reviewer 边表 = {store, implementer} ∪ 请求人，故 @ 另一位
      // reviewer 落 role-not-allowed、@ 店长+实施猫落 count-limit。旧实现只有一句
      // 「目标不在角色允许范围内（…）」把两者并报——对超上限那两个目标是假话。
      // 本用例钉的是「分句」本身：两段同时在、顺序固定（role 段在前）、
      // 且 role 段与 1c 的单独串逐字节相同（契约面不因混合态而漂移）。
      await mockActive()
      insertSecondReviewerCat()
      const res = await app.inject({
        method: 'POST',
        url: '/api/internal/route-signals',
        payload: reviewerBody({ targetCats: ['店长', '实施猫', '副审查猫'] }),
        headers: { 'x-signal-token': VALID_TOKEN },
      })
      expect(res.statusCode).toBe(422)
      expect(JSON.parse(res.body).reason).toBe(
        '目标不在角色允许范围内（副审查猫:role-not-allowed）——请改投文本行首 @ 或调整目标；' +
          '一条回复最多 @ 1 个目标，请收敛到一个目标重投（店长:count-limit）'
      )
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

      it('嵌入失败（明确 reason）→ 200 + 空结果（降级不阻塞）', async () => {
        await mockActive()
        mockEmbedText.mockResolvedValueOnce({ ok: false, reason: 'spawn-failed' })
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

  describe('db-query 端点', () => {
    /** 查库 fixture：messages 显式 created_at 控序（DESC 断言）；knowledge/execution_logs 各一条 */
    const insertDbQueryFixture = () => {
      const db = getDb()
      db.prepare(
        `INSERT INTO messages (id, session_id, agent_id, role, content, mentions, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'msg-old',
        'session-1',
        'agent-impl',
        'user',
        '最早的旧消息',
        '[]',
        '2026-08-01 10:00:00'
      )
      db.prepare(
        `INSERT INTO messages (id, session_id, agent_id, role, content, mentions, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('msg-mid', 'session-1', 'agent-store', 'agent', '回复内容', '[]', '2026-08-05 10:00:00')
      db.prepare(
        `INSERT INTO messages (id, session_id, agent_id, role, content, mentions, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'msg-recent',
        'session-1',
        'agent-impl',
        'user',
        '请求重启服务',
        '[]',
        '2026-08-08 10:00:00'
      )
      // ⚠️ 原 fixture 此处插 `memories` 一行：该表已随段三接线下线（票辛 ⑥）。
      // BLOB 剔除面改用同样带 `embedding BLOB` 列的 `knowledge` 验（见下方案例）
      db.prepare(
        `INSERT INTO knowledge (id, content, embedding, source, created_at)
         VALUES (?, ?, NULL, ?, datetime('now'))`
      ).run('kb-1', '一条知识', 'doc-a')
      db.prepare(
        `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, trace_id, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'log-old',
        'session-1',
        'agent-impl',
        'msg-old',
        'completed',
        't1',
        '2026-08-01 09:00:00'
      )
      db.prepare(
        `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, trace_id, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        'log-new',
        'session-1',
        'agent-impl',
        'msg-recent',
        'running',
        't2',
        '2026-08-08 09:00:00'
      )
    }
    const mockActive = async () =>
      vi.mocked((await import('../connectors/socketio.js')).getActiveStream).mockReturnValue({
        sessionId: 'session-1',
        messageId: 'reply-1',
        content: '',
        token: VALID_TOKEN,
      })
    const qBody = (over: Record<string, unknown> = {}) => ({
      sessionId: 'session-1',
      agentId: 'agent-impl',
      msgId: 'msg-1',
      table: 'messages',
      ...over,
    })

    describe('body 基本校验（400）', () => {
      it('缺 sessionId 拒', async () => {
        const body = qBody() as Record<string, unknown>
        delete body.sessionId
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/db-query',
          payload: body,
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(400)
        expect(JSON.parse(res.body).reason).toContain('sessionId')
      })

      it('table 非白名单（sqlite_master/不存在的表）拒', async () => {
        for (const bad of ['sqlite_master', 'users']) {
          const res = await app.inject({
            method: 'POST',
            url: '/api/internal/db-query',
            payload: qBody({ table: bad }),
            headers: { 'x-signal-token': VALID_TOKEN },
          })
          expect(res.statusCode).toBe(400)
          expect(JSON.parse(res.body).reason).toContain('table')
        }
      })

      it('conditions 非数组拒', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/db-query',
          payload: qBody({ conditions: { column: 'role' } }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(400)
      })

      it('conditions column 不在表白名单（agents.llm_api_key）拒', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/db-query',
          payload: qBody({
            table: 'agents',
            conditions: [{ column: 'llm_api_key', op: '=', value: 'x' }],
          }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(400)
        expect(JSON.parse(res.body).reason).toContain('column')
      })

      it('conditions op 非法 / value 非字符串拒', async () => {
        const badOp = await app.inject({
          method: 'POST',
          url: '/api/internal/db-query',
          payload: qBody({ conditions: [{ column: 'role', op: 'CONTAINS', value: 'x' }] }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(badOp.statusCode).toBe(400)
        const badVal = await app.inject({
          method: 'POST',
          url: '/api/internal/db-query',
          payload: qBody({ conditions: [{ column: 'role', op: '=', value: 123 }] }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(badVal.statusCode).toBe(400)
      })

      it('limit 越界（0 / 101 / 小数）拒', async () => {
        for (const bad of [0, 101, 2.5]) {
          const res = await app.inject({
            method: 'POST',
            url: '/api/internal/db-query',
            payload: qBody({ limit: bad }),
            headers: { 'x-signal-token': VALID_TOKEN },
          })
          expect(res.statusCode).toBe(400)
          expect(JSON.parse(res.body).reason).toContain('limit')
        }
      })
    })

    describe('鉴权链（404/401/409 与 knowledge-search 同款）', () => {
      it('无活跃流 → 404 + reason', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/db-query',
          payload: qBody(),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(404)
        expect(JSON.parse(res.body).reason).toContain('无活跃流')
      })

      it('token 不匹配 → 401', async () => {
        await mockActive()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/db-query',
          payload: qBody(),
          headers: { 'x-signal-token': 'wrong-token' },
        })
        expect(res.statusCode).toBe(401)
      })

      it('sessionId 不匹配 → 409', async () => {
        await mockActive()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/db-query',
          payload: qBody({ sessionId: 'session-other' }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(409)
      })
    })

    describe('查询成功路径（200）', () => {
      it('无条件查 messages → 最近在前（created_at DESC）+ total 全量计数', async () => {
        await mockActive()
        insertDbQueryFixture()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/db-query',
          payload: qBody(),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.ok).toBe(true)
        expect(body.total).toBe(3)
        expect(body.rows.map((r: { id: string }) => r.id)).toEqual([
          'msg-recent',
          'msg-mid',
          'msg-old',
        ])
      })

      it('条件 AND 过滤 + LIKE 模糊匹配正确', async () => {
        await mockActive()
        insertDbQueryFixture()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/db-query',
          payload: qBody({
            conditions: [
              { column: 'role', op: '=', value: 'user' },
              { column: 'content', op: 'LIKE', value: '%重启%' },
            ],
          }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.total).toBe(1)
        expect(body.rows[0].id).toBe('msg-recent')
      })

      it('agents 返回列不含敏感三列（llm_api_key/llm_base_url/system_prompt）', async () => {
        await mockActive()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/db-query',
          payload: qBody({ table: 'agents' }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.rows.length).toBe(3)
        for (const row of body.rows) {
          expect(row).not.toHaveProperty('llm_api_key')
          expect(row).not.toHaveProperty('llm_base_url')
          expect(row).not.toHaveProperty('system_prompt')
        }
      })

      it('knowledge 返回列不含 embedding BLOB', async () => {
        await mockActive()
        insertDbQueryFixture()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/db-query',
          payload: qBody({ table: 'knowledge' }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.rows.length).toBe(1)
        expect(body.rows[0]).not.toHaveProperty('embedding')
        expect(body.rows[0]).toMatchObject({ id: 'kb-1', content: '一条知识' })
      })

      it('已下线的 memories 不在白名单（明确拒绝，不是 SQL 报错）', async () => {
        await mockActive()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/db-query',
          payload: qBody({ table: 'memories' }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).not.toBe(200)
      })

      it('limit 截断 + total 仍为全量', async () => {
        await mockActive()
        insertDbQueryFixture()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/db-query',
          payload: qBody({ limit: 1 }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.rows).toHaveLength(1)
        expect(body.rows[0].id).toBe('msg-recent')
        expect(body.total).toBe(3)
      })

      it('execution_logs 用 started_at DESC 排序（无 created_at 列）', async () => {
        await mockActive()
        insertDbQueryFixture()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/db-query',
          payload: qBody({ table: 'execution_logs' }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.rows.map((r: { id: string }) => r.id)).toEqual(['log-new', 'log-old'])
      })

      it('注入字符串 value → 参数化后无效果（不命中也不报错）', async () => {
        await mockActive()
        insertDbQueryFixture()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/db-query',
          payload: qBody({
            conditions: [{ column: 'content', op: '=', value: `' OR 1=1 --` }],
          }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(200)
        expect(JSON.parse(res.body)).toEqual({ ok: true, rows: [], total: 0 })
      })

      it('注入字符串 value（DROP 语句）→ 不执行，表仍可查', async () => {
        await mockActive()
        insertDbQueryFixture()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/db-query',
          payload: qBody({
            conditions: [{ column: 'content', op: '=', value: 'x; DROP TABLE messages' }],
          }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(200)
        expect(JSON.parse(res.body).total).toBe(0)
        // 表未被 DROP——再查一次仍 200
        const res2 = await app.inject({
          method: 'POST',
          url: '/api/internal/db-query',
          payload: qBody(),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res2.statusCode).toBe(200)
        expect(JSON.parse(res2.body).total).toBe(3)
      })

      it('无命中 → 200 + rows: [] + total: 0（不报错）', async () => {
        await mockActive()
        insertDbQueryFixture()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/db-query',
          payload: qBody({
            conditions: [{ column: 'content', op: '=', value: '不存在的内容' }],
          }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(200)
        expect(JSON.parse(res.body)).toEqual({ ok: true, rows: [], total: 0 })
      })
    })
  })

  describe('user-request 端点（request_user_action 结构化用户请求）', () => {
    /** 发送者 = 店长（store 角色——角色白名单通过态） */
    const urBody = (over: Record<string, unknown> = {}) => ({
      sessionId: 'session-1',
      agentId: 'agent-store',
      msgId: 'msg-1',
      type: 'restart',
      reason: '服务器卡死',
      ...over,
    })
    const mockActive = async () =>
      vi.mocked((await import('../connectors/socketio.js')).getActiveStream).mockReturnValue({
        sessionId: 'session-1',
        messageId: 'reply-1',
        content: '',
        token: VALID_TOKEN,
      })

    describe('body 基本校验（400）', () => {
      it('缺 type / type 非枚举（foo）→ 400 + reason 点名 type', async () => {
        for (const payload of [urBody({ type: undefined }), urBody({ type: 'foo' })]) {
          const res = await app.inject({
            method: 'POST',
            url: '/api/internal/user-request',
            payload,
            headers: { 'x-signal-token': VALID_TOKEN },
          })
          expect(res.statusCode).toBe(400)
          expect(JSON.parse(res.body).reason).toContain('type')
        }
      })

      it('type=choice → 400（该类型暂不支持——渲染留第二步，诚实拒绝）', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/user-request',
          payload: urBody({ type: 'choice' }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(400)
        expect(JSON.parse(res.body).reason).toContain('该类型暂不支持')
      })

      it('缺 reason / reason 空串 → 400 + reason 点名', async () => {
        for (const reason of [undefined, '', '   ']) {
          const res = await app.inject({
            method: 'POST',
            url: '/api/internal/user-request',
            payload: urBody({ reason }),
            headers: { 'x-signal-token': VALID_TOKEN },
          })
          expect(res.statusCode).toBe(400)
          expect(JSON.parse(res.body).reason).toContain('reason')
        }
      })

      it('options 非数组 / 每项结构错 → 400', async () => {
        for (const options of [{ id: 'a' }, [{ label: 'x' }], 'not-array']) {
          const res = await app.inject({
            method: 'POST',
            url: '/api/internal/user-request',
            payload: urBody({ options }),
            headers: { 'x-signal-token': VALID_TOKEN },
          })
          expect(res.statusCode).toBe(400)
          expect(JSON.parse(res.body).reason).toContain('options')
        }
      })
    })

    describe('鉴权链（404/401/409 与 route-signals 同款）', () => {
      it('无活跃流 → 404 + reason', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/user-request',
          payload: urBody(),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(404)
        expect(JSON.parse(res.body).reason).toContain('无活跃流')
      })

      it('token 不匹配 → 401', async () => {
        await mockActive()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/user-request',
          payload: urBody(),
          headers: { 'x-signal-token': 'wrong-token' },
        })
        expect(res.statusCode).toBe(401)
      })

      it('sessionId 不匹配 → 409', async () => {
        await mockActive()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/user-request',
          payload: urBody({ sessionId: 'session-other' }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(409)
      })
    })

    describe('角色白名单（403）', () => {
      it('implementer 角色调用 → 403 + 可诊断错误文本', async () => {
        await mockActive()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/user-request',
          payload: urBody({ agentId: 'agent-impl' }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(403)
        expect(JSON.parse(res.body).reason).toContain('role=store')
      })

      it('未知 agent（不在 agents 表）→ 403（fail-closed：角色缺失不放行）', async () => {
        await mockActive()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/user-request',
          payload: urBody({ agentId: 'agent-ghost' }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(403)
        expect(JSON.parse(res.body).reason).toContain('unknown')
      })

      it('reviewer 角色调用 → 403', async () => {
        await mockActive()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/user-request',
          payload: urBody({ agentId: 'agent-reviewer' }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(403)
      })
    })

    describe('成功路径（200 入 Map）', () => {
      it('store 角色全过 → 200 + 信号可被同 msgId 消费（type/reason 原样）', async () => {
        await mockActive()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/user-request',
          payload: urBody({ reason: '  服务器卡死  ' }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(200)
        expect(JSON.parse(res.body).ok).toBe(true)

        const signals = consumeUserRequestSignals('session-1', 'agent-store', 'msg-1')
        expect(signals).toHaveLength(1)
        expect(signals[0]).toMatchObject({ type: 'restart', reason: '服务器卡死', msgId: 'msg-1' })
      })

      it('restart 携带 options → 忽略不入信号（restart 无选项语义）', async () => {
        await mockActive()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/user-request',
          payload: urBody({ options: [{ id: 'a', label: '重启' }] }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(200)
        const signals = consumeUserRequestSignals('session-1', 'agent-store', 'msg-1')
        expect(signals[0].options).toBeUndefined()
      })
    })
  })

  describe('create-pr 端点（create_pr 工具——收口链发布关载体）', () => {
    /** 发送者 = 店长（store 角色——角色白名单通过态） */
    const cpBody = (over: Record<string, unknown> = {}) => ({
      sessionId: 'session-1',
      agentId: 'agent-store',
      msgId: 'msg-1',
      head: 'session/abc',
      title: 'feat: 测试',
      body: '改动说明',
      ...over,
    })
    const mockActive = async () =>
      vi.mocked((await import('../connectors/socketio.js')).getActiveStream).mockReturnValue({
        sessionId: 'session-1',
        messageId: 'reply-1',
        content: '',
        token: VALID_TOKEN,
      })

    describe('body 基本校验（400）', () => {
      it('缺 head / head 空串 → 400 + reason 点名 head', async () => {
        for (const head of [undefined, '', '   ']) {
          const res = await app.inject({
            method: 'POST',
            url: '/api/internal/create-pr',
            payload: cpBody({ head }),
            headers: { 'x-signal-token': VALID_TOKEN },
          })
          expect(res.statusCode).toBe(400)
          expect(JSON.parse(res.body).reason).toContain('head')
        }
      })

      it('缺 title / 缺 body → 400 + reason 点名', async () => {
        const noTitle = await app.inject({
          method: 'POST',
          url: '/api/internal/create-pr',
          payload: cpBody({ title: undefined }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(noTitle.statusCode).toBe(400)
        const noBody = await app.inject({
          method: 'POST',
          url: '/api/internal/create-pr',
          payload: cpBody({ body: undefined }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(noBody.statusCode).toBe(400)
        expect(JSON.parse(noBody.body).reason).toContain('body')
      })

      it('base 非字符串 → 400 + reason 点名 base', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/create-pr',
          payload: cpBody({ base: 123 }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(400)
        expect(JSON.parse(res.body).reason).toContain('base')
      })
    })

    describe('鉴权链（404/401/409 与 user-request 同款）', () => {
      it('无活跃流 → 404 + reason', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/create-pr',
          payload: cpBody(),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(404)
        expect(JSON.parse(res.body).reason).toContain('无活跃流')
      })

      it('token 不匹配 → 401', async () => {
        await mockActive()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/create-pr',
          payload: cpBody(),
          headers: { 'x-signal-token': 'wrong-token' },
        })
        expect(res.statusCode).toBe(401)
      })

      it('sessionId 不匹配 → 409', async () => {
        await mockActive()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/create-pr',
          payload: cpBody({ sessionId: 'session-other' }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(409)
      })
    })

    describe('角色白名单（403）——防实施猫误发 PR', () => {
      it('implementer 角色调用 → 403 + 可诊断错误文本', async () => {
        await mockActive()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/create-pr',
          payload: cpBody({ agentId: 'agent-impl' }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(403)
        expect(JSON.parse(res.body).reason).toContain('role=store')
      })

      it('未知 agent（不在 agents 表）→ 403（fail-closed）', async () => {
        await mockActive()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/create-pr',
          payload: cpBody({ agentId: 'agent-ghost' }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(403)
        expect(JSON.parse(res.body).reason).toContain('unknown')
      })

      it('reviewer 角色调用 → 403', async () => {
        await mockActive()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/create-pr',
          payload: cpBody({ agentId: 'agent-reviewer' }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(403)
      })
    })

    describe('业务失败（422 不静默）', () => {
      it('createPr 返回 not-authed → 422 + reason 含原因与 error', async () => {
        await mockActive()
        vi.mocked((await import('../git/create-pr.js')).createPr).mockResolvedValue({
          ok: false,
          reason: 'not-authed',
          error: 'Please run: gh auth login',
        } as any)
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/create-pr',
          payload: cpBody(),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(422)
        const body = JSON.parse(res.body)
        expect(body.ok).toBe(false)
        expect(body.reason).toContain('not-authed')
        expect(body.error).toBe('Please run: gh auth login')
      })

      it('createPr 返回 branch-not-pushed → 422 透传', async () => {
        await mockActive()
        vi.mocked((await import('../git/create-pr.js')).createPr).mockResolvedValue({
          ok: false,
          reason: 'branch-not-pushed',
          error: 'Command failed: git ls-remote',
        } as any)
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/create-pr',
          payload: cpBody(),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(422)
        expect(JSON.parse(res.body).reason).toContain('branch-not-pushed')
      })
    })

    describe('成功路径（200 透传 createPr 结果）', () => {
      it('store 角色全过 → 200 + number/url 透传 + createPr 参数正确', async () => {
        await mockActive()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/create-pr',
          payload: cpBody(),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(200)
        expect(JSON.parse(res.body)).toEqual({
          ok: true,
          number: 123,
          url: 'https://github.com/org/repo/pull/123',
        })
        expect((await import('../git/create-pr.js')).createPr).toHaveBeenCalledWith({
          base: undefined,
          head: 'session/abc',
          title: 'feat: 测试',
          body: '改动说明',
        })
      })

      it('base 显式传值透传 + head/title/body trim', async () => {
        await mockActive()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/create-pr',
          payload: cpBody({ base: 'main', head: '  feat-x  ', title: '  T  ', body: '  B  ' }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(200)
        expect((await import('../git/create-pr.js')).createPr).toHaveBeenCalledWith({
          base: 'main',
          head: 'feat-x',
          title: 'T',
          body: 'B',
        })
      })
    })
  })

  describe('session-messages 端点（query_session_messages 工具——B agent 会话回读）', () => {
    /** 发送者 = 实施猫（回读是通用能力，无角色白名单——任何活跃流角色可调） */
    const smBody = (over: Record<string, unknown> = {}) => ({
      sessionId: 'session-1',
      agentId: 'agent-impl',
      msgId: 'msg-1',
      ...over,
    })
    const mockActive = async () =>
      vi.mocked((await import('../connectors/socketio.js')).getActiveStream).mockReturnValue({
        sessionId: 'session-1',
        messageId: 'reply-1',
        content: '',
        token: VALID_TOKEN,
      })

    /** 会话消息 fixture：agent 回复带 segments / 用户图带 images / 老 agent 回复 segments NULL / system */
    const insertSmFixture = () => {
      const db = getDb()
      const segs = [
        { kind: 'thinking', content: '先想一下再调工具' },
        {
          kind: 'tool',
          content: '',
          tool: { id: 'call_1', name: 'apply_patch', status: 'completed' },
        },
        { kind: 'text', content: '这是正文' },
      ]
      db.prepare(
        `INSERT INTO messages (id, session_id, agent_id, role, content, mentions, segments, created_at)
         VALUES ('msg-reply-1', ?, 'agent-store', 'agent', '这是正文', '[]', ?, '2026-09-01 10:00:00')`
      ).run('session-1', JSON.stringify(segs))
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions, images, created_at)
         VALUES ('msg-user-1', ?, 'user', '看图', '[]', ?, '2026-09-01 09:00:00')`
      ).run('session-1', JSON.stringify(['data:image/png;base64,AAAA']))
      db.prepare(
        `INSERT INTO messages (id, session_id, agent_id, role, content, mentions, created_at)
         VALUES ('msg-old-1', ?, 'agent-impl', 'agent', '旧回复（无 segments）', '[]', '2026-09-01 08:00:00')`
      ).run('session-1')
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions, created_at)
         VALUES ('msg-sys-1', ?, 'system', '重启完成', '[]', '2026-09-01 11:00:00')`
      ).run('session-1')
    }

    describe('body 基本校验（400）', () => {
      it('缺 sessionId → 400 + reason', async () => {
        const body = smBody() as Record<string, unknown>
        delete body.sessionId
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/session-messages',
          payload: body,
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(400)
        expect(JSON.parse(res.body).reason).toContain('sessionId')
      })

      it('limit 越界（0 / 101 / 小数）→ 400', async () => {
        for (const bad of [0, 101, 2.5]) {
          const res = await app.inject({
            method: 'POST',
            url: '/api/internal/session-messages',
            payload: smBody({ limit: bad }),
            headers: { 'x-signal-token': VALID_TOKEN },
          })
          expect(res.statusCode).toBe(400)
          expect(JSON.parse(res.body).reason).toContain('limit')
        }
      })

      it('kinds 非法（非数组/空数组/含未知 kind）→ 400', async () => {
        for (const bad of ['text', [], ['text', 'unknown']]) {
          const res = await app.inject({
            method: 'POST',
            url: '/api/internal/session-messages',
            payload: smBody({ kinds: bad }),
            headers: { 'x-signal-token': VALID_TOKEN },
          })
          expect(res.statusCode).toBe(400)
          expect(JSON.parse(res.body).reason).toContain('kinds')
        }
      })

      it('agentIdFilter 非字符串 / before 非字符串 → 400', async () => {
        const cases: Array<[string, unknown]> = [
          ['agentIdFilter', 123],
          ['before', ['x']],
        ]
        for (const [key, val] of cases) {
          const res = await app.inject({
            method: 'POST',
            url: '/api/internal/session-messages',
            payload: smBody({ [key]: val }),
            headers: { 'x-signal-token': VALID_TOKEN },
          })
          expect(res.statusCode).toBe(400)
        }
      })
    })

    describe('鉴权链（404/401/409 与 knowledge-search 同款——回读通用能力无 403 角色白名单）', () => {
      it('无活跃流 → 404 + reason', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/session-messages',
          payload: smBody(),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(404)
        expect(JSON.parse(res.body).reason).toContain('无活跃流')
      })

      it('token 不匹配 → 401', async () => {
        await mockActive()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/session-messages',
          payload: smBody(),
          headers: { 'x-signal-token': 'wrong-token' },
        })
        expect(res.statusCode).toBe(401)
      })

      it('sessionId 不匹配 → 409', async () => {
        await mockActive()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/session-messages',
          payload: smBody({ sessionId: 'session-other' }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(409)
      })

      it('实施猫角色调用 → 200（无角色白名单——历史回读不限角色）', async () => {
        await mockActive()
        insertSmFixture()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/session-messages',
          payload: smBody({ agentId: 'agent-impl' }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(200)
      })
    })

    describe('回读成功路径（200）', () => {
      it('segments 行 → 结构化块 + agentName JOIN + 新→旧 + system 排除 + total', async () => {
        await mockActive()
        insertSmFixture()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/session-messages',
          payload: smBody(),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.ok).toBe(true)
        // 非 system 三条，新→旧：msg-reply-1 → msg-user-1 → msg-old-1
        expect(body.total).toBe(3)
        expect(body.messages.map((m: any) => m.messageId)).toEqual([
          'msg-reply-1',
          'msg-user-1',
          'msg-old-1',
        ])

        const reply = body.messages[0]
        expect(reply).toMatchObject({
          messageId: 'msg-reply-1',
          role: 'agent',
          agentId: 'agent-store',
          agentName: '店长', // LEFT JOIN agents.name
          // 夹具行落库是秒级 `2026-09-01 10:00:00`，出参经 `toIsoDb` 归一为 ISO 毫秒
          //（票 5 起统一口径；此前是裸 `.replace(' ','T')+'Z'`，出 `…00Z` 无毫秒位）
          createdAt: '2026-09-01T10:00:00.000Z',
        })
        // 三个块 kind 齐全 + tool 元数据透传
        expect(reply.blocks.map((b: any) => b.kind)).toEqual(['thinking', 'tool', 'text'])
        expect(reply.blocks[1].tool).toMatchObject({ id: 'call_1', name: 'apply_patch' })
        expect(reply.blocks[2].content).toBe('这是正文')

        const user = body.messages[1]
        expect(user.agentName).toBeNull() // user 消息无 agent
        // images 挂在承载 body 的单 text 块
        expect(user.blocks).toEqual([
          { kind: 'text', content: '看图', images: ['data:image/png;base64,AAAA'] },
        ])
      })

      it('segments NULL 老行 → 退化单 text 块（不崩，不拼 thinking_content/tool_content 旧块）', async () => {
        await mockActive()
        insertSmFixture()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/session-messages',
          payload: smBody({ agentIdFilter: 'agent-impl' }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.messages).toHaveLength(1)
        expect(body.messages[0].messageId).toBe('msg-old-1')
        expect(body.messages[0].blocks).toEqual([
          { kind: 'text', content: '旧回复（无 segments）' },
        ])
      })

      it('limit 生效 + before 游标翻页（B 端点复用 A 读层窗口）', async () => {
        await mockActive()
        insertSmFixture()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/session-messages',
          payload: smBody({ limit: 2 }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(JSON.parse(res.body).messages.map((m: any) => m.messageId)).toEqual([
          'msg-reply-1',
          'msg-user-1',
        ])

        const page2 = await app.inject({
          method: 'POST',
          url: '/api/internal/session-messages',
          payload: smBody({ limit: 2, before: 'msg-user-1' }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(JSON.parse(page2.body).messages.map((m: any) => m.messageId)).toEqual(['msg-old-1'])
      })

      it('kinds 过滤 → 只回该 kind 块；空块消息被丢弃', async () => {
        await mockActive()
        insertSmFixture()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/session-messages',
          payload: smBody({ kinds: ['thinking'] }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        // msg-reply-1 有 thinking 块 → 保留且只剩 thinking；user/old 无 thinking → 丢弃
        expect(body.messages).toHaveLength(1)
        expect(body.messages[0].messageId).toBe('msg-reply-1')
        expect(body.messages[0].blocks).toEqual([{ kind: 'thinking', content: '先想一下再调工具' }])
        expect(body.total).toBe(1)
      })

      it('agentIdFilter → 只回该 agent 的消息（悬空 agent 名 null）', async () => {
        await mockActive()
        insertSmFixture()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/session-messages',
          payload: smBody({ agentIdFilter: 'agent-impl' }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.messages).toHaveLength(1)
        expect(body.messages[0]).toMatchObject({ messageId: 'msg-old-1', agentName: '实施猫' })
      })

      it('无命中（before 指向不存在的消息）→ 200 + 空 messages 不崩', async () => {
        await mockActive()
        insertSmFixture()
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/session-messages',
          payload: smBody({ before: 'ghost-message' }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(200)
        expect(JSON.parse(res.body)).toEqual({ ok: true, messages: [], total: 0 })
      })
    })
  })

  describe('session-members 端点（list_session_members 工具——会话成员带 role 查询）', () => {
    /** 发送者 = 实施猫（成员查询是通用能力，无角色白名单——任何活跃流角色可调） */
    const memBody = (over: Record<string, unknown> = {}) => ({
      sessionId: 'session-1',
      agentId: 'agent-impl',
      msgId: 'msg-1',
      ...over,
    })
    const mockActiveIn = async (sessionId: string) =>
      vi.mocked((await import('../connectors/socketio.js')).getActiveStream).mockReturnValue({
        sessionId,
        messageId: 'reply-1',
        content: '',
        token: VALID_TOKEN,
      })

    describe('body 基本校验（400）', () => {
      it('缺 sessionId → 400 + reason 点名', async () => {
        const body = memBody() as Record<string, unknown>
        delete body.sessionId
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/session-members',
          payload: body,
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(400)
        expect(JSON.parse(res.body).reason).toContain('sessionId')
      })

      it('缺 agentId → 400 + reason 点名', async () => {
        const body = memBody() as Record<string, unknown>
        delete body.agentId
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/session-members',
          payload: body,
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(400)
        expect(JSON.parse(res.body).reason).toContain('agentId')
      })

      it('sessionId/agentId 非字符串（数字）→ 400', async () => {
        for (const key of ['sessionId', 'agentId']) {
          const res = await app.inject({
            method: 'POST',
            url: '/api/internal/session-members',
            payload: memBody({ [key]: 123 }),
            headers: { 'x-signal-token': VALID_TOKEN },
          })
          expect(res.statusCode).toBe(400)
        }
      })
    })

    describe('鉴权链（404/401/409 与 session-messages 同款——成员查询通用能力无 403 角色白名单）', () => {
      it('无活跃流 → 404 + reason', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/session-members',
          payload: memBody(),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(404)
        expect(JSON.parse(res.body).reason).toContain('无活跃流')
      })

      it('token 不匹配 → 401', async () => {
        await mockActiveIn('session-1')
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/session-members',
          payload: memBody(),
          headers: { 'x-signal-token': 'wrong-token' },
        })
        expect(res.statusCode).toBe(401)
      })

      it('sessionId 不匹配 → 409', async () => {
        await mockActiveIn('session-1')
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/session-members',
          payload: memBody({ sessionId: 'session-other' }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(409)
      })

      it('reviewer 角色调用 → 200（无角色白名单——成员查询不限角色，非 store/implementer 专属）', async () => {
        await mockActiveIn('session-1')
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/session-members',
          payload: memBody({ agentId: 'agent-reviewer' }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(200)
      })
    })

    describe('成员解析成功路径（200）', () => {
      it('返回 members 含 agentId/name/role + session 注册序保持（非 IN 子句序）', async () => {
        await mockActiveIn('session-1')
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/session-members',
          payload: memBody(),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.ok).toBe(true)
        expect(body.members).toEqual([
          { agentId: 'agent-store', name: '店长', role: 'store' },
          { agentId: 'agent-impl', name: '实施猫', role: 'implementer' },
          { agentId: 'agent-reviewer', name: '吐槽猫', role: 'reviewer' },
        ])
      })

      it('悬空 agent（session 引用已删成员）→ name/role null 不丢不崩 + 其余成员正常', async () => {
        const db = getDb()
        db.prepare(
          `INSERT INTO sessions (id, title, agent_ids, created_at, updated_at)
           VALUES (?, ?, ?, datetime('now'), datetime('now'))`
        ).run('session-2', '悬空会话', JSON.stringify(['agent-impl', 'ghost-agent', 'agent-store']))
        await mockActiveIn('session-2')
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/session-members',
          payload: memBody({ sessionId: 'session-2' }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.members).toEqual([
          { agentId: 'agent-impl', name: '实施猫', role: 'implementer' },
          { agentId: 'ghost-agent', name: null, role: null },
          { agentId: 'agent-store', name: '店长', role: 'store' },
        ])
      })

      it('会话无成员（agent_ids 空数组）→ 200 + members [] 不崩', async () => {
        const db = getDb()
        db.prepare(
          `INSERT INTO sessions (id, title, agent_ids, created_at, updated_at)
           VALUES (?, ?, ?, datetime('now'), datetime('now'))`
        ).run('session-empty', '空会话', JSON.stringify([]))
        await mockActiveIn('session-empty')
        const res = await app.inject({
          method: 'POST',
          url: '/api/internal/session-members',
          payload: memBody({ sessionId: 'session-empty' }),
          headers: { 'x-signal-token': VALID_TOKEN },
        })
        expect(res.statusCode).toBe(200)
        expect(JSON.parse(res.body)).toEqual({ ok: true, members: [] })
      })
    })
  })
})
