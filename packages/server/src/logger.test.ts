import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'node:path'

/** 默认日志路径（与 `logger.ts` 同一算法——`__dirname` 两边同目录，可直接对齐） */
const DEFAULT_LOG_FILE = path.join(__dirname, '..', 'data', 'cat-study.log')

// 捕获文件写入（appendFileSync），隔离真实文件系统副作用
const { appendFileSyncMock } = vi.hoisted(() => ({ appendFileSyncMock: vi.fn() }))

vi.mock('node:fs', () => ({
  default: {
    existsSync: () => false,
    mkdirSync: () => {},
    statSync: () => ({ size: 0 }),
    appendFileSync: appendFileSyncMock,
  },
}))

/** 覆盖 process.stdout.isTTY（vitest 环境默认非 TTY），返回恢复函数 */
function mockIsTTY(value: boolean): () => void {
  const original = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value })
  return () => {
    if (original) Object.defineProperty(process.stdout, 'isTTY', original)
    else delete (process.stdout as { isTTY?: boolean }).isTTY
  }
}

/** 调用一次 logger 并抓取 stdout 输出行 */
function captureStdout(
  loggerModule: typeof import('./logger.js'),
  level: 'debug' | 'info' | 'warn' | 'error',
  msg: string,
  meta?: Record<string, unknown>
): string {
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    loggerModule.createLogger('color-test')[level](msg, meta)
    // write 捕获含行尾 \n，trim 掉便于锚定断言
    return writeSpy.mock.calls
      .map((c: any[]) => c[0])
      .join('')
      .trim()
  } finally {
    writeSpy.mockRestore()
  }
}

