/**
 * CatStudy 开发启动器。
 *
 * 直接启动 server + web 进程，不依赖 pnpm --parallel（避免 Windows shell 问题）。
 * 通过 node 直接执行 tsx / vite 的 JS 入口，无需 .cmd 文件。
 *
 * Server 使用 tsx 运行，不监听文件变更自动重启——文件变更热重启已退役
 * （Agent 编辑 src/ 下的文件触发立即重启 → 杀死正在执行的 Agent；
 * 7f69535 的保护窗也只能推迟、不能阻止）。保存代码仅打提示日志，
 * 重启全面收归用户确认制。
 *
 * 机制（重启只发生在用户确认之后）：
 *   店长发「【重启请求】原因：xxx」→ 用户点前端 [确认重启] → server 写
 *   .restart-request（state=confirmed）→ dev.js 执行重启（Agent 执行中则
 *   等待执行结束，保护窗）→ 写 .restart-done 供新 server 广播「重启完成」。
 *
 * 用法: node scripts/dev.js  或  pnpm dev
 */

import { spawn, execSync } from 'node:child_process'
import { watch, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { decideRestartAction } from './restart-gate.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const isWindows = process.platform === 'win32'

// 映射包名 → node_modules 路径
const PKG_DIRS = {
  server: path.join(ROOT, 'packages', 'server'),
  web: path.join(ROOT, 'packages', 'web'),
}

// tsx CLI 入口（node 直接执行，避过 tsx.cmd / shell:true 的问题）
const TSX_CLI = path.join(PKG_DIRS.server, 'node_modules', 'tsx', 'dist', 'cli.mjs')
// Vite CLI 入口
const VITE_CLI = path.join(PKG_DIRS.web, 'node_modules', 'vite', 'bin', 'vite.js')

// Agent 执行锁文件（与 socketio.ts 中 LOCK_FILE 路径一致）
const LOCK_FILE = path.join(ROOT, '.agent-busy')

// 重启确认机制文件（与 server 侧 restart-request.ts 路径一致）：
// server 写 .restart-request（pending → 用户确认 → confirmed），dev.js 轮询执行重启；
// 重启成功后写 .restart-done 供新 server 广播「重启完成」。
const RESTART_REQUEST_FILE = path.join(ROOT, '.restart-request')
const RESTART_DONE_FILE = path.join(ROOT, '.restart-done')

if (!fs.existsSync(TSX_CLI)) {
  console.error('[dev] 找不到 tsx，请确认已执行 pnpm install')
  process.exit(1)
}
if (!fs.existsSync(VITE_CLI)) {
  console.error('[dev] 找不到 vite，请确认已执行 pnpm install')
  process.exit(1)
}

console.log('[dev] tsx:', TSX_CLI)
console.log('[dev] vite:', VITE_CLI)

/** 跟踪所有子进程 */
const children = new Set()

/** 强制杀进程（Windows: taskkill /T 杀整棵进程树） */
function killTree(pid) {
  if (!isWindows) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
    return
  }
  try {
    spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' })
  } catch {}
}

/** 终止所有子进程 */
function killAll() {
  for (const child of children) {
    if (child.exitCode !== null) continue
    killTree(child.pid)
  }
  children.clear()
}

// ─── Server 进程管理 ─────────────────────────

let serverChild = null

/** 检查 server 进程是否还活着。
 *  先用 spawn 引用判断，再读锁文件里的 PID 做兜底。 */
function isServerAlive() {
  // A：spawn 子进程引用还活着
  if (serverChild && serverChild.exitCode === null) return true

  // B：读锁文件中的 PID 验证
  if (existsSync(LOCK_FILE)) {
    try {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8').trim(), 10)
      if (!isNaN(pid)) {
        process.kill(pid, 0) // ESRCH = PID 不存在
        return true
      }
    } catch (e) {
      if (e.code !== 'ESRCH') throw e
    }
  }

  return false
}

