<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useChatStore } from '@/stores/chat'
import { api } from '@/composables/useApi'
import type { SessionMessageFacets } from '@/composables/useApi'
import type { Message } from '@cat-study/shared'

/**
 * 右栏「历史」页——消息历史的快速查询面板（不是猫的上下文通道）。
 *
 * 形态钉死（本组件是**右栏内的一个页面**，不是抽屉 / 浮层 / 新列）：
 *   右栏宽度由 `App.vue` 的 grid 决定（本组件 `width: 100%`，不设宽、不做宽度动画、
 *   不位移、不加遮罩）；与成员页同列切 tab，Esc 不响应、无关闭按钮。
 *
 * 数据来源：
 *   - 默认（无搜索词）：`GET /api/sessions/:id/messages/browse`——**含 system**，与日期条
 *     facets 的计数同一口径（用 `/messages` 会丢 system，日期条写 1 条、点进去空）；
 *   - 有搜索词：`GET /api/sessions/:id/messages/search`（q 必填，rows 与 /messages 投影逐字一致）；
 *   - 日期条：`GET /api/sessions/:id/messages/facets`（按 tzOffset 换算后分组）。
 *
 * 分页 = 一屏：把候选行全渲染 → 量每项（含日期头）实际高度 → 只保留装得下的那几项。
 * **结果区不得内滚**（`overflow: hidden` + 只渲染装得下的项），翻页由游标推进，
 * 不用内滚伪装「分页」。
 */

const props = defineProps<{ sessionId: string }>()

const store = useChatStore()

/** 单次向服务端取的条数（与分页游标配合；一屏装不下就留给下一页） */
const CHUNK = 50
/** 一页目标候选数：比一屏多，便于按实际高度裁；不是页大小 */
const TARGET_ROWS = 20
/** 翻页时最多连取几个 chunk（角色筛选会把整段过滤成空，需要往下补） */
const MAX_CHUNKS = 10
/** 卡片间距，与 `.hist-item` 的 margin-bottom 同源（量高度时加回） */
const HIST_GAP = 6

/** 本地时区偏移（分钟，东八区 = 480）——日期分组与展示的唯一时区口径 */
const TZ_OFFSET = -new Date().getTimezoneOffset()

/** 筛选行的唯一声明点（模板与 `setRole` 同源） */
const ROLE_FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'user', label: '我' },
  { key: 'agent', label: '猫咪' },
] as const

type RoleFilter = (typeof ROLE_FILTERS)[number]['key']

const query = ref('')
const appliedQuery = ref('')
const roleFilter = ref<RoleFilter>('all')
const selectedDate = ref<string | null>(null)

const facets = ref<SessionMessageFacets | null>(null)
const candidates = ref<Message[]>([])
const visibleCount = ref(0)
const loading = ref(false)
const error = ref('')
const hasMore = ref(false)
/** 当前模式的匹配总数（服务端 total）：browse 与 search 都返回，翻页时不随 before 缩水 */
const matchTotal = ref<number | null>(null)
const pageIndex = ref(0)
/** 每页起始游标：`cursors[i]` = 第 i 页请求时的 before（首页为 null） */
const cursors = ref<Array<string | null>>([null])

const resultsEl = ref<HTMLElement | null>(null)
/** 真的跳转失败（红色错误态） */
const revealError = ref('')
/** 中性说明（如 system 结果不可跳转）：不是错误，用 muted 色，不与红态混用 */
const revealNote = ref('')

const datePickerOpen = ref(false)
const pickerYear = ref(new Date().getFullYear())
const pickerMonth = ref<string | null>(null)

// ─── 角色筛选（全部 / 我 / 猫咪）────────────────────────────
// 服务端没有 role 参数（契约只钉了 q/limit/before/from/to），故在取回的候选里过滤；
// 取数时按一屏目标连取多段，避免「筛完这一页是空的」被读成「没有匹配」。
function roleMatches(m: Message): boolean {
  if (roleFilter.value === 'all') return true
  if (roleFilter.value === 'user') return m.role === 'user'
  return m.role === 'agent'
}

