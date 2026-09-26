/**
 * Message 表查询函数。
 */
import type Database from 'better-sqlite3'
import { purgeMessageDependents } from './dependents.js'
import type { MessageRow, MessageWithAgentName } from './types.js'
import { isoMinutesAgo, nowIso, toIsoDb, toIsoDbUpper } from './time.js'

let db: Database.Database

export function setRepoDb(dbInst: Database.Database): void {
  db = dbInst
}

// ─── 查询 ──────────────────────────────────────────────

/** 检查消息是否存在（不限 role），用于撤回时窗保护。
 *  区别于 getMessageById，不按 role 过滤 —— A2A 场景下触发消息可能是 agent 角色。 */
export function messageExists(id: string, sessionId: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM messages WHERE id = ? AND session_id = ?')
    .get(id, sessionId)
  return row !== undefined
}

export function getMessageById(
  id: string,
  sessionId: string,
  role: string
): MessageRow | undefined {
  return db
    .prepare('SELECT * FROM messages WHERE id = ? AND session_id = ? AND role = ?')
    .get(id, sessionId, role) as MessageRow | undefined
}

/** 仅按消息 id 查询所属会话（不限定 session/role）。
 *  供 handoff 从 commit message 的 catstudy [uuid] 反查投递目标会话——
 *  getMessageById 必须带 session_id 才能查（鸡生蛋），故拆出此函数。 */
export function getMessageByIdOnly(
  id: string
): { id: string; session_id: string; role: string } | undefined {
  return db.prepare('SELECT id, session_id, role FROM messages WHERE id = ?').get(id) as
    { id: string; session_id: string; role: string } | undefined
}

/** 按消息 id 反查所属会话 + task_id（契约③ 反查源链 commit）。
 *  审查链 verdict 消息的 task_id = 源链 trace_id（handoff-gen E3 接线投递），
 *  经 execution_logs.commit_hash 反查被审 commit——契约③ 状态机推进的定位键。
 *  task_id NULL / 消息不存在 → undefined（纯会话无 commit 链路，状态机不接管）。 */
export function getTaskIdByMessageId(
  id: string
): { session_id: string; task_id: string } | undefined {
  const row = db.prepare('SELECT session_id, task_id FROM messages WHERE id = ?').get(id) as
    { session_id: string; task_id: string | null } | undefined
  if (!row || !row.task_id) return undefined
  return { session_id: row.session_id, task_id: row.task_id }
}

/** 获取会话中最近的用户消息 ID */
export function getLatestUserMessageId(sessionId: string): string | undefined {
  const row = db
    .prepare(
      'SELECT id FROM messages WHERE session_id = ? AND role = ? ORDER BY created_at DESC LIMIT 1'
    )
    .get(sessionId, 'user') as { id: string } | undefined
  return row?.id
}

/** 指定 Agent 在某个时间点之后是否已有回复。
 *  用 `>=` 而非 `>`：SQLite datetime 是秒级精度，同秒内完成的回复
 *  用 `>` 会漏判 → 重启恢复时误判"未回复" → 重复执行。 */
export function hasAgentRepliedAfter(
  agentId: string,
  sessionId: string,
  afterCreatedAt: string
): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM messages
       WHERE session_id = ? AND role = 'agent' AND agent_id = ? AND created_at >= ?`
    )
    .get(sessionId, agentId, afterCreatedAt) as { cnt: number }
  return (row?.cnt || 0) > 0
}

/** 获取会话中某条消息之后的所有 Agent 回复 */
export function getAgentRepliesAfter(sessionId: string, afterCreatedAt: string): MessageRow[] {
  return db
    .prepare('SELECT id FROM messages WHERE session_id = ? AND role = ? AND created_at > ?')
    .all(sessionId, 'agent', afterCreatedAt) as MessageRow[]
}

/** 获取会话的历史消息（用于前端加载，含 system 消息如「重启完成」等需用户可见，限制条数） */
export function getSessionHistory(sessionId: string, limit: number = 200): MessageRow[] {
  return db
    .prepare(
      `SELECT * FROM messages
       WHERE session_id = ?
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .all(sessionId, limit) as MessageRow[]
}

