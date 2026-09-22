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
 *   R1-R5 R13a 重排口（R1 首调即加载 / R2 分**非退化** / R3 80 对不截池 / R4 条数 / R5 逐位对齐）
 *   B9  sidecar 是**独立 pid**；杀掉它本进程仍存活，且该端口不再可连
 *   B10 孤儿自退（票巳 (c)）：**只杀父进程、不杀 sidecar** ⇒ sidecar 收 stdin EOF 自退
 *
 * ⚠️ 首次运行会下载**两个**模型：嵌入 ~100MB + 重排 266MB（R13a 起）。
 *
 * 不覆盖（另有人管）：B8 真机 `pnpm start`（占端口 + 主库，按票面约定由店长协调时间窗）。
 *
 * 内部双角色：`--fake-server` 时本文件反过来充当「假 server」（起 sidecar 并保活），
 * 供 B10 的 driver 硬杀——这样孤儿自退的拓扑能在一个文件里自洽复现，不引额外脚本。
 */

import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolveTransformersEntry } from './embed-server.mjs'

const SELF = fileURLToPath(import.meta.url)
const SIDECAR = fileURLToPath(new URL('embed-server.mjs', import.meta.url))
const READY_PREFIX = 'EMBED_SIDECAR_READY'
const FAKE_SERVER_FLAG = '--fake-server'

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

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))

/** pid 存活判据（signal 0）；非本进程子进程在 Windows 上无 zombie 面 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 清理用硬杀（带 /T 连坐整棵树）——**只用于善后**，判据断言不用它（见 B10 注释） */
function killPidTree(pid) {
  if (!pid || !pidAlive(pid)) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' })
  } else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
}

/**
 * B10（票巳 (c)）：「只杀 server 不杀 sidecar」的孤立实测。
 *
 * 拓扑镜像真机：driver → fakeServer（冒充 server，三管道起 sidecar）→ embed-server.mjs。
 * 硬杀只打 fakeServer（Windows `taskkill /F`，**不带 `/T`**）——带 /T 会连坐杀树，
 * 测的就不是这件事了。
 *
 * 证伪对象 = 票面原判「非 Windows `killTree` 只杀 server ⇒ sidecar 成孤儿」。
 * 判据**必须带对照**：杀前两侧都要报活、杀后 fakeServer 必须报死 —— 否则
 * 「sidecar 不在了」可能是存活判据本身坏掉造出的假绿。
 */
async function checkOrphanSelfExit() {
  const parent = spawn(process.execPath, [SELF, FAKE_SERVER_FLAG], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // 动态端口：避开在跑的 dev sidecar（EMBED_SIDECAR_PORT 可能被外部 shell 设成 3210）
    env: { ...process.env, EMBED_SIDECAR_PORT: '0' },
  })
  parent.stderr.on('data', () => {})
  let sidecarPid = null
  let buf = ''
  parent.stdout.on('data', (c) => {
    buf += c.toString()
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (line.startsWith('SIDECAR_PID ')) sidecarPid = Number(line.split(' ')[1])
    }
  })

  try {
    const deadline = Date.now() + 60_000
    while (!sidecarPid && Date.now() < deadline) await sleepMs(200)
    if (!sidecarPid) {
      check(false, 'B10 拿到 sidecar pid（端口握手）')
      return
    }
    await sleepMs(2000) // 留出 sidecar 注册 stdin 自检的时间（握手后同步注册，不等模型）

    const preParent = pidAlive(parent.pid)
    const preSidecar = pidAlive(sidecarPid)
    check(
      preParent && preSidecar,
      'B10 阳性对照：杀前两侧都活着（存活判据不是坏的）',
      `parent=${parent.pid} sidecar=${sidecarPid}`
    )

    const t0 = Date.now()
    const parentExited = new Promise((r) => parent.once('exit', () => r(true)))
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/F', '/PID', String(parent.pid)], { stdio: 'ignore' })
    } else {
      process.kill(parent.pid, 'SIGKILL') // 非 Windows 的 killTree 同款：只杀 server 本身
    }
    await parentExited // 等 exit 事件 = 顺带完成 POSIX 侧的回收，存活判据才可信
    check(!pidAlive(parent.pid), 'B10 阴性对照：硬杀后 parent 判死（判据能观测到死）')

    while (Date.now() - t0 < 15_000 && pidAlive(sidecarPid)) await sleepMs(200)
    const gone = !pidAlive(sidecarPid)

    check(
      gone,
      'B10 **只杀 server 不杀 sidecar ⇒ sidecar 自退**（stdin EOF 自检成立）',
      gone ? `${Date.now() - t0}ms 内消失` : '15s 仍存活 = 孤儿'
    )
  } finally {
    // 善后放 finally：提前 return / 断言失败 / 抛异常三条路径都不留孤儿。
    // 原先只清 sidecar ⇒ 阴性对照失败（parent 没死）时 parent 会漏在盘上占端口。
    // 两侧各扫一遍：parent 已死则 killPidTree 是 no-op。
    killPidTree(parent.pid)
    killPidTree(sidecarPid)
  }
}

