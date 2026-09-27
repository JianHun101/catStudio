/**
 * 评估中心 REST API（E4-A：后端四接口）。
 *
 * - GET /api/eval/scores?limit=&agent_id=   最近评分列表（join agents 拿猫名）
 * - GET /api/eval/aggregates                按猫聚合 count / avg_score / low_score_rate
 * - GET /api/eval/review/pending            待回标样本（low_score 且无回标，附回复全文 + 前置 10 条上下文）
 * - POST /api/eval/review/:evalScoreId      { score: 1-5, comment? } 写回标 + 翻转 sample_reason；
 *                                           重复提交同一 eval_score_id → 覆盖 + log 留痕（契约钉死分支）
 * - GET /api/eval/episode-stats             任务结局分布（U 根/H 根 outcome 计数 + open + 版本偏差，
 *                                           挂现成 episodeStats()，办成率前端算）
 * - GET /api/eval/l1-metrics                L1 八口径聚合（P1-A：给已有 aggregateMetrics() 开门）
 * - GET /api/eval/chains?limit=&windowDays= 链路查询（P1-A：哪条链最长 / 卡在哪一跳）
 * - GET /api/eval/spans?execution_id=       一次执行的段分解时间轴（R3：卡点从「哪一跳」
 *                                           下沉到「哪一段」；接线 R2 既有读口，不写新 SQL）
 * - GET /api/eval/session-traces?session_id= 会话内每只有执行的猫的最近一次执行（R4 §A：
 *                                           右侧面板展开某猫 trace 前的取数口——先拿到
 *                                           execution_id，再调上面的 /spans 懒加载段）
 * - GET /api/eval/label/pool               待标注候选池（J1 盲标：跨会话分散、排除已标注、
 *                                           **响应不含判官分**；E1 起每条附**前置 10 条
 *                                           上下文**，与 /review/pending 同款取数）
 * - POST /api/eval/label/:messageId        { score: 1-5, comment?, labeler? } 写 human_labels；
 *                                           重复提交同一 message_id → 覆盖 + log 留痕
 * - GET /api/eval/judge-agreement          判官分 × 人工分的一致性读数（J1 形态甲：
 *                                          复用 phase0 的 spearman/agreementRate；空库 →
 *                                          200 + 结构化空态，不是 500）
 * - GET /api/eval/retrieval/reports        检索跑批报告清单（E1：日期倒序，给日期选择器用。
 *                                          **空清单是 200 + `[]`**——「还没跑过批」不是错误）
 * - GET /api/eval/retrieval/report?date=   一份检索跑批报告（E1：缺省 = 最新；没有 → 404
 *                                          + reason。**纯读文件，绝不触发跑批**）
 * - GET /api/eval/executions                执行列表（T2 §三A 过滤栏数据面：五维过滤
 *                                           + 偏移分页 + 检索漏斗；缺省 = 跨会话近 50 条）
 * - GET /api/eval/execution-detail?execution_id=  一次执行的展开详情（T2：执行行 +
 *                                           上下文决策逐条 + prompt 节清单**无正文**；
 *                                           `execution_id` 不存在 → 404，与 /spans 刻意不同）
 * - GET /api/eval/prompt-section?execution_id=&key=  单节快照**当次注入原文**（T2 懒加载；
 *                                           节不存在 → 404，与「合法的 empty 节」分开）
 * - GET /api/eval/retrieval-detail?execution_id=  检索明细（T2 懒加载：复用既有
 *                                           `getRetrievalQueries`/`getRetrievalCandidates`，
 *                                           **不过滤 injected**——本节正是要看没进的那些）
 * - GET /api/eval/execution-by-message?message_id=&session_id=  messageId → executionId
 *                                           （T2 气泡 ⚙ 跳页预选；`session_id` 必填是越权约束）
 *
 * **字段名随取数层**：DB 行投影原样 snake_case（`/scores`、`/aggregates`、`/review/pending`、
 * `/spans` 的段行——前端直接消费 DB 行）；**聚合/派生结构**用 camelCase
 * （`/chains` 的 `chainId`、`/l1-metrics`、`/episode-stats`、`/spans` 的 `llm`、
 * `/session-traces`）。此前这里笼统写「返回 snake_case 原样出」，对派生端点本就不成立
 * （`/chains` 起就已如此），R4 §A 再添一例——按事实改写，不再复述一个反例比正例多的断言。
 * 错误 { error } + 4xx 钉死契约类型。纯展示 + 两处人工写入（回标 / 标注），零 LLM 调用。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { v4 as uuid } from 'uuid'
import {
  evalScores as evalScoresRepo,
  userFeedback as userFeedbackRepo,
  humanLabels as humanLabelsRepo,
  executionLogs as executionLogsRepo,
  retrievalEvents as retrievalRepo,
  traceDetails as traceDetailsRepo,
  spans as spansRepo,
} from '../db/repository/index.js'
import type { SpanRow, LlmSpanDetail } from '../db/repository/index.js'
import { extractCitationMarkers } from '../memory/citationMarkers.js'
import { episodeStats } from '../eval/episodes.js'
import { aggregateMetrics, WINDOW_DAYS } from '../eval/l1-aggregator.js'
import { buildChains } from '../eval/chain-query.js'
import { agreementRate, spearman } from '../eval/phase0.js'
import { envNumber } from '../env-number.js'
import { createLogger } from '../logger.js'
import { findRepoRootFrom } from '../repo-root.js'

const log = createLogger('eval-routes')

/** limit 必须是 1-200 的整数——前端传错静默回退会掩盖 bug，400 钉死 */
function parseLimit(raw: unknown): number | null {
  if (raw === undefined || raw === '') return 50
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 && n <= 200 ? n : null
}

/** 链路查询的取参：**越界钳位不报错**（契约冻结）——与 parseLimit 的 400 语义刻意不同。
 *  非数字（含 `?limit=abc`）回默认值，不静默当 0 用。 */
function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

/** 整数取参：**没给 → 默认值；给了但不是 [min,max] 内的整数 → `null`（调用方回 400）**。
 *
 *  与上面两个刻意三态分离：`parseLimit` 没有「默认值」参（默认写死 50），`clampInt` 是
 *  「越界钳位不报错」。本函数服务标注池的 `perSession` / `days`——它们的默认值与上下界
 *  都由调用点给，且**给了非法值必须报错**：`?perSession=abc` 静默落回 3，使用者会以为
 *  「每会话 3 条」的约束生效了，实际拿到的是别的数。 */
