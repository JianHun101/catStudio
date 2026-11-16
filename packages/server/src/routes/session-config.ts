/**
 * `SessionRow`（DB snake_case）→ `SessionConfig`（wire camelCase）的投影。
 *
 * 为什么单独一个模块：`routes/sessions.ts` 与 `routes/sessionGroups.ts`（整组恢复要回
 * `SESSION_RESTORED.sessions: SessionConfig[]`）都要用同一份投影。抄第二份必然漂移
 * （一处加了字段、另一处没加，前端拿到两种形状）——这正是 `toMessageDto` 注释里说的
 * 同一条纪律。
 */
import type { SessionConfig } from '@cat-study/shared'
import type { SessionRow } from '../db/repository/index.js'

export function toSessionConfig(row: SessionRow): SessionConfig {
  return {
    id: row.id,
    title: row.title,
    agentIds: JSON.parse(row.agent_ids || '[]'),
    broadcastMode: !!row.broadcast_mode,
    createdAt: row.created_at.replace(' ', 'T') + 'Z',
    updatedAt: row.updated_at.replace(' ', 'T') + 'Z',
    handoffFrom: row.handoff_from || null,
    runningSummary: row.running_summary || null,
    groupId: row.group_id ?? null,
  }
}
