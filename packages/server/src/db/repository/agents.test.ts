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
