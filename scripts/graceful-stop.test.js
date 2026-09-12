/**
 * graceful-stop 策略单测（票巳 (b) D4 承重反例）。
 *
 * 被判面 = 「宽限窗**有界** 且 超窗**无条件**硬杀」——真卡死时用户按的那颗重启按钮
 * 必须还能用。测试全部走注入（假子进程 / 手摇时钟 / 假 killTree），不起真进程。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import {
  stopProcessGracefully,
  SHUTDOWN_GRACE_MS,
  SHUTDOWN_REQUEST_FILE_NAME,
} from './graceful-stop.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
// 落在仓库 node_modules/.cache 下（已 gitignore，不会被 auto-commit 的 git add -A 扫走）
const TEST_DIR = resolve(__dirname, '../node_modules/.cache/graceful-stop-test')
const requestFile = join(TEST_DIR, '.shutdown-request')

/** 假子进程：捕获 once 回调，由测试决定何时「退出」 */
function makeChild(pid = 4242) {
  const listeners = []
  const child = {
    pid,
    exitCode: null,
    once: (ev, cb) => listeners.push({ ev, cb }),
  }
  return {
    child,
    fireExit: () => listeners.filter((l) => l.ev === 'exit').forEach((l) => l.cb(0)),
    listenerCount: () => listeners.length,
  }
}

/** 手摇时钟：now/sleep 同源，elapsed 可直接断言「等了多久」 */
function makeClock() {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms
    },
    get elapsed() {
      return t
    },
  }
}

function baseOpts(over = {}) {
  return {
    requestFile,
    killTree: vi.fn(),
    graceMs: 500,
    pollStepMs: 100,
    log: () => {},
    warn: () => {},
    ...over,
  }
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('契约/常量守卫（D4 元守卫）', () => {
  it('SHUTDOWN_GRACE_MS **有界**且为正——防「设成极大」把重启卡死', () => {
    expect(Number.isFinite(SHUTDOWN_GRACE_MS)).toBe(true)
    expect(SHUTDOWN_GRACE_MS).toBeGreaterThan(0)
    expect(SHUTDOWN_GRACE_MS).toBeLessThanOrEqual(15_000)
  })

  it('文件名是 .shutdown-request，**不得**复用 .restart-request（会被 dev.js 的 watcher 当重启请求触发）', () => {
    expect(SHUTDOWN_REQUEST_FILE_NAME).toBe('.shutdown-request')
    expect(SHUTDOWN_REQUEST_FILE_NAME).not.toBe('.restart-request')
  })
})

describe('stopProcessGracefully：有界宽限窗 + 兜底硬杀（D4 承重反例）', () => {
  it('窗内不退出 ⇒ 到点**无条件**硬杀一次，且等待量 = 宽限窗（不是无界）', async () => {
    const { child } = makeChild()
    const clock = makeClock()
    const opts = baseOpts({ now: clock.now, sleep: clock.sleep })

    const res = await stopProcessGracefully(child, opts)

    expect(res.graceful).toBe(false)
    expect(res.waitedMs).toBe(500)
    expect(clock.elapsed).toBe(500) // 上界就是宽限窗：循环没有无限跑
    expect(opts.killTree).toHaveBeenCalledTimes(1)
    expect(opts.killTree).toHaveBeenCalledWith(4242)
  })

  it('窗内自行退出 ⇒ 不硬杀，且**不跑满**宽限窗（早退即早走）', async () => {
    const { child, fireExit } = makeChild()
    // 手摇：推进到 200ms 时触发退出（早于 500ms 的宽限窗）
    let t = 0
    const opts = baseOpts({
      now: () => t,
      sleep: async (ms) => {
        t += ms
        if (t >= 200) fireExit()
      },
    })

    const res = await stopProcessGracefully(child, opts)

    expect(res.graceful).toBe(true)
    expect(res.waitedMs).toBe(200)
    expect(t).toBe(200) // 没跑满 500
    expect(opts.killTree).not.toHaveBeenCalled()
  })

  it('写进去的必须是**空文件**（契约 7：存在即请求，内容不参与判定）', async () => {
    const { child } = makeChild()
    const clock = makeClock()
    const seen = []
    const opts = baseOpts({
      now: clock.now,
      sleep: async (ms) => {
        seen.push(readFileSync(requestFile, 'utf-8'))
        clock.sleep(ms)
      },
      graceMs: 100, // 只跑一轮
    })

    await stopProcessGracefully(child, opts)

    expect(seen).toEqual([''])
  })

  it('宽限窗结束（server 没消费）⇒ 写方兜底删文件，残留不打掉下一个 server（契约 4）', async () => {
    const { child } = makeChild()
    const clock = makeClock()
    await stopProcessGracefully(child, baseOpts({ now: clock.now, sleep: clock.sleep }))
    expect(existsSync(requestFile)).toBe(false)
  })

  it('优雅路径下文件已被读方消费 ⇒ 兜底 unlink 落空也不抛（契约 7③ 对称面）', async () => {
    const { child, fireExit } = makeChild()
    let t = 0
    const opts = baseOpts({
      now: () => t,
      sleep: async (ms) => {
        t += ms
        rmSync(requestFile, { force: true }) // 模拟 server 读后即删
        if (t >= 200) fireExit()
      },
    })
    await expect(stopProcessGracefully(child, opts)).resolves.toMatchObject({ graceful: true })
  })
})

describe('stopProcessGracefully：退化与快速路径', () => {
  it('child 为 null / 已退出 ⇒ 零等待、不写文件、不硬杀', async () => {
    const opts = baseOpts()
    expect(await stopProcessGracefully(null, opts)).toEqual({ graceful: true, waitedMs: 0 })
    expect(await stopProcessGracefully({ pid: 1, exitCode: 0, once: () => {} }, opts)).toEqual({
      graceful: true,
      waitedMs: 0,
    })
    expect(existsSync(requestFile)).toBe(false)
    expect(opts.killTree).not.toHaveBeenCalled()
  })

  it('写请求文件失败（目录不存在）⇒ 仍走兜底硬杀，**不静默放弃也不卡死**', async () => {
    const { child } = makeChild()
    const clock = makeClock()
    const opts = baseOpts({
      requestFile: join(TEST_DIR, 'no-such-dir', '.shutdown-request'),
      now: clock.now,
      sleep: clock.sleep,
    })

    const res = await stopProcessGracefully(child, opts)

    expect(res.graceful).toBe(false)
    expect(clock.elapsed).toBe(500) // 仍是**有界**等待
    expect(opts.killTree).toHaveBeenCalledTimes(1)
  })
})
