/**
 * config-summary 路由测试（摘要配置 API）。
 *
 * 覆盖：GET 回显（掩码/缺省/hasKey/needsRestart）；POST 行级 patch .env——
 * 只替换目标行、注释与其他键逐字符保真、行不存在追加、空串清空（删除行 → 重启后
 * 回退 DS_KEY）、无字段 no-op、校验 400 不落盘。ENV_FILE_PATH stub 隔离真实 .env。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildTestApp } from '../test-helpers.js'
import type { FastifyInstance } from 'fastify'

const tmpDir = 'node_modules/.cache/restart-test-env-patch'
const envFile = path.join(tmpDir, '.env')

/** 初始 .env 副本——含注释、引号值、无关键，验证行级 patch 保真 */
const ORIGINAL_ENV = `# 猫咖 .env 测试副本（注释必须原样保留）
DS_KEY="sk-original-ds-key-with-quotes"

# 摘要模型（注释必须原样保留）
SUMMARY_MODEL=deepseek-v4-flash
SUMMARY_API_KEY=sk-test-abcdef123456

PORT=3200
`

const getSummary = async (app: FastifyInstance) => {
  const res = await app.inject({ method: 'GET', url: '/api/config/summary' })
  return JSON.parse(res.body)
}

const postSummary = (app: FastifyInstance, body: unknown) =>
  app.inject({ method: 'POST', url: '/api/config/summary', payload: body as any })

