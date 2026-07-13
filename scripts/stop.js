/**
 * 强制清理 CatStudy 开发端口上的残留进程。
 *
 * 用法: pnpm stop  (或 node scripts/stop.js)
 */

import { execSync } from 'node:child_process'

const PORTS = [3200, 5173, 5174, 5175]
const isWindows = process.platform === 'win32'

if (!isWindows) {
  console.log('[stop] Unix: 请使用 lsof -ti:<port> | xargs kill')
  for (const port of PORTS) {
    try {
      execSync(`lsof -ti:${port} | xargs kill -9`, { stdio: 'ignore' })
      console.log(`  port ${port}: cleaned`)
    } catch {
      console.log(`  port ${port}: no process`)
    }
  }
  process.exit(0)
}

// Windows
console.log('[stop] 扫描端口...')

for (const port of PORTS) {
  try {
    const result = execSync(`netstat -ano | findstr ":${port}" | findstr "LISTENING"`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    const lines = result.trim().split(/\r?\n/).filter(Boolean)
    const killed = new Set()

    for (const line of lines) {
      const parts = line.trim().split(/\s+/)
      const pid = parts[parts.length - 1]
      if (pid && !killed.has(pid)) {
        killed.add(pid)
        try {
          execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' })
          console.log(`  port ${port}: killed PID ${pid}`)
        } catch {
          console.log(`  port ${port}: PID ${pid} 无法终止`)
        }
      }
    }

    if (killed.size === 0) {
      console.log(`  port ${port}: no process`)
    }
  } catch {
    console.log(`  port ${port}: no process`)
  }
}

console.log('[stop] 完成')
