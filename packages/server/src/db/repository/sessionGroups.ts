/**
 * Session 分组表查询函数（T1：分组管收纳，ADR 0016）。
 *
 * 口径（spec `docs/plans/session-groups-trash.md` §2.1 / §4.1）：
 * - 单归属：一个会话最多属于一个组；组无嵌套、无 position，按 `created_at ASC`。
 * - 组名唯一只约束**活组**（部分唯一索引 `ux_session_groups_name_live`）。
 * - 折叠态落在服务端（`collapsed`），多 tab 一致，迁移出的「归档」组默认折叠。
 * - 组内会话数只统计 `deleted_at IS NULL` 的行（回收站里的会话不算组内可见会话）。
 *
 * 本文件在 T1 只做「活组」的 CRUD + 仅解散；软删 / 恢复 / 彻底删除是 T2 的面
 * （`session_groups.deleted_at` 列已建好，但本票不写入）。
 */
import type Database from 'better-sqlite3'
import { nowIso } from './time.js'

let db: Database.Database

export function setRepoDb(dbInst: Database.Database): void {
  db = dbInst
}

/** `session_groups` 行（snake_case，与库列同名） */
export interface SessionGroupRow {
  id: string
  name: string
  /** 0 / 1——SQLite 没有布尔列 */
  collapsed: number
  /** ISO 毫秒 UTC */
  created_at: string
  /** ISO 毫秒 UTC */
  updated_at: string
  /** ISO 毫秒 UTC；NULL = 活组（T2 起写入） */
  deleted_at: string | null
}

/** 列表投影：组行 + 组内未删除会话数（`sessionCount` 的唯一算法在 `listGroups` 的 SQL 里） */
export interface SessionGroupWithCount extends SessionGroupRow {
  session_count: number
}

/** 活组列表（`created_at ASC`），带组内未删除会话数。 */
export function listGroups(): SessionGroupWithCount[] {
  return db
    .prepare(
      `SELECT g.*,
              (SELECT COUNT(*) FROM sessions s
                WHERE s.group_id = g.id AND s.deleted_at IS NULL) AS session_count
         FROM session_groups g
        WHERE g.deleted_at IS NULL
        ORDER BY g.created_at ASC, g.id ASC`
    )
    .all() as SessionGroupWithCount[]
}

/** 按 id 取**活组**（已删组当作不存在——T1 尚未写 deleted_at，语义先钉住）。 */
export function getGroupById(id: string): SessionGroupRow | undefined {
  return db.prepare('SELECT * FROM session_groups WHERE id = ? AND deleted_at IS NULL').get(id) as
    SessionGroupRow | undefined
}

/** 按名字取活组（组名唯一索引只约束活组）。 */
export function getGroupByName(name: string): SessionGroupRow | undefined {
  return db
    .prepare('SELECT * FROM session_groups WHERE name = ? AND deleted_at IS NULL')
    .get(name) as SessionGroupRow | undefined
}

/** 新建组。id 由调用方生成（与 POST /api/sessions 同款）；重名由路由先查后拒。 */
export function createGroup(id: string, name: string): SessionGroupRow {
  const now = nowIso()
  db.prepare(
    `INSERT INTO session_groups (id, name, collapsed, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?)`
  ).run(id, name, now, now)
  return getGroupById(id) as SessionGroupRow
}

/** 改名。组 `updated_at` 跟着动（组自身的元数据变更），**不碰** `sessions.updated_at`。 */
export function renameGroup(id: string, name: string): SessionGroupRow | undefined {
  db.prepare(
    'UPDATE session_groups SET name = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL'
  ).run(name, nowIso(), id)
  return getGroupById(id)
}

/** 折叠/展开。折叠态是组自身状态，落库才能多 tab 一致、迁移组默认折叠。 */
export function setGroupCollapsed(id: string, collapsed: boolean): SessionGroupRow | undefined {
  db.prepare(
    'UPDATE session_groups SET collapsed = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL'
  ).run(collapsed ? 1 : 0, nowIso(), id)
  return getGroupById(id)
}

/**
 * 仅解散：组行**硬删**，组内会话 `group_id = NULL`（落未分组），会话不进回收站、
 * `deleted_at` 与 `updated_at` 都不动。
 *
 * 同一事务里显式置 NULL + 删组：FK `ON DELETE SET NULL` 本可代劳，但显式写让「解散 =
 * 会话落未分组」这条语义留在本函数正文里，不依赖建表时的 FK 动作（读代码的人不必去
 * 迁移文件里追）。两条语句在一个事务里，崩在中间不会留下「组没了、会话还指着它」。
 */
export function dissolveGroup(id: string): void {
  const run = db.transaction(() => {
    db.prepare('UPDATE sessions SET group_id = NULL WHERE group_id = ?').run(id)
    db.prepare('DELETE FROM session_groups WHERE id = ?').run(id)
  })
  run()
}
