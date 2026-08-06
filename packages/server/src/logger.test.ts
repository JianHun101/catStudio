import { describe, it, expect, vi, beforeEach } from 'vitest'

// 模拟 formatLine 和 writeLine，隔离文件系统副作用
const writeLineSpy = vi.fn()

vi.mock('node:fs', () => ({
  default: {
    existsSync: () => false,
    mkdirSync: () => {},
    statSync: () => ({ size: 0 }),
    appendFileSync: () => {},
  },
}))

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
    it('日志时间带本地时区偏移（如 +08:00），可解析且绝对时间不变', async () => {
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      try {
        loggerModule.createLogger('tz-test').info('timezone check')
        const line = writeSpy.mock.calls.map((c: any[]) => c[0]).join('')
        const entry = JSON.parse(line)
        expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/)
        // 偏移与机器本地时区一致
        const offsetMin = -new Date().getTimezoneOffset()
        const sign = offsetMin >= 0 ? '+' : '-'
        const abs = Math.abs(offsetMin)
        const expectedSuffix = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
        expect(entry.ts.endsWith(expectedSuffix)).toBe(true)
        // 本地化不改变绝对时间点（±500ms 内）
        expect(new Date(entry.ts).getTime()).toBeCloseTo(Date.now(), -3)
      } finally {
        writeSpy.mockRestore()
      }
    })
  })
})
