<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import {
  api,
  type EvalScoreRow,
  type ScoreAggregate,
  type PendingReviewScore,
  type LabelPoolRow,
  type EpisodeStats,
  type EvalL1Metrics,
  type EvalChainsResponse,
  type ChainHop,
  type HopFlag,
  type SpanDto,
  type RetrievalReport,
  type RetrievalReportSummary,
  type RetrievalAnchorDetail,
} from '@/composables/useApi'
// 段瀑布口径（几何 / 相位 / 段说明 / 字段说明）——**唯一真相源在 utils/spanLayout.ts**，
// 会话右侧面板的内联 trace 消费同一份。改动口径请改那里，别在本文件重新内联。
import {
  buildWaterfall,
  fmtMs,
  FIELD_DOCS,
  SEG_DOC,
  type FieldDoc,
  type Waterfall,
} from '@/utils/spanLayout'
// 时间口径——**唯一真相源在 utils/time.ts**。后端透传的是 SQLite `datetime('now')` 的
// UTC 无后缀串，直接喂 `new Date` 会按本地时区解析（UTC+8 差 8 小时）；解析只此一处，
// 本文件不再自带副本。新增时间显示（含 `SpanRow.start_at` 那种 ISO 形态）一律从这里取。
import { fmtUtcShort, fmtUtcFull } from '@/utils/time'

/**
 * 全屏评估中心（E4-B，左侧栏底部入口进入，无 vue-router 的 App 级 view 切换）。
 * 五 tab（用户看得懂是硬要求）：
 *   - 观察：评分列表 + 按猫聚合卡片 + 任务结局分布（episodes 7 类计数 + 办成率）
 *   - 回标：低分样本卡（回复全文 + 上下文折叠 + 1-5 分单选 + 评语）→ 提交移出待回标 + 角标减一
 *   - 标注（J1）：盲标池样本卡（回复**全文** + 上下文折叠 + 1-5 分单选 + 评语）→ 提交移出池子。
 *     **界面绝不显示判官分**——盲标是方法论硬要求（显示了就污染基准），故这一栏
 *     连数据都不取：`/api/eval/label/pool` 的响应里根本没有判官分字段。
 *   - 链路（P1）：L1 八口径 + 链概览 + 每链跳瀑布（回答「哪条链最长 / 卡在哪一跳」）
 *   - 检索（E1）：检索跑批基线的**快照**视图（两组 recall 分列 / 归因分布 / 逐条明细 /
 *     canary 与负例 / 日期选择器）。数字永远来自**上一次手工跑批**，页面顶部明写这句——
 *     跑批要起嵌入 sidecar，前端不能触发。
 * 契约：消费 E4-A 后端四接口 + episode-stats（契约缺口裁决补充的只读路由）
 * + P1-A 的 l1-metrics / chains（平铺响应，无 ok 外壳）+ J1 的 label/pool 与 label/:id；
 * 办成率口径店长钉死：(success + corrected_success) / Σ(uRoot 已分类)，open 不计分母。
 * 纯展示 + 两处人工写入（回标 / 标注），零 LLM 调用。
 */
const emit = defineEmits<{ close: [] }>()

const activeTab = ref<'observe' | 'review' | 'label' | 'chain' | 'retrieval'>('observe')

// ─── 观察 tab ─────────────────────────────
const scores = ref<EvalScoreRow[]>([])
const aggregates = ref<ScoreAggregate[]>([])
const stats = ref<EpisodeStats | null>(null)
const observeLoading = ref(true)
const observeError = ref('')

// ─── 回标 tab ─────────────────────────────
const pending = ref<PendingReviewScore[]>([])
const pendingLoading = ref(true)
const pendingError = ref('')
/** 每张样本卡独立的评分/评语状态（共享会串卡——A 卡选的分数显示到 B 卡） */
const reviewState = ref<Record<string, { score: number; comment: string }>>({})
const submittingId = ref<string | null>(null)
const submitError = ref('')

// ─── 标注 tab（J1 盲标）─────────────────────
// 与回标 tab 是**两条通道**：回标标的是一条**判官已打过分**的回复（`user_feedback`），
// 标注标的是判官**没参与挑选**的回复（`human_labels`），后者才是判官分的基准。
// 界面与回标同形是有意的（标注者不必学两套），但状态、接口、移出语义各自独立。
const labelPool = ref<LabelPoolRow[]>([])
const labelLoading = ref(true)
const labelError = ref('')
/** 每张样本卡独立的评分/评语状态（共享会串卡——与回标 tab 同款理由） */
const labelState = ref<Record<string, { score: number; comment: string }>>({})
const labelingId = ref<string | null>(null)
const labelSubmitError = ref('')

// ─── 链路 tab（P1：哪条链耗时最长 / 卡在哪一跳）──────────
const l1 = ref<EvalL1Metrics | null>(null)
const chains = ref<EvalChainsResponse | null>(null)
const chainLoading = ref(true)
const chainError = ref('')
/** 展开状态按链锚键控（默认全收起——一条链可达 26 跳，全铺开会淹掉列表） */
const expanded = ref<Record<string, boolean>>({})
const ORPHAN_KEY = '__orphan__'

// ─── R3 段分解：展开一跳时拉该执行的段（回答「这一跳里卡在哪一段」）──────────
/** 键 = `executionLogId`（= `spans.execution_id`）。缓存住，收起再展开不重发 */
const spansByExec = ref<Record<string, SpanDto[]>>({})
const spanLoading = ref<Record<string, boolean>>({})
const spanError = ref<Record<string, string>>({})

// ─── 检索 tab（E1：跑批基线的快照视图）──────
// ⚠️ 这一栏的数字**永远是「上一次跑批」的快照**，不是实时水位：跑批要起嵌入 sidecar、
// 跑几分钟，前端不能触发（会撞活 server 的嵌入端口）。tab 顶部那句声明是承重件——
// 去掉它，快照会被读成当前水位。报告本体只落 md 时这一栏拿不到数据，故 E1 同批让
// 跑批脚本多落一份同基名的 `.json`（契约 A）。
const retrievalReports = ref<RetrievalReportSummary[]>([])
const retrievalMeta = ref<RetrievalReportSummary | null>(null)
const retrievalDate = ref('')
const retrievalReport = ref<RetrievalReport | null>(null)
const retrievalLoading = ref(true)
const retrievalError = ref('')
/** 逐条明细默认全收起——40 条 × 各自明细全铺开会淹掉整栏 */
const retrievalOpen = ref<Record<string, boolean>>({})

/** 两组读数**分列**（D4：测的是不同面，不合成总分）。
 *  真实组的 n 是「标了 expect 的条数」——`recallMean` 为 `null` 表示该组无可评分条目。 */
const retrievalGroups = computed(() => {
  const g = retrievalReport.value?.groups
  if (!g) return []
  return [
    { key: 'real', label: '真实组', ...g.real },
    { key: 'constructed', label: '构造组', ...g.constructed },
  ]
})

/** 归因分布：口径与 md 报告「未召回归因汇总」**逐字同源**——遍历全部条目（含负例）、
 *  跳过已注入，键 = `drop ?? status`，计数单位 = (条目, 锚点) 对。自己另立一套口径
 *  的话，页面与报告就会对不上账（而两边的数看着都「有理」）。 */
const retrievalAttribution = computed(() => {
  const bucket = new Map<string, number>()
  const anchors = new Set<string>()
  for (const s of retrievalReport.value?.scores ?? []) {
    for (const d of s.details) {
      if (d.status === 'injected') continue
      const key = d.drop ?? d.status
      bucket.set(key, (bucket.get(key) ?? 0) + 1)
      anchors.add(`${d.docPath}\u0000${d.sectionAnchor}`)
    }
  }
  const rows = [...bucket.entries()]
    .map(([key, n]) => ({ key, n }))
    .sort((a, b) => b.n - a.n || (a.key < b.key ? -1 : 1))
  return { rows, total: rows.reduce((a, r) => a + r.n, 0), distinct: anchors.size }
})

/** 锚点归因标签：与 `retrieval-baseline.mjs::missLabel` 同一口径（`below_topk` 带
 *  「哪条查询、池内第几名」，有距离就带距离）——md / json / 页面三处读到的必须是同一句话。 */
function anchorLabel(d: RetrievalAnchorDetail): string {
  const key = d.drop ?? d.status
  const at = key === 'below_topk' ? ` q${d.queryIndex} rank=${d.rank}` : ''
  const dist = typeof d.distance === 'number' ? ` dist=${d.distance.toFixed(4)}` : ''
  return `${key}${at}${dist}`
}

/** canary 未通过条数。**它恒为 0 是预期值不是告警位**——任一条不符时脚本在落盘前就拒出
 *  （B2 硬闸），所以这里读到 0 只说明「那份报告当初过了闸」；非 0 只可能来自被手工改过的
 *  json。放在页面上是为了让「还是全过吗」一眼可查，不是当报警灯用。 */
const canaryFailed = computed(
  () => (retrievalReport.value?.canary ?? []).filter((c) => !c.ok).length
)

/** 负例判红条数 = `forbid`（刻意标注的「误读路径」节）被注入 prompt 的条数。 */
const negativeRed = computed(
  () => (retrievalReport.value?.negatives ?? []).filter((s) => s.forbidHit.length > 0).length
)

