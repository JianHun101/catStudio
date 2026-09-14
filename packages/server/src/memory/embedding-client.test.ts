/**
 * embedding-client 测试 —— 覆盖票丁 B1–B6。
 *
 * mock 边界：子进程（假 child，stdout 只发端口握手）+ 网络（真起 127.0.0.1 stub
 * HTTP server）。**不 mock fetch / 不 mock server**——被测面就是这套 HTTP 协议本身。
 * 不加载模型：stub 直接回向量。
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  EmbeddingClient,
  MAX_BATCH,
  REQUEST_BATCH_SIZE,
  parsePortFromUrl,
  type SidecarChild,
  type SpawnSidecar,
} from './embedding-client.js'

// ─── logger 边界 mock ─────────────────────────────────

const logMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../logger.js', () => ({ createLogger: () => logMocks }))

// ─── 测试替身 ─────────────────────────────────────────

/** 假 sidecar 子进程：只做 stdout 握手 + 记录 kill */
function fakeChild(port: number): {
  child: SidecarChild
  killed: () => boolean
  exited: () => void
} {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let killed = false
  const exitHandlers: Array<(code: number | null) => void> = []

  const child: SidecarChild = {
    stdout,
    stderr,
    kill: () => {
      killed = true
      return true
    },
    once: (event, cb) => {
      if (event === 'exit') exitHandlers.push(cb)
      return child
    },
  }

  // 端口握手（下一 tick 发出——客户端在同一 tick 内已挂上 data 监听）
  setImmediate(() => stdout.write(`EMBED_SIDECAR_READY {"port":${port},"host":"127.0.0.1"}\n`))

  return { child, killed: () => killed, exited: () => exitHandlers.forEach((h) => h(0)) }
}

/** 握手前即退出的假子进程（B2「起不来」） */
function deadChild(): SidecarChild {
  const child: SidecarChild = {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
    once: (event, cb) => {
      if (event === 'exit') setImmediate(() => cb(1))
      return child
    },
  }
  return child
}

interface StubSidecar {
  port: number
  hits: { health: number; embeddings: number }
  batchSizes: number[]
  close: () => Promise<void>
  setHealth: (patch: Record<string, unknown>) => void
  setEmbedStatus: (status: number) => void
  hangEmbeddings: (yes: boolean) => void
  setDataCount: (n: number) => void
  /** 接下来 n 次嵌入请求立即回 500（不挂起、无时序竞态）——票午 (b) 造「首败」用 */
  failNextEmbeddings: (n: number) => void
  /**
   * 非 2xx 的 body 原文（票 F1-a）——默认 `{ok:false,reason:'boom'}`。
   * 传非 JSON 串 = 造「body 不是 JSON」；传 sidecar 真实形态
   * `{"ok":false,"reason":"internal","detail":"..."}` = 造「根因在 body 里」。
   */
  setEmbedErrorBody: (body: string) => void
  /** >0 ⇒ 非 2xx 时只写前 N 字节就断链（造「读 body 本身抛错」） */
  setEmbedAbortAfter: (bytes: number) => void
}

