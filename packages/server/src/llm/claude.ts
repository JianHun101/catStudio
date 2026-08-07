import type { Chunk, ChatOptions, LLMMessage } from '@cat-study/shared'
import type { LLMAdapter } from './adapter.js'
import {
  resolveBin,
  messagesToPrompt,
  parseClaudeCodeOutput,
  attachIdleTimeout,
  spawnSupervised,
  getWorkspaceDir,
} from './cli-utils.js'
import { createLogger } from '../logger.js'
import { randomBytes } from 'node:crypto'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const log = createLogger('claude')

/** MCP server 脚本路径（workspace 上级 = 项目根 → scripts/mcp-server.mjs；
 *  与 cli-utils getWorkspaceDir 同款 cwd 假设） */
const MCP_SERVER_PATH = resolve(getWorkspaceDir(), '..', 'scripts', 'mcp-server.mjs')

/**
 * 内置工具黑名单（spike case 7 实证 --disallowedTools 对内置工具生效：
 * tool_use 被请求但执行被拒、命令未真实执行——「能否真正关掉 shell」= 能）。
 * 店长裁决：用例 7 生效 → claude.ts 顺带加内置工具黑名单（内置清单有限、
 * 可列全，净改善）。注：--allowedTools 白名单管不到内置工具（case 6：
 * bypassPermissions 下 Bash 照调），必须显式黑名单才能收窄内置工具面。
 * 聊天回复场景模型只需 post_message 路由 + 文本；读文件/改代码等执行能力
 * 若未来需要，走独立立项（裁决一：本单不换权限模式）。
 */
const BUILTIN_TOOLS_DISALLOWED = [].join(',')

/** 生成 .mcp.json 到 OS temp（每 spawn 一次；调用方负责 finally 清理）。
 *  文件名带 pid + 随机后缀——同一进程并发多个 spawn 不冲突 */