/** canary 一行文案。**拼成单个字符串再输出**——写成跨行的多个插值会把换行带进文本节点，
 *  `wrapper.text()` 的断言与人的肉眼读法都会跟着对不齐（同一个坑在 `负例判红` 那行是
 *  单行连续的，故无需此处理）。 */
const canaryText = computed(() => {
  const total = retrievalReport.value?.canary.length ?? 0
  const failed = canaryFailed.value
  return `${failed === 0 ? '✓' : '✗'} canary ${total - failed}/${total} 通过`
})

/** 渲染用分组：正文链 + 末尾孤儿组。
 *  归一成同一形状后，孤儿区复用同一套跳渲染（否则要复制一份 ~20 行的跳模板）。
 *  孤儿组没有跨度/完成/失败口径（契约只保证 `{ chainId, hopCount, hops }`）→ 取 null。 */
interface ChainGroup {
  key: string
  orphan: boolean
  spanMs: number | null
  startedAt: string | null
  endedAt: string | null
  hopCount: number
  completedCount: number | null
  failedCount: number | null
  hops: ChainHop[]
}

const chainGroups = computed<ChainGroup[]>(() => {
  const c = chains.value
  if (!c) return []
  return [
    ...c.chains.map((ch, i) => ({
      key: ch.chainId || `chain-${i}`,
      orphan: false,
      spanMs: ch.spanMs,
      startedAt: ch.startedAt,
      endedAt: ch.endedAt,
      hopCount: ch.hopCount,
      completedCount: ch.completedCount,
      failedCount: ch.failedCount,
      hops: ch.hops,
    })),
    {
      key: ORPHAN_KEY,
      orphan: true,
      spanMs: null,
      startedAt: null,
      endedAt: null,
      hopCount: c.orphanChain.hopCount,
      completedCount: null,
      failedCount: null,
      hops: c.orphanChain.hops,
    },
  ]
})

function isExpanded(key: string): boolean {
  return expanded.value[key] === true
}

function toggleChain(g: ChainGroup): void {
  const next = !expanded.value[g.key]
  expanded.value[g.key] = next
  // 展开才拉段——收起状态下发 26 跳 × N 段纯属浪费（一条链可达 26 跳）
  if (next) loadSpansForGroup(g)
}

/** 卡点徽章文案——**带文字**不只靠颜色（色盲可读） */
const FLAG_LABELS: Record<HopFlag, string> = {
  failed: '失败',
  no_reply: '无回复',
  slow: '超时',
  no_data: '无数据',
}
const FLAG_ORDER: HopFlag[] = ['failed', 'no_reply', 'slow', 'no_data']

/** 按白名单取标记：后端将来新增标记不会渲染成一个没有文案的空徽章 */
function hopFlags(hop: ChainHop): HopFlag[] {
  return FLAG_ORDER.filter((f) => hop.flags?.includes(f))
}

/** execution_logs.status 四值（db/index.ts CHECK 约束） */
const STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  running: '进行中',
  completed: '完成',
  failed: '失败',
}

function statusLabel(s: string): string {
  return STATUS_LABELS[s] || s
}

/** 比率 → 百分比；null → `—`（不编 0%） */
function fmtRate(r: number | null | undefined): string {
  if (r == null) return '—'
  return `${Math.round(r * 100)}%`
}

