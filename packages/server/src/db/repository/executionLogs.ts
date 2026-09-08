/**
 * Execution Log 表查询函数。
 */
import type Database from 'better-sqlite3'
import type { ExecutionLogRow } from './types.js'

let db: Database.Database

export function setRepoDb(dbInst: Database.Database): void {
  db = dbInst
}

// ─── 查询 ──────────────────────────────────────────────

export function getRunningLogs(): Array<{ id: string; agent_id: string }> {
  return db
    .prepare("SELECT id, agent_id FROM execution_logs WHERE status = 'running'")
    .all() as Array<{ id: string; agent_id: string }>
}

/** 启动时获取被 server 重启打断的执行（fixStuckExecutionLogs 标记后）。
 *  供重启恢复队列使用——重新 dispatch 这些未完成的执行。
 *  message_id：洞 A 精确判据——非空即该执行已完成并写回回复 id，恢复跳过；
 *  NULL（历史记录/被打断未回复）→ 恢复回退时间窗判据。 */
export function getInterruptedExecutions(): Array<{
  id: string
  session_id: string
  agent_id: string
  triggered_by_message_id: string
  started_at: string
  message_id: string | null
}> {
  return db
    .prepare(
      `SELECT id, session_id, agent_id, triggered_by_message_id, started_at, message_id
       FROM execution_logs
       WHERE status = 'failed' AND error_message = 'server_restart'
       ORDER BY started_at ASC`
    )
    .all() as Array<{
    id: string
    session_id: string
    agent_id: string
    triggered_by_message_id: string
    started_at: string
    message_id: string | null
  }>
}

export function getLogsByTriggerMessage(triggeredByMessageId: string): ExecutionLogRow[] {
  return db
    .prepare('SELECT * FROM execution_logs WHERE triggered_by_message_id = ?')
    .all(triggeredByMessageId) as ExecutionLogRow[]
}

/** 反查"执行某条消息"的 agent（handoff-gen 动态补填人用）。
 *  一条消息可触发多个 agent（多人 @），取最近开始执行的一条；无记录返回 undefined。 */
export function getExecutorNameByTriggeredBy(
  triggeredByMessageId: string
): { agent_id: string; name: string; trace_id: string } | undefined {
  return db
    .prepare(
      `SELECT el.agent_id, a.name, el.trace_id
       FROM execution_logs el
       JOIN agents a ON a.id = el.agent_id
       WHERE el.triggered_by_message_id = ?
       ORDER BY el.started_at DESC
       LIMIT 1`
    )
    .get(triggeredByMessageId) as { agent_id: string; name: string; trace_id: string } | undefined
}

/** 反查"提交某 commit"的 agent（handoff-gen 动态补填人，commit_hash 精确匹配）。
 *  commit 由实施者提交时经 POST /api/messages/:id/commit-hash 写回
 *  （updateRunningExecutionCommitHash），同 uuid 多执行者时各 commit 各命中
 *  各的实施者，不再"取最近开始执行"误指。无记录返回 undefined。
 *  trace_id 一并返回——E3 接线：审查链投递 payload 的 taskId 与 chain_task_id
 *  同源反查（commit_hash → execution_logs → trace_id），verdict 消息才能与
 *  任务链 JOIN 匹配。 */
export function getExecutorNameByCommitHash(
  commitHash: string
): { agent_id: string; name: string; trace_id: string } | undefined {
  return db
    .prepare(
      `SELECT el.agent_id, a.name, el.trace_id
       FROM execution_logs el
       JOIN agents a ON a.id = el.agent_id
       WHERE el.commit_hash = ?
       ORDER BY el.started_at DESC
       LIMIT 1`
    )
    .get(commitHash) as { agent_id: string; name: string; trace_id: string } | undefined
}

/** 按 trace_id 反查 commit_hash（契约③ 状态机推进的定位键）。
 *  审查链 verdict 消息的 task_id = 源链 trace_id（E3 接线），源链执行行挂 commit_hash——
 *  反查被审 commit 供 flow_states 推进。无 commit 链路的执行行（纯会话/未写回）返回 undefined。 */
