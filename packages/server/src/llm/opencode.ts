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
import { v4 as uuid } from 'uuid'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
 * Windows 命令行长度限制防御阈值。prompt 以 positional message 传入
 * （opencode run 不读 stdin，见 spawn 注释），命令行总长受 CreateProcess
 * 32K 限制——超阈值截断兜底，防止 spawn ENOENT（claude.ts 走 stdin 无此限制）。
 */
const PROMPT_ARG_MAX = 30000

/** 竞态修复：stdout EOF 后等 close 派发的兜底窗口（防进程永挂） */
const WAIT_CLOSE_MS = 5000

/**
 * 把最后一条 user 消息的 base64 dataURL 图片落盘为临时文件。
 *
 * opencode run 的 -f 只认文件路径（不认 base64）——实测 `-f <path>` 传图成功，
 * gpt-5.6-luna 正确识别图片内容（视觉模型）。仅取最后一条 user 消息的图片：
 * opencode run 是单 message 形态（positional），历史消息的图无法与消息建立
 * 关联，传了模型也看不到上下文（与 messagesToPrompt 的平铺模型对齐）。
 *
 * 返回 { dir, fileArgs }；落盘失败返回 null（降级：prompt 里仍有 socketio.ts
 * 注入的「用户附带了 N 张图片」文字占位，模型仍可感知"用户发了图"）。
 */
