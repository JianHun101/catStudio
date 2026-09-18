/**
 * W1 L1 聚合器 — 八口径指标聚合 + 滞回告警状态机 + 告警投递。
 *
 * 契约要点：
 * - 八口径：执行成功率 / 超时率 / 平均耗时 / token / suggest_rate / reject_rate /
 *   解析失败率 / infra 失败数（server_restart 桶单独报，不进成功率不进告警）
 * - 告警：滞回状态机 normal→alerting→normal，仅转换沿发「📊评估告警」（行首@店长，
 *   走既有消息通道：落库 + 房间广播 + mentions 写回）；恢复只记报告一行（log）
 * - 重启清空状态机（模块级内存态，重启后最多多发一条，接受）
 * - 阈值 env 化（env.ts ??= 默认值），30 天窗口聚合（未来切 p95 只改配置）
 */

import { v4 as uuid } from 'uuid'
import { getDb } from '../db/index.js'
import { sessions as sessionsRepo, messages as messagesRepo } from '../db/repository/index.js'
import { isoDaysAgo } from '../db/repository/clock.js'
import { createLogger } from '../logger.js'
import { messageOf } from '../utils.js'
import type { EngineBus, HandoffBus } from '../execution/bus.js'

const log = createLogger('l1-aggregator')

/** 聚合窗口（天）——告警口径基于近 30 天执行数据 */
export const WINDOW_DAYS = 30

// ─── 阈值（env.ts 已 ??= 默认值）───────────────────

export function alertThresholds(): {
  successRate: number
  timeoutRate: number
  reworkRate: number
} {
  return {
    successRate: parseFloat(process.env.EVAL_ALERT_SUCCESS_RATE || '0.8'),
    timeoutRate: parseFloat(process.env.EVAL_ALERT_TIMEOUT_RATE || '0.1'),
    reworkRate: parseFloat(process.env.EVAL_ALERT_REWORK_RATE || '0.3'),
  }
}

// ─── 聚合 ──────────────────────────────────────────

export interface L1Metrics {
  /** 执行成功率 completed/(completed+failed[error_type≠server_restart]) */
  successRate: number
  /** 超时率 timeout/(completed+failed[error_type≠server_restart]) */
  timeoutRate: number
  /** 平均耗时（completed 执行）ms */
  avgLatencyMs: number | null
  /** token 总量 prompt+completion */
  totalTokens: number
  /** suggest_rate suggest/verdicts */
  suggestRate: number
  /** reject_rate reject/verdicts */
  rejectRate: number
  /** 解析失败率 failures/(verdicts+failures) */
  parseFailureRate: number
  /** infra 失败数（server_restart 桶，单独报不进成功率） */
  infraFailures: number
  /** 样本量（successRate 分母）——空窗口时无意义，报出来供报告行使用 */
  sampleTotal: number
}

/**
 * 聚合近 30 天执行/审查数据为八口径。
 * error_type 存量行 NULL → COALESCE('unknown') 兜底（不回填，契约）。
 */
