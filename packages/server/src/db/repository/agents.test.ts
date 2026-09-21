/**
 * Agents repo upsertAgent 运行配置覆盖语义测试。
 *
 * 根治 seed 覆盖 DB key（docs/sessions/cat-study-handoff-review-loop-fix-summary.md:104 预登记）：
 * - UPDATE 分支不覆盖 llm_provider/model/base_url/effort_level（DB 是运行配置权威）
 * - llm_api_key 同受保护，**唯一例外**是「库中为占位符哨兵 + 本次 seed 值够格」时的
 *   自愈补写（= 从未配过 key 的库，配好后补上；空串 '' 是用户停跑意图，不在此列）
 * - INSERT 分支保留写入默认（首次初始化行为）
 * - 团队定义字段（system_prompt/avatar/role/skill_modules）仍由 seed 同步（prompt 更新链路保留）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb } from '../../test-helpers.js'
import { setDb, resetDb, getDb } from '../index.js'
import { initRepository } from './index.js'
import { agents as agentsRepo } from './index.js'
import { PLACEHOLDER_API_KEY } from '../../constants.js'

const SEED_ARGS = {
  id: 'agent-seed-1',
  name: 'ds猫',
  avatar: '🐱',
  systemPrompt: 'seed prompt v1',
  llmProvider: 'deepseek',
  llmModel: 'deepseek-v4-pro',
  llmApiKey: 'sk-seed-key',
  llmBaseUrl: '',
  effortLevel: 'high',
  skillModules: '["a"]',
  role: 'implementer',
}

describe('upsertAgent 运行配置覆盖语义', () => {
  beforeEach(() => {
    setDb(createTestDb())
    initRepository(getDb())
  })

  afterEach(() => {
    resetDb()
  })

  it('已有 agent 跑 upsert → llm_* 不被覆盖（DB 是运行配置权威）', () => {
    // 首次 INSERT：seed 默认配置写入
    agentsRepo.upsertAgent(
      SEED_ARGS.id,
      SEED_ARGS.name,
      SEED_ARGS.avatar,
      SEED_ARGS.systemPrompt,
      SEED_ARGS.llmProvider,
      SEED_ARGS.llmModel,
      SEED_ARGS.llmApiKey,
      SEED_ARGS.llmBaseUrl,
      SEED_ARGS.effortLevel,
      SEED_ARGS.skillModules,
      SEED_ARGS.role
    )

    // 模拟用户直改 DB 运行配置（key 换成真实 key、模型/提供方都换掉）
    getDb()
      .prepare(
        "UPDATE agents SET llm_api_key = 'sk-db-key', llm_model = 'custom-model', llm_provider = 'ollama', llm_base_url = 'http://127.0.0.1:11434', effort_level = 'low' WHERE id = ?"
      )
      .run(SEED_ARGS.id)

    // 重跑 seed（同 name，seed 值可能已变）
    agentsRepo.upsertAgent(
      SEED_ARGS.id,
      SEED_ARGS.name,
      SEED_ARGS.avatar,
      'seed prompt v2',
      'deepseek',
      'deepseek-v4-flash',
      'sk-seed-key-2',
      '',
      'high',
      '["b"]',
      'implementer'
    )

    const row = agentsRepo.getAgentById(SEED_ARGS.id)!
    expect(row.llm_api_key).toBe('sk-db-key') // 不被 seed 覆盖
    expect(row.llm_model).toBe('custom-model')
    expect(row.llm_provider).toBe('ollama')
    expect(row.llm_base_url).toBe('http://127.0.0.1:11434')
    expect(row.effort_level).toBe('low')
  })

  it('新库首跑 → INSERT 写入 seed 默认配置', () => {
    agentsRepo.upsertAgent(
      SEED_ARGS.id,
      SEED_ARGS.name,
      SEED_ARGS.avatar,
      SEED_ARGS.systemPrompt,
      SEED_ARGS.llmProvider,
      SEED_ARGS.llmModel,
      SEED_ARGS.llmApiKey,
      SEED_ARGS.llmBaseUrl,
      SEED_ARGS.effortLevel,
      SEED_ARGS.skillModules,
      SEED_ARGS.role
    )

    const row = agentsRepo.getAgentById(SEED_ARGS.id)!
    expect(row.llm_api_key).toBe('sk-seed-key')
    expect(row.llm_model).toBe('deepseek-v4-pro')
    expect(row.llm_provider).toBe('deepseek')
    expect(row.effort_level).toBe('high')
  })

  it('团队定义字段仍由 seed 同步（prompt 更新链路回归）', () => {
    agentsRepo.upsertAgent(
      SEED_ARGS.id,
      SEED_ARGS.name,
      '🐱',
      'seed prompt v1',
      SEED_ARGS.llmProvider,
      SEED_ARGS.llmModel,
      SEED_ARGS.llmApiKey,
      SEED_ARGS.llmBaseUrl,
      SEED_ARGS.effortLevel,
      '["a"]',
      'implementer'
    )

    // 改 prompt 重跑 seed → 团队字段更新、运行配置保持
    agentsRepo.upsertAgent(
      SEED_ARGS.id,
      SEED_ARGS.name,
      '🐈',
      'seed prompt v2（收口链指令）',
      SEED_ARGS.llmProvider,
      SEED_ARGS.llmModel,
      SEED_ARGS.llmApiKey,
      SEED_ARGS.llmBaseUrl,
      SEED_ARGS.effortLevel,
      '["b"]',
      'store'
    )

    const row = agentsRepo.getAgentById(SEED_ARGS.id)!
    expect(row.system_prompt).toBe('seed prompt v2（收口链指令）')
    expect(row.avatar).toBe('🐈')
    expect(row.role).toBe('store')
    expect(row.skill_modules).toBe('["b"]')
    expect(row.llm_api_key).toBe(SEED_ARGS.llmApiKey) // 运行配置保持
  })
})

describe('llm_max_tokens / llm_temperature 列默认回填', () => {
  beforeEach(() => {
    setDb(createTestDb())
    initRepository(getDb())
  })

  afterEach(() => {
    resetDb()
  })

  it('迁移前存量行（INSERT 不带两列）→ 读回 2048/0.7（DEFAULT 回填，读侧零 COALESCE）', () => {
    // 模拟迁移前创建的 agent：SQL 直接 INSERT 不含 llm_max_tokens/llm_temperature
    getDb()
      .prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run('agent-legacy', '老猫', '🐱', 'prompt', 'deepseek', 'deepseek-v4-pro', 'sk-old')

    const row = agentsRepo.getAgentById('agent-legacy')!
    expect(row.llm_max_tokens).toBe(2048)
    expect(row.llm_temperature).toBe(0.7)
  })

  it('insertAgent 不带新参数 → 落库 2048/0.7（repository 兜底，与 DB DEFAULT 对齐）', () => {
    agentsRepo.insertAgent(
      'agent-new',
      '新猫',
      '🐱',
      'prompt',
      'deepseek',
      'deepseek-v4-pro',
      'sk-test',
      null,
      'high'
    )
    const row = agentsRepo.getAgentById('agent-new')!
    expect(row.llm_max_tokens).toBe(2048)
    expect(row.llm_temperature).toBe(0.7)
  })

  it('insertAgent 带显式配置 → 落库一致', () => {
    agentsRepo.insertAgent(
      'agent-cfg',
      '配置猫',
      '🐱',
      'prompt',
      'deepseek',
      'deepseek-v4-pro',
      'sk-test',
      null,
      'high',
      null,
      4096,
      1.2
    )
    const row = agentsRepo.getAgentById('agent-cfg')!
    expect(row.llm_max_tokens).toBe(4096)
    expect(row.llm_temperature).toBe(1.2)
  })
})

describe('llm_env_extra 列默认回填（per-agent 额外环境变量）', () => {
  beforeEach(() => {
    setDb(createTestDb())
    initRepository(getDb())
  })

  afterEach(() => {
    resetDb()
  })

  it('迁移前存量行（INSERT 不带该列）→ 读回 {}（DEFAULT 回填，读侧零 COALESCE）', () => {
    getDb()
      .prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run('agent-legacy-env', '老猫', '🐱', 'prompt', 'opencode', 'openai/gpt-5', '')

    const row = agentsRepo.getAgentById('agent-legacy-env')!
    expect(row.llm_env_extra).toBe('{}')
  })

  it('insertAgent 不带新参数 → 落库 {}（repository 兜底，与 DB DEFAULT 对齐）', () => {
    agentsRepo.insertAgent(
      'agent-new-env',
      '新猫',
      '🐱',
      'prompt',
      'opencode',
      'openai/gpt-5',
      '',
      null,
      'high'
    )
    const row = agentsRepo.getAgentById('agent-new-env')!
    expect(row.llm_env_extra).toBe('{}')
  })

  it('insertAgent 带显式 envExtra → 落库一致', () => {
    agentsRepo.insertAgent(
      'agent-cfg-env',
      '配置猫',
      '🐱',
      'prompt',
      'opencode',
      'openai/gpt-5',
      '',
      null,
      'high',
      null,
      null,
      null,
      '{"HTTPS_PROXY":"http://127.0.0.1:7897"}'
    )
    const row = agentsRepo.getAgentById('agent-cfg-env')!
    expect(row.llm_env_extra).toBe('{"HTTPS_PROXY":"http://127.0.0.1:7897"}')
  })
})

// ═══ 占位符 API Key 自愈 ═══
//
// 病灶路径：无 DS_KEY 时首次启动 → 自动 seed 把 5 只猫全写成占位符哨兵 → 之后配好
// key 重启，表已非空 → 启动不再走 seed → 哨兵**永不补写**（旧 upsert 的 DO UPDATE
// 不碰 llm_*）。两条自愈路径分别覆盖两个触发面：重跑 seed（upsertAgent 条件补写）
// 与仅重启（healPlaceholderApiKeys，见下个 describe）。

/** 按 SEED_ARGS 的默认形状调 upsertAgent，只覆盖指定字段 */
function upsertWith(over: Partial<typeof SEED_ARGS> = {}) {
  const a = { ...SEED_ARGS, ...over }
  return agentsRepo.upsertAgent(
    a.id,
    a.name,
    a.avatar,
    a.systemPrompt,
    a.llmProvider,
    a.llmModel,
    a.llmApiKey,
    a.llmBaseUrl,
    a.effortLevel,
    a.skillModules,
    a.role
  )
}

