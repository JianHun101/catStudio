/**
 * Session 表查询函数。
 */
import type Database from 'better-sqlite3'
import type { SessionRow } from './types.js'

let db: Database.Database

export function setRepoDb(dbInst: Database.Database): void {
  db = dbInst
}

// ─── 查询 ──────────────────────────────────────────────

export function getSessionById(id: string): SessionRow | undefined {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined
}

export function getSessionAgentIds(id: string): string[] {
  const row = db.prepare('SELECT agent_ids FROM sessions WHERE id = ?').get(id) as
    { agent_ids: string } | undefined
  if (!row) return []
  try {
    return JSON.parse(row.agent_ids) as string[]
  } catch {
    return []
  }
}

export function getSessionBroadcastMode(id: string): boolean {
  const row = db.prepare('SELECT broadcast_mode FROM sessions WHERE id = ?').get(id) as
    { broadcast_mode: number } | undefined
  return !!row?.broadcast_mode
}

export function getSessionMeta(
  id: string
): { agent_ids: string; broadcast_mode: number } | undefined {
  return db.prepare('SELECT agent_ids, broadcast_mode FROM sessions WHERE id = ?').get(id) as
    { agent_ids: string; broadcast_mode: number } | undefined
}

export function getSessionRunningSummary(id: string): string | null {
  const row = db.prepare('SELECT running_summary FROM sessions WHERE id = ?').get(id) as
    { running_summary: string | null } | undefined
  return row?.running_summary ?? null
}

export function getSessionSummaryState(id: string):
  | {
      running_summary: string | null
      summary_msg_id: string | null
    }
  | undefined {
  return db.prepare('SELECT running_summary, summary_msg_id FROM sessions WHERE id = ?').get(id) as
    { running_summary: string | null; summary_msg_id: string | null } | undefined
}

// ─── 摘要替代压缩（compressed_summaries）──────────────────

/**
 * 读取会话的压缩摘要数组（JSON 字符串原样返回；无压缩历史返回 null）。
 * 条目形状 { createdAt, tokenCount, content }，content 空串 = 异步生成中的 pending。
 */
export function getCompressedSummaries(id: string): string | null {
  const row = db.prepare('SELECT compressed_summaries FROM sessions WHERE id = ?').get(id) as
    { compressed_summaries: string | null } | undefined
  return row?.compressed_summaries ?? null
}

/**
 * append 一条压缩摘要条目（读-改-写 JSON，单进程 better-sqlite3 同步执行无并发写）。
 * 异步路径先落 pending（content 空串），生成完成后回填（updateLastCompressedSummary）。
 */
export function appendCompressedSummary(
  id: string,
  entry: { createdAt: string; tokenCount: number; content: string }
): void {
  let arr: Array<{ createdAt: string; tokenCount: number; content: string }> = []
  const current = getCompressedSummaries(id)
  if (current) {
    try {
      arr = JSON.parse(current)
    } catch {
      arr = []
    }
  }
  arr.push(entry)
  db.prepare(
    `UPDATE sessions SET compressed_summaries = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(JSON.stringify(arr), id)
}

/**
 * 回填最后一条 pending 条目（异步生成完成后的落库点）。
 * 只更新数组末条——append 与回填在同一事件循环同步段内成对出现，末条必是自家 pending。
 */
export function updateLastCompressedSummary(
  id: string,
  patch: { tokenCount: number; content: string }
): void {
  const current = getCompressedSummaries(id)
  if (!current) return
  try {
    const arr = JSON.parse(current) as Array<{
      createdAt: string
      tokenCount: number
      content: string
    }>
    if (!Array.isArray(arr) || arr.length === 0) return
    const last = { ...arr[arr.length - 1], ...patch }
    arr[arr.length - 1] = last
    db.prepare(
      `UPDATE sessions SET compressed_summaries = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(JSON.stringify(arr), id)
  } catch {
    // JSON 损坏视为无历史，静默跳过（读取侧同样容错）
  }
}

export function listAllSessions(): SessionRow[] {
  return db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as SessionRow[]
}

/**
 * 查找父会话的"真实交接"子会话（handoff 去重守卫）。
 *
 * 语义：仅当子会话有 ≥1 条消息时才算真实交接——空壳子会话
 * （0 条消息，前端切换失败产物）不挡二次交接，旧会话才能再次触发
 * performHandoff 并重建子会话。
 */
export function getHandoffChild(parentSessionId: string): { id: string } | undefined {
  return db
    .prepare(
      `SELECT s.id FROM sessions s
       WHERE s.handoff_from = ?
         AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)`
    )
    .get(parentSessionId) as { id: string } | undefined
}

/**
 * 删除父会话下所有空壳子会话（0 条消息，前端切换失败留下的孤儿）。
 * 空壳子会话无消息 → 无执行记录，不存在 FK 阻碍；session_read_state 有 CASCADE。
 * @returns 删除数
 */
export function deleteEmptyHandoffChildren(parentSessionId: string): number {
  const result = db
    .prepare(
      `DELETE FROM sessions
       WHERE handoff_from = ?
         AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id = sessions.id)`
    )
    .run(parentSessionId)
  return result.changes
}

// ─── 写入 ──────────────────────────────────────────────

export function insertSession(
  id: string,
  title: string,
  agentIds: string[],
  broadcastMode?: number,
  handoffFrom?: string,
  runningSummary?: string
): void {
  db.prepare(
    `INSERT INTO sessions (id, title, agent_ids, broadcast_mode, handoff_from, running_summary)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    title,
    JSON.stringify(agentIds),
    broadcastMode ?? 0,
    handoffFrom ?? null,
    runningSummary ?? null
  )
}

export function upsertDemoSession(
  id: string,
  title: string,
  agentIdsJson: string
): { changes: number } {
  return db
    .prepare(
      `INSERT INTO sessions (id, title, agent_ids)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         agent_ids = excluded.agent_ids,
         updated_at = datetime('now')`
    )
    .run(id, title, agentIdsJson) as { changes: number }
}

export function updateSessionTitle(id: string, title: string): void {
  db.prepare(`UPDATE sessions SET title = ?, updated_at = datetime('now') WHERE id = ?`).run(
    title,
    id
  )
}

export function updateSessionBroadcastMode(id: string, broadcastMode: boolean): void {
  db.prepare(
    `UPDATE sessions SET broadcast_mode = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(broadcastMode ? 1 : 0, id)
}

export function updateSessionAgentIds(id: string, agentIdsJson: string): void {
  db.prepare(`UPDATE sessions SET agent_ids = ?, updated_at = datetime('now') WHERE id = ?`).run(
    agentIdsJson,
    id
  )
}

export function updateSessionTimestamp(id: string): void {
  db.prepare(`UPDATE sessions SET updated_at = datetime('now') WHERE id = ?`).run(id)
}

export function updateSessionRunningSummary(
  id: string,
  summary: string,
  summaryMsgId: string
): void {
  db.prepare(
    `UPDATE sessions SET running_summary = ?, summary_msg_id = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(summary, summaryMsgId, id)
}

export function updateSessionSummaryOnly(id: string, summary: string): void {
  db.prepare(
    `UPDATE sessions SET running_summary = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(summary, id)
}

export function deleteSession(id: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
}

export function deleteAllSessions(): void {
  db.exec('DELETE FROM sessions')
}