const visibleCandidates = computed(() => candidates.value.filter(roleMatches))

// ─── 日期口径 ──────────────────────────────────────────

/** ISO → 本地日期（YYYY-MM-DD）。用偏移换算而不是 toLocaleDateString：不依赖 ICU 环境 */
function localDate(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  return new Date(t + TZ_OFFSET * 60_000).toISOString().slice(0, 10)
}

/** ISO → 本地时刻 HH:mm */
function localTime(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  return new Date(t + TZ_OFFSET * 60_000).toISOString().slice(11, 16)
}

/** 日期条标签：今年省略年份，跨年带年份 */
function dayLabel(date: string): string {
  const [, m, d] = date.split('-')
  if (!date) return ''
  const sameYear = date.slice(0, 4) === String(new Date().getFullYear())
  return sameYear
    ? `${Number(m)}月${Number(d)}日`
    : `${date.slice(0, 4)}年${Number(m)}月${Number(d)}日`
}

/** 某天在本地时区的 [00:00:00.000, 23:59:59.999] 窗口（ISO UTC 串，交给服务端时间窗） */
function dayRange(date: string): { from: string; to: string } {
  const [y, m, d] = date.split('-').map(Number)
  const start = new Date(y, m - 1, d, 0, 0, 0, 0)
  const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0)
  return {
    from: start.toISOString(),
    to: new Date(end.getTime() - 1).toISOString(),
  }
}

const recentDays = computed(() => (facets.value?.days ?? []).slice(0, 2))
/** 「+N 更早」只数最近两天之外的其余日期；已选中的老日期已作为独立 chip 出现，不再重复计数 */
const olderDays = computed(() =>
  (facets.value?.days ?? []).slice(2).filter((d) => d.date !== selectedDate.value)
)

/** 选中的日期不在最近两天里时，把它插进日期条第 3 位（替换「+N 更早」入口的位置） */
const selectedDayChip = computed(() => {
  const date = selectedDate.value
  if (!date) return null
  if (recentDays.value.some((d) => d.date === date)) return null
  return { date, count: facets.value?.days.find((d) => d.date === date)?.count ?? 0 }
})

// ─── 日期弹层（年 → 月 → 日 三级）──────────────────────────

const pickerYears = computed(() => {
  const years = Array.from(
    new Set((facets.value?.months ?? []).map((m) => Number(m.month.slice(0, 4))))
  )
  return years.sort((a, b) => b - a)
})

const pickerMonths = computed(() =>
  (facets.value?.months ?? []).filter((m) => Number(m.month.slice(0, 4)) === pickerYear.value)
)

const pickerDays = computed(() => {
  if (!pickerMonth.value) return []
  return (facets.value?.days ?? []).filter((d) => d.date.startsWith(pickerMonth.value!))
})

function openDatePicker(): void {
  const latest = facets.value?.days[0]?.date ?? null
  pickerYear.value = latest ? Number(latest.slice(0, 4)) : new Date().getFullYear()
  pickerMonth.value = latest ? latest.slice(0, 7) : (facets.value?.months[0]?.month ?? null)
  datePickerOpen.value = true
}

function stepYear(delta: number): void {
  const years = pickerYears.value
  if (years.length === 0) return
  const i = years.indexOf(pickerYear.value)
  const next = years[Math.min(years.length - 1, Math.max(0, (i < 0 ? 0 : i) + delta))]
  if (next !== undefined) {
    pickerYear.value = next
    // 切年：月份收敛到该年第一个有消息的月，避免停在空月份
    pickerMonth.value =
      (facets.value?.months ?? []).find((m) => Number(m.month.slice(0, 4)) === next)?.month ?? null
  }
}

function pickDate(date: string | null): void {
  selectedDate.value = date
  datePickerOpen.value = false
  void resetAndLoad()
}

// ─── 取数 ──────────────────────────────────────────────

