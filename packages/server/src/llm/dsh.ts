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
import { randomBytes } from 'node:crypto'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const log = createLogger('dsh')

interface DshConfig {
  /** DeepSeek API Key（DS_KEY 复用）；可选——缺失时以空串注入，dsh 走 credentials 落盘兜底 */
  apiKey?: string
  model: string
  baseUrl?: string
  /** 额外环境变量（per-agent 配置；registry 已宽容解析，此处收对象） */
  envExtra?: Record<string, string>
}

/** dsh CLI 二进制路径（模块加载时解析） */
let DSH_BIN: string
try {
  DSH_BIN = resolveBin('dsh', '@deepseek-ai/dsh')
} catch (err: any) {
  log.warn('dsh CLI 未安装', { error: err.message })
  DSH_BIN = ''
}

/** MCP server 脚本路径（workspace 上级 = 项目根 → scripts/mcp-server.mjs；
 *  与 cli-utils getWorkspaceDir 同款 cwd 假设） */
const MCP_SERVER_PATH = resolve(getWorkspaceDir(), '..', 'scripts', 'mcp-server.mjs')

/** Windows 命令行长度限制防御阈值。headless task 以 positional 传入
 *  （dsh --profile headless "task"），命令行总长受 CreateProcess
 *  32K 限制——超阈值截断兜底，防止 spawn ENOENT。 */
const PROMPT_ARG_MAX = 30000

