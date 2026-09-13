/**
 * 评估中心 REST API（E4-A：后端四接口）。
 *
 * - GET /api/eval/scores?limit=&agent_id=   最近评分列表（join agents 拿猫名）
 * - GET /api/eval/aggregates                按猫聚合 count / avg_score / low_score_rate
 * - GET /api/eval/review/pending            待回标样本（low_score 且无回标，附回复全文 + 前置 10 条上下文）
 * - POST /api/eval/review/:evalScoreId      { score: 1-5, comment? } 写回标 + 翻转 sample_reason；
 *                                           重复提交同一 eval_score_id → 覆盖 + log 留痕（契约钉死分支）
 * - GET /api/eval/episode-stats             任务结局分布（U 根/H 根 outcome 计数 + open + 版本偏差，
 *                                           挂现成 episodeStats()，办成率前端算）
 * - GET /api/eval/l1-metrics                L1 八口径聚合（P1-A：给已有 aggregateMetrics() 开门）
 * - GET /api/eval/chains?limit=&windowDays= 链路查询（P1-A：哪条链最长 / 卡在哪一跳）
 *
 * 返回 snake_case 原样出（前端直接消费 DB 行），错误 { error } + 4xx 钉死契约类型。
 * 纯展示 + 回标写入，零 LLM 调用。
 */
import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import {
  evalScores as evalScoresRepo,
  userFeedback as userFeedbackRepo,
  executionLogs as executionLogsRepo,
} from '../db/repository/index.js'
import { episodeStats } from '../eval/episodes.js'
import { aggregateMetrics, WINDOW_DAYS } from '../eval/l1-aggregator.js'
import { buildChains } from '../eval/chain-query.js'
import { createLogger } from '../logger.js'

const log = createLogger('eval-routes')

/** limit 必须是 1-200 的整数——前端传错静默回退会掩盖 bug，400 钉死 */
function parseLimit(raw: unknown): number | null {
  if (raw === undefined || raw === '') return 50
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 && n <= 200 ? n : null
}

/** 链路查询的取参：**越界钳位不报错**（契约冻结）——与 parseLimit 的 400 语义刻意不同。
 *  非数字（含 `?limit=abc`）回默认值，不静默当 0 用。 */
function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

