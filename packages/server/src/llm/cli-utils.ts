/**
 * CLI 适配器共享工具。
 *
 * - 二进制路径解析（兼容 Windows 中文用户名路径）
 * - LLMMessage[] → 文本 prompt 转换
 * - Codex Proxy 生命周期管理
 * - 子进程 NDJSON 流式解析
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Chunk, LLMMessage } from '@cat-study/shared'
import { createLogger } from '../logger.js'

// ─── Workspace Directory ────────────────────────────────

/**
 * Agent 工作区目录（项目根级的 workspace/）。
 *
 * 将 Claude Code CLI 的 cwd 限制在此目录，防止 Agent 写入
 * packages/server/src/ 触发 tsx watch 重启 → 杀死正在执行的 Agent。
 *
 * dev.js 将 server 进程的 cwd 设为项目根，因此 process.cwd() 就是项目根。
 */
export function getWorkspaceDir(): string {
  const dir = path.join(process.cwd(), 'workspace')
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return dir
}

const log = createLogger('cli-utils')

// ─── Binary Resolution ───────────────────────────────────

/**
 * 解析 npm 全局安装的 CLI 二进制路径。
 * 不使用 `where` 命令（Windows 中文用户名路径编码损坏），
 * 优先通过 `npm prefix -g` 定位。
 */
