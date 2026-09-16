<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useChatStore } from '@/stores/chat'
import { api } from '@/composables/useApi'
import type { SpanDto, SessionTraceDto } from '@/composables/useApi'
import {
  buildWaterfall,
  splitMicroSpans,
  sharePct,
  fmtMs,
  SEG_DOC,
  FIELD_DOCS,
  type Waterfall,
  type WfRow,
} from '@/utils/spanLayout'
import AgentSettingsDrawer from './AgentSettingsDrawer.vue'

/**
 * 会话右侧边栏——clowder-ai 精简评估面板（低密度分区卡片，评估会话当前状态用）。
 *
 * 严禁恢复旧版 300px 高密度运行控制台（9dc5619^ 那版：进度条 / 停止按钮 / 调度队列全量）。
 *
 * R4 落地后本面板新增两项交互，**逐条对账过上面那条禁令**（不撞）：
 *   ① 成员卡内联 trace（屏②）——**按需展开、可随时收回**，默认态密度比旧版**更低**
 *      （弱化卡：两行 → 一行、状态 label 收成色点）；旧版是**常驻**的进度条与全量队列。
 *   ② 头像设置抽屉（屏③）——编辑入口，**不常驻**，关闭后右栏回到默认密度。
 * 禁令点名禁止的三样（进度条 / 停止按钮 / 调度队列全量）本面板一样没有：
 * 停止按钮归 ChatPanel 气泡（B2 重定位，避免双实现），队列区只列**排队中**的成员。
 *
 * 数据源：agentStates / contextTokens / activeMessages / activeSession.agentIds + agents store；
 * 成员变更走 PATCH /api/sessions/:id，SESSION_UPDATE 广播自动刷新（store 已订阅）。
 * R4 新增：GET /api/eval/session-traces（每猫最后一次执行）→ 展开时按 executionId
 * 懒加载既有 GET /api/eval/spans。段瀑布口径**全部来自 utils/spanLayout.ts**（与评估页
 * 链路 tab 同一份真相源），本文件不得内联任何几何换算。
 */
const store = useChatStore()

// ─── 会话成员（按 activeSession.agentIds 过滤全量 agents）───
const memberAgents = computed(() => {
  const ids = new Set(store.activeSession?.agentIds ?? [])
  return store.agents.filter((a) => ids.has(a.id))
})

/** 可添加的 agent（排除已在会话的——添加列表不出现重复成员） */
const addableAgents = computed(() => {
  const ids = new Set(store.activeSession?.agentIds ?? [])
  return store.agents.filter((a) => !ids.has(a.id))
})

// ─── Tokens 数字（数字非进度条——评估用，不渲染进度条）───

/** 窗口上限：优先 token 统计里推送的 maxContextTokens，回退配置值（缺省 128000） */
function maxTokensFor(agentId: string): number {
  return (
    store.agentTokenStats.get(agentId)?.maxContextTokens ?? store.contextConfig.maxContextTokens
  )
}

/** 当前上下文窗口 token 用量（驱动 handoff 的真实数字） */
function contextTokensFor(agentId: string): number {
  return store.contextTokens.get(agentId) ?? 0
}

/** 数字格式化：12400 → 12.4k、128000 → 128k（k 后去掉末尾 .0） */
function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
}

/** 成员卡 tokens 文案：{用量}/{上限}（如 12.4k/128k，与气泡 footer 同一数字体系） */
function tokensText(agentId: string): string {
  return `${fmtTokens(contextTokensFor(agentId))} / ${fmtTokens(maxTokensFor(agentId))}`
}

// ─── 状态点 / 队列（agentStates 实时数据）───

function statusFor(agentId: string): string {
  return store.currentStateFor(agentId)?.status || 'idle'
}

function queueFor(agentId: string): number {
  return store.currentStateFor(agentId)?.queueLength || 0
}

/** 状态中文 label（R4 起**不再视觉呈现**——弱化卡把它收成 7px 色点）。
 *  保留是因为色点对屏幕阅读器无语义：`aria-label` 仍读出「回复中…」，信息不丢。 */
function statusLabel(status: string): string {
  switch (status) {
    case 'idle':
      return '空闲'
    case 'thinking':
      return '思考中…'
    case 'busy':
      return '回复中…'
    default:
      return status
  }
}

// ─── 消息统计（从 store 消息列表计数，零额外请求）───
const messageStats = computed(() => {
  const msgs = store.activeMessages
  return { total: msgs.length, agent: msgs.filter((m) => m.role === 'agent').length }
})

/** 有排队任务的会话成员（调度队列信息——从 B2 迁出后此处承接） */
const queuedMembers = computed(() => {
  const ids = new Set(store.activeSession?.agentIds ?? [])
  return store.agentStateList.filter((s) => s.queueLength > 0 && ids.has(s.agentId))
})

