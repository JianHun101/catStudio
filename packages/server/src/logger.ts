/**
 * 结构化日志工具。
 *
 * - 双格式输出：stdout 人读格式（`LEVEL ts module msg {meta}`，TTY 下 ANSI 彩色；
 *   管道/重定向/测试捕获为同式样无色纯文本，零转义码）+
 *   文件 JSON Lines（packages/server/data/cat-study.log，机器/检索用，逐字节兼容）
 * - 文件超过 10MB 自动轮转（保留 1 个旧文件）
 * - 支持 traceId 请求追踪
 *
 * 环境变量（票 F1-c）:
 *   LOG_LEVEL — debug | info | warn | error（未设/非法 ⇒ debug，生产默认不变）
 *   LOG_FILE  — 日志文件路径覆盖；**测试专用**隔离通道（同 `RESTART_FILES_DIR` 范式），
 *               vitest `test.env` 指向 `node_modules/.cache/test-logs/`。未设 ⇒ 默认路径。
 *               ⚠️ 勿在 `.env` 里设它——那是把生产日志重定向走，排查时找不到文件的经典事故。
 *
 * 用法:
 *   import { createLogger } from './logger.js'
 *   const log = createLogger('dispatch')
 *   log.info('agent started', { agentId, traceId })
 *   log.error('llm failed', { agentId, error: err.message })
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** 默认日志目录（`packages/server/data`）——`LOG_FILE` 覆盖时以覆盖值为准 */
const LOG_DIR = path.join(__dirname, '..', 'data')
const LOG_FILE_NAME = 'cat-study.log'
const MAX_SIZE = 10 * 1024 * 1024 // 10MB

/**
 * 日志文件绝对路径（票 F1-c c1）。
 *
 * **每次写时解析**，不在模块顶层冻成常量：顶层常量会把「首次 import 那一刻的 env」
 * 钉死——测试无法按用例切换路径，且 import 顺序会变成隐式契约。
 * 未设 `LOG_FILE` ⇒ 默认路径，与改前**逐字节同路径**（生产语义不变）。
 */
export function resolveLogFile(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LOG_FILE?.trim()
  return override ? path.resolve(override) : path.join(LOG_DIR, LOG_FILE_NAME)
}

// ─── Log levels ─────────────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

/**
 * 解析级别字符串；未设 / 非法 ⇒ `'debug'`（= 模块初值的既有语义，生产默认不变）。
 * 非法值回落而非报错，与 `index.ts` 的 `setLogLevel(env.LOG_LEVEL as LogLevel)`
 * 在**可观察面上等价**（未知键 `LEVEL_ORDER[x]` 为 undefined，比较恒 false ⇒ 全放行）。
 */
function parseLogLevel(raw: string | undefined): LogLevel {
  return raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' ? raw : 'debug'
}

/**
 * 最低输出级别，低于此级别的日志静默丢弃。
 *
 * 票 F1-c c2：**模块初始化时读一次 env**。原先只有 `index.ts:122` 调 `setLogLevel`，
 * 而测试**不 import `index.ts`**（直接 import 被测模块）⇒ `minLevel` 恒停在 `'debug'`，
 * vitest 配置里写的 `LOG_LEVEL: 'error'` **从未生效**（实测硬证据：配置写着 error 的那轮
 * 仍落了一条 `"level":"debug"`）。生产语义不变——`index.ts` 仍会再设一次。
 */
let minLevel: LogLevel = parseLogLevel(process.env.LOG_LEVEL)

export function setLogLevel(level: LogLevel): void {
  minLevel = level
}

/** 当前最低输出级别（只读可观察面——让「级别到底是多少」不必靠副作用反推） */
export function getLogLevel(): LogLevel {
  return minLevel
}

// ─── File rotation ──────────────────────────────────

function rotateLog(file: string): void {
  try {
    if (fs.existsSync(file)) {
      const stat = fs.statSync(file)
      if (stat.size < MAX_SIZE) return

      const bak = file + '.1'
      if (fs.existsSync(bak)) fs.unlinkSync(bak)
      fs.renameSync(file, bak)
    }
  } catch {
    // 轮转失败不阻塞日志输出
  }
}

