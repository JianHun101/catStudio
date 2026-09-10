/**
 * chain-verdicts.ts 测试 — 「按锚查判词」单一实现的语义钉子（T-G）。
 *
 * 覆盖三条语义：
 * - **按锚**：别的锚名下的判词不串门
 * - **最新**：不是「曾出现过闭环档」（`hasClosedVerdictByTaskId` 的链级 LIMIT 1 语义）
 * - **两档查询各自筛值**：`getChainRejectionsSince` 只取 reject/suggest 且严格晚于 since
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { getLatestChainVerdict, getChainRejectionsSince } from './chain-verdicts.js'

const SESSION = 's1'

function seedSession(): void {
  getDb().prepare(`INSERT INTO sessions (id, title, agent_ids) VALUES (?, 't', '[]')`).run(SESSION)
}

/** 落一条判词（消息 task_id = 锚；`verdict` 行同源） */
function seedVerdict(opts: {
  msgId: string
  anchor: string | null
  verdict: string
  createdAt: string
  subject?: string | null
}): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO messages (id, session_id, role, content, mentions, task_id, created_at)
     VALUES (?, ?, 'agent', '审查回复', '[]', ?, ?)`
  ).run(opts.msgId, SESSION, opts.anchor, opts.createdAt)
  db.prepare(
    `INSERT INTO review_verdicts (message_id, session_id, reviewer_agent_id, subject_agent_id, verdict, created_at)
     VALUES (?, ?, 'reviewer-1', ?, ?, ?)`
  ).run(opts.msgId, SESSION, opts.subject ?? 'agent-x', opts.verdict, opts.createdAt)
}

beforeEach(() => {
  setDb(createTestDb())
  seedSession()
})

afterEach(() => {
  resetDb()
})

describe('eval/chain-verdicts — 按锚查判词', () => {
  it('getLatestChainVerdict：有 ⚠️ 又有 ✅ → 取**最新**那条（不是「曾出现过闭环档」）', () => {
    seedVerdict({
      msgId: 'v-old',
      anchor: 'A',
      verdict: 'approve',
      createdAt: '2026-09-10 10:00:00',
    })
    seedVerdict({
      msgId: 'v-new',
      anchor: 'A',
      verdict: 'suggest',
      createdAt: '2026-09-10 11:00:00',
    })

    const latest = getLatestChainVerdict('A', SESSION)
    // 旧口径（链级 LIMIT 1 存在性）会给出 approve ⇒ 本条对旧实现必红
    expect(latest?.message_id).toBe('v-new')
    expect(latest?.verdict).toBe('suggest')
  })

  it('getLatestChainVerdict：别的锚名下的判词不串门', () => {
    seedVerdict({ msgId: 'v-b', anchor: 'B', verdict: 'reject', createdAt: '2026-09-10 12:00:00' })

    expect(getLatestChainVerdict('A', SESSION)).toBeUndefined()
    expect(getLatestChainVerdict('B', SESSION)?.message_id).toBe('v-b')
  })

  it('getLatestChainVerdict：无锚 → undefined（无锚即无链，不猜、不查库）', () => {
    seedVerdict({
      msgId: 'v-null',
      anchor: null,
      verdict: 'approve',
      createdAt: '2026-09-10 10:00:00',
    })

    expect(getLatestChainVerdict(null, SESSION)).toBeUndefined()
    expect(getLatestChainVerdict(undefined, SESSION)).toBeUndefined()
  })

  it('getLatestChainVerdict：只取本会话（同锚跨会话不串）', () => {
    seedVerdict({
      msgId: 'v-s1',
      anchor: 'A',
      verdict: 'approve',
      createdAt: '2026-09-10 10:00:00',
    })

    expect(getLatestChainVerdict('A', 'other-session')).toBeUndefined()
    expect(getLatestChainVerdict('A', SESSION)?.message_id).toBe('v-s1')
  })

  it('getChainRejectionsSince：只取 reject/suggest 且严格晚于 since，DESC 序', () => {
    seedVerdict({ msgId: 'v-1', anchor: 'A', verdict: 'approve', createdAt: '2026-09-10 10:00:00' })
    seedVerdict({ msgId: 'v-2', anchor: 'A', verdict: 'suggest', createdAt: '2026-09-10 11:00:00' })
    seedVerdict({ msgId: 'v-3', anchor: 'A', verdict: 'reject', createdAt: '2026-09-10 12:00:00' })

    const rows = getChainRejectionsSince('A', SESSION, '2026-09-10 10:30:00')
    // approve 不算打回；since 之前的（无）不计；DESC 序 ⇒ v-3 在前
    expect(rows.map((r) => r.message_id)).toEqual(['v-3', 'v-2'])
  })

  it('getChainRejectionsSince：无锚 → 空数组（不抛错）', () => {
    expect(getChainRejectionsSince(null, SESSION, '2026-09-10 00:00:00')).toEqual([])
  })

  // ─── tie-break：同 created_at 时按**插入序**（T-G 补）─────────────────
  // 原实现 `ORDER BY v.created_at DESC, v.message_id DESC`——message_id 是 uuid，
  // 字典序与时间无关 ⇒ 同秒落库的两条判词谁胜出是随机的。改用 `m.rowid DESC`（插入序）。
  // 判别设计：先插字典序**大**的、后插字典序**小**的，两种实现的胜者必然相反。

  it('getLatestChainVerdict：同 created_at → 取后插入的那条（旧实现按 uuid 字典序，必红）', () => {
    seedVerdict({
      msgId: 'v-zzz',
      anchor: 'A',
      verdict: 'suggest',
      createdAt: '2026-09-10 10:00:00',
    })
    seedVerdict({
      msgId: 'v-aaa',
      anchor: 'A',
      verdict: 'approve',
      createdAt: '2026-09-10 10:00:00',
    })

    // 后插入 = 更新的那条 ⇒ 旧实现返回 v-zzz（uuid 字典序更大者）
    expect(getLatestChainVerdict('A', SESSION)?.message_id).toBe('v-aaa')
  })

  it('getChainRejectionsSince：同 created_at → [0] 是后插入的那条（旧实现按 uuid 字典序，必红）', () => {
    seedVerdict({
      msgId: 'v-zzz',
      anchor: 'A',
      verdict: 'suggest',
      createdAt: '2026-09-10 11:00:00',
    })
    seedVerdict({
      msgId: 'v-aaa',
      anchor: 'A',
      verdict: 'reject',
      createdAt: '2026-09-10 11:00:00',
    })

    const rows = getChainRejectionsSince('A', SESSION, '2026-09-10 10:00:00')
    // [0] 被 episodes 当「最近一次打回」的时间源 —— 取错条会误导 corrected_success 判定
    expect(rows[0].message_id).toBe('v-aaa')
  })
})