export function resolveBin(name: string, npmPkg: string): string {
  const isWindows = process.platform === 'win32'
  if (!isWindows) return name

  // 1. npm 全局 prefix（如 C:\Users\xxx\AppData\Roaming\npm）
  let prefix: string | null = null
  try {
    prefix = execSync('npm prefix -g', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    prefix = null
  }

  if (prefix) {
    // 1a. package bin 目录下的 .exe
    const pkgExe = path.join(prefix, 'node_modules', npmPkg, 'bin', `${name}.exe`)
    if (fs.existsSync(pkgExe)) return pkgExe

    // 1b. npm prefix 根目录下的 .exe / .cmd
    const rootExe = path.join(prefix, `${name}.exe`)
    if (fs.existsSync(rootExe)) return rootExe
    const rootCmd = path.join(prefix, `${name}.cmd`)
    if (fs.existsSync(rootCmd)) return rootCmd
  }

  // 2. 兜底：where 命令（多编码尝试）
  try {
    const result = execSync(`where ${name}`, {
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    for (const enc of ['utf8', 'gbk', 'cp936']) {
      const text = Buffer.from(result).toString(enc as BufferEncoding)
      const lines = text.split(/\r?\n/).filter(Boolean)
      const exe = lines.find((l) => l.endsWith('.exe') && fs.existsSync(l))
      if (exe) return exe
      const cmd = lines.find((l) => l.endsWith('.cmd') && fs.existsSync(l))
      if (cmd) return cmd
    }
  } catch {
    // 找不到
  }

  throw new Error(`无法找到 ${name} 可执行文件。请先运行: npm i -g ${npmPkg}`)
}

/**
 * 解析 npm 全局安装的纯 JS CLI 的入口文件绝对路径。
 *
 * 与 resolveBin 的差异：resolveBin 解析 Windows 可执行包装（.exe/.cmd）。纯 JS 包
 * （如 @deepseek-ai/dsh）在 Windows 上只有 .cmd 包装——spawnSupervised → supervisor
 * `spawn('.cmd', {shell:false})` 在 Node 24 win32 同步抛 EINVAL（bde908e ❌ 审查阻塞项）。
 * 本函数读 `<prefix>/node_modules/<npmPkg>/package.json` 的 bin 字段拿 JS 入口绝对路径，
 * 配合 `spawn(process.execPath, [entry, ...args])` 执行——正是 CLAUDE.md
 * 「Spawn: node path/to/cli.mjs，avoid .cmd wrappers」约定（node.exe 是原生 exe，无 EINVAL）。
 *
 * @param npmPkg npm 包名（如 '@deepseek-ai/dsh'）
 * @param binName 命令名（如 'dsh'）——bin 字段为对象时用它取对应条目
 * @returns win32 下 JS 入口绝对路径；非 win32 直接返回 binName（走 PATH 可执行）
 */
export function resolveJsEntry(npmPkg: string, binName: string): string {
  const isWindows = process.platform === 'win32'
  if (!isWindows) return binName

  // 1. npm 全局 prefix（与 resolveBin 同款定位，Windows 中文用户名安全）
  let prefix: string | null = null
  try {
    prefix = execSync('npm prefix -g', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    prefix = null
  }

  if (prefix) {
    const pkgJsonPath = path.join(prefix, 'node_modules', npmPkg, 'package.json')
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
        bin?: string | Record<string, string>
      }
      // bin 字段双形态：字符串（单入口）或对象（{ <binName>: <entry> }）
      const entry = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[binName]
      if (typeof entry === 'string') {
        return path.resolve(path.dirname(pkgJsonPath), entry)
      }
    } catch {
      // package.json 缺失/损坏 → 落到兜底抛错
    }
  }

  throw new Error(`无法找到 ${binName} 的 JS 入口。请先运行: npm i -g ${npmPkg}`)
}

// ─── Prompt Construction ──────────────────────────────────

/**
 * 单条 LLMMessage → 文本片段（messagesToPrompt 与 messagesToPromptBounded
 * 共用同一份格式化逻辑，保证两者在无截断时逐字符一致）。
 */
function messageToPart(m: LLMMessage): string {
  switch (m.role) {
    case 'system':
      return `${m.content}\n\n---\n`
    case 'user':
      return `User: ${m.content}`
    case 'assistant':
      return `Assistant: ${m.content}`
  }
}

/**
 * 将 LLMMessage 数组转为单个文本 prompt，供 CLI 工具使用。
 */
export function messagesToPrompt(messages: LLMMessage[]): string {
  return messages.map(messageToPart).join('\n\n')
}

/**
 * 有界版本的 messagesToPrompt：按消息粒度从最旧历史整条丢弃，保 system + 保尾。
 *
 * 背景：dsh/opencode 的 prompt 以 positional 传入，受 Windows CreateProcess 32K
 * 命令行限制。旧做法 `prompt.slice(0, maxLen)` 保头砍尾——而 messagesToPrompt
 * 平铺顺序是 system→历史→「【当前待回复】」最新任务在末尾，超限时被砍掉的
 * 恰恰是最该保留的当前触发消息（dsh 形态聚焦漂移的截断侧根因）。
 *
 * 保序规则（超限时）：
 *   ① 永远保留 system（仅当 index 0 且 role === 'system'，且它不是唯一一条）
 *   ② 永远保留末尾最后一条（当前触发消息，含锚定）
 *   ③ 中间历史从新到旧尽量多保留——贪心从最旧开始整条丢弃，直到总长 ≤ maxLen
 *
 * 截断单位是整条消息（按 \n\n 分界），不是字符硬切——不切碎任何一条消息，
 * 尤其不切碎「【当前待回复】」锚定行。
 *
 * 空 messages / 全量 ≤ maxLen 时，输出与 messagesToPrompt 逐字符一致。
 */
export function messagesToPromptBounded(messages: LLMMessage[], maxLen: number): string {
  if (messages.length === 0) return ''
  const parts = messages.map(messageToPart)
  const full = parts.join('\n\n')
  if (full.length <= maxLen) return full

  const tailIdx = parts.length - 1
  // head = index 0 的 system（当它不等于 tail 时才单独保留，避免单条 system 重复）
  const hasHead = messages[0].role === 'system' && tailIdx !== 0
  const mid = parts.slice(hasHead ? 1 : 0, tailIdx)

  const build = (midParts: string[]): string =>
    (hasHead ? [parts[0], ...midParts, parts[tailIdx]] : [...midParts, parts[tailIdx]]).join('\n\n')

  let kept = mid
  while (kept.length > 0 && build(kept).length > maxLen) {
    kept = kept.slice(1)
  }
  return build(kept)
}

// ─── Codex Proxy Management ────────────────────────────────

const PROXY_PORT = 9090
let proxyStarted = false
let proxyApiKey = ''

function isProxyRunning(): boolean {
  try {
    execSync(`netstat -ano | findstr ":${PROXY_PORT}" | findstr "LISTENING"`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return true
  } catch {
    return false
  }
}

/**
 * 确保 codex-proxy 在运行。首次调用时启动，后续复用。
 * 多个 Agent 共用同一代理进程（使用第一个调用的 API key）。
 */
export function ensureProxy(apiKey: string): void {
  if (isProxyRunning()) {
    if (!proxyStarted) {
      log.info('codex-proxy 检测到已有代理运行，复用')
      proxyStarted = true
      proxyApiKey = apiKey
    }
    return
  }

  if (proxyStarted) return

  log.info('codex-proxy 正在启动...')

  const proxyDir = path.join(process.env.USERPROFILE || '~', 'codex-proxy')
  const proxyScript = path.join(proxyDir, 'codex_proxy.py')

  if (!fs.existsSync(proxyScript)) {
    throw new Error(
      `codex-proxy 脚本未找到: ${proxyScript}。请克隆 https://github.com/openai/codex 并配置代理`
    )
  }

  const child = spawn(
    'python',
    [proxyScript, '--upstream', 'https://api.deepseek.com', '--port', String(PROXY_PORT)],
    {
      stdio: 'ignore',
      detached: true,
      env: { ...process.env, DEEPSEEK_API_KEY: apiKey },
    }
  )
  spawnedProxyChild = child
  child.unref()

  proxyStarted = true
  proxyApiKey = apiKey
  log.info('codex-proxy 已启动', { pid: child.pid, port: PROXY_PORT })
}

/** 只保存自己 spawn 的 codex-proxy（探测发现已有实例则不 spawn，保持 null → 不误杀） */
let spawnedProxyChild: ChildProcess | null = null

/** 清理自己 spawn 的 codex-proxy（server shutdown 时调用）。未 spawn 过 / 已清理 → no-op */
export function stopProxyIfSpawned(): void {
  spawnedProxyChild?.kill()
  spawnedProxyChild = null
}

/** 测试专用：重置 codex-proxy 模块级状态（proxyStarted 缓存 + 句柄，用例间不留残留） */
export function __test_reset(): void {
  proxyStarted = false
  proxyApiKey = ''
  spawnedProxyChild = null
}

// ─── NDJSON Stream Parsing ─────────────────────────────────

/**
 * 从 Claude Code CLI 的 NDJSON 输出流中提取文本 Chunk。
 * 格式: {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
 *
 * 过滤策略：text 块暂存到 buffer，遇到 tool_use 则清空（因为前面的 text
 * 是工具调用前导描述如"让我审查..."，不是给下游 Agent 看的回复内容）；
 * 到 result 事件时 buffer 中剩余的 text 才是真正的回复，统一产出。
 *
 * 🔧 修复 (2026-07-28): textBuffer 跨事件共享时，tool_use 清空操作错误地丢弃了
 * **之前事件** 中已积累的纯文本（非工具前导），导致 agent 回复主体内容丢失。
 * 改为事件级局部 buffer：只丢弃 tool_use **同一事件内** 的前导文本，
 * 保留此前事件中已产出的纯文本。
 *
 * thinking 块始终实时产出（前缀 "[思考] "），让前端看到流式进度。
 */
export async function* parseClaudeCodeOutput(child: ChildProcess): AsyncIterable<Chunk> {
  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity })

  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)

      if (event.type === 'assistant' && event.message?.content) {
        // 预扫描：检测当前事件是否含 tool_use
        let eventHasToolUse = false
        for (const block of event.message.content) {
          if (block.type === 'tool_use') {
            eventHasToolUse = true
            break
          }
        }

        for (const block of event.message.content) {
          // 实时产出 text block（true streaming），含 tool_use 的前导文本跳过
          if (block.type === 'text' && typeof block.text === 'string' && !eventHasToolUse) {
            yield { content: block.text, done: false, kind: 'text' }
          }
          // 产出思考过程，让前端看到实时进度（但不存入 DB，不参与上下文）
          if (block.type === 'thinking' && typeof block.thinking === 'string') {
            yield { content: `[思考] ${block.thinking}`, done: false, kind: 'thinking' }
          }
        }
      }
    } catch {
      // 跳过无法解析的行
    }
  }
}

