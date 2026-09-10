/**
 * v2 episode 判定引擎 — 任务生命周期结局分类。
 * 规格：docs/plans/episode-evaluation-v2.md（九轮审查定稿 5b45a38，全文档权威）。
 *
 * 契约要点：
 * - episode 锚点 = 根触发消息（role='user'；U 根用户任务 / H 根交接消息，双根语义）
 * - 判定优先级 1-5：running 在途 skip / completed 按 reject·suggest 时序 / 非重启失败归因 /
 *   server_restart 或零执行超窗 abandoned / 其他 unclassified
 * - chain_task_id = **链锚** = 根触发消息的 messages.task_id（T-G：全链同锚，下游判词按它 JOIN）。
 *   原实现抄**链末 execution_log.trace_id**——那是**当轮**执行追踪 id，不是锚：实测 958 条
 *   执行行里 706 条（73.7%）两者不等，导致真实链 `f352c2e7`（锚 `28aa26c4`）查 0 行，
 *   而该锚名下实有 17 条消息 + 1 条 suggest 判词 ⇒ 打回检测形同不存在（G2 已被 T-E 推翻）。
 * - 零执行扫描：role='user' > 30min 无 execution_log 引用 → abandoned（chain_task_id=NULL，G2-N5）
 * - G3 三阶 H 根判定（task_id 匹配既有 episode / N9 内容特征精确前缀 / U 已知噪声兜底）
 */

import { v4 as uuid } from 'uuid'
import { getDb } from '../db/index.js'
import type { ExecutionLogRow } from '../db/repository/types.js'
import { getChainRejectionsSince } from './chain-verdicts.js'

/** 判定规则版本号（P5 全量重评承重：规则升级时改此常量，全量 upsert 重评覆盖历史结局） */
export const EPISODE_CLASSIFICATION_VER = 'v2.1'

/** 零执行扫描超窗（分钟）：落库未调度静默丢的判定窗口（规格 G2-N5） */
export const ZERO_EXECUTION_WINDOW_MINUTES = 30

/** 7 类结局 */
export type EpisodeOutcome =
  | 'success'
  | 'corrected_success'
  | 'needs_investigation'
  | 'harness_fix_needed'
  | 'routing_failure'
  | 'abandoned'
  | 'unclassified'

/** 双根语义：U 根用户任务 / H 根交接审查链 */
export type RootTriggeredBy = 'U' | 'H'

export type EpisodeState = 'open' | 'classified' | 'closed'

/** 候选根消息最小字段集 */
export interface RootMessageRow {
  id: string
  session_id: string
  content: string
  task_id: string | null
  created_at: string
}

// ─── H 根内容特征（N9 第九轮钉死）───────────────────

/**
 * handoff-gen 精确前缀 `@<猫名> 请补填以下交接文档`（buildHandoffMessage 唯一生成源，
 * handoff-gen.mjs:765；socketio.ts:1740 既有 startsWith 先例）。role='user' 的 H 根
 * 仅此一种来源——审查请求是 agent 回复、performHandoff 不插消息表。
 */
const HANDOFF_CONTENT_PREFIX = /^@[^\s@]+ 请补填以下交接文档/

// ─── G3 三阶 H 根判定 ─────────────────────────────────

/**
 * 判定根消息的 root_triggered_by（G3 第八轮修 + G5 第九轮补全 + N9 内容特征钉死）：
 * 1. task_id 非 NULL 且已有 episode 的 chain_task_id = 该 task_id（交接延续）→ 'H'
 * 2. 带交接文档内容特征（E3 接线前唯一可工作的 H 根判定）→ 'H'
 * 3. 其他（task_id 为空或无匹配 episode 且无内容特征）→ 'U' 已知噪声，
 *    仍生成 episode——task_id 非 NULL 无匹配时不漏出判定阶梯（G5）
 */
