/**
 * embedding.ts（客户端代理）测试 —— 覆盖票丁 B6 / B9 与代理接线。
 *
 * 本文件不加载模型、不 spawn 真 sidecar：stub HTTP server 走 `baseUrl` 通道，
 * spawn 通道由 embedding-client.test.ts 覆盖。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository } from '../db/repository/index.js'
import { EmbeddingClient, SIDECAR_SCRIPT_PATH } from './embedding-client.js'
import {
  __setEmbeddingClientForTest,
  embedText,
  getEmbeddingStatus,
  isMemoryEnabled,
  resolveStoredVectorDim,
  startEmbeddingSidecar,
  stopEmbeddingSidecar,
} from './embedding.js'

const logMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../logger.js', () => ({ createLogger: () => logMocks }))

const HERE = fileURLToPath(new URL('.', import.meta.url))

// ─── stub sidecar（只回 /health + 向量）───────────────

let stub: { server: Server; port: number } | null = null

async function startStub(dim = 512): Promise<string> {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, ready: true, model: 'stub-model', dim }))
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const input = JSON.parse(Buffer.concat(chunks).toString()).input
      const texts: string[] = typeof input === 'string' ? [input] : input
      const vec = Array.from({ length: dim }, (_, i) => (i === 0 ? 7 : 0))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          model: 'stub-model',
          dim,
          data: texts.map((_, index) => ({ index, embedding: vec })),
        })
      )
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  stub = { server, port }
  return `http://127.0.0.1:${port}`
}

/** 假 sidecar 子进程：只发一行端口握手（口径同 embedding-client.test.ts 的 fakeChild） */
function handshakeChild(port: number) {
  const stdout = new PassThrough()
  setImmediate(() => stdout.write(`EMBED_SIDECAR_READY {"port":${port},"host":"127.0.0.1"}\n`))
  return {
    stdout,
    stderr: new PassThrough(),
    kill: () => true,
    once: () => null,
  } as any
}

beforeEach(() => {
  vi.clearAllMocks()
  __setEmbeddingClientForTest(null)
})

afterEach(async () => {
  stopEmbeddingSidecar()
  __setEmbeddingClientForTest(null)
  if (stub) {
    const s = stub
    stub = null
    await new Promise<void>((r) => s.server.close(() => r()))
  }
  resetDb()
  delete process.env.MEMORY_ENABLED
  delete process.env.EMBED_SIDECAR_PORT
})

// ─── B9 模型真在进程外 ────────────────────────────────

describe('B9 模型真在进程外', () => {
  it('embedding.ts 源码不含 pipeline( 调用（静态断言，防「嘴上搬出去」）', () => {
    const source = readFileSync(`${HERE}embedding.ts`, 'utf-8')
    expect(source).not.toContain('pipeline(')
    expect(source).not.toContain('@huggingface/transformers')
  })

  it('spawn 走 node + 绝对路径，不用 shell（Windows EINVAL 铁律）', () => {
    const source = readFileSync(`${HERE}embedding-client.ts`, 'utf-8')
    expect(source).toContain('spawn(process.execPath, [scriptPath]')
    expect(source).toContain('windowsHide: true')
    expect(source).not.toContain('shell: true')
    expect(source).not.toContain('execSync')
  })

  it('sidecar 脚本落点存在（客户端解析出的路径可执行）', () => {
    expect(existsSync(SIDECAR_SCRIPT_PATH)).toBe(true)
    const source = readFileSync(SIDECAR_SCRIPT_PATH, 'utf-8')
    expect(source).toContain("pipeline('feature-extraction'") // 模型真身在此
  })
})

// ─── B6 未启用 ≠ 失败 ─────────────────────────────────

describe('B6 未启用 ≠ 失败', () => {
  it('MEMORY_ENABLED=false ⇒ not-enabled（不是 spawn-failed）', async () => {
    process.env.MEMORY_ENABLED = 'false'
    expect(isMemoryEnabled()).toBe(false)

    const r = await embedText('x')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toBe('not-enabled')
  })

  it('未启用时 startEmbeddingSidecar 不 spawn（零开销）', async () => {
    process.env.MEMORY_ENABLED = 'false'
    await startEmbeddingSidecar()
    expect(logMocks.info).toHaveBeenCalledWith(
      '记忆功能未启用（MEMORY_ENABLED=false），嵌入 sidecar 不启动'
    )
  })
})

// ─── 代理接线 ─────────────────────────────────────────

