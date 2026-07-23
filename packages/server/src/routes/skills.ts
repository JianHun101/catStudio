/**
 * 技能列表 REST API — 供前端 / 下拉框使用。
 */
import type { FastifyInstance } from 'fastify'
import { SkillLoader } from '../skills/skill-loader.js'
import { agents as agentsRepo } from '../db/repository/index.js'
import { createLogger } from '../logger.js'

const log = createLogger('skills')

/** Agent 技能模块映射（临时硬编码，待 DB 列 migration 后移除） */
const AGENT_SKILL_MODULES: Record<string, string[]> = {
  店长: ['handoff', 'dependency-request'],
  服务员: ['handoff', 'dependency-request'],
  吐槽猫: ['handoff', 'code-review', 'dependency-review'],
}

export async function skillRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/skills', async (req, reply) => {
    const manifest = SkillLoader.getInstance().getManifest()
    const loadedNames = SkillLoader.getInstance().getLoadedSkillNames()

    let allowedSkills: Set<string> | null = null

    // 可选：按 session 内 Agent 的能力过滤（防止下拉框显示无效技能）
    const agentIdsParam = (req.query as any)?.agentIds
    if (agentIdsParam) {
      const agentIds: string[] = String(agentIdsParam).split(',').filter(Boolean)
      const agentRows = agentIds.length > 0 ? agentsRepo.listAgentsByIds(agentIds) : []
      const agentNames = agentRows.map((a) => a.name)
      allowedSkills = new Set(agentNames.flatMap((name) => AGENT_SKILL_MODULES[name] || []))
    }

    const skills = Object.entries(manifest.skills)
      .filter(([name]) => !allowedSkills || allowedSkills.has(name))
      .map(([name, entry]) => ({
        name,
        description: entry.description,
        triggers: entry.triggers,
        loaded: loadedNames.includes(name),
      }))

    return reply.send({ skills })
  })
}