/**
 * 从 Codex CLI 的 NDJSON 输出流中提取文本 Chunk。
 * 格式: {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
 */
export async function* parseCodexOutput(child: ChildProcess): AsyncIterable<Chunk> {
  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity })

  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (
        event.type === 'item.completed' &&
        event.item?.type === 'agent_message' &&
        event.item.text
      ) {
        yield { content: event.item.text, done: false }
      }
    } catch {
      // 跳过无法解析的行
    }
  }
}

// ─── Child Process Helpers ────────────────────────────────

/** CLI 空闲超时：20 分钟无 stdout/stderr 输出视为挂死。
 *  CatStudy 以 CLI 子进程为主力，按输出重置 timer，
 *  持续产出内容的进程不会被误杀，只有真正无输出的进程才会超时终止。
 *  环境变量 CLI_IDLE_TIMEOUT_MS 可覆盖（设为 0 禁用）。 */
const _IDLE_TIMEOUT = parseInt(process.env.CLI_IDLE_TIMEOUT_MS || '')
const CLI_IDLE_TIMEOUT_MS = isNaN(_IDLE_TIMEOUT) ? 20 * 60 * 1000 : _IDLE_TIMEOUT
/** SIGTERM → SIGKILL 的等待间隔 */
const GRACE_MS = 5000

/**
 * 给子进程挂上空闲超时检测。
 *
 * 每次 stdout/stderr 有数据时重置 timer——跟 clowder-ai 的
 * CLI 进程超时机制一致：持续产出内容的进程不会被误杀，
 * 只有真正无输出的进程才会超时终止。
 *
 * 超时后先 SIGTERM（给进程清理机会），5 秒后若仍存活则 SIGKILL 强杀。
 *
 * @returns cleanup 函数，用于提前取消 timer
 */
