/**
 * 技能列表 REST API — 供前端 / 下拉框使用。
 */
import type { FastifyInstance } from 'fastify'
import { SkillLoader } from '../skills/skill-loader.js'
import { agents as agentsRepo } from '../db/repository/index.js'
import { createLogger } from '../logger.js'

const log = createLogger('skills')

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
      allowedSkills = new Set(
        agentRows.flatMap((a) => {
          try {
            const arr = JSON.parse(a.skill_modules)
            return Array.isArray(arr) ? arr : []
          } catch {
            return []
          }
        })
      )
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