export function aggregateMetrics(): L1Metrics {
  const db = getDb()
  // execution_logs 无 created_at 列（建表只有 started_at/ended_at，insert 时已写 started_at）
  // ——时间窗用 started_at（含 infra 桶：按执行开始时间判窗——重启杀死的残留 running 行
  //    started_at 超窗则不计，infra 为信息性指标不进告警，接受此语义）；review 两表有 created_at，保持不动
  // （e82ff69 事故根因拆分：W1 一手引入夹具 created_at + windowCond 三表共用，致启动聚合必炸）
  // 窗口下界 = N 天前的 ISO 毫秒（⑤-b 连带改造点）：旧写法 `datetime('now','-N days')`
  // 产出**秒级**串，与 ISO 毫秒列比较是格式混比——同一天里 ISO 串首位 `T`(0x54) 恒大于
  // 秒级串首位空格(0x20) ⇒ 窗口静默放大。下界由 JS 侧算好后**内联为字面量**（值来自
  // `Date.now()`，非用户输入，无注入面）；同一时刻算一次、两处条件共用，防窗沿漂移。
  const windowStart = isoDaysAgo(WINDOW_DAYS)
  const execWindowCond = `WHERE started_at >= '${windowStart}'`
  const verdictWindowCond = `WHERE created_at >= '${windowStart}'`

  const execRow = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN status = 'failed' AND COALESCE(error_type, 'unknown') != 'server_restart' THEN 1 ELSE 0 END) AS failed_non_infra,
         SUM(CASE WHEN status = 'failed' AND COALESCE(error_type, 'unknown') = 'timeout' THEN 1 ELSE 0 END) AS timeouts,
         SUM(CASE WHEN status = 'failed' AND COALESCE(error_type, 'unknown') = 'server_restart' THEN 1 ELSE 0 END) AS infra_failures,
         AVG(CASE WHEN status = 'completed' THEN latency_ms END) AS avg_latency_ms,
         COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
         COALESCE(SUM(completion_tokens), 0) AS completion_tokens
       FROM execution_logs ${execWindowCond}`
    )
    .get() as {
    total: number
    completed: number
    failed_non_infra: number
    timeouts: number
    infra_failures: number
    avg_latency_ms: number | null
    prompt_tokens: number
    completion_tokens: number
  }

  const verdictRow = db
    .prepare(
      `SELECT
         COUNT(*) AS verdicts,
         SUM(CASE WHEN verdict = 'suggest' THEN 1 ELSE 0 END) AS suggests,
         SUM(CASE WHEN verdict = 'reject' THEN 1 ELSE 0 END) AS rejects
       FROM review_verdicts ${verdictWindowCond}`
    )
    .get() as { verdicts: number; suggests: number; rejects: number }

  const failureRow = db
    .prepare(`SELECT COUNT(*) AS failures FROM review_parse_failures ${verdictWindowCond}`)
    .get() as { failures: number }

  // 分母：completed + failed[≠server_restart]（infra 桶排除在成功率/超时率外）
  const sampleTotal = execRow.completed + execRow.failed_non_infra
  const successRate = sampleTotal > 0 ? execRow.completed / sampleTotal : 1
  const timeoutRate = sampleTotal > 0 ? execRow.timeouts / sampleTotal : 0
  const verdicts = verdictRow.verdicts
  const failures = failureRow.failures
  const parseTotal = verdicts + failures

  return {
    successRate,
    timeoutRate,
    avgLatencyMs: execRow.avg_latency_ms,
    totalTokens: execRow.prompt_tokens + execRow.completion_tokens,
    suggestRate: verdicts > 0 ? verdictRow.suggests / verdicts : 0,
    rejectRate: verdicts > 0 ? verdictRow.rejects / verdicts : 0,
    parseFailureRate: parseTotal > 0 ? failures / parseTotal : 0,
    infraFailures: execRow.infra_failures,
    sampleTotal,
  }
}

// ─── 滞回状态机 ────────────────────────────────────

type AlertState = 'normal' | 'alerting'

/** 模块级内存态——重启天然清空（重启后最多多发一条，契约接受） */
let alertState: AlertState = 'normal'

/** 测试钩子：重置状态机（生产路径不调用） */
export function __test_resetAlertState(): void {
  alertState = 'normal'
}

/** 破线判定结果：broken 非空 = 需告警 */
function evaluateBreaches(m: L1Metrics, t: ReturnType<typeof alertThresholds>): string[] {
  const broken: string[] = []
  if (m.successRate < t.successRate) {
    broken.push(
      `执行成功率 ${(m.successRate * 100).toFixed(1)}%（< ${(t.successRate * 100).toFixed(0)}%）`
    )
  }
  if (m.timeoutRate > t.timeoutRate) {
    broken.push(
      `超时率 ${(m.timeoutRate * 100).toFixed(1)}%（> ${(t.timeoutRate * 100).toFixed(0)}%）`
    )
  }
  const reworkRate = m.suggestRate + m.rejectRate
  if (reworkRate > t.reworkRate) {
    broken.push(`返工率 ${(reworkRate * 100).toFixed(1)}%（> ${(t.reworkRate * 100).toFixed(0)}%）`)
  }
  return broken
}

/** 格式化为报告行（恢复/调试用，只记 log 不投递） */
function formatReportLine(m: L1Metrics): string {
  return [
    `成功率 ${(m.successRate * 100).toFixed(1)}%`,
    `超时率 ${(m.timeoutRate * 100).toFixed(1)}%`,
    `平均耗时 ${m.avgLatencyMs ? `${Math.round(m.avgLatencyMs)}ms` : '—'}`,
    `token ${m.totalTokens}`,
    `suggest ${(m.suggestRate * 100).toFixed(1)}%`,
    `reject ${(m.rejectRate * 100).toFixed(1)}%`,
    `解析失败率 ${(m.parseFailureRate * 100).toFixed(1)}%`,
    `infra 失败 ${m.infraFailures}`,
    `样本 ${m.sampleTotal}`,
  ].join(' / ')
}

/**
 * 告警投递：对每个存在的会话落库 + 房间广播（system 消息，mentions=['店长'] 写回——
 * 上下文过滤只对店长可见；与 agent 回复的落库后写回不同，系统告警一次落库带全）。
 * per-session 防御：单会话 FK 失败（会话并发删除）不 abort 其余会话。
 */
function broadcastAlert(bus: EngineBus & HandoffBus, broken: string[]): void {
  const content = `@店长 📊评估告警（近 ${WINDOW_DAYS} 天）：${broken.join('、')}，请关注猫咖运行状态`
  const sessions = sessionsRepo.listAllSessions()
  for (const s of sessions) {
    try {
      const msgId = uuid()
      messagesRepo.insertMessage(
        msgId,
        s.id,
        'system',
        content,
        JSON.stringify(['店长']),
        null,
        null
      )
      bus.emitSystemNotice({
        id: msgId,
        sessionId: s.id,
        agentId: null,
        content,
        mentions: ['店长'],
        createdAt: new Date().toISOString(),
      })
      log.warn('L1 评估告警已投递', { sessionId: s.id, broken })
    } catch (err: any) {
      // 单会话投递失败只留痕（会话已删等 FK 场景）
      log.warn('L1 评估告警投递失败（跳过该会话）', { sessionId: s.id, error: messageOf(err) })
    }
  }
}

/**
 * 执行一轮 L1 聚合 + 滞回判定。
 * 定时器（index.ts 每小时）调用；也可测试直接调用。
 * 返回值供测试断言：本次是否触发告警/恢复。
 */
export function runL1Aggregation(bus: EngineBus & HandoffBus): {
  alert: boolean
  recovered: boolean
} {
  const metrics = aggregateMetrics()
  const thresholds = alertThresholds()
  const broken = evaluateBreaches(metrics, thresholds)

  if (alertState === 'normal' && broken.length > 0) {
    // normal → alerting：转换沿发告警
    alertState = 'alerting'
    broadcastAlert(bus, broken)
    log.warn('L1 告警进入 alerting', { broken })
    return { alert: true, recovered: false }
  }

  if (alertState === 'alerting' && broken.length === 0) {
    // alerting → normal：恢复只记报告一行（不投递）
    alertState = 'normal'
    log.info('L1 评估指标恢复', { report: formatReportLine(metrics) })
    return { alert: false, recovered: true }
  }

  // 无转换沿：alerting 持续破线（滞回去重，不刷屏）/ normal 健康（静默）
  if (alertState === 'alerting') {
    log.warn('L1 告警持续中（滞回不重复投递）', { broken })
  }
  return { alert: false, recovered: false }
}
