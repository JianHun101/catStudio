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
import type { Chunk, LLMMessage } from '@cat-study/shared'
import { createLogger } from '../logger.js'

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

// ─── Prompt Construction ──────────────────────────────────

/**
 * 将 LLMMessage 数组转为单个文本 prompt，供 CLI 工具使用。
 */
export function messagesToPrompt(messages: LLMMessage[]): string {
  const parts: string[] = []

  for (const m of messages) {
    switch (m.role) {
      case 'system':
        parts.push(`${m.content}\n\n---\n`)
        break
      case 'user':
        parts.push(`User: ${m.content}`)
        break
      case 'assistant':
        parts.push(`Assistant: ${m.content}`)
        break
    }
  }

  return parts.join('\n\n')
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

  const child = spawn('python', [
    proxyScript,
    '--upstream', 'https://api.deepseek.com',
    '--port', String(PROXY_PORT),
  ], {
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, DEEPSEEK_API_KEY: apiKey },
  })

  child.unref()

  proxyStarted = true
  proxyApiKey = apiKey
  log.info('codex-proxy 已启动', { pid: child.pid, port: PROXY_PORT })
}

// ─── NDJSON Stream Parsing ─────────────────────────────────

/**
 * 从 Claude Code CLI 的 NDJSON 输出流中提取文本 Chunk。
 * 格式: {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
 */
export async function* parseClaudeCodeOutput(
  child: ChildProcess,
): AsyncIterable<Chunk> {
  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity })

  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (event.type === 'assistant' && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            yield { content: block.text, done: false }
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
export async function* parseCodexOutput(
  child: ChildProcess,
): AsyncIterable<Chunk> {
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

const MAX_IDLE_MS = 5 * 60 * 1000 // 5 分钟无输出视为超时
const GRACE_MS = 5000

/**
 * 给子进程挂上空闲超时检测。超时后先 SIGTERM，再 SIGKILL。
 */
export function attachIdleTimeout(child: ChildProcess): () => void {
  let lastActivity = Date.now()

  const bump = () => {
    lastActivity = Date.now()
  }
  child.stdout?.on('data', bump)
  child.stderr?.on('data', bump)

  const timer = setInterval(() => {
    if (Date.now() - lastActivity > MAX_IDLE_MS) {
      const idleSec = Math.round((Date.now() - lastActivity) / 1000)
      log.error('子进程无输出，发送 SIGTERM', { idleSec })
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
  child.on('close', (code) => {
    if (code !== 0 && code !== null) {
      log.error(`${label} 退出`, { exitCode: code })
    }
  })

  child.stderr?.on('data', (data: Buffer) => {
    const text = data.toString()
    if (!text.includes('Warning') && !text.includes('info')) {
      log.error(`${label} stderr`, { text: text.trim() })
    }
  })
}
