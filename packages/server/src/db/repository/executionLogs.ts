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
 *  供重启恢复队列使用——重新 dispatch 这些未完成的执行。 */
export function getInterruptedExecutions(): Array<{
  id: string
  session_id: string
  agent_id: string
  triggered_by_message_id: string
  started_at: string
}> {
  return db
    .prepare(
      `SELECT id, session_id, agent_id, triggered_by_message_id, started_at
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
  }>
}

export function getLogsByTriggerMessage(triggeredByMessageId: string): ExecutionLogRow[] {
  return db
    .prepare('SELECT * FROM execution_logs WHERE triggered_by_message_id = ?')
    .all(triggeredByMessageId) as ExecutionLogRow[]
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

/** 标记执行完成/失败 */
export function finalizeExecutionLog(
  agentId: string,
  status: 'completed' | 'failed',
  latencyMs: number | null,
  errorMessage: string | null
): void {
  db.prepare(
    `UPDATE execution_logs
     SET status = ?, ended_at = datetime('now'),
         latency_ms = ?, error_message = ?
     WHERE agent_id = ? AND status = 'running'
     ORDER BY started_at DESC LIMIT 1`
  ).run(status, latencyMs, errorMessage, agentId)
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

/** 启动时修复：将所有 running 状态标记为 failed */
export function fixStuckExecutionLogs(): { changes: number } {
  return db
    .prepare(
      `UPDATE execution_logs
       SET status = 'failed',
           ended_at = datetime('now'),
           error_message = 'server_restart'
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
