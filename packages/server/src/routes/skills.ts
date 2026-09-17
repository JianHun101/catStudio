/**
 * 技能清单 REST API —— 前端斜杠命令补全的数据源。
 *
 * - GET /api/skills → 200 { ok: true, skills: [{ name, description, category }] }
 *
 * **成员资格由目录决定，不由 manifest 决定**：`skills/` 下**含 `SKILL.md` 的顶级
 * 目录**才算技能（有正文才算存在）。这条分工与 `scripts/skills-check-manifest.mjs`
 * 的既有判据同源（该脚本做的是「目录 ↔ manifest ↔ frontmatter」三方一致校验）。
 *
 * **两个展示字段各有其源，不是同一个源**（实测口径，不是设计偏好）：
 *   · `category` **只有 manifest 有**——SKILL.md frontmatter 无此字段，28/28 条
 *     manifest 登记都带 category（自研中文分类 / 三方 `'外部技能'`）。
 *   · `description` **manifest 只覆盖 7/28**——只有 7 个自研技能在 manifest 里手写了
 *     description，其余 21 条（mattpocock/external）只登记了 source/use_when/not_for/
 *     category。故取「manifest 手写优先、缺失回退 SKILL.md frontmatter」：manifest 的
 *     手写串是猫咖语境下的短blurb，优先；frontmatter 是技能自述、28/28 全覆盖
 *     （三方一致校验已强制该字段存在），保证下拉不出现空白描述项。
 *
 * **为什么必须只取 `skills:` 段**：manifest 里还有 `catstudy:`（2 条定制层登记）与
 * `pipeline:`（dev/review 两条流程链，其值为 skill 名数组）。朴素按缩进扫描会把
 * 它们一并读成技能条目——`dev` / `review` / `catstudy-quality-gate` /
 * `catstudy-receive-review` 四个名字写得出却**读不到正文**，出现在补全列表里等于
 * 把用户送去一个死端点。解析器遇 `skills:` 段外的顶级键即停（段内注释亦停）。
 *
 * **悬空条目（manifest 登记但无目录）不进结果**——同上，成员资格以目录为准，
 * manifest 只补字段。当前 main 上 `skills:` 段 28 条与 28 个目录恰好一一对应，
 * 悬空数为 0；这条是防御，不是当前数据形态。
 *
 * 源库定位与 `scripts/mcp-server-utils.mjs` 的 read_skill 同款：
 * `CATSTUDY_SKILLS_DIR` 环境覆盖优先，否则向上找含 `pnpm-workspace.yaml` 的仓库根。
 * 起点两处——本模块目录（锚「正在跑的这份代码所属检出」，源码/构建产物两种深度都成立）
 * 与进程 cwd（模块落在检出外时兜底）。**不锚单一 cwd**：`pnpm dev:server` 下 cwd 是
 * `packages/server`，单起点会解析出 `packages/server/skills`。
 *
 * 与 skill 的**执行**无关：skill 由 CLI 原生消费（消息原样透传，见 useSkillCommand），
 * 本端点只喂前端下拉，不做任何注入、不碰 LLM。
 */
import type { FastifyInstance } from 'fastify'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLogger } from '../logger.js'

const log = createLogger('skill-routes')

/** 本模块所在目录（源码与构建产物通用——向上找根不依赖层级） */
const moduleDir = dirname(fileURLToPath(import.meta.url))

const WORKSPACE_MARKER = 'pnpm-workspace.yaml'

export interface SkillEntry {
  name: string
  description: string
  category: string
}

