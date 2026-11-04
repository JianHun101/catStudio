#!/usr/bin/env node
/**
 * skills-gen-catalog.mjs — 从 SKILL.md frontmatter 生成 SKILL_CATALOG（注入目录单一源）
 *
 * 病灶：`packages/shared/src/skill-catalog.ts` 里的 13 条一句话目录是**手抄**的，
 * 与 `skills/<name>/SKILL.md` 的 frontmatter 各说各话。本脚本把 frontmatter 定为
 * 唯一源，生成 `SKILL_CATALOG` 并写回标记块；`--check` 只比对不写盘（幂等门）。
 *
 * frontmatter 契约（四段 folded `>`，顺序固定）：
 *   是什么（一句）
 *   Use when: ...
 *   Not for: ...
 *   Output: ...
 * 另加 `triggers:` 列表（3–6 条中文关键词，双引号包裹，零路由短语）。
 *
 * 生成值形态：`<是什么>｜何时：<Use when>｜触发：<t1>、<t2>…`
 * 两个消费者（server 注入面 / MCP list_skills）都从这里取值，格式天然同源。
 *
 * 不引 YAML 依赖：手写缩进解析，与 `scripts/skills-check-manifest.mjs` 同口径。
 * 用 prettier 以仓库配置格式化生成结果——保证 `--check` 在 lint-staged 的
 * `prettier --write` 之后仍然幂等（否则生成物每次提交都会被重排成另一份）。
 *
 * 用法：
 *   node scripts/skills-gen-catalog.mjs            # 生成并写盘
 *   node scripts/skills-gen-catalog.mjs --check    # 只校验（不一致 exit 1）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as prettier from 'prettier'
import { SKILL_WHITELIST } from '../packages/shared/src/skill-catalog.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKILLS_DIR = resolve(ROOT, 'skills')
const TARGET = resolve(ROOT, 'packages/shared/src/skill-catalog.ts')

// 标记行只按前缀匹配——行尾说明文字可变，不参与定位。
const BEGIN = '// ── BEGIN GENERATED SKILL_CATALOG'
const END = '// ── END GENERATED SKILL_CATALOG'

// ADR 0014 §3 零路由：与 `scripts/mcp-server.test.js` 的 ROUTING_PATTERNS 同款。
// 生成物会进 system prompt；路由短语藏在目录里同样破坏不变量。
export const ROUTING_PATTERNS = [
  /请谁审查|投给谁/,
  /(请|交给|转给|发给|递给|通知|告知)\s*(审查者|审查猫|吐槽猫|店长)/,
]

const TRIGGER_MIN = 3
const TRIGGER_MAX = 6

/** 校验失败统一抛 Error —— 顶层 catch 打印技能名与原因，exit 1。 */
function fail(message) {
  throw new Error(message)
}

/** 剥 YAML 单/双引号包裹（手写解析器不引第三方 YAML 库）。 */
function unquote(raw) {
  const t = raw.trim()
  if (
    t.length >= 2 &&
    ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"')))
  ) {
    return t.slice(1, -1)
  }
  return t
}

/**
 * 解析 SKILL.md frontmatter 的 description 与 triggers。
 *
 * description 支持 folded `>` / literal `|` 块（本项目统一用 `>`）；triggers 必须是
 * 缩进列表，且每项双引号包裹（`# prettier-ignore` 注释行跳过——它用来挡住
 * prettier 把双引号改成单引号）。
 */
