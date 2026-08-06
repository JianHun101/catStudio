/**
 * connectors 路由测试（P2 AC2/AC3）。
 *
 * 覆盖：绑定管理 CRUD + 校验；webhook 四类 payload（@机器人+@猫名 / 纯@机器人 /
 * 无绑定群 / 自己发的消息）+ 非 message 事件 + 私聊 + saveMemory 断言 + 503 开关 +
 * 白名单模式 5 例（命中 / 白名单外@ / 白名单外私聊 / 未配置兼容 / 格式宽容）。
 */
import { createHmac } from 'node:crypto'
import { createServer, type AddressInfo } from 'node:net'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
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
    // shell/env 可能带真实 ONEBOT_TOKEN（本机实测存在）——每个用例前清干净，
    // 保证「token 未配置不校验」前提成立（P5-1 曾因首个用例继承 shell token 而 401；
    // 460-533 的鉴权用例在用例体内自设 token，不受影响）
    delete process.env.ONEBOT_TOKEN
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
    vi.unstubAllEnvs() // 薄桥用例 stubEnv 的 env 恢复（先恢复再 delete，顺序无关——beforeEach 已清）
    await app.close()
    resetDb()
    delete process.env.ONEBOT_ENABLED
    delete process.env.ONEBOT_TOKEN
    delete process.env.ONEBOT_ALLOWLIST
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

  describe('OneBot 白名单（ONEBOT_ALLOWLIST）', () => {
    // groupEvent 默认发送者 user_id=999；白名单检查在绑定查找之前（群绑定 555 已由
    // insertBoundFixture 插入）——用例 2/3 删白名单检查行必红（绑定命中即摄入）

    it('P5-1: 发送者在白名单 → 200 正常摄入', async () => {
      insertBoundFixture()
      process.env.ONEBOT_ALLOWLIST = '999'
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/onebot/webhook',
        payload: groupEvent(),
      })
      expect(res.statusCode).toBe(200)
      expect(countMessages()).toBe(1)
    })

    it('P5-2: 白名单外的 @ 群消息 → 200 静默忽略，不落库', async () => {
      insertBoundFixture()
      process.env.ONEBOT_ALLOWLIST = '123' // 不含发送者 999
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/onebot/webhook',
        payload: groupEvent(),
      })
      expect(res.statusCode).toBe(200)
      expect(countMessages()).toBe(0) // 删白名单检查行必红（绑定 555 命中即摄入）
    })

    it('P5-3: 白名单外的私聊 → 200 静默忽略，不落库（群聊+私聊统一管）', async () => {
      // 私聊绑定存在（删白名单行后摄入路径畅通）——钉死拦截发生在绑定查找之前
      const db = getDb()
      db.prepare(
        `INSERT INTO sessions (id, title, agent_ids, created_at, updated_at)
         VALUES ('session-qq-w', 'w', '[]', datetime('now'), datetime('now'))`
      ).run()
      bindingsRepo.upsertConnectorBinding('qq', 'private', '999', 'session-qq-w')
      process.env.ONEBOT_ALLOWLIST = '123' // 不含发送者 999
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
      expect(countMessages()).toBe(0) // 删白名单检查行必红（私聊绑定 999 命中即摄入）
    })

    it('P5-4: 未配置 ONEBOT_ALLOWLIST → 白名单模式关闭，非白名单发送者照常摄入（现状回归）', async () => {
      insertBoundFixture()
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/onebot/webhook',
        payload: groupEvent(),
      })
      expect(res.statusCode).toBe(200)
      expect(countMessages()).toBe(1)
    })

    it('P5-5: 格式宽容——白名单含空格/空段（trim + 去空段）仍命中', async () => {
      insertBoundFixture()
      process.env.ONEBOT_ALLOWLIST = ' 3598764614 , , 999 ' // 空格 + 空段混排
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/onebot/webhook',
        payload: groupEvent(),
      })
      expect(res.statusCode).toBe(200)
      expect(countMessages()).toBe(1)
    })
  })

  describe('NapCat 生命周期薄桥（零 spawn：只读探测 + 写请求文件）', () => {
    // 请求文件隔离目录（与 messages.test.ts 的 restart-test-messages 同款范式）：
    // 全量并行时避免写真实 ROOT/.napcat-request 干扰 dev.js
    const napcatTmpDir = 'node_modules/.cache/restart-test-napcat'
    const napcatTmpFile = path.join(napcatTmpDir, '.napcat-request')

    afterEach(() => {
      rmSync(napcatTmpDir, { recursive: true, force: true })
    })

    it('GET status: 字段齐全 + enabled 随 env（与 webhook 503 开关同源）', async () => {
      process.env.ONEBOT_ENABLED = 'true'
      // 环境隔离：本用例断言「未配置启动命令」态——本机 .env 模板（NAPCAT_LAUNCH_CMD={NAPCAT_PATH}）
      // 经外部 export 进进程环境时该断言会失效（launchCmdConfigured 读 env 实时求值），先清掉再测
      delete process.env.NAPCAT_LAUNCH_CMD
      const res = await app.inject({ method: 'GET', url: '/api/connectors/onebot/status' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.enabled).toBe(true)
      expect(typeof body.apiBase).toBe('string')
      expect(typeof body.running).toBe('boolean')
      expect(body.launchCmdConfigured).toBe(false)
      expect(body.tokenConfigured).toBe(false)
      expect(body.tokenMasked).toBe('')

      process.env.ONEBOT_ENABLED = 'false'
      const res2 = await app.inject({ method: 'GET', url: '/api/connectors/onebot/status' })
      expect(JSON.parse(res2.body).enabled).toBe(false)
    })

    it('GET status: running 探测真实（不可达端口 → false；真实 TCP 监听 → true）', async () => {
      // 端口 1 基本必无监听——不依赖测试机 3000 空闲（跑着 dev 时 3000 可能被 NapCat 占）
      vi.stubEnv('ONEBOT_API_BASE', 'http://127.0.0.1:1')
      let res = await app.inject({ method: 'GET', url: '/api/connectors/onebot/status' })
      expect(JSON.parse(res.body).running).toBe(false)

      // 真实 TCP server 监听随机端口 → running true（探测走真 socket，非 mock）
      const server = createServer()
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
      try {
        const port = (server.address() as AddressInfo).port
        vi.stubEnv('ONEBOT_API_BASE', `http://127.0.0.1:${port}`)
        res = await app.inject({ method: 'GET', url: '/api/connectors/onebot/status' })
        const body = JSON.parse(res.body)
        expect(body.running).toBe(true)
        expect(body.apiBase).toBe(`http://127.0.0.1:${port}`)
      } finally {
        await new Promise<void>((r) => server.close(() => r()))
      }
    })

    it('GET status: launchCmdConfigured / token 脱敏随 env（完整 token 不出 server）', async () => {
      vi.stubEnv('NAPCAT_LAUNCH_CMD', 'napcat --config x')
      vi.stubEnv('ONEBOT_TOKEN', 'secret-token-abc')
      const res = await app.inject({ method: 'GET', url: '/api/connectors/onebot/status' })
      const body = JSON.parse(res.body)
      expect(body.launchCmdConfigured).toBe(true)
      expect(body.tokenConfigured).toBe(true)
      expect(body.tokenMasked).toBe('secr****') // 前 4 位 + 4 星
      expect(body.tokenMasked).not.toContain('secret-token')
    })

    it('POST control: start → 202 + 写 .napcat-request（隔离目录）', async () => {
      vi.stubEnv('RESTART_FILES_DIR', napcatTmpDir)
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/napcat/control',
        payload: { action: 'start' },
      })
      expect(res.statusCode).toBe(202)
      expect(JSON.parse(res.body).ok).toBe(true)
      expect(existsSync(napcatTmpFile)).toBe(true)
      const req = JSON.parse(readFileSync(napcatTmpFile, 'utf-8'))
      expect(req.action).toBe('start')
      expect(typeof req.createdAt).toBe('string')
    })

    it('POST control: stop → 202 写文件；非法 action → 400 不写文件', async () => {
      vi.stubEnv('RESTART_FILES_DIR', napcatTmpDir)
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/napcat/control',
        payload: { action: 'stop' },
      })
      expect(res.statusCode).toBe(202)
      expect(existsSync(napcatTmpFile)).toBe(true)
      expect(JSON.parse(readFileSync(napcatTmpFile, 'utf-8')).action).toBe('stop')

      const bad = await app.inject({
        method: 'POST',
        url: '/api/connectors/napcat/control',
        payload: { action: 'restart' },
      })
      expect(bad.statusCode).toBe(400)
    })
  })

  describe('NapCat 启动路径配置（.napcat-config.json 读写 + 存在性校验）', () => {
    // 独立隔离目录（与 control 的 restart-test-napcat 分开——两 describe 并行用例交错
    // 会互删对方文件；路径配置读的是 .napcat-config.json，control 读写 .napcat-request）
    const cfgTmpDir = 'node_modules/.cache/restart-test-napcat-config'
    const cfgTmpFile = path.join(cfgTmpDir, '.napcat-config.json')
    /** 真实存在的文件——「路径存在」断言用（stat 走真 fs，非 mock） */
    const realExe = path.join(cfgTmpDir, 'NapCat Studio.exe') // 含空格名，顺带验证路径存储不做引号处理

    afterEach(() => {
      rmSync(cfgTmpDir, { recursive: true, force: true })
    })

    it('GET config: 未保存 → napcatPath 空串 + pathExists null', async () => {
      vi.stubEnv('RESTART_FILES_DIR', cfgTmpDir)
      const res = await app.inject({ method: 'GET', url: '/api/connectors/napcat/config' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.ok).toBe(true)
      expect(body.napcatPath).toBe('')
      expect(body.pathExists).toBeNull()
    })

    it('POST config: 存在的路径（含空格）→ 200 落盘原样存储；GET 回读一致 + pathExists true', async () => {
      vi.stubEnv('RESTART_FILES_DIR', cfgTmpDir)
      mkdirSync(cfgTmpDir, { recursive: true })
      writeFileSync(realExe, '') // 真实存在的文件
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/napcat/config',
        payload: { napcatPath: realExe },
      })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body).napcatPath).toBe(realExe)
      // 落盘内容原样（含空格无引号——dev.js 侧由 Node 数组参数组装加引号）
      expect(JSON.parse(readFileSync(cfgTmpFile, 'utf-8')).napcatPath).toBe(realExe)

      const get = await app.inject({ method: 'GET', url: '/api/connectors/napcat/config' })
      const body = JSON.parse(get.body)
      expect(body.napcatPath).toBe(realExe)
      expect(body.pathExists).toBe(true)
    })

    it('POST config: 不存在路径 → 400「路径不存在」且不落盘', async () => {
      vi.stubEnv('RESTART_FILES_DIR', cfgTmpDir)
      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/napcat/config',
        payload: { napcatPath: path.join(cfgTmpDir, 'no-such.exe') },
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).error).toBe('路径不存在')
      expect(existsSync(cfgTmpFile)).toBe(false)
    })

    it('POST config: 空值 / 缺失字段 / 非字符串 → 400', async () => {
      vi.stubEnv('RESTART_FILES_DIR', cfgTmpDir)
      const blank = await app.inject({
        method: 'POST',
        url: '/api/connectors/napcat/config',
        payload: { napcatPath: '   ' },
      })
      expect(blank.statusCode).toBe(400)
      const missing = await app.inject({
        method: 'POST',
        url: '/api/connectors/napcat/config',
        payload: { other: 1 },
      })
      expect(missing.statusCode).toBe(400)
      const noBody = await app.inject({ method: 'POST', url: '/api/connectors/napcat/config' })
      expect(noBody.statusCode).toBe(400)
    })

    it('GET status: launchReady 随模板形态与路径配置（占位符未配 → false；配了 → true）', async () => {
      vi.stubEnv('NAPCAT_LAUNCH_CMD', 'napcat --path {NAPCAT_PATH}')
      // 含占位符且未配路径 → launchReady false（launchCmdConfigured 仍 true——模板非空）
      let res = await app.inject({ method: 'GET', url: '/api/connectors/onebot/status' })
      let body = JSON.parse(res.body)
      expect(body.launchCmdConfigured).toBe(true)
      expect(body.launchReady).toBe(false)

      // 配置存在路径 → launchReady true
      vi.stubEnv('RESTART_FILES_DIR', cfgTmpDir)
      mkdirSync(cfgTmpDir, { recursive: true })
      writeFileSync(realExe, '')
      await app.inject({
        method: 'POST',
        url: '/api/connectors/napcat/config',
        payload: { napcatPath: realExe },
      })
      res = await app.inject({ method: 'GET', url: '/api/connectors/onebot/status' })
      body = JSON.parse(res.body)
      expect(body.launchReady).toBe(true)

      // 无占位符的完整命令行 → 不依赖路径配置，直接就绪（f184c71 语义向后兼容）。
      // 此处 config 目录里已有保存的路径——若实现错误地等路径就绪必红
      vi.stubEnv('NAPCAT_LAUNCH_CMD', 'napcat.exe --config x')
      res = await app.inject({ method: 'GET', url: '/api/connectors/onebot/status' })
      expect(JSON.parse(res.body).launchReady).toBe(true)
    })
  })
})