export function getCommitHashByTraceId(traceId: string): string | undefined {
  const row = db
    .prepare(
      `SELECT commit_hash FROM execution_logs WHERE trace_id = ? AND commit_hash IS NOT NULL
       ORDER BY started_at DESC LIMIT 1`
    )
    .get(traceId) as { commit_hash: string } | undefined
  return row?.commit_hash
}

export function getAgentStats(agentId: string): {
  total_prompt: number
  total_completion: number
  total_calls: number
} {
  return db
    .prepare(
      `SELECT
         COALESCE(SUM(prompt_tokens), 0) AS total_prompt,
         COALESCE(SUM(completion_tokens), 0) AS total_completion,
         COUNT(*) AS total_calls
       FROM execution_logs
       WHERE agent_id = ? AND status = 'completed'`
    )
    .get(agentId) as { total_prompt: number; total_completion: number; total_calls: number }
}

/** 按 session 查全部 execution 的展示列投影（message_id 关联回复气泡）。
 *  message_id = execution_logs.message_id（finalize 写回 replyMessageId，成功路径精确 1:1；
 *  失败/中断为 NULL——展示耗时/token 只关心成功回复，够用）。
 *  ⚠️ 禁用 triggered_by_message_id 作回复消息关联：那是「触发消息」（一条广播/@ 可触发
 *  多个 agent → N:1），关联回复气泡会混淆（店长裁决，别踩反）。
 *  只投影展示所需列，避免整行含 error_message 等无关字段。 */
export function getExecutionsBySession(sessionId: string): Array<{
  message_id: string | null
  agent_id: string
  status: string
  latency_ms: number | null
  prompt_tokens: number | null
  completion_tokens: number | null
  started_at: string | null
}> {
  return db
    .prepare(
      `SELECT message_id, agent_id, status, latency_ms, prompt_tokens, completion_tokens, started_at
       FROM execution_logs
       WHERE session_id = ?`
    )
    .all(sessionId) as Array<{
    message_id: string | null
    agent_id: string
    status: string
    latency_ms: number | null
    prompt_tokens: number | null
    completion_tokens: number | null
    started_at: string | null
  }>
}

export function getAgentSessionStats(
  agentId: string,
  sessionId: string
): { session_prompt: number; session_completion: number } {
  return db
    .prepare(
      `SELECT
         COALESCE(SUM(prompt_tokens), 0) AS session_prompt,
         COALESCE(SUM(completion_tokens), 0) AS session_completion
       FROM execution_logs
       WHERE agent_id = ? AND session_id = ? AND status = 'completed'`
    )
    .get(agentId, sessionId) as { session_prompt: number; session_completion: number }
}

// ─── 写入 ──────────────────────────────────────────────

export function insertExecutionLog(
  id: string,
  sessionId: string,
  agentId: string,
  triggeredByMessageId: string,
  traceId: string
): void {
  db.prepare(
    `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, trace_id, status, started_at)
     VALUES (?, ?, ?, ?, ?, 'running', datetime('now'))`
  ).run(id, sessionId, agentId, triggeredByMessageId, traceId)
}

/** 标记执行完成/失败。
 *  replyMessageId：成功路径写回本次回复的消息 id（洞 A 精确判据——重启恢复时
 *  message_id 非空即已回复，不再用时间窗把后续其他回复误判成本次回复）；
 *  失败/中断路径不传保持 NULL，恢复回退时间窗判据。
 *  errorType：L1 错误分类桶（W1 契约）——必须与 status/error_message **同一条
 *  UPDATE** 带走（finalize 按 agent 最新 running 定位、无 id，二次更新在重启
 *  恢复时会把恢复后新执行的错误错配到旧行）。 */
export function finalizeExecutionLog(
  agentId: string,
  status: 'completed' | 'failed',
  latencyMs: number | null,
  errorMessage: string | null,
  replyMessageId: string | null = null,
  errorType: string | null = null
): void {
  db.prepare(
    `UPDATE execution_logs
     SET status = ?, ended_at = datetime('now'),
         latency_ms = ?, error_message = ?, message_id = ?, error_type = ?
     WHERE agent_id = ? AND status = 'running'
     ORDER BY started_at DESC LIMIT 1`
  ).run(status, latencyMs, errorMessage, replyMessageId, errorType, agentId)
}

