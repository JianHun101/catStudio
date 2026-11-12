/**
 * 检索数量配置（topK）——设置页优先、`MEMORY_TOP_K` 回落、代码默认 3。
 *
 * 与 `config/eval-alert-config.ts` / `config/iron-laws.ts` 同款范式：运营参数进
 * settings 表，改完**下一轮检索**立即生效（检索链每次调用现读，不缓存），无需重启。
 *
 * 优先级（本模块是唯一判定点）：
 *   settings 表 `memory_top_k` → env `MEMORY_TOP_K` → 代码默认 `DEFAULT_TOP_K`
 *
 * 值域只对**写侧**（设置页 POST）生效：1..10 的整数。env 与直接写库的值仍按旧口径
 * 原样生效（`0` 会注入空集，`>10` 会被预算截断）——本票不改既有行为，只把写侧钉死。
 *
 * 读侧 fail-soft：DB 未就绪 / 存值损坏 / 越界一律回落下一档，不抛错——`currentRetrievalParams`
 * 可能在测试或启动早期、DB 尚未初始化的路径被调用。
 */
import { settings as settingsRepo } from '../db/repository/index.js'
import { envNumber } from '../env-number.js'

/** settings 表 key（存整数的十进制字符串） */
export const RETRIEVAL_TOP_K_SETTING_KEY = 'memory_top_k'

/** 代码默认值（与 `.env.example` / `memory/index.ts` 头注一致） */
export const DEFAULT_TOP_K = 3

/** 设置页写入范围：1..10 的整数（含端点） */
export const MIN_TOP_K = 1
export const MAX_TOP_K = 10

const DEFAULT_MAX_DISTANCE = 0.6

/** topK 的生效来源——设置页据此显示「设置 / 环境变量 / 默认」 */
export type RetrievalTopKSource = 'settings' | 'env' | 'default'

export interface RetrievalConfig {
  /** 本次实际生效的 topK（按节计名额） */
  topK: number
  /** 生效值来自哪一档 */
  topKSource: RetrievalTopKSource
  /** env 读数（未设置 / 空串 / 坏值 ⇒ null）；设置页用它回显回落值 */
  envTopK: number | null
  /** 代码默认值（常量，随响应返回避免前端再抄一份 3） */
  defaultTopK: number
  /** 检索距离阈值（只读回显；本票不开放配置） */
  maxDistance: number
}

/** 写侧校验：1..10 的整数。字符串 / 小数 / 越界一律 false（不做隐式换算） */
export function isValidTopK(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= MIN_TOP_K && value <= MAX_TOP_K
  )
}

/**
 * env 读数：未设置 / 空串 / 坏值 ⇒ null。
 *
 * 用 `envNumber` 而不是手写 `Number()`：坏值（如 `MEMORY_TOP_K=abc`）沿既有路径打
 * 一条 warn 并回退，避免本模块把 `envNumber` 的出声面绕过去。fallback 传 `NaN`
 * 是刻意的——`envNumber` 对「未设置」返回 fallback 且不出声，对坏值同样返回
 * fallback 但先打 warn；两种情况在这里都落成 `null`（= 没有可用的 env 值）。
 * 有效值照旧 `Math.trunc`，与 `currentRetrievalParams` 的整数语义一致。
 */
function readEnvTopK(): number | null {
  const parsed = envNumber('MEMORY_TOP_K', Number.NaN)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null
}

/**
 * settings 表读数：缺失 / 损坏 / 越界 ⇒ null。
 *
 * 越界值（含 0、11、1.5、非数字串）视为「没写过」，回落 env——读侧不因脏值报错，
 * 但也不会让脏值生效；写侧校验已经把这个口子堵住了，这里是防御历史脏行。
 */
function readStoredTopK(): number | null {
  try {
    const raw = settingsRepo.getSetting(RETRIEVAL_TOP_K_SETTING_KEY)
    if (raw === undefined) return null
    const parsed = Number(raw)
    return isValidTopK(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** 读生效配置：settings → env → 默认，并回报生效来源 */
export function getRetrievalConfig(): RetrievalConfig {
  const stored = readStoredTopK()
  const envTopK = readEnvTopK()
  const topK = stored ?? envTopK ?? DEFAULT_TOP_K
  const topKSource: RetrievalTopKSource =
    stored !== null ? 'settings' : envTopK !== null ? 'env' : 'default'

  return {
    topK,
    topKSource,
    envTopK,
    defaultTopK: DEFAULT_TOP_K,
    maxDistance: envNumber('MEMORY_MAX_DISTANCE', DEFAULT_MAX_DISTANCE),
  }
}

/**
 * 写 topK（调用方必须先校验；这里再守一道，防绕过路由直接调用把越界值写进库）。
 * 写后立即返回最新生效配置，调用方不必再读一次。
 */
export function setRetrievalTopK(topK: number): RetrievalConfig {
  if (!isValidTopK(topK)) {
    throw new RangeError(`topK must be an integer in ${MIN_TOP_K}..${MAX_TOP_K}`)
  }
  settingsRepo.setSetting(RETRIEVAL_TOP_K_SETTING_KEY, String(topK))
  return getRetrievalConfig()
}

/** 删 settings 行回落 env / 默认；缺失 key 幂等 no-op */
export function resetRetrievalTopK(): RetrievalConfig {
  settingsRepo.deleteSetting(RETRIEVAL_TOP_K_SETTING_KEY)
  return getRetrievalConfig()
}
