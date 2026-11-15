import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import {
  SessionCreateSchema,
  SessionUpdateSchema,
  SessionRollbackSchema,
  Events,
  type SessionConfig,
  type ToolCallInfo,
  type StreamSegment,
} from '@cat-study/shared'
import {
  sessions as sessionsRepo,
  sessionGroups as sessionGroupsRepo,
  agents as agentsRepo,
  messages as messagesRepo,
  messageSearch as messageSearchRepo,
  executionLogs as execLogsRepo,
  sessionReadState as readStateRepo,
  trash as trashRepo,
} from '../db/repository/index.js'
import type { MessageRow, SessionRow } from '../db/repository/index.js'
import { normalizeIsoMs } from '../db/repository/clock.js'
import { getIO } from '../connectors/socketio.js'
import { emitGroupsChanged } from './sessionGroups.js'
import { blockerError, getSessionBlocker } from './trash-guard.js'
import { toSessionConfig } from './session-config.js'
import { toIsoDb } from '../db/repository/time.js'
import { getExecutionEngine } from '../execution/registry.js'
import { createLogger } from '../logger.js'
import { parseJsonArray, parseJsonValue } from '../utils.js'

const log = createLogger('sessions')

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  // ─── POST /api/sessions — 创建会话 ──────────────────

  app.post('/api/sessions', async (req, reply) => {
    const parsed = SessionCreateSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const { title, agentIds } = parsed.data

    // 验证 Agent 是否存在
    const existingIds = agentsRepo.checkAgentIdsExist(agentIds)
    if (existingIds.length !== agentIds.length) {
      return reply.status(400).send({
        error: 'Some agent IDs are invalid',
      })
    }

    const id = uuid()
    sessionsRepo.insertSession(id, title, agentIds)

    const row = sessionsRepo.getSessionById(id)
    return reply.status(201).send(toSessionConfig(row!))
  })

  // ─── GET /api/sessions — 列出会话（未删除；归档不再过滤）───
  //
  // 票 7 的「默认过滤已归档」已退役（ADR 0016）：收纳由分组折叠承担，归档不影响列表。
  // `includeArchived` 作为兼容参数被接受但**不再改变「归档是否可见」**——两种取值都
  // 排除回收站（`deleted_at IS NOT NULL`），区别只是取数函数的名字：默认走
  // `listActiveSessions()`，显式传参走 `listAllSessionsExcludingDeleted()`。参数本身
  // 留到归档面清退票（T5）再删；T2 起两条路径都不能漏出回收站会话（spec §4.3，验收 18）。
  app.get('/api/sessions', async (req) => {
    const hasIncludeArchived =
      (req.query as Record<string, unknown> | undefined)?.includeArchived !== undefined
    const rows = hasIncludeArchived
      ? sessionsRepo.listAllSessionsExcludingDeleted()
      : sessionsRepo.listActiveSessions()
    // 最后消息时间：一次 GROUP BY 批量取，不逐会话查（T6 契约）
    const lastMessageAt = messagesRepo.getLastMessageAtBySessionIds(rows.map((row) => row.id))
    return rows.map((row) => {
      const session = toSessionConfig(row)
      // Compute unread count: messages created after last_read_at
      const lastRead = readStateRepo.getLastReadAt(row.id) || row.created_at
      session.unreadCount = messagesRepo.countMessagesAfter(row.id, lastRead)
      session.lastMessageAt = lastMessageAt.get(row.id) ?? null
      return session
    })
  })

  // ─── GET /api/sessions/trash — 回收站条目（未过期）──────────
  //
  // **必须注册在 GET /api/sessions/:id 之前**（spec §3.2 路由顺序契约）：静态段优先是
  // 现在的路由器行为，但显式顺序才是契约——换路由库时 `:id='trash'` 不会把它吞掉。
  app.get('/api/sessions/trash', async () => ({ entries: trashRepo.listTrash() }))

  // ─── GET /api/sessions/:id — 获取会话详情 ───────────

  app.get('/api/sessions/:id', async (req, reply) => {
    const row = sessionsRepo.getSessionById((req.params as any).id)
    if (!row) return reply.status(404).send({ error: 'Session not found' })

    // 附带 Agent 详情
    const agentIds: string[] = JSON.parse(row.agent_ids || '[]')
    const agents = agentIds.length > 0 ? agentsRepo.listAgentsByIds(agentIds) : []

    return {
      ...toSessionConfig(row),
      agents: agents.map((a) => ({
        id: a.id,
        name: a.name,
        avatar: a.avatar,
      })),
    }
  })

  // ─── PATCH /api/sessions/:id — 更新会话 ──────────────

  app.patch('/api/sessions/:id', async (req, reply) => {
    const id = (req.params as any).id
    const row = sessionsRepo.getSessionById(id)
    if (!row) return reply.status(404).send({ error: 'Session not found' })

    const parsed = SessionUpdateSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const { title, addAgentIds, removeAgentIds, broadcastMode, groupId } = parsed.data

    // ── 先校验完再写 ──────────────────────────────────────────────
    // 任一 400 都不该留下半截更新：四个动作（改名 / 广播 / 归组 / 成员）现在统一走
    // 「校验 → 写入」两段，避免「先改了标题、后面成员校验失败」这种部分生效。
    // 移动到分组（`groupId=null` = 回未分组）的组必须存在且未删；不做「静默落未分组」——
    // 前端传了一个不存在的组 id 是 bug，静默吞掉会让它以为成功。
    if (groupId !== undefined && groupId !== null && !sessionGroupsRepo.getGroupById(groupId)) {
      return reply.status(400).send({ error: 'GROUP_NOT_FOUND' })
    }

    let nextAgentIds: string[] | undefined
    if (addAgentIds?.length || removeAgentIds?.length) {
      const currentIds: string[] = JSON.parse(row.agent_ids || '[]')

      // 验证要添加的 Agent 是否存在
      if (addAgentIds?.length) {
        const existing = agentsRepo.checkAgentIdsExist(addAgentIds)
        if (existing.length !== addAgentIds.length) {
          return reply.status(400).send({ error: 'Some agent IDs are invalid' })
        }
      }

      const removeSet = new Set(removeAgentIds || [])
      nextAgentIds = currentIds
        .filter((aid) => !removeSet.has(aid))
        .concat(addAgentIds || [])
        // 去重
        .filter((aid, i, arr) => arr.indexOf(aid) === i)

      if (nextAgentIds.length === 0) {
        return reply.status(400).send({ error: '会话至少需要一只猫咪' })
      }
    }

    // ── 写入 ──────────────────────────────────────────────────────
    // 支持重命名
    if (title !== undefined) {
      sessionsRepo.updateSessionTitle(id, title)
    }

    // 支持切换广播模式
    if (broadcastMode !== undefined) {
      sessionsRepo.updateSessionBroadcastMode(id, broadcastMode)
    }

    // 移动到分组（不动 `updated_at`：分组是组织动作，不是会话活跃）。
    // `groupChanged` 只在**归属真的变了**时为真：同值 PATCH（前端重放/双击）不该广播，
    // 否则每次无关更新都让所有 tab 重拉一遍组列表。
    const currentGroupId = row.group_id ?? null
    const groupChanged = groupId !== undefined && (groupId ?? null) !== currentGroupId
    if (groupId !== undefined) {
      sessionsRepo.updateSessionGroup(id, groupId)
    }

    // 支持增加/移除 Agent
    if (nextAgentIds !== undefined) {
      sessionsRepo.updateSessionAgentIds(id, JSON.stringify(nextAgentIds))
    }

    // emit 通知前端
    const updated = sessionsRepo.getSessionById(id)
    const config = toSessionConfig(updated!)
    try {
      getIO()?.to(`session:${id}`).emit(Events.SESSION_UPDATE, config)
    } catch {
      /* emit 失败不影响响应 */
    }
    // 组归属变化是**全局**结构变化（左栏所有 tab 都要重拉组列表）；与 SESSION_UPDATE
    // 的会话房间广播不是一回事，两者都发、互不替代。
    if (groupChanged) emitGroupsChanged()
    return config
  })

  // ─── POST /api/sessions/:id/archive — 归档 ──────────
  // 用户态「删除」的替代形态：数据全留（会话 / 消息 / 成员照常可查），只从默认列表隐藏。

  app.post('/api/sessions/:id/archive', async (req, reply) => {
    const id = (req.params as any).id
    if (!sessionsRepo.getSessionById(id)) {
      return reply.status(404).send({ error: 'Session not found' })
    }

    sessionsRepo.archiveSession(id)
    return reply.send(emitArchived(id))
  })

  // ─── POST /api/sessions/:id/unarchive — 取消归档 ────

  app.post('/api/sessions/:id/unarchive', async (req, reply) => {
    const id = (req.params as any).id
    if (!sessionsRepo.getSessionById(id)) {
      return reply.status(404).send({ error: 'Session not found' })
    }

    sessionsRepo.unarchiveSession(id)
    return reply.send(emitArchived(id))
  })

  // ─── DELETE /api/sessions/:id/messages — 清空消息 ────

  app.delete('/api/sessions/:id/messages', async (req, reply) => {
    const id = (req.params as any).id

    if (!sessionsRepo.getSessionById(id)) {
      return reply.status(404).send({ error: 'Session not found' })
    }

    // 按外键依赖顺序删除
    const elogResult = execLogsRepo.deleteExecutionLogsBySession(id)
    const msgResult = messagesRepo.deleteMessagesBySession(id)

    // 更新会话时间戳
    sessionsRepo.updateSessionTimestamp(id)

    // 通知所有已连接的客户端（支持多 tab 同步）
    const io = getIO()
    if (io) {
      io.emit(Events.SESSION_MESSAGES_CLEARED, { sessionId: id })
    }

    log.info('session messages cleared', {
      sessionId: id,
      messagesRemoved: msgResult.changes,
      executionLogsRemoved: elogResult.changes,
    })

    return {
      ok: true,
      messagesRemoved: msgResult.changes,
      executionLogsRemoved: elogResult.changes,
    }
  })

  // ─── POST /api/sessions/:id/rollback — 同会话回退（T1）──
  //
  // 语义：删掉目标消息**之后**的全部消息，会话从该节点继续（目标本身保留）。
  // 与「撤回」的分工：撤回是「这条我发错了」（只允许最新一条用户消息，且连带回滚文件与
  // 依赖包）；回退是「从某个节点重来」（任意消息、只动消息与执行记录，**不碰工作区**）。
  // 两者混用会让「回退到十轮前」顺带 `git reset --hard` 掉之后所有工作——故回退不做
  // git/npm 回滚，这是有意的边界，不是漏实现。
  //
  // 顺序硬约束：**先停后删**。正在跑/排队的命令持有即将被删的触发消息，先删会让 run 收尾
  // 往已删的触发消息上写回复（或落出孤儿 execution_logs）。

  app.post('/api/sessions/:id/rollback', async (req, reply) => {
    const id = (req.params as any).id

    if (!sessionsRepo.getSessionById(id)) {
      return reply.status(404).send({ error: 'Session not found' })
    }

    const parsed = SessionRollbackSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }
    const { messageId } = parsed.data

    // 目标必须是**落库**的消息。会话欢迎消息（`welcome-<sessionId>`）是 SESSION_HISTORY 的
    // 合成字段、从不落库，故在这里落到 404——这正是票面要的 4xx，且「库里查不到」与
    // 「不是可回退的目标」在这个判据下是同一件事，不必再按 id 前缀特判（那会把 `welcome-`
    // 字面量复制到第二处，正是本仓反复吃过的「同一规则两处措辞」）。
    const target = messagesRepo.getMessageInSession(messageId, id)
    if (!target) {
      return reply.status(404).send({ error: 'Message not found in session' })
    }

    // 删除集只算一次：先停（要它）、后删（要它）——定序判据单源在 getMessageIdsAfter
    const doomed = messagesRepo.getMessageIdsAfter(id, messageId)

    const engine = getExecutionEngine()
    const stoppedAgents: string[] = []
    if (engine) {
      const doomedSet = new Set(doomed)
      for (const slot of engine.snapshot()) {
        if (slot.sessionId !== id) continue
        const trigger = slot.currentTriggerMessageId
        if (trigger && doomedSet.has(trigger) && engine.abortAgent(slot.agentId, id)) {
          stoppedAgents.push(slot.agentId)
        }
      }
      for (const mid of doomed) engine.cancelQueuedCommand(mid)
    }

    const result = messagesRepo.deleteMessagesByIds(doomed)

    sessionsRepo.updateSessionTimestamp(id)

    // 广播给**会话房间**（不是全局）：回退只影响待在该会话里的客户端。payload 带权威
    // `removedIds`，前端按 id 删——不自己按时间戳重算删除集（两处各算一次必然分叉）。
    // try 包住：删除已提交，广播只是让别的端同步；发不出去不该把成功的回退变成 500
    // （与本文件 PATCH 的房间广播同款护栏）。
    try {
      getIO()?.to(`session:${id}`).emit(Events.SESSION_ROLLED_BACK, {
        sessionId: id,
        messageId,
        removedIds: doomed,
        removedCount: result.changes,
      })
    } catch {
      /* emit 失败不影响响应 */
    }

    log.info('session rolled back', {
      sessionId: id,
      messageId,
      removedCount: result.changes,
      stoppedAgents: stoppedAgents.length,
    })

    return { ok: true, messageId, removedIds: doomed, removedCount: result.changes }
  })

  // ─── GET /api/sessions/:id/messages — 获取消息列表 ──
  // 方案 3 A 读层端点：limit/before（messageId 游标）/from/to（created_at 时间窗）——
  // 无参数时行为与既有 getRecentMessages(id, 200) 一致（role != system 口径不变）。

  app.get('/api/sessions/:id/messages', async (req, reply) => {
    const id = (req.params as any).id

    if (!sessionsRepo.getSessionById(id)) {
      return reply.status(404).send({ error: 'Session not found' })
    }

    const q = (req.query as any) ?? {}
    const limit = Math.min(Math.max(parseInt(q?.limit || '200', 10) || 200, 1), 1000)

    // 可选窗口参数校验：before = 消息 id 游标；from/to = created_at 时间窗（ISO/DB 秒级串）
    const before = q?.before
    if (before !== undefined && (typeof before !== 'string' || !before.trim())) {
      return reply.status(400).send({ error: 'before 必须是非空字符串（消息 id 游标）' })
    }
    const from = q?.from
    if (from !== undefined && (typeof from !== 'string' || !from.trim())) {
      return reply.status(400).send({ error: 'from 必须是非空字符串（created_at 下界）' })
    }
    const to = q?.to
    if (to !== undefined && (typeof to !== 'string' || !to.trim())) {
      return reply.status(400).send({ error: 'to 必须是非空字符串（created_at 上界）' })
    }

    const rows = messagesRepo.getSessionMessagesRange(id, {
      limit,
      before: before ?? undefined,
      from: from ?? undefined,
      to: to ?? undefined,
    })

    return rows.map(toMessageDto)
  })

  // ─── GET /api/sessions/:id/messages/browse — 历史面板默认列表 ──
  //
  // 右栏历史面板**无搜索词**时的取数口。与 `/messages` 的关键差异：本端点**含 system**
  // （人看的历史视图是全貌，运维通告也在历史里），且额外返回 `total`——面板的日期条
  // 计数来自 facets（同样含 system），两处必须同一口径，否则「日期条写 1 条、点进去空」。
  // 分页/时间窗语义与 `/search` 逐字一致；行投影复用 `toMessageDto`。

  app.get('/api/sessions/:id/messages/browse', async (req, reply) => {
    const id = (req.params as any).id

    if (!sessionsRepo.getSessionById(id)) {
      return reply.status(404).send({ error: 'Session not found' })
    }

    const q = (req.query as any) ?? {}
    const parsedLimit = parseInt(q.limit ?? '', 10)
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 100) : 50

    const before = q.before
    if (before !== undefined && (typeof before !== 'string' || !before.trim())) {
      return reply.status(400).send({ error: 'before 必须是非空字符串（消息 id 游标）' })
    }
    const from = q.from
    if (from !== undefined && (typeof from !== 'string' || !from.trim())) {
      return reply.status(400).send({ error: 'from 必须是非空字符串（created_at 下界）' })
    }
    const to = q.to
    if (to !== undefined && (typeof to !== 'string' || !to.trim())) {
      return reply.status(400).send({ error: 'to 必须是非空字符串（created_at 上界）' })
    }

    const result = messageSearchRepo.listSessionMessages(id, {
      limit,
      before: before ?? undefined,
      from: from ?? undefined,
      to: to ?? undefined,
    })

    return { rows: result.rows.map(toMessageDto), total: result.total }
  })

  // ─── GET /api/sessions/:id/messages/facets — 历史面板日期索引 ──
  //
  // 右栏历史面板的日期条：哪些天/月有消息、各多少条。**按 `tzOffset` 换算后分组**，
  // 不是截 UTC 日期——否则东八区的晚间消息会错落到前一天（静默错位）。
  // `total` 含 system：这是给人看的历史视图，运维通告也在历史里。

  app.get('/api/sessions/:id/messages/facets', async (req, reply) => {
    const id = (req.params as any).id

    if (!sessionsRepo.getSessionById(id)) {
      return reply.status(404).send({ error: 'Session not found' })
    }

    const raw = (req.query as any)?.tzOffset
    let tzOffset = 0
    if (raw !== undefined && raw !== '') {
      const n = Number(raw)
      if (!Number.isFinite(n)) {
        return reply
          .status(400)
          .send({ error: 'tzOffset 必须是数字（分钟，UTC 偏移，如东八区 480）' })
      }
      tzOffset = Math.max(-840, Math.min(840, Math.trunc(n)))
    }

    return messageSearchRepo.getSessionMessageFacets(id, tzOffset)
  })

  // ─── GET /api/sessions/:id/messages/search — 历史面板全文搜索 ──
  //
  // rows 的投影**复用 `/messages` 的 `toMessageDto`**（不另写第二份 11 字段映射：
  // 两处映射必然漂移）；`total` 是该 q + 时间窗的匹配总数，不受 before/limit 影响。

  app.get('/api/sessions/:id/messages/search', async (req, reply) => {
    const id = (req.params as any).id

    if (!sessionsRepo.getSessionById(id)) {
      return reply.status(404).send({ error: 'Session not found' })
    }

    const q = (req.query as any) ?? {}
    const term = typeof q.q === 'string' ? q.q : ''
    if (!term.trim()) {
      return reply.status(400).send({ error: '搜索词 q 必填，且 trim 后不能为空' })
    }
    if (term.trim().length > 200) {
      return reply.status(400).send({ error: '搜索词 q 长度不得超过 200 字符' })
    }

    // `parseInt(...) || 50` 会把合法值 0 折成 50（'0' 是真值串），故显式判 NaN：
    // 缺省 / 非数字 → 50，数字才进 clamp [1,100]
    const parsedLimit = parseInt(q.limit ?? '', 10)
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 100) : 50

    const before = q.before
    if (before !== undefined && (typeof before !== 'string' || !before.trim())) {
      return reply.status(400).send({ error: 'before 必须是非空字符串（消息 id 游标）' })
    }
    const from = q.from
    if (from !== undefined && (typeof from !== 'string' || !from.trim())) {
      return reply.status(400).send({ error: 'from 必须是非空字符串（created_at 下界）' })
    }
    const to = q.to
    if (to !== undefined && (typeof to !== 'string' || !to.trim())) {
      return reply.status(400).send({ error: 'to 必须是非空字符串（created_at 上界）' })
    }

    const result = messageSearchRepo.searchSessionMessages(id, {
      q: term,
      limit,
      before: before ?? undefined,
      from: from ?? undefined,
      to: to ?? undefined,
    })

    return { rows: result.rows.map(toMessageDto), total: result.total }
  })

  // ─── GET /api/sessions/:id/executions — 执行元数据（耗时/token 展示投影）──

  app.get('/api/sessions/:id/executions', async (req, reply) => {
    const id = (req.params as any).id

    if (!sessionsRepo.getSessionById(id)) {
      return reply.status(404).send({ error: 'Session not found' })
    }

    const rows = execLogsRepo.getExecutionsBySession(id)

    return {
      executions: rows.map((r) => ({
        // T2：气泡 footer 的 ⚙trace 点开就要 executionId。本投影是**前端本来就拉**的
        // （ChatPanel 进会话即批量取、按 messageId 缓存），带上它 = 点 ⚙ 零往返。
        // 独立的 `/api/eval/execution-by-message` 仍在——它是**权威回退**：缓存未就绪
        // （老消息、刷新后 store 还没回、或该执行行已被回退删掉）时由它给准话。
        executionId: r.id,
        messageId: r.message_id,
        agentId: r.agent_id,
        status: r.status,
        latencyMs: r.latency_ms,
        promptTokens: r.prompt_tokens,
        completionTokens: r.completion_tokens,
        // `normalizeIsoMs` 而非 `replace(' ','T') + 'Z'`：后者对已是 ISO 的串会拼出 `…123ZZ`
        // （票 6 起 `started_at` 已是 ISO 毫秒）⇒ 前端拿到的 `startedAt` 畸形。
        startedAt: r.started_at ? normalizeIsoMs(r.started_at) : null,
      })),
    }
  })

  // ─── POST /api/sessions/:id/read — 标记已读 ──────────

  app.post('/api/sessions/:id/read', async (req, reply) => {
    const id = (req.params as any).id

    if (!sessionsRepo.getSessionById(id)) {
      return reply.status(404).send({ error: 'Session not found' })
    }

    readStateRepo.upsertLastReadAt(id)

    return { ok: true }
  })

  // ─── DELETE /api/sessions/:id — 移入回收站（幂等）─────
  //
  // 与票 7 的物理删除是**语义反转**：只写 `sessions.deleted_at`，消息 / 执行日志 / 绑定
  // 依赖全留 7 天。读取口径（spec §3.2）：
  // - 从未存在 / 已彻底清除 → 404；
  // - 已删且不是整组条目成员 → 200 返回**首次** `deletedAt`（不重置 7 天计时）；
  // - 已删且属于某次整组删除 → 409 `SESSION_IN_TRASH_GROUP`（它已作为组条目在回收站里）；
  // - 忙碌 / 绑定守卫**只在 `deleted_at IS NULL` 时跑**（第二次删除不会被自己的忙碌挡回）。
  app.delete('/api/sessions/:id', async (req, reply) => {
    const id = (req.params as any).id
    const row = sessionsRepo.getSessionByIdIncludingDeleted(id)
    if (!row) return reply.status(404).send({ error: 'Session not found' })

    if (row.deleted_at !== null) {
      const groupId = groupBatchOf(row)
      if (groupId !== null) {
        return reply.status(409).send({ error: 'SESSION_IN_TRASH_GROUP', groupId })
      }
      return {
        id,
        deletedAt: row.deleted_at,
        purgeAfter: trashRepo.purgeAfterOf(row.deleted_at),
      }
    }

    const blocker = getSessionBlocker(row)
    if (blocker) {
      return reply.status(409).send({ error: blockerError([blocker]), sessions: [blocker] })
    }

    const deletedAt = new Date().toISOString()
    sessionsRepo.trashSession(id, deletedAt)
    // 软删成功后清引擎槽位（C1：槽位只增不减；忙碌守卫已挡掉在跑的会话，这里收的是
    // idle 残留槽位）。disposeSession 只清内存，不中断 stream——与「先停后删」是两件事。
    getExecutionEngine()?.disposeSession(id)
    emitGlobal(Events.SESSION_TRASHED, { sessionIds: [id], groupIds: [] })
    return { id, deletedAt, purgeAfter: trashRepo.purgeAfterOf(deletedAt) }
  })

  // ─── POST /api/sessions/:id/restore — 恢复单条 ────────
  app.post('/api/sessions/:id/restore', async (req, reply) => {
    const id = (req.params as any).id
    const row = sessionsRepo.getSessionByIdIncludingDeleted(id)
    if (!row || row.deleted_at === null) {
      return reply.status(404).send({ error: 'Session not in trash' })
    }
    const batchGroupId = groupBatchOf(row)
    if (batchGroupId !== null) {
      return reply.status(409).send({ error: 'SESSION_IN_TRASH_GROUP', groupId: batchGroupId })
    }
    if (isExpired(row.deleted_at)) {
      return reply.status(404).send({ error: 'Session not in trash' })
    }

    // 原组还活着 → 回原组；已删 / 已清除 → 落未分组（spec §4.2）
    const targetGroupId =
      row.group_id !== null && sessionGroupsRepo.getGroupById(row.group_id) ? row.group_id : null
    sessionsRepo.restoreSession(id, targetGroupId)
    const restored = sessionsRepo.getSessionByIdIncludingDeleted(id)!
    const config = toSessionConfig(restored)
    emitGlobal(Events.SESSION_RESTORED, { groupId: targetGroupId, sessions: [config] })
    return { session: config, groupId: targetGroupId }
  })

  // ─── DELETE /api/sessions/:id/purge — 彻底删除单条 ────
  app.delete('/api/sessions/:id/purge', async (req, reply) => {
    const id = (req.params as any).id
    const row = sessionsRepo.getSessionByIdIncludingDeleted(id)
    if (!row) return reply.status(404).send({ error: 'Session not found' })
    if (row.deleted_at === null) {
      return reply.status(409).send({ error: 'SESSION_NOT_TRASHED' })
    }
    const batchGroupId = groupBatchOf(row)
    if (batchGroupId !== null) {
      return reply.status(409).send({ error: 'SESSION_IN_TRASH_GROUP', groupId: batchGroupId })
    }

    trashRepo.purgeSessionRecord(id)
    getExecutionEngine()?.disposeSession(id)
    emitGlobal(Events.SESSION_PURGED, { sessionIds: [id], groupIds: [] })
    return { id }
  })

  // ─── DELETE /api/trash — 清空回收站 ───────────────────
  //
  // 含过期未清扫的条目：用户点「清空」时不该留下「已过期但还没到整点清扫」的残余。
  app.delete('/api/trash', async () => {
    const { groupIds, sessionIds } = trashRepo.emptyTrash()
    const engine = getExecutionEngine()
    if (engine) {
      for (const id of sessionIds) engine.disposeSession(id)
    }
    if (sessionIds.length > 0 || groupIds.length > 0) {
      emitGlobal(Events.SESSION_PURGED, { sessionIds, groupIds })
    }
    if (groupIds.length > 0) emitGroupsChanged()
    return { purged: { groups: groupIds.length, sessions: sessionIds.length } }
  })
}

