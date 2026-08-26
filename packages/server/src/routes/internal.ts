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
 * POST /api/internal/user-request（request_user_action 工具，重启请求稳定触发
 * Phase 1）：同款五步鉴权链（400→404→401→409）+ 角色白名单（仅 store 角色
 * 可发，403）→ storeUserRequestSignal 入 Map——socketio.ts runAgentReply 完成
 * 点消费，与 isRestartRequestContent 文本检测取并集（结构化主路径 + 文本 fallback）。
 *
 * 失败一律 4xx + reason 字段——mcp-server.mjs 把 reason 拼进工具错误文本
 * 回模型（提示改行首 @ fallback）。
 */

import type { FastifyInstance } from 'fastify'
import { createLogger } from '../logger.js'
import {
  sessions as sessionsRepo,
  agents as agentsRepo,
  knowledge as knowledgeRepo,
  query as queryRepo,
} from '../db/repository/index.js'
import { QUERY_TABLE_SCHEMAS, type QueryOp } from '../db/repository/query.js'
import { getActiveStream } from '../connectors/socketio.js'
import { storeRouteSignal } from '../llm/route-signals.js'
import { storeUserRequestSignal } from '../llm/user-request-signals.js'
import { filterAllowedMentions } from '../dispatch/mention-policy.js'
import { embedText } from '../memory/embedding.js'
import { vectorToBlob } from '../memory/index.js'
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

interface KnowledgeSearchBody {
  sessionId?: unknown
  agentId?: unknown
  msgId?: unknown
  query?: unknown
  topK?: unknown
}

interface DbQueryBody {
  sessionId?: unknown
  agentId?: unknown
  msgId?: unknown
  table?: unknown
  conditions?: unknown
  limit?: unknown
}

interface UserRequestBody {
  sessionId?: unknown
  agentId?: unknown
  msgId?: unknown
  type?: unknown
  reason?: unknown
  options?: unknown
}

const QUERY_OPS = new Set<QueryOp>(['=', '>', '<', 'LIKE'])