// ─── R4 屏②：成员卡内联 trace（点卡片体展开 / 点头像开设置）───

/** 本会话每猫最后一次执行（§A 端点）。拉失败只影响 trace 区，面板其余部分照常工作。 */
const traces = ref<SessionTraceDto[]>([])
const traceLoading = ref(false)
const traceError = ref('')

/** 手风琴单开：同时至多一张卡展开（`null` = 全收起） */
const expandedAgentId = ref<string | null>(null)
/** 「折叠微段」开关（**默认关 = 全列**：时间序下折叠中间的微段会切断因果链） */
const compactAgents = ref<Record<string, boolean>>({})
/** 字段总说明（标题旁 `!`）展开的是哪只猫 */
const fieldsOpenAgentId = ref<string | null>(null)

/** 段数据按执行缓存（展开才拉；收起再展开不重发） */
const spansByExec = ref<Record<string, SpanDto[]>>({})
const spanLoading = ref<Record<string, boolean>>({})
const spanError = ref<Record<string, string>>({})

const traceByAgent = computed(() => {
  const m = new Map<string, SessionTraceDto>()
  for (const t of traces.value) m.set(t.agentId, t)
  return m
})

/** 按猫缓存瀑布。**未到达（段没拉到）的猫不进表**——据此把「加载中 / 加载失败」与
 *  「到了但是空数组（存量行）」分开，两者文案不同（null ≠ 0 同款判据）。 */
const waterfalls = computed<Record<string, Waterfall>>(() => {
  const out: Record<string, Waterfall> = {}
  for (const t of traces.value) {
    const spans = spansByExec.value[t.executionId]
    if (!spans) continue
    const wf = buildWaterfall(spans)
    if (wf) out[t.agentId] = wf
  }
  return out
})

/** 段清单与段条只列**非根段**：根段耗时已经在头部当总时长显示（列出来是同一数字重复两遍） */
function kidRows(agentId: string): WfRow[] {
  const wf = waterfalls.value[agentId]
  return wf ? wf.rows.filter((r) => !r.isRoot) : []
}

/** 当前该展示的段行（折叠微段态下分出 micro 组）。**两组并集恒等于全量**——折叠不丢数据。 */
function visibleRows(agentId: string): { shown: WfRow[]; micro: WfRow[] } {
  const wf = waterfalls.value[agentId]
  if (!wf) return { shown: [], micro: [] }
  const kids = kidRows(agentId)
  if (!compactAgents.value[agentId]) return { shown: kids, micro: [] }
  return splitMicroSpans(kids, wf.axisMs)
}

/** 被折叠的微段合计（原型：「已折叠 N 个微段 + 合计耗时/占比」） */
function microSummary(agentId: string): { count: number; text: string; pct: string } | null {
  const wf = waterfalls.value[agentId]
  if (!wf || !compactAgents.value[agentId]) return null
  const { micro } = visibleRows(agentId)
  if (micro.length === 0) return null
  const sum = micro.reduce((a, r) => a + r.durationMs, 0)
  return { count: micro.length, text: fmtMs(sum), pct: sharePct(sum, wf.axisMs) }
}

/** 该猫这次执行是否在飞（段未落库 ⇒ 必须显式显示「采集中」，不是 0 也不是空白） */
function traceRunning(agentId: string): boolean {
  const t = traceByAgent.value.get(agentId)
  return !!t && t.endedAt == null
}

/** 头部状态文案：在飞 → 采集中；否则按 execution_logs.status 四值 */
function traceStatusText(agentId: string): string {
  const t = traceByAgent.value.get(agentId)
  if (!t) return ''
  if (t.endedAt == null) return '采集中'
  switch (t.status) {
    case 'completed':
      return '完成'
    case 'failed':
      return '失败'
    case 'running':
      return '采集中'
    default:
      return t.status
  }
}

function traceStatusClass(agentId: string): string {
  const t = traceByAgent.value.get(agentId)
  if (!t) return 'st-warn'
  if (t.endedAt == null) return 'st-warn'
  if (t.status === 'failed') return 'st-bad'
  if (t.status === 'completed') return 'st-ok'
  return 'st-warn'
}

/** 总时长**只在根段到手后显示**——口径铁律「总时长的权威是根段 invoke_agent」，
 *  根段没到手就是不显示，绝不用 trace.totalMs 另起一套口径。 */
function traceTotalText(agentId: string): string {
  const wf = waterfalls.value[agentId]
  return wf ? fmtMs(wf.axisMs) : ''
}

/** 展开某猫 trace（**手风琴单开**：点已展开的卡收回） */
async function toggleExpand(agentId: string): Promise<void> {
  if (expandedAgentId.value === agentId) {
    expandedAgentId.value = null
    return
  }
  expandedAgentId.value = agentId
  const t = traceByAgent.value.get(agentId)
  // 无执行 / 在飞都不发请求：在飞的执行段尚未落库（一次执行一事务、收尾才写），查了也是空
  if (!t || t.endedAt == null) return
  await loadSpans(t.executionId)
}

