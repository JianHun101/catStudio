/**
 * skill-loader.ts 测试（读取原语：仓库 skills/ 源库定位 + SKILL.md 读盘降级）。
 *
 * 注入层已拆除（delivery 单 A）：resolveSkillsForContext / buildSkillContextBlock /
 * reply.ts 技能注入行为验证全部随注入层删除——本文件只测保留的两支读盘原语
 * （loadSkill / getSkillsRoot）。zero DB 依赖，读的是仓库真实 skills/ 源库。
 */

import { describe, it, expect } from 'vitest'
import { loadSkill, getSkillsRoot, SKILL_NAME_RE } from './skill-loader.js'

describe('loadSkill — 仓库 skills/ 源库读取与降级守卫', () => {
  it('读真实 quality-gate SKILL.md 关键段', () => {
    const md = loadSkill('quality-gate')
    expect(md).toContain('提交审查前的自查门')
  })

  it('读真实 implement SKILL.md 关键段', () => {
    const md = loadSkill('implement')
    expect(md).toContain('Implement the work described')
  })

  it('读真实 spec-gate SKILL.md 关键段（需求进实施前门）', () => {
    const md = loadSkill('spec-gate')
    expect(md).toContain('spec-gate')
  })

  it('路径守卫：非法名返回空串（防穿越到 skills/ 外）', () => {
    expect(loadSkill('..')).toBe('')
    expect(loadSkill('../env')).toBe('')
    expect(loadSkill('a/b')).toBe('')
    expect(loadSkill('-x')).toBe('')
    expect(loadSkill('')).toBe('')
    expect(loadSkill('QUALITY-GATE')).toBe('') // 大写不在允许字符集
  })

  it('未知技能名返回空串（读缺失降级，不抛）', () => {
    expect(loadSkill('no-such-skill-xyz')).toBe('')
  })
})

describe('getSkillsRoot — 源库定位', () => {
  it('定位到仓库 skills/（读到真实 SKILL_NAME_RE 兼容的技能目录）', () => {
    const root = getSkillsRoot()
    expect(root).toBeTruthy()
    expect(root?.endsWith('skills')).toBe(true)
  })
})

describe('SKILL_NAME_RE — 技能名路径守卫契约', () => {
  it('kebab-case 放行、非法字符拒绝', () => {
    expect(SKILL_NAME_RE.test('quality-gate')).toBe(true)
    expect(SKILL_NAME_RE.test('session-handoff')).toBe(true)
    expect(SKILL_NAME_RE.test('..')).toBe(false)
    expect(SKILL_NAME_RE.test('a/b')).toBe(false)
    expect(SKILL_NAME_RE.test('QUALITY')).toBe(false)
    expect(SKILL_NAME_RE.test('')).toBe(false)
  })
})