/** 真起一个 127.0.0.1 stub sidecar */
async function startStub(initialHealth: Record<string, unknown> = {}): Promise<StubSidecar> {
  let health = { ok: true, ready: true, model: 'stub-model', dim: 512, ...initialHealth }
  const hits = { health: 0, embeddings: 0 }
  const batchSizes: number[] = []
  let embedStatus = 200
  let hang = false
  let dataCount: number | undefined
  let failNext = 0
  let embedErrorBody: string | null = null
  let embedAbortAfter = 0

  const server: Server = createServer((req, res) => {
    if (req.url === '/health') {
      hits.health++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(health))
      return
    }
    if (req.url === '/v1/embeddings' && req.method === 'POST') {
      hits.embeddings++
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        if (hang) return // 故意不响应（B3 超时）
        if (embedStatus !== 200) {
          res.writeHead(embedStatus, { 'content-type': 'application/json' })
          const body = embedErrorBody ?? JSON.stringify({ ok: false, reason: 'boom' })
          // F1-a 反例面：写完半截 body 就断链 ⇒ 客户端读 body 抛（须回落，不得升级成未捕获异常）
          if (embedAbortAfter > 0) {
            res.write(body.slice(0, embedAbortAfter))
            setTimeout(() => res.destroy(), 10)
            return
          }
          res.end(body)
          return
        }
        const input = JSON.parse(Buffer.concat(chunks).toString()).input
        const texts: string[] = typeof input === 'string' ? [input] : input
        batchSizes.push(texts.length)
        // 票午 (b)：按需造「首败」——仍记 batchSizes，好断「重试的是同一批」
        if (failNext > 0) {
          failNext--
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, reason: 'boom' }))
          return
        }
        // 向量维度跟着 /health 的 dim 走（真实 sidecar 亦然——两侧同源）
        const dim = Number(health.dim) || 3
        const items = texts.map((t, index) => {
          const vec = [t.length, 3, 1]
          while (vec.length < dim) vec.push(0)
          vec.length = Math.max(1, dim)
          return { index, embedding: vec }
        })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            model: health.model,
            dim: health.dim,
            // dataCount 只在测试要造「条目数不符」时才偏离（默认与输入等长）
            data: typeof dataCount === 'number' ? items.slice(0, dataCount) : items,
          })
        )
      })
      return
    }
    res.writeHead(404).end()
  })

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port

  return {
    port,
    hits,
    batchSizes,
    close: () => new Promise<void>((r) => server.close(() => r())),
    setHealth: (patch) => {
      health = { ...health, ...patch }
    },
    setEmbedStatus: (status) => {
      embedStatus = status
    },
    hangEmbeddings: (yes) => {
      hang = yes
    },
    setDataCount: (n) => {
      dataCount = n
    },
    failNextEmbeddings: (n) => {
      failNext = n
    },
    setEmbedErrorBody: (body) => {
      embedErrorBody = body
    },
    setEmbedAbortAfter: (bytes) => {
      embedAbortAfter = bytes
    },
  }
}

/** 由 stub 造出「spawn 得通」的 spawnFn */
function spawnTo(stub: StubSidecar, spawnCounter?: { n: number }): SpawnSidecar {
  return () => {
    if (spawnCounter) spawnCounter.n++
    return fakeChild(stub.port).child
  }
}

let stubs: StubSidecar[] = []

async function makeStub(health?: Record<string, unknown>): Promise<StubSidecar> {
  const stub = await startStub(health)
  stubs.push(stub)
  return stub
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.MEMORY_ENABLED = 'true'
})

afterEach(async () => {
  for (const s of stubs) await s.close()
  stubs = []
  delete process.env.MEMORY_ENABLED
})

// ─── B1 正常路径 ──────────────────────────────────────

describe('B1 正常路径', () => {
  it('spawn → 握手 → 探活 → 嵌入：返回 stub 的向量', async () => {
    const stub = await makeStub()
    const client = new EmbeddingClient({ spawnFn: spawnTo(stub) })

    const r = await client.embed('abcd')
    expect(r.ok).toBe(true)
    expect(r.ok && r.vector).toHaveLength(512)
    expect(r.ok && r.vector.slice(0, 3)).toEqual([4, 3, 1])
    expect(stub.hits.health).toBeGreaterThan(0)
    expect(stub.hits.embeddings).toBe(1)
  })

  it('modelId / dim 以 /health 回报为权威', async () => {
    const stub = await makeStub({ model: 'X', dim: 1024 })
    const client = new EmbeddingClient({ spawnFn: spawnTo(stub), expectedDim: () => 1024 })

    await client.embed('x')
    expect(client.status()).toMatchObject({ ok: true, model: 'X', dim: 1024 })
  })

  it('embedMany 按 REQUEST_BATCH_SIZE 分块（票午 a：切批 = 每批各持一份请求预算）', async () => {
    const stub = await makeStub()
    const client = new EmbeddingClient({ spawnFn: spawnTo(stub) })

    const results = await client.embedMany(Array.from({ length: MAX_BATCH + 1 }, () => 'x'))
    expect(results).toHaveLength(MAX_BATCH + 1)
    expect(results.every((r) => r.ok)).toBe(true)
    // 常量层面先钉住「不切就是退化」——批大小回到 MAX_BATCH 即等于整件一次
    expect(REQUEST_BATCH_SIZE).toBeLessThan(MAX_BATCH)
    // **承重反例 D1**：把切批去掉（批大小改回 MAX_BATCH）⇒ 本行必红（实测得到 [64, 1]）
    expect(stub.batchSizes).toEqual([16, 16, 16, 16, 1])
  })
})

// ─── 票午 · 超时预算与批大小解耦 ──────────────────────

