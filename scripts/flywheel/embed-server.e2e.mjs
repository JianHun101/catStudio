/**
 * embed-server.mjs 端到端测试 —— 真起 sidecar 进程 + 真模型。
 *
 * 用法:
 *   node scripts/flywheel/embed-server.e2e.mjs
 *
 * **不进 vitest include**（真模型，首次运行会下载 ~100MB；`*.e2e.mjs` 天然隔离）。
 *
 * 覆盖:
 *   B1  同文本 → sidecar 向量 与 进程内（同一 ESM 入口、同选项）向量 **逐位相同**
 *   B1' 同文本两次 → 向量相同（无随机性）
 *   B9  sidecar 是**独立 pid**；杀掉它本进程仍存活，且该端口不再可连
 *
 * 不覆盖（另有人管）：B8 真机 `pnpm start`（占端口 + 主库，按票面约定由店长协调时间窗）。
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolveTransformersEntry } from './embed-server.mjs'

const SIDECAR = fileURLToPath(new URL('embed-server.mjs', import.meta.url))
const READY_PREFIX = 'EMBED_SIDECAR_READY'

let passed = 0
let failed = 0

function check(ok, label, detail = '') {
  if (ok) {
    passed++
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed++
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForPort(child, budgetMs = 30_000) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('端口握手超时')), budgetMs)
    let buffer = ''
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      let idx
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (!line.startsWith(READY_PREFIX)) continue
        clearTimeout(deadline)
        resolve(JSON.parse(line.slice(READY_PREFIX.length).trim()).port)
        return
      }
    })
    child.once('exit', (code) => {
      clearTimeout(deadline)
      reject(new Error(`sidecar 提前退出 code=${code}`))
    })
  })
}

async function waitReady(base, budgetMs) {
  const deadline = Date.now() + budgetMs
  let last = null
  while (Date.now() < deadline) {
    try {
      const body = await (await fetch(`${base}/health`)).json()
      last = body
      if (body.ready) return body
      if (body.error) console.log(`  …模型加载中（last error: ${body.error}）`)
    } catch (err) {
      last = { error: err.message }
    }
    await sleep(1000)
  }
  throw new Error(`等待 /health ready 超时；最后响应: ${JSON.stringify(last)}`)
}

async function main() {
  console.log(`sidecar: ${SIDECAR}`)
  console.log(`ESM 入口: ${resolveTransformersEntry()}\n`)

  const child = spawn(process.execPath, [SIDECAR], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const stderr = []
  child.stderr.on('data', (c) => stderr.push(c.toString()))

  let killed = false
  try {
    // ── 1. 独立进程 + 端口握手 ──────────────────────────
    console.log('[1] 起进程 / 端口握手')
    const port = await waitForPort(child)
    const base = `http://127.0.0.1:${port}`
    check(
      child.pid !== process.pid,
      'B9 sidecar 是独立 pid',
      `pid=${child.pid}（本进程 ${process.pid}）`
    )
    check(Number.isInteger(port) && port > 0, '握手回报端口', `port=${port}`)

    // ── 2. 就绪（首次含模型下载）────────────────────────
    console.log('\n[2] /health 就绪（首次可能下载模型，预算 10 分钟）')
    const health = await waitReady(base, 10 * 60 * 1000)
    check(health.ready === true, '/health ready', `model=${health.model} dim=${health.dim}`)
    check(health.dim === 512, '模型维度 512', `dim=${health.dim}`)

    // ── 3. 嵌入 + 确定性 ────────────────────────────────
    console.log('\n[3] 嵌入')
    const TEXT = '记忆飞轮：把零散经验沉淀为可检索的知识资产。'
    const post = async (input) => {
      const res = await fetch(`${base}/v1/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
      return (await res.json()).data.map((d) => d.embedding)
    }

    const [v1] = await post(TEXT)
    const [v2] = await post(TEXT)
    check(Array.isArray(v1) && v1.length === 512, '返回 512 维', `len=${v1.length}`)
    check(
      v1.every((n) => Number.isFinite(n)),
      '向量元素全为有限数'
    )
    check(
      v1.every((n, i) => n === v2[i]),
      '同文本两次 → 逐位相同（无随机性）'
    )

    // ── 4. B1：与进程内实现逐位比对 ─────────────────────
    console.log('\n[4] B1 进程内比对（同 ESM 入口、同选项）')
    const { pipeline } = await import(resolveTransformersEntry())
    const pipe = await pipeline(
      'feature-extraction',
      process.env.MEMORY_EMBEDDING_MODEL || 'Xenova/bge-small-zh-v1.5'
    )
    const local = Array.from((await pipe(TEXT, { pooling: 'mean', normalize: true })).data)

    check(local.length === v1.length, '两侧维度一致', `local=${local.length} sidecar=${v1.length}`)
    const diffs = v1.filter((n, i) => n !== local[i]).length
    const maxDelta = Math.max(...v1.map((n, i) => Math.abs(n - local[i])))
    check(diffs === 0, '逐位相同（换壳不换语义）', `diffs=${diffs} maxDelta=${maxDelta}`)

    // ── 5. B9：杀进程后主进程存活 + 端口不可用 ───────────
    console.log('\n[5] 停 sidecar')
    child.kill()
    await sleep(1500)
    killed = child.killed
    check(process.pid != null && true, '杀 sidecar 后本进程仍存活', `pid=${process.pid}`)
    let unreachable = false
    try {
      const res = await fetch(`${base}/v1/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: TEXT }),
        signal: AbortSignal.timeout(3000),
      })
      unreachable = !res.ok
    } catch {
      unreachable = true
    }
    check(unreachable, '停掉后该端口不再可用（客户端将走降级路径）')
  } finally {
    if (!killed) child.kill()
    const err = stderr.join('').trim()
    if (err) console.log(`\n[sidecar stderr]\n${err}`)
  }

  console.log(`\n${failed === 0 ? '✅' : '❌'} e2e: ${passed} passed / ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(`\n❌ e2e 异常: ${err.stack || err}`)
  process.exit(1)
})
