/**
 * flow_states / flow_state_events 表读写（契约③ 当前状态 + 审计流水）。
 *
 * 语义（ADR 0014 §4 契约③）：
 * - 「当前状态」= 一个 commit 在主干道走到哪（quality-gate → request-review →
 *   receive-review → 闭环），键 (session_id, commit_sha)，**同事务更新**（状态字段
 *   + 审计流水一起落，要么都成、要么都不成）。
 * - 「下一步」**不落库**——由 execution/flow-state.ts 的纯函数 deriveNextIntent
 *   读当前状态 + 查主链机械算出。本模块只负责记录「当前状态」这一事实 + 审计留痕。
 *
 * 注意：db/repository 各 repo 用模块级 db 单例（setRepoDb 注入）——事务必须在模块
 * 内部自开 db.transaction（参照 chunks.ts 的 deleteChunksByDocPaths /
 * deleteStaleChunkRows 那种「函数内自开事务再立即调用」的本地批事务范式；路由层不包
 * 事务、repo 间无共享事务句柄），否则状态字段与审计流水无法同事务原子落库。
 */
import type Database from 'better-sqlite3'
import { createLogger } from '../../logger.js'
import { nowIso } from './clock.js'
import type { FlowStateRow } from './types.js'

const log = createLogger('flow-state')

let db: Database.Database

export function setRepoDb(dbInst: Database.Database): void {
  db = dbInst
}

/** 读某 commit 当前主干道状态；无记录返回 undefined（还没进入状态机）。 */
export function getFlowState(sessionId: string, commitSha: string): FlowStateRow | undefined {
  return db
    .prepare(
      'SELECT session_id, commit_sha, state, updated_at FROM flow_states WHERE session_id = ? AND commit_sha = ?'
    )
    .get(sessionId, commitSha) as FlowStateRow | undefined
}

/**
 * 记录一次状态迁移（事件发生时同事务更新状态字段 + 写审计流水）。
 *
 * - state：本次事件达成后的主干道状态（事实）；
 * - intent：本次动作语义（供投递信号 intent 字段，如 review_commit/closeout）。
 * 幂等：同 (session_id, commit_sha) 重复记录 → upsert 覆盖当前状态、流水 append 一条
 * （每条历史迁移各有留痕，不覆盖）。返回记录数（恒 1——事务内必落一条状态）。
 */
export function recordFlowTransition(
  sessionId: string,
  commitSha: string,
  state: string,
  intent: string
): { changes: number } {
  const upsert = db.prepare(
    `INSERT INTO flow_states (session_id, commit_sha, state, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id, commit_sha) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`
  )
  const audit = db.prepare(
    `INSERT INTO flow_state_events (session_id, commit_sha, from_state, to_state, intent, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )

  // 记录时间由本层生成（⑤-c）：状态字段与审计流水同一时刻、同一口径（ISO 毫秒）
  const now = nowIso()
  const tx = db.transaction((): void => {
    const prev = getFlowState(sessionId, commitSha)
    upsert.run(sessionId, commitSha, state, now)
    audit.run(sessionId, commitSha, prev?.state ?? null, state, intent, now)
  })
  tx()

  log.info('flow transition recorded', { sessionId, commitSha, state, intent })
  return { changes: 1 }
}
