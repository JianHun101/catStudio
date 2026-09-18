/**
 * sessions repo — handoff 去重守卫语义测试（方案 C）。
 *
 * 覆盖：
 *   - getHandoffChild 新语义：仅当子会话有 ≥1 条消息才算真实交接
 *     （空壳子会话 = 0 条消息，前端切换失败产物，不挡二次交接）
 *   - deleteEmptyHandoffChildren：删空壳保真实，返回删除数
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

  describe('deleteEmptyHandoffChildren — 空壳清理', () => {
    it('删除所有空壳子会话，保留真实子会话，返回删除数', () => {
      insertSession('parent-5')
      insertSession('child-empty-a', { handoffFrom: 'parent-5' })
      insertSession('child-empty-b', { handoffFrom: 'parent-5' })
      insertSession('child-real', { handoffFrom: 'parent-5' })
      insertMessage('m-3', 'child-real')

      const removed = sessionsRepo.deleteEmptyHandoffChildren('parent-5')

      expect(removed).toBe(2)
      expect(
        getDb().prepare('SELECT id FROM sessions WHERE handoff_from = ?').all('parent-5')
      ).toEqual([{ id: 'child-real' }])
    })

    it('无空壳子会话时返回 0', () => {
      insertSession('parent-6')
      insertSession('child-real', { handoffFrom: 'parent-6' })
      insertMessage('m-4', 'child-real')

      expect(sessionsRepo.deleteEmptyHandoffChildren('parent-6')).toBe(0)
    })

    it('无任何子会话时返回 0', () => {
      insertSession('parent-7')
      expect(sessionsRepo.deleteEmptyHandoffChildren('parent-7')).toBe(0)
    })

    it('只删目标父会话的空壳，不影响其他父会话', () => {
      insertSession('parent-8')
      insertSession('parent-other')
      insertSession('child-empty', { handoffFrom: 'parent-8' })
      insertSession('child-other-real', { handoffFrom: 'parent-other' })
      insertMessage('m-5', 'child-other-real')

      expect(sessionsRepo.deleteEmptyHandoffChildren('parent-8')).toBe(1)
      expect(sessionsRepo.getHandoffChild('parent-other')).toEqual({ id: 'child-other-real' })
    })
  })

  // ─── 票 7 · 归档（用户态「删除」= 归档）────────────────────────────
  describe('sessions repo — 归档', () => {
    const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

    /**
     * 把 `updated_at` 钉成哨兵值——「归档不动 updated_at」这条断言若不做这件事就是**恒真**的：
     * 插入与归档发生在同一秒内，`datetime('now')` 前后同值，改了也看不出来。
     */
    const pinUpdatedAt = (id: string, ts = '2020-01-01 00:00:00') =>
      db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(ts, id)

    it('archiveSession 写 ISO 毫秒 archived_at（⑤-c 记录时间口径）', () => {
      insertSession('s-a1')
      sessionsRepo.archiveSession('s-a1')
      const row = sessionsRepo.getSessionById('s-a1')
      expect(row?.archived_at).toMatch(ISO_MS)
    })

    it('archiveSession 不动 updated_at（归档是可见性开关，不是会话活动）', () => {
      insertSession('s-a2')
      pinUpdatedAt('s-a2')
      sessionsRepo.archiveSession('s-a2')
      expect(sessionsRepo.getSessionById('s-a2')?.updated_at).toBe('2020-01-01 00:00:00')
    })

    it('archiveSession 幂等：重复归档不改写首次归档时刻', () => {
      insertSession('s-a3')
      sessionsRepo.archiveSession('s-a3')
      const first = sessionsRepo.getSessionById('s-a3')?.archived_at
      // 拉开时间差再归档一次：若实现是「无条件覆盖」，两次读数会不同
      db.prepare(`UPDATE sessions SET archived_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(
        's-a3'
      )
      sessionsRepo.archiveSession('s-a3')
      sessionsRepo.archiveSession('s-a3')
      expect(sessionsRepo.getSessionById('s-a3')?.archived_at).toBe('2000-01-01T00:00:00.000Z')
      // 反向对照：上面不是「怎么写都行」——首归档确实写过值（哨兵是后来手工改的）
      expect(first).toMatch(ISO_MS)
    })

    it('unarchiveSession 归 NULL，且同样不动 updated_at', () => {
      insertSession('s-a4')
      sessionsRepo.archiveSession('s-a4')
      pinUpdatedAt('s-a4')
      sessionsRepo.unarchiveSession('s-a4')
      const row = sessionsRepo.getSessionById('s-a4')
      expect(row?.archived_at).toBeNull()
      expect(row?.updated_at).toBe('2020-01-01 00:00:00')
    })

    it('listActiveSessions 滤掉归档；listAllSessions 含归档（系统链路口径不变）', () => {
      insertSession('s-live')
      insertSession('s-gone')
      sessionsRepo.archiveSession('s-gone')

      const activeIds = sessionsRepo.listActiveSessions().map((r) => r.id)
      expect(activeIds).toContain('s-live')
      expect(activeIds).not.toContain('s-gone')

      // `listAllSessions` 是**系统链路**口径（评估告警播报靠它），过滤塞进去 = 让归档
      // 静默改变无关子系统的行为。这条断言就是那个不变量的守卫。
      const allIds = sessionsRepo.listAllSessions().map((r) => r.id)
      expect(allIds).toContain('s-live')
      expect(allIds).toContain('s-gone')
    })

    it('取消归档后回到活跃列表', () => {
      insertSession('s-back')
      sessionsRepo.archiveSession('s-back')
      expect(sessionsRepo.listActiveSessions().map((r) => r.id)).not.toContain('s-back')
      sessionsRepo.unarchiveSession('s-back')
      expect(sessionsRepo.listActiveSessions().map((r) => r.id)).toContain('s-back')
    })
  })
})