/** 跨会话最新 agent 消息（倒序，Phase 0 候选样本收集用——不限会话挑 DS 族回复） */
export function getLatestAgentMessages(limit: number = 2000): MessageRow[] {
  return db
    .prepare(
      `SELECT * FROM messages
       WHERE role = 'agent'
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(limit) as MessageRow[]
}

/** 获取会话的最近消息（倒序，用于构建 Agent 上下文） */
export function getRecentMessages(sessionId: string, limit: number = 500): MessageRow[] {
  return db
    .prepare(
      `SELECT * FROM messages
       WHERE session_id = ? AND role != 'system'
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(sessionId, limit) as MessageRow[]
}

/** 会话消息读层查询（方案 3 A 地基——前端历史渲染与 agent 回读共用同一查询函数）。
 *
 *  窗口参数（全部可选，逐项 AND）：
 *    limit  — 返回条数上限 1-1000，默认 200（无参数调用行为与 getRecentMessages(id, 200) 一致）
 *    before — messageId 游标：返回「严格早于该消息」的批次（翻更早历史用）
 *    from   — created_at >= from；to — created_at <= to（时间窗）
 *
 *  窗口入参**两种形态通吃**（秒级 `YYYY-MM-DD HH:MM:SS` 与 ISO）——库里 created_at 自票 5
 *  起是 ISO 毫秒，而调用方（老前端 / agent 回读）常传秒级串；不归一就是混比：`' '`(0x20)
 *  < `'T'`(0x54) ⇒ 秒级串在**同一天**的所有 ISO 串面前一律判小，窗口整段失配且不报错。
 *    agentId— 可选：仅返回指定 agent 的消息（B 工具 body 的 agentIdFilter 落点）
 *
 *  排序 created_at DESC, id DESC——**tie-break 仍必需**（票 5 迁毫秒后并未消掉它）：
 *  ① 并发写会落在同一毫秒；② 老库同秒的行经 `toIsoMs` 一律折成 `…SS.000Z`，
 *  整秒的行**全部同值**。只比 created_at 会漏行/重行；before 游标用 (created_at, id) 复合。
 *  before 消息不在本会话 → 位置不可定 → 返回空数组（客户端自然停止翻页）。
 */
export function getSessionMessagesRange(
  sessionId: string,
  opts: {
    limit?: number
    before?: string
    from?: string
    to?: string
    agentId?: string
  } = {}
): MessageRow[] {
  const rawLimit = opts.limit ?? 200
  const limit = Number.isFinite(rawLimit) ? Math.min(1000, Math.max(1, Math.floor(rawLimit))) : 200

  const where: string[] = ['session_id = ?', "role != 'system'"]
  const params: Array<string | number> = [sessionId]

  if (opts.before) {
    const cursor = db
      .prepare('SELECT created_at, id FROM messages WHERE id = ? AND session_id = ?')
      .get(opts.before, sessionId) as { created_at: string; id: string } | undefined
    if (!cursor) return []
    where.push('(created_at < ? OR (created_at = ? AND id < ?))')
    params.push(cursor.created_at, cursor.created_at, cursor.id)
  }
  if (opts.from !== undefined) {
    where.push('created_at >= ?')
    params.push(toIsoDb(opts.from))
  }
  if (opts.to !== undefined) {
    where.push('created_at <= ?')
    // 上界走 `toIsoDbUpper`：省略小数秒的输入按「整秒含入」折算（`.999`），与迁移前
    // 秒级列的 `<=` 行为逐条对齐——直接折算成 `.000` 会让同一秒里 `.001~.999` 的消息
    // **静默从结果里消失**（票 5 迁移把列精度抬到毫秒的连带面）。
    params.push(toIsoDbUpper(opts.to))
  }
  if (opts.agentId !== undefined) {
    where.push('agent_id = ?')
    params.push(opts.agentId)
  }
  params.push(limit)

  return db
    .prepare(
      `SELECT * FROM messages
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`
    )
    .all(...params) as MessageRow[]
}

/** 同会话同 task_id 是否已有 agent 回复（补填风暴根治方向 2：重放/零执行扫描前查）。
 *  批量答复场景下兄弟消息无独立 execution_log，但同 task_id 的 agent 回复
 *  已证明"这条消息事实上被执行过"——不再反复补派。task_id NULL → false
 *  （SQL NULL 比较不命中，行为天然退化，绝不误伤真静默丢）。 */
export function hasAgentReplyByTaskId(sessionId: string, taskId: string): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM messages
       WHERE session_id = ? AND task_id = ? AND role = 'agent' AND agent_id IS NOT NULL
       LIMIT 1`
    )
    .get(sessionId, taskId)
}

/** 链是否存在：同会话同 task_id 是否已有消息（T-F 入口主闸的**结构推导**源）。
 *
 *  语义 = 「该锚名下已经有东西了」⟹ 链已存在。比 spec A5 括注的
 *  「该链上是否已有审查请求消息」更宽也更机械：审查请求形态要靠内容前缀匹配
 *  （脆弱、且审查请求只是链上消息的一种），而锚的全部含义就是"同锚即同链"。
 *  taskId 为空 → false（无锚即无链，确定）。 */
export function hasMessagesByTaskId(sessionId: string, taskId: string): boolean {
  return !!db
    .prepare(`SELECT 1 FROM messages WHERE session_id = ? AND task_id = ? LIMIT 1`)
    .get(sessionId, taskId)
}

/** 获取同一 taskId 的完整消息历史 */
export function getTaskHistory(
  taskId: string,
  sessionId: string,
  limit: number = 500
): MessageRow[] {
  return db
    .prepare(
      `SELECT * FROM messages
       WHERE task_id = ? AND session_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(taskId, sessionId, limit) as MessageRow[]
}

