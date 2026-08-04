#!/usr/bin/env node
/**
 * skills-bootstrap.mjs — 单源挂载引导
 *
 * 项目根 `skills/` 是唯一真相源；各供应商配置目录下的挂载位（junction/symlink）
 * 指向它。本脚本探测挂载位状态，缺失或失效时重建并报告。
 *
 * 挂载位：
 *   .claude/skills → skills/   （Claude Code，一期唯一真实挂载）
 *   Kimi / Codex / Gemini 挂载位一期未启用（占位，二期按需扩展）
 *
 * 用法：
 *   node scripts/skills-bootstrap.mjs          # 探测 + 修复 + 报告
 *   node scripts/skills-bootstrap.mjs --check  # 只探测报告，不修复（退出码 1=挂载失效）
 *
 * Windows 用 junction（mklink /J 语义，无需管理员权限），POSIX 用目录 symlink。
 * 挂载位本身被 .gitignore 排除，不提交；新 clone 环境由本脚本重建。
 */
import { existsSync, lstatSync, readlinkSync, symlinkSync, mkdirSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = resolve(ROOT, 'skills') // 单源目录（必须存在）
const MOUNTS = [
  { name: 'Claude', path: resolve(ROOT, '.claude', 'skills'), enabled: true },
  // 二期占位：接入 Kimi/Codex/Gemini 猫时在对应配置目录建挂载位
  // { name: 'Kimi', path: resolve(ROOT, '.kimi', 'skills'), enabled: false },
  // { name: 'Codex', path: resolve(ROOT, '.codex', 'skills'), enabled: false },
  // { name: 'Gemini', path: resolve(ROOT, '.gemini', 'skills'), enabled: false },
]

const checkOnly = process.argv.includes('--check')

function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

/** 解析链接目标（readlink 原始值，junction/symlink 均适用） */
function readLinkTarget(p) {
  try {
    return readlinkSync(p)
  } catch {
    return null
  }
}

/** 探测挂载位状态：missing / valid / stale（链接指向的目标不存在）/ not-link（普通目录或文件） */
function probeMount(mount) {
  const { name, path, enabled } = mount
  if (!enabled) return { name, status: 'disabled' }
  if (!existsSync(path)) return { name, path, status: 'missing' }
  if (!isLink(path)) {
    // 普通目录（非链接）——可能是旧版直存结构，视为异常（应重建为链接）
    return { name, path, status: 'not-link' }
  }
  // 链接存在：验证目标可达（相对目标按挂载位所在目录解析）
  const target = readLinkTarget(path)
  if (target === null) return { name, path, status: 'stale' }
  const targetAbs = resolve(dirname(path), target)
  if (!existsSync(targetAbs)) return { name, path, status: 'stale' }
  return { name, path, status: 'valid' }
}

/** 重建挂载位（Windows junction / POSIX symlink） */
function createMount(mount) {
  const { name, path, enabled } = mount
  if (!enabled) return { name, status: 'disabled' }
  if (!existsSync(SOURCE)) {
    console.error(`❌ 单源目录不存在: ${SOURCE} —— 先迁移 skills/ 再跑本脚本`)
    process.exit(1)
  }
  mkdirSync(dirname(path), { recursive: true })
  // 先清理旧挂载位再重建：stale（链接指向失效目标）/ not-link（普通目录/文件）状态下
  // symlinkSync 会抛 EEXIST，必须 rmSync 兜底（missing 场景 force 无副作用）
  rmSync(path, { recursive: true, force: true })
  try {
    const type = process.platform === 'win32' ? 'junction' : 'dir'
    symlinkSync(SOURCE, path, type)
    console.log(`✅ [${name}] 挂载位已创建: ${path} -> ${SOURCE} (${type})`)
    return { name, status: 'created' }
  } catch (err) {
    console.error(`❌ [${name}] 创建挂载位失败: ${path}`, err.message)
    return { name, status: 'error' }
  }
}

function report(results) {
  console.log('')
  console.log('🧰 skill 挂载状态看板')
  console.log('┌─────────┬──────────┐')
  for (const r of results) {
    const statusIcon =
      r.status === 'valid'
        ? '✅'
        : r.status === 'missing' || r.status === 'stale'
          ? '⚠️'
          : r.status === 'disabled'
            ? '⏸️'
            : '❌'
    const detail =
      r.status === 'valid'
        ? 'OK'
        : r.status === 'disabled'
          ? '未启用（二期占位）'
          : r.status === 'missing'
            ? '缺失'
            : r.status === 'stale'
              ? '失效'
              : r.status === 'not-link'
                ? '非链接（旧结构）'
                : r.status
    console.log(`│ ${r.name.padEnd(7)} │ ${statusIcon} ${detail.padEnd(14)} │`)
  }
  console.log('└─────────┴──────────┘')
  const bad = results.filter(
    (r) =>
      r.status === 'missing' ||
      r.status === 'stale' ||
      r.status === 'not-link' ||
      r.status === 'error'
  )
  if (bad.length > 0) {
    console.log(`\n⚠️  ${bad.length} 个挂载位异常 —— 运行以下命令修复:`)
    console.log('   node scripts/skills-bootstrap.mjs')
    return false
  }
  console.log('\n✅ 全部挂载位正常（无挂载环境的 CI/新机器上缺失位由 bootstrap 重建，不阻塞）')
  return true
}

// ── main ─────────────────────────────────────────────

if (!existsSync(SOURCE)) {
  console.error(`❌ 单源目录不存在: ${SOURCE}`)
  console.error('   请先执行迁移（git mv 后目录应位于项目根 skills/）')
  process.exit(1)
}

const probes = MOUNTS.map(probeMount)
const broken = probes.filter((r) => r.status !== 'valid' && r.status !== 'disabled')

if (broken.length > 0 && !checkOnly) {
  console.log(`🛠  发现 ${broken.length} 个异常挂载位，正在重建...`)
  for (const p of broken) {
    createMount(MOUNTS.find((m) => m.name === p.name))
  }
  const ok = report(MOUNTS.map(probeMount))
  process.exit(ok ? 0 : 1)
} else {
  const ok = report(probes)
  if (broken.length > 0 && checkOnly) {
    console.log('\n（--check 模式：未修复，需运行无 --check 版本）')
  }
  process.exit(ok ? 0 : 1)
}
