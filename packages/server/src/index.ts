// ═══ .env 加载（必须放在最前面，在所有模块初始化之前）═══
import './env.js'

// HuggingFace 端点 — 默认直连 huggingface.co，需要镜像时设 HF_ENDPOINT=https://hf-mirror.com
// 必须在 import transformers 之前设置

import Fastify from 'fastify'
import cors from '@fastify/cors'
import { initDb, getDb } from './db/index.js'
import { connectRedis, closeRedis } from './db/redis.js'
import { createSocketIO } from './connectors/socketio.js'
import { agentRoutes } from './routes/agents.js'
import { sessionRoutes } from './routes/sessions.js'
import { createLogger, setLogLevel } from './logger.js'
import { buildDemoAgents, DEMO_SESSION_ID, DEMO_SESSION_TITLE } from './seed-data.js'

const log = createLogger('server')

const PORT = parseInt(process.env.PORT || '3200', 10)
const HOST = process.env.HOST || '127.0.0.1'

async function main(): Promise<void> {
  // 调试模式下输出 DEBUG 日志
  if (process.env.LOG_LEVEL) {
    setLogLevel(process.env.LOG_LEVEL as any)
    log.info('log level set', { level: process.env.LOG_LEVEL })
  }

  // 1. 初始化数据库
  initDb()
  log.info('database ready')

  // 1.5 启动时修复：将上一次异常退出遗留的 running 状态标记为 failed
  //     （参照 clowder-ai StartupReconciler）
  const db0 = getDb()
  const stuckLogs = db0.prepare(
    "SELECT id, agent_id FROM execution_logs WHERE status = 'running'",
  ).all() as any[]
  if (stuckLogs.length > 0) {
    db0.prepare(`
      UPDATE execution_logs
      SET status = 'failed',
          ended_at = datetime('now'),
          error_message = 'server_restart'
      WHERE status = 'running'
    `).run()
    log.warn('启动时修复 stuck execution_logs', {
      count: stuckLogs.length,
      ids: stuckLogs.map((r: any) => r.id),
    })
  }

  // 2. 首次启动自动初始化种子数据（Agents 表为空时）
  const db = getDb()
  const agentCount = (db.prepare('SELECT COUNT(*) as cnt FROM agents').get() as any).cnt
  if (agentCount === 0) {
    log.info('首次启动 — 自动创建默认猫咪…')

    const agents = buildDemoAgents()

    const upsert = db.prepare(`
      INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, llm_base_url, effort_level)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        avatar = excluded.avatar,
        system_prompt = excluded.system_prompt,
        llm_provider = excluded.llm_provider,
        llm_model = excluded.llm_model,
        llm_api_key = excluded.llm_api_key,
        llm_base_url = excluded.llm_base_url,
        effort_level = excluded.effort_level,
        updated_at = datetime('now')
    `)

    for (const a of agents) {
      upsert.run(a.id, a.name, a.avatar, a.systemPrompt, a.llmProvider, a.llmModel, a.llmApiKey, a.llmBaseUrl, a.effortLevel || null)
      console.log(`  ✅ ${a.avatar} ${a.name}`)
    }

    // 创建演示会话
    const agentIds = JSON.stringify(agents.map((a) => a.id))
    db.prepare(`INSERT INTO sessions (id, title, agent_ids) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET agent_ids = excluded.agent_ids, updated_at = datetime('now')`)
      .run(DEMO_SESSION_ID, DEMO_SESSION_TITLE, agentIds)
    console.log(`  ✅ Session: ${DEMO_SESSION_TITLE}`)

    log.info('种子数据初始化完成', { agents: agents.length })
  }

  // 3. 连接 Redis（可选——失败不阻塞启动）
  try {
    await connectRedis()
  } catch {
    log.warn('Redis unavailable — running without message bus')
  }

  // 4. Fastify HTTP 服务器
  const app = Fastify({ logger: false })
  await app.register(cors, {
    origin: [/^http:\/\/localhost:\d+$/],
  })

  // 全局错误处理：记录完整错误并返回结构化响应
  app.setErrorHandler((rawErr, req, reply) => {
    const err = rawErr as any
    log.error('request error', {
      method: req.method,
      url: req.url,
      error: err.message,
      stack: err.stack,
    })
    const statusCode = err.statusCode || 500
    reply.status(statusCode).send({
      error: statusCode >= 500 ? 'Internal Server Error' : err.message,
      message: err.message,
    })
  })

  // 健康检查
  app.get('/api/health', async () => ({ status: 'ok', uptime: process.uptime() }))

  // REST API 路由
  await app.register(agentRoutes)
  await app.register(sessionRoutes)

  // 5. 启动 Fastify → 拿到 HTTP Server → attach Socket.IO
  await app.listen({ port: PORT, host: HOST })
  const io = createSocketIO(app.server)

  log.info('server started', { host: HOST, port: PORT })

  // 6. 优雅关闭
  const shutdown = async () => {
    log.info('shutting down...')
    io.close()
    await app.close()
    await closeRedis()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  log.error('failed to start', { error: String(err) })
  process.exit(1)
})