function toggleCompact(agentId: string): void {
  compactAgents.value[agentId] = !compactAgents.value[agentId]
}

function toggleFields(agentId: string): void {
  fieldsOpenAgentId.value = fieldsOpenAgentId.value === agentId ? null : agentId
}

function isTraceExpanded(agentId: string): boolean {
  return expandedAgentId.value === agentId
}

/** 拉本会话每猫最后一次执行。会话切走后的迟到响应直接丢弃（不写已换会话的 ref）。 */
async function loadTraces(sessionId: string): Promise<void> {
  traceLoading.value = true
  traceError.value = ''
  try {
    const res = await api.getSessionTraces(sessionId)
    if (store.activeSessionId !== sessionId) return
    traces.value = res.traces
  } catch (err: any) {
    if (store.activeSessionId === sessionId) traceError.value = err.message || '执行记录加载失败'
  } finally {
    if (store.activeSessionId === sessionId) traceLoading.value = false
  }
}

/** 拉一次执行的段。已缓存 / 在途则不重发（同卡反复展开收起不刷屏） */
async function loadSpans(executionId: string): Promise<void> {
  if (spansByExec.value[executionId] || spanLoading.value[executionId]) return
  spanLoading.value[executionId] = true
  spanError.value[executionId] = ''
  try {
    const res = await api.getEvalSpans(executionId)
    spansByExec.value[executionId] = res.spans
  } catch (err: any) {
    spanError.value[executionId] = err.message || '段数据加载失败'
  } finally {
    spanLoading.value[executionId] = false
  }
}

/** 换会话：清空 trace 相关全部状态再拉新的（残留旧会话的展开态会指向不存在的执行） */
watch(
  () => store.activeSessionId,
  (id) => {
    expandedAgentId.value = null
    compactAgents.value = {}
    fieldsOpenAgentId.value = null
    spansByExec.value = {}
    spanLoading.value = {}
    spanError.value = {}
    traces.value = []
    traceError.value = ''
    if (id) void loadTraces(id)
    else traceLoading.value = false
  },
  { immediate: true }
)

// ─── R4 屏②：段说明浮层（命中区 = **段名**；段条与空白不出）───

const tip = ref<{ title: string; body: string } | null>(null)
const tipPos = ref<{ left: number; top: number } | null>(null)
const tipEl = ref<HTMLElement | null>(null)

function hideTip(): void {
  tip.value = null
  tipPos.value = null
}

/** 段名 → 说明浮层（文案来自 spanLayout 的 SEG_DOC，与评估页同一份） */
async function onSegTip(name: string, ev: MouseEvent): Promise<void> {
  // ⚠️ `currentTarget` **只在事件派发期间有效**，派发一结束就被置空。本函数要
  // `await nextTick()` 才量得到浮层宽高，那时它已是 null ⇒ 必须在**同步段**先取出来。
  const anchor = ev.currentTarget as HTMLElement | null
  tip.value = { title: name, body: SEG_DOC[name] || '（未登记的段名）' }
  tipPos.value = null
  await nextTick()
  const el = tipEl.value
  if (!el || !anchor) return
  const r = anchor.getBoundingClientRect()
  const t = el.getBoundingClientRect()
  // 贴锚点右侧；越界翻到左侧 / 上收（视口 300px 面板 + 360px 抽屉都会挤）
  let left = r.right + 8
  if (left + t.width > window.innerWidth - 8) left = Math.max(8, r.left - t.width - 8)
  let top = r.top
  if (top + t.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - t.height - 8)
  tipPos.value = { left, top }
}

// ─── R4 屏③：设置抽屉（点**头像**热区开，与展开热区互不触发）───

const drawerAgentId = ref<string | null>(null)

const drawerAgent = computed(() => store.agents.find((a) => a.id === drawerAgentId.value) ?? null)

function openDrawer(agentId: string): void {
  drawerAgentId.value = agentId
}

function closeDrawer(): void {
  drawerAgentId.value = null
}

// ─── 成员管理（添加/移除，PATCH addAgentIds/removeAgentIds）───
const pickerOpen = ref(false)
const selectedAddIds = ref<string[]>([])
const adding = ref(false)
const actionError = ref('')

function openPicker(): void {
  pickerOpen.value = true
  selectedAddIds.value = []
}

function closePicker(): void {
  pickerOpen.value = false
}

function togglePick(id: string): void {
  const i = selectedAddIds.value.indexOf(id)
  if (i >= 0) selectedAddIds.value.splice(i, 1)
  else selectedAddIds.value.push(id)
}

