/**
 * 契约③ flow_state 状态机纯函数测试（无 DB 依赖）。
 *
 * - FLOW_MAIN_CHAIN：主干道序（implement → quality-gate → request-review →
 *   receive-review → closed）
 * - deriveNextIntent：读当前状态机械算「下一步」（派生数据，不落库）
 * - isOnMainChain：岔道状态不在主干道 → 状态机不接管
 */
import { describe, it, expect } from 'vitest'
import { FLOW_MAIN_CHAIN, deriveNextIntent, isOnMainChain } from './flow-state.js'

describe('execution/flow-state — FLOW_MAIN_CHAIN', () => {
  it('主干道序固定（ADR §4 契约③ 闭环：quality-gate → request-review → receive-review → 闭环）', () => {
    expect(FLOW_MAIN_CHAIN).toEqual([
      'implement',
      'quality-gate',
      'request-review',
      'receive-review',
      'closed',
    ])
  })
})

describe('execution/flow-state — deriveNextIntent', () => {
  it('未初始化 / implement → 下一步跑 quality-gate', () => {
    expect(deriveNextIntent(undefined)).toEqual({ stage: 'quality-gate', intent: 'quality_gate' })
    expect(deriveNextIntent('implement')).toEqual({ stage: 'quality-gate', intent: 'quality_gate' })
  })

  it('quality-gate → 请求审查（intent=review_commit，ADR 契约①示例）', () => {
    expect(deriveNextIntent('quality-gate')).toEqual({
      stage: 'request-review',
      intent: 'review_commit',
    })
  })

  it('request-review → 接收审查', () => {
    expect(deriveNextIntent('request-review')).toEqual({
      stage: 'receive-review',
      intent: 'receive_review',
    })
  })

  it('receive-review → 收口', () => {
    expect(deriveNextIntent('receive-review')).toEqual({ stage: 'closed', intent: 'closeout' })
  })

  it('closed（终态）→ null（无下一步）', () => {
    expect(deriveNextIntent('closed')).toBeNull()
  })
})

describe('execution/flow-state — isOnMainChain', () => {
  it('主干道状态在链上', () => {
    for (const s of FLOW_MAIN_CHAIN) {
      expect(isOnMainChain(s)).toBe(true)
    }
  })

  it('岔道状态（@求助 / 审查❌打回 / 需求澄清）不在链上 → 状态机不接管', () => {
    expect(isOnMainChain('help_request')).toBe(false)
    expect(isOnMainChain('reject')).toBe(false)
    expect(isOnMainChain('clarify')).toBe(false)
    expect(isOnMainChain(undefined)).toBe(false)
    expect(isOnMainChain('')).toBe(false)
  })
})
