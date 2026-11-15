/**
 * 当前 server 进程身份的唯一内存读点（票 B · 唤醒自检）。
 *
 * 谁写：`index.ts` 在 `insertServerBoot` 成功后**立刻**注册一次（同一 `try/catch`，
 * 采集或入库失败则不注册）。
 *
 * 谁读：`execution/reply.ts` 组装 system prompt 时取 `getRuntimeInstance()`，交给
 * `buildRuntimeSelfCheck` 生成「[运行时自检]」行。
 *
 * **为什么读内存而不查库**：`server_boots` 里既有本进程的行，也有副本库、其他实例、
 * 历史进程的行；「当前进程是谁」只有运行中的进程自己知道。查最新行会在探针库/共享库
 * 场景里读到别人的账（票 B 契约 A）。
 */
export interface RuntimeInstance {
  /** 启动账本主键，UUID */
  bootId: string
  /** ISO 毫秒 UTC，与 `server_boots.started_at` 逐字相同（由写入层产出，不在此重取时间） */
  startedAt: string
  /** 采集面拿不到就是 null，不写空串 */
  gitSha: string | null
  /** 0/1；采集失败是 null（未知 ≠ 干净） */
  gitDirty: number | null
}

let current: RuntimeInstance | null = null

/** 注册当前进程身份（唯一写入点 = 启动序列） */
export function setRuntimeInstance(instance: RuntimeInstance): void {
  current = instance
}

/** 当前进程身份；未注册（测试进程 / 采集失败 / CLI 兜底）返回 null */
export function getRuntimeInstance(): RuntimeInstance | null {
  return current
}

/** 测试钩子：清空注册表，用例间不互相污染 */
export function __test_resetRuntimeInstance(): void {
  current = null
}