async function main() {
  console.log(`sidecar: ${SIDECAR}`)
  console.log(`ESM 入口: ${resolveTransformersEntry()}\n`)

  const child = spawn(process.execPath, [SIDECAR], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    // ⚠️ **必须钉动态端口**：主仓 `.env` 里有 `EMBED_SIDECAR_PORT=3210`，而日常在跑的
    // dev server 正占着它 ⇒ 继承环境会让本 e2e 直接 `EADDRINUSE` 起不来。这不是新问题：
    // `checkOrphanSelfExit` 早就为同一条因由显式传了 `'0'`，唯独 `main()` 漏了 ——
    // 于是「有 dev server 在跑时 e2e 必红」，而红的原因与 E2E 要测的任何东西都无关。
    env: { ...process.env, EMBED_SIDECAR_PORT: '0' },
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

    // ── 4b. R13a：重排口真模型 ──────────────────────────
    // 单测用假 rerank 只证明**路由**；这里证明**模型路径**。且 R1/R2 钉的正是 S0 那个
    // 「假读数」陷阱：按票面原字面用 text-classification 会恒返回 1，臂③ ≡ 臂①，
    // 报告得出「重排无效」把票关错——而所有探针都显示「跑通了」。
    console.log('\n[4b] R13a /v1/rerank（真模型；首次含 266MB 重排权重下载）')
    const postRerank = async (pairs) => {
      const res = await fetch(`${base}/v1/rerank`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairs }),
        signal: AbortSignal.timeout(10 * 60 * 1000),
      })
      const body = await res.json().catch(() => null)
      return { status: res.status, body }
    }
    const Q = '记忆检索的 top-K 截断应该按什么粒度去重，节级还是片级？'
    const REL =
      '节级去重与片级去重的差别在于：片级会把同一节的多个切片都算进 top-K，导致注入量被单节吃满；' +
      '节级去重按 doc_path 与 section_anchor 组合成键，同一个节的多个命中只占一个名额。'
    const IRR =
      '本仓库的停服脚本会顺序释放三个端口，并在释放前检查端口占用者是不是本进程自己 spawn 的子进程。'

    const first = await postRerank([
      { query: Q, passage: IRR },
      { query: Q, passage: REL },
    ])
    check(
      first.status === 200,
      'R1 **首调即加载**：就绪态 false 时仍放行（不设前置就绪门 —— 设了会把功能锁死在「永远不就绪」）',
      `HTTP ${first.status} model=${first.body?.model}`
    )
    if (first.status === 200) {
      const [irr, rel] = first.body.scores
      check(
        Number.isFinite(rel) && Number.isFinite(irr) && rel !== irr,
        'R2a 重排分**不是常数**（排除 softmax-of-one 恒 1 的退化尺）',
        `相关=${rel} 不相关=${irr}`
      )
      check(
        rel > 0.5 && irr < 0.5,
        'R2b 相关 > 0.5 且不相关 < 0.5（可分）',
        `相关=${rel} 不相关=${irr}`
      )
    }

    // 顺序对齐：相关对排在**末位**，argmax 必须跟着走（否则是按下标回填错了）
    const wide = await postRerank(
      Array.from({ length: 80 }, (_, i) => ({ query: Q, passage: i === 79 ? REL : IRR }))
    )
    check(
      wide.status === 200,
      'R3 80 对一次请求 ⇒ 200（跨过嵌入侧的 MAX_BATCH=64；截池会让高名次锚点永远救不回）',
      `HTTP ${wide.status}`
    )
    if (wide.status === 200) {
      const scores = wide.body.scores
      const argmax = scores.indexOf(Math.max(...scores))
      check(scores.length === 80, 'R4 scores 条数 == 请求条数', `len=${scores.length}`)
      check(argmax === 79, 'R5 scores 与入参**逐位对齐**', `argmax=${argmax}（期望 79）`)
    }

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

    // ── 6. B10：孤儿自退（票巳 (c)，孤立实测）──────────────
    console.log('\n[6] B10 孤儿自退：只杀「server」不杀 sidecar')
    await checkOrphanSelfExit()
  } finally {
    if (!killed) child.kill()
    const err = stderr.join('').trim()
    if (err) console.log(`\n[sidecar stderr]\n${err}`)
  }

  console.log(`\n${failed === 0 ? '✅' : '❌'} e2e: ${passed} passed / ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

/**
 * `--fake-server`：本文件反过来冒充 server —— 用三管道起 sidecar 并保活，
 * 等 driver（B10）把它硬杀掉。**故意不走任何清理路径**：被硬杀时正是被测面。
 */
function runFakeServer() {
  const child = spawn(process.execPath, [SIDECAR], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stderr.on('data', () => {})
  let buf = ''
  child.stdout.on('data', (c) => {
    buf += c.toString()
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.startsWith(READY_PREFIX)) continue
      process.stdout.write(`SIDECAR_PID ${child.pid}\n`)
    }
  })
  setInterval(() => {}, 1000) // 保活
}

if (process.argv.includes(FAKE_SERVER_FLAG)) {
  runFakeServer()
} else {
  main().catch((err) => {
    console.error(`\n❌ e2e 异常: ${err.stack || err}`)
    process.exit(1)
  })
}
