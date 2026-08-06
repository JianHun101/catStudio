/**
 * 内部端点——MCP 结构化路由信号入口（Phase 1）。
 *
 * 模型通过 post_message 工具（scripts/mcp-server.mjs）POST 本端点声明
 * 「投递下一棒」意图。校验顺序（店长裁决二钉死）：
 *   1. body 基本校验（400）——防御纵深（mcp-server.mjs 已做参数校验）
 *   2. lookup activeStreams（404）——无活跃流 = 没有可接收信号的流
 *   3. token 精确匹配（401）——x-signal-token === 本 spawn 随机 token
 *      （方案 A：token 在 socketio.ts runAgentReply 生成，activeStreams 存值，
 *       context 透传进 .mcp.json env——「每 spawn 随机」语义保持）
 *   4. 复合键 sessionId 匹配（409）——流存在但在别的会话
 *   5. 目标预校验（422）——会话成员 + 角色白名单（filterAllowedMentions
 *      与 socketio.ts 合并点同源，body 可选字段 triggerAuthorName 支持 reviewer
 *      @ 回请求人的特殊边——OQ③ 补丁），失败 422 + reason 回模型（消灭半成功 ACK）
 *   6. storeRouteSignal 入 Map（200）——合并点按 messageId 标签消费
 *
 * 失败一律 4xx + reason 字段——mcp-server.mjs 把 reason 拼进工具错误文本
 * 回模型（提示改行首 @ fallback）。
 */

import type { FastifyInstance } from 'fastify'
import { createLogger } from '../logger.js'
import { sessions as sessionsRepo, agents as agentsRepo } from '../db/repository/index.js'
import { getActiveStream } from '../connectors/socketio.js'
import { storeRouteSignal } from '../llm/route-signals.js'
import { filterAllowedMentions } from '../dispatch/mention-policy.js'
import type { AgentRole } from '@cat-study/shared'

const log = createLogger('internal')

interface RouteSignalBody {
  sessionId?: unknown
  agentId?: unknown
  msgId?: unknown
  targetCats?: unknown
  clientMessageId?: unknown
  triggerAuthorName?: unknown
}

export async function internalRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/internal/route-signals', async (req, reply) => {
    const body = (req.body ?? {}) as RouteSignalBody

    // ── 1. body 基本校验（400）──
    const { sessionId, agentId, msgId } = body
    if (
      typeof sessionId !== 'string' ||
      !sessionId ||
      typeof agentId !== 'string' ||
      !agentId ||
      typeof msgId !== 'string' ||
      !msgId
    ) {
      return reply.status(400).send({ ok: false, reason: 'sessionId/agentId/msgId 必填非空字符串' })
    }
    const targetCats = body.targetCats
    if (
      !Array.isArray(targetCats) ||
      targetCats.length === 0 ||
      !targetCats.every((c) => typeof c === 'string' && c.trim().length > 0)
    ) {
      return reply.status(400).send({ ok: false, reason: 'targetCats 必须是非空字符串数组' })
    }
    const clientMessageId = body.clientMessageId
    if (clientMessageId !== undefined && typeof clientMessageId !== 'string') {
      return reply.status(400).send({ ok: false, reason: 'clientMessageId 必须是字符串' })
    }
    // triggerAuthorName 可选（OQ③ 补丁）：非字符串拒 400；缺失则按 undefined 处理
    const triggerAuthorName = body.triggerAuthorName
    if (triggerAuthorName !== undefined && typeof triggerAuthorName !== 'string') {
      return reply.status(400).send({ ok: false, reason: 'triggerAuthorName 必须是字符串' })
    }

    // ── 2. lookup activeStreams（404）──
    const stream = getActiveStream(agentId)
    if (!stream) {
      return reply
        .status(404)
        .send({ ok: false, reason: `agent ${agentId} 当前无活跃流，路由信号被拒` })
    }

    // ── 3. token 精确匹配（401）──
    const token = req.headers['x-signal-token']
    if (typeof token !== 'string' || token !== stream.token) {
      return reply.status(401).send({ ok: false, reason: 'x-signal-token 不匹配' })
    }

    // ── 4. 复合键 sessionId 匹配（409）──
    if (stream.sessionId !== sessionId) {
      return reply.status(409).send({
        ok: false,
        reason: `agent ${agentId} 正在会话 ${stream.sessionId} 执行，本信号会话 ${sessionId} 不匹配`,
      })
    }

    // ── 5. 目标预校验（422）——会话成员 + 角色白名单 ──
    const uniqueTargets = [...new Set(targetCats.map((c) => (c as string).trim()))]
    // 会话成员（id → row），与 socketio.ts 合并点同款反查
    const memberRows = sessionsRepo
      .getSessionAgentIds(sessionId)
      .map((id) => agentsRepo.getAgentById(id))
      .filter((r): r is NonNullable<typeof r> => !!r)
    const unknownNames = uniqueTargets.filter((name) => !memberRows.some((r) => r.name === name))
    if (unknownNames.length > 0) {
      return reply.status(422).send({
        ok: false,
        reason: `目标不在会话成员中: ${unknownNames.join('、')}（会话成员: ${
          memberRows.map((r) => r.name).join('、') || '（空）'
        }）`,
      })
    }
    const fromRow = agentsRepo.getAgentById(agentId)
    const targets = memberRows
      .filter((r) => uniqueTargets.includes(r.name))
      .map((r) => ({ name: r.name, role: r.role as AgentRole }))
    // triggerAuthorName 与 socketio.ts 合并点 :947 同款语义——reviewer 可 @ 回
    // 本次触发消息作者（OQ③ 补丁：缺失则仅按角色边表判定，既有行为零回归）
    const policy = filterAllowedMentions(
      {
        role: (fromRow?.role as AgentRole | undefined) ?? undefined,
        triggerAuthorName: (triggerAuthorName as string | undefined) ?? undefined,
      },
      targets
    )
    if (policy.blocked.length > 0) {
      const reasons = policy.blocked.map((b) => `${b.name}:${b.reason}`).join('、')
      return reply.status(422).send({
        ok: false,
        reason: `目标不在角色允许范围内（${reasons}）——请改投文本行首 @ 或调整目标`,
      })
    }

    // ── 6. 入 Map（200）──
    storeRouteSignal({
      sessionId,
      agentId,
      msgId,
      targetCats: policy.allowed.map((a) => a.name),
      clientMessageId,
    })
    log.info('route signal stored', {
      sessionId,
      agentId,
      msgId,
      targets: policy.allowed.map((a) => a.name),
    })
    return reply.send({ ok: true, reason: '信号已入队' })
  })
}