async function confirmAdd(): Promise<void> {
  if (!store.activeSessionId || selectedAddIds.value.length === 0) return
  adding.value = true
  actionError.value = ''
  try {
    await api.updateSessionAgents(store.activeSessionId, {
      addAgentIds: selectedAddIds.value,
    })
    pickerOpen.value = false
    // 刷新由 SESSION_UPDATE 广播驱动（store 已订阅）——不手动拉
  } catch (err: any) {
    actionError.value = err.message || '添加失败'
  } finally {
    adding.value = false
  }
}

/** 从会话移除。移除后若该猫正展开，一并收回（否则展开态指向一张不存在的卡）。 */
async function removeAgent(agentId: string): Promise<void> {
  if (!store.activeSessionId) return
  actionError.value = ''
  try {
    await api.updateSessionAgents(store.activeSessionId, { removeAgentIds: [agentId] })
    if (expandedAgentId.value === agentId) expandedAgentId.value = null
  } catch (err: any) {
    actionError.value = err.message || '移除失败'
  }
}
</script>

<template>
  <div class="session-agents-panel">
    <!-- 无会话空态（不报错，静默提示） -->
    <div v-if="!store.activeSessionId" class="panel-empty">
      <span class="empty-icon">🐾</span>
      <p>选择会话后展示成员与用量</p>
    </div>

    <template v-else>
      <!-- 统计计数卡（clowder-ai 低密度评估：纯数字 + 标签） -->
      <div class="stat-card">
        <div class="stat-item">
          <span class="stat-value">{{ messageStats.total }}</span>
          <span class="stat-label">消息总数</span>
        </div>
        <div class="stat-divider"></div>
        <div class="stat-item">
          <span class="stat-value">{{ messageStats.agent }}</span>
          <span class="stat-label">猫咪回复</span>
        </div>
      </div>

      <!-- 会话成员卡列表（R4 弱化卡：一行、头像独立热区、状态收成色点） -->
      <div class="section-title">会话成员</div>
      <div class="member-list">
        <div v-for="agent in memberAgents" :key="agent.id" class="member-item">
          <!-- 整卡是展开热区；头像按钮 @click.stop 独占自己的热区（两者互不触发）。
               键盘可达：头像与移除都是真 button，卡片体是 Enter/Space 可触发。 -->
          <div
            class="member-card slim"
            :class="{ expanded: isTraceExpanded(agent.id) }"
            role="button"
            tabindex="0"
            :aria-expanded="isTraceExpanded(agent.id)"
            @click="toggleExpand(agent.id)"
            @keydown.enter.prevent="toggleExpand(agent.id)"
            @keydown.space.prevent="toggleExpand(agent.id)"
          >
            <button
              class="avatar-btn"
              :title="`打开 ${agent.name} 的设置`"
              :aria-label="`打开 ${agent.name} 的设置`"
              @click.stop="openDrawer(agent.id)"
            >
              {{ agent.avatar }}
            </button>
            <span class="member-name">{{ agent.name }}</span>
            <div class="slim-right">
              <span v-if="queueFor(agent.id) > 0" class="queue-badge"
                >队列 {{ queueFor(agent.id) }}</span
              >
              <!-- 状态中文 label 收成 7px 色点（色义不变）；语义走 aria-label，屏幕阅读器仍读得出 -->
              <span
                class="status-dot"
                :class="statusFor(agent.id) === 'idle' ? 'dot-idle' : 'dot-busy'"
                :aria-label="statusLabel(statusFor(agent.id))"
                role="img"
              ></span>
              <span class="member-tokens">{{ tokensText(agent.id) }}</span>
              <button
                class="btn-remove"
                title="从会话移除"
                aria-label="移除"
                @click.stop="removeAgent(agent.id)"
              >
                ✕
              </button>
              <span class="slim-chev">▸</span>
            </div>
          </div>

          <!-- 内联 trace（屏②）：按时间顺序、默认全列、段名悬浮出说明 -->
          <div v-if="isTraceExpanded(agent.id)" class="trace-inline">
            <div class="ti-head">
              <span class="ti-title"
                >执行 trace<button
                  class="info-btn"
                  aria-label="字段说明"
                  @click.stop="toggleFields(agent.id)"
                >
                  !
                </button></span
              >
              <span class="ti-status" :class="traceStatusClass(agent.id)">{{
                traceStatusText(agent.id)
              }}</span>
              <span v-if="traceTotalText(agent.id)" class="ti-total">{{
                traceTotalText(agent.id)
              }}</span>
            </div>

            <!-- 字段总说明（`!` 点开；内容来自 spanLayout 的 FIELD_DOCS 单源） -->
            <div v-if="fieldsOpenAgentId === agent.id" class="ti-fields">
              <div v-for="d in FIELD_DOCS" :key="d.key" class="ti-field">
                <span class="ti-fname">{{ d.name }}</span>
                <span class="ti-fdesc">{{ d.desc }}</span>
              </div>
            </div>

            <div v-if="traceLoading" class="ti-nodata">执行记录加载中…</div>
            <div v-else-if="traceError" class="ti-err">{{ traceError }}</div>
            <div v-else-if="!traceByAgent.get(agent.id)" class="ti-nodata">本会话暂无执行</div>

            <!-- 在飞：段在执行收尾才一次性落库 ⇒ 此刻库里一行段都没有。
                 这不是「0ms」也不是「空白」——必须显式说明。 -->
            <template v-else-if="traceRunning(agent.id)">
              <div class="ti-nodata">采集中 · 段未落库</div>
              <div class="ti-foot">
                段在一次执行<b>收尾时</b>才一次性落库 ⇒ 正在跑的执行此刻<b>库里一行段都没有</b>。
              </div>
            </template>

            <div v-else-if="spanLoading[agent.id]" class="ti-nodata">段数据加载中…</div>
            <div v-else-if="spanError[agent.id]" class="ti-err">
              段数据加载失败：{{ spanError[agent.id] }}
            </div>
            <div v-else-if="!waterfalls[agent.id]" class="ti-nodata">无段数据（存量行）</div>

            <template v-else>
              <!-- 段条本身即时间轴（left/width 全部来自 spanLayout 的几何量） -->
              <div class="segbar">
                <span
                  v-for="r in visibleRows(agent.id).shown"
                  :key="r.key"
                  class="seg"
                  :class="[`ph-${r.phase}`, { 'seg-err': r.bad }]"
                  :style="{ left: `${r.leftPct}%`, width: `${r.widthPct}%` }"
                ></span>
              </div>

              <!-- 段清单：**按时间顺序**（上→下 = 执行先后）；默认全列 -->
              <div class="seglist">
                <div v-for="r in visibleRows(agent.id).shown" :key="r.key" class="segrow">
                  <span class="swatch" :class="[`ph-${r.phase}`, { 'sw-err': r.bad }]"></span>
                  <span
                    class="segn"
                    @mouseenter="onSegTip(r.name, $event)"
                    @mouseleave="hideTip()"
                    >{{ r.name }}</span
                  >
                  <span v-if="r.bad" class="segflag">{{ r.status }}</span>
                  <span v-if="r.ttftText" class="segttft">首字 {{ r.ttftText }}</span>
                  <span class="segd">{{ fmtMs(r.durationMs) }}</span>
                  <span class="segp">{{ r.sharePct }}</span>
                </div>
                <div v-if="microSummary(agent.id)" class="segrow rest">
                  <span class="swatch sw-rest"></span>
                  <span class="segn">已折叠 {{ microSummary(agent.id)!.count }} 个微段</span>
                  <span class="segd">{{ microSummary(agent.id)!.text }}</span>
                  <span class="segp">{{ microSummary(agent.id)!.pct }}</span>
                </div>
              </div>
              <button class="ti-more" @click.stop="toggleCompact(agent.id)">
                {{
                  compactAgents[agent.id]
                    ? `展开全部 ${kidRows(agent.id).length} 段（时间序）`
                    : '折叠微段'
                }}
              </button>

              <!-- 轴外段：不进瀑布、不计总时长，只作单行标注（文案由 spanLayout 组装） -->
              <div v-for="o in waterfalls[agent.id].outside" :key="o.key" class="ti-outside">
                {{ o.text }}
              </div>

              <div class="ti-foot">总时长只认根段 invoke_agent；段是嵌套的，子段之和会超过它。</div>
            </template>
          </div>
        </div>
        <div v-if="memberAgents.length === 0" class="member-empty">
          会话暂无猫咪——点下方「添加猫咪」
        </div>
      </div>

      <!-- 调度队列信息（排队中的成员，agentStates 实时） -->
      <div class="section-title">调度队列</div>
      <div v-if="queuedMembers.length === 0" class="queue-empty">暂无排队任务</div>
      <div v-else class="queue-list">
        <div v-for="s in queuedMembers" :key="s.agentId" class="queue-row">
          <span class="queue-dot"></span>
          <span class="queue-name">{{ store.agentInfo(s.agentId)?.name || s.agentId }}</span>
          <span class="queue-count">{{ s.queueLength }} 条</span>
        </div>
      </div>

      <!-- 折叠配置层级（clowder-ai 折叠风格） -->
      <details class="config-section">
        <summary class="config-summary">
          <span>会话配置</span>
          <span class="summary-chevron">▸</span>
        </summary>
        <div class="config-body">
          <div class="config-row">
            <div class="config-info">
              <span class="config-title">广播模式</span>
              <span class="config-hint"
                >关闭时仅被 @ 的 Agent 可见（agent 间 @ 始终生效）；开启后所有 Agent
                的回复互相可见，无需 @ 即可相互响应</span
              >
            </div>
            <button
              class="toggle-switch"
              :class="{ on: store.broadcastMode }"
              role="switch"
              :aria-checked="store.broadcastMode"
              @click="store.toggleBroadcast()"
            >
              <span class="toggle-knob"></span>
            </button>
          </div>
        </div>
      </details>

      <!-- 添加猫咪入口（排除已在会话的，多选 → PATCH addAgentIds） -->
      <button class="btn-add-members" @click="openPicker" :disabled="addableAgents.length === 0">
        ＋ 添加猫咪
      </button>
      <div v-if="actionError" class="error-msg">{{ actionError }}</div>

      <!-- 多选弹层 -->
      <div v-if="pickerOpen" class="picker-overlay" @click.self="closePicker">
        <div class="picker" role="dialog" aria-modal="true" aria-label="添加猫咪到会话">
          <div class="picker-header">
            <h3>添加猫咪到会话</h3>
            <button class="btn-close" @click="closePicker">✕</button>
          </div>
          <div v-if="addableAgents.length === 0" class="picker-hint">所有猫咪都已在会话中</div>
          <div v-else class="picker-list">
            <label v-for="agent in addableAgents" :key="agent.id" class="picker-row">
              <input
                type="checkbox"
                :checked="selectedAddIds.includes(agent.id)"
                @change="togglePick(agent.id)"
              />
              <span class="picker-avatar">{{ agent.avatar }}</span>
              <span class="picker-name">{{ agent.name }}</span>
            </label>
          </div>
          <div class="picker-footer">
            <span v-if="selectedAddIds.length" class="pick-count"
              >已选 {{ selectedAddIds.length }} 只</span
            >
            <button class="btn btn-cancel" @click="closePicker">取消</button>
            <button
              class="btn btn-ok"
              :disabled="selectedAddIds.length === 0 || adding"
              @click="confirmAdd"
            >
              {{ adding ? '添加中…' : '确认添加' }}
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- 设置抽屉（屏③）：点成员卡头像开；面板本体保留在左侧可见 -->
    <AgentSettingsDrawer :agent="drawerAgent" @close="closeDrawer" />

    <!-- 段说明浮层（命中区 = 段名）。挂在面板根上——`position: fixed` 相对视口定位，
         不进数值块内 ⇒ 不盖住段自己的读数。 -->
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
/* ─── 右栏面板骨架（低密度评估面板，非运行控制台） ─── */