describe('票午 (a) 批大小参数化', () => {
  it('构造项 batchSize 覆盖默认值（契约 ④：不散落硬编码）', async () => {
    const stub = await makeStub()
    const client = new EmbeddingClient({ spawnFn: spawnTo(stub), batchSize: 8 })

    await client.embedMany(Array.from({ length: 20 }, () => 'x'))
    expect(stub.batchSizes).toEqual([8, 8, 4])
  })

  it('batchSize 超 MAX_BATCH 由协议上限封顶（sidecar 侧同值，越界即 400）', async () => {
    const stub = await makeStub()
    const client = new EmbeddingClient({ spawnFn: spawnTo(stub), batchSize: 999 })

    await client.embedMany(Array.from({ length: MAX_BATCH + 1 }, () => 'x'))
    expect(stub.batchSizes).toEqual([MAX_BATCH, 1])
  })

  it('batchSize 非法（0 / 负数）不造成死循环（下界 1）', async () => {
    const stub = await makeStub()
    const client = new EmbeddingClient({ spawnFn: spawnTo(stub), batchSize: 0 })

    const results = await client.embedMany(['a', 'b', 'c'])
    expect(results.map((r) => r.ok)).toEqual([true, true, true])
    expect(stub.batchSizes).toEqual([1, 1, 1])
  })
})

describe('票午 (b) 批次失败自动重试一次', () => {
  it('首败 + 重试成功 ⇒ 整批 ok，且重试**真发了请求**（票午 D4 的客户端面）', async () => {
    const stub = await makeStub()
    stub.failNextEmbeddings(1)
    const client = new EmbeddingClient({ spawnFn: spawnTo(stub) })

    const results = await client.embedMany(['a', 'b'])

    expect(results.map((r) => r.ok)).toEqual([true, true])
    expect(stub.hits.embeddings).toBe(2) // 空转的重试会停在 1
    expect(stub.batchSizes).toEqual([2, 2]) // 重试的是**同一批**，不是换批/切碎
    expect(client.status().ok).toBe(true) // 首败痕迹被清（冷却不残留）
  })

  it('重试有界：两次都失败 ⇒ 恰好两次请求，不是无限重试', async () => {
    const stub = await makeStub()
    stub.setEmbedStatus(500)
    const client = new EmbeddingClient({ spawnFn: spawnTo(stub) })

    const r = await client.embed('x')
    expect(r.ok === false && r.reason).toBe('bad-status')
    expect(stub.hits.embeddings).toBe(2)
  })

  it('冷却拒绝**不**触发重试（否则 30s 冷却被架空：每次调用都硬拉一只新侧车）', async () => {
    const counter = { n: 0 }
    const stub = await makeStub()
    stub.setEmbedStatus(500)
    const client = new EmbeddingClient({
      spawnFn: spawnTo(stub, counter),
      reprobeCooldownMs: 60_000,
    })

    expect((await client.embed('x')).ok).toBe(false)
    const afterFirst = counter.n
    const second = await client.embed('x')
    expect(second.ok).toBe(false)
    expect(counter.n).toBe(afterFirst) // 冷却期内不重 spawn、不重发请求
  })

  it('retryAttempts=0 ⇒ 关掉重试（首败即返回）', async () => {
    const stub = await makeStub()
    stub.failNextEmbeddings(1)
    const client = new EmbeddingClient({ spawnFn: spawnTo(stub), retryAttempts: 0 })

    const r = await client.embedMany(['a', 'b'])
    expect(r.every((x) => !x.ok)).toBe(true)
    expect(stub.hits.embeddings).toBe(1)
  })

  it('**不**重试启动类失败（spawn-failed / health-timeout）：确定性故障不该翻倍拖长', async () => {
    const counter = { n: 0 }
    const client = new EmbeddingClient({
      spawnFn: () => {
        counter.n++
        return deadChild()
      },
    })

    const r = await client.embed('x')
    expect(r.ok === false && r.reason).toBe('spawn-failed')
    expect(counter.n).toBe(1) // 只 spawn 一次
  })
})

// ─── C2 端口透出（票辰）───────────────────────────────

