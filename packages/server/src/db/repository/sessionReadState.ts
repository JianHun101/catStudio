/**
 * Session Read State 表查询函数。
 */
import type Database from 'better-sqlite3'
import type { SessionReadStateRow } from './types.js'

let db: Database.Database

export function setRepoDb(dbInst: Database.Database): void {
  db = dbInst
}

export function getLastReadAt(sessionId: string): string | undefined {
  const row = db
    .prepare('SELECT last_read_at FROM session_read_state WHERE session_id = ?')
    .get(sessionId) as SessionReadStateRow | undefined
  return row?.last_read_at
}

export function upsertLastReadAt(sessionId: string): void {
  db.prepare(
    `INSERT INTO session_read_state (session_id, last_read_at)
     VALUES (?, datetime('now'))
     ON CONFLICT(session_id) DO UPDATE SET last_read_at = datetime('now')`
  ).run(sessionId)
}
