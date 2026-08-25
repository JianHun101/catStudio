/**
 * Execution — 引擎实例态（3.5 刀：模块态 → 实例态）。
 *
 * 第 2/3 刀从 socketio.ts 迁出的 6 个模块级 Map/计数收进 createEngineState()
 * 工厂产生的实例字段：run 注册表（activeAborts+activeStreams 合并）、撤回标记、
 * 锁引用计数、M1 频控、mention 配额。生产单实例（connector createSocketIO 持有，
 * 重复创建 fail-fast——热重启双注册表防护）；测试每用例新造实例天然隔离。
 *
 * 依赖方向：reply/serial 经参数消费本实例；connector 经引擎 accessor
 * （setRetraction/listActiveStreams/abortAgent/getActiveStream）寻址——
 * internal.ts 经 socketio 委托函数零改动。
 *
 * .agent-busy 锁文件本体保留（server↔dev.js 跨进程信号，实例状态替代不了，
 * ADR 决策 10）——实例化的是引用计数，不是文件。
 */

import { existsSync, writeFileSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { createLogger } from '../logger.js'

const log = createLogger('socketio')

/** 流状态条目（JOIN_SESSION 打字气泡恢复 / internal.ts 信号校验共用形状） */
export interface StreamState {
  sessionId: string
  messageId: string
  content: string
  token: string
}

/**
 * Run 注册表条目（3.5 刀合并 activeAborts + activeStreams）：
 * 同一 agent 的 abort 控制器与流状态共享一个 key——finalizeRun 单点 endRun
 * 同时收口两者（此前两条 Map 各自 delete，失败漏斗漏过 stream 清理）。
 * 生命周期：registerAbort（执行体启动，先于 runAgentReply）→ setActiveStream
 * 逐 chunk 更新 → endRun（finalizeRun 统一出口）。deleteActiveStream 只清
 * stream 字段不动 abort——流退出（撤回/超时提前返回）后执行体仍持有
 * abort 注册表项，AGENT_INTERRUPT 在收口前仍可寻址。
 */
interface RunEntry {
  abort?: AbortController
  stream?: StreamState
}

/** 引擎实例态——方法形态 accessor（Maps 私有，实例间零共享） */
export interface EngineState {
  // ─── Run 注册表 ─────────────────────────────────
  registerAbort(agentId: string, controller: AbortController): void
  setActiveStream(agentId: string, stream: StreamState): void
  getActiveStream(agentId: string): StreamState | undefined
  listActiveStreams(): Array<[string, StreamState]>
  /** 注销流状态（runAgentReply 撤回/超时出口）——只清 stream 字段，abort 保留 */
  deleteActiveStream(agentId: string): void
  /** 注销整个 run 条目（finalizeRun 统一出口，幂等） */
  endRun(agentId: string): void
  /** AGENT_INTERRUPT handler 用：abort 该 agent 当前执行体；有执行中返回 true */
  abortAgent(agentId: string): boolean

  // ─── 撤回标记 ───────────────────────────────────
  hasRetraction(messageId: string): boolean
  setRetraction(messageId: string): void
  clearRetraction(messageId: string): void

  // ─── Agent 执行锁（引用计数；文件本体归本模块管） ──
  acquireLock(): void
  releaseLock(): void

  // ─── M1 频控 ───────────────────────────────────
  maybeWarnM1(agentId: string): boolean

  // ─── Mention 配额（engine 级字段——跨 run 存活，按 trace 顶层收尾清空） ──
  getMentionCount(traceId: string, agentId: string): number
  setMentionCount(traceId: string, agentId: string, count: number): void
  clearMentionCountsForTrace(traceId: string): void

  // ─── 测试钩子（仅测试用，生产路径不调用） ────────
  __test_reset(): void
  __test_resetLockState(): void
  __test_resetMentionCounts(): void
  __test_resetM1Warned(): void
  __test_resetRuns(): void
}

/** Agent 执行锁文件路径 — 项目根目录下的 .agent-busy（见文件头注释） */
const LOCK_FILE = resolve(process.cwd(), '.agent-busy')

/** M1 防线频控窗口（5 分钟内同猫不重复告警） */
const M1_WARN_INTERVAL_MS = 5 * 60 * 1000

export function createEngineState(): EngineState {
  // ─── 实例字段 ──────────────────────────────────
  const runs = new Map<string, RunEntry>()
  const retractions = new Map<string, boolean>()
  const m1WarnedAt = new Map<string, number>()
  const mentionCounts = new Map<string, number>()
  let lockRefCount = 0

  return {
    // ─── Run 注册表 ───────────────────────────────

    registerAbort(agentId, controller) {
      const entry = runs.get(agentId) ?? {}
      entry.abort = controller
      runs.set(agentId, entry)
    },

    setActiveStream(agentId, stream) {
      const entry = runs.get(agentId) ?? {}
      entry.stream = stream
      runs.set(agentId, entry)
    },

    getActiveStream(agentId) {
      return runs.get(agentId)?.stream
    },

    listActiveStreams() {
      const out: Array<[string, StreamState]> = []
      for (const [agentId, entry] of runs) {
        if (entry.stream) out.push([agentId, entry.stream])
      }
      return out
    },

    deleteActiveStream(agentId) {
      const entry = runs.get(agentId)
      if (!entry) return
      entry.stream = undefined
    },

    endRun(agentId) {
      runs.delete(agentId)
    },

    abortAgent(agentId) {
      const entry = runs.get(agentId)
      if (!entry?.abort) return false
      entry.abort.abort()
      return true
    },

    // ─── 撤回标记 ─────────────────────────────────

    hasRetraction(messageId) {
      return retractions.get(messageId) === true
    },

    setRetraction(messageId) {
      retractions.set(messageId, true)
    },

    clearRetraction(messageId) {
      retractions.delete(messageId)
    },

    // ─── Agent 执行锁 ─────────────────────────────
    // 引用计数——每个 Claude 执行体 acquire/release 严格配对，归零才删文件。
    // 改造前 lockAcquired 是 executeAgentsSerial 的循环外变量：同消息 @ 多
    // Claude agent 时 A 完成后即删锁、B 执行期间无锁 → dev.js 误判空闲触发
    // 重启打断 B（派活单审查发现，实施必做项顺带根治）

    acquireLock() {
      lockRefCount++
      if (lockRefCount === 1 && !existsSync(LOCK_FILE)) {
        writeFileSync(LOCK_FILE, String(process.pid))
        log.info('agent busy lock acquired', { pid: process.pid })
      }
    },

    releaseLock() {
      if (lockRefCount <= 0) {
        log.warn('agent busy lock released with no holders', { lockRefCount })
        return
      }
      lockRefCount--
      if (lockRefCount === 0 && existsSync(LOCK_FILE)) {
        unlinkSync(LOCK_FILE)
        log.info('agent busy lock released')
      }
    },

    // ─── M1 频控 ─────────────────────────────────

    maybeWarnM1(agentId) {
      const now = Date.now()
      const last = m1WarnedAt.get(agentId) || 0
      if (now - last < M1_WARN_INTERVAL_MS) return false
      m1WarnedAt.set(agentId, now)
      return true
    },

    // ─── Mention 配额 ─────────────────────────────

    getMentionCount(traceId, agentId) {
      return mentionCounts.get(`${traceId}:${agentId}`) || 0
    },

    setMentionCount(traceId, agentId, count) {
      mentionCounts.set(`${traceId}:${agentId}`, count)
    },

    clearMentionCountsForTrace(traceId) {
      for (const key of mentionCounts.keys()) {
        if (key.startsWith(`${traceId}:`)) {
          mentionCounts.delete(key)
        }
      }
    },

    // ─── 测试钩子 ─────────────────────────────────

    __test_reset() {
      runs.clear()
      retractions.clear()
      m1WarnedAt.clear()
      mentionCounts.clear()
      lockRefCount = 0
      if (existsSync(LOCK_FILE)) unlinkSync(LOCK_FILE)
    },

    __test_resetLockState() {
      lockRefCount = 0
      if (existsSync(LOCK_FILE)) unlinkSync(LOCK_FILE)
    },

    __test_resetMentionCounts() {
      mentionCounts.clear()
    },

    __test_resetM1Warned() {
      m1WarnedAt.clear()
    },

    __test_resetRuns() {
      runs.clear()
    },
  }
}