describe('C2 端口透出', () => {
  it('spawn 分支：status().port = 握手真实端口（不读 EMBED_SIDECAR_PORT）', async () => {
    const stub = await makeStub()
    // 反例面：env 里摆一个显眼的假端口——实现若改成「用 env 反推端口」，本断言必红
    process.env.EMBED_SIDECAR_PORT = '9999'
    try {
      const client = new EmbeddingClient({ spawnFn: spawnTo(stub) })
      expect((await client.embed('x')).ok).toBe(true)
      expect(client.status()).toMatchObject({ ok: true, port: stub.port })
      expect(stub.port).not.toBe(9999) // 防「假端口恰好是真端口」的退化
    } finally {
      delete process.env.EMBED_SIDECAR_PORT
    }
  })

  it('baseUrl 直连分支：端口由 URL 解析（同样不读 env）', async () => {
    const stub = await makeStub()
    const client = new EmbeddingClient({ baseUrl: `http://127.0.0.1:${stub.port}` })

    expect((await client.embed('x')).ok).toBe(true)
    expect(client.status()).toMatchObject({ ok: true, port: stub.port })
  })

  it('失败态无 port：spawn 失败 ⇒ status().port === undefined', async () => {
    const client = new EmbeddingClient({
      spawnFn: () => {
        throw new Error('ENOENT')
      },
    })

    expect((await client.embed('x')).ok).toBe(false)
    expect(client.status().ok).toBe(false)
    expect(client.status().port).toBeUndefined()
  })

  it('未成功态无 port：从未跑过 ⇒ ok:true 但无 port（不编一个）', () => {
    const client = new EmbeddingClient() // 不调用 embed ⇒ 既不 spawn 也不探活
    expect(client.status()).toEqual({ ok: true })
    expect(client.status().port).toBeUndefined()
  })
})

describe('parsePortFromUrl（直连分支的端口来源）', () => {
  it('正常 URL 取端口；未写端口 / 非法 URL ⇒ 0（不抛错）', () => {
    expect(parsePortFromUrl('http://127.0.0.1:8080')).toBe(8080)
    expect(parsePortFromUrl('http://127.0.0.1')).toBe(0)
    expect(parsePortFromUrl('not-a-url')).toBe(0)
    expect(parsePortFromUrl('')).toBe(0)
  })
})

// ─── B2 降级 · 起不来 ─────────────────────────────────

describe('B2 降级 · 起不来', () => {
  it('spawn 抛错 ⇒ spawn-failed，不是 []', async () => {
    const client = new EmbeddingClient({
      spawnFn: () => {
        throw new Error('ENOENT node')
      },
    })

    const r = await client.embed('x')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('spawn-failed')
    expect(logMocks.error).toHaveBeenCalledWith(
      '嵌入不可用，记忆链降级',
      expect.objectContaining({ reason: 'spawn-failed' })
    )
  })

  it('进程在握手前退出 ⇒ spawn-failed', async () => {
    const client = new EmbeddingClient({ spawnFn: () => deadChild() })
    const r = await client.embed('x')
    expect(r.ok === false && r.reason).toBe('spawn-failed')
  })

  it('探活始终不 ready ⇒ health-timeout（不假装有向量）', async () => {
    const stub = await makeStub({ ready: false })
    const client = new EmbeddingClient({
      spawnFn: spawnTo(stub),
      probeTimeoutMs: 300,
      probeIntervalMs: 30,
    })

    const r = await client.embed('x')
    expect(r.ok === false && r.reason).toBe('health-timeout')
    expect(stub.hits.embeddings).toBe(0) // 未就绪不进入请求路径
  })

  it('冷却期内不重试（不重 spawn、不重探活），冷却过后重试', async () => {
    const counter = { n: 0 }
    let stub = await makeStub()
    const client = new EmbeddingClient({
      spawnFn: () => {
        counter.n++
        return counter.n === 1 ? deadChild() : fakeChild(stub.port).child
      },
      reprobeCooldownMs: 120,
    })

    const first = await client.embed('x')
    expect(first.ok === false && first.reason).toBe('spawn-failed')

    const during = await client.embed('x') // 冷却期内：复用失败结论
    expect(during.ok === false && during.reason).toBe('spawn-failed')
    expect(counter.n).toBe(1)

    await new Promise((r) => setTimeout(r, 140))
    const after = await client.embed('x')
    expect(after.ok).toBe(true)
    expect(counter.n).toBe(2)
  })
})

// ─── B3 降级 · 超时 ───────────────────────────────────

describe('B3 降级 · 超时', () => {
  it('stub 挂起 ⇒ request-timeout，且在超时量级返回', async () => {
    const stub = await makeStub()
    stub.hangEmbeddings(true)
    const client = new EmbeddingClient({ spawnFn: spawnTo(stub), requestTimeoutMs: 120 })

    const t0 = Date.now()
    const r = await client.embed('x')
    const elapsed = Date.now() - t0
    expect(r.ok === false && r.reason).toBe('request-timeout')
    expect(elapsed).toBeLessThan(2000)
  })
})

