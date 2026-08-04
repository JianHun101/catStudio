#!/usr/bin/env node
/**
 * skills-check-manifest.mjs — manifest ↔ 目录 ↔ frontmatter 三方一致校验（阻塞）
 *                           + requires_mcp 运行时健康检查（红示 advisory，不阻塞）
 *
 * 校验项：
 *   1. manifest.yaml `skills:` 下的登记 ↔ `skills/` 顶级 skill 目录 双向覆盖（40/40）
 *   2. 每个 SKILL.md frontmatter 的 name 与目录名一致、description 存在
 *   3. 每个登记的 skill 有 source 标记（self / mattpocock / external），取值合法
 *   4. catstudy/ 定制层不参与顶级计数（随迁保留，另行校验其 4 个 skill 的 frontmatter）
 *   5. merged_from（catstudy 定制层合并来源登记）/ requires_mcp（运行时依赖声明）格式入 schema
 *   6. requires_mcp 运行时健康检查：声明但运行时缺失 → 红示 advisory 不阻塞
 *      （MCP 是可选运行时——如 vision-assist 依赖 Ollama，服务未起时技能文档仍可读可用）
 *
 * 任一校验失败 → exit 1（阻塞提交/合并）。健康检查缺失 → 仅红示提示，exit 0。
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
const MCP_TIMEOUT_MS = 1500 // 运行时探测超时（Ollama 未起时连接拒绝很快，防挂起 CI）

/** 从 manifest.yaml 提取顶级 skills 登记：{ name: { source?, requires_mcp? } }（手写解析，避免 YAML 依赖） */
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
    const kv = line.match(/^ {4}(source|requires_mcp):\s*(.+)$/)
    if (kv && current) skills[current][kv[1]] = unquote(kv[2].trim())
  }
  return skills
}

/** 提取 manifest.yaml catstudy 段登记：{ name: { source?, merged_from? } } */
function parseCatstudySkills() {
  const text = readFileSync(MANIFEST, 'utf8')
  const lines = text.split(/\r?\n/)
  const skills = {}
  let inCatstudy = false
  let current = null
  for (const line of lines) {
    if (/^catstudy:$/.test(line)) {
      inCatstudy = true
      continue
    }
    if (!inCatstudy) continue
    if (/^\S/.test(line)) break // catstudy 段结束（pipeline 等）
    const m = line.match(/^ {2}(\S[^:]*):/)
    if (m) {
      current = m[1]
      skills[current] = {}
      continue
    }
    const kv = line.match(/^ {4}(source|merged_from):\s*(.+)$/)
    if (kv && current) skills[current][kv[1]] = unquote(kv[2].trim())
  }
  return skills
}

/** 剥 YAML 单/双引号包裹（手写解析器不引第三方 YAML 库） */
function unquote(value) {
  if (
    value.length >= 2 &&
    value[0] === value[value.length - 1] &&
    (value[0] === "'" || value[0] === '"')
  ) {
    return value.slice(1, -1)
  }
  return value
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

/** 解析 requires_mcp 声明：'provider:model (endpoint)' → { provider, model, endpoint }；不匹配返回 null */
function parseMcpDecl(decl) {
  const m = decl.match(/^([a-z0-9_-]+):([^ (]+)(?:\s*\(([^)]*)\))?$/i)
  if (!m) return null
  return { provider: m[1], model: m[2], endpoint: m[3] || '' }
}

/** 探测 ollama 运行时：GET {endpoint}/api/tags 是否含声明模型 */
async function probeOllama(model, endpoint) {
  const base = endpoint || '127.0.0.1:11434'
  try {
    const res = await fetch(`http://${base}/api/tags`, {
      signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
    })
    if (!res.ok) return { reachable: true, modelFound: false, detail: `HTTP ${res.status}` }
    const data = await res.json()
    const names = (data.models || []).flatMap((m) => [m.name, m.model]).filter(Boolean)
    return {
      reachable: true,
      modelFound: names.includes(model),
      detail: names.join(', ') || '空模型列表',
    }
  } catch (err) {
    const reason = err?.name === 'TimeoutError' ? '探测超时' : String(err?.message || err)
    return { reachable: false, modelFound: false, detail: reason }
  }
}

async function main() {
  const errors = []
  const advisories = []

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
  const manifest = parseManifestSkills()
  const manifestSkills = Object.keys(manifest)

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
  for (const s of manifestSkills) {
    const source = manifest[s]?.source
    if (!source) errors.push(`${s}: manifest 缺 source 标记（self/mattpocock/external）`)
    else if (!VALID_SOURCES.has(source)) errors.push(`${s}: source 取值非法 (${source})`)
  }

  // ── 5. requires_mcp / merged_from 格式入 schema ──
  for (const s of manifestSkills) {
    const decl = manifest[s]?.requires_mcp
    if (decl !== undefined && !parseMcpDecl(decl)) {
      errors.push(
        `${s}: requires_mcp 格式非法 (${decl}) — 应为 provider:model (endpoint)，如 'ollama:qwen3.5:9b (127.0.0.1:11434)'`
      )
    }
  }
  const catstudyManifest = parseCatstudySkills()
  for (const [s, v] of Object.entries(catstudyManifest)) {
    if (v.merged_from !== undefined && !v.merged_from.trim()) {
      errors.push(`catstudy/${s}: merged_from 为空（合并来源登记应注明来源 skill）`)
    }
  }

  // ── 6. catstudy/ 定制层 frontmatter ────────────
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

  // ── 7. requires_mcp 运行时健康检查（advisory 不阻塞）──
  const mcpDecls = Object.entries(manifest).filter(([, v]) => v.requires_mcp !== undefined)
  for (const [skill, v] of mcpDecls) {
    const decl = parseMcpDecl(v.requires_mcp)
    if (!decl) continue // 格式错误已在第 5 节阻塞上报
    if (decl.provider === 'ollama') {
      const probe = await probeOllama(decl.model, decl.endpoint)
      if (!probe.reachable) {
        advisories.push(
          `${skill}: requires_mcp 运行时不可达 — Ollama ${decl.endpoint || '127.0.0.1:11434'}（${probe.detail}）。MCP 是可选运行时，不阻塞`
        )
      } else if (!probe.modelFound) {
        advisories.push(
          `${skill}: requires_mcp 模型缺失 — ${decl.model} 不在运行时模型列表（${probe.detail}）。MCP 是可选运行时，不阻塞`
        )
      } else {
        console.log(`✅ ${skill}: requires_mcp 运行时就绪 — ${decl.model}（${probe.detail}）`)
      }
    } else {
      advisories.push(`${skill}: requires_mcp provider 未知 (${decl.provider})，跳过运行探测`)
    }
  }

  // ── 报告 ──────────────────────────────────────
  if (advisories.length > 0) {
    console.warn(`⚠️ MCP 健康检查 advisory（${advisories.length} 项，不阻塞）`)
    for (const a of advisories) console.warn(`   - ${a}`)
  }
  const total = dirSkills.length
  if (errors.length > 0) {
    console.error(`❌ manifest 三方一致校验失败（${errors.length} 项）`)
    for (const e of errors) console.error(`   - ${e}`)
    console.error(`   登记 ${manifestSkills.length}/${total}（期望 40/40）`)
    process.exit(1)
  }
  console.log(
    `✅ manifest 三方一致：${manifestSkills.length}/${total} 全覆盖，frontmatter 全部合法，source 标记全部有效，merged_from/requires_mcp 格式校验通过`
  )
  process.exit(0)
}

await main()
