/**
 * 会话分组路由（T1：分组管收纳；ADR 0016 / spec `docs/plans/session-groups-trash.md` §3.2）。
 *
 * 本票只交付「活组」：列表 / 建组 / 改名 / 折叠 / 仅解散。软删、恢复、彻底删除与
 * 忙碌/绑定 409 守卫是 T2 的面——本文件在 T2 接 `?withSessions=1`、`/restore`、`/purge`。
 *
 * 组名规则：`trim()` 后 1–24 字；空/超长 400；活组重名 409 `{ error: 'GROUP_NAME_TAKEN' }`。
 */
import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import { Events, type SessionGroup } from '@cat-study/shared'
import { sessionGroups as groupsRepo } from '../db/repository/index.js'
import type { SessionGroupRow } from '../db/repository/index.js'
import { getIO } from '../connectors/socketio.js'

const GROUP_NAME_MAX = 24

/** `trim()` 后 1–24 字才合法；非字符串 / 空 / 超长一律 null（路由转 400）。 */
function normalizeGroupName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.trim()
  if (name.length < 1 || name.length > GROUP_NAME_MAX) return null
  return name
}

/** 组结构变化后全局广播（受影响的是所有正在看左栏的客户端）。emit 失败不影响响应。 */
function emitGroupsChanged(): void {
  try {
    getIO()?.emit(Events.GROUPS_CHANGED, {})
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

  // ─── DELETE /api/session-groups/:id — 仅解散 ─────────────────────────
  //
  // `?withSessions=1`（组软删 + 同批会话进回收站）是 T2 的契约。本票不实现回收站语义，
  // 遇到该参数**显式拒绝**而不是静默按「仅解散」处理——后者会把「删组连带删会话」的
  // 用户意图降级成「只解散」，属于不可见的语义漂移。
  app.delete('/api/session-groups/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id
    const withSessions = (req.query as { withSessions?: string } | undefined)?.withSessions
    if (withSessions !== undefined) {
      return reply.status(400).send({ error: 'SESSION_TRASH_NOT_AVAILABLE' })
    }
    if (!groupsRepo.getGroupById(id)) {
      return reply.status(404).send({ error: 'GROUP_NOT_FOUND' })
    }

    groupsRepo.dissolveGroup(id)
    emitGroupsChanged()
    return { mode: 'dissolve', id }
  })
}
