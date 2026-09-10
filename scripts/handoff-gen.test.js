/**
 * decideHookDelivery 判定逻辑单测（T-A ①：post-commit 兜底投递三分支）。
 *
 * 判据三态：有归属（agent 提交）→ 静默；无归属（用户手动提交）→ 投递；
 * 判据查不动 → 投递（降级语义：宁可多投不可漏投）。
 */
import { describe, it, expect } from 'vitest'
import { decideHookDelivery } from './handoff-gen.mjs'

describe('decideHookDelivery — T-A ① 钩子侧归属判据', () => {
  it('有归属执行（agent 执行中提交）→ 不投（实施猫负责主动投递）', () => {
    const verdict = decideHookDelivery(true)
    expect(verdict.deliver).toBe(false)
    expect(verdict.reason).toContain('有归属')
  })

  it('无归属执行（用户手动提交）→ 兜底投递', () => {
    const verdict = decideHookDelivery(false)
    expect(verdict.deliver).toBe(true)
    expect(verdict.reason).toContain('手动提交')
  })

  it('归属判据查不动（写回失败/响应不可解析）→ 投递，不静默吞', () => {
    const verdict = decideHookDelivery(null)
    expect(verdict.deliver).toBe(true)
    expect(verdict.reason).toContain('查不动')
  })

  it('undefined 与 null 同语义（判据缺失 = 查不动 → 投递）', () => {
    expect(decideHookDelivery(undefined).deliver).toBe(true)
  })
})

describe('decideHookDelivery — 原痛点复现（返工不新起链）', () => {
  it('同一任务链连续两次 commit（第二次为返工形态）→ 钩子投 0 条', () => {
    // 两次提交都是 agent 在执行中提交（有归属）——旧行为是「每 commit 必投一条」，
    // 即每次返工都新起一条链；新行为两次都静默，审查请求只有实施猫主动投的那一条。
    const commits = [
      { sha: 'a'.repeat(40), attributed: true }, // 首轮 commit
      { sha: 'b'.repeat(40), attributed: true }, // 返工 commit（新 SHA，链不变）
    ]
    const delivered = commits.filter((c) => decideHookDelivery(c.attributed).deliver)
    expect(delivered).toHaveLength(0)
  })

  it('手动提交与 agent 提交混合 → 只补投手动那条', () => {
    const commits = [
      { sha: 'a'.repeat(40), attributed: true }, // agent 提交 → 静默
      { sha: 'b'.repeat(40), attributed: false }, // 用户手动提交 → 兜底投
    ]
    const delivered = commits.filter((c) => decideHookDelivery(c.attributed).deliver)
    expect(delivered).toHaveLength(1)
    expect(delivered[0].sha).toBe('b'.repeat(40))
  })
})
