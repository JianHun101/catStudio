/**
 * config 路由测试（context 阈值配置 API）。
 *
 * 覆盖：GET 缺省值 / maxContext 从 env；POST 校验（0<t<1、warn≤handoff、至少一个字段、
 * 类型严格）与原子写落盘；坏 JSON 容错；shouldHandoff 读配置生效（跨模块消费验证——
 * 核心被测对象是 context-config 机制，shouldHandoff 是其消费方）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { buildTestApp, isolatedTestDir } from '../test-helpers.js'
import { shouldHandoff } from '../handoff/index.js'
import type { FastifyInstance } from 'fastify'

/**
 * 独立隔离目录——每个用例前清理，保证「缺文件」前提（与 connectors.test.ts 同款范式）。
 * 绝对路径 + 仓库根派生（test-helpers.isolatedTestDir）：相对路径经 worktree 的
 * node_modules junction 落在主仓库共享面，跨根并发跑批仍互删。
 */
const cfgTmpDir = isolatedTestDir('restart-test-context-config')
const cfgTmpFile = path.join(cfgTmpDir, 'context-config.json')

const getConfig = async (app: FastifyInstance) => {
  const res = await app.inject({ method: 'GET', url: '/api/config/context' })
  return JSON.parse(res.body)
}

describe('config routes (context thresholds)', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    rmSync(cfgTmpDir, { recursive: true, force: true })
    vi.stubEnv('RESTART_FILES_DIR', cfgTmpDir)
    vi.stubEnv('MAX_CONTEXT_TOKENS', '128000')
    app = await buildTestApp()
    const { configRoutes } = await import('./config.js')
    await app.register(configRoutes)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    rmSync(cfgTmpDir, { recursive: true, force: true })
    await app.close()
  })

  describe('GET /api/config/context', () => {
    it('缺文件 → 默认 0.8/0.9 + maxContextTokens 从 env', async () => {
      const body = await getConfig(app)
      expect(body.ok).toBe(true)
      expect(body.warnThreshold).toBe(0.8)
      expect(body.handoffThreshold).toBe(0.9)
      expect(body.maxContextTokens).toBe(128000)
    })

    it('maxContextTokens 跟随 env MAX_CONTEXT_TOKENS', async () => {
      vi.stubEnv('MAX_CONTEXT_TOKENS', '32000')
      const body = await getConfig(app)
      expect(body.maxContextTokens).toBe(32000)
    })

    it('坏 JSON 文件 → 默认值（读失败=未配置降级）', async () => {
      mkdirSync(cfgTmpDir, { recursive: true })
      const { writeFileSync } = await import('node:fs')
      writeFileSync(cfgTmpFile, 'not json{{{')
      const body = await getConfig(app)
      expect(body.warnThreshold).toBe(0.8)
      expect(body.handoffThreshold).toBe(0.9)
    })

    it('文件里手工写的坏值（1.5）→ 默认值（坏值=缺失）', async () => {
      mkdirSync(cfgTmpDir, { recursive: true })
      const { writeFileSync } = await import('node:fs')
      writeFileSync(cfgTmpFile, JSON.stringify({ warnThreshold: 1.5, handoffThreshold: 0.9 }))
      const body = await getConfig(app)
      expect(body.warnThreshold).toBe(0.8)
      expect(body.handoffThreshold).toBe(0.9)
    })
  })

  describe('POST /api/config/context', () => {
    it('合法全量 → 200 落盘；GET 回读一致；文件为合法 JSON（原子写产物）', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/config/context',
        payload: { warnThreshold: 0.7, handoffThreshold: 0.85 },
      })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.warnThreshold).toBe(0.7)
      expect(body.handoffThreshold).toBe(0.85)

      const after = await getConfig(app)
      expect(after.warnThreshold).toBe(0.7)
      expect(after.handoffThreshold).toBe(0.85)

      const raw = JSON.parse(readFileSync(cfgTmpFile, 'utf-8'))
      expect(raw.warnThreshold).toBe(0.7)
      expect(raw.handoffThreshold).toBe(0.85)
      expect(typeof raw.updatedAt).toBe('string')
    })

    it('只传一个字段 → 合并保留另一个', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/config/context',
        payload: { warnThreshold: 0.6 },
      })
      const body = await getConfig(app)
      expect(body.warnThreshold).toBe(0.6)
      expect(body.handoffThreshold).toBe(0.9)
    })

    it.each([
      [{ warnThreshold: 0 }, 'warnThreshold=0'],
      [{ warnThreshold: 1 }, 'warnThreshold=1'],
      [{ warnThreshold: -0.5 }, 'warnThreshold=-0.5'],
      [{ handoffThreshold: 1.5 }, 'handoffThreshold=1.5'],
      [{ warnThreshold: '0.5' }, 'string 类型不静默转 number'],
      [{ handoffThreshold: null }, 'null 类型'],
      [{}, '空 body 两字段都不传'],
    ])('非法输入 %s → 400 且不落盘', async (payload, label) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/config/context',
        payload,
      })
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body).error).toBeTruthy()
      expect(existsSync(cfgTmpFile)).toBe(false) // 校验失败路径零副作用
    })

    it('warnThreshold > handoffThreshold → 400 不落盘', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/config/context',
        payload: { warnThreshold: 0.95, handoffThreshold: 0.9 },
      })
      expect(res.statusCode).toBe(400)
      expect(existsSync(cfgTmpFile)).toBe(false)
    })

    it('warnThreshold == handoffThreshold → 200（边界允许相等）', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/config/context',
        payload: { warnThreshold: 0.9, handoffThreshold: 0.9 },
      })
      expect(res.statusCode).toBe(200)
    })
  })

  describe('shouldHandoff 读配置生效（跨模块消费验证）', () => {
    beforeEach(() => {
      vi.stubEnv('HANDOFF_ENABLED', 'true')
      vi.stubEnv('MAX_CONTEXT_TOKENS', '128000')
    })

    it('配置文件 handoffThreshold=0.5 → 64000 触发 / 63999 不触发 / 60000 不触发', async () => {
      // warn 必须 ≤ handoff 才能落盘（契约校验）——同时传 warn=0.4 避开 400
      await app.inject({
        method: 'POST',
        url: '/api/config/context',
        payload: { warnThreshold: 0.4, handoffThreshold: 0.5 },
      })
      // 128000 * 0.5 = 64000——交接线是 max*threshold，等值触发
      expect(shouldHandoff(64000)).toBe(true)
      expect(shouldHandoff(63999)).toBe(false)
      expect(shouldHandoff(60000)).toBe(false)
    })

    it('配置文件优先于 env HANDOFF_THRESHOLD', async () => {
      vi.stubEnv('HANDOFF_THRESHOLD', '0.9')
      await app.inject({
        method: 'POST',
        url: '/api/config/context',
        payload: { warnThreshold: 0.4, handoffThreshold: 0.5 },
      })
      // 文件 0.5 生效：64000 触发；若误走 env 0.9 则 115200 才触发
      expect(shouldHandoff(64000)).toBe(true)
    })

    it('无配置文件 → env fallback（行为与现状一致）', () => {
      vi.stubEnv('HANDOFF_THRESHOLD', '0.8')
      expect(shouldHandoff(102400)).toBe(true) // 128000*0.8=102400
      expect(shouldHandoff(102399)).toBe(false)
    })
  })
})
