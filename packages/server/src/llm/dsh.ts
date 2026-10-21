import type { Chunk, ChatOptions, LLMMessage } from '@cat-study/shared'
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
 * 通过 spawn node dsh-entry 子进程（`--profile headless` + 题面走 stdin 的一次性形态）→
 * 收集 stdout → 输出最终答案 Chunk。与 claude.ts 同为 CLI 子进程形态，复用 cli-utils 公共设施
 * （resolveJsEntry / messagesToPrompt / spawnSupervised；不挂 idle timeout——
 * headless 全程无输出，idle 语义不适用，见 chatStream 内运行时长遥测注释）。
 *
 * 纯 JS CLI 用 `node <entry>` 执行（spawn(process.execPath, [DSH_ENTRY, ...])）——
 * 避免 .cmd 包装（resolveBin 在 win32 落 .cmd，supervisor spawn('.cmd', shell:false) 在
 * Node 24 同步 EINVAL，bde908e ❌ 审查阻塞项；node.exe 是原生 exe 无此问题）。
 *
 * 形态差异（headless 无流式）：整轮 agent 循环完成后一次性打印最终答案到 stdout
 * （exit 0 = completed，stderr 可能带 `dsh: reasoning:` 推理增量；非 0 退出 stderr
 * 带错误码+消息）。所以本适配器
 * 不解析事件流——收集全量 stdout，close 后按 exit code 判定产出。长思考/工具循环期间
 * 用户看到静默（headless 形态固有，无中间事件可转发），与 opencode run 的实时工具
 * 事件不同——这是形态取舍，OQ 记录。
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
    // 参数面只留 flags（--profile / --patch）；题面经 spawnSupervised 的 input 写 stdin。
    let patchPath: string | null = null
    const args = ['--profile', 'headless']
    if (options.context) {
      patchPath = writePatchConfig(options.context, model)
      args.push('--patch', patchPath)
    }

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

    // ─── 运行时长遥测（P0）：dsh headless 一次性形态，适配器运行期间不转发任何中间
    // 事件（0.2.1 的推理增量虽写 stderr，也只在 close 后整体消费）、close 前无任何
    // 周期信号——30s 周期日志让 server 日志/execution_logs 能看到「dsh 跑到第几秒了」
    // （与前端「回复中 · 已 N 秒」互补：一个子进程存活遥测，一个回复状态计时）。
    // ⚠️ 不挂 idle timeout（P1）：dsh 无「idle」概念——headless 全程无输出，
    // 「按输出重置 timer」的 bump 永不触发 → idle timeout 退化为 wall-clock 强杀
    // （20min 必杀，曾 SIGTERM 在 commit 前）；wall-clock 上限由 dispatch 层已有
    // 30min hard timeout（AbortSignal → 上方 onAbort kill 子进程）兜底，不新增超时层。
    const PROGRESS_INTERVAL_MS = 30_000
    const startedAt = Date.now()
    const elapsedSec = () => Math.floor((Date.now() - startedAt) / 1000)
    const progressTimer = setInterval(() => {
      log.info('dsh 运行中', { elapsedSec: elapsedSec() })
    }, PROGRESS_INTERVAL_MS)

    // headless 一次性输出：收集全量 stdout（最终答案）与 stderr（推理增量 / 错误诊断）
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

    // stderr 分流：exit code 是唯一权威判据。
    // - cli-supervisor 每次启动都会往 stderr 写 `[supervisor] pid=…`，且与 CLI 共用同一
    //   管道；0.2.1 起推理增量（`dsh: reasoning:`）也写 stderr——按内容前缀做行级过滤
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

    // 等 close（进程退出后派发；spawn error 也会触发 close）——先等再判 exitCode，
    // 免 stdout EOF/close 竞态（opencode WAIT_CLOSE_MS 处理的是先查后等，这里先等）
    const exitCode = await new Promise<number | null>((res) => {
      child.once('close', (code) => res(code))
    })

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
      const detailText = stripSupervisorLines()
      const detail = detailText ? `: ${detailText.slice(0, 300)}` : ''
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
