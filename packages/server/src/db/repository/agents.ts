/**
 * Agent 表查询函数。
 */
import type Database from 'better-sqlite3'
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
  effortLevel: string | null
): void {
  db.prepare(
    `
    INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, llm_base_url, effort_level)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run(id, name, avatar, systemPrompt, llmProvider, llmModel, llmApiKey, llmBaseUrl, effortLevel)
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
  effortLevel: string
): { changes: number } {
  return db
    .prepare(
      `
    INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, llm_base_url, effort_level)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      avatar = excluded.avatar,
      system_prompt = excluded.system_prompt,
      llm_provider = excluded.llm_provider,
      llm_model = excluded.llm_model,
      llm_api_key = excluded.llm_api_key,
      llm_base_url = excluded.llm_base_url,
      effort_level = excluded.effort_level,
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
      effortLevel
    ) as { changes: number }
}

export function updateAgent(id: string, setClauses: string, values: any[]): void {
  db.prepare(`UPDATE agents SET ${setClauses}, updated_at = datetime('now') WHERE id = ?`).run(
    ...values,
    id
  )
}

export function deleteAgentById(id: string): void {
  db.prepare('DELETE FROM agents WHERE id = ?').run(id)
}

export function deleteAllAgents(): void {
  db.exec('DELETE FROM agents')
}