.session-agents-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  overflow-y: auto;
  padding: 14px 12px 16px;
}

.panel-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  color: var(--text-muted);
  font-size: 12px;
  text-align: center;
  padding: 24px;
}

.empty-icon {
  font-size: 30px;
  opacity: 0.5;
}

/* ─── 统计计数卡 ─────────────────────── */

.stat-card {
  display: flex;
  align-items: center;
  justify-content: space-around;
  padding: 12px 8px;
  background: var(--bg-base);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
}

.stat-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  flex: 1;
}

.stat-value {
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}

.stat-label {
  font-size: 10px;
  color: var(--text-muted);
}

.stat-divider {
  width: 1px;
  height: 28px;
  background: var(--border-subtle);
}

/* ─── 分区标题 ─────────────────────── */

.section-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.4px;
  padding: 4px 2px 0;
}

/* ─── 成员卡（R4 弱化：两行 → 一行，8×10 内边距） ─── */

.member-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* 卡 + 其内联 trace 同属一项：卡与 trace 之间不留 gap（视觉上是同一块） */
.member-item {
  display: flex;
  flex-direction: column;
}

.member-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
}

.member-card.slim {
  cursor: pointer;
  transition:
    border-color var(--ease-out),
    background var(--ease-out);
}

.member-card.slim:hover {
  border-color: var(--border-default);
}

