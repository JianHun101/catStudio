import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import { AgentCreateSchema, AgentConfigSchema } from '@cat-study/shared'
import { getDb } from '../db/index.js'
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
    const db = getDb()

    try {
      db.prepare(`
        INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, llm_base_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        agent.name,
        agent.avatar,
        agent.systemPrompt,
        agent.llmProvider,
        agent.llmModel,
        agent.llmApiKey,
        agent.llmBaseUrl || null,
      )

      const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as any
      return reply.status(201).send(toAgentConfig(row))
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
    const db = getDb()
    const rows = db.prepare('SELECT * FROM agents ORDER BY created_at ASC').all() as any[]
    return rows.map(toAgentConfig)
  })

  // ─── GET /api/agents/:id — 获取单个 Agent ───────────

  app.get('/api/agents/:id', async (req, reply) => {
    const db = getDb()
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get((req.params as any).id) as any
    if (!row) return reply.status(404).send({ error: 'Agent not found' })
    return toAgentConfig(row)
  })

  // ─── PATCH /api/agents/:id — 更新 Agent ─────────────

  app.patch('/api/agents/:id', async (req, reply) => {
    const db = getDb()
    const id = (req.params as any).id
    const existing = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as any
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
    })) {
      if (body[key] !== undefined) {
        fields.push(`${col} = ?`)
        values.push(body[key])
      }
    }

    if (fields.length === 0) {
      return reply.status(400).send({ error: 'No fields to update' })
    }

    fields.push("updated_at = datetime('now')")
    values.push(id)

    db.prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`).run(...values)

    const updated = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as any
    return toAgentConfig(updated)
  })

  // ─── DELETE /api/agents/:id — 删除 Agent ────────────

  app.delete('/api/agents/:id', async (req, reply) => {
    const db = getDb()
    const id = (req.params as any).id
    const result = db.prepare('DELETE FROM agents WHERE id = ?').run(id)
    if (result.changes === 0) return reply.status(404).send({ error: 'Agent not found' })
    return { ok: true }
  })
}

/** DB row → AgentConfig */
function toAgentConfig(row: any) {
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    systemPrompt: row.system_prompt,
    llmProvider: row.llm_provider,
    llmModel: row.llm_model,
    llmApiKey: row.llm_api_key,
    llmBaseUrl: row.llm_base_url || undefined,
  }
}