/** 目录取**该文件自己的** dirname（覆盖到别的目录时不再去建默认目录） */
function ensureLogDir(file: string): void {
  const dir = path.dirname(file)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

// ─── Core logger ────────────────────────────────────

interface LogMeta {
  traceId?: string
  [key: string]: unknown
}

/** 本地时区 ISO 时间（带偏移，如 2026-08-06T15:04:49.123+08:00）。
 *  JSON 可解析、可排序；DB 层保持 UTC 存储不动（数据层契约——记录时间由 repository 层
 *  生成、口径随 `db/repository/time.ts`，前端已本地化显示），日志层本地化便于人眼观察
 *  （用户需求：日志时间与时区匹配）。 */
function toLocalIso(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const offsetMin = -date.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
    `${String(date.getMilliseconds()).padStart(3, '0')}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

// ─── stdout 人读格式（彩色） ──────────────────────

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
} as const

/** 级别 → 四字母标签 + 着色码（INFO 默认白，无码） */
const LEVEL_STYLE: Record<LogLevel, { label: string; code: string }> = {
  debug: { label: 'DEBUG', code: ANSI.dim },
  info: { label: 'INFO', code: '' },
  warn: { label: 'WARN', code: ANSI.yellow },
  error: { label: 'ERROR', code: ANSI.red },
}

/** stdout 是否启用 ANSI 颜色：仅 TTY 且未设 NO_COLOR 时着色；
 *  管道/重定向/vitest 捕获走无色纯文本，零转义码（契约） */
function useColor(): boolean {
  return !!(process.stdout.isTTY && !process.env.NO_COLOR)
}

/** 过滤 undefined/null 字段——stdout 与文件两格式共用同一过滤语义 */
function sanitizeMeta(meta: LogMeta): Record<string, unknown> {
  const entry: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(meta)) {
    if (v !== undefined && v !== null) {
      entry[k] = v
    }
  }
  return entry
}

function formatStdout(level: LogLevel, module: string, msg: string, meta?: LogMeta): string {
  const style = LEVEL_STYLE[level]
  const ts = toLocalIso(new Date())
  const sanitized = meta ? sanitizeMeta(meta) : undefined
  const metaJson = sanitized && Object.keys(sanitized).length > 0 ? JSON.stringify(sanitized) : ''

  if (!useColor()) {
    // 无色路径：与彩色路径同式样纯文本（ts 与文件同格式可对齐 grep）
    return [style.label, ts, module, msg, metaJson].filter(Boolean).join(' ')
  }

  // 彩色路径：LEVEL 标签与 msg 按级别着色，ts dim、module 青、meta 默认色
  const paint = (s: string, code: string): string => (code ? `${code}${s}${ANSI.reset}` : s)
  return [
    paint(style.label, style.code),
    paint(ts, ANSI.dim),
    paint(module, ANSI.cyan),
    paint(msg, style.code),
    metaJson,
  ]
    .filter(Boolean)
    .join(' ')
}

function formatLine(level: LogLevel, module: string, msg: string, meta?: LogMeta): string {
  const entry: Record<string, unknown> = {
    ts: toLocalIso(new Date()),
    level,
    module,
    msg,
  }
  if (meta) {
    Object.assign(entry, sanitizeMeta(meta))
  }
  return JSON.stringify(entry)
}

function writeLine(level: LogLevel, module: string, msg: string, meta?: LogMeta): void {
  // stdout：人读格式（TTY 彩色 / 管道无色）
  process.stdout.write(formatStdout(level, module, msg, meta) + '\n')

  // file (best-effort)：JSON Lines 原格式（检索/排查用，逐字节兼容）
  try {
    const file = resolveLogFile()
    ensureLogDir(file)
    rotateLog(file)
    fs.appendFileSync(file, formatLine(level, module, msg, meta) + '\n')
  } catch {
    // 写文件失败不阻塞
  }
}

function logLine(level: LogLevel, module: string, msg: string, meta?: LogMeta): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return
  writeLine(level, module, msg, meta)
}

// ─── Public API ─────────────────────────────────────

export interface Logger {
  debug(msg: string, meta?: LogMeta): void
  info(msg: string, meta?: LogMeta): void
  warn(msg: string, meta?: LogMeta): void
  error(msg: string, meta?: LogMeta): void
}

export function createLogger(module: string): Logger {
  return {
    debug(msg, meta) {
      logLine('debug', module, msg, meta)
    },
    info(msg, meta) {
      logLine('info', module, msg, meta)
    },
    warn(msg, meta) {
      logLine('warn', module, msg, meta)
    },
    error(msg, meta) {
      logLine('error', module, msg, meta)
    },
  }
}
