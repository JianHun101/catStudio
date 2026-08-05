/**
 * connectors 路由测试（P2 AC2/AC3）。
 *
 * 覆盖：绑定管理 CRUD + 校验；webhook 四类 payload（@机器人+@猫名 / 纯@机器人 /
 * 无绑定群 / 自己发的消息）+ 非 message 事件 + 私聊 + saveMemory 断言 + 503 开关。
 */
import { createHmac } from 'node:crypto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTestDb, buildTestApp } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository, connectorBindings as bindingsRepo } from '../db/repository/index.js'
import type { FastifyInstance } from 'fastify'
import { saveMessageMemory } from '../memory/index.js'
import { __test_resetOneBotDedup } from './connectors.js'

// Mock socketio connector（ingest 顶层 import 需要可解析；getIO null → 广播/执行跳过）。
// P4 顺带（AC2-1 mock 退化值修正）：rowToAgent 补真实字段映射——此前 vi.fn() 返回
// undefined → validAgents=[] → saveMessageMemory 断言第 4 参收到退化值 []（真实环境
// 应为 ['agent-ds']）。与 socketio.ts rowToAgent 同构，删 mock 时断言不用改。
vi.mock('../connectors/socketio.js', () => ({
  getIO: vi.fn(() => null),
  createSocketIO: vi.fn(),
  rowToAgent: vi.fn((row: any) => ({
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    systemPrompt: row.system_prompt,
    llmProvider: row.llm_provider,
    llmModel: row.llm_model,
    llmApiKey: row.llm_api_key,
    llmBaseUrl: row.llm_base_url || undefined,
    effortLevel: row.effort_level || undefined,
    skillModules: JSON.parse(row.skill_modules || '[]'),
    role: row.role || undefined,
  })),
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
    // AC2-1 mock 修正后 validAgents 非空 → dispatch 真实执行会占用槽位，
    // 用例间必须复位（CLAUDE.md 约定：Dispatch __test_reset() between cases）
    const { __test_reset } = await import('../dispatch/index.js')
    __test_reset()
    __test_resetOneBotDedup() // P4 #5: 去重表是模块级单例，用例间清空
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
    delete process.env.ONEBOT_TOKEN
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

    it('P4 #4-1: 数字 externalId（QQ 群号/QQ 号天然是数字）→ 201 且落库仍 string', async () => {
      const db = getDb()
      db.prepare(
        `INSERT INTO sessions (id, title, agent_ids, created_at, updated_at)
         VALUES ('session-n', 'n', '[]', datetime('now'), datetime('now'))`
      ).run()
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/bindings',
        payload: { platform: 'qq', externalType: 'group', externalId: 555, sessionId: 'session-n' },
      })
      expect(res.statusCode).toBe(201)
      const body = JSON.parse(res.body)
      expect(body.binding.external_id).toBe('555') // 存储仍 string——与入站查询对称
      expect(typeof body.binding.external_id).toBe('string')
      // 数字 externalId 的 DELETE 同样归一化命中
      const resDel = await app.inject({
        method: 'DELETE',
        url: '/api/connectors/bindings',
        payload: { platform: 'qq', externalType: 'group', externalId: 555 },
      })
      expect(resDel.statusCode).toBe(200)
      expect(bindingsRepo.getConnectorBinding('qq', 'group', '555')).toBeUndefined()
    })

    it('P4 #4-2: 非数字 externalId → 400（POST 与 DELETE 两处校验）', async () => {
      insertBoundFixture()
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/bindings',
        payload: {
          platform: 'qq',
          externalType: 'group',
          externalId: 'abc',
          sessionId: 'session-qq-1',
        },
      })
      expect(res.statusCode).toBe(400)

      const resDel = await app.inject({
        method: 'DELETE',
        url: '/api/connectors/bindings',
        payload: { platform: 'qq', externalType: 'group', externalId: 'abc' },
      })
      expect(resDel.statusCode).toBe(400)
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

      // 吐槽猫观察点 #1 护栏：OneBot 真实对话必须进向量记忆库。
      // P4 顺带（AC2-1 mock 退化值修正）：第 4 参不再是退化值 []——
      // rowToAgent mock 补真实映射后 validAgents=['agent-ds']（真实环境一致）
      expect(saveMessageMemory).toHaveBeenCalledWith(
        'session-qq-1',
        '[小明]: @ds猫 帮我看看',
        expect.any(String),
        ['agent-ds']
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

    // ─── P4 #5: message_id 去重 ──────────────────
    // NapCat 网络层重投（200 未达超时重投）→ 同一条消息处理两次 → 重复摄入。
    // 进程内 LRU（TTL 10 分钟 + 容量 1000），check+insert 在入口同步段完成。

    it('P4 #5-1: number 型 message_id 命中（OneBot v11 标准类型不跳过）', async () => {
      insertBoundFixture()
      const ev = groupEvent({ message_id: 30001000 }) // NapCat 上报标准 number 型
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/onebot/webhook',
        payload: ev,
      })
      expect(res.statusCode).toBe(200)
      expect(countMessages()).toBe(1)
    })

    it('P4 #5-2: 同 id 二次投递（重投窗口并发）→ 去重命中仅处理一次', async () => {
      insertBoundFixture()
      const ev = groupEvent({ message_id: '30001001' }) // string 型实现同样归一化命中
      const res1 = await app.inject({
        method: 'POST',
        url: '/api/connectors/onebot/webhook',
        payload: ev,
      })
      expect(res1.statusCode).toBe(200)
      expect(countMessages()).toBe(1)
      const res2 = await app.inject({
        method: 'POST',
        url: '/api/connectors/onebot/webhook',
        payload: ev,
      })
      expect(res2.statusCode).toBe(200)
      expect(countMessages()).toBe(1) // 未重复摄入
    })

    it('P4 #5-3: undefined message_id → 跳过查重，正常处理', async () => {
      insertBoundFixture()
      const ev = groupEvent() // 不带 message_id
      await app.inject({ method: 'POST', url: '/api/connectors/onebot/webhook', payload: ev })
      await app.inject({ method: 'POST', url: '/api/connectors/onebot/webhook', payload: ev })
      expect(countMessages()).toBe(2) // 无 id 不误杀，两条都处理
    })

    it('P4 #5-4: 过期后可再次处理（Date.now 时间戳 + check/insert 顺带清过期）', async () => {
      insertBoundFixture()
      // 只 fake Date（toFake: ['Date']）——app.inject 依赖真实定时器，
      // 全量 fake 会让注入管线挂起；Date 被 fake 后 setSystemTime 可拨动时钟
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const ev = groupEvent({ message_id: 30001002 })
        await app.inject({ method: 'POST', url: '/api/connectors/onebot/webhook', payload: ev })
        expect(countMessages()).toBe(1)
        // 未过期 → 命中
        await app.inject({ method: 'POST', url: '/api/connectors/onebot/webhook', payload: ev })
        expect(countMessages()).toBe(1)
        // 快进 10 分钟 → 过期项被 check/insert 的清过期扫掉 → 可再次处理
        vi.setSystemTime(Date.now() + 10 * 60 * 1000)
        await app.inject({ method: 'POST', url: '/api/connectors/onebot/webhook', payload: ev })
        expect(countMessages()).toBe(2)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('webhook token 鉴权（P3 AC4）', () => {
    it('未设置 ONEBOT_TOKEN → 不校验，照常 200', async () => {
      insertBoundFixture()
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/onebot/webhook',
        payload: groupEvent(),
      })
      expect(res.statusCode).toBe(200)
      expect(countMessages()).toBe(1)
    })

    it('设置 ONEBOT_TOKEN 后无 Authorization header → 401，不落库', async () => {
      insertBoundFixture()
      process.env.ONEBOT_TOKEN = 'secret'
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/onebot/webhook',
        payload: groupEvent(),
      })
      expect(res.statusCode).toBe(401)
      expect(countMessages()).toBe(0)
    })

    it('错 token → 401，不落库', async () => {
      insertBoundFixture()
      process.env.ONEBOT_TOKEN = 'secret'
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/onebot/webhook',
        payload: groupEvent(),
        headers: { authorization: 'Bearer wrong' },
      })
      expect(res.statusCode).toBe(401)
      expect(countMessages()).toBe(0)
    })

    it('正确 Bearer token → 200，正常摄入', async () => {
      insertBoundFixture()
      process.env.ONEBOT_TOKEN = 'secret'
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/onebot/webhook',
        payload: groupEvent(),
        headers: { authorization: 'Bearer secret' },
      })
      expect(res.statusCode).toBe(200)
      expect(countMessages()).toBe(1)
    })

    // ─── x-signature 兼容（NapCat HTTP 上报真实形态）──────────
    // 根因：NapCat HTTP 上报发 x-signature: sha1=<HMAC-SHA1(token, body)>（OneBot v11 标准），
    // 从不发 Authorization: Bearer——P3 只测 Bearer 路径致真实环境 401 必现。
    // 实现与测试同步用 createHmac（napcat.mjs 源码实锤 _L = createHmac，token 参与计算）。
    // 测试用收到的 body JSON.stringify 后算 HMAC（V8 解析保持键序，两端一致）。

    it('x-signature（NapCat HTTP 上报真实形态）→ 200，正常摄入', async () => {
      insertBoundFixture()
      process.env.ONEBOT_TOKEN = 'secret'
      // 真实形态：NapCat 对上报 body 算 HMAC-SHA1(token, body) 发 x-signature，不带 Bearer 头
      const payload = groupEvent({ message_id: 30002000 })
      const digest = createHmac('sha1', 'secret').update(JSON.stringify(payload)).digest('hex')
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/onebot/webhook',
        payload,
        headers: { 'x-signature': `sha1=${digest}` },
      })
      expect(res.statusCode).toBe(200)
      expect(countMessages()).toBe(1) // 进正常处理路径——删 x-signature 分支必红
    })

    it('错误 x-signature → 401，不落库', async () => {
      insertBoundFixture()
      process.env.ONEBOT_TOKEN = 'secret'
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/onebot/webhook',
        payload: groupEvent(),
        headers: { 'x-signature': `sha1=${'deadbeef'.repeat(5)}` },
      })
      expect(res.statusCode).toBe(401)
      expect(countMessages()).toBe(0)
    })

    it('错误 HMAC key 签名 → 401，不落库（钉死 key 必须等于 token——删 key 必红）', async () => {
      insertBoundFixture()
      process.env.ONEBOT_TOKEN = 'secret'
      // 与实现逐字同形态（HMAC-SHA1 + body JSON.stringify），但 key 用错的 'wrong'：
      // 若实现退化回 createHash 纯摘要（key 不参与）或误用其他 key，本用例必红
      const digest = createHmac('sha1', 'wrong').update(JSON.stringify(groupEvent())).digest('hex')
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/onebot/webhook',
        payload: groupEvent(),
        headers: { 'x-signature': `sha1=${digest}` },
      })
      expect(res.statusCode).toBe(401)
      expect(countMessages()).toBe(0)
    })
  })
})