export function attachIdleTimeout(child: ChildProcess): () => void {
  // 超时被禁用（CLI_IDLE_TIMEOUT_MS=0）
  if (CLI_IDLE_TIMEOUT_MS <= 0) return () => {}

  let lastActivity = Date.now()

  const bump = () => {
    lastActivity = Date.now()
  }
  child.stdout?.on('data', bump)
  child.stderr?.on('data', bump)

  const timer = setInterval(() => {
    if (Date.now() - lastActivity > CLI_IDLE_TIMEOUT_MS) {
      const idleSec = Math.round((Date.now() - lastActivity) / 1000)
      log.error('子进程无输出，发送 SIGTERM', { idleSec, timeoutMs: CLI_IDLE_TIMEOUT_MS })
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!child.killed && child.exitCode === null) {
          log.error('SIGTERM 未响应，发送 SIGKILL')
          child.kill('SIGKILL')
        }
      }, GRACE_MS)
    }
  }, 1000)

  const cleanup = () => clearInterval(timer)
  child.on('close', cleanup)
  child.on('exit', cleanup)

  return cleanup
}

/**
 * 在子进程退出时报错。
 */
export function attachExitError(child: ChildProcess, label: string): void {
  child.on('close', (code, signal) => {
    if (code !== 0 && code !== null) {
      log.error(`${label} 退出`, { exitCode: code, signal })
    } else {
      log.info(`${label} 正常退出`, { exitCode: code, signal })
    }
  })

  child.stderr?.on('data', (data: Buffer) => {
    const text = data.toString().trim()
    if (!text) return
    log.debug(`${label} stderr`, { text: text.slice(0, 500) })
    if (!text.includes('Warning') && !text.includes('info')) {
      log.error(`${label} stderr`, { text: text.slice(0, 500) })
    }
  })
}

// ─── Supervised Spawn ─────────────────────────────────────

/** Supervisor 脚本路径（.mjs，与 cli-utils.ts 同目录） */
const SUPERVISOR_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'cli-supervisor.mjs'
)

/**
 * 用 CLI Supervisor 包装 spawn，防止父进程被强杀时 CLI 子进程变孤儿。
 *
 * 包装方式: server → supervisor.mjs → CLI (Claude Code / Codex)
 * Supervisor 每 1 秒检查父进程是否存活：
 *   父进程死了 → 立即 SIGTERM → 3s → SIGKILL
 *
 * @returns supervisor 的 ChildProcess 引用（用于 kill / 监控）
 */
export function spawnSupervised(
  bin: string,
  args: string[],
  opts: {
    env?: Record<string, string | undefined>
    label: string
    cwd?: string
    input?: string
  }
): ChildProcess {
  const spawnOpts = {
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    shell: false,
    // env 合并语义统一：opts.env 覆盖 process.env（per-agent 注入变量优先）。
    // 不能只传 opts.env——spawn 的 env 语义是「传了就全用传的」，部分 env 会整个
    // 丢 process.env（PATH 丢失 → CLI 子进程找不到可执行文件）；supervisor 分支
    // 旧代码 {...opts.env, ...process.env} 顺序颠倒（opts.env 被 process.env 覆盖，
    // 注入变量失效）——两分支在此统一（luna 猫 HTTPS_PROXY 注入的正确性前提）
    env: { ...process.env, ...opts.env },
    cwd: opts.cwd,
  }

  // 选择通过 supervisor 或直接 spawn
  let child: ChildProcess
  if (!fs.existsSync(SUPERVISOR_PATH)) {
    log.warn(`${opts.label} supervisor 脚本缺失，回退到直接 spawn`, { path: SUPERVISOR_PATH })
    child = spawn(bin, args, spawnOpts)
  } else {
    child = spawn(process.execPath, [SUPERVISOR_PATH, '--', bin, ...args], {
      ...spawnOpts,
      env: {
        ...spawnOpts.env,
        CATSTUDY_SUPERVISOR_PARENT_PID: String(process.pid),
      },
    })

    log.info(`${opts.label} supervisor 启动`, {
      supervisorPid: child.pid,
      bin,
      parentPid: process.pid,
    })
  }

  // 将 input 通过 stdin 传入（避免 Windows 命令行 32K 限制）。
  // supervisor 会将 stdin 转发给 CLI 子进程；直接 spawn 时 CLI 直接读取。
  if (opts.input) {
    child.stdin!.write(opts.input)
    child.stdin!.end()
  } else {
    // 没有 input 时也要关闭 stdin，避免 CLI 挂起等待输入。
    child.stdin!.end()
  }

  return child
}
