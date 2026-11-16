/**
 * sessions repo — handoff 去重守卫语义测试（方案 C）。
 *
 * 覆盖：
 *   - getHandoffChild 新语义：仅当子会话有 ≥1 条消息才算真实交接
 *     （空壳子会话 = 0 条消息，前端切换失败产物，不挡二次交接）
 *   - getEmptyHandoffChild：0 消息子会话（窗内空壳复用判据）
 *   - deleteEmptyHandoffChildren：按年龄删**陈旧**空壳保真实，返回被删 id 列表
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { createTestDb } from '../../test-helpers.js'
import { setDb, resetDb, getDb } from '../index.js'
import { initRepository } from './index.js'
import { sessions as sessionsRepo } from './index.js'

describe('sessions repo — handoff 去重守卫', () => {
  let db: Database.Database

  /** 插入会话，handoffFrom 可选 */
  const insertSession = (
    id: string,
    opts: { handoffFrom?: string; runningSummary?: string } = {}
  ) => {
    db.prepare(
      `INSERT INTO sessions (id, title, handoff_from, running_summary)
       VALUES (?, 'test', ?, ?)`
    ).run(id, opts.handoffFrom ?? null, opts.runningSummary ?? null)
  }

  /**
   * 插入会话并**显式钉住 created_at**（相对当前的秒级偏移）——年龄谓词的用例必须钉，
   * 否则「插入时刻」与「清理时刻」同秒 ⇒ 窗边界两分支都落同一侧，断言恒真。
   * 口径与列一致：秒级 `datetime('now')` 产物（不带 `T`/`Z`）。
   */
  const insertSessionAged = (id: string, ageSeconds: number, handoffFrom?: string) => {
    db.prepare(
      `INSERT INTO sessions (id, title, handoff_from, created_at)
       VALUES (?, 'test', ?, datetime('now', ?))`
    ).run(id, handoffFrom ?? null, `-${ageSeconds} seconds`)
  }

  /** 向会话插入一条用户消息 */
  const insertMessage = (id: string, sessionId: string) => {
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, mentions)
       VALUES (?, ?, 'user', 'hello', '[]')`
    ).run(id, sessionId)
  }

  beforeEach(() => {
    db = createTestDb()
    setDb(db)
    initRepository(db)
  })

  afterEach(() => {
    resetDb()
  })

  describe('getHandoffChild — 真实交接判定', () => {
    it('无子会话时返回 undefined', () => {
      insertSession('parent-1')
      expect(sessionsRepo.getHandoffChild('parent-1')).toBeUndefined()
    })

    it('空壳子会话（0 条消息）不算真实交接，返回 undefined', () => {
      insertSession('parent-2')
      insertSession('child-empty', { handoffFrom: 'parent-2' })
      expect(sessionsRepo.getHandoffChild('parent-2')).toBeUndefined()
    })

    it('有 ≥1 条消息的子会话是真实交接，返回该子会话', () => {
      insertSession('parent-3')
      insertSession('child-real', { handoffFrom: 'parent-3' })
      insertMessage('m-1', 'child-real')
      expect(sessionsRepo.getHandoffChild('parent-3')).toEqual({ id: 'child-real' })
    })

    it('多个子会话中只认有消息的那个（空壳不干扰）', () => {
      insertSession('parent-4')
      insertSession('child-empty-1', { handoffFrom: 'parent-4' })
      insertSession('child-empty-2', { handoffFrom: 'parent-4' })
      insertSession('child-real', { handoffFrom: 'parent-4' })
      insertMessage('m-2', 'child-real')
      expect(sessionsRepo.getHandoffChild('parent-4')).toEqual({ id: 'child-real' })
    })
  })

  describe('getEmptyHandoffChild — 窗内空壳（复用判据）', () => {
    it('0 消息子会话命中（不限年龄）', () => {
      insertSession('parent-e1')
      insertSession('child-empty', { handoffFrom: 'parent-e1' })
      expect(sessionsRepo.getEmptyHandoffChild('parent-e1')).toEqual({ id: 'child-empty' })
    })

    it('陈旧空壳同样命中——年龄过滤归 deleteEmptyHandoffChildren，本函数不管', () => {
      insertSession('parent-e2')
      insertSessionAged('child-old-empty', 3600, 'parent-e2')
      expect(sessionsRepo.getEmptyHandoffChild('parent-e2')).toEqual({ id: 'child-old-empty' })
    })

    it('有消息的子会话不算空壳 → undefined', () => {
      insertSession('parent-e3')
      insertSession('child-real', { handoffFrom: 'parent-e3' })
      insertMessage('m-e1', 'child-real')
      expect(sessionsRepo.getEmptyHandoffChild('parent-e3')).toBeUndefined()
    })

    it('无子会话 → undefined', () => {
      insertSession('parent-e4')
      expect(sessionsRepo.getEmptyHandoffChild('parent-e4')).toBeUndefined()
    })

    it('多个空壳取 created_at 最新的一个（结果确定，不依赖行序）', () => {
      insertSession('parent-e5')
      insertSessionAged('child-older', 300, 'parent-e5')
      insertSessionAged('child-newer', 10, 'parent-e5')
      expect(sessionsRepo.getEmptyHandoffChild('parent-e5')).toEqual({ id: 'child-newer' })
    })
  })

  describe('deleteEmptyHandoffChildren — 陈旧空壳清理（按年龄）', () => {
    const GRACE = 600

    it('删窗外空壳、留窗内空壳与真实子会话，返回被删 id 列表', () => {
      insertSession('parent-5')
      insertSessionAged('child-old-empty', 3600, 'parent-5')
      insertSessionAged('child-fresh-empty', 30, 'parent-5')
      insertSession('child-real', { handoffFrom: 'parent-5' })
      insertMessage('m-3', 'child-real')

      const removed = sessionsRepo.deleteEmptyHandoffChildren('parent-5', GRACE)

      expect(removed).toEqual(['child-old-empty'])
      expect(
        getDb()
          .prepare('SELECT id FROM sessions WHERE handoff_from = ? ORDER BY id')
          .all('parent-5')
      ).toEqual([{ id: 'child-fresh-empty' }, { id: 'child-real' }])
    })

    it('窗边界：窗外 1s 删、窗内 1s 留', () => {
      insertSession('parent-b1')
      insertSessionAged('child-just-out', GRACE + 1, 'parent-b1')
      insertSession('parent-b2')
      insertSessionAged('child-just-in', GRACE - 1, 'parent-b2')

      expect(sessionsRepo.deleteEmptyHandoffChildren('parent-b1', GRACE)).toEqual([
        'child-just-out',
      ])
      expect(sessionsRepo.deleteEmptyHandoffChildren('parent-b2', GRACE)).toEqual([])
      expect(sessionsRepo.getSessionById('child-just-in')).toBeDefined()
    })

    it('无空壳子会话时返回空数组', () => {
      insertSession('parent-6')
      insertSession('child-real', { handoffFrom: 'parent-6' })
      insertMessage('m-4', 'child-real')

      expect(sessionsRepo.deleteEmptyHandoffChildren('parent-6', GRACE)).toEqual([])
      expect(sessionsRepo.getSessionById('child-real')).toBeDefined()
    })

    it('无任何子会话时返回空数组', () => {
      insertSession('parent-7')
      expect(sessionsRepo.deleteEmptyHandoffChildren('parent-7', GRACE)).toEqual([])
    })

    it('只删目标父会话的空壳，不影响其他父会话', () => {
      insertSession('parent-8')
      insertSession('parent-other')
      insertSessionAged('child-old-empty', 3600, 'parent-8')
      insertSessionAged('child-other-old-empty', 3600, 'parent-other')

      expect(sessionsRepo.deleteEmptyHandoffChildren('parent-8', GRACE)).toEqual([
        'child-old-empty',
      ])
      expect(sessionsRepo.getSessionById('child-other-old-empty')).toBeDefined()
    })
  })

  // ─── 摘要替代压缩 · 有界存储（D-3「折叠续命」）──────────────────────
  describe('trimCompressedSummaries — 保留块数上限（不是生成次数上限）', () => {
    const append = (sessionId: string, id: string, content: string) =>
      sessionsRepo.appendCompressedSummary(sessionId, {
        id,
        createdAt: '2026-08-01T00:00:00.000Z',
        tokenCount: 1,
        content,
        coveredThrough: 1,
      })
    const readContents = (sessionId: string): string[] =>
      JSON.parse(sessionsRepo.getCompressedSummaries(sessionId) ?? '[]').map(
        (e: { content: string }) => e.content
      )

    it('超限只丢最旧、末条恒为最新（keep=1）', () => {
      insertSession('s-trim-1')
      append('s-trim-1', 'e1', 'a')
      append('s-trim-1', 'e2', 'b')
      append('s-trim-1', 'e3', 'c')

      sessionsRepo.trimCompressedSummaries('s-trim-1', 1)

      expect(readContents('s-trim-1')).toEqual(['c'])
    })

    it('keep 大于当前条数 → 一条不丢（顺序不变）', () => {
      insertSession('s-trim-2')
      append('s-trim-2', 'e1', 'a')
      append('s-trim-2', 'e2', 'b')

      sessionsRepo.trimCompressedSummaries('s-trim-2', 5)

      expect(readContents('s-trim-2')).toEqual(['a', 'b'])
    })

    it('keep=0 绝不裁到 0 条（下限钉 1，否则下一轮退回全量重读）', () => {
      insertSession('s-trim-3')
      append('s-trim-3', 'e1', 'a')
      append('s-trim-3', 'e2', 'b')

      sessionsRepo.trimCompressedSummaries('s-trim-3', 0)

      expect(readContents('s-trim-3')).toEqual(['b'])
    })

    it('JSON 损坏 → 不抛、原样不动（读取侧同容错口径）', () => {
      insertSession('s-trim-4')
      db.prepare(`UPDATE sessions SET compressed_summaries = '{oops' WHERE id = 's-trim-4'`).run()

      expect(() => sessionsRepo.trimCompressedSummaries('s-trim-4', 1)).not.toThrow()
      expect(sessionsRepo.getCompressedSummaries('s-trim-4')).toBe('{oops')
    })

    it('坏 keep 参数（NaN）→ 不裁（不猜成 1 条）', () => {
      insertSession('s-trim-5')
      append('s-trim-5', 'e1', 'a')
      append('s-trim-5', 'e2', 'b')

      sessionsRepo.trimCompressedSummaries('s-trim-5', Number.NaN)

      expect(readContents('s-trim-5')).toEqual(['a', 'b'])
    })
  })

  // ─── 摘要替代压缩 · 回填返回值（D-4 P3-5：不谎报完成）────────────────
  describe('updateCompressedSummary — 返回布尔（回填是否真的落库）', () => {
    const appendPending = (sessionId: string, id: string) =>
      sessionsRepo.appendCompressedSummary(sessionId, {
        id,
        createdAt: '2026-08-01T00:00:00.000Z',
        tokenCount: 0,
        content: '',
        coveredThrough: 1,
      })
    const readEntries = (sessionId: string): Array<{ id: string; content: string }> =>
      JSON.parse(sessionsRepo.getCompressedSummaries(sessionId) ?? '[]')

    it('entryId 仍在数组中 → true，且内容已写入', () => {
      insertSession('s-upd-1')
      appendPending('s-upd-1', 'e1')

      const ok = sessionsRepo.updateCompressedSummary('s-upd-1', 'e1', {
        tokenCount: 5,
        content: 'filled',
        coveredToId: 'm-1',
      })

      expect(ok).toBe(true)
      expect(readEntries('s-upd-1')[0]).toMatchObject({
        id: 'e1',
        content: 'filled',
        tokenCount: 5,
        coveredToId: 'm-1',
      })
    })

    it('entryId 已被 trim 裁掉 → false，数组不动（调用方不得打 completed）', () => {
      insertSession('s-upd-2')
      appendPending('s-upd-2', 'e1')
      appendPending('s-upd-2', 'e2')
      sessionsRepo.trimCompressedSummaries('s-upd-2', 1) // e1 被裁掉

      const ok = sessionsRepo.updateCompressedSummary('s-upd-2', 'e1', {
        tokenCount: 5,
        content: 'late',
      })

      expect(ok).toBe(false)
      const entries = readEntries('s-upd-2')
      expect(entries).toHaveLength(1)
      expect(entries[0].id).toBe('e2')
      expect(entries[0].content).toBe('')
    })

    it('无压缩历史 / JSON 损坏 → false，不抛', () => {
      insertSession('s-upd-3')
      expect(
        sessionsRepo.updateCompressedSummary('s-upd-3', 'e1', { tokenCount: 1, content: 'x' })
      ).toBe(false)

      insertSession('s-upd-4')
      db.prepare(`UPDATE sessions SET compressed_summaries = '{oops' WHERE id = 's-upd-4'`).run()
      expect(
        sessionsRepo.updateCompressedSummary('s-upd-4', 'e1', { tokenCount: 1, content: 'x' })
      ).toBe(false)
      expect(sessionsRepo.getCompressedSummaries('s-upd-4')).toBe('{oops')
    })
  })

  // ─── T1 · 分组移动 ─────────────────────────────────
  describe('sessions repo — 分组移动', () => {
    /**
     * 把 `updated_at` 钉成哨兵值——「移动分组不动 updated_at」这条断言若不做这件事就是
     * **恒真**的：插入与移动发生在同一秒内，`datetime('now')` 前后同值，改了也看不出来。
     */
    const pinUpdatedAt = (id: string, ts = '2020-01-01 00:00:00') =>
      db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(ts, id)

    it('归档 API 已退役：sessions repo 不再导出任何 archive 动作', () => {
      expect(Object.keys(sessionsRepo).filter((name) => /archiv/i.test(name))).toEqual([])
    })

    it('updateSessionGroup 移动组不改 updated_at（分组是组织动作，不是会话活跃）', () => {
      insertSession('s-move')
      pinUpdatedAt('s-move')
      db.prepare(
        `INSERT INTO session_groups (id, name, created_at, updated_at)
         VALUES ('g-move', '目标组', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      ).run()

      sessionsRepo.updateSessionGroup('s-move', 'g-move')

      const row = sessionsRepo.getSessionById('s-move')
      expect(row?.group_id).toBe('g-move')
      expect(row?.updated_at).toBe('2020-01-01 00:00:00')
      // 移回未分组同样不动 updated_at
      sessionsRepo.updateSessionGroup('s-move', null)
      expect(sessionsRepo.getSessionById('s-move')?.group_id).toBeNull()
      expect(sessionsRepo.getSessionById('s-move')?.updated_at).toBe('2020-01-01 00:00:00')
    })
  })
})

