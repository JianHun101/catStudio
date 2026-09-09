/**
 * Execution — ProviderTokenPool（并发护栏：每 provider 并发上限）。
 *
 * 目标：多 agent 并行后（同会话多猫 / 跨会话同猫），同一 provider（如 deepseek）
 * 的并发 LLM 调用可能成倍增长——适配器按 provider:apiKey 缓存单实例，无护栏时
 * 同实例并发流数无界。本池按 provider 键控并发 cap（默认 2，env PROVIDER_TOKEN_CAP
 * 可配），acquire 阻塞等待、release 唤醒下一个等待者，FIFO 公平。
 *
 * 键复用 llm/registry.ts 的 provider:apiKey 模式（registry 默认分支 cacheKey 形态）。
 * 免 key provider（opencode/ollama）key 留空/占位 → 同 provider 共享一个池键，
 * cap 对本地认证的 provider 同样生效。
 *
 * 可取消 acquire（B 方案，2026-09-09）：等待上限默认 35min
 * （= AGENT_HARD_TIMEOUT_MS 30min 单次执行硬上限 + 5min 余量，防误伤长任务），
 * env PROVIDER_TOKEN_ACQUIRE_TIMEOUT_MS 可覆盖、0 禁用。超时后 acquire reject，
 * 调用方按执行失败收口（executeOneAgent 的 catch 漏斗）。
 *
 * 取消必须做在池内：池外 `Promise.race` 包一层的话，超时后原 waiter 仍留在队列里，
 * 之后被 release 唤醒并照常递增计数，而调用方早已放弃——token 泄漏、池容量被永久
 * 吃掉。故 waiter 带 cancelled 标记，超时只置位（惰性摘除），由 release 唤醒时跳过
 * 并丢弃——若超时路径直接 splice 掉，release 的跳过分支就成了不可达代码。
 */

const DEFAULT_CAP = 2

/** acquire 等待上限默认值：35min = 单次执行硬上限（30min）+ 5min 余量 */
const DEFAULT_ACQUIRE_TIMEOUT_MS = 35 * 60 * 1000

/** 解析 env 覆盖（非法/未设 → 默认 2；设为 0 表示不限制） */
function resolveCap(): number {
  const raw = process.env.PROVIDER_TOKEN_CAP
  if (raw === undefined) return DEFAULT_CAP
  const n = parseInt(raw, 10)
  return isNaN(n) || n < 0 ? DEFAULT_CAP : n
}

/** 解析 acquire 超时覆盖（非法/未设 → 默认 35min；设为 0 表示不超时） */
function resolveAcquireTimeoutMs(): number {
  const raw = process.env.PROVIDER_TOKEN_ACQUIRE_TIMEOUT_MS
  if (raw === undefined) return DEFAULT_ACQUIRE_TIMEOUT_MS
  const n = parseInt(raw, 10)
  return isNaN(n) || n < 0 ? DEFAULT_ACQUIRE_TIMEOUT_MS : n
}

/** acquire 等待超时（B 方案安全网）——调用方按执行失败处理，池内计数未泄漏 */
export class ProviderTokenAcquireTimeoutError extends Error {
  readonly providerKey: string
  readonly timeoutMs: number
  constructor(providerKey: string, timeoutMs: number) {
    super(`provider token acquire timeout after ${timeoutMs}ms (providerKey=${providerKey})`)
    this.name = 'ProviderTokenAcquireTimeoutError'
    this.providerKey = providerKey
    this.timeoutMs = timeoutMs
  }
}

/** 等待者条目——cancelled 由超时路径置位，release 唤醒时跳过它 */
interface Waiter {
  resolve: () => void
  reject: (err: Error) => void
  cancelled: boolean
  timer?: ReturnType<typeof setTimeout>
}

