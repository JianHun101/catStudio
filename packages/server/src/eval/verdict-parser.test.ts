/**
 * verdict-parser 测试 — W3 L3 契约。
 *
 * 纯函数单测（parseReviewVerdict 无 I/O）+ recordReviewVerdict 落库集成
 * （真实 SQLite :memory:，走 repository 层）。契约验收三分支：
 * approve→subject null；suggest/reject 只@作者 / @店长+作者 / 只@店长→null+no_subject。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository } from '../db/repository/index.js'
import { parseReviewVerdict, recordReviewVerdict } from './verdict-parser.js'

/** 店长（store）+ 作者（非 store）的典型作用域 */
const TARGETS = [
  { name: '店长', isStore: true },
  { name: 'ds猫', isStore: false },
]

describe('parseReviewVerdict — 纯函数', () => {
  it('approve 行首标记 → verdict=approve、subject=null（即使 @ 店长）', () => {
    const r = parseReviewVerdict('审查完毕，全部通过。\n✅可合并', TARGETS)
    expect(r).toEqual({ kind: 'verdict', verdict: 'approve', subject: null, failure: null })
  })

  it('suggest 只@作者 → subject=作者', () => {
    const r = parseReviewVerdict('⚠️建议修改 见下。', [{ name: 'ds猫', isStore: false }])
    expect(r).toEqual({
      kind: 'verdict',
      verdict: 'suggest',
      subject: 'ds猫',
      failure: null,
    })
  })

  it('suggest @店长+作者 → subject=作者（首个非 store 目标，店长排前也取作者）', () => {
    const r = parseReviewVerdict('⚠️建议修改 需返工。', [
      { name: '店长', isStore: true },
      { name: 'ds猫', isStore: false },
    ])
    expect(r).toEqual({
      kind: 'verdict',
      verdict: 'suggest',
      subject: 'ds猫',
      failure: null,
    })
  })

  it('reject 只@店长 → subject=null + failure=no_subject', () => {
    const r = parseReviewVerdict('❌需重做 全部推倒。', [{ name: '店长', isStore: true }])
    expect(r).toEqual({
      kind: 'verdict',
      verdict: 'reject',
      subject: null,
      failure: 'no_subject',
    })
  })

  it('无行首标记 → no-marker（不落库）', () => {
    const r = parseReviewVerdict('整体不错，没有结论标记。', TARGETS)
    expect(r).toEqual({ kind: 'no-marker' })
  })

  it('句中复述标记（非行首）→ no-marker（防正文复述误命中）', () => {
    const r = parseReviewVerdict('这个方案 ✅可合并，不用改。', TARGETS)
    expect(r).toEqual({ kind: 'no-marker' })
  })

  it('代码块内的标记 → 不误命中（剥离后 no-marker）', () => {
    const r = parseReviewVerdict('```\n✅可合并\n```\n正文无结论。', TARGETS)
    expect(r).toEqual({ kind: 'no-marker' })
  })

  it('行首 emoji 非标准 marker → failure=bad_verdict（格式漂移防御）', () => {
    const r = parseReviewVerdict('✅ 可合并（带空格变体）', TARGETS)
    expect(r).toEqual({ kind: 'failure', reason: 'bad_verdict' })
  })

  it('行首 ✅ 前缀变体（✅可合并了）→ bad_verdict（格式漂移防御，不静默）', () => {
    const r = parseReviewVerdict('✅可合并了，结论如下', TARGETS)
    expect(r).toEqual({ kind: 'failure', reason: 'bad_verdict' })
  })

  it('多标记取最后出现者（结论在末尾语义，同 buildReviewLoopHint）', () => {
    const r = parseReviewVerdict('⚠️建议修改 先说问题。\n✅可合并 后来确认了', TARGETS)
    expect(r).toEqual({ kind: 'verdict', verdict: 'approve', subject: null, failure: null })
  })

  it('suggest 但 targets 为空（防御）→ subject=null + no_subject', () => {
    const r = parseReviewVerdict('⚠️建议修改', [])
    expect(r).toEqual({
      kind: 'verdict',
      verdict: 'suggest',
      subject: null,
      failure: 'no_subject',
    })
  })
})