export async function evalRoutes(app: FastifyInstance): Promise<void> {
  /** 最近评分列表（join agents 拿猫名；agent_id 可选过滤） */
  app.get('/api/eval/scores', async (req, reply) => {
    const { limit: rawLimit, agent_id } = req.query as { limit?: string; agent_id?: string }
    const limit = parseLimit(rawLimit)
    if (limit === null) {
      return reply.status(400).send({ error: 'limit must be an integer in 1..200' })
    }
    const agentId = typeof agent_id === 'string' && agent_id ? agent_id : null
    const scores = evalScoresRepo.listScores({ limit, agentId })
    return reply.send({ ok: true, scores })
  })

  /** 按猫聚合：count / avg_score / low_score_rate（≤2 占比） */
  app.get('/api/eval/aggregates', async (_req, reply) => {
    return reply.send({ ok: true, aggregates: evalScoresRepo.getAggregates() })
  })

  /**
   * 任务结局分布（E4-B 观察 tab 数据源，契约缺口裁决补充的唯二后端改动之一）。
   * 挂现成 episodeStats()：U 根/H 根 outcome 计数 + open + 版本偏差；
   * 办成率口径钉死前端算：(success + corrected_success) / Σ(uRoot 各 outcome 计数)，open 不计入分母。
   */
  app.get('/api/eval/episode-stats', async (_req, reply) => {
    return reply.send({ ok: true, stats: episodeStats() })
  })

  /**
   * L1 八口径聚合（P1-A）。
   *
   * 路径**必须**是 `l1-metrics`——`/api/eval/aggregates`（上方）已被 L2 按猫评分聚合占用，
   * 撞名会静默覆盖。
   *
   * **纯读**：只调 `aggregateMetrics()`，**不得**触发 `runL1Aggregation()` 的滞回状态机
   * 与告警投递——那是定时任务的事，被一次 GET 顺带触发 = 假告警。
   */
  app.get('/api/eval/l1-metrics', async (_req, reply) => {
    return reply.send({ windowDays: WINDOW_DAYS, ...aggregateMetrics() })
  })

  /**
   * 链路查询（P1-A）：按链锚 `COALESCE(回复.task_id, 触发.task_id)` 分组，
   * 回答「哪条链耗时最长 / 卡在哪一跳」。
   *
   * 取数归 repo、变换归 `eval/chain-query.ts` 纯函数，本路由只做「取数 → 调纯函数 → 返回」。
   * 字段级契约见 `docs/run/eval-system/P1-a-backend-chain-query.md`（P1-B 前端按此消费）。
   */
  app.get('/api/eval/chains', async (req, reply) => {
    const { limit: rawLimit, windowDays: rawWindow } = req.query as {
      limit?: string
      windowDays?: string
    }
    // 与 /scores 的 parseLimit 不同：**越界钳位不报错**（契约），limit 只截链不截跳
    const limit = clampInt(rawLimit, 20, 1, 100)
    const windowDays = clampInt(rawWindow, WINDOW_DAYS, 1, 3650)
    const slowMs = parseFloat(process.env.EVAL_CHAIN_SLOW_MS || '300000')
    const result = buildChains(executionLogsRepo.getExecutionHopsWithChainAnchor(windowDays), {
      slowMs,
      limit,
    })
    return reply.send({
      windowDays,
      anchor: 'coalesce(reply.task_id, trigger.task_id)',
      slowMs,
      ...result,
    })
  })

  /** 待回标样本：low_score 且无 user_feedback，每条附回复全文 + 前置最近 10 条上下文 */
  app.get('/api/eval/review/pending', async (_req, reply) => {
    const pending = evalScoresRepo.getPendingReviewScores().map((s) => ({
      ...s,
      context: evalScoresRepo.getContextBefore(s.session_id, s.reply_created_at, 10),
    }))
    return reply.send({ ok: true, pending })
  })

  /**
   * 提交回标：写 user_feedback + 翻转 eval_scores.sample_reason='user_feedback'。
   * 重复提交同一 eval_score_id → 覆盖 + log 留痕（契约钉死：不 409 拒绝）。
   */
  app.post('/api/eval/review/:evalScoreId', async (req, reply) => {
    const { evalScoreId } = req.params as { evalScoreId: string }
    if (!evalScoreId || typeof evalScoreId !== 'string') {
      return reply.status(400).send({ error: 'evalScoreId is required' })
    }
    const body = req.body as { score?: unknown; comment?: unknown } | null
    const score = body?.score
    // score 必须是 1-5 整数（前端 1-5 分单选）——string "3" 静默转 number 会掩盖前端 bug
    if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 5) {
      return reply.status(400).send({ error: 'score must be an integer in 1..5' })
    }
    if (body?.comment !== undefined && typeof body.comment !== 'string') {
      return reply.status(400).send({ error: 'comment must be a string' })
    }
    const existing = evalScoresRepo.getScoreById(evalScoreId)
    if (!existing) {
      return reply.status(404).send({ error: 'eval score not found' })
    }
    const covered = userFeedbackRepo.upsertFeedback({
      id: uuid(),
      evalScoreId,
      messageId: existing.message_id,
      sessionId: existing.session_id,
      userScore: score,
      comment: typeof body?.comment === 'string' && body.comment ? body.comment : null,
    })
    if (covered) {
      // 覆盖是契约钉死语义（不是错误），留痕供回溯：谁在什么时候覆盖了谁的评分
      log.warn('user feedback overwrote previous', {
        evalScoreId,
        previousScore: existing.score,
        newScore: score,
      })
    }
    evalScoresRepo.markSampleReason(evalScoreId, 'user_feedback')
    const feedback = userFeedbackRepo.getByEvalScoreId(evalScoreId)
    return reply.send({ ok: true, covered, feedback })
  })
}