/** 计数 → 字符串（非整数保留 2 位，如均跳数 2.19）；null → `—` */
function fmtNum(n: number | null | undefined): string {
  if (n == null) return '—'
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

/** L1 八口径卡片：`value` 留原始值供「无数据」样式判定（任一口径为 null 都置灰），
 *  `text` 是展示串——两者分开，避免用展示串反推「是不是没有数据」。 */
const l1Cards = computed(() => {
  const m = l1.value
  return [
    { label: '成功率', value: m?.successRate ?? null, text: fmtRate(m?.successRate) },
    { label: '超时率', value: m?.timeoutRate ?? null, text: fmtRate(m?.timeoutRate) },
    { label: '平均耗时', value: m?.avgLatencyMs ?? null, text: fmtMs(m?.avgLatencyMs) },
    { label: '总 token', value: m?.totalTokens ?? null, text: fmtNum(m?.totalTokens) },
    { label: '建议率', value: m?.suggestRate ?? null, text: fmtRate(m?.suggestRate) },
    { label: '驳回率', value: m?.rejectRate ?? null, text: fmtRate(m?.rejectRate) },
    { label: '解析失败率', value: m?.parseFailureRate ?? null, text: fmtRate(m?.parseFailureRate) },
    { label: '基建故障', value: m?.infraFailures ?? null, text: fmtNum(m?.infraFailures) },
  ]
})

/** 该跳仍在飞（无结束时点）→ 耗时不可得，展示 `—` */
function hopRunning(hop: ChainHop): boolean {
  return hop.endedAt == null
}

function hopTotalText(hop: ChainHop): string {
  return hopRunning(hop) ? '—' : fmtMs(hop.totalMs)
}

/** 组件卸载（评估中心关闭）后停止写 ref——防写已卸载组件的警告 */
let disposed = false

/** 按执行缓存瀑布。**未到达的执行不进表**——据此把「还在加载 / 加载失败」与
 *  「到了但是空数组（存量行）」区分开，两者文案不同（null ≠ 0 同款判据）。 */
const waterfalls = computed<Record<string, Waterfall>>(() => {
  const out: Record<string, Waterfall> = {}
  for (const [execId, spans] of Object.entries(spansByExec.value)) {
    const wf = buildWaterfall(spans)
    if (wf) out[execId] = wf
  }
  return out
})

/** 拉一次执行的段。已缓存 / 在途则不重发（同跳反复展开收起不刷屏） */
async function loadSpans(executionLogId: string): Promise<void> {
  if (spansByExec.value[executionLogId] || spanLoading.value[executionLogId]) return
  spanLoading.value[executionLogId] = true
  spanError.value[executionLogId] = ''
  try {
    const res = await api.getEvalSpans(executionLogId)
    if (disposed) return
    spansByExec.value[executionLogId] = res.spans
  } catch (err: any) {
    if (!disposed) spanError.value[executionLogId] = err.message || '段数据加载失败'
  } finally {
    if (!disposed) spanLoading.value[executionLogId] = false
  }
}

/** 展开一条链时批量拉它各跳的段。**在飞的跳跳过**——R2 一次执行一事务、`finalizeRun`
 *  才写，跑着的执行库里必然零段行，查了也是空；文案由 `hopRunning` 给，不必白跑一趟。 */
function loadSpansForGroup(g: ChainGroup): void {
  for (const h of g.hops) {
    if (!hopRunning(h)) void loadSpans(h.executionLogId)
  }
}

// ─── 悬浮说明：自绘浮层（**不用原生 `title`**）──────────────────
// 原生 `title` 撑不起多字段排版、延迟约 1s、且贴不到「段名」上（R3 架构裁决 1）。
interface Tip {
  title: string
  body: string
}
const tip = ref<Tip | null>(null)
const tipPos = ref<{ left: number; top: number } | null>(null)
const tipEl = ref<HTMLElement | null>(null)

function hideTip(): void {
  tip.value = null
  tipPos.value = null
}

/**
 * 定位：**贴名字**——右侧、水平小间隙（6px）、垂直居中于名字。
 *
 * 「不得遮挡该段数值读数」靠**右边界硬约束**实现：行内数值块（`.wf-nums`）的左沿
 * 就是浮层能到的最远处，够不到就一定不遮。右侧塞不下时，行内场景落到名字正下方，
 * 表头场景（无数值块）翻到名字左侧。
 */
function positionTip(anchor: HTMLElement): void {
  const el = tipEl.value
  if (!el) return
  const GAP = 6
  const r = anchor.getBoundingClientRect()
  const t = el.getBoundingClientRect()
  const nums = anchor.closest('.wf-row')?.querySelector('.wf-nums')
  const rightLimit = (nums ? nums.getBoundingClientRect().left : window.innerWidth) - GAP
  let left = r.right + GAP
  let top = r.top + r.height / 2 - t.height / 2
  if (left + t.width > rightLimit) {
    if (nums) {
      left = r.left
      top = r.bottom + GAP
    } else {
      left = r.left - t.width - GAP
    }
  }
  tipPos.value = {
    left: Math.max(8, left),
    top: Math.max(8, Math.min(top, window.innerHeight - t.height - 8)),
  }
}

async function showTip(content: Tip, anchor: HTMLElement): Promise<void> {
  tip.value = content
  tipPos.value = null // 先渲染但透明（`.is-placing`）——不渲染就量不出尺寸，定位无从谈起
  await nextTick()
  positionTip(anchor)
}

function onFieldTip(doc: FieldDoc, ev: MouseEvent): void {
  void showTip({ title: doc.name, body: doc.desc }, ev.currentTarget as HTMLElement)
}

/** 命中区 = **段名元素本身**（用户明确要求）。事件只挂在 `.wf-name` 上——
 *  段身（条）/整行/空白都不触发，模板里没有第二个 handler。 */
function onSegTip(name: string, ev: MouseEvent): void {
  void showTip(
    { title: name, body: SEG_DOC[name] || '（未登记的段名）' },
    ev.currentTarget as HTMLElement
  )
}

// ─── 任务结局（E2/E3 规格 §4：U 根任务结局 7 类全集）─────────
const OUTCOME_LABELS: Record<string, string> = {
  success: '成功',
  corrected_success: '修正后成功',
  needs_investigation: '需调查',
  harness_fix_needed: '机制需修',
  routing_failure: '路由失败',
  abandoned: '放弃',
  unclassified: '未分类',
}
const OUTCOME_ORDER = [
  'success',
  'corrected_success',
  'needs_investigation',
  'harness_fix_needed',
  'routing_failure',
  'abandoned',
  'unclassified',
]

/** U 根已分类任务总数（open 不计入——未定论任务不算成败，店长裁决口径） */
const totalClassified = computed(() => {
  const s = stats.value
  if (!s) return 0
  return OUTCOME_ORDER.reduce((sum, k) => sum + (s.uRoot[k] || 0), 0)
})

/** 办成率 %：(success + corrected_success) / Σ uRoot 已分类；无已分类任务 → null（不显示） */
const doneRate = computed(() => {
  const s = stats.value
  if (!s || totalClassified.value === 0) return null
  const done = (s.uRoot['success'] || 0) + (s.uRoot['corrected_success'] || 0)
  return Math.round((done / totalClassified.value) * 100)
})

/** 结局条形分段宽度（相对已分类总数） */
function outcomePct(key: string): string {
  const s = stats.value
  if (!s || totalClassified.value === 0) return '0%'
  const cnt = s.uRoot[key] || 0
  return `${Math.round((cnt / totalClassified.value) * 100)}%`
}

const pendingBadge = computed(() => pending.value.length)

/** 样本卡独立状态惰性初始化 */
function stateFor(id: string): { score: number; comment: string } {
  if (!reviewState.value[id]) {
    reviewState.value[id] = { score: 3, comment: '' }
  }
  return reviewState.value[id]
}

/** 标注卡独立状态惰性初始化（与 `stateFor` 分开：两张 tab 的卡可能同 id 形态但语义不同） */
function labelStateFor(id: string): { score: number; comment: string } {
  if (!labelState.value[id]) {
    labelState.value[id] = { score: 3, comment: '' }
  }
  return labelState.value[id]
}

function scoreLabel(n: number): string {
  return ['很差', '较差', '一般', '不错', '很好'][n - 1] || String(n)
}

function sampleReasonLabel(r: string): string {
  const map: Record<string, string> = { low_score: '低分样本', user_feedback: '已回标' }
  return map[r] || r
}

/** 观察 tab 三份数据并行拉取（Promise.all——互不依赖，失败任一 → 整区错误态） */
async function loadObserve(): Promise<void> {
  observeLoading.value = true
  observeError.value = ''
  try {
    const [scoresRes, aggRes, statsRes] = await Promise.all([
      api.getEvalScores(50),
      api.getEvalAggregates(),
      api.getEvalEpisodeStats(),
    ])
    if (disposed) return
    scores.value = scoresRes.scores
    aggregates.value = aggRes.aggregates
    stats.value = statsRes.stats
  } catch (err: any) {
    if (!disposed) observeError.value = err.message || '评估数据加载失败'
  } finally {
    if (!disposed) observeLoading.value = false
  }
}

async function loadPending(): Promise<void> {
  pendingLoading.value = true
  pendingError.value = ''
  try {
    const res = await api.getEvalPending()
    if (disposed) return
    pending.value = res.pending
  } catch (err: any) {
    if (!disposed) pendingError.value = err.message || '待回标样本加载失败'
  } finally {
    if (!disposed) pendingLoading.value = false
  }
}

/** 链路 tab 两份数据并行拉取（Promise.all——互不依赖，失败任一 → 整区错误态） */
async function loadChains(): Promise<void> {
  chainLoading.value = true
  chainError.value = ''
  try {
    const [l1Res, chainRes] = await Promise.all([api.getEvalL1Metrics(), api.getEvalChains()])
    if (disposed) return
    l1.value = l1Res
    chains.value = chainRes
  } catch (err: any) {
    if (!disposed) chainError.value = err.message || '链路数据加载失败'
  } finally {
    if (!disposed) chainLoading.value = false
  }
}

/** 提交回标 → 成功即从列表移除（角标自动减一），失败保留样本卡 + 错误提示 */
async function submitReview(id: string): Promise<void> {
  submitError.value = ''
  submittingId.value = id
  try {
    const st = stateFor(id)
    await api.submitEvalReview(id, {
      score: st.score,
      comment: st.comment.trim() || undefined,
    })
    pending.value = pending.value.filter((p) => p.id !== id)
    delete reviewState.value[id]
  } catch (err: any) {
    submitError.value = err.message || '回标提交失败'
  } finally {
    submittingId.value = null
  }
}

/** 标注池加载。空池是**正常态**（历史回复标完就空），故空态文案不说「出错」。 */
async function loadLabelPool(): Promise<void> {
  labelLoading.value = true
  labelError.value = ''
  try {
    const res = await api.getEvalLabelPool()
    if (disposed) return
    labelPool.value = res.pool
  } catch (err: any) {
    if (!disposed) labelError.value = err.message || '标注样本加载失败'
  } finally {
    if (!disposed) labelLoading.value = false
  }
}

/** 检索报告：先拉清单，再拉选中那一份（缺省 = 最新）。
 *
 *  **清单为空 ⇒ 空态，不是错误**（还没跑过批就是空，接口为此刻意不返 404）；
 *  「清单非空但那份拉不到」才走错误分支——两者混成一个分支的话，空跑批历史会被
 *  显示成「加载失败」，使用者会去查一个根本不存在的故障。
 */
async function loadRetrieval(date?: string): Promise<void> {
  retrievalLoading.value = true
  retrievalError.value = ''
  try {
    const listRes = await api.getRetrievalReports()
    if (disposed) return
    retrievalReports.value = listRes.reports
    const want = date || retrievalDate.value
    const picked = listRes.reports.find((r) => r.date === want) ?? listRes.reports[0] ?? null
    retrievalMeta.value = picked
    retrievalDate.value = picked?.date ?? ''
    if (!picked) {
      retrievalReport.value = null
      return
    }
    const res = await api.getRetrievalReport(picked.date)
    if (disposed) return
    retrievalReport.value = res.report
  } catch (err: any) {
    if (!disposed) retrievalError.value = err.message || '检索报告加载失败'
  } finally {
    if (!disposed) retrievalLoading.value = false
  }
}

/** 切换报告日期（下拉在模板里就地取值，避免多一个 ref 与列表脱节） */
function onRetrievalDateChange(e: Event): void {
  void loadRetrieval((e.target as HTMLSelectElement).value)
}

/** 提交标注 → 成功即从池中移除（下一次拉取时服务端也会排除它），失败保留样本卡 + 提示 */
async function submitLabel(id: string): Promise<void> {
  labelSubmitError.value = ''
  labelingId.value = id
  try {
    const st = labelStateFor(id)
    await api.submitEvalLabel(id, {
      score: st.score,
      comment: st.comment.trim() || undefined,
    })
    labelPool.value = labelPool.value.filter((p) => p.id !== id)
    delete labelState.value[id]
  } catch (err: any) {
    labelSubmitError.value = err.message || '标注提交失败'
  } finally {
    labelingId.value = null
  }
}

onMounted(() => {
  loadObserve()
  loadPending()
  loadLabelPool()
  loadChains()
  loadRetrieval()
})
onUnmounted(() => {
  disposed = true
})
</script>

<template>
  <div class="eval-view" role="dialog" aria-modal="true" aria-label="评估中心">
    <header class="eval-header">
      <div class="eval-title">
        <span class="eval-icon">📊</span>
        <h2>评估中心</h2>
      </div>
      <button class="btn-close" title="关闭" aria-label="关闭" @click="emit('close')">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <path
            d="M4 4l10 10M14 4l-10 10"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </header>

    <div class="eval-tabs">
      <button
        class="tab-btn"
        :class="{ active: activeTab === 'observe' }"
        @click="activeTab = 'observe'"
      >
        观察
      </button>
      <button
        class="tab-btn"
        :class="{ active: activeTab === 'review' }"
        @click="activeTab = 'review'"
      >
        回标
        <span v-if="pendingBadge > 0" class="tab-badge">{{ pendingBadge }}</span>
      </button>
      <button
        class="tab-btn"
        :class="{ active: activeTab === 'label' }"
        @click="activeTab = 'label'"
      >
        标注
      </button>
      <button
        class="tab-btn"
        :class="{ active: activeTab === 'chain' }"
        @click="activeTab = 'chain'"
      >
        链路
      </button>
      <button
        class="tab-btn"
        :class="{ active: activeTab === 'retrieval' }"
        @click="activeTab = 'retrieval'"
      >
        检索
      </button>
    </div>

    <!-- ─── 观察 tab ─────────────────────── -->
    <div v-show="activeTab === 'observe'" class="eval-pane">
      <div v-if="observeLoading" class="list-hint">
        <span class="status-spinner"></span> 加载中…
      </div>
      <div v-else-if="observeError" class="error-msg">
        {{ observeError }}
        <button class="btn-retry-sm" @click="loadObserve">重试</button>
      </div>
      <template v-else>
        <div class="section-title">聚合统计</div>
        <div v-if="aggregates.length === 0" class="list-hint">
          暂无评分数据——评估采样开启后这里会出现每只猫的评分统计
        </div>
        <div v-else class="agg-grid">
          <div v-for="a in aggregates" :key="a.agent_id || '?'" class="agg-card">
            <span class="agg-name">{{ a.agent_name || '未知猫' }}</span>
            <div class="agg-stats">
              <span class="agg-item">样本 {{ a.count }}</span>
              <span class="agg-item">均分 {{ a.avg_score }}</span>
              <span class="agg-item" :class="{ 'agg-bad': a.low_score_rate > 0 }">
                低分率 {{ Math.round(a.low_score_rate * 100) }}%
              </span>
            </div>
          </div>
        </div>

        <div class="section-title">任务结局分布</div>
        <div v-if="totalClassified === 0 && !stats?.open" class="list-hint">暂无已分类任务</div>
        <div v-else class="outcome-card">
          <div class="outcome-bar">
            <div
              v-for="k in OUTCOME_ORDER"
              :key="k"
              class="outcome-seg"
              :class="`outcome-${k}`"
              :style="{ width: outcomePct(k) }"
              :title="`${OUTCOME_LABELS[k]} ${stats?.uRoot[k] || 0}`"
            />
          </div>
          <div class="outcome-legend">
            <span v-for="k in OUTCOME_ORDER" :key="k" class="legend-item">
              <i class="legend-dot" :class="`dot-${k}`"></i>
              {{ OUTCOME_LABELS[k] }} {{ stats?.uRoot[k] || 0 }}
            </span>
            <span class="legend-item legend-open">
              <i class="legend-dot dot-open"></i> 未定论 {{ stats?.open || 0 }}
            </span>
          </div>
          <div v-if="doneRate !== null" class="done-rate">
            办成率 <b>{{ doneRate }}%</b>
            <span class="hint">（成功 + 修正后成功）/ 已分类任务，未定论不计入</span>
          </div>
        </div>

        <div class="section-title">最近评分</div>
        <div v-if="scores.length === 0" class="list-hint">暂无评分记录</div>
        <div v-else class="score-list">
          <div v-for="s in scores" :key="s.id" class="score-row">
            <span class="score-name">{{ s.agent_name || '未知猫' }}</span>
            <span class="score-num" :class="{ 'score-low': s.score <= 2 }">{{ s.score }}</span>
            <span class="score-reason">{{ sampleReasonLabel(s.sample_reason) }}</span>
            <span class="score-time">{{ fmtUtcFull(s.created_at) }}</span>
          </div>
        </div>
      </template>
    </div>

    <!-- ─── 回标 tab ─────────────────────── -->
    <div v-show="activeTab === 'review'" class="eval-pane">
      <div v-if="pendingLoading" class="list-hint">
        <span class="status-spinner"></span> 加载中…
      </div>
      <div v-else-if="pendingError" class="error-msg">
        {{ pendingError }}
        <button class="btn-retry-sm" @click="loadPending">重试</button>
      </div>
      <div v-else-if="pending.length === 0" class="list-hint">
        没有待回标样本——低分样本经人工回标后移出此列表
      </div>
      <div v-else class="pending-list">
        <div v-for="p in pending" :key="p.id" class="sample-card">
          <div class="sample-head">
            <span class="score-name">{{ p.agent_name || '未知猫' }}</span>
            <span class="score-num score-low">{{ p.score }} 分</span>
            <span class="score-time">{{ fmtUtcFull(p.reply_created_at) }}</span>
          </div>
          <div class="sample-reply">{{ p.reply_content }}</div>
          <details class="sample-context">
            <summary>查看上下文（{{ p.context.length }} 条）</summary>
            <div v-for="c in p.context" :key="c.id" class="ctx-line">
              <span class="ctx-role">{{ c.role === 'user' ? '用户' : '猫' }}</span>
              <span class="ctx-text">{{ c.content }}</span>
            </div>
          </details>
          <div class="sample-actions">
            <div class="score-picker" role="radiogroup" :aria-label="`评分 ${p.id}`">
              <button
                v-for="n in 5"
                :key="n"
                type="button"
                class="score-btn"
                :class="{ active: stateFor(p.id).score === n }"
                :aria-checked="stateFor(p.id).score === n"
                role="radio"
                @click="stateFor(p.id).score = n"
              >
                {{ n }}
              </button>
              <span class="score-label">{{ scoreLabel(stateFor(p.id).score) }}</span>
            </div>
            <input
              v-model="stateFor(p.id).comment"
              class="input"
              placeholder="评语（可选）"
              @keydown.enter="submitReview(p.id)"
            />
            <button
              class="btn-submit"
              :disabled="submittingId === p.id"
              @click="submitReview(p.id)"
            >
              {{ submittingId === p.id ? '提交中…' : '提交回标' }}
            </button>
          </div>
        </div>
        <div v-if="submitError" class="error-msg">{{ submitError }}</div>
      </div>
    </div>

    <!-- ─── 标注 tab（J1 盲标）───────────── -->
    <!-- 卡上**没有判官分**——不是省略，是盲标要求（数据里也没有）。回复正文不截断：
         Phase 0 的采集期砍过 1200 字符，判官与人都只看到残段，那次教训已记账。
         E1 起每张卡另附**前置 10 条上下文**（契约 D）——盲标要求盲的是判官分，不是上下文。 -->
    <div v-show="activeTab === 'label'" class="eval-pane">
      <div v-if="labelLoading" class="list-hint"><span class="status-spinner"></span> 加载中…</div>
      <div v-else-if="labelError" class="error-msg">
        {{ labelError }}
        <button class="btn-retry-sm" @click="loadLabelPool">重试</button>
      </div>
      <div v-else-if="labelPool.length === 0" class="list-hint">
        没有待标注样本——猫的回复被标注后即移出此列表
      </div>
      <div v-else class="pending-list">
        <div v-for="p in labelPool" :key="p.id" class="sample-card">
          <div class="sample-head">
            <span class="score-name">{{ p.agent_name || '未知猫' }}</span>
            <span class="score-time">{{ fmtUtcFull(p.created_at) }}</span>
          </div>
          <div class="sample-reply">{{ p.content }}</div>
          <!-- E1 契约 D：与回标 tab 的上下文块**逐字同款**（同一份 `getContextBefore` 取数）。
               盲标要求的是「看不到判官分」，**不包括**看不到上下文——没有上下文，标注者判的
               是「这句话本身像不像好话」，而不是「这个回答对不对」，测出来的分就废了。 -->
          <details class="sample-context">
            <summary>查看上下文（{{ p.context.length }} 条）</summary>
            <div v-for="c in p.context" :key="c.id" class="ctx-line">
              <span class="ctx-role">{{ c.role === 'user' ? '用户' : '猫' }}</span>
              <span class="ctx-text">{{ c.content }}</span>
            </div>
          </details>
          <div class="sample-actions">
            <div class="score-picker" role="radiogroup" :aria-label="`标注 ${p.id}`">
              <button
                v-for="n in 5"
                :key="n"
                type="button"
                class="score-btn"
                :class="{ active: labelStateFor(p.id).score === n }"
                :aria-checked="labelStateFor(p.id).score === n"
                role="radio"
                @click="labelStateFor(p.id).score = n"
              >
                {{ n }}
              </button>
              <span class="score-label">{{ scoreLabel(labelStateFor(p.id).score) }}</span>
            </div>
            <input
              v-model="labelStateFor(p.id).comment"
              class="input"
              placeholder="评语（可选）"
              @keydown.enter="submitLabel(p.id)"
            />
            <button class="btn-submit" :disabled="labelingId === p.id" @click="submitLabel(p.id)">
              {{ labelingId === p.id ? '提交中…' : '提交标注' }}
            </button>
          </div>
        </div>
        <div v-if="labelSubmitError" class="error-msg">{{ labelSubmitError }}</div>
      </div>
    </div>

    <!-- ─── 链路 tab（P1）─────────────────── -->
    <div v-show="activeTab === 'chain'" class="eval-pane">
      <div v-if="chainLoading" class="list-hint"><span class="status-spinner"></span> 加载中…</div>
      <div v-else-if="chainError" class="error-msg">
        {{ chainError }}
        <button class="btn-retry-sm" @click="loadChains">重试</button>
      </div>
      <template v-else>
        <div class="section-title">L1 指标</div>
        <div class="l1-grid">
          <div v-for="c in l1Cards" :key="c.label" class="l1-card">
            <span class="l1-label">{{ c.label }}</span>
            <span class="l1-value" :class="{ 'l1-nodata': c.value === null }">{{ c.text }}</span>
          </div>
        </div>
        <div class="l1-note">
          <span>窗口 {{ l1?.windowDays ?? '—' }} 天</span>
          <span>样本 {{ fmtNum(l1?.sampleTotal) }}</span>
          <span class="hint">平均耗时只算 completed 执行；无样本时为 —</span>
        </div>

        <div class="section-title">链路概览</div>
        <div v-if="!chains" class="list-hint">暂无链路数据</div>
        <template v-else>
          <div class="overview-bar">
            <span class="ov-item">
              链 <b>{{ chains.totals.chains }}</b>
            </span>
            <span class="ov-item">
              总跳数 <b>{{ chains.totals.hops }}</b>
            </span>
            <span class="ov-item">
              均跳数 <b>{{ fmtNum(chains.totals.avgHopsPerChain) }}</b>
            </span>
            <span class="ov-item">
              最长跳数 <b>{{ chains.totals.maxHops }}</b>
            </span>
            <span class="ov-item" :class="{ 'ov-warn': chains.totals.orphanHops > 0 }">
              孤儿跳 <b>{{ chains.totals.orphanHops }}</b>
            </span>
            <span class="ov-item ov-dim"> 近 {{ chains.windowDays }} 天 </span>
          </div>

          <div class="section-title">链路列表（按跨度降序）</div>
          <div v-if="chains.chains.length === 0" class="list-hint">窗口内没有链</div>
          <div class="chain-list">
            <template v-for="g in chainGroups" :key="g.key">
              <div v-if="g.orphan" class="section-title orphan-title">未归属跳（无链锚）</div>
              <div
                class="chain-card"
                :class="{
                  'chain-has-failure': (g.failedCount || 0) > 0,
                  'chain-orphan': g.orphan,
                }"
              >
                <button
                  class="chain-head"
                  :aria-expanded="isExpanded(g.key)"
                  @click="toggleChain(g)"
                >
                  <span class="chain-caret">{{ isExpanded(g.key) ? '▾' : '▸' }}</span>
                  <template v-if="g.orphan">
                    <span class="chain-item chain-bad">{{ g.hopCount }} 跳</span>
                    <span class="chain-note">触发/回复消息均无 task_id，无法归入任何链</span>
                  </template>
                  <template v-else>
                    <span class="chain-item">跨度 {{ fmtMs(g.spanMs) }}</span>
                    <span class="chain-item">{{ g.hopCount }} 跳</span>
                    <span class="chain-item">完成 {{ g.completedCount }}</span>
                    <span class="chain-item" :class="{ 'chain-bad': (g.failedCount || 0) > 0 }">
                      失败 {{ g.failedCount }}
                    </span>
                    <span class="chain-item chain-time">
                      {{ fmtUtcShort(g.startedAt) }} → {{ fmtUtcShort(g.endedAt) }}
                    </span>
                  </template>
                </button>
                <div v-if="g.orphan && g.hopCount === 0" class="list-hint">无</div>
                <div v-else-if="isExpanded(g.key)" class="hop-list">
                  <div v-for="h in g.hops" :key="h.executionLogId" class="hop-row">
                    <div class="hop-head">
                      <span class="hop-agent">{{ h.agentName || '未知猫' }}</span>
                      <span class="hop-status">{{ statusLabel(h.status) }}</span>
                      <span
                        v-for="f in hopFlags(h)"
                        :key="f"
                        class="flag-badge"
                        :class="`flag-${f}`"
                      >
                        {{ FLAG_LABELS[f] }}
                      </span>
                      <span v-if="h.errorType" class="hop-err">{{ h.errorType }}</span>
                    </div>
                    <div class="hop-body">
                      <div class="hop-sum">
                        <span class="hop-dur">总 {{ hopTotalText(h) }}</span>
                        <span v-if="h.segmentClamped" class="hop-clamp">秒级舍入</span>
                      </div>

                      <!-- 在飞：R2 一次执行一事务、收尾才落库 ⇒ 跑着的执行查出来必然空。
                           文案与「有耗时但无段」（存量行）**分开** —— null ≠ 0。 -->
                      <div v-if="hopRunning(h)" class="wf-nodata">进行中 · 段未落库</div>
                      <div v-else-if="spanLoading[h.executionLogId]" class="wf-nodata">
                        段数据加载中…
                      </div>
                      <div v-else-if="spanError[h.executionLogId]" class="wf-err">
                        段数据加载失败：{{ spanError[h.executionLogId] }}
                      </div>
                      <div v-else-if="!waterfalls[h.executionLogId]" class="wf-nodata">
                        无段数据（存量行）
                      </div>

                      <div v-else class="wf">
                        <div class="wf-head">
                          <span class="wf-title">执行 trace</span>
                          <span class="wf-total">
                            总 {{ fmtMs(waterfalls[h.executionLogId].axisMs) }}
                          </span>
                          <span class="wf-legend">
                            <span
                              v-for="d in FIELD_DOCS"
                              :key="d.key"
                              class="wf-lg"
                              @mouseenter="onFieldTip(d, $event)"
                              @mouseleave="hideTip()"
                            >
                              {{ d.name }}<span class="info-btn">ⓘ</span>
                            </span>
                          </span>
                        </div>

                        <div class="wf-rows">
                          <div
                            v-for="r in waterfalls[h.executionLogId].rows"
                            :key="r.key"
                            class="wf-row"
                          >
                            <!-- 命中区 = 段名文本本身（含色点），不是整行/段身：
                                 浮层只在移到名字上时出 —— 这是用户本轮点名的验收点 -->
                            <span class="wf-name">
                              <span
                                class="wf-name-hit"
                                @mouseenter="onSegTip(r.name, $event)"
                                @mouseleave="hideTip()"
                              >
                                <span class="wf-dot" :class="`ph-${r.phase}`"></span>{{ r.name }}
                              </span>
                            </span>
                            <span class="wf-track">
                              <span
                                class="wf-bar"
                                :class="[
                                  `ph-${r.phase}`,
                                  { 'bar-bad': r.bad, 'bar-root': r.isRoot },
                                ]"
                                :style="{ left: `${r.leftPct}%`, width: `${r.widthPct}%` }"
                              ></span>
                            </span>
                            <span class="wf-nums">
                              <span v-if="r.bad" class="wf-badge">{{ r.status }}</span>
                              <span v-if="r.ttftText" class="wf-ttft">首字 {{ r.ttftText }}</span>
                              <span class="wf-dur">{{ fmtMs(r.durationMs) }}</span>
                              <span class="wf-share">{{ r.sharePct }}</span>
                            </span>
                          </div>
                        </div>

                        <!-- 轴外段：起点早于根段（排队等的是上一个 trace）/ 终点晚于根段
                             （git.auto_commit 是轮次段）——不进瀑布、不计总时长，只作单行标注。
     文案（形如「排队等待 1.8min（不计入本次执行）」）由 spanLayout 的 buildWaterfall
     组装——右侧面板内联 trace 消费同一份，本文件不得另拼一份。 -->
                        <div
                          v-for="o in waterfalls[h.executionLogId].outside"
                          :key="o.key"
                          class="wf-outside"
                        >
                          {{ o.text }}
                        </div>

                        <div class="wf-foot">
                          总时长只认根段 invoke_agent；段是嵌套的，子段之和会超过它。
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </template>
          </div>
        </template>
      </template>
    </div>

    <!-- ─── 检索 tab（E1：跑批基线的快照视图）─── -->
    <!-- ⚠️ 顶部那条快照声明是**承重件**，不是装饰：跑批要起嵌入 sidecar、跑几分钟，前端
         不能触发（会撞活 server 的嵌入端口）⇒ 页面上的数字**永远**是「上一次跑批」的结果。
         去掉这句话，一份历史报告就会被读成当前水位。 -->
    <div v-show="activeTab === 'retrieval'" class="eval-pane">
      <div v-if="retrievalLoading" class="list-hint">
        <span class="status-spinner"></span> 加载中…
      </div>
      <div v-else-if="retrievalError" class="error-msg">
        {{ retrievalError }}
        <button class="btn-retry-sm" @click="loadRetrieval()">重试</button>
      </div>
      <!-- 空态**不是错误**：报告是手工跑批产物，「还没跑过批」就是空——接口为此刻意不返 404 -->
      <div v-else-if="!retrievalReport" class="list-hint">
        还没有检索跑批报告——先在仓库根跑
        <code class="retrieval-cmd">node scripts/eval/retrieval-baseline.mjs</code>
        （跑批要起嵌入 sidecar，不能从这里触发）
      </div>

      <template v-else>
        <div class="snapshot-bar">
          <span class="snapshot-tag">快照</span>
          <span class="snapshot-text">
            <strong>{{ retrievalMeta?.date }}</strong>
            那次跑批的结果，<strong>不是当前水位</strong>——跑批是手工的，页面不自动刷新。
            <span v-if="retrievalMeta?.writtenAt" class="snapshot-at">
              文件写入于 {{ fmtUtcFull(retrievalMeta.writtenAt) }}
            </span>
          </span>
          <select
            v-if="retrievalReports.length > 1"
            class="retrieval-date"
            :value="retrievalDate"
            @change="onRetrievalDateChange"
          >
            <option v-for="r in retrievalReports" :key="r.date" :value="r.date">
              {{ r.date }}
            </option>
          </select>
        </div>

        <!-- 两组读数**分列**（D4）：测的是不同面，不合成总分——合成出来的那个数
             既不能定位问题，也不能比较版本。 -->
        <div class="section-title">召回（两组分列，不合成总分）</div>
        <div class="l1-grid">
          <template v-for="g in retrievalGroups" :key="g.key">
            <div class="l1-card">
              <span class="l1-label">{{ g.label }} · recall（集均）</span>
              <span class="l1-value" :class="{ 'l1-nodata': g.recallMean === null }">
                {{ fmtRate(g.recallMean) }}
              </span>
              <span class="l1-sub"
                >{{ g.hit }}/{{ g.expectTotal }} 锚点 · {{ g.scoredN }}/{{ g.n }} 条可评</span
              >
            </div>
            <div class="l1-card">
              <span class="l1-label">{{ g.label }} · 阈值前命中率（集均）</span>
              <span class="l1-value" :class="{ 'l1-nodata': g.preThresholdRateMean === null }">
                {{ fmtRate(g.preThresholdRateMean) }}
              </span>
              <span class="l1-sub"
                >被阈值挡下 {{ g.preThreshold }} 处 · 阈值 {{ retrievalReport.maxDistance }}</span
              >
            </div>
          </template>
        </div>
        <!-- 术语按报告原文照抄（**不改成「阈值拦截率」之类**）：改名会让页面与 md 报告读的
             不是同一句话，两边对不上账时无法判断是口径分歧还是数据分歧。 -->
        <div class="l1-note">
          <span class="hint">
            「集均」= 各条算术平均；「阈值前命中率」=
            <code>expect</code> 里<strong>被距离阈值挡下</strong>的节占比
            （数值越高越差，不是越高越好）。
          </span>
        </div>

        <div class="section-title">语料与跑批快照</div>
        <div class="l1-note">
          <span
            >chunks {{ retrievalReport.dbRows }} 行 / {{ retrievalReport.dbDocs }} 个 doc_path</span
          >
          <span
            >语料新鲜度 live={{ retrievalReport.liveDocs }} rotten={{
              retrievalReport.rotten
            }}</span
          >
          <span>
            索引新鲜度
            {{ retrievalReport.indexFreshness.checked - retrievalReport.indexFreshness.stale }}/{{
              retrievalReport.indexFreshness.checked
            }}
            份同步
          </span>
          <span>TOP_K {{ retrievalReport.params.topK }}</span>
          <span>MAX_DISTANCE {{ retrievalReport.params.maxDistance }}</span>
          <span
            >嵌入 {{ retrievalReport.embed.model ?? 'n/a' }}/{{
              retrievalReport.embed.dim ?? 'n/a'
            }}
            维</span
          >
        </div>
        <div class="l1-note">
          <span>
            黄金集
            <code>{{ retrievalReport.goldenFile }}</code>
            v{{ retrievalReport.goldenData.version }}
            <span v-for="(n, k) in retrievalReport.goldenCounts" :key="k" class="golden-count">
              {{ k }}={{ n }}
            </span>
          </span>
          <span class="hint">
            冻结基点 <code>{{ retrievalReport.goldenData.meta?.frozenCorpusRef ?? 'n/a' }}</code>
          </span>
        </div>

        <!-- 归因分布：**一个度量跨类目** ⇒ 单一色相按长度编码，不按类目换色
             （类目换了颜色，读者会去找一个不存在的分组含义）。类目名是文字标签，
             不靠颜色表意。 -->
        <div class="section-title">
          未召回归因分布（{{ retrievalAttribution.total }} 处 · 去重后
          {{ retrievalAttribution.distinct }} 个锚点）
        </div>
        <div v-if="retrievalAttribution.rows.length === 0" class="list-hint">
          本次跑批没有未召回的应命中锚点
        </div>
        <div v-else class="attr-list">
          <div
            v-for="r in retrievalAttribution.rows"
            :key="r.key"
            class="attr-row"
            :title="`${r.key}：${r.n} 处`"
          >
            <span class="attr-key">{{ r.key }}</span>
            <span class="attr-track">
              <span
                class="attr-bar"
                :style="{ width: `${(r.n / retrievalAttribution.rows[0].n) * 100}%` }"
              ></span>
            </span>
            <span class="attr-n">{{ r.n }}</span>
          </div>
          <div class="attr-foot">
            计数单位 = （条目, 锚点）对，不是锚点数：同一节被两条条目标为
            <code>expect</code> 时算两处。 药方见同批 md 报告的「未召回归因汇总」表。
          </div>
        </div>

        <!-- 反对照：canary 与负例判红都是**状态**（通过/判红），按项目状态色 + 文字标签出，
             不靠颜色单独表意。canary 全绿是预期值而非告警位——任一条不符时脚本根本不出报告。 -->
        <div class="section-title">反对照与负例</div>
        <div class="l1-note">
          <span :class="canaryFailed === 0 ? 'is-ok' : 'is-bad'">{{ canaryText }}</span>
          <span class="hint">必中条目必须满分、必不中必须零分——测的是测量工具自身的真空性</span>
        </div>
        <div class="l1-note">
          <span :class="negativeRed > 0 ? 'is-bad' : 'is-ok'">
            负例判红 {{ negativeRed }}/{{ retrievalReport.negatives.length }}
          </span>
          <span class="hint">
            判红 = 刻意标注的「误读路径」节被注入了
            prompt；应命中数一并在明细里，用来分开「标错了」与「尺子太宽」
          </span>
        </div>

        <div class="section-title">逐条明细（{{ retrievalReport.scores.length }} 条）</div>
        <div class="retrieval-list">
          <div v-for="s in retrievalReport.scores" :key="s.id" class="retrieval-item">
            <button
              class="retrieval-head"
              :aria-expanded="!!retrievalOpen[s.id]"
              @click="retrievalOpen[s.id] = !retrievalOpen[s.id]"
            >
              <span class="chain-caret">{{ retrievalOpen[s.id] ? '▾' : '▸' }}</span>
              <span class="retrieval-id">{{ s.id }}</span>
              <!-- kind 是**类目**（real / constructed / negative），不是状态：不给它配色。
                   状态色是保留色（见下方 `.is-ok` / `.is-bad` 的注释），拿它染类目会让「红=判红」
                   这条读法失效；类目本身由文字承载。 -->
              <span class="retrieval-kind">{{ s.kind }}</span>
              <span class="retrieval-count">{{ s.hit }}/{{ s.expectTotal }}</span>
              <span class="retrieval-metric">recall {{ fmtRate(s.recall) }}</span>
              <span v-if="s.forbidHit.length > 0" class="retrieval-bad">
                负例命中 {{ s.forbidHit.length }}
              </span>
            </button>
            <div v-if="retrievalOpen[s.id]" class="retrieval-body">
              <div class="retrieval-reason">{{ s.reason }}</div>
              <!-- 锚点状态用 ✓/✗ **加**文字色双编码：状态色是保留色，不能单独承载语义 -->
              <div
                v-for="(d, i) in s.details"
                :key="`${d.docPath}#${d.sectionAnchor}#${i}`"
                class="anchor-row"
              >
                <span class="anchor-mark" :class="d.status === 'injected' ? 'is-ok' : 'is-miss'">
                  {{ d.status === 'injected' ? '✓' : '✗' }}
                </span>
                <span class="anchor-path">
                  {{ d.docPath }}<span class="anchor-sec">#{{ d.sectionAnchor }}</span>
                </span>
                <span v-if="d.status !== 'injected'" class="anchor-tag">{{ anchorLabel(d) }}</span>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- 悬浮说明浮层：挂在视图根上（`position: fixed` 相对视口定位）。
         `.is-placing` 期间透明但**已渲染**——不渲染量不出宽高，定位就无从谈起。 -->
    <div
      v-if="tip"
      ref="tipEl"
      class="span-tip"
      :class="{ 'is-placing': !tipPos }"
      :style="tipPos ? { left: `${tipPos.left}px`, top: `${tipPos.top}px` } : undefined"
      role="tooltip"
    >
      <div class="tip-h">{{ tip.title }}</div>
      <div class="tip-b">{{ tip.body }}</div>
    </div>
  </div>