describe('recordReviewVerdict — 解析 + 落库', () => {
  beforeEach(() => {
    setDb(createTestDb())
    initRepository(getDb())
  })

  afterEach(() => {
    resetDb()
  })

  const verdictsOf = (messageId: string) =>
    getDb().prepare('SELECT * FROM review_verdicts WHERE message_id = ?').get(messageId) as
      Record<string, unknown> | undefined

  const failuresOf = (messageId: string) =>
    getDb().prepare('SELECT * FROM review_parse_failures WHERE message_id = ?').get(messageId) as
      Record<string, unknown> | undefined

  it('approve → review_verdicts 落库 subject=null，failure 表不写', () => {
    recordReviewVerdict({
      messageId: 'm-approve',
      sessionId: 's1',
      reviewerAgentId: 'reviewer-1',
      content: '没问题\n✅可合并',
      targets: TARGETS,
    })
    const row = verdictsOf('m-approve')!
    expect(row.verdict).toBe('approve')
    expect(row.subject_agent_id).toBeNull()
    expect(row.session_id).toBe('s1')
    expect(row.reviewer_agent_id).toBe('reviewer-1')
    expect(failuresOf('m-approve')).toBeUndefined()
  })

  it('suggest + 只@店长 → review_verdicts subject=null + failure no_subject 双写', () => {
    recordReviewVerdict({
      messageId: 'm-nosubject',
      sessionId: 's1',
      reviewerAgentId: 'reviewer-1',
      content: '❌需重做',
      targets: [{ name: '店长', isStore: true }],
    })
    const row = verdictsOf('m-nosubject')!
    expect(row.verdict).toBe('reject')
    expect(row.subject_agent_id).toBeNull()
    const fail = failuresOf('m-nosubject')!
    expect(fail.reason).toBe('no_subject')
    expect(fail.raw).toContain('❌需重做')
  })

  it('bad_verdict → 只写 failure 表，不写 review_verdicts', () => {
    recordReviewVerdict({
      messageId: 'm-bad',
      sessionId: 's1',
      reviewerAgentId: 'reviewer-1',
      content: '✅ 可合并',
      targets: TARGETS,
    })
    expect(verdictsOf('m-bad')).toBeUndefined()
    const fail = failuresOf('m-bad')!
    expect(fail.reason).toBe('bad_verdict')
    expect(fail.raw).toContain('✅ 可合并')
  })

  it('no-marker → 两表都不写', () => {
    recordReviewVerdict({
      messageId: 'm-none',
      sessionId: 's1',
      reviewerAgentId: 'reviewer-1',
      content: '日常汇报，无结论。',
      targets: TARGETS,
    })
    expect(verdictsOf('m-none')).toBeUndefined()
    expect(failuresOf('m-none')).toBeUndefined()
  })

  it('同 message_id 重复落库（INSERT OR IGNORE）→ 不抛错不覆盖', () => {
    recordReviewVerdict({
      messageId: 'm-dupe',
      sessionId: 's1',
      reviewerAgentId: 'reviewer-1',
      content: '✅可合并',
      targets: TARGETS,
    })
    expect(() =>
      recordReviewVerdict({
        messageId: 'm-dupe',
        sessionId: 's1',
        reviewerAgentId: 'reviewer-1',
        content: '✅可合并',
        targets: TARGETS,
      })
    ).not.toThrow()
    const rows = getDb()
      .prepare('SELECT COUNT(*) AS c FROM review_verdicts WHERE message_id = ?')
      .get('m-dupe') as { c: number }
    expect(rows.c).toBe(1)
  })
})
