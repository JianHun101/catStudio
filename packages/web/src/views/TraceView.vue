<script setup lang="ts">
/**
 * 全屏「执行追踪」查询页（T2，左侧轨道 ⚙ 入口 / 气泡 footer ⚙ 带预选进入）。
 *
 * **为什么是独立查询页而不是气泡内联展开**（用户裁决链，票 §一）：排障要先**横向比**
 * 再**纵向看**——「今天哪几次失败了 / 哪次特别慢」在列表层一眼可见，内联展开只能一条条点。
 * 会话右侧面板的成员卡内联 trace **保留不动**：那是「这只猫现在在干嘛」的会话级视角，
 * 与「这一次执行经历了什么」互补（票 §四 边界）。
 *
 * 取数分**两档**（与服务端同样的切分，见 `routes/eval.ts` 该节头注）：
 * · 行一展开 → `/execution-detail`（执行行 + 决策逐条 + 节清单，都很小）+ `/spans`（瀑布）；
 * · 三小节**再**点开 → `/prompt-section`（单节全文可达数十 KB）/ `/retrieval-detail`（候选几十条）。
 *   首屏不为「用户可能不看的那几节」付带宽。
 *
 * 三条诚实性口径（票面明写，不许在渲染层抹平）：
 * 1. **token 一律带「估」标**——适配器不回流真实 usage（R2 边界），这些数是
 *    `estimateTokens` 估的，不当精确值展示。
 * 2. **存量行显示「无段数据（存量行）」而非报错**——T2 之前的所有执行都没有本票的
 *    两表数据，那不是错误。
 * 3. **`totalMs === null` 显示「—」不显示 0**——0ms 与「没数」是两回事。
 */
import { ref, computed, watch, onMounted } from 'vue'
import {
  api,
  type ExecutionTraceRow,
  type ExecutionDetailResponse,
  type PromptSectionMeta,
  type RetrievalQueryRow,
  type RetrievalCandidateRow,
  type SpanDto,
} from '@/composables/useApi'
import { buildWaterfall, fmtMs, splitMicroSpans, type Waterfall } from '@/utils/spanLayout'
import { fmtUtcShort } from '@/utils/time'
import { useChatStore } from '@/stores/chat'

const props = defineProps<{
  /** 从气泡 ⚙ 进来时预选的执行 id（null = 从轨道直接进来） */
  preselectExecutionId?: string | null
}>()

const emit = defineEmits<{
  close: []
  jumpToMessage: [messageId: string, sessionId: string]
}>()

const store = useChatStore()

// ─── 过滤栏 ────────────────────────────────────────────────

/** 默认 = 当前会话 + 近 50 条 + 全部状态（票 §三A 的默认口径）。
 *  `activeSessionId` 可能为 null（还没进任何会话）⇒ 不传该维 = 跨会话看全部。 */
const fSessionId = ref<string>(store.activeSessionId ?? '')
const fAgentId = ref<string>('')
const fStatus = ref<string>('')
/** 单位**秒**（UI 是秒），发请求时换算成毫秒——两侧口径不同面，换算只在这一处 */
const fMinLatencySec = ref<number | null>(null)
const fErrorsOnly = ref(false)
const PAGE_SIZE = 50
const offset = ref(0)

const total = ref(0)
const rows = ref<ExecutionTraceRow[]>([])
const listLoading = ref(false)
const listError = ref('')

/** 只按**已加载的行**归集猫选项：跨会话看全部时，全部猫的清单可能很长，
 *  而「列表里出现过的猫」才是用户此刻能筛的对象（选了必然有结果）。 */
const agentOptions = computed(() => {
  const seen = new Map<string, string>()
  for (const r of rows.value) seen.set(r.agentId, r.agentName ?? r.agentId)
  return [...seen.entries()].map(([id, name]) => ({ id, name }))
})

async function load(): Promise<void> {
  listLoading.value = true
  listError.value = ''
  try {
    const res = await api.getTraceExecutions({
      sessionId: fSessionId.value || undefined,
      agentId: fAgentId.value || undefined,
      status: fStatus.value || undefined,
      minLatencyMs:
        fMinLatencySec.value === null || Number.isNaN(fMinLatencySec.value)
          ? undefined
          : Math.max(0, Math.round(fMinLatencySec.value * 1000)),
      errorsOnly: fErrorsOnly.value,
      limit: PAGE_SIZE,
      offset: offset.value,
    })
    rows.value = res.executions
    total.value = res.total
  } catch (err: any) {
    listError.value = err?.message ?? '加载失败'
    rows.value = []
    total.value = 0
  } finally {
    listLoading.value = false
  }
}

/** 改任一过滤条件都回第一页（停在第 3 页看新条件的结果是错位的）。 */
function reload(): void {
  offset.value = 0
  void load()
}

