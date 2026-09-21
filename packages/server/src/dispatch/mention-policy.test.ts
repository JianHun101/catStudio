import { describe, it, expect } from 'vitest'
import type { AgentRole } from '@cat-study/shared'
import {
  filterAllowedMentions,
  allowedTargetsDescription,
  MAX_MENTIONS_PER_REPLY,
} from './mention-policy.js'

const target = (name: string, role?: AgentRole) => ({ name, role })
const names = (ts: { name: string }[]) => ts.map((t) => t.name)

describe('mention-policy — A2A 白名单边矩阵', () => {
  describe('store（店长）→ 任意', () => {
    // 本条同时是**单目标闸作用域**的回归探针（票乙）：4 个目标一次 @ 出去全部保留，
    // 证明闸没把 store 也圈进去。写通道时若把作用域误写成「所有角色」，这里必红——
    // 一处断言守住两条契约（边表语义 + 闸的边界），故不另立重复用例。
    it('可 @ 任何角色', () => {
      const { allowed, blocked } = filterAllowedMentions({ role: 'store' }, [
        target('吐槽猫', 'reviewer'),
        target('ds猫', 'implementer'),
        target('dsh猫', 'implementer'),
        target('flash猫', 'implementer'),
      ])
      expect(names(allowed)).toEqual(['吐槽猫', 'ds猫', 'dsh猫', 'flash猫'])
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

    // 原「不可 @ 图测猫（vision）」负向用例已随 vision 退役删除（2026-09-13，单A）：
    // implementer 边表现在只剩 {store, reviewer}，**唯一**的非白名单角色就是
    // implementer 自身——上一条「implementer 互 @ 被拦」覆盖的正是同一分支，
    // 保留会得到一个同分支同断言的重复用例。覆盖未下降。

    it(`同 @ 两猫（均合法）→ 保 reviewer，另一被剥（count-limit，上限 ${MAX_MENTIONS_PER_REPLY}）`, () => {
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

  describe(`reviewer（吐槽猫）→ {store, implementer} ∪ 本次触发消息作者，且每条回复 ≤${MAX_MENTIONS_PER_REPLY} 个 @`, () => {
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
      // 边表原先只有「触发者」概念、没有「作者」，@作者 永远不可达）。
      // 单目标闸（票乙）后**一条回复只能 @ 一个**——本条收窄成单目标以保住
      // 原判据（边可达性）；「两个实施猫只留一个」归下方单目标闸矩阵覆盖，
      // 覆盖未下降。
      const { allowed, blocked } = filterAllowedMentions(
        { role: 'reviewer', triggerAuthorName: '店长' },
        [target('ds猫', 'implementer')]
      )
      expect(names(allowed)).toEqual(['ds猫'])
      expect(blocked).toEqual([])
    })

    it('可 @ 回本次触发消息作者（角色不在边表时仍放行——例外边保留）', () => {
      // 目标用 reviewer 自身：reviewer 边表 = {store, implementer}，reviewer 是
      // **真正不在边表里**的角色（vision 退役后，这是最后一个非边表角色）。
      // 与下一条同目标、只差 triggerAuthorName——隔离出的正是「例外边」这一个变量。
      const { allowed, blocked } = filterAllowedMentions(
        { role: 'reviewer', triggerAuthorName: '吐槽猫' },
        [target('吐槽猫', 'reviewer')]
      )
      expect(names(allowed)).toEqual(['吐槽猫'])
      expect(blocked).toEqual([])
    })

    it('不可 @ 另一位审查猫（reviewer）——非触发作者，不放开', () => {
      const { allowed, blocked } = filterAllowedMentions(
        { role: 'reviewer', triggerAuthorName: 'ds猫' },
        [target('吐槽猫', 'reviewer')]
      )
      expect(allowed).toEqual([])
      expect(blocked).toEqual([{ name: '吐槽猫', reason: 'role-not-allowed' }])
    })

    it('用户触发（无触发作者）+ 单目标 → 不受单目标闸影响', () => {
      const { allowed, blocked } = filterAllowedMentions({ role: 'reviewer' }, [
        target('店长', 'store'),
      ])
      expect(names(allowed)).toEqual(['店长'])
      expect(blocked).toEqual([])
    })

    // ─── 单目标闸（票乙，2026-09-20）──────────────────────────────────
    // 落地前 reviewer **无计数上限**：一条回复 @ 架构师 + @ 作者会让收口链与
    // 返工链同时被唤起（本闸要堵的形态）。超上限时保谁由**审查结论**决定，
    // 表的定义在 `mention-policy.ts` 的 REVIEWER_KEEP_PRIORITY。
    //
    // 每条都断言 blocked 的 reason：只断「留了谁」看不出剥除走的是 count-limit
    // 还是 role-not-allowed——后者意味着边表回归，是另一回事（两条路径的
    // 下游补救也不同：前者提示收敛目标，后者告知 store 猫结论悬空）。
    describe(`单目标闸：reviewer 交 >${MAX_MENTIONS_PER_REPLY} 个合法目标时按结论保一个`, () => {
      /** 双 @ 的两个合法目标：店长(store) + 实施猫(implementer)；请求人 = 实施猫 */
      const pair = () => [target('店长', 'store'), target('ds猫', 'implementer')]

      it('✅可合并（approve）→ 保 store（收口信号直达架构师），剥实施猫', () => {
        const { allowed, blocked } = filterAllowedMentions(
          { role: 'reviewer', triggerAuthorName: 'ds猫', verdict: 'approve' },
          pair()
        )
        expect(names(allowed)).toEqual(['店长'])
        expect(blocked).toEqual([{ name: 'ds猫', reason: 'count-limit' }])
      })

      it('❌需重做（reject）→ 保请求人（实施猫），剥 store', () => {
        const { allowed, blocked } = filterAllowedMentions(
          { role: 'reviewer', triggerAuthorName: 'ds猫', verdict: 'reject' },
          pair()
        )
        expect(names(allowed)).toEqual(['ds猫'])
        expect(blocked).toEqual([{ name: '店长', reason: 'count-limit' }])
      })

      it('💬仅评论（comment）且列表里没有 store → 退到请求人', () => {
        const { allowed, blocked } = filterAllowedMentions(
          { role: 'reviewer', triggerAuthorName: 'ds猫', verdict: 'comment' },
          [target('ds猫', 'implementer'), target('flash猫', 'implementer')]
        )
        expect(names(allowed)).toEqual(['ds猫'])
        expect(blocked).toEqual([{ name: 'flash猫', reason: 'count-limit' }])
      })

      it('结论不可得（未传 verdict）→ 保请求人（偏实施侧兜底）', () => {
        const { allowed, blocked } = filterAllowedMentions(
          { role: 'reviewer', triggerAuthorName: 'ds猫' },
          pair()
        )
        expect(names(allowed)).toEqual(['ds猫'])
        expect(blocked).toEqual([{ name: '店长', reason: 'count-limit' }])
      })

      it('结论不可得且请求人不在列表 → 退到 implementer 角色', () => {
        const { allowed, blocked } = filterAllowedMentions(
          { role: 'reviewer', triggerAuthorName: '用户' },
          pair()
        )
        expect(names(allowed)).toEqual(['ds猫'])
        expect(blocked).toEqual([{ name: '店长', reason: 'count-limit' }])
      })

      it('结论不可得且列表里只有 store → 保 store（保底第一个，不剥空）', () => {
        const { allowed, blocked } = filterAllowedMentions(
          { role: 'reviewer', triggerAuthorName: '用户' },
          [target('店长', 'store'), target('副店长', 'store')]
        )
        expect(names(allowed)).toEqual(['店长'])
        expect(blocked).toEqual([{ name: '副店长', reason: 'count-limit' }])
      })

      it('结论与 @ 书写顺序无关（逆序仍是同一裁决）', () => {
        const { allowed, blocked } = filterAllowedMentions(
          { role: 'reviewer', triggerAuthorName: 'ds猫', verdict: 'approve' },
          [target('ds猫', 'implementer'), target('店长', 'store')]
        )
        expect(names(allowed)).toEqual(['店长'])
        expect(blocked).toEqual([{ name: 'ds猫', reason: 'count-limit' }])
      })
    })
  })

  // 原 describe('vision（图测猫）→ {store}') 整块随角色退役删除（2026-09-13，单A）：
  // 边表已无该键，该角色不再有「允许集」，正向用例无被测对象。

  describe('未知角色 → 放行不拦截（老库零回归）', () => {
    it('发送者 role 缺失（undefined）→ 全放行', () => {
      const { allowed, blocked } = filterAllowedMentions({}, [
        target('ds猫', 'implementer'),
        target('吐槽猫', 'reviewer'),
      ])
      expect(names(allowed)).toEqual(['ds猫', '吐槽猫'])
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

  // ─── 退役不变量（vision，2026-09-13 单A）────────────────────────────
  // 老库残留行仍带 role='vision'（D 列取值域不受 TS 联合类型约束，残留照样读得出）。
  // 下面两条**成对**钉住退役后的两个方向——它们不是同一件事，方向相反：
  //   · 发送者侧：边表已无该键 → 落 `!rule` 兜底**放行**（fail-open）
  //   · 目标侧：`t.role='vision'` 是真值 → 落 `rule.includes` 失败**被拦**
  // 之所以要写下来：店长派活单把两者一并描述为"保住既有兜底"——**发送者侧并非
  // "保住"**，退役前该键在边表里、vision 发送者被限到 {store}；退役后才是全放行。
  // 这是一处**行为放宽**（不再是收紧），且只作用于已不存在的角色，实害为零；
  // 但"描述成守恒"与"实际放宽"必须分开记，否则下一个人会照描述去推。
  describe('已退役角色（vision）残留行的两向行为', () => {
    it('发送者残留 role=vision → 全放行（边表无该键 → !rule 兜底，非"守恒"是"放宽"）', () => {
      const { allowed, blocked } = filterAllowedMentions({ role: 'vision' as AgentRole }, [
        target('ds猫', 'implementer'),
        target('吐槽猫', 'reviewer'),
      ])
      expect(names(allowed)).toEqual(['ds猫', '吐槽猫'])
      expect(blocked).toEqual([])
    })

    it('目标残留 role=vision → 仍被拦（目标侧真值走 includes 失败，行为与退役前同）', () => {
      const { allowed, blocked } = filterAllowedMentions({ role: 'implementer' }, [
        target('图测猫', 'vision' as AgentRole),
      ])
      expect(allowed).toEqual([])
      expect(blocked).toEqual([{ name: '图测猫', reason: 'role-not-allowed' }])
    })
  })

  describe('allowedTargetsDescription', () => {
    it('各角色返回对应规则描述', () => {
      expect(allowedTargetsDescription('store')).toBe('任意猫')
      expect(allowedTargetsDescription('implementer')).toContain('店长')
      expect(allowedTargetsDescription('implementer')).toContain('吐槽猫')
      expect(allowedTargetsDescription('reviewer')).toContain('店长')
      expect(allowedTargetsDescription('reviewer')).toContain('实施猫')
      // 票乙：reviewer 的规则描述补上单目标上限（此前只有 implementer 那条带）
      expect(allowedTargetsDescription('reviewer')).toBe(
        `店长或实施猫（每条回复最多 ${MAX_MENTIONS_PER_REPLY} 个 @）`
      )
      expect(allowedTargetsDescription(undefined)).toBe('任意猫')
      expect(allowedTargetsDescription('unknown' as AgentRole)).toBe('任意猫')
    })
  })
})
