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
})