export function parseSkillFrontmatter(text, name) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') fail(`${name}: SKILL.md 缺 frontmatter`)
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i
      break
    }
  }
  if (end === -1) fail(`${name}: frontmatter 未闭合`)
  const fm = lines.slice(1, end)

  let description = null
  let triggers = null

  for (let i = 0; i < fm.length; i++) {
    const line = fm[i]
    if (/^\s*#/.test(line)) continue

    const descMatch = line.match(/^description:\s*(.*?)\s*$/)
    if (descMatch) {
      const raw = descMatch[1]
      if (raw === '>' || raw === '>-' || raw === '|' || raw === '|-') {
        const folded = raw.startsWith('>')
        const parts = []
        for (let j = i + 1; j < fm.length; j++) {
          const next = fm[j]
          if (next.trim() === '') continue
          if (!/^\s/.test(next)) break // 缩进结束 = 块结束
          parts.push(next.trim())
        }
        description = parts.join(folded ? ' ' : '\n')
      } else {
        description = unquote(raw)
      }
      continue
    }

    const trigMatch = line.match(/^triggers:\s*(.*?)\s*$/)
    if (trigMatch) {
      if (trigMatch[1]) fail(`${name}: triggers 必须是缩进列表，不能写成行内值`)
      const out = []
      for (let j = i + 1; j < fm.length; j++) {
        const next = fm[j]
        if (/^\s*#/.test(next)) continue
        if (next.trim() === '') continue
        if (!/^\s/.test(next)) break
        const item = next.match(/^\s*-\s*(.*?)\s*$/)
        if (!item) fail(`${name}: triggers 行格式非法（${next.trim()}）`)
        const rawItem = item[1]
        if (!/^".*"$/.test(rawItem)) fail(`${name}: trigger 必须双引号包裹（${rawItem}）`)
        out.push(rawItem.slice(1, -1))
      }
      triggers = out
    }
  }

  if (!description) fail(`${name}: 缺 description`)
  if (!triggers) fail(`${name}: 缺 triggers`)
  return { description, triggers }
}

/** 把折叠后的 description 切成四段；缺段/空段直接报技能名。 */
export function splitDescription(description, name) {
  const m = description.match(/^(.*?)Use when:\s*(.*?)Not for:\s*(.*?)Output:\s*([\s\S]*)$/)
  if (!m) fail(`${name}: description 缺四段（是什么 / Use when / Not for / Output）`)
  const parts = {
    what: m[1].trim(),
    useWhen: m[2].trim(),
    notFor: m[3].trim(),
    output: m[4].trim(),
  }
  if (!parts.what) fail(`${name}: description 的「是什么」段为空`)
  if (!parts.useWhen) fail(`${name}: description 的 Use when 段为空`)
  if (!parts.notFor) fail(`${name}: description 的 Not for 段为空`)
  if (!parts.output) fail(`${name}: description 的 Output 段为空`)
  return parts
}

/** 校验 triggers：3–6 条、非空、无 @、零路由。 */
function validateTriggers(triggers, name) {
  if (triggers.length < TRIGGER_MIN || triggers.length > TRIGGER_MAX) {
    fail(`${name}: triggers 须 ${TRIGGER_MIN}–${TRIGGER_MAX} 条（当前 ${triggers.length}）`)
  }
  for (const trigger of triggers) {
    if (!trigger.trim()) fail(`${name}: trigger 为空`)
    if (trigger.includes('@')) fail(`${name}: trigger 含 @（${trigger}）`)
    for (const re of ROUTING_PATTERNS) {
      if (re.test(trigger)) fail(`${name}: trigger 命中路由黑名单（${trigger}）`)
    }
  }
}

/** 读 13 份 frontmatter，返回 `[{ name, value }]`（顺序 = 白名单序）。 */
export function buildCatalogEntries() {
  return SKILL_WHITELIST.map((name) => {
    const file = join(SKILLS_DIR, name, 'SKILL.md')
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      fail(`${name}: 读不到 ${file}`)
    }
    const { description, triggers } = parseSkillFrontmatter(text, name)
    validateTriggers(triggers, name)
    const parts = splitDescription(description, name)
    return {
      name,
      value: `${parts.what}｜何时：${parts.useWhen}｜触发：${triggers.join('、')}`,
    }
  })
}

/** 渲染标记块（不含前后换行——由调用方拼接）。 */
function renderBlock(entries) {
  return [
    `${BEGIN}（scripts/skills-gen-catalog.mjs 生成，勿手改；改 skills/<name>/SKILL.md 后重跑）`,
    'export const SKILL_CATALOG: Record<string, string> = {',
    ...entries.map(({ name, value }) => `  ${JSON.stringify(name)}: ${JSON.stringify(value)},`),
    '}',
    `${END}`,
  ].join('\n')
}

/** 用标记块替换目标文件的生成区，再按仓库 prettier 配置格式化整份文件。 */
async function renderTarget(entries, source) {
  const lines = source.split(/\r?\n/)
  const begin = lines.findIndex((line) => line.startsWith(BEGIN))
  const end = lines.findIndex((line) => line.startsWith(END))
  if (begin < 0) fail(`skill-catalog.ts 缺 BEGIN 标记（${BEGIN}）`)
  if (end < 0) fail(`skill-catalog.ts 缺 END 标记（${END}）`)
  if (end < begin) fail('skill-catalog.ts 的 END 标记在 BEGIN 之前')
  const nextRaw = [
    ...lines.slice(0, begin),
    ...renderBlock(entries).split('\n'),
    ...lines.slice(end + 1),
  ].join('\n')
  const config = (await prettier.resolveConfig(TARGET)) ?? {}
  return prettier.format(nextRaw, { ...config, filepath: TARGET })
}

async function main() {
  const entries = buildCatalogEntries()
  const source = readFileSync(TARGET, 'utf8')
  const next = await renderTarget(entries, source)

  if (process.argv.includes('--check')) {
    if (next === source) {
      console.log(`✅ SKILL_CATALOG 与 ${entries.length} 份 frontmatter 一致（--check）`)
      return
    }
    const a = source.split(/\r?\n/)
    const b = next.split(/\r?\n/)
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        console.error(`❌ SKILL_CATALOG 已漂移：首个差异在第 ${i + 1} 行`)
        console.error(`  - ${a[i] ?? '(缺行)'}`)
        console.error(`  + ${b[i] ?? '(缺行)'}`)
        break
      }
    }
    console.error('   跑 node scripts/skills-gen-catalog.mjs 重新生成')
    process.exit(1)
  }

  writeFileSync(TARGET, next, 'utf8')
  console.log(`✅ 已生成 ${entries.length} 条 SKILL_CATALOG → ${TARGET}`)
}

// 直接运行才执行；被测试 import 时只暴露纯函数（不写盘）。
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
