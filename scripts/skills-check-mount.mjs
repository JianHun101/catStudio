#!/usr/bin/env node
/**
 * skills-check-mount.mjs — 挂载看板 + 完整性检查
 *
 * 单源 `skills/` 下每个 skill 目录必须通过挂载位可见（Claude 一期）；
 * 输出逐 skill 看板（Claude/Kimi/Codex/Gemini 四列，Kimi 起二期占位）。
 *
 * 用法：
 *   node scripts/skills-check-mount.mjs          # 看板模式：完整输出
 *   node scripts/skills-check-mount.mjs --check  # 门禁模式：无挂载位幂等跳过（CI/新机器），
 *                                                # 挂载存在但 skill 不可见 → exit 1
 *
 * lint-staged 挂载此脚本（--check）：提交时校验单源 ↔ 挂载位一致性。
 * 无挂载环境（CI/新机器未跑 bootstrap）不阻塞提交——挂载由 bootstrap 重建。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = resolve(ROOT, 'skills')
const MOUNT_POINT = resolve(ROOT, '.claude', 'skills') // Claude 挂载位（junction/symlink）

const checkOnly = process.argv.includes('--check')

/** 单源下的 skill 目录（顶级目录，排除 manifest/refs/BOOTSTRAP 等非 skill 条目） */
function listSkillDirs() {
  if (!existsSync(SOURCE)) return []
  return readdirSync(SOURCE)
    .filter((d) => statSync(resolve(SOURCE, d)).isDirectory())
    .filter((d) => existsSync(resolve(SOURCE, d, 'SKILL.md')))
    .sort()
}

function main() {
  const skills = listSkillDirs()
  if (skills.length === 0) {
    console.error(`❌ 单源目录无 skill: ${SOURCE}`)
    process.exit(1)
  }

  // ── 挂载位状态 ────────────────────────────────
  const mountExists = existsSync(MOUNT_POINT)

  if (!mountExists) {
    // 无挂载环境：幂等跳过（不阻塞提交），看板模式提示修复
    console.log(
      `⏸️  挂载位不存在: ${MOUNT_POINT}（CI/新机器属预期——跑 scripts/skills-bootstrap.mjs 重建）`
    )
    if (checkOnly) {
      console.log(`✅ 幂等跳过（${skills.length} 个 skill 仅单源校验）`)
      process.exit(0)
    }
    console.log(`\n📋 单源 skill 清单（${skills.length} 个）：${skills.join(', ')}`)
    process.exit(0)
  }

  // ── 逐 skill 可见性检查 ────────────────────────
  const missing = []
  for (const s of skills) {
    if (!existsSync(resolve(MOUNT_POINT, s, 'SKILL.md'))) missing.push(s)
  }

  if (checkOnly) {
    if (missing.length > 0) {
      console.error(
        `❌ 挂载位存在但 ${missing.length} 个 skill 不可见（挂载失效?）: ${missing.join(', ')}`
      )
      console.error('   修复: node scripts/skills-bootstrap.mjs')
      process.exit(1)
    }
    console.log(`✅ 挂载位完整：${skills.length} 个 skill 全部通过 ${MOUNT_POINT} 可见`)
    process.exit(0)
  }

  // ── 看板模式 ───────────────────────────────────
  console.log('')
  console.log('🧩 skill 挂载看板')
  console.log(`   单源: ${SOURCE}`)
  console.log(`   挂载: ${MOUNT_POINT} → skills/`)
  console.log('')
  const head = `│ ${'skill'.padEnd(28)} │ Claude │ Kimi │ Codex │ Gemini │`
  console.log('┌' + '─'.repeat(head.length - 2) + '┐')
  console.log(head)
  console.log('├' + '─'.repeat(head.length - 2) + '┤')
  for (const s of skills) {
    const visible = existsSync(resolve(MOUNT_POINT, s, 'SKILL.md')) ? '✅' : '❌'
    // Kimi/Codex/Gemini 一期占位（未启用 → 显示 ⏸️）
    console.log(`│ ${s.padEnd(28)} │ ${visible}    │ ⏸️    │ ⏸️     │ ⏸️     │`)
  }
  console.log('└' + '─'.repeat(head.length - 2) + '┘')
  console.log('')
  if (missing.length > 0) {
    console.log(`⚠️  ${missing.length} 个 skill 在挂载位不可见: ${missing.join(', ')}`)
    console.log('   修复: node scripts/skills-bootstrap.mjs')
    process.exit(1)
  }
  console.log(`✅ 全部 ${skills.length} 个 skill 可见可用`)
  process.exit(0)
}

main()