// ─── B4 降级 · 维度不符 ───────────────────────────────

describe('B4 降级 · 维度不符', () => {
  it('回报 1024 ≠ 库内 512 ⇒ dim-mismatch，且不进入查询路径', async () => {
    const stub = await makeStub({ dim: 1024 })
    const client = new EmbeddingClient({ spawnFn: spawnTo(stub), expectedDim: () => 512 })

    const r = await client.embed('x')
    expect(r.ok === false && r.reason).toBe('dim-mismatch')
    expect(stub.hits.embeddings).toBe(0)
    expect(logMocks.error).toHaveBeenCalledWith(
      '嵌入不可用，记忆链降级',
      expect.objectContaining({ reason: 'dim-mismatch' })
    )
  })

  it('维度不符是粘性的（配置错重试无意义）——不再探活', async () => {
    const stub = await makeStub({ dim: 1024 })
    const client = new EmbeddingClient({ spawnFn: spawnTo(stub), expectedDim: () => 512 })

    await client.embed('x')
    const healthAfterFirst = stub.hits.health
    const second = await client.embed('x')

    expect(second.ok === false && second.reason).toBe('dim-mismatch')
    expect(stub.hits.health).toBe(healthAfterFirst)
    expect(client.status()).toMatchObject({ ok: false, reason: 'dim-mismatch' })
  })

  it('库内尚无向量（expectedDim=null）⇒ 跳过自检，不误杀', async () => {
    const stub = await makeStub({ dim: 1024 })
    const client = new EmbeddingClient({ spawnFn: spawnTo(stub), expectedDim: () => null })
    expect((await client.embed('x')).ok).toBe(true)
  })
})

// ─── B6 未启用 ≠ 失败 ─────────────────────────────────

describe('B6 未启用 ≠ 失败', () => {
  it('MEMORY_ENABLED=false ⇒ not-enabled，且不 spawn（零开销）', async () => {
    process.env.MEMORY_ENABLED = 'false'
    const counter = { n: 0 }
    const client = new EmbeddingClient({ spawnFn: spawnTo(await makeStub(), counter) })

    const r = await client.embed('x')
    expect(r.ok === false && r.reason).toBe('not-enabled')
    expect(counter.n).toBe(0)
    expect(logMocks.error).not.toHaveBeenCalled() // 未启用不是故障，不记 error
  })

  it('not-enabled 与 spawn-failed 可区分', async () => {
    process.env.MEMORY_ENABLED = 'false'
    const disabled = new EmbeddingClient({ spawnFn: () => deadChild() })
    const r1 = await disabled.embed('x')

    process.env.MEMORY_ENABLED = 'true'
    const broken = new EmbeddingClient({ spawnFn: () => deadChild() })
    const r2 = await broken.embed('x')

    expect(r1.ok === false && r1.reason).toBe('not-enabled')
    expect(r2.ok === false && r2.reason).toBe('spawn-failed')
  })
})

// ─── 其它降级面 ───────────────────────────────────────

describe('bad-status', () => {
  it('嵌入端点非 200 ⇒ bad-status', async () => {
    const stub = await makeStub()
    stub.setEmbedStatus(500)
    const client = new EmbeddingClient({ spawnFn: spawnTo(stub) })

    const r = await client.embed('x')
    expect(r.ok === false && r.reason).toBe('bad-status')
  })

  it('响应条目数不符 ⇒ bad-status（不静默错位）', async () => {
    const stub = await makeStub()
    const client = new EmbeddingClient({ spawnFn: spawnTo(stub) })
    expect((await client.embedMany(['a', 'b'])).map((r) => r.ok)).toEqual([true, true])

    stub.setDataCount(1) // 请求 2 条只回 1 条
    const r = await client.embedMany(['a', 'b'])
    expect(r.every((x) => !x.ok && x.reason === 'bad-status')).toBe(true)
  })
})

// ─── 票 F1-a 非 2xx 读 body · 根因可见 ────────────────

