/**
 * Execution — `ExecTrace`（P2 / R2 段五：一次执行的段分解时间轴采集器）。
 *
 * 要回答什么：诉求③「哪里耗时最长」。今天的两端是 `execution_logs`（一次执行一个
 * 总时长，秒级）与 `retrieval_events`（一次检索，毫秒级）——**中间十级全不存在**。
 *
 * ## 三条形态契约（R2 §4.7，逐条有据）
 *
 * 1. **per-execution，绝不挂 `EngineState`。** `EngineState` 是**引擎级单例**，而并发
 *    批内 **3 个执行体同时跑**（`CONCURRENT_AGENTS_PER_MESSAGE = 3`）——挂上去就是三个
 *    执行互相写对方的 span。故本模块**无模块级可变状态**：一个 `createExecTrace()`
 *    返回一个闭包实例，由 `executeOneAgent` 创建、经一个参数传进 `runAgentReply`。
 * 2. **内存累积，不逐段落库。** span 攒在 `spans` 数组里，`finish()` 时一次事务落两表
 *    （R2 §七 硬点 2）。代价如实声明：**进程级崩溃时该执行的 span 全丢**；30min 硬超时 /
 *    20min CLI 空闲超时 / 35min token 超时**都走失败漏斗进 `finalizeRun`，不丢**。
 *    不为崩溃可见性牺牲关键路径延迟（逐段落盘 = 拿关键路径延迟换）。
 * 3. **字段自持。** `chainId` / `executionId` / `sessionId` / `agentId` 在创建时取一次并
 *    冻结，段内不回头读全局。
 *
 * ## 时刻口径
 *
 * 一律 `Date.now()`（墙钟毫秒）。**不用 `performance.now()`**——它是「进程启动以来的
 * 毫秒数、不是 epoch」，重启归零、跨进程不可比，`idx_spans_start` 的时间窗查询会直接
 * 废掉。（实测该 idiom 在本仓非测试代码零命中。）`start_at` 落库时转 ISO 8601 毫秒 UTC。
 */
import { randomBytes } from 'node:crypto'
import { classifyError } from '../eval/classify-error.js'
import { spans as spansRepo, type LlmSpanDetail, type SpanInput } from '../db/repository/index.js'

/**
 * 段名**闭集**（R2 §五）——实施时不得自由增名。新增段名 = 改设计票 + 补验收。
 *
 * `tool.execute` / `dispatch.a2a` 是 §五 明写 **v1 不做** 的两段（前者要给
 * `shared` 的 `ToolCallInfo` 加时间字段并动各适配器，后者要穿线 A2A 子树上下文），
 * 不在本集合内 —— 本集合就是「v1 实际会打出来的段」的穷举。
 */
export const SPAN_NAMES = [
  'invoke_agent',
  'dispatch.queue_wait',
  'dispatch.token_wait',
  'context.assemble',
  'context.compress',
  'memory.retrieval',
  'knowledge.retrieval',
  'llm.chat',
  'diff.collect',
  'reply.persist',
  'git.auto_commit',
] as const

export type SpanName = (typeof SPAN_NAMES)[number]

/**
 * `gen_ai.operation.name` 字面量。**NULL = 规范无此概念**（自定义段）。
 *
 * 三个 NULL 段里有两个是 wait 段——FIFO 槽位排队在 OTel 里没有对应概念
 * （`gen_ai.response.status='queued'` 指的是 **provider 侧**排队，不是本仓的槽位队列）。
 * **把「有无标准键」做成一个列值，而不是表结构差异。**
 */
const OPERATION_NAMES: Record<SpanName, string | null> = {
  invoke_agent: 'invoke_agent',
  'dispatch.queue_wait': null,
  'dispatch.token_wait': null,
  'context.assemble': null,
  'context.compress': null,
  'memory.retrieval': 'retrieval',
  'knowledge.retrieval': 'retrieval',
  'llm.chat': 'chat',
  'diff.collect': null,
  'reply.persist': null,
  'git.auto_commit': null,
}

export type SpanStatus = 'ok' | 'error' | 'timeout' | 'skipped'

/** `error_message` 落库截断上限（字符）——只防爆存储，段名/状态恒全量可查 */
const MAX_ERROR_MESSAGE_CHARS = 1000