const page = computed(() => Math.floor(offset.value / PAGE_SIZE) + 1)
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)))

function goto(delta: number): void {
  const next = offset.value + delta * PAGE_SIZE
  if (next < 0 || next >= total.value) return
  offset.value = next
  void load()
}

watch([fSessionId, fAgentId, fStatus, fMinLatencySec, fErrorsOnly], reload)

// ─── 行详情（展开才拉）────────────────────────────────────

const expandedId = ref<string | null>(null)
const detail = ref<ExecutionDetailResponse | null>(null)
const detailLoading = ref(false)
const detailError = ref('')
const spans = ref<SpanDto[]>([])

/** 瀑布几何（唯一真相源在 `utils/spanLayout.ts`，与成员卡/评估页同一份） */
const waterfall = computed<Waterfall | null>(() =>
  spans.value.length > 0 ? buildWaterfall(spans.value) : null
)
/** 微段折叠（同一口径：占比 < 1% 的段不画进条，只汇总一行） */
const shownRows = computed(() =>
  waterfall.value ? splitMicroSpans(waterfall.value.rows, waterfall.value.axisMs).shown : []
)
/** 轴外段（排队等待那类「起点早于根段」的段）——取自 config，不在模板里再算一遍 */
const outsideRows = computed(() => waterfall.value?.outside ?? [])
const microInfo = computed(() => {
  if (!waterfall.value) return null
  const { micro } = splitMicroSpans(waterfall.value.rows, waterfall.value.axisMs)
  if (micro.length === 0) return null
  const ms = micro.reduce((s, r) => s + r.durationMs, 0)
  return { count: micro.length, text: fmtMs(ms) }
})

async function toggleRow(row: ExecutionTraceRow): Promise<void> {
  if (expandedId.value === row.executionId) {
    expandedId.value = null
    return
  }
  expandedId.value = row.executionId
  detail.value = null
  detailError.value = ''
  spans.value = []
  detailLoading.value = true
  // 段与详情**并行**取：两者互不依赖，串行会白等一个往返
  const [d, s] = await Promise.allSettled([
    api.getExecutionDetail(row.executionId),
    api.getEvalSpans(row.executionId),
  ])
  if (expandedId.value !== row.executionId) return // 用户已切走，丢弃这次的结果
  if (d.status === 'fulfilled') detail.value = d.value
  else detailError.value = (d.reason as any)?.message ?? '详情加载失败'
  if (s.status === 'fulfilled') spans.value = s.value.spans ?? []
  detailLoading.value = false
}

// ─── 三折叠小节（懒加载）──────────────────────────────────

type SubKey = 'context' | 'retrieval' | 'prompt'
const openSub = ref<Set<SubKey>>(new Set())

function toggleSub(key: SubKey): void {
  const s = new Set(openSub.value)
  if (s.has(key)) s.delete(key)
  else s.add(key)
  openSub.value = s
  if (key === 'retrieval' && s.has('retrieval')) void loadRetrieval()
}

const retrievalQueries = ref<RetrievalQueryRow[]>([])
const retrievalCandidates = ref<RetrievalCandidateRow[]>([])
const retrievalDropped = ref<Record<string, number>>({})
const retrievalLoaded = ref(false)
const retrievalLoading = ref(false)

async function loadRetrieval(): Promise<void> {
  const id = expandedId.value
  if (!id || retrievalLoaded.value || retrievalLoading.value) return
  retrievalLoading.value = true
  try {
    const res = await api.getRetrievalDetail(id)
    if (expandedId.value !== id) return
    retrievalQueries.value = res.queries
    retrievalCandidates.value = res.candidates
    retrievalDropped.value = res.droppedReasons ?? {}
    retrievalLoaded.value = true
  } catch {
    // 懒加载失败不炸整页：小节内显示空态即可（详情主体仍在）
  } finally {
    retrievalLoading.value = false
  }
}

/** 丢弃原因的中文名——**唯一表述点**（前端别处不再各写一份映射） */
const DROPPED_LABEL: Record<string, string> = {
  threshold: '距离超阈值',
  status: '状态过滤（superseded 等）',
  not_topk: '未进 topK',
  budget: '超 token 预算',
  section_dup: '同节已有代表片',
}

// ─── prompt 快照（逐节懒加载正文）─────────────────────────

const sectionContent = ref<Record<string, string>>({})
const sectionLoading = ref<string | null>(null)

async function toggleSection(meta: PromptSectionMeta): Promise<void> {
  const id = expandedId.value
  if (!id) return
  if (sectionContent.value[meta.sectionKey] !== undefined) {
    // 已加载 → 折叠（从记录里删掉即收起，与 openSub 的 Set 语义一致）
    const next = { ...sectionContent.value }
    delete next[meta.sectionKey]
    sectionContent.value = next
    return
  }
  sectionLoading.value = meta.sectionKey
  try {
    const res = await api.getPromptSection(id, meta.sectionKey)
    if (expandedId.value !== id) return
    sectionContent.value = { ...sectionContent.value, [meta.sectionKey]: res.content }
  } catch (err: any) {
    if (expandedId.value === id) {
      sectionContent.value = {
        ...sectionContent.value,
        [meta.sectionKey]: `[加载失败] ${err?.message ?? ''}`,
      }
    }
  } finally {
    sectionLoading.value = null
  }
}

