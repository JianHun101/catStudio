import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = path.join(__dirname, '..', '..', 'data', 'cat-study.db')

let db: Database.Database

export function getDb(): Database.Database {
  if (!db) {
    const dataDir = path.dirname(DB_PATH)
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }

    db = new Database(DB_PATH)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
  }
  return db
}

/** 仅在测试中使用：注入外部 DB 实例（如 :memory:） */
export function setDb(testDb: Database.Database): void {
  db = testDb
}

/** 仅在测试中使用：关闭并重置 DB 单例 */
export function resetDb(): void {
  if (db) {
    db.close()
    db = undefined as unknown as Database.Database
  }
}

export function initDb(): void {
  const db = getDb()

  // 加载 sqlite-vec 向量扩展（vec_distance_cosine 等函数）
  sqliteVec.load(db)

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      avatar TEXT NOT NULL DEFAULT '🐱',
      system_prompt TEXT NOT NULL,
      llm_provider TEXT NOT NULL DEFAULT 'deepseek',
      llm_model TEXT NOT NULL DEFAULT 'deepseek-v4-pro',
      llm_api_key TEXT NOT NULL,
      llm_base_url TEXT,
      skill_modules TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      agent_ids TEXT NOT NULL DEFAULT '[]',
      broadcast_mode INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );


    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_id TEXT,
      role TEXT NOT NULL CHECK (role IN ('user', 'agent', 'system')),
      content TEXT NOT NULL,
      mentions TEXT NOT NULL DEFAULT '[]',
      task_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session
      ON messages(session_id, created_at);

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding BLOB,
      source_message_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS execution_logs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      triggered_by_message_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
      trace_id TEXT NOT NULL DEFAULT '',
      started_at TEXT,
      ended_at TEXT,
      latency_ms INTEGER,
      error_message TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id),
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS session_read_state (
      session_id TEXT PRIMARY KEY,
      last_read_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS connector_bindings (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      external_type TEXT NOT NULL CHECK (external_type IN ('group', 'private')),
      external_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (platform, external_type, external_id)
    );
  `)

  // ─── 迁移 ─────────────────────────────────────────

  const migrations: Array<{ name: string; sql: string }> = [
    {
      name: 'broadcast_mode on sessions',
      sql: `ALTER TABLE sessions ADD COLUMN broadcast_mode INTEGER NOT NULL DEFAULT 0`,
    },
    {
      name: 'trace_id on execution_logs',
      sql: `ALTER TABLE execution_logs ADD COLUMN trace_id TEXT NOT NULL DEFAULT ''`,
    },
    {
      name: 'latency_ms on execution_logs',
      sql: `ALTER TABLE execution_logs ADD COLUMN latency_ms INTEGER`,
    },
    {
      name: 'error_message on execution_logs',
      sql: `ALTER TABLE execution_logs ADD COLUMN error_message TEXT`,
    },
    {
      name: 'task_id on messages',
      sql: `ALTER TABLE messages ADD COLUMN task_id TEXT`,
    },
    {
      name: 'images on messages',
      sql: `ALTER TABLE messages ADD COLUMN images TEXT`,
    },
    {
      name: 'message_id on execution_logs',
      sql: `ALTER TABLE execution_logs ADD COLUMN message_id TEXT`,
    },
    {
      name: 'commit_hash on execution_logs',
      sql: `ALTER TABLE execution_logs ADD COLUMN commit_hash TEXT`,
    },
    {
      name: 'packages_installed on execution_logs',
      sql: `ALTER TABLE execution_logs ADD COLUMN packages_installed TEXT`,
    },
    {
      name: 'effort_level on agents',
      // 注意：NOT NULL 必须带 DEFAULT（历史老库已是 NOT NULL DEFAULT 'high'，此迁移对老库静默跳过、对新库建出同构）
      sql: `ALTER TABLE agents ADD COLUMN effort_level TEXT NOT NULL DEFAULT 'high'`,
    },
    {
      name: 'prompt_chars on execution_logs',
      sql: `ALTER TABLE execution_logs ADD COLUMN prompt_chars INTEGER`,
    },
    {
      name: 'reply_chars on execution_logs',
      sql: `ALTER TABLE execution_logs ADD COLUMN reply_chars INTEGER`,
    },
    {
      name: 'prompt_tokens on execution_logs',
      sql: `ALTER TABLE execution_logs ADD COLUMN prompt_tokens INTEGER`,
    },
    {
      name: 'completion_tokens on execution_logs',
      sql: `ALTER TABLE execution_logs ADD COLUMN completion_tokens INTEGER`,
    },
    {
      name: 'running_summary on sessions',
      sql: `ALTER TABLE sessions ADD COLUMN running_summary TEXT`,
    },
    {
      name: 'handoff_from on sessions',
      sql: `ALTER TABLE sessions ADD COLUMN handoff_from TEXT`,
    },
    {
      name: 'summary_msg_id on sessions',
      sql: `ALTER TABLE sessions ADD COLUMN summary_msg_id TEXT`,
    },
    {
      name: 'skill_modules on agents',
      sql: `ALTER TABLE agents ADD COLUMN skill_modules TEXT NOT NULL DEFAULT '[]'`,
    },
    {
      name: 'thinking_content on messages',
      sql: `ALTER TABLE messages ADD COLUMN thinking_content TEXT`,
    },
    {
      name: 'dispatch_state on messages',
      sql: `ALTER TABLE messages ADD COLUMN dispatch_state TEXT DEFAULT NULL`,
    },
    {
      name: 'role on agents',
      // 默认 'unknown'——老库零回归（白名单对未知角色放行不拦截），seed 后各就其位
      sql: `ALTER TABLE agents ADD COLUMN role TEXT NOT NULL DEFAULT 'unknown'`,
    },
  ]

  for (const m of migrations) {
    try {
      db.exec(m.sql)
      console.log(`[db] migrated: added ${m.name}`)
    } catch {
      // 列已存在则忽略
    }
  }

  console.log('[db] SQLite initialized at', DB_PATH)
}