// 直接 import 会触发模块加载，logger 导入 fs，需要先 mock
// 使用动态 import 来隔离
describe('logger', () => {
  let loggerModule: typeof import('./logger.js')

  beforeEach(async () => {
    vi.resetModules()
    // 重新导入以获取干净的模块状态
    loggerModule = await import('./logger.js')
    // 重置 log level
    loggerModule.setLogLevel('debug')
    appendFileSyncMock.mockClear()
    delete process.env.NO_COLOR
  })

  describe('createLogger', () => {
    it('returns an object with debug/info/warn/error methods', () => {
      const log = loggerModule.createLogger('test-module')
      expect(typeof log.debug).toBe('function')
      expect(typeof log.info).toBe('function')
      expect(typeof log.warn).toBe('function')
      expect(typeof log.error).toBe('function')
    })
  })

  describe('setLogLevel', () => {
    it('filters out messages below min level', () => {
      // 设置为 error，则 debug/info/warn 都应被静默
      loggerModule.setLogLevel('error')

      const log = loggerModule.createLogger('test')
      // 不应抛出异常——静默丢弃
      expect(() => {
        log.debug('should be filtered')
        log.info('should be filtered')
        log.warn('should be filtered')
        log.error('should be printed')
      }).not.toThrow()
    })

    it('allows all messages at debug level', () => {
      loggerModule.setLogLevel('debug')
      const log = loggerModule.createLogger('test')
      expect(() => {
        log.debug('ok')
        log.info('ok')
        log.warn('ok')
        log.error('ok')
      }).not.toThrow()
    })
  })

  describe('Logger methods', () => {
    it('accepts meta object with traceId', () => {
      loggerModule.setLogLevel('debug')
      const log = loggerModule.createLogger('test')
      expect(() => {
        log.info('test message', { traceId: 'abc-123', extra: 'data' })
      }).not.toThrow()
    })

    it('accepts no meta argument', () => {
      loggerModule.setLogLevel('debug')
      const log = loggerModule.createLogger('test')
      expect(() => {
        log.info('plain message')
      }).not.toThrow()
    })
  })

  describe('ts 本地时区格式', () => {
    it('日志时间带本地时区偏移（如 +08:00），可解析且绝对时间不变', () => {
      const line = captureStdout(loggerModule, 'info', 'timezone check')
      // stdout 人读格式：INFO <ts> color-test timezone check
      const ts = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}/)?.[0]
      expect(ts).toBeTruthy()
      // 偏移与机器本地时区一致
      const offsetMin = -new Date().getTimezoneOffset()
      const sign = offsetMin >= 0 ? '+' : '-'
      const abs = Math.abs(offsetMin)
      const expectedSuffix = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
      expect(ts!.endsWith(expectedSuffix)).toBe(true)
      // 本地化不改变绝对时间点（±500ms 内）
      expect(new Date(ts!).getTime()).toBeCloseTo(Date.now(), -3)
    })
  })

  describe('stdout 彩色 / 无色', () => {
    it('TTY 下 WARN/ERROR/DEBUG 按级别着色，module 青色', () => {
      const restore = mockIsTTY(true)
      try {
        expect(captureStdout(loggerModule, 'warn', 'boom')).toContain('\x1b[33mWARN\x1b[0m')
        expect(captureStdout(loggerModule, 'error', 'fatal')).toContain('\x1b[31mERROR\x1b[0m')
        const debugLine = captureStdout(loggerModule, 'debug', 'trace')
        expect(debugLine).toContain('\x1b[2mDEBUG\x1b[0m')
        expect(debugLine).toContain('\x1b[36mcolor-test\x1b[0m')
      } finally {
        restore()
      }
    })

    it('INFO 默认白不包色码，但 ts dim、module 青仍着色', () => {
      const restore = mockIsTTY(true)
      try {
        const line = captureStdout(loggerModule, 'info', 'plain')
        expect(line).not.toMatch(/\x1b\[\d+mINFO\x1b\[0m/)
        expect(line).toContain('\x1b[2m') // ts dim
        expect(line).toContain('\x1b[36mcolor-test\x1b[0m')
      } finally {
        restore()
      }
    })

    it('非 TTY（管道/重定向）零转义码，同式样纯文本且 meta 尾随', () => {
      const restore = mockIsTTY(false)
      try {
        const line = captureStdout(loggerModule, 'warn', 'pipe me', { traceId: 't-1' })
        expect(line).not.toContain('\x1b')
        expect(line).toMatch(
          /^WARN \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2} color-test pipe me \{"traceId":"t-1"\}$/
        )
      } finally {
        restore()
      }
    })

    it('NO_COLOR 覆盖 TTY：设了 NO_COLOR 也不输出转义码', () => {
      const restore = mockIsTTY(true)
      process.env.NO_COLOR = '1'
      try {
        expect(captureStdout(loggerModule, 'error', 'muted')).not.toContain('\x1b')
      } finally {
        restore()
      }
    })

    it('彩色路径 meta 尾随且不包色码', () => {
      const restore = mockIsTTY(true)
      try {
        const line = captureStdout(loggerModule, 'error', 'with meta', { traceId: 't-2' })
        expect(line).toContain('{"traceId":"t-2"}')
        expect(line.endsWith('{"traceId":"t-2"}')).toBe(true)
      } finally {
        restore()
      }
    })
  })

  describe('文件 JSON Lines', () => {
    it('文件输出每行可 JSON.parse，字段与旧格式一致', () => {
      loggerModule.createLogger('file-test').warn('to file', { traceId: 'abc' })
      const last = appendFileSyncMock.mock.calls[appendFileSyncMock.mock.calls.length - 1]
      expect(last).toBeTruthy()
      const line = String(last[1]).trim()
      const entry = JSON.parse(line)
      expect(entry).toMatchObject({
        level: 'warn',
        module: 'file-test',
        msg: 'to file',
        traceId: 'abc',
      })
      expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/)
    })

    it('文件行过滤 undefined/null 字段（旧行为保持）', () => {
      loggerModule.createLogger('file-test').info('filtered', { a: 1, b: undefined, c: null })
      const entry = JSON.parse(String(appendFileSyncMock.mock.calls[0][1]))
      expect(entry.a).toBe(1)
      expect('b' in entry).toBe(false)
      expect('c' in entry).toBe(false)
    })
  })

  // ─── 票 F1-c c1：日志文件路径 env 覆盖 ────────────────
  //
  // 本文件已 mock `node:fs`，故「落盘」断言走 `appendFileSync` 的**第一实参**——
  // 目标路径正是 c1 的被测面（改前该值恒为 `packages/server/data/cat-study.log`）。
  // 「跑完全套生产日志零增量」是行为面验收，见票 §四 第 6 条（跑批实测，非单测）。

  describe('F1-c c1 LOG_FILE 路径覆盖', () => {
    afterEach(() => vi.unstubAllEnvs())

    it('未设 / 空白 ⇒ 目标路径仍是 packages/server/data/cat-study.log（生产语义不变）', () => {
      vi.stubEnv('LOG_FILE', '')
      loggerModule.createLogger('f1c').error('默认路径')
      const file = String(appendFileSyncMock.mock.calls.at(-1)![0])
      expect(file).toBe(DEFAULT_LOG_FILE)
    })

    it('设了 ⇒ 目标路径 = 覆盖值（相对路径按 cwd 解析）', () => {
      vi.stubEnv('LOG_FILE', 'node_modules/.cache/test-logs/cat-study-test.log')
      loggerModule.createLogger('f1c').error('隔离路径')
      const file = String(appendFileSyncMock.mock.calls.at(-1)![0])
      expect(file).toBe(path.resolve('node_modules/.cache/test-logs/cat-study-test.log'))
      expect(file).not.toBe(DEFAULT_LOG_FILE)
    })

    it('路径**每次写时**解析，不是模块顶层冻死的常量', () => {
      vi.stubEnv('LOG_FILE', path.join('tmp', 'a.log'))
      loggerModule.createLogger('f1c').error('first')
      vi.stubEnv('LOG_FILE', path.join('tmp', 'b.log'))
      loggerModule.createLogger('f1c').error('second')

      const calls = appendFileSyncMock.mock.calls
      expect(String(calls.at(-2)![0])).toBe(path.resolve('tmp/a.log'))
      expect(String(calls.at(-1)![0])).toBe(path.resolve('tmp/b.log'))
    })

    it('resolveLogFile 是纯映射（未设/空白/相对/绝对）', () => {
      expect(loggerModule.resolveLogFile({})).toBe(DEFAULT_LOG_FILE)
      expect(loggerModule.resolveLogFile({ LOG_FILE: '   ' })).toBe(DEFAULT_LOG_FILE)
      expect(loggerModule.resolveLogFile({ LOG_FILE: 'rel/x.log' })).toBe(path.resolve('rel/x.log'))
      const abs = path.resolve('abs', 'x.log') // 已绝对 ⇒ 原样返回（不再叠 cwd）
      expect(loggerModule.resolveLogFile({ LOG_FILE: abs })).toBe(abs)
    })
  })

  // ─── 票 F1-c c2：LOG_LEVEL 在**模块初始化**时生效 ──────
  //
  // 改前的死法：`setLogLevel` 全仓只在 `index.ts:122` 调用，而测试**不 import `index.ts`**
  // （直接 import 被测模块）⇒ `minLevel` 恒停在模块初值 `'debug'`，vitest 配置里写的
  // `LOG_LEVEL: 'error'` **从未被应用**。硬证据：配置写着 error 的那轮仍落了一条
  // `"level":"debug"` 的嵌入降级行。

  describe('F1-c c2 LOG_LEVEL 初始即生效', () => {
    afterEach(() => vi.unstubAllEnvs())

    it('vitest env 的 LOG_LEVEL=error 真的被模块初始化读到（改前恒为 debug）', async () => {
      // 前置：本套跑批确实注入了 LOG_LEVEL=error（否则本用例会**空转通过**）
      expect(process.env.LOG_LEVEL).toBe('error')
      vi.resetModules()
      vi.stubEnv('LOG_LEVEL', 'error')
      const fresh = await import('./logger.js')
      expect(fresh.getLogLevel()).toBe('error')
    })

    it('未设 ⇒ 默认 debug（生产默认不变）', async () => {
      vi.resetModules()
      vi.stubEnv('LOG_LEVEL', '')
      const fresh = await import('./logger.js')
      expect(fresh.getLogLevel()).toBe('debug')
    })

    it('设 info ⇒ 初始化即 info（不必再等 index.ts 设一次）', async () => {
      vi.resetModules()
      vi.stubEnv('LOG_LEVEL', 'info')
      const fresh = await import('./logger.js')
      expect(fresh.getLogLevel()).toBe('info')
    })

    it('非法值 ⇒ 回落 debug（不炸，也不落进「未知键全放行」）', async () => {
      vi.resetModules()
      vi.stubEnv('LOG_LEVEL', 'bogus')
      const fresh = await import('./logger.js')
      expect(fresh.getLogLevel()).toBe('debug')
    })

    it('setLogLevel 仍可改级别（index.ts 的调用点不动）', () => {
      loggerModule.setLogLevel('warn')
      expect(loggerModule.getLogLevel()).toBe('warn')
    })
  })
})
