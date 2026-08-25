import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// DB 分离（ADR 决策 9，脚本即配置）：NODE_ENV=production（pnpm start，日常真实
// 使用，记忆延续）→ 主库 cat-study.db；其他（pnpm dev 实验场，空库自举自动
// seed 同款猫）→ cat-study-dev.db。NODE_ENV 由 dev.js 的 --mode 设定（Windows
// 无内联 env 语法，零新依赖）；vitest 走 setDb 注入 :memory: 不受影响。
const DB_FILE_NAME = process.env.NODE_ENV === 'production' ? 'cat-study.db' : 'cat-study-dev.db'
const DB_PATH = path.join(__dirname, '..', '..', 'data', DB_FILE_NAME)

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
      name: 'extra on messages',
      // 消息附加富内容（diff 块等，JSON 字符串）——对话内 diff 展示通道。
      // 独立列 = 永不进 LLM 上下文（上下文构建只消费 content 列）。
      sql: `ALTER TABLE messages ADD COLUMN extra TEXT DEFAULT NULL`,
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
    {
      name: 'llm_env_extra on agents',
      // 额外环境变量（per-agent 静态运行配置）：JSON 字符串直存任意 env KV
      // （skill_modules 同款惯例）；加列带 DEFAULT '{}' 自动回填存量行——旧 agent
      // 升级零注入（无 envExtra），读侧零 COALESCE。seed upsert 不覆盖（运行配置）
      sql: `ALTER TABLE agents ADD COLUMN llm_env_extra TEXT NOT NULL DEFAULT '{}'`,
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
      );
      -- 同一条回复只评一次：UNIQUE 索引兜底（调用方仍先查后写省 judge 调用）。
      -- 独立语句幂等，已建表的存量库同样生效
      CREATE UNIQUE INDEX IF NOT EXISTS idx_eval_scores_message_id ON eval_scores(message_id)`,
    },
    // W4 用户回标表（additive：CREATE TABLE IF NOT EXISTS 幂等）。
    // 用户对低分样本的人工复核：eval_score_id UNIQUE = 一评一标，
    // 重复回标走覆盖（路由层先查后写 + log 留痕）。与 eval_scores
    // 通过 eval_score_id 关联，sample_reason 翻转为 'user_feedback'
    // 由路由层在写入成功后更新（表间不建外键，照 eval_scores 同款松耦合）
    {
      name: 'user_feedback table (W4 用户回标)',
      sql: `CREATE TABLE IF NOT EXISTS user_feedback (
        id TEXT PRIMARY KEY,
        eval_score_id TEXT NOT NULL UNIQUE,
        message_id TEXT,
        session_id TEXT,
        user_score REAL NOT NULL,
        comment TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    },
    {
      name: 'error_type on execution_logs',
      // W1 L1 错误分类桶列（additive ALTER；存量行 NULL，聚合 COALESCE('unknown') 兜底）
      sql: `ALTER TABLE execution_logs ADD COLUMN error_type TEXT`,
    },
    // v2 episode 评估表（additive：CREATE TABLE IF NOT EXISTS 幂等，老库重跑零副作用）。
    // 结构按 docs/plans/episode-evaluation-v2.md §3（九轮审查定稿 5b45a38）：
    // - root_trigger_message_id UNIQUE = 锚定主键（upsert 冲突键，五处先例）
    // - chain_task_id 允许 NULL（G2-N5：仅零执行场景可达；有执行行必有 trace_id 抄录）
    // - outcome 允许 NULL（未定 = 在途 open）；episode_state open→classified→closed（closure 状态机）
    // - classification_ver 承重 P5 全量重评（规则升级带新版本号全量 upsert 覆盖）
    {
      name: 'episodes table (v2 episode 评估)',
      sql: `CREATE TABLE IF NOT EXISTS episodes (
        id TEXT PRIMARY KEY,
        root_trigger_message_id TEXT NOT NULL UNIQUE,
        root_triggered_by TEXT NOT NULL CHECK (root_triggered_by IN ('U', 'H')),
        root_message_id TEXT,
        task_id TEXT,
        chain_task_id TEXT,
        session_id TEXT,
        outcome TEXT CHECK (outcome IN ('success', 'corrected_success', 'needs_investigation', 'harness_fix_needed', 'routing_failure', 'abandoned', 'unclassified')),
        episode_state TEXT NOT NULL CHECK (episode_state IN ('open', 'classified', 'closed')),
        classification_ver TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    },
    // E2 归因记录表（additive：CREATE TABLE IF NOT EXISTS 幂等）。
    // 非 success 结局的 episode 归因 → 分流到既有动作通道（调查单/拆活单/重放/改进素材），
    // 一个 episode 一条记录（UNIQUE 幂等键，防定时器每轮重复投递）；
    // status 流转 dispatched → resolved（closure 复验确认结局翻转后）。
    {
      name: 'episode_attributions table (E2 归因分流)',
      sql: `CREATE TABLE IF NOT EXISTS episode_attributions (
        id TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL UNIQUE,
        outcome TEXT NOT NULL,
        root_cause TEXT,
        action_type TEXT NOT NULL CHECK (action_type IN ('investigation', 'harness_fix', 'replay', 'improvement')),
        action_detail TEXT,
        status TEXT NOT NULL DEFAULT 'dispatched' CHECK (status IN ('dispatched', 'resolved')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (episode_id) REFERENCES episodes(id)
      )`,
    },
    // 混合检索 FTS5 关键词通道表（additive：CREATE VIRTUAL TABLE IF NOT EXISTS 幂等，
    // 老库重跑零副作用）。独立表（非 external content）——内容为 bigram 预分词串
    // （空格 join，memories.ts bigramTokenize 应用层切分），unicode61 按字母/数字切
    // token：每个 bigram 独立成 token，FTS 侧零中文分词依赖；rowid 映射
    // memories.rowid，检索 JOIN 取原文。同步走应用层双写（memories.ts 各写函数
    // 配套），测试 :memory: 无此表时双写容错降级（no such table 静默跳过），
    // 检索侧 hybrid 开关下同样降级纯向量
    {
      name: 'memories_fts table (FTS5 混合检索)',
      sql: `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content,
        tokenize='unicode61'
      )`,
    },
    // 摘要替代压缩列（additive ALTER；存量行 NULL = 无压缩历史，兼容）。
    // JSON 数组，每次压缩 append 一条 {createdAt, tokenCount, content}；
    // content 空串 = 异步生成中的 pending 占位（生成完成回填，消费侧跳过空条目）
    {
      name: 'compressed_summaries on sessions',
      sql: `ALTER TABLE sessions ADD COLUMN compressed_summaries TEXT`,
    },
    // E2 归因投递消息 id（additive ALTER；存量行 NULL = 旧库已投递无记录，
    // 追加标记对存量调查单不生效——观察项，新投递全量记录）。
    // 消息层闭环：dispatchAction 投递成功时写回，closure 复验 markResolved
    // 关闭时对原消息原地追加「✅已关闭」标记（方案 A，店长契约——用户
    // 同一位置看到完整状态，不撤回、不另起新消息）
    {
      name: 'delivery_message_id on episode_attributions',
      sql: `ALTER TABLE episode_attributions ADD COLUMN delivery_message_id TEXT`,
    },
    // 全局设置表（additive：CREATE TABLE IF NOT EXISTS 幂等）。
    // 铁律等运行期全局策略的挂载点——key/value 直存，getSetting/setSetting 访问器
    // 读写；设置优先、代码常量兜底（getIronLaws 单一权威访问器，见 config/iron-laws.ts）
    {
      name: 'settings table (运行期全局设置)',
      sql: `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
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