describe('upsertAgent 占位符自愈（A1–A4）', () => {
  beforeEach(() => {
    setDb(createTestDb())
    initRepository(getDb())
  })

  afterEach(() => {
    resetDb()
  })

  it('A1 库中为占位符 + seed 值为真 key → 补写（自愈成立）', () => {
    upsertWith({ llmApiKey: PLACEHOLDER_API_KEY })
    expect(agentsRepo.getAgentById(SEED_ARGS.id)!.llm_api_key).toBe(PLACEHOLDER_API_KEY)

    upsertWith({ llmApiKey: 'sk-real-key' })

    expect(agentsRepo.getAgentById(SEED_ARGS.id)!.llm_api_key).toBe('sk-real-key')
  })

  it('A3 库中为空串（用户显式清空）+ seed 值为真 key → 不补写（停跑意图优先）', () => {
    upsertWith({ llmApiKey: PLACEHOLDER_API_KEY })
    // 用户在界面上显式清空 —— 空串是「意图」，不是「缺失」，与哨兵语义相反
    getDb().prepare("UPDATE agents SET llm_api_key = '' WHERE id = ?").run(SEED_ARGS.id)

    upsertWith({ llmApiKey: 'sk-real-key' })

    expect(agentsRepo.getAgentById(SEED_ARGS.id)!.llm_api_key).toBe('')
  })

  it('A4 库中为真 key + seed 值为占位符（DS_KEY 被清空）→ 真 key 不被冲掉', () => {
    upsertWith({ llmApiKey: 'sk-real-key' })

    upsertWith({ llmApiKey: PLACEHOLDER_API_KEY })

    expect(agentsRepo.getAgentById(SEED_ARGS.id)!.llm_api_key).toBe('sk-real-key')
  })

  it('库中为占位符 + seed 值也是占位符 → 保持哨兵（补了等于没补）', () => {
    upsertWith({ llmApiKey: PLACEHOLDER_API_KEY })
    upsertWith({ llmApiKey: PLACEHOLDER_API_KEY })
    expect(agentsRepo.getAgentById(SEED_ARGS.id)!.llm_api_key).toBe(PLACEHOLDER_API_KEY)
  })

  it('补写只动 llm_api_key 一列——其余运行配置仍不被 seed 覆盖', () => {
    upsertWith({ llmApiKey: PLACEHOLDER_API_KEY })
    // 模拟用户直改 DB 的其他运行配置（key 之外的面）
    getDb()
      .prepare(
        "UPDATE agents SET llm_model = 'custom-model', llm_provider = 'ollama', llm_base_url = 'http://127.0.0.1:11434', effort_level = 'low' WHERE id = ?"
      )
      .run(SEED_ARGS.id)

    upsertWith({ llmApiKey: 'sk-real-key' })

    const row = agentsRepo.getAgentById(SEED_ARGS.id)!
    expect(row.llm_api_key).toBe('sk-real-key') // 自愈生效
    expect(row.llm_model).toBe('custom-model') // 其余照旧不被覆盖
    expect(row.llm_provider).toBe('ollama')
    expect(row.llm_base_url).toBe('http://127.0.0.1:11434')
    expect(row.effort_level).toBe('low')
  })

  it('isHealableApiKey 判据：真值够格，空串与哨兵都不够格', () => {
    expect(agentsRepo.isHealableApiKey('sk-real-key')).toBe(true)
    expect(agentsRepo.isHealableApiKey('')).toBe(false)
    expect(agentsRepo.isHealableApiKey(PLACEHOLDER_API_KEY)).toBe(false)
  })
})

