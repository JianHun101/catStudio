/**
 * iron-laws 路由测试 — GET /api/iron-laws 只读暴露铁律常量。
 *
 * 核心断言：接口返回与 seed-data.ts 常量逐字一致（直接 import，天然一致）——
 * coder/reviewer 非空 + 含关键子串（「行首」「post-commit」「request_user_action」），
 * 并抽查「开发铁律注入多猫 / 审查铁律注入吐槽猫」的归属特征。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp } from '../test-helpers.js'
import { IRON_LAWS_CODER, IRON_LAWS_REVIEWER } from '../seed-data.js'
import { ironLawRoutes } from './iron-laws.js'

describe('iron-laws routes (GET /api/iron-laws)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await buildTestApp()
    await app.register(ironLawRoutes)
  })

  afterEach(async () => {
    await app.close()
  })

  it('返回 ok + coder/reviewer，与 seed-data 常量逐字一致', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/iron-laws' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(body.coder).toBe(IRON_LAWS_CODER)
    expect(body.reviewer).toBe(IRON_LAWS_REVIEWER)
  })

  it('coder 非空且含开发铁律关键子串（行首 / post-commit / request_user_action）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/iron-laws' })
    const body = JSON.parse(res.body)
    expect(body.coder.length).toBeGreaterThan(0)
    expect(body.coder).toContain('行首')
    expect(body.coder).toContain('post-commit')
    expect(body.coder).toContain('request_user_action')
    // 归属特征：开发铁律注入多只猫（「你的名字是」出现多次），非单猫专属
    expect(body.coder).toContain('Worktree 模式')
  })

  it('reviewer 非空且含审查铁律关键子串（行首 / 审查流程 / request_user_action）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/iron-laws' })
    const body = JSON.parse(res.body)
    expect(body.reviewer.length).toBeGreaterThan(0)
    expect(body.reviewer).toContain('行首')
    expect(body.reviewer).toContain('审查流程')
    expect(body.reviewer).toContain('request_user_action')
  })
})
