/**
 * embed-server.mjs HTTP 层测试 —— 假 embed 注入，**不加载模型**。
 *
 * 被测面：路由 / 输入归一化 / 批量上限 / 就绪门 / 仅本机监听。
 * 不测：真实模型推理（e2e 覆盖，见 embed-server.e2e.mjs）。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  MAX_BATCH,
  MAX_RERANK_PAIRS,
  RERANK_MODEL,
  createEmbedServer,
  isFetchReachable,
  resolveTransformersEntry,
} from './embed-server.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SIDECAR_SRC_PATH = resolve(__dirname, 'embed-server.mjs')
const CLIENT_SRC_PATH = resolve(__dirname, '../../packages/server/src/memory/embedding-client.ts')
/** 折叠空白：静态断言只认符号配对，不认换行/缩进排版 */
const squash = (s) => s.replace(/\s+/g, ' ')

/** 假嵌入：维度 3，值 = 文本长度（可断言顺序与内容） */
const fakeEmbed = async (texts) => texts.map((t) => [t.length, 3, 1])

let app
let base

beforeAll(async () => {
  app = createEmbedServer({ embed: fakeEmbed, getModel: () => 'fake-model', getDim: () => 3 })
  const port = await app.listen(0)
  base = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await app.close()
})

const post = (body) =>
  fetch(`${base}/v1/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

describe('embed-server', () => {
  describe('监听面', () => {
    it('默认只监听 127.0.0.1（不得放宽到 0.0.0.0）', () => {
      expect(app.host).toBe('127.0.0.1')
      expect(app.server.address().address).toBe('127.0.0.1')
    })

    it('import 期不加载模型（本文件全程未加载 transformers 仍可服务）', () => {
      // 能跑到这里本身就是断言：createEmbedServer 不依赖模型
      expect(typeof app.listen).toBe('function')
    })
  })

  describe('依赖入口解析（换壳不换语义）', () => {
    it('取 ESM 构建（.node.mjs），不是 require 条件的 .node.cjs', () => {
      const entry = resolveTransformersEntry()
      expect(entry).toMatch(/transformers\.node\.mjs$/)
      expect(entry).not.toMatch(/\.cjs$/)
      expect(existsSync(fileURLToPath(entry))).toBe(true)
    })
  })

  describe('GET /health', () => {
    it('回报 ready / model / dim', async () => {
      const res = await fetch(`${base}/health`)
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({
        ok: true,
        ready: true,
        model: 'fake-model',
        dim: 3,
      })
    })

    it('未就绪 ⇒ ready:false（模型加载中不假装可用）', async () => {
      const cold = createEmbedServer({
        embed: fakeEmbed,
        getReady: () => false,
        getError: () => 'loading',
      })
      const port = await cold.listen(0)
      try {
        const body = await (await fetch(`http://127.0.0.1:${port}/health`)).json()
        expect(body.ready).toBe(false)
        expect(body.error).toBe('loading')
      } finally {
        await cold.close()
      }
    })
  })

  describe('POST /v1/embeddings', () => {
    it('string input ⇒ 单条向量', async () => {
      const res = await post({ input: 'abcd' })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.model).toBe('fake-model')
      expect(body.dim).toBe(3)
      expect(body.data).toEqual([{ index: 0, embedding: [4, 3, 1] }])
    })

    it('array input ⇒ 按 index 对齐，条数一致', async () => {
      const body = await (await post({ input: ['aa', 'bbbb'] })).json()
      expect(body.data.map((d) => d.index)).toEqual([0, 1])
      expect(body.data.map((d) => d.embedding[0])).toEqual([2, 4])
    })

    it(`批量上限 ${MAX_BATCH}：超一条即 400 batch-too-large`, async () => {
      const okBody = await post({ input: Array.from({ length: MAX_BATCH }, () => 'x') })
      expect(okBody.status).toBe(200)

      const res = await post({ input: Array.from({ length: MAX_BATCH + 1 }, () => 'x') })
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ reason: 'batch-too-large', limit: MAX_BATCH })
    })

    it('坏 input ⇒ 400 bad-input（空数组 / 空串 / 非字符串）', async () => {
      for (const input of [[], '', ['ok', ''], [1, 2], { a: 1 }, undefined]) {
        const res = await post({ input })
        expect(res.status, `input=${JSON.stringify(input)}`).toBe(400)
        expect((await res.json()).reason).toBe('bad-input')
      }
    })

    it('非 JSON body ⇒ 400 bad-json（不 500）', async () => {
      const res = await post('{not json')
      expect(res.status).toBe(400)
      expect((await res.json()).reason).toBe('bad-json')
    })

    it('模型未就绪 ⇒ 503 model-not-ready', async () => {
      const cold = createEmbedServer({ embed: fakeEmbed, getReady: () => false })
      const port = await cold.listen(0)
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input: 'x' }),
        })
        expect(res.status).toBe(503)
        expect((await res.json()).reason).toBe('model-not-ready')
      } finally {
        await cold.close()
      }
    })

    it('未知路径 / 错误方法 ⇒ 404', async () => {
      expect((await fetch(`${base}/v1/other`)).status).toBe(404)
      expect((await fetch(`${base}/health`, { method: 'POST' })).status).toBe(404)
      expect((await fetch(`${base}/v1/embeddings`)).status).toBe(404) // GET ≠ POST
    })
  })

  // ─── 重排口（R13a）──────────────────────────────────────
  describe('POST /v1/rerank', () => {
    /** 假重排：分数 = 首个 passage 的长度（可断言**顺序与对齐**，与假嵌入同款手法） */
    const fakeRerank = async (pairs) => pairs.map((p) => p.passage.length / 1000)

    /** 起一只带重排能力的 server，用完即关（避免污染共享的 `app`） */
    const withRerank = async (overrides, fn) => {
      const s = createEmbedServer({
        embed: fakeEmbed,
        getModel: () => 'fake-model',
        rerank: fakeRerank,
        ...overrides,
      })
      const port = await s.listen(0)
      try {
        return await fn(`http://127.0.0.1:${port}`)
      } finally {
        await s.close()
      }
    }

    const postRerank = (b, body) =>
      fetch(`${b}/v1/rerank`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      })

    it('pairs ⇒ scores 按 index 逐位对齐', async () => {
      await withRerank({}, async (b) => {
        const res = await postRerank(b, {
          pairs: [
            { query: 'q1', passage: 'aaa' },
            { query: 'q2', passage: 'aaaaa' },
          ],
        })
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.model).toBe(RERANK_MODEL)
        expect(body.scores).toEqual([0.003, 0.005])
      })
    })

    it('未注入 rerank ⇒ 503 rerank-unavailable（不是 404：路由在、能力不在）', async () => {
      const res = await postRerank(base, { pairs: [{ query: 'q', passage: 'p' }] })
      expect(res.status).toBe(503)
      expect((await res.json()).reason).toBe('rerank-unavailable')
    })

    it(`恰好 ${MAX_RERANK_PAIRS} 对 ⇒ 200（不截池的边界）；超一对 ⇒ 400 batch-too-large`, async () => {
      await withRerank({}, async (b) => {
        const pair = { query: 'q', passage: 'p' }
        const ok = await postRerank(b, {
          pairs: Array.from({ length: MAX_RERANK_PAIRS }, () => pair),
        })
        expect(ok.status).toBe(200)
        expect((await ok.json()).scores).toHaveLength(MAX_RERANK_PAIRS)

        const over = await postRerank(b, {
          pairs: Array.from({ length: MAX_RERANK_PAIRS + 1 }, () => pair),
        })
        expect(over.status).toBe(400)
        expect(await over.json()).toMatchObject({
          reason: 'batch-too-large',
          limit: MAX_RERANK_PAIRS,
        })
      })
    })

    it('坏 pairs ⇒ 400 bad-input（整批拒，不静默跳过坏条）', async () => {
      await withRerank({}, async (b) => {
        for (const pairs of [
          [],
          undefined,
          'notarray',
          [{ query: 'q' }],
          [{ passage: 'p' }],
          [{ query: '', passage: 'p' }],
          [{ query: 'q', passage: '' }],
          [{ query: 1, passage: 'p' }],
          ['string'],
        ]) {
          const res = await postRerank(b, { pairs })
          expect(res.status, `pairs=${JSON.stringify(pairs)}`).toBe(400)
          expect((await res.json()).reason).toBe('bad-input')
        }
      })
    })

    it('非 JSON body ⇒ 400 bad-json（不 500）', async () => {
      await withRerank({}, async (b) => {
        const res = await postRerank(b, '{not json')
        expect(res.status).toBe(400)
        expect((await res.json()).reason).toBe('bad-json')
      })
    })

    it('**首调即加载**：就绪态为 false 时仍必须放行（不设前置就绪门）', async () => {
      // 与 /v1/embeddings 的刻意分叉：重排模型懒加载，就绪由**本次调用**推动。
      // 若照嵌入那样先判 getReady()，首次请求必然 503，而它正是唯一能加载起模型的那次
      // ⇒ 功能被锁死在「永远不就绪」。这条钉住那个分叉。
      await withRerank({ getReady: () => false }, async (b) => {
        const res = await postRerank(b, { pairs: [{ query: 'q', passage: 'pp' }] })
        expect(res.status).toBe(200)
        expect((await res.json()).scores).toEqual([0.002])
      })
    })

    it('模型加载失败 ⇒ 503 model-not-ready；推理失败 ⇒ 503 rerank-failed', async () => {
      const loadFail = async () => {
        const e = new Error('权重拿不到')
        e.code = 'MODEL_LOAD_FAILED'
        throw e
      }
      await withRerank({ rerank: loadFail }, async (b) => {
        const res = await postRerank(b, { pairs: [{ query: 'q', passage: 'p' }] })
        expect(res.status).toBe(503)
        expect(await res.json()).toMatchObject({ reason: 'model-not-ready', detail: '权重拿不到' })
      })
      await withRerank(
        {
          rerank: async () => {
            throw new Error('ONNX 崩了')
          },
        },
        async (b) => {
          const res = await postRerank(b, { pairs: [{ query: 'q', passage: 'p' }] })
          expect(res.status).toBe(503)
          expect((await res.json()).reason).toBe('rerank-failed')
        }
      )
    })

    it('返回条数 ≠ 请求条数 ⇒ 500 shape-mismatch（不给错位的 scores）', async () => {
      await withRerank({ rerank: async () => [0.5] }, async (b) => {
        const res = await postRerank(b, {
          pairs: [
            { query: 'q', passage: 'p' },
            { query: 'q', passage: 'p' },
          ],
        })
        expect(res.status).toBe(500)
        expect((await res.json()).reason).toBe('shape-mismatch')
      })
    })

    it('GET ⇒ 404（方法不对）', async () => {
      expect((await fetch(`${base}/v1/rerank`)).status).toBe(404)
    })
  })
})

