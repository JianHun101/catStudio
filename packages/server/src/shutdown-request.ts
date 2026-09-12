/**
 * 关停请求文件握手 —— **server 侧消费端**（票巳 (b)）。
 *
 * 写方是 dev.js（`scripts/dev.js`，按钮重启杀旧进程之前写空文件），消费方是本模块，
 * 路径常量与 `.restart-request` 同源（`restart-request.ts` 的 `RESTART_FILES_DIR`）。
 *
 * 为什么不是信号：Windows 上 `child.kill()` = `TerminateProcess`，不投递信号 ⇒
 * 只能走文件握手。为什么是**轮询**不是 `fs.watch`：本路径的延迟预算 = dev.js 的
 * 宽限窗（秒级），我们**不需要即时性**；而 `fs.watch` 在 Windows 上有已知的 null
 * 文件名误报（`dev.js` src watcher 注释在案）与事件丢失面 —— 用可靠性换掉一个
 * 并不需要的即时性。轮询成本 = 一次 `existsSync`。
 *
 * 三处契约（票巳契约 4/5/7）在本模块的落点：
 * - **契约 4（陈旧文件清理）**：`clearStaleShutdownRequest()` —— 落盘后若进程没来得及
 *   消费（走了兜底硬杀），**新起的 server 会一启动就自杀**。清理点 = server 启动路径。
 * - **契约 7②（读后即删，删在 shutdown() 之前）**：`consumeShutdownRequest()` 先删后返回，
 *   防宽限窗内自检被重复触发。
 * - **契约 7③（unlink ENOENT 不阻断关停）**：文件已不在是**正常态**（dev.js 兜底清理
 *   可能抢先删掉），任何 unlink 失败都只记日志、不改判定。
 */

import { existsSync, unlinkSync } from 'node:fs'
import { createLogger } from './logger.js'
import { SHUTDOWN_REQUEST_FILE } from './restart-request.js'

const log = createLogger('shutdown-request')

/**
 * 自检轮询间隔。取值依据：宽限窗是**秒级**（dev.js `SHUTDOWN_GRACE_MS`），
 * 200ms 只为把「dev.js 写文件 → server 开始关停」的附加延迟压到可忽略，
 * 同时把轮询成本压在一次 `existsSync`（每 5 秒 25 次，纯 stat，无读文件）。
 */
export const SHUTDOWN_POLL_INTERVAL_MS = 200

/**
 * 消费关停请求：文件存在 ⇒ 删掉并返回 true；不存在 ⇒ false。
 *
 * 契约 7：**存在即请求，内容不解析**（空文件合法）。
 * 任意 unlink 失败（含 ENOENT）都**不阻断**——见文件头契约 7③。
 */
export function consumeShutdownRequest(): boolean {
  if (!existsSync(SHUTDOWN_REQUEST_FILE)) return false
  try {
    unlinkSync(SHUTDOWN_REQUEST_FILE)
  } catch (err: any) {
    // ENOENT = dev.js 兜底清理抢先删了 ⇒ 正常态；其余（EPERM 等）也只记不抛：
    // 关停请求的判定面是「见到过文件」，删不掉不影响这次关停该不该发生。
    log.warn('删除关停请求文件失败（不阻断关停）', { error: err?.message, code: err?.code })
  }
  return true
}

/**
 * 启动路径的防御性清理（契约 4）：清掉陈旧请求文件，防「新 server 一启动就自杀」。
 *
 * 返回是否真的清掉了一个（供调用侧按需记日志 / 测试断言）。
 */
export function clearStaleShutdownRequest(): boolean {
  if (!consumeShutdownRequest()) return false
  log.warn('清理了陈旧的关停请求文件（防新 server 启动即自杀）', { file: SHUTDOWN_REQUEST_FILE })
  return true
}

/** 自检启动项的可注入面（测试用：把轮询间隔压到毫秒级） */
export interface ShutdownWatcherOptions {
  intervalMs?: number
}

/**
 * 起关停请求自检（轮询）。`onRequest` 由调用侧注入（生产 = `shutdown`）。
 *
 * **调用时机必须在 `clearStaleShutdownRequest()` 之后**——否则刚启动就可能被一个
 * 陈旧文件打掉。返回值是停止函数（shutdown 链与测试都靠它收尾，防定时器泄漏）。
 *
 * 单次触发即停：本文件是「一次性请求」，同一次关停不需要第二次回调；
 * 即便文件被重复写入（重入），`shutdown()` 自身的幂等守卫（契约 5）兜底。
 */
export function startShutdownRequestWatcher(
  onRequest: () => void,
  options: ShutdownWatcherOptions = {}
): () => void {
  const intervalMs = options.intervalMs ?? SHUTDOWN_POLL_INTERVAL_MS
  let stopped = false
  const timer = setInterval(() => {
    if (stopped) return
    if (!consumeShutdownRequest()) return
    log.info('收到关停请求（文件握手），走优雅关停')
    onRequest()
  }, intervalMs)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