/** YAML 单引号标量：单引号翻倍转义（YAML 语义），路径反斜杠在单引号内保持字面量 */
function yamlScalar(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * 生成 per-spawn 临时 cordis.patch.yml（--patch overlay，finally 清理）。
 *
 * 内容三行 insert：
 *  1. mcp-catstudy（@deepseek-ai/dsh-mcp-client）——serverName catstudy + stdio
 *     spawn node scripts/mcp-server.mjs；env 以**字面量内联**（非 !!js 引用）——
 *     guaranteed 路径：不依赖 dsh 的 !!js env 求值（店长派活单红项，post-install 实测
 *     通过后可简化为静态 patch + !!js process.env.X）。工具面 mcp__catstudy__* 与
 *     claude 链逐字一致（官方文档实证：mcp__<serverName>__<rawName>）。
 *  2. agent-default-model——headless 走 base bundle 的默认模型选择行，覆盖为当轮
 *     llmModel（**row id 未实证，post-install 以 --dump-config 核对，见 OQ**）。
 *  3. approval——headless 无 UI 应答时工具 fail-closed 全拒，需配置放行
 *     （**row id 与取值未实证，post-install 核对，见 OQ**）。
 *
 * env 值来自 options.context（CATSTUDY_* 五元组 + 可选 triggerAuthorName），
 * MCP server 子进程继承；文件名带 pid + 随机后缀——同一进程并发多个 spawn 不冲突。
 */
function writePatchConfig(context: NonNullable<ChatOptions['context']>, model: string): string {
  const serverUrl = `http://127.0.0.1:${process.env.PORT || '3200'}`
  const envLines = [
    `CATSTUDY_SERVER_URL: ${yamlScalar(serverUrl)}`,
    `CATSTUDY_SIGNAL_TOKEN: ${yamlScalar(context.token)}`,
    `CATSTUDY_SESSION_ID: ${yamlScalar(context.sessionId)}`,
    `CATSTUDY_AGENT_ID: ${yamlScalar(context.agentId)}`,
    `CATSTUDY_MSG_ID: ${yamlScalar(context.msgId)}`,
  ]
  if (context.triggerAuthorName) {
    envLines.push(`CATSTUDY_TRIGGER_AUTHOR_NAME: ${yamlScalar(context.triggerAuthorName)}`)
  }

  const patch = `- insert:
    - id: mcp-catstudy
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: catstudy
        transport: stdio
        command: node
        args: [${yamlScalar(MCP_SERVER_PATH)}]
        env:
${envLines.map((l) => `          ${l}`).join('\n')}
- insert:
    - id: agent-default-model
      config:
        model: ${yamlScalar(model)}
- insert:
    - id: approval
      config:
        mode: never
`
  const p = join(
    tmpdir(),
    `catstudy-dsh-patch-${process.pid}-${randomBytes(4).toString('hex')}.yml`
  )
  writeFileSync(p, patch)
  return p
}

/**
 * dsh（deepseek-harness）CLI 适配器。
 *
 * 通过 spawn dsh 子进程（`--profile headless "task"` 一次性形态）→ 收集 stdout →
 * 输出最终答案 Chunk。与 claude.ts 同为 CLI 子进程形态，复用 cli-utils 公共设施
 * （resolveBin / messagesToPrompt / attachIdleTimeout / spawnSupervised）。
 *
 * 形态差异（headless 无流式）：整轮 agent 循环完成后一次性打印最终答案到 stdout
 * （exit 0 = completed，stderr 保持空；非 0 退出 stderr 带错误码+消息）。所以本适配器
 * 不解析事件流——收集全量 stdout，close 后按 exit code 判定产出。长思考/工具循环期间
 * 用户看到静默（headless 形态固有，无中间事件可转发），与 opencode run 的实时工具
 * 事件不同——这是形态取舍，OQ 记录。
 *
 * 凭证：dsh 解析顺序为 继承 env → $DSH_HOME/.credentials.yaml → 调用目录 .env →
 * $DSH_HOME/.env；本适配器把 apiKey（DS_KEY 复用）以 DEEPSEEK_API_KEY 注入 spawn env
 * （继承 env 优先级最高，覆盖 credentials 落盘——不落盘任何密钥）。
 *
 * 前置要求: npm i -g @deepseek-ai/dsh
 */
export class DshAdapter implements LLMAdapter {
  readonly provider = 'dsh'
  private apiKey: string
  private model: string
  private baseUrl?: string
  private envExtra: Record<string, string>

  constructor(config: DshConfig) {
    this.apiKey = config.apiKey ?? ''
    this.model = config.model
    this.baseUrl = config.baseUrl
    this.envExtra = config.envExtra ?? {}
  }

  async *chatStream(messages: LLMMessage[], options: ChatOptions): AsyncIterable<Chunk> {
    const signal = options.signal

    // dsh 通过 profile/patch 配置控制模型与参数，ChatOptions 中的对应字段会被忽略
    if (options.maxTokens !== undefined || options.temperature !== undefined) {
      log.warn('ChatOptions.maxTokens/temperature 被 dsh 适配器忽略，请通过 dsh profile 配置调整')
    }

    if (signal?.aborted) {
      yield { content: '', done: true }
      return
    }

    if (!DSH_BIN) {
      yield {
        content: 'dsh CLI 未安装。请先运行: npm i -g @deepseek-ai/dsh',
        done: true,
      }
      return
    }

    const prompt = messagesToPrompt(messages)
    // headless task 以 positional 传入（launcher flags 之后的首个未识别 token 起为
    // app 参数）——同 opencode 受 32K 限制，超阈值截断兜底
    const promptArg = prompt.length > PROMPT_ARG_MAX ? prompt.slice(0, PROMPT_ARG_MAX) : prompt
    if (prompt.length > PROMPT_ARG_MAX) {
      log.warn('prompt 超过命令行长度阈值，已截断', {
        promptLen: prompt.length,
        max: PROMPT_ARG_MAX,
      })
    }

    const model = options.model || this.model

    // MCP 结构化路由（context 存在时挂工具面）：per-spawn 临时 patch overlay。
    // 参数序：launcher flags（--profile/--patch）在前，task 最后。
    let patchPath: string | null = null
    const args = ['--profile', 'headless']
    if (options.context) {
      patchPath = writePatchConfig(options.context, model)
      args.push('--patch', patchPath)
    }
    args.push(promptArg)

    log.info('启动 dsh CLI', { model, promptLen: prompt.length })

    const env = {
      ...process.env,
      ...this.envExtra,
      // 凭证注入（DS_KEY 复用）：dsh 继承 env 优先级最高，不落盘密钥
      DEEPSEEK_API_KEY: this.apiKey,
    } as Record<string, string>

    const child = spawnSupervised(DSH_BIN, args, {
      env,
      label: 'dsh',
      // cwd 透传会话 worktree 路径（会话隔离）——缺省默认 workspace（存量行为零变化）
      cwd: options.cwd ?? getWorkspaceDir(),
    })

    // ─── Abort 处理：收到取消信号时 kill 子进程 ───
    const GRACE_MS = 5000
    const onAbort = () => {
      if (!child.killed && child.exitCode === null) {
        log.warn('收到取消信号，发送 SIGTERM', { model })
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

    // headless 一次性输出：收集全量 stdout（最终答案）与 stderr（错误诊断）
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    // spawn 失败标记（ENOENT 等：进程从未启动）
    let spawnFailed = false
    let spawnError = ''
    child.on('error', (err) => {
      spawnFailed = true
      spawnError = err.message
      log.error('spawn 失败', { error: err.message })
    })

    child.on('close', (code) => {
      if (code !== 0 && code !== null) {
        log.error('dsh 退出', { exitCode: code, stderr: stderr.slice(0, 500) })
      } else if (stderr.trim()) {
        // exit 0 但 stderr 非空 → 可能包含诊断信息
        log.warn('dsh stderr (exit 0)', { stderr: stderr.slice(0, 500) })
      }
    })

    // 等 close（进程退出后派发；spawn error 也会触发 close）——先等再判 exitCode，
    // 免 stdout EOF/close 竞态（opencode WAIT_CLOSE_MS 处理的是先查后等，这里先等）
    const exitCode = await new Promise<number | null>((res) => {
      child.once('close', (code) => res(code))
    })

    signal?.removeEventListener('abort', onAbort)
    cleanupIdle()
    // 清理临时 patch（正常/异常/abort 路径都走 finally）
    if (patchPath) {
      try {
        unlinkSync(patchPath)
      } catch {
        /* 已被外部清理则忽略 */
      }
    }

    // 被取消时不产出后续错误信息
    if (signal?.aborted) {
      yield { content: '', done: true }
      return
    }

    // 文案归位（与进程真实状态一一对应）：
    // 「无法启动」仅指 spawn 失败（进程从未启动，ENOENT 类）；
    // 「启动失败 (exit code N)」指进程启动但非零退出（headless 非 completed 即 exit 1）；
    // exit 0 = completed：stdout 有内容则产出最终答案，空则空响应（不报错）。
    if (spawnFailed) {
      yield {
        content: `dsh CLI 无法启动: ${spawnError}`,
        done: true,
      }
      return
    }
    if (exitCode !== null && exitCode !== 0) {
      const detail = stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ''
      yield {
        content: `dsh CLI 启动失败 (exit code ${exitCode})${detail}`,
        done: true,
      }
      return
    }
    if (stdout.trim()) {
      yield { content: stdout.trim(), done: false, kind: 'text' }
    }
    yield { content: '', done: true }
  }
}