/** 获取上次摘要之后的新消息 */
export function getMessagesAfterSummary(sessionId: string, lastMessageId: string): MessageRow[] {
  return db
    .prepare(
      `SELECT * FROM messages
       WHERE session_id = ? AND role != 'system' AND created_at > (
         SELECT created_at FROM messages WHERE id = ?
       )
       ORDER BY created_at ASC`
    )
    .all(sessionId, lastMessageId) as MessageRow[]
}

/** 获取会话全部非 system 消息（首次摘要用） */
export function getAllSessionMessages(sessionId: string): MessageRow[] {
  return db
    .prepare(
      `SELECT * FROM messages
       WHERE session_id = ? AND role != 'system'
       ORDER BY created_at ASC`
    )
    .all(sessionId) as MessageRow[]
}

/** 获取会话中指定时间之后的消息数（未读计数用）。
 *
 *  ⚠️ `afterTime` 是**跨表**来的（`session_read_state.last_read_at` 或 `sessions.created_at`
 *  ——两张表都还是秒级的 `datetime('now')`，随各自重建票迁移），而 `messages.created_at`
 *  自票 5 起是 ISO 毫秒。混比 ⇒ `' '`(0x20) < `'T'`(0x54) ⇒ **未读计数恒等于全量**（不报错，
 *  只是每次列表都显示全未读）。故入参一律先归一到 ISO（§4.2 连带改造点：比较点与迁移同批切）。
 *  等那两张表也迁到 ISO 后，这里是幂等的（已是 ISO 原样返回），无需回改。 */
export function countMessagesAfter(sessionId: string, afterTime: string): number {
  const row = db
    .prepare('SELECT COUNT(*) as cnt FROM messages WHERE session_id = ? AND created_at > ?')
    .get(sessionId, toIsoDb(afterTime)) as { cnt: number }
  return row?.cnt || 0
}

/** 获取会话非 system 消息总数（摘要块覆盖边界判定用；与 getRecentMessages 口径一致） */
export function countBySession(sessionId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM messages
       WHERE session_id = ? AND role != 'system'`
    )
    .get(sessionId) as { cnt: number }
  return row?.cnt || 0
}

/** 获取带 Agent 名称的消息（用于交接总结） */
export function getMessagesWithAgentName(
  sessionId: string,
  limit: number = 300
): MessageWithAgentName[] {
  return db
    .prepare(
      `SELECT m.*, a.name as agent_name
       FROM messages m
       LEFT JOIN agents a ON m.agent_id = a.id
       WHERE m.session_id = ? AND m.role != 'system'
       ORDER BY m.created_at DESC
       LIMIT ?`
    )
    .all(sessionId, limit) as MessageWithAgentName[]
}

/**
 * 按 **id 列表**批量取消息正文（R14b 读口用：解析角标要拿原文）。
 *
 * 批量是**防 N+1** 的要求：一页 50 条消息，逐条取就是 50 次查询。
 * 调用方（`routes/memory.ts`）只对**有注入节**的消息取内容——三态里的
 * `not-retrieved` / `none` 没有号可解析，不该为此多查一次。
 *
 * 返回 Map（调用方按 id 取，不必再 find）；不存在的 id 不出现在 Map 里。
 */
export function getMessageContentsByIds(
  ids: readonly string[],
  sessionId: string
): Map<string, string> {
  const result = new Map<string, string>()
  if (ids.length === 0) return result
  const placeholders = ids.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT id, content FROM messages
       WHERE id IN (${placeholders}) AND session_id = ?`
    )
    .all(...ids, sessionId) as Array<{ id: string; content: string }>
  for (const row of rows) result.set(row.id, row.content)
  return result
}

