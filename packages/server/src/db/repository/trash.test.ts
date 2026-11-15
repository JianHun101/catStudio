/**
 * 回收站仓储（T2）：列表两段、到期清扫边界、组条目同批语义、清空、索引。
 *
 * 时间一律显式注入 `now`——`purgeExpiredTrash(now)` / `listTrash(now)` 的测试缝就是为
 * 「±1 分钟」这类边界准备的，不靠 `sleep` / 真实时钟。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createTestDb } from '../../test-helpers.js'
import { setDb, resetDb } from '../index.js'
import { initRepository, trash as trashRepo } from './index.js'

const DAY = 24 * 60 * 60 * 1000
const MIN = 60 * 1000
const NOW = Date.parse('2026-03-01T00:00:00.000Z')

const iso = (ms: number) => new Date(ms).toISOString()

describe('trash repo — 回收站列表 / 清扫（T2）', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createTestDb()
    setDb(db)
    initRepository(db)
    db.prepare(
      `INSERT INTO agents (id, name, system_prompt, llm_api_key)
       VALUES ('a1', '猫一', 'p', 'sk-test')`
    ).run()
  })

  afterEach(() => {
    resetDb()
    vi.unstubAllEnvs()
  })

  const insertGroup = (id: string, name: string, deletedAt: string | null = null) => {
    db.prepare(
      `INSERT INTO session_groups (id, name, created_at, updated_at, deleted_at)
       VALUES (?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?)`
    ).run(id, name, deletedAt)
  }

  const insertSession = (
    id: string,
    title: string,
    opts: { groupId?: string | null; deletedAt?: string | null } = {}
  ) => {
    db.prepare(
      `INSERT INTO sessions (id, title, group_id, deleted_at)
       VALUES (?, ?, ?, ?)`
    ).run(id, title, opts.groupId ?? null, opts.deletedAt ?? null)
  }

  const insertMessage = (id: string, sessionId: string) => {
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, mentions)
       VALUES (?, ?, 'user', 'hello', '[]')`
    ).run(id, sessionId)
  }

  it('列表：组条目 / 会话条目两段；同批不重复；过期滤掉；原组名保留', () => {
    const groupTs = iso(NOW - 1 * DAY)
    insertGroup('g1', '删除的组', groupTs)
    insertSession('s-batch', '同批会话', { groupId: 'g1', deletedAt: groupTs })
    insertSession('s-single', '早先单删', { groupId: 'g1', deletedAt: iso(NOW - 2 * DAY) })
    insertSession('s-free', '未分组单删', { deletedAt: iso(NOW - 3 * DAY) })
    insertSession('s-expired', '过期单删', { deletedAt: iso(NOW - 8 * DAY) })
    insertMessage('m-batch', 's-batch')
    insertMessage('m-single', 's-single')

    const entries = trashRepo.listTrash(NOW)
    expect(entries.map((e) => e.id).sort()).toEqual(['g1', 's-free', 's-single'])

    const group = entries.find((e) => e.id === 'g1')!
    expect(group).toMatchObject({
      kind: 'group',
      name: '删除的组',
      deletedAt: groupTs,
      purgeAfter: iso(NOW - 1 * DAY + 7 * DAY),
      daysLeft: 6,
      sessionCount: 1,
      messageCount: 1,
      groupId: null,
      groupName: null,
    })

    // 同批会话不重复出现在「单个会话」段
    expect(entries.some((e) => e.id === 's-batch')).toBe(false)

    const single = entries.find((e) => e.id === 's-single')!
    expect(single).toMatchObject({
      kind: 'session',
      name: '早先单删',
      sessionCount: 1,
      messageCount: 1,
      groupId: 'g1',
      groupName: '删除的组',
    })
    expect(single.daysLeft).toBe(5)

    // 过期条目已从列表滤掉
    expect(entries.some((e) => e.id === 's-expired')).toBe(false)
  })

  it('到期边界：now-7d+1min 保留，now-7d-1min 连同消息 / 执行日志 / 依赖行清除', () => {
    const kept = iso(NOW - 7 * DAY + MIN)
    const purged = iso(NOW - 7 * DAY - MIN)
    insertSession('s-kept', '差一分钟过期', { deletedAt: kept })
    insertSession('s-purged', '已过期', { deletedAt: purged })
    insertMessage('m-purged', 's-purged')
    db.prepare(
      `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status)
       VALUES ('log-purged', 's-purged', 'a1', 'm-purged', 'completed')`
    ).run()
    db.prepare(
      `INSERT INTO flow_states (session_id, commit_sha, state, updated_at)
       VALUES ('s-purged', 'sha1', 'x', '2026-01-01T00:00:00.000Z')`
    ).run()

    const result = trashRepo.purgeExpiredTrash(NOW)
    expect(result).toMatchObject({
      groups: 0,
      sessions: 1,
      sessionIds: ['s-purged'],
      groupIds: [],
    })
    expect(db.prepare('SELECT 1 FROM sessions WHERE id = ?').get('s-kept')).toBeDefined()
    expect(db.prepare('SELECT 1 FROM sessions WHERE id = ?').get('s-purged')).toBeUndefined()
    expect(db.prepare('SELECT 1 FROM messages WHERE id = ?').get('m-purged')).toBeUndefined()
    expect(
      db.prepare('SELECT 1 FROM execution_logs WHERE id = ?').get('log-purged')
    ).toBeUndefined()
    expect(
      db.prepare('SELECT 1 FROM flow_states WHERE session_id = ?').get('s-purged')
    ).toBeUndefined()
  })

  it('组条目到期：组行 + 同批会话消失，早先单删的会话仍在（属会话条目）', () => {
    const oldTs = iso(NOW - 8 * DAY)
    insertGroup('g-old', '过期组', oldTs)
    insertSession('s-batch', '同批', { groupId: 'g-old', deletedAt: oldTs })
    insertSession('s-earlier', '早先单删', { groupId: 'g-old', deletedAt: iso(NOW - 3 * DAY) })

    const result = trashRepo.purgeExpiredTrash(NOW)
    expect(result).toMatchObject({
      groups: 1,
      sessionIds: ['s-batch'],
      groupIds: ['g-old'],
    })
    // 早先单删的会话未到期，不属于本批
    expect(result.sessionIds).not.toContain('s-earlier')
    expect(db.prepare('SELECT 1 FROM session_groups WHERE id = ?').get('g-old')).toBeUndefined()
    expect(db.prepare('SELECT 1 FROM sessions WHERE id = ?').get('s-batch')).toBeUndefined()
    expect(db.prepare('SELECT 1 FROM sessions WHERE id = ?').get('s-earlier')).toBeDefined()
  })

  it('零同批组（防御分支）：只删组行，不报错', () => {
    insertGroup('g-empty', '空组', iso(NOW - 8 * DAY))
    const result = trashRepo.purgeExpiredTrash(NOW)
    expect(result).toMatchObject({
      groups: 1,
      sessions: 0,
      sessionIds: [],
      groupIds: ['g-empty'],
    })
    expect(db.prepare('SELECT 1 FROM session_groups WHERE id = ?').get('g-empty')).toBeUndefined()
  })

  it('probe 模式跳过清扫（不删副本库行）', () => {
    insertSession('s-old', '过期', { deletedAt: iso(NOW - 8 * DAY) })
    vi.stubEnv('CATSTUDY_PROBE_MODE', '1')

    const result = trashRepo.purgeExpiredTrash(NOW)
    expect(result).toMatchObject({
      skipped: 'probe',
      groups: 0,
      sessions: 0,
      sessionIds: [],
      groupIds: [],
    })
    expect(db.prepare('SELECT 1 FROM sessions WHERE id = ?').get('s-old')).toBeDefined()
  })

  it('清空回收站：含过期未扫条目；组条目连带同批；早先单删独立清', () => {
    const oldTs = iso(NOW - 8 * DAY)
    insertGroup('g1', '组', oldTs)
    insertSession('s-batch', '同批', { groupId: 'g1', deletedAt: oldTs })
    insertSession('s-single', '单删', { deletedAt: iso(NOW - 1 * DAY) })
    insertMessage('m1', 's-single')

    const result = trashRepo.emptyTrash()
    expect(result.groupIds).toEqual(['g1'])
    expect(result.sessionIds.sort()).toEqual(['s-batch', 's-single'])
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM session_groups').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 })
  })

  it('索引：回收站列表走 idx_sessions_trash，整组删除的 UPDATE 走 idx_sessions_group', () => {
    const planOf = (sql: string, ...args: unknown[]) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>)
        .map((r) => r.detail)
        .join('\n')

    const trashPlan = planOf(
      `SELECT * FROM sessions WHERE deleted_at IS NOT NULL AND deleted_at > ? ORDER BY deleted_at DESC`,
      iso(NOW)
    )
    expect(trashPlan).toContain('idx_sessions_trash')

    const groupPlan = planOf(
      `UPDATE sessions SET deleted_at = ? WHERE group_id = ? AND deleted_at IS NULL`,
      iso(NOW),
      'g1'
    )
    expect(groupPlan).toContain('idx_sessions_group')
  })
})