// ─── S0 教训固化成守卫（R13a §三 / §六 A5）──────────────────────
// S0 实测：pipeline('text-classification') 对本模型恒返回 score:1（softmax-of-one），
// 后果不是报错而是**臂③ ≡ 臂① ⇒ 报告「重排无效」⇒ 票被关错**。这条守卫钉住可用路径，
// 防止后来者「简化」回 pipeline —— 那会静默把尺子变成恒绿。
describe('重排加载路径守卫（S0 教训）', () => {
  const sidecarSrc = readFileSync(SIDECAR_SRC_PATH, 'utf8')
  /** 只取重排器一节：全文搜会误命中文件头注释里**解释为何弃用**的那几行 */
  const rerankerSrc = squash(
    sidecarSrc.slice(
      sidecarSrc.indexOf('export function createTransformersReranker'),
      sidecarSrc.indexOf('export function createEmbedServer')
    )
  )

  it('用 AutoModelForSequenceClassification，不用 text-classification pipeline', () => {
    expect(rerankerSrc).toContain('AutoModelForSequenceClassification.from_pretrained')
    expect(rerankerSrc).not.toContain("pipeline('text-classification'")
    expect(rerankerSrc).not.toContain("pipeline('text-ranking'")
  })

  it('显式 sigmoid（单 logit 相关度）——缺它即退化成 softmax ≡ 1', () => {
    expect(rerankerSrc).toContain('.sigmoid()')
  })

  it('模型名与 dtype 是模块常量，**无 env 旋钮**（离线与生产必须同模型）', () => {
    expect(rerankerSrc).toContain('dtype = RERANK_DTYPE')
    expect(rerankerSrc).not.toMatch(/process\.env\.RERANK/)
  })
})

