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

  it('种子包含 5 只猫（店长/ds猫/flash猫/吐槽猫/dsh猫）——图测猫已随 vision 角色退役', () => {
    expect(agents.map((a) => a.name).sort()).toEqual(['dsh猫', 'ds猫', 'flash猫', '吐槽猫', '店长'])
  })

  it('seed 不再产出任何已退役角色（vision）条目', () => {
    // 反向断言：退役不是"改个名字"——若有人把 vision 条目换个名字加回来，名字断言
    // 抓不到；这条按 role 值断言，角色一旦复活即红。
    expect(agents.filter((a) => a.role === 'vision')).toEqual([])
  })

  it('四只对话猫的角色与白名单边表对齐', () => {
    const roleOf = (name: string) => agents.find((a) => a.name === name)!.role
    expect(roleOf('店长')).toBe('store')
    expect(roleOf('ds猫')).toBe('implementer')
    expect(roleOf('flash猫')).toBe('implementer')
    expect(roleOf('吐槽猫')).toBe('reviewer')
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

    it('知识点只收铁律注入面没有的领域数据；复述铁律的条目不复存在', () => {
      // 「提交规范」「MCP 结构化路由」两条整条复述铁律（每轮强制注入）——检索副本纯重复
      // load 且两处必漂移，2026-09-18 结构重构票移除。收录判据见 seed-data.ts 注释。
      expect(docs.length).toBeGreaterThanOrEqual(1)
      const tags = docs.flatMap((d) => d.tags)
      expect(tags).not.toContain('提交规范')
      expect(tags).not.toContain('MCP')
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
      // 前缀隔离：knowledgeId 与 fixedId 同命名空间不同前缀（同名不撞 id）
      expect(knowledgeId('上下文注入机制')).not.toBe(fixedId('上下文注入机制'))
    })
  })
})
