/**
 * 嵌入 sidecar 客户端 —— 主进程侧打电话的一方。
 *
 * 背景（票丁）：嵌入推理跑在 server **主进程之外**（`scripts/flywheel/embed-server.mjs`）。
 * 本模块负责：spawn sidecar → 端口握手 → 探活 → 请求 → 超时/冷却/降级。
 *
 * 降级面 = **明确失败**，不退回进程内（票丁契约 ①）：
 * 失败返回 `{ ok:false, reason }` 而**不是**空数组 —— 「没开这个功能」与「功能坏了」
 * 必须可区分（`not-enabled` vs 其余五种）。
 *
 * 参数（票丁契约 ②，默认值即契约值）：
 *   首启探活上限 30s / 单次请求超时 10s / 探活失败后重探冷却 30s / 批量上限 64
 *
 * 环境变量:
 *   MEMORY_ENABLED         — 'false' 时直接 not-enabled（不 spawn、零开销）
 *   MEMORY_EMBEDDING_MODEL — 模型名（sidecar 读；主进程不写死白名单，以 /health 回报为准）
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createLogger } from '../logger.js'

const log = createLogger('memory:embedding-client')

/** sidecar 脚本位置（相对本模块；`packages/server/src/memory/` → 上溯 4 层为仓库根） */
export const SIDECAR_SCRIPT_PATH = fileURLToPath(
  new URL('../../../../scripts/flywheel/embed-server.mjs', import.meta.url)
)

/** stdout 握手行前缀（与 embed-server.mjs 的 READY_PREFIX 同步） */
const READY_PREFIX = 'EMBED_SIDECAR_READY'

// ─── 契约参数（票丁契约 ②）─────────────────────────────

/** 首启探活上限（冷启动含模型加载） */
export const PROBE_TIMEOUT_MS = 30_000
/** 单次嵌入请求超时（512 维小模型正常 < 100ms） */
export const REQUEST_TIMEOUT_MS = 10_000
/** 探活失败后的重探冷却（冷却期内直接复用失败结论，不重 spawn） */
export const REPROBE_COOLDOWN_MS = 30_000
/** 批量上限（与 sidecar 侧 MAX_BATCH 一致） */
export const MAX_BATCH = 64
/** 探活轮询间隔 */
export const PROBE_INTERVAL_MS = 200

// ─── 形态 ─────────────────────────────────────────────

export type EmbedFailureReason =
  | 'spawn-failed'
  | 'health-timeout'
  | 'request-timeout'
  | 'bad-status'
  | 'dim-mismatch'
  | 'not-enabled'

export type EmbedResult =
  { ok: true; vector: number[] } | { ok: false; reason: EmbedFailureReason; detail?: string }

/** 嵌入链当前状态（供检索面打降级标记，票丁契约 ①-②） */
export interface EmbeddingStatus {
  ok: boolean
  reason?: EmbedFailureReason
  model?: string
  dim?: number
  /**
   * sidecar 监听端口（票辰）：**来源唯一 = 握手回报 / baseUrl 解析出的真实值**，
   * 不用 `process.env.EMBED_SIDECAR_PORT` 反推（默认 `0` 时它没有信息量）。
   * 失败 / 从未成功过 ⇒ undefined；直连分支解析不出 ⇒ 0。
   */
  port?: number
  /** 本轮失败起始时刻（ISO）；上次成功则 undefined */
  failingSince?: string
}

/** spawn 出的 sidecar 子进程（只取本模块用到的面 —— 单测可传假实现） */
export interface SidecarChild {
  stdout: NodeJS.ReadableStream | null
  stderr: NodeJS.ReadableStream | null
  kill(signal?: NodeJS.Signals): boolean
  once(event: 'exit', cb: (code: number | null) => void): unknown
}

export type SpawnSidecar = (scriptPath: string) => SidecarChild

export interface EmbeddingClientOptions {
  probeTimeoutMs?: number
  requestTimeoutMs?: number
  reprobeCooldownMs?: number
  probeIntervalMs?: number
  /** 期望维度提供者；返回 null = 库内尚无向量可校，跳过维度自检 */
  expectedDim?: () => number | null
  spawnFn?: SpawnSidecar
  /** 直接指定 sidecar 地址（跳过 spawn；单测/stub 用） */
  baseUrl?: string
  scriptPath?: string
}

interface LiveSidecar {
  child: SidecarChild | null
  baseUrl: string
  model: string
  dim: number
  /** 真实监听端口：spawn 分支 = 握手回报；baseUrl 直连分支 = 由 URL 解析（解析不出为 0） */
  port: number
}

// ─── 客户端 ───────────────────────────────────────────

export class EmbeddingClient {
  private readonly opts: Required<
    Omit<EmbeddingClientOptions, 'expectedDim' | 'baseUrl' | 'scriptPath'>
  > &
    Pick<EmbeddingClientOptions, 'expectedDim' | 'baseUrl' | 'scriptPath'>