</template>

<style scoped>
/* ─── 全屏评估中心 ──────────────────────── */

.eval-view {
  position: fixed;
  inset: 0;
  z-index: 600; /* 低于 error-toast(9999)，与设置页同层 */
  background: var(--bg-deep);
  display: flex;
  flex-direction: column;
}

.eval-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
}

.eval-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.eval-title h2 {
  font-size: 16px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: -0.3px;
}

.eval-icon {
  font-size: 18px;
}

.btn-close {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 6px;
  border-radius: var(--radius-sm);
  transition: all var(--ease-out);
  display: flex;
  align-items: center;
  justify-content: center;
}

.btn-close:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

/* ─── Tab 栏 ────────────────────────────── */

.eval-tabs {
  display: flex;
  gap: 4px;
  padding: 0 24px;
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
}

.tab-btn {
  position: relative;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-muted);
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  padding: 10px 14px;
  cursor: pointer;
  transition: all var(--ease-out);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.tab-btn:hover {
  color: var(--text-primary);
}

.tab-btn.active {
  color: var(--accent-text);
  border-bottom-color: var(--accent);
  font-weight: 600;
}

/* 待回标角标（提交成功样本移出 → 角标减一） */
.tab-badge {
  font-size: 10px;
  font-weight: 700;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--text-on-accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.eval-pane {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  box-sizing: border-box;
  width: 100%;
  padding: 20px 28px 32px;
  max-width: 860px;
  margin: 0 auto;
}

/* ─── 通用区块 ──────────────────────────── */

.section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  margin: 0 0 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-subtle);
}

