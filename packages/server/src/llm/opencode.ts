import type { Chunk, ChatOptions, LLMMessage } from '@cat-study/shared'
import type { LLMAdapter } from './adapter.js'
import {
  resolveBin,
  messagesToPrompt,
  messagesToPromptBounded,
  attachIdleTimeout,
  spawnSupervised,
  getWorkspaceDir,
  terminateChild,
} from './cli-utils.js'
import { createLogger } from '../logger.js'
import { PLACEHOLDER_API_KEY } from '../constants.js'
import { messageOf } from '../utils.js'
import { createInterface } from 'node:readline'
import type { ChildProcess } from 'node:child_process'
import { v4 as uuid } from 'uuid'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const log = createLogger('opencode')

/** MCP server 脚本路径（workspace 上级 = 项目根 → scripts/mcp-server.mjs；
 *  与 dsh.ts MCP_SERVER_PATH 同款 cwd 假设——两边挂同一个 server，工具面通用） */
const MCP_SERVER_PATH = resolve(getWorkspaceDir(), '..', 'scripts', 'mcp-server.mjs')

interface OpencodeConfig {
  model: string
  /** DeepSeek API Key（DS_KEY 复用）；可选——非空时以 DEEPSEEK_API_KEY 注入子进程 env（deepseek provider 复用 DS_KEY），空则不注入（opencode 本地 credentials 兜底） */
  apiKey?: string
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
 * tool_use 事件 state.status → 中文标签（--agent build 模式工具循环）。
 * status 是开放 union（pending/running/completed/error 之外上游可能新增）——
 * 未知状态原样透出（不吞），无状态只产出工具名。
 */
const TOOL_STATUS_LABELS: Record<string, string> = {
  pending: '排队中',
  running: '运行中',
  completed: '完成',
  error: '失败',
}

/**
 * 生成 per-spawn 临时 opencode.jsonc（本地 MCP 挂载 catstudy，finally 清理）。
 *
 * 形态：与 dsh.ts writePatchConfig 完全同构的「每轮动态 env 适配到 opencode 静态
 * 配置」——dsh 走 --patch overlay 注入 CATSTUDY_*，opencode 走 OPENCODE_CONFIG
 * env 指向临时配置（research-2026-08-17-opencode-32k-avoidance §4 实测三假设全 ✅）。
 * 本地 MCP 官方形态：mcp.<name>.type="local" + command:[array] + environment:{}，
 * 工具命名 mcp__catstudy__*（与 claude/dsh 链一致）。
 *
 * environment 六变量（对齐 dsh writePatchConfig envLines，ADR 0008 通道准则）：
 *   五固定 + 可选 triggerAuthorName——MCP server（工具面路由）消费这些字段。
 *   ⚠️ triggerMsgId 的消费者是猫自己（提交 commit 的 catstudy [uuid]），走进程 env
 *   单字段注入（chatStream 内，见下），**不进** MCP environment（对齐 `dsh.ts` 的
 *   `writePatchConfig` 通道边界注——MCP 子进程 env ≠ agent 进程 env）。
 *
 * 配置仅走每轮临时文件，不进全局/项目静态 opencode.json（OPENCODE_CONFIG 是
 * 追加合并，不改用户本地配置）。文件名带 pid + uuid——同一进程并发多个 spawn 不冲突。
 *
 * @returns 临时配置绝对路径（调用方 finally 清理）
 */
async function writeOpencodeMcpConfig(
  context: NonNullable<ChatOptions['context']>
): Promise<string> {
  const serverUrl = `http://127.0.0.1:${process.env.PORT || '3200'}`
  const environment: Record<string, string> = {
    CATSTUDY_SERVER_URL: serverUrl,
    CATSTUDY_SIGNAL_TOKEN: context.token,
    CATSTUDY_SESSION_ID: context.sessionId,
    CATSTUDY_AGENT_ID: context.agentId,
    CATSTUDY_MSG_ID: context.msgId,
  }
  if (context.triggerAuthorName) {
    environment.CATSTUDY_TRIGGER_AUTHOR_NAME = context.triggerAuthorName
  }

  const config = {
    mcp: {
      catstudy: {
        type: 'local',
        command: ['node', MCP_SERVER_PATH],
        environment,
      },
    },
  }
  const p = join(tmpdir(), `opencode-catstudy-mcp-${process.pid}-${uuid()}.jsonc`)
  await writeFile(p, JSON.stringify(config, null, 2))
  return p
}

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
    log.warn('图片落盘失败，降级为仅文字占位', { error: messageOf(err) })
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
 * apiKey 非空时条件注入 DEEPSEEK_API_KEY（deepseek provider 复用 DS_KEY）——
 * 绕过手动 `opencode auth login` 的本地认证（历史存了占位符 `local` 导致 auth 失败），
 * 空则不注入（走 opencode 本地 credentials 兜底）。maxTokens/temperature 由 opencode
 * 本地配置控制。MCP 工具面：options.context 存在时 per-spawn 临时 opencode.jsonc
 * 挂 catstudy（对齐 dsh 侧，同一 scripts/mcp-server.mjs）→ OPENCODE_CONFIG env
 * 注入（工具面通用，取代此前的嵌句 @ 静默丢单风险）；triggerMsgId 仍单字段注入
 * 进程 env（猫提交 commit 的 catstudy [uuid] 来源）——其余 context 字段仅用于
 * MCP environment（工具面路由），不重复注入进程 env。
 *
 * 前置要求: npm i -g opencode-ai && opencode auth login
 */
export class OpencodeAdapter implements LLMAdapter {
  readonly provider = 'opencode'
  private model: string
  private apiKey: string
  private envExtra: Record<string, string>

