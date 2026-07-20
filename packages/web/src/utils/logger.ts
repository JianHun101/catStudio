/**
 * 浏览器端轻量日志工具。
 *
 * - 开发环境：输出到 console
 * - 生产环境：静默（避免泄露调试信息）
 * - 接口与 server 端 createLogger 对齐（debug/info/warn/error）
 *
 * 用法:
 *   import { createLogger } from '@/utils/logger'
 *   const log = createLogger('socket')
 *   log.info('connected', { id: socket.id })
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const noop = () => {}

function createLogger(module: string) {
  const prefix = `[${module}]`

  if (import.meta.env.PROD) {
    return {
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
    }
  }

  return {
    debug(msg: string, meta?: Record<string, unknown>) {
      console.debug(prefix, msg, meta ?? '')
    },
    info(msg: string, meta?: Record<string, unknown>) {
      console.info(prefix, msg, meta ?? '')
    },
    warn(msg: string, meta?: Record<string, unknown>) {
      console.warn(prefix, msg, meta ?? '')
    },
    error(msg: string, meta?: Record<string, unknown>) {
      console.error(prefix, msg, meta ?? '')
    },
  }
}

export { createLogger }
export type { LogLevel }
