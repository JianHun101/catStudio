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

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

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

function formatLine(level: LogLevel, module: string, msg: string, meta?: LogMeta): string {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
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