export function determineRootTriggeredBy(
  msg: Pick<RootMessageRow, 'task_id' | 'content'>,
  taskIdMatchesEpisode: boolean
): RootTriggeredBy {
  if (msg.task_id && taskIdMatchesEpisode) return 'H'
  if (HANDOFF_CONTENT_PREFIX.test(msg.content)) return 'H'
  return 'U'
}

/** 是否存在 chain_task_id = taskId 的既有 episode（G3 判定 1 的匹配源） */
function hasEpisodeWithChainTaskId(taskId: string): boolean {
  const row = getDb().prepare('SELECT 1 FROM episodes WHERE chain_task_id = ? LIMIT 1').get(taskId)
  return row !== undefined
}

// ─── 执行链收集 ───────────────────────────────────────

/**
 * 收集根消息的直接/间接执行链（A2A 递归：agent 回复若再触发执行，经
 * message_id 续查）。深度上限防异常循环。链末 = started_at 最晚的执行行。
 * 导出供 E2 归因分流器复用（closure 复验重跑判定需独立收集执行链）。
 */
export function collectChain(rootMsgId: string): ExecutionLogRow[] {
  const db = getDb()
  const chain: ExecutionLogRow[] = []
  const frontier = new Set<string>([rootMsgId])
  let depth = 0
  while (frontier.size > 0 && depth < 20) {
    const ids = [...frontier]
    frontier.clear()
    const placeholders = ids.map(() => '?').join(',')
    const logs = db
      .prepare(`SELECT * FROM execution_logs WHERE triggered_by_message_id IN (${placeholders})`)
      .all(...ids) as ExecutionLogRow[]
    for (const l of logs) {
      chain.push(l)
      // agent 回复消息若被 dispatch 再派发（@ 其他 agent），续查下一层
      if (l.message_id) frontier.add(l.message_id)
    }
    depth++
  }
  return chain
}

/**
 * 链锚（T-G）：**优先**取根触发消息的 `messages.task_id`。
 *
 * 锚由 ingest 在首轮显式落库（`anchor = taskId || traceId`），链内每条消息
 * （含 agent 回复，reply.ts `triggerMsg.taskId`）继承同一个值 ⇒ 全链同锚。
 *
 * 为什么不取链末执行行的 `trace_id`：那是**当轮**追踪 id，全链每轮各不相同
 * （实测 958 条执行行里 706 条两者不等），拿它 JOIN `messages.task_id` 常是空集
 * ——真实链 `f352c2e7`（根锚 `28aa26c4`）按旧值查 0 行，按锚查命中 17 条消息 + 1 条 suggest 判词。
 *
 * 存量降级（pre-T-E 落库的链，根 `task_id` 为 NULL）：退到旧近似值（链末执行行的
 * `trace_id`）。**实测代价**：全库 540 条链上判词命中「按锚 3 增 / 4 失」，
 * 4 条失的全是这种 NULL 锚存量链（`3fee9a56` / `e2a9338d` / `4bb97d3a` / `b8961220`，均 2026-08/09 落库）。
 * 退化的理由：**不为修一个缺口制造另一个缺口**；且这批数据不会被重写，降级路径随
 * 存量自然退场。代价是链锚列在存量行上可能仍是「当轮锚」而非「全链锚」——
 * 该歧义属**存量数据面**（只作用于 pre-T-E 落库的行），故此处**只就地说明、不引外部指针**；
 * 新链不受影响。
 */
function chainAnchor(
  rootMsg: Pick<RootMessageRow, 'task_id'>,
  chain: ExecutionLogRow[]
): string | null {
  if (rootMsg.task_id) return rootMsg.task_id
  return legacyTailTrace(chain)
}

/** 旧近似值（T-G 前 `chainTaskId` 的全部实现）——仅存量 NULL 锚链降级用 */
function legacyTailTrace(chain: ExecutionLogRow[]): string | null {
  let tail = chain[0]
  for (const l of chain) {
    if ((l.started_at ?? '') > (tail.started_at ?? '')) tail = l
  }
  return tail?.trace_id ?? null
}