describe('票 F1-a 非 2xx 的 detail 带根因', () => {
  /** sidecar 的真实形态（`embed-server.mjs:161` 的 sendJson(500, {ok,reason,detail})） */
  const SIDECAR_ERROR = JSON.stringify({
    ok: false,
    reason: 'internal',
    detail: '模型加载失败: xxx',
  })

  it('根因在 body 里 ⇒ detail 带出来（改前恒为 `HTTP 500`，本断言必红）', async () => {
    const stub = await makeStub()
    stub.setEmbedStatus(500)
    stub.setEmbedErrorBody(SIDECAR_ERROR)
    const client = new EmbeddingClient({ spawnFn: spawnTo(stub) })

    const r = await client.embed('x')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('bad-status')
    // 承重断言：改前 detail = 'POST /v1/embeddings → HTTP 500'，不含任何根因
    expect(r.ok === false && r.detail).toContain('模型加载失败: xxx')
    expect(r.ok === false && r.detail).toContain('reason=internal')
  })

  it('落痕同面：日志里的 detail 也带根因（「生产上嵌入为什么挂」才答得出）', async () => {
    const stub = await makeStub()
    stub.setEmbedStatus(500)
    stub.setEmbedErrorBody(SIDECAR_ERROR)
    const client = new EmbeddingClient({ spawnFn: spawnTo(stub) })

    await client.embed('x')

    expect(logMocks.error).toHaveBeenCalledWith(
      '嵌入不可用，记忆链降级',
      expect.objectContaining({
        reason: 'bad-status',
        detail: expect.stringContaining('模型加载失败: xxx'),
      })
    )
  })

  it('非 JSON body ⇒ 回落旧文案，不新增失败态', async () => {
    const stub = await makeStub()
    stub.setEmbedStatus(500)
    stub.setEmbedErrorBody('<html>500 Internal Server Error</html>')
    const client = new EmbeddingClient({ spawnFn: spawnTo(stub), retryAttempts: 0 })

    const r = await client.embed('x')
    expect(r.ok === false && r.reason).toBe('bad-status')
    expect(r.ok === false && r.detail).toBe('POST /v1/embeddings → HTTP 500')
  })

  it('空 body ⇒ 回落旧文案', async () => {
    const stub = await makeStub()
    stub.setEmbedStatus(500)
    stub.setEmbedErrorBody('')
    const client = new EmbeddingClient({ spawnFn: spawnTo(stub), retryAttempts: 0 })

    const r = await client.embed('x')
    expect(r.ok === false && r.reason).toBe('bad-status')
    expect(r.ok === false && r.detail).toBe('POST /v1/embeddings → HTTP 500')
  })

  it('JSON 但不是根因形态（无 reason/detail）⇒ 同样回落，不编内容', async () => {
    const stub = await makeStub()
    stub.setEmbedStatus(503)
    stub.setEmbedErrorBody(JSON.stringify({ error: 'unavailable' }))
    const client = new EmbeddingClient({ spawnFn: spawnTo(stub), retryAttempts: 0 })

    const r = await client.embed('x')
    expect(r.ok === false && r.detail).toBe('POST /v1/embeddings → HTTP 503')
  })

  it('读 body 本身抛错（半截 body 后断链）⇒ 回落，不升级成未捕获异常', async () => {
    const stub = await makeStub()
    stub.setEmbedStatus(500)
    stub.setEmbedErrorBody(SIDECAR_ERROR)
    stub.setEmbedAbortAfter(12) // 写 12 字节就 destroy ⇒ 客户端读 body 抛
    const client = new EmbeddingClient({ spawnFn: spawnTo(stub), retryAttempts: 0 })

    const r = await client.embed('x')
    expect(r.ok === false && r.reason).toBe('bad-status')
    expect(r.ok === false && r.detail).toBe('POST /v1/embeddings → HTTP 500')
  })

  it('超长 detail 截断到 500 字符（长度不受本模块控制）', async () => {
    const stub = await makeStub()
    stub.setEmbedStatus(500)
    stub.setEmbedErrorBody(
      JSON.stringify({ ok: false, reason: 'internal', detail: 'x'.repeat(5000) })
    )
    const client = new EmbeddingClient({ spawnFn: spawnTo(stub), retryAttempts: 0 })

    const r = await client.embed('x')
    const detail = (r.ok === false && r.detail) || ''
    // 截断作用在**根因段**上（`|` 之后）：恰好 500 字符，且切的是根因串本身
    // （改前 detail 恒为 `POST /v1/embeddings → HTTP 500`，本断言必红）
    const extra = detail.slice(detail.indexOf(' | ') + 3)
    expect(extra).toHaveLength(500)
    // 短字段（reason）在前 ⇒ 截断先切长字段（detail），契约信息不因截断而丢
    expect(/^reason=internal x+$/.test(extra)).toBe(true)
    expect(detail).toContain('POST /v1/embeddings → HTTP 500') // 前缀文案不变
  })
})

