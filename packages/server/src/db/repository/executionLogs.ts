/**
 * Execution Log 表查询函数。
 */
import type Database from 'better-sqlite3'
import type { ExecutionLogRow } from './types.js'
import type { ExecHopRow } from '../../eval/chain-query.js'

let db: Database.Database

export function setRepoDb(dbInst: Database.Database): void {
  db = dbInst
}

// ─── 查询 ──────────────────────────────────────────────

export function getRunningLogs(): Array<{ id: string; agent_id: string }> {
  return db
    .prepare("SELECT id, agent_id FROM execution_logs WHERE status = 'running'")
    .all() as Array<{ id: string; agent_id: string }>
}

/** 启动时获取被 server 重启打断的执行（fixStuckExecutionLogs 标记后）。
 *  供重启恢复队列使用——重新 dispatch 这些未完成的执行。
 *  message_id：洞 A 精确判据——非空即该执行已完成并写回回复 id，恢复跳过；
 *  NULL（历史记录/被打断未回复）→ 恢复回退时间窗判据。 */
export function getInterruptedExecutions(): Array<{
  id: string
  session_id: string
  agent_id: string
  triggered_by_message_id: string
  started_at: string
  message_id: string | null
}> {
  return db
    .prepare(
      `SELECT id, session_id, agent_id, triggered_by_message_id, started_at, message_id
       FROM execution_logs
       WHERE status = 'failed' AND error_message = 'server_restart'
       ORDER BY started_at ASC`
    )
    .all() as Array<{
    id: string
    session_id: string
    agent_id: string
    triggered_by_message_id: string
    started_at: string
    message_id: string | null
  }>
}

export function getLogsByTriggerMessage(triggeredByMessageId: string): ExecutionLogRow[] {
  return db
    .prepare('SELECT * FROM execution_logs WHERE triggered_by_message_id = ?')
    .all(triggeredByMessageId) as ExecutionLogRow[]
}

/** 执行者反查的候选行形状（三个反查函数共用）。 */
export interface ExecutorLookup {
  agent_id: string
  name: string
  trace_id: string
  task_id: string | null
}

/** 从候选执行行里**唯一**指认执行者（T-M）。
 *  同一 agent 的多行（重试 / 重放）**不算歧义**——执行者是同一只猫；跨 agent 才算。
 *  不可消歧 ⇒ `undefined`（**不猜**）：T-M 治的正是「`ORDER BY started_at DESC LIMIT 1`
 *  取最近」在双执行者下有一半概率指向非作者（合成实验：同 uuid 双 running、只有后者提交，
 *  反查却返回后者——刚好对；把 started_at 反过来就恒错）。
 *  判据取 **distinct agent** 而非行数：同 agent 多行时执行者是确定的，按行数拒会把
 *  "同一只猫重试"误判成歧义、白丢归属。 */
function pickSingleExecutor<T extends { agent_id: string }>(rows: T[]): T | undefined {
  if (rows.length === 0) return undefined
  const first = rows[0]
  for (const row of rows) {
    if (row.agent_id !== first.agent_id) return undefined
  }
  return first
}

/** 反查"执行某条消息"的 agent（handoff-gen 动态补填人用）。
 *  一条消息可触发多个 agent（多人 @）——**跨 agent 不再"取最近"猜**（T-M）：
 *  那是双执行者下 50% 指错人的根因，改为返回 undefined（调用方退回兜底 @店长）。
 *  同一 agent 多行时取最近开始执行的一条。无记录返回 undefined。
 *
 *  `task_id`（T-I）：**链锚**，取该执行行触发的那条消息的 `messages.task_id`
 *  （一跳 JOIN）。与 `trace_id` 是两个不同的东西——`trace_id` 是**当轮**执行追踪 id，
 *  显式锚投递下两者必然不等；谁要"链锚"谁拿 `task_id`，谁要"这一轮执行"谁拿 `trace_id`。
 *  LEFT JOIN：消息行缺失（存量/手工造的 fixture）时仍返回执行者本身，只把 task_id 置空
 *  ——不因加 JOIN 改变"有无执行行"的判据（404 语义归调用方）。 */
