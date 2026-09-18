/**
 * 删除依赖清理 —— B 范围重建批（票 6）给新 FK 接的配套件。
 *
 * **为什么需要它**：spec §4.1 的删除策略是「物理删除全 RESTRICT」，本批给 7 张表补的
 * FK 全部落在 RESTRICT 上 ⇒ 删父行时子行**会挡路**。不清理的后果不是「更安全」，
 * 而是既有删除端点从「删得掉」变成 500：`DELETE /api/sessions/:id`、
 * `DELETE /api/sessions/:id/messages`、`DELETE /api/agents/:id`、`pnpm seed --reset`。
 *
 * **为什么集中在**一个模块：这批依赖是**跨表知识**（「删消息前要先动 execution_logs /
 * review_verdicts / review_parse_failures / episode_attributions」），散在各调用点就是
 * 「谁忘了谁 500」——票 3 实测的 26 行悬空 verdict 正是这么攒出来的（删消息时没人知道
 * 还有张表指着它）。故清理挂在 `db/repository` 的 `delete*` 函数内部（而非路由），
 * 路由 / seed / handoff 回滚**每条调用路径**自动覆盖。
 *
 * **与 D1 的关系**：D1（票 3 拍板）清的是**存量**孤儿，走迁移条目；本模块管的是
 * **增量**——同一条规则（子行随父行去）的两个时态，判据一致。
 *
 * **判据边界**：只清「引用列指向待删父行」的子行，不做递归——上表的子表（如
 * `episodes` 之于 `episode_attributions`）由各自票的删除路径负责。
 */
import type Database from 'better-sqlite3'

let db: Database.Database

export function setRepoDb(dbInst: Database.Database): void {
  db = dbInst
}

/** 待删**消息**的选取范围——四种调用形态（单条 / 按会话 / 按猫 / 全清）共用一个实现 */
export type MessageScope =
  | { kind: 'id'; id: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'agent'; agentId: string }
  | { kind: 'all' }

/** 待删**会话**的选取范围 */
export type SessionScope = { kind: 'id'; sessionId: string } | { kind: 'all' }

/** 待删**成员**的选取范围 */
export type AgentScope = { kind: 'id'; agentId: string } | { kind: 'all' }

/** 范围 → 「待删消息 id 的子查询」+ 绑定参数（四种形态共用一套 DELETE 语句） */
function messageScopeWhere(scope: MessageScope): { sub: string; args: unknown[] } {
  switch (scope.kind) {
    case 'id':
      return { sub: 'SELECT id FROM messages WHERE id = ?', args: [scope.id] }
    case 'session':
      return { sub: 'SELECT id FROM messages WHERE session_id = ?', args: [scope.sessionId] }
    case 'agent':
      return { sub: 'SELECT id FROM messages WHERE agent_id = ?', args: [scope.agentId] }
    case 'all':
      return { sub: 'SELECT id FROM messages', args: [] }
  }
}

/**
 * 清掉引用「待删消息」的子行——**必须在删消息之前调用**。
 *
 * 覆盖四条依赖（票 6 重建批立的 FK，全 RESTRICT）：
 * - `execution_logs.message_id` / `.triggered_by_message_id`（回复侧 + 触发侧）
 * - `review_verdicts.message_id`（主键即被引用消息）
 * - `review_parse_failures.message_id`（同上）
 * - `episode_attributions.delivery_message_id`（可空诊断链）
 *
 * 全部在**一个事务**里跑：清理与随后的 `DELETE FROM messages` 之间不留「子行已被清、
 * 父行还在」的中间态（调用方紧接着删父行，失败由调用方那条语句负责回滚语义）。
 */
export function purgeMessageDependents(scope: MessageScope): void {
  const { sub, args } = messageScopeWhere(scope)

  const tx = db.transaction((): void => {
    db.prepare(
      `DELETE FROM execution_logs
       WHERE message_id IN (${sub}) OR triggered_by_message_id IN (${sub})`
    ).run(...args, ...args)
    db.prepare(`DELETE FROM review_verdicts WHERE message_id IN (${sub})`).run(...args)
    db.prepare(`DELETE FROM review_parse_failures WHERE message_id IN (${sub})`).run(...args)
    db.prepare(`DELETE FROM episode_attributions WHERE delivery_message_id IN (${sub})`).run(
      ...args
    )
  })
  tx()
}

/**
 * 清掉挂在一个会话上的子行——**必须在删会话之前调用**。
 *
 * 覆盖四条依赖（全 RESTRICT）：`flow_states.session_id`、`flow_state_events.session_id`、
 * `review_verdicts.session_id`、`connector_bindings.session_id`。
 *
 * 消息与执行日志**不在此列**：它们由调用方按既有顺序（先日志、后消息、再会话）删除，
 * 而消息那次删除自己会带上 `purgeMessageDependents`。
 */
export function purgeSessionDependents(scope: SessionScope): void {
  const where = scope.kind === 'all' ? '' : ' WHERE session_id = ?'
  const args: unknown[] = scope.kind === 'all' ? [] : [scope.sessionId]

  const tx = db.transaction((): void => {
    for (const table of [
      'flow_states',
      'flow_state_events',
      'review_verdicts',
      'connector_bindings',
    ]) {
      db.prepare(`DELETE FROM ${table}${where}`).run(...args)
    }
  })
  tx()
}

/**
 * 清掉挂在一位成员上的子行——**必须在删成员之前调用**。
 *
 * 覆盖两条依赖（全 RESTRICT）：`review_verdicts.reviewer_agent_id`（审查者）与
 * `.subject_agent_id`（被审查者）。
 *
 * ⚠️ **与 spec §4.1 的 409 契约的关系**：spec 定的终态是「删被引用的成员 → 先查后删 →
 * 409 + 会话清单」（票 8 交付）。本函数是**票 8 落地前的过渡**——保持「删得掉」这一
 * 既有行为不被 FK 变成 500；票 8 会用显式拦截替换它（届时删除不再带走审查结论，而是
 * 让用户先处理引用）。两条路径不共存：票 8 收口时应删掉这里的调用。
 */
export function purgeAgentDependents(scope: AgentScope): void {
  if (scope.kind === 'all') {
    db.prepare('DELETE FROM review_verdicts').run()
    return
  }
  db.prepare('DELETE FROM review_verdicts WHERE reviewer_agent_id = ? OR subject_agent_id = ?').run(
    scope.agentId,
    scope.agentId
  )
}
