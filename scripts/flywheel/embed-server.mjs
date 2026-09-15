/**
 * 飞轮嵌入 sidecar —— 把「算向量」从 server 主进程搬到独立进程。
 *
 * 动机（票丁 / map Decisions 28 二）：换型 = 改配置 + 重启 sidecar；server 重启
 * 不再背模型冷启动。
 *
 * 用法:
 *   node scripts/flywheel/embed-server.mjs          # 由 server spawn（stdio 全 pipe）
 *   EMBED_SIDECAR_PORT=3210 node ... embed-server.mjs
 *
 * 契约:
 *   GET  /health          → { ok, ready, model, dim }        （就绪前 ready:false）
 *   POST /v1/embeddings   → { model, dim, data:[{index, embedding}] }
 *                           body: { input: string | string[] }（≤ MAX_BATCH）
 *   只监听本机回环（createEmbedServer 的 host 默认值，不放宽到全网卡）
 *
 * 环境变量:
 *   MEMORY_EMBEDDING_MODEL — 模型名（默认 Xenova/bge-small-zh-v1.5，与进程内实现一致）
 *   HF_ENDPOINT            — 自定义 HF 端点（仅显式设置时切换镜像）
 *   EMBED_SIDECAR_PORT     — 监听端口（默认 0 = 由 OS 分配，端口经 stdout 握手回报；
 *                            显式指定的值若落在 fetch 禁用端口黑名单里 ⇒ 启动即报错，
 *                            不静默换端口）
 *
 * 设计要点:
 * - **import 期不加载模型**：`@huggingface/transformers` 在 modelLoader 内动态 import，
 *   故单测可直接 import 本模块的 createEmbedServer 而不触发 ~100MB 模型加载。
 * - **端口握手**：监听成功后向 stdout 打印 `EMBED_SIDECAR_READY {"port":N}` ——
 *   spawn 方据此获知实际端口（OS 分配，避免并行测试/多实例撞端口）。
 * - **端口必须对 `fetch` 可达**：OS 分配的端口可能落在 WHATWG Fetch 禁用端口黑名单
 *   （1719 / 3659 / 6666 / 10080 …）—— 那种端口上服务在听、`fetch` 却永久 `bad port`。
 *   `listen()` 因此绑定后即校验，命中则换端口重来（显式指定则报错）。见 `isFetchReachable`。
 * - 嵌入选项与进程内实现逐字一致（`pooling:'mean', normalize:true`）——换壳不换语义。
 */

import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 批量上限（票丁契约 ②：与蓝本两侧一致） */
export const MAX_BATCH = 64

/** 请求体上限（防超大 body 打爆 sidecar；单条 450 字 × 64 远小于此值） */
export const MAX_BODY_BYTES = 4 * 1024 * 1024

/** 端口不可被 fetch 触达时的重取上限（仅 OS 分配态）——命中黑名单概率约 15/13977，5 次已足够 */
const LISTEN_ATTEMPTS = 5

/**
 * 该端口能否被 `fetch` **触达** —— 判据必须与消费方同面。
 *
 * undici 的 `fetch` 有一份 **WHATWG 禁用端口黑名单**（1719 / 1720 / 1723 / 3659 / 4045 /
 * 4190 / 5060 / 6000 / 6566 / 6665–6669 / 10080 …）。服务可以**真的在监听**这类端口
 * （裸 TCP 连得通、`listening:true`），但 `fetch` 在发请求**之前**就拒
 * （`cause = "bad port"`），且**永不恢复** —— 而主进程正是经 HTTP `fetch` 调 sidecar
 * （`embedding-client.ts`），命中即**嵌入功能整体静默失败**。
 *
 * TCP 层判不出来（实测同一端口 `CONNECT-OK` 与 `bad port` 并存），唯一的 oracle 就是
 * `fetch` 本身，故此处不比对硬编码黑名单（那份表随 undici 版本漂移，抄一份就是下次复发）。
 * 探的是必定 404 的路径 —— 只验**传输可达**，不碰 `/health` 的应用状态。
 */
export async function isFetchReachable(host, port) {
  try {
    await fetch(`http://${host}:${port}/__portcheck`)
    return true
  } catch {
    return false
  }
}

/** stdout 握手行前缀（spawn 方按行解析） */
export const READY_PREFIX = 'EMBED_SIDECAR_READY'

const DEFAULT_MODEL = 'Xenova/bge-small-zh-v1.5'