export function getExecutorNameByTriggeredBy(
  triggeredByMessageId: string
): ExecutorLookup | undefined {
  const rows = db
    .prepare(
      `SELECT el.agent_id, a.name, el.trace_id, m.task_id
       FROM execution_logs el
       JOIN agents a ON a.id = el.agent_id
       LEFT JOIN messages m ON m.id = el.triggered_by_message_id
       WHERE el.triggered_by_message_id = ?
       ORDER BY el.started_at DESC`
    )
    .all(triggeredByMessageId) as ExecutorLookup[]
  return pickSingleExecutor(rows)
}

/** 该触发消息是否存在**可反查的执行行**（INNER JOIN agents，与上面两个反查同口径）。
 *  只回答"有没有行"，不回答"是谁"——`/executor` 用它区分两种失败（T-M）：
 *    - 无行 → 404（"该消息没有任何执行行"，既有语义）
 *    - 有行但不可消歧 → 200 + `ambiguous:true`（**不能报 404**：`probeAttribution`
 *      拿 404 当"无归属 ⇒ 钩子兜底投递"，把"指不出人"报成 404 会让有归属的 agent
 *      提交被钩子多投一轮——正是 T-A / T-H 要止住的形态）。
 *  口径与反查一致（INNER JOIN agents）：agent 行被删的行不算"可反查"，保持既有
 *  「删 agent ⇒ 404 ⇒ 多投」的安全方向不变。 */