/** request_user_action 类型枚举——restart/push 已落地；choice 枚举就绪但渲染未落地（诚实拒绝，避免半吊子功能误导模型） */
const USER_REQUEST_TYPES = new Set(['restart', 'push', 'choice'] as const)

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

  app.post('/api/internal/knowledge-search', async (req, reply) => {
    const body = (req.body ?? {}) as KnowledgeSearchBody

    // ── 1. body 基本校验（400）── 与 route-signals 同款：防御纵深（mcp-server.mjs 已做参数校验）
    const { sessionId, agentId, msgId, query } = body
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
    if (typeof query !== 'string' || !query.trim()) {
      return reply.status(400).send({ ok: false, reason: 'query 必须是非空字符串' })
    }
    const topK = body.topK ?? 3
    if (typeof topK !== 'number' || !Number.isInteger(topK) || topK < 1 || topK > 10) {
      return reply.status(400).send({ ok: false, reason: 'topK 必须是 1-10 整数' })
    }

    // ── 2. lookup activeStreams（404）──
    const stream = getActiveStream(agentId)
    if (!stream) {
      return reply
        .status(404)
        .send({ ok: false, reason: `agent ${agentId} 当前无活跃流，知识库检索被拒` })
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
        reason: `agent ${agentId} 正在会话 ${stream.sessionId} 执行，本请求会话 ${sessionId} 不匹配`,
      })
    }

    // ── 5. 知识库检索（200）——无「目标猫」语义，跳过目标预校验 ──
    // 单向量通道：query 原样嵌入（结构化 query 无口语歧义，不改写双通道）；
    // 嵌入失败降级空结果（与 buildKnowledgeContext 同款，不阻塞）
    let vector: number[]
    try {
      vector = await embedText(query.trim())
    } catch (err: any) {
      log.warn('knowledge search embedding failed', {
        error: err.message,
        sessionId,
        agentId,
        msgId,
      })
      return reply.send({ ok: true, results: [] })
    }
    if (vector.length === 0) {
      log.warn('knowledge search embedding empty', { sessionId, agentId, msgId })
      return reply.send({ ok: true, results: [] })
    }
    let rows
    try {
      rows = knowledgeRepo.searchKnowledgeByVector(vectorToBlob(vector), topK)
    } catch (err: any) {
      log.error('knowledge search failed', { error: err.message, sessionId, agentId, msgId })
      return reply.status(500).send({ ok: false, reason: `知识库检索异常: ${err.message}` })
    }
    const results = rows.map((r) => ({
      id: r.id,
      content: r.content,
      source: r.source,
      distance: r.distance,
    }))
    log.info('knowledge search', {
      sessionId,
      agentId,
      msgId,
      query: query.trim(),
      topK,
      hits: results.length,
    })
    return reply.send({ ok: true, results })
  })

  app.post('/api/internal/db-query', async (req, reply) => {
    const body = (req.body ?? {}) as DbQueryBody

    // ── 1. body 基本校验（400）── 与 knowledge-search 同款：防御纵深
    //（mcp-server.mjs 已做参数校验）；表/列白名单以服务端 QUERY_TABLE_SCHEMAS 为权威
    const { sessionId, agentId, msgId, table } = body
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
    if (typeof table !== 'string' || !(table in QUERY_TABLE_SCHEMAS)) {
      return reply.status(400).send({
        ok: false,
        reason: `table 必须是白名单表（${Object.keys(QUERY_TABLE_SCHEMAS).join('/')}）`,
      })
    }
    const schema = QUERY_TABLE_SCHEMAS[table as keyof typeof QUERY_TABLE_SCHEMAS]
    const conditions = body.conditions ?? []
    if (!Array.isArray(conditions)) {
      return reply.status(400).send({ ok: false, reason: 'conditions 必须是数组' })
    }
    for (const c of conditions) {
      if (
        typeof c !== 'object' ||
        c === null ||
        typeof c.column !== 'string' ||
        !c.column ||
        !schema.columns.includes(c.column)
      ) {
        return reply.status(400).send({
          ok: false,
          reason: `conditions 每项 column 必须 ∈ 该表可查列（${schema.columns.join('/')}）`,
        })
      }
      if (typeof c.op !== 'string' || !QUERY_OPS.has(c.op as QueryOp)) {
        return reply.status(400).send({ ok: false, reason: 'conditions 每项 op 必须是 =/>/</LIKE' })
      }
      if (typeof c.value !== 'string') {
        return reply.status(400).send({ ok: false, reason: 'conditions 每项 value 必须是字符串' })
      }
    }
    const limit = body.limit ?? 50
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      return reply.status(400).send({ ok: false, reason: 'limit 必须是 1-100 整数' })
    }

    // ── 2. lookup activeStreams（404）──
    const stream = getActiveStream(agentId)
    if (!stream) {
      return reply
        .status(404)
        .send({ ok: false, reason: `agent ${agentId} 当前无活跃流，数据库查询被拒` })
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
        reason: `agent ${agentId} 正在会话 ${stream.sessionId} 执行，本请求会话 ${sessionId} 不匹配`,
      })
    }

    // ── 5. 白名单参数化查询（200）——queryTable 内部仍是安全执行点 ──
    let result
    try {
      // table 已过 `in QUERY_TABLE_SCHEMAS` 校验——窄化回字面量联合类型
      result = queryRepo.queryTable({
        table: table as keyof typeof QUERY_TABLE_SCHEMAS,
        conditions,
        limit,
      })
    } catch (err: any) {
      // 端点已校验过白名单——此处只兜绕过校验的直调（不应发生）
      log.error('db query failed', { error: err.message, sessionId, agentId, msgId, table })
      return reply.status(500).send({ ok: false, reason: `数据库查询异常: ${err.message}` })
    }
    log.info('db query', {
      sessionId,
      agentId,
      msgId,
      table,
      conditions: conditions.length,
      limit,
      hits: result.rows.length,
      total: result.total,
    })
    return reply.send({ ok: true, rows: result.rows, total: result.total })
  })

  app.post('/api/internal/user-request', async (req, reply) => {
    const body = (req.body ?? {}) as UserRequestBody

    // ── 1. body 基本校验（400）── 与 route-signals 同款：防御纵深（mcp-server.mjs 已做参数校验）
    const { sessionId, agentId, msgId, type } = body
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
    if (
      typeof type !== 'string' ||
      !USER_REQUEST_TYPES.has(type as 'restart' | 'push' | 'choice')
    ) {
      return reply
        .status(400)
        .send({ ok: false, reason: `type 必须是 ${[...USER_REQUEST_TYPES].join('/')} 之一` })
    }
    // choice 枚举就绪但渲染/回灌未落地——诚实拒绝（管道结构已就绪，加渲染即通）
    if (type === 'choice') {
      return reply
        .status(400)
        .send({ ok: false, reason: '该类型暂不支持（choice 渲染待后续版本）' })
    }
    const reason = body.reason
    if (typeof reason !== 'string' || !reason.trim()) {
      return reply.status(400).send({ ok: false, reason: 'reason 必须是非空字符串' })
    }
    // options 仅 choice 用（restart 忽略）——形状校验保留，防非法结构入信号
    const options = body.options ?? []
    if (!Array.isArray(options)) {
      return reply.status(400).send({ ok: false, reason: 'options 必须是数组' })
    }
    for (const o of options) {
      if (
        typeof o !== 'object' ||
        o === null ||
        typeof o.id !== 'string' ||
        !o.id ||
        typeof o.label !== 'string' ||
        !o.label
      ) {
        return reply
          .status(400)
          .send({ ok: false, reason: 'options 每项须 { id, label } 非空字符串' })
      }
    }

    // ── 2. lookup activeStreams（404）──
    const stream = getActiveStream(agentId)
    if (!stream) {
      return reply
        .status(404)
        .send({ ok: false, reason: `agent ${agentId} 当前无活跃流，用户请求被拒` })
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
        reason: `agent ${agentId} 正在会话 ${stream.sessionId} 执行，本请求会话 ${sessionId} 不匹配`,
      })
    }

    // ── 5. 角色白名单（403）——重启请求是店长权限，防实施猫误发按钮噪音 ──
    // 注意：AgentRole 类型无 'architect'——架构师角色在库中即 'store'（seed-data.ts
    // 店长 role: 'store'）；未知/缺失角色 fail-closed（误发噪音代价小、漏拦代价大，
    // 与 mention-policy 的 fail-open 取向相反——那是 A2A 生命线，这里是用户交互噪音）
    const fromRow = agentsRepo.getAgentById(agentId)
    if (fromRow?.role !== 'store') {
      return reply.status(403).send({
        ok: false,
        reason: `仅店长（role=store）可发起用户请求（当前 agent ${agentId} role=${fromRow?.role ?? 'unknown'}）`,
      })
    }

    // ── 6. 入 Map（200）── 角色白名单已在上一步拦截（restart/push 均 store 专属）
    storeUserRequestSignal({
      sessionId,
      agentId,
      msgId,
      type: type as 'restart' | 'push',
      reason: reason.trim(),
    })
    log.info('user request signal stored', {
      sessionId,
      agentId,
      msgId,
      type,
      reason: reason.trim(),
    })
    return reply.send({ ok: true, reason: '用户请求已入队' })
  })
}
