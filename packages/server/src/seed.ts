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
import {
  initRepository,
  agents as agentsRepo,
  sessions as sessionsRepo,
  messages as messagesRepo,
  executionLogs as execLogsRepo,
  memories as memoriesRepo,
} from './db/repository/index.js'
import { buildDemoAgents, DEMO_SESSION_ID, DEMO_SESSION_TITLE } from './seed-data.js'

function seed(): void {
  const isReset = process.argv.includes('--reset')

  initDb()
  initRepository(getDb())

  if (isReset) {
    console.log('🔄 --reset: 清空所有数据…')
    console.log(
      '   ⚠️ 清库重建将恢复 seed 默认运行配置（llm_provider/model/api_key/base_url/effort）——运行中直改 DB 的配置会被 seed 默认值覆盖'
    )
    messagesRepo.deleteAllMessages()
    execLogsRepo.deleteAllExecutionLogs()
    sessionsRepo.deleteAllSessions()
    memoriesRepo.deleteAllMemories() // FK 依赖 agents，必须在 deleteAllAgents 之前
    agentsRepo.deleteAllAgents()
  }

  // ── Upsert agents ────────────────────────────────────

  const agents = buildDemoAgents()

  for (const a of agents) {
    const result = agentsRepo.upsertAgent(
      a.id,
      a.name,
      a.avatar,
      a.systemPrompt,
      a.llmProvider,
      a.llmModel,
      a.llmApiKey,
      a.llmBaseUrl,
      a.effortLevel ?? '',
      JSON.stringify(a.skillModules ?? []),
      a.role ?? 'unknown'
    )
    const verb = result.changes === 1 ? '✅' : '🔄'
    console.log(`  ${verb} ${a.avatar} ${a.name} (${a.id})`)
  }

  // ── Upsert demo session ──────────────────────────────

  const agentIds = JSON.stringify(agents.map((a) => a.id))

  const sResult = sessionsRepo.upsertDemoSession(DEMO_SESSION_ID, DEMO_SESSION_TITLE, agentIds)
  const sVerb = sResult.changes === 1 ? '✅' : '🔄'
  console.log(`  ${sVerb} Session: ${DEMO_SESSION_TITLE} (${DEMO_SESSION_ID})`)

  console.log('\n🌱 Seed complete!')
}

seed()
