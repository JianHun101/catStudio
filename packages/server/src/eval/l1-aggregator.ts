/**
 * W1 L1 聚合器 — 八口径指标聚合 + 滞回告警状态机。
 *
 * 契约要点：
 * - 八口径：执行成功率 / 超时率 / 平均耗时 / token / suggest_rate / reject_rate /
 *   解析失败率 / infra 失败数（server_restart 桶单独报，不进成功率不进告警）
 * - **投递形态（2026-11 起）**：告警**不落会话、不广播**。聚合结果由
 *   `GET /api/eval/l1-metrics` 供评估中心与全局横幅（`EvalAlertBanner.vue`）读取；
 *   定时器只负责滞回状态机与日志留痕。旧「每会话落一条 system 消息」已整体退役。
 * - **样本门**：成功率/超时率需 ≥ `minExecutions` 条执行样本、返工率需 ≥ `minVerdicts`
 *   条判词样本才参与判定；不足时进 `insufficient`（只记 debug，不告警、不改状态机）。
 * - 告警：滞回状态机 normal→alerting→normal，转换沿只记日志；恢复只记报告一行
 * - 重启清空状态机（模块级内存态，重启后最多多发一条，接受）
 * - 阈值 settings 表优先、env 兜底（`config/eval-alert-config.ts`），改完下一轮聚合
 *   生效，无需重启；30 天窗口聚合（未来切 p95 只改配置）
 */

import { getDb } from '../db/index.js'
import { isoDaysAgo } from '../db/repository/clock.js'
import { createLogger } from '../logger.js'
import { getEvalAlertConfig } from '../config/eval-alert-config.js'

const log = createLogger('l1-aggregator')

/** 聚合窗口（天）——告警口径基于近 30 天执行数据 */
export const WINDOW_DAYS = 30

// ─── 阈值（settings 优先、env 兜底）────────────────

export interface AlertThresholds {
  successRate: number
  timeoutRate: number
  reworkRate: number
  minExecutions: number
  minVerdicts: number
}

export function alertThresholds(): AlertThresholds {
  return getEvalAlertConfig().config
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
  /** 执行样本量（successRate 分母）——空窗口时无意义，报出来供报告行使用 */
  sampleTotal: number
  /** 审查判词样本量（返工率分母）——样本门的第二个分母 */
  verdictTotal: number
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
    verdictTotal: verdicts,
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

export type ThresholdKey = 'successRate' | 'timeoutRate' | 'reworkRate'

/** 一条破线 / 样本不足读数——text 直接供横幅与评估中心展示 */
export interface ThresholdBreach {
  key: ThresholdKey
  value: number
  threshold: number
  text: string
}

export interface BreachEvaluation {
  /** 够格且破线——驱动状态机与告警 */
  broken: ThresholdBreach[]
  /** 样本不足——只记 debug，不告警、不改状态机 */
  insufficient: ThresholdBreach[]
}

/**
 * 破线判定 + 样本门。
 *
 * 成功率/超时率共用一个执行分母 `sampleTotal`，返工率用审查分母 `verdictTotal`；
 * 分母不足时对应告警线一律进 `insufficient`，**不参与比较**——16 条判词算出的
 * 37.5% 与 30 条判词算出的 37.5% 不是同一个量级的证据，混在一起会让告警在
 * 小样本上反复翻转。
 */
export function evaluateBreaches(m: L1Metrics, t: AlertThresholds): BreachEvaluation {
  const broken: ThresholdBreach[] = []
  const insufficient: ThresholdBreach[] = []

  if (m.sampleTotal < t.minExecutions) {
    insufficient.push(
      {
        key: 'successRate',
        value: m.sampleTotal,
        threshold: t.minExecutions,
        text: `执行成功率样本不足（${m.sampleTotal} < ${t.minExecutions} 条执行）`,
      },
      {
        key: 'timeoutRate',
        value: m.sampleTotal,
        threshold: t.minExecutions,
        text: `超时率样本不足（${m.sampleTotal} < ${t.minExecutions} 条执行）`,
      }
    )
  } else {
    if (m.successRate < t.successRate) {
      broken.push({
        key: 'successRate',
        value: m.successRate,
        threshold: t.successRate,
        text: `执行成功率 ${(m.successRate * 100).toFixed(1)}%（< ${(t.successRate * 100).toFixed(0)}%）`,
      })
    }
    if (m.timeoutRate > t.timeoutRate) {
      broken.push({
        key: 'timeoutRate',
        value: m.timeoutRate,
        threshold: t.timeoutRate,
        text: `超时率 ${(m.timeoutRate * 100).toFixed(1)}%（> ${(t.timeoutRate * 100).toFixed(0)}%）`,
      })
    }
  }

  const reworkRate = m.suggestRate + m.rejectRate
  if (m.verdictTotal < t.minVerdicts) {
    insufficient.push({
      key: 'reworkRate',
      value: m.verdictTotal,
      threshold: t.minVerdicts,
      text: `返工率样本不足（${m.verdictTotal} < ${t.minVerdicts} 条判词）`,
    })
  } else if (reworkRate > t.reworkRate) {
    broken.push({
      key: 'reworkRate',
      value: reworkRate,
      threshold: t.reworkRate,
      text: `返工率 ${(reworkRate * 100).toFixed(1)}%（> ${(t.reworkRate * 100).toFixed(0)}%）`,
    })
  }

  return { broken, insufficient }
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
    `执行样本 ${m.sampleTotal}`,
    `判词样本 ${m.verdictTotal}`,
  ].join(' / ')
}

/**
 * 执行一轮 L1 聚合 + 滞回判定。
 * 定时器（index.ts 每小时）调用；也可测试直接调用。
 * **不落库、不广播**——结果由 `/api/eval/l1-metrics` 读，返回值供测试断言。
 */
export function runL1Aggregation(): {
  alert: boolean
  recovered: boolean
  broken: ThresholdBreach[]
  insufficient: ThresholdBreach[]
} {
  const metrics = aggregateMetrics()
  const thresholds = alertThresholds()
  const { broken, insufficient } = evaluateBreaches(metrics, thresholds)

  // 样本不足只留 debug：它不改变状态机，但排障时要能看出「为什么没告警」
  if (insufficient.length > 0) {
    log.debug('L1 告警样本不足（不判定）', { insufficient: insufficient.map((b) => b.text) })
  }

  if (alertState === 'normal' && broken.length > 0) {
    // normal → alerting：转换沿记日志（告警面由 l1-metrics 读出）
    alertState = 'alerting'
    log.warn('L1 告警进入 alerting', { broken: broken.map((b) => b.text) })
    return { alert: true, recovered: false, broken, insufficient }
  }

  if (alertState === 'alerting' && broken.length === 0) {
    // alerting → normal：恢复只记报告一行
    alertState = 'normal'
    log.info('L1 评估指标恢复', { report: formatReportLine(metrics) })
    return { alert: false, recovered: true, broken, insufficient }
  }

  // 无转换沿：alerting 持续破线（滞回去重，不刷屏）/ normal 健康（静默）
  if (alertState === 'alerting') {
    log.warn('L1 告警持续中（滞回不重复告警）', { broken: broken.map((b) => b.text) })
  }
  return { alert: false, recovered: false, broken, insufficient }
}
