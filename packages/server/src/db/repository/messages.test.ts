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
        undefined, // tool_content
        '{"rich":{"v":1,"blocks":[]}}'
      )

      const row = db.prepare('SELECT extra FROM messages WHERE id = ?').get(id) as {
        extra: string | null
      }
      expect(row.extra).toBe('{"rich":{"v":1,"blocks":[]}}')
    })

    it('insertAgentMessage 带 tool_content 结构化 JSON 落库（工具记录独立列）', () => {
      const id = uuid()
      messagesRepo.insertAgentMessage(
        id,
        's1',
        'agent-1',
        '正文',
        null,
        '纯思考',
        JSON.stringify([
          {
            id: 'call_1',
            name: 'apply_patch',
            status: 'completed',
            input: { filePath: 'hello.txt' },
            output: 'diff: +hello',
          },
        ])
      )

      const row = db
        .prepare('SELECT thinking_content, tool_content FROM messages WHERE id = ?')
        .get(id) as {
        thinking_content: string | null
        tool_content: string | null
      }
      expect(row.thinking_content).toBe('纯思考')
      expect(row.tool_content).toContain('"apply_patch"')
      expect(JSON.parse(row.tool_content!).length).toBe(1)
    })

    it('insertAgentMessage 带 segments 结构化 JSON 落库（回复分段交错列——历史还原交错序权威源）', () => {
      const id = uuid()
      const segs = [
        { kind: 'thinking', content: '先想一下再调工具' },
        {
          kind: 'tool',
          content: '',
          tool: { id: 'call_1', name: 'apply_patch', status: 'completed' },
        },
        { kind: 'text', content: '正文结论' },
      ]
      messagesRepo.insertAgentMessage(
        id,
        's1',
        'agent-1',
        '正文结论',
        null,
        '先想一下再调工具',
        undefined, // tool_content
        undefined, // extra
        JSON.stringify(segs)
      )

      const row = db.prepare('SELECT segments FROM messages WHERE id = ?').get(id) as {
        segments: string | null
      }
      expect(row.segments).toContain('"kind":"tool"')
      expect(JSON.parse(row.segments!)).toEqual(segs)
    })

    it('insertAgentMessage 不带 segments → segments 列为 NULL（老消息零回归）', () => {
      const id = uuid()
      messagesRepo.insertAgentMessage(id, 's1', 'agent-1', '摘要', null)

      const row = db.prepare('SELECT segments FROM messages WHERE id = ?').get(id) as {
        segments: string | null
      }
      expect(row.segments).toBeNull()
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

describe('messages repo — getSessionMessagesRange（方案 3 A 读层地基）', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createTestDb()
    setDb(db)
    initRepository(db)
    db.prepare("INSERT INTO sessions (id, title) VALUES ('s1', 'test')").run()
  })

  afterEach(() => {
    resetDb()
  })

  /** 显式 created_at 插消息（insertMessage 不暴露时间列——时间窗/游标测试需要控序） */
  const insertMsg = (row: {
    id: string
    role?: string
    agentId?: string | null
    content: string
    createdAt: string
  }) => {
    db.prepare(
      `INSERT INTO messages (id, session_id, agent_id, role, content, mentions, created_at)
       VALUES (?, 's1', ?, ?, ?, '[]', ?)`
    ).run(row.id, row.agentId ?? null, row.role ?? 'user', row.content, row.createdAt)
  }

  it('无参数 → 与 getRecentMessages 同口径（role != system，新→旧）', () => {
    insertMsg({ id: 'm1', content: 'old', createdAt: '2026-09-01 10:00:00' })
    insertMsg({ id: 'm2', content: 'mid', createdAt: '2026-09-01 12:00:00' })
    insertMsg({ id: 'm3', content: 'new', createdAt: '2026-09-01 14:00:00' })
    insertMsg({ id: 'm-sys', role: 'system', content: 'system', createdAt: '2026-09-01 15:00:00' })

    const rows = messagesRepo.getSessionMessagesRange('s1')
    expect(rows.map((r) => r.id)).toEqual(['m3', 'm2', 'm1'])
  })

  it('limit 生效（倒序截取）', () => {
    for (let i = 1; i <= 5; i++) {
      insertMsg({
        id: `m${i}`,
        content: `c${i}`,
        createdAt: `2026-09-01 0${i}:00:00`,
      })
    }
    const rows = messagesRepo.getSessionMessagesRange('s1', { limit: 2 })
    expect(rows.map((r) => r.id)).toEqual(['m5', 'm4'])
  })

  it('from/to 时间窗命中（ISO 秒级时间戳归一后比较）', () => {
    insertMsg({ id: 'm1', content: 'before', createdAt: '2026-09-01 10:00:00' })
    insertMsg({ id: 'm2', content: 'in-window', createdAt: '2026-09-01 12:00:00' })
    insertMsg({ id: 'm3', content: 'after', createdAt: '2026-09-01 14:00:00' })

    const rows = messagesRepo.getSessionMessagesRange('s1', {
      from: '2026-09-01T12:00:00Z',
      to: '2026-09-01T13:00:00Z',
    })
    expect(rows.map((r) => r.id)).toEqual(['m2'])
  })

  it('from 下界包含（>=）到窗口——同秒边界不丢', () => {
    insertMsg({ id: 'm1', content: 'older', createdAt: '2026-09-01 10:00:00' })
    insertMsg({ id: 'm2', content: 'edge', createdAt: '2026-09-01 12:00:00' })
    const rows = messagesRepo.getSessionMessagesRange('s1', { from: '2026-09-01T12:00:00Z' })
    expect(rows.map((r) => r.id)).toEqual(['m2'])
  })

  it('before 游标翻页不重叠、不回环——全部消息恰好覆盖一次', () => {
    for (let i = 1; i <= 5; i++) {
      insertMsg({
        id: `m${i}`,
        content: `c${i}`,
        createdAt: `2026-09-01 10:0${i}:00`,
      })
    }
    // 时间序 m1(10:01) < m2(10:02) < ... < m5(10:05)；倒序最新在前
    const page1 = messagesRepo.getSessionMessagesRange('s1', { limit: 2 })
    expect(page1.map((r) => r.id)).toEqual(['m5', 'm4'])

    const page2 = messagesRepo.getSessionMessagesRange('s1', { limit: 2, before: 'm4' })
    expect(page2.map((r) => r.id)).toEqual(['m3', 'm2'])

    const page3 = messagesRepo.getSessionMessagesRange('s1', { limit: 2, before: 'm2' })
    expect(page3.map((r) => r.id)).toEqual(['m1'])

    const all = [...page1, ...page2, ...page3]
    const ids = all.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length) // 不重叠
    expect(ids.sort()).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']) // 不回环不漏
  })

  it('同 created_at 多条——(created_at, id) 复合 tie-break 顺序正确、翻页不丢', () => {
    // 同一秒三条，id 字典序 a<b<c → 倒序 c,b,a
    for (const id of ['m-a', 'm-b', 'm-c']) {
      insertMsg({ id, content: id, createdAt: '2026-09-01 10:00:00' })
    }
    const page1 = messagesRepo.getSessionMessagesRange('s1', { limit: 2 })
    expect(page1.map((r) => r.id)).toEqual(['m-c', 'm-b'])

    const page2 = messagesRepo.getSessionMessagesRange('s1', { limit: 2, before: 'm-b' })
    // 严格早于 (10:00:00, 'm-b') → 同秒内 id < 'm-b' 的 'm-a'
    expect(page2.map((r) => r.id)).toEqual(['m-a'])

    // 合并无重叠无遗漏
    const ids = [...page1, ...page2].map((r) => r.id)
    expect(new Set(ids).size).toBe(3)
    expect(ids.sort()).toEqual(['m-a', 'm-b', 'm-c'])
  })

  it('before 消息不在本会话/不存在 → 空数组（位置不可定，客户端自然停止翻页）', () => {
    insertMsg({ id: 'm1', content: 'x', createdAt: '2026-09-01 10:00:00' })
    expect(messagesRepo.getSessionMessagesRange('s1', { before: 'ghost' })).toEqual([])
  })

  it('agentId 过滤 → 只返回该 agent 的消息（B 工具 agentIdFilter 落点）', () => {
    insertMsg({ id: 'm-user', content: 'u', createdAt: '2026-09-01 10:00:00' })
    insertMsg({ id: 'm-a', agentId: 'agent-a', content: 'a', createdAt: '2026-09-01 11:00:00' })
    insertMsg({ id: 'm-b', agentId: 'agent-b', content: 'b', createdAt: '2026-09-01 12:00:00' })

    const rows = messagesRepo.getSessionMessagesRange('s1', { agentId: 'agent-a' })
    expect(rows.map((r) => r.id)).toEqual(['m-a'])
  })

  it('system 消息恒不出现在窗口（limit 内含 system 也被挤出）', () => {
    insertMsg({ id: 'm1', content: 'normal', createdAt: '2026-09-01 10:00:00' })
    insertMsg({ id: 'm-sys1', role: 'system', content: 's1', createdAt: '2026-09-01 11:00:00' })
    insertMsg({ id: 'm-sys2', role: 'system', content: 's2', createdAt: '2026-09-01 12:00:00' })

    const rows = messagesRepo.getSessionMessagesRange('s1', { limit: 1 })
    expect(rows.map((r) => r.id)).toEqual(['m1'])
  })

  it('limit 越界防御性钳制（负数/超大 → 钳到 1/1000，不抛）', () => {
    insertMsg({ id: 'm1', content: 'x', createdAt: '2026-09-01 10:00:00' })
    expect(() => messagesRepo.getSessionMessagesRange('s1', { limit: 2000 })).not.toThrow()
    expect(messagesRepo.getSessionMessagesRange('s1', { limit: 2000 }).length).toBe(1)
    // 负数钳到 1（下界）→ 返回 1 条，不抛
    expect(messagesRepo.getSessionMessagesRange('s1', { limit: -5 }).length).toBe(1)
  })
})