/** 展开新行时清空上一行的三小节与正文缓存（缓存按 executionId 记就必须一起清，
 *  否则会串到下一行——症状是「点开 B 行看到 A 行的 prompt」）。 */
watch(expandedId, () => {
  openSub.value = new Set(expandedId.value ? ['context'] : [])
  sectionContent.value = {}
  retrievalQueries.value = []
  retrievalCandidates.value = []
  retrievalDropped.value = {}
  retrievalLoaded.value = false
})

// ─── 展示助手 ─────────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  running: '进行中',
  completed: '完成',
  failed: '失败',
  queued: '排队',
}

function statusText(s: string): string {
  return STATUS_LABEL[s] ?? s
}

/** 耗时：null → 「—」（**不是 0**）。秒级以下保留整数毫秒。 */
function msText(ms: number | null): string {
  return ms === null ? '—' : fmtMs(ms)
}

/** 检索漏斗文案。`skipped-a2a` 是「A2A 触发且记忆门关」——**不是**「没检索到」。 */
function funnelText(r: ExecutionTraceRow): string {
  if (r.retrievalReason === 'skipped-a2a') return '未检索（A2A）'
  if (r.retrievalReason === null) return '未检索'
  return `注入${r.injectedSections}节 · 引${r.citationCount}`
}

function decisionText(d: { decision: string; detail: string | null }): string {
  const base =
    d.decision === 'kept'
      ? '筛入'
      : d.decision === 'invisible'
        ? '不可见'
        : d.decision === 'summary_replaced'
          ? '摘要替代'
          : '超预算截断'
  return d.detail === 'replied' ? `${base}（已回复标注）` : base
}

function decisionClass(decision: string): string {
  return `dc-${decision}`
}

/** 节状态的中文与配色（注入绿 / 截断黄 / 空灰） */
const SECTION_STATUS: Record<string, { text: string; cls: string }> = {
  injected: { text: '已注入', cls: 'ss-ok' },
  truncated: { text: '已截断', cls: 'ss-warn' },
  empty: { text: '本轮为空', cls: 'ss-empty' },
}

function sectionStatus(s: string): { text: string; cls: string } {
  return SECTION_STATUS[s] ?? { text: s, cls: 'ss-empty' }
}

/**
 * 报错类型的**处置提示**。**唯一表述点**——别在模板里再散一份。
 * 值域取自 `execution_logs.error_type` 的既有分类桶（L1 分类 + `server_restart`）；
 * 认不出的类型**原样不提示**（宁可不说，不要瞎指方向 —— 错的处置建议比没有建议更贵）。
 */
const ERROR_HINT: Record<string, string> = {
  timeout: '执行超过 AGENT_HARD_TIMEOUT_MS 硬上限被中止——本轮上下文或工具调用可能过重。',
  quota: '上游配额或余额不足（常见 402）——本轮**不会自动重派**，需换 key 或充值后手动重发。',
  auth: '上游鉴权失败（401/403）——查该猫的 llm_api_key 配置。',
  network: '网络不可达或连接被中断——先查代理与端口占用（本仓有代理失效前科）。',
  server_restart: 'server 重启打断了在飞执行——恢复链会自动重派；若长期停在 failed 查 recovery。',
}

function errorHint(t: string | null): string {
  return t ? (ERROR_HINT[t] ?? '') : ''
}

onMounted(async () => {
  await load()
  // 预选（气泡 ⚙ 进来）：放到列表加载后——`expandedId` 若不在这页里，
  // 展开区会是空的，用户以为点了没反应
  const pre = props.preselectExecutionId
  if (pre) {
    const hit = rows.value.find((r) => r.executionId === pre)
    if (hit) await toggleRow(hit)
  }
})
</script>

