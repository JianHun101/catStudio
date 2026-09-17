/**
 * 迁移数组 —— 库结构的**唯一真相源**（票 `db-schema-governance` 票 1）。
 *
 * 定稿规格：`docs/plans/db-schema-governance.md` §3.1。四条纪律，改这个文件前先读：
 *
 * 1. **append-only**：数组只许**追加**；已登记条目的 `sql` **一个字节都不许改**
 *    （改 = 台账 checksum 对不上 = 拒启）。历史迁移的「最后一次合法改写窗口」就是
 *    压扁重放那一次，窗口已关闭。要改结构 → 在**数组末尾**追加一条 fix-forward。
 * 2. **`name` 是台账主键**：同名同一条；改名 = 删旧 + 增新（台账里会留一条无主的旧行，
 *    无害，但别指望改名能改语义）。
 * 3. **`sql` 是正文**：checksum = 它的 sha256 原文（不归一化），所以格式化也算改。
 * 4. **失败即拒启**：runner 每条一个 `BEGIN IMMEDIATE` 事务，零吞咽、零「预期错误」白名单。
 *
 * ## 这一版是「压扁」产物（②-a）
 *
 * 台账上船前，61 条历史迁移被一次性压扁成**基线集**：每张表一条 `CREATE TABLE`
 * 直接写**最新形状**（历史 ALTER 列并入列清单、`widenReviewVerdictsCheck` 的 CHECK
 * 放宽誊进 `review_verdicts` 基线），索引各归其位。压扁的正确性由
 * `migrations.test.ts` 的「誊写校验」钉死：空库重放基线集后的 `sqlite_master`
 * 必须与**改动前**旧码产物逐行一致（基准 `__fixtures__/schema-baseline.json`）。
 *
 * ## `verify` 探针（②-b）
 *
 * 只有**静默失败型**条目才挂探针——那些「失败不报错、只在运行时静默劣化」的重建类
 * 迁移。判据是**效果是否已成立**，两条路径同一把尺子：
 *
 * - 探针 `true` ⇒ 效果已成立（或目标对象不存在、无事可做）⇒ **跳过执行**，只登记；
 * - 探针 `false` ⇒ **真执行**（全新库 = 首次落地；老库补登 = 矫正路径）。
 *
 * 全量审计结论（票 1 实施时逐条过了一遍 61 条的压扁源）：
 * - **挂探针 3 条**：`widen review_verdicts …`、`chunk_vectors distance_metric=cosine`、
 *   `drop memories chain tables`——三条都是「效果缺失不报错、只静默劣化」。
 *   前两条是规格点名的候选；第三条是审计新增：`DROP TABLE IF EXISTS` 对缺表是 no-op，
 *   老库若仍留着两张死表，启动**不会有任何提示**，而 `db/index.test.ts` 有用例钉着
 *   「老库跑完 initDb 后两表必须消失」。不挂探针 = 该用例在老库路径上必然静默失效。
 * - **不挂探针 38 条**：其余 CREATE TABLE / CREATE INDEX / DROP 条目要么是纯新物体
 *   （缺了会在首次使用时响亮报错），要么效果由后续条目独立保证。加列类历史 ALTER 已
 *   并入基线列清单，老库「缺列」这条路径根本不成立（旧机制每次启动全量重跑，缺列会
 *   以 SELECT 报错的形式当场暴露，不会静默）。
 */
import type Database from 'better-sqlite3'

/** 一条迁移：`name` 台账主键 / `sql` 正文（checksum 原文）/ `verify` 可选矫正探针 */
export interface Migration {
  name: string
  sql: string
  verify?: (db: Database.Database) => boolean
  /**
   * **基线标记**（②-a / ②-b 的岔路口）：`true` = 台账上船前「历史已在此库发生」的压扁
   * 条目，老库对它**只登记不执行**（除非探针报效果缺失，走矫正）。
   *
   * 台账立闸后追加的迁移**一律不带**这个标记——它们从未在任何老库上发生过，走的是与新库
   * 同一条增量路径（真执行）。漏带 = 老库静默缺结构 + 台账记假历史，正是本票要消灭的失败类；
   * 故基线集不靠手写标记，而是由文件末尾的 `BASELINE_MIGRATIONS` 常量**结构性**盖上（见
   * 那里的纪律说明），测试另钉着「基线集条数冻结」。
   */
  baseline?: boolean
}

