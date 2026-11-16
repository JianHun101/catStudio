/**
 * 回收站到期清扫接线（T2；spec §2.3 / §3.3）。
 *
 * 为什么从 `index.ts` 抽出来：清扫是「DB 清除 + 广播 + 清引擎槽位」三段合成，`index.ts`
 * 的 `main()` 一被 import 就会起服务、没法单测。抽出这个纯接线函数后，定时器与启动调用
 * 仍留在 `index.ts`（只做 `runTrashPurge(phase)`），而「清掉的行有没有广播出去」有测试缝。
 *
 * 广播口径（审查 P2-1）：
 * - 实际清掉会话/组 → 全局 `SESSION_PURGED`，payload = 本次 id 列表；
 * - 有组被删 → 补 `GROUPS_CHANGED`（左栏组列表要重拉）；
 * - 启动那次 `getIO()` 仍是 null（`createSocketIO` 在 `listen` 之后）→ 自然 no-op。
 *
 * 槽位口径（审查 P2-2）：清扫是物理删除，DB 写成功后必须清引擎内该会话的槽位；失败只记
 * 日志、下一轮重试，**不**因广播/清理失败回滚已删的行。
 */
import { Events } from '@cat-study/shared'
import { trash as trashRepo } from './db/repository/index.js'
import { getIO } from './connectors/socketio.js'
import { getExecutionEngine } from './execution/registry.js'
import { emitGroupsChanged } from './connectors/broadcast.js'
import { createLogger } from './logger.js'
import { messageOf } from './utils.js'

const log = createLogger('trash-purge')

/** 启动一次 + 每小时一次；`phase` 只用于日志，不改变行为（启动时 `getIO()` 为 null）。 */
export function runTrashPurge(phase: 'startup' | 'hourly'): void {
  try {
    const result = trashRepo.purgeExpiredTrash()
    if (result.skipped !== 'probe' && (result.groups > 0 || result.sessions > 0)) {
      log.info('trash purge', { phase, ...result })
    }
    if (result.sessionIds.length === 0 && result.groupIds.length === 0) return

    // 物理删除已完成（每条会话各自事务）→ 清引擎槽位，防 (agentId, sessionId) 只增不减
    const engine = getExecutionEngine()
    if (engine) {
      for (const id of result.sessionIds) engine.disposeSession(id)
    }

    try {
      getIO()?.emit(Events.SESSION_PURGED, {
        sessionIds: result.sessionIds,
        groupIds: result.groupIds,
      })
      if (result.groupIds.length > 0) emitGroupsChanged()
    } catch {
      /* 广播失败不影响已提交的清除 */
    }
  } catch (err: any) {
    log.error('trash purge crashed (non-blocking)', { phase, error: messageOf(err) })
  }
}
