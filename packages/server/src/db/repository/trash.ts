/**
 * 回收站仓储（T2；ADR 0016 D3/D5；spec `docs/plans/session-groups-trash.md` §2.3 / §4.2）。
 *
 * 职责边界：
 * - **列表**：`listTrash(now)` 产出回收站条目（组条目 / 会话条目两段），粒度 = 删除动作
 *   粒度，不按 `group_id` 聚合。
 * - **物理清除**：`purgeExpiredTrash(now)`（到期清扫，可注入时钟）、`emptyTrash()`（清空）
 *   与单条 / 单组清除的共用实现都在这里。`index.ts` 只调 `purgeExpiredTrash`，不自带 SQL
 *   ——否则「±1 分钟」这类边界没有测试缝。
 * - **不负责**软删 / 恢复（在 `sessions.ts` / `sessionGroups.ts`）：回收站是**读取 + 清除**
 *   面，写入语义留在各自实体的仓储里，避免同一张表的写入规则散成两处。
 *
 * 时间口径：`deleted_at` / `purgeAfter` 一律 ISO 毫秒 UTC；cutoff 由 JS 算好再传，
 * **绝不**与秒级的 `sessions.created_at/updated_at` 同框比较（ISO 首位 `T` 恒大于秒级串
 * 的空格，比较会整片判反）。
 *
 * 归属不重叠：整组删除的同批会话（`group_id` 指向一个 `deleted_at` 与之字符串相等的组）
 * 归**组条目**清；其余已删会话归**会话条目**清。同一行不会被两条路径各清一次。
 */
import type Database from 'better-sqlite3'
import type { TrashEntry } from '@cat-study/shared'
import type { SessionRow } from './types.js'
import { deleteSession } from './sessions.js'
import { deleteGroupRow, type SessionGroupRow } from './sessionGroups.js'
import { deleteMessagesBySession } from './messages.js'
import { deleteExecutionLogsBySession } from './executionLogs.js'
import { isProbeMode } from '../../probe-mode.js'
import { createLogger } from '../../logger.js'

const log = createLogger('trash')

let db: Database.Database

export function setRepoDb(dbInst: Database.Database): void {
  db = dbInst
}

/** 回收站保留期：7 天（spec §2.3；用户可观察的规则，不是环境旋钮） */
export const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000

/** `deleted_at` → 到期时刻（ISO 毫秒）。服务端计算，不信任前端时钟。 */
export function purgeAfterOf(deletedAt: string): string {
  return new Date(Date.parse(deletedAt) + TRASH_RETENTION_MS).toISOString()
}

/** `now` → 回收站保留截止串；`deleted_at > cutoff` = 未过期。 */
export function trashCutoff(now: number = Date.now()): string {
  return new Date(now - TRASH_RETENTION_MS).toISOString()
}

/** 剩余天数：1..7（列表已滤掉过期条目，故不会 <1） */
function daysLeftOf(deletedAt: string, now: number): number {
  const left = Date.parse(purgeAfterOf(deletedAt)) - now
  return Math.max(1, Math.min(7, Math.ceil(left / DAY_MS)))
}

/** 一条组条目里「同批会话」的 id（`deleted_at` 字符串精确相等 = 同一次整组删除） */
function batchSessionIdsOf(group: SessionGroupRow): string[] {
  return (
    db
      .prepare('SELECT id FROM sessions WHERE group_id = ? AND deleted_at = ?')
      .all(group.id, group.deleted_at) as Array<{ id: string }>
  ).map((r) => r.id)
}

/**
 * 回收站条目（`deletedAt DESC`）。
 *
 * - 组条目：组名 + 同批会话数 + 同批消息数；
 * - 会话条目：标题 + 原组名（组已删/已清除也尽力保留名字；行没了就 `null`）+ 消息数；
 * - 只返回**未过期**（`deleted_at > cutoff`）的条目——避免「剩 0 天还能点恢复、点了 404」。
 */
