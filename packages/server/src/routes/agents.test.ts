import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb, buildTestApp } from '../test-helpers.js'
import { setDb, resetDb } from '../db/index.js'
import { agentRoutes } from './agents.js'
import type { FastifyInstance } from 'fastify'

describe('Agent Routes', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    setDb(createTestDb())
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
        payload: { ...validAgent, name: '服务员橘子' },
      })

      const res = await app.inject({ method: 'GET', url: '/api/agents' })
      expect(res.statusCode).toBe(200)
      const agents = JSON.parse(res.body)
      expect(agents).toHaveLength(2)
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

    it('returns 404 for nonexistent id', async () => {
      const res = await app.inject({ method: 'DELETE', url: '/api/agents/nonexistent' })
      expect(res.statusCode).toBe(404)
    })
  })
})
