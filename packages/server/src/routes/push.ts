/**
 * push 审批 REST API — push 确认/取消走 HTTP（一次性请求/响应，不依赖 WebSocket 传输）。
 *
 * - POST /api/push/confirm — body { messageId }：执行 git push origin dev（幂等，连点短路）
 * - POST /api/push/cancel — body { messageId }：清除审批态（取消即删除，push 幂等）
 *
 * 迁移动因：PUSH_CONFIRM 是纯「请求 → 结果」交互，本不该走 WebSocket——socket 版继承了
 * WS 传输脆弱性（用户追了 N 轮的「点确认按钮 transport close」）。HTTP 状态码 + 响应体
 * 本身就是 ack，无需 ack 回调 + 超时兜底。业务核心在 git/push-state.ts 的
 * executePushConfirm/cancelPush（push 审批状态机唯一 owner，REST 与历史 Socket 双入口共用同一语义）。
 */
import type { FastifyInstance } from 'fastify'
import { executePushConfirm, cancelPush } from '../git/push-state.js'

export async function pushRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /api/push/confirm — body { messageId }
   * messageId 缺失/非 string → 400；否则 executePushConfirm 结果原样 200 返回
   * （业务失败也 200，状态在 body——失败是预期业务分支，不是 HTTP 层错误）。
   */
  app.post('/api/push/confirm', async (req, reply) => {
    const body = req.body as { messageId?: unknown } | null
    if (typeof body?.messageId !== 'string' || !body.messageId) {
      return reply.status(400).send({ error: 'messageId is required (string)' })
    }
    const result = await executePushConfirm(body.messageId)
    return reply.send(result)
  })

  /**
   * POST /api/push/cancel — body { messageId }
   * messageId 缺失/非 string → 400；否则取消 → 200 { ok: true }。
   */
  app.post('/api/push/cancel', async (req, reply) => {
    const body = req.body as { messageId?: unknown } | null
    if (typeof body?.messageId !== 'string' || !body.messageId) {
      return reply.status(400).send({ error: 'messageId is required (string)' })
    }
    cancelPush(body.messageId)
    return reply.send({ ok: true })
  })
}
