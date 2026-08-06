/**
 * 结构化日志工具。
 *
 * - 双格式输出：stdout 人读格式（`LEVEL ts module msg {meta}`，TTY 下 ANSI 彩色；
 *   管道/重定向/测试捕获为同式样无色纯文本，零转义码）+
 *   文件 JSON Lines（packages/server/data/cat-study.log，机器/检索用，逐字节兼容）
 * - 文件超过 10MB 自动轮转（保留 1 个旧文件）
 * - 支持 traceId 请求追踪
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
const LOG_DIR = path.join(__dirname, '..', 'data')
const LOG_FILE = path.join(LOG_DIR, 'cat-study.log')
const MAX_SIZE = 10 * 1024 * 1024 // 10MB

// ─── Log levels ─────────────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

/** 最低输出级别，低于此级别的日志静默丢弃 */
let minLevel: LogLevel = 'debug'

export function setLogLevel(level: LogLevel): void {
  minLevel = level
}

// ─── File rotation ──────────────────────────────────

function rotateLog(): void {
  try {
    if (fs.existsSync(LOG_FILE)) {
      const stat = fs.statSync(LOG_FILE)
      if (stat.size < MAX_SIZE) return

      const bak = LOG_FILE + '.1'
      if (fs.existsSync(bak)) fs.unlinkSync(bak)
      fs.renameSync(LOG_FILE, bak)
    }
  } catch {
    // 轮转失败不阻塞日志输出
  }
}

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true })
  }
}

// ─── Core logger ────────────────────────────────────

interface LogMeta {
  traceId?: string
  [key: string]: unknown
}

/** 本地时区 ISO 时间（带偏移，如 2026-08-06T15:04:49.123+08:00）。
 *  JSON 可解析、可排序；DB 层 datetime('now') 保持 UTC 存储不动（数据层契约，
 *  前端已本地化显示），日志层本地化便于人眼观察（用户需求：日志时间与时区匹配）。 */
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
    ensureLogDir()
    rotateLog()
    fs.appendFileSync(LOG_FILE, formatLine(level, module, msg, meta) + '\n')
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
