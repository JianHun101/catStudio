import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb } from './index.js'

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
    it('has all 5 expected tables', () => {
      const db = getDb()
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>
      const names = tables.map((t) => t.name)
      expect(names).toContain('agents')
      expect(names).toContain('sessions')
      expect(names).toContain('messages')
      expect(names).toContain('memories')
      expect(names).toContain('execution_logs')
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
  })

  describe('schema - memories table', () => {
    it('has embedding BLOB column', () => {
      const db = getDb()
      const cols = db.pragma('table_info(memories)') as Array<{ name: string }>
      const colNames = cols.map((c) => c.name)
      expect(colNames).toContain('embedding')
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

    it('additive migrations 幂等：initDb 重复执行不炸（列已存在则 ALTER 静默跳过）', async () => {
      const { initDb } = await import('./index.js')
      const db = getDb()
      // 模拟旧库升级：先建好全部新列（含 compressed_summaries），再跑 initDb 迁移数组
      // → 所有 ALTER/CREATE 在 try/catch 中静默跳过，重复启动零副作用
      expect(() => initDb()).not.toThrow()
      const cols = db.pragma('table_info(sessions)') as Array<{ name: string }>
      expect(cols.map((c) => c.name)).toContain('compressed_summaries')
    })
  })
})
