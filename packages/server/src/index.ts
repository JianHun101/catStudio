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
import { skillRoutes } from './routes/skills.js'
import { memoryRoutes } from './routes/memory.js'
import { createLogger, setLogLevel, type LogLevel } from './logger.js'
import { runL1Aggregation } from './eval/l1-aggregator.js'
import { classifyEpisodes, ZERO_EXECUTION_WINDOW_MINUTES } from './eval/episodes.js'
import { runEpisodeAttribution } from './eval/attribution.js'
import { existsSync, unlinkSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { findRepoRootFrom } from './repo-root.js'
import { buildDemoAgents, DEMO_SESSION_ID, DEMO_SESSION_TITLE } from './seed-data.js'
import { stopLlamaServerIfSpawned } from './llm/llama-server.js'
import { startEmbeddingSidecar, stopEmbeddingSidecar } from './memory/embedding.js'
import { summarizeSkippedByReason } from './memory/flywheel/scan-report.js'
import { clearStaleShutdownRequest, startShutdownRequestWatcher } from './shutdown-request.js'
import { stopOllamaIfSpawned } from './llm/ollama.js'
import { stopProxyIfSpawned } from './llm/cli-utils.js'
import { messageOf } from './utils.js'

const log = createLogger('server')

const PORT = parseInt(process.env.PORT || '3200', 10)
const HOST = process.env.HOST || '127.0.0.1'

// ─── 飞轮扫描器接线（票庚 · 契约 ② 自动触发点）─────────────

/** 本模块所在目录（源码与构建产物通用——向上找根不依赖层级） */
const moduleDir = dirname(fileURLToPath(import.meta.url))

/** 飞轮扫描器脚本相对仓库根的路径（它自己会拉 tsx 跑 TS 依赖）——同时充当「仓库根」的**存在性锚点** */
const FLYWHEEL_SCAN_REL = ['scripts', 'flywheel', 'scan.mjs'] as const

/**
 * 定位仓库根与扫描器脚本；两者**同生共死**（根靠这个锚找出来），故一起返回，找不到整体 `null`。
 *
 * **为什么不是固定层级**（原实现的缺陷）：原注释断言「`packages/server/src/` 与打包后
 * `dist/server/src/` 同为 3 层深」——被 `tsconfig.json`（`rootDir: ".."` + `outDir: "./dist"`，
 * 加 `package.json` 的 `"start": "node dist/server/src/index.js"` 独立印证）实测**证伪**：
 * 产物比源码深**两层**。产物布局下 `REPO_ROOT` 解析成 `packages/server/` ⇒
 * `FLYWHEEL_SCAN_SCRIPT` 指向不存在的路径 ⇒ 每次启动一条「脚本缺失」warn + 扫描器永不跑。
 * 走存在性向上找（`repo-root.ts`）后两种布局同解。
 */
function resolveFlywheelTarget(): { root: string; script: string } | null {
  const root = findRepoRootFrom(moduleDir, FLYWHEEL_SCAN_REL)
  return root === null ? null : { root, script: resolve(root, ...FLYWHEEL_SCAN_REL) }
}

/**
 * 启动时把扫描器 spawn 一次（**fire-and-forget**）。
 *
 * 「失败不阻塞」是刻意的：索引是**派生投影**，重建者起不来不该拖垮 server
 * （承 AGENTS.md「记忆: fire-and-forget，失败不阻塞」）。脚本缺失 / spawn 抛错 /
 * 子进程非零退出**全部只记 log**。
 *
 * 形态 = `node <绝对路径.mjs> --root <仓库根>`：不走 shell、不经 `.cmd` wrapper
 * （AGENTS.md：Windows 会 EINVAL）；`--root` 显式传，避免 server 的 cwd 落在
 * `workspace/` 降级路径时扫错目录。tsx 知识不在这里——扫描器自己负责把自己
 * 拉进能跑 TS 的运行时。
 */
function spawnFlywheelScan(): void {
  try {
    const target = resolveFlywheelTarget()
    if (target === null) {
      // 锚文件不在 ⇒ 「脚本缺失」与「找不到仓库根」是同一件事（根就是靠它找出来的）
      log.warn('飞轮扫描器脚本缺失，跳过本轮扫描', { path: FLYWHEEL_SCAN_REL.join('/') })
      return
    }
    const child = spawn(process.execPath, [target.script, '--root', target.root], {
      cwd: target.root,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    let stdout = ''
    child.stdout?.on('data', (buf: Buffer) => {
      stdout += buf.toString()
    })
    child.on('error', (err: Error) => {
      log.warn('飞轮扫描器 spawn 失败（不阻塞启动）', { error: err.message })
    })
    child.on('exit', (code) => {
      const report = parseScanReport(stdout)
      if (code !== 0 || !report) {
        log.warn('飞轮扫描器未正常完成', { code, aborted: report?.aborted?.reason ?? null })
        return
      }
      log.info('飞轮扫描完成', {
        scanned: report.scanned,
        inserted: report.inserted,
        updated: report.updated,
        skipped: report.skipped.length,
        // 跳过明细按 reason 归桶：`unchanged`（正常增量）与 `empty-evidence` 等
        // （真缺口）在总数上同形，分开才读得出「谁被跳、为什么」
        skippedByReason: summarizeSkippedByReason(report.skipped),
        orphansDeleted: report.orphansDeleted,
        errors: report.errors.length,
        // 中止（如嵌入未启用）= 本轮没写索引，不是失败——留痕以便分辨「扫完没变化」与「压根没扫」
        aborted: report.aborted?.reason ?? null,
      })
    })
  } catch (err: any) {
    log.warn('飞轮扫描器启动失败（不阻塞启动）', { error: messageOf(err) })
  }
}

/** 扫描器 stdout 的 JSON 报告；空/半行/中止导致解析不出 ⇒ null（调用方按未完成处理） */
function parseScanReport(stdout: string): any | null {
  const line = stdout.trim().split('\n').filter(Boolean).pop()
  if (!line) return null
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

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

  // 1.6b 启动时清理**陈旧的关停请求文件**（票巳 (b) 契约 4）
  //      dev.js 写了 .shutdown-request 但进程没来得及消费（走了兜底硬杀）⇒ 文件残留。
  //      不清理的话新起的 server 一启动就会被它打掉 —— **启动即自杀**。
  //      必须在下面的 startShutdownRequestWatcher() **之前**（见那里的注释）。
  clearStaleShutdownRequest()

  // 1.7 启动时清理幽灵 execution_logs（agent 已被删除但日志残留）
  const ghostResult = execLogsRepo.deleteGhostExecutionLogs()
  if (ghostResult.changes > 0) {
    log.warn('启动时清理幽灵 execution_logs', { deleted: ghostResult.changes })
  }

  // 1.8 嵌入 sidecar 探活（票辛 W7）：**先于扫描器**——扫描器要嵌入（嵌入不可用
  //     则整件不写，票庚 ⑤），sidecar 后起会让首轮扫描白跑一次。
  //
  //     分支在 `startEmbeddingSidecar` 内部：`MEMORY_ENABLED=false` ⇒ 记一行
  //     「不启动」直接返回（不 spawn、零开销）；否则 spawn + 探活 + 维度自检。
  //     仍是 fire-and-forget（不 await）：冷启动含模型加载，最长 30s，不能拖住
  //     server 起来（AGENTS.md「记忆: fire-and-forget，失败不阻塞」）。扫描器
  //     侧另有兜底：其 EmbeddingClient 首次调用会自行 spawn sidecar。
  void startEmbeddingSidecar()

  // 1.9 飞轮扫描器（票庚 S2 自动触发点）：白名单内的结晶 MD 增量同步进 `chunks`
  //     索引表。fire-and-forget —— 起不来只记 log，不阻塞启动、不 fail 启动。
  spawnFlywheelScan()

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
  } else {
    // 2.1 占位符 API Key 自愈 —— **独立于**上面那条「表空才 seed」的路径。
    //
    //     为什么不能直接把 `agentCount === 0` 放宽成 `|| 存在占位符`：上面那个块
    //     尾部还有 upsertDemoSession + 逐只 console.log，放宽会让「没配 key」的
    //     每一次启动都重跑整个 seed 块。这里只补 `llm_api_key` 一列——
    //     不碰会话、不重建猫、不覆盖任何其他运行配置。
    //
    //     补的是「无 key 首启写了占位符哨兵 → 之后配好 key」这条路径：表已非空，
    //     启动不再走 seed，若不在此自愈则 key 永远补不上。判据在 repository 内
    //     （哨兵才补；空串 '' = 用户显式清空，不补）。
    const healed = agentsRepo.healPlaceholderApiKeys(
      buildDemoAgents().map((a) => ({ name: a.name, llmApiKey: a.llmApiKey }))
    )
    if (healed > 0) {
      log.info('占位符 API Key 已自愈（原值为未配置哨兵）', { healed })
    }
  }

  // 3. Fastify HTTP 服务器
  const app = Fastify({ logger: false })
  await app.register(cors, {
    origin: [/^http:\/\/(localhost|127\.0\.0\.1):\d+$/],
  })

  // 全局错误处理：记录完整错误并返回结构化响应
  app.setErrorHandler((rawErr, req, reply) => {
    const err = rawErr as any
    // 诊断取值单源（R6 §B）：框架抛出的未必是 Error（`throw 'x'` 同样合法），
    // `err.message` 在那种情况下恒 undefined——日志与响应两侧一起归零。
    const detail = messageOf(err)
    log.error('request error', {
      method: req.method,
      url: req.url,
      error: detail,
      stack: err.stack,
    })
    const statusCode = err.statusCode || 500
    reply.status(statusCode).send({
      error: statusCode >= 500 ? 'Internal Server Error' : detail,
      message: detail ?? 'Unknown Error',
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
  await app.register(skillRoutes)
  await app.register(memoryRoutes)

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

  // （嵌入 sidecar 已前移到 1.8：扫描器之前，见那里的注释）

  // 5. 优雅关闭
  // 契约 5（票巳）：`.shutdown-request` 文件握手与 SIGINT 可能**同窗到达** ⇒
  // `shutdown()` 会被重入。现状无守卫，第二次会撞上已关闭的 io/app（抛错，关停链
  // 断在半路，尾部进程回收走不到）。守卫必须是「幂等 + 记一行」，不是静默吞掉：
  // 重入本身就是关停链的可观测事实。
  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) {
      log.info('已在关停中，忽略重复触发')
      return
    }
    shuttingDown = true
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

  // 关停请求自检（票巳 (b) 契约 4/7）：dev.js 按钮重启时写 `.shutdown-request`，
  // 本处轮询消费 → 走**同一个** `shutdown()`（Ctrl+C 与文件握手共用一条关停链，
  // 重入由上面的守卫兜住）。
  //
  // 必须晚于 1.6b 的 `clearStaleShutdownRequest()`——顺序反了就是「新 server 被
  // 陈旧文件打掉」。此处已是 main 尾部，天然满足。
  startShutdownRequestWatcher(() => {
    void shutdown()
  })
}

main().catch((err) => {
  log.error('failed to start', { error: String(err) })
  process.exit(1)
})
