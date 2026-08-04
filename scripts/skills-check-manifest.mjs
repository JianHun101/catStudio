#!/usr/bin/env node
/**
 * skills-check-manifest.mjs — manifest ↔ 目录 ↔ frontmatter 三方一致校验（阻塞）
 *
 * 校验项：
 *   1. manifest.yaml `skills:` 下的登记 ↔ `skills/` 顶级 skill 目录 双向覆盖（40/40）
 *   2. 每个 SKILL.md frontmatter 的 name 与目录名一致、description 存在
 *   3. 每个登记的 skill 有 source 标记（self / mattpocock / external），取值合法
 *   4. catstudy/ 定制层不参与顶级计数（随迁保留，另行校验其 4 个 skill 的 frontmatter）
 *
 * 任一校验失败 → exit 1（阻塞提交/合并）。
 * 本脚本只读单源 `skills/`，不依赖挂载位——CI/新机器天然可跑。
 *
 * 用法：
 *   node scripts/skills-check-manifest.mjs
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = resolve(ROOT, 'skills')
const MANIFEST = resolve(SOURCE, 'manifest.yaml')

const VALID_SOURCES = new Set(['self', 'mattpocock', 'external'])
const NON_SKILL_DIRS = new Set(['catstudy', 'refs']) // 单源内非顶级 skill 的目录

/** 从 manifest.yaml 提取 skills 登记：{ name: { source?, ... } }（手写解析，避免 YAML 依赖） */
function parseManifestSkills() {
  const text = readFileSync(MANIFEST, 'utf8')
  const lines = text.split(/\r?\n/)
  const skills = {}
  let inSkills = false
  let current = null
  for (const line of lines) {
    if (/^skills:$/.test(line)) {
      inSkills = true
      continue
    }
    if (!inSkills) continue
    if (/^\S/.test(line)) break // 顶级键结束（pipeline 等）
    const m = line.match(/^ {2}(\S[^:]*):/)
    if (m) {
      current = m[1]
      skills[current] = {}
      continue
    }
    const kv = line.match(/^ {4}(source):\s*(\S+)/)
    if (kv && current) skills[current][kv[1]] = kv[2]
  }
  return skills
}

/** 读取 SKILL.md frontmatter：{ name?, description? } */
function parseFrontmatter(file) {
  const text = readFileSync(file, 'utf8')
  if (!text.startsWith('---')) return {}
  const end = text.indexOf('\n---', 3)
  if (end === -1) return {}
  const fm = text.slice(3, end)
  const name = fm.match(/^name:\s*(\S+)/m)?.[1]
  const description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim()
  return { name, description }
}

function main() {
  const errors = []

  // ── 0. 前置 ────────────────────────────────────
  if (!existsSync(MANIFEST)) {
    console.error(`❌ manifest 不存在: ${MANIFEST}`)
    process.exit(1)
  }

  // ── 1. 目录侧清单 ──────────────────────────────
  const dirs = readdirSync(SOURCE)
    .filter((d) => statSync(resolve(SOURCE, d)).isDirectory())
    .filter((d) => !NON_SKILL_DIRS.has(d))
  const dirSkills = dirs.filter((d) => existsSync(resolve(SOURCE, d, 'SKILL.md')))

  // ── 2. manifest 侧清单 ─────────────────────────
  const manifestSkills = Object.keys(parseManifestSkills())

  // 双向覆盖检查
  const inManifestNotDir = manifestSkills.filter((s) => !dirs.includes(s))
  const inDirNotManifest = dirSkills.filter((s) => !manifestSkills.includes(s))
  if (inManifestNotDir.length > 0)
    errors.push(`manifest 登记但目录不存在: ${inManifestNotDir.join(', ')}`)
  if (inDirNotManifest.length > 0)
    errors.push(`目录存在但 manifest 未登记: ${inDirNotManifest.join(', ')}`)

  // ── 3. frontmatter 三方一致 ────────────────────
  for (const s of dirSkills) {
    const fm = parseFrontmatter(resolve(SOURCE, s, 'SKILL.md'))
    if (!fm.name) errors.push(`${s}: SKILL.md 缺 frontmatter name`)
    else if (fm.name !== s) errors.push(`${s}: frontmatter name (${fm.name}) 与目录名不一致`)
    if (!fm.description) errors.push(`${s}: SKILL.md 缺 frontmatter description`)
  }

  // ── 4. source 标记合法性 ───────────────────────
  const manifest = parseManifestSkills()
  for (const s of manifestSkills) {
    const source = manifest[s]?.source
    if (!source) errors.push(`${s}: manifest 缺 source 标记（self/mattpocock/external）`)
    else if (!VALID_SOURCES.has(source)) errors.push(`${s}: source 取值非法 (${source})`)
  }

  // ── 5. catstudy/ 定制层 frontmatter ────────────
  const catstudyDir = resolve(SOURCE, 'catstudy')
  if (existsSync(catstudyDir)) {
    for (const d of readdirSync(catstudyDir)) {
      const fmFile = resolve(catstudyDir, d, 'SKILL.md')
      if (!statSync(resolve(catstudyDir, d)).isDirectory() || !existsSync(fmFile)) continue
      const fm = parseFrontmatter(fmFile)
      if (!fm.name) errors.push(`catstudy/${d}: SKILL.md 缺 frontmatter name`)
      else if (!fm.name.startsWith('catstudy-'))
        errors.push(`catstudy/${d}: frontmatter name (${fm.name}) 应带 catstudy- 前缀`)
      if (!fm.description) errors.push(`catstudy/${d}: SKILL.md 缺 frontmatter description`)
    }
  }

  // ── 报告 ──────────────────────────────────────
  const total = dirSkills.length
  if (errors.length > 0) {
    console.error(`❌ manifest 三方一致校验失败（${errors.length} 项）`)
    for (const e of errors) console.error(`   - ${e}`)
    console.error(`   登记 ${manifestSkills.length}/${total}（期望 40/40）`)
    process.exit(1)
  }
  console.log(
    `✅ manifest 三方一致：${manifestSkills.length}/${total} 全覆盖，frontmatter 全部合法，source 标记全部有效`
  )
  process.exit(0)
}

main()
