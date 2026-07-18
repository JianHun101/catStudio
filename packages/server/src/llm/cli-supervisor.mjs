/**
 * CLI Supervisor — 防止孤儿 CLI 子进程。
 *
 * 在父进程（CatStudy server）和 CLI 子进程（Claude Code / Codex）之间
 * 插入一层监督进程。每 1 秒检查父进程是否存活：
 *   - 父进程存活 → 正常工作，透传 stdin/stdout/stderr
 *   - 父进程死亡 → SIGTERM → 3s → SIGKILL 终止 CLI 子进程
 *
 * 用法（由 cli-utils.ts 内部使用，不直接调用）:
 *   node cli-supervisor.mjs -- <cli-bin> [args...]
 *
 * 环境变量:
 *   CATSTUDY_SUPERVISOR_PARENT_PID — 要监控的父进程 PID
 */

import { spawn } from 'node:child_process'

const PARENT_PID = parseInt(process.env.CATSTUDY_SUPERVISOR_PARENT_PID || '', 10)
const GRACE_MS = 3000
const POLL_MS = 1000

if (!PARENT_PID || isNaN(PARENT_PID)) {
  console.error('[supervisor] CATSTUDY_SUPERVISOR_PARENT_PID 未设置，退出')
  process.exit(1)
}

// 解析命令行：node supervisor.mjs -- claude -p "..." --output-format stream-json
const dashDash = process.argv.indexOf('--')
if (dashDash === -1) {
  console.error('[supervisor] 用法: node cli-supervisor.mjs -- <command> [args...]')
  process.exit(1)
}

const command = process.argv[dashDash + 1]
const args = process.argv.slice(dashDash + 2)

if (!command) {
  console.error('[supervisor] 未指定要监督的命令')
  process.exit(1)
}

// ─── 检查父进程是否存活 ──────────────────────────
function isParentAlive() {
  try {
    // signal 0 = 只检查权限，不发送实际信号
    process.kill(PARENT_PID, 0)
    return true
  } catch {
    return false
  }
}

// ─── 启动 CLI 子进程 ─────────────────────────────
// stdin 使用 pipe（提示词可能超过 Windows 命令行 32K 限制，通过 stdin 传入），
// stdout/stderr 使用 inherit 透传给父进程。
const child = spawn(command, args, {
  stdio: ['pipe', 'inherit', 'inherit'],
  shell: false,
})

// 转发父进程（server）写入的 stdin 数据到 CLI 子进程。
// pipe() 会在源流结束时自动结束目标流。
process.stdin.pipe(child.stdin)
process.stdin.on('error', () => {
  child.stdin.end()
})

// 记录启动信息（写入父进程的 stderr，和 CLI 输出混在一起）
process.stderr.write(
  `[supervisor] pid=${process.pid} parent=${PARENT_PID} child=${child.pid} cmd=${command}\n`,
)

// ─── 父进程存活监控 ─────────────────────────────
let parentDead = false

const poller = setInterval(() => {
  if (!isParentAlive()) {
    parentDead = true
    clearInterval(poller)
    process.stderr.write(
      `[supervisor] 父进程 ${PARENT_PID} 已退出，终止子进程 ${child.pid}...\n`,
    )
    child.kill('SIGTERM')
    setTimeout(() => {
      if (!child.killed && child.exitCode === null) {
        process.stderr.write(
          `[supervisor] SIGTERM 未响应，SIGKILL 子进程 ${child.pid}\n`,
        )
        child.kill('SIGKILL')
      }
    }, GRACE_MS)
  }
}, POLL_MS)

// ─── CLI 子进程退出时清理 ────────────────────────
child.on('close', (code, signal) => {
  clearInterval(poller)
  if (!parentDead) {
    process.stderr.write(
      `[supervisor] 子进程 ${child.pid} 退出 code=${code} signal=${signal}\n`,
    )
  }
  process.exit(code || 0)
})

// ─── 透传自身收到的信号 ─────────────────────────
process.on('SIGTERM', () => child.kill('SIGTERM'))
process.on('SIGINT', () => child.kill('SIGINT'))
