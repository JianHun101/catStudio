import { describe, it, expect } from 'vitest'
import {
  deliverySignalSchema,
  buildDeliverySignal,
  resolveDeliveryRef,
  planDelivery,
} from './delivery-signal.js'

describe('delivery-signal（ADR 0014 契约① 投递轻信号）', () => {
  describe('deliverySignalSchema（契约束① 形状）', () => {
    it('接受完整 {target, intent, ref}', () => {
      const s = deliverySignalSchema.parse({
        target: '吐槽猫',
        intent: 'review_commit',
        ref: 'aabbcc',
      })
      expect(s).toEqual({ target: '吐槽猫', intent: 'review_commit', ref: 'aabbcc' })
    })

    it('缺任一字段拒绝（轻信号三件套恒定）', () => {
      expect(() =>
        deliverySignalSchema.parse({ target: '吐槽猫', intent: 'review_commit' })
      ).toThrow()
      expect(() => deliverySignalSchema.parse({ target: '吐槽猫', ref: 'aabbcc' })).toThrow()
      expect(() => deliverySignalSchema.parse({ intent: 'review_commit', ref: 'aabbcc' })).toThrow()
      expect(() => deliverySignalSchema.parse({})).toThrow()
    })

    it('空字符串字段拒绝', () => {
      expect(() =>
        deliverySignalSchema.parse({ target: '', intent: 'review_commit', ref: 'aabbcc' })
      ).toThrow()
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
        target: '吐槽猫',
        intent: 'review_commit',
        commitSha: 'aabbcc',
        traceId: 't-1',
      })
      expect(s).toEqual({ target: '吐槽猫', intent: 'review_commit', ref: 'aabbcc' })
    })

    it('纯会话无 commit → ref 退 trace_id 不漏', () => {
      const s = buildDeliverySignal({
        target: '店长',
        intent: 'close_out',
        commitSha: undefined,
        traceId: 't-9',
      })
      expect(s).toEqual({ target: '店长', intent: 'close_out', ref: 't-9' })
    })
  })

  describe('planDelivery（产出 → 消费映射：post_message 首选 / 行首 @ fallback）', () => {
    it('post_message 可用 → 首选结构化路由到正确目标猫', () => {
      const s = buildDeliverySignal({
        target: '吐槽猫',
        intent: 'review_commit',
        commitSha: 'aabbcc',
        traceId: 't-1',
      })
      const action = planDelivery(s, { postMessageAvailable: true })
      expect(action).toEqual({ channel: 'post_message', target: '吐槽猫' })
    })

    it('post_message 不可用（预校验被拦）→ 降级行首 @ fallback', () => {
      const s = buildDeliverySignal({
        target: '店长',
        intent: 'close_out',
        commitSha: undefined,
        traceId: 't-9',
      })
      const action = planDelivery(s, { postMessageAvailable: false })
      expect(action).toEqual({ channel: 'at-mention', target: '店长' })
    })
  })
})