/** `llm.chat` 详情列的种子（`provider` / `model` / `max_tokens` 是**快照**） */
export interface LlmSpanSeed {
  provider: string
  model: string
  maxTokens: number | null
  stream: boolean
}

/** 内存态的段记录（`startMs` 是墙钟毫秒，落库时才转 ISO） */
export interface SpanRecord {
  spanId: string
  parentSpanId: string | null
  name: SpanName
  operationName: string | null
  startMs: number
  durationMs: number
  status: SpanStatus
  errorType: string | null
  errorMessage: string | null
  itemCount: number | null
  llm: (LlmSpanDetail & { firstChunkMs: number | null }) | null
}

/** 段句柄——埋点处只拿得到它，内部记录不外露 */
export interface SpanHandle {
  readonly spanId: string
  readonly name: SpanName
  /**
   * **即时打点**：首个 chunk 到达时刻。
   *
   * 必须在 `for await` 循环内首个 chunk 处调用——这是 `ttft_ms` 唯一可能的采集点
   * （规范键 `gen_ai.response.time_to_first_chunk`）。等整段结束再记就只剩总时长。
   * 重复调用只认第一次。
   */
  markFirstChunk(): void
  /** 即时打点：产出计数（也可在 `endSpan` 的 `itemCount` 里补） */
  setItemCount(n: number | null): void
}

export interface StartSpanOpts {
  /**
   * 显式起点（墙钟毫秒）。**重放式打点**用——`dispatch.queue_wait` 的时刻在
   * `slot.queue.push(cmd)` 当场就打了，进入执行体时只剩「补记」。
   */
  startMs?: number
  /** 覆盖 `gen_ai.operation.name`（缺省按闭集查表） */
  operationName?: string | null
  /** 仅 `llm.chat`：详情列种子 */
  llm?: LlmSpanSeed
}

export interface EndSpanOpts {
  /** 抛出物（自动取 message）；与 `errorMessage` 二选一 */
  error?: unknown
  errorMessage?: string
  /** 产出计数（`context.assemble` 的条数 / `knowledge.retrieval` 的命中数…） */
  itemCount?: number | null
  /** 显式终点（缺省 `Date.now()`） */
  endMs?: number
  /**
   * 仅 `llm.chat`：token 用量。本仓适配器**不回流 usage**（`Chunk` 无该字段，R2 §八
   * 明写不改 `shared` 类型），故这是与 `execution_logs.prompt_tokens / completion_tokens`
   * **同一表达式**的估算值——两处口径一致，不制造第二个数字。
   */
  llmUsage?: { inputTokens: number | null; outputTokens: number | null }
}

export interface RecordSpanOpts {
  /** 起点（必填——事后补记的段，起止都已知道） */
  startMs: number
  /** 终点；给了 `durationMs` 时忽略 */
  endMs?: number
  durationMs?: number
  status?: SpanStatus
  error?: unknown
  errorMessage?: string
  itemCount?: number | null
}

export interface ExecTrace {
  /** 挂 `execution_logs.id` */
  readonly executionId: string
  /** **链锚** = `messages.task_id`（口径见 `reply.ts` 的 `coalesce(回复.task_id, 触发.task_id)`） */
  readonly chainId: string | null
  readonly sessionId: string
  readonly agentId: string
  /** 已累积的段（只读视图；写库在 `finish()`） */
  readonly spans: readonly SpanRecord[]
  startSpan(name: SpanName, opts?: StartSpanOpts): SpanHandle
  endSpan(handle: SpanHandle, status?: SpanStatus, opts?: EndSpanOpts): void
  /** 事后补记一整段（起止都已知；queue_wait / token_wait / git.auto_commit 用） */
  recordSpan(name: SpanName, opts: RecordSpanOpts): void
  /**
   * 收尾：关根段 + **一次事务**落两表（写库失败绝不抛）。
   * 由 `finalizeRun` 调用（R2 §七：根段 = `executeOneAgent` 入口 → `finalizeRun`）。
   * 幂等——重复调用只生效一次。
   */
  finish(opts: { success: boolean; errorMessage?: string }): void
}