/**
 * `schema_migrations` 台账建表语句。放在本文件而不是 runner 里：`db/index.ts` 从此
 * **一句 DDL 都不含**（静态源断言钉着这条，见 `migrations.test.ts` 验收 5）。
 *
 * `note` 留空 = 正常落地；`note='baseline'` = 老库补登行（没真执行过，只是「历史已
 * 在此库发生」的登记）。`checksum` = 条目 `sql` 的 sha256 原文。
 */
export const SCHEMA_MIGRATIONS_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  note TEXT
)`

/** 取某张表的建表原文（不存在 → `undefined`）。虚拟表在 `sqlite_master` 里同样是 `type='table'`。 */
function tableSql(db: Database.Database, name: string): string | undefined {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { sql: string } | undefined
  return row?.sql
}

/**
 * `chunk_vectors` 的 vec0 表体 —— 基线建表与量纲校正**共用一份**，防两处漂移。
 * `distance_metric=cosine` 是与全仓阈值口径对齐的关键：vec0 不写这句默认是 **L2**，
 * 而 `MEMORY_MAX_DISTANCE` / knowledge 阈值 / `searchChunksByVector` 文档全是余弦口径，
 * 混用会让阈值静默变严（不报错的召回劣化）。
 */
const CHUNK_VECTORS_VEC0_BODY = `vec0(
        chunk_id INTEGER PRIMARY KEY,
        embedding float[512] distance_metric=cosine
      )`
/** 基线建表用（全新库安全） */
const CHUNK_VECTORS_DDL = `CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING ${CHUNK_VECTORS_VEC0_BODY}`
/** 量纲校正用（前置 `DROP` 已执行 ⇒ 不带 `IF NOT EXISTS`，建表失败必须响亮） */
const CHUNK_VECTORS_RECREATE_DDL = `CREATE VIRTUAL TABLE chunk_vectors USING ${CHUNK_VECTORS_VEC0_BODY}`

/**
 * `chunk_vectors` 量纲校正的**有序**执行序列 —— **顺序即契约**，导出给测试按前缀穷举。
 *
 * 先清数据再重建向量表：`chunk_vectors` 一重建，原有 `chunks` 行的向量就没了，而扫描器
 * 按 `origin_id` 增量比对 ⇒ 这些行会被判「没变」而跳过，向量永远补不上（静默不可召回）。
 * 三表同清 ⇒ 下次扫描全量重建 + 重嵌入——`chunks` 是 MD 的派生投影，清空可无损重建。
 *
 * ⚠️ 旧实现靠「顺序 + 每次启动重跑」把崩溃窗口一点点收敛；现在整条序列在**一个事务**里
 * 跑（`BEGIN IMMEDIATE`），崩在中间 = 整体回滚 = 状态退回「满库 + L2 表」，下次启动整条
 * 重来。顺序保留，但它不再是收敛性的唯一保证。
 */
export const CHUNK_VECTOR_METRIC_FIX_SEQUENCE: ReadonlyArray<string> = [
  // ① 先清数据（表存在性由探针保证：探针 false ⇒ chunk_vectors 存在 ⇒ 两张数据表也在）
  'DELETE FROM chunks_fts',
  'DELETE FROM chunks',
  // ② 再重建向量表（失败必须响亮——静默 = 量纲没校正却以为校正了）
  'DROP TABLE IF EXISTS chunk_vectors',
  CHUNK_VECTORS_RECREATE_DDL,
]

// ─── 基线集（②-a 压扁重放）────────────────────────────────────────────────
// 顺序 = 建表依赖序（FK 目标先建）。全新库按序重放；老库逐条**只登记不执行**。
// 每条 `sql` 的空白排版可读即可——誊写校验比对的是归一化后的词法（见测试文件），
// 但**任何 token 的增删改序都会被拦下**。
//
// ⚠️ **这个常量是封存的历史，不许再往里加东西**（加了 = 老库会静默跳过它）。新迁移一律
// 追加到文件末尾的 `APPENDED_MIGRATIONS`。

const BASELINE_MIGRATIONS: ReadonlyArray<Migration> = [
  // ── 会话 / 猫 ────────────────────────────────────────
  {
    name: 'sessions table',
    sql: `CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      agent_ids TEXT NOT NULL DEFAULT '[]',
      broadcast_mode INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      running_summary TEXT,
      handoff_from TEXT,
      summary_msg_id TEXT,
      compressed_summaries TEXT
    )`,
  },
  {
    name: 'agents table',
    sql: `CREATE TABLE IF NOT EXISTS agents (
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
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      effort_level TEXT NOT NULL DEFAULT 'high',
      role TEXT NOT NULL DEFAULT 'unknown',
      llm_max_tokens INTEGER NOT NULL DEFAULT 2048,
      llm_temperature REAL NOT NULL DEFAULT 0.7,
      llm_env_extra TEXT NOT NULL DEFAULT '{}'
    )`,
  },
  {
    // 列序抄自压扁前的实际产物（`created_at` 在 ADD COLUMN 追加列**之前**，历史如此）
    name: 'messages table',
    sql: `CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_id TEXT,
      role TEXT NOT NULL CHECK (role IN ('user', 'agent', 'system')),
      content TEXT NOT NULL,
      mentions TEXT NOT NULL DEFAULT '[]',
      task_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      images TEXT,
      thinking_content TEXT,
      tool_content TEXT,
      segments TEXT,
      dispatch_state TEXT DEFAULT NULL,
      extra TEXT DEFAULT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )`,
  },
  {
    name: 'idx_messages_session',
    sql: `CREATE INDEX IF NOT EXISTS idx_messages_session
      ON messages(session_id, created_at)`,
  },
  // ── 知识库 ───────────────────────────────────────────
  {
    // ⚠️ 行内 `--` 注释是**建表原文的一部分**（SQLite 原样存进 sqlite_master），
    // 删掉就与旧码产物对不上——誊写校验会拦住。别顺手清理。
    name: 'knowledge table',
    sql: `CREATE TABLE IF NOT EXISTS knowledge (
      id         TEXT PRIMARY KEY,
      content    TEXT NOT NULL,
      embedding  BLOB,              -- 512-dim f32，同 memories.embedding 格式
      source     TEXT,              -- 来源标注（文档名/URL）
      tags       TEXT,              -- JSON 字符串数组，检索过滤预留
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  },
  // ── 执行日志 ─────────────────────────────────────────
  {
    name: 'execution_logs table',
    sql: `CREATE TABLE IF NOT EXISTS execution_logs (
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
      error_type TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id),
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    )`,
  },
  {
    name: 'session_read_state table',
    sql: `CREATE TABLE IF NOT EXISTS session_read_state (
      session_id TEXT PRIMARY KEY,
      last_read_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )`,
  },
  {
    name: 'connector_bindings table',
    sql: `CREATE TABLE IF NOT EXISTS connector_bindings (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      external_type TEXT NOT NULL CHECK (external_type IN ('group', 'private')),
      external_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (platform, external_type, external_id)
    )`,
  },
  // ── 审查 / 评估 ──────────────────────────────────────
  {
    // 基线直接写**放宽后**的 CHECK（含 'comment'，T-C 判词三档）——
    // 放宽本身对老库走下面那条探针条目
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
    // 老库矫正路径：旧 CHECK 不含 'comment' ⇒ 探针 false ⇒ 真跑一次重建（建新表 + 拷数据 + 换名）。
    // 全新库：上面那条基线已建出含 'comment' 的表 ⇒ 探针 true ⇒ 跳过（不白重建一次）。
    name: 'widen review_verdicts verdict CHECK (comment)',
    sql: `CREATE TABLE review_verdicts_widened (
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
      ALTER TABLE review_verdicts_widened RENAME TO review_verdicts`,
    verify: (db) => {
      const sql = tableSql(db, 'review_verdicts')
      // 表不存在 = 无事可做（不自动重建：库状态对不上任何已知历史路径时，运行时会响亮暴露）
      return sql === undefined || sql.includes("'comment'")
    },
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
    // 同一条回复只评一次：UNIQUE 索引兜底（调用方仍先查后写省 judge 调用）
    name: 'idx_eval_scores_message_id',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_eval_scores_message_id ON eval_scores(message_id)`,
  },
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
  // ── episode 评估（v2）────────────────────────────────
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
      delivery_message_id TEXT,
      FOREIGN KEY (episode_id) REFERENCES episodes(id)
    )`,
  },
  // ── 运行期全局设置 / 流程状态机 ───────────────────────
  {
    name: 'settings table (运行期全局设置)',
    sql: `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  },
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
  // ── 段三·记忆飞轮切片索引（chunks 三表）───────────────
  // chunks 是 **MD 的派生投影**（可无损重建）。表内**禁存任何扫描时间戳 / 运行态列**：
  // `scanned_at`/`updated_at`/`last_seen` 一落表，「删表 → 重扫 → 逐行等价」这条不变式
  // 必破（唯一例外 `date` 是 MD 里的历史事实，不是扫描时刻）。
  // 身份键 = (doc_path, section_anchor, content_hash)；`part_index`/`part_total` 是列、
  // 不进唯一键——它们是重扫时被覆盖的搬运工。
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
  {
    // 查询体过滤面：status 是节级硬排除维度
    name: 'idx_chunks_status',
    sql: `CREATE INDEX IF NOT EXISTS idx_chunks_status ON chunks(status)`,
  },
  {
    // 增量比对面：扫描器按 origin_id（= 扫描时 MD 的 git blob SHA）比对
    name: 'idx_chunks_origin',
    sql: `CREATE INDEX IF NOT EXISTS idx_chunks_origin ON chunks(origin_id)`,
  },
  {
    // ⚠️ vec0 写入侧地雷（本仓首次引入 vec0 时实测取证）：vec0 是虚拟表，**没有列的
    // INTEGER 亲和性**，PK 值必须原样以 SQLITE_INTEGER 抵达 xUpdate。better-sqlite3 把
    // JS number 一律按 REAL 绑定 ⇒ **显式写 chunk_id 必须传 BigInt**（`BigInt(chunkId)`）；
    // 让 SQLite 自增则不受影响。
    name: 'chunk_vectors table (sqlite-vec vec0)',
    sql: CHUNK_VECTORS_DDL,
  },
  {
    // 老库量纲校正（探针条目）：旧 L2 表 ⇒ 探针 false ⇒ 清三表 + 重建 cosine 表；
    // 全新库 / 已校正库 / 表不存在 ⇒ 探针 true ⇒ 跳过。详见序列处的注释。
    name: 'chunk_vectors distance_metric=cosine (量纲校正)',
    sql: CHUNK_VECTOR_METRIC_FIX_SEQUENCE.join(';\n'),
    verify: (db) => {
      const sql = tableSql(db, 'chunk_vectors')
      return sql === undefined || sql.includes('distance_metric=cosine')
    },
  },
  {
    // 关键词通道：content 列存 bigram 预分词串（空格 join，两侧对称），tokenize='unicode61'
    // 按空格切回 token（零中文分词器依赖）；rowid 映射 chunks.rowid，检索 JOIN 取原文
    name: 'chunks_fts table (FTS5 关键词通道)',
    sql: `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        content,
        tokenize='unicode61'
      )`,
  },
  // ── 段四·记忆检索流水（retrieval_* 三表）──────────────
  // 定位：**只采不改**。三表按粒度分层：一 event 含 N query，一 query 含 N candidate。
  // 冗余判据：凡事后无法可靠重算的值（阈值/参数快照、人类可读快照）一律冗余进表。
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
      truncated INTEGER,
      param_pool_n INTEGER
    )`,
  },
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
  {
    // ⚠️ 两处口径易写错：`distance` 纯关键词命中写 **NULL**（不写 maxDistance 哨兵）；
    // `chunk_id` 是**诊断专用探针**（回查「现在的 chunk_id 还是不是同一片」），
    // **绝不作 join 键**——身份一律走 (doc_path, section_anchor, content_hash)。
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
  {
    name: 'idx_retrieval_candidates_query',
    sql: `CREATE INDEX IF NOT EXISTS idx_retrieval_candidates_query
        ON retrieval_candidates(query_id)`,
  },
  {
    name: 'idx_retrieval_candidates_content_hash',
    sql: `CREATE INDEX IF NOT EXISTS idx_retrieval_candidates_hash
        ON retrieval_candidates(content_hash)`,
  },
  // ── 段五·执行时间轴（spans 两表）──────────────────────
  // 形态：**窄骨架 + 类型详情表**。三条形态纪律（逐条有据，别「顺手统一」）：
  // 不设 trace_id 列（链锚列名取 chain_id，避免同库两个 trace_id 语义）、不设 created_at
  // （start_at 就是时间轴）、start_at 取 ISO 毫秒 TEXT（全库时间列 100% TEXT）。
  {
    name: 'spans table (段五执行时间轴·骨架)',
    sql: `CREATE TABLE IF NOT EXISTS spans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      span_id TEXT NOT NULL UNIQUE,
      parent_span_id TEXT REFERENCES spans(span_id),
      chain_id TEXT,
      execution_id TEXT NOT NULL,
      session_id TEXT,
      agent_id TEXT,
      name TEXT NOT NULL,
      operation_name TEXT,
      start_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      error_type TEXT,
      error_message TEXT,
      item_count INTEGER
    )`,
  },
  {
    name: 'span_llm table (段五执行时间轴·LLM 详情)',
    sql: `CREATE TABLE IF NOT EXISTS span_llm (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      span_id TEXT NOT NULL UNIQUE REFERENCES spans(span_id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      ttft_ms INTEGER,
      stream INTEGER NOT NULL,
      max_tokens INTEGER
    )`,
  },
  {
    name: 'idx_spans_execution',
    sql: `CREATE INDEX IF NOT EXISTS idx_spans_execution ON spans(execution_id)`,
  },
  {
    name: 'idx_spans_chain',
    sql: `CREATE INDEX IF NOT EXISTS idx_spans_chain ON spans(chain_id)`,
  },
  {
    name: 'idx_spans_start',
    sql: `CREATE INDEX IF NOT EXISTS idx_spans_start ON spans(start_at)`,
  },
  {
    name: 'idx_spans_name',
    sql: `CREATE INDEX IF NOT EXISTS idx_spans_name ON spans(name)`,
  },
  // ── 旧链下线 ─────────────────────────────────────────
  {
    // ⚠️ **不可逆**：`chunks` 是 MD 的派生投影（可无损重建），`memories` 是**对话原话**
    // （没有源文件可重放，DROP 即永久丢失）。基线集里没有这两张表的 CREATE——全新库压根
    // 不会建出来；本条只为**老库**存在，由探针矫正：老库若仍留着两张死表 ⇒ 探针 false ⇒
    // 真删。表已不在 ⇒ 探针 true ⇒ 跳过（`DROP TABLE IF EXISTS` 对缺表本也是 no-op）。
    name: 'drop memories chain tables (票辛 旧链下线)',
    sql: `DROP TABLE IF EXISTS memories_fts;
          DROP TABLE IF EXISTS memories`,
    verify: (db) =>
      tableSql(db, 'memories') === undefined && tableSql(db, 'memories_fts') === undefined,
  },
]

