/**
 * Execution — 执行路径模块态（第 2/3 刀从 socketio.ts 迁出，只搬不改）。
 *
 * 3.5 刀将收编为引擎实例字段（run 注册表合并 + finalizeRun 统一）。
 * 测试钩子（__test_*）照 dispatch 惯例：仅测试用，生产路径不调用。
 */

import { existsSync, writeFileSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { createLogger } from '../logger.js'

const log = createLogger('socketio')

// ─── 回复路径（第 2 刀迁入） ─────────────────────────────

/** 正在执行的消息 ID → 是否被撤回（runAgentReply 检查此标志以提前终止） */
const retractionRequests = new Map<string, boolean>()

/** 正在流式输出的 Agent 状态 → { sessionId, messageId, content, token }
 *  JOIN_SESSION 时用于恢复打字气泡（客户端切会话会清空 typingStates）；
 *  token 为本次 spawn 的随机信号 token（internal.ts 精确校验 x-signal-token） */
const activeStreams = new Map<
  string,
  { sessionId: string; messageId: string; content: string; token: string }
>()

/**
 * 只读 getter：internal.ts 校验信号用（不迁移 Map 本体——set/delete 不动，
 * 回归面最小）。依赖方向 internal.ts → execution/state.ts 无环。
 */
export function getActiveStream(
  agentId: string
): { sessionId: string; messageId: string; content: string; token: string } | undefined {
  return activeStreams.get(agentId)
}

/** 撤回标记查询（runAgentReply Window ③ 流中途检查） */
export function hasRetraction(messageId: string): boolean {
  return retractionRequests.get(messageId) === true
}

/** 标记撤回（MESSAGE_RETRACT handler） */
export function setRetraction(messageId: string): void {
  retractionRequests.set(messageId, true)
}

/** 清除撤回标记（runAgentReply 出口 / handler 失败与无执行者清理） */
export function clearRetraction(messageId: string): void {
  retractionRequests.delete(messageId)
}

/** 注册流状态（runAgentReply 流启动 + 逐 chunk 更新） */
export function setActiveStream(
  agentId: string,
  stream: { sessionId: string; messageId: string; content: string; token: string }
): void {
  activeStreams.set(agentId, stream)
}

/** 注销流状态（runAgentReply 三条出口 / executeOneAgent 异常漏斗） */
export function deleteActiveStream(agentId: string): void {
  activeStreams.delete(agentId)
}

/** 流状态条目（JOIN_SESSION 打字气泡恢复遍历） */
export function listActiveStreams(): Array<
  [string, { sessionId: string; messageId: string; content: string; token: string }]
> {
  return Array.from(activeStreams.entries())
}

// ─── 执行循环（第 3 刀迁入） ─────────────────────────────

/** 正在执行的 Agent → 其 AbortController（停止按钮中断思考用）。
 *  executeAgentsSerial 创建后注册、Promise.race 结束路径（正常/异常）清理。
 *  abortController 原本是循环内局部变量外部摸不到——升级为模块级注册表后，
 *  AGENT_INTERRUPT handler 才能跨会话按 agentId 全局寻址（用户手动改 DB 的场景）。 */
const activeAborts = new Map<string, AbortController>()

export function registerAbort(agentId: string, controller: AbortController): void {
  activeAborts.set(agentId, controller)
}

export function unregisterAbort(agentId: string): void {
  activeAborts.delete(agentId)
}

/** AGENT_INTERRUPT handler 用：abort 该 agent 当前执行体；有执行中返回 true */
export function abortAgent(agentId: string): boolean {
  const controller = activeAborts.get(agentId)
  if (!controller) return false
  controller.abort()
  return true
}

// ─── Agent Busy Lock ────────────────────────────────

/** Agent 执行锁文件路径 — 项目根目录下的 .agent-busy。
 *  存在此文件时，dev.js 文件监听器会推迟 tsx 重启，
 *  确保 Agent（Claude Code CLI）完成文件编辑后才允许重启。 */
const LOCK_FILE = resolve(process.cwd(), '.agent-busy')

/** Agent 执行锁引用计数——每个 Claude 执行体 acquire/release 严格配对，
 *  归零才删 .agent-busy。改造前 lockAcquired 是 executeAgentsSerial 的循环外
 *  变量：同消息 @ 多 Claude agent 时 A 完成后即删锁、B 执行期间无锁 →
 *  dev.js 误判空闲触发重启打断 B（派活单审查发现，实施必做项顺带根治） */
let lockRefCount = 0

/** 获取 Agent 执行锁（引用计数 +1；首次创建文件——文件已存在则不覆盖，
 *  可能是异常残留或并发实例持有，保留内容只计引用） */
export function acquireLock(): void {
  lockRefCount++
  if (lockRefCount === 1 && !existsSync(LOCK_FILE)) {
    writeFileSync(LOCK_FILE, String(process.pid))
    log.info('agent busy lock acquired', { pid: process.pid })
  }
}

/** 释放 Agent 执行锁（引用计数 -1；归零才删除文件） */
export function releaseLock(): void {
  if (lockRefCount <= 0) {
    log.warn('agent busy lock released with no holders', { lockRefCount })
    return
  }
  lockRefCount--
  if (lockRefCount === 0 && existsSync(LOCK_FILE)) {
    unlinkSync(LOCK_FILE)
    log.info('agent busy lock released')
  }
}

/** 测试钩子：重置锁引用计数并清理锁文件（仅测试用，生产路径不调用） */
export function __test_resetLockState(): void {
  lockRefCount = 0
  if (existsSync(LOCK_FILE)) unlinkSync(LOCK_FILE)
}

// ─── M1 频控 ────────────────────────────────────────

/** M1 防线频控：agentId → 上次告警时间戳（5 分钟内同猫不重复告警） */
const m1WarnedAt = new Map<string, number>()
const M1_WARN_INTERVAL_MS = 5 * 60 * 1000

/** M1 频控：同猫 5 分钟内只告警一次（返回是否应告警） */
export function maybeWarnM1(agentId: string): boolean {
  const now = Date.now()
  const last = m1WarnedAt.get(agentId) || 0
  if (now - last < M1_WARN_INTERVAL_MS) return false
  m1WarnedAt.set(agentId, now)
  return true
}

/** 测试钩子：清空 M1 频控时间戳（测试用例间隔离） */
export function __test_resetM1Warned(): void {
  m1WarnedAt.clear()
}

// ─── Mention 配额 ────────────────────────────────────

/** 追踪每个 Agent 在同一 traceId 下被 @ 的次数（防止无限循环） */
const mentionCounts = new Map<string, number>()

function getMentionKey(traceId: string, agentId: string): string {
  return `${traceId}:${agentId}`
}

/** 读取 mention 计数（生产：配额原子段；测试钩子同名复用） */
export function getMentionCount(traceId: string, agentId: string): number {
  return mentionCounts.get(getMentionKey(traceId, agentId)) || 0
}

/** 写入 mention 计数（生产：预留/递增；测试钩子同名复用） */
export function setMentionCount(traceId: string, agentId: string, count: number): void {
  mentionCounts.set(getMentionKey(traceId, agentId), count)
}

/** 顶层收尾：清空该 trace 的全部配额（depth=0 结束时） */
export function clearMentionCountsForTrace(traceId: string): void {
  for (const key of mentionCounts.keys()) {
    if (key.startsWith(`${traceId}:`)) {
      mentionCounts.delete(key)
    }
  }
}

/** 测试钩子别名（socketio.test.ts 经 re-export 引用；生产路径不调用） */
export const __getMentionCount = getMentionCount
export const __setMentionCount = setMentionCount

/** 测试钩子：重置 mention 计数（仅测试用，生产路径不调用） */
export function __test_resetMentionCounts(): void {
  mentionCounts.clear()
}