// ─── 写入 ──────────────────────────────────────────────

/** 三条写入的 `created_at` 一律由**这里**生成（⑤-c：记录时间 repository 层统一生成，
 *  调用方不许传）。列上的 DEFAULT 只是裸 SQL 写入的兜底，生产写入全部走这三个函数。 */
export function insertMessage(
  id: string,
  sessionId: string,
  role: 'user' | 'agent' | 'system',
  content: string,
  mentionsJson: string,
  agentId: string | null,
  taskId: string | null
): void {
  db.prepare(
    `INSERT INTO messages (id, session_id, agent_id, role, content, mentions, task_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, sessionId, agentId, role, content, mentionsJson, taskId, nowIso())
}

export function insertUserMessage(
  id: string,
  sessionId: string,
  content: string,
  mentionsJson: string,
  taskId: string | null,
  imagesJson?: string
): void {
  db.prepare(
    `INSERT INTO messages (id, session_id, role, content, mentions, task_id, images, created_at)
     VALUES (?, ?, 'user', ?, ?, ?, ?, ?)`
  ).run(id, sessionId, content, mentionsJson, taskId, imagesJson || '[]', nowIso())
}

export function insertAgentMessage(
  id: string,
  sessionId: string,
  agentId: string,
  content: string,
  taskId: string | null,
  thinkingContent?: string,
  toolContentJson?: string,
  extraJson?: string,
  segmentsJson?: string
): void {
  db.prepare(
    `INSERT INTO messages (id, session_id, agent_id, role, content, mentions, task_id, thinking_content, tool_content, extra, segments, created_at)
     VALUES (?, ?, ?, 'agent', ?, '[]', ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    sessionId,
    agentId,
    content,
    taskId,
    thinkingContent ?? null,
    toolContentJson ?? null,
    extraJson ?? null,
    segmentsJson ?? null,
    nowIso()
  )
}

/** 补写消息的附加富内容（extra 列）。
 *  diff 采集在回复落库之后进行（异步 git 调用），成功后再补写——
 *  采集失败静默跳过，消息保持无 extra（前端纯文本回退，行为与现网一致）。
 *  fire-and-forget：DB 写入失败静默吞错，不阻塞回复广播。 */
export function updateMessageExtra(messageId: string, extraJson: string): void {
  try {
    db.prepare('UPDATE messages SET extra = ? WHERE id = ?').run(extraJson, messageId)
  } catch {
    // fire-and-forget：DB 挂了也不影响消息广播（extra 随 NEW_MESSAGE 已带上）
  }
}

export function updateMessageMentions(messageId: string, mentionsJson: string): void {
  db.prepare('UPDATE messages SET mentions = ? WHERE id = ?').run(mentionsJson, messageId)
}

/** 原地改写消息正文（内容 UPDATE 通道）。
 *  E2 归因消息层闭环专用：closure 复验关闭时对已投递的调查单原地追加
 *  「✅已关闭」标记（方案 A——用户同一位置看到完整状态，不另起新消息）。
 *  只改 content 列，不动 mentions/task_id/created_at（消息身份不变）。 */
export function updateMessageContent(messageId: string, content: string): void {
  db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, messageId)
}

// ↓ 四个删除函数**先清子行再删消息**（票 6：新 FK 全 RESTRICT，不清则既有端点 500）。
//   清理清单与理由集中在 `dependents.ts` 一处声明，此处只负责在删之前调用。

export function deleteMessageById(id: string): void {
  purgeMessageDependents({ kind: 'id', id })
  db.prepare('DELETE FROM messages WHERE id = ?').run(id)
}