<template>
  <div class="trace-view" role="dialog" aria-modal="true" aria-label="执行追踪">
    <header class="tv-header">
      <div class="tv-title">
        <span class="tv-icon">⚙</span>
        <h2>执行追踪</h2>
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

    <!-- ─── 过滤栏 ─────────────────────────────── -->
    <div class="tv-filters">
      <label class="tf">
        <span class="tf-l">会话</span>
        <select v-model="fSessionId">
          <option value="">全部</option>
          <option v-for="s in store.sessions" :key="s.id" :value="s.id">{{ s.title }}</option>
        </select>
      </label>
      <label class="tf">
        <span class="tf-l">猫</span>
        <select v-model="fAgentId">
          <option value="">全部</option>
          <option v-for="a in agentOptions" :key="a.id" :value="a.id">{{ a.name }}</option>
        </select>
      </label>
      <label class="tf">
        <span class="tf-l">状态</span>
        <select v-model="fStatus" :disabled="fErrorsOnly">
          <option value="">全部</option>
          <option value="completed">完成</option>
          <option value="failed">失败</option>
          <option value="running">进行中</option>
        </select>
      </label>
      <label class="tf">
        <span class="tf-l">耗时 &gt;</span>
        <input v-model.number="fMinLatencySec" type="number" min="0" step="1" placeholder="不限" />
        <span class="tf-u">s</span>
      </label>
      <label class="tf tf-chk">
        <input v-model="fErrorsOnly" type="checkbox" />
        <span>仅看报错</span>
      </label>
      <span class="tf-count">共 {{ total }} 条</span>
      <button class="btn-ghost" :disabled="listLoading" @click="reload">刷新</button>
    </div>

    <!-- ─── 列表 ──────────────────────────────── -->
    <div class="tv-list">
      <div v-if="listLoading" class="tv-hint">加载中…</div>
      <div v-else-if="listError" class="tv-hint tv-err">加载失败：{{ listError }}</div>
      <div v-else-if="rows.length === 0" class="tv-hint">没有匹配的执行</div>

      <template v-else>
        <div
          v-for="r in rows"
          :key="r.executionId"
          class="tv-row"
          :class="{ 'row-failed': r.status === 'failed', 'row-open': expandedId === r.executionId }"
        >
          <!-- 行头：六个读数（时间/猫/摘要/状态/耗时/检索漏斗） -->
          <div
            class="row-head"
            role="button"
            tabindex="0"
            :aria-expanded="expandedId === r.executionId"
            @click="toggleRow(r)"
            @keydown.enter.prevent="toggleRow(r)"
            @keydown.space.prevent="toggleRow(r)"
          >
            <span class="rh-time">{{ r.startedAt ? fmtUtcShort(r.startedAt) : '—' }}</span>
            <span class="rh-avatar">{{ r.agentAvatar ?? '🐱' }}</span>
            <span class="rh-agent">{{ r.agentName ?? r.agentId }}</span>
            <span class="rh-sum">{{ r.summary || '（无正文）' }}</span>
            <span class="rh-status" :class="`st-${r.status}`">{{ statusText(r.status) }}</span>
            <!-- failed 行把报错类型直接写在行上：「猫没动静」类问题在列表层就有答案 -->
            <span v-if="r.errorType" class="rh-err">{{ r.errorType }}</span>
            <span class="rh-ms">{{ msText(r.totalMs) }}</span>
            <span class="rh-funnel">{{ funnelText(r) }}</span>
            <span class="rh-caret">{{ expandedId === r.executionId ? '▾' : '▸' }}</span>
          </div>

          <!-- 展开详情（就地，不跳走） -->
          <div v-if="expandedId === r.executionId" class="row-detail">
            <div v-if="detailLoading" class="tv-hint">详情加载中…</div>
            <div v-else-if="detailError" class="tv-hint tv-err">{{ detailError }}</div>

            <template v-else-if="detail">
              <!-- ① 瀑布（复用 spanLayout，失败段标红） -->
              <div class="dsec">
                <div class="dsec-h">
                  时间轴
                  <span class="dsec-note">段是嵌套的，总时长只认根段 invoke_agent</span>
                </div>
                <!-- 在飞执行**必然**没有段（`ExecTrace` 内存累积、`finish()` 才落库），
                     那不是「存量行」——把它显示成存量行会让用户以为这条老数据没采集。
                     两态必须分开说，否则下次有人排障会把「还在跑」读成「没采到」。 -->
                <div v-if="!waterfall" class="dsec-empty">
                  {{
                    detail.execution.status === 'running'
                      ? '段数据在本次执行收尾时一次性落库——它还在跑，此刻库里确实一行段都没有'
                      : '无段数据（存量行）'
                  }}
                </div>
                <template v-else>
                  <div class="segbar">
                    <span
                      v-for="sr in shownRows"
                      :key="sr.key"
                      class="seg"
                      :class="[`ph-${sr.phase}`, { 'seg-err': sr.bad }]"
                      :style="{ left: `${sr.leftPct}%`, width: `${sr.widthPct}%` }"
                    ></span>
                  </div>
                  <div class="seglist">
                    <div v-for="sr in shownRows" :key="sr.key" class="segrow">
                      <span class="swatch" :class="[`ph-${sr.phase}`, { 'sw-err': sr.bad }]"></span>
                      <span class="segn">{{ sr.name }}</span>
                      <span v-if="sr.bad" class="segflag">{{ sr.status }}</span>
                      <span v-if="sr.ttftText" class="segttft">首字 {{ sr.ttftText }}</span>
                      <span class="segd">{{ fmtMs(sr.durationMs) }}</span>
                      <span class="segp">{{ sr.sharePct }}</span>
                    </div>
                    <div v-if="microInfo" class="segrow rest">
                      <span class="swatch sw-rest"></span>
                      <span class="segn">已折叠 {{ microInfo.count }} 个微段</span>
                      <span class="segd">{{ microInfo.text }}</span>
                    </div>
                  </div>
                </template>
                <!-- 轴外段：不进瀑布、不计总时长，只作单行标注（文案由 spanLayout 组装） -->
                <div v-for="o in outsideRows" :key="o.key" class="seg-outside">
                  {{ o.text }}
                </div>
                <!-- token 一律带「估」标：适配器不回流真实 usage（R2 边界） -->
                <div class="dsec-meta">
                  估算 token：输入 {{ detail.execution.promptTokens ?? '—' }} · 输出
                  {{ detail.execution.completionTokens ?? '—' }}
                  <span class="est-tag">估</span>
                  <template v-if="detail.retrieval">
                    · 记忆 {{ detail.retrieval.contextTokens ?? '—' }} / 预算
                    {{ detail.retrieval.budgetTokens ?? '—' }}
                    <span class="est-tag">估</span>
                  </template>
                </div>
              </div>

              <!-- ② 上下文决策（默认展开——排障最常问「这条回复看到了什么」） -->
              <div class="dsec">
                <button class="dsec-h dsec-btn" @click="toggleSub('context')">
                  <span class="caret">{{ openSub.has('context') ? '▾' : '▸' }}</span>
                  上下文决策
                  <span class="dsec-note">
                    筛入 {{ detail.context.counts.kept }} · 筛出
                    {{ detail.context.total - detail.context.counts.kept }}
                    （不可见 {{ detail.context.counts.invisible }} · 摘要替代
                    {{ detail.context.counts.summary_replaced }} · 超预算
                    {{ detail.context.counts.budget }}）
                  </span>
                </button>
                <div v-if="openSub.has('context')" class="dsec-body">
                  <div v-if="!detail.hasDetails" class="dsec-empty">
                    无决策数据（存量行）——本条执行发生在 T2 上线之前
                  </div>
                  <template v-else>
                    <div v-for="d in detail.context.decisions" :key="d.ordinal" class="dc-row">
                      <span class="dc-ord">{{ d.ordinal }}</span>
                      <span class="dc-role">{{ d.role ?? '?' }}</span>
                      <span class="dc-dec" :class="decisionClass(d.decision)">{{
                        decisionText(d)
                      }}</span>
                      <span class="dc-head">{{ d.content_head ?? '（正文已随消息删除）' }}</span>
                    </div>
                    <div v-if="detail.context.decisions.length === 0" class="dsec-empty">
                      本轮上下文为空
                    </div>
                  </template>
                </div>
              </div>

              <!-- ③ 检索明细（懒加载） -->
              <div class="dsec">
                <button class="dsec-h dsec-btn" @click="toggleSub('retrieval')">
                  <span class="caret">{{ openSub.has('retrieval') ? '▾' : '▸' }}</span>
                  检索明细
                  <span class="dsec-note">
                    <template v-if="detail.retrieval">
                      {{ detail.retrieval.reason }} · {{ detail.retrieval.retrievalMs ?? '—' }}ms ·
                      阈值
                      {{ detail.retrieval.thresholdMaxDistance }}
                    </template>
                    <template v-else>本轮无检索流水</template>
                  </span>
                </button>
                <div v-if="openSub.has('retrieval')" class="dsec-body">
                  <div v-if="retrievalLoading" class="dsec-empty">明细加载中…</div>
                  <template v-else>
                    <div v-if="retrievalQueries.length > 0" class="rq-list">
                      <div v-for="q in retrievalQueries" :key="q.id" class="rq-row">
                        <span class="rq-i">{{
                          q.query_index === 0 ? '原话' : `改写${q.query_index}`
                        }}</span>
                        <span class="rq-t">{{ q.query_text }}</span>
                        <span class="rq-e" :class="{ bad: !q.query_embed_ok }">
                          {{ q.query_embed_ok ? '向量 ok' : '向量失败' }}
                        </span>
                      </div>
                    </div>
                    <div v-if="Object.keys(retrievalDropped).length > 0" class="rd-list">
                      <span class="rd-t">丢弃原因：</span>
                      <span v-for="(n, k) in retrievalDropped" :key="k" class="rd-chip">
                        {{ DROPPED_LABEL[k] ?? k }} {{ n }}
                      </span>
                    </div>
                    <div v-if="retrievalCandidates.length === 0" class="dsec-empty">
                      无候选（本轮未检索或库中无流水）
                    </div>
                    <table v-else class="rc-table">
                      <thead>
                        <tr>
                          <th>源</th>
                          <th>位次</th>
                          <th>距离</th>
                          <th>RRF</th>
                          <th>注入</th>
                          <th>文档 / 节</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr
                          v-for="c in retrievalCandidates"
                          :key="c.id"
                          :class="{ 'rc-inj': c.injected === 1 }"
                        >
                          <td>{{ c.source }}</td>
                          <td>{{ c.final_rank ?? c.rank ?? '—' }}</td>
                          <td>{{ c.distance === null ? '关键词' : c.distance.toFixed(3) }}</td>
                          <td>{{ c.rrf_score === null ? '—' : c.rrf_score.toFixed(4) }}</td>
                          <td>
                            <span v-if="c.injected === 1" class="rc-yes"
                              >[{{ c.injected_position }}]</span
                            >
                            <span v-else class="rc-no">{{
                              c.dropped_reason
                                ? (DROPPED_LABEL[c.dropped_reason] ?? c.dropped_reason)
                                : '否'
                            }}</span>
                          </td>
                          <td class="rc-doc">
                            {{ c.breadcrumb ?? `${c.doc_path} > ${c.section_anchor}` }}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </template>
                </div>
              </div>

              <!-- ④ prompt 快照（懒加载逐节正文） -->
              <div class="dsec">
                <button class="dsec-h dsec-btn" @click="toggleSub('prompt')">
                  <span class="caret">{{ openSub.has('prompt') ? '▾' : '▸' }}</span>
                  prompt 快照
                  <span class="dsec-note">点开任一节看**当次实际注入的原文**</span>
                </button>
                <div v-if="openSub.has('prompt')" class="dsec-body">
                  <div v-if="detail.promptSections.length === 0" class="dsec-empty">
                    无快照数据（存量行）
                  </div>
                  <template v-else>
                    <div v-for="m in detail.promptSections" :key="m.sectionKey" class="ps-row">
                      <button class="ps-head" @click="toggleSection(m)">
                        <span class="ps-caret">{{
                          sectionContent[m.sectionKey] !== undefined ? '▾' : '▸'
                        }}</span>
                        <span class="ps-label">{{ m.label }}</span>
                        <span class="ps-status" :class="sectionStatus(m.status).cls">
                          {{ sectionStatus(m.status).text }}
                        </span>
                        <span class="ps-chars">{{ m.charCount }} 字符</span>
                      </button>
                      <pre v-if="sectionContent[m.sectionKey] !== undefined" class="ps-body">{{
                        sectionLoading === m.sectionKey ? '加载中…' : sectionContent[m.sectionKey]
                      }}</pre>
                    </div>
                  </template>
                </div>
              </div>

              <!-- ⑤ 错误原文（failed 时默认展开，其余态不出现） -->
              <div v-if="detail.execution.errorMessage" class="dsec dsec-error">
                <div class="dsec-h err-h">
                  错误原文
                  <span class="err-type">{{ detail.execution.errorType ?? 'unknown' }}</span>
                </div>
                <pre class="err-body">{{ detail.execution.errorMessage }}</pre>
                <div class="err-hint">{{ errorHint(detail.execution.errorType) }}</div>
              </div>

              <div class="detail-foot">
                <button
                  v-if="detail.execution.messageId"
                  class="btn-ghost"
                  @click="
                    emit('jumpToMessage', detail.execution.messageId, detail.execution.sessionId)
                  "
                >
                  跳到该回复气泡 ↗
                </button>
                <span class="foot-id">执行 {{ detail.execution.executionId }}</span>
              </div>
            </template>
          </div>
        </div>
      </template>
    </div>

    <!-- ─── 分页 ──────────────────────────────── -->
    <div v-if="total > PAGE_SIZE" class="tv-pager">
      <button class="btn-ghost" :disabled="offset === 0" @click="goto(-1)">上一页</button>
      <span class="pg-info">{{ page }} / {{ pageCount }}</span>
      <button class="btn-ghost" :disabled="offset + PAGE_SIZE >= total" @click="goto(1)">
        下一页
      </button>
    </div>
  </div>
