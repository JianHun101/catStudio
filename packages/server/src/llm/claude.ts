import type { Chunk, ChatOptions, LLMMessage } from '@cat-study/shared'
import type { LLMAdapter } from './adapter.js'
import {
  resolveBin,
  messagesToPrompt,
  parseClaudeCodeOutput,
  attachIdleTimeout,
  spawnSupervised,
} from './cli-utils.js'
import { createLogger } from '../logger.js'

const log = createLogger('claude')

interface ClaudeConfig {
  apiKey: string
  model: string
  baseUrl?: string
  effortLevel?: string
}

/** Claude Code CLI 二进制路径（模块加载时解析） */
let CLAUDE_BIN: string
try {
  CLAUDE_BIN = resolveBin('claude', '@anthropic-ai/claude-code')
} catch (err: any) {
  log.warn('Claude Code CLI 未安装', { error: err.message })
  CLAUDE_BIN = ''
}

/**
 * Claude Code CLI 适配器。
 *
 * 通过 spawn Claude Code 子进程 → 解析 NDJSON 流 → 输出 Chunk。
 * 环境变量将 Claude Code 指向 DeepSeek API。
 *
 * 前置要求: npm i -g @anthropic-ai/claude-code
 */
export class ClaudeAdapter implements LLMAdapter {
  readonly provider = 'claude'
  private apiKey: string
  private model: string
  private effortLevel?: string

  constructor(config: ClaudeConfig) {
    this.apiKey = config.apiKey
    this.model = config.model
    this.effortLevel = config.effortLevel
  }

  async *chatStream(
    messages: LLMMessage[],
    options: ChatOptions,
  ): AsyncIterable<Chunk> {
    const signal = options.signal

    if (signal?.aborted) {
      yield { content: '', done: true }
      return
    }

    if (!CLAUDE_BIN) {
      yield {
        content: 'Claude Code CLI 未安装。请运行: npm i -g @anthropic-ai/claude-code',
        done: true,
      }
      return
    }

    const prompt = messagesToPrompt(messages)
    const env = this.buildEnv()

    log.info('启动 Claude Code CLI', { model: this.model })

    const child = spawnSupervised(CLAUDE_BIN, [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
    ], {
      env,
      label: 'claude',
    })

    // ─── Abort 处理：收到取消信号时 kill 子进程 ───
    const GRACE_MS = 5000
    const onAbort = () => {
      if (!child.killed && child.exitCode === null) {
        log.warn('收到取消信号，发送 SIGTERM', { model: this.model })
        child.kill('SIGTERM')
        setTimeout(() => {
          if (!child.killed && child.exitCode === null) {
            log.warn('SIGTERM 未响应，发送 SIGKILL')
            child.kill('SIGKILL')
          }
        }, GRACE_MS)
      }
    }
    signal?.addEventListener('abort', onAbort)

    const cleanupIdle = attachIdleTimeout(child)

    // 收集 stderr 用于错误报告
    let stderr = ''
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    // 标记是否有输出，用于判断是否为静默失败
    let hasOutput = false

    // spawn 失败 → 立即产出错误 chunk，避免 generator 静默挂起
    child.on('error', (err) => {
      log.error('spawn 失败', { error: err.message })
    })

    child.on('close', (code) => {
      if (code !== 0 && code !== null) {
        log.error('claude 退出', { exitCode: code, stderr: stderr.slice(0, 500) })
      }
    })

    try {
      for await (const chunk of parseClaudeCodeOutput(child)) {
        if (signal?.aborted) break
        hasOutput = true
        yield chunk
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      cleanupIdle()
    }

    // 被取消时不产出后续错误信息
    if (signal?.aborted) {
      yield { content: '', done: true }
      return
    }

    // 进程非零退出或无输出 → 产出错误信息
    if (!hasOutput) {
      if (child.exitCode !== null && child.exitCode !== 0) {
        const detail = stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ''
        yield {
          content: `Claude Code CLI 启动失败 (exit code ${child.exitCode})${detail}`,
          done: true,
        }
        return
      }
      // exitCode 为 null = 进程未能启动（如 ENOENT）
      if (child.exitCode === null) {
        yield {
          content: 'Claude Code CLI 无法启动。请检查是否已安装: npm i -g @anthropic-ai/claude-code',
          done: true,
        }
        return
      }
    }

    yield { content: '', done: true }
  }

  private buildEnv(): Record<string, string> {
    return {
      ...process.env,
      DEEPSEEK_API_KEY: this.apiKey,
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: this.apiKey,
      ANTHROPIC_MODEL: this.model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: this.model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: this.model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || 'deepseek-v4-flash',
      CLAUDE_CODE_SUBAGENT_MODEL: process.env.CLAUDE_CODE_SUBAGENT_MODEL || 'deepseek-v4-flash',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_EFFORT_LEVEL: this.effortLevel || process.env.CLAUDE_CODE_EFFORT_LEVEL || 'high',
    } as Record<string, string>
  }
}