/** 链内 completed 行的最晚完成时刻（ended_at；N1 比较对象） */
function latestCompletedAt(chain: ExecutionLogRow[]): string | null {
  let latest: string | null = null
  for (const l of chain) {
    if (l.status === 'completed' && l.ended_at && (!latest || l.ended_at > latest)) {
      latest = l.ended_at
    }
  }
  return latest
}

// ─── 判定优先级 1-5 ───────────────────────────────────

/** 判定 2：completed 存在 → 按 reject/suggest 时序判结局（G2 + N1；锚源 T-G 修正） */
function classifyCompleted(chain: ExecutionLogRow[], rootMsg: RootMessageRow): EpisodeOutcome {
  // 锚为空只可能发生在「链上一条执行行都没有」——判定 2 已保证有 completed 行，
  // 故此处 anchor 必非空。真正要区分的是「有锚但查无打回」（success，正常）与
  // 「查询未命中」（同判 success 但 chain_task_id 落库可查，见 D2 记账）。
  //
  // 但 `chain_task_id` 列上的 NULL **不是判据**（T-G 补记，原注释在此处被删）：
  // 零执行扫描的 abandoned 行本就落 NULL（G2-N5），存量 pre-T-E 链的根 `task_id`
  // 也是 NULL（降级到链末 trace_id 近似值，实测 4 条判词关联净失）。NULL 是**已知噪声**，
  // 不是「该链无打回」的证据——列上有它，别把它读成结论。
  const anchor = chainAnchor(rootMsg, chain)
  const verdicts = getChainRejectionsSince(anchor, rootMsg.session_id, rootMsg.created_at)
  if (verdicts.length === 0) return 'success'
  // 最近一次 reject/suggest 审查时间（DESC 首行）；N1：比较对象钉死最近打回
  const lastRejectAt = verdicts[0].created_at
  const doneAt = latestCompletedAt(chain)
  // 打回后重做完成 → corrected_success；完成之后仍有打回（未重做）→ needs_investigation
  return doneAt && doneAt > lastRejectAt ? 'corrected_success' : 'needs_investigation'
}

/**
 * 判定 3：无 completed、有非重启失败行 → 按 error_type 归因。
 * - 无明确归因（error_type 全 NULL/unknown）且全部执行行均失败 → routing_failure（路由整体失败）
 * - 有明确归因 → 取最近失败行 error_type 映射：timeout → needs_investigation（配额/网络需调查，
 *   验收 ④' 钉死）；parse_error/tool_error/reasoning_error/context_overflow/iteration_limit
 *   属猫咖 harness 侧（解析/工具/推理/token 预算/循环防护）→ harness_fix_needed
 */
function classifyFailed(chain: ExecutionLogRow[]): EpisodeOutcome {
  const nonInfra = chain.filter(
    (l) => l.status === 'failed' && (l.error_type ?? 'unknown') !== 'server_restart'
  )
  const attributable = nonInfra.filter((l) => l.error_type && l.error_type !== 'unknown')
  if (attributable.length === 0) return 'routing_failure'
  const latest = attributable.sort((a, b) =>
    (b.started_at ?? '') > (a.started_at ?? '') ? 1 : -1
  )[0]
  return latest.error_type === 'timeout' ? 'needs_investigation' : 'harness_fix_needed'
}