describe('NapCat 路径浏览（只读目录导航，零 spawn）', () => {
  // 真实文件系统目录（browse 读真实路径；node_modules/.cache 下天然被 gitignore 覆盖）
  const browseTmpDir = path.join('node_modules', '.cache', 'restart-test-browse')
  let browseApp: FastifyInstance

  beforeAll(async () => {
    rmSync(browseTmpDir, { recursive: true, force: true })
    mkdirSync(path.join(browseTmpDir, 'shell'), { recursive: true })
    writeFileSync(path.join(browseTmpDir, 'napcat.bat'), 'node ./index.js\n')
    writeFileSync(path.join(browseTmpDir, 'shell', 'index.js'), 'console.log("ok")\n')
    writeFileSync(path.join(browseTmpDir, 'notes.txt'), 'plain file\n')
    const testDb = createTestDb()
    setDb(testDb)
    initRepository(testDb)
    browseApp = await buildTestApp()
    const { connectorRoutes } = await import('./connectors.js')
    await browseApp.register(connectorRoutes)
  })

  afterAll(async () => {
    rmSync(browseTmpDir, { recursive: true, force: true })
    resetDb()
  })

  it('dir 空 → 盘符列表（A:-Z: 枚举，全部 dir 类型）', async () => {
    const res = await browseApp.inject({ method: 'GET', url: '/api/connectors/napcat/browse' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.dir).toBeNull()
    expect(body.parent).toBeNull()
    expect(body.entries.length).toBeGreaterThan(0)
    for (const e of body.entries) {
      expect(e.type).toBe('dir')
      expect(e.executable).toBe(false)
      expect(e.name).toMatch(/^[A-Z]:\\$/) // 盘符形态 C:\（反斜杠结尾）
    }
  })

  it('dir 存在 → 目录优先排序 + executable 标记（.bat 命中、.txt 不命中）', async () => {
    const res = await browseApp.inject({
      method: 'GET',
      url: `/api/connectors/napcat/browse?dir=${encodeURIComponent(browseTmpDir)}`,
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.dir).toBe(browseTmpDir)
    expect(body.parent).not.toBeNull()
    // 目录优先：shell（dir）在 notes.txt（file）之前
    expect(body.entries[0].name).toBe('shell')
    expect(body.entries[0].type).toBe('dir')
    const shell = body.entries.find((e: any) => e.name === 'shell')
    const bat = body.entries.find((e: any) => e.name === 'napcat.bat')
    const txt = body.entries.find((e: any) => e.name === 'notes.txt')
    expect(shell.type).toBe('dir')
    expect(bat.executable).toBe(true)
    expect(txt.executable).toBe(false)
    expect(txt.type).toBe('file')
  })

  it('盘符根目录 → parent null（dirname 自身不上溯）', async () => {
    // Windows 盘符根（如 C:\）的 dirname 是自身 → parent 必须为 null
    const driveRoot = path.parse(process.cwd()).root
    const res = await browseApp.inject({
      method: 'GET',
      url: `/api/connectors/napcat/browse?dir=${encodeURIComponent(driveRoot)}`,
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.parent).toBeNull()
  })

  it('dir 不存在 → 400 路径不存在；dir 是文件 → 400 不是目录', async () => {
    const missing = await browseApp.inject({
      method: 'GET',
      url:
        '/api/connectors/napcat/browse?dir=' + encodeURIComponent(path.join(browseTmpDir, 'nope')),
    })
    expect(missing.statusCode).toBe(400)
    expect(JSON.parse(missing.body).error).toBe('路径不存在')

    const file = await browseApp.inject({
      method: 'GET',
      url:
        '/api/connectors/napcat/browse?dir=' +
        encodeURIComponent(path.join(browseTmpDir, 'notes.txt')),
    })
    expect(file.statusCode).toBe(400)
    expect(JSON.parse(file.body).error).toBe('不是目录')
  })
})