export class ProviderTokenPool {
  private readonly cap: number
  private readonly acquireTimeoutMs: number
  /** providerKey → 当前在飞 token 数 */
  private counts = new Map<string, number>()
  /** providerKey → 等待队列（acquire 时满则排队，release 时唤醒队首） */
  private waiters = new Map<string, Waiter[]>()

  constructor(cap?: number, acquireTimeoutMs?: number) {
    this.cap = cap ?? resolveCap()
    this.acquireTimeoutMs = acquireTimeoutMs ?? resolveAcquireTimeoutMs()
  }

  /**
   * 获取一个 provider token。池满时阻塞等待（await Promise——Node 单线程下
   * 等待者不占 CPU，release 时按 FIFO 唤醒）。等待超过 acquireTimeoutMs →
   * reject ProviderTokenAcquireTimeoutError（0 禁用超时，行为退回纯阻塞）。
   * @returns release 函数（执行收口后必须调用，否则泄漏 token 死锁）
   */
  async acquire(providerKey: string): Promise<() => void> {
    while (this.cap > 0 && (this.counts.get(providerKey) ?? 0) >= this.cap) {
      await this.waitForSlot(providerKey)
    }
    this.counts.set(providerKey, (this.counts.get(providerKey) ?? 0) + 1)
    return () => this.release(providerKey)
  }

  /**
   * 入队等一个空位。超时 → 置 cancelled + reject（不递增计数，故不泄漏）。
   * 条目留在队列里惰性摘除：release 遇到 cancelled 直接丢弃并继续找下一个，
   * 保证被取消者不消费唤醒（否则排在它后面的活 waiter 会白等一轮）。
   */
  private waitForSlot(providerKey: string): Promise<void> {
    let waiter!: Waiter
    const pending = new Promise<void>((resolve, reject) => {
      waiter = { resolve, reject, cancelled: false }
      const list = this.waiters.get(providerKey) ?? []
      list.push(waiter)
      this.waiters.set(providerKey, list)
      if (this.acquireTimeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          waiter.cancelled = true
          reject(new ProviderTokenAcquireTimeoutError(providerKey, this.acquireTimeoutMs))
        }, this.acquireTimeoutMs)
        // 超时器不持有事件循环（server 常驻进程与测试退出不被拖住）
        waiter.timer.unref?.()
      }
    })
    // 正常唤醒（release）后清掉超时器——否则它会在此后某个时刻平白 reject 一个
    // 已 settle 的 promise（无害但留悬挂 timer）
    return pending.finally(() => {
      if (waiter.timer) clearTimeout(waiter.timer)
    })
  }

  private release(providerKey: string): void {
    const next = (this.counts.get(providerKey) ?? 1) - 1
    if (next <= 0) this.counts.delete(providerKey)
    else this.counts.set(providerKey, next)
    // 唤醒一个等待者（FIFO：队首未被取消者）。已取消的 waiter 不消费本次唤醒——
    // 它的 acquire 已 reject，若在此 resolve 会平白吃掉一个空位（排在它后面的
    // 活 waiter 白等一轮），故跳过并顺带惰性摘除。
    const list = this.waiters.get(providerKey)
    while (list && list.length > 0) {
      const nextWaiter = list.shift() as Waiter
      if (nextWaiter.cancelled) continue
      nextWaiter.resolve()
      break
    }
    if (list && list.length === 0) this.waiters.delete(providerKey)
  }

  /** 当前 provider 在飞 token 数（测试/诊断用） */
  activeCount(providerKey: string): number {
    return this.counts.get(providerKey) ?? 0
  }

  /** 测试钩子：清空全部计数与等待队列（用例间隔离） */
  reset(): void {
    // 未 settle 的等待者先摘除超时器并置取消——避免用例结束后残留 timer 触发
    for (const list of this.waiters.values()) {
      for (const w of list) {
        w.cancelled = true
        if (w.timer) clearTimeout(w.timer)
      }
    }
    this.counts.clear()
    this.waiters.clear()
  }
}