/**
 * 一次取数的**不可变快照**。`loadPage` 在发起时捕获它，`fetchChunk` 只读快照——
 * 不在每个 chunk 里重新读 `appliedQuery` / `selectedDate`：首屏请求未回时按 Enter
 * 搜新词，旧请求会带着新词取数，晚到后把浏览结果写回（旧实现的实际缺陷）。
 */
interface LoadSnapshot {
  sessionId: string
  q: string
  from?: string
  to?: string
  role: RoleFilter
}

function currentWindow(): { from?: string; to?: string } {
  return selectedDate.value ? dayRange(selectedDate.value) : {}
}

/** 快照里的角色筛选（不复用响应式的 `roleMatches`：结果必须由发起时的快照决定） */
function roleMatchesIn(role: RoleFilter, m: Message): boolean {
  if (role === 'all') return true
  if (role === 'user') return m.role === 'user'
  return m.role === 'agent'
}

/** 取一段（服务端 DESC：最新在前）。q 为空走 /browse（含 system，与 facets 同口径），
 *  否则走 /search。两条端点都返回 `total`（分页条的「共 N 条」读数）。 */
async function fetchChunk(
  before: string | null,
  snap: LoadSnapshot
): Promise<{ rows: Message[]; total: number }> {
  if (snap.q) {
    const res = await api.searchSessionMessages(snap.sessionId, {
      q: snap.q,
      limit: CHUNK,
      before: before ?? undefined,
      from: snap.from,
      to: snap.to,
    })
    return { rows: res.rows, total: res.total }
  }
  return api.getSessionBrowseMessages(snap.sessionId, {
    limit: CHUNK,
    before: before ?? undefined,
    from: snap.from,
    to: snap.to,
  })
}

/**
 * 加载一页。
 * 连取多个 chunk，直到角色筛选后凑到一屏目标（TARGET_ROWS）或服务端没有更早的行——
 * 否则「筛完这页空」会被读成「没有匹配」。
 *
 * **过期守门**：`loadSeq` 每次发起递增；任何 await 之后 token 不一致就整段丢弃。
 * 切搜索词/日期/角色、切会话都会发起新请求并递增 token，旧响应绝不写回（P3-2）。
 */
let loadSeq = 0

async function loadPage(before: string | null): Promise<void> {
  const token = ++loadSeq
  const snap: LoadSnapshot = {
    sessionId: props.sessionId,
    q: appliedQuery.value.trim(),
    ...currentWindow(),
    role: roleFilter.value,
  }
  const stillCurrent = (): boolean => token === loadSeq && props.sessionId === snap.sessionId
  loading.value = true
  error.value = ''
  try {
    let cursor = before
    let exhausted = false
    let total: number | null = null
    const collected: Message[] = []
    const seen = new Set<string>()
    for (let i = 0; i < MAX_CHUNKS; i++) {
      const chunk = await fetchChunk(cursor, snap)
      if (!stillCurrent()) return
      if (i === 0) total = chunk.total
      for (const m of chunk.rows) {
        if (seen.has(m.id)) continue
        seen.add(m.id)
        collected.push(m)
      }
      if (chunk.rows.length < CHUNK) {
        exhausted = true
        break
      }
      const last = chunk.rows[chunk.rows.length - 1]
      if (!last) {
        exhausted = true
        break
      }
      cursor = last.id
      if (collected.filter((m) => roleMatchesIn(snap.role, m)).length >= TARGET_ROWS) break
    }
    if (!stillCurrent()) return
    candidates.value = collected
    matchTotal.value = total
    hasMore.value = !exhausted
    await refit()
  } catch (err: any) {
    if (!stillCurrent()) return
    error.value = err?.message || '历史加载失败'
  } finally {
    if (stillCurrent()) loading.value = false
  }
}

async function resetAndLoad(): Promise<void> {
  pageIndex.value = 0
  cursors.value = [null]
  candidates.value = []
  visibleCount.value = 0
  hasMore.value = false
  matchTotal.value = null
  await loadPage(null)
}