export function listTrash(now: number = Date.now()): TrashEntry[] {
  const cutoff = trashCutoff(now)

  const groups = db
    .prepare(
      `SELECT g.*,
              (SELECT COUNT(*) FROM sessions s
                WHERE s.group_id = g.id AND s.deleted_at = g.deleted_at) AS session_count,
              (SELECT COUNT(*) FROM messages m
                 JOIN sessions s ON s.id = m.session_id
                WHERE s.group_id = g.id AND s.deleted_at = g.deleted_at) AS message_count
         FROM session_groups g
        WHERE g.deleted_at IS NOT NULL AND g.deleted_at > ?
        ORDER BY g.deleted_at DESC, g.id ASC`
    )
    .all(cutoff) as Array<SessionGroupRow & { session_count: number; message_count: number }>

  const sessions = db
    .prepare(
      `SELECT s.*, g.name AS group_name
         FROM sessions s
         LEFT JOIN session_groups g ON g.id = s.group_id
        WHERE s.deleted_at IS NOT NULL AND s.deleted_at > ?
          AND NOT EXISTS (
            SELECT 1 FROM session_groups sg
             WHERE sg.id = s.group_id AND sg.deleted_at = s.deleted_at
          )
        ORDER BY s.deleted_at DESC, s.id ASC`
    )
    .all(cutoff) as Array<SessionRow & { group_name: string | null }>

  const entries: TrashEntry[] = groups.map((g) => ({
    kind: 'group' as const,
    id: g.id,
    name: g.name,
    deletedAt: g.deleted_at as string,
    purgeAfter: purgeAfterOf(g.deleted_at as string),
    daysLeft: daysLeftOf(g.deleted_at as string, now),
    sessionCount: g.session_count,
    messageCount: g.message_count,
    groupId: null,
    groupName: null,
  }))

  for (const s of sessions) {
    const messageCount = (
      db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(s.id) as {
        n: number
      }
    ).n
    entries.push({
      kind: 'session',
      id: s.id,
      name: s.title,
      deletedAt: s.deleted_at as string,
      purgeAfter: purgeAfterOf(s.deleted_at as string),
      daysLeft: daysLeftOf(s.deleted_at as string, now),
      sessionCount: 1,
      messageCount,
      groupId: s.group_id,
      groupName: s.group_name,
    })
  }

  // 跨两类统一按删除时刻倒序（前端按 kind 拆两段，不依赖数组切分顺序）
  entries.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : a.deletedAt > b.deletedAt ? -1 : 0))
  return entries
}

/**
 * 物理清除一条会话（执行日志 → 消息（自带消息侧子行）→ 会话依赖 → 会话行）。
 *
 * **每条会话一个事务**：单条坏数据不阻塞整轮；失败由调用方记日志并在下一轮重试。
 * 复用既有删除链（`deleteExecutionLogsBySession` / `deleteMessagesBySession` /
 * `deleteSession`），不另写一套物理删除顺序。
 */
export function purgeSessionRecord(id: string): void {
  const run = db.transaction(() => {
    deleteExecutionLogsBySession(id)
    deleteMessagesBySession(id)
    deleteSession(id)
  })
  run()
}

/**
 * 清除一个组条目：先逐条清同批会话（各自事务），**全部成功后**最后一个事务删组行。
 *
 * 同批为 0（防御分支）直接删组行；组行删除失败则该组条目下轮重试，已清的会话不会复活。
 * 早先单删的会话（`deleted_at` 与组不等）不碰——它属于会话条目。
 *
 * @returns `sessionIds` = 本次实际清掉的会话 id；`groupPurged` = 组行是否已删
 */
export function purgeGroupBatch(group: SessionGroupRow): {
  sessionIds: string[]
  groupPurged: boolean
} {
  if (group.deleted_at === null) return { sessionIds: [], groupPurged: false }
  const sessionIds = batchSessionIdsOf(group)
  const purged: string[] = []
  for (const sid of sessionIds) {
    try {
      purgeSessionRecord(sid)
      purged.push(sid)
    } catch (err: any) {
      log.warn('purge session of trashed group failed (will retry next round)', {
        groupId: group.id,
        sessionId: sid,
        error: err?.message ?? String(err),
      })
    }
  }
  if (purged.length !== sessionIds.length) {
    // 有会话没清掉 → 组行留着，下轮重试；已经清掉的会话不会复活（行已不存在）
    return { sessionIds: purged, groupPurged: false }
  }
  const tx = db.transaction(() => deleteGroupRow(group.id))
  tx()
  return { sessionIds: purged, groupPurged: true }
}

