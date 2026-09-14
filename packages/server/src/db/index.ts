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

/**
 * 放宽 review_verdicts.verdict 的 CHECK 约束（加 'comment'，T-C 判词三档）。
 *
 * SQLite 不支持改 CHECK → 只能走标准的「建新表 + 拷数据 + 换名」重建。重建
 * **必须带闸门**：迁移数组每次启动全量重跑，把重建裸写进数组 = 每次开服 DROP
 * 一次生产表；更糟的是日后若有人给 review_verdicts 加列，会被这次重建按固定
 * 列清单静默回退。闸门 = 读 sqlite_master 里的建表 SQL，已含 'comment' 即跳过
 * （全新库走上面的 CREATE TABLE，天然命中跳过）。整个重建包在事务里，中途
 * 失败不会留下半成品。
 */
function widenReviewVerdictsCheck(): void {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'review_verdicts'`)
    .get() as { sql: string } | undefined
  if (!row || row.sql.includes("'comment'")) return

  db.transaction(() => {
    db.exec(`
      CREATE TABLE review_verdicts_widened (
        message_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        reviewer_agent_id TEXT NOT NULL,
        subject_agent_id TEXT,
        verdict TEXT NOT NULL CHECK (verdict IN ('approve', 'comment', 'suggest', 'reject')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT OR IGNORE INTO review_verdicts_widened
        SELECT message_id, session_id, reviewer_agent_id, subject_agent_id, verdict, created_at
        FROM review_verdicts;
      DROP TABLE review_verdicts;
      ALTER TABLE review_verdicts_widened RENAME TO review_verdicts;
    `)
  })()
  console.log('[db] migrated: review_verdicts verdict CHECK widened (comment)')
}

/**
 * `chunk_vectors` 的 vec0 表体 —— 迁移数组与量纲校正守卫**共用一份**，防两处漂移。
 * `distance_metric=cosine` 是与全仓阈值口径对齐的关键，见迁移条目处注释。
 */
const CHUNK_VECTORS_VEC0_BODY = `vec0(
        chunk_id INTEGER PRIMARY KEY,
        embedding float[512] distance_metric=cosine
      )`
/** 迁移数组用（`IF NOT EXISTS`：全新库与存量库都安全） */
const CHUNK_VECTORS_DDL = `CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING ${CHUNK_VECTORS_VEC0_BODY}`
/** 守卫用（前置 `DROP` 已执行 ⇒ 不带 `IF NOT EXISTS`，建表失败必须响亮） */
const CHUNK_VECTORS_RECREATE_DDL = `CREATE VIRTUAL TABLE chunk_vectors USING ${CHUNK_VECTORS_VEC0_BODY}`

/**
 * 存量库的 `chunk_vectors` 距离量纲校正（票辛 · 契约对齐，非新机制）。
 *
 * 为什么需要单独一个守卫：虚拟表的量纲写在 DDL 里，`CREATE ... IF NOT EXISTS`
 * 对**已存在**的表是 no-op ⇒ 老库会一直保留 L2 量纲，而代码侧的阈值全是余弦口径。
 * 不能把 `DROP + CREATE` 直接塞进迁移数组——那个循环**每次 initDb() 都跑**，
 * 会把索引向量每次启动清空一次。
 *
 * 校正代价 = 清空 `chunks` 三表。这是**必须**的：`chunk_vectors` 一重建，原有
 * `chunks` 行的向量就没了，而扫描器按 `origin_id` 增量比对 ⇒ 这些行会被判「没变」
 * 而跳过，永远补不上向量（静默不可召回）。三表同清 ⇒ 下次扫描全量重建 + 重嵌入
 * ——`chunks` 是 MD 的派生投影，清空可无损重建（Decisions 1）。
 */
/**
 * 量纲校正守卫的**有序**执行序列 —— **顺序即契约**。
 *
 * 两条 `DELETE` 必须排在 `DROP/CREATE` **之前**：`db.exec` 多语句**非原子**
 * （无显式事务），崩在任意两条之间都必须能收敛。反序（先 DROP+CREATE 再清数据）
 * 的窗口是：崩在 `DROP` 与 `CREATE` 之间 ⇒ 留下「`chunk_vectors` 缺表 + `chunks`
 * 满库」⇒ 下次启动迁移数组用 cosine DDL 把**空表**建回来、守卫见 cosine 直接
 * no-op ⇒ 扫描器按 `origin_id` 判「没变」全跳过（`scripts/flywheel/scan.mjs` 的
 * 增量判据）⇒ **永久静默不可召回**。正序则每个崩溃点要么 `chunks` 已清、要么
 * 守卫条件（非 cosine）仍成立会重跑 ⇒ 全路径收敛到「三表已清 ⇒ 下次扫描全量重建」。
 *
 * 导出给测试**按前缀逐点模拟崩溃**（`db/repository/chunks.test.ts`）：「不可达的
 * 状态」没法用一条运行用例覆盖，只能对崩溃点穷举。
 */
export const CHUNK_VECTOR_METRIC_FIX_SEQUENCE: ReadonlyArray<{
  sql: string
  optional: boolean
}> = [
  // ① 先清数据（optional：极老库可能缺 chunks_fts / chunks，无事可清）
  { sql: 'DELETE FROM chunks_fts', optional: true },
  { sql: 'DELETE FROM chunks', optional: true },
  // ② 再重建向量表（失败必须响亮——静默 = 量纲没校正却以为校正了）
  { sql: 'DROP TABLE IF EXISTS chunk_vectors', optional: false },
  { sql: CHUNK_VECTORS_RECREATE_DDL, optional: false },
]

function ensureChunkVectorCosineMetric(): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chunk_vectors'")
    .get() as { sql: string } | undefined
  if (!row || row.sql.includes('distance_metric=cosine')) return

  for (const step of CHUNK_VECTOR_METRIC_FIX_SEQUENCE) {
    try {
      db.exec(step.sql)
    } catch (err) {
      if (!step.optional) throw err
      /* 表不存在：无事可清 */
    }
  }
  console.log('[db] chunk_vectors 距离量纲已校正为 cosine，chunks 三表已清空待重扫')
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

    -- ⚠️ memories 表**已下线**（票辛 ⑥ 段三检索接线）：对话原话不再入库，
    -- 索引唯一来源是飞轮扫描器产出的 chunks。全新库不再建该表；存量库由
    -- 迁移数组末尾的 DROP 清除。原 DDL 见 git 历史（本块删除前的版本）。

    -- 知识库表（知识库 Phase 1）：运营方维护的标准数据，独立表不加 type 列
    -- 混进 memories（该表已下线，本句保留为历史语义说明）——对话记忆可被
    -- UPDATE 修正（去重三段式，已随旧写口退役），知识库不可被对话覆盖，
    -- 复用表会让去重/更新语义硬分叉（roadmap 已定，保持）
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
      name: 'tool_content on messages',
      // 工具调用记录（结构化 JSON 数组：id/name/status/input/output 截断摘要）。
      // 独立列 = 与正文/思考三通道分离、永不进 LLM 上下文（上下文构建只消费 content）；
      // additive ALTER + 存量行 NULL（无工具 = 旧消息/纯文本回复，读侧 undefined 兼容）
      sql: `ALTER TABLE messages ADD COLUMN tool_content TEXT`,
    },
    {
      name: 'segments on messages',
      // 回复分段（kind+content+tool 按时间序交错，JSON 字符串）——历史渲染还原生成期
      // 交错顺序的权威来源（镜像 clowder 有序块数组）。落库即持久化生成期交错时序——
      // 此前 insertAgentMessage 只写 content/thinking_content/tool_content 三列、交错序
      // 落库即丢，历史折叠块只能「思考一块+工具一块」堆叠（最终输出收拢工具根因）。
      // additive ALTER + 存量行 NULL（老消息无分段 = 前端退化现行为，零回归）
      sql: `ALTER TABLE messages ADD COLUMN segments TEXT`,
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
        verdict TEXT NOT NULL CHECK (verdict IN ('approve', 'comment', 'suggest', 'reject')),
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
    // ⚠️ `memories_fts`（FTS5 关键词通道）建表迁移**已删除**：整条 memories
    // 检索链随段三接线下线（票辛 ⑥），关键词通道改由 `chunks_fts` 承担。
    // 全新库不建该表；存量库由数组末尾的 DROP 清除。原 DDL 见 git 历史。
    //
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
    // 契约③ flow_state 当前状态表（additive：CREATE TABLE IF NOT EXISTS 幂等，老库重跑零副作用）。
    // 键 (session_id, commit_sha) = 一个 commit 在某个会话的主干道走到哪；值=主干道状态
    // （implement/quality-gate/request-review/receive-review/closed，见 execution/flow-state.ts）。
    // 状态机只管主干道；岔道走判断式投递不落此表。同事务更新见 db/repository/flowStates.ts。
    {
      name: 'flow_states table (契约③ 当前状态)',
      sql: `CREATE TABLE IF NOT EXISTS flow_states (
        session_id TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (session_id, commit_sha)
      )`,
    },
    // 契约③ flow_state 审计流水表（additive：幂等）。每次状态变更随写一条（含 from→to+intent），
    // 与 flow_states.state 字段双保险——状态字段被误改时可由流水还原；独立于状态字段做兜底留痕。
    {
      name: 'flow_state_events table (契约③ 审计流水)',
      sql: `CREATE TABLE IF NOT EXISTS flow_state_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT NOT NULL,
        intent TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    },
    // ─── 段三索引表（记忆飞轮：MD → 切片索引，Decisions 34 X1/X2）───────────
    // chunks 是**派生投影**（可从 MD 无损重建，Decisions 1）——写入侧是扫描器
    // （票庚），读侧是检索接线（票辛），本段只建表，不含任何写入同步逻辑。
    //
    // ⚠️ 表内**禁存任何扫描时间戳 / 运行态列**（X3）：`scanned_at`/`updated_at`/
    // `last_seen` 一类列一旦落表，「删表 → 重扫 → 逐行等价」这条不变式必破。
    // 唯一例外是 `date`——它是 **MD 里的历史事实**（由票戊冻结），不是扫描时刻。
    //
    // 身份键 = (doc_path, section_anchor, content_hash)（Decisions 17 明裁
    // 「不必带片序号」）：带片序号会让「节内插入一段」把后续所有碎片身份全变。
    // `part_index`/`part_total` **是列、不进唯一键**——它们是重扫时被覆盖的搬运工。
    // 已知边界：同一节内两片 body 完全相同 ⇒ 唯一键相撞、幂等合一（丢一个片序号）。
    // 取舍照 Decisions 17 原样：合一是确定性的 ⇒ 「重扫 N 次结果不变」仍成立。
    {
      name: 'chunks table (段三切片索引)',
      sql: `CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_path TEXT NOT NULL,
        section_anchor TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        origin_id TEXT NOT NULL,
        type TEXT,
        status TEXT,
        date TEXT,
        evidence TEXT,
        supersedes TEXT,
        superseded_by TEXT,
        valid_from TEXT,
        valid_to TEXT,
        part_index INTEGER NOT NULL,
        part_total INTEGER NOT NULL,
        hard_cut INTEGER NOT NULL DEFAULT 0,
        body TEXT NOT NULL,
        breadcrumb TEXT NOT NULL
      )`,
    },
    {
      name: 'chunks identity unique index (doc_path, section_anchor, content_hash)',
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_identity
        ON chunks(doc_path, section_anchor, content_hash)`,
    },
    // 查询体过滤面（X4）：status 是节级硬排除维度（Decisions 24）
    {
      name: 'idx_chunks_status',
      sql: `CREATE INDEX IF NOT EXISTS idx_chunks_status ON chunks(status)`,
    },
    // 增量比对面（Q5 S2）：扫描器按 origin_id（= 扫描时 MD 的 git blob SHA）比对
    {
      name: 'idx_chunks_origin',
      sql: `CREATE INDEX IF NOT EXISTS idx_chunks_origin ON chunks(origin_id)`,
    },
    // 切片向量（X1）：sqlite-vec vec0，512 维（= Xenova/bge-small-zh-v1.5 输出维度，
    // 与 memories/knowledge 的 embedding BLOB 同维）。chunk_id ↔ chunks.id 对齐。
    //
    // ⚠️ **必须显式声明 `distance_metric=cosine`**（票辛实测）：vec0 不写这一句时
    // 默认量纲是 **L2**，而全仓的距离阈值词汇（`MEMORY_MAX_DISTANCE` 0.6 /
    // knowledge 0.35 / `searchChunksByVector` 文档写的「余弦距离」）全是余弦口径。
    // 实测同一对向量：默认 L2 = 0.7654，cosine = 0.2929 —— 混用会让阈值静默变严，
    // 属于「不报错的召回劣化」。存量库的校正见 `ensureChunkVectorCosineMetric()`。
    //
    // ⚠️ 写入侧地雷（本仓首次引入 vec0，实测取证）：vec0 是虚拟表，**没有列的
    // INTEGER 亲和性**，PK 值必须原样以 SQLITE_INTEGER 抵达 xUpdate。better-sqlite3
    // 把 JS number 一律按 REAL 绑定（`typeof(?)` 实测 = real），普通表靠列亲和性
    // 把 real 收敛回 integer 所以看不出来，vec0 则直接抛
    // 「Only integers are allows for primary key values」。⇒ **显式写 chunk_id 必须
    // 传 BigInt**（`BigInt(chunkId)`）；不传 PK 让 SQLite 自增则不受影响。
    {
      name: 'chunk_vectors table (sqlite-vec vec0)',
      sql: CHUNK_VECTORS_DDL,
    },
    // 关键词通道（W1）：**逐项对齐 memories_fts**——非 external content 独立表，
    // content 列存 bigram 预分词串（空格 join，两侧对称），tokenize='unicode61'
    // 按空格切回 token（零中文分词器依赖）；rowid 映射 chunks.rowid，检索 JOIN 取原文。
    // 本票**只建表**：写入侧同步（bigram 切分 + 双写）归票庚/票辛。
    {
      name: 'chunks_fts table (FTS5 关键词通道)',
      sql: `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        content,
        tokenize='unicode61'
      )`,
    },
    // ─── 段四记忆检索流水（P2 / R1）：retrieval_* 三表 ──────────────────────
    // 定位：**只采不改**——纯新增写口，读侧（评估中心「链路」tab / 检索面看板）
    // 是后续叶子节点（P2 §七 边界）。三表按粒度分层：一 event 含 N query，
    // 一 query 含 N candidate（归属，不是流水线先后）。
    //
    // 拆表判据（用户 2026-09-14 裁「表需要具有代表性，主要代表某类东西」）：
    // 单表方案把检索级/查询级事实复制到每个候选行上（约 23 遍），一致性只能靠
    // 「冗余列一律全行写」这类纪律看住；拆开后这些值各自只有一行，**按定义
    // 不可能稀疏**——一致性由结构保证，不由纪律看住。
    //
    // 冗余判据（P2 §一）：「凡事后无法可靠重算的值，一律冗余进表」——
    //   · 参数快照（threshold_max_distance / param_top_k / param_probe_n）：
    //     `.env` 改一次阈值，全部历史行的可解释性当场归零（分不清某片被挡掉
    //     是离得远还是当时阈值是 0.5）；
    //   · 人类可读快照（breadcrumb / body_head / status_at_query）：`chunks`
    //     是可重建的派生表（重扫 id 全变、status/body 被覆盖），不冗余则历史行
    //     退化成读不懂的锚点。
    //
    // ⚠️ 表内**禁存**任何可从别处 join 出来的冗余计数（如 query_total /
    // queries_embedded）——首版单表方案里这两列是「追着用户要签字」的产物，
    // 拆表后它们由 `SELECT COUNT(*)` 派生，**不是被回答，是不存在了**。
    {
      name: 'retrieval_events table (段四检索流水·检索级)',
      sql: `CREATE TABLE IF NOT EXISTS retrieval_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        execution_id TEXT NOT NULL,
        session_id TEXT,
        agent_id TEXT,
        task_id TEXT,
        created_at TEXT NOT NULL,
        threshold_max_distance REAL NOT NULL,
        param_top_k INTEGER NOT NULL,
        param_probe_n INTEGER,
        reason TEXT NOT NULL,
        retrieval_ms INTEGER,
        context_tokens INTEGER,
        budget_tokens INTEGER,
        truncated INTEGER
      )`,
    },
    // 索引：挂链路（execution_id）/ 时间窗取数（created_at）/ 与 P1 链锚对齐（task_id）
    {
      name: 'idx_retrieval_events_execution',
      sql: `CREATE INDEX IF NOT EXISTS idx_retrieval_events_execution
        ON retrieval_events(execution_id)`,
    },
    {
      name: 'idx_retrieval_events_created',
      sql: `CREATE INDEX IF NOT EXISTS idx_retrieval_events_created
        ON retrieval_events(created_at)`,
    },
    {
      name: 'idx_retrieval_events_task',
      sql: `CREATE INDEX IF NOT EXISTS idx_retrieval_events_task
        ON retrieval_events(task_id)`,
    },
    {
      name: 'retrieval_queries table (段四检索流水·查询级)',
      sql: `CREATE TABLE IF NOT EXISTS retrieval_queries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        retrieval_id INTEGER NOT NULL REFERENCES retrieval_events(id) ON DELETE CASCADE,
        query_index INTEGER NOT NULL,
        query_text TEXT NOT NULL,
        query_embed_ok INTEGER NOT NULL,
        UNIQUE(retrieval_id, query_index)
      )`,
    },
    // 候选级 20 列。两处口径必须与 §四 表 3 逐字一致，易写错：
    //   · `distance` 纯关键词命中写 **NULL**（不写 maxDistance 哨兵）——「这片怎么
    //     进来的」由 `channel` 承担，哨兵值退休；
    //   · `injected` 的口径是**节**（注入单位是节，Decisions 14）：该片所属的节
    //     最终进了 prompt ⇒ 1。`injected` 与 `dropped_reason` 必须分开——「被阈值
    //     挡掉」和「被预算截断」是两个相反的药方（松阈值 vs 加预算）。
    //   · `chunk_id` 是**诊断专用探针**（回查「现在的 chunk_id 还是不是同一片」），
    //     **绝不作 join 键**——身份一律走 (doc_path, section_anchor, content_hash)。
    {
      name: 'retrieval_candidates table (段四检索流水·候选级)',
      sql: `CREATE TABLE IF NOT EXISTS retrieval_candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query_id INTEGER NOT NULL REFERENCES retrieval_queries(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        channel TEXT,
        doc_path TEXT NOT NULL,
        section_anchor TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        chunk_id INTEGER,
        breadcrumb TEXT,
        body_head TEXT,
        status_at_query TEXT,
        distance REAL,
        rank INTEGER,
        rrf_score REAL,
        final_rank INTEGER,
        passed_status_filter INTEGER,
        injected INTEGER NOT NULL,
        section_rank INTEGER,
        injected_position INTEGER,
        dropped_reason TEXT
      )`,
    },
    // 看板主查询路径：按查询取候选
    {
      name: 'idx_retrieval_candidates_query',
      sql: `CREATE INDEX IF NOT EXISTS idx_retrieval_candidates_query
        ON retrieval_candidates(query_id)`,
    },
    // 同一片的历次召回序列（改前改后对比）。**单列**——时间窗条件在
    // retrieval_events.created_at 上，跨表 join 后过滤。
    {
      name: 'idx_retrieval_candidates_content_hash',
      sql: `CREATE INDEX IF NOT EXISTS idx_retrieval_candidates_hash
        ON retrieval_candidates(content_hash)`,
    },
    // ─── 票辛 ⑥ 旧链下线：memories / memories_fts 双 DROP ──────────────────
    // 对话原话向量记忆链整体退役：写口已由票壬摘除（`saveMessageMemory` 删除 +
    // 存量清零），读口本票改走 `chunks`，两张表再无任何调用方（W8 判据）。
    //
    // ⚠️ **不可逆**，且与「删表可重建」的索引侧不同：`chunks` 是 MD 的派生投影
    // （可无损重建），`memories` 是**对话原话**——没有源文件可重放，DROP 即永久
    // 丢失。执行前提是票壬已先清空数据（实测 198/110 → 0，删的是空表）。
    //
    // FK 安全性：`memories.agent_id → agents(id)` 是**它引用别人**，无子表引用它
    // ⇒ DROP 不触发 FK 逐行校验，也不需要先删 agents。
    //
    // `DROP TABLE IF EXISTS` 对全新库是 no-op：上面两处 CREATE 已删，全新库压根
    // 没有这两张表；存量库由本条目清除。放在数组**末尾** = 所有建表迁移都跑完
    // 之后才执行，避免「先删后建」把表又建回来。
    {
      name: 'drop memories chain tables (票辛 旧链下线)',
      sql: `DROP TABLE IF EXISTS memories_fts;
            DROP TABLE IF EXISTS memories`,
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

  widenReviewVerdictsCheck()
  ensureChunkVectorCosineMetric()

  console.log('[db] SQLite initialized at', DB_PATH)
}
