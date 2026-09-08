import { describe, it, expect } from 'vitest'
import type { AgentRole } from '@cat-study/shared'
import {
  filterAllowedMentions,
  allowedTargetsDescription,
  IMPLEMENTER_MAX_MENTIONS_PER_REPLY,
} from './mention-policy.js'

const target = (name: string, role?: AgentRole) => ({ name, role })
const names = (ts: { name: string }[]) => ts.map((t) => t.name)

describe('mention-policy — A2A 白名单边矩阵', () => {
  describe('store（店长）→ 任意', () => {
    it('可 @ 任何角色', () => {
      const { allowed, blocked } = filterAllowedMentions({ role: 'store' }, [
        target('吐槽猫', 'reviewer'),
        target('ds猫', 'implementer'),
        target('图测猫', 'vision'),
        target('flash猫', 'implementer'),
      ])
      expect(names(allowed)).toEqual(['吐槽猫', 'ds猫', '图测猫', 'flash猫'])
      expect(blocked).toEqual([])
    })
  })

  describe('implementer（实施猫）→ {store, reviewer}，且每条回复 ≤1 个 @', () => {
    it('可 @ 店长（store）', () => {
      const { allowed, blocked } = filterAllowedMentions({ role: 'implementer' }, [
        target('店长', 'store'),
      ])
      expect(names(allowed)).toEqual(['店长'])
      expect(blocked).toEqual([])
    })

    it('可 @ 吐槽猫（reviewer）', () => {
      const { allowed, blocked } = filterAllowedMentions({ role: 'implementer' }, [
        target('吐槽猫', 'reviewer'),
      ])
      expect(names(allowed)).toEqual(['吐槽猫'])
      expect(blocked).toEqual([])
    })

    it('不可 @ 其他实施猫（implementer 互 @ 被拦）', () => {
      const { allowed, blocked } = filterAllowedMentions({ role: 'implementer' }, [
        target('flash猫', 'implementer'),
      ])
      expect(allowed).toEqual([])
      expect(blocked).toEqual([{ name: 'flash猫', reason: 'role-not-allowed' }])
    })

    it('不可 @ 图测猫（vision）', () => {
      const { allowed, blocked } = filterAllowedMentions({ role: 'implementer' }, [
        target('图测猫', 'vision'),
      ])
      expect(allowed).toEqual([])
      expect(blocked).toEqual([{ name: '图测猫', reason: 'role-not-allowed' }])
    })

    it(`同 @ 两猫（均合法）→ 保 reviewer，另一被剥（count-limit，上限 ${IMPLEMENTER_MAX_MENTIONS_PER_REPLY}）`, () => {
      const { allowed, blocked } = filterAllowedMentions({ role: 'implementer' }, [
        target('店长', 'store'),
        target('吐槽猫', 'reviewer'),
      ])
      expect(names(allowed)).toEqual(['吐槽猫']) // reviewer 优先——审查链必达
      expect(blocked).toEqual([{ name: '店长', reason: 'count-limit' }])
    })

    it('同 @ 两猫逆序（@[吐槽猫,店长]）→ 仍保 reviewer', () => {
      const { allowed, blocked } = filterAllowedMentions({ role: 'implementer' }, [
        target('吐槽猫', 'reviewer'),
        target('店长', 'store'),
      ])
      expect(names(allowed)).toEqual(['吐槽猫']) // 与文本/注册顺序无关
      expect(blocked).toEqual([{ name: '店长', reason: 'count-limit' }])
    })

    it('同 @ 两合法目标且无 reviewer（如未来多 store）→ 保第一个', () => {
      const { allowed, blocked } = filterAllowedMentions({ role: 'implementer' }, [
        target('店长', 'store'),
        target('副店长', 'store'),
      ])
      expect(names(allowed)).toEqual(['店长']) // 无 reviewer 时保传入顺序第一个
      expect(blocked).toEqual([{ name: '副店长', reason: 'count-limit' }])
    })

    it('目标角色未知（老库未配）→ 放行', () => {
      const { allowed, blocked } = filterAllowedMentions({ role: 'implementer' }, [
        target('神秘猫'),
      ])
      expect(names(allowed)).toEqual(['神秘猫'])
      expect(blocked).toEqual([])
    })
  })

  describe('reviewer（吐槽猫）→ {store, implementer} ∪ 本次触发消息作者', () => {
    it('可 @ 店长（store）', () => {
      const { allowed, blocked } = filterAllowedMentions(
        { role: 'reviewer', triggerAuthorName: 'ds猫' },
        [target('店长', 'store')]
      )
      expect(names(allowed)).toEqual(['店长'])
      expect(blocked).toEqual([])
    })

    it('可 @ 实施猫（implementer）——收口链回作者通路，无需是触发作者', () => {
      // 关键回归：触发者是用户/店长时，⚠️/❌ 仍能投回作者（事故根因：
      // 边表原先只有「触发者」概念、没有「作者」，@作者 永远不可达）
      const { allowed, blocked } = filterAllowedMentions(
        { role: 'reviewer', triggerAuthorName: '店长' },
        [target('ds猫', 'implementer'), target('flash猫', 'implementer')]
      )
      expect(names(allowed)).toEqual(['ds猫', 'flash猫'])
      expect(blocked).toEqual([])
    })

    it('可 @ 回本次触发消息作者（角色不在边表时仍放行——例外边保留）', () => {
      const { allowed, blocked } = filterAllowedMentions(
        { role: 'reviewer', triggerAuthorName: '图测猫' },
        [target('图测猫', 'vision')]
      )
      expect(names(allowed)).toEqual(['图测猫'])
      expect(blocked).toEqual([])
    })

    it('不可 @ 图测猫（vision）——非触发作者，不放开', () => {
      const { allowed, blocked } = filterAllowedMentions(
        { role: 'reviewer', triggerAuthorName: 'ds猫' },
        [target('图测猫', 'vision')]
      )
      expect(allowed).toEqual([])
      expect(blocked).toEqual([{ name: '图测猫', reason: 'role-not-allowed' }])
    })

    it('用户触发（无触发作者）→ 可 @ 店长与实施猫', () => {
      const { allowed, blocked } = filterAllowedMentions({ role: 'reviewer' }, [
        target('店长', 'store'),
        target('ds猫', 'implementer'),
      ])
      expect(names(allowed)).toEqual(['店长', 'ds猫'])
      expect(blocked).toEqual([])
    })
  })

  describe('vision（图测猫）→ {store}', () => {
    it('可 @ 店长', () => {
      const { allowed, blocked } = filterAllowedMentions({ role: 'vision' }, [
        target('店长', 'store'),
      ])
      expect(names(allowed)).toEqual(['店长'])
      expect(blocked).toEqual([])
    })

    it('不可 @ 其他猫', () => {
      const { allowed, blocked } = filterAllowedMentions({ role: 'vision' }, [
        target('ds猫', 'implementer'),
        target('吐槽猫', 'reviewer'),
      ])
      expect(allowed).toEqual([])
      expect(blocked).toEqual([
        { name: 'ds猫', reason: 'role-not-allowed' },
        { name: '吐槽猫', reason: 'role-not-allowed' },
      ])
    })
  })

  describe('未知角色 → 放行不拦截（老库零回归）', () => {
    it('发送者 role 缺失（undefined）→ 全放行', () => {
      const { allowed, blocked } = filterAllowedMentions({}, [
        target('ds猫', 'implementer'),
        target('图测猫', 'vision'),
      ])
      expect(names(allowed)).toEqual(['ds猫', '图测猫'])
      expect(blocked).toEqual([])
    })

    it('发送者 role 为 DB 默认值 "unknown"（不在边表）→ 全放行', () => {
      const { allowed, blocked } = filterAllowedMentions({ role: 'unknown' as AgentRole }, [
        target('ds猫', 'implementer'),
      ])
      expect(names(allowed)).toEqual(['ds猫'])
      expect(blocked).toEqual([])
    })
  })

  describe('allowedTargetsDescription', () => {
    it('各角色返回对应规则描述', () => {
      expect(allowedTargetsDescription('store')).toBe('任意猫')
      expect(allowedTargetsDescription('implementer')).toContain('店长')
      expect(allowedTargetsDescription('implementer')).toContain('吐槽猫')
      expect(allowedTargetsDescription('reviewer')).toContain('店长')
      expect(allowedTargetsDescription('reviewer')).toContain('实施猫')
      expect(allowedTargetsDescription('vision')).toBe('店长')
      expect(allowedTargetsDescription(undefined)).toBe('任意猫')
      expect(allowedTargetsDescription('unknown' as AgentRole)).toBe('任意猫')
    })
  })
})
