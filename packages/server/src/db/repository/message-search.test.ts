/**
 * message-search repo — 历史面板的两个只读查询。
 *
 * 覆盖：日期按 tzOffset 分组（不是截 UTC）、月份由 days 聚合、total 含 system、
 * LIKE 转义顺序（`\` → `%` → `_`）、total 不受 before/limit 影响、游标不在本会话 → 空页、
 * 发送者名匹配（前端契约「搜索匹配正文与发送者」）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { createTestDb } from '../../test-helpers.js'
import { setDb, resetDb } from '../index.js'
import { initRepository, messageSearch as repo } from './index.js'

describe('message-search repo — 历史面板查询', () => {
  let db: Database.Database

  const insert = (
    id: string,
    role: 'user' | 'agent' | 'system',
    content: string,
    createdAt: string,
    agentId: string | null = null
  ) => {
    db.prepare(
      `INSERT INTO messages (id, session_id, agent_id, role, content, mentions, created_at)
       VALUES (?, 's1', ?, ?, ?, '[]', ?)`
    ).run(id, agentId, role, content, createdAt)
  }

  beforeEach(() => {
    db = createTestDb()
    setDb(db)
    initRepository(db)
    db.prepare("INSERT INTO sessions (id, title) VALUES ('s1', '会话 1')").run()
    db.prepare("INSERT INTO sessions (id, title) VALUES ('s2', '会话 2')").run()
    const insAgent = db.prepare(
      `INSERT INTO agents (id, name, system_prompt, llm_api_key) VALUES (?, ?, 'p', 'sk-test')`
    )
    insAgent.run('agent-a', '店长阿暹')
    insAgent.run('agent-b', '阿橘')
  })

  afterEach(() => {
    resetDb()
  })

  describe('escapeLikeTerm', () => {
    it('先转义反斜杠、再转义 % 与 _（顺序反了会产出 \\\\%）', () => {
      expect(repo.escapeLikeTerm('100%')).toBe('100\\%')
      expect(repo.escapeLikeTerm('a_b')).toBe('a\\_b')
      expect(repo.escapeLikeTerm('C:\\tmp')).toBe('C:\\\\tmp')
      expect(repo.escapeLikeTerm('50%_off\\')).toBe('50\\%\\_off\\\\')
      // 无特殊字符原样返回（不无脑加反斜杠）
      expect(repo.escapeLikeTerm('普通搜索')).toBe('普通搜索')
    })
  })

  describe('getSessionMessageFacets', () => {
    beforeEach(() => {
      // UTC 22:30 ⇒ 东八区是「第二天」；UTC 01:00 ⇒ 同一 UTC 日
      insert('m1', 'user', '晚间消息', '2026-11-12T22:30:00.000Z')
      insert('m2', 'agent', '清晨消息', '2026-11-12T01:00:00.000Z', 'agent-a')
      insert('m3', 'system', '重启完成', '2026-11-01T03:00:00.000Z')
      // 别的会话不参与
      db.prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions, created_at)
         VALUES ('m9', 's2', 'user', '别的会话', '[]', '2026-11-12T05:00:00.000Z')`
      ).run()
    })

    it('按 tzOffset 换算后分组：UTC 22:30 在东八区落次日、在 UTC 落当日', () => {
      const shanghai = repo.getSessionMessageFacets('s1', 480)
      expect(shanghai.days).toEqual([
        { date: '2026-11-13', count: 1 },
        { date: '2026-11-12', count: 1 },
        { date: '2026-11-01', count: 1 },
      ])
      expect(shanghai.months).toEqual([{ month: '2026-11' }])

      const utc = repo.getSessionMessageFacets('s1', 0)
      expect(utc.days).toEqual([
        { date: '2026-11-12', count: 2 },
        { date: '2026-11-01', count: 1 },
      ])
    })

    it('total 含 system，且只算本会话', () => {
      expect(repo.getSessionMessageFacets('s1', 0).total).toBe(3)
      expect(repo.getSessionMessageFacets('s2', 0).total).toBe(1)
    })

    it('月份由 days 聚合去重、按 DESC；偏移越界按 ±840 夹取', () => {
      insert('m4', 'user', '更早', '2026-09-30T10:00:00.000Z')
      const f = repo.getSessionMessageFacets('s1', 0)
      expect(f.months).toEqual([{ month: '2026-11' }, { month: '2026-09' }])
      // 9999 与 840 等价（clamp），不抛错也不产生非法 modifier
      expect(repo.getSessionMessageFacets('s1', 9999)).toEqual(
        repo.getSessionMessageFacets('s1', 840)
      )
    })
  })

  describe('searchSessionMessages', () => {
    beforeEach(() => {
      insert('s-1', 'user', '进度 100% 了', '2026-11-10T10:00:00.000Z')
      insert('s-2', 'user', '进度 100x 了', '2026-11-10T10:01:00.000Z')
      insert('s-3', 'agent', '文件 a_b 已生成', '2026-11-10T10:02:00.000Z', 'agent-a')
      insert('s-4', 'user', '文件 axb 不存在', '2026-11-10T10:03:00.000Z')
      insert('s-5', 'agent', '路径 C:\\tmp 可用', '2026-11-10T10:04:00.000Z', 'agent-b')
      insert('s-6', 'user', '路径 C:tmp 不存在', '2026-11-10T10:05:00.000Z')
      insert('sys-1', 'system', '重启完成', '2026-11-10T10:06:00.000Z')
    })

    it('转义语料：100% / a_b / C:\\tmp 都只命中字面量', () => {
      const ids = (q: string) => repo.searchSessionMessages('s1', { q }).rows.map((r) => r.id)
      expect(ids('100%')).toEqual(['s-1'])
      expect(ids('a_b')).toEqual(['s-3'])
      expect(ids('C:\\tmp')).toEqual(['s-5'])
    })

    it('排序 created_at DESC, id DESC；system 照常返回', () => {
      const rows = repo.searchSessionMessages('s1', { q: '重启' }).rows
      expect(rows.map((r) => r.id)).toEqual(['sys-1'])
    })

    it('total 不受 before/limit 影响；rows 受 before 约束', () => {
      const all = repo.searchSessionMessages('s1', { q: '文件' })
      expect(all.total).toBe(2)
      expect(all.rows.map((r) => r.id)).toEqual(['s-4', 's-3'])

      const paged = repo.searchSessionMessages('s1', { q: '文件', limit: 1 })
      expect(paged.rows.map((r) => r.id)).toEqual(['s-4'])
      expect(paged.total).toBe(2)

      const before = repo.searchSessionMessages('s1', { q: '文件', before: 's-4' })
      expect(before.rows.map((r) => r.id)).toEqual(['s-3'])
      expect(before.total).toBe(2)
    })

    it('发送者名参与匹配（只记得猫名时也能搜到）', () => {
      const rows = repo.searchSessionMessages('s1', { q: '阿橘' }).rows
      expect(rows.map((r) => r.id)).toEqual(['s-5'])
    })

    it('时间窗 from/to 收窄结果，且 total 同步收窄', () => {
      const r = repo.searchSessionMessages('s1', {
        q: '进度',
        from: '2026-11-10T10:01:00.000Z',
        to: '2026-11-10T10:01:00.000Z',
      })
      expect(r.rows.map((x) => x.id)).toEqual(['s-2'])
      expect(r.total).toBe(1)
    })

    it('游标不在本会话 → rows 空但 total 仍是匹配总数', () => {
      const r = repo.searchSessionMessages('s1', { q: '文件', before: '不存在' })
      expect(r.rows).toEqual([])
      expect(r.total).toBe(2)
    })

    it('limit 夹取 [1,100]：0 → 1、1000 → 100', () => {
      expect(repo.searchSessionMessages('s1', { q: '进度', limit: 0 }).rows).toHaveLength(1)
      expect(repo.searchSessionMessages('s1', { q: '进度', limit: 1000 }).rows).toHaveLength(2)
    })
  })
})