// ─── 父子关停配对（票巳 (c)）────────────────────────────────────
// 票面原判「非 Windows killTree 只杀 server ⇒ sidecar 成孤儿」**已实测证伪**：
// 父进程无论软杀硬杀，OS 回收时都会关掉管道写端 → 子进程 stdin 收 EOF → 自退
// （孤立实测 + 阳性/阴性对照，见交接文档；真进程复现见 embed-server.e2e.mjs）。
//
// 但这条自检**是配对才活的**：子侧注册 stdin 自检 + 父侧用 pipe 起进程，缺任一侧
// 它都是死代码（写成 'ignore' 就永远收不到 EOF）。本组把这对配对钉死——纯源码断言，
// 不加载模型。
describe('关停自检（票巳 (c)：父子配对，缺一侧即死代码）', () => {
  const sidecarSrc = squash(readFileSync(SIDECAR_SRC_PATH, 'utf8'))
  const clientSrc = squash(readFileSync(CLIENT_SRC_PATH, 'utf8'))

  it('子侧：main() 注册 stdin end/close → stop，并 resume（不 resume 收不到 EOF）', () => {
    expect(sidecarSrc).toContain("process.stdin.on('end', stop)")
    expect(sidecarSrc).toContain("process.stdin.on('close', stop)")
    expect(sidecarSrc).toContain('process.stdin.resume()')
  })

  it('子侧：自检在**握手之后立刻**注册，不等模型加载完（加载期父进程死也照样自退）', () => {
    // ⚠️ 锚点必须是**握手写入点**，不是 `READY_PREFIX` 首次出现处——那是文件头的
    //    常量声明（embed-server.mjs:41），拿它比排序是恒真的假绿门。
    const handshakeAt = sidecarSrc.indexOf('process.stdout.write(`${READY_PREFIX}')
    const selfCheckAt = sidecarSrc.indexOf("process.stdin.on('end', stop)")
    expect(handshakeAt).toBeGreaterThan(-1)
    expect(selfCheckAt).toBeGreaterThan(handshakeAt)
  })

  it('父侧：EmbeddingClient 起 sidecar 必须用三管道 stdio（否则 EOF 永远不来）', () => {
    expect(clientSrc).toContain("stdio: ['pipe', 'pipe', 'pipe']")
  })
})

