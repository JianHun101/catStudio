/**
 * 种子数据：创建 3 只演示 Agent + 1 个演示会话。
 *
 * 默认 upsert 模式：按 agent name 去重，已存在则更新配置。
 * --reset 参数：先清空所有数据再重建。
 *
 * 运行: node scripts/seed.js [--reset]
 *      pnpm seed [--reset]
 */
import { initDb, getDb } from './db/index.js'
import { buildDemoAgents, DEMO_SESSION_ID, DEMO_SESSION_TITLE } from './seed-data.js'

function seed(): void {
  const isReset = process.argv.includes('--reset')

  initDb()
  const db = getDb()

  if (isReset) {
    console.log('🔄 --reset: 清空所有数据…')
    db.exec('DELETE FROM messages')
    db.exec('DELETE FROM execution_logs')
    db.exec('DELETE FROM sessions')
    db.exec('DELETE FROM agents')
  }

  // ── Upsert agents ────────────────────────────────────

  const upsert = db.prepare(`
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
  `)

  const agents = buildDemoAgents()

  for (const a of agents) {
    const result = upsert.run(
      a.id, a.name, a.avatar, a.systemPrompt,
      a.llmProvider, a.llmModel, a.llmApiKey, a.llmBaseUrl,
      a.effortLevel || null,
    )
    const verb = result.changes === 1 ? '✅' : '🔄'
    console.log(`  ${verb} ${a.avatar} ${a.name} (${a.id})`)
  }

  // ── Upsert demo session ──────────────────────────────

  const agentIds = JSON.stringify(agents.map((a) => a.id))

  const sessionUpsert = db.prepare(`
    INSERT INTO sessions (id, title, agent_ids)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      agent_ids = excluded.agent_ids,
      updated_at = datetime('now')
  `)

  const sResult = sessionUpsert.run(DEMO_SESSION_ID, DEMO_SESSION_TITLE, agentIds)
  const sVerb = sResult.changes === 1 ? '✅' : '🔄'
  console.log(`  ${sVerb} Session: ${DEMO_SESSION_TITLE} (${DEMO_SESSION_ID})`)

  console.log('\n🌱 Seed complete!')
}

seed()