// ─── T2 · 读取口径 / 回收站写入 / 交接子会话过滤 ──────────────────────

describe('sessions repo — T2 回收站语义', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createTestDb()
    setDb(db)
    initRepository(db)
  })

  afterEach(() => {
    resetDb()
  })

  const insertSession = (
    id: string,
    opts: { handoffFrom?: string; groupId?: string | null } = {}
  ) => {
    db.prepare(
      `INSERT INTO sessions (id, title, handoff_from, group_id, updated_at)
       VALUES (?, 'test', ?, ?, '2020-01-01 00:00:00')`
    ).run(id, opts.handoffFrom ?? null, opts.groupId ?? null)
  }

  const insertMessage = (id: string, sessionId: string) => {
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, mentions)
       VALUES (?, ?, 'user', 'hello', '[]')`
    ).run(id, sessionId)
  }

  it('getSessionById 默认排除已删；IncludingDeleted 返回同一行', () => {
    insertSession('s1')
    expect(sessionsRepo.getSessionById('s1')).toBeDefined()
    sessionsRepo.trashSession('s1', '2026-01-02T00:00:00.000Z')

    expect(sessionsRepo.getSessionById('s1')).toBeUndefined()
    const row = sessionsRepo.getSessionByIdIncludingDeleted('s1')
    expect(row?.id).toBe('s1')
    expect(row?.deleted_at).toBe('2026-01-02T00:00:00.000Z')
  })

  it('listActiveSessions 只返回未删会话', () => {
    insertSession('s-live')
    insertSession('s-trashed')
    sessionsRepo.trashSession('s-trashed', '2026-01-02T00:00:00.000Z')

    expect(sessionsRepo.listActiveSessions().map((r) => r.id)).toEqual(['s-live'])
  })

  it('trashSession 幂等：第二次不改首次时间戳；restoreSession 清标记、落目标组、不动 updated_at', () => {
    insertSession('s1')
    db.prepare(
      `INSERT INTO session_groups (id, name, created_at, updated_at)
       VALUES ('g1', '组', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
    ).run()

    expect(sessionsRepo.trashSession('s1', '2026-01-02T00:00:00.000Z').changes).toBe(1)
    expect(sessionsRepo.trashSession('s1', '2026-01-03T00:00:00.000Z').changes).toBe(0)
    expect(sessionsRepo.getSessionByIdIncludingDeleted('s1')?.deleted_at).toBe(
      '2026-01-02T00:00:00.000Z'
    )

    expect(sessionsRepo.restoreSession('s1', 'g1').changes).toBe(1)
    const row = sessionsRepo.getSessionById('s1')
    expect(row?.deleted_at).toBeNull()
    expect(row?.group_id).toBe('g1')
    expect(row?.updated_at).toBe('2020-01-01 00:00:00')

    // 已恢复的行再恢复是 no-op（不会把 group_id 又改一遍）
    expect(sessionsRepo.restoreSession('s1', null).changes).toBe(0)
    expect(sessionsRepo.getSessionById('s1')?.group_id).toBe('g1')
  })

  it('getHandoffChild / getEmptyHandoffChild 跳过回收站里的子会话', () => {
    insertSession('parent')
    insertSession('child-real', { handoffFrom: 'parent' })
    insertMessage('m1', 'child-real')
    expect(sessionsRepo.getHandoffChild('parent')).toEqual({ id: 'child-real' })

    sessionsRepo.trashSession('child-real', '2026-01-02T00:00:00.000Z')
    // 真子会话已删 → 不再算「已交接」；空壳查询也不得把已删壳当可复用
    expect(sessionsRepo.getHandoffChild('parent')).toBeUndefined()

    insertSession('child-empty', { handoffFrom: 'parent' })
    expect(sessionsRepo.getEmptyHandoffChild('parent')).toEqual({ id: 'child-empty' })
    sessionsRepo.trashSession('child-empty', '2026-01-02T00:00:00.000Z')
    expect(sessionsRepo.getEmptyHandoffChild('parent')).toBeUndefined()
  })
})
