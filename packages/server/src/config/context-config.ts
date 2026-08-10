/**
 * 上下文阈值配置（context-config.json）——80% 告警线 / 90% 交接触发线的共享配置源。
 *
 * 设计：与 .napcat-config.json 同机制——JSON 文件 + 读缺省容错 + 原子写。
 * - 消费者：server 进程内两个点——routes/config.ts（GET/POST 读写）、handoff shouldHandoff（只读）。
 *   无跨包读点（dev.js 不读），故用 RESTART_FILES_DIR ?? cwd 定位即可（pnpm dev 时 cwd=ROOT，
 *   与 napcatConfigFile 同款——函数内动态求值而非模块顶层常量，测试可 vi.stubEnv 即时隔离）。
 * - 读失败 = 默认值（0.8 / 0.9）：配置缺失不是错误态，告警/交接必须永远有值可判
 * - 写 = 临时文件 + rename 原子替换：防写一半崩溃留下坏 JSON（下次读走容错，但别制造坏文件）
 * - 值域校验读侧也做：坏值（手工编辑 1.5 等）= 缺失 → 默认值——「坏值永不进入生效路径」，
 *   与写侧 400 是同一哲学的两面
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export interface ContextConfig {
  warnThreshold: number
  handoffThreshold: number
}

export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  warnThreshold: 0.8,
  handoffThreshold: 0.9,
}

/** context-config.json 定位——与 napcatConfigFile 同款 RESTART_FILES_DIR ?? cwd（测试隔离现成） */
export function contextConfigFile(): string {
  return resolve(process.env.RESTART_FILES_DIR ?? process.cwd(), 'context-config.json')
}

/** 阈值合法性：number、有限、开区间 (0,1)。写侧 400 与读侧「坏值=缺失」共用同一判定 */
function validThreshold(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1
}

/**
 * 读原始配置——文件缺失/坏 JSON 返回 null（调用方决定降级路径）。
 * 字段级容错：某个字段非合法 number → 该字段 undefined，其余字段照常返回。
 * shouldHandoff 用它实现「文件优先、env 兜底」——必须能区分「文件没写该字段」与「缺文件」。
 */
export function readRawContextConfig(): Partial<ContextConfig> | null {
  try {
    const file = contextConfigFile()
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    const out: Partial<ContextConfig> = {}
    if (validThreshold(parsed.warnThreshold)) out.warnThreshold = parsed.warnThreshold
    if (validThreshold(parsed.handoffThreshold)) out.handoffThreshold = parsed.handoffThreshold
    return out
  } catch {
    return null
  }
}

/** 读生效配置——缺省填充（routes GET 用，保证返回全量；坏值 = 缺失 = 默认） */
export function readContextConfig(): ContextConfig {
  const raw = readRawContextConfig()
  return {
    warnThreshold: raw?.warnThreshold ?? DEFAULT_CONTEXT_CONFIG.warnThreshold,
    handoffThreshold: raw?.handoffThreshold ?? DEFAULT_CONTEXT_CONFIG.handoffThreshold,
  }
}

/**
 * 原子写配置——临时文件 + rename 替换，返回落盘值（调用方已校验过 0<t<1 且 warn≤handoff）。
 * 遗留 tmp 文件（进程恰在写与 rename 之间崩溃）由下次写覆盖，不清理（无读影响）。
 */
export function writeContextConfig(config: ContextConfig): ContextConfig {
  const file = contextConfigFile()
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify({ ...config, updatedAt: new Date().toISOString() }, null, 2))
  renameSync(tmp, file)
  return { ...config }
}