/**
 * 解析 `@huggingface/transformers` 的 **ESM 入口**。
 *
 * 为什么不用裸 import：本脚本住在 `scripts/`，而该依赖声明在 `packages/server`
 * ——没有依赖图可走，裸 import 从本文件出发必然解析失败（pnpm 严格隔离，根
 * node_modules 无此包）。故显式从 server 包出发按 exports 映射取入口。
 *
 * 为什么不用 `createRequire(...).resolve`：那走 `require` 条件，拿到的是
 * `transformers.node.cjs`，与 server 现用的 ESM 构建**不是同一份产物**——
 * B1 要求逐位相同，必须与进程内实现同源（`node.import` 条件）。
 */
export function resolveTransformersEntry() {
  const candidates = [
    new URL('../../packages/server/node_modules/@huggingface/transformers/', import.meta.url),
    new URL('../../node_modules/@huggingface/transformers/', import.meta.url),
  ]
  for (const base of candidates) {
    const pkgPath = fileURLToPath(new URL('package.json', base))
    if (!existsSync(pkgPath)) continue
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      const rel = pkg?.exports?.node?.import?.default ?? pkg?.module ?? pkg?.main
      if (typeof rel === 'string') return new URL(rel, base).href
    } catch {
      /* 解析失败换下一个候选 */
    }
  }
  // 兜底：让 Node 原生解析给出清晰报错（比静默用错构建好）
  return '@huggingface/transformers'
}

/**
 * 默认嵌入实现：加载 @huggingface/transformers 模型并按与进程内版本一致的选项推理。
 * 返回 `{ embed, getModel, getDim, ready }` —— 模型懒加载，首次调用 embed 时才加载。
 */
export function createTransformersEmbedder(
  modelName = process.env.MEMORY_EMBEDDING_MODEL || DEFAULT_MODEL
) {
  let pipePromise = null
  let ready = false
  let dim = null
  let lastError = null

  function getPipeline() {
    if (!pipePromise) {
      pipePromise = (async () => {
        const { env, pipeline } = await import(resolveTransformersEntry())

        // 仅在显式设置了 HF_ENDPOINT 时切换镜像（否则用默认 huggingface.co）
        const mirror = process.env.HF_ENDPOINT
        if (mirror && mirror !== 'https://huggingface.co') {
          env.remoteHost = mirror.replace(/\/+$/, '') + '/'
          env.remotePathTemplate = '{model}/resolve/{revision}/'
        }

        const pipe = await pipeline('feature-extraction', modelName)
        // 预热一次：既是维度真值来源（不依赖 config 字段命名），也让首次真实请求不必等
        // 模型冷启动。维度取自实际输出长度 —— 与落库向量的维度同一来源。
        const warm = await pipe('维度自检', { pooling: 'mean', normalize: true })
        dim = warm.data.length
        ready = true
        return pipe
      })().catch((err) => {
        lastError = err?.message || String(err)
        pipePromise = null
        throw err
      })
    }
    return pipePromise
  }

  return {
    model: modelName,
    getDim: () => dim,
    getReady: () => ready,
    getError: () => lastError,
    async embed(texts) {
      const pipe = await getPipeline()
      const out = []
      for (const text of texts) {
        const result = await pipe(text, { pooling: 'mean', normalize: true })
        out.push(Array.from(result.data))
      }
      return out
    },
    /** 供 main 预触发加载（失败由 /health 的 ready:false 呈现，不抛） */
    async warmup() {
      try {
        await getPipeline()
      } catch {
        /* 错误已存 lastError；/health 会回报 ready:false */
      }
    },
  }
}

/**
 * 构造嵌入 HTTP 服务（不含模型加载 —— embed 由调用方注入，单测传假实现）。
 *
 * @param {object} opts
 * @param {(texts: string[]) => Promise<number[][]>} opts.embed
 * @param {() => string} [opts.getModel]
 * @param {() => number|null} [opts.getDim]
 * @param {() => boolean} [opts.getReady]
 * @param {() => string|null} [opts.getError]
 * @param {string} [opts.host] 默认 127.0.0.1（**不得**放宽到 0.0.0.0）
 */
