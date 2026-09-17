/**
 * skills 路由测试 — GET /api/skills（前端斜杠补全的数据源）。
 *
 * - 解析器：只取 `skills:` 段（`catstudy:`/`pipeline:` 段不得混入）、`|` 块值折单行、
 *   引号标量去引号
 * - listSkills()：成员资格以「目录含 SKILL.md」为准（悬空名字不进结果）、字典序、
 *   每个条目都能补到 description
 * - GET 契约：200 + { ok, skills }
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { createTestDb, buildTestApp } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository } from '../db/repository/index.js'
import {
  skillRoutes,
  parseManifestSkills,
  parseFrontmatterDescription,
  listSkills,
  getSkillsRoot,
} from './skills.js'

/** 与 manifest 段结构同形的合成样本（含段内注释、两个 `|` 块、引号标量、段外顶级键） */
const SAMPLE_MANIFEST = [
  '# 头部注释',
  'skills:',
  '  # ── 段内注释（缩进 2、无结尾冒号）──',
  '  alpha:',
  '    source: self',
  '    use_when: |',
  '      描述里的 use_when 不该被收进来。',
  "    category: '方法论'",
  '    description: |',
  '      第一行。',
  '      第二行。',
  '',
  '  beta:',
  '    source: external',
  '    category: "外部技能"',
  '    description: |',
  '      单行描述。',
  '',
  '# ── 段外列 0 注释：解析到此为止 ──',
  'catstudy:',
  '  catstudy-quality-gate:',
  '    source: self',
  '',
  'pipeline:',
  '  dev:',
  '    - spec-gate',
].join('\n')

describe('parseManifestSkills', () => {
  it('只取 skills: 段——catstudy/pipeline 段的名字不进结果', () => {
    const parsed = parseManifestSkills(SAMPLE_MANIFEST)
    expect([...parsed.keys()]).toEqual(['alpha', 'beta'])
    expect(parsed.has('catstudy-quality-gate')).toBe(false)
    expect(parsed.has('dev')).toBe(false)
    expect(parsed.has('spec-gate')).toBe(false)
  })

  it('`|` 块值折成单行；引号标量去引号；use_when 块不被当成展示字段', () => {
    const parsed = parseManifestSkills(SAMPLE_MANIFEST)
    expect(parsed.get('alpha')!.description).toBe('第一行。 第二行。')
    expect(parsed.get('alpha')!.category).toBe('方法论')
    expect(parsed.get('beta')!.category).toBe('外部技能')
    expect(parsed.get('beta')!.description).toBe('单行描述。')
    expect(JSON.stringify(parsed.get('alpha'))).not.toContain('use_when')
  })

  it('没有 skills: 段 → 空表（不抛、不误读段外内容）', () => {
    expect(parseManifestSkills('pipeline:\n  dev:\n    - spec-gate\n').size).toBe(0)
  })
})

describe('parseFrontmatterDescription', () => {
  it('取首个 --- 块内的 description 单行标量', () => {
    expect(parseFrontmatterDescription('---\nname: x\ndescription: 做某事。\n---\n\n正文')).toBe(
      '做某事。'
    )
  })

  it('无 frontmatter / 块内无该字段 → 空串（不抛）', () => {
    expect(parseFrontmatterDescription('# 没有 frontmatter')).toBe('')
    expect(parseFrontmatterDescription('---\nname: x\n---\n')).toBe('')
  })

  it('只认首个块——正文里出现的 description: 行不算', () => {
    expect(parseFrontmatterDescription('---\nname: x\n---\ndescription: 正文里的')).toBe('')
  })
})

describe('listSkills', () => {
  it('成员资格以「目录含 SKILL.md」为准——悬空的段外名字不进结果', () => {
    const names = listSkills().map((s) => s.name)
    for (const dangling of ['dev', 'review', 'catstudy-quality-gate', 'catstudy-receive-review']) {
      expect(names).not.toContain(dangling)
    }
  })

  it('每个条目都对应真实存在的 SKILL.md，且能补到非空 description', () => {
    const root = getSkillsRoot()
    expect(root).toBeTruthy()
    const skills = listSkills()
    expect(skills.length).toBeGreaterThan(0)
    for (const s of skills) {
      expect(existsSync(join(root!, s.name, 'SKILL.md'))).toBe(true)
      expect(s.description.length).toBeGreaterThan(0)
    }
    // 抽样：自研与三方的条目都在场（防「只扫到一半目录」退化）
    const names = skills.map((s) => s.name)
    expect(names).toContain('implement')
    expect(names).toContain('design-taste-frontend')
  })

  it('按名字典序（下拉是边打边筛，顺序稳定可预期）', () => {
    const names = listSkills().map((s) => s.name)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
  })
})

describe('skills routes', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    setDb(createTestDb())
    initRepository(getDb())
    app = await buildTestApp()
    await app.register(skillRoutes)
  })

  afterEach(async () => {
    await app.close()
    resetDb()
  })

  it('GET /api/skills → 200 { ok, skills }，条目含 name/description/category', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/skills' })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.skills)).toBe(true)
    expect(body.skills.length).toBeGreaterThan(0)
    for (const s of body.skills) {
      expect(typeof s.name).toBe('string')
      expect(typeof s.description).toBe('string')
      expect(typeof s.category).toBe('string')
    }
  })
})
