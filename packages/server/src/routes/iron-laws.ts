/**
 * 铁律只读 API — 开发铁律 + 审查铁律全文。
 *
 * - GET /api/iron-laws → 200 { ok: true, coder, reviewer }
 *
 * 铁律唯一权威是 seed-data.ts 的两个常量（注入各猫 systemPrompt 末尾），
 * 本路由直接 import 返回——不新建副本，接口与常量逐字一致。
 * 纯只读，无写侧；配置页面「⚙️ 系统配置」tab 铁律卡片消费。
 */
import type { FastifyInstance } from 'fastify'
import { IRON_LAWS_CODER, IRON_LAWS_REVIEWER } from '../seed-data.js'

export async function ironLawRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/iron-laws', async () => ({
    ok: true,
    coder: IRON_LAWS_CODER,
    reviewer: IRON_LAWS_REVIEWER,
  }))
}
