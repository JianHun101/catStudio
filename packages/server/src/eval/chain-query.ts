/**
 * 链结构纯变换 —— P1-A「哪条链耗时最长 / 卡在哪一跳」的**唯一组装实现**。
 *
 * **组件边界**：只做「原始行 → 链结构」的纯变换，零 I/O（不碰 DB、不碰 Fastify）。
 * 取数归 `db/repository/executionLogs.ts`，HTTP 归 `routes/eval.ts`。
 * 这样分组 / 段算 / flags / 排序 / 截断可以脱库全量单测（见 chain-query.test.ts）。
 *
 * **链锚** = `COALESCE(回复消息.task_id, 触发消息.task_id)`（地图 Decisions 已裁死，
 * 覆盖率 97.4%）——单用触发侧丢 32.5%、单用回复侧丢 7.5%，**别改回单侧**。
 * 锚为 NULL 的行是**孤儿跳**，只落 `orphanChain`，不进 `chains[]`。
 */

/** repo 产出的原始行（形状与取数 SQL 的 SELECT 别名一一对应） */
export interface ExecHopRow {
  execution_log_id: string
  agent_id: string
  agent_name: string
  status: string
  error_type: string | null
  started_at: string | null
  ended_at: string | null
  latency_ms: number | null
  reply_chars: number | null
  message_id: string | null
  triggered_by_message_id: string
  chain_id: string | null
}

/** 卡点标记。四值**互不排斥**（P1 裁决 = 全标不筛选）——一个跳可以同时 failed + no_reply + slow。 */
export type HopFlag = 'failed' | 'no_reply' | 'slow' | 'no_data'

export interface ChainHop {
  executionLogId: string
  agentId: string
  agentName: string
  status: string
  errorType: string | null
  /** SQLite 原样 UTC 字符串（`YYYY-MM-DD HH:MM:SS`），**不做时区转换**——转换归前端 */
  startedAt: string | null
  endedAt: string | null
  /** `ended_at − started_at`。两列都是 `datetime('now')` 写的 **UTC 字符串、精度 1 秒**
   *  ⇒ 本值必是 1000 的整数倍，**不是毫秒精度**（对照 `replyMs`）。`ended_at` 为 null → null。 */
  totalMs: number | null
  /** = `latency_ms`，进程内 `Date.now()` 算的，**毫秒精度**。
   *  语义 = 上下文过滤 + 记忆检索 + LLM 流式 + 落库——**不只是 LLM**。 */
  replyMs: number | null
  /** = `totalMs − replyMs`（钳到 ≥0）。语义 = 等 token 锁 + 编排收尾 + 建行开销
   *  ——等锁是主要成分，**占比未实测**。字段名刻意用中性词：
   *  `t0` 在 `runAgentReply` **内部**（`reply.ts:207`），而 token 获取在它**之前**，
   *  故残余段 ≠ 等锁。**禁用 `lockWaitMs` 之类命名**——会报假数。 */
  nonReplyMs: number | null
  /** `totalMs − replyMs < 0`：秒级舍入造成的负值，**钳位但显式暴露**，不静默 */
  segmentClamped: boolean
  flags: HopFlag[]
  triggerMessageId: string
  replyMessageId: string | null
}

export interface Chain {
  chainId: string
  /** 链内最早 `started_at`（原样 UTC 字符串） */
  startedAt: string | null
  /** 链内最晚 `ended_at`（原样 UTC 字符串）。
   *  ⚠️ 链内有在飞跳（`ended_at` null）时，本值是**已结束跳的下界**，故 `spanMs` 偏小。 */
  endedAt: string | null
  /** `endedAt − startedAt`（毫秒，1000 的整数倍）。两端缺一 → null。 */
  spanMs: number | null
  /** 链内跳数，**恒等于 `hops.length`**（截断只截链、不截跳） */
  hopCount: number
  completedCount: number
  failedCount: number
  hops: ChainHop[]
}

export interface ChainTotals {
  /** 真链条数（**不含**孤儿桶） */
  chains: number
  /** 窗口内执行行总数（**含**孤儿跳） */
  hops: number
  orphanHops: number
  /** 非孤儿跳 / 真链条数，保留 2 位小数；无链 → 0 */
  avgHopsPerChain: number
  /** 真链最大跳数（**不含**孤儿桶）。无链 → 0 */
  maxHops: number
}

export interface ChainQueryResult {
  /** **永远基于未截断的全窗口**计算——`limit` 不影响本字段 */
  totals: ChainTotals
  /** 已按 `spanMs` 降序（并列按 `chainId` 升序，保证分页/重复请求不抖动）并截断到 `limit` */
  chains: Chain[]
  /** 链锚为 NULL 的孤儿跳。**恒在**——无孤儿时 `{ chainId: null, hopCount: 0, hops: [] }`，
   *  **不得省略字段、不得静默丢弃**（dev 库实测 28 行 ≈ 2.6%）。 */
  orphanChain: { chainId: null; hopCount: number; hops: ChainHop[] }
}

/** SQLite `datetime('now')` 写的 UTC 字符串 → epoch ms。
 *  必须手动补 `T`/`Z`——JS 把不带 Z 的 `YYYY-MM-DD HH:MM:SS` 当**本地时间**，
 *  直接 `new Date(s)` 会差 8 小时（东八区）。 */
function parseUtcMs(s: string | null): number | null {
  if (!s) return null
  const ms = Date.parse(`${s.replace(' ', 'T')}Z`)
  return Number.isNaN(ms) ? null : ms
}

