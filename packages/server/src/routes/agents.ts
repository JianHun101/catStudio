import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import { AgentCreateSchema, AgentConfigSchema } from '@cat-study/shared'
import type { AgentTokenStats } from '@cat-study/shared'
import {
  agents as agentsRepo,
  executionLogs as execLogsRepo,
  memories as memoriesRepo,
  messages as messagesRepo,
} from '../db/repository/index.js'
import type { AgentRow } from '../db/repository/index.js'
import { createLogger } from '../logger.js'

const log = createLogger('agents')

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  // ─── POST /api/agents — 创建 Agent ──────────────────

  app.post('/api/agents', async (req, reply) => {
    const parsed = AgentCreateSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() })
    }

    const agent = parsed.data
    const id = uuid()

    try {
      agentsRepo.insertAgent(
        id,
        agent.name,
        agent.avatar,
        agent.systemPrompt,
        agent.llmProvider,
        agent.llmModel,
        agent.llmApiKey,
        agent.llmBaseUrl || null,
        agent.effortLevel || null,
        // skill_modules 列保留兼容（历史数据），新建 Agent 不再声明技能——注入链已拆除
        '[]'
      )

      const row = agentsRepo.getAgentById(id)
      return reply.status(201).send(toAgentConfig(row!))
    } catch (err: any) {
      if (err.message?.includes('UNIQUE')) {
        return reply.status(409).send({ error: `Agent "${agent.name}" already exists` })
      }
      log.error('agent create failed', { name: agent.name, error: err.message, stack: err.stack })
      throw err
    }
  })

  // ─── GET /api/agents — 列出所有 Agent ───────────────

  app.get('/api/agents', async () => {
    const rows = agentsRepo.listAllAgents()
    return rows.map(toAgentConfig)
  })

  // ─── GET /api/agents/:id — 获取单个 Agent ───────────

  app.get('/api/agents/:id', async (req, reply) => {
    const row = agentsRepo.getAgentById((req.params as any).id)
    if (!row) return reply.status(404).send({ error: 'Agent not found' })
    return toAgentConfig(row)
  })

  // ─── PATCH /api/agents/:id — 更新 Agent ─────────────

  app.patch('/api/agents/:id', async (req, reply) => {
    const id = (req.params as any).id
    const existing = agentsRepo.getAgentById(id)
    if (!existing) return reply.status(404).send({ error: 'Agent not found' })

    const body = req.body as any
    const fields: string[] = []
    const values: any[] = []

    for (const [key, col] of Object.entries({
      name: 'name',
      avatar: 'avatar',
      systemPrompt: 'system_prompt',
      llmProvider: 'llm_provider',
      llmModel: 'llm_model',
      llmApiKey: 'llm_api_key',
      llmBaseUrl: 'llm_base_url',
      effortLevel: 'effort_level',
    })) {
      if (body[key] !== undefined) {
        fields.push(`${col} = ?`)
        values.push(body[key])
      }
    }

    if (fields.length === 0) {
      return reply.status(400).send({ error: 'No fields to update' })
    }

    agentsRepo.updateAgent(id, fields.join(', '), values)

    const updated = agentsRepo.getAgentById(id)
    return toAgentConfig(updated!)
  })

  // ─── GET /api/agents/:id/stats — Agent Token 统计 ───

  app.get('/api/agents/:id/stats', async (req, reply) => {
    const id = (req.params as any).id
    const agent = agentsRepo.getAgentById(id)
    if (!agent) return reply.status(404).send({ error: 'Agent not found' })

    const maxTokens = parseInt(process.env.MAX_CONTEXT_TOKENS || '128000', 10)

    // 累计统计（所有调用）
    const totals = execLogsRepo.getAgentStats(id)

    // 当前活跃会话统计
    const sessionId = (req.query as any)?.sessionId
    let sessionPrompt = 0
    let sessionCompletion = 0
    if (sessionId) {
      const sessionStats = execLogsRepo.getAgentSessionStats(id, sessionId)
      sessionPrompt = sessionStats?.session_prompt || 0
      sessionCompletion = sessionStats?.session_completion || 0
    }

    const stats: AgentTokenStats = {
      agentId: id,
      agentName: agent.name,
      totalPromptTokens: totals?.total_prompt || 0,
      totalCompletionTokens: totals?.total_completion || 0,
      sessionPromptTokens: sessionPrompt,
      sessionCompletionTokens: sessionCompletion,
      maxContextTokens: maxTokens,
    }

    return stats
  })

  // ─── DELETE /api/agents/:id — 删除 Agent ────────────

  app.delete('/api/agents/:id', async (req, reply) => {
    const id = (req.params as any).id

    // 先检查是否存在
    if (!agentsRepo.agentExists(id)) {
      return reply.status(404).send({ error: 'Agent not found' })
    }

    // 清理关联数据（FK 约束无 ON DELETE CASCADE，需手动删除）
    execLogsRepo.deleteExecutionLogsByAgent(id)
    memoriesRepo.deleteMemoriesByAgent(id)
    messagesRepo.deleteMessagesByAgent(id)
    agentsRepo.deleteAgentById(id)
    return { ok: true }
  })
}

/** DB row → AgentConfig */
function toAgentConfig(row: AgentRow) {
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    systemPrompt: row.system_prompt,
    llmProvider: row.llm_provider,
    llmModel: row.llm_model,
    llmApiKey: row.llm_api_key,
    llmBaseUrl: row.llm_base_url || undefined,
    effortLevel: row.effort_level || undefined,
    role: row.role, // 前端占位符解析（@架构师→store 角色真名）依赖此字段；漏序列化 → 前端永远拿不到角色
  }
}