// ─── 端口可达性（F5 反向对照）──────────────────────────────────
// 根因（`docs/run/flaky-precommit/finding-2026-09-16.md`）：`listen(0)` 偶尔分到
// **WHATWG Fetch 禁用端口黑名单**里的端口 —— 服务真在听（裸 TCP 连得通），`fetch` 却在
// 发请求前就拒（`bad port`）且**永不恢复** ⇒ 主进程嵌入链静默失败。
//
// 加固后**判据自己必须能被证伪**：若 `isFetchReachable` 恒 true（catch 写反 / 抄了一份
// 过期的黑名单），"校验"就是空转，而一切照旧全绿 —— 那正是本仓栽过的恒真绿门。
describe('端口可达性（F5 反向对照）', () => {
  const sidecarSrc = squash(readFileSync(SIDECAR_SRC_PATH, 'utf8'))
  const cold = () => createEmbedServer({ embed: fakeEmbed, getModel: () => 'm', getDim: () => 3 })

  /** 候选池与 server 侧 `test-helpers.test.ts` **错开**：两文件可能并行跑，共用端口会 EADDRINUSE */
  const BLACKLISTED = [5060, 6566, 6667, 6668, 6669, 10080]

  /** 在指定端口起一个裸服务；被占 ⇒ null */
  async function bindRaw(port) {
    const srv = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    })
    try {
      await new Promise((resolve, reject) => {
        srv.once('error', reject)
        srv.listen(port, '127.0.0.1', resolve)
      })
      return srv
    } catch {
      return null
    }
  }

  it('isFetchReachable 非恒真亦非恒假：黑名单端口 false、正常端口 true', async () => {
    let srv = null
    let port = 0
    for (const candidate of BLACKLISTED) {
      const bound = await bindRaw(candidate)
      if (bound) {
        srv = bound
        port = candidate
        break
      }
    }
    if (srv === null) {
      throw new Error(
        `黑名单候选端口全被占用（试过 ${BLACKLISTED.join(' / ')}）——本票的承重判据无法验证，不静默跳过`
      )
    }

    // 先证「服务确实在听」：否则下面的 false 可能只是「什么都没连上」，判据就没有分辨力
    expect(srv.listening).toBe(true)
    expect(await isFetchReachable('127.0.0.1', port)).toBe(false)
    await new Promise((resolve) => {
      srv.close(() => resolve())
      srv.closeAllConnections()
    })

    // 正控：同一个函数、同一种「服务在听」，端口不在黑名单 ⇒ true
    expect(await isFetchReachable('127.0.0.1', Number(new URL(base).port))).toBe(true)
  })

  it('listen(0)：返回的端口必须对 fetch 可达（加固后的正向行为）', async () => {
    const app2 = cold()
    const port = await app2.listen(0)
    expect(await isFetchReachable('127.0.0.1', port)).toBe(true)
    await app2.close()
  })

  it('显式端口落在黑名单 ⇒ 启动即报错，不静默换端口', async () => {
    let hardened = null
    for (const candidate of BLACKLISTED) {
      const app2 = cold()
      try {
        await app2.listen(candidate)
        await app2.close() // 竟然可达（不在黑名单）⇒ 换下一个候选
      } catch (err) {
        if (/不可被 fetch 触达/.test(err.message)) {
          hardened = err
          break
        }
        // EADDRINUSE 之类 —— 换下一个候选（候选全废时下面的断言会红，不静默放行）
      }
    }
    expect(hardened).not.toBeNull()
    expect(hardened.message).toMatch(/EMBED_SIDECAR_PORT=\d+ 不可被 fetch 触达/)
  })

  it('静态：listen() 绑定后必须校验可达性；重取只在 OS 分配态（pin 态不得偷换端口）', () => {
    expect(sidecarSrc).toContain('await isFetchReachable(host, bound)')
    expect(sidecarSrc).toContain('const attempts = auto ? LISTEN_ATTEMPTS : 1')
  })
})