/** facets 的过期守门：会话切走后旧响应不得覆盖新会话的日期条 */
let facetsSeq = 0

async function loadFacets(): Promise<void> {
  if (!props.sessionId) return
  const token = ++facetsSeq
  const sessionId = props.sessionId
  try {
    const res = await api.getSessionMessageFacets(sessionId, TZ_OFFSET)
    if (token !== facetsSeq || props.sessionId !== sessionId) return
    facets.value = res
  } catch {
    // 日期条拉不到只影响日期筛选入口，不影响结果列表——不把整页打成错误态
    if (token === facetsSeq && props.sessionId === sessionId) facets.value = null
  }
}

// ─── 一屏装页 ──────────────────────────────────────────

/**
 * 重排：先把全部候选渲染出来（否则被裁掉的那些量不到高度），量完再收敛到装得下的条数。
 *
 * 两次渲染发生在同一个 microtask 链里（`nextTick` 早于浏览器绘制），用户看不到中间态；
 * 稳态下结果区 `clientHeight === scrollHeight`（裁掉的项 `display: none`，不占高度）。
 */
async function refit(): Promise<void> {
  visibleCount.value = visibleCandidates.value.length
  await nextTick()
  measure()
}

/** 量当前候选的实际高度，只留装得下的项。`clientHeight` 为 0（无布局）时全渲染。 */
function measure(): void {
  const el = resultsEl.value
  if (!el) return
  const items = Array.from(el.querySelectorAll<HTMLElement>('.hist-item'))
  if (items.length === 0) {
    visibleCount.value = 0
    return
  }
  const avail = el.clientHeight
  if (!avail) {
    visibleCount.value = items.length
    return
  }
  let used = 0
  let count = 0
  for (const item of items) {
    const h = item.offsetHeight
    if (h === 0) break
    // 第一项永远保留（可用高度比一张卡还小时，宁可露出一张，也不给空结果区）
    if (count > 0 && used + h + HIST_GAP > avail) break
    used += h + HIST_GAP
    count++
  }
  visibleCount.value = Math.max(1, Math.min(count, items.length))
}

watch(
  () => visibleCandidates.value,
  () => {
    void refit()
  }
)

let observer: ResizeObserver | null = null

onMounted(async () => {
  await Promise.all([loadFacets(), resetAndLoad()])
  // 窗口尺寸变化：重排后锚定原屏首条（页起点不变 ⇒ 首条不变，只改装得下的条数）
  if (typeof ResizeObserver !== 'undefined' && resultsEl.value) {
    observer = new ResizeObserver(() => {
      void refit()
    })
    observer.observe(resultsEl.value)
  }
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})

watch(
  () => props.sessionId,
  (id) => {
    if (!id) return
    facets.value = null
    selectedDate.value = null
    datePickerOpen.value = false
    revealError.value = ''
    revealNote.value = ''
    query.value = ''
    appliedQuery.value = ''
    roleFilter.value = 'all'
    void Promise.all([loadFacets(), resetAndLoad()])
  }
)

// ─── 交互 ──────────────────────────────────────────────

function applySearch(): void {
  appliedQuery.value = query.value
  void resetAndLoad()
}

function setRole(role: RoleFilter): void {
  if (roleFilter.value === role) return
  roleFilter.value = role
  void resetAndLoad()
}

const rendered = computed(() => visibleCandidates.value.slice(0, visibleCount.value))

/** 当前页最后一条可见消息——下一页的游标（不用候选末条，否则被裁掉的那几条会漏读）。
 *
 *  角色筛选可能把整页筛空（候选 500 条、可见 0 条）：此时 `rendered` 为空，若返回 null
 *  下一页按钮就是死的（点按无请求）。未穷尽时退到**候选末条**——本页已经扫到的最旧一条，
 *  用它的 id 继续向更早翻；这样「本页无匹配」只是提示，不是死路。 */
