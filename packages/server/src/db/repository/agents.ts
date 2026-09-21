/**
 * Agent 表查询函数。
 */
import type Database from 'better-sqlite3'
import { purgeAgentDependents } from './dependents.js'
import { PLACEHOLDER_API_KEY } from '../../constants.js'
import type { AgentRow } from './types.js'

let db: Database.Database

export function setRepoDb(dbInst: Database.Database): void {
  db = dbInst
}

// ─── 查询 ──────────────────────────────────────────────

export function getAgentById(id: string): AgentRow | undefined {
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined
}

export function getAgentByName(name: string): AgentRow | undefined {
  return db.prepare('SELECT * FROM agents WHERE name = ?').get(name) as AgentRow | undefined
}

export function getAgentNameById(id: string): string | undefined {
  const row = db.prepare('SELECT name FROM agents WHERE id = ?').get(id) as
    { name: string } | undefined
  return row?.name
}

export function agentExists(id: string): boolean {
  const row = db.prepare('SELECT id FROM agents WHERE id = ?').get(id)
  return !!row
}

export function listAgentsByIds(ids: string[]): AgentRow[] {
  const placeholders = ids.map(() => '?').join(',')
  return db.prepare(`SELECT * FROM agents WHERE id IN (${placeholders})`).all(...ids) as AgentRow[]
}

export function checkAgentIdsExist(ids: string[]): string[] {
  const placeholders = ids.map(() => '?').join(',')
  return (
    db.prepare(`SELECT id FROM agents WHERE id IN (${placeholders})`).all(...ids) as {
      id: string
    }[]
  ).map((r) => r.id)
}

export function listAllAgents(): AgentRow[] {
  return db.prepare('SELECT * FROM agents ORDER BY created_at ASC').all() as AgentRow[]
}

export function countAgents(): number {
  return (db.prepare('SELECT COUNT(*) as cnt FROM agents').get() as { cnt: number }).cnt
}

// ─── 写入 ──────────────────────────────────────────────

