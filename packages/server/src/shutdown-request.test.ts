/**
 * 关停请求文件握手 —— server 侧消费端契约测试（票巳 (b)）。
 *
 * 承重面：契约 4（陈旧文件清理 ⇒ 新 server 不自杀）/ 契约 7①（存在即请求、内容不参与
 * 判定）/ 契约 7②（读后即删、删在回调之前）/ 契约 7③（unlink 失败不阻断关停）/ 契约 8
 * （文件名不得复用 `.restart-request`）。
 *
 * 隔离目录：**不复用** socketio.test.ts 的共享目录（node_modules/.cache/restart-test）——
 * 全量并行时两文件用例交错互删同一文件是竞态根源，restart-request.test.ts 已踩过并留注。
 * 本组用独立目录 + vi.resetModules + vi.stubEnv，每次加载独立模块实例。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

const ISOLATED_DIR = 'node_modules/.cache/restart-test-shutdown'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type ShutdownApi = typeof import('./shutdown-request.js')
type RestartApi = typeof import('./restart-request.js')

let api: ShutdownApi
let restart: RestartApi
/** 关停请求文件的绝对路径（由被测模块自己算出，测试不复制路径拼接逻辑） */
let file: string

beforeEach(async () => {
  vi.resetModules()
  vi.stubEnv('RESTART_FILES_DIR', ISOLATED_DIR)
  api = await import('./shutdown-request.js')
  restart = await import('./restart-request.js')
  file = restart.SHUTDOWN_REQUEST_FILE
  rmSync(file, { force: true, recursive: true }) // 每例从干净态起
})

afterEach(() => {
  vi.unstubAllEnvs()
  try {
    rmSync(file, { force: true, recursive: true })
  } catch {}
})

describe('契约 6/8：路径同源 + 不复用 .restart-request 名', () => {
  it('与 .restart-request 同一个 RESTART_FILES_DIR（不散落第二处路径常量）', () => {
    expect(dirname(restart.SHUTDOWN_REQUEST_FILE)).toBe(dirname(restart.RESTART_REQUEST_FILE))
  })

  it('文件名是 .shutdown-request，**不得**复用 .restart-request（契约 8：会被 dev.js 当重启请求触发）', () => {
    expect(basename(restart.SHUTDOWN_REQUEST_FILE)).toBe('.shutdown-request')
    expect(restart.SHUTDOWN_REQUEST_FILE).not.toBe(restart.RESTART_REQUEST_FILE)
  })

  it('cwd 与 RESTART_FILES_DIR 一致时落在项目根（dev.js 写方读的是同一个路径）', () => {
    // vitest 的 RESTART_FILES_DIR 是相对路径 ⇒ resolve(cwd, ...)；这里只断言
    // 「相对 cwd 解析」这条语义与 dev.js `path.join(ROOT, ...)` 的落点规则一致。
    expect(restart.SHUTDOWN_REQUEST_FILE).toBe(resolve(ISOLATED_DIR, '.shutdown-request'))
  })

  it('已进仓库根 .gitignore（工作流状态文件不入库）', () => {
    const rootGitignore = readFileSync(resolve(__dirname, '../../../.gitignore'), 'utf-8')
    expect(rootGitignore).toMatch(/^\.shutdown-request$/m)
  })
})

describe('consumeShutdownRequest（契约 7）', () => {
  it('文件不存在 → false', () => {
    expect(api.consumeShutdownRequest()).toBe(false)
  })

  it('存在即请求：**空文件**即合法命中（契约 7①，dev.js 写的就是空文件）', () => {
    writeFileSync(file, '')
    expect(api.consumeShutdownRequest()).toBe(true)
  })

  it('内容不参与判定：非空 / 非 JSON 同样命中（读方不校验、不解析）', () => {
    writeFileSync(file, '这不是 JSON {{{')
    expect(api.consumeShutdownRequest()).toBe(true)
  })

  it('读后即删：命中一次后文件已不在，第二次 → false（契约 7②）', () => {
    writeFileSync(file, '')
    expect(api.consumeShutdownRequest()).toBe(true)
    expect(existsSync(file)).toBe(false)
    expect(api.consumeShutdownRequest()).toBe(false)
  })

  it('unlink 失败**不阻断**关停：路径被占成目录（unlink 必失败）仍返回 true 且不抛（契约 7③）', () => {
    mkdirSync(file, { recursive: true })
    let result: boolean | undefined
    expect(() => {
      result = api.consumeShutdownRequest()
    }).not.toThrow()
    expect(result).toBe(true)
  })
})

