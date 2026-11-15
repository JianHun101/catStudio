/**
 * 会话分组路由（T1 活组 CRUD + T2 回收站：整组删除 / 恢复 / 彻底删除）。
 * ADR 0016 / spec `docs/plans/session-groups-trash.md` §3.2。
 *
 * 组名规则：`trim()` 后 1–24 字；空/超长 400；活组重名 409 `{ error: 'GROUP_NAME_TAKEN' }`。
 * 重名判定经 `groupsRepo.getGroupByName`（`COLLATE NOCASE`），建组 / 改名 / 恢复三处共用。
 */
import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import { Events, type SessionConfig, type SessionGroup } from '@cat-study/shared'
import {
  sessionGroups as groupsRepo,
  sessions as sessionsRepo,
  trash as trashRepo,
  type SessionGroupRow,
} from '../db/repository/index.js'
import { getIO } from '../connectors/socketio.js'
import { getExecutionEngine } from '../execution/registry.js'
import { toSessionConfig } from './session-config.js'
import { blockerError, getSessionBlocker } from './trash-guard.js'

const GROUP_NAME_MAX = 24

/** `trim()` 后 1–24 字才合法；非字符串 / 空 / 超长一律 null（路由转 400）。 */
function normalizeGroupName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.trim()
  if (name.length < 1 || name.length > GROUP_NAME_MAX) return null
  return name
}

/** 组结构变化后全局广播（受影响的是所有正在看左栏的客户端）。emit 失败不影响响应。
 *
 *  导出给 `routes/sessions.ts` 的 PATCH 复用：**移动会话**也改变组的成员归属，左栏所有
 *  客户端都要重拉组列表；两处各写一份 `getIO()?.emit(...)` 就是同一规则的平行真相源。 */
export function emitGroupsChanged(): void {
  try {
    getIO()?.emit(Events.GROUPS_CHANGED, {})
  } catch {
    /* emit 失败不影响响应 */
  }
}

/** 全局广播（回收站三事件都是列表级 UI 态）。 */
function emitGlobal(event: string, payload: unknown): void {
  try {
    getIO()?.emit(event, payload)
  } catch {
    /* emit 失败不影响响应 */
  }
}

function toSessionGroup(row: SessionGroupRow & { session_count?: number }): SessionGroup {
  return {
    id: row.id,
    name: row.name,
    collapsed: !!row.collapsed,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sessionCount: row.session_count ?? 0,
  }
}

/** 把 `（恢复 N）` 后缀塞进 24 字上限：只截原名，不截后缀（spec §3.2 恢复重名规则）。 */
function fitWithSuffix(base: string, suffix: string): string {
  return base.slice(0, Math.max(0, GROUP_NAME_MAX - suffix.length)) + suffix
}

/**
 * 恢复重名时挑一个不冲突的名字：`name（恢复）`、`name（恢复 2）`…
 *
 * 判定与唯一索引同口径（`COLLATE NOCASE`）——`Work` 与 `work` 算同名。找不到空位是
 * 病态数据（同一名字最多 99 个已删组），抛错让 500 显式暴露，不静默撞唯一索引。
 */
function pickRestoreName(base: string): string {
  if (!groupsRepo.getGroupByName(base)) return base
  for (let n = 1; n <= 99; n++) {
    const suffix = n === 1 ? '（恢复）' : `（恢复 ${n}）`
    const candidate = fitWithSuffix(base, suffix)
    if (!groupsRepo.getGroupByName(candidate)) return candidate
  }
  throw new Error(`[session-groups] 恢复组名冲突超过 99 次：${base}`)
}

/** 组内未删除会话行（删除守卫的守卫面；顺序按 updated_at DESC 与列表一致）。 */
function liveSessionRows(groupId: string) {
  return groupsRepo
    .listLiveSessionIdsInGroup(groupId)
    .map((id) => sessionsRepo.getSessionById(id))
    .filter((row): row is NonNullable<typeof row> => row !== undefined)
}

