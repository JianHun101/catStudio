import { spawn } from 'node:child_process'
import type { Chunk, ChatOptions, LLMMessage } from '@cat-study/shared'
import type { LLMAdapter } from './adapter.js'
import {
  resolveBin,
  messagesToPrompt,
  parseCodexOutput,
  ensureProxy,
  attachIdleTimeout,
  attachExitError,
  // Codex 通过 stdin 传 prompt，supervisor 暂不支持 stdin 转发
  // spawnSupervised 用于 Claude 适配器（-p 参数传 prompt）
  terminateChild,
} from './cli-utils.js'
import { createLogger } from '../logger.js'

const log = createLogger('openai')

interface OpenAIConfig {
  apiKey: string
  model: string
  baseUrl?: string
}

/** Codex CLI 二进制路径（模块加载时解析） */
let CODEX_BIN: string
try {
  CODEX_BIN = resolveBin('codex', '@openai/codex')
} catch (err: any) {
  log.warn('Codex CLI 未安装', { error: err.message })
  CODEX_BIN = ''
}

/**
 * Codex CLI 适配器。
 *
 * 通过 spawn Codex 子进程 → 解析 NDJSON 流 → 输出 Chunk。
 * Codex 经 codex-proxy 将 Responses API 转为 DeepSeek Chat Completions。
 *
 * 前置要求:
 *   1. npm i -g @openai/codex
 *   2. codex-proxy 已安装于 ~/codex-proxy/codex_proxy.py
 */
export class OpenAIAdapter implements LLMAdapter {
  readonly provider = 'openai'
  private apiKey: string
  private model: string

  constructor(config: OpenAIConfig) {
    this.apiKey = config.apiKey
    this.model = config.model
  }

  async *chatStream(messages: LLMMessage[], options: ChatOptions): AsyncIterable<Chunk> {
    const signal = options.signal

    // Codex CLI 通过模型内部配置控制 maxTokens/temperature，ChatOptions 中的对应字段会被忽略
    if (options.maxTokens !== undefined || options.temperature !== undefined) {
      log.warn('ChatOptions.maxTokens/temperature 被 Codex CLI 适配器忽略')
    }

    if (signal?.aborted) {
      yield { content: '', done: true }
      return
    }

    if (!CODEX_BIN) {
      yield {
        content: 'Codex CLI 未安装。请运行: npm i -g @openai/codex',
        done: true,
      }
      return
    }

    // 确保 codex-proxy 在运行
    try {
      ensureProxy(this.apiKey)
    } catch (err: any) {
      yield {
        content: `codex-proxy 启动失败: ${err.message}`,
        done: true,
      }
      return
    }

    const prompt = messagesToPrompt(messages)

    log.info('启动 Codex CLI', { model: this.model })

    let child

    // Windows: PowerShell 管道传 prompt，避免 stdin 阻塞
    if (process.platform === 'win32' && CODEX_BIN.endsWith('.cmd')) {
      const escapedPrompt = prompt.replace(/"/g, '`"')
      const psCmd = `$input | & "${CODEX_BIN}" exec --skip-git-repo-check --json -`
      child = spawn('powershell.exe', ['-NoProfile', '-Command', psCmd], {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        env: { ...process.env, DEEPSEEK_API_KEY: this.apiKey },
      })
      child.stdin!.write(escapedPrompt)
      child.stdin!.end()
    } else {
      child = spawn(CODEX_BIN, ['exec', '--skip-git-repo-check', '--json', prompt], {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        env: { ...process.env, DEEPSEEK_API_KEY: this.apiKey },
      })
      child.stdin!.write(prompt)
      child.stdin!.end()
    }

    // ─── Abort 处理 ───
    // 存活判据与平台分派统一收在 `terminateChild`（cli-utils）——判据禁用 `killed`
    // （信号发出≠进程已死），win32 走 `taskkill /T` 树杀。详见该函数注释。
    const onAbort = () => terminateChild(child, { label: 'codex' })
    signal?.addEventListener('abort', onAbort)

    const cleanupIdle = attachIdleTimeout(child)
    attachExitError(child, 'codex')

    child.on('error', (err) => {
      log.error('spawn 失败', { error: err.message })
    })

    try {
      for await (const chunk of parseCodexOutput(child)) {
        if (signal?.aborted) break
        yield chunk
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      cleanupIdle()
    }

    yield { content: '', done: true }
  }
}
