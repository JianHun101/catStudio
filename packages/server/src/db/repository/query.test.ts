/**
 * query repo — messages 可见性收敛的两个取数函数（B-1）。
 *
 * `queryTable` 的六表白名单 SQL 由 routes/internal.test.ts 端到端覆盖；本文件只测
 * 新增的 messages 专用取数层：
 *   - getMessageQueryCandidates：只投影可见性判定需要的五列、按 created_at/id DESC
 *     排序、不截 limit（截断归调用方在过滤后做）
 *   - getMessageQueryRowsByIds：按传入 id 顺序回表白名单全列，且二次限定会话
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { createTestDb } from '../../test-helpers.js'
import { setDb, resetDb } from '../index.js'
import { initRepository, query as queryRepo } from './index.js'

describe('query repo — messages 取数层（B-1）', () => {
  let db: Database.Database

  const insertMessage = (
    id: string,
    sessionId: string,
    agentId: string | null,
    role: 'user' | 'agent' | 'system',
    content: string,
    mentions: string[],
    createdAt: string
  ) => {
    db.prepare(
      `INSERT INTO messages (id, session_id, agent_id, role, content, mentions, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, sessionId, agentId, role, content, JSON.stringify(mentions), createdAt)
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
    insAgent.run('agent-a', '猫A')
    insAgent.run('agent-b', '猫B')

    insertMessage('m1', 's1', 'agent-a', 'agent', '第一条', [], '2026-09-01 10:00:00')
    insertMessage('m2', 's1', null, 'user', '第二条', ['猫A'], '2026-09-01 10:01:00')
    insertMessage('m3', 's2', 'agent-b', 'agent', '别的会话', [], '2026-09-01 10:02:00')
  })

  afterEach(() => {
    resetDb()
  })

  describe('getMessageQueryCandidates', () => {
    it('只投影可见性判定五列（不读正文/segments），不跨会话', () => {
      const rows = queryRepo.getMessageQueryCandidates('s1')
      expect(rows.map((r) => r.id)).toEqual(['m2', 'm1'])
      expect(Object.keys(rows[0]).sort()).toEqual(
        ['agent_id', 'created_at', 'id', 'mentions', 'role'].sort()
      )
      expect(rows[0]).toMatchObject({
        id: 'm2',
        role: 'user',
        agent_id: null,
        mentions: JSON.stringify(['猫A']),
      })
    })

    it('conditions 在 SQL 层生效（role = user）', () => {
      const rows = queryRepo.getMessageQueryCandidates('s1', [
        { column: 'role', op: '=', value: 'user' },
      ])
      expect(rows.map((r) => r.id)).toEqual(['m2'])
    })

    it('同 created_at 用 id DESC 定序（与 getSessionMessagesRange 同口径）', () => {
      insertMessage('m-a', 's1', null, 'user', '同秒 A', [], '2026-09-02 10:00:00')
      insertMessage('m-b', 's1', null, 'user', '同秒 B', [], '2026-09-02 10:00:00')
      const rows = queryRepo.getMessageQueryCandidates('s1')
      expect(rows.slice(0, 2).map((r) => r.id)).toEqual(['m-b', 'm-a'])
    })

    it('拒绝把 session_id 混进 conditions（会话边界由调用方强制）', () => {
      expect(() =>
        queryRepo.getMessageQueryCandidates('s1', [{ column: 'session_id', op: '=', value: 's2' }])
      ).toThrow(/会话条件由端点强制/)
    })

    it('列不在白名单 → throw（与 queryTable 同款防御）', () => {
      expect(() =>
        queryRepo.getMessageQueryCandidates('s1', [{ column: 'not_a_column', op: '=', value: 'x' }])
      ).toThrow(/白名单/)
    })
  })

  describe('getMessageQueryRowsByIds', () => {
    it('按传入 id 顺序回表白名单全列（含 content），snake_case 原样', () => {
      const rows = queryRepo.getMessageQueryRowsByIds('s1', ['m2', 'm1'])
      expect(rows.map((r) => r.id)).toEqual(['m2', 'm1'])
      expect(rows.map((r) => r.content)).toEqual(['第二条', '第一条'])
      expect(Object.keys(rows[0])).toEqual([...queryRepo.QUERY_TABLE_SCHEMAS.messages.columns])
      expect(rows[0]).toMatchObject({ session_id: 's1', role: 'user', mentions: '["猫A"]' })
    })

    it('二次限定会话：拿别的会话 id 也取不到', () => {
      expect(queryRepo.getMessageQueryRowsByIds('s1', ['m3'])).toEqual([])
    })

    it('空 ids → 空数组（不发 SQL）', () => {
      expect(queryRepo.getMessageQueryRowsByIds('s1', [])).toEqual([])
    })
  })
})
