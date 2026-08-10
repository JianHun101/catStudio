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

    -- 知识库表（知识库 Phase 1）：运营方维护的标准数据，独立表不加 type 列
    -- 混进 memories——对话记忆可被 UPDATE 修正（去重三段式），知识库不可被
    -- 对话覆盖，复用表会让去重/更新语义硬分叉（roadmap 已定，保持）
    CREATE TABLE IF NOT EXISTS knowledge (
      id         TEXT PRIMARY KEY,
      content    TEXT NOT NULL,
      embedding  BLOB,              -- 512-dim f32，同 memories.embedding 格式
      source     TEXT,              -- 来源标注（文档名/URL）
      tags       TEXT,              -- JSON 字符串数组，检索过滤预留
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    {
      name: 'llm_max_tokens on agents',
      // 静态运行配置（per-agent）：NOT NULL 必须带 DEFAULT（effort_level 同款注释）——
      // 加列带 DEFAULT 自动回填存量行，旧 agent 升级零行为变化，读侧零 COALESCE
      sql: `ALTER TABLE agents ADD COLUMN llm_max_tokens INTEGER NOT NULL DEFAULT 2048`,
    },
    {
      name: 'llm_temperature on agents',
      sql: `ALTER TABLE agents ADD COLUMN llm_temperature REAL NOT NULL DEFAULT 0.7`,
    },
    // W3 L3 审查结论契约表（additive：CREATE TABLE IF NOT EXISTS 幂等，
    // 老库重跑零副作用；新表不依赖老列，无 ALTER 依赖）
    {
      name: 'review_verdicts table',
      sql: `CREATE TABLE IF NOT EXISTS review_verdicts (
        message_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        reviewer_agent_id TEXT NOT NULL,
        subject_agent_id TEXT,
        verdict TEXT NOT NULL CHECK (verdict IN ('approve', 'suggest', 'reject')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    },
    {
      name: 'review_parse_failures table',
      sql: `CREATE TABLE IF NOT EXISTS review_parse_failures (
        message_id TEXT PRIMARY KEY,
        reason TEXT NOT NULL CHECK (reason IN ('no_subject', 'bad_verdict')),
        raw TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    },
    // W2 L2 评估评分表（additive：CREATE TABLE IF NOT EXISTS 幂等）。
    // judge 模型对采样回复的评分，独立于执行日志——评估是旁路，不占
    // agent slot、不进 dispatch 主链。sample_reason CHECK 三值：
    // 'user_feedback' 为 W4 预留值（无结构化信号时不实现，仅契约占位）
    {
      name: 'eval_scores table (W2 L2 评估子系统)',
      sql: `CREATE TABLE IF NOT EXISTS eval_scores (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        agent_id TEXT,
        score REAL NOT NULL,
        dimensions TEXT,
        judge_model TEXT NOT NULL,
        sample_reason TEXT NOT NULL CHECK (sample_reason IN ('random', 'low_score', 'user_feedback')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    },
    {
      name: 'error_type on execution_logs',
      // W1 L1 错误分类桶列（additive ALTER；存量行 NULL，聚合 COALESCE('unknown') 兜底）
      sql: `ALTER TABLE execution_logs ADD COLUMN error_type TEXT`,
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