function nextCursor(): string | null {
  const last = rendered.value[rendered.value.length - 1]
  if (last) return last.id
  return hasMore.value ? (candidates.value[candidates.value.length - 1]?.id ?? null) : null
}

async function nextPage(): Promise<void> {
  const cursor = nextCursor()
  if (!cursor || loading.value || !hasMore.value) return
  cursors.value = [...cursors.value.slice(0, pageIndex.value + 1), cursor]
  pageIndex.value += 1
  await loadPage(cursor)
}

async function prevPage(): Promise<void> {
  if (pageIndex.value === 0 || loading.value) return
  pageIndex.value -= 1
  await loadPage(cursors.value[pageIndex.value] ?? null)
}

function senderOf(m: Message): string {
  if (m.role === 'user') return '我'
  if (m.role === 'system') return '系统'
  if (!m.agentId) return '猫咪'
  return store.agents.find((a) => a.id === m.agentId)?.name ?? '猫咪'
}

/** 正文按搜索词切片（渲染成 mark，不用 v-html：消息正文是任意用户输入） */
function highlight(raw: string): Array<{ text: string; hit: boolean }> {
  const text = raw ?? ''
  const needle = appliedQuery.value.trim()
  if (!needle) return [{ text, hit: false }]
  const lower = text.toLowerCase()
  const q = needle.toLowerCase()
  const out: Array<{ text: string; hit: boolean }> = []
  let i = 0
  while (i <= text.length) {
    const j = lower.indexOf(q, i)
    if (j < 0) {
      if (i < text.length) out.push({ text: text.slice(i), hit: false })
      break
    }
    if (j > i) out.push({ text: text.slice(i, j), hit: false })
    out.push({ text: text.slice(j, j + q.length), hit: true })
    i = j + q.length
  }
  return out.length > 0 ? out : [{ text, hit: false }]
}

/** 点结果 → 主区补载并高亮（本面板保持打开；找不到就明说，不静默）。
 *
 *  - **system 消息不进主消息流**（`SESSION_HISTORY` / `/messages` 都是 `role != 'system'`
 *    口径）：调用 `revealMessage` 会白翻 50 轮后误报「已在开头之前」。system 结果不可跳转，
 *    直接给专门文案。
 *  - `revealMessage` 也因网络失败返回 false：`olderError` 有值时把真实错误显示出来，
 *    不再把一切 false 都归因成「开头之前」。
 *  - system 的「不可跳转」是**中性说明**（`revealNote`，muted 色），不是错误；真实跳转
 *    失败才进 `revealError`（红色）。两者别混用同一 class。
 */
async function pick(m: Message): Promise<void> {
  revealError.value = ''
  revealNote.value = ''
  if (m.role === 'system') {
    revealNote.value = '系统通知不在主消息流中显示'
    return
  }
  const ok = await store.revealMessage(m.id)
  if (!ok) revealError.value = store.olderError || '该消息已在会话开头之前'
}

watch([appliedQuery, selectedDate, roleFilter], () => {
  revealError.value = ''
  revealNote.value = ''
})

/**
 * 结果区空态。三种情形分开：
 * - 角色筛选把**本页**筛空但服务端还有更早行 → 「本页没有匹配，继续翻页」（不是死路）；
 * - 搜索词存在 → 「没有匹配的消息」优先（搜索 + 日期同时为空时，用户先看到的是搜索条件）；
 * - 只有日期 → 「这一天没有消息」。
 */
const emptyText = computed(() => {
  if (visibleCandidates.value.length === 0 && candidates.value.length > 0 && hasMore.value) {
    return '本页没有匹配，继续翻页'
  }
  if (appliedQuery.value.trim()) return '没有匹配的消息'
  if (selectedDate.value) return '这一天没有消息'
  return '没有匹配的消息'
})
</script>