  constructor(config: OpencodeConfig) {
    this.model = config.model
    this.apiKey = config.apiKey ?? ''
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

    const fullPrompt = messagesToPrompt(messages)
    // images（base64 dataURL）落盘为临时文件，-f 透传（实测支持视觉输入）；
    // 落盘失败降级：不传图，prompt 仍含「用户附带了 N 张图片」占位
    const materialized = await materializeImages(messages)
    const fileArgs = materialized?.fileArgs ?? []

    log.info('启动 opencode CLI', {
      model: options.model || this.model,
      promptLen: fullPrompt.length,
    })

    // run --format json 非交互流式（NDJSON 事件流）；
    // --agent build --auto：run 形态 agent 循环（店长拍板回退 serve——2026-08-13
    // 实测 7.7s 完整跑通工具循环：reasoning→text→tool_use→step_finish 多轮自动
    // 推进，tool_use 事件结构与 serve 同款 schema）。--auto = 工具全自动批准
    // （run 无 permission ruleset 注入，serve 的精细化权限是其独有优势，回退后
    // --auto 一刀切；luna 沙箱根 workspace 风险可控，后续可补自定义 agent 权限
    // 配置）。注意：-m/--thinking 与 --agent build 的组合未实测（店长实测命令
    // 未带 -m/--thinking）——真机验收确认 model 生效（见交接文档 OQ）。
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
    // 超阈值按消息粒度「保尾砍旧历史」（messagesToPromptBounded：保 system +
    // 末尾「【当前待回复】」触发消息，从最旧历史整条丢弃），不再 slice 保头砍尾
    // （会砍掉最该保留的当前任务，抵消 1cdbea9 锚定成果）
    const promptArg =
      fullPrompt.length > PROMPT_ARG_MAX
        ? messagesToPromptBounded(messages, PROMPT_ARG_MAX)
        : fullPrompt
    if (fullPrompt.length > PROMPT_ARG_MAX) {
      log.warn('prompt 超过命令行长度阈值，已按消息粒度截断（保尾砍旧历史）', {
        promptLen: fullPrompt.length,
        max: PROMPT_ARG_MAX,
      })
    }

    // 凭证条件注入（DS_KEY 复用，对齐 `dsh.ts` 的 `DEEPSEEK_API_KEY` 条件注入）：仅非空才写 `DEEPSEEK_API_KEY`，
    // 空串会覆盖 opencode 本地 credentials 兜底（有凭证的安装失效）。opencode 的
    // deepseek provider 消费 DEEPSEEK_API_KEY 且 env 优先级高于 auth.json（真机验收点）
    const env = {
      ...process.env,
      ...this.envExtra,
    } as Record<string, string>
    // 占位符守卫（72f6e3c 回归修复）：local / sk-your-api-key-here 视为「未配置真实 key」——
    // 非空就注入会把占位符当真 key 注入（flash猫 local → DEEPSEEK_API_KEY=local → auth 失败
    // 实锤）。占位符 fallback 到 .env DS_KEY（真实 key）；空串仍走「本地 credentials 兜底」不注入。
    let effectiveKey = this.apiKey
    if (effectiveKey === 'local' || effectiveKey === PLACEHOLDER_API_KEY) {
      effectiveKey = process.env.DS_KEY || ''
    }
    if (effectiveKey) {
      env.DEEPSEEK_API_KEY = effectiveKey
    }

    // 边界红线（对齐 `dsh.ts` 的同名注）：只读 context.triggerMsgId 单字段注入进程 env
    // （猫提交 commit 的 catstudy [uuid] 来源）——消费者是猫自己的 shell/工具（继承
    // opencode 进程 env），**不是** MCP server（不可写回 MCP environment，对齐 ADR
    // 0008 通道准则 / dsh OQ1 硬伤修复：MCP 子进程 env ≠ agent 进程 env）
    if (options.context?.triggerMsgId) {
      env.CATSTUDY_TRIGGER_MSG_ID = options.context.triggerMsgId
    }

    // MCP 工具面（context 存在时挂 catstudy，对齐 dsh 侧）：per-spawn 临时
    // opencode.jsonc（mcp.catstudy = local + command node scripts/mcp-server.mjs +
    // environment 当轮 CATSTUDY_* 六变量）→ OPENCODE_CONFIG env 指向临时文件。
    // 配置仅走临时文件，不进全局/项目静态 opencode.json；finally 清理（成功/异常/abort）
    let mcpConfigPath: string | null = null
    if (options.context) {
      mcpConfigPath = await writeOpencodeMcpConfig(options.context)
      env.OPENCODE_CONFIG = mcpConfigPath
      log.info('挂载 catstudy MCP 工具面', { config: mcpConfigPath })
    }

    const child = spawnSupervised(
      OPENCODE_BIN,
      // options.model 优先（调用方每轮传当轮 agent 的 llmModel，socketio.ts 契约），
      // 构造 model 兜底——同一缓存实例可服务不同 model 的猫（deepseek.ts/ollama.ts 同款惯例）
      [
        'run',
        '--agent',
        'build',
        '--auto',
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
        // per-agent 额外环境变量（如 HTTPS_PROXY）已并入上方 env；spawnSupervised
        // 内部统一为 {...process.env, ...opts.env}，此处传完整合并（含 apiKey 条件注入）
        env,
      }
    )

    // ─── Abort 处理：收到取消信号时终止子进程 ───
    // 存活判据与平台分派统一收在 `terminateChild`（cli-utils）——判据禁用 `killed`
    // （信号发出≠进程已死），win32 走 `taskkill /T` 树杀（信号杀不到 supervisor 底下
    // 的真 CLI）。详见该函数注释。
    const onAbort = () =>
      terminateChild(child, { label: `opencode(${options.model || this.model})` })
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
      // 清理 MCP 临时配置（成功/异常/abort 三路都执行；对齐 dsh patch finally 清理）
      if (mcpConfigPath) {
        await rm(mcpConfigPath, { force: true }).catch(() => {})
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
 *   tool_use:  {"type":"tool_use","timestamp":...,"part":{"type":"tool","tool":"bash","state":{"status":"completed","input":{...},"output":"..."}}}
 *   error:     {"type":"error","error":{"data":{"message":"Upstream request failed: [403]..."}}}
 *   —— 顶层 text 仅存在于其他版本输出（兜底兼容）；error 详情在 error.data.message
 *   （嵌套两层），非 error.message；reasoning 与 text 事件同构（文本同样在
 *   part.text），仅在有 --thinking 时输出（无它时推理模型的思考被过滤）；
 *   tool_use 仅 --agent 模式输出，part 结构与 serve 适配器工具事件映射同款
 *   schema（店长实测报告 + opencode.db 落盘样本 + 上游 schema 三源一致）
 *
 * type === 'text' → 实时产出内容 chunk；type === 'reasoning' → 产出纯思考文本
 * chunk（kind:'thinking' 前端折叠展示、不入库）；type === 'tool_use' →
 * 产出独立 kind:'tool' chunk（结构化 tool 元数据：id/name/status/input/output，
 * 状态标签见 TOOL_STATUS_LABELS）——reply 分流：io 落 messages.tool_content 可查，
 * 不再降维 [工具] thinking 混进思考块；type === 'error' → 产出错误 chunk 并终止
 * （错误是终止性事件，后续不再有有效内容）。无法解析的行跳过。
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
        // 且有 reasoning 事件；简单算术无思考 → 无该事件）。纯思考文本无 [思考] 前缀
        // ——结构分离后 kind 字段即结构信号（store 直接累积 segments 分段、前端按 kind
        // 渲染折叠块，不再依赖文本标记回推）。结构同 text 事件，同样 part.text 主
        const text = event.part?.text ?? event.text
        if (typeof text === 'string' && text) {
          yield { content: text, done: false, kind: 'thinking' }
        }
      } else if (event.type === 'tool_use') {
        // 工具调用事件（--agent build 模式）。语义拆分后映射独立 kind:'tool' chunk：
        // 实时观感反馈（长思考期间用户看到工具推进而非死寂）；tool 元数据
        // （id/name/status/input/output）随 chunk 携带——reply 分流：input/output
        // 落 messages.tool_content（结构化 JSON，可查「这单跑了哪个工具/结果」），
        // 正文/思考/工具三通道彻底分离（不再降维成 [工具] thinking 混进思考块）。
        // 同一次调用的多状态推进（running→completed）以 callID 关联——reply 落库
        // 按 id 合并成单条工具记录。input/output 原样带出（落库前 reply 统一截断防
        // 爆存储）。input 落日志审计（与 serve 适配器同款：tool/status/input 三字段，
        // 序列化截断防大对象刷屏）。结构防御：part.tool 非字符串直接跳过（开放
        // union，未来新增 part 变体不炸解析）。
        const part = event.part
        if (typeof part?.tool === 'string') {
          const status = part.state?.status
          const label = status != null ? (TOOL_STATUS_LABELS[status] ?? String(status)) : ''
          const input = part.state?.input
          const output = part.state?.output
          log.info('opencode 工具调用', {
            tool: part.tool,
            status,
            input: input !== undefined ? JSON.stringify(input).slice(0, 500) : undefined,
          })
          yield {
            content: `${part.tool}${label ? `: ${label}` : ''}`,
            done: false,
            kind: 'tool',
            tool: {
              // part.id 是事件/part id（同调用多状态快照共用同一 id），callID 是调用 id——
              // 取 callID 作合并键（无 callID 退化 part.id，仍可归并同 id 快照）
              id: typeof part.callID === 'string' ? part.callID : part.id,
              name: part.tool,
              status,
              input,
              output,
              isError: status === 'error',
            },
          }
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
