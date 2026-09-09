/**
 * token-pool.test.ts — ProviderTokenPool 纯单元（无 I/O、无 mock）。
 *
 * 覆盖 B 方案（池内可取消 acquire + 等待超时）与既有 cap 语义回归。
 * A 方案（token 只包 LLM 段）的死锁回归钉子落在 serial.test.ts——那里才有真实
 * A2A 嵌套链；本文件只测池本体，不假装覆盖编排层。
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { ProviderTokenPool, ProviderTokenAcquireTimeoutError } from './token-pool.js'

const KEY = 'deepseek:sk-test'

/** 让出定时器队列（等被唤醒的 acquire 续跑） */
const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms))

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('ProviderTokenPool — cap 语义（既有行为回归）', () => {
  it('cap 内直接放行；满则排队，release 按 FIFO 唤醒队首', async () => {
    const pool = new ProviderTokenPool(1, 0) // 第二参 0 = 不超时（本用例只测排队语义）
    const rel1 = await pool.acquire(KEY)
    expect(pool.activeCount(KEY)).toBe(1)

    const order: string[] = []
    const p2 = pool.acquire(KEY).then((rel) => {
      order.push('second')
      return rel
    })
    const p3 = pool.acquire(KEY).then((rel) => {
      order.push('third')
      return rel
    })
    await tick(10)
    expect(order).toEqual([]) // 两个都在排队

    rel1()
    const rel2 = await p2
    await tick(10)
    expect(order).toEqual(['second']) // FIFO：队首先醒
    rel2()
    const rel3 = await p3
    expect(order).toEqual(['second', 'third'])
    rel3()
    expect(pool.activeCount(KEY)).toBe(0)
  })

  it('cap=0 不限制（acquire 恒立即成功）', async () => {
    const pool = new ProviderTokenPool(0, 0)
    const r1 = await pool.acquire(KEY)
    const r2 = await pool.acquire(KEY)
    expect(pool.activeCount(KEY)).toBe(2)
    r1()
    r2()
    expect(pool.activeCount(KEY)).toBe(0)
  })
})

describe('ProviderTokenPool — B 方案：池内可取消 acquire', () => {
  it('②⑨ 超时 reject 且不泄漏计数——同 key 再 acquire 立即可得', async () => {
    // 验收⑨要求「env 名与取值可注入」：走 env 解析路径而非构造参数
    vi.stubEnv('PROVIDER_TOKEN_ACQUIRE_TIMEOUT_MS', '50')
    const pool = new ProviderTokenPool(1)
    const holder = await pool.acquire(KEY)

    await expect(pool.acquire(KEY)).rejects.toBeInstanceOf(ProviderTokenAcquireTimeoutError)
    // 关键：超时的 waiter 未递增计数（无泄漏）——持有者仍在飞，计数恰为 1
    expect(pool.activeCount(KEY)).toBe(1)

    holder()
    expect(pool.activeCount(KEY)).toBe(0)
    // 若旧实现（或池外 Promise.race 包装）泄漏了 token，此处会一路排到超时
    const again = await pool.acquire(KEY)
    expect(pool.activeCount(KEY)).toBe(1)
    again()
  })

  it('被取消的 waiter 不消费 release 的唤醒（惰性摘除承重）', async () => {
    vi.stubEnv('PROVIDER_TOKEN_ACQUIRE_TIMEOUT_MS', '60')
    const pool = new ProviderTokenPool(1)
    const holder = await pool.acquire(KEY)

    // A 入队后超时被取消——条目仍留在队列里（惰性摘除），排在后面的 B 才是活的
    const a = pool.acquire(KEY).catch((e) => e)
    await tick(100)
    expect(await a).toBeInstanceOf(ProviderTokenAcquireTimeoutError)
    expect(pool.activeCount(KEY)).toBe(1)

    const b = pool.acquire(KEY)
    await tick(10)
    holder() // release 必须跳过已取消的 A，把唤醒给 B

    const bRel = await b // 若唤醒被 A 吃掉，B 会一路等到自己的 60ms 超时
    expect(pool.activeCount(KEY)).toBe(1)
    bRel()
    expect(pool.activeCount(KEY)).toBe(0)
  })

  it('PROVIDER_TOKEN_ACQUIRE_TIMEOUT_MS=0 禁用超时（等待退回纯阻塞）', async () => {
    vi.stubEnv('PROVIDER_TOKEN_ACQUIRE_TIMEOUT_MS', '0')
    const pool = new ProviderTokenPool(1)
    const holder = await pool.acquire(KEY)

    let settled = false
    const p = pool.acquire(KEY).then((rel) => {
      settled = true
      return rel
    })
    await tick(80)
    expect(settled).toBe(false) // 不超时 → 一直等

    holder()
    const rel = await p
    expect(settled).toBe(true)
    rel()
  })

  it('reset 清空计数与队列（用例间隔离钩子）', async () => {
    const pool = new ProviderTokenPool(1, 0)
    await pool.acquire(KEY)
    expect(pool.activeCount(KEY)).toBe(1)

    pool.reset()

    expect(pool.activeCount(KEY)).toBe(0)
    const rel = await pool.acquire(KEY) // 队列已清 → 立即放行
    expect(pool.activeCount(KEY)).toBe(1)
    rel()
  })
})
