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
  knowledge as knowledgeRepo,
} from './db/repository/index.js'
import {
  buildDemoAgents,
  buildDemoKnowledge,
  DEMO_SESSION_ID,
  DEMO_SESSION_TITLE,
} from './seed-data.js'
import { embedText } from './memory/embedding.js'
import { vectorToBlob } from './memory/index.js'
import { writeIronLaws } from './config/iron-laws.js'
import { IRON_LAWS_CODER, IRON_LAWS_REVIEWER } from './seed-data.js'
import { createLogger } from './logger.js'

const log = createLogger('seed')

async function seed(): Promise<void> {
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
      // skill_modules 列保留兼容（历史数据），种子数据不再声明技能——注入链已拆除
      '[]',
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

  // ── Upsert 知识文档（知识库 Phase 1）──────────────────
  // 嵌入走 await embedText（首次触发 sidecar 冷启动 + ~100MB 模型下载）；
  // 嵌入不可用（返回带 reason 的失败 / 空向量）→ embedding 存 NULL + warn，
  // 不阻塞 seed 主流程（重跑幂等补齐）。embedText 不再抛错。
  const knowledgeDocs = buildDemoKnowledge()

  for (const doc of knowledgeDocs) {
    let embedding: Buffer | null = null
    const embedded = await embedText(doc.content)
    if (embedded.ok && embedded.vector.length > 0) {
      embedding = vectorToBlob(embedded.vector)
    } else if (!embedded.ok) {
      log.warn('知识文档嵌入不可用，embedding 存 NULL', { docId: doc.id, reason: embedded.reason })
    }
    if (!embedding) {
      console.log(`  ⚠️ ${doc.id} 嵌入失败，embedding 存 NULL（重跑幂等补齐）`)
    }
    const kResult = knowledgeRepo.upsertKnowledge(
      doc.id,
      doc.content,
      embedding,
      doc.source,
      doc.tags
    )
    const kVerb = kResult.changes === 1 ? '✅' : '🔄'
    console.log(`  ${kVerb} Knowledge: ${doc.id} (${doc.source})${embedding ? '' : ' [无嵌入]'}`)
  }

  // ── Sync 铁律 → settings（writeIronLaws 运行期生效）────────────────
  // 铁律是全局运营策略：代码常量（seed-data.ts）是规范源，但运行期注入读的是
  // settings 表（settings 优先、常量兜底）——只改常量对已存在 settings 行的现役
  // 库不生效。seed（含 --reset 重建）是显式治理动作，把常量规范写入 settings，
  // 让「输出结构」等新增契约下一轮回复立即对现役猫生效（无需重启 server）。
  // 显式跑 seed 会覆盖 UI 上的铁律自定义（全局治理以代码常量为规范源，行为预期内）
  writeIronLaws(IRON_LAWS_CODER.trim(), IRON_LAWS_REVIEWER.trim())
  console.log('  🧭 Iron laws synced to settings (writeIronLaws)')

  console.log('\n🌱 Seed complete!')
}

seed().catch((err) => {
  console.error('🌱 Seed failed:', err)
  process.exit(1)
})
