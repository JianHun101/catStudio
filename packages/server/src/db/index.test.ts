import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb, initDb } from './index.js'

describe('db', () => {
  beforeEach(() => {
    setDb(createTestDb())
  })

  afterEach(() => {
    resetDb()
  })

  describe('getDb', () => {
    it('returns the injected test database', () => {
      const db = getDb()
      expect(db).toBeDefined()
      expect(db.open).toBe(true)
    })
  })

  describe('schema - tables', () => {
    it('has all expected tables', () => {
      const db = getDb()
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>
      const names = tables.map((t) => t.name)
      expect(names).toContain('agents')
      expect(names).toContain('sessions')
      expect(names).toContain('messages')
      expect(names).toContain('knowledge')
      expect(names).toContain('execution_logs')
      // `chunks` 系三表由迁移建，本文件的手搓测试 schema 不含 —— 见下方
      // 「旧 memories 链已下线」describe（那里走真实 initDb() 迁移路径）
    })
  })

  describe('schema - flow_states table (契约③)', () => {
    it('has session_id/commit_sha/state columns', () => {
      const db = getDb()
      const cols = db.pragma('table_info(flow_states)') as Array<{ name: string }>
      const colNames = cols.map((c) => c.name)
      expect(colNames).toContain('session_id')
      expect(colNames).toContain('commit_sha')
      expect(colNames).toContain('state')
      expect(colNames).toContain('updated_at')
    })

    it('flow_state_events 审计流水有 from_state/to_state/intent', () => {
      const db = getDb()
      const cols = db.pragma('table_info(flow_state_events)') as Array<{ name: string }>
      const colNames = cols.map((c) => c.name)
      expect(colNames).toContain('session_id')
      expect(colNames).toContain('commit_sha')
      expect(colNames).toContain('from_state')
      expect(colNames).toContain('to_state')
      expect(colNames).toContain('intent')
    })
  })

  describe('schema - agents table', () => {
    it('has expected columns', () => {
      const db = getDb()
      const cols = db.pragma('table_info(agents)') as Array<{ name: string }>
      const colNames = cols.map((c) => c.name)
      expect(colNames).toContain('id')
      expect(colNames).toContain('name')
      expect(colNames).toContain('avatar')
      expect(colNames).toContain('system_prompt')
      expect(colNames).toContain('llm_provider')
      expect(colNames).toContain('llm_model')
      expect(colNames).toContain('llm_api_key')
      expect(colNames).toContain('llm_base_url')
      expect(colNames).toContain('created_at')
      expect(colNames).toContain('updated_at')
    })
  })

  describe('schema - sessions table', () => {
    it('has broadcast_mode column', () => {
      const db = getDb()
      const cols = db.pragma('table_info(sessions)') as Array<{ name: string }>
      const colNames = cols.map((c) => c.name)
      expect(colNames).toContain('broadcast_mode')
    })

    it('has compressed_summaries column（摘要替代压缩，additive 迁移）', () => {
      const db = getDb()
      const cols = db.pragma('table_info(sessions)') as Array<{ name: string }>
      const colNames = cols.map((c) => c.name)
      expect(colNames).toContain('compressed_summaries')
    })
  })

  describe('schema - messages table', () => {
    it('has expected columns and role constraint', () => {
      const db = getDb()
      const cols = db.pragma('table_info(messages)') as Array<{ name: string }>
      const colNames = cols.map((c) => c.name)
      expect(colNames).toContain('session_id')
      expect(colNames).toContain('agent_id')
      expect(colNames).toContain('role')
      expect(colNames).toContain('content')
      expect(colNames).toContain('mentions')
    })

    it('has extra column（对话内 diff 富文本块通道，additive 迁移）', () => {
      const db = getDb()
      const cols = db.pragma('table_info(messages)') as Array<{ name: string }>
      const colNames = cols.map((c) => c.name)
      expect(colNames).toContain('extra')
    })

    // ─── 票 5 重建（FK agent_id / CHECK dispatch_state / created_at 口径）────────
    it('票 5：FK agent_id → agents 悬空引用被拦（此前是裸列，写什么都能落库）', () => {
      const db = getDb()
      db.prepare("INSERT INTO sessions (id, title) VALUES ('s1', 'test')").run()
      expect(() =>
        db
          .prepare(
            `INSERT INTO messages (id, session_id, agent_id, role, content)
             VALUES ('m-ghost', 's1', 'ghost-agent', 'user', 'x')`
          )
          .run()
      ).toThrowError(/FOREIGN KEY/)
    })

    it('票 5：CHECK dispatch_state 锁定**实测值域**（queued/running/done + NULL 放行）', () => {
      const db = getDb()
      db.prepare("INSERT INTO sessions (id, title) VALUES ('s1', 'test')").run()
      const ins = (id: string, st: string | null) =>
        db
          .prepare(
            `INSERT INTO messages (id, session_id, role, content, dispatch_state)
             VALUES (?, 's1', 'user', 'x', ?)`
          )
          .run(id, st)

      for (const st of ['queued', 'running', 'done', null]) {
        expect(() => ins(`ok-${String(st)}`, st), String(st)).not.toThrow()
      }
      // `completed` / `failed` 属 `execution_logs.status` 的值域（派活初稿张冠李戴）——
      // 照字面落 CHECK 会让 fire-and-forget 的 setDispatchState 撞约束而**静默失效**，
      // 这里钉住它确实被拒（真实值域见 `repository/messages.ts` 的类型签名）。
      expect(() => ins('bad-completed', 'completed')).toThrowError(/CHECK/)
      expect(() => ins('bad-failed', 'failed')).toThrowError(/CHECK/)
    })

    it('票 5：重建后**全库** foreign_key_check 零违规（spec §4.4 纪律 6 硬条款）', () => {
      const db = getDb()
      // 造真实引用链，避免「空库当然零违规」的真空断言
      db.prepare(
        `INSERT INTO agents (id, name, system_prompt, llm_api_key) VALUES ('a1', '猫', 'p', 'sk')`
      ).run()
      db.prepare(
        "INSERT INTO sessions (id, title, agent_ids) VALUES ('s1', 'test', '[\"a1\"]')"
      ).run()
      db.prepare(
        `INSERT INTO messages (id, session_id, agent_id, role, content, task_id)
         VALUES ('m1', 's1', 'a1', 'user', 'hi', 'task-1')`
      ).run()
      db.prepare(
        `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, trace_id)
         VALUES ('e1', 's1', 'a1', 'm1', 'completed', 'task-1')`
      ).run()

      expect(db.pragma('foreign_key_check')).toEqual([])
    })
  })

  describe('schema - 旧 memories 链已下线（票辛 ⑥）', () => {
    const tableNames = () =>
      (
        getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string
        }>
      ).map((r) => r.name)

    it('存量老库跑迁移后 memories / memories_fts 双双消失', () => {
      // 先在「老库」里造出这两张表 —— DROP 才真的被执行到（不是空跑）
      getDb().exec(`
        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, content TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, tokenize='unicode61');
      `)
      expect(tableNames()).toContain('memories')
      // **「老库」判据 = 有用户表 + 无台账**（runner 同款）：夹具是走真实迁移路径建出来的，
      // 台账齐全 ⇒ 不删台账的话 DROP 条目已登记，压根不会被碰到（本用例会退化成假绿）
      getDb().exec(`DROP TABLE schema_migrations`)

      initDb()

      const names = tableNames()
      expect(names).not.toContain('memories')
      expect(names).not.toContain('memories_fts')
      expect(names).toContain('chunks')
    })

    it('DROP 是幂等的：连跑两次 initDb() 不抛', () => {
      initDb()
      expect(() => initDb()).not.toThrow()
      expect(tableNames()).not.toContain('memories')
    })
  })

  describe('schema - execution_logs table', () => {
    it('has expected columns for auditing', () => {
      const db = getDb()
      const cols = db.pragma('table_info(execution_logs)') as Array<{ name: string }>
      const colNames = cols.map((c) => c.name)
      expect(colNames).toContain('status')
      expect(colNames).toContain('trace_id')
      expect(colNames).toContain('latency_ms')
      expect(colNames).toContain('error_message')
    })
  })

  describe('foreign keys', () => {
    it('enforces FK on messages → sessions', () => {
      const db = getDb()
      expect(() => {
        db.prepare(
          "INSERT INTO messages (id, session_id, role, content) VALUES ('m1', 'nonexistent', 'user', 'test')"
        ).run()
      }).toThrow()
    })

    it('enforces FK on messages → agents (nullable)', () => {
      const db = getDb()
      // agent_id is nullable, so this should not throw
      // But we need a session first
      db.prepare("INSERT INTO sessions (id, title) VALUES ('s1', 'test')").run()
      expect(() => {
        db.prepare(
          "INSERT INTO messages (id, session_id, agent_id, role, content) VALUES ('m1', 's1', null, 'user', 'test')"
        ).run()
      }).not.toThrow()
    })
  })

  describe('idempotency', () => {
    it('CREATE TABLE IF NOT EXISTS is idempotent', () => {
      const db = getDb()
      // Running DDL again should not throw
      expect(() => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS agents (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE
          );
        `)
      }).not.toThrow()
    })

    it('重复启动幂等：initDb 再跑不炸（台账已登记 ⇒ 零执行）', async () => {
      const { initDb } = await import('./index.js')
      const db = getDb()
      // 夹具 schema 由真实迁移路径建出、台账齐全 ⇒ 再跑 initDb 只是 checksum 校验 + no-op。
      // （「跳过」如今由台账承担，不再靠 ALTER/CREATE 的 try/catch 静默吞错）
      expect(() => initDb()).not.toThrow()
      const cols = db.pragma('table_info(sessions)') as Array<{ name: string }>
      expect(cols.map((c) => c.name)).toContain('compressed_summaries')
    })
  })

  describe('migration - review_verdicts CHECK 放宽（T-C 💬仅评论）', () => {
    /**
     * 把 review_verdicts 换成「旧 CHECK」版本，模拟 T-C 之前的存量库。
     *
     * ⚠️ 光换表不够：**「老库」判据 = 有用户表 + 无台账**。台账齐全时该条目已登记，
     * runner 只会 checksum 校验、不会再去碰它（这正是「台账管历史不管现状」的语义）
     * ⇒ 用例会退化成假绿。故一并删掉台账，走真正的老库补登路径（探针 false ⇒ 矫正）。
     */
    function downgradeToOldCheck(): void {
      getDb().exec(`
        DROP TABLE review_verdicts;
        CREATE TABLE review_verdicts (
          message_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          reviewer_agent_id TEXT NOT NULL,
          subject_agent_id TEXT,
          verdict TEXT NOT NULL CHECK (verdict IN ('approve', 'suggest', 'reject')),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        DROP TABLE schema_migrations;
      `)
    }

    const tableSql = () =>
      (
        getDb()
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='review_verdicts'")
          .get() as { sql: string }
      ).sql

    /**
     * 父行前置（票 6 起 `review_verdicts` 的 message_id / session_id / reviewer_agent_id
     * 都是 RESTRICT 外键）：缺父行的旧行会被重建条目的 D1 孤儿清理删掉 ⇒ 用例会退化成
     * 「测了个已被清理的空表」，而不是「旧 CHECK 被放宽」。
     */
    function seedParents(): void {
      getDb().exec(`
        INSERT INTO sessions (id, title, agent_ids) VALUES ('s1', 't', '[]');
        INSERT INTO agents (id, name, system_prompt, llm_api_key) VALUES ('r1', '吐槽猫', 'p', 'sk');
        INSERT INTO messages (id, session_id, role, content, mentions)
          VALUES ('m-old', 's1', 'agent', 'x', '[]'), ('m-comment', 's1', 'agent', 'x', '[]');
      `)
    }

    it('存量库（旧 CHECK）→ initDb 重建后可落 comment', async () => {
      const { initDb } = await import('./index.js')
      downgradeToOldCheck()
      seedParents()
      expect(tableSql()).not.toContain("'comment'")

      initDb()

      expect(tableSql()).toContain("'comment'")
      expect(() =>
        getDb()
          .prepare(
            `INSERT INTO review_verdicts (message_id, session_id, reviewer_agent_id, verdict, created_at)
             VALUES ('m-comment', 's1', 'r1', 'comment', '2026-09-01T00:00:00.000Z')`
          )
          .run()
      ).not.toThrow()
    })

    it('重建保数据 + 台账幂等：旧行原样搬过去，第二次 initDb 不再重建', async () => {
      const { initDb } = await import('./index.js')
      downgradeToOldCheck()
      seedParents()
      getDb()
        .prepare(
          `INSERT INTO review_verdicts (message_id, session_id, reviewer_agent_id, verdict)
           VALUES ('m-old', 's1', 'r1', 'suggest')`
        )
        .run()

      initDb()
      const row = getDb()
        .prepare(`SELECT verdict FROM review_verdicts WHERE message_id = 'm-old'`)
        .get() as { verdict: string } | undefined
      expect(row?.verdict).toBe('suggest') // 重建不是清库

      initDb() // 台账已登记 + 探针报效果已成立 → 跳过重建，数据不动
      const count = getDb().prepare(`SELECT COUNT(*) AS n FROM review_verdicts`).get() as {
        n: number
      }
      expect(count.n).toBe(1)
    })
  })
})
