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
 * POST /api/internal/create-pr（create_pr 工具，收口链发布关载体）：同款鉴权链
 * （400→404→401→409）+ 角色白名单（仅 store 角色可提 PR，403——防实施猫误发）
 * → 透传 createPr（git/create-pr.ts，前置校验 gh auth + 分支已 push）——
 * 业务失败四种原因（no-main-root/not-authed/branch-not-pushed/create-failed）
 * 422 返回不静默，error 透传命令 stderr 回模型可诊断。
 *
 * 失败一律 4xx + reason 字段——mcp-server.mjs 把 reason 拼进工具错误文本
 * 回模型（提示改行首 @ fallback）。
 */

import type { FastifyInstance } from 'fastify'
import { createLogger } from '../logger.js'
import {
  sessions as sessionsRepo,
  agents as agentsRepo,
  messages as messagesRepo,
  knowledge as knowledgeRepo,
  query as queryRepo,
} from '../db/repository/index.js'
import type { MessageRow } from '../db/repository/index.js'
import { QUERY_TABLE_SCHEMAS, type QueryOp } from '../db/repository/query.js'
import { getActiveStream } from '../connectors/socketio.js'
import { storeRouteSignal } from '../llm/route-signals.js'
import { storeUserRequestSignal } from '../llm/user-request-signals.js'
import {
  filterAllowedMentions,
  mentionLimitRemedy,
  MAX_MENTIONS_PER_REPLY,
} from '../dispatch/mention-policy.js'
import { embedText } from '../memory/embedding.js'
import { vectorToBlob } from '../memory/index.js'
import { toIsoDb } from '../db/repository/time.js'
import { createPr } from '../git/create-pr.js'
import { parseJsonArray, parseJsonValue, messageOf } from '../utils.js'
import type { AgentRole, StreamSegment, ToolCallInfo } from '@cat-study/shared'

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

interface CreatePrBody {
  sessionId?: unknown
  agentId?: unknown
  msgId?: unknown
  base?: unknown
  head?: unknown
  title?: unknown
  body?: unknown
}

interface SessionMessagesBody {
  sessionId?: unknown
  agentId?: unknown
  msgId?: unknown
  limit?: unknown
  before?: unknown
  from?: unknown
  to?: unknown
  kinds?: unknown
  agentIdFilter?: unknown
}

/** list_session_members 端点请求体：sessionId/agentId 必填（msgId 可选——纯日志用，
 *  无 store-by-messageId 语义，不进 400 校验）。 */
interface SessionMembersBody {
  sessionId?: unknown
  agentId?: unknown
  msgId?: unknown
}

/** 会话消息回读的块形状（内部端点返回，不上 shared——只被 mcp-server 消费，非 web 契约）。
 *  与 shared.StreamSegment 同构 + 消息级 images 挂在承载 body 的块上。 */
interface SessionMessageBlock {
  kind: 'text' | 'thinking' | 'tool'
  content: string
  tool?: ToolCallInfo
  images?: string[]
}

const QUERY_OPS = new Set<QueryOp>(['=', '>', '<', 'LIKE'])
const SEGMENT_KINDS = new Set(['text', 'thinking', 'tool'])

/** 消息行 → 结构化块数组（对应方案 3 C 兼容全砍决策）：
 *  segments 非空 → 按 segments 逐块映射（kind/content/tool）；
 *  segments 为 NULL → 只返回单 text 块（row.content），不去拼 thinking_content/tool_content
 *  旧块——「当前 shape 读」的自然退化。消息级 images（用户图）挂在首个 text 块（body 承载块）。 */
function buildMessageBlocks(
  row: MessageRow,
  images: string[],
  kinds?: Set<string>
): SessionMessageBlock[] {
  let blocks: SessionMessageBlock[]
  const segs = parseJsonValue<StreamSegment[]>(row.segments)
  if (segs && segs.length > 0) {
    blocks = segs.map((s) => {
      const b: SessionMessageBlock = { kind: s.kind, content: s.content ?? '' }
      if (s.kind === 'tool' && s.tool) b.tool = s.tool
      return b
    })
    if (images.length > 0) {
      const firstText = blocks.find((b) => b.kind === 'text')
      if (firstText) firstText.images = images
    }
  } else {
    blocks = [{ kind: 'text', content: row.content }]
    if (images.length > 0) blocks[0].images = images
  }
  return kinds ? blocks.filter((b) => kinds.has(b.kind)) : blocks
}