describe('config-summary routes', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    rmSync(tmpDir, { recursive: true, force: true })
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(envFile, ORIGINAL_ENV)
    vi.stubEnv('ENV_FILE_PATH', envFile)
    vi.stubEnv('SUMMARY_MODEL', 'deepseek-v4-flash')
    vi.stubEnv('SUMMARY_BASE_URL', 'https://api.deepseek.com')
    vi.stubEnv('SUMMARY_API_KEY', 'sk-test-abcdef123456')
    app = await buildTestApp()
    const { summaryConfigRoutes } = await import('./config-summary.js')
    await app.register(summaryConfigRoutes)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    rmSync(tmpDir, { recursive: true, force: true })
    await app.close()
  })

  describe('GET /api/config/summary', () => {
    it('回显模型/baseUrl/掩码 key/hasKey，needsRestart:false', async () => {
      const body = await getSummary(app)
      expect(body.ok).toBe(true)
      expect(body.summaryModel).toBe('deepseek-v4-flash')
      expect(body.summaryBaseUrl).toBe('https://api.deepseek.com')
      expect(body.summaryApiKeyMasked).toBe('sk***3456')
      expect(body.hasKey).toBe(true)
      expect(body.needsRestart).toBe(false)
    })

    it('无 key → 掩码空串 + hasKey:false（未配置提示的数据源）', async () => {
      vi.stubEnv('SUMMARY_API_KEY', '')
      const body = await getSummary(app)
      expect(body.summaryApiKeyMasked).toBe('')
      expect(body.hasKey).toBe(false)
    })

    it('短 key（≤8 字符）→ 整体打码不泄前缀', async () => {
      vi.stubEnv('SUMMARY_API_KEY', 'sk-short')
      const body = await getSummary(app)
      expect(body.summaryApiKeyMasked).toBe('***')
    })
  })

  describe('POST /api/config/summary — 行级 patch .env', () => {
    it('改 summaryModel → 仅该行变化，注释/引号/其他键逐字符保真，needsRestart:true', async () => {
      const res = await postSummary(app, { summaryModel: 'deepseek-chat' })
      const body = JSON.parse(res.body)
      expect(body.needsRestart).toBe(true)
      // 注意：响应反映当前进程 env（重启才生效），summaryModel 仍是旧值——needsRestart
      // 即驱动前端「已保存，重启后生效」提示链；真正落盘的是 .env 文件（下方断言）
      expect(body.summaryModel).toBe('deepseek-v4-flash')
      expect(body.summaryApiKeyMasked).toBe('sk***3456')

      const file = readFileSync(envFile, 'utf-8')
      expect(file).toContain('SUMMARY_MODEL=deepseek-chat')
      expect(file).toContain('# 摘要模型（注释必须原样保留）')
      expect(file).toContain('DS_KEY="sk-original-ds-key-with-quotes"')
      expect(file).toContain('# 猫咖 .env 测试副本（注释必须原样保留）')
      expect(file).toContain('PORT=3200')
      // 原 SUMMARY_API_KEY 行未被触碰
      expect(file).toContain('SUMMARY_API_KEY=sk-test-abcdef123456')
      expect(file).not.toContain('SUMMARY_MODEL=deepseek-v4-flash')
    })

    it('改 summaryApiKey → 行替换为新值', async () => {
      const res = await postSummary(app, { summaryApiKey: 'sk-new-key-9999999999' })
      expect(JSON.parse(res.body).needsRestart).toBe(true)
      const file = readFileSync(envFile, 'utf-8')
      expect(file).toContain('SUMMARY_API_KEY=sk-new-key-9999999999')
      expect(file).not.toContain('SUMMARY_API_KEY=sk-test-abcdef123456')
    })

    it('summaryApiKey 空串 = 清空 → 删除该行 + note 明示回退语义（删除而非写空值，env.ts ??= 对显式空串不生效）', async () => {
      const res = await postSummary(app, { summaryApiKey: '' })
      const body = JSON.parse(res.body)
      expect(body.needsRestart).toBe(true)
      expect(body.note).toContain('回退复用 DS_KEY')
      const file = readFileSync(envFile, 'utf-8')
      expect(file).not.toContain('SUMMARY_API_KEY=')
      // 注释仍在（行删除不连坐注释）
      expect(file).toContain('# 摘要模型（注释必须原样保留）')
    })

    it('行不存在 → 追加到文件尾部', async () => {
      // 初始文件删掉 SUMMARY_MODEL 行（模拟无该键的旧 .env）
      writeFileSync(envFile, ORIGINAL_ENV.replace('SUMMARY_MODEL=deepseek-v4-flash\n', ''))
      const res = await postSummary(app, { summaryModel: 'deepseek-chat' })
      expect(JSON.parse(res.body).needsRestart).toBe(true)
      const file = readFileSync(envFile, 'utf-8')
      expect(file).toContain('SUMMARY_MODEL=deepseek-chat')
      expect(file.trimEnd().split('\n').pop()).toBe('SUMMARY_MODEL=deepseek-chat')
    })

    it('CRLF 文件 → patch 后保持 CRLF 行尾（不混合换行）', async () => {
      writeFileSync(envFile, ORIGINAL_ENV.replace(/\n/g, '\r\n'))
      await postSummary(app, { summaryModel: 'deepseek-chat' })
      const file = readFileSync(envFile, 'utf-8')
      expect(file).toContain('SUMMARY_MODEL=deepseek-chat\r\n')
      expect(file).toContain('DS_KEY="sk-original-ds-key-with-quotes"\r\n')
      // 无裸 \n（除 \r\n 外无单换行）
      expect(file.replace(/\r\n/g, '')).not.toContain('\n')
    })

    it('无字段 POST → 200 no-op，needsRestart:false，文件不变', async () => {
      const before = readFileSync(envFile, 'utf-8')
      const res = await postSummary(app, {})
      const body = JSON.parse(res.body)
      expect(body.needsRestart).toBe(false)
      expect(body.note).toBeUndefined()
      expect(readFileSync(envFile, 'utf-8')).toBe(before)
    })

    it('校验 400：summaryModel 非字符串/空串/纯空白；summaryApiKey 非字符串 → 不落盘', async () => {
      const before = readFileSync(envFile, 'utf-8')
      const badBodies = [
        { summaryModel: 123 },
        { summaryModel: '' },
        { summaryModel: '   ' },
        { summaryApiKey: 42 },
      ]
      for (const bad of badBodies) {
        const res = await postSummary(app, bad)
        expect(res.statusCode).toBe(400)
        expect(JSON.parse(res.body).error).toBeTruthy()
      }
      expect(readFileSync(envFile, 'utf-8')).toBe(before)
    })
  })
})
