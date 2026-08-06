/**
 * 结构化日志工具。
 *
 * - JSON Lines 格式，每行一条日志
 * - 同时输出到 stdout 和文件（packages/server/data/cat-study.log）
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

function formatLine(level: LogLevel, module: string, msg: string, meta?: LogMeta): string {
  const entry: Record<string, unknown> = {
    ts: toLocalIso(new Date()),
    level,
    module,
    msg,
  }
  if (meta) {
    for (const [k, v] of Object.entries(meta)) {
      if (v !== undefined && v !== null) {
        entry[k] = v
      }
    }
  }
  return JSON.stringify(entry)
}

function writeLine(line: string): void {
  // stdout
  process.stdout.write(line + '\n')

  // file (best-effort)
  try {
    ensureLogDir()
    rotateLog()
    fs.appendFileSync(LOG_FILE, line + '\n')
  } catch {
    // 写文件失败不阻塞
  }
}

function logLine(level: LogLevel, module: string, msg: string, meta?: LogMeta): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return
  const line = formatLine(level, module, msg, meta)
  writeLine(line)
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