.section-title + .section-title {
  margin-top: 22px;
  padding-top: 16px;
  border-top: 1px solid var(--border-subtle);
}

.list-hint {
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
  padding: 14px 0;
}

.status-spinner {
  display: inline-block;
  width: 16px;
  height: 16px;
  border: 2px solid var(--border-default);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  vertical-align: -3px;
  margin-right: 6px;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.error-msg {
  background: rgba(224, 85, 106, 0.1);
  color: var(--accent-red);
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  margin-top: 12px;
  border: 1px solid rgba(224, 85, 106, 0.2);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.btn-retry-sm {
  padding: 4px 14px;
  border: 1px solid var(--accent-text);
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  color: var(--accent-text);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--ease-out);
  flex-shrink: 0;
}

.btn-retry-sm:hover {
  background: var(--accent);
  color: var(--text-on-accent);
}

/* ─── 聚合卡片 ──────────────────────────── */

.agg-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 10px;
  margin-bottom: 22px;
}

.agg-card {
  background: var(--bg-base);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.agg-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.agg-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.agg-item {
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
  padding: 2px 9px;
}

.agg-bad {
  color: var(--accent-red);
  border-color: rgba(224, 85, 106, 0.3);
}

/* ─── 任务结局分布 ──────────────────────── */

.outcome-card {
  background: var(--bg-base);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 22px;
}

.outcome-bar {
  display: flex;
  height: 10px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--bg-surface);
}

