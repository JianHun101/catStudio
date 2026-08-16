/**
 * iron-laws 路由测试 — GET/POST /api/iron-laws（运行期注入的全局策略）。
 *
 * - GET 空 settings → 回退 seed-data.ts 常量（逐字一致）
 * - GET 写后 → settings 优先（写后返回新值）
 * - POST 校验 400：缺字段 / 空串 / 超长
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestDb, buildTestApp } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository } from '../db/repository/index.js'
import { IRON_LAWS_CODER, IRON_LAWS_REVIEWER } from '../seed-data.js'
import { ironLawRoutes } from './iron-laws.js'

describe('iron-laws routes', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    setDb(createTestDb())
    initRepository(getDb())
    app = await buildTestApp()
    await app.register(ironLawRoutes)
  })

  afterEach(async () => {
    await app.close()
    resetDb()
  })

  it('GET 空 settings → 回退 seed-data 常量（coder/reviewer 逐字一致）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/iron-laws' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.coder).toBe(IRON_LAWS_CODER)
    expect(body.reviewer).toBe(IRON_LAWS_REVIEWER)
  })

  it('GET 写后 → settings 优先（返回新值，不再回退常量）', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/iron-laws',
      payload: { coder: '开发铁律 v2', reviewer: '审查铁律 v2' },
    })
    const res = await app.inject({ method: 'GET', url: '/api/iron-laws' })
    const body = JSON.parse(res.body)
    expect(body.coder).toBe('开发铁律 v2')
    expect(body.reviewer).toBe('审查铁律 v2')
  })

  it('POST 合法 → 返回 ok + trim 后内容', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/iron-laws',
      payload: { coder: '  开发铁律 v3  ', reviewer: '  审查铁律 v3  ' },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.coder).toBe('开发铁律 v3')
    expect(body.reviewer).toBe('审查铁律 v3')
  })

  it('POST 缺字段 → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/iron-laws',
      payload: { coder: 'x' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('POST 空串/纯空白 → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/iron-laws',
      payload: { coder: '   ', reviewer: 'y' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('POST 超长（>20000）→ 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/iron-laws',
      payload: { coder: 'x'.repeat(20001), reviewer: 'y' },
    })
    expect(res.statusCode).toBe(400)
  })
})
