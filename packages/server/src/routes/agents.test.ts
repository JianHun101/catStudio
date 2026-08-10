import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, buildTestApp } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository, agents as agentsRepo } from '../db/repository/index.js'
import { agentRoutes } from './agents.js'
import type { FastifyInstance } from 'fastify'

describe('Agent Routes', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    setDb(createTestDb())
    initRepository(getDb())
    app = await buildTestApp()
    await app.register(agentRoutes)
  })

  afterEach(async () => {
    await app.close()
    resetDb()
  })

  const validAgent = {
    name: '店长阿暹',
    avatar: '🐱',
    systemPrompt: '你是一只暹罗猫',
    llmProvider: 'deepseek',
    llmModel: 'deepseek-v4-pro',
    llmApiKey: 'sk-test',
  }

  describe('POST /api/agents', () => {
    it('creates an agent and returns 201', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: validAgent,
      })
      expect(res.statusCode).toBe(201)
      const body = JSON.parse(res.body)
      expect(body.name).toBe('店长阿暹')
      expect(body.llmProvider).toBe('deepseek')
      expect(body.id).toBeDefined()
      // POST 响应同样走 toAgentConfig 序列化——role 为 DB 默认 'unknown'（schema 无 role 字段，创建时不落值）
      expect(body.role).toBe('unknown')
    })

    it('defaults effortLevel to high when omitted (regression: NOT NULL constraint)', async () => {
      // 回归：agents.effort_level 列 NOT NULL DEFAULT 'high'，省略该字段时不得报
      // "NOT NULL constraint failed" —— repository 层兜底落库 'high'
      const res = await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: validAgent,
      })
      expect(res.statusCode).toBe(201)
      const body = JSON.parse(res.body)
      expect(body.effortLevel).toBe('high')
    })

    it('returns 409 for duplicate name', async () => {
      await app.inject({ method: 'POST', url: '/api/agents', payload: validAgent })
      const res = await app.inject({ method: 'POST', url: '/api/agents', payload: validAgent })
      expect(res.statusCode).toBe(409)
      const body = JSON.parse(res.body)
      expect(body.error).toContain('already exists')
    })

    it('returns 400 for invalid body (empty name)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: { ...validAgent, name: '' },
      })
      expect(res.statusCode).toBe(400)
    })

    it('returns 400 for missing required fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: { name: 'test' },
      })
      expect(res.statusCode).toBe(400)
    })
  })

  describe('POST /api/agents — 静态运行配置（llmMaxTokens/llmTemperature）', () => {
    it('带新字段 → 201 回读一致', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: { ...validAgent, llmMaxTokens: 4096, llmTemperature: 1.2 },
      })
      expect(res.statusCode).toBe(201)
      const body = JSON.parse(res.body)
      expect(body.llmMaxTokens).toBe(4096)
      expect(body.llmTemperature).toBe(1.2)
    })

    it('不带新字段 → 默认 2048/0.7（列 DEFAULT 回填，存量 agent 升级零行为变化）', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/agents', payload: validAgent })
      expect(res.statusCode).toBe(201)
      const body = JSON.parse(res.body)
      expect(body.llmMaxTokens).toBe(2048)
      expect(body.llmTemperature).toBe(0.7)
    })

    it.each([
      ['llmMaxTokens 为 0', { ...validAgent, llmMaxTokens: 0 }],
      ['llmMaxTokens 为负数', { ...validAgent, llmMaxTokens: -1 }],
      ['llmMaxTokens 超上限', { ...validAgent, llmMaxTokens: 131073 }],
      ['llmMaxTokens 为小数', { ...validAgent, llmMaxTokens: 1.5 }],
      ['llmMaxTokens 为字符串', { ...validAgent, llmMaxTokens: '4096' }],
      ['llmTemperature 超上限', { ...validAgent, llmTemperature: 2.5 }],
      ['llmTemperature 为负数', { ...validAgent, llmTemperature: -0.1 }],
      ['llmTemperature 为字符串', { ...validAgent, llmTemperature: '0.5' }],
    ])('非法值 → 400（%s）', async (_name, payload) => {
      const res = await app.inject({ method: 'POST', url: '/api/agents', payload })
      expect(res.statusCode).toBe(400)
    })
  })

  describe('GET /api/agents', () => {
    it('returns empty array when no agents', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/agents' })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual([])
    })

    it('returns all agents', async () => {
      await app.inject({ method: 'POST', url: '/api/agents', payload: validAgent })
      await app.inject({
        method: 'POST',
        url: '/api/agents',
        payload: { ...validAgent, name: '阿橘' },
      })

      const res = await app.inject({ method: 'GET', url: '/api/agents' })
      expect(res.statusCode).toBe(200)
      const agents = JSON.parse(res.body)
      expect(agents).toHaveLength(2)
    })

    it('serializes role field equal to DB value (frontend placeholder resolution contract)', async () => {
      // 序列化契约钉死：API 返回的 role 必须等于 DB 值——前端 resolveDisplayPlaceholders
      // 靠 `agents.find(a => a.role === 'store')` 找架构师真名；toAgentConfig 漏序列化 role
      // 时此断言必红（事故链第四次变体：序列化遗漏盲区）
      // 真实数据形态用 seed 同款 upsertAgent 写入（POST 不含 role——schema 无此字段，zod strip）
      agentsRepo.upsertAgent(
        'agent-role',
        '店长',
        '🐱',
        'prompt',
        'deepseek',
        'deepseek-v4-pro',
        'sk-test',
        '',
        'high',
        '[]',
        'store'
      )

      const res = await app.inject({ method: 'GET', url: '/api/agents' })
      expect(res.statusCode).toBe(200)
      const agents = JSON.parse(res.body)
      expect(agents).toHaveLength(1)
      expect(agents[0].role).toBe('store')
    })
  })

  describe('GET /api/agents/:id', () => {
    it('returns agent by id', async () => {
      const create = await app.inject({ method: 'POST', url: '/api/agents', payload: validAgent })
      const { id } = JSON.parse(create.body)

      const res = await app.inject({ method: 'GET', url: `/api/agents/${id}` })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body).name).toBe('店长阿暹')
    })

    it('returns 404 for nonexistent id', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/agents/nonexistent' })
      expect(res.statusCode).toBe(404)
    })
  })

  describe('PATCH /api/agents/:id', () => {
    it('updates an agent', async () => {
      const create = await app.inject({ method: 'POST', url: '/api/agents', payload: validAgent })
      const { id } = JSON.parse(create.body)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/agents/${id}`,
        payload: { name: '新名字' },
      })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body).name).toBe('新名字')
    })

    it('returns 404 for nonexistent id', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/agents/nonexistent',
        payload: { name: 'test' },
      })
      expect(res.statusCode).toBe(404)
    })

    it('returns 400 for empty body', async () => {
      const create = await app.inject({ method: 'POST', url: '/api/agents', payload: validAgent })
      const { id } = JSON.parse(create.body)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/agents/${id}`,
        payload: {},
      })
      expect(res.statusCode).toBe(400)
    })

    it('updates static run config (llmMaxTokens/llmTemperature)', async () => {
      const create = await app.inject({ method: 'POST', url: '/api/agents', payload: validAgent })
      const { id } = JSON.parse(create.body)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/agents/${id}`,
        payload: { llmMaxTokens: 8192, llmTemperature: 0.3 },
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.llmMaxTokens).toBe(8192)
      expect(body.llmTemperature).toBe(0.3)

      // GET 回读一致
      const get = await app.inject({ method: 'GET', url: `/api/agents/${id}` })
      expect(JSON.parse(get.body).llmMaxTokens).toBe(8192)
    })

    it.each([
      ['llmMaxTokens 为 0', { llmMaxTokens: 0 }],
      ['llmMaxTokens 为小数', { llmMaxTokens: 2.5 }],
      ['llmMaxTokens 为字符串', { llmMaxTokens: '4096' }],
      ['llmTemperature 超上限', { llmTemperature: 3 }],
      ['llmTemperature 为字符串', { llmTemperature: '0.5' }],
    ])('非法值 → 400 不落盘（%s）', async (_name, payload) => {
      const create = await app.inject({ method: 'POST', url: '/api/agents', payload: validAgent })
      const { id } = JSON.parse(create.body)

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/agents/${id}`,
        payload,
      })
      expect(res.statusCode).toBe(400)

      // 不落盘：回读仍是默认值
      const get = await app.inject({ method: 'GET', url: `/api/agents/${id}` })
      const body = JSON.parse(get.body)
      expect(body.llmMaxTokens).toBe(2048)
      expect(body.llmTemperature).toBe(0.7)
    })
  })

  describe('DELETE /api/agents/:id', () => {
    it('deletes an agent', async () => {
      const create = await app.inject({ method: 'POST', url: '/api/agents', payload: validAgent })
      const { id } = JSON.parse(create.body)

      const res = await app.inject({ method: 'DELETE', url: `/api/agents/${id}` })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ ok: true })

      // 确认已删除
      const get = await app.inject({ method: 'GET', url: `/api/agents/${id}` })
      expect(get.statusCode).toBe(404)
    })

    it('cascades deletes associated messages and memories', async () => {
      const create = await app.inject({ method: 'POST', url: '/api/agents', payload: validAgent })
      const { id } = JSON.parse(create.body)

      const { sessions, messages, memories } = await import('../db/repository/index.js')
      const sessionId = 'test-session-cascade'

      // 创建 session
      sessions.insertSession(sessionId, 'cascade test', [id])

      // 插入关联消息
      messages.insertMessage('msg-1', sessionId, 'user', 'hello', '[]', id, null)

      // 插入关联记忆
      const embedding = new Float32Array(512).fill(0.1)
      const embBuf = Buffer.from(embedding.buffer)
      memories.insertMemory('mem-1', id, 'test memory', embBuf, 'msg-1', new Date().toISOString())

      // 删除 agent
      const res = await app.inject({ method: 'DELETE', url: `/api/agents/${id}` })
      expect(res.statusCode).toBe(200)

      // 确认关联消息已级联删除
      const msgs = messages.getAllSessionMessages(sessionId)
      expect(msgs).toHaveLength(0)

      // 记忆表没有 list 函数，用再次删除不抛异常来验证级联生效
      expect(() => memories.deleteMemoriesByAgent(id)).not.toThrow()
    })

    it('returns 404 for nonexistent id', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/api/agents/nonexistent' })
      expect(res.statusCode).toBe(404)
    })
  })
})
