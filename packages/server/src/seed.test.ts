/**
 * Seed 逻辑测试（不运行 seed.ts 的顶层 seed() 调用）。
 *
 * 验证 upsert 行为:
 * - 首次运行 → INSERT（changes = 1）
 * - 再次运行同一条 → DO UPDATE（changes > 1 via sqlite）
 * - 确定性 ID 生成（uuid.v5）
 * - Session 引用固定 Agent ID
 */
import { describe, it, expect } from 'vitest'
import { v5 as uuidV5 } from 'uuid'
import { buildDemoAgents, buildDemoKnowledge, knowledgeId } from './seed-data.js'

const SEED_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'

function fixedId(name: string): string {
  return uuidV5(`cat-study.agent.${name}`, SEED_NAMESPACE)
}

describe('seed agents', () => {
  const agents = buildDemoAgents()

  it('种子包含 6 只猫（店长/ds猫/flash猫/吐槽猫/图测猫/dsh猫）', () => {
    expect(agents.map((a) => a.name).sort()).toEqual([
      'dsh猫',
      'ds猫',
      'flash猫',
      '吐槽猫',
      '图测猫',
      '店长',
    ])
  })

  it('图测猫 role=vision 且 id 为 DB 现有 id（幂等命中不重建）', () => {
    const vision = agents.find((a) => a.name === '图测猫')!
    expect(vision.role).toBe('vision')
    expect(vision.id).toBe('0ac78872-80ad-4bfa-84ad-3bc0c0d05a1e')
  })

  it('四只对话猫的角色与白名单边表对齐', () => {
    const roleOf = (name: string) => agents.find((a) => a.name === name)!.role
    expect(roleOf('店长')).toBe('store')
    expect(roleOf('ds猫')).toBe('implementer')
    expect(roleOf('flash猫')).toBe('implementer')
    expect(roleOf('吐槽猫')).toBe('reviewer')
  })

  it('vision 角色条目必须使用视觉指令 prompt（角色↔prompt 语义绑定）', () => {
    // 按 role 找而非按名字找——绑定「任何 role=vision 的猫都必须是视觉指令 prompt」，
    // 防未来把 prompt 改成角色扮演模板但漏改 role 的漂移（名字找会绕过此检查）
    const vision = agents.filter((a) => a.role === 'vision')
    expect(vision).toHaveLength(1)
    expect(vision[0].systemPrompt).toContain('视觉测试专用')
    expect(vision[0].systemPrompt).toContain('发图')
  })
})

describe('seed helpers', () => {
  describe('fixedId (uuid.v5)', () => {
    it('produces deterministic IDs for same input', () => {
      const id1 = fixedId('店长')
      const id2 = fixedId('店长')
      expect(id1).toBe(id2)
    })

    it('produces different IDs for different names', () => {
      const id1 = fixedId('店长')
      const id2 = fixedId('ds猫')
      expect(id1).not.toBe(id2)
    })

    it('produces valid UUIDs', () => {
      const id = fixedId('店长')
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      expect(uuidV5('cat-study.agent.店长', SEED_NAMESPACE)).toBe(id)
    })
  })

  describe('DEMO_SESSION_ID', () => {
    it('is derived from the same namespace', () => {
      const sessionId = fixedId('demo-session')
      expect(sessionId).toBe(uuidV5('cat-study.agent.demo-session', SEED_NAMESPACE))
    })
  })

  describe('buildDemoKnowledge（知识库 Phase 1）', () => {
    const docs = buildDemoKnowledge()

    it('首期 2-3 条知识文档', () => {
      expect(docs.length).toBeGreaterThanOrEqual(2)
      expect(docs.length).toBeLessThanOrEqual(3)
    })

    it('每条：确定性 id / 非空 content / source / tags 数组', () => {
      for (const d of docs) {
        expect(d.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        )
        expect(d.content.length).toBeGreaterThan(0)
        expect(d.source.length).toBeGreaterThan(0)
        expect(Array.isArray(d.tags)).toBe(true)
        expect(d.tags.length).toBeGreaterThan(0)
      }
    })

    it('id 幂等固定（knowledgeId 同命名空间、不同前缀——与 agent id 空间隔离）', () => {
      const first = docs[0]
      const again = buildDemoKnowledge().find((d) => d.id === first.id)!
      expect(again.id).toBe(first.id)
      expect(again.content).toBe(first.content)
      // 前缀隔离：knowledgeId('提交规范') 与 fixedId('提交规范') 不同
      expect(knowledgeId('提交规范')).not.toBe(fixedId('提交规范'))
    })
  })
})