// ─── 执行保护窗：.agent-busy 锁 或 execution_logs 有 running 执行 ─────────
// 只服务用户确认重启（文件变更热重启已退役，见「文件监听」区块）：用户点
// 「确认重启」的瞬间若有 agent 在执行，等它跑完才动手。判据：锁文件 或
// execution_logs 有 running 执行 → 推迟。锁文件只覆盖 Claude agent
// （needsLock），且存在「锁释放→重启」收尾窗口；被打断的执行在
// execution_logs 里仍为 running——故用 node:sqlite（Node v24 内置
// DatabaseSync，零依赖）只读打开 server 的 SQLite（WAL 只读查询可行），
// 覆盖所有 provider 所有执行（比锁更全），finalizeExecutionLog 执行结束后
// 立即更新 → 判据实时。
const DB_FILE = path.join(ROOT, 'packages', 'server', 'data', 'cat-study.db')
let runningDb = null
let runningDbFailed = false

/** 是否有正在执行的 agent（execution_logs.status='running' 计数 > 0） */
function hasRunningExecutions() {
  if (runningDbFailed) return false
  try {
    if (!runningDb) runningDb = new DatabaseSync(DB_FILE, { readOnly: true })
    const row = runningDb
      .prepare("SELECT COUNT(*) AS cnt FROM execution_logs WHERE status = 'running'")
      .get()
    return row.cnt > 0
  } catch (e) {
    // DB 打开失败（首次启动 DB 未初始化 / WAL 恢复不可读等）→ 退化仅锁判据，
    // 不引入新故障面；标记失败避免每轮都重试打开
    runningDbFailed = true
    console.warn(`[dev] execution_logs 读取失败，退化仅锁文件判据（${e.message}）`)
    return false
  }
}

/** 清理孤儿锁：server 已死但 .agent-busy 还在 → 删除 */
function cleanupDeadLock() {
  if (!existsSync(LOCK_FILE)) return
  if (isServerAlive()) return

  let pidHint = '?'
  try {
    pidHint = fs.readFileSync(LOCK_FILE, 'utf-8').trim()
  } catch {}

  console.log(`[dev] 检测到孤儿锁 (pid=${pidHint})，清理后重启`)
  fs.unlinkSync(LOCK_FILE)
}

/**
 * 带重试的 server 重启。
 * 首次 waitForServer 失败后，等 2s / 4s / 8s 再试（最多 3 次重试）。
 * 全部失败后继续周期性重试（每 30s），而不是静默放弃。
 */
async function restartWithRetry(reason) {
  console.log(`[dev] ${reason}`)

  const maxRetries = 3
  let baseDelay = 2000

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      console.log(`[dev] 重试第 ${attempt} 次 (${baseDelay / 1000}s 后)...`)
      await new Promise((r) => setTimeout(r, baseDelay))
      baseDelay *= 2
    }

    startServer()
    const ok = await waitForServer()
    if (ok) return true

    // 启动失败 → 确保旧进程彻底死掉，释放端口
    if (serverChild && serverChild.exitCode === null) {
      killTree(serverChild.pid)
    }
  }

  // 全部重试失败 → 不放弃，设定一个长间隔定时器持续尝试
  console.error('[dev] server 重启失败（已重试 3 次），每 30s 继续尝试...')
  const keepTrying = setInterval(async () => {
    console.log('[dev] 再次尝试重启 server...')
    startServer()
    const ok = await waitForServer()
    if (ok) {
      console.log('[dev] server 恢复!')
      clearInterval(keepTrying)
    }
  }, 30_000)
  return false
}

function startServer() {
  cleanupDeadLock()

  // 杀掉旧 server 进程
  if (serverChild && serverChild.exitCode === null) {
    console.log('[dev] 终止旧 server 进程 (pid=' + serverChild.pid + ')')
    killTree(serverChild.pid)
    children.delete(serverChild)
  }

  serverChild = spawn(process.execPath, [TSX_CLI, 'packages/server/src/index.ts'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, FORCE_COLOR: '1' },
  })

  serverChild.on('error', (err) => {
    console.error('[dev] server 进程启动失败:', err.message)
  })

  serverChild.on('exit', (code) => {
    children.delete(serverChild)
    if (children.size === 0) {
      console.log(`[dev] 全部退出 (code=${code ?? '?'})`)
      killAll()
      process.exit(code || 0)
    }
  })

  children.add(serverChild)
  return serverChild
}