<template>
  <div class="session-history-panel">
    <!-- 搜索框：Enter 或点搜索按钮提交；清空后回车回到浏览模式 -->
    <div class="hist-search">
      <input
        v-model="query"
        class="hist-search-input"
        type="text"
        placeholder="搜索消息与发送者…"
        aria-label="搜索消息"
        @keydown.enter.prevent="applySearch"
      />
      <button class="hist-search-btn" title="搜索" aria-label="搜索" @click="applySearch">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="6.8" cy="6.8" r="4.1" stroke="currentColor" stroke-width="1.3" fill="none" />
          <path
            d="M9.8 9.8 L13 13"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </div>

    <!-- 筛选行：全部 / 我 / 猫咪（切换即回第 1 页） -->
    <div class="hist-filters" role="tablist" aria-label="按发送者筛选">
      <button
        v-for="f in ROLE_FILTERS"
        :key="f.key"
        class="hist-filter"
        :class="{ on: roleFilter === f.key }"
        role="tab"
        :aria-selected="roleFilter === f.key"
        @click="setRole(f.key)"
      >
        {{ f.label }}
      </button>
    </div>

    <!-- 日期条：全部 + 最近 2 天 + +N 更早 -->
    <div class="hist-dates">
      <button class="hist-date-chip" :class="{ on: selectedDate === null }" @click="pickDate(null)">
        全部
      </button>
      <button
        v-for="d in recentDays"
        :key="d.date"
        class="hist-date-chip"
        :class="{ on: selectedDate === d.date }"
        @click="pickDate(d.date)"
      >
        {{ dayLabel(d.date) }}
      </button>
      <button
        v-if="selectedDayChip"
        class="hist-date-chip on"
        :title="`${selectedDayChip.count} 条`"
        @click="pickDate(selectedDayChip.date)"
      >
        {{ dayLabel(selectedDayChip.date) }}
      </button>
      <!-- 契约点名的「选择日期」入口：与 +N 更早 打开同一个三级弹层，文案不靠猜 -->
      <button class="hist-date-chip picker" aria-label="选择日期" @click="openDatePicker">
        选择日期
      </button>
      <button
        v-if="olderDays.length > 0"
        class="hist-date-chip more"
        :class="{ on: datePickerOpen }"
        @click="openDatePicker"
      >
        +{{ olderDays.length }} 更早
      </button>
    </div>

    <!-- 日期弹层：年 → 月 → 日（只列有消息的层级） -->
    <div v-if="datePickerOpen" class="hist-datepicker">
      <div class="dp-head">
        <button class="dp-step" aria-label="上一年" @click="stepYear(1)">‹</button>
        <span class="dp-year">{{ pickerYear }} 年</span>
        <button class="dp-step" aria-label="下一年" @click="stepYear(-1)">›</button>
      </div>
      <div class="dp-months">
        <button
          v-for="m in pickerMonths"
          :key="m.month"
          class="dp-month"
          :class="{ on: pickerMonth === m.month }"
          @click="pickerMonth = m.month"
        >
          {{ Number(m.month.slice(5, 7)) }} 月
        </button>
      </div>
      <div class="dp-days">
        <button
          v-for="d in pickerDays"
          :key="d.date"
          class="dp-day"
          :class="{ on: selectedDate === d.date }"
          @click="pickDate(d.date)"
        >
          {{ Number(d.date.slice(8, 10)) }} 日
          <span class="dp-count">{{ d.count }}</span>
        </button>
        <div v-if="pickerDays.length === 0" class="dp-empty">该月没有消息</div>
      </div>
      <button class="dp-all" @click="pickDate(null)">全部时间</button>
    </div>

    <!-- 结果区：**不内滚**。装不下由 refit 裁掉，翻页给下一页。 -->
    <div ref="resultsEl" class="hist-results">
      <template v-if="rendered.length > 0">
        <div
          v-for="(m, i) in visibleCandidates"
          :key="m.id"
          class="hist-item"
          :class="{ clipped: i >= visibleCount }"
          data-hist-item
        >
          <div
            v-if="
              i === 0 || localDate(m.createdAt) !== localDate(visibleCandidates[i - 1].createdAt)
            "
            class="hist-day"
          >
            {{ localDate(m.createdAt).slice(0, 4) }}-{{ localDate(m.createdAt).slice(5, 10) }}
          </div>
          <article class="hist-card" @click="pick(m)">
            <div class="hc-meta">
              <span class="hc-time">{{ localTime(m.createdAt) }}</span>
              <span class="hc-sender">
                <template v-for="(p, k) in highlight(senderOf(m))" :key="k">
                  <mark v-if="p.hit">{{ p.text }}</mark>
                  <template v-else>{{ p.text }}</template>
                </template>
              </span>
            </div>
            <p class="hc-body">
              <template v-for="(p, k) in highlight(m.content)" :key="k">
                <mark v-if="p.hit">{{ p.text }}</mark>
                <template v-else>{{ p.text }}</template>
              </template>
            </p>
          </article>
        </div>
      </template>
      <div v-else-if="loading" class="hist-state">加载中…</div>
      <div v-else-if="error" class="hist-state err">{{ error }}</div>
      <div v-else class="hist-state">{{ emptyText }}</div>
    </div>

    <div v-if="revealNote" class="hist-reveal-note">{{ revealNote }}</div>
    <div v-if="revealError" class="hist-reveal-err">{{ revealError }}</div>
    <!-- 翻页失败：旧一页还在时不能把结果区打成错误态（否则已读内容消失），单独一行提示 -->
    <div v-if="error && rendered.length > 0" class="hist-reveal-err">{{ error }}</div>

    <!-- 分页条 -->
    <div class="hist-pager">
      <button class="hp-btn" :disabled="pageIndex === 0 || loading" @click="prevPage">
        上一页
      </button>
      <span class="hp-index">
        第 {{ pageIndex + 1 }} 页<template v-if="matchTotal !== null">
          · 共 {{ matchTotal }} 条<span v-if="roleFilter !== 'all'" class="hp-note"
            >（未计角色筛选）</span
          ></template
        >
      </span>
      <button class="hp-btn" :disabled="!hasMore || loading" @click="nextPage">下一页</button>
    </div>
  </div>
