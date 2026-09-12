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
import { createSocketIO } from './connectors/socketio.js'
import { replayStuckUserMessages, REPLAY_STUCK_WINDOW_MINUTES } from './execution/recovery.js'
import { getExecutionBus } from './execution/registry.js'
import { startOneBotOutbound } from './connectors/onebotOutbound.js'
import { agentRoutes } from './routes/agents.js'
import { sessionRoutes } from './routes/sessions.js'
import { messageRoutes } from './routes/messages.js'
import { connectorRoutes } from './routes/connectors.js'
import { configRoutes } from './routes/config.js'
import { summaryConfigRoutes } from './routes/config-summary.js'
import { internalRoutes } from './routes/internal.js'
import { evalRoutes } from './routes/eval.js'
import { ironLawRoutes } from './routes/iron-laws.js'
import { createLogger, setLogLevel, type LogLevel } from './logger.js'
import { runL1Aggregation } from './eval/l1-aggregator.js'
import { classifyEpisodes, ZERO_EXECUTION_WINDOW_MINUTES } from './eval/episodes.js'
import { runEpisodeAttribution } from './eval/attribution.js'
import { existsSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildDemoAgents, DEMO_SESSION_ID, DEMO_SESSION_TITLE } from './seed-data.js'
import { stopLlamaServerIfSpawned } from './llm/llama-server.js'
import { startEmbeddingSidecar, stopEmbeddingSidecar } from './memory/embedding.js'
import { stopOllamaIfSpawned } from './llm/ollama.js'
import { stopProxyIfSpawned } from './llm/cli-utils.js'

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
        a.effortLevel ?? '',
        undefined,
        a.role ?? 'unknown'
      )
      console.log(`  ✅ ${a.avatar} ${a.name}`)
    }

    // 创建演示会话
    const agentIdsJson = JSON.stringify(agents.map((a) => a.id))
    sessionsRepo.upsertDemoSession(DEMO_SESSION_ID, DEMO_SESSION_TITLE, agentIdsJson)
    console.log(`  ✅ Session: ${DEMO_SESSION_TITLE}`)

    log.info('种子数据初始化完成', { agents: agents.length })
  }

  // 3. Fastify HTTP 服务器
  const app = Fastify({ logger: false })
  await app.register(cors, {
    origin: [/^http:\/\/(localhost|127\.0\.0\.1):\d+$/],
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
  await app.register(messageRoutes)
  await app.register(connectorRoutes)
  await app.register(configRoutes)
  await app.register(summaryConfigRoutes)
  await app.register(internalRoutes)
  await app.register(evalRoutes)
  await app.register(ironLawRoutes)

  // 4. 启动 Fastify → 拿到 HTTP Server → attach Socket.IO
  await app.listen({ port: PORT, host: HOST })
  const io = createSocketIO(app.server)
  // 执行 bus 由 createSocketIO 注册（setExecutionBus）——此后恒非 null；
  // L1/episode/replay 定时器经 bus 输出（定时器在注册之后才创建，顺序保证）
  const bus = getExecutionBus()!

  // P3: OneBot 出站转发（QQ 回复）——ONEBOT_ENABLED=false 时内部不订阅，零开销。
  // P4 #1: 接收返回的取消订阅函数——shutdown 时调用，防 replyBus 订阅泄漏
  // （EventEmitter 随进程销毁，但显式解绑防热启动/测试进程内多实例的重复触发）
  const stopOneBotOutbound = startOneBotOutbound()

  // W1 L1 聚合定时器：每小时跑一轮八口径聚合 + 滞回告警判定（同步函数，
  // 失败不阻塞主流程——聚合器内部已 per-session 防御，外层再兜一层防崩溃）
  const l1Timer = setInterval(
    () => {
      try {
        runL1Aggregation(bus)
      } catch (err: any) {
        log.error('L1 aggregation crashed (non-blocking)', { error: err.message })
      }
    },
    60 * 60 * 1000
  )
  // 启动后立即跑一轮（不等首个整点，重启后状态机已清空、首轮即恢复判定基线）
  try {
    runL1Aggregation(bus)
  } catch (err: any) {
    log.error('L1 initial aggregation failed (non-blocking)', { error: err.message })
  }

  // v2 episode 判定定时器：周期跑一轮全量判定（执行链路径 + 零执行扫描，同步函数，
  // 失败不阻塞主流程——与 L1 同款外层兜底）+ E2 归因分流与 closure 复验
  // （判定之后跑：归因读到的是本轮最新结局；复验读到的是已翻转结局）
  const episodeTimer = setInterval(
    () => {
      try {
        const { upserted, open } = classifyEpisodes()
        if (upserted > 0 || open > 0) {
          log.info('episode 判定一轮完成', { upserted, open })
        }
      } catch (err: any) {
        log.error('episode classification crashed (non-blocking)', { error: err.message })
      }
      try {
        const { dispatched, resolved, needReplay } = runEpisodeAttribution(bus)
        if (dispatched > 0 || resolved > 0) {
          log.info('episode 归因分流一轮完成', { dispatched, resolved })
        }
        // replay 分流 → 触发 dispatch 重放检查（abandoned 零执行闭环引擎；
        // 内部自捕获，fire-and-forget 不阻塞本轮）
        if (needReplay) void replayStuckUserMessages(bus)
      } catch (err: any) {
        log.error('episode attribution crashed (non-blocking)', { error: err.message })
      }
    },
    ZERO_EXECUTION_WINDOW_MINUTES * 60 * 1000
  )
  // 启动后立即跑一轮（与 L1 同款：不等首个周期，重启后尽快建立判定基线）
  try {
    classifyEpisodes()
  } catch (err: any) {
    log.error('episode initial classification failed (non-blocking)', { error: err.message })
  }
  try {
    const { needReplay } = runEpisodeAttribution(bus)
    if (needReplay) void replayStuckUserMessages(bus)
  } catch (err: any) {
    log.error('episode initial attribution failed (non-blocking)', { error: err.message })
  }

  // 静默丢重放定时器：周期补派"落库但从未被调度"的用户消息（16:09/02:24 案例：
  // ingest 在 insert 与 dispatch 之间崩溃导致调度从未发生）。同步封装，失败不阻塞
  // 主流程（与 L1/episode 同款外层兜底）
  const replayTimer = setInterval(
    () => {
      try {
        replayStuckUserMessages(bus)
      } catch (err: any) {
        log.error('replay scan crashed (non-blocking)', { error: err.message })
      }
    },
    REPLAY_STUCK_WINDOW_MINUTES * 60 * 1000
  )
  // 启动后立即跑一轮（不等首个周期，尽快补派重启前遗留的静默丢消息）
  try {
    replayStuckUserMessages(bus)
  } catch (err: any) {
    log.error('replay initial scan failed (non-blocking)', { error: err.message })
  }

  log.info('server started', { host: HOST, port: PORT })

  // 4.5 嵌入 sidecar：随 server 启动（独立进程，模型不进主进程内存）。
  //     fire-and-forget —— 起不来只记日志并降级记忆链，不阻塞 server 启动
  //     （AGENTS.md「记忆: fire-and-forget，失败不阻塞」）。含库内维度自检。
  void startEmbeddingSidecar()

  // 5. 优雅关闭
  const shutdown = async () => {
    log.info('shutting down...')
    // P4 #1: 先取消 OneBot 出站订阅，停止 replyBus 投递（关停后不应再发 QQ）
    stopOneBotOutbound?.()
    // W1: 清理 L1 聚合定时器（shutdown 链完整——防热启动/测试进程内重复定时器）
    clearInterval(l1Timer)
    // v2: 清理 episode 判定定时器（同款防重复定时器）
    clearInterval(episodeTimer)
    // 静默丢重放定时器（同款防重复定时器）
    clearInterval(replayTimer)
    io.close()
    await app.close()
    // 清理自己 spawn 的常驻子进程（llama-server / ollama serve / codex-proxy）——
    // 只杀本进程 spawn 的实例（探测发现已有实例则不保存句柄 → 不误杀他人/手动起的）
    stopLlamaServerIfSpawned()
    stopOllamaIfSpawned()
    stopProxyIfSpawned()
    // 嵌入 sidecar（本进程 spawn ⇒ 关停时一并回收，防孤儿进程占端口/内存）
    stopEmbeddingSidecar()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  log.error('failed to start', { error: String(err) })
  process.exit(1)
})
