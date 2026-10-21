import type { Chunk, ChatOptions, LLMMessage, ToolCallInfo } from '@cat-study/shared'
import type { LLMAdapter } from './adapter.js'
import {
  resolveJsEntry,
  messagesToPrompt,
  spawnSupervised,
  getWorkspaceDir,
  terminateChild,
} from './cli-utils.js'
import { createLogger } from '../logger.js'
import { PLACEHOLDER_API_KEY } from '../constants.js'
import { randomBytes } from 'node:crypto'
import { writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'

/**
 * `--json` 事件的最小形状（防御式解析：上游字段缺失/类型漂移时不炸，未知 type 忽略）。
 * 只声明本适配器消费的字段；其余原样忽略。
 */
interface DshEvent {
  type?: unknown
  text?: unknown
  callId?: unknown
  tool?: unknown
  input?: unknown
  result?: unknown
  status?: unknown
  isError?: unknown
  truncated?: unknown
  message?: unknown
  phase?: unknown
  reason?: { kind?: unknown; message?: unknown; error?: unknown }
}

const log = createLogger('dsh')

interface DshConfig {
  /** DeepSeek API Key（DS_KEY 复用）；可选——缺失时不注入 DEEPSEEK_API_KEY，dsh 走 credentials 落盘兜底 */
  apiKey?: string
  model: string
  /** 额外环境变量（per-agent 配置；registry 已宽容解析，此处收对象） */
  envExtra?: Record<string, string>
}

/** dsh CLI JS 入口路径（模块加载时解析；纯 JS 包用 node <entry> 执行，avoid .cmd wrappers） */
let DSH_ENTRY: string
try {
  DSH_ENTRY = resolveJsEntry('@deepseek-ai/dsh', 'dsh')
} catch (err: any) {
  log.warn('dsh CLI 未安装', { error: err.message })
  DSH_ENTRY = ''
}

/** MCP server 脚本路径（workspace 上级 = 项目根 → scripts/mcp-server.mjs；
 *  与 cli-utils getWorkspaceDir 同款 cwd 假设） */
const MCP_SERVER_PATH = resolve(getWorkspaceDir(), '..', 'scripts', 'mcp-server.mjs')

/** YAML 单引号标量：单引号翻倍转义（YAML 语义），路径反斜杠在单引号内保持字面量 */
function yamlScalar(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * 生成 per-spawn 临时 cordis.patch.yml（--patch overlay，finally 清理）。
 *
 * ⚠️ 版本 pinned：@deepseek-ai/dsh 锁 0.2.1-rc.2（升级前已逐项对账，见下）。
 *   本文件**关键**硬编码契约（**非穷尽**）——patch row id（agent-default-model /
 *   mcp-catstudy）、DSH_PERMISSION_MODE=danger-full-access seam、provider: deepseek-official
 *   ——均为针对 rc.2 实证的形态；再升版本前先对账这几处再动，避免静默背刺。
 *   另有散落同文件的契约未在此穷尽：mcp-client 插件名
 *   `@deepseek-ai/dsh-mcp-client`（writePatchConfig 内）、`--profile headless` profile 名
 *   （chatStream 内）、bin 名 `resolveJsEntry('@deepseek-ai/dsh', 'dsh')`（模块顶部）、
 *   headless 的 stdin 任务输入契约（无 positional 或传 `-` 时读 stdin 到 EOF；
 *   空白 positional 仍报错）——升版本时须一并核对，避免「对完此列表就安全」的虚假信心。
 *
 * 内容两行：
 *  1. mcp-catstudy（@deepseek-ai/dsh-mcp-client）——`insert` 新增 loader entry
 *     （不在 headless profile 底座里，insert 语义正确）；serverName catstudy + stdio
 *     spawn node scripts/mcp-server.mjs；env 以**字面量内联**（非 !!js 引用）——
 *     guaranteed 路径：不依赖 dsh 的 !!js env 求值（店长派活单红项，post-install 实测
 *     通过后可简化为静态 patch + !!js process.env.X）。工具面 mcp__catstudy__* 与
 *     claude 链逐字一致（官方文档实证：mcp__<serverName>__<rawName>）。
 *  2. agent-default-model——覆盖当轮 llmModel；裸 `- id:` 行写（**非 insert**）——
 *     agent-default-model 已在 headless profile 底座挂载（dsh-base/cordis.patch.yml，
 *     所有 profile 公共底座），insert 会因 duplicate loader entry id 炸（实机复现：
 *     `duplicate loader entry id: agent-default-model`）；改已有 row 用裸 id 行写、
 *     按 id 寻址最后写胜（dsh-base 注释实证）。patch config 整块替换非合并，且
 *     dsh-agent-default-model Config schema 中 provider/model 均必填
 *     （z.string().required()）——缺 provider 会 Zod 校验失败，故连
 *     provider: deepseek-official 一起写（消费 DEEPSEEK_API_KEY 继承 env，与凭证注入一致）。
 *
 * approval 不再走 patch 行写——由 chatStream 注入 DSH_PERMISSION_MODE=danger-full-access
 * 官方 seam（base config 同时读它设 sandbox-policy.mode 与 approval.policy，一次到位）；
 * 单独设 policy: never 会触发 permission-presets 校验（(workspace-write,never) 不匹配
 * 三预设 → `composed sandbox and approval defaults match no preset`）。
 *
 * env 值来自 options.context（CATSTUDY_* 五元组 + 可选 triggerAuthorName），
 * MCP server 子进程继承；文件名带 pid + 随机后缀——同一进程并发多个 spawn 不冲突。
 *
 * ⚠️ 通道边界：triggerMsgId 的消费者是**猫自己**（提交 commit 的 catstudy [uuid]），
 * 走 dsh CLI 进程 env（chatStream 内注入，见下），**不进** MCP server env——MCP server
 * 是工具面路由，不消费该变量，写进 patch env 猫的 shell 读不到（根因：OQ1 硬伤修复）。
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
- id: agent-default-model
  config:
    provider: deepseek-official
    model: ${yamlScalar(model)}
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
 * 通过 spawn node dsh-entry 子进程（`--profile headless --json` + 题面走 stdin）→
 * 逐行解析 stdout NDJSON 事件 → 边到边 yield Chunk（thinking / text / tool 三通道）。
 * 与 claude.ts 同为 CLI 子进程形态，复用 cli-utils 公共设施（resolveJsEntry /
 * messagesToPrompt / spawnSupervised；不挂 idle timeout——idle 语义不适用，
 * wall-clock 由 dispatch 层 30min hard timeout 兜底，见 chatStream 内遥测注释）。
 *
 * 纯 JS CLI 用 `node <entry>` 执行（spawn(process.execPath, [DSH_ENTRY, ...])）——
 * 避免 .cmd 包装（resolveBin 在 win32 落 .cmd，supervisor spawn('.cmd', shell:false) 在
 * Node 24 同步 EINVAL，bde908e ❌ 审查阻塞项；node.exe 是原生 exe 无此问题）。
 *
 * `--json` 事件契约（0.2.1-rc.2 实证，实包源码 + 真机双证）：
 *  - `thinking` / `text`：逐条产出。`thinking` 可能是空串（跳过空串）。
 *  - `tool_call`：`{ callId, tool, input }` → 产出 running chunk，并建 callId→tool 映射。
 *  - `tool_result`：只带 `callId`（**不带工具名**）→ 按映射补名，缺失退化 'unknown'；
 *    `status=error`/`isError` → status='error'。
 *  - `final`：**不是全文**，是最后一条非空 text 的复述（源码 summarize()）——
 *    已产出的文本以它结尾时不重复补，否则补一条 text（防未来只有 final 的形态）。
 *  - `status` / `session` / 未知 type：不产出；`turn_end.reason.kind='error'` 存为诊断兜底。
 *  - 运行期错误没有 `error` 事件（`error` 只由 CLI 用法错误产生）——运行失败走
 *    `turn_end.reason` + stderr + exit code。
 *  - 每条字符串 8KB 截断并标 `truncated:true`（`final` 豁免）；事件行上限 32KB。
 *  - `--json` 与 stderr 推理流互斥（源码 projection 分支）：exit 0 的 stderr 只剩
 *    `[supervisor]` 行，故 exit 0 一律降 debug 的既有分流继续成立。
 *  - ⚠️ **位置红线**：`--json` 必须排在 `--patch` 之后。实测
 *    `--profile headless --json --patch X` 会把 patch 当 app 参数 →
 *    `unknown option '--patch'`，工具面整块消失。正确顺序：
 *    `--profile headless [--patch <path>] --json`。
 *
 * 凭证：dsh 解析顺序为 继承 env → $DSH_HOME/.credentials.yaml → 调用目录 .env →
 * $DSH_HOME/.env；本适配器把 apiKey（DS_KEY 复用）以 DEEPSEEK_API_KEY 注入 spawn env
 * （继承 env 优先级最高，覆盖 credentials 落盘——不落盘任何密钥）。apiKey 为空时**不注入**
 * （条件注入）——空串会覆盖 dsh credentials 落盘兜底，让有凭证的安装失效。
 *
 * 前置要求: npm i -g @deepseek-ai/dsh@0.2.1-rc.2
 */
export class DshAdapter implements LLMAdapter {
  readonly provider = 'dsh'
  private apiKey: string
  private model: string
  private envExtra: Record<string, string>

  constructor(config: DshConfig) {
    this.apiKey = config.apiKey ?? ''
    this.model = config.model
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

    if (!DSH_ENTRY) {
      yield {
        content: 'dsh CLI 未安装。请先运行: npm i -g @deepseek-ai/dsh@0.2.1-rc.2',
        done: true,
      }
      return
    }

    // 题面全量走 stdin（与 claude.ts 同构）：headless 无 positional 时读 stdin 到 EOF，
    // 不再受 Windows CreateProcess 32K 命令行限制，也不再需要按消息粒度截断。
    // 静态守卫见 dsh.test.ts A8：本文件不得再引用按长度截断的 helper。
    const fullPrompt = messagesToPrompt(messages)

    const model = options.model || this.model

    // MCP 结构化路由（context 存在时挂工具面）：per-spawn 临时 patch overlay。
    // 参数面只留 flags（--profile / --patch / --json）；题面经 spawnSupervised 的 input 写 stdin。
    // ⚠️ `--json` 必须最后：放 `--patch` 之前会让 patch 被当成 app 参数
    // （unknown option '--patch'，工具面整块消失——实机撞过，勿调序）。
    let patchPath: string | null = null
    const args = ['--profile', 'headless']
    if (options.context) {
      patchPath = writePatchConfig(options.context, model)
      args.push('--patch', patchPath)
    }
    args.push('--json')

    log.info('启动 dsh CLI', { model, promptLen: fullPrompt.length })

    const env = {
      ...process.env,
      ...this.envExtra,
    } as Record<string, string>
    // 凭证条件注入（DS_KEY 复用）：仅非空才写 DEEPSEEK_API_KEY（dsh 继承 env 优先级最高），
    // 避免空串覆盖 dsh credentials 落盘兜底（有凭证的安装因空注入失效）。
    // 占位符守卫（对齐 opencode，72f6e3c 同族回归）：local / sk-your-api-key-here 视为
    // 「未配置真实 key」，fallback 到 .env DS_KEY（真实 key）；空串仍走 credentials 兜底不注入。
    let effectiveKey = this.apiKey
    if (effectiveKey === 'local' || effectiveKey === PLACEHOLDER_API_KEY) {
      effectiveKey = process.env.DS_KEY || ''
    }
    if (effectiveKey) {
      env.DEEPSEEK_API_KEY = effectiveKey
    }
    // 官方 seam：headless 形态需要确定性放行（ask 会 fail-closed 全拒工具）。
    // base config 同时读它设 sandbox-policy.mode 与 approval.policy——一次到位，
    // 不再在 patch 里写 approval row（单独 policy: never 会触发 permission-presets
    // 校验）。放在 envExtra spread 之后 = 适配器钉死，不开放 per-agent 覆盖。
    env.DSH_PERMISSION_MODE = 'danger-full-access'
    // 边界红线（对齐 opencode/claude）：只读 context.triggerMsgId 单字段注入进程 env
    // （猫提交 commit 的 catstudy [uuid] 来源）。消费者是猫自己的 shell/sandbox 工具
    // （继承 dsh CLI 进程 env），**不是** MCP server——不可写回 patch env（OQ1 硬伤修复）
    if (options.context?.triggerMsgId) {
      env.CATSTUDY_TRIGGER_MSG_ID = options.context.triggerMsgId
    }

    // spawn node <DSH_ENTRY>：纯 JS CLI 用 node.exe 执行（避免 .cmd 包装 EINVAL，
    // CLAUDE.md「Spawn: node path/to/cli.mjs」约定）——supervisor command=node.exe 原生 exe
    const child = spawnSupervised(process.execPath, [DSH_ENTRY, ...args], {
      env,
      label: 'dsh',
      // cwd 透传会话 worktree 路径（会话隔离）——缺省默认 workspace（存量行为零变化）
      cwd: options.cwd ?? getWorkspaceDir(),
      // 题面唯一传输通道：cli-utils 写 stdin + end()，supervisor 透传给 CLI 子进程
      input: fullPrompt,
    })

    // stdin 写入守卫（P2）：spawnSupervised 在返回前同步 write(input) + end()，但
    // 错误是异步派发的。CLI 在消费完 stdin 前早退（patch 读不到 / profile 名漂移 /
    // 启动即报错）时，pending write 会以 EOF/EPIPE 触发 child.stdin 的 'error'；本进程
    // 无 uncaughtException 兜底，无监听即**整个 server 退出**。此处立即挂监听兜住
    // （write 已同步完成、错误异步到达，故返回后挂仍能捕获）。
    // 不改变主判定：退出码仍是权威，stdin 错误只记 debug。
    // TODO(另票): 守卫应下沉到 spawnSupervised + cli-supervisor.mjs（claude/openai 同族）。
    child.stdin?.on('error', (err: NodeJS.ErrnoException) => {
      log.debug('dsh stdin 写入失败', { code: err.code ?? 'unknown', error: err.message })
    })

    // ─── Abort 处理：收到取消信号时终止子进程 ───
    // 存活判据与平台分派统一收在 `terminateChild`（cli-utils）——判据禁用 `killed`
    // （信号发出≠进程已死），win32 走 `taskkill /T` 树杀（信号杀不到 supervisor 底下
    // 的真 CLI）。详见该函数注释。
    const onAbort = () => terminateChild(child, { label: `dsh(${model})` })
    signal?.addEventListener('abort', onAbort)

    // ─── 运行时长遥测：事件虽已边到边上屏，但长思考/长工具调用期间可能长时间没有
    // 任何事件；30s 周期日志让 server 日志/execution_logs 能看到「dsh 跑到第几秒了」
    // （与前端「回复中 · 已 N 秒」互补：一个子进程存活遥测，一个回复状态计时）。
    // ⚠️ 不挂 idle timeout（P1）：本单只改 stdout 形态、不改超时策略——wall-clock
    // 上限由 dispatch 层已有 30min hard timeout（AbortSignal → 上方 onAbort kill
    // 子进程）兜底。事件流让「按输出重置 timer」技术上可行，但属另一张票，不在本单扩。
    const PROGRESS_INTERVAL_MS = 30_000
    const startedAt = Date.now()
    const elapsedSec = () => Math.floor((Date.now() - startedAt) / 1000)
    const progressTimer = setInterval(() => {
      log.info('dsh 运行中', { elapsedSec: elapsedSec() })
    }, PROGRESS_INTERVAL_MS)

    // stderr 只收诊断（`[supervisor]` 管道行 / 错误）；stdout 走下方 readline 事件流。
    let stderr = ''
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

    // stderr 分流：exit code 是唯一权威判据。
    // - cli-supervisor 每次启动都会往 stderr 写 `[supervisor] pid=…`，且与 CLI 共用同一
    //   管道；`--json` 模式下推理流与事件流互斥，但管道噪声仍在——按内容前缀做行级过滤
    //   必然漏，故 exit 0 不按内容判定，**全量降 debug**（字节数 + 截断 head）。
    // - exit != 0 时先剥掉 `[supervisor]` 开头的启动行，再取真实错误作 detail，避免
    //   管道噪声把诊断挤出截断窗口。
    const stripSupervisorLines = () =>
      stderr
        .split(/\r?\n/)
        .filter((line) => !line.trimStart().startsWith('[supervisor]'))
        .join('\n')
        .trim()
    child.on('close', (code) => {
      if (code !== 0 && code !== null) {
        const detail = stripSupervisorLines()
        log.error('dsh 退出', { exitCode: code, stderr: detail.slice(0, 500) })
      } else if (stderr) {
        log.debug('dsh stderr (exit 0)', {
          bytes: Buffer.byteLength(stderr),
          head: stderr.slice(0, 500),
        })
      }
    })

    // close promise 在迭代 stdout 之前注册：readline 可能先于 close 结束（正常时序），
    // 晚注册会漏掉已派发的 close 事件而永久挂起。
    const exitCodePromise = new Promise<number | null>((res) => {
      child.once('close', (code) => res(code))
    })

    // ─── stdout NDJSON 事件流：逐行解析、边到边 yield ───
    // 事件映射见类头注释。诊断兜底三源（优先级）：剥 supervisor 的 stderr >
    // turn_end.reason 错误 > CLI 用法错误事件 message。
    const pendingTools = new Map<string, string>() // callId → 工具名（tool_result 不带名）
    let allText = '' // 已产出的 text 累积（final 去重判据）
    let finalText = ''
    let turnEndError = ''
    let errorEventMessage = ''
    let parsedEvents = 0
    let invalidLines = 0
    const rawLines: string[] = [] // 非 JSON 行（格式漂移时的纯文本兜底）
    if (child.stdout) {
      const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
      try {
        for await (const line of rl) {
          const trimmed = line.trim()
          if (!trimmed) continue
          let event: DshEvent
          try {
            event = JSON.parse(trimmed) as DshEvent
          } catch {
            invalidLines++
            rawLines.push(trimmed)
            continue
          }
          parsedEvents++
          const type = typeof event.type === 'string' ? event.type : ''

          if (type === 'thinking') {
            const text = typeof event.text === 'string' ? event.text : ''
            if (!text) continue // 第二步可能是空串（实证）
            if (event.truncated === true) {
              log.debug('dsh thinking 事件被截断', { bytes: Buffer.byteLength(text) })
            }
            yield { content: text, done: false, kind: 'thinking' }
            continue
          }

          if (type === 'text') {
            const text = typeof event.text === 'string' ? event.text : ''
            if (!text) continue
            if (event.truncated === true) {
              log.debug('dsh text 事件被截断', { bytes: Buffer.byteLength(text) })
            }
            allText += text
            yield { content: text, done: false, kind: 'text' }
            continue
          }

          if (type === 'tool_call') {
            const id = typeof event.callId === 'string' ? event.callId : undefined
            const name = typeof event.tool === 'string' && event.tool ? event.tool : 'unknown'
            if (id) pendingTools.set(id, name)
            yield {
              content: name,
              done: false,
              kind: 'tool',
              tool: { id, name, status: 'running', input: event.input },
            }
            continue
          }

          if (type === 'tool_result') {
            const id = typeof event.callId === 'string' ? event.callId : undefined
            // tool_result 不带工具名——按 callId 从 tool_call 建映射补；缺失退化 unknown
            const name = (id && pendingTools.get(id)) || 'unknown'
            if (id) pendingTools.delete(id)
            const isError = event.status === 'error' || event.isError === true
            const tool: ToolCallInfo = {
              id,
              name,
              status: isError ? 'error' : 'completed',
              output: event.result,
              isError,
            }
            if (event.truncated === true) tool.truncated = true
            yield { content: name, done: false, kind: 'tool', tool }
            continue
          }

          if (type === 'final') {
            // final 是「最后一条非空 text」的复述，不是全文——收下，流结束后判重再补
            finalText = typeof event.text === 'string' ? event.text : ''
            continue
          }

          if (type === 'error') {
            // 仅 CLI 用法错误（运行期失败没有 error 事件）
            errorEventMessage = typeof event.message === 'string' ? event.message : ''
            continue
          }

          if (type === 'status') {
            const reason = event.reason
            if (event.phase === 'turn_end' && reason?.kind === 'error') {
              turnEndError =
                typeof reason.message === 'string'
                  ? reason.message
                  : typeof reason.error === 'string'
                    ? reason.error
                    : JSON.stringify(reason)
            }
            continue
          }
          // session / 未知 type：不产出（格式漂移由「零合法事件 + 纯文本兜底」兜底）
        }
      } catch (err: any) {
        // stdout 流错误不得崩掉整轮：落错误日志，交给 exit code 判定
        log.error('dsh stdout 读取失败', { error: err.message })
      }
    }

    // 等 close（进程退出后派发；spawn error 也会触发 close）——先等再判 exitCode，
    // 免 stdout EOF/close 竞态（opencode WAIT_CLOSE_MS 处理的是先查后等，这里先等）
    const exitCode = await exitCodePromise

    signal?.removeEventListener('abort', onAbort)
    // 三路径（正常 close / abort / spawn-error）都汇到此处统一清理，不留泄漏 timer
    clearInterval(progressTimer)
    log.info('dsh 完成', { totalSec: elapsedSec(), exitCode })
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
    // 「启动失败 (exit code N)」指进程启动但非零退出；
    // exit 0 = completed：事件已边到边产出，此处只做 final 去重 / 纯文本兜底，空则空响应。
    if (spawnFailed) {
      yield {
        content: `dsh CLI 无法启动: ${spawnError}`,
        done: true,
      }
      return
    }
    if (exitCode !== null && exitCode !== 0) {
      // 诊断兜底优先级：剥 supervisor 的 stderr > turn_end 错误 > CLI 用法错误事件
      const detailText = stripSupervisorLines() || turnEndError || errorEventMessage
      const detail = detailText ? `: ${detailText.slice(0, 300)}` : ''
      yield {
        content: `dsh CLI 启动失败 (exit code ${exitCode})${detail}`,
        done: true,
      }
      return
    }
    if (invalidLines > 0) {
      log.debug('dsh stdout 含无法解析的行', { lines: invalidLines })
    }
    if (parsedEvents === 0 && rawLines.length > 0) {
      // 格式漂移防护：exit 0 却一条合法事件都没解析到 → 不静默空回复，按纯文本兜底
      log.warn('dsh stdout 不是可解析的事件流，按纯文本兜底', {
        lines: rawLines.length,
        head: rawLines.join('\n').slice(0, 500),
      })
      const raw = rawLines.join('\n').trim()
      if (raw) yield { content: raw, done: false, kind: 'text' }
    } else if (finalText.trimEnd() && !allText.trimEnd().endsWith(finalText.trimEnd())) {
      // final 未被前面 text 事件覆盖时才补——实测 final 常与最后一条 text 重复
      yield { content: finalText, done: false, kind: 'text' }
    }
    yield { content: '', done: true }
  }
}
