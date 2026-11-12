/**
 * 检索配置路由测试（GET/POST/DELETE /api/config/retrieval）。
 *
 * 覆盖：三档优先级经 HTTP 面可见；写侧四类非法值 400 且**零副作用**（不落库、
 * 生效值不变）；边界 1 / 10 可存；DELETE 幂等回落。路由壳与配置模块分开测——
 * 本文件只验 HTTP 契约（状态码 / 响应形状 / 不落库），模块语义见
 * `config/retrieval.test.ts`。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildTestApp, createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository, settings as settingsRepo } from '../db/repository/index.js'
import { RETRIEVAL_TOP_K_SETTING_KEY } from '../config/retrieval.js'

describe('routes/retrieval-config', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    // 不依赖外部 env（跑批进程可能继承 .env 的 MEMORY_TOP_K=5）
    vi.stubEnv('MEMORY_TOP_K', undefined)
    vi.stubEnv('MEMORY_MAX_DISTANCE', undefined)
    setDb(createTestDb())
    initRepository(getDb())
    app = await buildTestApp()
    const { retrievalConfigRoutes } = await import('./retrieval-config.js')
    await app.register(retrievalConfigRoutes)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await app.close()
    resetDb()
  })

  const getCfg = async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config/retrieval' })
    return { status: res.statusCode, body: JSON.parse(res.body) }
  }

  const postCfg = async (payload: unknown) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/config/retrieval',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    })
    return { status: res.statusCode, body: JSON.parse(res.body) }
  }

  it('GET 默认 → 3 / default / envTopK=null（无 ok 外壳）', async () => {
    const { status, body } = await getCfg()
    expect(status).toBe(200)
    expect(body).toEqual({
      topK: 3,
      topKSource: 'default',
      envTopK: null,
      defaultTopK: 3,
      maxDistance: 0.6,
    })
  })

  it('env=4 → GET 回报 4 / env；POST 7 → 7 / settings；DELETE → 回 4 / env', async () => {
    vi.stubEnv('MEMORY_TOP_K', '4')

    const first = await getCfg()
    expect(first.body.topK).toBe(4)
    expect(first.body.topKSource).toBe('env')

    const saved = await postCfg({ topK: 7 })
    expect(saved.status).toBe(200)
    expect(saved.body.ok).toBe(true)
    expect(saved.body.topK).toBe(7)
    expect(saved.body.topKSource).toBe('settings')

    const deleted = await app.inject({ method: 'DELETE', url: '/api/config/retrieval' })
    expect(deleted.statusCode).toBe(200)
    const deletedBody = JSON.parse(deleted.body)
    expect(deletedBody.ok).toBe(true)
    expect(deletedBody.topK).toBe(4)
    expect(deletedBody.topKSource).toBe('env')
  })

  it('DELETE 在无 settings 行时幂等（重复删不报错）', async () => {
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: 'DELETE', url: '/api/config/retrieval' })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body).topKSource).toBe('default')
    }
  })

  it('边界 1 与 10 可存', async () => {
    for (const k of [1, 10]) {
      const res = await postCfg({ topK: k })
      expect(res.status, String(k)).toBe(200)
      expect(res.body.topK).toBe(k)
    }
  })

  it('0 / 11 / 1.5 / "abc" / null → 400，且 DB 与生效值不变', async () => {
    vi.stubEnv('MEMORY_TOP_K', '4')
    const before = await getCfg()

    for (const bad of [0, 11, 1.5, 'abc', null, undefined]) {
      const res = await postCfg({ topK: bad })
      expect(res.status, String(bad)).toBe(400)
      expect(res.body.ok, String(bad)).toBeUndefined()
    }

    expect(settingsRepo.getSetting(RETRIEVAL_TOP_K_SETTING_KEY)).toBeUndefined()
    const after = await getCfg()
    expect(after.body).toEqual(before.body)
  })

  it('缺 topK / 空对象 / 未知字段 → 400', async () => {
    expect((await postCfg({})).status).toBe(400)
    expect((await postCfg({ topk: 7 })).status).toBe(400)
    expect((await postCfg({ topK: 7, maxDistance: 0.4 })).status).toBe(400)
  })
})
