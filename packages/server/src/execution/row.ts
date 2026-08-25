/**
 * Execution — DB row → 领域对象映射（第 3 刀从 socketio.ts 迁出，只搬不改）。
 *
 * 行映射收口（opencode 报告 #4：rowToAgent/toAgentConfig 近重复）另开单，
 * 本文件先承接既有 rowToAgent——connector/recovery/serial 三方共用。
 */

import type { AgentConfig } from '@cat-study/shared'
import type { AgentRow } from '../db/repository/index.js'

/** DB row (snake_case) → AgentConfig (camelCase) */
export function rowToAgent(row: AgentRow): AgentConfig {
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    systemPrompt: row.system_prompt,
    llmProvider: row.llm_provider,
    llmModel: row.llm_model,
    llmApiKey: row.llm_api_key,
    llmBaseUrl: row.llm_base_url || undefined,
    effortLevel: (row.effort_level || undefined) as AgentConfig['effortLevel'],
    llmMaxTokens: row.llm_max_tokens, // 迁移 DEFAULT 2048 回填存量行；透传点据此决定是否传 ChatOptions.maxTokens
    llmTemperature: row.llm_temperature,
    llmEnvExtra: row.llm_env_extra, // 迁移 DEFAULT '{}' 回填存量行；registry 构造时宽容解析
    // 老库迁移默认 'unknown'（不在 AgentRole 里）——白名单对未知角色放行
    role: (row.role || undefined) as AgentConfig['role'],
  }
}