async function materializeImages(
  messages: LLMMessage[]
): Promise<{ dir: string; fileArgs: string[] } | null> {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user' && m.images?.length)
  if (!lastUser?.images?.length) return null

  const dir = await mkdtemp(join(tmpdir(), 'opencode-img-'))
  const fileArgs: string[] = []
  try {
    for (const dataUrl of lastUser.images) {
      // data:image/png;base64,XXXX → 去前缀取 base64；无前缀的裸 base64 直接用
      const comma = dataUrl.indexOf(',')
      const mimeMatch = /^data:image\/([\w+-]+)/.exec(dataUrl)
      const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
      const ext = mimeMatch ? (mimeMatch[1] === 'jpeg' ? 'jpg' : mimeMatch[1]) : 'png'
      const file = join(dir, `${uuid()}.${ext}`)
      await writeFile(file, Buffer.from(b64, 'base64'))
      fileArgs.push('-f', file)
    }
    return { dir, fileArgs }
  } catch (err: any) {
    log.warn('图片落盘失败，降级为仅文字占位', { error: err.message })
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    return null
  }
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
    // images（base64 dataURL）落盘为临时文件，-f 透传（实测支持视觉输入）；
    // 落盘失败降级：不传图，prompt 仍含「用户附带了 N 张图片」占位
    const materialized = await materializeImages(messages)
    const fileArgs = materialized?.fileArgs ?? []

    log.info('启动 opencode CLI', { model: options.model || this.model, promptLen: prompt.length })

    // run --format json 非交互流式（NDJSON 事件流）；
    // 注意：不带 -q——该静默选项在 opencode 1.18.16 已移除，yargs strict 遇未知
    // 选项会打印帮助并 exit 1（luna 猫「无法启动」实测根因）；--format json 本身
    // 已是 raw JSON 事件，无需要抑制的噪音。
    // -m <model> 用 provider/model 格式（如 anthropic/claude-sonnet-4-5）。
    // --thinking：实测必需——无它时推理模型的 reasoning 事件被过滤
    // （tokens.reasoning>0 但事件流只有 step_start/text/step_finish 三行，
    // gpt-5.6-luna 鸡兔同笼问题对照实测）；加了才输出 reasoning 事件。
    // -f <file> 图片透传（每张一个 -f）：实测视觉模型正确识别图片内容。
    // 参数序关键：-f 必须排在 prompt 之后——opencode 的 -f 是贪婪选项，
    // `-f <file> <prompt>` 会把 prompt 也吞成第二个文件路径 → File not found:
    // <prompt 全文> → exit 1「启动失败」（带图 @luna猫 实测三组对照：-f 在前
    // exit 1 与 server 日志一字不差、prompt 在前 exit 0 正常流式且视觉识别正确）
    // prompt 以 positional message 尾部追加（run [message..]）——opencode 1.18.16
    // 的 help 没有任何 stdin 选项，stdin 方式实测空转 exit 0 无输出（luna 猫
    // 「无法启动」三层证据链根因；claude.ts 的 -p - 思维惯性不适用于 opencode）。
    // 代价：positional 受 Windows 命令行 32K 限制，prompt 超阈值截断兜底（见上）。
    const promptArg = prompt.length > PROMPT_ARG_MAX ? prompt.slice(0, PROMPT_ARG_MAX) : prompt
    if (prompt.length > PROMPT_ARG_MAX) {
      log.warn('prompt 超过命令行长度阈值，已截断', {
        promptLen: prompt.length,
        max: PROMPT_ARG_MAX,
      })
    }

    const child = spawnSupervised(
      OPENCODE_BIN,
      // options.model 优先（调用方每轮传当轮 agent 的 llmModel，socketio.ts 契约），
      // 构造 model 兜底——同一缓存实例可服务不同 model 的猫（deepseek.ts/ollama.ts 同款惯例）
      [
        'run',
        '--format',
        'json',
        '--thinking',
        '-m',
        options.model || this.model,
        promptArg,
        ...fileArgs,
      ],
      {
        label: 'opencode',
        // 不再传 input：opencode run 不消费 stdin（positional 传参）；spawnSupervised
        // 无 input 时自动 end stdin，不会挂起
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

    // spawn 失败标记（ENOENT 等：进程从未启动——resolveBin 验证过路径存在但
    // spawn 仍可能失败，如 .cmd 包装、路径被删；'error' 事件在 spawn 阶段派发）。
    // 与「正常退出无输出」区分：exitCode null 可能是成功退出的竞态窗口（见下），
    // 只有 spawn error 才是真正的「无法启动」。
    let spawnFailed = false
    let spawnError = ''

    child.on('error', (err) => {
      spawnFailed = true
      spawnError = err.message
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
      // 清理图片临时文件（成功/失败/中止都执行；rm 失败静默——os 临时目录兜底）
      if (materialized) {
        await rm(materialized.dir, { recursive: true, force: true }).catch(() => {})
      }
    }

    // 被取消时不产出后续错误信息
    if (signal?.aborted) {
      yield { content: '', done: true }
      return
    }

    // 进程非零退出或无输出 → 产出错误信息（不静默挂起）
    if (!hasOutput) {
      // 竞态修复：stdout EOF（流循环退出）时 close 事件可能尚未派发，exitCode
      // 仍是 null——真实场景成功退出（exit 0 无输出）也撞上该竞态，旧代码误报
      // 「无法启动」（server 日志 19:46:05 实证：stderr 报错先于 close 派发）。
      // 先等 close（带超时兜底防进程永挂），再读 exitCode 判定。
      if (child.exitCode === null && !spawnFailed) {
        await Promise.race([
          new Promise<void>((resolve) => child.once('close', () => resolve())),
          new Promise<void>((resolve) => setTimeout(resolve, WAIT_CLOSE_MS)),
        ])
        if (child.exitCode === null && !spawnFailed) {
          // 超时仍未 close：进程僵死（异常态）——记录日志，走空 done 不误报
          log.warn('opencode 进程未在等待窗口内退出', { waitMs: WAIT_CLOSE_MS })
        }
      }

      // 文案归位（与进程真实状态一一对应）：
      // 「无法启动」仅指 spawn 失败（进程从未启动，ENOENT 类）；
      // 「启动失败 (exit code N)」指进程启动但非零退出；
      // exit 0 无输出 = 空响应，不报错（走空 done）。
      if (spawnFailed) {
        yield {
          content: `opencode CLI 无法启动: ${spawnError}`,
          done: true,
        }
        return
      }
      if (child.exitCode !== null && child.exitCode !== 0) {
        const detail = stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ''
        yield {
          content: `opencode CLI 启动失败 (exit code ${child.exitCode})${detail}`,
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
 * 格式（run --format json --thinking，1.18.16 实测——文本在 part 嵌套，非顶层）:
 *   text:      {"type":"text","timestamp":...,"part":{"id":...,"messageID":...,"text":"..."}}
 *   reasoning: {"type":"reasoning","timestamp":...,"part":{"type":"reasoning","text":"..."}}
 *   error:     {"type":"error","error":{"data":{"message":"Upstream request failed: [403]..."}}}
 *   —— 顶层 text 仅存在于其他版本输出（兜底兼容）；error 详情在 error.data.message
 *   （嵌套两层），非 error.message；reasoning 与 text 事件同构（文本同样在
 *   part.text），仅在有 --thinking 时输出（无它时推理模型的思考被过滤）
 *
 * type === 'text' → 实时产出内容 chunk；type === 'reasoning' → 产出 [思考] 前缀
 * chunk（对齐 claude.ts/pi.ts 契约，前端折叠展示、不入库）；type === 'error' →
 * 产出错误 chunk 并终止（错误是终止性事件，后续不再有有效内容）。无法解析的行跳过。
 */
async function* parseOpencodeOutput(child: ChildProcess): AsyncIterable<Chunk> {
  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity })

  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (event.type === 'text') {
        // 1.18.16 实测文本在 event.part.text（顶层无 text 字段）——旧解析直取
        // event.text 永不命中 → 输出正常但 0 个 yield → hasOutput=false → 空 done
        // 落库（luna 猫空回复根因，店长四层二分实锤）；顶层 text 兜底兼容其他版本
        const text = event.part?.text ?? event.text
        if (typeof text === 'string' && text) {
          yield { content: text, done: false, kind: 'text' }
        }
      } else if (event.type === 'reasoning') {
        // 推理模型思考事件（--thinking 开启时输出，鸡兔同笼实测 tokens.reasoning=43
        // 且有 reasoning 事件；简单算术无思考 → 无该事件）。转 [思考] 前缀 chunk
        // 对齐 claude.ts:222 / pi.ts:155 契约（kind:'thinking' 前端折叠展示、
        // socketio.ts:2706 不落库不参与上下文）。结构同 text 事件，同样 part.text 主
        const text = event.part?.text ?? event.text
        if (typeof text === 'string' && text) {
          yield { content: `[思考] ${text}`, done: false, kind: 'thinking' }
        }
      } else if (event.type === 'error') {
        // error 详情按实测结构层级取（error.data.message 最优先，嵌套两层）：
        // {error:{data:{message}}}（1.18.16 实测）→ {error:{message}} → 顶层 {message}
        // 旧解析只取 error.message → 实测结构下取不到 → 永远 fallback「opencode 错误」
        const msg =
          event.error?.data?.message ?? event.error?.message ?? event.message ?? 'opencode 错误'
        yield { content: `[错误] ${msg}`, done: false, kind: 'text' }
        return
      }
    } catch {
      // 跳过无法解析的行
    }
  }
}