function writeMcpConfig(): string {
  const cfg = {
    mcpServers: {
      // server 名 catstudy → 工具面 mcp__catstudy__post_message（spike 验证形态）
      catstudy: {
        command: process.execPath,
        args: [MCP_SERVER_PATH],
      },
    },
  }
  const p = join(tmpdir(), `catstudy-mcp-${process.pid}-${randomBytes(4).toString('hex')}.json`)
  writeFileSync(p, JSON.stringify(cfg, null, 2))
  return p
}

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
  private baseUrl?: string
  private effortLevel?: string

  constructor(config: ClaudeConfig) {
    this.apiKey = config.apiKey
    this.model = config.model
    this.baseUrl = config.baseUrl
    this.effortLevel = config.effortLevel
  }

  async *chatStream(messages: LLMMessage[], options: ChatOptions): AsyncIterable<Chunk> {
    const signal = options.signal

    // Claude CLI 通过模型内部配置控制 maxTokens/temperature，ChatOptions 中的对应字段会被忽略
    if (options.maxTokens !== undefined || options.temperature !== undefined) {
      log.warn(
        'ChatOptions.maxTokens/temperature 被 Claude CLI 适配器忽略，请通过 Claude Code 配置调整'
      )
    }

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
    const env = this.buildEnv(options.context)

    log.info('启动 Claude Code CLI', { model: this.model, promptLen: prompt.length })

    // MCP 结构化路由（契约 4——店长裁决）：context 存在时挂 post_message 工具面。
    // .mcp.json 每 spawn 生成到 OS temp，流结束/异常路径 finally 删除；
    // env 五变量由 buildEnv 透传（MCP server 子进程继承）。
    // context 不存在（测试/非路由调用）→ 不加任何参数，行为与现状逐字节一致。
    let mcpConfigPath: string | null = null
    const args = [
      '-p',
      '-',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
    ]
    if (options.context) {
      mcpConfigPath = writeMcpConfig()
      args.push(
        '--mcp-config',
        mcpConfigPath,
        // 白名单只留 post_message（spike case 3/4 双证实效：MCP 工具面收窄）
        '--allowedTools',
        'mcp__catstudy__post_message',
        // 内置工具黑名单（spike case 7 实证生效——店长裁决：列全净改善）
        '--disallowedTools',
        BUILTIN_TOOLS_DISALLOWED
      )
    }

    // 将 prompt 通过 stdin 传入，避免 Windows 命令行 32K 限制。
    // -p - 告诉 Claude CLI 从 stdin 读取提示词。
    const child = spawnSupervised(CLAUDE_BIN, args, {
      env,
      label: 'claude',
      input: prompt,
      cwd: getWorkspaceDir(),
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
      } else if (stderr.trim()) {
        // exit 0 但 stderr 非空 → 可能包含诊断信息（API 警告、速率限制等）
        log.warn('claude stderr (exit 0)', { stderr: stderr.slice(0, 500) })
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
      // 清理临时 .mcp.json（正常/异常/abort 路径都走 finally）
      if (mcpConfigPath) {
        try {
          unlinkSync(mcpConfigPath)
        } catch {
          /* 已被外部清理则忽略 */
        }
      }
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

  private buildEnv(context?: ChatOptions['context']): Record<string, string> {
    // baseUrl 留空默认 DeepSeek Anthropic 兼容端点；填其他端点（如 Kimi: https://api.moonshot.ai/anthropic）走对应服务
    const baseUrl = this.baseUrl || 'https://api.deepseek.com/anthropic'
    const isDeepSeek = !this.baseUrl || /deepseek/i.test(this.baseUrl)

    // 非 DeepSeek 端点（Kimi K3 等）无分级模型，HAIKU/SUBAGENT/FABLE 全量兜底主模型；
    // Kimi 端点不支持 Tool Search，需显式关闭
    const tierFallbacks = isDeepSeek
      ? {
          ANTHROPIC_DEFAULT_HAIKU_MODEL:
            process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || 'deepseek-v4-flash',
          CLAUDE_CODE_SUBAGENT_MODEL: process.env.CLAUDE_CODE_SUBAGENT_MODEL || 'deepseek-v4-flash',
          // MCP spike case 5 实锤：ENABLE_TOOL_SEARCH=true 时 ToolSearch 混入调用链
          // 且真实执行（tool_reference 指向 echo）——DeepSeek 端点显式关闭，
          // 与 Kimi 端点一致，消除 ToolSearch 路径（店长裁决：必须项）
          ENABLE_TOOL_SEARCH: 'false',
        }
      : {
          ANTHROPIC_DEFAULT_HAIKU_MODEL: this.model,
          ANTHROPIC_DEFAULT_FABLE_MODEL: this.model,
          CLAUDE_CODE_SUBAGENT_MODEL: this.model,
          ENABLE_TOOL_SEARCH: 'false',
        }

    const env = {
      ...process.env,
      DEEPSEEK_API_KEY: this.apiKey,
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: this.apiKey,
      ANTHROPIC_MODEL: this.model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: this.model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: this.model,
      ...tierFallbacks,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_EFFORT_LEVEL: this.effortLevel || process.env.CLAUDE_CODE_EFFORT_LEVEL || 'high',
    } as Record<string, string>

    // MCP 结构化路由变量（契约 4——店长裁决）：context 透传给 MCP server
    // （子进程继承 env）。CATSTUDY_SERVER_URL 用 server 监听口径（index.ts 同款
    // PORT 默认 3200）——MCP server 在本机访问，127.0.0.1 而非 localhost
    // （Windows IPv4/IPv6 歧义，项目惯例）。triggerAuthorName 可选（OQ③ 补丁）：
    // 有值才设 env，避免空串噪音（MCP server 侧只读值非空才带 body 字段）。
    if (context) {
      env.CATSTUDY_SERVER_URL = `http://127.0.0.1:${process.env.PORT || '3200'}`
      env.CATSTUDY_SIGNAL_TOKEN = context.token
      env.CATSTUDY_SESSION_ID = context.sessionId
      env.CATSTUDY_AGENT_ID = context.agentId
      env.CATSTUDY_MSG_ID = context.msgId
      if (context.triggerAuthorName) env.CATSTUDY_TRIGGER_AUTHOR_NAME = context.triggerAuthorName
    }
    return env
  }
}