</template>

<style scoped>
/* ─── 全屏执行追踪 ──────────────────────── */

.trace-view {
  position: fixed;
  inset: 0;
  z-index: 600; /* 低于 error-toast(9999)，与设置/评估页同层 */
  background: var(--bg-deep);
  display: flex;
  flex-direction: column;
}

.tv-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
}

.tv-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.tv-title h2 {
  font-size: 16px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: -0.3px;
}

.tv-icon {
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

/* ─── 过滤栏 ────────────────────────────── */

.tv-filters {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 24px;
  border-bottom: 1px solid var(--border-subtle);
  flex-wrap: wrap;
  flex-shrink: 0;
}

.tf {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
}

.tf-l {
  color: var(--text-muted);
}

.tf select,
.tf input[type='number'] {
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: 12px;
  padding: 4px 8px;
  font-family: inherit;
}

.tf input[type='number'] {
  width: 72px;
}

.tf select:disabled {
  opacity: 0.5;
}

.tf-u {
  color: var(--text-muted);
}

.tf-chk {
  cursor: pointer;
}

.tf-count {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-muted);
}

.btn-ghost {
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: 12px;
  padding: 5px 12px;
  cursor: pointer;
  font-family: inherit;
  transition: all var(--ease-out);
}

.btn-ghost:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.btn-ghost:disabled {
  opacity: 0.45;
  cursor: default;
}