describe('healPlaceholderApiKeys（server 启动路径的独立自愈）', () => {
  beforeEach(() => {
    setDb(createTestDb())
    initRepository(getDb())
  })

  afterEach(() => {
    resetDb()
  })

  it('占位符行被补写，返回补写行数', () => {
    upsertWith({ llmApiKey: PLACEHOLDER_API_KEY })

    const healed = agentsRepo.healPlaceholderApiKeys([
      { name: SEED_ARGS.name, llmApiKey: 'sk-real-key' },
    ])

    expect(healed).toBe(1)
    expect(agentsRepo.getAgentById(SEED_ARGS.id)!.llm_api_key).toBe('sk-real-key')
  })

  it('空串行不动（用户停跑意图）——即便 entry 给了真 key', () => {
    upsertWith({ llmApiKey: PLACEHOLDER_API_KEY })
    getDb().prepare("UPDATE agents SET llm_api_key = '' WHERE id = ?").run(SEED_ARGS.id)

    const healed = agentsRepo.healPlaceholderApiKeys([
      { name: SEED_ARGS.name, llmApiKey: 'sk-real-key' },
    ])

    expect(healed).toBe(0)
    expect(agentsRepo.getAgentById(SEED_ARGS.id)!.llm_api_key).toBe('')
  })

  it('真 key 行不动（A4 的启动路径投影）', () => {
    upsertWith({ llmApiKey: 'sk-real-key' })

    const healed = agentsRepo.healPlaceholderApiKeys([
      { name: SEED_ARGS.name, llmApiKey: PLACEHOLDER_API_KEY },
    ])

    expect(healed).toBe(0)
    expect(agentsRepo.getAgentById(SEED_ARGS.id)!.llm_api_key).toBe('sk-real-key')
  })

  it('entry 值为空串 → 提前返回 0，且不碰库', () => {
    upsertWith({ llmApiKey: PLACEHOLDER_API_KEY })

    const healed = agentsRepo.healPlaceholderApiKeys([{ name: SEED_ARGS.name, llmApiKey: '' }])

    expect(healed).toBe(0)
    expect(agentsRepo.getAgentById(SEED_ARGS.id)!.llm_api_key).toBe(PLACEHOLDER_API_KEY)
  })

  it('entry 名字在库中不存在 → 不抛错、返回 0（幂等，非断言失败）', () => {
    upsertWith({ llmApiKey: PLACEHOLDER_API_KEY })

    const healed = agentsRepo.healPlaceholderApiKeys([
      { name: '并不存在的猫', llmApiKey: 'sk-real-key' },
    ])

    expect(healed).toBe(0)
    expect(agentsRepo.getAgentById(SEED_ARGS.id)!.llm_api_key).toBe(PLACEHOLDER_API_KEY)
  })

  it('混合批次：只补该补的，行数与各行动作都对', () => {
    // 三只猫三种初态：哨兵 / 空串 / 真 key
    upsertWith({ id: 'a-sentinel', name: '甲猫', llmApiKey: PLACEHOLDER_API_KEY })
    upsertWith({ id: 'a-empty', name: '乙猫', llmApiKey: PLACEHOLDER_API_KEY })
    getDb().prepare("UPDATE agents SET llm_api_key = '' WHERE id = 'a-empty'").run()
    upsertWith({ id: 'a-real', name: '丙猫', llmApiKey: 'sk-existing' })

    const healed = agentsRepo.healPlaceholderApiKeys([
      { name: '甲猫', llmApiKey: 'sk-new' },
      { name: '乙猫', llmApiKey: 'sk-new' },
      { name: '丙猫', llmApiKey: 'sk-new' },
    ])

    expect(healed).toBe(1) // 只有甲猫（哨兵）被补
    expect(agentsRepo.getAgentById('a-sentinel')!.llm_api_key).toBe('sk-new')
    expect(agentsRepo.getAgentById('a-empty')!.llm_api_key).toBe('')
    expect(agentsRepo.getAgentById('a-real')!.llm_api_key).toBe('sk-existing')
  })

  it('自愈只动 llm_api_key 一列——provider/model/base_url/effort 不被碰', () => {
    upsertWith({ llmApiKey: PLACEHOLDER_API_KEY })
    getDb()
      .prepare(
        "UPDATE agents SET llm_model = 'custom-model', llm_provider = 'ollama', llm_base_url = 'http://127.0.0.1:11434', effort_level = 'low' WHERE id = ?"
      )
      .run(SEED_ARGS.id)

    agentsRepo.healPlaceholderApiKeys([{ name: SEED_ARGS.name, llmApiKey: 'sk-real-key' }])

    const row = agentsRepo.getAgentById(SEED_ARGS.id)!
    expect(row.llm_api_key).toBe('sk-real-key')
    expect(row.llm_model).toBe('custom-model')
    expect(row.llm_provider).toBe('ollama')
    expect(row.llm_base_url).toBe('http://127.0.0.1:11434')
    expect(row.effort_level).toBe('low')
  })
})