.outcome-seg {
  height: 100%;
  transition: width var(--ease-out);
}

.outcome-success {
  background: #3ecf8e;
}
.outcome-corrected_success {
  background: #67c6a0;
}
.outcome-needs_investigation {
  background: #f2b84a;
}
.outcome-harness_fix_needed {
  background: #e8794a;
}
.outcome-routing_failure {
  background: #e0556a;
}
.outcome-abandoned {
  background: #9a8ab0;
}
.outcome-unclassified {
  background: #6b7a8f;
}

.outcome-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--text-secondary);
}

.legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  background: #6b7a8f;
}

.dot-success {
  background: #3ecf8e;
}
.dot-corrected_success {
  background: #67c6a0;
}
.dot-needs_investigation {
  background: #f2b84a;
}
.dot-harness_fix_needed {
  background: #e8794a;
}
.dot-routing_failure {
  background: #e0556a;
}
.dot-abandoned {
  background: #9a8ab0;
}
.dot-unclassified {
  background: #6b7a8f;
}
.dot-open {
  background: var(--border-default);
}

.done-rate {
  font-size: 12px;
  color: var(--text-secondary);
  padding-top: 10px;
  border-top: 1px solid var(--border-subtle);
}

.done-rate b {
  font-size: 15px;
  color: #3ecf8e;
  margin: 0 4px;
}