function toHop(row: ExecHopRow, slowMs: number): ChainHop {
  const startedMs = parseUtcMs(row.started_at)
  const endedMs = parseUtcMs(row.ended_at)

  // running 行（ended_at null，正在跑的那一跳）⇒ 段算全 null。该跳**仍留在 hops[] 里**
  // ——正在跑的就是当前卡点，丢掉它等于把卡点藏起来。
  const totalMs = startedMs !== null && endedMs !== null ? endedMs - startedMs : null
  const replyMs = row.latency_ms
  const nonReplyMs = replyMs === null || totalMs === null ? null : Math.max(0, totalMs - replyMs)
  // 秒级舍入：ended_at 精度 1 秒、replyMs 毫秒精度 ⇒ 理论上 totalMs 可小于 replyMs。
  // 钳位但不静默——segmentClamped 把这个事实暴露到响应里。
  const segmentClamped = replyMs !== null && totalMs !== null && totalMs - replyMs < 0

  const flags: HopFlag[] = []
  if (row.status === 'failed') flags.push('failed')
  // ⚠️ 无 status 守卫（契约原文如此，对照 no_data 有守卫）：在飞跳 message_id 必为 null
  //    ⇒ 会被标 no_reply。若语义应为「尚未回复 ≠ 无回复」需架构裁决加 running 守卫。
  if (row.message_id === null || row.reply_chars === 0) flags.push('no_reply')
  if (totalMs !== null && totalMs > slowMs) flags.push('slow')
  // 有回复却无耗时——正是采集修复前全表的形态；修复后新数据不再出现，存量行会显示
  if (row.status === 'completed' && replyMs === null) flags.push('no_data')

  return {
    executionLogId: row.execution_log_id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    status: row.status,
    errorType: row.error_type,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    totalMs,
    replyMs,
    nonReplyMs,
    segmentClamped,
    flags,
    triggerMessageId: row.triggered_by_message_id,
    replyMessageId: row.message_id,
  }
}

/** 跳排序：按 `started_at` 升序（回答「卡在哪一跳」要时序），并列按 id 升序
 *  ——`started_at` 精度 1 秒，同秒并发是常态，没有 tiebreak 顺序会抖。 */
function compareHops(a: ChainHop, b: ChainHop): number {
  const am = parseUtcMs(a.startedAt)
  const bm = parseUtcMs(b.startedAt)
  if (am !== bm) {
    if (am === null) return 1
    if (bm === null) return -1
    return am - bm
  }
  return a.executionLogId < b.executionLogId ? -1 : a.executionLogId > b.executionLogId ? 1 : 0
}

function buildChain(chainId: string, rows: ExecHopRow[], slowMs: number): Chain {
  const hops = rows.map((r) => toHop(r, slowMs)).sort(compareHops)

  let startedAt: string | null = null
  let endedAt: string | null = null
  let startedMs: number | null = null
  let endedMs: number | null = null
  for (const h of hops) {
    const sm = parseUtcMs(h.startedAt)
    if (sm !== null && (startedMs === null || sm < startedMs)) {
      startedMs = sm
      startedAt = h.startedAt
    }
    const em = parseUtcMs(h.endedAt)
    if (em !== null && (endedMs === null || em > endedMs)) {
      endedMs = em
      endedAt = h.endedAt
    }
  }

  return {
    chainId,
    startedAt,
    endedAt,
    spanMs: startedMs !== null && endedMs !== null ? endedMs - startedMs : null,
    hopCount: hops.length,
    completedCount: hops.filter((h) => h.status === 'completed').length,
    failedCount: hops.filter((h) => h.status === 'failed').length,
    hops,
  }
}

/**
 * 分组 + 段算 + flags + 排序 + 截断。纯函数——同输入必同输出。
 *
 * @param opts.slowMs `totalMs > slowMs` 标 `slow`（来自 `EVAL_CHAIN_SLOW_MS`）
 * @param opts.limit  **只截链、不截跳**——整链返回或整链不返回，绝不出现半条链
 *                    （半条链会伪造出错误的「链长」与「跨度」）。
 */
export function buildChains(
  rows: ExecHopRow[],
  opts: { slowMs: number; limit: number }
): ChainQueryResult {
  const groups = new Map<string, ExecHopRow[]>()
  const orphanRows: ExecHopRow[] = []

  for (const row of rows) {
    if (row.chain_id === null) {
      orphanRows.push(row)
      continue
    }
    const bucket = groups.get(row.chain_id)
    if (bucket) bucket.push(row)
    else groups.set(row.chain_id, [row])
  }

  const allChains = [...groups.entries()].map(([id, rs]) => buildChain(id, rs, opts.slowMs))
  const nonOrphanHops = rows.length - orphanRows.length

  const totals: ChainTotals = {
    chains: allChains.length,
    hops: rows.length,
    orphanHops: orphanRows.length,
    avgHopsPerChain:
      allChains.length > 0 ? Math.round((nonOrphanHops / allChains.length) * 100) / 100 : 0,
    maxHops: allChains.reduce((m, c) => Math.max(m, c.hopCount), 0),
  }

  // spanMs 降序回答「哪里耗时最长」；并列按 chainId 升序保证不抖动。
  // spanMs 为 null（链内全是在飞跳）排最后——它们没有可比的跨度。
  const sorted = allChains.sort((a, b) => {
    const av = a.spanMs ?? -1
    const bv = b.spanMs ?? -1
    if (av !== bv) return bv - av
    return a.chainId < b.chainId ? -1 : a.chainId > b.chainId ? 1 : 0
  })

  return {
    totals,
    chains: sorted.slice(0, opts.limit),
    orphanChain: {
      chainId: null,
      hopCount: orphanRows.length,
      hops: orphanRows.map((r) => toHop(r, opts.slowMs)).sort(compareHops),
    },
  }
}