  private live: LiveSidecar | null = null
  private connecting: Promise<LiveSidecar> | null = null
  private failure: { reason: EmbedFailureReason; detail?: string; at: number } | null = null
  /** 维度不符是配置错，重试无意义 ⇒ 粘性失败，不再重探 */
  private dimMismatch: { reported: number; expected: number } | null = null
  private loggedStreak = false
  private lastSuccess: { model: string; dim: number; port: number } | null = null

  constructor(options: EmbeddingClientOptions = {}) {
    this.opts = {
      probeTimeoutMs: options.probeTimeoutMs ?? PROBE_TIMEOUT_MS,
      requestTimeoutMs: options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      reprobeCooldownMs: options.reprobeCooldownMs ?? REPROBE_COOLDOWN_MS,
      probeIntervalMs: options.probeIntervalMs ?? PROBE_INTERVAL_MS,
      spawnFn: options.spawnFn ?? defaultSpawn,
      expectedDim: options.expectedDim,
      baseUrl: options.baseUrl,
      scriptPath: options.scriptPath,
    }
  }

  /** 嵌入启用开关（与 `isMemoryEnabled` 同口径：只认显式 'false'） */
  isEnabled(): boolean {
    return process.env.MEMORY_ENABLED !== 'false'
  }

  /** 当前状态（不触发任何 I/O） */
  status(): EmbeddingStatus {
    if (this.dimMismatch) {
      return { ok: false, reason: 'dim-mismatch' }
    }
    if (this.failure) {
      return {
        ok: false,
        reason: this.failure.reason,
        failingSince: new Date(this.failure.at).toISOString(),
      }
    }
    if (this.lastSuccess) {
      return {
        ok: true,
        model: this.lastSuccess.model,
        dim: this.lastSuccess.dim,
        port: this.lastSuccess.port,
      }
    }
    // 从未成功过 ⇒ 无端口可报（契约：ok 但无 lastSuccess 时不编一个）
    return { ok: true }
  }

  /** 单条嵌入 */
  async embed(text: string): Promise<EmbedResult> {
    const [result] = await this.embedMany([text])
    return result
  }

