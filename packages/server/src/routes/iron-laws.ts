/**
 * 铁律 API — 开发铁律 + 审查铁律的读写入口。
 *
 * - GET  /api/iron-laws → 200 { ok: true, coder, reviewer }
 * - POST /api/iron-laws → body { coder, reviewer }（必填、string、trim 后非空、
 *   各 ≤20000 字符）→ writeIronLaws 落 settings 表 → { ok: true, coder, reviewer }
 *
 * 铁律运行期注入的全局策略（settings 表优先、seed-data.ts 常量兜底）——编辑后
 * 下一轮回复立即生效（无需重启、无需重跑 seed）。配置页面「⚙️ 系统配置」tab 铁律卡片消费。
 */
import type { FastifyInstance } from 'fastify'
import { getIronLaws, writeIronLaws } from '../config/iron-laws.js'

const MAX_IRON_LAW_LENGTH = 20000

/** 铁律字段合法性：必填、string、trim 后非空、长度 ≤ 上限。返回错误消息或 null（合法） */
function validIronLaw(value: unknown): string | null {
  if (typeof value !== 'string') return 'must be a string'
  const trimmed = value.trim()
  if (!trimmed) return 'must not be empty'
  if (trimmed.length > MAX_IRON_LAW_LENGTH) {
    return `must be at most ${MAX_IRON_LAW_LENGTH} characters`
  }
  return null
}

export async function ironLawRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/iron-laws', async () => ({
    ok: true,
    ...getIronLaws(),
  }))

  app.post('/api/iron-laws', async (req, reply) => {
    const body = req.body as any
    if (!body || typeof body !== 'object') {
      return reply.status(400).send({ error: 'Request body is required' })
    }
    const coderError = validIronLaw(body.coder)
    if (coderError) {
      return reply.status(400).send({ error: `coder ${coderError}` })
    }
    const reviewerError = validIronLaw(body.reviewer)
    if (reviewerError) {
      return reply.status(400).send({ error: `reviewer ${reviewerError}` })
    }
    const coder = (body.coder as string).trim()
    const reviewer = (body.reviewer as string).trim()
    writeIronLaws(coder, reviewer)
    return reply.send({ ok: true, coder, reviewer })
  })
}
