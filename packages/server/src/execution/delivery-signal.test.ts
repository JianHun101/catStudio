import { describe, it, expect } from 'vitest'
import {
  deliverySignalSchema,
  DELIVERY_INTENTS,
  type DeliveryIntent,
  buildDeliverySignal,
  resolveDeliveryRef,
  planDelivery,
} from './delivery-signal.js'
import { deriveNextIntent, FLOW_MAIN_CHAIN } from './flow-state.js'

describe('delivery-signal（ADR 0014 契约① 投递轻信号）', () => {
  describe('deliverySignalSchema（契约束① 形状）', () => {
    it('接受完整 {targets, intent, ref}——targets 数组化（契约即传输层 shape）', () => {
      const s = deliverySignalSchema.parse({
        targets: ['吐槽猫'],
        intent: 'review_commit',
        ref: 'aabbcc',
      })
      expect(s).toEqual({ targets: ['吐槽猫'], intent: 'review_commit', ref: 'aabbcc' })
    })

    it('targets 支持多播（一次投多只天然承载）', () => {
      const s = deliverySignalSchema.parse({
        targets: ['店长', '吐槽猫'],
        intent: 'closeout',
        ref: 'aabbcc',
      })
      expect(s.targets).toEqual(['店长', '吐槽猫'])
    })

    it('缺任一字段拒绝（轻信号三件套恒定）', () => {
      expect(() =>
        deliverySignalSchema.parse({ targets: ['吐槽猫'], intent: 'review_commit' })
      ).toThrow()
      expect(() => deliverySignalSchema.parse({ targets: ['吐槽猫'], ref: 'aabbcc' })).toThrow()
      expect(() => deliverySignalSchema.parse({ intent: 'review_commit', ref: 'aabbcc' })).toThrow()
      expect(() => deliverySignalSchema.parse({})).toThrow()
    })

    it('targets 空数组 / 空字符串字段拒绝', () => {
      expect(() =>
        deliverySignalSchema.parse({ targets: [], intent: 'review_commit', ref: 'aabbcc' })
      ).toThrow()
      expect(() =>
        deliverySignalSchema.parse({ targets: [''], intent: 'review_commit', ref: 'aabbcc' })
      ).toThrow()
      expect(() =>
        deliverySignalSchema.parse({ targets: ['吐槽猫'], intent: 'review_commit', ref: '' })
      ).toThrow()
    })

    it('intent 值域定死——弃旧变体 request_review / close_out（Zod 违规抛错）', () => {
      expect(() =>
        deliverySignalSchema.parse({
          targets: ['吐槽猫'],
          intent: 'request_review',
          ref: 'aabbcc',
        })
      ).toThrow()
      expect(() =>
        deliverySignalSchema.parse({ targets: ['店长'], intent: 'close_out', ref: 't-9' })
      ).toThrow()
      expect(DELIVERY_INTENTS).toEqual([
        'quality_gate',
        'review_commit',
        'receive_review',
        'closeout',
      ])
    })
  })

  describe('resolveDeliveryRef（ref 主键：commit_sha 优先，纯会话退 trace_id）', () => {
    it('已知 commit_sha → ref 主键（审查链事件定位+去重同源）', () => {
      expect(resolveDeliveryRef({ commitSha: 'aabbcc', traceId: 't-1' })).toBe('aabbcc')
    })

    it('纯会话无 commit → 退 trace_id 兜底（不漏）', () => {
      expect(resolveDeliveryRef({ commitSha: undefined, traceId: 't-1' })).toBe('t-1')
      expect(resolveDeliveryRef({ traceId: 't-9' })).toBe('t-9')
    })
  })

  describe('buildDeliverySignal（产出轻信号，ref 主键语义内聚）', () => {
    it('已知 sha 的 commit → 产出 ref=sha 的轻信号（恰好路由到正确目标猫的契约载体）', () => {
      const s = buildDeliverySignal({
        targets: ['吐槽猫'],
        intent: 'review_commit',
        commitSha: 'aabbcc',
        traceId: 't-1',
      })
      expect(s).toEqual({ targets: ['吐槽猫'], intent: 'review_commit', ref: 'aabbcc' })
    })

    it('纯会话无 commit → ref 退 trace_id 不漏', () => {
      const s = buildDeliverySignal({
        targets: ['店长'],
        intent: 'closeout',
        commitSha: undefined,
        traceId: 't-9',
      })
      expect(s).toEqual({ targets: ['店长'], intent: 'closeout', ref: 't-9' })
    })
  })

  describe('planDelivery（产出 → 消费映射：post_message 首选 / 行首 @ fallback）', () => {
    it('post_message 可用 → 首选结构化路由到正确目标猫（targets 数组透传）', () => {
      const s = buildDeliverySignal({
        targets: ['吐槽猫'],
        intent: 'review_commit',
        commitSha: 'aabbcc',
        traceId: 't-1',
      })
      const action = planDelivery(s, { postMessageAvailable: true })
      expect(action).toEqual({ channel: 'post_message', targets: ['吐槽猫'] })
    })

    it('post_message 不可用（预校验被拦）→ 降级行首 @ fallback', () => {
      const s = buildDeliverySignal({
        targets: ['店长'],
        intent: 'closeout',
        commitSha: undefined,
        traceId: 't-9',
      })
      const action = planDelivery(s, { postMessageAvailable: false })
      expect(action).toEqual({ channel: 'at-mention', targets: ['店长'] })
    })

    it('多播信号映射为 targets 数组原样透传（无适配层，契约即传输层 shape）', () => {
      const s = buildDeliverySignal({
        targets: ['店长', '吐槽猫'],
        intent: 'receive_review',
        commitSha: 'aabbcc',
        traceId: 't-1',
      })
      expect(planDelivery(s, { postMessageAvailable: true }).targets).toEqual(['店长', '吐槽猫'])
    })
  })

  describe('intent 值域 === 派生谱（契约① 与 契约③ 状态机结构性对齐，单源）', () => {
    it('delivery-signal 契约值域 === flow-state 派生谱（bijection：无孤儿值、无缺失值）', () => {
      // 收集状态机主干道派生出的全部 intent（closed 终态 → null 无下一步）
      const derived = new Set<DeliveryIntent>()
      for (const stage of FLOW_MAIN_CHAIN) {
        const next = deriveNextIntent(stage)
        if (next) derived.add(next.intent)
      }
      // 每个派生 intent 都是合法契约值（compile-time 已保证，运行时再断言）
      expect([...derived].every((i) => DELIVERY_INTENTS.includes(i))).toBe(true)
      // 契约值域全部被派生覆盖（无孤儿值）——bijection 双射
      expect([...derived].sort()).toEqual([...DELIVERY_INTENTS].sort())
    })
  })
})