export function hasExecutorRowsForTrigger(triggeredByMessageId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS hit FROM execution_logs el
       JOIN agents a ON a.id = el.agent_id
       WHERE el.triggered_by_message_id = ? LIMIT 1`
    )
    .get(triggeredByMessageId) as { hit: number } | undefined
  return row !== undefined
}

/** R2 轮次级 span（`git.auto_commit`）的归属行：该触发消息**唯一**执行者那一行。
 *
 *  depth=0 的自动提交在**全部 `execute()` 返回之后**跑，此刻每个执行体的 trace 都已
 *  在 `finalizeRun` 落库 ⇒ 「把提交段塞进某次执行」需要反查归属。判据与
 *  `updateExecutionLogCommitHash`（T-M）**逐字同源**：同一 agent 的多行（重试/重放）
 *  不算歧义，跨 agent 才算——那边拒写 sha，这边拒写段，两个消费点同一口径。
 *  不可消歧 ⇒ `undefined`（**不猜**，调用方跳过该段：缺 ≠ 失败，R2 §九 26）。
 *
 *  返回 `id` 而非 `agent_id`：span 要挂的是 `execution_logs.id`（`spans.execution_id`）。 */
export function getUnambiguousExecutionRow(
  triggeredByMessageId: string
): { id: string; agent_id: string; session_id: string } | undefined {
  const rows = db
    .prepare(
      `SELECT id, agent_id, session_id FROM execution_logs
       WHERE triggered_by_message_id = ?
       ORDER BY started_at DESC`
    )
    .all(triggeredByMessageId) as Array<{ id: string; agent_id: string; session_id: string }>
  return pickSingleExecutor(rows)
}

/** 反查"提交某 commit"的 agent（handoff-gen 动态补填人，commit_hash 精确匹配）。
 *  commit 由实施者提交时经 POST /api/messages/:id/commit-hash 写回
 *  （updateRunningExecutionCommitHash），同 uuid 多执行者时各 commit 各命中
 *  各的实施者，不再"取最近开始执行"误指。无记录返回 undefined。
 *  **跨 agent 命中多行时同样不猜**（T-M）：一个 sha 落到两只猫的行上（无 agentId 的
 *  全刷 / 自动提交快照制造出来的），谁是真作者已不可知 → undefined，而不是按
 *  started_at 挑一个。同 agent 多行取最近。
 *  trace_id 一并返回——`/api/handoff/verdict` 的判据链仍走它
 *  （commit_hash → execution_logs → trace_id → review_verdicts）。
 *  task_id（T-I）同上：**链锚**取触发消息的 `messages.task_id`，供 `/executor`
 *  回传给 handoff-gen 当交接文档的锚。 */
export function getExecutorNameByCommitHash(commitHash: string): ExecutorLookup | undefined {
  const rows = db
    .prepare(
      `SELECT el.agent_id, a.name, el.trace_id, m.task_id
       FROM execution_logs el
       JOIN agents a ON a.id = el.agent_id
       LEFT JOIN messages m ON m.id = el.triggered_by_message_id
       WHERE el.commit_hash = ?
       ORDER BY el.started_at DESC`
    )
    .all(commitHash) as ExecutorLookup[]
  return pickSingleExecutor(rows)
}

/** 反查"该 agent 当前 running 执行"的 commit_hash（T-A ② 收尾兜底判据）。
 *  定位口径与 finalizeExecutionLog 完全一致（agent 最新 running）——**必须在
 *  finalizeExecutionLog 之前调用**，否则行已 completed、恒 undefined。
 *  无 commit 链路（纯会话执行/写回未发生）返回 undefined。 */
export function getRunningExecutionCommitHash(agentId: string): string | undefined {
  const row = db
    .prepare(
      `SELECT commit_hash FROM execution_logs
       WHERE agent_id = ? AND status = 'running'
       ORDER BY started_at DESC LIMIT 1`
    )
    .get(agentId) as { commit_hash: string | null } | undefined
  return row?.commit_hash ?? undefined
}

/** 按 trace_id 反查 commit_hash（契约③ 状态机推进的定位键）。
 *  审查链 verdict 消息的 task_id = 源链 trace_id（E3 接线），源链执行行挂 commit_hash——
 *  反查被审 commit 供 flow_states 推进。无 commit 链路的执行行（纯会话/未写回）返回 undefined。 */
export function getCommitHashByTraceId(traceId: string): string | undefined {
  const row = db
    .prepare(
      `SELECT commit_hash FROM execution_logs WHERE trace_id = ? AND commit_hash IS NOT NULL
       ORDER BY started_at DESC LIMIT 1`
    )
    .get(traceId) as { commit_hash: string } | undefined
  return row?.commit_hash
}

export function getAgentStats(agentId: string): {
  total_prompt: number
  total_completion: number
  total_calls: number
} {
  return db
    .prepare(
      `SELECT
         COALESCE(SUM(prompt_tokens), 0) AS total_prompt,
         COALESCE(SUM(completion_tokens), 0) AS total_completion,
         COUNT(*) AS total_calls
       FROM execution_logs
       WHERE agent_id = ? AND status = 'completed'`
    )
    .get(agentId) as { total_prompt: number; total_completion: number; total_calls: number }
}

/** 按 session 查全部 execution 的展示列投影（message_id 关联回复气泡）。
 *  message_id = execution_logs.message_id（finalize 写回 replyMessageId，成功路径精确 1:1；
 *  失败/中断为 NULL——展示耗时/token 只关心成功回复，够用）。
 *  ⚠️ 禁用 triggered_by_message_id 作回复消息关联：那是「触发消息」（一条广播/@ 可触发
 *  多个 agent → N:1），关联回复气泡会混淆（店长裁决，别踩反）。
 *  只投影展示所需列，避免整行含 error_message 等无关字段。 */
export function getExecutionsBySession(sessionId: string): Array<{
  message_id: string | null
  agent_id: string
  status: string
  latency_ms: number | null
  prompt_tokens: number | null
  completion_tokens: number | null
  started_at: string | null
}> {
  return db
    .prepare(
      `SELECT message_id, agent_id, status, latency_ms, prompt_tokens, completion_tokens, started_at
       FROM execution_logs
       WHERE session_id = ?`
    )
    .all(sessionId) as Array<{
    message_id: string | null
    agent_id: string
    status: string
    latency_ms: number | null
    prompt_tokens: number | null
    completion_tokens: number | null
    started_at: string | null
  }>
}

export function getAgentSessionStats(
  agentId: string,
  sessionId: string
): { session_prompt: number; session_completion: number } {
  return db
    .prepare(
      `SELECT
         COALESCE(SUM(prompt_tokens), 0) AS session_prompt,
         COALESCE(SUM(completion_tokens), 0) AS session_completion
       FROM execution_logs
       WHERE agent_id = ? AND session_id = ? AND status = 'completed'`
    )
    .get(agentId, sessionId) as { session_prompt: number; session_completion: number }
}

/**
 * 链路查询取数（P1-A）——execution_logs 行 + 链锚 + 猫名。
 *
 * **链锚** `COALESCE(回复消息.task_id, 触发消息.task_id)`（地图 Decisions 已裁死，
 * 覆盖率 97.4%）：单用触发侧丢 32.5%、单用回复侧丢 7.5%，**别改回单侧**。
 * 锚为 NULL 的行是**孤儿跳**（dev 库实测 28 行 ≈ 2.6%），由 `buildChains` 归入
 * `orphanChain`——**本函数不筛掉它们**，筛掉等于把卡点静默丢弃。
 *
 * 时间窗口径与 `eval/l1-aggregator.ts` 一致（`started_at >= datetime('now','-N days')`）。
 * 只取数不做变换——分组/段算/flags/排序/截断全归 `eval/chain-query.ts` 的纯函数。
 *
 * @param windowDays 窗口天数（拼进 `datetime('now', ?)` 的修饰符，非字符串插值）
 */
export function getExecutionHopsWithChainAnchor(windowDays: number): ExecHopRow[] {
  return db
    .prepare(
      `SELECT el.id AS execution_log_id, el.agent_id, a.name AS agent_name,
              el.status, el.error_type, el.started_at, el.ended_at,
              el.latency_ms, el.reply_chars, el.message_id,
              el.triggered_by_message_id,
              COALESCE(rm.task_id, tm.task_id) AS chain_id
       FROM execution_logs el
       JOIN agents a ON a.id = el.agent_id
       LEFT JOIN messages rm ON rm.id = el.message_id
       LEFT JOIN messages tm ON tm.id = el.triggered_by_message_id
       WHERE el.started_at >= datetime('now', ?)`
    )
    .all(`-${windowDays} days`) as ExecHopRow[]
}

// ─── 写入 ──────────────────────────────────────────────

export function insertExecutionLog(
  id: string,
  sessionId: string,
  agentId: string,
  triggeredByMessageId: string,
  traceId: string
): void {
  db.prepare(
    `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, trace_id, status, started_at)
     VALUES (?, ?, ?, ?, ?, 'running', datetime('now'))`
  ).run(id, sessionId, agentId, triggeredByMessageId, traceId)
}

/** 标记执行完成/失败。
 *  replyMessageId：成功路径写回本次回复的消息 id（洞 A 精确判据——重启恢复时
 *  message_id 非空即已回复，不再用时间窗把后续其他回复误判成本次回复）；
 *  失败/中断路径不传保持 NULL，恢复回退时间窗判据。
 *  errorType：L1 错误分类桶（W1 契约）——必须与 status/error_message **同一条
 *  UPDATE** 带走（finalize 按 agent 最新 running 定位、无 id，二次更新在重启
 *  恢复时会把恢复后新执行的错误错配到旧行）。
 *
 *  **latency_ms 用 COALESCE（P1 采集修复）**：成功路径的耗时由
 *  `updateExecutionLogDiagnostics` 先写、`finalizeExecutionLog` 后擦（opts 里没有
 *  latencyMs，impl 传 null）——修复前该列 100% 被擦成 NULL。要求：
 *  1. **永不擦除已记录的耗时**：传 null + 行内已有值 → 保留 → 传 null + 行内也 null
 *     → 仍 null。**不能写成 0**——0 是「瞬间完成」，与「无数据」是两回事。
 *  2. **不把 latencyMs 穿线到 completeExecution**（架构裁决）：穿线要动
 *     EngineCtx.completeExecution 接口 + finalizeRun opts + 3 个调用点；更糟的是
 *     本函数按 `agent_id + 最新 running` 定位（**WHERE 里没有 sessionId**），同一只猫
 *     跨会话并行时穿线会把 A 执行的耗时刻到 B 行上——COALESCE 只读行内已有值，不会串。 */
export function finalizeExecutionLog(
  agentId: string,
  status: 'completed' | 'failed',
  latencyMs: number | null,
  errorMessage: string | null,
  replyMessageId: string | null = null,
  errorType: string | null = null
): void {
  db.prepare(
    `UPDATE execution_logs
     SET status = ?, ended_at = datetime('now'),
         latency_ms = COALESCE(?, latency_ms), error_message = ?, message_id = ?, error_type = ?
     WHERE agent_id = ? AND status = 'running'
     ORDER BY started_at DESC LIMIT 1`
  ).run(status, latencyMs, errorMessage, replyMessageId, errorType, agentId)
}

/** 写回诊断数据（延迟、安装包、token 统计等） */
export function updateExecutionLogDiagnostics(
  agentId: string,
  data: {
    latencyMs: number
    packagesInstalled: string
    promptChars: number
    replyChars: number
    promptTokens: number
    completionTokens: number
  }
): void {
  db.prepare(
    `UPDATE execution_logs
     SET latency_ms = ?,
         packages_installed = ?,
         prompt_chars = ?,
         reply_chars = ?,
         prompt_tokens = ?,
         completion_tokens = ?
     WHERE agent_id = ? AND status = 'running'
     ORDER BY started_at DESC LIMIT 1`
  ).run(
    data.latencyMs,
    data.packagesInstalled,
    data.promptChars,
    data.replyChars,
    data.promptTokens,
    data.completionTokens,
    agentId
  )
}

/** 该触发消息的执行行跨了几只**不同的猫**。>1 = 归属不可消歧（T-M 两条写路径共用）。 */
function distinctAgentCount(triggeredByMessageId: string, onlyRunning: boolean): number {
  const rows = db
    .prepare(
      `SELECT DISTINCT agent_id FROM execution_logs
       WHERE triggered_by_message_id = ?${onlyRunning ? " AND status = 'running'" : ''}`
    )
    .all(triggeredByMessageId) as Array<{ agent_id: string }>
  return rows.length
}

/** depth=0 自动提交写回：把本轮自动生成的那个 commit 记到该触发消息的**全部**执行行上
 *  （round 级快照，不是"某只猫的执行产物"）。
 *
 *  **为什么不过滤 `status`**（T-M 实测裁定）：唯一调用点（`execution/serial.ts` 的
 *  depth=0 收尾块）在所有 `execute()` 返回**之后**执行，而每个 execute 的收口漏斗
 *  （`finalizeRun` → `completeExecution` → `finalizeExecutionLog`）已在返回前把行置终态
 *  ⇒ 给这里加 `status='running'` 过滤会让该路径**恒为空操作**（不是收窄，是废掉它）。
 *  合成实验：ended + 2×running 三行，现实现 changes=3（ended 行确实被盖）。
 *
 *  **收窄点改为消歧**：该触发消息的执行行跨多只猫时，这个"本轮快照"sha 无法指认作者，
 *  刷上去只会让读侧反查从"猜"变成"更自信地猜" ⇒ 拒写并回报 `skippedAmbiguous`，
 *  归属留空（读侧反查返 undefined → 调用方兜底 @店长）。单猫轮次照写（含已终态行，
 *  那正是本函数存在的意义）。 */
export function updateExecutionLogCommitHash(
  triggeredByMessageId: string,
  commitHash: string
): { changes: number; skippedAmbiguous: boolean } {
  if (distinctAgentCount(triggeredByMessageId, false) > 1) {
    return { changes: 0, skippedAmbiguous: true }
  }
  const r = db
    .prepare('UPDATE execution_logs SET commit_hash = ? WHERE triggered_by_message_id = ?')
    .run(commitHash, triggeredByMessageId)
  return { changes: r.changes, skippedAmbiguous: false }
}

/** post-commit 写回：把本次 commit 的 hash 记到"仍 running 的执行记录"上。
 *  agentId：post-commit → handoff-gen 继承 claude.ts spawn env 注入的
 *  CATSTUDY_AGENT_ID（dispatch 派发子进程自带），按 agent_id 精确命中自己的
 *  执行行——同 uuid 双 running（双猫同时执行，店长一条消息派两单）时
 *  两个 commit 各刷各的行，互不覆盖（`eae5a5e` 是**实害化**锚——该 sha 的改动
 *  本身是 handoff-gen 审查须知绝对引用，不是本竞态的修复；按 agent_id 精确化的
 *  根治是 `0fe8292`，双 running 写回互覆实害化后裁决）。
 *  无 agentId（开发者终端手动提交，env 不存在）走 fallback：running 过滤 + 全刷。
 *  **但全刷前先消歧**（T-M）：该 uuid 的 running 行跨**多只不同的猫**时，无法判断
 *  这个 commit 是谁提交的——刷上去等于给每只猫都记一笔"我提交了它"，读侧只能按
 *  `started_at` 猜（合成实验：双 running 全刷 changes=2，反查返回 started_at 靠后的
 *  那只，与真实作者无关）。此时**拒写**（changes=0 + `skippedAmbiguous`），归属留空
 *  让调用方兜底 @店长，而不是制造一条"看似精确"的错归属。
 *  同一只猫的多个 running 行（重试）不算歧义——执行者是同一只猫。 */
export function updateRunningExecutionCommitHash(
  triggeredByMessageId: string,
  commitHash: string,
  agentId?: string
): { changes: number; skippedAmbiguous: boolean } {
  if (agentId) {
    const r = db
      .prepare(
        `UPDATE execution_logs SET commit_hash = ?
         WHERE triggered_by_message_id = ? AND status = 'running' AND agent_id = ?`
      )
      .run(commitHash, triggeredByMessageId, agentId)
    return { changes: r.changes, skippedAmbiguous: false }
  }
  if (distinctAgentCount(triggeredByMessageId, true) > 1) {
    return { changes: 0, skippedAmbiguous: true }
  }
  const r = db
    .prepare(
      `UPDATE execution_logs SET commit_hash = ?
       WHERE triggered_by_message_id = ? AND status = 'running'`
    )
    .run(commitHash, triggeredByMessageId)
  return { changes: r.changes, skippedAmbiguous: false }
}

/** 启动时修复：将所有 running 状态标记为 failed。
 *  error_type 同 UPDATE 落 'server_restart'（W1 契约：infra 桶单独统计，
 *  不进成功率不进告警；同 UPDATE 契约与 finalizeExecutionLog 一致）。 */
export function fixStuckExecutionLogs(): { changes: number } {
  return db
    .prepare(
      `UPDATE execution_logs
       SET status = 'failed',
           ended_at = datetime('now'),
           error_message = 'server_restart',
           error_type = 'server_restart'
       WHERE status = 'running'`
    )
    .run()
}

// ─── 删除 ──────────────────────────────────────────────

export function deleteExecutionLogsByAgent(agentId: string): void {
  db.prepare('DELETE FROM execution_logs WHERE agent_id = ?').run(agentId)
}

export function deleteExecutionLogsBySession(sessionId: string): { changes: number } {
  return db.prepare('DELETE FROM execution_logs WHERE session_id = ?').run(sessionId)
}

export function deleteExecutionLogsByTriggerMessage(triggeredByMessageId: string): void {
  db.prepare('DELETE FROM execution_logs WHERE triggered_by_message_id = ?').run(
    triggeredByMessageId
  )
}

/** 启动时清理：删除已不存在的 Agent 的执行日志 */
export function deleteGhostExecutionLogs(): { changes: number } {
  return db
    .prepare('DELETE FROM execution_logs WHERE agent_id NOT IN (SELECT id FROM agents)')
    .run()
}

export function deleteAllExecutionLogs(): void {
  db.exec('DELETE FROM execution_logs')
}
