import type { Chunk, ChatOptions, LLMMessage } from '@cat-study/shared'
import type { LLMAdapter } from './adapter.js'
import {
  resolveBin,
  messagesToPrompt,
  attachIdleTimeout,
  spawnSupervised,
  getWorkspaceDir,
} from './cli-utils.js'
import { createLogger } from '../logger.js'
import { createInterface } from 'node:readline'
import type { ChildProcess } from 'node:child_process'

const log = createLogger('opencode')

interface OpencodeConfig {
  model: string
  /** 额外环境变量（per-agent 配置，如 HTTPS_PROXY 代理；registry 已宽容解析，此处收对象） */
  envExtra?: Record<string, string>
}

/** opencode CLI 二进制路径（模块加载时解析） */
let OPENCODE_BIN: string
try {
  OPENCODE_BIN = resolveBin('opencode', 'opencode-ai')
} catch (err: any) {
  log.warn('opencode CLI 未安装', { error: err.message })
  OPENCODE_BIN = ''
}

/**
 * opencode CLI 适配器。
 *
 * 通过 spawn opencode 子进程（`run --format json` 非交互流式）→ 解析 NDJSON
 * 事件流 → 输出 Chunk。与 claude.ts 同为 CLI 子进程形态，复用 cli-utils
 * 公共设施（resolveBin / messagesToPrompt / attachIdleTimeout / spawnSupervised）。
 *
 * apiKey 不消费（opencode 用本地认证，`opencode auth login` 后凭本地凭据鉴权），
 * maxTokens/temperature 由 opencode 本地配置控制。不挂 MCP 工具面
 * （options.context 忽略，与 deepseek/pi/ollama 一致）。
 *
 * 前置要求: npm i -g opencode-ai && opencode auth login
 */
export class OpencodeAdapter implements LLMAdapter {
  readonly provider = 'opencode'
  private model: string
  private envExtra: Record<string, string>

  constructor(config: OpencodeConfig) {
    this.model = config.model
    this.envExtra = config.envExtra ?? {}
  }

  async *chatStream(messages: LLMMessage[], options: ChatOptions): AsyncIterable<Chunk> {
    const signal = options.signal

    // opencode 通过本地配置控制 maxTokens/temperature，ChatOptions 中的对应字段会被忽略
    if (options.maxTokens !== undefined || options.temperature !== undefined) {
      log.warn('ChatOptions.maxTokens/temperature 被 opencode 适配器忽略，请通过 opencode 配置调整')
    }

    if (signal?.aborted) {
      yield { content: '', done: true }
      return
    }

    if (!OPENCODE_BIN) {
      yield {
        content: 'opencode CLI 未安装。请先运行: npm i -g opencode-ai && opencode auth login',
        done: true,
      }
      return
    }

    const prompt = messagesToPrompt(messages)

    log.info('启动 opencode CLI', { model: options.model || this.model, promptLen: prompt.length })

    // run --format json 非交互流式（NDJSON 事件流）；
    // 注意：不带 -q——该静默选项在 opencode 1.18.16 已移除，yargs strict 遇未知
    // 选项会打印帮助并 exit 1（luna 猫「无法启动」实测根因）；--format json 本身
    // 已是 raw JSON 事件，无需要抑制的噪音。
    // -m <model> 用 provider/model 格式（如 anthropic/claude-sonnet-4-5）。
    // prompt 通过 stdin 传入，避免 Windows 命令行 32K 限制（claude.ts -p - 同款思路）。
    const child = spawnSupervised(
      OPENCODE_BIN,
      // options.model 优先（调用方每轮传当轮 agent 的 llmModel，socketio.ts 契约），
      // 构造 model 兜底——同一缓存实例可服务不同 model 的猫（deepseek.ts/ollama.ts 同款惯例）
      ['run', '--format', 'json', '-m', options.model || this.model],
      {
        label: 'opencode',
        input: prompt,
        // cwd 透传会话 worktree 路径（会话隔离）——缺省默认 workspace（存量行为零变化）
        cwd: options.cwd ?? getWorkspaceDir(),
        // per-agent 额外环境变量（如 HTTPS_PROXY）：显式完整合并传入——
        // spawnSupervised 内部统一为 {...process.env, ...opts.env}，此处传完整合并
        // 双保险：即使内部语义未来被误改，注入也不丢 process.env（luna 猫代理场景）
        env: { ...process.env, ...this.envExtra },
      }
    )

    // ─── Abort 处理：收到取消信号时 kill 子进程 ───
    const GRACE_MS = 5000
    const onAbort = () => {
      if (!child.killed && child.exitCode === null) {
        log.warn('收到取消信号，发送 SIGTERM', { model: options.model || this.model })
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
        log.error('opencode 退出', { exitCode: code, stderr: stderr.slice(0, 500) })
      } else if (stderr.trim()) {
        // exit 0 但 stderr 非空 → 可能包含诊断信息（API 警告、速率限制等）
        log.warn('opencode stderr (exit 0)', { stderr: stderr.slice(0, 500) })
      }
    })

    try {
      for await (const chunk of parseOpencodeOutput(child)) {
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

    // 进程非零退出或无输出 → 产出错误信息（不静默挂起）
    if (!hasOutput) {
      if (child.exitCode !== null && child.exitCode !== 0) {
        const detail = stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ''
        yield {
          content: `opencode CLI 启动失败 (exit code ${child.exitCode})${detail}`,
          done: true,
        }
        return
      }
      // exitCode 为 null = 进程未能启动（如 ENOENT）
      if (child.exitCode === null) {
        yield {
          content: 'opencode CLI 无法启动。请检查是否已安装: npm i -g opencode-ai',
          done: true,
        }
        return
      }
    }

    yield { content: '', done: true }
  }
}

/**
 * 从 opencode CLI 的 NDJSON 输出流中提取文本 Chunk。
 * 格式（run --format json）: {"type":"text","text":"..."} / {"type":"error",...}
 *
 * type === 'text' → 实时产出内容 chunk；type === 'error' → 产出错误 chunk 并终止
 * （错误是终止性事件，后续不再有有效内容）。无法解析的行跳过。
 */
async function* parseOpencodeOutput(child: ChildProcess): AsyncIterable<Chunk> {
  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity })

  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (event.type === 'text' && typeof event.text === 'string' && event.text) {
        yield { content: event.text, done: false, kind: 'text' }
      } else if (event.type === 'error') {
        // error 事件兼容两种形态：{error:{message}} 嵌套 或 顶层 {message}
        const msg = event.error?.message || event.message || 'opencode 错误'
        yield { content: `[错误] ${msg}`, done: false, kind: 'text' }
        return
      }
    } catch {
      // 跳过无法解析的行
    }
  }
}