/** 单链判定（判定 1-5 全量）。open = 在途不归因（closure 状态机 skip） */
export function classifyChain(
  chain: ExecutionLogRow[],
  rootMsg: RootMessageRow
): { outcome: EpisodeOutcome | null; state: EpisodeState } {
  // 判定 1：在途（有 running 行）→ open，不归因
  if (chain.some((l) => l.status === 'running')) {
    return { outcome: null, state: 'open' }
  }

  // 判定 2：有 completed 行 → 按 reject/suggest 时序
  if (chain.some((l) => l.status === 'completed')) {
    return { outcome: classifyCompleted(chain, rootMsg), state: 'classified' }
  }

  // 判定 3：无非重启失败行 → 归因（N3 口径：COALESCE(error_type,'unknown')，对齐 l1-aggregator.ts:80）
  const hasNonInfraFailure = chain.some(
    (l) => l.status === 'failed' && (l.error_type ?? 'unknown') !== 'server_restart'
  )
  if (hasNonInfraFailure) {
    return { outcome: classifyFailed(chain), state: 'classified' }
  }

  // 判定 4：仅 server_restart 失败（重启打断未恢复）→ abandoned（G1 守卫：前序判定已排除
  // running/completed/非重启失败，此处到达即满足「无 running 且无 completed 且无非重启失败行」）
  if (chain.some((l) => l.status === 'failed')) {
    return { outcome: 'abandoned', state: 'classified' }
  }

  // 判定 5：其他（异常态防御）→ unclassified
  return { outcome: 'unclassified', state: 'classified' }
}

// ─── upsert（验收 ⑥ 幂等）─────────────────────────────

/**
 * upsert 一条 episode。root_trigger_message_id 为冲突键，重复归因覆盖更新不产生重复行。
 * closed 终态守卫（E2）：episode_state='closed' 的行不被定时器重判覆盖——closure
 * 复验确认结局翻转后关闭即终态（规格 §4 状态机 open → classified → closed），
 * 否则每轮 classifyEpisodes 会把 closed 覆盖回 classified，闭环永不落定。
 */
export function upsertEpisode(data: {
  rootTriggerMessageId: string
  rootTriggeredBy: RootTriggeredBy
  rootMessageId: string
  taskId: string | null
  chainTaskId: string | null
  sessionId: string
  outcome: EpisodeOutcome | null
  episodeState: EpisodeState
}): void {
  getDb()
    .prepare(
      `INSERT INTO episodes (id, root_trigger_message_id, root_triggered_by, root_message_id, task_id, chain_task_id, session_id, outcome, episode_state, classification_ver)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(root_trigger_message_id) DO UPDATE SET
         root_triggered_by = excluded.root_triggered_by,
         root_message_id = excluded.root_message_id,
         task_id = excluded.task_id,
         chain_task_id = excluded.chain_task_id,
         session_id = excluded.session_id,
         outcome = excluded.outcome,
         episode_state = excluded.episode_state,
         classification_ver = excluded.classification_ver,
         updated_at = datetime('now')
       WHERE episodes.episode_state != 'closed'`
    )
    .run(
      uuid(),
      data.rootTriggerMessageId,
      data.rootTriggeredBy,
      data.rootMessageId,
      data.taskId,
      data.chainTaskId,
      data.sessionId,
      data.outcome,
      data.episodeState,
      EPISODE_CLASSIFICATION_VER
    )
}

// ─── 零执行扫描（G2-N5 + G3 + G5 + N9）─────────────────

/**
 * 零执行 episode 产生路径：扫描 role='user' 且 > 30min 且无任何 execution_log
 * 引用的消息（落库未调度静默丢）→ 生成 episode（chain_task_id=NULL）判 abandoned。
 * root_triggered_by 走 G3 三阶判定；已生成过（root_trigger_message_id 存在）跳过。
 * 注意：无 @ 的闲聊消息也会生成 abandoned episode——这是「用户发了消息猫咖零响应」
 * 的暴露语义（v2 就是想评这类缺口），规格 G2-N5 明写。
 */