describe('clearStaleShutdownRequest（契约 4：启动路径防「启动即自杀」）', () => {
  it('无陈旧文件 → false（干净启动不留噪声日志）', () => {
    expect(api.clearStaleShutdownRequest()).toBe(false)
  })

  it('有陈旧文件 → 清掉并返回 true', () => {
    writeFileSync(file, '')
    expect(api.clearStaleShutdownRequest()).toBe(true)
    expect(existsSync(file)).toBe(false)
  })
})

describe('startShutdownRequestWatcher 自检行为', () => {
  it('正向反例：起自检后写入文件 ⇒ 回调触发、文件被消费（证明自检**真的在工作**）', async () => {
    const onRequest = vi.fn()
    const stop = api.startShutdownRequestWatcher(onRequest, { intervalMs: 20 })
    try {
      writeFileSync(file, '')
      await vi.waitFor(() => expect(onRequest).toHaveBeenCalledTimes(1))
      expect(existsSync(file)).toBe(false)
    } finally {
      stop()
    }
  })

  it('读后即删发生在回调**之前**：回调里读文件已不在（契约 7②，防宽限窗内重复触发）', async () => {
    let fileStillThereAtCallback: boolean | null = null
    const stop = api.startShutdownRequestWatcher(
      () => {
        fileStillThereAtCallback = existsSync(file)
      },
      { intervalMs: 20 }
    )
    try {
      writeFileSync(file, '')
      await vi.waitFor(() => expect(fileStillThereAtCallback).not.toBeNull())
      expect(fileStillThereAtCallback).toBe(false)
    } finally {
      stop()
    }
  })

  it('stop() 之后写入文件不再触发（防关停后误触发 / 定时器泄漏）', async () => {
    const onRequest = vi.fn()
    api.startShutdownRequestWatcher(onRequest, { intervalMs: 20 })()
    writeFileSync(file, '')
    await sleep(120)
    expect(onRequest).not.toHaveBeenCalled()
  })

  it('单次触发即停：消费过一次后再写入 ⇒ 不再回调，且第二个文件**留在盘上**', async () => {
    const onRequest = vi.fn()
    const stop = api.startShutdownRequestWatcher(onRequest, { intervalMs: 20 })
    try {
      writeFileSync(file, '')
      await vi.waitFor(() => expect(onRequest).toHaveBeenCalledTimes(1))

      writeFileSync(file, '') // 第二次请求（宽限窗内重复写入）
      await sleep(120) // ≫ 5 个轮询周期

      expect(onRequest).toHaveBeenCalledTimes(1)
      // 关键鉴别断言：文件仍在 = 自检**真的停了**。
      // 若实现只是「消费了但不回调」（仍在轮询），文件会被删 ⇒ 本断言必红。
      expect(existsSync(file)).toBe(true)
      stop() // 自停后再调返回的 stop()：幂等，不抛
    } finally {
      stop()
    }
  })
})

// ─── 契约 4 承重面（成对用例，防假绿）────────────────────────────
// ⚠️ 只验「启动时预置的文件不触发回调」会被「自检压根没工作」假冒绿门
//    （验证面 ≠ 被判面）。故与上面的正向反例**成对**读：先证自检在写文件时会触发，
//    再证启动序列会把陈旧文件清在自检起来之前。
describe('启动序列：清陈旧 → 起自检（契约 4 承重）', () => {
  it('预置陈旧关停请求 → 走启动序列（clearStale → watcher）⇒ 回调**零**触发，进程不自杀', async () => {
    writeFileSync(file, '') // 上次走兜底硬杀留下的陈旧关停请求
    api.clearStaleShutdownRequest() // index.ts 启动路径 1.6b
    const onRequest = vi.fn()
    const stop = api.startShutdownRequestWatcher(onRequest, { intervalMs: 20 }) // index.ts main 尾部
    try {
      await sleep(200) // ≫ 10 个轮询周期
      expect(onRequest).not.toHaveBeenCalled()
      expect(existsSync(file)).toBe(false)
    } finally {
      stop()
    }
  })
})