function parseBoundedInt(raw: unknown, fallback: number, min: number, max: number): number | null {
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  return Number.isInteger(n) && n >= min && n <= max ? n : null
}

/** 一行段 + 内联的 LLM 详情（R3 契约）：`SpanRow` 原样 snake_case **加上** `llm`。
 *
 *  `llm` 内联而**不是**单开一个 `span_llm` 端点，是为了掐掉前端 N+1——
 *  11 段各发一次请求，等于把「一次执行的时间轴」拆成 11 个可乱序的往返。
 *  非 `llm.chat` 段恒 `null`（闭集里只有它建 `span_llm` 行，见 R2 §五）。 */
export interface SpanDto extends SpanRow {
  llm: LlmSpanDetail | null
}

/** `span_llm` 行（snake_case 列）→ 契约类型 `LlmSpanDetail`（camelCase）。
 *  只在这里换算一次，前端拿到的就是定型字段，不必自己认列名。 */
function toLlmDetail(raw: Record<string, unknown>): LlmSpanDetail {
  return {
    provider: String(raw.provider),
    model: String(raw.model),
    inputTokens: raw.input_tokens == null ? null : Number(raw.input_tokens),
    outputTokens: raw.output_tokens == null ? null : Number(raw.output_tokens),
    ttftMs: raw.ttft_ms == null ? null : Number(raw.ttft_ms),
    // SQLite 无布尔类型，`stream` 列存 0/1（R2 DDL `INTEGER NOT NULL`）
    stream: raw.stream === 1 || raw.stream === true,
    maxTokens: raw.max_tokens == null ? null : Number(raw.max_tokens),
  }
}

/** 会话内某只猫最近一次执行的**前端契约**（R4 §A）。
 *
 *  与 `SpanDto`（DB 行原样 snake_case）刻意不同：本 DTO **没有对应的 DB 行形状**
 *  ——它是「每猫取最新」聚合后的产物，不是哪一张表的投影，故按本仓对**派生类型**
 *  的既有惯例用 camelCase（同 `LlmSpanDetail`、`ChainHop`：库里的列名不是它的名字）。
 *  `totalMs` 尤其如此：库里那列叫 `latency_ms`，这里给的是面板要显示的语义名。
 *
 *  `endedAt === null` 是**在飞**的唯一判据（`totalMs` 给不出数时为 null，不回落 0）
 *  ——前端据此显式渲染「采集中」，而不是显示 0 或空白。 */
export interface SessionTraceDto {
  agentId: string
  executionId: string
  status: string
  startedAt: string | null
  endedAt: string | null
  totalMs: number | null
}

// ─── 检索跑批报告的只读出口（E1）────────────────────────────────────────
// 报告本体是 `scripts/eval/retrieval-baseline.mjs` 的**手工跑批**产物：跑批要起嵌入
// sidecar、跑几分钟，**前端不能触发**（会撞活 server 的嵌入端口）。所以这一节只做
// 「把磁盘上已有的报告读出来」，**零计算、零 LLM、零写**——页面上的数字永远是
// 「上一次跑批」的快照，不是当前水位。前端在 tab 顶部明写这句话。

/** 报告文件名的契约形状：`retrieval-baseline-<YYYY-MM-DD>.json`（`--out` 换扩展名而来）。 */
const REPORT_FILE_RE = /^retrieval-baseline-(\d{4}-\d{2}-\d{2})\.json$/

/** `?date=` 的形状闸。**它同时是路径穿越的闸**：date 会拼进文件名，`../../x` 这类
 *  必须在这条正则上就死掉——别指望「拼出来的文件多半不存在」兜底。 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 仓库根锚点。黄金集是**已跟踪文件**，源码布局与产物布局下都能由它反查出仓库根；
 *  用 `findRepoRootFrom` 向上找而**不按固定层级上溯**——产物比源码深两层，
 *  固定层数必有一边静默指到不存在的路径（理由与实测见 `repo-root.ts` 文件头）。
 *
 *  导出是给测试用的：布局无关性要拿**这个** marker 去证伪，测试里再抄一份字面量的话，
 *  marker 改了测试照绿（而改错 marker = 报告目录整个找不到）。 */
export const RETRIEVAL_REPO_MARKER = ['docs', 'eval', 'retrieval-golden.json'] as const

/** 测试注入的报告目录。`undefined` = 未注入（走 `import.meta.url` 真解析）。 */
let reportsDirOverride: string | null | undefined

/**
 * 测试专用：把报告目录钉到夹具目录（传 `null` = 钉成「解析不到」，`undefined` 复位）。
 *
 * 与 `setDb()` 同一分工——**目录是部署事实**，生产侧锚在模块自身位置（`import.meta.url`），
 * 夹具没有可上溯的祖先链，只能注入。命名带 `__test_` 前缀是让它一眼可见用途
 * （同 `dispatch/index.ts::__test_reset` 一类）。
 */
export function __test_setRetrievalReportsDir(dir: string | null | undefined): void {
  reportsDirOverride = dir
}

/** 报告目录 = `<仓库根>/docs/eval`；找不到仓库根返回 `null`（调用方按「无报告」处置）。 */
function retrievalReportsDir(): string | null {
  if (reportsDirOverride !== undefined) return reportsDirOverride
  const root = findRepoRootFrom(dirname(fileURLToPath(import.meta.url)), RETRIEVAL_REPO_MARKER)
  return root === null ? null : join(root, 'docs', 'eval')
}

/** 磁盘上一份报告的身份（给日期选择器用）。 */
export interface RetrievalReportSummary {
  date: string
  file: string
  /** 文件写入时刻（UTC ISO）——**取自 mtime，不是报告内容**：报告本体按 B1 纪律
   *  零时间量（同树同库两跑逐字节一致，**`.md` 与 `.json` 两份产物各自成立**），
   *  「生成时刻」只能由文件系统给。 */
  writtenAt: string | null
}

/**
 * 列出全部报告，**日期倒序**。
 *
 * 目录读不到 ⇒ 空数组：「还没跑过批」是正常状态，不是错误（`docs/eval/` 在产物布局
 * 或裁剪过的检出里本就可能缺席）。单个文件 `stat` 失败 ⇒ 保留该条、`writtenAt` 给
 * `null`——手工跑批正在写时可能撞上，丢掉整条会让清单在跑批期间抖动。
 */