/* ─── 列表 ──────────────────────────────── */

.tv-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 24px 24px;
}

.tv-hint {
  padding: 24px;
  color: var(--text-muted);
  font-size: 13px;
  text-align: center;
}

.tv-err {
  color: var(--accent-red);
}

.tv-row {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  margin-bottom: 6px;
  background: var(--bg-surface);
  overflow: hidden;
}

/* 失败行整行淡红：扫列表时「哪几次挂了」一眼可见 */
.tv-row.row-failed {
  background: rgba(224, 85, 106, 0.07);
  border-color: rgba(224, 85, 106, 0.28);
}

.tv-row.row-open {
  border-color: var(--border-focus);
}

.row-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  cursor: pointer;
  font-size: 12.5px;
  outline: none;
}

.row-head:hover,
.row-head:focus-visible {
  background: var(--accent-row-hover);
}

.rh-time {
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 11.5px;
  flex-shrink: 0;
  width: 84px;
}

.rh-avatar {
  flex-shrink: 0;
}

.rh-agent {
  color: var(--text-primary);
  font-weight: 600;
  flex-shrink: 0;
  width: 64px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rh-sum {
  flex: 1;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.rh-status {
  flex-shrink: 0;
  padding: 1px 7px;
  border-radius: 9px;
  font-size: 11px;
  border: 1px solid transparent;
}

.st-completed {
  color: var(--accent-green);
  border-color: rgba(90, 200, 140, 0.35);
}

.st-failed {
  color: var(--accent-red);
  border-color: rgba(224, 85, 106, 0.4);
}

.st-running {
  color: var(--accent-yellow);
  border-color: rgba(220, 180, 90, 0.35);
}

.st-queued {
  color: var(--text-muted);
  border-color: var(--border-default);
}

.rh-err {
  flex-shrink: 0;
  color: var(--accent-red);
  font-size: 11px;
  font-family: var(--font-mono);
}

.rh-ms {
  flex-shrink: 0;
  width: 68px;
  text-align: right;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 11.5px;
}

.rh-funnel {
  flex-shrink: 0;
  width: 132px;
  text-align: right;
  color: var(--text-muted);
  font-size: 11.5px;
}

.rh-caret {
  flex-shrink: 0;
  color: var(--text-muted);
  width: 12px;
  text-align: center;
}

/* ─── 展开详情 ──────────────────────────── */

.row-detail {
  border-top: 1px solid var(--border-subtle);
  padding: 12px 14px 14px;
  background: var(--bg-base);
}

.dsec {
  margin-bottom: 10px;
}

.dsec-h {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 6px;
}

.dsec-btn {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  font-family: inherit;
  width: 100%;
  text-align: left;
}

.dsec-btn:hover {
  color: var(--accent);
}

.caret {
  color: var(--text-muted);
}

.dsec-note {
  font-weight: 400;
  color: var(--text-muted);
  font-size: 11.5px;
}

.dsec-empty {
  font-size: 12px;
  color: var(--text-muted);
  padding: 6px 0;
}

.dsec-meta {
  font-size: 11.5px;
  color: var(--text-muted);
  margin-top: 6px;
}

.est-tag {
  font-size: 10px;
  border: 1px solid var(--border-default);
  border-radius: 3px;
  padding: 0 3px;
  margin-left: 3px;
  color: var(--text-muted-frozen, var(--text-muted));
}

.dsec-body {
  padding-left: 4px;
}

/* ─── 瀑布（几何全来自 spanLayout，本文件只管皮肤）─────── */

.segbar {
  position: relative;
  height: 14px;
  background: var(--bg-surface);
  border-radius: 3px;
  overflow: hidden;
  margin-bottom: 6px;
}

.seg {
  position: absolute;
  top: 0;
  bottom: 0;
  border-radius: 2px;
  min-width: 1px;
}

.seg-err {
  outline: 1px solid var(--accent-red);
}

.ph-dispatch {
  background: #6b7a8f;
}
.ph-context {
  background: #4a7fa5;
}
.ph-memory {
  background: #7a6bab;
}
.ph-llm {
  background: var(--accent);
}
.ph-reply {
  background: var(--accent-green);
}
.ph-git {
  background: var(--accent-yellow);
}

.seglist {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.segrow {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  color: var(--text-secondary);
}

.swatch {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex-shrink: 0;
}

.sw-rest {
  background: var(--text-muted);
}

.sw-err {
  outline: 1px solid var(--accent-red);
}

.segn {
  flex: 1;
  font-family: var(--font-mono);
}

.segflag {
  color: var(--accent-red);
}

.segttft {
  color: var(--text-muted);
}

.segd,
.segp {
  font-family: var(--font-mono);
  color: var(--text-muted);
  width: 68px;
  text-align: right;
}

.segrow.rest .segn {
  color: var(--text-muted);
}

.seg-outside {
  font-size: 11.5px;
  color: var(--text-muted);
  padding: 2px 0;
}

/* ─── 上下文决策 ────────────────────────── */

.dc-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  padding: 2px 0;
}

.dc-ord {
  width: 22px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  text-align: right;
  flex-shrink: 0;
}

.dc-role {
  width: 46px;
  flex-shrink: 0;
  color: var(--text-muted);
}

.dc-dec {
  width: 128px;
  flex-shrink: 0;
}

.dc-kept {
  color: var(--accent-green);
}
.dc-invisible {
  color: var(--text-muted);
}
.dc-summary_replaced {
  color: var(--accent-yellow);
}
.dc-budget {
  color: var(--accent-red);
}

.dc-head {
  flex: 1;
  min-width: 0;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ─── 检索明细 ──────────────────────────── */

.rq-list {
  margin-bottom: 6px;
}

.rq-row {
  display: flex;
  gap: 8px;
  font-size: 11.5px;
  padding: 2px 0;
}

.rq-i {
  color: var(--accent);
  flex-shrink: 0;
  width: 42px;
}

.rq-t {
  flex: 1;
  min-width: 0;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rq-e {
  flex-shrink: 0;
  color: var(--accent-green);
  font-size: 11px;
}

.rq-e.bad {
  color: var(--accent-red);
}

.rd-list {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 11.5px;
  margin-bottom: 6px;
}

.rd-t {
  color: var(--text-muted);
}

.rd-chip {
  border: 1px solid var(--border-default);
  border-radius: 9px;
  padding: 1px 8px;
  color: var(--text-secondary);
}

.rc-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11.5px;
}

.rc-table th {
  text-align: left;
  color: var(--text-muted);
  font-weight: 500;
  border-bottom: 1px solid var(--border-table, var(--border-subtle));
  padding: 3px 6px;
}

.rc-table td {
  padding: 3px 6px;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border-subtle);
}

.rc-inj td {
  background: var(--accent-tint, transparent);
}

.rc-yes {
  color: var(--accent-green);
  font-family: var(--font-mono);
}

.rc-no {
  color: var(--text-muted);
}

.rc-doc {
  font-family: var(--font-mono);
  font-size: 11px;
}

/* ─── prompt 快照 ───────────────────────── */

.ps-row {
  margin-bottom: 4px;
}

.ps-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  background: none;
  border: none;
  padding: 3px 0;
  cursor: pointer;
  font-family: inherit;
  font-size: 11.5px;
  color: var(--text-secondary);
  text-align: left;
}

.ps-head:hover {
  color: var(--text-primary);
}

.ps-caret {
  color: var(--text-muted);
  width: 10px;
}

.ps-label {
  flex: 1;
}

.ps-status {
  font-size: 11px;
  flex-shrink: 0;
}

.ss-ok {
  color: var(--accent-green);
}
.ss-warn {
  color: var(--accent-yellow);
}
.ss-empty {
  color: var(--text-muted);
}

.ps-chars {
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 11px;
  flex-shrink: 0;
  width: 76px;
  text-align: right;
}

.ps-body {
  margin: 4px 0 8px 18px;
  padding: 8px 10px;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow: auto;
}

/* ─── 错误框 ────────────────────────────── */

.dsec-error {
  border: 1px solid rgba(224, 85, 106, 0.35);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  background: rgba(224, 85, 106, 0.06);
}

.err-h {
  color: var(--accent-red);
}

.err-type {
  font-family: var(--font-mono);
  font-size: 11px;
  border: 1px solid rgba(224, 85, 106, 0.4);
  border-radius: 3px;
  padding: 0 4px;
}

.err-body {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 240px;
  overflow: auto;
  margin: 4px 0;
}

.err-hint {
  font-size: 11.5px;
  color: var(--text-muted);
}

/* ─── 尾部 / 分页 ───────────────────────── */

.detail-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--border-subtle);
}

.foot-id {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-muted);
}

.tv-pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 10px;
  border-top: 1px solid var(--border-subtle);
  flex-shrink: 0;
}

.pg-info {
  font-size: 12px;
  color: var(--text-muted);
}
</style>