/** request_user_action 类型枚举——restart 已落地；choice 枚举就绪但渲染未落地（诚实拒绝，避免半吊子功能误导模型） */
const USER_REQUEST_TYPES = new Set(['restart', 'choice'] as const)

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
      // 422 串是**回给模型让它自我收敛的唯一输入**（票乙 P2，审查 ⚠️ on 0e5b2c4）。
      // count-limit 对 reviewer 是票乙才首次可达的 reason，而原串只有一句
      // 「目标不在角色允许范围内」——纯 count-limit 时那是**假话**（两个目标都在
      // 边表内，只是超上限），会把模型往「换目标」而不是「收敛到一个」上引。
      // 故按 reason 分句，两种原因各说各的、可同时出现（role-not-allowed 与
      // count-limit 同轮可达）。纯 role-not-allowed 时输出与旧串**逐字节恒等**，
      // 既有 1c 的契约面零漂移。
      const fmt = (bs: typeof policy.blocked) => bs.map((b) => `${b.name}:${b.reason}`).join('、')
      const roleBlocked = policy.blocked.filter((b) => b.reason === 'role-not-allowed')
      const countBlocked = policy.blocked.filter((b) => b.reason === 'count-limit')
      const parts: string[] = []
      if (roleBlocked.length > 0) {
        parts.push(`目标不在角色允许范围内（${fmt(roleBlocked)}）——请改投文本行首 @ 或调整目标`)
      }
      if (countBlocked.length > 0) {
        // 补救方向按角色分岔（票丙：原先此处对所有角色写死「请收敛到一个目标
        // 重投」）——文案单一维护面 = `mentionLimitRemedy`。本路径**首次**按角色
        // 分岔：reviewer 的目标由审查结论唯一决定，与文本路径给同一句指引。
        parts.push(
          `一条回复最多 @ ${MAX_MENTIONS_PER_REPLY} 个目标，${mentionLimitRemedy(
            (fromRow?.role as AgentRole | undefined) ?? undefined
          )}（${fmt(countBlocked)}）`
        )
      }
      return reply.status(422).send({ ok: false, reason: parts.join('；') })
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
    const embedded = await embedText(query.trim())
    if (!embedded.ok) {
      log.warn('knowledge search embedding unavailable', {
        reason: embedded.reason,
        sessionId,
        agentId,
        msgId,
      })
      return reply.send({ ok: true, results: [] })
    }
    const vector = embedded.vector
    if (vector.length === 0) {
      log.warn('knowledge search embedding empty', { sessionId, agentId, msgId })
      return reply.send({ ok: true, results: [] })
    }
    let rows
    try {
      rows = knowledgeRepo.searchKnowledgeByVector(vectorToBlob(vector), topK)
    } catch (err: any) {
      const detail = messageOf(err) ?? '未知错误'
      log.error('knowledge search failed', { error: detail, sessionId, agentId, msgId })
      return reply.status(500).send({ ok: false, reason: `知识库检索异常: ${detail}` })
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
      const detail = messageOf(err) ?? '未知错误'
      log.error('db query failed', { error: detail, sessionId, agentId, msgId, table })
      return reply.status(500).send({ ok: false, reason: `数据库查询异常: ${detail}` })
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
    if (typeof type !== 'string' || !USER_REQUEST_TYPES.has(type as 'restart' | 'choice')) {
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

    // ── 6. 入 Map（200）── 角色白名单已在上一步拦截（restart 系 store 专属）
    storeUserRequestSignal({
      sessionId,
      agentId,
      msgId,
      type: type as 'restart',
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

  app.post('/api/internal/create-pr', async (req, reply) => {
    const body = (req.body ?? {}) as CreatePrBody

    // ── 1. body 基本校验（400）── 与 user-request 同款：防御纵深（mcp-server.mjs 已做参数校验）
    const { sessionId, agentId, msgId, head, title, body: prBody } = body
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
    if (typeof head !== 'string' || !head.trim()) {
      return reply.status(400).send({ ok: false, reason: 'head 必须是非空字符串' })
    }
    if (typeof title !== 'string' || !title.trim()) {
      return reply.status(400).send({ ok: false, reason: 'title 必须是非空字符串' })
    }
    if (typeof prBody !== 'string' || !prBody.trim()) {
      return reply.status(400).send({ ok: false, reason: 'body 必须是非空字符串' })
    }
    const base = body.base
    if (base !== undefined && (typeof base !== 'string' || !base.trim())) {
      return reply.status(400).send({ ok: false, reason: 'base 必须是字符串' })
    }

    // ── 2. lookup activeStreams（404）──
    const stream = getActiveStream(agentId)
    if (!stream) {
      return reply
        .status(404)
        .send({ ok: false, reason: `agent ${agentId} 当前无活跃流，创建 PR 被拒` })
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

    // ── 5. 角色白名单（403）——提 PR 是店长收口权限，防实施猫误发 PR。
    // 与 user-request 同款 fail-closed（未知/缺失角色不放行）——
    // 这里是「往 GitHub 发 PR」的对外动作，误发代价远大于漏拦
    const fromRow = agentsRepo.getAgentById(agentId)
    if (fromRow?.role !== 'store') {
      return reply.status(403).send({
        ok: false,
        reason: `仅店长（role=store）可创建 PR（当前 agent ${agentId} role=${fromRow?.role ?? 'unknown'}）`,
      })
    }

    // ── 6. 执行 createPr（业务失败 422 不静默——四种原因透传）──
    const result = await createPr({
      base: base?.trim() || undefined,
      head: head.trim(),
      title: title.trim(),
      body: prBody.trim(),
    })
    if (!result.ok) {
      log.warn('PR create failed via internal endpoint', {
        sessionId,
        agentId,
        msgId,
        reason: result.reason,
        error: result.error,
      })
      return reply.status(422).send({
        ok: false,
        reason: `PR 创建失败（${result.reason}）：${result.error}`,
        error: result.error,
      })
    }
    log.info('PR created via internal endpoint', {
      sessionId,
      agentId,
      msgId,
      number: result.number,
      url: result.url,
    })
    return reply.send({ ok: true, number: result.number, url: result.url })
  })

  app.post('/api/internal/session-messages', async (req, reply) => {
    const body = (req.body ?? {}) as SessionMessagesBody

    // ── 1. body 基本校验（400）── 与 route-signals 同款：防御纵深（mcp-server.mjs 已做参数校验）
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
    const limit = body.limit ?? 20
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      return reply.status(400).send({ ok: false, reason: 'limit 必须是 1-100 整数' })
    }
    // 可选窗口/过滤参数校验（before/from/to/agentIdFilter 非空字符串；kinds 非空子集）
    const before = body.before
    if (before !== undefined && (typeof before !== 'string' || !before.trim())) {
      return reply
        .status(400)
        .send({ ok: false, reason: 'before 必须是非空字符串（消息 id 游标）' })
    }
    const from = body.from
    if (from !== undefined && (typeof from !== 'string' || !from.trim())) {
      return reply
        .status(400)
        .send({ ok: false, reason: 'from 必须是非空字符串（created_at 下界）' })
    }
    const to = body.to
    if (to !== undefined && (typeof to !== 'string' || !to.trim())) {
      return reply.status(400).send({ ok: false, reason: 'to 必须是非空字符串（created_at 上界）' })
    }
    const agentIdFilter = body.agentIdFilter
    if (
      agentIdFilter !== undefined &&
      (typeof agentIdFilter !== 'string' || !agentIdFilter.trim())
    ) {
      return reply
        .status(400)
        .send({ ok: false, reason: 'agentIdFilter 必须是非空字符串（agent id）' })
    }
    const kindsRaw = body.kinds
    let kinds: Set<string> | undefined
    if (kindsRaw !== undefined) {
      if (
        !Array.isArray(kindsRaw) ||
        kindsRaw.length === 0 ||
        !kindsRaw.every((k) => typeof k === 'string' && SEGMENT_KINDS.has(k))
      ) {
        return reply.status(400).send({
          ok: false,
          reason: `kinds 必须是非空数组且每项 ∈ ${[...SEGMENT_KINDS].join('/')}`,
        })
      }
      kinds = new Set(kindsRaw as string[])
    }

    // ── 2. lookup activeStreams（404）──
    const stream = getActiveStream(agentId)
    if (!stream) {
      return reply
        .status(404)
        .send({ ok: false, reason: `agent ${agentId} 当前无活跃流，会话消息回读被拒` })
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

    // ── 5. 回读（200）——通用能力，无角色白名单（历史回读不限角色，不加 403）。
    // A 地基共用：调 getSessionMessagesRange（同一读层查询函数），agentName 单独
    // JOIN agents 批量补名（行内无 agent 名列）。before 消息缺失 → 空批次自然停翻。
    const rows = messagesRepo.getSessionMessagesRange(sessionId, {
      limit,
      before: before ?? undefined,
      from: from ?? undefined,
      to: to ?? undefined,
      agentId: agentIdFilter ?? undefined,
    })
    // 批量补 agent 名（去重查一次；缺失 agent（悬空 FK）→ null）
    const agentIds = [...new Set(rows.map((r) => r.agent_id).filter((x): x is string => !!x))]
    const nameById = new Map(
      (agentIds.length > 0 ? agentsRepo.listAgentsByIds(agentIds) : []).map((a) => [a.id, a.name])
    )
    const messages = rows
      .map((r) => {
        const images = parseJsonArray(r.images)
        const blocks = buildMessageBlocks(r, images, kinds)
        return {
          messageId: r.id,
          role: r.role,
          agentId: r.agent_id || null,
          agentName: r.agent_id ? (nameById.get(r.agent_id) ?? null) : null,
          createdAt: toIsoDb(r.created_at),
          blocks,
        }
      })
      .filter((m) => (kinds ? m.blocks.length > 0 : true))
    const total = messages.length
    log.info('session messages read', {
      sessionId,
      agentId,
      msgId,
      limit,
      before: before ?? undefined,
      from: from ?? undefined,
      to: to ?? undefined,
      agentIdFilter: agentIdFilter ?? undefined,
      kinds: kinds ? [...kinds] : undefined,
      rows: rows.length,
      messages: total,
    })
    return reply.send({ ok: true, messages, total })
  })

  app.post('/api/internal/session-members', async (req, reply) => {
    const body = (req.body ?? {}) as SessionMembersBody

    // ── 1. body 基本校验（400）── 与 session-messages 同款：防御纵深（mcp-server.mjs 已做形状兜底）
    const { sessionId, agentId } = body
    if (typeof sessionId !== 'string' || !sessionId || typeof agentId !== 'string' || !agentId) {
      return reply.status(400).send({ ok: false, reason: 'sessionId/agentId 必填非空字符串' })
    }
    const msgId = body.msgId

    // ── 2. lookup activeStreams（404）──
    const stream = getActiveStream(agentId)
    if (!stream) {
      return reply
        .status(404)
        .send({ ok: false, reason: `agent ${agentId} 当前无活跃流，会话成员查询被拒` })
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

    // ── 5. 成员解析（200）——通用能力，无角色白名单（成员查询不限角色，不加 403）。
    // session agent_ids JSON 数组顺序 = 注册序；listAgentsByIds 的 IN 子句不保证顺序，
    // 用 id→row Map 按 ids 顺序回查投影（参照 session-messages :743 批量补名手法）——
    // 悬空 agent（session 引用已删成员）补 name/role null，不丢、不崩。
    const memberIds = sessionsRepo.getSessionAgentIds(sessionId)
    const rowById = new Map(
      (memberIds.length > 0 ? agentsRepo.listAgentsByIds(memberIds) : []).map((a) => [a.id, a])
    )
    const members = memberIds.map((id) => {
      const row = rowById.get(id)
      return { agentId: id, name: row?.name ?? null, role: row?.role ?? null }
    })
    log.info('session members read', {
      sessionId,
      agentId,
      msgId: typeof msgId === 'string' && msgId ? msgId : undefined,
      members: members.length,
    })
    return reply.send({ ok: true, members })
  })
}
