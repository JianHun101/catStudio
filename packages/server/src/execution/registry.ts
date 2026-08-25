/**
 * Execution — 单例注册表（第 4 刀）：引擎与 bus 的进程内单点寻址。
 *
 * createSocketIO 构造后注册；ingest / recovery / index.ts 经此寻址——
 * 断开 ingest ↔ socketio 的 ESM 循环（ingest 不再 import connector；
 * getIO 同款服务定位惯例，见 ADR 先例段）。生产恒先注册后使用，
 * 未注册返回 null 由调用点守卫（与 getIO 语义一致）。
 *
 * 双注册表防护由 createSocketIO 的 fail-fast 断言承担（3.5 刀）——
 * 本模块只持有引用，不判重。
 */

import type { EngineBus, HandoffBus } from './bus.js'
import type { ExecutionEngine, ExecutionEngineTestHooks } from './serial.js'

let engine: (ExecutionEngine & ExecutionEngineTestHooks) | null = null
let bus: (EngineBus & HandoffBus) | null = null

export function setExecutionEngine(e: ExecutionEngine & ExecutionEngineTestHooks): void {
  engine = e
}

export function getExecutionEngine(): (ExecutionEngine & ExecutionEngineTestHooks) | null {
  return engine
}

export function setExecutionBus(b: EngineBus & HandoffBus): void {
  bus = b
}

export function getExecutionBus(): (EngineBus & HandoffBus) | null {
  return bus
}

/** 测试钩子：卸载注册表（createSocketIO fail-fast 的用例间复位配套） */
export function __test_reset(): void {
  engine = null
  bus = null
}