</template>

<style scoped>
/* 右栏内的一个页面：宽度 100%（不设宽、不做宽度动画、不位移、不加遮罩）。
   头行 48px 归父面板，本页从搜索框起。 */
.session-history-panel {
  width: 100%;
  min-width: 0;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 0 10px;
  overflow: hidden;
}

.hist-search {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 2px;
}

.hist-search-input {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  border: none;
  border-radius: 7px;
  background: var(--panel-tint-1, rgba(60, 48, 40, 0.035));
  color: var(--text-primary);
  font-family: inherit;
  font-size: 12px;
  outline: none;
}

.hist-search-input:focus {
  background: var(--bg-hover);
}

.hist-search-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.hist-search-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.hist-filters {
  flex: none;
  display: flex;
  gap: 4px;
  padding: 0 2px;
}

.hist-filter,
.hist-date-chip {
  border: none;
  background: transparent;
  border-radius: 999px;
  padding: 2px 9px;
  font-family: inherit;
  font-size: 11px;
  color: var(--text-muted);
  cursor: pointer;
  white-space: nowrap;
  transition:
    background var(--ease-out),
    color var(--ease-out);
}

.hist-filter:hover,
.hist-date-chip:hover {
  background: var(--bg-hover);
}

.hist-filter.on,
.hist-date-chip.on {
  background: var(--accent-soft);
  color: var(--accent-text);
  font-weight: 600;
}

.hist-dates {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  padding: 0 2px;
}

.hist-date-chip.more {
  color: var(--text-secondary);
}

/* 日期弹层：贴着日期条展开（不浮层、不遮罩——它在同一列里占位） */
.hist-datepicker {
  flex: none;
  border-radius: 8px;
  background: var(--bg-raised);
  padding: 6px 8px 8px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.dp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-secondary);
}

