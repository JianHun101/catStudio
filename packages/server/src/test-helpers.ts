/**
 * 共享测试工具。
 *
 * - 创建内存 SQLite 数据库（含完整 schema）
 * - Fastify 测试应用构建
 * - 起 stub 服务时的**端口分配**（避开 WHATWG Fetch 禁用端口黑名单，见 `listenFetchable`）
 * - 测试隔离目录的绝对路径派生（见 `isolatedTestDir`）
 */
import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'
import type { FastifyInstance } from 'fastify'
import Fastify from 'fastify'
import { createHash } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本包根目录（`packages/server`）——隔离目录的派生键。`resolve` 抹掉尾部分隔符，与 vitest 配置的 `__dirname` 同形。 */
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/**
 * 测试隔离根：`os.tmpdir()` 下按**本包目录绝对路径**派生的独立子目录。
 *
 * 为什么必须绝对、且必须带仓库键：worktree 的 `node_modules` 是指向主仓库的 junction，
 * 于是任何相对路径（`node_modules/.cache/xxx`）或 cwd 派生路径，在主仓库、本会话
 * worktree、以及将来一猫一 worktree 的各根里，**解析到同一批物理文件**。两进程并发跑
 * 同一批用例时，A 的 `afterEach` 删掉 B 刚 `existsSync` 过的那一个文件 ⇒ 假红。
 * 派生键取「这是哪个仓库」，故主仓库与各 worktree 各得一份，互不可见。
 *
 * 为什么不是 `process.cwd()`：`pnpm test` / `pnpm test:server` / `--root` 三种调用下
 * cwd 不同，分叉时**静默**（两处算同一个哈希 ⇒ 隔离凭空失效）。派生键要钉在「哪个仓库」
 * 上，不是「从哪儿敲的命令」。
 *
 * 同一派生公式在 `packages/server/vitest.config.ts` 复写一份（配置面不能 import 本文件——
 * 会把 better-sqlite3 / sqlite-vec 拖进配置加载期）。
 */
const ISOLATION_ROOT = resolve(
  tmpdir(),
  'cat-study-test-isolation',
  createHash('sha1').update(PACKAGE_ROOT).digest('hex').slice(0, 12)
)

/**
 * 取一个隔离目录的**绝对路径**（离开仓库，见 `ISOLATION_ROOT`）。
 *
 * 调用方把它交给 `vi.stubEnv('RESTART_FILES_DIR', …)` / 配置 `test.env` —— 被测模块
 * 内部是 `resolve(env ?? process.cwd(), '<后缀>')`，喂绝对路径即可短路掉 cwd 那一层。
 * `name` 保持各处原有的末段（`restart-test-create` / `restart-test-shutdown` / …）：
 * 同根内不同用例组各占一段，跨根由 `ISOLATION_ROOT` 的仓库键分开。
 */
