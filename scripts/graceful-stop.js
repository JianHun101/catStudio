/**
 * 优雅停服策略（票巳 (b)）—— 写关停请求 → **有界**宽限窗等自退 → 超窗兜底硬杀。
 *
 * 为什么从 dev.js 抽出：dev.js 是顶层 await 的启动脚本（import 即起 server），
 * 不可被 vitest import。而「宽限窗必须有界、超窗必须硬杀」是 **D4 承重反例**
 * （无上界 = 真卡死时按钮重启彻底失效），必须可测 —— 照 `restart-gate.js` 范式
 * 抽成兄弟模块（scripts/graceful-stop.test.js，scripts/ 已是第四个 vitest 项目）。
 *
 * 为什么用文件不用信号：Windows 上 `child.kill()` = `TerminateProcess`，**不投递
 * 信号**（实测子进程处理函数零执行）⇒ 照抄仓内 `.restart-request` 的文件握手范式。
 *
 * 与 server 侧（`packages/server/src/shutdown-request.ts`）的契约：
 * - 文件名 `.shutdown-request`，与 `.restart-request` **同一目录**（不得复用后者文件名：
 *   dev.js 的重启 watcher 会把它当重启请求触发）
 * - **存在即请求**，内容不参与判定 ⇒ 本模块写**空文件**
 * - 读方读后即删；写方在宽限窗结束后兜底删（server 被硬杀时没机会消费）
 */

import fs from 'node:fs'

/**
 * 关停请求文件名（与 server 侧 `SHUTDOWN_REQUEST_FILE` 同名，目录由调用侧给）。
 * ⚠️ 不得改成 `.restart-request`——那会被 dev.js 的重启 watcher 当重启请求触发。
 */
export const SHUTDOWN_REQUEST_FILE_NAME = '.shutdown-request'

/**
 * 宽限窗（毫秒）。**必须有界**（D4 承重反例）。
 *
 * 取值依据（真机日志实测，`packages/server/data/cat-study.log`）：三次 SIGINT 关停
 * 「shutting down...」→ 新进程「server started」= **3.75s / 4.48s / 6.35s**，而这段
 * 还**含新进程 tsx 冷启 + DB 迁移** ⇒ 旧进程自身关停远低于此。5s 覆盖全部观测值，
 * 且等于 dev.js 既有 `setInterval(pollRestart, 5000)` 的轮询粒度——不给重启路径引入
 * 比现状更细的等待面。
 */
export const SHUTDOWN_GRACE_MS = 5000

/** 宽限窗内的轮询步长（只影响「退出被观测到」的延迟，不影响上界） */
const POLL_STEP_MS = 100

/**
 * 停掉一个子进程：优雅优先，超窗兜底硬杀。
 *
 * @param {{pid:number, exitCode:number|null, once:(ev:string, cb:Function)=>void}|null} child
 *   目标子进程（null / 已退出 ⇒ 直接返回，不写文件不硬杀）
 * @param {object} opts
 * @param {string} opts.requestFile 关停请求文件绝对路径
 * @param {(pid:number)=>void} opts.killTree 兜底硬杀（dev.js 的 killTree）
 * @param {number} [opts.graceMs] 宽限窗（测试注入；生产用 SHUTDOWN_GRACE_MS）
 * @param {()=>number} [opts.now] 时钟（测试注入）
 * @param {(ms:number)=>Promise<void>} [opts.sleep] 等待（测试注入）
 * @param {number} [opts.pollStepMs]
 * @param {(msg:string)=>void} [opts.log]
 * @param {(msg:string)=>void} [opts.warn]
 * @returns {Promise<{graceful:boolean, waitedMs:number}>} graceful=false ⇒ 走了兜底硬杀
 */
export async function stopProcessGracefully(child, opts) {
  const {
    requestFile,
    killTree,
    graceMs = SHUTDOWN_GRACE_MS,
    now = Date.now,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    pollStepMs = POLL_STEP_MS,
    log = console.log,
    warn = console.warn,
  } = opts

  if (!child || child.exitCode !== null) return { graceful: true, waitedMs: 0 }

  const t0 = now()
  let exited = false
  child.once('exit', () => {
    exited = true
  })

  try {
    fs.writeFileSync(requestFile, '') // 空文件 = 契约 7「存在即请求，内容不参与判定」
    log('[dev] 已写 .shutdown-request，等待 server 优雅退出...')
  } catch (err) {
    // 写不进去不是「不关了」——兜底硬杀仍在，只是退化成本票要修的老行为
    warn(`[dev] 写 .shutdown-request 失败：${err.message}（直接走兜底硬杀）`)
  }

  // ⚠️ 有界循环：`now() - t0 < graceMs` 是**承重**上界（D4）。去掉/改成无界
  //    等于「真卡死时按钮重启卡死」——比不优雅严重得多。
  while (!exited && now() - t0 < graceMs) await sleep(pollStepMs)

  if (exited) {
    log(`[dev] server 已优雅退出（${now() - t0}ms）`)
  } else {
    log(`[dev] 宽限窗 ${graceMs}ms 内未退出，兜底强杀 (pid=${child.pid})`)
    killTree(child.pid)
  }

  // 契约 4 写方兜底：server 被硬杀时没机会消费文件，残留会把下一个 server 打掉
  // （server 侧 clearStaleShutdownRequest 是第二道；这里删不掉也不影响重启）
  try {
    fs.unlinkSync(requestFile)
  } catch {}

  return { graceful: exited, waitedMs: now() - t0 }
}