.dp-step {
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.dp-step:hover {
  background: var(--bg-hover);
}

.dp-year {
  font-weight: 600;
}

.dp-months,
.dp-days {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
}

.dp-month,
.dp-day,
.dp-all {
  border: none;
  background: transparent;
  border-radius: 6px;
  padding: 2px 7px;
  font-family: inherit;
  font-size: 11px;
  color: var(--text-secondary);
  cursor: pointer;
}

.dp-month.on,
.dp-day.on {
  background: var(--accent-soft);
  color: var(--accent-text);
  font-weight: 600;
}

.dp-month:hover,
.dp-day:hover,
.dp-all:hover {
  background: var(--bg-hover);
}

.dp-count {
  margin-left: 3px;
  font-size: 9px;
  color: var(--text-muted);
}

.dp-empty {
  font-size: 10px;
  color: var(--text-muted);
}

.dp-all {
  align-self: flex-start;
  color: var(--text-muted);
  text-decoration: underline;
  text-underline-offset: 2px;
}

/* 结果区：**不内滚**。装不下由 refit/measure 裁掉，翻页给下一页。 */
.hist-results {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.hist-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* 超出「一屏装得下」的候选：不渲染（不是 v-show 的占位——占位会把 scrollHeight 撑大） */
.hist-item.clipped {
  display: none;
}

.hist-day {
  flex: none;
  font-size: 10px;
  color: var(--text-muted);
  letter-spacing: 0.4px;
  padding: 1px 2px;
}

.hist-card {
  flex: none;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--panel-tint-1, rgba(60, 48, 40, 0.035));
  cursor: pointer;
  transition: background var(--ease-out);
}

.hist-card:hover {
  background: var(--panel-tint-2, rgba(60, 48, 40, 0.055));
}

.hc-meta {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 10px;
  line-height: 1.6;
  color: var(--text-muted);
  margin-bottom: 2px;
}

.hc-sender {
  font-weight: 600;
  color: var(--text-secondary);
}

/* 发送者名也可能命中搜索词（服务端按 agents.name LIKE 匹配）——命中处同样高亮，
   否则「搜 ds猫 能搜到、卡上却找不到一处高亮」。 */
.hc-sender mark {
  background: rgba(212, 168, 84, 0.35);
  color: inherit;
  border-radius: 2px;
}

/* 5 行正文：13px / 1.62（与原型定稿同口径），超出裁切 */
.hc-body {
  margin: 0;
  font-size: 13px;
  line-height: 1.62;
  color: var(--text-primary);
  display: -webkit-box;
  -webkit-line-clamp: 5;
  line-clamp: 5;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}

.hc-body mark {
  background: rgba(212, 168, 84, 0.35);
  color: inherit;
  border-radius: 2px;
}

.hist-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: var(--text-muted);
  text-align: center;
  padding: 12px;
}

.hist-state.err {
  color: var(--accent-red);
}

.hist-reveal-err {
  flex: none;
  font-size: 10px;
  color: var(--accent-red);
  padding: 2px;
}

/* 中性说明（system 结果不可跳转）：不是错误，用 muted 色，别让用户读成故障 */
.hist-reveal-note {
  flex: none;
  font-size: 10px;
  color: var(--text-muted);
  padding: 2px;
}

.hist-pager {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 2px;
}

.hp-btn {
  border: none;
  border-radius: 6px;
  padding: 3px 9px;
  background: transparent;
  font-family: inherit;
  font-size: 11px;
  color: var(--accent-text);
  cursor: pointer;
}

.hp-btn:hover:not(:disabled) {
  background: var(--accent-soft);
}

.hp-btn:disabled {
  color: var(--text-muted);
  opacity: 0.5;
  cursor: default;
}

.hp-index {
  font-size: 10px;
  color: var(--text-muted);
}

.hp-note {
  color: var(--text-muted);
  opacity: 0.85;
}

/* 「选择日期」入口：常驻文本 chip（不依赖 +N 更早 才出现），与日期 chip 同款 */
.hist-date-chip.picker {
  color: var(--text-secondary);
  text-decoration: underline;
  text-underline-offset: 2px;
}
</style>
