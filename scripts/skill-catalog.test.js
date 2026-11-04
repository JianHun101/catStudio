/**
 * skill-catalog.test.js — 注入目录单一源守卫
 *
 * 钉三件事：
 * 1. `SKILL_CATALOG` 与 13 份 SKILL.md frontmatter **零漂移**（生成器 --check）；
 * 2. frontmatter 契约：四段齐全 / triggers 3–6 条中文关键词 / 双引号 / 零 @ 零路由；
 * 3. 生成值形态 `<是什么>｜何时：<Use when>｜触发：<t1>、<t2>…` 对两个消费者同源。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SKILL_WHITELIST, SKILL_CATALOG } from '../packages/shared/src/skill-catalog.ts'
import {
  ROUTING_PATTERNS,
  buildCatalogEntries,
  parseSkillFrontmatter,
  splitDescription,
} from './skills-gen-catalog.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKILLS_DIR = join(ROOT, 'skills')
const GENERATOR = join(ROOT, 'scripts', 'skills-gen-catalog.mjs')
const CATALOG_FILE = join(ROOT, 'packages', 'shared', 'src', 'skill-catalog.ts')

/** 读某个技能的 SKILL.md 原文 */
function readSkill(name) {
  return readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8')
}

/** 取 frontmatter 原文（两个 --- 之间） */
function frontmatterOf(text) {
  const lines = text.split(/\r?\n/)
  expect(lines[0]?.trim()).toBe('---')
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---')
  expect(end).toBeGreaterThan(0)
  return lines.slice(1, end).join('\n')
}

describe('skills-gen-catalog — 幂等门', () => {
  it('--check：生成物与 13 份 frontmatter 一致（exit 0）', () => {
    const result = spawnSync(process.execPath, [GENERATOR, '--check'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('一致')
  })
})

describe('SKILL_CATALOG — 生成值形态', () => {
  it('键集合与顺序 === SKILL_WHITELIST（13 条，一条不多一条不少）', () => {
    expect(Object.keys(SKILL_CATALOG)).toEqual([...SKILL_WHITELIST])
    expect(Object.keys(SKILL_CATALOG)).toHaveLength(13)
  })

  it('每条为 `<是什么>｜何时：<Use when>｜触发：<3–6 个关键词>`', () => {
    for (const name of SKILL_WHITELIST) {
      const value = SKILL_CATALOG[name]
      expect(value, name).toMatch(/^.+｜何时：.+｜触发：.+$/)
      const parts = value.split('｜')
      expect(parts, name).toHaveLength(3)
      const triggers = parts[2].replace(/^触发：/, '').split('、')
      expect(triggers.length, name).toBeGreaterThanOrEqual(3)
      expect(triggers.length, name).toBeLessThanOrEqual(6)
      for (const trigger of triggers) {
        expect(trigger.trim(), name).not.toBe('')
        expect(trigger, name).not.toContain('@')
      }
    }
  })

  it('13 行渲染结果总长 ≤ 3000 字符（注入体积预算守卫）', () => {
    const entries = buildCatalogEntries()
    const total = entries.reduce((sum, { name, value }) => sum + `- ${name}: ${value}`.length, 0)
    expect(total, `实际 ${total} 字符（预算 3000）`).toBeLessThanOrEqual(3000)
  })

  it('生成块在 skill-catalog.ts 中恰好一对标记（BEGIN/END）', () => {
    const source = readFileSync(CATALOG_FILE, 'utf8')
    const begins = source.match(/^\/\/ ── BEGIN GENERATED SKILL_CATALOG/gm) ?? []
    const ends = source.match(/^\/\/ ── END GENERATED SKILL_CATALOG/gm) ?? []
    expect(begins).toHaveLength(1)
    expect(ends).toHaveLength(1)
    expect(source.indexOf(begins[0])).toBeLessThan(source.indexOf(ends[0]))
  })
})

describe('SKILL.md frontmatter — 四段与 triggers 契约', () => {
  it('13 份 description 四段齐全且非空', () => {
    for (const name of SKILL_WHITELIST) {
      const { description } = parseSkillFrontmatter(readSkill(name), name)
      const parts = splitDescription(description, name)
      for (const [key, value] of Object.entries(parts)) {
        expect(value.trim(), `${name}.${key}`).not.toBe('')
      }
    }
  })

  it('triggers 3–6 条、双引号包裹、零 @、零路由短语', () => {
    for (const name of SKILL_WHITELIST) {
      const text = readSkill(name)
      const { triggers } = parseSkillFrontmatter(text, name)
      expect(triggers.length, name).toBeGreaterThanOrEqual(3)
      expect(triggers.length, name).toBeLessThanOrEqual(6)

      // 原文必须是双引号（`# prettier-ignore` 挡住 prettier 改单引号）
      const fm = frontmatterOf(text)
      const triggerBlock = fm.slice(fm.indexOf('triggers:'))
      const rawItems = [...triggerBlock.matchAll(/^\s*-\s*(.*)$/gm)].map((m) => m[1].trim())
      expect(rawItems.length, name).toBe(triggers.length)
      for (const raw of rawItems) expect(raw, `${name}: ${raw}`).toMatch(/^".*"$/)

      for (const trigger of triggers) {
        expect(trigger, `${name}: ${trigger}`).not.toContain('@')
        for (const re of ROUTING_PATTERNS) {
          expect(re.test(trigger), `${name}: trigger 命中路由黑名单 ${re}`).not.toBe(true)
        }
      }
    }
  })

  it('生成结果与逐条重建一致（buildCatalogEntries 是同一口径）', () => {
    const entries = buildCatalogEntries()
    expect(entries.map((e) => e.name)).toEqual([...SKILL_WHITELIST])
    for (const { name, value } of entries) {
      expect(SKILL_CATALOG[name], name).toBe(value)
    }
  })
})