/**
 * 到期清扫（启动一次 + 每小时由 `index.ts` 调用）。
 *
 * - cutoff 由 JS 生成 ISO 毫秒串，不与秒级列同框比较；
 * - 探针实例跳过（`CATSTUDY_PROBE_MODE=1`；探针的库是副本，清扫会真实删行）；
 * - 组条目先清同批、再删组行；会话条目每条一个事务；
 * - 失败只影响该条目，下一轮重试。
 */
export function purgeExpiredTrash(now: number = Date.now()): {
  groups: number
  sessions: number
  /** 本次实际清掉的会话 id（供接线段发 `SESSION_PURGED` 并清引擎槽位） */
  sessionIds: string[]
  /** 本次实际删掉的组 id（供接线段发 `SESSION_PURGED` / `GROUPS_CHANGED`） */
  groupIds: string[]
  skipped?: 'probe'
} {
  if (isProbeMode()) {
    log.warn('探针模式：跳过回收站到期清扫（不删副本库行）')
    return { groups: 0, sessions: 0, sessionIds: [], groupIds: [], skipped: 'probe' }
  }

  const cutoff = trashCutoff(now)
  const groups = db
    .prepare(
      `SELECT * FROM session_groups
        WHERE deleted_at IS NOT NULL AND deleted_at <= ?
        ORDER BY deleted_at ASC, id ASC`
    )
    .all(cutoff) as SessionGroupRow[]

  let purgedGroups = 0
  let purgedSessions = 0
  const groupIds: string[] = []
  const sessionIds: string[] = []
  for (const group of groups) {
    try {
      const r = purgeGroupBatch(group)
      purgedSessions += r.sessionIds.length
      sessionIds.push(...r.sessionIds)
      if (r.groupPurged) {
        purgedGroups++
        groupIds.push(group.id)
      }
    } catch (err: any) {
      log.error('purge expired group failed (will retry next round)', {
        groupId: group.id,
        error: err?.message ?? String(err),
      })
    }
  }

  const sessions = db
    .prepare(
      `SELECT s.id FROM sessions s
        WHERE s.deleted_at IS NOT NULL AND s.deleted_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM session_groups g
             WHERE g.id = s.group_id AND g.deleted_at = s.deleted_at
          )
        ORDER BY s.deleted_at ASC`
    )
    .all(cutoff) as Array<{ id: string }>

  for (const { id } of sessions) {
    try {
      purgeSessionRecord(id)
      purgedSessions++
      sessionIds.push(id)
    } catch (err: any) {
      log.error('purge expired session failed (will retry next round)', {
        sessionId: id,
        error: err?.message ?? String(err),
      })
    }
  }

  return { groups: purgedGroups, sessions: purgedSessions, sessionIds, groupIds }
}

/**
 * 清空回收站：对**全部**条目执行彻底删除（含过期未扫条目）。
 *
 * 先处理组条目（连带同批会话），再处理剩余会话条目——同一行不会被两条路径各清一次。
 * 返回已清掉的 id，供路由发 `SESSION_PURGED`。
 */
export function emptyTrash(): { groupIds: string[]; sessionIds: string[] } {
  const groupIds: string[] = []
  const sessionIds: string[] = []

  const groups = db
    .prepare('SELECT * FROM session_groups WHERE deleted_at IS NOT NULL ORDER BY deleted_at ASC')
    .all() as SessionGroupRow[]
  for (const group of groups) {
    try {
      const r = purgeGroupBatch(group)
      sessionIds.push(...r.sessionIds)
      if (r.groupPurged) groupIds.push(group.id)
    } catch (err: any) {
      log.error('empty trash: purge group failed', {
        groupId: group.id,
        error: err?.message ?? String(err),
      })
    }
  }

  const sessions = db
    .prepare(
      `SELECT s.id FROM sessions s
        WHERE s.deleted_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM session_groups g
             WHERE g.id = s.group_id AND g.deleted_at = s.deleted_at
          )`
    )
    .all() as Array<{ id: string }>
  for (const { id } of sessions) {
    try {
      purgeSessionRecord(id)
      sessionIds.push(id)
    } catch (err: any) {
      log.error('empty trash: purge session failed', {
        sessionId: id,
        error: err?.message ?? String(err),
      })
    }
  }

  return { groupIds, sessionIds }
}
