import type { SpanDto } from '@/composables/useApi'

/**
 * 段瀑布口径的**唯一真相源**（R4 从 EvaluationView.vue 抽出，两处共用）。
 *
 * 为什么要抽：同一套口径有两个消费方——评估页链路 tab 的跳展开（EvaluationView）
 * 与会话右侧面板的成员卡内联展开（SessionAgentsPanel）。内联两份 = 两套口径，
 * 必然漂移（本仓「同名不同义」已栽两次：`chainRole`/`chainType`、`final_rank`）。
 *
 * 本文件是**纯函数 + 纯常量**：无 Vue 响应式、无 DOM、无副作用 ⇒ 几何全部可复算，
 * 测试据此断言，不必依赖布局引擎。
 */

/** 毫秒 → 人话；null（无数据）→ `—`，**不是** `0ms`——「我不知道」≠「我没有」 */
export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}min`
}

/** 段相位 → 配色分组（按 R2 §五 的段语义分组，不按段名硬编 11 种色） */
export const SPAN_PHASE: Record<string, string> = {
  invoke_agent: 'llm',
  'llm.chat': 'llm',
  'dispatch.queue_wait': 'wait',
  'dispatch.token_wait': 'wait',
  'context.assemble': 'orch',
  'context.compress': 'orch',
  'memory.retrieval': 'retr',
  'knowledge.retrieval': 'retr',
  'reply.persist': 'pers',
  'diff.collect': 'pers',
  'git.auto_commit': 'pers',
}

/** 段名说明（悬停段名时出）。闭集 11 条，与 R2 §五 同源 */
export const SEG_DOC: Record<string, string> = {
  invoke_agent: '根段。一次完整执行的全程——从调度器接手到收尾。执行总时长只认它。',
  'dispatch.queue_wait':
    '槽位 FIFO 排队。消息在猫的队列里等前面任务做完的时间。窗口在本次执行开始之前，不计入本次执行。',
  'dispatch.token_wait': 'token 池等待。ProviderTokenPool 配额已满时的阻塞时间。',
  'context.assemble': '上下文构建。取最近消息 / 任务历史 / 相关消息，拼出本轮 prompt。',
  'context.compress': '摘要压缩 + token 感知软截断。超预算时把旧消息压成摘要。',
  'memory.retrieval': '记忆混合检索（向量 + 关键词 RRF）。明细落在 retrieval_events 三表。',
  'knowledge.retrieval': '知识库检索。命中的区块按查询注入 system prompt。',
  'llm.chat': '模型流式生成。含首字延迟 ttft。明细落在 span_llm。',
  'diff.collect': '采集本轮 commit 的 diff（5s 超时）。在关键路径上 await。',
  'reply.persist': '回复落库。写入 messages 表。',
  'git.auto_commit':
    '顶层 auto-commit（3 次 execSync，阻塞整个事件循环）。轮次段——时间窗在根段之外。',
}

/** 字段说明：**只讲真展示在前端的字段**（用户原话「没有展示在前端上的字段，就不用描述了」）。
 *  后端有、界面无的（`item_count` / `operation_name` / `stream` / `max_tokens` …）不在此列。 */
export interface FieldDoc {
  key: string
  name: string
  desc: string
}
export const FIELD_DOCS: FieldDoc[] = [
  {
    key: 'duration',
    name: '耗时',
    desc: '该段自己的耗时。总时长的权威是根段 invoke_agent——段是嵌套的，子段之和会超过它，不能加总。',
  },
  {
    key: 'status',
    name: '状态',
    desc: 'ok / error / timeout / skipped。只有非 ok 才挂徽章；红条 = 该段失败或超时。',
  },
  {
    key: 'ttft',
    name: '首字',
    desc: '首个 chunk 的延迟，只在 llm.chat 段上有（来自 span_llm.ttft_ms）。',
  },
]

/** 轴外段的友好名（起点早于根段 / 终点晚于根段，硬画会溢出轴） */
export const OUTSIDE_LABELS: Record<string, string> = {
  'dispatch.queue_wait': '排队等待',
  'git.auto_commit': 'auto-commit',
}

/** 「微段」阈值：占轴长不足 1% 的段。**只用于折叠展示**，不参与任何口径计算——
 *  折叠是读法偏好（嫌长时收起），不是几何判定，更不许据此改轴长或改总时长。 */
export const MICRO_SHARE = 0.01

export interface WfRow {
  key: string
  name: string
  isRoot: boolean
  phase: string
  /** 相对轴起点（根段 `start_at`）的百分比——**这就是几何量本身**，不是样式糖 */
  leftPct: number
  widthPct: number
  durationMs: number
  sharePct: string
  status: string
  bad: boolean
  ttftText: string | null
}

export interface WfOutside {
  key: string
  text: string
}

export interface Waterfall {
  /** 横轴总长 = 根段 `duration_ms`（**禁止加总子段**：段嵌套，实测 2.0× / 1.6× / 3.0×） */
  axisMs: number
  rows: WfRow[]
  /** 轴外段：不进瀑布、不计总时长，只作单行文字标注 */
  outside: WfOutside[]
}

/** 占轴长的百分比（≥10% 保留 1 位，小段保留 2 位——小段的差别全在小数位） */
export function sharePct(part: number, total: number): string {
  if (total <= 0) return '—'
  const p = (part / total) * 100
  return `${p.toFixed(p >= 10 ? 1 : 2)}%`
}

/** 段 → 瀑布。**纯函数**：几何全部可复算，测试据此断言，不必依赖 DOM 布局引擎。 */
export function buildWaterfall(spans: SpanDto[]): Waterfall | null {
  // 根段 = `invoke_agent`（R2：一次执行恰一根，`parent_span_id` 恒 NULL）。
  // **按名优先**、再回落 NULL 判定：若将来有段被错挂成 NULL 父，纯 `find(NULL)`
  // 会逮到它当根 —— 轴起点与轴长一起错位，瀑布只剩那一行**且不报错**（静默）。
  // 真实库佐证：`parent_span_id IS NULL` 的段只有 `invoke_agent`（61/61）。
  const root =
    spans.find((s) => s.parent_span_id === null && s.name === 'invoke_agent') ??
    spans.find((s) => s.parent_span_id === null)
  if (!root) return null
  const rootStart = Date.parse(root.start_at)
  const axisMs = root.duration_ms
  if (Number.isNaN(rootStart) || axisMs <= 0) return null
  const rootEnd = rootStart + axisMs

  // 时间序：按 `start_at` 升序（`id` 兜底同刻段）。**本函数自己排**，不继承上游顺序——
  // 「时间序」是排查读法的前提（先看哪一步坏），不是可以靠对方保证的巧合。
  const ordered = [...spans].sort(
    (a, b) => Date.parse(a.start_at) - Date.parse(b.start_at) || a.id - b.id
  )

  const rows: WfRow[] = []
  const outside: WfOutside[] = []
  for (const s of ordered) {
    const start = Date.parse(s.start_at)
    if (Number.isNaN(start)) continue
    const end = start + s.duration_ms
    // 轴外 = 起点早于根段 **或** 终点晚于根段。
    // ⚠️ 轴的起点**必须**取根段 `start_at`，严禁 `min(start_at)`——那会把排队段拉进轴内。
    if (start < rootStart || end > rootEnd) {
      outside.push({
        key: s.span_id,
        text: `${OUTSIDE_LABELS[s.name] || s.name} ${fmtMs(s.duration_ms)}（不计入本次执行）`,
      })
      continue
    }
    rows.push({
      key: s.span_id,
      name: s.name,
      isRoot: s.parent_span_id === null,
      phase: SPAN_PHASE[s.name] || 'orch',
      leftPct: ((start - rootStart) / axisMs) * 100,
      widthPct: (s.duration_ms / axisMs) * 100,
      durationMs: s.duration_ms,
      sharePct: sharePct(s.duration_ms, axisMs),
      status: s.status,
      bad: s.status === 'error' || s.status === 'timeout',
      ttftText: s.llm?.ttftMs == null ? null : fmtMs(s.llm.ttftMs),
    })
  }
  return { axisMs, rows, outside }
}

/** 把行分成「常规」与「微段」两组（面板「折叠微段」用）。
 *  **只做分组，不动口径**：两组之和恒等于入参 rows 全量 —— 折叠是读法，不是丢数据。 */
export function splitMicroSpans(rows: WfRow[], axisMs: number): { shown: WfRow[]; micro: WfRow[] } {
  if (axisMs <= 0) return { shown: rows, micro: [] }
  const micro: WfRow[] = []
  const shown: WfRow[] = []
  for (const r of rows) {
    if (r.durationMs / axisMs < MICRO_SHARE) micro.push(r)
    else shown.push(r)
  }
  return { shown, micro }
}
