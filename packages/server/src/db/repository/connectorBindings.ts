/**
 * 连接器绑定表查询函数（外部平台群/私聊 ↔ 会话映射）。
 *
 * 一条绑定 = 外部平台的一个聊天（群号/QQ）映射到一个 cat-study 会话。
 * 唯一约束 (platform, external_type, external_id)：同一外部聊天只能绑定一个会话，
 * 重复 upsert 时更新 session_id（改绑）。
 *
 * 注（2026-09-17 重建后已变）：`session_id` 现有 FK → sessions 且为 **RESTRICT**——
 * 不再是「删会话后绑定变孤儿、webhook 侧静默忽略」的松耦合；删会话前必须先解绑
 * （`deleteConnectorBindingsBySession`，删除路径已接），悬空绑定从此不会存在。
 */
import type Database from 'better-sqlite3'
import { v4 as uuid } from 'uuid'
import { nowIso } from './clock.js'
import type { ConnectorBindingRow } from './types.js'

let db: Database.Database

export function setRepoDb(dbInst: Database.Database): void {
  db = dbInst
}

// ─── 写入 ──────────────────────────────────────────────

/**
 * 创建或更新绑定（唯一键冲突 → 更新 session_id 实现改绑）。
 * @returns 落库后的完整绑定行
 */
export function upsertConnectorBinding(
  platform: string,
  externalType: 'group' | 'private',
  externalId: string,
  sessionId: string
): ConnectorBindingRow {
  db.prepare(
    `INSERT INTO connector_bindings (id, platform, external_type, external_id, session_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(platform, external_type, external_id) DO UPDATE SET
       session_id = excluded.session_id`
  ).run(uuid(), platform, externalType, externalId, sessionId, nowIso())
  return getConnectorBinding(platform, externalType, externalId) as ConnectorBindingRow
}

export function deleteConnectorBinding(
  platform: string,
  externalType: 'group' | 'private',
  externalId: string
): boolean {
  const result = db
    .prepare(
      'DELETE FROM connector_bindings WHERE platform = ? AND external_type = ? AND external_id = ?'
    )
    .run(platform, externalType, externalId)
  return result.changes > 0
}

// ─── 查询 ──────────────────────────────────────────────

export function getConnectorBinding(
  platform: string,
  externalType: 'group' | 'private',
  externalId: string
): ConnectorBindingRow | undefined {
  return db
    .prepare(
      'SELECT * FROM connector_bindings WHERE platform = ? AND external_type = ? AND external_id = ?'
    )
    .get(platform, externalType, externalId) as ConnectorBindingRow | undefined
}

export function listConnectorBindings(platform?: string): ConnectorBindingRow[] {
  if (platform) {
    return db
      .prepare('SELECT * FROM connector_bindings WHERE platform = ? ORDER BY created_at DESC')
      .all(platform) as ConnectorBindingRow[]
  }
  return db
    .prepare('SELECT * FROM connector_bindings ORDER BY created_at DESC')
    .all() as ConnectorBindingRow[]
}

/** 一个会话的所有绑定（P3 出站转发用：agent 回复投递到会话绑定的每个群/私聊） */
export function listBindingsBySession(sessionId: string): ConnectorBindingRow[] {
  return db
    .prepare('SELECT * FROM connector_bindings WHERE session_id = ? ORDER BY created_at DESC')
    .all(sessionId) as ConnectorBindingRow[]
}
