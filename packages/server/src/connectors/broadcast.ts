/**
 * 列表级全局广播 helper。
 *
 * 为什么单独一个模块：`trash-purge.ts`（到期清扫）与 `routes/**`（组结构变化、清空回收站）
 * 都要发 `GROUPS_CHANGED`。放在路由层会让非路由模块反向依赖 `routes/**`（T5 收口项），
 * 两处各写一份 `getIO()?.emit(...)` 又会变成同一规则的平行真相源，故下沉到 `connectors/`，
 * 由两处共用。
 */
import { Events } from '@cat-study/shared'
import { getIO } from './socketio.js'

/** 组结构变化后全局广播（受影响的是所有正在看左栏的客户端）。emit 失败不影响响应。 */
export function emitGroupsChanged(): void {
  try {
    getIO()?.emit(Events.GROUPS_CHANGED, {})
  } catch {
    /* emit 失败不影响响应 */
  }
}
