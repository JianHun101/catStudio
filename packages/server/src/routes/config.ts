/**
 * 上下文阈值配置 API — 80% 告警线 / 90% 交接触发线的读写入口。
 *
 * 配置落 context-config.json（项目根，dev.js 不消费——无跨包读点，见 config/context-config.ts）：
 * - GET  — 返回 { warnThreshold, handoffThreshold, maxContextTokens }；缺文件返回默认 0.8/0.9
 * - POST — 收 { warnThreshold?, handoffThreshold? }（至少一个），校验 0<t<1 且 warn≤handoff，
 *          原子写文件，返回最新全量
 *
 * maxContextTokens 从 env MAX_CONTEXT_TOKENS 读、不回写（.env 可写管理留二期，既定契约）。
 */
import type { FastifyInstance } from 'fastify'
import {
  readContextConfig,
  writeContextConfig,
  type ContextConfig,
} from '../config/context-config.js'

/** 阈值合法性：number、有限、开区间 (0,1)——写侧 400 判定（与读侧同源同义） */
function validThreshold(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1
}

function maxContextTokens(): number {
  return parseInt(process.env.MAX_CONTEXT_TOKENS || '128000', 10)
}

function toResponseBody(cfg: ContextConfig) {
  return {
    ok: true,
    warnThreshold: cfg.warnThreshold,
    handoffThreshold: cfg.handoffThreshold,
    maxContextTokens: maxContextTokens(),
  }
}

export async function configRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/config/context', async (req, reply) => {
    return reply.send(toResponseBody(readContextConfig()))
  })

  app.post('/api/config/context', async (req, reply) => {
    const body = req.body as any
    if (!body || typeof body !== 'object') {
      return reply.status(400).send({ error: 'Request body is required' })
    }
    const hasWarn = body.warnThreshold !== undefined
    const hasHandoff = body.handoffThreshold !== undefined
    if (!hasWarn && !hasHandoff) {
      return reply.status(400).send({ error: 'warnThreshold or handoffThreshold is required' })
    }
    // 存在字段必须 number 且 0<t<1——string "0.5" 静默转 number 会掩盖前端 bug，
    // 400 钉死契约类型（与 napcat config 的 autoStart 严格写同哲学）
    if (hasWarn && !validThreshold(body.warnThreshold)) {
      return reply.status(400).send({ error: 'warnThreshold must be a number in (0, 1)' })
    }
    if (hasHandoff && !validThreshold(body.handoffThreshold)) {
      return reply.status(400).send({ error: 'handoffThreshold must be a number in (0, 1)' })
    }
    // 合并未传字段与现有值——只改一个字段时保留另一个（契约：字段可选）
    const current = readContextConfig()
    const next: ContextConfig = {
      warnThreshold: hasWarn ? body.warnThreshold : current.warnThreshold,
      handoffThreshold: hasHandoff ? body.handoffThreshold : current.handoffThreshold,
    }
    if (next.warnThreshold > next.handoffThreshold) {
      return reply.status(400).send({ error: 'warnThreshold must be <= handoffThreshold' })
    }
    // 先校验后写盘——校验失败路径零副作用（不落盘）
    const saved = writeContextConfig(next)
    return reply.send(toResponseBody(saved))
  })
}