/* 展开态：卡与下方 trace 连成一块（下圆角交给 trace 收口） */
.member-card.slim.expanded {
  border-color: var(--accent);
  background: var(--accent-tint);
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
  border-bottom-color: transparent;
}

/* 头像 = **独立热区**（点它开设置，不触发展开）：30px 方形，字形 22px 居中。
   与卡片体是两个不同元素 ⇒ 空间上不重叠；卡片的 @click 由 @click.stop 拦住。 */
.avatar-btn {
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  padding: 0;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  line-height: 1;
  margin: -2px 0;
  transition: background var(--ease-out);
}

.avatar-btn:hover {
  background: var(--bg-hover);
}

.member-name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 0;
}

.slim-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dot-idle {
  background: var(--text-muted);
}

.dot-busy {
  background: var(--accent-yellow);
  animation: status-pulse 2s infinite;
}

@keyframes status-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}

/* tokens 数字：等宽数字，评估一眼可读（保留行内，不再占第二行） */
.member-tokens {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.queue-badge {
  font-size: 10px;
  font-weight: 600;
  color: var(--accent-yellow);
  background: rgba(212, 168, 84, 0.1);
  border: 1px solid rgba(212, 168, 84, 0.3);
  padding: 1px 7px;
  border-radius: 999px;
  white-space: nowrap;
}

/* 移除入口：常态隐形（弱化卡的密度优先），hover / 键盘聚焦时才现身——
   既保住功能可达，又不在 5 张卡上各挂一个常驻 ✕。 */
.btn-remove {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  font-size: 10px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: all var(--ease-out);
}

.member-card:hover .btn-remove,
.btn-remove:focus-visible {
  opacity: 1;
}

.btn-remove:hover {
  color: var(--accent-red);
  background: rgba(224, 85, 106, 0.1);
}

.slim-chev {
  font-size: 9px;
  color: var(--text-muted);
  transition: transform var(--ease-out);
  flex-shrink: 0;
  width: 9px;
  text-align: center;
}

.member-card.slim.expanded .slim-chev {
  transform: rotate(90deg);
}

.member-empty {
  font-size: 11px;
  color: var(--text-muted);
  text-align: center;
  padding: 10px 0;
}

/* ─── 内联 trace（屏②） ─────────────── */

.trace-inline {
  border: 1px solid var(--accent);
  border-top: none;
  border-radius: 0 0 var(--radius-md) var(--radius-md);
  background: var(--bg-base);
  padding: 8px 10px 10px;
}

.ti-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 6px;
}