/**
 * 补记一段**跨执行**的 span（全票唯一一处：`git.auto_commit`）——**独立事务**。
 *
 * 为什么它不能进 `finish()` 那一笔事务：`depth=0` 的自动提交在**全部 `execute()`
 * 返回之后**才跑（那是「一次提交收整轮改动」的语义），此刻目标执行的时间轴早已
 * 落库。要把它折进同一笔事务，只能把整个落库推迟到轮次收尾——那会**延长崩溃窗口**
 * （从「执行结束」推到「轮次结束」），为一个段的收益付整轮风险，不划算。
 *
 * 代价如实声明：这一次插入**不是**「一次执行一个事务」的一部分（`spans` 表对该
 * `execution_id` 会有两笔事务）。它只增一行、只加不减，不改任何已落数据；
 * 落库失败走同一套「绝不抛 + 记痕」语义。
 *
 * @returns 写入成功 `true`；无根段可挂 / 写失败 `false`（**不编数据**）
 */
export function insertDetachedSpan(args: {
  executionId: string
  /** 该执行的根段 id——`spans.getRootSpanId` 取；取不到则不写 */
  parentSpanId: string
  chainId: string | null
  sessionId: string | null
  agentId: string | null
  name: SpanName
  startMs: number
  durationMs: number
  status?: SpanStatus
}): boolean {
  return spansRepo.insertExecTrace([
    {
      spanId: randomBytes(16).toString('hex'),
      parentSpanId: args.parentSpanId,
      chainId: args.chainId,
      executionId: args.executionId,
      sessionId: args.sessionId,
      agentId: args.agentId,
      name: args.name,
      operationName: OPERATION_NAMES[args.name],
      startAt: new Date(args.startMs).toISOString(),
      durationMs: Math.max(0, Math.round(args.durationMs)),
      status: args.status ?? 'ok',
      errorType: deriveErrorType(args.status ?? 'ok', null),
      errorMessage: null,
      itemCount: null,
      llm: null,
    },
  ])
}

/** 从抛出物取 message（非 Error 一律 `String(x)`，空值返回 undefined） */
function messageOf(err: unknown): string | undefined {
  if (err === null || err === undefined) return undefined
  if (err instanceof Error) return err.message
  const s = String(err)
  return s.length > 0 ? s : undefined
}

/** 状态 + 消息 → `error_type`（复用 `execution_logs` 的分类口径） */
function deriveErrorType(status: SpanStatus, msg: string | null): string | null {
  if (status === 'ok' || status === 'skipped') return null
  if (status === 'timeout') return 'timeout'
  return classifyError(msg)
}

/**
 * 创建一个 **per-execution** 采集器并立即开根段。
 *
 * 调用点：`serial.ts:executeOneAgent` 入口（此时 `execution_logs` 行已由
 * `executeAgentCommand` 落好，`executionId` 就是它的行 id）。
 */
