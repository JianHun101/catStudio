/**
 * CatStudy 开发启动器。
 *
 * 直接启动 server + web 进程，不依赖 pnpm --parallel（避免 Windows shell 问题）。
 * 通过 node 直接执行 tsx / vite 的 JS 入口，无需 .cmd 文件。
 *
 * Server 使用 tsx watch 模式：TypeScript 源文件变更时自动重启。
 * Agent 修改代码 → tsx 检测变更 → 自动重启 → 加载新代码。
 *
 * 用法: node scripts/dev.js  或  pnpm dev
 */

import { spawn } from 'node:child_process'
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
    try { process.kill(pid, 'SIGKILL') } catch {}
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

// ─── 启动 Server（tsx watch 模式） ─────────────────

const serverChild = spawn(
  process.execPath,
  [TSX_CLI, 'watch', 'packages/server/src/index.ts'],
  {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, FORCE_COLOR: '1' },
  },
)

serverChild.on('error', (err) => {
  console.error('[dev] server 进程启动失败:', err.message)
})

children.add(serverChild)

// 轮询等待 server 就绪，再启动 web（固定 500ms 不够，尤其是冷启动）
const PORT = parseInt(process.env.PORT || '3200', 10)
const HEALTH_URL = `http://127.0.0.1:${PORT}/api/health`

for (let i = 0; i < 60; i++) {
  try {
    const res = await fetch(HEALTH_URL)
    if (res.ok) {
      console.log(`[dev] server ready after ${i}s`)
      break
    }
  } catch {
    // 还没就绪，继续等
  }
  if (i === 0) console.log('[dev] waiting for server...')
  await new Promise((r) => setTimeout(r, 1000))
}

// ─── 启动 Web (Vite) ─────────────────────────────
// Vite 需要在 web 包目录下运行（index.html 和 vite.config.ts 都在那里）

const webChild = spawn(
  process.execPath,
  [VITE_CLI, '--host', '0.0.0.0'],
  {
    cwd: PKG_DIRS.web,
    stdio: 'inherit',
    env: { ...process.env, FORCE_COLOR: '1' },
  },
)

webChild.on('error', (err) => {
  console.error('[dev] web 进程启动失败:', err.message)
})

children.add(webChild)

// ─── 退出处理 ─────────────────────────────────────

const EXIT_TIMEOUT = 2000

function shutdown(signal) {
  console.log(`\n[dev] 收到 ${signal}，关闭所有子进程...`)
  killAll()
  setTimeout(() => {
    console.log('[dev] 退出')
    process.exit(0)
  }, EXIT_TIMEOUT)
}

// 子进程退出时清理
serverChild.on('exit', (code) => {
  children.delete(serverChild)
  if (children.size === 0) {
    console.log(`[dev] 全部退出 (code=${code ?? '?'})`)
    killAll()
    process.exit(code || 0)
  }
})

webChild.on('exit', (code) => {
  children.delete(webChild)
  if (children.size === 0) {
    console.log(`[dev] 全部退出 (code=${code ?? '?'})`)
    killAll()
    process.exit(code || 0)
  }
})

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('exit', () => killAll())