/** 写回诊断数据（延迟、安装包、token 统计等） */
export function updateExecutionLogDiagnostics(
  agentId: string,
  data: {
    latencyMs: number
    packagesInstalled: string
    promptChars: number
    replyChars: number
    promptTokens: number
    completionTokens: number
  }
): void {
  db.prepare(
    `UPDATE execution_logs
     SET latency_ms = ?,
         packages_installed = ?,
         prompt_chars = ?,
         reply_chars = ?,
         prompt_tokens = ?,
         completion_tokens = ?
     WHERE agent_id = ? AND status = 'running'
     ORDER BY started_at DESC LIMIT 1`
  ).run(
    data.latencyMs,
    data.packagesInstalled,
    data.promptChars,
    data.replyChars,
    data.promptTokens,
    data.completionTokens,
    agentId
  )
}

export function updateExecutionLogCommitHash(
  triggeredByMessageId: string,
  commitHash: string
): void {
  db.prepare('UPDATE execution_logs SET commit_hash = ? WHERE triggered_by_message_id = ?').run(
    commitHash,
    triggeredByMessageId
  )
}

/** post-commit 写回：把本次 commit 的 hash 记到"仍 running 的执行记录"上。
 *  agentId：post-commit → handoff-gen 继承 claude.ts spawn env 注入的
 *  CATSTUDY_AGENT_ID（dispatch 派发子进程自带），按 agent_id 精确命中自己的
 *  执行行——同 uuid 双 running（双猫同时执行，店长一条消息派两单）时
 *  两个 commit 各刷各的行，互不覆盖（eae5a5e 错投 ds猫 竞态根治，双 running
 *  写回互覆实害化后裁决）；无 agentId（开发者终端手动提交，env 不存在）走
 *  fallback：running 过滤 + 全刷，行为与修复前一致。 */
export function updateRunningExecutionCommitHash(
  triggeredByMessageId: string,
  commitHash: string,
  agentId?: string
): { changes: number } {
  if (agentId) {
    return db
      .prepare(
        `UPDATE execution_logs SET commit_hash = ?
         WHERE triggered_by_message_id = ? AND status = 'running' AND agent_id = ?`
      )
      .run(commitHash, triggeredByMessageId, agentId)
  }
  return db
    .prepare(
      `UPDATE execution_logs SET commit_hash = ?
       WHERE triggered_by_message_id = ? AND status = 'running'`
    )
    .run(commitHash, triggeredByMessageId)
}

/** 启动时修复：将所有 running 状态标记为 failed。
 *  error_type 同 UPDATE 落 'server_restart'（W1 契约：infra 桶单独统计，
 *  不进成功率不进告警；同 UPDATE 契约与 finalizeExecutionLog 一致）。 */
export function fixStuckExecutionLogs(): { changes: number } {
  return db
    .prepare(
      `UPDATE execution_logs
       SET status = 'failed',
           ended_at = datetime('now'),
           error_message = 'server_restart',
           error_type = 'server_restart'
       WHERE status = 'running'`
    )
    .run()
}

// ─── 删除 ──────────────────────────────────────────────

export function deleteExecutionLogsByAgent(agentId: string): void {
  db.prepare('DELETE FROM execution_logs WHERE agent_id = ?').run(agentId)
}

export function deleteExecutionLogsBySession(sessionId: string): { changes: number } {
  return db.prepare('DELETE FROM execution_logs WHERE session_id = ?').run(sessionId)
}

export function deleteExecutionLogsByTriggerMessage(triggeredByMessageId: string): void {
  db.prepare('DELETE FROM execution_logs WHERE triggered_by_message_id = ?').run(
    triggeredByMessageId
  )
}

/** 启动时清理：删除已不存在的 Agent 的执行日志 */
export function deleteGhostExecutionLogs(): { changes: number } {
  return db
    .prepare('DELETE FROM execution_logs WHERE agent_id NOT IN (SELECT id FROM agents)')
    .run()
}

export function deleteAllExecutionLogs(): void {
  db.exec('DELETE FROM execution_logs')
}
