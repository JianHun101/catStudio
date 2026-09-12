/**
 * dsh ACP 四原语对称实测探针
 *
 * 裸 JSON-RPC 2.0 over stdio 客户端（零依赖），spawn `@deepseek-ai/dsh-acp-demo`
 * 宿主（官方 `demo:acp` 的 npm 打包形态），对四块 ADR 0008 依赖原语逐一实测：
 *   1. fork/resume —— ACP 标准方法 `session/fork` / `session/resume`（及 load/list/delete/close）
 *      是否注册（预期：Method not found）
 *   2. close/cancel —— `session/close` 是否注册（预期：无）；`session/cancel` 对未知/无 in-flight
 *      会话是否静默成功（标记中止语义，非等价取消/关闭）
 *   3. mcpServers —— `session/new` 携带非空 `mcpServers` / `additionalDirectories`
 *      是否被拒（预期：invalid params，含具体消息）
 *   4. 流式 chunk 粒度 —— `session/prompt` 真实跑一次 LLM，统计 `session/update`
 *      (`agent_message_chunk`) 事件：按 committed `assistant/message` 每个 block 发一次
 *      （预期：单 block 答案 = 恰好 1 次 chunk，且不在推理过程中逐 token 推送）
 *
 * 用法:
 *   node scripts/probes/dsh-acp-probe.e2e.mjs [--probe-dir <dir>]
 *
 * --probe-dir 默认取 %TEMP%/opencode/dsh-acp-probe（或 Unix 下 ~/tmp/opencode/dsh-acp-probe），
 * 该目录需已安装 @deepseek-ai/dsh-acp-demo@0.1.0-rc.7 及其 peer 依赖、leaf 插件与 cordis.yml。
 * 真实流式测试需要 DEEPSEEK_API_KEY（继承当前环境，探针不透传/不落盘任何凭据）。
 *
 * 退出码：0 = 四原语证据全部拿到；1 = 任一原语行为与预期不符；2 = 环境/启动失败。
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'

const PROTOCOL_VERSION = 1

const args = process.argv.slice(2)
const flagIdx = args.indexOf('--probe-dir')
const probeDir =
  flagIdx >= 0 && args[flagIdx + 1]
    ? resolve(args[flagIdx + 1])
    : join(process.platform === 'win32' ? tmpdir() : homedir(), 'opencode', 'dsh-acp-probe')

const BIN = join(probeDir, 'node_modules', '@deepseek-ai', 'dsh-acp-demo', 'lib', 'bin.js')
const CONFIG = join(probeDir, 'cordis.yml')

if (!existsSync(BIN)) {
  console.error(`[probe] 宿主 bin 不存在: ${BIN}`)
  console.error(
    `[probe] 请先在 --probe-dir 安装: npm i @deepseek-ai/dsh-acp-demo@0.1.0-rc.7 @deepseek-ai/dsh-llm-deepseek@0.1.0-rc.7 @deepseek-ai/dsh-user-approval@0.1.0-rc.7 @deepseek-ai/dsh-sandbox-local@0.1.0-rc.7`
  )
  process.exit(2)
}
if (!existsSync(CONFIG)) {
  console.error(`[probe] cordis.yml 不存在: ${CONFIG}`)
  process.exit(2)
}

// ─── 结果收集 ───────────────────────────────────────────────

const evidence = {
  forkResume: [],
  closeCancel: [],
  mcpServers: [],
  streaming: [],
}
let failed = false

function note(group, ok, label, detail) {
  evidence[group].push({ ok, label, detail })
  console.log(`${ok ? '  ✅' : '  ❌'} ${label}${detail ? `\n      ${detail}` : ''}`)
  if (!ok) failed = true
}

/** 发送 JSON-RPC notification（无 id、无响应），fire-and-forget。 */
function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
}

// ─── 子进程 + JSON-RPC 线框 ────────────────────────────────

const child = spawn(process.execPath, [BIN, '--config', CONFIG], {
  cwd: probeDir,
  env: process.env,
  stdio: ['pipe', 'pipe', 'inherit'],
})

const inbox = createInterface({ input: child.stdout })
const listeners = new Map() // id -> {resolve, reject, timeout}
const notifications = []
let nextId = 1

inbox.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch (err) {
    console.error(`[probe] 无法解析宿主输出行: ${trimmed}`)
    return
  }
  if (msg.method !== undefined) {
    notifications.push({ at: Date.now(), method: msg.method, params: msg.params })
    return
  }
  const pending = listeners.get(msg.id)
  if (!pending) return
  listeners.delete(msg.id)
  clearTimeout(pending.timeout)
  if (msg.error) pending.resolve({ ok: false, error: msg.error })
  else pending.resolve({ ok: true, result: msg.result })
})

child.stderr?.on('data', (d) => process.stderr.write(d))
child.on('exit', (code) => {
  console.error(`[probe] 宿主退出 code=${code}`)
})