/** 归档态变化后：全局广播 + 返回新配置（`archivedAt` 一律过归一器——列已是 ISO，但接口
 *  形态统一走 `toIsoDb` 免得日后有人把这里换成秒级列时静默漂移）。 */
function emitArchived(id: string): SessionConfig {
  const row = sessionsRepo.getSessionById(id)!
  const config = toSessionConfig(row)
  try {
    // 全局广播（非会话房间）——归档改的是列表可见性，受影响的是所有看列表的客户端
    getIO()?.emit(Events.SESSION_ARCHIVED, {
      sessionId: id,
      archivedAt: config.archivedAt ?? null,
    })
  } catch {
    /* emit 失败不影响响应 */
  }
  return config
}

/** 已删会话所属的「整组删除」组 id：组与会话 `deleted_at` **精确相等**才是同批。
 *
 *  组内更早单删的会话时间戳不同 → 返回 null，它属于独立的会话条目（ADR D3 不变量）。 */
function groupBatchOf(row: SessionRow): string | null {
  if (row.deleted_at === null || row.group_id === null) return null
  const group = sessionGroupsRepo.getGroupByIdIncludingDeleted(row.group_id)
  return group && group.deleted_at === row.deleted_at ? group.id : null
}

/** 已过期（`deleted_at <= now-7d`）：列表已滤掉，恢复接口按「不存在」处理（spec §4.2）。 */
function isExpired(deletedAt: string): boolean {
  return deletedAt <= trashRepo.trashCutoff()
}

/** 全局广播（列表级 UI 态）；emit 失败不影响已提交的写操作。 */
function emitGlobal(event: string, payload: unknown): void {
  try {
    getIO()?.emit(event, payload)
  } catch {
    /* emit 失败不影响响应 */
  }
}

/** 消息行 → 前端 wire 形状（11 字段）。
 *
 *  `/messages`、`/messages/browse`、`/messages/search` **共用这一份**：投影是前端消费的
 *  契约，抄第二份必然漂移（一个端点加了字段、另一个没加，前端拿到两种形状）。 */
function toMessageDto(r: MessageRow) {
  const msgImages: string[] = parseJsonArray(r.images)
  return {
    id: r.id,
    sessionId: r.session_id,
    agentId: r.agent_id || null,
    role: r.role,
    content: r.content,
    images: msgImages.length > 0 ? msgImages : undefined,
    mentions: JSON.parse(r.mentions || '[]'),
    taskId: r.task_id || null,
    thinkingContent: r.thinking_content || undefined,
    toolContent: parseJsonValue<ToolCallInfo[]>(r.tool_content),
    segments: parseJsonValue<StreamSegment[]>(r.segments),
    createdAt: toIsoDb(r.created_at),
  }
}