export function deleteMessagesBySession(sessionId: string): { changes: number } {
  purgeMessageDependents({ kind: 'session', sessionId })
  return db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId)
}

export function deleteMessagesByAgent(agentId: string): { changes: number } {
  purgeMessageDependents({ kind: 'agent', agentId })
  return db.prepare('DELETE FROM messages WHERE agent_id = ?').run(agentId)
}

export function deleteAllMessages(): void {
  purgeMessageDependents({ kind: 'all' })
  db.exec('DELETE FROM messages')
}

// ─── 队列持久化（P0）────────────────────────────────────

/** 更新消息的 dispatch_state。
 *  fire-and-forget：DB 写入失败时静默吞错，不阻塞 dispatch 流程。 */
export function setDispatchState(messageId: string, state: 'queued' | 'running' | 'done'): void {
  try {
    db.prepare('UPDATE messages SET dispatch_state = ? WHERE id = ?').run(state, messageId)
  } catch {
    // fire-and-forget: DB 挂了也不影响消息入队/执行
  }
}

/** 读取消息当前 dispatch_state。
 *  多目标消息 per-target 循环守卫用：兄弟目标已写 queued/running 时，
 *  terminal 写（done）不得覆盖——否则重启恢复（recoverQueuedMessages 只捞
 *  queued/running）丢失兄弟目标的排队执行。DB 异常返回 null（守卫放行 done，
 *  此时 setDispatchState 同样会静默失败，语义自洽）。 */
export function getDispatchState(messageId: string): string | null {
  try {
    const row = db.prepare('SELECT dispatch_state FROM messages WHERE id = ?').get(messageId) as
      { dispatch_state: string | null } | undefined
    return row?.dispatch_state ?? null
  } catch {
    return null
  }
}

/** 查询所有待处理消息（queued 或 running），按创建时间升序。
 *  返回 dispatch 所需的最小字段集。 */
export function getPendingMessages(): Array<{
  id: string
  session_id: string
  content: string
  mentions: string
  agent_id: string | null
  role: string
}> {
  return db
    .prepare(
      `SELECT id, session_id, content, mentions, agent_id, role
       FROM messages
       WHERE dispatch_state IN ('queued', 'running')
       ORDER BY created_at ASC`
    )
    .all() as Array<{
    id: string
    session_id: string
    content: string
    mentions: string
    agent_id: string | null
    role: string
  }>
}

/**
 * 静默丢重放扫描：从未被 dispatch 调度过的用户消息（dispatch_state IS NULL 且无任何
 * execution_log 引用）且超时窗 → 补派候选（16:09/02:24 案例：@ 消息落库但 ingest
 * 在 insert 与 dispatch 之间崩溃，调度从未发生）。
 *
 * 只扫 NULL 不扫 queued/running：queued = 内存队列存活（正在等待执行，补派会双跑）；
 * running = 执行中或已被 completeExecution 弹出（弹出后由 drain 段立即执行——
 * 队列延迟修复后不存在长窗）。NULL = 从未调度——调度永远不发生的真实静默丢面。
 *
 * @param minutes 超时窗（分钟）——created_at 早于 now - minutes 才补派
 *
 * ⚠️ 超时窗比较**必须与列同口径**：原句 `created_at <= datetime('now', ?)` 右侧是**秒级**
 * 串，而 `created_at` 自票 5 起是 ISO 毫秒——`'T'`(0x54) > `' '`(0x20) ⇒ 同一天的 ISO 行
 * 恒判大于秒级 now ⇒ 扫描**永远空转**（静默丢重放的兜底整个失效，且不报错）。改用 ISO。
 */
export function getUndispatchedUserMessagesOlderThan(minutes: number): Array<{
  id: string
  session_id: string
  content: string
  mentions: string
  task_id: string | null
  images: string | null
  created_at: string
}> {
  return db
    .prepare(
      `SELECT id, session_id, content, mentions, task_id, images, created_at
       FROM messages
       WHERE role = 'user'
         AND dispatch_state IS NULL
         AND created_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM execution_logs el WHERE el.triggered_by_message_id = messages.id
         )
       ORDER BY created_at ASC`
    )
    .all(isoMinutesAgo(minutes)) as Array<{
    id: string
    session_id: string
    content: string
    mentions: string
    task_id: string | null
    images: string | null
    created_at: string
  }>
}
