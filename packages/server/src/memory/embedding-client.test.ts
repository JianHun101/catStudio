/**
 * embedding-client 测试 —— 覆盖票丁 B1–B6。
 *
 * mock 边界：子进程（假 child，stdout 只发端口握手）+ 网络（真起 127.0.0.1 stub
 * HTTP server）。**不 mock fetch / 不 mock server**——被测面就是这套 HTTP 协议本身。
 * 不加载模型：stub 直接回向量。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { PassThrough } from 'node:stream'
import {
  EmbeddingClient,
  MAX_BATCH,
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
}

/** 真起一个 127.0.0.1 stub sidecar */
async function startStub(initialHealth: Record<string, unknown> = {}): Promise<StubSidecar> {
  let health = { ok: true, ready: true, model: 'stub-model', dim: 512, ...initialHealth }
  const hits = { health: 0, embeddings: 0 }
  const batchSizes: number[] = []
  let embedStatus = 200
  let hang = false
  let dataCount: number | undefined

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
          res.end(JSON.stringify({ ok: false, reason: 'boom' }))
          return
        }
        const input = JSON.parse(Buffer.concat(chunks).toString()).input
        const texts: string[] = typeof input === 'string' ? [input] : input
        batchSizes.push(texts.length)
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

  it('embedMany 按 MAX_BATCH 分块（调用方不必知道上限）', async () => {
    const stub = await makeStub()
    const client = new EmbeddingClient({ spawnFn: spawnTo(stub) })

    const results = await client.embedMany(Array.from({ length: MAX_BATCH + 1 }, () => 'x'))
    expect(results).toHaveLength(MAX_BATCH + 1)
    expect(results.every((r) => r.ok)).toBe(true)
    expect(stub.batchSizes).toEqual([MAX_BATCH, 1])
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
})