/** 从 startDir 向上找**确实含** `pnpm-workspace.yaml` 的最近祖先（含自身）；找不到返回 null。 */
function findRepoRootFrom(startDir: string): string | null {
  let dir = resolve(startDir)
  for (;;) {
    if (existsSync(join(dir, WORKSPACE_MARKER))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** 定位技能源库目录 `skills/`；找不到返回 null（端点降级为空清单，不 500）。 */
export function getSkillsRoot(): string | null {
  const envRoot = process.env['CATSTUDY_SKILLS_DIR']
  if (envRoot) return existsSync(envRoot) ? envRoot : null
  for (const start of [moduleDir, process.cwd()]) {
    const root = findRepoRootFrom(start)
    if (!root) continue
    const skillsDir = join(root, 'skills')
    if (existsSync(skillsDir)) return skillsDir
  }
  return null
}

/** 去掉 YAML 单/双引号包裹（`'驻场方法论'` → `驻场方法论`） */
function unquote(raw: string): string {
  const t = raw.trim()
  const quoted =
    t.length >= 2 &&
    ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"')))
  return quoted ? t.slice(1, -1) : t
}

/**
 * 提取 manifest.yaml **`skills:` 段**的展示字段：`{ 技能名 → { description, category } }`。
 *
 * 手写缩进解析，不引 YAML 依赖（与 `scripts/skills-check-manifest.mjs` 同口径，
 * 该脚本刻意避开 YAML 依赖，本仓 scripts/ 与 server 分属两包无法共用模块）。
 * 只认 description / category 两个字段：`use_when` / `not_for` 同为 `|` 块值，
 * 但它们不是展示字段，收进来只会多一份漂移面。
 *
 * 段结束判据 `^\S`（列 0 起）——覆盖两个真实存在的终止形态：顶级键（`catstudy:`、
 * `pipeline:`、`iron_laws:`）与段间列 0 注释（`# ── 项目定制层…`）。段内注释缩进为 2，
 * 且不含结尾冒号，既不会被误读成条目名，也不会终止解析。
 */
export function parseManifestSkills(
  text: string
): Map<string, { description: string; category: string }> {
  const out = new Map<string, { description: string; category: string }>()
  let inSkills = false
  let current: string | null = null
  let blockField: 'description' | 'category' | null = null

  for (const line of text.split(/\r?\n/)) {
    if (!inSkills) {
      if (/^skills:\s*$/.test(line)) inSkills = true
      continue
    }
    if (/^\S/.test(line)) break // 顶级键 / 列 0 注释 → skills 段结束

    const entryMatch = line.match(/^ {2}(\S[^:]*):\s*$/)
    if (entryMatch) {
      current = entryMatch[1]
      out.set(current, { description: '', category: '' })
      blockField = null
      continue
    }

    // `|` 块值续行（缩进 6）——接在当前字段后，段内换行折成单空格（下拉是单行展示）
    const blockLine = blockField !== null && current !== null ? line.match(/^ {6}(.+?)\s*$/) : null
    if (blockLine && blockField !== null && current !== null) {
      const entry = out.get(current)!
      const prev = entry[blockField]
      entry[blockField] = prev ? `${prev} ${blockLine[1]}` : blockLine[1]
      continue
    }
    blockField = null

    const kv = current !== null ? line.match(/^ {4}(description|category):\s*(.*)$/) : null
    if (kv && current !== null) {
      const raw = kv[2].trim()
      const field = kv[1] as 'description' | 'category'
      if (raw === '|' || raw === '|-') {
        blockField = field // 后续缩进 6 行是该字段的块内容
      } else {
        out.get(current)![field] = unquote(raw)
      }
    }
  }
  return out
}

/**
 * 取 SKILL.md frontmatter 的 `description`（首个 `---` 块内的单行标量）。
 * 非 frontmatter 开头 / 无该字段 → ''（由调用方回退，不抛）。
 */
export function parseFrontmatterDescription(markdown: string): string {
  const lines = markdown.replace(/^﻿/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return ''
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '---') return ''
    const m = line.match(/^description:\s*(.+?)\s*$/)
    if (m) return unquote(m[1])
  }
  return ''
}

/** 读单个 SKILL.md 的 frontmatter description；文件不可读时返回 ''（降级，不抛）。 */
function readFrontmatterDescription(skillMdPath: string): string {
  try {
    return parseFrontmatterDescription(readFileSync(skillMdPath, 'utf-8'))
  } catch (err) {
    log.warn('SKILL.md 读取失败，该条回退为空描述', { path: skillMdPath, error: String(err) })
    return ''
  }
}

/** 读取 manifest 展示字段；文件缺失/不可读时返回空表（降级为「有名字无描述」，不抛）。 */
function readManifestFields(
  skillsRoot: string
): Map<string, { description: string; category: string }> {
  const manifestPath = join(skillsRoot, 'manifest.yaml')
  if (!existsSync(manifestPath)) return new Map()
  try {
    return parseManifestSkills(readFileSync(manifestPath, 'utf-8'))
  } catch (err) {
    log.warn('skills manifest 读取失败，回退为空描述', { error: String(err) })
    return new Map()
  }
}

/**
 * 技能清单：`skills/` 含 `SKILL.md` 的顶级目录 ∩ manifest 展示字段，按名字典序。
 *
 * 字典序而非 manifest 声明序——下拉是「边打边筛」的场景，顺序稳定可预期比保留
 * 分组更有用（manifest 的排序承载的是来源分组语义，在补全列表里读不出来）。
 */
export function listSkills(): SkillEntry[] {
  const root = getSkillsRoot()
  if (!root) {
    log.warn('技能源库未定位，/api/skills 降级为空清单')
    return []
  }
  const fields = readManifestFields(root)
  let entries: SkillEntry[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'SKILL.md')))
      .map((d) => d.name)
      .map((name) => {
        const manifest = fields.get(name)
        const fromManifest = manifest?.description ?? ''
        return {
          name,
          description: fromManifest || readFrontmatterDescription(join(root, name, 'SKILL.md')),
          category: manifest?.category ?? '',
        }
      })
  } catch (err) {
    log.warn('技能目录枚举失败，/api/skills 降级为空清单', { error: String(err) })
    return []
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

export async function skillRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/skills', async () => ({ ok: true, skills: listSkills() }))
}
