/**
 * CatStudy 开发启动器。
 *
 * 直接启动 server + web 进程，不依赖 pnpm --parallel（避免 Windows shell 问题）。
 * 通过 node 直接执行 tsx / vite 的 JS 入口，无需 .cmd 文件。
 *
 * Server 使用 tsx 运行 + fs.watch 自定义文件监听，
 * 替代 tsx watch 以避免 Agent（Claude Code CLI）编辑 src/ 下的文件时
 * 触发立即重启 → 杀死正在执行的 Agent。
 *
 * 机制：
 *   fs.watch 检测到 .ts 文件变更 → 检查 .agent-busy 锁文件
 *     → 锁存在 → 进入"推迟模式"，每秒轮询等待锁释放
 *     → 锁不存在 → 立即重启 server
 *
 * 用法: node scripts/dev.js  或  pnpm dev
 */

import { spawn, execSync } from 'node:child_process'
import { watch, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

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
/** 推迟重启标志：有文件变更但锁文件存在时为 true */
let pendingRestart = false

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
    // 推迟重启期间 server 退出是预期的（我们在主动杀进程），不退出 dev
    if (pendingRestart) return
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

// ─── 文件监听 + 推迟重启 ─────────────────────

let restartTimer = null

// 监听 packages/server/src 下的 .ts 文件变更
// fs.watch 在 Windows 上 recursive: true 是原生支持的（ReadDirectoryChangesW），
// 但极少数情况下可能丢事件或 filename 为 null——
// 此场景下只需要"有变更"信号即可，不要求精确文件名。
// 如果 Windows 上丢事件严重，可换 chokidar：npm install chokidar
const srcDir = path.join(ROOT, 'packages', 'server', 'src')
const watcher = watch(srcDir, { recursive: true }, (_event, filename) => {
  // 只关注 .ts 文件变更
  if (filename && !filename.endsWith('.ts')) return

  // 防抖：500ms 内的多次变更合并为一次重启
  clearTimeout(restartTimer)

  restartTimer = setTimeout(async () => {
    if (existsSync(LOCK_FILE)) {
      if (!isServerAlive()) {
        // 锁文件还在但进程已死 → 孤儿锁，强制重启
        await restartWithRetry('孤儿锁检测到，强制重启 server...')
      } else {
        if (!pendingRestart) {
          console.log('[dev] Agent 执行中，推迟重启...')
          pendingRestart = true
        }
      }
    } else {
      await restartWithRetry('文件变更，重启 server...')
    }
  }, 500)
})

// 推迟模式下的轮询：每秒检查锁文件是否已释放
setInterval(async () => {
  if (pendingRestart && (!existsSync(LOCK_FILE) || !isServerAlive())) {
    pendingRestart = false
    await restartWithRetry('Agent 完成，执行延迟重启')
  }
}, 1000)

// ─── 退出处理 ─────────────────────────────────

const EXIT_TIMEOUT = 2000

function shutdown(signal) {
  console.log(`\n[dev] 收到 ${signal}，关闭所有子进程...`)
  watcher.close()
  killAll()
  setTimeout(() => {
    console.log('[dev] 退出')
    process.exit(0)
  }, EXIT_TIMEOUT)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('exit', () => killAll())