export function listRetrievalReports(dir: string): RetrievalReportSummary[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: RetrievalReportSummary[] = []
  for (const name of names) {
    const m = REPORT_FILE_RE.exec(name)
    if (!m) continue
    let writtenAt: string | null = null
    try {
      writtenAt = statSync(join(dir, name)).mtime.toISOString()
    } catch {
      writtenAt = null
    }
    out.push({ date: m[1], file: name, writtenAt })
  }
  // 同日多份按文件名倒序：**显式 tie-break**，别把 `readdir` 的顺序（文件系统给的，
  // 不保证稳定）漏进响应——同一目录两次请求给出不同顺序会让日期选择器跳位。
  return out.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1
    return a.file < b.file ? 1 : -1
  })
}

export async function evalRoutes(app: FastifyInstance): Promise<void> {
  /** 最近评分列表（join agents 拿猫名；agent_id 可选过滤） */
  app.get('/api/eval/scores', async (req, reply) => {
    const { limit: rawLimit, agent_id } = req.query as { limit?: string; agent_id?: string }
    const limit = parseLimit(rawLimit)
    if (limit === null) {
      return reply.status(400).send({ error: 'limit must be an integer in 1..200' })
    }
    const agentId = typeof agent_id === 'string' && agent_id ? agent_id : null
    const scores = evalScoresRepo.listScores({ limit, agentId })
    return reply.send({ ok: true, scores })
  })

  /** 按猫聚合：count / avg_score / low_score_rate（≤2 占比） */
  app.get('/api/eval/aggregates', async (_req, reply) => {
    return reply.send({ ok: true, aggregates: evalScoresRepo.getAggregates() })
  })

  /**
   * 任务结局分布（E4-B 观察 tab 数据源，契约缺口裁决补充的唯二后端改动之一）。
   * 挂现成 episodeStats()：U 根/H 根 outcome 计数 + open + 版本偏差；
   * 办成率口径钉死前端算：(success + corrected_success) / Σ(uRoot 各 outcome 计数)，open 不计入分母。
   */
  app.get('/api/eval/episode-stats', async (_req, reply) => {
    return reply.send({ ok: true, stats: episodeStats() })
  })

  /**
   * L1 八口径聚合（P1-A）。
   *
   * 路径**必须**是 `l1-metrics`——`/api/eval/aggregates`（上方）已被 L2 按猫评分聚合占用，
   * 撞名会静默覆盖。
   *
   * **纯读**：只调 `aggregateMetrics()`，**不得**触发 `runL1Aggregation()` 的滞回状态机
   * 与告警投递——那是定时任务的事，被一次 GET 顺带触发 = 假告警。
   */
  app.get('/api/eval/l1-metrics', async (_req, reply) => {
    return reply.send({ windowDays: WINDOW_DAYS, ...aggregateMetrics() })
  })

  /**
   * 链路查询（P1-A）：按链锚 `COALESCE(回复.task_id, 触发.task_id)` 分组，
   * 回答「哪条链耗时最长 / 卡在哪一跳」。
   *
   * 取数归 repo、变换归 `eval/chain-query.ts` 纯函数，本路由只做「取数 → 调纯函数 → 返回」。
   * 字段级契约见 `docs/run/eval-system/P1-a-backend-chain-query.md`（P1-B 前端按此消费）。
   */
  app.get('/api/eval/chains', async (req, reply) => {
    const { limit: rawLimit, windowDays: rawWindow } = req.query as {
      limit?: string
      windowDays?: string
    }
    // 与 /scores 的 parseLimit 不同：**越界钳位不报错**（契约），limit 只截链不截跳
    const limit = clampInt(rawLimit, 20, 1, 100)
    const windowDays = clampInt(rawWindow, WINDOW_DAYS, 1, 3650)
    const slowMs = envNumber('EVAL_CHAIN_SLOW_MS', 300000)
    const result = buildChains(executionLogsRepo.getExecutionHopsWithChainAnchor(windowDays), {
      slowMs,
      limit,
    })
    return reply.send({
      windowDays,
      anchor: 'coalesce(reply.task_id, trigger.task_id)',
      slowMs,
      ...result,
    })
  })

  /**
   * 一次执行的段分解时间轴（R3）。前端消费粒度 = **一跳**（用户展开的就是某跳），
   * 故按 `execution_id` 取而非 `chain_id`——按链取会把整条链的段混在一起，
   * 逼前端把**已经存在的分组信息丢掉再按 execution_id 重建**，纯亏。
   * `ChainHop.executionLogId` 与 `spans.execution_id` 同值 ⇒ 前端零契约变更；
   * `idx_spans_execution` 正是为此建（「看板主路径：按执行取全段时间轴」）。
   *
   * **空数组是合法响应，不是 404**：`execution_id` 不存在 / 该执行未落段
   * （running 中，或采集修复前的存量行）一律 200 + `[]`——对用户都是「无段数据」，
   * 404 只会诱发一条无意义的错误分支。缺参才是 400。
   *
   * **纯读**：只调 `getSpansByExecution()` / `getLlmDetail()`，不写新 SQL、不回写任何表。
   * 排序归 repo（`ORDER BY start_at, id`），本路由**不得重排**。
   */
  app.get('/api/eval/spans', async (req, reply) => {
    const { execution_id } = req.query as { execution_id?: string }
    if (typeof execution_id !== 'string' || execution_id === '') {
      return reply.status(400).send({ error: 'execution_id is required' })
    }
    const spans: SpanDto[] = spansRepo.getSpansByExecution(execution_id).map((row) => {
      // 非 `llm.chat` 段**连查都不查**（闭集保证它没有详情行）——省掉每执行 10 次空查询，
      // 也让「非 llm.chat 恒 null」是结构性的，不依赖「恰好没数据」。
      const detail = row.name === 'llm.chat' ? spansRepo.getLlmDetail(row.span_id) : undefined
      return { ...row, llm: detail ? toLlmDetail(detail) : null }
    })
    return reply.send({ ok: true, spans })
  })

  /**
   * 会话内**每只有执行的猫的最近一次执行**（R4 §A）。
   *
   * 存在的理由是一条**缺口**：面板要展开某猫的 trace，得先知道「拉哪次执行」，
   * 而既有 8 个 eval 端点无一给得出——`/chains` 是链视角（无 session 维度）、
   * `/spans` 要显式 `execution_id`。本端点补的就是这一跳：**会话 → 每猫的
   * execution_id**；段数据仍由前端拿 id 去调 `/spans`（契约第 7 条：不内联）。
   *
   * **「最近」按 `started_at` 取最大，不看 `status`**（契约第 1 条）：按状态筛会在
   * 在飞时把该猫整个吞掉——用户点开一只正在干活的猫，看到的却是「暂无执行」。
   * 在飞行**照样返回**（契约第 2 条），由 `endedAt === null` 让前端渲染「采集中」，
   * **不回退到更早一次**（拿旧执行冒充当前状态，比空更坏）。
   *
   * **零执行的猫不出现在数组里**（契约第 3 条）——前端显示「本会话暂无执行」。
   * 返回 `0` 或空对象会造成「有过执行但没有数据」的假象。
   *
   * **缺参 / 空参 → 400；无匹配 → 200 + `[]`**（契约第 4 条）：口径与
   * `/spans` 逐字一致——「这个会话没有执行」对用户就是「无数据」，不是错误，
   * 404 只会诱发一条无意义的错误分支。**缺参**才是调用方写错了。
   *
   * **纯读**（契约第 5 条）：只调 `getLatestExecutionPerAgent()`，不写新 SQL 之外的
   * 东西、零 LLM、不回写任何表。
   */
  app.get('/api/eval/session-traces', async (req, reply) => {
    const { session_id } = req.query as { session_id?: string }
    if (typeof session_id !== 'string' || session_id === '') {
      return reply.status(400).send({ error: 'session_id is required' })
    }
    // 字段换算只在这里发生一次（repo 出行名，路由出契约名）——与 `toLlmDetail` 同一分工
    const traces: SessionTraceDto[] = executionLogsRepo
      .getLatestExecutionPerAgent(session_id)
      .map((row) => ({
        agentId: row.agent_id,
        executionId: row.id,
        status: row.status,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        // 库里叫 latency_ms，面板要的是「总时长」——**null 原样传**（在飞），不回落成 0
        totalMs: row.latency_ms,
      }))
    return reply.send({ ok: true, traces })
  })

  // ─── T2 执行追踪查询页（票 docs/run/ui-redesign/T2-trace-page.md）─────────────
  //
  // 五个口分成**两种取数时机**，这是刻意的：
  // · 列表 + `execution-detail` 是「行一展开就要」的（决策明细与节清单都很小），随展开一次拉全；
  // · `prompt-section` / `retrieval-detail` 是「三小节**再**点开才要」的（单节全文可达数十 KB、
  //   候选行一次几十条），故各自独立成口懒加载——把详情页首屏绑在最大 payload 上是不划算的。

  /** 列表行（`ExecutionTraceRowDto`）——**派生类型，故 camelCase**（与 `SessionTraceDto` 同惯例：
   *  它没有对应的 DB 行形状，是「execution_logs 行 + 五处 join + 两个子查询」的聚合产物）。 */
  interface ExecutionTraceRowDto {
    executionId: string
    sessionId: string
    sessionName: string | null
    agentId: string
    agentName: string | null
    agentAvatar: string | null
    status: string
    startedAt: string | null
    endedAt: string | null
    /** 总耗时（库里叫 `latency_ms`）；`null` = 在飞或失败未收口，**不回落 0** */
    totalMs: number | null
    promptTokens: number | null
    completionTokens: number | null
    /** 回复消息 id（成功路径才有）；气泡跳转据此反查 */
    messageId: string | null
    /** 触发消息 id——没生成回复的执行（failed）只有这个，列表摘要取它 */
    triggerMessageId: string
    traceId: string
    errorType: string | null
    errorMessage: string | null
    /** 列表摘要：优先回复正文，无回复则退回触发正文。已截前 200 字 */
    summary: string
    /** 检索漏斗：注入节数（按 `doc_path + section_anchor` 去重，与 memory-refs 同口径） */
    injectedSections: number
    /** 引用数：回复正文里的角标号个数（与 R14b 角标同一条判据函数，两侧不各写一份） */
    citationCount: number
    /** `skipped-a2a` ⇒ 列表行显示「未检索（A2A）」；`null` = 无检索流水行 */
    retrievalReason: string | null
  }

  /**
   * 执行列表（T2 §三A 过滤栏的数据面）。
   *
   * 五维过滤（会话 / 猫 / 状态 / 耗时阈值 / 仅看报错）+ 偏移分页（店长裁 OQ-3：50/页，
   * 不做无限滚动——与票面默认「近 50 条」一致）。
   *
   * **缺省不报错**（与 `/chains` 的钳位同档，非 `/spans` 的 400 档）：列表页是「一进来
   * 就要出东西」的界面，没给 `session_id` 就是「跨会话看全部」，是合法诉求不是调用方写错。
   * 只有**给了非法值**才 400（`?limit=abc` 静默落回 50 会让使用者以为自己的约束生效了）。
   */
  app.get('/api/eval/executions', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>
    const limit = parseLimit(q.limit)
    if (limit === null) return reply.status(400).send({ error: 'limit must be an integer 1-200' })
    const offset = parseBoundedInt(q.offset, 0, 0, 100000)
    if (offset === null) return reply.status(400).send({ error: 'offset must be an integer >= 0' })

    // 「仅看报错」= status 锁 failed。与显式 status 同时给时**前者优先**——
    // 勾选复选框是更具体的意图，静默取交集会得到空列表（用户看到的是「没报错」）。
    const errorsOnly = q.errors_only === '1' || q.errors_only === 'true'
    const status = errorsOnly ? 'failed' : q.status || undefined
    if (status !== undefined && !['queued', 'running', 'completed', 'failed'].includes(status)) {
      return reply
        .status(400)
        .send({ error: 'status must be one of queued|running|completed|failed' })
    }

    const minLatencyMs =
      q.min_latency_ms === undefined || q.min_latency_ms === ''
        ? undefined
        : (parseBoundedInt(q.min_latency_ms, 0, 0, 86_400_000) ?? null)
    if (minLatencyMs === null) {
      return reply.status(400).send({ error: 'min_latency_ms must be an integer >= 0' })
    }

    const filter = {
      sessionId: q.session_id || undefined,
      agentId: q.agent_id || undefined,
      status,
      minLatencyMs,
    }
    const rows = executionLogsRepo.listExecutionRows({ ...filter, limit, offset })
    const total = executionLogsRepo.countExecutionRows(filter)

    const executions: ExecutionTraceRowDto[] = rows.map((r) => ({
      executionId: r.id,
      sessionId: r.session_id,
      sessionName: r.session_name,
      agentId: r.agent_id,
      agentName: r.agent_name,
      agentAvatar: r.agent_avatar,
      status: r.status,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      totalMs: r.latency_ms,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      messageId: r.message_id,
      triggerMessageId: r.triggered_by_message_id,
      traceId: r.trace_id,
      errorType: r.error_type,
      errorMessage: r.error_message,
      summary: (r.reply_content ?? r.trigger_head ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
      injectedSections: r.injected_sections,
      // 引用数与角标渲染**同一个函数**（`extractCitationMarkers`）：各写一份就是
      // 「同一规则两处措辞」，改一处漏一处会造出「角标显示了 2 个、列表说 3 个」。
      // 只数**散文中**的号（`markersInCode` 是诊断列、前端不渲染角标）——
      // 两处口径若不同，列表会说「引 3」而气泡上只出现 2 个角标。
      //
      // **喂全文不喂摘要**：角标可在正文任意位置，拿 200 字摘要去数会系统性少算
      // 且不报错（判据面 ≠ 被判面）。全文只在进程内过一遍，回传的只是计数。
      citationCount: r.reply_content
        ? extractCitationMarkers(r.reply_content, r.injected_sections).markers.length
        : 0,
      retrievalReason: r.retrieval_reason,
    }))
    return reply.send({ ok: true, total, limit, offset, executions })
  })

  /**
   * 一次执行的详情（T2 §三A 展开区）：执行行 + 上下文决策逐条 + prompt 节清单（无正文）。
   *
   * **不内联节正文**（见上方两档取数时机）：节清单只给 `sectionKey / label / status /
   * charCount`，正文走 `/prompt-section`。
   *
   * `hasDetails === false` ⇒ 存量行（本票之前的所有执行都没有这两张表的行）。前端据此
   * 渲染「无段数据（存量行）」占位——**不能靠「数组为空」判**：真跑过但两表为空是另一态。
   *
   * **`execution_id` 不存在 → 404**（与 `/spans` 的「空数组是合法响应」刻意不同）：
   * `/spans` 的消费面是「某个确实存在的执行的段」，缺段是常态；本口的消费面是
   * 「列表点进来的这一行」，`execution_id` 查不到只可能是传错了 id 或行已被删
   * （回退删消息会连带删 `execution_logs`）——静默给一个空壳页会让用户以为执行没数据。
   */
  app.get('/api/eval/execution-detail', async (req, reply) => {
    const { execution_id } = req.query as { execution_id?: string }
    if (typeof execution_id !== 'string' || execution_id === '') {
      return reply.status(400).send({ error: 'execution_id is required' })
    }
    const row = executionLogsRepo.getExecutionById(execution_id)
    if (!row) return reply.status(404).send({ error: 'execution not found' })

    const decisions = traceDetailsRepo.getContextDecisions(execution_id)
    const sections = traceDetailsRepo.getPromptSectionMetas(execution_id)
    const event = retrievalRepo.getRetrievalEventByExecution(execution_id)

    // 决策面聚合读数（前端过滤栏/摘要行直接用，免得在渲染层再遍历一遍——
    // 而遍历就会在「什么算筛出」上再分一次叉）
    const counts = { kept: 0, invisible: 0, summary_replaced: 0, budget: 0 }
    let replied = 0
    for (const d of decisions) {
      if (d.decision in counts) counts[d.decision as keyof typeof counts]++
      if (d.detail === 'replied') replied++
    }

    return reply.send({
      ok: true,
      hasDetails: traceDetailsRepo.hasTraceDetails(execution_id),
      execution: {
        executionId: row.id,
        sessionId: row.session_id,
        agentId: row.agent_id,
        status: row.status,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        totalMs: row.latency_ms,
        promptTokens: row.prompt_tokens,
        completionTokens: row.completion_tokens,
        messageId: row.message_id,
        triggerMessageId: row.triggered_by_message_id,
        traceId: row.trace_id,
        errorType: row.error_type,
        errorMessage: row.error_message,
      },
      context: {
        /** 四级漏斗的四档计数 + 已回复标注数。`kept` 应与 `context.compress` 段的
         *  `item_count` 相等（两者都是「实际进 prompt 的消息条数」） */
        counts,
        repliedCount: replied,
        total: decisions.length,
        decisions,
      },
      promptSections: sections.map((s) => ({
        sectionKey: s.section_key,
        label: s.label,
        status: s.status,
        charCount: s.char_count,
      })),
      retrieval: event
        ? {
            reason: event.reason,
            retrievalMs: event.retrieval_ms,
            contextTokens: event.context_tokens,
            budgetTokens: event.budget_tokens,
            truncated: event.truncated === 1,
            thresholdMaxDistance: event.threshold_max_distance,
            paramTopK: event.param_top_k,
            paramProbeN: event.param_probe_n,
            paramPoolN: event.param_pool_n,
            taskId: event.task_id,
          }
        : null,
    })
  })

  /**
   * 单节 prompt 快照正文（T2 §三A「点开展开当次实际注入的完整原文」）。
   *
   * **节不存在 → 404**（不是空串）：`empty` 是**合法的节状态**（本轮该节没内容，
   * 例如没注入铁律），空串是它的真值；而「这一节压根没记」是另一回事，混成空串
   * 会让前端把「存量行没有快照」渲染成「这节内容为空」。
   */
  app.get('/api/eval/prompt-section', async (req, reply) => {
    const { execution_id, key } = req.query as { execution_id?: string; key?: string }
    if (typeof execution_id !== 'string' || execution_id === '') {
      return reply.status(400).send({ error: 'execution_id is required' })
    }
    if (typeof key !== 'string' || key === '') {
      return reply.status(400).send({ error: 'key is required' })
    }
    const content = traceDetailsRepo.getPromptSection(execution_id, key)
    if (content === null) return reply.status(404).send({ error: 'prompt section not found' })
    return reply.send({ ok: true, key, content, charCount: content.length })
  })

  /**
   * 检索明细（T2 §三A 三折叠小节的第二块，懒加载）。
   *
   * 直接复用 `getRetrievalQueries` / `getRetrievalCandidates` 两个**既有**读函数
   * （票 §二 缺口 4：它们在库里但从来没被任何 HTTP 出口暴露过）——不写新 SQL，
   * 也不在这里过滤 `injected = 1`：本小节的用途正是「看**没**进 prompt 的那些为什么
   * 没进」（`dropped_reason` 分布），只出注入行等于把这块的面砍掉一半。
   *
   * 无检索事件 → `{ queries: [], candidates: [] }` + `reason: null`（前端显示
   * 「本轮未检索」，与存量行同款占位，不报错）。
   */
  app.get('/api/eval/retrieval-detail', async (req, reply) => {
    const { execution_id } = req.query as { execution_id?: string }
    if (typeof execution_id !== 'string' || execution_id === '') {
      return reply.status(400).send({ error: 'execution_id is required' })
    }
    const event = retrievalRepo.getRetrievalEventByExecution(execution_id)
    if (!event) {
      return reply.send({ ok: true, reason: null, queries: [], candidates: [] })
    }
    // 丢弃原因分布在这算一次（同一份候选数组上遍历一次，前端不必再遍历——
    // 也就不会出现「前端按另一套规则统计」的第二把尺子）
    const candidates = retrievalRepo.getRetrievalCandidates(event.id)
    const dropped: Record<string, number> = {}
    for (const c of candidates) {
      if (c.dropped_reason) dropped[c.dropped_reason] = (dropped[c.dropped_reason] ?? 0) + 1
    }
    return reply.send({
      ok: true,
      reason: event.reason,
      queries: retrievalRepo.getRetrievalQueries(event.id),
      candidates,
      droppedReasons: dropped,
    })
  })

  /**
   * `messageId → executionId` 关联口（T2 §二 缺口 3：气泡 footer 的 ⚙trace 跳页预选）。
   *
   * `session_id` **必填**：这是把内部 id 换成另一个内部 id 的口，没有会话约束就等于
   * 给了一个「拿任意 messageId 探任意会话执行」的探针（本仓有跨会话越权前科，
   * `getInjectedRefsByMessageIds` 的同名约束是同一把尺子）。
   *
   * **查不到 → 404**（不是 200 + null）：点 ⚙ 的前提是「这条气泡有对应执行」，
   * 查不到说明该气泡的执行行已被删（回退/清空）或它根本不是猫的回复——
   * 两种都该让前端弹一句实话，而不是打开一个空追踪页。
   */
  app.get('/api/eval/execution-by-message', async (req, reply) => {
    const { message_id, session_id } = req.query as {
      message_id?: string
      session_id?: string
    }
    if (typeof message_id !== 'string' || message_id === '') {
      return reply.status(400).send({ error: 'message_id is required' })
    }
    if (typeof session_id !== 'string' || session_id === '') {
      return reply.status(400).send({ error: 'session_id is required' })
    }
    const row = executionLogsRepo.getExecutionByReplyMessageId(message_id, session_id)
    if (!row) return reply.status(404).send({ error: 'execution not found for this message' })
    return reply.send({
      ok: true,
      executionId: row.id,
      agentId: row.agent_id,
      status: row.status,
      startedAt: row.started_at,
      totalMs: row.latency_ms,
    })
  })

  /** 待回标样本：low_score 且无 user_feedback，每条附回复全文 + 前置最近 10 条上下文 */
  app.get('/api/eval/review/pending', async (_req, reply) => {
    const pending = evalScoresRepo.getPendingReviewScores().map((s) => ({
      ...s,
      context: evalScoresRepo.getContextBefore(s.session_id, s.reply_created_at, 10),
    }))
    return reply.send({ ok: true, pending })
  })

  /**
   * 提交回标：写 user_feedback + 翻转 eval_scores.sample_reason='user_feedback'。
   * 重复提交同一 eval_score_id → 覆盖 + log 留痕（契约钉死：不 409 拒绝）。
   */
  app.post('/api/eval/review/:evalScoreId', async (req, reply) => {
    const { evalScoreId } = req.params as { evalScoreId: string }
    if (!evalScoreId || typeof evalScoreId !== 'string') {
      return reply.status(400).send({ error: 'evalScoreId is required' })
    }
    const body = req.body as { score?: unknown; comment?: unknown } | null
    const score = body?.score
    // score 必须是 1-5 整数（前端 1-5 分单选）——string "3" 静默转 number 会掩盖前端 bug
    if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 5) {
      return reply.status(400).send({ error: 'score must be an integer in 1..5' })
    }
    if (body?.comment !== undefined && typeof body.comment !== 'string') {
      return reply.status(400).send({ error: 'comment must be a string' })
    }
    const existing = evalScoresRepo.getScoreById(evalScoreId)
    if (!existing) {
      return reply.status(404).send({ error: 'eval score not found' })
    }
    const covered = userFeedbackRepo.upsertFeedback({
      id: uuid(),
      evalScoreId,
      messageId: existing.message_id,
      sessionId: existing.session_id,
      userScore: score,
      comment: typeof body?.comment === 'string' && body.comment ? body.comment : null,
    })
    if (covered) {
      // 覆盖是契约钉死语义（不是错误），留痕供回溯：谁在什么时候覆盖了谁的评分
      log.warn('user feedback overwrote previous', {
        evalScoreId,
        previousScore: existing.score,
        newScore: score,
      })
    }
    evalScoresRepo.markSampleReason(evalScoreId, 'user_feedback')
    const feedback = userFeedbackRepo.getByEvalScoreId(evalScoreId)
    return reply.send({ ok: true, covered, feedback })
  })

  // ─── J1 · 人工标注（盲标池 + 提交）────────────────────────────────────────
  // 与上方「回标」是**两条独立通道**，别混：回标（`user_feedback`）是对**判官分**的复核，
  // 判官分先于它存在；标注（`human_labels`）是判官分的**基准**，判官分不参与抽样、
  // 也不出现在响应里。理由（一句话）：样本选择权交给被判定的对象，测出来的就只是
  // 「判官像不像它自己」。详见 `migrations.ts` 的 human_labels 条目与 `humanLabels.ts`。

  /**
   * 待标注候选池（盲标）。
   *
   * **响应体刻意不含任何判官分字段**——不是 UI 偏好，是方法论硬要求：标注者一旦看见
   * 判官分就会被锚定，测出来的「一致性」是锚定的产物。取数口径（跨会话分散 / 排除
   * 已标注 / 排除空回复）全在 `humanLabels.listLabelPool`，本路由只做参数校验与透传。
   *
   * 参数：`limit` 默认 30（1..200，越界 400——与 `/scores` 同语义，默认值不同）；
   * `perSession` 默认 3（1..20，**每会话上限**，防单个活跃会话吃满池子）；`agentId` 可选；
   * `days` 可选（**不给 = 不限时间窗**：池子是基准面不是近期视图，默认砍历史会静默
   * 少给样本；要近期视图显式传 `?days=30`）。
   */
  app.get('/api/eval/label/pool', async (req, reply) => {
    const {
      limit: rawLimit,
      perSession: rawPer,
      agentId: rawAgent,
      days: rawDays,
    } = req.query as {
      limit?: string
      perSession?: string
      agentId?: string
      days?: string
    }
    // 默认 30（不是 `/scores` 的 50）：`parseLimit` 把默认值写死在函数里，复用它会让
    // 池子悄悄按 50 出样本——而标注是**人工**成本，默认值该小。语义（非法即 400）
    // 与 `/scores` 逐字一致，只是默认值与上下界由调用点给。
    const limit = parseBoundedInt(rawLimit, 30, 1, 200)
    if (limit === null) {
      return reply.status(400).send({ error: 'limit must be an integer in 1..200' })
    }
    const perSession = parseBoundedInt(rawPer, 3, 1, 20)
    if (perSession === null) {
      return reply.status(400).send({ error: 'perSession must be an integer in 1..20' })
    }
    // days 可选：不给 → null（不限窗）。给了就必须是正整数，否则 400——`?days=abc`
    // 静默当不限窗会让人以为筛过了
    let days: number | null = null
    if (rawDays !== undefined && rawDays !== '') {
      days = parseBoundedInt(rawDays, 1, 1, 3650)
      if (days === null) {
        return reply.status(400).send({ error: 'days must be an integer in 1..3650' })
      }
    }
    const agentId = typeof rawAgent === 'string' && rawAgent ? rawAgent : null
    // E1 契约 D：每条附**前置 10 条上下文**，与 `/review/pending`（上方）逐字同款取数。
    // 没有它，标注者只看得到孤零零一句回复——「这句答得对不对」在无上下文的条件下判不了，
    // 而盲标测的正是「人读了这句给几分」，上下文缺失会把这个分数变成噪音。
    //
    // `getContextBefore` 走**字符串比较** `created_at < ?`：仅当全表时间串格式一致时，
    // 字典序才等于时间序。当前成立的理由与举证见 `db/repository/messages.ts` 的
    // 「created_at 一律由这里生成」注（写入恒经 repository 显式生成 ISO 毫秒），`eval.test.ts` 有顺序判据。
    const pool = humanLabelsRepo.listLabelPool({ limit, perSession, agentId, days }).map((p) => ({
      ...p,
      context: evalScoresRepo.getContextBefore(p.session_id, p.created_at, 10),
    }))
    return reply.send({ ok: true, limit, perSession, days, pool })
  })

  /**
   * 提交人工标注：写 `human_labels`。重复提交同一 `message_id` → **覆盖 + log 留痕**
   * （与回标同款契约：不 409）。
   *
   * 三道门：消息不存在 → 404；**不是猫的回复**（`role !== 'agent'`）→ 400（让人去标
   * 用户消息是接口用错了，不是数据缺失）；分不是 1-5 整数 → 400（string `"3"` 静默转
   * number 会掩盖前端 bug，与回标同口径）。
   *
   * `labeler` 是**标注源**（J1 §三-4 待钉：单源 vs 多源）：不传默认 `'user'`（今天只有
   * 用户一人标注）。多源那天前端传谁标的就是了，结构不必再动。
   */
  app.post('/api/eval/label/:messageId', async (req, reply) => {
    const { messageId } = req.params as { messageId: string }
    if (!messageId || typeof messageId !== 'string') {
      return reply.status(400).send({ error: 'messageId is required' })
    }
    const body = req.body as { score?: unknown; comment?: unknown; labeler?: unknown } | null
    const score = body?.score
    if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 5) {
      return reply.status(400).send({ error: 'score must be an integer in 1..5' })
    }
    if (body?.comment !== undefined && typeof body.comment !== 'string') {
      return reply.status(400).send({ error: 'comment must be a string' })
    }
    if (body?.labeler !== undefined && typeof body.labeler !== 'string') {
      return reply.status(400).send({ error: 'labeler must be a string' })
    }
    const target = humanLabelsRepo.getLabelTarget(messageId)
    if (!target) {
      return reply.status(404).send({ error: 'message not found' })
    }
    if (target.role !== 'agent') {
      return reply.status(400).send({ error: 'message is not an agent reply' })
    }
    const labeler =
      typeof body?.labeler === 'string' && body.labeler.trim() ? body.labeler.trim() : 'user'
    const previous = humanLabelsRepo.getByMessageId(messageId)
    const covered = humanLabelsRepo.upsertLabel({
      id: uuid(),
      messageId,
      sessionId: target.session_id,
      agentId: target.agent_id,
      labeler,
      score,
      comment: typeof body?.comment === 'string' && body.comment ? body.comment : null,
    })
    if (covered) {
      // 覆盖是契约钉死语义（不是错误），留痕供回溯：谁在什么时候改了哪条标注
      log.warn('human label overwrote previous', {
        messageId,
        previousScore: previous?.score ?? null,
        newScore: score,
        labeler,
      })
    }
    return reply.send({ ok: true, covered, label: humanLabelsRepo.getByMessageId(messageId) })
  })

  /**
   * 判官一致性读数（J1 形态甲：端点常驻）。
   *
   * JOIN `eval_scores` × `human_labels`（按 `message_id`），复用 `phase0` 的
   * `spearman` 与 `agreementRate`——**同一份实现**，不另写第二条一致性口径
   * （J1 §六-4 的验收就是钉这条：同一组输入喂两者必须逐位相同）。
   *
   * **无数据是 200 + 结构化空态，不是 500**（J1 §六-1）：活库 `eval_scores` 至今 0 行
   * （`EVAL_SAMPLE_RATE=0`），空库是**今天最可能的响应**，让它报错等于把「还没数据」
   * 伪装成「接口坏了」。`spearman`/`agreement` 在样本不足时是 `NaN`，JSON 里没有 NaN
   * ——统一出 `null`（不是 0：0 是个合法读数，会把「没数据」画成「完全不相关」）。
   *
   * **分母下界**：`counted < minCount` ⇒ `sufficient: false`，**不给判定**
   * （J1 §六-3）。阈值走 `EVAL_LABEL_MIN_COUNT`（默认 30）——J1 §三-2 把「攒到多少算数」
   * 列为待钉项，env 化让这个数可调而不用改代码。
   *
   * ⚠️ **`gate` 恒为 `null` 是设计而非省略**：`phase0.gateVerdict` 的三项闸门里有一项是
   * 「自有族 vs 外部族一致率差 ≤15pp」，而「族」（Phase 0 的 `real`/`external`）是**离线
   * 标注文件**的样本集元数据，活库没有任何一列记着它 ⇒ 常驻面**结构性不可判**。
   * 若照喂 `NaN` 调用 `gateVerdict`，它会恒定输出 `pass: false` + 「样本不足」——一个
   * 永远为假、且理由是假话的判据，正是本仓反复吃过的那类坑（判据恒假 = 静默失效）。
   * 故此项宁缺勿假：主指标（Spearman / 一致率）与 `sufficient` 照常给出，判定读这三个。
   * 要恢复三项闸门，得先让「族」进活库（样本来源列），那是另一票。
   */
  app.get('/api/eval/judge-agreement', async (_req, reply) => {
    const pairs = humanLabelsRepo.listJudgeHumanPairs()
    const judgeScores = pairs.map((p) => p.judge_score)
    const humanScores = pairs.map((p) => p.human_score)
    const agreement = agreementRate(judgeScores, humanScores)
    const rho = spearman(judgeScores, humanScores)
    const minCount = Math.trunc(envNumber('EVAL_LABEL_MIN_COUNT', 30))
    // 判官模型清单：读数要能溯源到「这批一致性出自哪个判官」——判官换过而没人知道，
    // 趋势图会把两个模型的读数连成一条线
    const judgeModels = [...new Set(pairs.map((p) => p.judge_model))].sort()
    return reply.send({
      ok: true,
      total: agreement.total,
      counted: agreement.counted,
      minCount,
      sufficient: agreement.counted >= minCount,
      spearman: Number.isFinite(rho) ? rho : null,
      agreement: Number.isFinite(agreement.rate) ? agreement.rate : null,
      judgeModels,
      gate: null,
      gateUnavailableReason:
        'gateVerdict 的族间差子指标（自有族 vs 外部族 ≤15pp）需要「族」这一维度，它是 Phase 0 离线标注文件的样本集元数据，活库无对应列 ⇒ 常驻面不可判。判定请读 sufficient + spearman + agreement。',
    })
  })

  // ─── E1 · 检索跑批报告（只读）────────────────────────────────────────────

  /**
   * 报告清单（E1 契约 B 上半）：给前端日期选择器用，**日期倒序**。
   *
   * **空清单是 200 + `[]`，不是 404**——口径与 `/spans`（`execution_id` 无段数据）逐字
   * 一致：「还没有跑过批」对使用者就是「无数据」，不是错误。这一栏今天恰恰很可能就是
   * 空的（报告是手工跑批产物，`docs/eval/` 里只有两份 md、还没有 json），回 404 会逼
   * 前端把「空」写成异常分支，而空态文案（「先去跑 scripts/eval/retrieval-baseline.mjs」）
   * 才是使用者真正需要看到的。**单份报告**取不到才是 404（见下一条）。
   */
  app.get('/api/eval/retrieval/reports', async (_req, reply) => {
    const dir = retrievalReportsDir()
    return reply.send({ ok: true, reports: dir === null ? [] : listRetrievalReports(dir) })
  })

  /**
   * 一份报告（E1 契约 B 下半）。`?date=` 缺省 = **最新那份**。
   *
   * 三态刻意分开（与 `/label/pool` 的 `days` 同款取舍）：缺省/空串 ⇒ 取最新；
   * 形状不对（`?date=abc`、`?date=2026-9-1`）⇒ **400**；形状对但那天没有 ⇒ **404 + reason**。
   * 400 与 404 不能合并：日期选择器的选项来自上面那个清单，手写畸形值就是调用方写错了，
   * 回 404 会把它伪装成「那天确实没有报告」——正是本文件 `parseBoundedInt` 注释里说的
   * 「静默落回默认值 / 静默当不存在」那类掩盖。
   *
   * 文件在、内容读不动或不是 JSON ⇒ **500**：这不是调用方的问题，也不该伪装成 404。
   */
  app.get('/api/eval/retrieval/report', async (req, reply) => {
    const { date: rawDate } = req.query as { date?: string }
    let date: string | null = null
    if (rawDate !== undefined && rawDate !== '') {
      if (typeof rawDate !== 'string' || !DATE_RE.test(rawDate)) {
        return reply.status(400).send({ error: 'date must be YYYY-MM-DD' })
      }
      date = rawDate
    }
    const dir = retrievalReportsDir()
    const reports = dir === null ? [] : listRetrievalReports(dir)
    // 清单已按日期倒序 ⇒ `reports[0]` 即最新那份（「缺省 = 最新」不另写一遍排序）
    const picked = date === null ? reports[0] : reports.find((r) => r.date === date)
    if (dir === null || picked === undefined) {
      return reply.status(404).send({
        error:
          reports.length === 0
            ? 'no retrieval baseline report yet — run scripts/eval/retrieval-baseline.mjs'
            : `no retrieval baseline report for date ${date}`,
      })
    }
    try {
      const report: unknown = JSON.parse(readFileSync(join(dir, picked.file), 'utf8'))
      // 顶层不是对象（`null` / 数组 / 裸标量）等同读不动：契约是 `{schema, ...ctx}`，
      // 放过去只会让前端在渲染时炸，比在这里 500 难查得多。
      if (report === null || typeof report !== 'object' || Array.isArray(report)) {
        throw new Error('报告顶层不是对象')
      }
      return reply.send({ ok: true, ...picked, report })
    } catch (err) {
      log.warn('retrieval report unreadable', { file: picked.file, error: String(err) })
      return reply.status(500).send({ error: `retrieval report unreadable: ${picked.file}` })
    }
  })
}
