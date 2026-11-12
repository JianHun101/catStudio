/**
 * 检索配置 API — 记忆检索的 topK（注入节数上限）。
 *
 * 契约（本票钉死）：
 * - GET    — `{ topK, topKSource, envTopK, defaultTopK, maxDistance }`（不带 ok 外壳）
 * - POST   — 收 `{ topK }`，1..10 的整数；越界 / 小数 / 字符串 / 未知字段 ⇒ 400，**不落库**
 * - DELETE — 删 settings 行回落 env / 默认，返回与 POST 同形状（带 ok）
 *
 * 生效时机：下一轮检索立即生效——检索链每次调用 `currentRetrievalParams()` 现读，
 * 没有进程内缓存，因此不需要重启 server。
 */
import type { FastifyInstance } from 'fastify'
import {
  getRetrievalConfig,
  isValidTopK,
  resetRetrievalTopK,
  setRetrievalTopK,
  MAX_TOP_K,
  MIN_TOP_K,
  type RetrievalConfig,
} from '../config/retrieval.js'

/** POST 成功 / DELETE 成功的响应：生效配置 + ok 外壳 */
function okBody(cfg: RetrievalConfig) {
  return { ok: true as const, ...cfg }
}

export async function retrievalConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/config/retrieval', async (_req, reply) => {
    return reply.send(getRetrievalConfig())
  })

  app.post('/api/config/retrieval', async (req, reply) => {
    const body = req.body
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return reply.status(400).send({ error: 'Request body is required' })
    }
    const entries = Object.entries(body as Record<string, unknown>)
    if (entries.length === 0) {
      return reply.status(400).send({ error: 'topK is required' })
    }
    // 未知字段 400：拼错字段名（topk / top_k）静默忽略会让前端以为保存成功
    for (const [key] of entries) {
      if (key !== 'topK') {
        return reply.status(400).send({ error: `Unknown field: ${key}` })
      }
    }
    const topK = (body as Record<string, unknown>).topK
    if (!isValidTopK(topK)) {
      return reply
        .status(400)
        .send({ error: `topK must be an integer in ${MIN_TOP_K}..${MAX_TOP_K}` })
    }
    // 先校验后写——400 路径零副作用（DB 与生效值都不变）
    return reply.send(okBody(setRetrievalTopK(topK)))
  })

  app.delete('/api/config/retrieval', async (_req, reply) => {
    return reply.send(okBody(resetRetrievalTopK()))
  })
}
