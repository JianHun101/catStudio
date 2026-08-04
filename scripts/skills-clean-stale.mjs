#!/usr/bin/env node
/**
 * skills-clean-stale.mjs — 清失效挂载链接
 *
 * 挂载位（.claude/skills junction/symlink）目标丢失时，链接残留在文件系统上——
 * 各供应商会看到一堆"文件存在但内容不可见"的假目录。本脚本移除失效链接，
 * 并提示跑 skills-bootstrap.mjs 重建。
 *
 * 用法：
 *   node scripts/skills-clean-stale.mjs          # 检查并清理失效链接
 *   node scripts/skills-clean-stale.mjs --check  # 只检查不清理（exit 1=存在失效链接）
 */
import { existsSync, lstatSync, readlinkSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MOUNT_POINT = resolve(ROOT, '.claude', 'skills')

const checkOnly = process.argv.includes('--check')

function main() {
  const stale = []

  if (existsSync(MOUNT_POINT) && lstatSync(MOUNT_POINT).isSymbolicLink()) {
    try {
      const target = readlinkSync(MOUNT_POINT)
      const targetAbs = resolve(dirname(MOUNT_POINT), target)
      if (!existsSync(targetAbs)) stale.push({ path: MOUNT_POINT, target })
    } catch {
      stale.push({ path: MOUNT_POINT, target: '<不可读>' })
    }
  }

  if (stale.length === 0) {
    console.log('✅ 无失效挂载链接')
    process.exit(0)
  }

  for (const s of stale) {
    console.error(`⚠️  失效链接: ${s.path} -> ${s.target}`)
    if (!checkOnly) {
      rmSync(s.path, { recursive: true, force: true })
      console.error(`   → 已移除。重建: node scripts/skills-bootstrap.mjs`)
    }
  }
  if (checkOnly) {
    console.error(`❌ 存在 ${stale.length} 个失效链接（--check 模式未清理）`)
    console.error(
      '   修复: node scripts/skills-clean-stale.mjs && node scripts/skills-bootstrap.mjs'
    )
    process.exit(1)
  }
  process.exit(0)
}

main()
