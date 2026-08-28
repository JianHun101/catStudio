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
 */

const DEFAULT_CAP = 2

/** 解析 env 覆盖（非法/未设 → 默认 2；设为 0 表示不限制） */
function resolveCap(): number {
  const raw = process.env.PROVIDER_TOKEN_CAP
  if (raw === undefined) return DEFAULT_CAP
  const n = parseInt(raw, 10)
  return isNaN(n) || n < 0 ? DEFAULT_CAP : n
}

export class ProviderTokenPool {
  private readonly cap: number
  /** providerKey → 当前在飞 token 数 */
  private counts = new Map<string, number>()
  /** providerKey → 等待队列（acquire 时满则排队，release 时唤醒队首） */
  private waiters = new Map<string, Array<() => void>>()

  constructor(cap?: number) {
    this.cap = cap ?? resolveCap()
  }

  /**
   * 获取一个 provider token。池满时阻塞等待（await Promise——Node 单线程下
   * 等待者不占 CPU，release 时按 FIFO 唤醒）。
   * @returns release 函数（执行收口后必须调用，否则泄漏 token 死锁）
   */
  async acquire(providerKey: string): Promise<() => void> {
    while (this.cap > 0 && (this.counts.get(providerKey) ?? 0) >= this.cap) {
      await new Promise<void>((resolve) => {
        const list = this.waiters.get(providerKey) ?? []
        list.push(resolve)
        this.waiters.set(providerKey, list)
      })
    }
    this.counts.set(providerKey, (this.counts.get(providerKey) ?? 0) + 1)
    return () => this.release(providerKey)
  }

  private release(providerKey: string): void {
    const next = (this.counts.get(providerKey) ?? 1) - 1
    if (next <= 0) this.counts.delete(providerKey)
    else this.counts.set(providerKey, next)
    // 唤醒一个等待者（FIFO：队首先醒）。被唤醒者在 acquire 循环里重查计数——
    // release 已递减 1，恰好一个空位，先到者（队首）拿到。
    const list = this.waiters.get(providerKey)
    const nextWaiter = list?.shift()
    if (nextWaiter) {
      nextWaiter()
      if (list && list.length === 0) this.waiters.delete(providerKey)
    }
  }

  /** 当前 provider 在飞 token 数（测试/诊断用） */
  activeCount(providerKey: string): number {
    return this.counts.get(providerKey) ?? 0
  }

  /** 测试钩子：清空全部计数与等待队列（用例间隔离） */
  reset(): void {
    this.counts.clear()
    this.waiters.clear()
  }
}