export function createExecTrace(args: {
  executionId: string
  chainId: string | null
  sessionId: string
  agentId: string
  /** 根段起点（缺省 `Date.now()`）——`executeOneAgent` 传函数入口时刻 */
  startMs?: number
}): ExecTrace {
  const { executionId, chainId, sessionId, agentId } = args
  const records: SpanRecord[] = []
  const byId = new Map<string, SpanRecord>()
  let finished = false
  /** 根段 id——`null` 期间（正在建根段）建的段才是根；建完之后一律挂它 */
  let rootSpanId: string | null = null

  function startSpan(name: SpanName, opts?: StartSpanOpts): SpanHandle {
    const record: SpanRecord = {
      spanId: randomBytes(16).toString('hex'),
      // 本票的段是**扁平一层**：根 + 若干子段，层级靠 `parent_span_id` 表达。
      // 没有「段中段」——11 段的起止都在同一条执行主线上。
      parentSpanId: rootSpanId,
      name,
      operationName: opts?.operationName !== undefined ? opts.operationName : OPERATION_NAMES[name],
      startMs: opts?.startMs ?? Date.now(),
      durationMs: 0,
      status: 'ok',
      errorType: null,
      errorMessage: null,
      itemCount: null,
      llm: opts?.llm
        ? {
            provider: opts.llm.provider,
            model: opts.llm.model,
            inputTokens: null,
            outputTokens: null,
            ttftMs: null,
            stream: opts.llm.stream,
            maxTokens: opts.llm.maxTokens,
            firstChunkMs: null,
          }
        : null,
    }
    records.push(record)
    byId.set(record.spanId, record)
    return {
      spanId: record.spanId,
      name: record.name,
      markFirstChunk() {
        if (record.llm && record.llm.firstChunkMs === null) record.llm.firstChunkMs = Date.now()
      },
      setItemCount(n: number | null) {
        record.itemCount = n
      },
    }
  }

  function endSpan(handle: SpanHandle, status: SpanStatus = 'ok', opts?: EndSpanOpts): void {
    const record = byId.get(handle.spanId)
    if (!record) return
    const endMs = opts?.endMs ?? Date.now()
    record.durationMs = Math.max(0, Math.round(endMs - record.startMs))
    record.status = status
    if (opts?.itemCount !== undefined) record.itemCount = opts.itemCount
    const msg = opts?.errorMessage ?? messageOf(opts?.error)
    if (msg) record.errorMessage = msg.slice(0, MAX_ERROR_MESSAGE_CHARS)
    record.errorType = deriveErrorType(status, record.errorMessage)
    // ttft 在收段时结算：首 chunk 相对**本段起点**（= chatStream 调用前一刻，R2 §七 硬点 3）
    if (record.llm) {
      record.llm.ttftMs =
        record.llm.firstChunkMs === null
          ? null
          : Math.max(0, Math.round(record.llm.firstChunkMs - record.startMs))
      if (opts?.llmUsage) {
        record.llm.inputTokens = opts.llmUsage.inputTokens
        record.llm.outputTokens = opts.llmUsage.outputTokens
      }
    }
  }

  function recordSpan(name: SpanName, opts: RecordSpanOpts): void {
    const handle = startSpan(name, { startMs: opts.startMs })
    endSpan(handle, opts.status ?? 'ok', {
      ...(opts.error !== undefined ? { error: opts.error } : {}),
      ...(opts.errorMessage !== undefined ? { errorMessage: opts.errorMessage } : {}),
      ...(opts.itemCount !== undefined ? { itemCount: opts.itemCount } : {}),
      endMs:
        opts.endMs ?? (opts.durationMs !== undefined ? opts.startMs + opts.durationMs : undefined),
    })
  }

  // 根段：建它时 `rootSpanId` 仍是 null ⇒ `parent_span_id` 恒 NULL
  // （一次执行恰一个根——验收 2 的机器判据）。建完立刻钉死，后续段一律挂它。
  const rootHandle = startSpan('invoke_agent', {
    operationName: OPERATION_NAMES.invoke_agent,
    ...(args.startMs !== undefined ? { startMs: args.startMs } : {}),
  })
  rootSpanId = rootHandle.spanId

  return {
    executionId,
    chainId,
    sessionId,
    agentId,
    get spans() {
      return records
    },
    startSpan,
    endSpan,
    recordSpan,
    finish(opts) {
      if (finished) return
      finished = true
      endSpan(rootHandle, opts.success ? 'ok' : 'error', {
        ...(opts.errorMessage !== undefined ? { errorMessage: opts.errorMessage } : {}),
      })
      const rows: SpanInput[] = records.map((r) => ({
        spanId: r.spanId,
        parentSpanId: r.parentSpanId,
        chainId,
        executionId,
        sessionId,
        agentId,
        name: r.name,
        operationName: r.operationName,
        startAt: new Date(r.startMs).toISOString(),
        durationMs: r.durationMs,
        status: r.status,
        errorType: r.errorType,
        errorMessage: r.errorMessage,
        itemCount: r.itemCount,
        llm: r.llm
          ? {
              provider: r.llm.provider,
              model: r.llm.model,
              inputTokens: r.llm.inputTokens,
              outputTokens: r.llm.outputTokens,
              ttftMs: r.llm.ttftMs,
              stream: r.llm.stream,
              maxTokens: r.llm.maxTokens,
            }
          : null,
      }))
      spansRepo.insertExecTrace(rows)
    },
  }
}
