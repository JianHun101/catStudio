/**
 * 评估告警阈值配置——settings 表优先、env 兜底、代码默认值再兜底。
 *
 * 与 `config/iron-laws.ts` 同款范式：运营参数进 settings 表，改完下一轮聚合
 * （最长 1 小时）自动生效，无需重启。值只存**显式改过的字段**（JSON），读时逐字段
 * `settings ?? env ?? 默认`——这样只改「审查判词门限」时，三条告警线仍跟 env 走，
 * 不会被冻结成写入那一刻的默认值。
 *
 * 单位：三条告警线是小数（0.3 = 30%，与 `context-config.json` 的 0.8/0.9 同款）；
 * 两个门限是条数整数。设置页显示百分比，换算只在 web 侧做，本模块只认小数。
 *
 * 读侧 fail-soft：settings 表未就绪 / JSON 损坏 / 字段越界一律回落 env，
 * 不抛错——`alertThresholds()` 可能在 DB 未就绪的测试路径被调用。
 */
import { settings as settingsRepo } from '../db/repository/index.js'
import { envNumber } from '../env-number.js'

/** settings 表 key（单行 JSON，值只含显式改过的字段） */
export const EVAL_ALERT_SETTING_KEY = 'eval_alert_config'

export type EvalAlertField =
  'successRate' | 'timeoutRate' | 'reworkRate' | 'minExecutions' | 'minVerdicts'

export interface EvalAlertConfig {
  /** 执行成功率低于此值破线 */
  successRate: number
  /** 超时率高于此值破线 */
  timeoutRate: number
  /** 返工率（suggest+reject 占审查结论比）高于此值破线 */
  reworkRate: number
  /** 成功率 / 超时率的最小执行样本数，不足则判「样本不足」不告警 */
  minExecutions: number
  /** 返工率的最小判词样本数，不足则判「样本不足」不告警 */
  minVerdicts: number
}

/** 每个字段的生效来源——设置页据此显示「已自定义」小标 */
export type EvalAlertSource = Record<EvalAlertField, 'settings' | 'env'>

export interface EvalAlertConfigResult {
  config: EvalAlertConfig
  source: EvalAlertSource
}

const FIELDS: readonly EvalAlertField[] = [
  'successRate',
  'timeoutRate',
  'reworkRate',
  'minExecutions',
  'minVerdicts',
]

const RATE_FIELDS = new Set<EvalAlertField>(['successRate', 'timeoutRate', 'reworkRate'])
const COUNT_FIELDS = new Set<EvalAlertField>(['minExecutions', 'minVerdicts'])

/** 代码默认值（env.ts 的 `??=` 与此一致；这里再兜一层，防调用方绕过 env.ts） */
const DEFAULTS: EvalAlertConfig = {
  successRate: 0.8,
  timeoutRate: 0.1,
  reworkRate: 0.3,
  minExecutions: 20,
  minVerdicts: 30,
}

/** 告警线：number、有限、开区间 (0,1)——写侧 400 判定（与读侧同源同义） */
function validRate(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1
}

/** 样本门限：条数整数，1..10000（含端点） */
function validCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 10000
}

/** env 兜底值：坏值由 env-number 出声并回退；门限再按整数区间收一次 */
function envConfig(): EvalAlertConfig {
  const minExecutions = Math.trunc(envNumber('EVAL_ALERT_MIN_EXECUTIONS', DEFAULTS.minExecutions))
  const minVerdicts = Math.trunc(envNumber('EVAL_ALERT_MIN_VERDICTS', DEFAULTS.minVerdicts))
  return {
    successRate: envNumber('EVAL_ALERT_SUCCESS_RATE', DEFAULTS.successRate),
    timeoutRate: envNumber('EVAL_ALERT_TIMEOUT_RATE', DEFAULTS.timeoutRate),
    reworkRate: envNumber('EVAL_ALERT_REWORK_RATE', DEFAULTS.reworkRate),
    minExecutions: validCount(minExecutions) ? minExecutions : DEFAULTS.minExecutions,
    minVerdicts: validCount(minVerdicts) ? minVerdicts : DEFAULTS.minVerdicts,
  }
}

/** 读 settings 原始 JSON——DB 未就绪 / 坏 JSON / 非对象一律返回空对象（fail-soft） */
function readStored(): Record<string, unknown> {
  try {
    const raw = settingsRepo.getSetting(EVAL_ALERT_SETTING_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

/** 读生效配置：逐字段 settings → env → 默认，并回报每字段来源 */
export function getEvalAlertConfig(): EvalAlertConfigResult {
  const base = envConfig()
  const stored = readStored()
  const config: EvalAlertConfig = { ...base }
  const source = {} as EvalAlertSource

  for (const field of FIELDS) {
    const v = stored[field]
    const ok = RATE_FIELDS.has(field) ? validRate(v) : validCount(v)
    if (ok) {
      config[field] = v as number
      source[field] = 'settings'
    } else {
      source[field] = 'env'
    }
  }

  return { config, source }
}

export type EvalAlertPatch = Partial<EvalAlertConfig>

export type EvalAlertPatchResult =
  { ok: true; value: EvalAlertPatch } | { ok: false; error: string }

/**
 * POST body 校验：至少一个已知字段，逐字段严格（不做隐式换算——传 80 而不是 0.8
 * 必须 400，自动除以 100 会掩盖前端单位 bug）。未知字段同样 400，防拼写错误被静默吞掉。
 */
export function validateEvalAlertPatch(body: unknown): EvalAlertPatchResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body is required' }
  }
  const entries = Object.entries(body as Record<string, unknown>)
  if (entries.length === 0) {
    return { ok: false, error: 'At least one field is required' }
  }
  const value: EvalAlertPatch = {}
  for (const [key, v] of entries) {
    if (!FIELDS.includes(key as EvalAlertField)) {
      return { ok: false, error: `Unknown field: ${key}` }
    }
    const field = key as EvalAlertField
    if (RATE_FIELDS.has(field)) {
      if (!validRate(v)) {
        return { ok: false, error: `${field} must be a number in (0, 1)` }
      }
    } else if (!validCount(v)) {
      return { ok: false, error: `${field} must be an integer in 1..10000` }
    }
    value[field] = v as number
  }
  return { ok: true, value }
}

/**
 * 写配置：只合并**显式传入**的字段，与既有 settings JSON 合并后 upsert。
 * 未传字段保持原样（若原本就不在 settings 里，则继续跟 env 走）。
 */
export function writeEvalAlertConfig(patch: EvalAlertPatch): EvalAlertConfigResult {
  const stored = readStored()
  const merged: Record<string, unknown> = { ...stored }
  for (const [key, v] of Object.entries(patch)) {
    if (v !== undefined) merged[key] = v
  }
  // 只保留已知字段——历史脏键不随本次写回扩散
  const clean: Record<string, unknown> = {}
  for (const field of FIELDS) {
    if (merged[field] !== undefined) clean[field] = merged[field]
  }
  settingsRepo.setSetting(EVAL_ALERT_SETTING_KEY, JSON.stringify(clean))
  return getEvalAlertConfig()
}
