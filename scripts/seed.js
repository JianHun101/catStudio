/**
 * CatStudy 种子数据脚本。
 *
 * 创建 3 只演示 Agent + 1 个演示会话。
 * 用法: node scripts/seed.js        (upsert 模式)
 *       node scripts/seed.js --reset (先清空再重建)
 *       pnpm seed                    (同上)
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const TSX_CLI = path.join(ROOT, 'packages', 'server', 'node_modules', 'tsx', 'dist', 'cli.mjs')

if (!fs.existsSync(TSX_CLI)) {
  console.error('[seed] 找不到 tsx，请确认已执行 pnpm install')
  process.exit(1)
}

const seedArgs = process.argv.slice(2)
console.log('[seed]', seedArgs.length > 0 ? seedArgs.join(' ') : '(upsert 模式)')

const child = spawn(
  process.execPath,
  [TSX_CLI, 'packages/server/src/seed.ts', ...seedArgs],
  {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env },
  },
)

child.on('exit', (code) => {
  process.exit(code || 0)
})

child.on('error', (err) => {
  console.error('[seed] 启动失败:', err.message)
  process.exit(1)
})
