/**
 * T-A ② 收尾兜底判据单测（judgeReviewFallback 三分支 + 边界）。
 *
 * 只测纯判据：spawn 侧是子进程 I/O（被测边界为文件系统/进程，按约定不在此覆盖）。
 */
import { describe, it, expect } from 'vitest'
import { judgeReviewFallback } from './review-fallback.js'

const SHA = 'a'.repeat(40)
const REVIEWER = '吐槽猫'

describe('judgeReviewFallback — T-A ② 收尾兜底判据', () => {
  it('有 commit 且回复未 @ 审查者 → 补投', () => {
    const v = judgeReviewFallback({ commitSha: SHA, mentions: [], reviewerName: REVIEWER })
    expect(v.deliver).toBe(true)
    expect(v.reason).toContain('收尾兜底投递')
  })

  it('回复已 @ 审查者 → 静默（主动投递已发生）', () => {
    const v = judgeReviewFallback({
      commitSha: SHA,
      mentions: [REVIEWER],
      reviewerName: REVIEWER,
    })
    expect(v.deliver).toBe(false)
    expect(v.reason).toContain('已 @')
  })

  it('本执行无 commit → 静默（无审查请求可投）', () => {
    const v = judgeReviewFallback({ commitSha: null, mentions: [], reviewerName: REVIEWER })
    expect(v.deliver).toBe(false)
    expect(v.reason).toContain('无 commit')
  })

  it('会话内无 reviewer 角色 → 静默（审查链不适用）', () => {
    const v = judgeReviewFallback({ commitSha: SHA, mentions: [], reviewerName: null })
    expect(v.deliver).toBe(false)
    expect(v.reason).toContain('reviewer')
  })

  it('mentions 含其他猫但不含审查者 → 仍补投（判据只认审查者）', () => {
    const v = judgeReviewFallback({
      commitSha: SHA,
      mentions: ['店长', 'ds猫'],
      reviewerName: REVIEWER,
    })
    expect(v.deliver).toBe(true)
  })

  it('commitSha 为 undefined（未反查到）与无 commit 同语义', () => {
    const v = judgeReviewFallback({ mentions: [REVIEWER], reviewerName: REVIEWER })
    expect(v.deliver).toBe(false)
    expect(v.reason).toContain('无 commit')
  })
})