export async function sessionGroupRoutes(app: FastifyInstance): Promise<void> {
  // ─── GET /api/session-groups — 活组列表（created_at ASC） ─────────────
  app.get('/api/session-groups', async () => {
    return { groups: groupsRepo.listGroups().map(toSessionGroup) }
  })

  // ─── POST /api/session-groups — 新建分组 ─────────────────────────────
  app.post('/api/session-groups', async (req, reply) => {
    const name = normalizeGroupName((req.body as { name?: unknown } | undefined)?.name)
    if (name === null) {
      return reply.status(400).send({ error: 'GROUP_NAME_INVALID' })
    }
    if (groupsRepo.getGroupByName(name)) {
      return reply.status(409).send({ error: 'GROUP_NAME_TAKEN' })
    }

    const row = groupsRepo.createGroup(uuid(), name)
    emitGroupsChanged()
    return reply.status(201).send(toSessionGroup({ ...row, session_count: 0 }))
  })

  // ─── PATCH /api/session-groups/:id — 改名 / 折叠 ─────────────────────
  app.patch('/api/session-groups/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id
    if (!groupsRepo.getGroupById(id)) {
      return reply.status(404).send({ error: 'GROUP_NOT_FOUND' })
    }

    const body = (req.body ?? {}) as { name?: unknown; collapsed?: unknown }
    let nextName: string | undefined
    if (body.name !== undefined) {
      const normalized = normalizeGroupName(body.name)
      if (normalized === null) {
        return reply.status(400).send({ error: 'GROUP_NAME_INVALID' })
      }
      const existing = groupsRepo.getGroupByName(normalized)
      if (existing && existing.id !== id) {
        return reply.status(409).send({ error: 'GROUP_NAME_TAKEN' })
      }
      nextName = normalized
    }

    let nextCollapsed: boolean | undefined
    if (body.collapsed !== undefined) {
      if (typeof body.collapsed !== 'boolean') {
        return reply.status(400).send({ error: 'GROUP_COLLAPSED_INVALID' })
      }
      nextCollapsed = body.collapsed
    }

    // 两个字段都缺省 = 无操作，返回当前组（幂等，不另造一个「空 PATCH」错误码）
    if (nextName !== undefined) {
      groupsRepo.renameGroup(id, nextName)
    }
    if (nextCollapsed !== undefined) {
      groupsRepo.setGroupCollapsed(id, nextCollapsed)
    }

    const row = groupsRepo.getGroupById(id) as SessionGroupRow
    const count = groupsRepo.listGroups().find((g) => g.id === id)?.session_count ?? 0
    emitGroupsChanged()
    return toSessionGroup({ ...row, session_count: count })
  })

  // ─── DELETE /api/session-groups/:id — 仅解散 / 整组删除 ───────────────
  //
  // 不带 `withSessions`（或非真值）= **仅解散**：组行硬删、会话落未分组、不进回收站。
  // 这个动作不删任何会话，因此**不跑 busy/bound 守卫**（店长裁决：拦它没有道理）。
  //
  // `?withSessions=1` = 组软删 + 同批会话进回收站：
  // - 组内零未删会话（含空组）→ 降级为仅解散，不产生空组条目（组条目恒有 ≥1 条会话）；
  // - 任一成员忙碌/绑定 → 409 且**一行不改**（原子拒绝；守卫先于任何写）。
  app.delete('/api/session-groups/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id
    if (!groupsRepo.getGroupById(id)) {
      return reply.status(404).send({ error: 'GROUP_NOT_FOUND' })
    }

    const withSessions = (req.query as { withSessions?: string } | undefined)?.withSessions
    const trashMode = withSessions === '1' || withSessions === 'true'
    if (!trashMode) {
      groupsRepo.dissolveGroup(id)
      emitGroupsChanged()
      return { mode: 'dissolve', id }
    }

    const liveRows = liveSessionRows(id)
    if (liveRows.length === 0) {
      groupsRepo.dissolveGroup(id)
      emitGroupsChanged()
      return { mode: 'dissolve', id }
    }

    const blockers = liveRows
      .map((row) => getSessionBlocker(row))
      .filter((b): b is NonNullable<typeof b> => b !== null)
    if (blockers.length > 0) {
      return reply.status(409).send({ error: blockerError(blockers), sessions: blockers })
    }

    const deletedAt = new Date().toISOString()
    const { sessionIds } = groupsRepo.trashGroup(id, deletedAt)
    const engine = getExecutionEngine()
    if (engine) {
      for (const sid of sessionIds) engine.disposeSession(sid)
    }
    emitGlobal(Events.SESSION_TRASHED, { sessionIds, groupIds: [id] })
    emitGroupsChanged()
    return { mode: 'trash', id }
  })

  // ─── POST /api/session-groups/:id/restore — 恢复整组 ────────────────
  //
  // 只清与组**同批**的会话（`deleted_at` 精确相等）；组内更早单删的会话留在回收站。
  // 同名活组存在时先改名再清 `deleted_at`（同一事务，顺序反了会撞部分唯一索引）。
  app.post('/api/session-groups/:id/restore', async (req, reply) => {
    const id = (req.params as { id: string }).id
    const group = groupsRepo.getGroupByIdIncludingDeleted(id)
    if (!group || group.deleted_at === null) {
      return reply.status(404).send({ error: 'GROUP_NOT_IN_TRASH' })
    }
    if (group.deleted_at <= trashRepo.trashCutoff()) {
      return reply.status(404).send({ error: 'GROUP_NOT_IN_TRASH' })
    }

    const nextName = pickRestoreName(group.name)
    const { sessionIds } = groupsRepo.restoreGroup(
      id,
      group.deleted_at,
      nextName === group.name ? undefined : nextName
    )
    const restoredGroup = groupsRepo.getGroupById(id)
    if (!restoredGroup) {
      return reply.status(404).send({ error: 'GROUP_NOT_IN_TRASH' })
    }
    const sessions: SessionConfig[] = sessionIds
      .map((sid) => sessionsRepo.getSessionById(sid))
      .filter((row): row is NonNullable<typeof row> => row !== undefined)
      .map(toSessionConfig)

    emitGlobal(Events.SESSION_RESTORED, { groupId: id, sessions })
    emitGroupsChanged()
    const count = groupsRepo.listGroups().find((g) => g.id === id)?.session_count ?? 0
    return { group: toSessionGroup({ ...restoredGroup, session_count: count }), sessions }
  })

  // ─── DELETE /api/session-groups/:id/purge — 彻底删除已删组 ─────────
  app.delete('/api/session-groups/:id/purge', async (req, reply) => {
    const id = (req.params as { id: string }).id
    const group = groupsRepo.getGroupByIdIncludingDeleted(id)
    if (!group) return reply.status(404).send({ error: 'GROUP_NOT_FOUND' })
    if (group.deleted_at === null) {
      return reply.status(409).send({ error: 'GROUP_NOT_TRASHED' })
    }

    const result = trashRepo.purgeGroupBatch(group)
    const engine = getExecutionEngine()
    if (engine) {
      for (const sid of result.sessionIds) engine.disposeSession(sid)
    }
    if (result.sessionIds.length > 0 || result.groupPurged) {
      emitGlobal(Events.SESSION_PURGED, {
        sessionIds: result.sessionIds,
        groupIds: result.groupPurged ? [id] : [],
      })
    }
    if (result.groupPurged) emitGroupsChanged()
    if (!result.groupPurged) {
      return reply.status(500).send({ error: 'GROUP_PURGE_INCOMPLETE' })
    }
    return { id }
  })
}