  /**
   * 批量嵌入（按 MAX_BATCH 分块——调用方不必知道上限）。
   * 逐条返回结果：单条失败不影响同批其他条目（与本仓 memory 链 fire-and-forget 一致）。
   */
  async embedMany(texts: string[]): Promise<EmbedResult[]> {
    if (!this.isEnabled()) {
      return texts.map(() => ({ ok: false, reason: 'not-enabled' as const }))
    }
    if (texts.length === 0) return []

    const results: EmbedResult[] = []
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const chunk = texts.slice(i, i + MAX_BATCH)
      results.push(...(await this.embedChunk(chunk)))
    }
    return results
  }

  /** 关停 sidecar（server shutdown 调用；只杀本进程 spawn 的实例） */
  stop(): void {
    const child = this.live?.child
    this.live = null
    this.connecting = null
    if (child) {
      try {
        child.kill()
      } catch {
        /* 已退出/无法杀：不阻塞关停链 */
      }
    }
  }

  /** 提前预热（server 启动时调用；含维度自检；失败留痕不抛） */
  async warmup(): Promise<EmbeddingStatus> {
    if (!this.isEnabled()) return this.status()
    await this.embed('预热')
    return this.status()
  }

  // ─── 内部 ───────────────────────────────────────────

  private async embedChunk(texts: string[]): Promise<EmbedResult[]> {
    const refused = this.refusalReason()
    if (refused) return texts.map(() => refused)

    let live: LiveSidecar
    try {
      live = await this.ensureLive()
    } catch (err: any) {
      const reason: EmbedFailureReason = err?.embedReason ?? 'spawn-failed'
      return texts.map(() => this.recordFailure(reason, err?.message))
    }

    let res: Response
    try {
      res = await this.request(live, '/v1/embeddings', {
        method: 'POST',
        body: JSON.stringify({ input: texts }),
      })
    } catch (err: any) {
      const reason: EmbedFailureReason = err?.embedReason ?? 'request-timeout'
      this.dropSidecar()
      return this.failAll(texts.length, reason, err?.message)
    }

    if (!res.ok) {
      this.dropSidecar()
      return this.failAll(texts.length, 'bad-status', `POST /v1/embeddings → HTTP ${res.status}`)
    }

    let payload: any
    try {
      payload = await res.json()
    } catch (err: any) {
      return this.failAll(texts.length, 'bad-status', `响应非 JSON: ${err?.message}`)
    }

    const vectors = extractVectors(payload, texts.length)
    if (!vectors) {
      return this.failAll(texts.length, 'bad-status', '响应形态不符（data[].embedding）')
    }
    const dimBad = vectors.find((v) => v.length !== live.dim)
    if (dimBad) {
      return this.failAll(
        texts.length,
        'bad-status',
        `返回维度 ${dimBad.length} 与 /health 回报 ${live.dim} 不一致`
      )
    }

    this.failure = null
    this.loggedStreak = false
    this.lastSuccess = { model: live.model, dim: live.dim, port: live.port }
    return vectors.map((vector) => ({ ok: true, vector }) as EmbedResult)
  }

  /**
   * 整批失败：本批**不做部分成功**（请求要么整体成功，要么整体判失败），
   * 每条返回同一个 reason（各自一份对象，避免共享可变引用）。
   */
  private failAll(count: number, reason: EmbedFailureReason, detail?: string): EmbedResult[] {
    const failure = this.recordFailure(reason, detail)
    return Array.from({ length: count }, () => ({ ...failure }))
  }

  /** 冷却期内的快速拒绝（不 spawn、不请求） */
  private refusalReason(): EmbedResult | null {
    if (this.dimMismatch) {
      return {
        ok: false,
        reason: 'dim-mismatch',
        detail: `模型维度 ${this.dimMismatch.reported} ≠ 库内向量维度 ${this.dimMismatch.expected}`,
      }
    }
    if (this.failure) {
      const age = Date.now() - this.failure.at
      if (age < this.opts.reprobeCooldownMs) {
        return { ok: false, reason: this.failure.reason, detail: this.failure.detail }
      }
    }
    return null
  }

  /** 建立（或复用）sidecar 连接：spawn → 握手 → 探活 → 维度自检 */
  private async ensureLive(): Promise<LiveSidecar> {
    if (this.live) return this.live
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = null
      })
    }
    return this.connecting
  }

  private async connect(): Promise<LiveSidecar> {
    if (this.opts.baseUrl) {
      return this.probe({
        child: null,
        baseUrl: this.opts.baseUrl,
        model: '',
        dim: 0,
        // 直连分支（单测/stub 专用）没有握手，端口只能从 URL 解析——解析不出记 0，不抛错
        port: parsePortFromUrl(this.opts.baseUrl),
      })
    }

    const scriptPath = this.opts.scriptPath ?? resolveSidecarPath()
    let child: SidecarChild
    try {
      child = this.opts.spawnFn(scriptPath)
    } catch (err: any) {
      throw embedError('spawn-failed', `spawn 失败: ${err?.message}`)
    }

    const handshake = await this.awaitHandshake(child).catch((err: any) => {
      killQuietly(child)
      throw embedError('spawn-failed', err?.message)
    })

    return this.probe({
      child,
      baseUrl: `http://127.0.0.1:${handshake.port}`,
      model: '',
      dim: 0,
      port: handshake.port,
    }).catch((err: any) => {
      killQuietly(child)
      throw err
    })
  }

  /** 解析 stdout 握手行拿实际端口（OS 分配，避免撞端口） */
  private awaitHandshake(child: SidecarChild): Promise<{ port: number }> {
    return new Promise((resolvePromise, reject) => {
      const deadline = setTimeout(
        () => reject(new Error(`未在 ${this.opts.probeTimeoutMs}ms 内收到端口握手`)),
        this.opts.probeTimeoutMs
      )
      let buffer = ''

      const onData = (chunk: Buffer | string) => {
        buffer += chunk.toString()
        let idx: number
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          if (!line.startsWith(READY_PREFIX)) continue
          try {
            const info = JSON.parse(line.slice(READY_PREFIX.length).trim())
            if (typeof info?.port === 'number' && info.port > 0) {
              clearTimeout(deadline)
              child.stdout?.removeListener('data', onData)
              resolvePromise({ port: info.port })
              return
            }
          } catch {
            /* 非握手行/半行：继续等 */
          }
        }
      }

      child.stdout?.on('data', onData)
      child.once('exit', (code) => {
        clearTimeout(deadline)
        reject(new Error(`sidecar 在握手前退出（code=${code}）`))
      })
    })
  }

  /** 探活直到 ready（含维度自检）；失败抛带 embedReason 的错误 */
  private async probe(seed: LiveSidecar): Promise<LiveSidecar> {
    const baseUrl = seed.baseUrl
    const deadline = Date.now() + this.opts.probeTimeoutMs
    let lastDetail = '未收到 /health 响应'

    while (Date.now() < deadline) {
      let payload: any = null
      try {
        // 单次探活请求不超过剩余预算（挂死的 /health 不会把探活拖过 30s 上限）
        const budget = Math.max(1, Math.min(this.opts.requestTimeoutMs, deadline - Date.now()))
        const res = await this.requestUrl(baseUrl, '/health', { method: 'GET' }, budget)
        if (res.ok) payload = await res.json()
        else lastDetail = `GET /health → HTTP ${res.status}`
      } catch (err: any) {
        lastDetail = err?.message || String(err)
      }

      if (payload?.ready === true) {
        const reported = Number(payload.dim)
        if (!Number.isFinite(reported) || reported <= 0) {
          throw embedError('bad-status', `/health 回报的 dim 非法: ${payload.dim}`)
        }
        const expected = this.opts.expectedDim?.() ?? null
        if (expected !== null && expected !== reported) {
          this.dimMismatch = { reported, expected }
          throw embedError(
            'dim-mismatch',
            `sidecar 回报维度 ${reported} ≠ 库内向量维度 ${expected}（拒绝启动嵌入路径）`
          )
        }
        const liveInput: LiveSidecar = {
          child: seed.child,
          baseUrl,
          model: String(payload.model ?? ''),
          dim: reported,
          // 端口贯穿 seed → live：/health 不回报端口，唯一来源是握手 / URL 解析
          port: seed.port,
        }
        this.live = liveInput
        this.lastSuccess = { model: liveInput.model, dim: liveInput.dim, port: liveInput.port }
        return liveInput
      }

      await sleep(this.opts.probeIntervalMs)
    }

    throw embedError('health-timeout', lastDetail)
  }

  private request(live: LiveSidecar, path: string, init: RequestInit): Promise<Response> {
    return this.requestUrl(live.baseUrl, path, init, this.opts.requestTimeoutMs)
  }

  /** 带超时的单次 HTTP —— 超时即 abort（不挂死调用方） */
  private async requestUrl(
    baseUrl: string,
    path: string,
    init: RequestInit,
    timeoutMs: number
  ): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
        signal: controller.signal,
      })
    } catch (err: any) {
      if (controller.signal.aborted)
        throw embedError('request-timeout', `超过 ${timeoutMs}ms 未响应`)
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  private dropSidecar(): void {
    const child = this.live?.child
    this.live = null
    if (child) killQuietly(child)
  }

  /**
   * 记录失败：**首次失败记 error（含 reason），同一条失败链后续降级 debug** ——
   * 避免每轮刷日志（票丁契约 ①-②）。cooling 期由 refusalReason 承担。
   */
  private recordFailure(reason: EmbedFailureReason, detail?: string): EmbedResult {
    this.failure = { reason, detail, at: Date.now() }
    if (!this.loggedStreak) {
      this.loggedStreak = true
      log.error('嵌入不可用，记忆链降级', { reason, detail })
    } else {
      log.debug('嵌入仍不可用（同一失败链，不再刷日志）', { reason })
    }
    return { ok: false, reason, detail }
  }
}

