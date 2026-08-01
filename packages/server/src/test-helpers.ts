/**
 * 共享测试工具。
 *
 * - 创建内存 SQLite 数据库（含完整 schema）
 * - Fastify 测试应用构建
 */
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import type { FastifyInstance } from 'fastify'
import Fastify from 'fastify'

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    avatar TEXT NOT NULL DEFAULT '🐱',
    system_prompt TEXT NOT NULL,
    llm_provider TEXT NOT NULL DEFAULT 'deepseek',
    llm_model TEXT NOT NULL DEFAULT 'deepseek-v4-pro',
    llm_api_key TEXT NOT NULL,
    llm_base_url TEXT,
    effort_level TEXT NOT NULL DEFAULT 'high',
    skill_modules TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    agent_ids TEXT NOT NULL DEFAULT '[]',
    broadcast_mode INTEGER NOT NULL DEFAULT 0,
    running_summary TEXT,
    handoff_from TEXT,
    summary_msg_id TEXT,
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
    images TEXT,
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
    message_id TEXT,
    commit_hash TEXT,
    packages_installed TEXT,
    prompt_chars INTEGER,
    reply_chars INTEGER,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id),
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  CREATE TABLE IF NOT EXISTS session_read_state (
    session_id TEXT PRIMARY KEY,
    last_read_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
`

/**
 * 创建带完整 schema 的内存 SQLite 数据库。
 * 尝试加载 sqlite-vec 扩展（向量检索类测试依赖；个别环境加载失败时降级，
 * 存储类测试不受影响）。
 */
export function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)
  try {
    sqliteVec.load(db)
  } catch {
    // sqlite-vec 原生扩展加载失败 → 仅检索类测试受影响
  }
  return db
}

/**
 * 创建用于测试的 Fastify 实例（不启动服务，不注册任何插件，不调用 ready）。
 * 通过 `app.inject()` 发送请求——它会自动 boot。
 */
export async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  return app
}