.done-rate .hint {
  font-size: 10px;
  color: var(--text-muted);
}

/* ─── 评分列表 ──────────────────────────── */

.score-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.score-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  background: var(--bg-base);
  border: 1px solid var(--border-subtle);
}

.score-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  flex-shrink: 0;
}

.score-num {
  font-size: 12px;
  font-weight: 700;
  color: #3ecf8e;
  flex-shrink: 0;
  min-width: 22px;
}

.score-low {
  color: var(--accent-red);
}

.score-reason {
  font-size: 10px;
  color: var(--text-muted);
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  padding: 1px 8px;
  border-radius: 999px;
}

.score-time {
  margin-left: auto;
  font-size: 10px;
  color: var(--text-muted);
  flex-shrink: 0;
}

/* ─── 回标样本卡 ────────────────────────── */

.pending-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.sample-card {
  background: var(--bg-base);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sample-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.sample-reply {
  font-size: 13px;
  color: var(--text-primary);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
}

.sample-context {
  font-size: 12px;
  color: var(--text-secondary);
}

.sample-context summary {
  cursor: pointer;
  font-size: 11px;
  color: var(--text-muted);
  padding: 4px 0;
}

.ctx-line {
  display: flex;
  gap: 8px;
  padding: 5px 0;
  border-top: 1px dashed var(--border-subtle);
}

.ctx-role {
  font-size: 10px;
  font-weight: 600;
  color: var(--accent-text);
  flex-shrink: 0;
  min-width: 28px;
}

.ctx-text {
  font-size: 12px;
  color: var(--text-secondary);
  word-break: break-word;
  line-height: 1.5;
}

.sample-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.score-picker {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  padding: 3px;
  background: var(--bg-surface);
}

.score-btn {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: all var(--ease-out);
}

.score-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.score-btn.active {
  background: var(--accent);
  color: var(--text-on-accent);
}

.score-label {
  font-size: 11px;
  color: var(--text-secondary);
  padding: 0 6px;
}

.sample-actions .input {
  flex: 1;
  min-width: 140px;
  padding: 7px 11px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: 12px;
  font-family: inherit;
  outline: none;
  transition: border-color var(--ease-out);
}

.sample-actions .input:focus {
  border-color: var(--accent);
}

.btn-submit {
  padding: 7px 18px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--accent);
  color: var(--text-on-accent);
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: all var(--ease-out);
  flex-shrink: 0;
}

.btn-submit:hover:not(:disabled) {
  background: var(--accent-hover);
}

.btn-submit:disabled {
  opacity: 0.4;
  cursor: default;
}

/* ─── 链路 tab（P1）────────────────────── */

.l1-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
  gap: 8px;
}

.l1-card {
  background: var(--bg-base);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.l1-label {
  font-size: 11px;
  color: var(--text-muted);
}

.l1-value {
  font-size: 17px;
  font-weight: 700;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

/* 无数据（null）与 0 必须视觉可分——「我不知道」≠「我没有」 */
.l1-nodata {
  color: var(--text-muted);
  font-weight: 500;
}

.l1-note {
  margin: 10px 0 22px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  font-size: 11px;
  color: var(--text-secondary);
}

.l1-note .hint {
  font-size: 10px;
  color: var(--text-muted);
}

.overview-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 22px;
}

.ov-item {
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-base);
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
  padding: 4px 12px;
}

.ov-item b {
  font-size: 13px;
  color: var(--text-primary);
  margin-left: 3px;
  font-variant-numeric: tabular-nums;
}

.ov-warn {
  color: var(--accent-red);
  border-color: rgba(224, 85, 106, 0.35);
}

.ov-warn b {
  color: var(--accent-red);
}

.ov-dim {
  color: var(--text-muted);
}

.chain-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.chain-card {
  background: var(--bg-base);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  overflow: hidden;
}

/* 含失败跳的链整条可见区分（不只靠「失败 N」这个数字） */
.chain-has-failure {
  border-left: 3px solid var(--accent-red);
}

.chain-orphan {
  border-left: 3px solid #6b7a8f;
}

.orphan-title {
  margin-top: 16px;
}

.chain-head {
  width: 100%;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 10px 12px;
  background: none;
  border: none;
  color: inherit;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--ease-out);
}

.chain-head:hover {
  background: var(--bg-hover);
}

.chain-caret {
  width: 10px;
  flex-shrink: 0;
  font-size: 10px;
  color: var(--text-muted);
}

.chain-item {
  font-size: 12px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.chain-bad {
  color: var(--accent-red);
  font-weight: 600;
}

.chain-note {
  font-size: 11px;
  color: var(--text-muted);
}

.chain-time {
  margin-left: auto;
  font-size: 10px;
  color: var(--text-muted);
}

.hop-list {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--border-subtle);
}

.hop-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px 10px 26px;
  border-bottom: 1px dashed var(--border-subtle);
}

.hop-row:last-child {
  border-bottom: none;
}

.hop-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.hop-agent {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}

.hop-status {
  font-size: 11px;
  color: var(--text-secondary);
}

.hop-err {
  font-size: 10px;
  color: var(--accent-red);
  background: rgba(224, 85, 106, 0.1);
  border-radius: 999px;
  padding: 1px 8px;
}

/* 卡点徽章：四类各一色，且**都带文字**（色盲可读；四值可同时出现） */
.flag-badge {
  font-size: 10px;
  font-weight: 600;
  border-radius: 999px;
  padding: 1px 8px;
  border: 1px solid transparent;
}

.flag-failed {
  color: #e0556a;
  background: rgba(224, 85, 106, 0.12);
  border-color: rgba(224, 85, 106, 0.3);
}

.flag-no_reply {
  color: #e8794a;
  background: rgba(232, 121, 74, 0.12);
  border-color: rgba(232, 121, 74, 0.3);
}

.flag-slow {
  color: #f2b84a;
  background: rgba(242, 184, 74, 0.12);
  border-color: rgba(242, 184, 74, 0.3);
}

.flag-no_data {
  color: #9aa7b8;
  background: rgba(107, 122, 143, 0.14);
  border-color: rgba(107, 122, 143, 0.35);
}

