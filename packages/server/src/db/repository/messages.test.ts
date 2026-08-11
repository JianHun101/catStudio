/**
 * messages repo — 队列持久化（P0）测试。
 *
 * 覆盖：
 *   - dispatch_state 列存在（SCHEMA_SQL 已包含）
 *   - 迁移幂等（initDb 在已有列上重跑不报错）
 *   - setDispatchState 写入正确
 *   - getPendingMessages 过滤正确（queued/running 返回，done/NULL 不返回）
 *   - 存量 NULL 行兼容
 *   - fire-and-forget（写入失败不抛）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { createTestDb } from '../../test-helpers.js'
import { setDb, resetDb, getDb, initDb } from '../index.js'
import { initRepository } from './index.js'
import { messages as messagesRepo } from './index.js'
import { v4 as uuid } from 'uuid'

describe('messages repo — 队列持久化', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createTestDb()
    setDb(db)
    initRepository(db)
    // 建一个 session，所有消息测试都需要
    db.prepare("INSERT INTO sessions (id, title) VALUES ('s1', 'test')").run()
  })

  afterEach(() => {
    resetDb()
  })

  // ─── 验收 4: 迁移幂等 ────────────────────────────────
  describe('迁移', () => {
    it('dispatch_state 列存在', () => {
      const cols = db.pragma('table_info(messages)') as Array<{ name: string }>
      const names = cols.map((c) => c.name)
      expect(names).toContain('dispatch_state')
    })

    it('initDb 在已有列上重跑不报错（迁移幂等）', () => {
      // SCHEMA_SQL 已包含 dispatch_state，initDb 的 ALTER ADD COLUMN 应被 try/catch 吞掉
      expect(() => initDb()).not.toThrow()
    })
  })

  // ─── 验收 1-3: 状态生命周期 ──────────────────────────
  describe('setDispatchState', () => {
    it('写入 queued', () => {
      messagesRepo.insertMessage(uuid(), 's1', 'user', 'hello', '[]', null, null)
      const msg = db.prepare('SELECT id FROM messages LIMIT 1').get() as { id: string }

      messagesRepo.setDispatchState(msg.id, 'queued')

      const row = db.prepare('SELECT dispatch_state FROM messages WHERE id = ?').get(msg.id) as {
        dispatch_state: string | null
      }
      expect(row.dispatch_state).toBe('queued')
    })

    it('queued → running → done 状态转换', () => {
      messagesRepo.insertMessage(uuid(), 's1', 'user', 'hello', '[]', null, null)
      const msg = db.prepare('SELECT id FROM messages LIMIT 1').get() as { id: string }

      messagesRepo.setDispatchState(msg.id, 'queued')
      expect(
        (db.prepare('SELECT dispatch_state FROM messages WHERE id = ?').get(msg.id) as any)
          .dispatch_state
      ).toBe('queued')

      messagesRepo.setDispatchState(msg.id, 'running')
      expect(
        (db.prepare('SELECT dispatch_state FROM messages WHERE id = ?').get(msg.id) as any)
          .dispatch_state
      ).toBe('running')

      messagesRepo.setDispatchState(msg.id, 'done')
      expect(
        (db.prepare('SELECT dispatch_state FROM messages WHERE id = ?').get(msg.id) as any)
          .dispatch_state
      ).toBe('done')
    })
  })

  // ─── 验收 5: 存量 NULL 兼容 + 过滤正确 ──────────────
  describe('getPendingMessages', () => {
    it('只返回 queued 和 running 的消息', () => {
      const id1 = uuid()
      const id2 = uuid()
      const id3 = uuid()
      const id4 = uuid()

      messagesRepo.insertMessage(id1, 's1', 'user', 'msg-1', '[]', null, null)
      messagesRepo.insertMessage(id2, 's1', 'user', 'msg-2', '[]', null, null)
      messagesRepo.insertMessage(id3, 's1', 'user', 'msg-3', '[]', null, null)
      messagesRepo.insertMessage(id4, 's1', 'user', 'msg-4', '[]', null, null)

      messagesRepo.setDispatchState(id1, 'queued')
      messagesRepo.setDispatchState(id2, 'running')
      messagesRepo.setDispatchState(id3, 'done')
      // id4 stays NULL

      const pending = messagesRepo.getPendingMessages()
      const ids = pending.map((m) => m.id)

      expect(ids).toContain(id1)
      expect(ids).toContain(id2)
      expect(ids).not.toContain(id3) // done → 不返回
      expect(ids).not.toContain(id4) // NULL → 不返回
      expect(pending.length).toBe(2)
    })

    it('存量 NULL 行不影响查询（回归）', () => {
      // 插 10 条全部 NULL dispatch_state，确认 getPendingMessages 返回空
      for (let i = 0; i < 10; i++) {
        messagesRepo.insertMessage(uuid(), 's1', 'user', `msg-${i}`, '[]', null, null)
      }

      const pending = messagesRepo.getPendingMessages()
      expect(pending).toHaveLength(0)

      // 确认现有查询（getSessionHistory）不受影响
      const history = messagesRepo.getSessionHistory('s1')
      expect(history).toHaveLength(10)
    })

    it('返回 dispatch 所需的最小字段集', () => {
      const id = uuid()
      messagesRepo.insertMessage(id, 's1', 'user', 'test content', '["agent-1"]', null, null)
      messagesRepo.setDispatchState(id, 'queued')

      const [row] = messagesRepo.getPendingMessages()
      expect(row).toBeDefined()
      expect(row.id).toBe(id)
      expect(row.session_id).toBe('s1')
      expect(row.content).toBe('test content')
      expect(row.mentions).toBe('["agent-1"]')
      expect(row.agent_id).toBeNull()
      expect(row.role).toBe('user')
      // 不返回 dispatch_state 列（最小字段集）
      expect((row as any).dispatch_state).toBeUndefined()
    })
  })

  // ─── 验收 8: fire-and-forget ─────────────────────────
  describe('fire-and-forget', () => {
    it('写入失败不抛异常', () => {
      // 不存在的 message id → UPDATE 0 行，不应抛
      expect(() => messagesRepo.setDispatchState('nonexistent-id', 'queued')).not.toThrow()
    })

    it('getPendingMessages 在空表上返回空数组', () => {
      const pending = messagesRepo.getPendingMessages()
      expect(pending).toEqual([])
    })
  })

  // ─── extra 列（对话内 diff 富文本块通道）──────────────
  describe('extra 列', () => {
    it('updateMessageExtra 补写 extra（diff 采集在回复落库后进行）', () => {
      const id = uuid()
      messagesRepo.insertMessage(id, 's1', 'user', 'hello', '[]', null, null)
      const extra = JSON.stringify({
        rich: { v: 1, blocks: [{ id: 'diff-1', kind: 'diff', v: 1, filePath: 'a.ts', diff: 'x' }] },
      })

      messagesRepo.updateMessageExtra(id, extra)

      const row = db.prepare('SELECT extra FROM messages WHERE id = ?').get(id) as {
        extra: string | null
      }
      expect(JSON.parse(row.extra!)).toEqual({
        rich: { v: 1, blocks: [{ id: 'diff-1', kind: 'diff', v: 1, filePath: 'a.ts', diff: 'x' }] },
      })
    })

    it('updateMessageExtra 对不存在消息不抛（fire-and-forget）', () => {
      expect(() =>
        messagesRepo.updateMessageExtra('nonexistent-id', '{"rich":{"v":1,"blocks":[]}}')
      ).not.toThrow()
    })

    it('insertAgentMessage 可直接带 extra 落库', () => {
      const id = uuid()
      messagesRepo.insertAgentMessage(
        id,
        's1',
        'agent-1',
        '摘要',
        null,
        undefined,
        '{"rich":{"v":1,"blocks":[]}}'
      )

      const row = db.prepare('SELECT extra FROM messages WHERE id = ?').get(id) as {
        extra: string | null
      }
      expect(row.extra).toBe('{"rich":{"v":1,"blocks":[]}}')
    })

    it('insertAgentMessage 不带 extra → extra 列为 NULL（旧消息零回归）', () => {
      const id = uuid()
      messagesRepo.insertAgentMessage(id, 's1', 'agent-1', '摘要', null)

      const row = db.prepare('SELECT extra FROM messages WHERE id = ?').get(id) as {
        extra: string | null
      }
      expect(row.extra).toBeNull()
    })
  })
})