// ─── 辅助 ─────────────────────────────────────────────

interface EmbedError extends Error {
  embedReason?: EmbedFailureReason
}

function embedError(reason: EmbedFailureReason, message: string): EmbedError {
  const err = new Error(message) as EmbedError
  err.embedReason = reason
  return err
}

/** 默认 spawn：`node <绝对路径>.mjs` —— 禁用 .cmd 包装 / shell:true（Windows EINVAL） */
const defaultSpawn: SpawnSidecar = (scriptPath) =>
  spawn(process.execPath, [scriptPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  }) as unknown as SidecarChild

/**
 * 从 baseUrl 解析端口（直连/stub 分支的端口来源）。
 * 解析不出（URL 非法 / 未写端口）⇒ **返回 0，不抛错**——该分支只用于单测与 stub，
 * 不该因为「地址里没端口」把整条探测路径炸掉。
 */
export function parsePortFromUrl(baseUrl: string): number {
  try {
    const port = Number(new URL(baseUrl).port)
    return Number.isInteger(port) && port > 0 ? port : 0
  } catch {
    return 0
  }
}

function resolveSidecarPath(): string {
  if (existsSync(SIDECAR_SCRIPT_PATH)) return SIDECAR_SCRIPT_PATH
  const fromCwd = resolve(process.cwd(), 'scripts/flywheel/embed-server.mjs')
  if (existsSync(fromCwd)) return fromCwd
  return SIDECAR_SCRIPT_PATH
}

function killQuietly(child: SidecarChild): void {
  try {
    child.kill()
  } catch {
    /* 已退出 */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 响应体 → 向量数组；形态不符返回 null（不抛，交调用方记 bad-status） */
function extractVectors(payload: any, expected: number): number[][] | null {
  const data = payload?.data
  if (!Array.isArray(data) || data.length !== expected) return null
  const ordered = [...data].sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0))
  const vectors: number[][] = []
  for (const item of ordered) {
    const vec = item?.embedding
    if (
      !Array.isArray(vec) ||
      vec.length === 0 ||
      !vec.every((n: unknown) => typeof n === 'number')
    ) {
      return null
    }
    vectors.push(vec as number[])
  }
  return vectors
}