async function waitForServer() {
  const PORT = parseInt(process.env.PORT || '3200', 10)
  const HEALTH_URL = `http://127.0.0.1:${PORT}/api/health`

  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(HEALTH_URL)
      if (res.ok) {
        console.log(`[dev] server ready after ${i}s`)
        return true
      }
    } catch {
      // 还没就绪，继续等
    }
    if (i === 0) console.log('[dev] waiting for server...')
    await new Promise((r) => setTimeout(r, 1000))
  }
  console.error('[dev] server 启动超时 (60s)')
  return false
}

// ─── 启动流程 ─────────────────────────────────

// 1. 启动 Server
startServer()
const ready = await waitForServer()
if (!ready) {
  killAll()
  process.exit(1)
}

// 2. 启动 Web (Vite)
const webChild = spawn(process.execPath, [VITE_CLI, '--host', '0.0.0.0'], {
  cwd: PKG_DIRS.web,
  stdio: 'inherit',
  env: { ...process.env, FORCE_COLOR: '1' },
})

webChild.on('error', (err) => {
  console.error('[dev] web 进程启动失败:', err.message)
})

webChild.on('exit', (code) => {
  children.delete(webChild)
  if (children.size === 0) {
    console.log(`[dev] 全部退出 (code=${code ?? '?'})`)
    killAll()
    process.exit(code || 0)
  }
})

children.add(webChild)

// ─── 文件监听（仅提示，不重启） ─────────────────
// 2026-08 架构决策：文件变更热重启退役——Agent 编辑 src/ 下的文件触发立即
// 重启会杀死正在执行的 Agent（店长 5 次、flash猫 2 次事故），保护窗也只能
// 推迟、不能阻止。现在保存代码仅打提示日志（「变更未生效」可见性，不重启、
// 不打断），重启只发生在用户确认之后（下方「重启确认机制」区块）。
// fs.watch 的 Windows 误报（null 文件名事件，典型：git add -A 全树 stat）
// 最多多打一条提示，不产生任何重启动作——无 a9a9cba 类事故面。
const srcDir = path.join(ROOT, 'packages', 'server', 'src')
let changeNotifyTimer = null
const watcher = watch(srcDir, { recursive: true }, (_event, filename) => {
  // 只关注 .ts 文件变更
  if (filename && !filename.endsWith('.ts')) return

  // 防抖：500ms 内的多次变更合并为一次提示
  clearTimeout(changeNotifyTimer)
  changeNotifyTimer = setTimeout(() => {
    console.log(
      '[dev] 检测到 server 代码变更——未生效，需重启才能生效（重启走「重启请求」确认制，不会自动重启）'
    )
  }, 500)
})

// ─── 重启确认机制（fs.watch 事件 + 5s 兜底轮询双路径） ──────────────────
// 店长发「【重启请求】原因：xxx」消息 → 用户点前端 [确认重启] → server 写
// .restart-request（state=confirmed）→ 消费端双保险：fs.watch 事件路径（即时）
// + 5s 兜底轮询路径（可靠，事件双丢失最坏 5s 内仍执行），共用 pollRestart()，
// restartInProgress 天然去重双路径。处理语义：confirmed 且新鲜 → 等 Agent 执行
// 锁释放 → 既有 restartWithRetry 重启 → 写 .restart-done（新 server 启动时广播
// 「重启完成」）→ 删请求文件。过期请求忽略并清理；pending 忽略。
let restartInProgress = false
/** 等待提示已打标志：Agent 执行中等待释放时只提示一次（防 5s 轮询刷屏） */
let restartWaitNotified = false