export function createEmbedServer(opts) {
  const host = opts.host ?? '127.0.0.1'
  const getModel = opts.getModel ?? (() => DEFAULT_MODEL)
  const getDim = opts.getDim ?? (() => null)
  const getReady = opts.getReady ?? (() => true)
  const getError = opts.getError ?? (() => null)

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      sendJson(res, 500, { ok: false, reason: 'internal', detail: err?.message || String(err) })
    })
  })

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1')

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, {
        ok: true,
        ready: getReady(),
        model: getModel(),
        dim: getDim(),
        error: getReady() ? null : getError(),
      })
    }

    if (req.method === 'POST' && url.pathname === '/v1/embeddings') {
      let body
      try {
        body = await readJson(req)
      } catch (err) {
        const tooLarge = err?.code === 'BODY_TOO_LARGE'
        return sendJson(res, tooLarge ? 413 : 400, {
          ok: false,
          reason: tooLarge ? 'body-too-large' : 'bad-json',
        })
      }

      const texts = normalizeInput(body?.input)
      if (!texts) {
        return sendJson(res, 400, { ok: false, reason: 'bad-input' })
      }
      if (texts.length > MAX_BATCH) {
        return sendJson(res, 400, {
          ok: false,
          reason: 'batch-too-large',
          limit: MAX_BATCH,
          got: texts.length,
        })
      }
      if (!getReady()) {
        return sendJson(res, 503, { ok: false, reason: 'model-not-ready' })
      }

      const data = await opts.embed(texts)
      return sendJson(res, 200, {
        model: getModel(),
        dim: data[0]?.length ?? 0,
        data: data.map((embedding, index) => ({ index, embedding })),
      })
    }

    return sendJson(res, 404, { ok: false, reason: 'not-found' })
  }

  return {
    server,
    host,
    /**
     * 监听端口，并校验该端口**对 `fetch` 可达**（判据见 `isFetchReachable`）。
     *
     * - `port` 为 0（默认）⇒ OS 分配；不可达即关掉换一个重来（上限 `LISTEN_ATTEMPTS`）。
     * - `port` 显式指定 ⇒ 同样校验，但**命中即抛错、不静默换端口**：配置方按固定端口对接，
     *   悄悄换一个等于骗人（客户端只会看到永久连不上）。
     *
     * 换端口对 spawn 方透明 —— 端口是经 stdout 握手回报的，不是猜的。
     */
    async listen(port = 0) {
      const auto = !port
      const attempts = auto ? LISTEN_ATTEMPTS : 1
      const bindOnce = (p) =>
        new Promise((resolve, reject) => {
          server.once('error', reject)
          server.listen(p, host, () => {
            server.removeListener('error', reject)
            resolve(server.address().port)
          })
        })
      const closeOnce = () =>
        new Promise((resolve) => {
          server.close(() => resolve())
          server.closeAllConnections()
        })

      for (let attempt = 1; attempt <= attempts; attempt++) {
        const bound = await bindOnce(auto ? 0 : port)
        if (await isFetchReachable(host, bound)) return bound
        await closeOnce()
      }
      throw new Error(
        auto
          ? `embed sidecar: 连续 ${LISTEN_ATTEMPTS} 次分配到的端口都不可被 fetch 触达（落在 WHATWG 禁用端口黑名单里？）`
          : `embed sidecar: EMBED_SIDECAR_PORT=${port} 不可被 fetch 触达（落在 WHATWG 禁用端口黑名单里），请改用其他端口`
      )
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve())
        // 强制断开既有连接（含 fetch keep-alive 池里的空闲 socket）——否则 close 回调可能一直等
        server.closeAllConnections()
      })
    },
  }
}

/** input 归一化：string → [string]；string[] → 原样（空串/非字符串/空数组 → null 拒绝） */
function normalizeInput(input) {
  const arr = typeof input === 'string' ? [input] : Array.isArray(input) ? input : null
  if (!arr || arr.length === 0) return null
  if (!arr.every((t) => typeof t === 'string' && t.length > 0)) return null
  return arr
}

function sendJson(res, status, payload) {
  const buf = Buffer.from(JSON.stringify(payload), 'utf-8')
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(buf)
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        const err = new Error('body too large')
        err.code = 'BODY_TOO_LARGE'
        reject(err)
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

async function main() {
  const embedder = createTransformersEmbedder()
  const app = createEmbedServer({
    embed: (texts) => embedder.embed(texts),
    getModel: () => embedder.model,
    getDim: () => embedder.getDim(),
    getReady: () => embedder.getReady(),
    getError: () => embedder.getError(),
  })

  const port = await app.listen(parseInt(process.env.EMBED_SIDECAR_PORT || '0', 10))

  // 握手：spawn 方按行解析出实际端口（OS 分配 → 并行实例不撞端口）
  process.stdout.write(`${READY_PREFIX} ${JSON.stringify({ port, host: app.host })}\n`)

  // 加载模型（不阻塞握手；就绪前 /health 回报 ready:false）
  void embedder.warmup()

  const stop = async () => {
    try {
      await app.close()
    } catch {
      /* 关停失败不阻塞退出 */
    }
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  // 父进程消失（stdin 管道关闭）→ 自我了断，避免孤儿 sidecar 占端口/内存。
  // Windows 下 kill 父进程不会连带子进程，故需要这条自检。
  process.stdin.on('end', stop)
  process.stdin.on('close', stop)
  process.stdin.resume()
}

// 仅作为入口脚本执行时启动（被 import 时不启动 —— 单测走这条路径）
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`embed-server failed to start: ${err?.stack || err}\n`)
    process.exit(1)
  })
}
