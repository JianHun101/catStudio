/**
 * 链锚作用域的判词查询 —— T-G「按锚查」的**单一实现**。
 *
 * 锚 = `messages.task_id`（T-E：首轮锚 = 该轮 trace_id，全链同锚）。
 *
 * 为什么必须有这一个模块：本票之前，三个消费方各写各的「窗口近似值 / 执行 trace 近似值」——
 * - `eval/episodes.ts` 用**链末 execution_log.trace_id** 当锚 → 实测 958 条执行行里
 *   **706 条（73.7%）** 的 `trace_id ≠ 触发消息.task_id`（`trace_id` 是**当轮**执行追踪 id，
 *   显式锚投递下两者必然不等）⇒ 真实链 `f352c2e7`（锚 `28aa26c4`）查 0 行、而该锚名下
 *   实有 17 条消息 + 1 条 suggest 判词 ⇒ 打回检测形同不存在。
 * - `execution/hints.ts` 用**可见窗口内最近一条审查者消息**当结论 → 陈旧 ⚠️ 无限重放。
 * - `execution/flow-advance.ts` 用 `trace_id` 反查 commit（该半条归 `db/`，本票只交规格）。
 *
 * 三者同族：**拿近似值当权威**。本模块把「按锚查判词」收敛成一处，消费方不再各自造句。
 */

import { getDb } from '../db/index.js'
import { normalizeIsoMs } from '../db/repository/clock.js'
import type { ReviewVerdict } from './review-verdict-markers.js'

export interface ChainVerdictRow {
  message_id: string
  verdict: ReviewVerdict
  created_at: string
  reviewer_agent_id: string
  subject_agent_id: string | null
}

/**
 * 锚名下**最新一条**判词（四档全取，不筛 verdict）。
 *
 * 为什么是「最新」而不是「曾出现闭环档」：`hasClosedVerdictByTaskId`
 * （`db/repository/verdicts.ts:60`）是链级 `LIMIT 1` 存在性——「先 ✅ 后新 commit 再 ⚠️」
 * 的链上它恒真。判「这条链现在还有没有待处理的返工」必须看**最新那条**。
 *
 * 无锚（空/未定义）→ undefined（无锚即无链，不猜）；有锚无判词 → undefined。
 * 两者对消费方都等价于「无待处理判词」，但**不与「查到了一条闭环判词」混同**。
 *
 * tie-break 用 `m.rowid`（messages 的插入序）而非 `v.message_id`：message_id 是 uuid，
 * 字典序与时间无关——同秒落库的两条判词谁胜出会是随机的（T-G 补，原写法如此）。
 *
 * **承重面只有 `getLatestChainVerdict`**：`LIMIT 1` 下胜者的 `verdict` 不同，选错就是
 * 「该返工的判成通过」。`getChainRejectionsSince` 沿用同一 ORDER BY 只为**口径一致**，
 * 它的 `[0]` 只被 `episodes.ts:175` 取 `.created_at` 用——同秒并列时两边**同值**，
 * `classifyCompleted` 结局逐字不变（理由别讲过头：改这里不是为修 corrected_success）。
 */
export function getLatestChainVerdict(
  anchor: string | null | undefined,
  sessionId: string
): ChainVerdictRow | undefined {
  if (!anchor) return undefined
  return getDb()
    .prepare(
      `SELECT v.message_id, v.verdict, v.created_at, v.reviewer_agent_id, v.subject_agent_id
       FROM review_verdicts v
       JOIN messages m ON m.id = v.message_id
       WHERE m.task_id = ? AND m.session_id = ?
       ORDER BY v.created_at DESC, m.rowid DESC
       LIMIT 1`
    )
    .get(anchor, sessionId) as ChainVerdictRow | undefined
}

/**
 * 锚名下 `since` 之后（严格晚于）的**打回档**判词（reject / suggest），DESC。
 *
 * `since` 传根触发消息的 `created_at`——只数「这条链自己产生过的打回」，
 * 不把锚被复用前的历史算进来。
 *
 * ⚠️ **两侧口径不同，必须归一后再比**（票 6 起）：`since` 来自 `messages.created_at`
 * （仍是秒级串，票 5 才转），而 `v.created_at` 已是 ISO 毫秒——直接比就是格式混比，
 * 「严格晚于」恒真。判据同 `db/repository/clock.ts::normalizeIsoMs`。
 */
export function getChainRejectionsSince(
  anchor: string | null | undefined,
  sessionId: string,
  since: string
): ChainVerdictRow[] {
  if (!anchor) return []
  return getDb()
    .prepare(
      `SELECT v.message_id, v.verdict, v.created_at, v.reviewer_agent_id, v.subject_agent_id
       FROM review_verdicts v
       JOIN messages m ON m.id = v.message_id
       WHERE m.task_id = ? AND m.session_id = ?
         AND v.created_at > ?
         AND v.verdict IN ('reject', 'suggest')
       ORDER BY v.created_at DESC, m.rowid DESC`
    )
    .all(anchor, sessionId, normalizeIsoMs(since)) as ChainVerdictRow[]
}
