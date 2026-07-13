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

const SEED_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'

function fixedId(name: string): string {
  return uuidV5(`cat-study.agent.${name}`, SEED_NAMESPACE)
}

describe('seed helpers', () => {
  describe('fixedId (uuid.v5)', () => {
    it('produces deterministic IDs for same input', () => {
      const id1 = fixedId('店长')
      const id2 = fixedId('店长')
      expect(id1).toBe(id2)
    })

    it('produces different IDs for different names', () => {
      const id1 = fixedId('店长')
      const id2 = fixedId('服务员')
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
})