export function scanZeroExecutionEpisodes(): number {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT id, session_id, content, task_id, created_at FROM messages
       WHERE role = 'user'
         AND created_at < datetime('now', '-${ZERO_EXECUTION_WINDOW_MINUTES} minutes')
         AND NOT EXISTS (SELECT 1 FROM execution_logs el WHERE el.triggered_by_message_id = messages.id)
         AND NOT EXISTS (SELECT 1 FROM episodes e WHERE e.root_trigger_message_id = messages.id)
         AND NOT EXISTS (
           SELECT 1 FROM messages r
           WHERE r.session_id = messages.session_id
             AND r.task_id = messages.task_id
             AND r.role = 'agent'
         )`
    )
    .all() as RootMessageRow[]

  let n = 0
  for (const row of rows) {
    const by = determineRootTriggeredBy(
      row,
      row.task_id ? hasEpisodeWithChainTaskId(row.task_id) : false
    )
    upsertEpisode({
      rootTriggerMessageId: row.id,
      rootTriggeredBy: by,
      rootMessageId: row.id,
      taskId: row.task_id,
      chainTaskId: null, // G2-N5：零执行场景无执行链，无锚可抄录（根消息自己的 task_id 已在 taskId 列）
      sessionId: row.session_id,
      outcome: 'abandoned',
      episodeState: 'classified',
    })
    n++
  }
  return n
}

// ─── P5 重评统计（classification_ver 驱动）─────────────

/**
 * 重评统计：按 root_triggered_by × outcome 分组计数 + 版本偏差行数。
 * P5 全量重评承重：规则升级（EPISODE_CLASSIFICATION_VER 变更）后重跑
 * classifyEpisodes() 全量 upsert 覆盖历史结局——versionStale 是「将被覆盖」
 * 的存量行数（信息性输出，重评本身幂等不依赖它）。
 * 任务结局只统计在 U 根 episode 上；H 根（审查链）不参与任务结局计数（G2 拍板）。
 */
export function episodeStats(): {
  versionStale: number
  uRoot: Record<string, number>
  hRoot: Record<string, number>
  open: number
} {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT root_triggered_by, outcome, COUNT(*) AS cnt
       FROM episodes
       GROUP BY root_triggered_by, outcome
       ORDER BY root_triggered_by, outcome`
    )
    .all() as Array<{
    root_triggered_by: RootTriggeredBy
    outcome: EpisodeOutcome | null
    cnt: number
  }>
  const staleRow = db
    .prepare('SELECT COUNT(*) AS cnt FROM episodes WHERE classification_ver != ?')
    .get(EPISODE_CLASSIFICATION_VER) as { cnt: number }

  const stats: ReturnType<typeof episodeStats> = {
    versionStale: staleRow.cnt,
    uRoot: {},
    hRoot: {},
    open: 0,
  }
  for (const r of rows) {
    if (r.outcome === null) {
      stats.open += r.cnt
      continue
    }
    if (r.root_triggered_by === 'U') stats.uRoot[r.outcome] = r.cnt
    else stats.hRoot[r.outcome] = r.cnt
  }
  return stats
}

// ─── 主入口 ───────────────────────────────────────────

/**
 * 全量判定一轮：执行链路径（有执行引用的 user 根消息，上溯锚定 + 判定 1-5）
 * + 零执行扫描路径。返回统计供日志/测试断言。
 */
export function classifyEpisodes(): { upserted: number; open: number } {
  const db = getDb()
  let upserted = 0
  let open = 0

  // 路径一：执行链锚定。触发执行的起点必然是 user 消息或 agent 回复——
  // agent 回复由 collectChain 从根扩展，这里直接取有执行引用的 user 根。
  const roots = db
    .prepare(
      `SELECT DISTINCT m.id, m.session_id, m.content, m.task_id, m.created_at
       FROM messages m
       JOIN execution_logs el ON el.triggered_by_message_id = m.id
       WHERE m.role = 'user'`
    )
    .all() as RootMessageRow[]

  for (const root of roots) {
    const chain = collectChain(root.id)
    const { outcome, state } = classifyChain(chain, root)
    const by = determineRootTriggeredBy(
      root,
      root.task_id ? hasEpisodeWithChainTaskId(root.task_id) : false
    )
    upsertEpisode({
      rootTriggerMessageId: root.id,
      rootTriggeredBy: by,
      rootMessageId: root.id,
      taskId: root.task_id,
      chainTaskId: chainAnchor(root, chain),
      sessionId: root.session_id,
      outcome,
      episodeState: state,
    })
    if (state === 'open') open++
    else upserted++
  }

  upserted += scanZeroExecutionEpisodes()
  return { upserted, open }
}