export function isolatedTestDir(name: string): string {
  return resolve(ISOLATION_ROOT, name)
}

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
    llm_max_tokens INTEGER NOT NULL DEFAULT 2048,
    llm_temperature REAL NOT NULL DEFAULT 0.7,
    llm_env_extra TEXT NOT NULL DEFAULT '{}',
    skill_modules TEXT NOT NULL DEFAULT '[]',
    role TEXT NOT NULL DEFAULT 'unknown',
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
    compressed_summaries TEXT,
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
    thinking_content TEXT,
    tool_content TEXT,
    segments TEXT,
    dispatch_state TEXT DEFAULT NULL,
    extra TEXT DEFAULT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session
    ON messages(session_id, created_at);

  -- ⚠️ memories 表不在此列：该表已随段三接线下线（票辛 ⑥ 双 DROP）。
  -- 测试 schema 必须与生产 schema 同面——留着它会让「表已不存在」的判据
  -- （W1）在测试里恒假绿，也会让测试看不出调用方还挂着旧链。

  CREATE TABLE IF NOT EXISTS knowledge (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    embedding BLOB,
    source TEXT,
    tags TEXT,
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

  CREATE TABLE IF NOT EXISTS eval_scores (
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

  CREATE TABLE IF NOT EXISTS user_feedback (
    id TEXT PRIMARY KEY,
    eval_score_id TEXT NOT NULL UNIQUE,
    message_id TEXT,
    session_id TEXT,
    user_score REAL NOT NULL,
    comment TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS review_verdicts (
    message_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    reviewer_agent_id TEXT NOT NULL,
    subject_agent_id TEXT,
    verdict TEXT NOT NULL CHECK (verdict IN ('approve', 'comment', 'suggest', 'reject')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS review_parse_failures (
    message_id TEXT PRIMARY KEY,
    reason TEXT NOT NULL CHECK (reason IN ('no_subject', 'bad_verdict')),
    raw TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS episodes (
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
  );

  CREATE TABLE IF NOT EXISTS episode_attributions (
    id TEXT PRIMARY KEY,
    episode_id TEXT NOT NULL UNIQUE,
    outcome TEXT NOT NULL,
    root_cause TEXT,
    action_type TEXT NOT NULL CHECK (action_type IN ('investigation', 'harness_fix', 'replay', 'improvement')),
    action_detail TEXT,
    status TEXT NOT NULL DEFAULT 'dispatched' CHECK (status IN ('dispatched', 'resolved')),
    delivery_message_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (episode_id) REFERENCES episodes(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS flow_states (
    session_id TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    state TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (session_id, commit_sha)
  );

  CREATE TABLE IF NOT EXISTS flow_state_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    from_state TEXT,
    to_state TEXT NOT NULL,
    intent TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

/** `listenFetchable` 的重取上限 —— 单次命中黑名单概率约 15/13977，8 次已是天文安全裕度 */
const LISTEN_ATTEMPTS = 8

/**
 * 服务已在监听时，判断该端口能否被 `fetch` **触达**。
 *
 * 判据必须是 fetch 本身（而不是「端口在听」）：实测同一端口可以 `TCP CONNECT-OK`
 * 而 `fetch` 报 `bad port` —— 两个谓词不同面。任何异常（含 `ECONNREFUSED`，
 * 表示端口没被拒、只是没人听）都算「不可触达」，由调用方决定怎么处置。
 */
export async function isFetchReachable(host: string, port: number): Promise<boolean> {
  try {
    await fetch(`http://${host}:${port}/`)
    return true
  } catch {
    return false
  }
}

/**
 * 让 `server` 监听一个 **fetch 可触达**的端口，返回实际端口。
 *
 * 为什么不能只用 `listen(0)`：OS 分配的端口可能落在 **WHATWG Fetch 禁用端口黑名单**
 * （1719 / 1720 / 1723 / 3659 / 4045 / 4190 / 5060 / 6000 / 6566 / 6665–6669 / 10080 …）。
 * 这类端口上服务**真的在监听**（裸 TCP 连得通、`listening:true`），但 undici 的 `fetch`
 * 在发请求**之前**就拒（`cause = "bad port"`），且**永不恢复** ⇒ 客户端探活吃满超时预算
 * ⇒ 测试撞穿 harness 预算（`Test timed out`）。本机动态端口池是 1024–15000
 * （`netsh int ipv4 show dynamicport tcp`），与黑名单**有交叠**，故命中概率非零。
 *
 * 此处**不比对硬编码黑名单**——那份表随 undici 版本漂移，抄一份就是下一次静默复发；
 * 改为**真的 fetch 一次**，与消费方同面。命中即可换端口重来。
 */
export async function listenFetchable(server: Server, host = '127.0.0.1'): Promise<number> {
  return withFetchablePort(
    () =>
      new Promise<number>((resolve) => {
        server.listen(0, host, () => resolve((server.address() as AddressInfo).port))
      }),
    // 换端口前必须真的关掉：同一个 Server 实例可 close 后重新 listen，
    // 但不关就再 listen 会 EADDRINUSE。
    () => closeServer(server),
    (port) => isFetchReachable(host, port)
  )
}

/**
 * 「分配 → 校验 → 命中则重取」循环。判据（`probe`）与副作用（`bind`/`unbind`）都从外面传：
 * **重取分支在真机上要 OS 恰好分到黑名单端口才走得到**（约 15/13977），注入替身才能把它
 * 钉进单测——否则这条分支的「写了但从不执行」与「压根没写」在判据上无法区分。
 */
export async function withFetchablePort(
  bind: () => Promise<number>,
  unbind: () => Promise<void>,
  probe: (port: number) => Promise<boolean>,
  attempts = LISTEN_ATTEMPTS
): Promise<number> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const port = await bind()
    if (await probe(port)) return port
    await unbind()
  }
  throw new Error(
    `withFetchablePort: 连续 ${attempts} 次分配到的端口都不可被 fetch 触达` +
      `（WHATWG 禁用端口黑名单？）——端口池配置可能异常，见 listenFetchable 注释`
  )
}

/** 关掉 server，并**强制断开**已有连接（含 fetch keep-alive 池里的空闲 socket，否则 close 回调可能一直等） */
export async function closeServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()))
  server.closeAllConnections()
  await closed
}