async function pollRestart() {
  if (restartInProgress) return
  if (!existsSync(RESTART_REQUEST_FILE)) return

  let raw = ''
  try {
    raw = fs.readFileSync(RESTART_REQUEST_FILE, 'utf-8')
  } catch {
    return // 读取竞态（文件刚被删除），下轮再试
  }

  const action = decideRestartAction(raw)
  if (action === 'expired') {
    console.log('[dev] 重启请求已过期（10 分钟有效），忽略并清理')
    try {
      fs.unlinkSync(RESTART_REQUEST_FILE)
    } catch {}
    return
  }
  if (action !== 'restart') return // pending 或内容无效 → 忽略

  // Agent 执行中（.agent-busy 锁存在或 execution_logs 有 running）→ 等待释放
  //（保护窗语义：不抢占 Agent）
  if ((existsSync(LOCK_FILE) || hasRunningExecutions()) && isServerAlive()) {
    if (!restartWaitNotified) {
      console.log('[dev] Agent 执行中，等待执行结束后执行用户确认的重启...')
      restartWaitNotified = true
    }
    return
  }

  restartInProgress = true
  try {
    let req = null
    try {
      req = JSON.parse(raw)
    } catch {}
    const reason = (req && req.reason) || '用户请求'
    const sessionId = (req && req.sessionId) || ''
    restartWaitNotified = false // 下个等待周期重新提示

    console.log(`[dev] 收到用户确认的重启请求（原因：${reason}）`)
    await restartWithRetry(`用户确认重启（原因：${reason}）`)

    // 等健康再写完成标记（restartWithRetry 失败时进入 30s 周期重试，此处兜底等待）
    const healthy = await waitForServer()
    if (healthy) {
      fs.writeFileSync(
        RESTART_DONE_FILE,
        JSON.stringify({ sessionId, reason, completedAt: new Date().toISOString() }, null, 2)
      )
      try {
        fs.unlinkSync(RESTART_REQUEST_FILE)
      } catch {}
      console.log('[dev] 重启完成，已写 .restart-done 通知 server 广播「重启完成」')
    }
  } finally {
    restartInProgress = false
  }
}

// 路径 A：fs.watch 事件驱动（即时）。监听 ROOT 非递归——现有 srcDir watcher 是
// recursive 且只管 src/，.restart-request 在 ROOT 必须新建。回调过滤
// basename === '.restart-request'（大小写归一：Windows 事件文件名大小写可能与
// 写入不一致）；writeFileSync → 'change'、unlinkSync → 'rename' 都处理；
// filename 为 null → 保守重读（误触发无害：重读发现非 confirmed → 忽略）。
// 不做 mtime 误报过滤（历史教训：那正是丢真事件的代码级先例，src watcher
// 曾因此误忽略真变更），不设防抖窗口（重启确认即时性就是收益，重复事件由
// restartInProgress + state 检查天然去重）。
const restartWatcher = watch(ROOT, (_event, filename) => {
  if (filename && path.basename(filename).toLowerCase() !== '.restart-request') return
  pollRestart()
})

// 路径 B：5s 兜底轮询（可靠）。钉死「文件存在即进 pollRestart()」不做存在性
// diff——.restart-request 有原地重写流（updateRestartRequest pending→confirmed
// 写同一条路径），事件双丢失场景下 diff 永不触发、兜底在其存在目的场景里失效；
// 照抄现有 !existsSync return 范式，pollRestart 内部状态判定自然忽略 pending/
// 过期（每 5s 读一个微型 JSON，成本≈零）。
setInterval(pollRestart, 5000)

// ─── 退出处理 ─────────────────────────────────

const EXIT_TIMEOUT = 2000

function shutdown(signal) {
  console.log(`\n[dev] 收到 ${signal}，关闭所有子进程...`)
  watcher.close()
  restartWatcher.close()
  killAll()
  setTimeout(() => {
    console.log('[dev] 退出')
    process.exit(0)
  }, EXIT_TIMEOUT)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('exit', () => killAll())
