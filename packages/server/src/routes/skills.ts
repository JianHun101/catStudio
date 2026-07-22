/**
 * 技能列表 REST API — 供前端 / 下拉框使用。
 */
import type { FastifyInstance } from 'fastify'
import { SkillLoader } from '../skills/skill-loader.js'
import { createLogger } from '../logger.js'

const log = createLogger('skills')

export async function skillRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/skills', async (_req, reply) => {
    const manifest = SkillLoader.getInstance().getManifest()
    const loadedNames = SkillLoader.getInstance().getLoadedSkillNames()

    const skills = Object.entries(manifest.skills).map(([name, entry]) => ({
      name,
      description: entry.description,
      triggers: entry.triggers,
      loaded: loadedNames.includes(name),
    }))

    return reply.send({ skills })
  })
}