.ti-title {
  font-size: 10px;
  font-weight: 600;
  color: var(--accent-text);
  letter-spacing: 0.3px;
}

.info-btn {
  margin-left: 3px;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: 1px solid var(--border-default);
  background: var(--bg-hover);
  color: var(--text-muted);
  font-size: 9px;
  line-height: 1;
  cursor: pointer;
  padding: 0;
  transition: all var(--ease-out);
}

.info-btn:hover {
  color: var(--accent-text);
  border-color: var(--accent-text);
}

.ti-status {
  margin-left: auto;
  font-size: 9px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 999px;
}

.st-ok {
  color: var(--accent-green, #3ecf8e);
  background: rgba(62, 207, 142, 0.12);
}

.st-bad {
  color: var(--accent-red);
  background: rgba(224, 85, 106, 0.12);
}

.st-warn {
  color: var(--accent-yellow);
  background: rgba(212, 168, 84, 0.12);
}

.ti-total {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.ti-fields {
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  padding: 6px 8px;
  margin-bottom: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ti-field {
  display: flex;
  gap: 6px;
  font-size: 10px;
  line-height: 1.5;
}

.ti-fname {
  flex-shrink: 0;
  width: 32px;
  font-weight: 600;
  color: var(--text-secondary);
}

.ti-fdesc {
  color: var(--text-muted);
}

.ti-nodata {
  font-size: 10px;
  color: var(--text-muted);
  padding: 4px 0;
}

.ti-err {
  font-size: 10px;
  color: var(--accent-red);
  padding: 4px 0;
}

/* 段条 = 时间轴本身（高度小，靠 left/width 百分比定位） */
.segbar {
  position: relative;
  height: 12px;
  border-radius: 3px;
  overflow: hidden;
  background: var(--bg-hover);
  margin-bottom: 7px;
}

.seg {
  position: absolute;
  top: 0;
  bottom: 0;
  min-width: 1.5px;
  border-radius: 2px;
}

/* 失败 / 超时压过相位色——必须排在 .ph-* 之后，否则同特异度下被盖掉 */
.seg-err {
  background: var(--accent-red);
}

.seglist {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.segrow {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  line-height: 1.45;
  padding: 1px 0;
}

.swatch {
  width: 7px;
  height: 7px;
  border-radius: 2px;
  flex-shrink: 0;
}

.sw-err {
  background: var(--accent-red);
}

.sw-rest {
  background: var(--text-muted);
  opacity: 0.35;
}

.segn {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: help;
}

.segflag {
  flex-shrink: 0;
  font-size: 9px;
  font-weight: 600;
  color: var(--accent-red);
  background: rgba(224, 85, 106, 0.12);
  padding: 0 5px;
  border-radius: 999px;
}

.segttft {
  flex-shrink: 0;
  font-size: 9px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

/* 数值列定宽 ⇒ 各行轴宽一致（跨行位置可比；随内容伸缩会把轴挤窄） */
.segd {
  margin-left: auto;
  flex: 0 0 44px;
  text-align: right;
  font-family: var(--font-mono);
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.segp {
  flex: 0 0 38px;
  text-align: right;
  font-family: var(--font-mono);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.segrow.rest .segn {
  color: var(--text-muted);
  font-style: italic;
}

.ti-more {
  margin-top: 5px;
  background: none;
  border: none;
  padding: 0;
  color: var(--accent-text);
  font-size: 10px;
  font-family: inherit;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.ti-more:hover {
  color: var(--accent-hover);
}

.ti-outside {
  margin-top: 5px;
  font-size: 10px;
  color: var(--text-muted);
  line-height: 1.5;
}

.ti-foot {
  margin-top: 6px;
  padding-top: 5px;
  border-top: 1px solid var(--border-subtle);
  font-size: 10px;
  color: var(--text-muted);
  line-height: 1.5;
}

/* 段相位配色：**与评估页链路 tab 同一套值**（对拍护栏测试盯着，改一处漏一处即红） */
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

/* ─── 段说明浮层（命中区 = 段名；段条与空白不出） ─── */

.span-tip {
  position: fixed;
  z-index: 1200;
  max-width: 240px;
  padding: 7px 9px;
  background: var(--bg-raised);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-lg);
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

/* ─── 调度队列 ─────────────────────── */

.queue-empty {
  font-size: 11px;
  color: var(--text-muted);
  text-align: center;
  padding: 8px 0;
}

.queue-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.queue-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
}

.queue-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent-yellow);
  flex-shrink: 0;
}

.queue-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
}

.queue-count {
  color: var(--accent-yellow);
  font-weight: 500;
  font-size: 11px;
}

/* ─── 折叠配置层级（clowder-ai 折叠风格） ─── */

.config-section {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-base);
}

.config-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  cursor: pointer;
  user-select: none;
  list-style: none;
}

.config-summary::-webkit-details-marker {
  display: none;
}

.config-summary:hover {
  color: var(--text-primary);
}

.summary-chevron {
  font-size: 10px;
  transition: transform var(--ease-out);
  opacity: 0.6;
}

.config-section[open] .summary-chevron {
  transform: rotate(90deg);
}

.config-body {
  padding: 4px 12px 12px;
}

.config-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.config-info {
  min-width: 0;
}

.config-title {
  display: block;
  font-size: 12px;
  color: var(--text-primary);
}

.config-hint {
  display: block;
  font-size: 10px;
  color: var(--text-muted);
  margin-top: 2px;
  line-height: 1.5;
}

.toggle-switch {
  flex-shrink: 0;
  width: 34px;
  height: 20px;
  border-radius: 10px;
  border: none;
  background: var(--bg-hover);
  position: relative;
  cursor: pointer;
  transition: background var(--ease-out);
  padding: 0;
}

.toggle-switch.on {
  background: var(--accent);
}

.toggle-knob {
  display: block;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  position: absolute;
  top: 3px;
  left: 3px;
  transition: transform var(--ease-out);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}

.toggle-switch.on .toggle-knob {
  transform: translateX(14px);
}

/* ─── 添加猫咪 ─────────────────────── */

.btn-add-members {
  width: 100%;
  padding: 8px 10px;
  border: 1px dashed var(--border-default);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: all var(--ease-out);
}

.btn-add-members:hover:not(:disabled) {
  border-color: var(--accent-text);
  color: var(--accent-text);
  background: var(--accent-soft);
}

.btn-add-members:disabled {
  opacity: 0.4;
  cursor: default;
}

.error-msg {
  background: rgba(224, 85, 106, 0.1);
  color: var(--accent-red);
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  font-size: 11px;
  border: 1px solid rgba(224, 85, 106, 0.2);
}

/* ─── 多选弹层 ─────────────────────── */

.picker-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.picker {
  width: 340px;
  max-width: 92vw;
  max-height: 76vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
  overflow: hidden;
}

.picker-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-subtle);
}

.picker-header h3 {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.btn-close {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 4px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  transition: all var(--ease-out);
}

.btn-close:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.picker-list {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
  max-height: 44vh;
}

.picker-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--ease-out);
}

.picker-row:hover {
  background: var(--bg-hover);
}

.picker-row input {
  accent-color: var(--accent);
}

.picker-avatar {
  font-size: 20px;
}

.picker-name {
  font-size: 13px;
  color: var(--text-primary);
}

.picker-hint {
  padding: 20px;
  text-align: center;
  font-size: 12px;
  color: var(--text-muted);
}

.picker-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border-subtle);
}

.pick-count {
  flex: 1;
  font-size: 11px;
  color: var(--text-muted);
}

.btn {
  padding: 6px 16px;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: all var(--ease-out);
}

.btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.btn-cancel {
  background: var(--bg-hover);
  color: var(--text-secondary);
}

.btn-cancel:hover:not(:disabled) {
  color: var(--text-primary);
}

.btn-ok {
  background: var(--accent);
  color: var(--text-on-accent);
  font-weight: 600;
}

.btn-ok:hover:not(:disabled) {
  background: var(--accent-hover);
}
</style>
