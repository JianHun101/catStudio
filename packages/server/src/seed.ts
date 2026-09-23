/**
 * 种子数据：创建 4 只演示 Agent + 1 个演示会话。
 *
 * 默认 upsert 模式：按 agent name 去重，已存在则更新配置。
 * --reset 参数：先清空所有数据再重建。
 *
 * 覆盖语义（改这条语义请同时扫全仓复述它的文本——本文件 console/log 文案、
 * `AGENTS.md` 口径、`README`、`CONTRIBUTING.md`、`.env.example` 都复述过）：
 *   已存在的猫 → 仅同步 头像 / 系统提示词 / 技能模块 / 角色；
 *   运行配置（provider / model / base_url / effort）以 DB 为权威，seed 不覆盖；
 *   **llm_api_key 例外**：库里仍是占位符哨兵（从未配过 key）且本次 seed 值够格时补写
 *   ——空串 '' 是用户显式清空（停跑意图），永不补。
 *
 * 运行: node scripts/seed.js [--reset]
 *      pnpm seed [--reset]
 */
// env 必须在任何模块初始化之前加载（`seed` 是独立进程入口——`scripts/seed.js`
// spawn tsx 直接跑本文件，不经过 `index.ts`）。两件事都靠它：
// ① 不加载 = 整份 `.env` 无人解析 ⇒ `buildDemoAgents()` 拿到的 `DS_KEY` 是 undefined，
//    写库落成占位符（该函数在调用时才读 env，故承重的是「加载与否」而非加载位置）；
// ② 加载的**位置**也要紧——`db/index.ts` 在模块顶层读 `NODE_ENV` 选库名，`env.js`
//    排在它之后，`.env` 里写 `NODE_ENV` 就是白写。与 `src/index.ts` 的 `import './env.js'` 同理。
import './env.js'
import { initDb, getDb } from './db/index.js'
import {
  initRepository,
  agents as agentsRepo,
  sessions as sessionsRepo,
  messages as messagesRepo,
  executionLogs as execLogsRepo,
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
import { PLACEHOLDER_API_KEY } from './constants.js'

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
    // ⚠️ 原此处有「清空 memories」一步（注释：FK 依赖 agents，必须先删）
    // ——`memories` 表随段三接线下线（票辛 ⑥），该 FK 与这次清理一并消失
    agentsRepo.deleteAllAgents()
  }

  // ── Upsert agents ────────────────────────────────────

  const agents = buildDemoAgents()

  // 运行配置的差异可见性：已存在的猫，其运行配置由 DB 权威持有（upsertAgent 的
  // ON CONFLICT 不更新 llm_*）——静默会让用户误以为「改了 .env 就生效」，正是踩过的坑。
  // 这里只收集**猫名**，循环结束后统一 warn 一次。
  // 安全红线：warn 只输出猫名——不得打印 key 的明文 / 前缀 / 长度 / hash 或任何可推断值。
  const keyMismatchNames: string[] = []

  for (const a of agents) {
    // upsert 之前先读既有行，才能看到「本次不会写进去的那个值」与库里的差异。
    // 自愈例外：库中为占位符哨兵 + 本次值够格 ⇒ upsertAgent 会补写，不算「不覆盖」差异。
    // 少了这个排除，会对一行**即将被修好**的数据警告「seed 不会覆盖」= 假话。
    const existing = agentsRepo.getAgentByName(a.name)
    if (existing && existing.llm_api_key !== a.llmApiKey) {
      const willHeal =
        existing.llm_api_key === PLACEHOLDER_API_KEY && agentsRepo.isHealableApiKey(a.llmApiKey)
      if (!willHeal) keyMismatchNames.push(a.name)
    }

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

  // 常驻说明（每次 seed 都打，不依赖是否真有差异）：说清 upsert 到底同步了什么
  console.log(
    '  ℹ️ 已存在的猫仅同步 头像 / 系统提示词 / 技能模块 / 角色；' +
      '运行配置（供应商 / 模型 / API Key / base_url / effort）以数据库为准，seed 不覆盖' +
      '——唯一例外：API Key 仍是未配置占位符时，会被本次 seed 的真 key 补写'
  )

  if (keyMismatchNames.length > 0) {
    log.warn(
      '以下猫的数据库 API Key 与本次 seed 值不同，seed 不会覆盖——' +
        '要同步请在界面的 agent 设置里改，或用 pnpm seed --reset 重建：' +
        keyMismatchNames.join('、')
    )
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