export function insertAgent(
  id: string,
  name: string,
  avatar: string,
  systemPrompt: string,
  llmProvider: string,
  llmModel: string,
  llmApiKey: string,
  llmBaseUrl: string | null,
  effortLevel: string | null,
  skillModules: string | null = null,
  llmMaxTokens: number | null = null,
  llmTemperature: number | null = null,
  llmEnvExtra: string | null = null
): void {
  db.prepare(
    `
    INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, llm_base_url, effort_level, skill_modules, llm_max_tokens, llm_temperature, llm_env_extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    id,
    name,
    avatar,
    systemPrompt,
    llmProvider,
    llmModel,
    llmApiKey,
    llmBaseUrl,
    effortLevel ?? 'high', // 与 DB 列 DEFAULT 'high' 对齐；INSERT 显式含该列时 SQLite 不会触发 DEFAULT，null 会直接违反 NOT NULL
    skillModules ?? '[]',
    llmMaxTokens ?? 2048, // 与 DB 列 DEFAULT 2048 对齐（同上：显式含列不触发 DEFAULT）
    llmTemperature ?? 0.7, // 与 DB 列 DEFAULT 0.7 对齐
    llmEnvExtra ?? '{}' // 与 DB 列 DEFAULT '{}' 对齐（同上）
  )
}

/**
 * 这条值是否够格作为 **llm_api_key 自愈的目标值**：非空、且不是占位符哨兵。
 *
 * 两个方向都由本谓词统一定义（`upsertAgent` 的条件补写与 `healPlaceholderApiKeys`
 * 共用，勿各写各的）：
 *   - 空串 `''` = 用户**显式清空**（主库 luna猫 即此态 = 停跑意图）⇒ 不够格，绝不自愈
 *   - 占位符哨兵 = 本次 seed 自己也没拿到真 key ⇒ 不够格，补了等于没补
 *
 * 注意方向：本谓词判的是**新值**；是否补写还要另判**旧值**恰为哨兵（见 `healPlaceholderApiKeys`
 * 的 WHERE 与 `upsertAgent` 的 CASE）。
 */
export function isHealableApiKey(value: string): boolean {
  return value !== '' && value !== PLACEHOLDER_API_KEY
}

export function upsertAgent(
  id: string,
  name: string,
  avatar: string,
  systemPrompt: string,
  llmProvider: string,
  llmModel: string,
  llmApiKey: string,
  llmBaseUrl: string,
  effortLevel: string,
  skillModules: string | null = null,
  role: string = 'unknown'
): { changes: number } {
  return db
    .prepare(
      `
    INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, llm_base_url, effort_level, skill_modules, role)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      avatar = excluded.avatar,
      system_prompt = excluded.system_prompt,
      -- 运行配置（llm_provider / llm_model / llm_base_url / effort_level）仅首次初始化写入，
      -- UPDATE 不覆盖：DB 是运行配置的权威（用户直改库永久有效），seed 重跑不得把 5 猫
      -- 运行配置覆盖回 seed 默认值。
      -- 唯一例外 = llm_api_key 的**占位符自愈**：库里仍是占位符哨兵（= 从未配过 key，
      -- 见 constants.ts 语义）且本次 seed 值够格（isHealableApiKey）时补写。
      -- 成立场景：无 DS_KEY 的首次启动写了哨兵 → 之后配好 key 重启，表已非空故
      -- index.ts 不再走 seed 块 —— 本分支让「重跑 seed」这条路径也能补上。
      -- 绑定参数顺序：问号按**文本出现顺序**绑定，而 ON CONFLICT 段在 VALUES 之后
      -- ⇒ 这两个 ? 排在 11 个 VALUES 参数**之后**（放在前面会把 healFlag 绑到 id 列，
      -- 且 SQLite 动态类型不报错——静默错位）。
      llm_api_key = CASE
        WHEN ? = 1 AND agents.llm_api_key = ?
        THEN excluded.llm_api_key
        ELSE agents.llm_api_key
      END,
      skill_modules = excluded.skill_modules,
      role = excluded.role,
      updated_at = datetime('now')
  `
    )
    .run(
      id,
      name,
      avatar,
      systemPrompt,
      llmProvider,
      llmModel,
      llmApiKey,
      llmBaseUrl,
      effortLevel,
      skillModules ?? '[]',
      role,
      // ↓ ON CONFLICT 段（文本在 VALUES 之后）的两个 ?：(healFlag, 占位符哨兵)
      isHealableApiKey(llmApiKey) ? 1 : 0,
      PLACEHOLDER_API_KEY
    ) as { changes: number }
}

/** `healPlaceholderApiKeys` 的入参条目：seed 定义的角色名 + 本次可用的 key 值 */
export interface PlaceholderHealEntry {
  name: string
  llmApiKey: string
}

/**
 * 占位符 API Key 自愈：把库里 `llm_api_key` 仍是占位符哨兵的行，补写成**本次**可用的真值。
 *
 * 与 `upsertAgent` 的分工：那条走 upsert（`ON CONFLICT`）且只在 seed 链上；
 * 本函数是**纯 UPDATE**，供 server 启动路径（`index.ts`）独立调用 —— 那条路径
 * 表已非空、根本不进 seed 块，但「无 key 首启写了哨兵 → 之后配好 key」的库同样要能补上。
 *
 * 判据（两侧都收口在 SQL 的 WHERE 里，不做读-改-写，故并发下不会误伤）：
 *   - 旧值 `= PLACEHOLDER_API_KEY`（只有哨兵才补；空串 `''` 是用户停跑意图，不补；
 *     真 key 更不补）
 *   - 新值过 `isHealableApiKey`（空串 / 哨兵一律在进 SQL 前就被滤掉）
 *
 * @param entries seed 定义的角色条目（`buildDemoAgents()` 投影即可）
 * @returns 实际补写的行数（0 = 无需补）
 */
export function healPlaceholderApiKeys(entries: PlaceholderHealEntry[]): number {
  const healable = entries.filter((e) => isHealableApiKey(e.llmApiKey))
  if (healable.length === 0) return 0

  // 键用 name：与 upsertAgent 的冲突键同源（seed 定义的「角色」身份），
  // 且 seed 的 id 本就是 fixedId(name)，两者一一对应。
  const stmt = db.prepare(
    `UPDATE agents SET llm_api_key = ?, updated_at = datetime('now')
     WHERE name = ? AND llm_api_key = ?`
  )

  let healed = 0
  db.transaction(() => {
    for (const e of healable) {
      healed += stmt.run(e.llmApiKey, e.name, PLACEHOLDER_API_KEY).changes
    }
  })()

  return healed
}

export function updateAgent(id: string, setClauses: string, values: any[]): void {
  db.prepare(`UPDATE agents SET ${setClauses}, updated_at = datetime('now') WHERE id = ?`).run(
    ...values,
    id
  )
}

// ↓ 删猫前先清引用它的审查结论（票 6：reviewer/subject 两条 FK 全 RESTRICT）。
//   过渡语义与「票 8 的 409 契约」的关系见 `dependents.ts::purgeAgentDependents`。

export function deleteAgentById(id: string): void {
  purgeAgentDependents({ kind: 'id', agentId: id })
  db.prepare('DELETE FROM agents WHERE id = ?').run(id)
}

export function deleteAllAgents(): void {
  purgeAgentDependents({ kind: 'all' })
  db.exec('DELETE FROM agents')
}
