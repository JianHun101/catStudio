/**
 * 删除守卫（T2）：忙碌 / 绑定的**唯一判据**。
 *
 * 为什么单独一个模块：单删（`routes/sessions.ts`）与整组删除（`routes/sessionGroups.ts`）
 * 必须用同一把尺子。复制两份 = 一处修了另一处漏；把 `routes/sessions.ts` 的 helper 借给
 * 组路由又会造出两个路由模块的 ESM 环。
 *
 * 忙碌判据（吐槽猫实测事实 ③）：`status === 'busy' || queueLength > 0`。
 * **不能**写成「槽位里留着 sessionId 就算忙」——idle 槽位仍留 sessionId，会永远 409。
 */
import { connectorBindings as bindingsRepo, type SessionRow } from '../db/repository/index.js'
import { getExecutionEngine } from '../execution/registry.js'

/** 阻塞项 wire 形状（spec §3.2：`sessions: [{ id, title, reason, platform?, externalId? }]`） */
export interface SessionBlocker {
  id: string
  title: string
  reason: 'busy' | 'bound'
  platform?: string
  externalId?: string
}

/**
 * 该会话是否被删除守卫挡住。
 *
 * 忙碌优先于绑定：两者同时成立时，用户能做的第一个动作是「先停执行」；把绑定排在前面会
 * 让用户去解绑后仍然 409。绑定取第一条（同一会话绑多个外部群时，列一个代表性来源即可）。
 */
export function getSessionBlocker(row: SessionRow): SessionBlocker | null {
  const engine = getExecutionEngine()
  const busy =
    engine
      ?.snapshot()
      .some(
        (slot) => slot.sessionId === row.id && (slot.status === 'busy' || slot.queueLength > 0)
      ) ?? false
  if (busy) return { id: row.id, title: row.title, reason: 'busy' }

  const bindings = bindingsRepo.listBindingsBySession(row.id)
  if (bindings.length > 0) {
    return {
      id: row.id,
      title: row.title,
      reason: 'bound',
      platform: bindings[0].platform,
      externalId: bindings[0].external_id,
    }
  }
  return null
}

/** 409 的顶层 error：只要有一个忙碌成员就报 SESSION_BUSY，否则 SESSION_BOUND。 */
export function blockerError(blockers: SessionBlocker[]): 'SESSION_BUSY' | 'SESSION_BOUND' {
  return blockers.some((b) => b.reason === 'busy') ? 'SESSION_BUSY' : 'SESSION_BOUND'
}