// ─── 票 F1-b defaultSpawn 接管 stderr ─────────────────
//
// 本组**不 mock 子进程**：被测面就是 `defaultSpawn` 与**真实管道**的关系，
// 换成 PassThrough 假 child 等于把被测对象换成替身（自证）。
// 真 spawn 一个假 sidecar（临时 .mjs），走完整「握手 → /health → /v1/embeddings」。

const STUB_SIDECAR_SRC = `import { createServer } from 'node:http'

// F1-b 假 sidecar：**先灌 stderr、后握手**——顺序即病灶。真实 sidecar 的模型加载失败 /
// OOM / 端口占用 / 异常栈都发生在 listen 之前，正是「冷启动期」那一段。
const mode = process.env.F1_STUB_STDERR || 'boom'
if (mode === 'flood') {
  const chunk = 'x'.repeat(8192)
  for (let i = 0; i < 256; i++) process.stderr.write(chunk) // 2MB ≫ 管道缓冲（约 64KB）
} else {
  process.stderr.write('boom\\n')
}

const dim = 3
const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, ready: true, model: 'f1-stub', dim: dim }))
    return
  }
  if (req.url === '/v1/embeddings' && req.method === 'POST') {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const input = JSON.parse(Buffer.concat(chunks).toString()).input
      const texts = typeof input === 'string' ? [input] : input
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          model: 'f1-stub',
          dim: dim,
          data: texts.map((t, index) => ({ index: index, embedding: [t.length, 0, 0] })),
        })
      )
    })
    return
  }
  res.writeHead(404).end()
})

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(
    'EMBED_SIDECAR_READY ' +
      JSON.stringify({ port: server.address().port, host: '127.0.0.1' }) +
      '\\n'
  )
})
`

/** 有界等待（stderr 落痕与 HTTP 往返是两条独立异步链） */
async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('票 F1-b defaultSpawn 接管 stderr', () => {
  let tmpDir: string
  let scriptPath: string
  let live: EmbeddingClient | null = null

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1-sidecar-'))
    scriptPath = path.join(tmpDir, 'stub-sidecar.mjs')
    fs.writeFileSync(scriptPath, STUB_SIDECAR_SRC)
  })

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* 子进程刚被杀、句柄尚未释放（Windows）——临时目录在系统 tmp 下，留着无害 */
    }
  })

  afterEach(() => {
    live?.stop()
    live = null
    delete process.env.F1_STUB_STDERR
  })

  it('stderr 有痕：假 sidecar 写 `boom` ⇒ 日志出现该内容', async () => {
    process.env.F1_STUB_STDERR = 'boom'
    live = new EmbeddingClient({ scriptPath, probeTimeoutMs: 5000, requestTimeoutMs: 5000 })

    expect((await live.embed('abcd')).ok).toBe(true)
    await waitFor(() => logMocks.error.mock.calls.some(([msg]) => msg === 'sidecar stderr'), 2000)
    // 改前：整个模块没有任何 `.on('data')`，stderr 一条不落 ⇒ 本断言必红
    expect(logMocks.error).toHaveBeenCalledWith(
      'sidecar stderr',
      expect.objectContaining({ text: expect.stringContaining('boom') })
    )
  })

  it('**不阻塞**：连续写 >1MB 到 stderr，探活 / 请求仍能完成', async () => {
    process.env.F1_STUB_STDERR = 'flood'
    live = new EmbeddingClient({ scriptPath, probeTimeoutMs: 5000, requestTimeoutMs: 5000 })

    const r = await live.embed('abcd')

    // 改前：stderr 无读者 ⇒ 管道写满后子进程在 `process.stderr.write` 阻塞 ⇒
    // 永远走不到 listen ⇒ 握手不发 ⇒ 客户端 spawn-failed（本断言是本票唯一能证明
    // 「第二重害 = 挂死而非报错」的用例）
    expect(r.ok).toBe(true)
    expect(r.ok && r.vector.slice(0, 3)).toEqual([4, 0, 0])

    // 截断上限：2MB 被切成多块落痕，每块都必须 ≤ 500 字符
    const calls = logMocks.error.mock.calls.filter(([msg]) => msg === 'sidecar stderr')
    expect(calls.length).toBeGreaterThan(0)
    for (const [, meta] of calls) {
      expect(String((meta as { text: string }).text).length).toBeLessThanOrEqual(500)
    }
  })
})

