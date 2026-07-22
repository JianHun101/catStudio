// ═══ .env 加载（必须放在最前面，在所有模块初始化之前）═══
import './env.js'

// HuggingFace 端点 — 默认直连 huggingface.co，需要镜像时设 HF_ENDPOINT=https://hf-mirror.com
// 必须在 import transformers 之前设置

import Fastify from 'fastify'
import cors from '@fastify/cors'
import { initDb, getDb } from './db/index.js'
import {
  initRepository,
  agents as agentsRepo,
  sessions as sessionsRepo,
  executionLogs as execLogsRepo,
} from './db/repository/index.js'
import { connectRedis, closeRedis } from './db/redis.js'
import { createSocketIO } from './connectors/socketio.js'
import { agentRoutes } from './routes/agents.js'
import { sessionRoutes } from './routes/sessions.js'
import { createLogger, setLogLevel, type LogLevel } from './logger.js'
import { existsSync, unlinkSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDemoAgents, DEMO_SESSION_ID, DEMO_SESSION_TITLE } from './seed-data.js'
import { SkillLoader } from './skills/skill-loader.js'

const log = createLogger('server')

const PORT = parseInt(process.env.PORT || '3200', 10)
const HOST = process.env.HOST || '127.0.0.1'

async function main(): Promise<void> {
  // 调试模式下输出 DEBUG 日志
  if (process.env.LOG_LEVEL) {
    setLogLevel(process.env.LOG_LEVEL as LogLevel)
    log.info('log level set', { level: process.env.LOG_LEVEL })
  }

  // 1. 初始化数据库
  initDb()
  initRepository(getDb())
  log.info('database ready')

  // 1.5 启动时修复：将上一次异常退出遗留的 running 状态标记为 failed
  //     （参照 clowder-ai StartupReconciler）
  const stuckResult = execLogsRepo.fixStuckExecutionLogs()
  if (stuckResult.changes > 0) {
    log.warn('启动时修复 stuck execution_logs', { count: stuckResult.changes })
  }

  // 1.6 启动时清理残留的 Agent 执行锁文件
  //     上次服务器异常退出（如 tsx watch 触发重启）时可能未删除
  const lockFile = resolve(process.cwd(), '.agent-busy')
  if (existsSync(lockFile)) {
    unlinkSync(lockFile)
    log.warn('启动时清理残留锁文件')
  }

  // 1.7 启动时清理幽灵 execution_logs（agent 已被删除但日志残留）
  const ghostResult = execLogsRepo.deleteGhostExecutionLogs()
  if (ghostResult.changes > 0) {
    log.warn('启动时清理幽灵 execution_logs', { deleted: ghostResult.changes })
  }

  // 1.8 初始化技能加载器（启动时一次性将所有 skill 文件读入内存）
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = dirname(__filename)
  const skillsDir = resolve(__dirname, 'skills')
  SkillLoader.initialize(skillsDir)
  log.info('skill loader initialized', {
    loadedSkills: SkillLoader.getInstance().getLoadedSkillNames(),
  })

  // 2. 首次启动自动初始化种子数据（Agents 表为空时）
  const agentCount = agentsRepo.countAgents()
  if (agentCount === 0) {
    log.info('首次启动 — 自动创建默认猫咪…')

    const agents = buildDemoAgents()

    for (const a of agents) {
      agentsRepo.upsertAgent(
        a.id,
        a.name,
        a.avatar,
        a.systemPrompt,
        a.llmProvider,
        a.llmModel,
        a.llmApiKey,
        a.llmBaseUrl,
        a.effortLevel ?? ''
      )
      console.log(`  ✅ ${a.avatar} ${a.name}`)
    }

    // 创建演示会话
    const agentIdsJson = JSON.stringify(agents.map((a) => a.id))
    sessionsRepo.upsertDemoSession(DEMO_SESSION_ID, DEMO_SESSION_TITLE, agentIdsJson)
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
