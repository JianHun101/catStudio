/**
 * Agents repo upsertAgent 运行配置覆盖语义测试。
 *
 * 根治 seed 覆盖 DB key（docs/sessions/cat-study-handoff-review-loop-fix-summary.md:104 预登记）：
 * - UPDATE 分支不覆盖 llm_provider/model/api_key/base_url/effort_level（DB 是运行配置权威）
 * - INSERT 分支保留写入默认（首次初始化行为）
 * - 团队定义字段（system_prompt/avatar/role/skill_modules）仍由 seed 同步（prompt 更新链路保留）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb } from '../../test-helpers.js'
import { setDb, resetDb, getDb } from '../index.js'
import { initRepository } from './index.js'
import { agents as agentsRepo } from './index.js'

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