describe('stop()', () => {
  it('只杀本进程 spawn 的 child（句柄清零）', async () => {
    const stub = await makeStub()
    const handles: Array<{ killed: () => boolean }> = []
    const client = new EmbeddingClient({
      spawnFn: () => {
        const f = fakeChild(stub.port)
        handles.push({ killed: f.killed })
        return f.child
      },
    })

    await client.embed('x')
    client.stop()
    expect(handles).toHaveLength(1)
    expect(handles[0].killed()).toBe(true)
  })

  // ─── 票巳 (a)：StopReceipt 四条可达分支 ────────────────────
  // 回执是「回收到底有没有发生」的**唯一可判面**（票丁 OQ4 的判定规则正建立在它之上），
  // 故它自己必须有断言 —— 上面那条既有用例只看 kill 副作用、把返回值丢掉，
  // 改动后照旧绿 = 「测试不挡新行为」的假绿面。

  it('spawn 分支：握手后 stop() ⇒ port = 握手真实端口、killedChild=true', async () => {
    const stub = await makeStub()
    const client = new EmbeddingClient({ spawnFn: spawnTo(stub) })

    expect((await client.embed('x')).ok).toBe(true)
    expect(client.stop()).toEqual({ port: stub.port, killedChild: true })
  })

  it('反例面：env 摆假端口也不进回执（port 是握手真值，不是 env 反推）', async () => {
    const stub = await makeStub()
    // 实现若改成「用 EMBED_SIDECAR_PORT 反推」，本断言必红
    process.env.EMBED_SIDECAR_PORT = '9999'
    try {
      const client = new EmbeddingClient({ spawnFn: spawnTo(stub) })
      expect((await client.embed('x')).ok).toBe(true)

      const receipt = client.stop()
      expect(receipt.port).toBe(stub.port)
      expect(receipt.port).not.toBe(9999)
    } finally {
      delete process.env.EMBED_SIDECAR_PORT
    }
  })

  it('baseUrl 直连分支（无 child）⇒ killedChild=false，port 仍由 URL 解析', async () => {
    const stub = await makeStub()
    const client = new EmbeddingClient({ baseUrl: `http://127.0.0.1:${stub.port}` })

    expect((await client.embed('x')).ok).toBe(true)
    // 直连不 spawn ⇒ 「本次关停无进程可回收」必须如实报 false，不能与「有 child 但杀失败」混淆
    expect(client.stop()).toEqual({ port: stub.port, killedChild: false })
  })

  it('live 已被 drop（失败即杀进程）⇒ 退到 lastSuccess 的握手端口、killedChild=false', async () => {
    const stub = await makeStub()
    // retryAttempts:0 —— 挡掉「首败自动重试」重新 spawn 出一条 live，否则本用例测不到右支
    const client = new EmbeddingClient({ spawnFn: spawnTo(stub), retryAttempts: 0 })

    expect((await client.embed('x')).ok).toBe(true)
    stub.setEmbedStatus(500)
    expect((await client.embed('x')).ok).toBe(false) // 失败路径已 dropSidecar：live 清零、child 被杀

    // live 缺席 ⇒ 走 `live?.port ?? lastSuccess?.port` 的**右支**（port 依旧是握手真值）
    expect(client.stop()).toEqual({ port: stub.port, killedChild: false })
  })

  it('从未连接 ⇒ 不编端口：port undefined 且 killedChild=false', () => {
    const client = new EmbeddingClient() // 不 embed ⇒ 既不 spawn 也不探活

    const receipt = client.stop()
    expect(receipt.killedChild).toBe(false)
    expect(receipt.port).toBeUndefined()
  })

  // 未覆盖：`port && port > 0` 的 `>0` 分支在本仓**不可达**，故不造假用例去「覆盖」它 ——
  // 握手解析已拒 `info.port <= 0`（embedding-client.ts 的 awaitHandshake），直连分支只有
  // URL 省略端口时 parsePortFromUrl 才回 0，而那意味着请求打到默认 80（stub 占不住、
  // 真机 sidecar 也不用 80）⇒ live 根本建不起来。属防御性守卫，本组只钉四条可达分支。
})