describe('代理接线', () => {
  it('embedText 转给客户端；status 反映就绪信息', async () => {
    process.env.MEMORY_ENABLED = 'true'
    const baseUrl = await startStub()
    __setEmbeddingClientForTest(new EmbeddingClient({ baseUrl }))

    const r = await embedText('中文')
    expect(r.ok).toBe(true)
    expect(r.ok && r.vector).toHaveLength(512)
    expect(getEmbeddingStatus()).toMatchObject({ ok: true, model: 'stub-model', dim: 512 })
  })

  it('sidecar 挂掉 ⇒ embedText 报明确 reason（不再静默空数组）', async () => {
    process.env.MEMORY_ENABLED = 'true'
    __setEmbeddingClientForTest(
      new EmbeddingClient({
        spawnFn: () => {
          throw new Error('ENOENT')
        },
        reprobeCooldownMs: 60_000,
      })
    )

    const r = await embedText('x')
    expect(r.ok === false && r.reason).toBe('spawn-failed')
    expect(getEmbeddingStatus()).toMatchObject({ ok: false, reason: 'spawn-failed' })
  })

  it('start/stop 成对：stop 关掉本进程 spawn 的 child 并复位单例', async () => {
    process.env.MEMORY_ENABLED = 'true'
    const baseUrl = await startStub(512)
    let killed = 0
    __setEmbeddingClientForTest(
      new EmbeddingClient({ baseUrl, spawnFn: () => ({ kill: () => (killed++, true) }) as any })
    )
    // baseUrl 路径不 spawn ⇒ kill 计数保持 0；这里断言 stop 不炸且单例复位
    await startEmbeddingSidecar()
    expect(logMocks.info).toHaveBeenCalledWith('嵌入 sidecar 就绪', {
      model: 'stub-model',
      dim: 512,
      // baseUrl 直连分支：端口由 URL 解析（票辰）
      port: stub!.port,
    })
    stopEmbeddingSidecar()
    expect(killed).toBe(0)
  })

  // ─── C1 端口进就绪日志（票辰）─────────────────────────

  it('C1 就绪日志的 port = 握手真实端口，不是 env 值', async () => {
    process.env.MEMORY_ENABLED = 'true'
    const baseUrl = await startStub(512)
    const realPort = stub!.port
    // 反例面：env 里摆一个假端口——若实现改成「用 env 反推」，日志的 port 会变成 9999
    process.env.EMBED_SIDECAR_PORT = '9999'
    __setEmbeddingClientForTest(new EmbeddingClient({ spawnFn: () => handshakeChild(realPort) }))

    await startEmbeddingSidecar()

    expect(realPort).not.toBe(9999)
    expect(logMocks.info).toHaveBeenCalledWith('嵌入 sidecar 就绪', {
      model: 'stub-model',
      dim: 512,
      port: realPort,
    })
    expect(baseUrl).toContain(String(realPort)) // 握手端口确实是探活命中的那个
  })
})

// ─── 维度自检的比对基准 ───────────────────────────────

describe('resolveStoredVectorDim', () => {
  beforeEach(() => {
    setDb(createTestDb())
    initRepository(getDb())
  })

  it('空库 ⇒ null（跳过自检，不误杀）', () => {
    expect(resolveStoredVectorDim()).toBeNull()
  })

  it('chunk_vectors 有向量 ⇒ 按 BLOB 字节数 / 4 得维度（vec0 读出的仍是 f32 BLOB）', () => {
    const db = getDb()
    // vec0 表不在 createTestDb 的手搓 schema 里 —— 按生产迁移 DDL 建（幂等）
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING vec0(
         chunk_id INTEGER PRIMARY KEY, embedding float[512]
       )`
    )
    db.prepare('INSERT INTO chunk_vectors (chunk_id, embedding) VALUES (?, ?)').run(
      BigInt(1),
      Buffer.from(new Float32Array(512).buffer)
    )
    expect(resolveStoredVectorDim()).toBe(512)
  })

  it('chunk_vectors 缺席（存量库未重启）⇒ 回落到 knowledge，不整体判失败', () => {
    getDb()
      .prepare(`INSERT INTO knowledge (id, content, embedding) VALUES ('k9', 'c', ?)`)
      .run(Buffer.from(new Float32Array(512).buffer))
    expect(resolveStoredVectorDim()).toBe(512)
  })

  it('只有 knowledge 有向量也认（同源格式）', () => {
    getDb()
      .prepare(`INSERT INTO knowledge (id, content, embedding) VALUES ('k1', 'c', ?)`)
      .run(Buffer.from(new Float32Array(1024).buffer))
    expect(resolveStoredVectorDim()).toBe(1024)
  })

  it('向量列为 NULL ⇒ null（不拿 0 当维度）', () => {
    getDb().prepare(`INSERT INTO knowledge (id, content, embedding) VALUES ('k2', 'c', NULL)`).run()
    expect(resolveStoredVectorDim()).toBeNull()
  })
})
