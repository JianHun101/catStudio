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

export function listAllSessions(): SessionRow[] {
  return db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as SessionRow[]
}

export function getHandoffChild(parentSessionId: string): { id: string } | undefined {
  return db.prepare('SELECT id FROM sessions WHERE handoff_from = ?').get(parentSessionId) as
    { id: string } | undefined
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