// ─── 追加区（fix-forward）─────────────────────────────────────────────────
// **新迁移写在这里**，数组末尾往下追加，写完不许回头改（checksum 会拦）。
// 这些条目不带 `baseline` 标记 ⇒ runner 对老库也走增量路径**真执行**：
// 它们从未在任何老库上发生过，「没台账的老库」不构成跳过它们的理由。
// 若某条迁移的效果在个别库上已由手工 SQL 提前成立，给它挂 `verify` 探针（探针 true ⇒
// 只登记不执行），别用「老库」这个笼统判据去挡。

const APPENDED_MIGRATIONS: ReadonlyArray<Migration> = []

/**
 * runner 的唯一输入 = 基线集（盖 `baseline` 标记）+ 追加区（原样，不带标记）。
 *
 * 结构上就这么分：基线标记不靠逐条手写（41 条里漏一个就是一处静默跳过），而是由这个
 * 拼接点统一盖上——加进 `BASELINE_MIGRATIONS` 的必然是历史，加进 `APPENDED_MIGRATIONS`
 * 的必然走增量路径，没有第三种。
 */
export const MIGRATIONS: ReadonlyArray<Migration> = [
  ...BASELINE_MIGRATIONS.map((m): Migration => ({ ...m, baseline: true })),
  ...APPENDED_MIGRATIONS,
]