function request(method, params, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const id = nextId++
    const timer = setTimeout(() => {
      listeners.delete(id)
      resolve({ ok: false, error: { code: -1, message: `timeout waiting ${method}` } })
    }, timeoutMs)
    listeners.set(id, { resolve, timeout: timer })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function expectMethodNotFound(label, method, params) {
  const res = await request(method, params)
  const got = res.ok ? 'RESULT' : `ERROR ${res.error.code}`
  note(
    'forkResume',
    !res.ok && res.error.code === -32601,
    label,
    res.ok
      ? `意外成功: ${JSON.stringify(res.result)}`
      : `code=${res.error.code} msg=${res.error.message}`
  )
}

// ─── 主流程 ────────────────────────────────────────────────

let sessionId

try {
  console.log(`[probe] 宿主: ${BIN}`)
  console.log(`[probe] 配置: ${CONFIG}\n`)

  // 0. initialize
  const init = await request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
  })
  if (!init.ok) {
    console.error(`[probe] initialize 失败: ${JSON.stringify(init.error)}`)
    process.exit(2)
  }
  console.log('[probe] initialize 成功, agentInfo =', JSON.stringify(init.result.agentInfo))
  console.log('[probe] agentCapabilities =', JSON.stringify(init.result.agentCapabilities))
  console.log('[probe] authMethods =', JSON.stringify(init.result.authMethods), '\n')

  // 0.5 合法 session/new（空 mcpServers 基线）
  const base = await request('session/new', {
    cwd: probeDir,
    mcpServers: [],
    additionalDirectories: [],
  })
  if (!base.ok) {
    console.error(`[probe] session/new(空) 失败: ${JSON.stringify(base.error)}`)
    process.exit(2)
  }
  sessionId = base.result.sessionId
  console.log('[probe] session/new(空 mcpServers) 成功 sessionId =', sessionId, '\n')

  // ─── 原语 1: fork / resume（及 load/list/delete/close）───
  console.log('── 原语 1: fork/resume 与会话导航方法 ──')
  for (const [method, params] of [
    ['session/fork', { sessionId }],
    ['session/resume', { sessionId }],
    ['session/load', { sessionId }],
    ['session/list', {}],
    ['session/delete', { sessionId }],
    ['session/close', { sessionId }],
  ]) {
    await expectMethodNotFound(`session/fork|resume|load|list|delete|close 缺失`, method, params)
  }
  // 确认合法会话仍在（上述方法未破坏会话）
  notify('session/cancel', { sessionId })
  await sleep(300)
  const still = await request('session/new', {
    cwd: probeDir,
    mcpServers: [],
    additionalDirectories: [],
  })
  console.log(`[probe] 会话未被上述方法破坏（cancel notification 后 session/new ok=${still.ok}）\n`)

  // ─── 原语 2: close/cancel 语义 ────────────────────────────
  console.log('── 原语 2: per-session close 缺失 / cancel 语义 ──')
  note(
    'closeCancel',
    !(await request('session/close', { sessionId })).ok,
    'session/close 未注册（per-session close 不存在，会话生命周期归连接）'
  )
  // session/cancel 是 ACP notification（无 id 无响应）——fire-and-forget 标记中止。
  // 验证路径：发送后无错误帧 + 连接仍活 + 会话仍可继续交互。
  notify('session/cancel', { sessionId: '00000000-0000-0000-0000-000000000000' })
  await sleep(300)
  const aliveAfterUnknown = await request('session/new', {
    cwd: probeDir,
    mcpServers: [],
    additionalDirectories: [],
  })
  note(
    'closeCancel',
    aliveAfterUnknown.ok,
    'session/cancel 未知会话 = 无错误帧静默 no-op（notification 无响应；连接仍活）',
    aliveAfterUnknown.ok
      ? `后续 session/new 正常 (${aliveAfterUnknown.result.sessionId})`
      : JSON.stringify(aliveAfterUnknown.error)
  )
  notify('session/cancel', { sessionId })
  await sleep(300)
  const aliveAfterIdle = await request('session/new', {
    cwd: probeDir,
    mcpServers: [],
    additionalDirectories: [],
  })
  note(
    'closeCancel',
    aliveAfterIdle.ok,
    'session/cancel 无 in-flight 会话 = 无错误帧静默成功（标记中止语义，无单会话关闭通道）',
    aliveAfterIdle.ok
      ? `后续 session/new 正常 (${aliveAfterIdle.result.sessionId})`
      : JSON.stringify(aliveAfterIdle.error)
  )
  const still2 = await request('session/cancel', { sessionId: aliveAfterIdle.result.sessionId })
  note(
    'closeCancel',
    !still2.ok,
    'cancel 后无应答（notification 特性）——无 per-session 关闭/销毁通道',
    `session/cancel 以 request 发送得到 ${JSON.stringify(still2.error.code)}（证明它只作 notification 处理）`
  )
  console.log()

  // ─── 原语 3: mcpServers / additionalDirectories 拒绝 ──────
  console.log('── 原语 3: session/new 携带 mcpServers / additionalDirectories ──')
  const mcp = await request('session/new', {
    cwd: probeDir,
    mcpServers: [
      {
        name: 'fake-server',
        command: 'npx',
        args: ['-y', 'fake-server'],
        env: [{ name: 'A', value: 'B' }],
      },
    ],
    additionalDirectories: [],
  })
  note(
    'mcpServers',
    !mcp.ok && mcp.error.code === -32602,
    '非空 mcpServers 被拒 (invalid params)',
    mcp.ok
      ? `意外成功 ${JSON.stringify(mcp.result)}`
      : `code=${mcp.error.code} msg=${mcp.error.message}`
  )
  const addl = await request('session/new', {
    cwd: probeDir,
    mcpServers: [],
    additionalDirectories: ['C:\\somewhere'],
  })
  note(
    'mcpServers',
    !addl.ok && addl.error.code === -32602 && /additionalDirectories/.test(addl.error.message),
    '非空 additionalDirectories 被拒 (invalid params)',
    addl.ok
      ? `意外成功 ${JSON.stringify(addl.result)}`
      : `code=${addl.error.code} msg=${addl.error.message}`
  )
  const badCwd = await request('session/new', {
    cwd: 'relative/path',
    mcpServers: [],
    additionalDirectories: [],
  })
  note(
    'mcpServers',
    !badCwd.ok && badCwd.error.code === -32602 && /cwd/.test(badCwd.error.message),
    '相对 cwd 被拒 (invalid params)',
    badCwd.ok
      ? `意外成功 ${JSON.stringify(badCwd.result)}`
      : `code=${badCwd.error.code} msg=${badCwd.error.message}`
  )
  console.log()

  // ─── 原语 4: 流式 chunk 粒度 ───────────────────────────────
  console.log('── 原语 4: 流式 chunk 粒度（真实 LLM 一次） ──')
  const probeSession = await request('session/new', {
    cwd: probeDir,
    mcpServers: [],
    additionalDirectories: [],
  })
  if (!probeSession.ok) {
    note('streaming', false, '无法为流式测试创建会话', JSON.stringify(probeSession.error))
  } else {
    const sid = probeSession.result.sessionId
    const chunksBefore = notifications.filter((n) => n.method === 'session/update').length
    const start = Date.now()
    const promptRes = await request(
      'session/prompt',
      {
        sessionId: sid,
        prompt: [
          {
            type: 'text',
            text: '请用 100 字左右介绍猫咖，分三个自然段，每段一行。只输出正文不要其它内容。',
          },
        ],
      },
      120000
    )
    const elapsed = Date.now() - start
    const updates = notifications.filter((n) => n.method === 'session/update')
    const newUpdates = updates.slice(chunksBefore)
    const chunks = newUpdates.filter(
      (u) => u.params?.update?.sessionUpdate === 'agent_message_chunk'
    )
    const nonChunk = newUpdates.filter(
      (u) => u.params?.update?.sessionUpdate !== 'agent_message_chunk'
    )

    note(
      'streaming',
      promptRes.ok,
      `session/prompt 完成 stopReason=${promptRes.ok ? JSON.stringify(promptRes.result.stopReason) : '(error)'} 耗时 ${elapsed}ms`,
      promptRes.ok ? '' : JSON.stringify(promptRes.error)
    )
    note(
      'streaming',
      chunks.length === 1,
      `agent_message_chunk 事件数 = ${chunks.length}（预期恰好 1：单 block committed 答案 = 1 次 chunk）`,
      JSON.stringify(
        chunks.map((c) => c.params.update),
        null,
        2
      )
    )
    note(
      'streaming',
      nonChunk.length === 0,
      `非 chunk 的 session/update 数 = ${nonChunk.length}（预期 0：推理/工具活动不上线）`,
      nonChunk.length > 0
        ? JSON.stringify(
            nonChunk.map((n) => n.params.update),
            null,
            2
          )
        : ''
    )
    const chunkContent = chunks[0]?.params?.update?.content
    const chunkText = chunkContent ? (chunkContent.text ?? `[${chunkContent.type}]`) : ''
    note(
      'streaming',
      chunks.length === 1 && typeof chunkText === 'string' && chunkText.length > 0,
      'chunk 内容为非空完整答案文本',
      chunkText ? `预览: ${chunkText}` : '(空或缺失)'
    )
  }
  console.log()

  // 收尾：EOF 让宿主 flush 退出
  child.stdin.end()
  await Promise.race([new Promise((r) => child.on('exit', r)), sleep(5000)])
} catch (err) {
  console.error(`[probe] 探针异常: ${err.stack ?? err}`)
  process.exit(2)
} finally {
  try {
    child.stdin.end()
  } catch {
    /* 已关闭 */
  }
  try {
    child.kill()
  } catch {
    /* 已退出 */
  }
}

console.log(
  `\n[probe] 证据汇总: fork/resume 组 ${evidence.forkResume.length} 条, close/cancel 组 ${evidence.closeCancel.length} 条, mcpServers 组 ${evidence.mcpServers.length} 条, streaming 组 ${evidence.streaming} 条`
)
if (failed) {
  console.error('[probe] 存在与预期不符的行为 → 退出码 1')
  process.exit(1)
} else {
  console.log('[probe] 四原语行为证据全部拿到 → 退出码 0')
  process.exit(0)
}
