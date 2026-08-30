/**
 * push 审批状态机 — git push origin dev 的审批状态唯一 owner。
 *
 * 归宿：git/ 目录（与 diff-collector.ts 同属「push 工作流」地盘）。
 * routes（写：confirm/cancel）与 socketio（读：JOIN 恢复 PUSH_STATUS）同向 import 本模块，
 * 无反向依赖——socketio.ts 退成薄传输层（ADR 0011 决策 1）在 push 线的最后一刀。
 *
 * 与 restart 落文件不同：重启需 dev.js 轮询（跨进程信号），push 由本进程
 * socket/REST handler 直接执行、无跨进程消费者 → 进程内 Map 即可，不必落文件。
 */

import { getMainRepoRoot, gitPushOriginDev } from '../llm/git-utils.js'
import { createLogger } from '../logger.js'

const log = createLogger('push-state')

/** push 审批状态（内存化，messageId → 状态） */
const pushStates = new Map<string, 'pending' | 'pushing' | 'done' | 'failed' | 'cancelled'>()
/** push 终态有界保留上限：done/failed 保留供 JOIN 状态恢复（刷新不回归可点 pending），超上限删最旧防 messageId 无界增长 */
const PUSH_STATES_MAX = 50

export type PushState = 'pending' | 'pushing' | 'done' | 'failed' | 'cancelled'

/**
 * push 审批执行结果（REST + Socket 双入口共用契约）。
 * ok=false 的三种原因：already-pushing（连点短路）、no-main-root（无法定位主仓库根）、
 * failed（git push 执行失败，error 携带远端错误）。业务失败也在 REST 200 返回（状态在 body）。
 */
export type PushConfirmResult = {
  ok: boolean
  state: 'pushing' | 'done' | 'failed'
  reason?: 'already-done' | 'already-pushing' | 'no-main-root' | 'failed'
  error?: string
}

/**
 * push 审批业务核心（REST POST /api/push/confirm 与历史 socket PUSH_CONFIRM 共用）：
 * 执行 git push origin dev。纯业务函数——不含任何 socket.emit（emit 是传输适配层的事）。
 * 镜像原 socket handler 语义：
 * - 已 pushing → already-pushing 短路（连点不二次 push）
 * - 已 done → already-done 幂等返回（终态有界保留供 JOIN 恢复）
 * - getMainRepoRoot() 为 null → no-main-root（不执行 push）
 * - 否则 set pushing → gitPushOriginDev → set done/failed + log → 终态有界裁剪（PUSH_STATES_MAX）
 */
export async function executePushConfirm(messageId: string): Promise<PushConfirmResult> {
  const state = pushStates.get(messageId)
  if (state === 'pushing') {
    return { ok: false, state: 'pushing', reason: 'already-pushing' }
  }
  if (state === 'done') {
    return { ok: true, state: 'done', reason: 'already-done' }
  }
  const mainRoot = getMainRepoRoot()
  if (!mainRoot) {
    return { ok: false, state: 'failed', reason: 'no-main-root' }
  }
  pushStates.set(messageId, 'pushing')
  const res = await gitPushOriginDev(mainRoot)
  if (res.ok) {
    pushStates.set(messageId, 'done')
    log.info('push confirmed and executed', { messageId })
  } else {
    pushStates.set(messageId, 'failed')
    log.error('push failed', { messageId, error: res.error })
  }
  // 终态有界保留：done/failed 保留供 JOIN 状态恢复（刷新后前端不回归可点 pending），
  // 超上限删最旧（Map 插入序）防 messageId 无界增长——1a6c220 立即删除的泄漏治理
  // 改为有界保留，二者都达成「不无界泄漏」，后者额外为 join 恢复提供数据源
  if (pushStates.size > PUSH_STATES_MAX) {
    for (const key of pushStates.keys()) {
      if (pushStates.size <= PUSH_STATES_MAX) break
      if (key !== messageId) pushStates.delete(key)
    }
  }
  if (res.ok) {
    return { ok: true, state: 'done' }
  }
  return { ok: false, state: 'failed', reason: 'failed', error: res.error }
}

/**
 * push 审批取消（REST POST /api/push/cancel 与历史 socket PUSH_CANCEL 共用）：
 * 清除审批态（取消即删除——刷新后回归 pending，可重新批准，push 幂等）。
 */
export function cancelPush(messageId: string): void {
  pushStates.delete(messageId)
  log.info('push request cancelled', { messageId })
}

/** 只读访问器：JOIN 恢复 PUSH_STATUS 用（socketio 不再直接持有 Map） */
export function getPushState(messageId: string): PushState | undefined {
  return pushStates.get(messageId)
}

/** 测试钩子：清空 push 审批状态（测试文件用例间隔离；生产路径不调用） */
export function __test_resetPushStates(): void {
  pushStates.clear()
}