.hop-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}

.hop-sum {
  display: flex;
  align-items: center;
  gap: 8px;
}

.hop-dur {
  font-size: 11px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.hop-clamp {
  font-size: 10px;
  color: var(--text-muted);
  border: 1px dashed var(--border-default);
  border-radius: 999px;
  padding: 1px 7px;
}

/* ─── R3 段瀑布 ───────────────────────────
   每条段一行（Gantt 式）：行序 = 时间序，行内条按「相对根段起点的偏移」定位、
   宽度 = 该段耗时 ÷ 根段耗时。**轴长只认根段**——段是嵌套的，子段之和会超过轴长。 */

.wf {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.wf-head {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11px;
  color: var(--text-secondary);
}

.wf-title {
  font-weight: 600;
  color: var(--text-primary);
}

.wf-total {
  font-variant-numeric: tabular-nums;
}

.wf-legend {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
}

/* ⓘ 字段说明触发区 */
.wf-lg {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--text-muted);
  cursor: help;
}

.info-btn {
  font-size: 11px;
  line-height: 1;
  color: var(--text-muted);
}

.wf-rows {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.wf-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 段名列定宽（各行对齐），但**命中区只有文本本身**——.wf-name-hit 收缩包裹，
   段名右侧的留白不触发浮层（R3 §B7 的反例就靠这条） */
.wf-name {
  width: 172px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  overflow: hidden;
}

.wf-name-hit {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--text-secondary);
  white-space: nowrap;
  cursor: help;
}

.wf-dot {
  width: 6px;
  height: 6px;
  border-radius: 2px;
  flex-shrink: 0;
}

.wf-track {
  flex: 1;
  min-width: 120px;
  height: 9px;
  position: relative;
  background: var(--bg-surface);
  border-radius: 999px;
  overflow: hidden;
}

.wf-bar {
  position: absolute;
  top: 0;
  height: 100%;
  border-radius: 2px;
  /* 0ms 段（token_wait / reply.persist 实测常见）仍要看得见——
     给个像素下限；非退化段不受影响，宽度语义仍是 duration ÷ 轴长 */
  min-width: 2px;
}

/* **定宽**：数值列宽度若随内容变（llm.chat 行多一个「首字」徽章、失败行多一个状态徽章），
   `flex: 1` 的 `.wf-track` 就被挤窄 ⇒ **各行轴宽不等，跨行位置不可比**。
   真机实测：llm.chat 行轴 408px vs 其余 460px，极差 52px —— 同一时刻在两行里画在不同 x 上，
   最大偏 12% 轴长，正好砸掉「时间序一眼看出卡在哪」。轴是**整条瀑布的属性，不是每行各自的**。 */
.wf-nums {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex: 0 0 200px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.wf-ttft {
  color: var(--text-muted);
}

.wf-dur {
  min-width: 54px;
  text-align: right;
  color: var(--text-secondary);
}

.wf-share {
  min-width: 54px;
  text-align: right;
  color: var(--text-muted);
}

.wf-badge {
  font-size: 10px;
  font-weight: 600;
  color: var(--accent-red);
  background: rgba(224, 85, 106, 0.12);
  border: 1px solid rgba(224, 85, 106, 0.3);
  border-radius: 999px;
  padding: 0 7px;
}

/* 段相位配色（按 R2 §五 的语义分组，不按段名硬编 11 色） */
.ph-wait {
  background: #6b7a8f;
}

.ph-orch {
  background: #8a7bd8;
}

.ph-retr {
  background: #4aa8e0;
}

.ph-llm {
  background: #3ecf8e;
}

.ph-pers {
  background: #d8a24a;
}

/* 失败 / 超时压过相位色——必须排在 .ph-* 之后，否则同特异度下被盖掉 */
.bar-bad {
  background: #e0556a;
}

/* 根段描边：一眼认出「总时长的那一条」 */
.bar-root {
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.35);
}

/* 轴外段：不进瀑布、不计总时长，单行文字标注 */
.wf-outside {
  font-size: 10px;
  color: var(--text-muted);
  padding-left: 180px;
}

.wf-foot {
  font-size: 10px;
  color: var(--text-muted);
}

.wf-nodata {
  font-size: 11px;
  color: var(--text-muted);
}

.wf-err {
  font-size: 11px;
  color: var(--accent-red);
}

/* ─── 悬浮说明浮层（自绘，非原生 `title`）───────────────── */

.span-tip {
  position: fixed;
  z-index: 10000;
  max-width: 320px;
  padding: 8px 10px;
  background: var(--bg-raised);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-lg);
  /* 不吃指针事件：否则浮层一出就截断 hover，自己把自己关掉（抖动） */
  pointer-events: none;
}

.span-tip.is-placing {
  opacity: 0;
}

.tip-h {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.tip-b {
  font-size: 11px;
  line-height: 1.55;
  color: var(--text-secondary);
}

/* ─── 检索 tab（E1）─────────────────────── */

/* 快照声明条：**承重件**，不是装饰。它要拦的误读代价最高——把一份历史报告当成当前
   水位去下结论。故做成高对比的一条，而不是一行灰色小字。 */
.snapshot-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  background: var(--accent-tint);
  border: 1px solid var(--accent-hint-border);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  margin-bottom: 22px;
}

.snapshot-tag {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  color: var(--text-on-accent);
  background: var(--accent);
  border-radius: 999px;
  padding: 2px 8px;
}

.snapshot-text {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.6;
}

.snapshot-at {
  color: var(--text-muted);
}

/* 日期选择器 = 切快照（报告是手工跑的，不是时间轴缩放） */
.retrieval-date {
  margin-left: auto;
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: 12px;
  padding: 4px 8px;
  cursor: pointer;
}

.retrieval-cmd {
  font-size: 11px;
  color: var(--accent-text);
  background: var(--accent-tint);
  border-radius: var(--radius-sm);
  padding: 1px 5px;
}

/* stat tile 的第三行：`l1-value` 给主读数，这里给「它是拿什么算的」（分母 / 口径） */
.l1-sub {
  font-size: 10px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.golden-count {
  margin-left: 6px;
  color: var(--text-muted);
}

/* ─── 归因分布：单一色相按长度编码 ─────── */
/* 类目名是文字标签、长度是唯一的视觉编码 ⇒ **不按类目换色**（换了颜色，读者会去找一个
   并不存在的分组含义）。条形锚在左基线，自由端 4px 圆角；行距即填充间隙。 */
.attr-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 22px;
}

.attr-row {
  display: grid;
  grid-template-columns: 120px 1fr 36px;
  align-items: center;
  gap: 10px;
}

.attr-key {
  font-size: 11px;
  color: var(--text-secondary);
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attr-track {
  height: 14px;
  background: var(--bg-surface);
  border-radius: 0 4px 4px 0;
  overflow: hidden;
}

.attr-bar {
  display: block;
  height: 100%;
  background: var(--accent);
  border-radius: 0 4px 4px 0;
}

.attr-n {
  font-size: 11px;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.attr-foot {
  font-size: 10px;
  color: var(--text-muted);
  line-height: 1.6;
  margin-top: 2px;
}

/* 状态色是**保留色**：通过 / 判红一律图标 + 文字双编码，不靠颜色单独表意——绿色与红色
   在色觉障碍下不可分，而这一栏恰恰是判「尺子还准不准」的地方。 */
.is-ok {
  color: var(--accent-green);
  font-weight: 600;
}

.is-bad {
  color: var(--accent-red);
  font-weight: 600;
}

/* ─── 逐条明细 ─────────────────────────── */

.retrieval-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 22px;
}

.retrieval-item {
  background: var(--bg-base);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.retrieval-head {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  background: none;
  border: none;
  color: inherit;
  font: inherit;
  text-align: left;
  padding: 8px 12px;
  cursor: pointer;
  transition: background var(--ease-out);
}

.retrieval-head:hover {
  background: var(--bg-hover);
}

.retrieval-id {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
  min-width: 44px;
}

.retrieval-kind {
  font-size: 10px;
  color: var(--text-muted);
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
  padding: 1px 7px;
}

.retrieval-count,
.retrieval-metric {
  font-size: 11px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.retrieval-bad {
  margin-left: auto;
  font-size: 10px;
  color: var(--accent-red);
  background: rgba(224, 85, 106, 0.1);
  border-radius: 999px;
  padding: 1px 8px;
}

.retrieval-body {
  padding: 0 12px 10px 32px;
  border-top: 1px solid var(--border-subtle);
}

.retrieval-reason {
  font-size: 11px;
  color: var(--text-muted);
  padding: 8px 0 4px;
}

.anchor-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 4px 0;
  border-top: 1px dashed var(--border-subtle);
}

.anchor-mark {
  flex-shrink: 0;
  font-size: 10px;
  width: 12px;
}

.anchor-mark.is-ok {
  color: var(--accent-green);
}

.anchor-mark.is-miss {
  color: var(--accent-red);
}

.anchor-path {
  font-size: 11px;
  color: var(--text-secondary);
  word-break: break-all;
}

.anchor-sec {
  color: var(--text-muted);
}

.anchor-tag {
  margin-left: auto;
  flex-shrink: 0;
  font-size: 10px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
</style>
