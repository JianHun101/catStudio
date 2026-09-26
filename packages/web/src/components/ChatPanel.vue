<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import type { Directive } from 'vue'
import type { Message, StreamSegment, ToolCallInfo, ExecutionMeta } from '@cat-study/shared'
import { useChatStore, type AgentStatusEntry } from '@/stores/chat'
import { useMention } from '@/composables/useMention'
import { useSkillCommand } from '@/composables/useSkillCommand'
import { useTheme } from '@/composables/useTheme'
import { renderMarkdown } from '@/utils/markdown'
import { parseThinkingBlocks } from '@/utils/thinking'
import { resolveDisplayPlaceholders } from '@/utils/rolePlaceholders'
import { isAgentStoppable, isToolActive, toolAreaSummary } from '@/utils/tools'
import { normalizeUtc } from '@/utils/time'
import { createLogger } from '@/utils/logger'
import { api, type MemoryRef, type MemoryRefsEntry } from '@/composables/useApi'
import { buildMemoryRefView, type MemoryRefView } from '@/utils/memoryRefs'
import MessageItem from './MessageItem.vue'
import ReplyElapsed from './ReplyElapsed.vue'
import ToolRow from './ToolRow.vue'

const log = createLogger('ChatPanel')

const props = defineProps<{
  leftSidebarOpen: boolean
}>()

const emit = defineEmits<{
  toggleLeftSidebar: []
}>()

const store = useChatStore()
const { isDark, toggle: toggleTheme } = useTheme()
const input = ref('')
const chatContainer = ref<HTMLDivElement>()
const textareaRef = ref<HTMLTextAreaElement>()
const clearingMessages = ref(false)
const clearConfirm = ref(false) // 两步确认：第一次点变红，第二次执行
const retractConfirm = ref<string | null>(null) // 撤回确认：存 messageId
const sending = ref(false)

const {
  mentionActive,
  mentionSuggestions,
  mentionIndex,
  mentionStartIdx,
  detect,
  select,
  navigate,
} = useMention(() => store.agents)

const {
  skillActive,
  skillSuggestions,
  skillIndex,
  skillStartIdx,
  skillsLoaded,
  detect: detectSkill,
  select: selectSkill,
  navigate: navigateSkill,
} = useSkillCommand()

// ─── Time Formatting ───────────────────────

/**
 * 将各种来源的时间戳统一转为浏览器可正确解析的 UTC 字符串。
 * - SQLite datetime('now') 格式 "YYYY-MM-DD HH:MM:SS"（无时区）→ 附加 Z
 * - 已含 Z / +HH:MM 时区的 ISO 字符串 → 原样返回
 * - 数字时间戳 → 转为 ISO 8601 UTC 字符串
 *
 * 串形态的归一**不在此实现**——唯一真相源在 `utils/time.ts`（同源的解析曾在本文件、
 * `EvaluationView.vue` 各存一份，R5 收成单源）。本函数只补「数字时间戳」这一 ChatPanel 私有形态。
 */
function normalizeDateTime(raw: string | number): string {
  if (typeof raw === 'number') return new Date(raw).toISOString()
  return normalizeUtc(raw)
}

function formatTime(isoString: string): string {
  try {
    const d = new Date(normalizeDateTime(isoString))
    if (isNaN(d.getTime())) return ''
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function formatDate(isoString: string): string {
  try {
    const d = new Date(normalizeDateTime(isoString))
    if (isNaN(d.getTime())) return ''
    const now = new Date()
    const isToday = d.toDateString() === now.toDateString()
    if (isToday) return '今天'
    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    if (d.toDateString() === yesterday.toDateString()) return '昨天'
    return `${d.getMonth() + 1}月${d.getDate()}日`
  } catch {
    return ''
  }
}

/** 哪些下标需要显示日期分隔线 */
const dateSepIndices = computed(() => {
  const indices = new Set<number>()
  const msgs = store.activeMessages
  for (let i = 0; i < msgs.length; i++) {
    if (i === 0) {
      indices.add(i)
      continue
    }
    try {
      const prevDate = new Date(normalizeDateTime(msgs[i - 1].createdAt)).toDateString()
      const currDate = new Date(normalizeDateTime(msgs[i].createdAt)).toDateString()
      if (prevDate !== currDate) indices.add(i)
    } catch {
      /* ignore invalid dates */
    }
  }
  return indices
})

/** 仅显示活跃会话中 Agent 的打字气泡（双重校验：sessionId + agentId） */
type ThoughtEntry = { kind: 'thinking'; content: string } | { kind: 'tool'; tool: ToolCallInfo }
type StreamSegItem = { type: 'seg'; seg: StreamSegment }
/**
 * 思考折叠块（思考+工具唯一容器，对齐用户「对外只露正文+思考框」）：thinking 文本与
 * tool 行按时间序交错（segments 有序性保证，工具嵌在实际发生位置，不聚尾部）；
 * tools 为 header 摘要快照（推进中/完成统计）
 */
type StreamFoldItem = {
  type: 'fold'
  entries: ThoughtEntry[]
  tools: ToolCallInfo[]
  open: boolean
  /** 过程仍在推进（有 running/pending 工具，或正文尚未开始的思考）——驱动自动展开与 header 动点 */
  processing: boolean
  frozen: boolean
}
type StreamItem = StreamSegItem | StreamFoldItem

interface ActiveTyping {
  messageId: string
  content: string
  sessionId: string
  segments?: StreamSegment[]
  /** 渲染条目：thinking 与 tool 段收进单一思考折叠块（时间序交错），text 正文段保留在外 */
  items: StreamItem[]
}

/** 用户点过流式思考折叠块 header 后的冻结态（frozen=true 停止自动展开/收起） */
const streamFoldState = ref(new Map<string, { frozen: boolean; open: boolean }>())
/**
 * 折叠块交互版本号：用户点击 header 时 bump——activeTypingStates 对 toggle 的
 * 直接响应依赖。item.open 来自 computed 重建的渲染条目，而 toggle 只写
 * streamFoldState Map；fc2fc9e 审查实证 Map key 级追踪覆盖不到「auto-close 后
 * 点开」的窗口（无后续 typing 则永不重建）——版本号 bump 强制立即重建。
 */
const streamFoldVersion = ref(0)

/** 工具段 → 展示行（seg.tool 流式轻量元数据；上游缺 tool 时回退段内容文本作名） */
function toolRowFromSeg(seg: StreamSegment): ToolCallInfo {
  return seg.tool ?? { name: seg.content || '工具' }
}

/**
 * 流式 typing segments → 渲染条目列表。
 * 点1（气泡只放最终回复）：流式期间不渲染任何 text 段——最终正文只在流结束
 * （NEW_MESSAGE 清 typing → 打字气泡换持久化 message）由历史气泡留外层
 * （MessageItem.vue 的 computeStoredFoldEntries 同判据）。
 * 流途中"最终段"未定，任何 text 段都属过程性内容，既不产出外层 seg、也不收进 fold；
 * thinking+tool 段照常收进单一 fold（思考折叠块），entries 按时间序交错——工具嵌在
 * 实际发生位置，不聚尾部。fold 展开态由 streamFoldState 控制——自动逻辑：一旦出现
 * thinking 或 tool 段即保持展开（单调，不随正文进入/工具完成中段收起——治 flap）；
 * processing 仅驱动 header 活跃指示（thinking-dots）——折叠体存在（有 thinking/tool 过程内容）
 * 即恒亮到流结束，不随正文进入/工具完成中段熄灭。用户点过 header 后冻结（frozen=true 尊重用户选择）。
 */
function buildStreamItems(agentId: string, segs: StreamSegment[]): StreamItem[] {
  // 依赖折叠块交互版本号：toggle bump 后强制重建渲染条目，item.open 立即翻转
  void streamFoldVersion.value
  const items: StreamItem[] = []
  let fold: StreamFoldItem | null = null
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    if (seg.kind === 'text') {
      // 点1 新规格：流式期间不渲染任何 text 段——最终正文只在流结束（NEW_MESSAGE 清
      // typing → 打字气泡换持久化 message）由历史气泡留外层（MessageItem 同判据：
      // 只留最后一个 text 段）。流途中"最终段"未定，任何 text 段都属过程性内容：
      // 既不留外层 seg，也不收进 fold——思考+tool 段照常进单一折叠块（时间序交错）。
      // 纯正文流（无 thinking/tool）items 为空 → 气泡只剩 cursor。
      continue
    }
    if (!fold) {
      fold = { type: 'fold', entries: [], tools: [], open: true, processing: false, frozen: false }
      items.push(fold)
    }
    if (seg.kind === 'tool') {
      const tool = toolRowFromSeg(seg)
      fold.tools.push(tool)
      fold.entries.push({ kind: 'tool', tool })
    } else {
      fold.entries.push({ kind: 'thinking', content: seg.content })
    }
  }
  if (fold) {
    const st = streamFoldState.value.get(agentId)
    // hasThinking 只含真·thinking 段（text 段已 drop、不进 fold）
    const hasThinking = fold.entries.some((e) => e.kind === 'thinking')
    // 自动开合单调化：一旦出现 thinking 或 tool 段即保持展开，不因正文进入/工具完成中段收起
    // ——thinking/tool 段只增不减，hasThinking || tools.length>0 天然单调，无需持久 latch。
    const monotonicOpen = hasThinking || fold.tools.length > 0
    // processing 供 header 活跃指示（thinking-dots）：折叠体存在（有 thinking/tool 过程内容）即
    // 恒亮到流结束——text 段已 drop，折叠体内容从出现到流结束只增不减，不是"工具推进中/思考中"
    // 这类瞬时态，而是"只要折叠体存在就持续亮"。流结束转持久化消息后 processing 不落
    // （历史气泡 MessageItem 不带 processing），天然熄灭，无 dots 残留。
    const processing = fold.entries.length > 0
    const frozen = st?.frozen ?? false
    fold.frozen = frozen
    fold.processing = processing
    fold.open = st ? (frozen ? st.open : monotonicOpen) : monotonicOpen
  }
  return items
}

/** 老载兼容：结构优先消费 typing.segments；无 segments 退化 [思考] 文本标记解析 */
function resolveTypingSegs(typing: {
  content: string
  segments?: StreamSegment[]
}): StreamSegment[] {
  return typing.segments && typing.segments.length
    ? typing.segments
    : parseThinkingBlocks(typing.content)
}

/** typing 条目构造：保留原字段 + 附 buildStreamItems 渲染条目供模板消费 */
function typingView(
  agentId: string,
  v: { messageId: string; content: string; sessionId: string; segments?: StreamSegment[] }
): ActiveTyping {
  return { ...v, items: buildStreamItems(agentId, resolveTypingSegs(v)) }
}

/** 流式思考折叠块 header 点击：记冻结态（open 取反），此后不再随过程状态自动开合 */
function toggleStreamFold(agentId: string, wasOpen: boolean): void {
  streamFoldState.value.set(agentId, { frozen: true, open: !wasOpen })
  // bump 版本号：buildStreamItems 依赖它，强制 activeTypingStates 立即重建渲染条目。
  // 否则点击只在「下一次 AGENT_TYPING 触发 rebuild」时生效——若该 typing 已是流式
  // 最后一发，点击永不生效（fc2fc9e 审查缺陷）。
  streamFoldVersion.value++
}

const activeTypingStates = computed(() => {
  const filtered = new Map<string, ActiveTyping>()
  const activeAgentIds = new Set(store.activeSession?.agentIds ?? [])
  store.typingStates.forEach((v, agentId) => {
    if (v.sessionId !== store.activeSessionId) return
    if (activeAgentIds.has(agentId)) filtered.set(agentId, typingView(agentId, v))
  })
  return filtered
})

/** 取某 agent 在**当前会话**的计时锚点（无则 undefined）——气泡 footer 与占位气泡共用。
 *  走 `currentReplyTimerFor`：计时表是全局表，直接 get(agentId) 会跨会话误命中。 */
function replyTimerFor(agentId: string): { startedAt: number; lastBeatAt: number } | undefined {
  return store.currentReplyTimerFor(agentId)
}

/**
 * 占位气泡数据源：**有计时锚点、无流式内容**的执行。
 *
 * 覆盖三类没有 `AGENT_TYPING` 的窗口：A2A（猫 @ 猫，没有用户消息状态行可挂）、
 * headless 适配器（整轮不 yield chunk）、首个 chunk 到达前的上下文组装阶段。
 * 与 `activeTypingStates` 互斥（同一条目不会既流式又占位）——首个 chunk 到达后
 * `typingStates` 有条目，本 list 自然剔除该 agent，气泡切换但计时同源不重置。
 *
 * 会话归属由**键**保证：只对本会话成员逐个取键（`currentReplyTimerFor`），不再遍历
 * 全局表——「遍历全表 + agentIds 过滤」在「同一只猫跨会话并行执行」时会漏进别的会话
 * 的条目（各会话成员恒为同样几只猫 ⇒ 成员过滤恒真、等于没有过滤）。
 */
const placeholderTimers = computed(() => {
  const list: { agentId: string; startedAt: number; lastBeatAt: number }[] = []
  for (const agentId of store.activeSession?.agentIds ?? []) {
    const timer = store.currentReplyTimerFor(agentId)
    if (!timer) continue
    if (store.typingStates.has(agentId)) continue
    list.push({ agentId, ...timer })
  }
  return list
})

// 流式结束（typing 条目删除）→ 清理该 agent 的折叠块冻结态，下一条流式从干净状态开始
watch(
  () => Array.from(store.typingStates.keys()).sort().join(','),
  (csv) => {
    const alive = new Set(csv ? csv.split(',') : [])
    for (const agentId of Array.from(streamFoldState.value.keys())) {
      if (!alive.has(agentId)) streamFoldState.value.delete(agentId)
    }
  }
)

// ─── Message Grouping ──────────────────────

const GROUP_WINDOW_MS = 2 * 60 * 1000 // 2 minutes

/** 当前消息是否与前一条消息合并显示（同发送者 + 2 分钟内） */
function isGrouped(index: number): boolean {
  if (index === 0) return false
  const msgs = store.activeMessages
  const prev = msgs[index - 1]
  const curr = msgs[index]
  if (curr.role === 'system' || prev.role === 'system') return false
  if (curr.role !== prev.role) return false
  if (curr.role === 'agent' && curr.agentId !== prev.agentId) return false
  try {
    const gap =
      new Date(normalizeDateTime(curr.createdAt)).getTime() -
      new Date(normalizeDateTime(prev.createdAt)).getTime()
    return gap >= 0 && gap < GROUP_WINDOW_MS
  } catch {
    return false
  }
}

// ─── Smart Scroll (stick-to-bottom) ─────────

const SCROLL_TOLERANCE = 40
const isAtBottom = ref(true)
const showScrollDown = ref(false)
// Count of new messages that arrived while user was scrolled up.
// Resets to 0 when user returns to the bottom (via click or manual scroll).
const newMessageCount = ref(0)

function checkScrollPosition(): void {
  const el = chatContainer.value
  if (!el) return
  const distToBottom = el.scrollHeight - el.scrollTop - el.clientHeight
  const wasAtBottom = isAtBottom.value
  isAtBottom.value = distToBottom < SCROLL_TOLERANCE
  // User scrolled back to bottom manually → dismiss new message indicator
  if (!wasAtBottom && isAtBottom.value) {
    newMessageCount.value = 0
    showScrollDown.value = false
  }
}

function scrollToBottom(smooth = false): void {
  const el = chatContainer.value
  if (!el) return
  // Dismiss the new message indicator — user is heading to the bottom.
  newMessageCount.value = 0
  showScrollDown.value = false
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  if (!smooth) {
    isAtBottom.value = true
  }
}

// New messages arrive → scroll if at bottom; otherwise show indicator
// watch 源用最后一条消息 id（比 length 精确：消息内容更新不改 id 不触发滚动）。
// C5 移除其中「隐式当成功」的 sending 复位——按钮复位改由 store.sendStatus 独占驱动。
const lastMessageId = computed(() => {
  const msgs = store.activeMessages
  return msgs.length > 0 ? msgs[msgs.length - 1].id : null
})
watch(lastMessageId, async () => {
  await nextTick()
  if (isAtBottom.value) {
    scrollToBottom()
  } else {
    newMessageCount.value++
    showScrollDown.value = true
  }
})

// C5：发送按钮复位由 store 独占生命周期驱动（ack ok/failed / 10s 超时 → sendStatus 终态）
watch(
  () => store.sendStatus,
  (s) => {
    if (s === 'ok' || s === 'failed') sending.value = false
  }
)

// Streaming content grows → follow if at bottom
watch(
  () => {
    const contents: string[] = []
    activeTypingStates.value.forEach((v) => contents.push(v.content))
    return contents.join('|')
  },
  async () => {
    await nextTick()
    if (isAtBottom.value) scrollToBottom()
  }
)

// Active session changes → reset to bottom
watch(
  () => store.activeSessionId,
  () => {
    setTimeout(() => scrollToBottom(), 50)
  }
)

// Agent status bubbles appear after scroll → re-scroll if at bottom
watch(
  () => store.messageStatus,
  async () => {
    await nextTick()
    if (isAtBottom.value) scrollToBottom()
  }
)

// ─── 思考框内跟进（stick-to-bottom，框内滚动）─────────
// 流式思考框自己就是有界滚动容器（.stream-fold .stream-fold-body：max-height:220px +
// overflow-y:auto），思考/工具在框内滚。三不变量与消息区同构：
//   I1 跟随——内容增长 且 用户此刻在框底 → 贴底
//   I2 让位——用户滚上去阅读 → 不抢滚动条、不打断阅读
//   I3 复位——滚回框底 → 恢复跟随
// 观测面选「尺寸」而非「内容增长来源」：后者要求穷举才正确（每新增一条渲染路径都得记得
// 补一个 watch，漏一个就静默失效），尺寸观测一个点天然覆盖所有来源（文本、工具行展开、
// 图片解码、字体加载……）。也不用「每次更新后读 scrollHeight」——流式每 chunk 一次会强制
// 同步布局，RO 回调由浏览器批量派发。
// ⚠️ 只作用流式折叠块。历史折叠块（.stored-thinking，MessageItem 渲染）展开后不再增长。
const FOLD_SCROLL_TOLERANCE = 4

// ⚠️ 「在框底」不能只用几何判据——真机实测（非推演）的冷启动失效：
// 本容器 max-height:220px。未溢出时 clientHeight 由内容决定，distToBottom 恒 0；而**首次
// 溢出那一帧** clientHeight 被钳在 219，scrollTop 却仍是 0 ⇒ distToBottom 一跃 7px（实测）
// ≥4 ⇒ 判定「不在底部」直接 return。此后 scrollTop 恒 0、dist 单调增（7 → 28 → 49 …），
// **跟随一次都不会触发**，用户看到的仍是「停在最上面、新内容长在框外」。
// 根因：几何距离把「用户主动滚上去了」与「内容刚长出来」混为一谈，两者的 dist>0 同形。
// 故拆开两件事：
//   - 写侧（RO 回调）只认 sticky 位——「用户此刻想不想跟」
//   - sticky 位只由 scroll 事件按几何距离重算——只有真滚动才会改它
// 初值 true = 用户要的「默认自动滚到最新」。三不变量语义不变（I1 贴底 / I2 让位 / I3 复位）。
// 注：增长量子（约一行 21px）恒大于容差 4px，所以纯几何判据在溢出后的每一跳都会失效，
// 不是只差「第一格」——sticky 位是唯一稳定的判据。

// 每个滚动容器一个 sticky 位：「用户此刻是否想贴底」。RO 回调只看它、不改它。
// WeakMap 键是 body 元素：折叠体随流式结束被销毁，条目随之回收，无需手工清理。
const foldSticky = new WeakMap<HTMLElement, boolean>()

function isAtFoldBottom(body: HTMLElement): boolean {
  return body.scrollHeight - body.scrollTop - body.clientHeight < FOLD_SCROLL_TOLERANCE
}

function stickFoldToBottom(body: HTMLElement): void {
  // I2 让位：用户滚上去过（sticky=false）就不抢滚动条，直到他自己滚回框底（I3）。
  if (!foldSticky.get(body)) return
  // behavior:'auto'——流式期平滑滚动既追不上逐 chunk 的增长，也会与用户手动滚动打架。
  body.scrollTo({ top: body.scrollHeight, behavior: 'auto' })
}

// rAF 节流：合并同帧内的多次触发起见，并把滚动写推迟到下一帧——滚动条出现/消失会改变
// clientWidth 进而又改内容尺寸，同帧内回写会触发 ResizeObserver loop 告警。
const pendingFoldBodies = new Set<HTMLElement>()
let foldStickRaf = 0

function scheduleFoldStick(body: HTMLElement): void {
  pendingFoldBodies.add(body)
  if (foldStickRaf) return
  foldStickRaf = requestAnimationFrame(() => {
    foldStickRaf = 0
    const bodies = [...pendingFoldBodies]
    pendingFoldBodies.clear()
    bodies.forEach(stickFoldToBottom)
  })
}

// 每个折叠体一个 RO + 一个 scroll 监听，随元素生命周期装卸。用指令而非函数 ref：指令的
// mounted/unmounted 与元素严格配对，卸载时能确切 cleanup（函数 ref 卸载只收到 null，
// 认不出是哪一个元素，观测集只增不减会随会话时长泄漏——本组件是长驻的）。
const foldStickBindings = new Map<
  HTMLElement,
  { ro: ResizeObserver; body: HTMLElement; onScroll: () => void }
>()

const vFoldStick: Directive<HTMLElement> = {
  mounted(el) {
    // 用 closest 而非 parentElement：中间多包一层时 parentElement 会指错元素且**静默失效**
    // （不报错，只是永不跟随）；closest 按语义找容器，容忍插入节点。
    const body = el.closest('.stream-fold-body') as HTMLElement | null
    if (!body) return
    foldSticky.set(body, true) // 默认跟随——冷启动第一跳就靠它（见上）
    // sticky 位唯一的更新口：真滚动（用户拖滚动条/触控板/键盘，或本指令自己的贴底写回）
    // 才重算。内容增长不产生 scroll 事件，故不会把「刚长出来」误读成「用户滚上去了」。
    const onScroll = () => foldSticky.set(body, isAtFoldBottom(body))
    body.addEventListener('scroll', onScroll, { passive: true })
    const ro = new ResizeObserver(() => scheduleFoldStick(body))
    ro.observe(el)
    foldStickBindings.set(el, { ro, body, onScroll })
  },
  unmounted(el) {
    // unmounted 时 el 已被移出 DOM，closest 会失配 ⇒ 必须靠 mounted 时记下的配对来清理。
    const b = foldStickBindings.get(el)
    if (!b) return
    b.ro.disconnect()
    b.body.removeEventListener('scroll', b.onScroll)
    foldStickBindings.delete(el)
  },
}

// C5：滚动监听恰好一份——挂在模板 @scroll.passive 上（Vue 随组件生命周期自动装卸），
// 不再于 onMounted 里对同一元素重复 addEventListener（此前两处并存，每次滚动跑两遍
// checkScrollPosition，其中一遍还挂在可能已卸载的节点上）。
onMounted(() => {
  window.addEventListener('keydown', onPreviewKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onPreviewKeydown)
  // 组件卸载时在途的 rAF 要取消：否则回调会在已脱离文档的节点上跑一遍。
  // RO 实例由指令的 unmounted 逐个 disconnect，此处不重复。
  if (foldStickRaf) {
    cancelAnimationFrame(foldStickRaf)
    foldStickRaf = 0
  }
  pendingFoldBodies.clear()
  // 在途的记忆引用合并窗口：卸载后不许再发请求（回调持的是已卸载组件的闭包）
  if (memoryRefsTimer) {
    clearTimeout(memoryRefsTimer)
    memoryRefsTimer = undefined
  }
})

// ─── Image preview (lightbox) ─────────────

const previewImages = ref<string[]>([])
const previewIndex = ref(0)
const previewVisible = computed(() => previewImages.value.length > 0)

function openPreview(images: string[], index: number): void {
  previewImages.value = images
  previewIndex.value = index
}

function closePreview(): void {
  previewImages.value = []
  previewIndex.value = 0
}

function previewStep(dir: 1 | -1): void {
  const len = previewImages.value.length
  if (len <= 1) return
  previewIndex.value = (previewIndex.value + dir + len) % len
}

/** 预览打开时：Esc 关闭、←/→ 切换（多图）；记忆抽屉只吃 Esc（无翻页语义） */
function onPreviewKeydown(e: KeyboardEvent): void {
  if (!previewVisible.value) {
    if (activeMemoryRef.value && e.key === 'Escape') closeMemoryRef()
    return
  }
  if (e.key === 'Escape') closePreview()
  else if (e.key === 'ArrowLeft') previewStep(-1)
  else if (e.key === 'ArrowRight') previewStep(1)
}

// ─── Restart request helpers ───────────────

/**
 * 重启按钮状态解析：默认 pending；服务端 confirmed → 「重启中…」；none/已过期 → 隐藏。
 * 过期以消息携带的 restartExpiresAt 为准（服务端权威状态由 RESTART_STATUS 事件驱动）。
 */
function restartStateFor(msg: Message): 'pending' | 'confirmed' | 'none' {
  if (msg.messageType !== 'restart_request') return 'none'
  const st = store.restartStates.get(msg.id)
  if (st === 'confirmed' || st === 'none') return st
  if (msg.restartExpiresAt && Date.now() > new Date(msg.restartExpiresAt).getTime()) return 'none'
  return 'pending'
}

// ─── Existing helpers ──────────────────────

async function handleClearMessages(): Promise<void> {
  if (!store.activeSessionId) return
  if (!clearConfirm.value) {
    clearConfirm.value = true
    setTimeout(() => {
      clearConfirm.value = false
    }, 3000)
    return
  }
  clearingMessages.value = true
  try {
    await store.clearSessionMessages(store.activeSessionId)
    clearConfirm.value = false
  } catch (err) {
    log.error('clear messages failed', { error: String(err) })
  } finally {
    clearingMessages.value = false
  }
}

function onInput(e: Event): void {
  if ((e as InputEvent).isComposing) return
  const ta = e.target as HTMLTextAreaElement
  detect(ta.value, ta.selectionStart)
  detectSkill(ta.value, ta.selectionStart)
}

// ─── Image Attachments ──────────────────────

const MAX_IMAGES = 4
const pastedImages = ref<string[]>([])
const fileInputRef = ref<HTMLInputElement>()

/**
 * 读取 File → canvas 压缩 → base64 dataURL。
 * 最长边压到 1280（与 server ui-review.ts 的 sharp 压缩一致），
 * 避免超大 base64 撑爆 socket 消息和 SQLite。
 */
function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        const MAX_EDGE = 1280
        const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(img.width * scale))
        canvas.height = Math.max(1, Math.round(img.height * scale))
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(reader.result as string)
          return
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL('image/jpeg', 0.85))
      }
      img.onerror = () => reject(new Error('图片解码失败'))
      img.src = reader.result as string
    }
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsDataURL(file)
  })
}

/** 批量加入图片（过滤非图片类型，截断超限部分） */
function addImages(files: FileList | File[]): void {
  const list = Array.from(files).filter((f) => f.type.startsWith('image/'))
  const remaining = MAX_IMAGES - pastedImages.value.length
  if (list.length > remaining) {
    log.error('图片数量超限', { max: MAX_IMAGES, received: list.length, remaining })
  }
  list.slice(0, Math.max(0, remaining)).forEach((f) => {
    fileToDataURL(f)
      .then((dataUrl) => {
        pastedImages.value.push(dataUrl)
      })
      .catch((err) => log.error('图片处理失败', { error: String(err) }))
  })
}

/** 剪贴板粘贴图片（阻止二进制粘进 textarea） */
function onPaste(e: ClipboardEvent): void {
  const items = e.clipboardData?.items
  if (!items) return
  const files: File[] = []
  for (const item of items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file) files.push(file)
    }
  }
  if (files.length > 0) {
    e.preventDefault()
    addImages(files)
  }
}

/** 文件选择框回调 */
function onFileSelect(e: Event): void {
  const input = e.target as HTMLInputElement
  if (input.files) addImages(input.files)
  input.value = '' // 清空以便重复选择同一文件
}

function removeImage(idx: number): void {
  pastedImages.value.splice(idx, 1)
}

async function handleSend(): Promise<void> {
  const text = input.value.trim()
  const images = pastedImages.value
  if ((!text && images.length === 0) || sending.value) return

  // 只匹配行首 @后跟字母/数字/中文/下划线/连字符，避免句中引用 @name 被误路由
  const mentionRegex = /^@([\w一-鿿-]+)/gm
  const rawMentions: string[] = []
  let match: RegExpExecArray | null
  while ((match = mentionRegex.exec(text)) !== null) {
    rawMentions.push(match[1])
  }
  // 白名单过滤：只保留真正的 Agent 名称，防止 @whatever 被误存
  const agentNames = store.agents.map((a) => a.name)
  const mentions = [...new Set(rawMentions)].filter((m) => agentNames.includes(m))

  sending.value = true
  // 发送按钮复位不再依赖「回显到达 / 10s timeout」双兜底——C5 收进 store：
  // sendMessage 内部走 ack + 超时，sendStatus 到终态后上方 watch 复位 sending
  store.sendMessage(text, mentions, images)
  input.value = ''
  pastedImages.value = []
  mentionActive.value = false
  skillActive.value = false
  await nextTick()
  scrollToBottom()
}

function onKeydown(e: KeyboardEvent): void {
  if (mentionActive.value) {
    if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
      e.preventDefault()
      const ta = textareaRef.value
      if (!ta) return
      const agent = mentionSuggestions.value[mentionIndex.value]
      const result = navigate(e.key, ta.value, ta.selectionStart)
      if (result !== null && agent) {
        input.value = result
        nextTick(() => {
          // 光标放在 @agentName 后面的空格之后
          ta.selectionStart = ta.selectionEnd = mentionStartIdx.value + agent.name.length + 2
        })
      }
      return
    }
  }

  // 斜杠补全：**只在真有候选项时**才拦按键（Enter 直通是硬契约——旧版无条件
  // preventDefault 把斜杠消息的 Enter 一并吞掉，见 useSkillCommand 头注）。
  // ESC 例外：无候选项时下拉可能正显示「无匹配」空态，ESC 收掉它不吞任何输入。
  if (skillActive.value && (skillSuggestions.value.length > 0 || e.key === 'Escape')) {
    if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
      e.preventDefault()
      const ta = textareaRef.value
      if (!ta) return
      const skill = skillSuggestions.value[skillIndex.value]
      const result = navigateSkill(e.key, ta.value, ta.selectionStart)
      if (result !== null && skill) {
        input.value = result
        nextTick(() => {
          // 光标放在 /skillName 后面的空格之后
          ta.selectionStart = ta.selectionEnd = skillStartIdx.value + skill.name.length + 2
        })
      }
      return
    }
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    if (e.isComposing) return
    e.preventDefault()
    handleSend()
  }
}

function selectSkillItem(idx: number): void {
  const skill = skillSuggestions.value[idx]
  const ta = textareaRef.value
  if (!skill || !ta) return
  input.value = selectSkill(skill, input.value, ta.selectionStart)
  nextTick(() => {
    if (textareaRef.value) {
      const pos = skillStartIdx.value + skill.name.length + 2
      textareaRef.value.selectionStart = textareaRef.value.selectionEnd = pos
      textareaRef.value.focus()
    }
  })
}

function selectMention(idx: number): void {
  const agent = mentionSuggestions.value[idx]
  if (!agent || !textareaRef.value) return
  const newText = select(agent, input.value, textareaRef.value.selectionStart)
  input.value = newText
  nextTick(() => {
    if (textareaRef.value) {
      const pos = mentionStartIdx.value + agent.name.length + 2
      textareaRef.value.selectionStart = textareaRef.value.selectionEnd = pos
      textareaRef.value.focus()
    }
  })
}

function avatarFor(role: string, agentId: string | null): string {
  if (role === 'user') return '👤'
  if (role === 'system') return '📢'
  const info = store.agentInfo(agentId)
  return info?.avatar || '🐱'
}

function senderName(agentId: string | null): string {
  if (!agentId) return ''
  const info = store.agentInfo(agentId)
  return info?.name || agentId
}

/** 状态行空值常量：命中缺失时返回**同一个**空数组引用（内联 `|| []` 每次新建数组 ⇒
 *  子组件 props 引用抖动 ⇒ 白重渲染） */
const EMPTY_STATUS: AgentStatusEntry[] = []

async function handleRetract(msgId: string): Promise<void> {
  if (!store.activeSessionId) return
  if (retractConfirm.value !== msgId) {
    retractConfirm.value = msgId
    setTimeout(() => {
      retractConfirm.value = null
    }, 3000)
    return
  }
  retractConfirm.value = null
  await store.retractMessage(store.activeSessionId, msgId)
}

// ─── Bubble Footer (模型 + 窗口用量 + 停止按钮) ───────

/** Agent 模型名（agents 表 llm_model，缺失返回空串隐藏） */
function modelNameFor(agentId: string): string {
  return store.agents.find((a) => a.id === agentId)?.llmModel || ''
}

/** 窗口上限：优先 token 统计里推送的 maxContextTokens，回退配置值（缺省 128000） */
function maxTokensFor(agentId: string): number {
  return (
    store.agentTokenStats.get(agentId)?.maxContextTokens ?? store.contextConfig.maxContextTokens
  )
}

/** 上下文窗口用量百分比（contextTokens / max，与交接线/横幅同一数字体系） */
function contextPctFor(agentId: string): number {
  const max = maxTokensFor(agentId)
  if (!max) return 0
  return Math.round(((store.contextTokens.get(agentId) ?? 0) / max) * 100)
}

/** 数字格式化：12400 → 12.4k、128000 → 128k（k 后去掉末尾 .0，与侧边栏同格式） */
function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
}

/** 气泡 footer tokens 文案：{用量}k/{上限}k tokens——m = maxContextTokens（上下文窗口数），
 *  不是 llm_max_tokens（单次输出上限 2048）——两个数字体系严防混淆 */
function tokensTextFor(agentId: string): string {
  return `${fmtTokens(store.contextTokens.get(agentId) ?? 0)}/${fmtTokens(maxTokensFor(agentId))} tokens`
}

/** agent 回复耗时徽标文案：{秒数} 秒（服务端随广播注入 durationMs，瞬态不落库） */
function formatDuration(ms: number): string {
  const s = ms / 1000
  return `${s >= 10 ? s.toFixed(0) : s.toFixed(1)} 秒`
}

/** 执行元数据（execution_logs.message_id 精确关联回复气泡——成功路径 1:1；落库稳定值）。
 *  无对应 execution（老消息/失败回复/前端尚未拉取）返回 undefined → 气泡不误显。 */
function execMetaFor(msg: { id: string }): ExecutionMeta | undefined {
  return store.sessionExecutions.get(msg.id)
}

/** 气泡 footer 执行元数据文案：{耗时} · in {prompt}k / out {completion}k tok。
 *  取代 durationMs 瞬态展示（durationMs 保留兜底——execution 拉取未到时新回复短暂可显）。 */
function execMetaTextFor(msg: { id: string }): string | null {
  const meta = execMetaFor(msg)
  if (!meta) return null
  const parts: string[] = []
  if (meta.latencyMs != null) parts.push(`耗时 ${formatDuration(meta.latencyMs)}`)
  const inTok = meta.promptTokens
  const outTok = meta.completionTokens
  if (inTok != null || outTok != null) {
    parts.push(`in ${fmtTokens(inTok ?? 0)} / out ${fmtTokens(outTok ?? 0)} tok`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

/** 是否可停止：回复中（busy）或有排队任务（AGENT_INTERRUPT 一个按钮覆盖两场景） */
function canStopAgent(agentId: string): boolean {
  return isAgentStoppable(store.currentStateFor(agentId))
}

function stopAgent(agentId: string): void {
  // OQ3：组件按会话渲染，传当前会话 sessionId——只停目标会话（并发双会话互不影响）
  store.interruptAgent(agentId, store.activeSessionId ?? undefined)
}

/** 窗口用量色阶：>= 交接线红、>= 告警线黄、否则弱化（阈值来自 /api/config/context，失败回退 0.8/0.9） */
function contextLevelFor(agentId: string): 'critical' | 'warn' | '' {
  const pct = contextPctFor(agentId)
  if (pct >= Math.round(store.contextConfig.handoffThreshold * 100)) return 'critical'
  if (pct >= Math.round(store.contextConfig.warnThreshold * 100)) return 'warn'
  return ''
}

/** 超过告警线的 agent（实时数据驱动，横幅数据源） */
const warnedAgents = computed(() => {
  const list: { name: string; pct: number }[] = []
  store.contextTokens.forEach((ctx, agentId) => {
    const max = maxTokensFor(agentId)
    if (!max || ctx <= 0) return
    const pct = Math.round((ctx / max) * 100)
    if (pct >= Math.round(store.contextConfig.warnThreshold * 100)) {
      list.push({ name: store.agentInfo(agentId)?.name || agentId, pct })
    }
  })
  return list
})

/** 横幅文案：⚠️ {猫名} 上下文已达 {n}%（超过 {告警线}% 告警线，接近 {交接线}% 交接触发线） */
const warnedAgentsText = computed(() => {
  const cfg = store.contextConfig
  return warnedAgents.value
    .map(
      (a) =>
        `${a.name} 上下文已达 ${a.pct}%（超过 ${Math.round(cfg.warnThreshold * 100)}% 告警线，接近 ${Math.round(cfg.handoffThreshold * 100)}% 交接触发线）`
    )
    .join('、')
})

// ─── 记忆引用（M1：回复下方「这条回复用了哪些记忆」）──────────────
//
// 数据源 = `GET /api/sessions/:id/memory-refs`（**批量口**：一页 N 条消息发 1 次请求）。
// 三个不变量：
//   ① **不按消息发请求**——批量拉一次进 Map，`messageViews` 从 Map 取（A4 的判据）；
//   ② **拍平到父组件**——`MessageItem` 不得为此遍历消息集合（O(1) 重渲染硬契约）；
//   ③ **三态分开**——有注入 / 未使用（查了没选中）/ 未检索（压根没查），
//      见 `utils/memoryRefs.ts`。三者混一句，使用率的分母就没了。

/**
 * 记忆面只认 agent 消息——**请求面与渲染面必须同尺**：`fetchMemoryRefs` 发哪些 id、
 * `memoryRefViewFor` 给谁渲染记忆行，判的是同一件事。
 *
 * 两处各写一份 `role === 'agent'` 就是「同一规则两处措辞 = 假绿源」：判据一分叉，
 * 请求就会带上不该带的 id。会话历史里有一条 server 合成的 welcome 伪消息
 * （`welcome-<sessionId>`，role=system，**不落 messages 表**），
 * server 的越权守卫查不到它 ⇒ **整条 400**（不是跳过该 id）⇒ 全会话记忆行 + 角标全灭。
 */
function isMemoryRefMessage(msg: Message): boolean {
  return msg.role === 'agent'
}

/** 批量口结果：messageId → 条目（会话切换时整体替换） */
const memoryRefsByMessage = ref<Map<string, MemoryRefsEntry>>(new Map())

/**
 * 合并窗口：会话切换 / 历史批量到达会让触发源连跳几次（空列表 → 缓存/全量），
 * 不合并就是一串请求。50ms 足够吃掉同一次加载里的连跳，又短到用户无感。
 */
const MEMORY_REFS_DEBOUNCE_MS = 50
let memoryRefsTimer: ReturnType<typeof setTimeout> | undefined
/** 请求序号：乱序回来的旧响应不许覆盖新会话的结果（切会话竞态） */
let memoryRefsSeq = 0

/**
 * 单次批量口的 id 上限，**必须与 server 的 `MAX_MESSAGE_IDS`（`routes/memory.ts`）同值**——
 * 超限 server 端是一整条 400（不静默截断），那会让整个会话的记忆行全灭。
 * 会话历史本身上限 200（`getSessionHistory` 默认 limit），故只有「长驻会话持续追加到
 * 200 条以上」才触发；触发时**取最近 200 条并留痕**（不静默丢）。
 */
const MEMORY_REFS_MAX_IDS = 200

async function fetchMemoryRefs(): Promise<void> {
  const sessionId = store.activeSessionId
  // 只发 agent 消息的 id（`isMemoryRefMessage`）——非 agent（user / welcome 伪消息）
  // 既不会渲染记忆行也不会渲染角标，发过去只会让 server 整条 400（见该函数注）。
  const all = store.activeMessages.filter((m) => isMemoryRefMessage(m)).map((m) => m.id)
  if (!sessionId || all.length === 0) {
    memoryRefsByMessage.value = new Map()
    return
  }
  const ids = all.length > MEMORY_REFS_MAX_IDS ? all.slice(-MEMORY_REFS_MAX_IDS) : all
  if (ids.length !== all.length) {
    log.error('记忆引用：消息数超单次批量上限，只取最近一批', {
      total: all.length,
      requested: ids.length,
    })
  }
  const seq = ++memoryRefsSeq
  try {
    const res = await api.getSessionMemoryRefs(sessionId, ids)
    if (seq !== memoryRefsSeq || store.activeSessionId !== sessionId) return
    memoryRefsByMessage.value = new Map(Object.entries(res))
  } catch (err) {
    // fire-and-forget：失败只留痕，不清空已加载的部分（与 fetchSessionExecutions 同款）
    log.error('fetchMemoryRefs failed', { error: String(err) })
  }
}

function scheduleFetchMemoryRefs(): void {
  if (memoryRefsTimer) clearTimeout(memoryRefsTimer)
  memoryRefsTimer = setTimeout(() => {
    memoryRefsTimer = undefined
    void fetchMemoryRefs()
  }, MEMORY_REFS_DEBOUNCE_MS)
}

// 触发源 = 「会话 + 消息条数 + 末条 id」三者的标量签名：
// 流式期间消息数组不变（增量在 typingStates 里），故流式 chunk **不触发**重拉；
// 新回复落库（末条 id 变）才拉一次。
watch(
  () =>
    `${store.activeSessionId ?? ''}|${store.activeMessages.length}|${lastMessageId.value ?? ''}`,
  () => scheduleFetchMemoryRefs(),
  { immediate: true }
)

// ─── 记忆抽屉（形态乙：库内看片段 + 次级链接开当前文档）────────────

/** 当前抽屉里的片段（null = 抽屉关着）；数据来自批量口，**不再发请求** */
const activeMemoryRef = ref<MemoryRef | null>(null)
/** 次级链接的目标文档正文（点「打开当前文档」才加载） */
const docPreview = ref<{ loading: boolean; content: string | null; error: string | null }>({
  loading: false,
  content: null,
  error: null,
})

/** 片段正文缺失时的占位文案（M3 前是 `<pre>` 里的一条内联兜底，现提为常量给渲染用） */
const DRAWER_SNIPPET_EMPTY = '（这一行没有落片段正文）'

/**
 * 抽屉两处内容区的渲染产物（M3：记忆抽屉 MD 化）。
 *
 * 走正文气泡**同一条管线** `renderMarkdown`（marked + DOMPurify）——故 `v-html` 的输入
 * 是**已消毒**的 HTML，安全面与正文同源、不重开。`markers` 缺省不传：抽屉不是回复正文，
 * 切片里的 `[n]` 保持字面（角标面不动，票 §三）。
 *
 * 注意渲染层**不管**两条口径纪律——「bodyHead 是命中片 ≠ 猫当时读到的整节」「打开的是
 * 当前检出、不是当时快照」由下方 caption / hint 文案逐字承担，MD 化只是换渲染器。
 */
const drawerSnippetHtml = computed(() =>
  renderMarkdown(activeMemoryRef.value?.bodyHead ?? DRAWER_SNIPPET_EMPTY)
)

/** 当前文档正文的渲染产物（抽屉关着 / 未加载 / 加载失败时不跑重管线） */
const drawerDocHtml = computed(() => {
  const content = docPreview.value.content
  return content === null ? '' : renderMarkdown(content)
})

function openMemoryRef(ref: MemoryRef): void {
  activeMemoryRef.value = ref
  docPreview.value = { loading: false, content: null, error: null }
}

function closeMemoryRef(): void {
  activeMemoryRef.value = null
  docPreview.value = { loading: false, content: null, error: null }
}

/**
 * 「打开当前文档」——**当前检出上的文档，不是当时的快照**（形态丙外链被否正是因为
 * 这一点）。按钮文案与抽屉标题都写「当前文档」，不写「猫当时读到的」。
 */
async function loadCurrentDoc(): Promise<void> {
  const ref = activeMemoryRef.value
  if (!ref || docPreview.value.loading) return
  docPreview.value = { loading: true, content: null, error: null }
  try {
    const res = await api.getMemoryDoc(ref.docPath)
    if (activeMemoryRef.value !== ref) return
    docPreview.value = { loading: false, content: res.content, error: null }
  } catch (err) {
    if (activeMemoryRef.value !== ref) return
    docPreview.value = { loading: false, content: null, error: String(err) }
  }
}

// ─── 消息视图模型（渲染边界的承重件）──────────────────────────
// 抽取 MessageItem 只完成一半：Vue 的更新传播是组件粒度，**前提是 props 引用不变**。
// 若父组件每次重渲染都现算一遍并把新对象/新数组塞下去，子组件照样全部重渲染——白抽。
// 故所有「依赖整个消息数组或下标」的判定（分组、日期分隔、最新用户消息、发送者/头像/
// 模型名/token 文案/状态行/撤回与重启态）都在这里一次算成标量，且**逐字段相等时复用上
// 一轮的对象引用**（身份稳定）。这样流式 chunk 只重渲染「流式气泡 + 真正变化的那条」。

/** 当前会话最后一条用户消息 id（撤回按钮显隐）——倒序找首个，替掉每条消息各跑一次
 *  全量 filter 的 O(N²) */
const lastUserMessageId = computed(() => {
  const msgs = store.activeMessages
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') return msgs[i].id
  }
  return null
})

type MessageView = {
  msg: Message
  /** 日期分隔线（TransitionGroup 内 .message 的兄弟节点，不属 MessageItem） */
  showDateSep: boolean
  dateText: string
  grouped: boolean
  isLatestUser: boolean
  avatar: string
  senderName: string
  modelName: string
  tokensText: string
  contextLevel: 'critical' | 'warn' | ''
  execMetaText: string | null
  durationText: string | null
  timeText: string
  statusEntries: AgentStatusEntry[]
  restartState: 'pending' | 'confirmed' | 'none'
  restartConfirming: boolean
  retractConfirming: boolean
  /** footer 记忆引用行（M1）——引用稳定（按 messageId 缓存），null = 不渲染该行 */
  memoryRefs: MemoryRefView | null
}

/** 逐字段相等判定（引用类型只比引用：msg/statusEntries 都是稳定引用） */
function isSameView(a: MessageView, b: MessageView): boolean {
  return (
    a.msg === b.msg &&
    a.showDateSep === b.showDateSep &&
    a.dateText === b.dateText &&
    a.grouped === b.grouped &&
    a.isLatestUser === b.isLatestUser &&
    a.avatar === b.avatar &&
    a.senderName === b.senderName &&
    a.modelName === b.modelName &&
    a.tokensText === b.tokensText &&
    a.contextLevel === b.contextLevel &&
    a.execMetaText === b.execMetaText &&
    a.durationText === b.durationText &&
    a.timeText === b.timeText &&
    a.statusEntries === b.statusEntries &&
    a.restartState === b.restartState &&
    a.restartConfirming === b.restartConfirming &&
    a.retractConfirming === b.retractConfirming &&
    // 记忆行按**引用**比：`memoryRefViewFor` 保证同一份原始条目（引用不变）产出同一个视图对象
    a.memoryRefs === b.memoryRefs
  )
}

/** 上一轮视图对象（messageId → view），用于身份复用；随 computed 重算整体替换 */
const viewCache = new Map<string, MessageView>()

/**
 * 记忆行视图缓存（messageId → { raw, view }）。
 *
 * 原始条目（`memoryRefsByMessage` 里的对象）在两次重拉之间是**同一引用**，故同一原始
 * 条目必然产出同一个 view 对象——`isSameView` 的 `a.memoryRefs === b.memoryRefs` 才成立。
 * 没有这层缓存的话，每次重算都新建对象 ⇒ 所有带记忆行的气泡在任意无关更新（含流式
 * chunk 触发的 messageViews 重算）时全部重渲染——正是抽取 MessageItem 要拆掉的那条链。
 */
const memoryViewCache = new Map<
  string,
  { raw: MemoryRefsEntry | undefined; view: MemoryRefView | null }
>()

/** 取正文段最后一个 text 段之外，本函数只看 role 与 id —— 非 agent 不渲染记忆行 */
function memoryRefViewFor(msg: Message): MemoryRefView | null {
  if (!isMemoryRefMessage(msg)) return null
  const raw = memoryRefsByMessage.value.get(msg.id)
  const cached = memoryViewCache.get(msg.id)
  if (cached && cached.raw === raw) return cached.view
  const view = buildMemoryRefView(raw)
  memoryViewCache.set(msg.id, { raw, view })
  return view
}

const messageViews = computed<MessageView[]>(() => {
  const msgs = store.activeMessages
  const lastUserId = lastUserMessageId.value
  const sepIndices = dateSepIndices.value
  const views: MessageView[] = []
  const next = new Map<string, MessageView>()
  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i]
    const agentId = msg.agentId
    const fresh: MessageView = {
      msg,
      showDateSep: sepIndices.has(i),
      dateText: formatDate(msg.createdAt),
      grouped: isGrouped(i),
      isLatestUser: msg.role === 'user' && msg.id === lastUserId,
      avatar: avatarFor(msg.role, agentId),
      senderName: senderName(agentId),
      modelName: agentId ? modelNameFor(agentId) : '',
      tokensText: agentId ? tokensTextFor(agentId) : '',
      contextLevel: agentId ? contextLevelFor(agentId) : '',
      execMetaText: execMetaTextFor(msg),
      durationText: msg.durationMs != null ? `耗时 ${formatDuration(msg.durationMs)}` : null,
      timeText: formatTime(msg.createdAt),
      statusEntries: store.messageStatus.get(msg.id) ?? EMPTY_STATUS,
      restartState: restartStateFor(msg),
      restartConfirming: store.confirmingRestartMessageId === msg.id,
      retractConfirming: retractConfirm.value === msg.id,
      memoryRefs: memoryRefViewFor(msg),
    }
    const cached = viewCache.get(msg.id)
    const view = cached && isSameView(cached, fresh) ? cached : fresh
    next.set(msg.id, view)
    views.push(view)
  }
  viewCache.clear()
  next.forEach((v, id) => viewCache.set(id, v))
  // 记忆行视图缓存的淘汰与 viewCache 同点：已被删掉的消息不留缓存（本组件长驻，
  // 只增不减的 Map 会随会话时长泄漏）
  for (const id of Array.from(memoryViewCache.keys())) {
    if (!next.has(id)) memoryViewCache.delete(id)
  }
  return views
})
</script>

<template>
  <div class="chat-panel">
    <!-- Header -->
    <div class="chat-header">
      <div class="chat-header-left">
        <!-- 左侧栏折叠按钮（Claude/OpenAI 风格：始终可见的汉堡菜单） -->
        <button
          class="btn-sidebar-toggle"
          :title="props.leftSidebarOpen ? '收起会话列表' : '展开会话列表'"
          :aria-label="props.leftSidebarOpen ? '收起会话列表' : '展开会话列表'"
          @click="emit('toggleLeftSidebar')"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path
              d="M3 4.5h12M3 9h12M3 13.5h8"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
            />
          </svg>
        </button>

        <h2 v-if="store.activeSession">{{ store.activeSession.title }}</h2>
        <span v-else class="placeholder">选择会话开始聊天</span>
        <span
          class="connection-dot"
          :class="{ online: store.serverOnline }"
          :title="store.serverOnline ? '已连接' : '连接断开'"
        ></span>

        <!-- 日间/夜间模式切换 — 始终可见，不依赖活跃会话 -->
        <button
          class="btn-theme-toggle"
          :title="isDark ? '切换日间模式' : '切换夜间模式'"
          :aria-label="isDark ? '切换日间模式' : '切换夜间模式'"
          @click="toggleTheme()"
        >
          <!-- 太阳图标（夜间模式显示，点击切换到日间） -->
          <svg v-if="isDark" width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="3.5" stroke="currentColor" stroke-width="1.3" />
            <path
              d="M8 1.5v1.2M8 13.3v1.2M2.5 8H1.3M14.7 8h-1.2M3.8 3.8l-.8-.8M12.9 12.9l-.8-.8M12.2 3.8l.8-.8M3.1 12.9l.8-.8"
              stroke="currentColor"
              stroke-width="1.2"
              stroke-linecap="round"
            />
          </svg>
          <!-- 月亮图标（日间模式显示，点击切换到夜间） -->
          <svg v-else width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M13.5 10.2a5.6 5.6 0 0 1-2.2.5A5.5 5.5 0 0 1 6.8 2.5a5.5 5.5 0 1 0 6.7 7.7Z"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>

      <div v-if="store.activeSessionId" class="chat-header-actions">
        <button
          class="btn-clear"
          :class="{ 'btn-clear-confirm': clearConfirm }"
          :title="clearConfirm ? '确认清空所有消息' : '清空所有消息'"
          :aria-label="clearConfirm ? '确认清空所有消息' : '清空所有消息'"
          :disabled="clearingMessages"
          @click="handleClearMessages"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path
              d="M2 4h12M5.5 4V2.5h5V4M6.5 7v5M9.5 7v5M3.5 4l.7 9.1a1 1 0 001 .9h5.6a1 1 0 001-.9l.7-9.1"
              stroke="currentColor"
              stroke-width="1.2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          {{ clearingMessages ? '…' : clearConfirm ? '确认清空？' : '清空' }}
        </button>
      </div>
    </div>

    <!-- Messages -->
    <div ref="chatContainer" class="chat-messages-wrapper" @scroll.passive="checkScrollPosition">
      <div class="chat-messages-inner" aria-live="polite">
        <!-- 80% 告警横幅：任一 agent 上下文超过告警线（实时数据驱动，阈值来自配置） -->
        <div v-if="warnedAgents.length" class="context-warning-banner" role="alert">
          ⚠️ {{ warnedAgentsText }}
        </div>

        <!-- 交接失败横幅：server 端摘要生成失败时 emit HANDOFF_FAILED（仅当前会话），收到新消息/手动关闭清除 -->
        <div v-if="store.handoffFailed" class="handoff-failed-banner" role="alert">
          <span>⚠️ 交接失败：{{ store.handoffFailed.reason }}</span>
          <button class="banner-dismiss" title="关闭" @click="store.dismissHandoffFailed()">
            ✕
          </button>
        </div>

        <!-- Session 切换加载中 -->
        <div
          v-if="store.activeSessionId && store.loadingMessages && store.activeMessages.length === 0"
          class="loading-messages"
        >
          <div class="loading-skeleton">
            <div class="skeleton-msg" v-for="i in 3" :key="i">
              <div class="skeleton-avatar"></div>
              <div class="skeleton-body">
                <div class="skeleton-line skeleton-line-sm"></div>
                <div class="skeleton-line skeleton-line-lg"></div>
                <div class="skeleton-line skeleton-line-md"></div>
              </div>
            </div>
            <div class="loading-spinner">
              <span class="spinner-dot"></span>
              <span class="spinner-dot"></span>
              <span class="spinner-dot"></span>
            </div>
          </div>
        </div>

        <div v-if="!store.activeSessionId" class="empty-state">
          <div class="empty-icon">🐱</div>
          <h3>欢迎来到 CatStudio</h3>
          <p v-if="store.sessions.length > 0">从左侧选择一个会话开始聊天</p>
          <p v-else>点击左下角按钮创建一个新会话</p>
          <p class="empty-hint">在消息中使用 @猫咪名字 来指定谁来回复</p>
        </div>

        <TransitionGroup name="msg">
          <template v-for="view in messageViews" :key="view.msg.id">
            <!-- Date separator (独立块级元素，不受 .message flex 影响) -->
            <div
              v-if="view.showDateSep"
              class="date-separator"
              :key="`sep-${view.msg.id}`"
              :class="{ 'date-sep-system': view.msg.role === 'system' }"
            >
              <span>{{ view.dateText }}</span>
            </div>

            <!-- 渲染边界：单条消息的全部模板内判定已上移到 messageViews（标量 prop），
                 props 引用不变 ⇒ 本组件整棵子树跳过更新 ⇒ 一个 chunk 只重渲染流式气泡 -->
            <MessageItem
              :msg="view.msg"
              :grouped="view.grouped"
              :is-latest-user="view.isLatestUser"
              :avatar="view.avatar"
              :sender-name="view.senderName"
              :model-name="view.modelName"
              :tokens-text="view.tokensText"
              :context-level="view.contextLevel"
              :exec-meta-text="view.execMetaText"
              :duration-text="view.durationText"
              :time-text="view.timeText"
              :status-entries="view.statusEntries"
              :restart-state="view.restartState"
              :restart-confirming="view.restartConfirming"
              :retract-confirming="view.retractConfirming"
              :memory-refs="view.memoryRefs"
              @open-memory-ref="openMemoryRef"
              @preview-images="openPreview"
              @retract="handleRetract"
              @stop-agent="stopAgent"
              @confirm-restart="store.confirmRestart"
              @cancel-restart="store.cancelRestart"
            />
          </template>
        </TransitionGroup>

        <!-- Streaming agent reply (live preview while agent is thinking) -->
        <div
          v-for="[agentId, typing] in activeTypingStates"
          :key="'streaming-' + agentId"
          class="message agent streaming"
        >
          <div class="msg-avatar">{{ avatarFor('agent', agentId) }}</div>
          <div class="msg-body">
            <div class="msg-sender">{{ senderName(agentId) }}</div>
            <div class="msg-bubble">
              <!-- 结构分离：优先消费 server 推的 typing.segments（kind+content 分段）。
                   点1 新规格：流式期间 text 段不渲染（buildStreamItems drop，不产出外层 seg）——
                   思考+tool 段由 buildStreamItems 收进单一 fold（思考折叠块，时间序交错）；
                   最终正文只在流结束由持久化 message（MessageItem 的正文段）留外层。
                   ——旧 server 无 segments 时退化 parseThinkingBlocks -->
              <template v-for="(item, ii) in typing.items" :key="ii">
                <div
                  v-if="item.type === 'seg'"
                  class="msg-text"
                  v-html="
                    renderMarkdown(resolveDisplayPlaceholders(item.seg.content, store.agents))
                  "
                ></div>
                <!-- 思考+工具单折叠块：thinking 文本与 tool 行在折叠块内按时间序交错
                     （工具嵌在实际发生位置，不聚尾部）；受控展开态 item.open 驱动
                     （推进自动展开/结束自动收起，用户点过冻结），processing 时 header 显动点。
                     取消独立 tool-area——工具长在思考框内、不再堆积气泡正下方 -->
                <div
                  v-else-if="item.type === 'fold'"
                  class="thinking-block stream-fold"
                  :class="{ open: item.open }"
                >
                  <div
                    class="thinking-summary"
                    role="button"
                    tabindex="0"
                    :aria-expanded="item.open"
                    @click="toggleStreamFold(agentId, item.open)"
                    @keydown.enter.prevent="toggleStreamFold(agentId, item.open)"
                  >
                    <span class="thinking-icon">🐾</span>
                    <span class="thinking-label">思考过程</span>
                    <span
                      v-if="item.tools.length"
                      class="thinking-tool-hint"
                      :title="toolAreaSummary(item.tools)"
                    >
                      {{ toolAreaSummary(item.tools) }}
                    </span>
                    <span v-if="item.processing" class="thinking-dots"><i></i><i></i><i></i></span>
                    <span class="thinking-chevron">▶</span>
                  </div>
                  <div v-show="item.open" class="stream-fold-body">
                    <!-- 内跟进观测层：v-fold-stick 的 RO 观测本元素（高度随内容增长）。
                         不能观测外层 .stream-fold-body——它 max-height:220px 固定，
                         思考再长尺寸也不变，观测它等于没接。 -->
                    <div v-fold-stick class="stream-fold-inner">
                      <template v-for="(e, ei) in item.entries" :key="ei">
                        <div
                          v-if="e.kind === 'thinking'"
                          class="fold-thinking"
                          v-html="renderMarkdown(e.content)"
                        ></div>
                        <ToolRow v-else :tool="e.tool" class="stream-tool-row" />
                      </template>
                    </div>
                  </div>
                </div>
              </template>
              <span class="typing-cursor inline">|</span>
              <!-- streaming 气泡 footer：正在思考时的停止按钮落点（B2 重定位——
                   每 agent 唯一气泡，无分组问题；canStopAgent 保守覆盖排队场景） -->
              <div class="msg-footer">
                <span class="msg-footer-info" :class="contextLevelFor(agentId)">
                  {{ modelNameFor(agentId) }} · {{ tokensTextFor(agentId) }}
                </span>
                <span class="msg-footer-right">
                  <button
                    v-if="canStopAgent(agentId)"
                    class="btn-stop-agent"
                    title="停止思考并清空队列"
                    aria-label="停止"
                    @click.stop="stopAgent(agentId)"
                  >
                    停止
                  </button>
                  <!-- 计时唯一权威位（A2A / headless 执行没有用户消息状态行可挂）；
                       锚点缺失（旧 server 不带 startedAt）→ 回退静态「回复中…」 -->
                  <ReplyElapsed
                    v-if="replyTimerFor(agentId)"
                    :started-at="replyTimerFor(agentId)!.startedAt"
                    :last-beat-at="replyTimerFor(agentId)!.lastBeatAt"
                  />
                  <span v-else class="streaming-indicator">回复中…</span>
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- 占位气泡（无流式内容的执行）：复用 streaming 气泡的虚线视觉语言，正文思考动点、
             footer 停止按钮 + 计时。首个 chunk 到达后由上方流式气泡接管，计时同源不重置。 -->
        <div
          v-for="timer in placeholderTimers"
          :key="'placeholder-' + timer.agentId"
          class="message agent streaming"
        >
          <div class="msg-avatar">{{ avatarFor('agent', timer.agentId) }}</div>
          <div class="msg-body">
            <div class="msg-sender">{{ senderName(timer.agentId) }}</div>
            <div class="msg-bubble">
              <div class="placeholder-thinking">
                <span class="thinking-dots"><i></i><i></i><i></i></span>
              </div>
              <div class="msg-footer">
                <span class="msg-footer-info" :class="contextLevelFor(timer.agentId)">
                  {{ modelNameFor(timer.agentId) }} · {{ tokensTextFor(timer.agentId) }}
                </span>
                <span class="msg-footer-right">
                  <button
                    v-if="canStopAgent(timer.agentId)"
                    class="btn-stop-agent"
                    title="停止思考并清空队列"
                    aria-label="停止"
                    @click.stop="stopAgent(timer.agentId)"
                  >
                    停止
                  </button>
                  <ReplyElapsed :started-at="timer.startedAt" :last-beat-at="timer.lastBeatAt" />
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- New-message indicator.
             Only shown when messages arrive while the user is scrolled up.
             Always in DOM (no v-if) — hidden via CSS class instead of DOM removal,
             so scrollHeight stays stable during the hide animation. -->
        <button
          class="scroll-down-btn"
          :class="{ 'scroll-down-btn--hidden': !showScrollDown }"
          aria-label="滚动到新消息"
          @click="scrollToBottom(true)"
          title="回到新消息"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M4 6l4 4 4-4"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <span>{{ newMessageCount }} 条新消息</span>
        </button>
      </div>
    </div>

    <!-- Input -->
    <div class="chat-input-area">
      <div class="input-wrapper">
        <!-- 待发送图片预览 -->
        <div v-if="pastedImages.length" class="image-preview-row">
          <div v-for="(src, idx) in pastedImages" :key="idx" class="image-preview-item">
            <img :src="src" :alt="`待发送图片${idx + 1}`" />
            <button
              class="image-preview-remove"
              :aria-label="`移除图片${idx + 1}`"
              @click="removeImage(idx)"
            >
              ×
            </button>
          </div>
        </div>

        <textarea
          ref="textareaRef"
          v-model="input"
          class="chat-input"
          :placeholder="
            store.activeSessionId
              ? '输入消息… @猫咪名 提及  /技能名 触发  （可直接粘贴图片）'
              : '请先选择会话'
          "
          :disabled="!store.activeSessionId"
          rows="2"
          @input="onInput"
          @keydown="onKeydown"
          @paste="onPaste"
        ></textarea>

        <div
          v-if="mentionActive && !skillActive && mentionSuggestions.length > 0"
          class="mention-dropdown"
        >
          <div
            v-for="(agent, idx) in mentionSuggestions"
            :key="agent.id"
            class="mention-item"
            :class="{ active: idx === mentionIndex }"
            @mousedown.prevent="selectMention(idx)"
            @mouseenter="mentionIndex = idx"
          >
            <span class="mention-avatar">{{ agent.avatar }}</span>
            <span class="mention-name">{{ agent.name }}</span>
            <span class="mention-hint">tab</span>
          </div>
        </div>
        <div
          v-if="mentionActive && !skillActive && mentionSuggestions.length === 0"
          class="mention-dropdown mention-empty"
        >
          <span>未找到匹配的猫咪</span>
        </div>

        <!-- / 技能补全下拉（数据源见 useSkillCommand；skill 本体仍由 CLI 原生消费） -->
        <div
          v-if="skillActive && skillSuggestions.length > 0"
          class="mention-dropdown skill-dropdown"
        >
          <div
            v-for="(skill, idx) in skillSuggestions"
            :key="skill.name"
            class="mention-item"
            :class="{ active: idx === skillIndex }"
            @mousedown.prevent="selectSkillItem(idx)"
            @mouseenter="skillIndex = idx"
          >
            <span class="skill-name">/{{ skill.name }}</span>
            <span class="skill-desc" :title="skill.description">{{ skill.description }}</span>
            <span class="mention-hint">tab</span>
          </div>
        </div>
        <div
          v-else-if="skillActive && skillsLoaded"
          class="mention-dropdown mention-empty skill-dropdown"
        >
          <span>无匹配技能（skill 由 CLI 原生触发，可继续输入）</span>
        </div>
        <!-- 清单不可用时的兜底提示——「端点没取到」≠「没这个词」，不冒充「无匹配」 -->
        <div v-else-if="skillActive" class="skill-tip">
          <span>skill 由 CLI 原生触发：输入 /skill-name 或由 agent 自主调用，服务端不再注入</span>
        </div>
      </div>

      <button
        class="btn-image"
        :disabled="!store.activeSessionId || sending || pastedImages.length >= MAX_IMAGES"
        aria-label="添加图片"
        title="添加图片（或直接 Ctrl+V 粘贴，最多 4 张）"
        @click="fileInputRef?.click()"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect
            x="1.5"
            y="2.5"
            width="13"
            height="11"
            rx="1.5"
            stroke="currentColor"
            stroke-width="1.3"
          />
          <circle cx="5.5" cy="6" r="1.3" stroke="currentColor" stroke-width="1.2" />
          <path
            d="M2.5 12.5l3.5-3.5 2.5 2.5 2-2 3 3"
            stroke="currentColor"
            stroke-width="1.2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <input
        ref="fileInputRef"
        type="file"
        accept="image/*"
        multiple
        class="hidden-file-input"
        @change="onFileSelect"
      />

      <button
        class="btn-send"
        :disabled="
          (!input.trim() && pastedImages.length === 0) || !store.activeSessionId || sending
        "
        aria-label="发送消息"
        @click="handleSend"
      >
        {{ sending ? '…' : '发送' }}
      </button>
    </div>

    <!-- 图片大图预览（lightbox） -->
    <Teleport to="body">
      <div
        v-if="previewVisible"
        class="image-lightbox"
        role="dialog"
        aria-modal="true"
        :aria-label="`图片预览 ${previewIndex + 1} / ${previewImages.length}`"
        @click.self="closePreview"
        @wheel.prevent
        @touchmove.prevent
      >
        <button class="lightbox-close" aria-label="关闭大图" @click="closePreview">✕</button>
        <button
          v-if="previewImages.length > 1"
          class="lightbox-nav"
          aria-label="上一张"
          @click="previewStep(-1)"
        >
          ‹
        </button>
        <img
          :src="previewImages[previewIndex]"
          class="lightbox-img"
          :alt="`大图 ${previewIndex + 1}`"
        />
        <button
          v-if="previewImages.length > 1"
          class="lightbox-nav"
          aria-label="下一张"
          @click="previewStep(1)"
        >
          ›
        </button>
        <div v-if="previewImages.length > 1" class="lightbox-counter">
          {{ previewIndex + 1 }} / {{ previewImages.length }}
        </div>
      </div>
    </Teleport>

    <!-- 记忆引用抽屉（M1 形态乙）：命中片段全文（来自库，不再发请求）+ 次级链接开当前文档。
         两处措辞是**口径**不是文案偏好：① 片段是「命中片」，注入进 prompt 的是补齐后的
         整节；② 「打开当前文档」拿到的是当前检出上的文档，不是当时的快照。 -->
    <Teleport to="body">
      <div
        v-if="activeMemoryRef"
        class="memory-drawer-mask"
        role="dialog"
        aria-modal="true"
        aria-label="记忆片段"
        @click.self="closeMemoryRef"
      >
        <div class="memory-drawer">
          <div class="memory-drawer-head">
            <div class="memory-drawer-title">
              <span class="memory-drawer-name">{{ activeMemoryRef.docPath }}</span>
              <span class="memory-drawer-anchor">{{ activeMemoryRef.sectionAnchor }}</span>
            </div>
            <button class="memory-drawer-close" aria-label="关闭" @click="closeMemoryRef">✕</button>
          </div>
          <div class="memory-drawer-body">
            <div class="memory-drawer-caption">
              命中片段全文（检索当时落库）。注意：注入进 prompt
              的是按节补齐后的整节，与这段话不等价。
            </div>
            <!-- M3：命中片按 markdown 渲染（`.memory-drawer-md` = 抽屉这个 markdown 落点） -->
            <div v-html="drawerSnippetHtml" class="memory-drawer-snippet memory-drawer-md"></div>
            <div class="memory-drawer-actions">
              <button
                class="memory-drawer-open"
                :disabled="docPreview.loading"
                @click="loadCurrentDoc"
              >
                {{ docPreview.loading ? '加载中…' : '打开当前文档' }}
              </button>
              <span class="memory-drawer-hint">打开的是当前检出上的文档，不是当时的快照</span>
            </div>
            <div v-if="docPreview.error" class="memory-drawer-error">
              读取失败：{{ docPreview.error }}
            </div>
            <div
              v-else-if="docPreview.content !== null"
              v-html="drawerDocHtml"
              class="memory-drawer-doc memory-drawer-md"
            ></div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.chat-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* ─── Header ────────────────────────────── */

.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--bg-deep);
}

.chat-header-left h2 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: -0.2px;
}

.chat-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* ─── Sidebar Toggle Buttons (header) ───── */

.btn-sidebar-toggle {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--ease-out);
}

.btn-sidebar-toggle:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* ─── Theme Toggle ──────────────────────── */

.btn-theme-toggle {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--ease-out);
}

.btn-theme-toggle:hover {
  background: var(--bg-hover);
  color: var(--accent-text);
}

/* Connection dot */
.connection-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent-red);
  flex-shrink: 0;
  transition: background var(--ease-out);
}
.connection-dot.online {
  background: var(--accent-green);
}

.placeholder {
  font-size: 14px;
  color: var(--text-muted);
  font-weight: 400;
}

/* ─── Header Actions ───────────────────── */

.chat-header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

.btn-clear {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: all var(--ease-out);
}

.btn-clear:hover:not(:disabled) {
  color: var(--accent-red);
  border-color: var(--accent-red);
  background: rgba(224, 85, 106, 0.06);
}

.btn-clear-confirm {
  color: var(--accent-red) !important;
  border-color: var(--accent-red) !important;
  background: rgba(224, 85, 106, 0.12) !important;
  font-weight: 600;
}

.btn-clear:disabled {
  opacity: 0.4;
  cursor: default;
}

/* ─── Messages ──────────────────────────── */

.chat-messages-wrapper {
  flex: 1;
  overflow-y: auto;
  position: relative;
  width: 100%;
}

.chat-messages-inner {
  max-width: 800px;
  margin: 0 auto;
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 100%;
}

/* Empty State */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  text-align: center;
  gap: 8px;
}

.empty-icon {
  font-size: 48px;
  margin-bottom: 8px;
  opacity: 0.6;
}

.empty-state h3 {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-secondary);
}

.empty-state p {
  font-size: 13px;
  color: var(--text-muted);
  max-width: 280px;
}

.empty-hint {
  margin-top: 8px;
  font-size: 12px !important;
  opacity: 0.7;
}

/* ─── Loading Messages Skeleton ────────────── */

.loading-messages {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 24px;
}

.loading-skeleton {
  width: 100%;
  max-width: 520px;
}

.skeleton-msg {
  display: flex;
  gap: 12px;
  margin-bottom: 24px;
  opacity: 0.55;
  animation: skeletonPulse 1.8s ease-in-out infinite;
  animation-delay: calc(var(--i, 0) * 0.15s);
}
.skeleton-msg:nth-child(1) {
  --i: 0;
}
.skeleton-msg:nth-child(2) {
  --i: 1;
}
.skeleton-msg:nth-child(3) {
  --i: 2;
}

.skeleton-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--bg-hover);
  flex-shrink: 0;
}

.skeleton-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 4px;
}

.skeleton-line {
  height: 12px;
  border-radius: 6px;
  background: var(--bg-hover);
}

.skeleton-line-sm {
  width: 40%;
}

.skeleton-line-lg {
  width: 92%;
}

.skeleton-line-md {
  width: 65%;
}

@keyframes skeletonPulse {
  0%,
  100% {
    opacity: 0.4;
  }
  50% {
    opacity: 0.75;
  }
}

.loading-spinner {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: 12px;
}

.spinner-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  opacity: 0.5;
  animation: spinnerBounce 1.2s ease-in-out infinite;
}
.spinner-dot:nth-child(2) {
  animation-delay: 0.2s;
}
.spinner-dot:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes spinnerBounce {
  0%,
  80%,
  100% {
    opacity: 0.3;
    transform: scale(0.8);
  }
  40% {
    opacity: 1;
    transform: scale(1.15);
  }
}

/* ─── Context Warning Banner（80% 告警）────── */

/* 横幅 sticky 贴顶：相对 .chat-messages-wrapper 滚动容器粘住——不滚动时仍在消息流最顶，
   滚动后贴顶始终可见（position: sticky 对 flex item 生效）。背景补实底（半透明黄 + bg-deep），
   防止滚动经过的消息文字从横幅下方透出；z-index 保证覆盖层序 */
.context-warning-banner {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 14px;
  margin-bottom: 8px;
  border-radius: var(--radius-md);
  background: linear-gradient(rgba(224, 158, 70, 0.12), rgba(224, 158, 70, 0.12)), var(--bg-deep);
  border: 1px solid rgba(224, 158, 70, 0.35);
  color: var(--accent-yellow);
  font-size: 12px;
  line-height: 1.5;
  text-align: center;
  flex-shrink: 0;
}

/* ─── Handoff Failed Banner（交接失败可见化）────── */

/* 与 80% 告警横幅同位置/样式族（sticky 贴顶、实底防透），红色系区分；
   两者同时出现时失败横幅在告警横幅下方（文档流占位天然错开，不叠加） */
.handoff-failed-banner {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 8px 14px;
  margin-bottom: 8px;
  border-radius: var(--radius-md);
  background: linear-gradient(rgba(224, 90, 70, 0.14), rgba(224, 90, 70, 0.14)), var(--bg-deep);
  border: 1px solid rgba(224, 90, 70, 0.4);
  color: var(--accent-red);
  font-size: 12px;
  line-height: 1.5;
  text-align: center;
  flex-shrink: 0;
}

.handoff-failed-banner .banner-dismiss {
  background: none;
  border: none;
  color: inherit;
  opacity: 0.7;
  cursor: pointer;
  font-size: 12px;
  padding: 0 2px;
  line-height: 1;
}

.handoff-failed-banner .banner-dismiss:hover {
  opacity: 1;
}

/* ─── Date Separator ────────────────────── */

.date-separator {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px 0 4px;
}

.date-separator span {
  font-size: 11px;
  color: var(--text-muted);
  opacity: 0.65;
  background: var(--bg-deep);
  padding: 2px 16px;
  border-radius: 10px;
}

.date-sep-system {
  padding: 0 0 4px;
}

.date-sep-system span {
  background: transparent;
}

/* ─── Scroll-to-bottom Button ───────────── */

.scroll-down-btn {
  position: sticky;
  bottom: 12px;
  align-self: center;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 14px;
  border: 1px solid var(--border-default);
  border-radius: 20px;
  background: var(--bg-raised);
  color: var(--text-secondary);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  box-shadow: var(--shadow-md);
  z-index: 20;
  /* Button is always in DOM — visibility controlled via opacity/transform,
     never by DOM removal, so scrollHeight stays stable. */
  transition:
    opacity 0.2s ease-out,
    transform 0.2s ease-out,
    border-color var(--ease-out),
    color var(--ease-out),
    background var(--ease-out),
    box-shadow var(--ease-out);
}

.scroll-down-btn--hidden {
  opacity: 0;
  pointer-events: none;
  transform: translateY(8px);
}

.scroll-down-btn:hover {
  color: var(--accent-text);
  border-color: var(--accent-text);
  background: var(--bg-surface);
  box-shadow: var(--shadow-lg);
}

/* ─── Input Area ────────────────────────── */

.chat-input-area {
  display: flex;
  gap: 10px;
  padding: 14px 20px;
  max-width: 800px;
  margin: 0 auto;
  width: 100%;
  border-top: 1px solid var(--border-subtle);
}

.input-wrapper {
  flex: 1;
  position: relative;
}

.chat-input {
  width: 100%;
  padding: 10px 14px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  background: var(--bg-surface);
  color: var(--text-primary);
  font-family: inherit;
  line-height: 1.5;
  resize: none;
  outline: none;
  transition:
    border-color var(--ease-out),
    box-shadow var(--ease-out);
}

.chat-input:hover:not(:disabled) {
  border-color: var(--border-focus);
}

.chat-input:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.chat-input::placeholder {
  color: var(--text-muted-frozen);
}

/* ─── Image Attachments ──────────────────── */

.image-preview-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  padding: 0 2px 8px;
}

.image-preview-item {
  position: relative;
  width: 56px;
  height: 56px;
  flex-shrink: 0;
}

.image-preview-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
}

.image-preview-remove {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 50%;
  background: var(--accent-red);
  color: #fff;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
}

.hidden-file-input {
  display: none;
}

/* Image preview lightbox */
.image-lightbox {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: clamp(10px, 2vw, 28px);
  cursor: zoom-out;
}

.lightbox-img {
  /* 单图默认 92vw 全幅；多图时才让出两侧按钮空间（见下方 :has 规则） */
  max-width: 92vw;
  max-height: 92vh;
  object-fit: contain;
  border-radius: var(--radius-md);
  cursor: default;
}

/* 多图：flex 行含 nav 按钮时图片让位（44px×2 + gap 上限 28px×2 ≈ 150px），
   保证按钮贴图且整行不溢出。让位仅在 <1875px 视口下确实缩小图片，
   更宽的屏上 calc(100vw - 150px) 反而大于 92vw——但那一档本来就用不满 */
.image-lightbox:has(.lightbox-nav) .lightbox-img {
  max-width: calc(100vw - 150px);
}

.lightbox-close,
.lightbox-nav {
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background var(--ease-out);
}

.lightbox-close {
  position: absolute;
  top: 16px;
  right: 16px;
  width: 40px;
  height: 40px;
  font-size: 18px;
}

.lightbox-nav {
  /* 不绝对定位贴视口边缘——作为 flex 子项紧贴图片两侧，图片多大按钮就贴多近 */
  flex-shrink: 0;
  width: 44px;
  height: 44px;
  font-size: 26px;
  line-height: 1;
}

.lightbox-close:hover,
.lightbox-nav:hover {
  background: rgba(255, 255, 255, 0.3);
}

.lightbox-counter {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  color: rgba(255, 255, 255, 0.85);
  font-size: 14px;
  background: rgba(0, 0, 0, 0.5);
  padding: 4px 12px;
  border-radius: var(--radius-sm);
}

.btn-image {
  flex-shrink: 0;
  width: 36px;
  border: none;
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  align-self: flex-end;
  padding: 8px 0;
  transition: all var(--ease-out);
}

.btn-image:hover:not(:disabled) {
  color: var(--accent-text);
  border-color: var(--accent-text);
  box-shadow: var(--shadow-sm);
}

.btn-image:disabled {
  opacity: 0.4;
  cursor: default;
}

/* Mention Dropdown */
.mention-dropdown {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  min-width: 220px;
  max-height: 240px;
  overflow-y: auto;
  background: var(--bg-raised);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  z-index: 100;
}

.mention-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  cursor: pointer;
  transition: background var(--ease-in);
}

.mention-item:first-child {
  border-radius: var(--radius-md) var(--radius-md) 0 0;
}

.mention-item:last-child {
  border-radius: 0 0 var(--radius-md) var(--radius-md);
}

.mention-item:hover,
.mention-item.active {
  background: var(--bg-hover);
}

.mention-avatar {
  font-size: 22px;
}

.mention-name {
  font-size: 14px;
  flex: 1;
  font-weight: 500;
}

.mention-hint {
  font-size: 10px;
  color: var(--text-muted);
  background: var(--bg-surface);
  padding: 2px 7px;
  border-radius: 4px;
  font-weight: 500;
}

.mention-empty {
  padding: 12px 14px;
  font-size: 13px;
  color: var(--text-muted);
}

/* Skill 补全下拉（复用 mention 下拉容器样式；多一列 description） */
.skill-dropdown {
  min-width: 320px;
  max-width: 560px;
}

.skill-name {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 500;
  flex: 0 0 auto;
  white-space: nowrap;
}

/* 描述单行省略——frontmatter 自述可达 200+ 字符，换行会把下拉撑成一堵墙；
   全文走 title 悬停可见 */
.skill-desc {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Skill 提示框（清单不可用时的兜底：CLI 原生触发说明） */
.skill-tip {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  min-width: 260px;
  padding: 12px 14px;
  font-size: 13px;
  color: var(--text-muted);
  background: var(--bg-raised);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  z-index: 100;
}

/* Send Button */
.btn-send {
  padding: 8px 22px;
  border: none;
  border-radius: var(--radius-md);
  background: var(--accent);
  color: var(--text-on-accent);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  align-self: flex-end;
  transition: all var(--ease-out);
}

.btn-send:hover:not(:disabled) {
  background: var(--accent-hover);
  box-shadow: var(--shadow-sm);
  transform: translateY(-1px);
}

.btn-send:disabled {
  opacity: 0.3;
  cursor: default;
}
</style>

<!-- Non-scoped: markdown content rendered via v-html -->
<style>
/* ─── Send button — light theme contrast fix ── */

[data-theme='light'] .chat-panel .btn-send {
  color: var(--text-primary);
}

/* ─── Inline formatting ────────────────── */

.chat-panel .msg-text strong,
.chat-panel .msg-text b,
.memory-drawer-md strong,
.memory-drawer-md b {
  font-weight: 600;
  color: var(--text-primary);
}

.chat-panel .msg-text em,
.chat-panel .msg-text i,
.memory-drawer-md em,
.memory-drawer-md i {
  font-style: italic;
}

.chat-panel .msg-text del,
.chat-panel .msg-text s,
.memory-drawer-md del,
.memory-drawer-md s {
  text-decoration: line-through;
  opacity: 0.7;
}

.chat-panel .msg-text a,
.memory-drawer-md a {
  color: var(--accent-text);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.chat-panel .msg-text a:hover,
.memory-drawer-md a:hover {
  opacity: 0.8;
}

/* ─── Inline code ───────────────────────── */

/* 四个落点同源——正文（.msg-text）、流式思考框（.fold-thinking）、历史思考框
   （.thinking-content）、记忆抽屉（.memory-drawer-md，M3 加入）都渲染 markdown 产出的
   code。此前只写正文一处，思考框里的行内 code 掉进 UA 默认（word-break: normal）：
   无空格长路径（实测 120 字符）不折行，顶出容器横向溢出（overRight=79.7px）。
   规则一一并列，新增落点不再各写一份——落点组的机械守卫在 ChatPanel.test.ts。 */
.chat-panel .msg-text code,
.chat-panel .fold-thinking code,
.chat-panel .thinking-content code,
.memory-drawer-md code {
  font-family: 'Cascadia Code', 'Fira Code', 'Consolas', 'Monaco', monospace;
  font-size: 0.9em;
  background: rgba(127, 127, 127, 0.12);
  padding: 1px 5px;
  border-radius: 4px;
  word-break: break-all;
}

/* ─── Code blocks ───────────────────────── */

/* 同上：正文代码块早就有 overflow-x:auto（长行自己横向滚），思考框一条 pre 规则都没有，
   代码块的 white-space:pre 让长行永不折行、自己又 overflow:visible 抓不住溢出 ⇒ 一路冒到
   最近的滚动容器 .stream-fold-body，把它的 scrollWidth 顶到 9257px（实测 22/38 个思考框
   溢出，最严重 17.5 倍）。本组规则让思考框代码块与正文同款：自己滚，不外溢。 */
.chat-panel .msg-text pre,
.chat-panel .fold-thinking pre,
.chat-panel .thinking-content pre,
.memory-drawer-md pre {
  background: var(--syntax-bg);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  padding: 12px 14px;
  overflow-x: auto;
  margin: 8px 0;
  /* 覆盖 .msg-text 的 overflow-wrap:anywhere——代码块保持原样换行语义，长行走横向滚动 */
  overflow-wrap: normal;
}

/* 特异性说明：本组 (0,2,2) 高于上面行内 code 组的 (0,2,1)，块内 code 恒走本组。 */
.chat-panel .msg-text pre code,
.chat-panel .fold-thinking pre code,
.chat-panel .thinking-content pre code,
.memory-drawer-md pre code {
  background: none;
  padding: 0;
  font-size: 0.85em;
  color: var(--syntax-text);
  line-height: 1.55;
  border-radius: 0;
  word-break: normal;
  white-space: pre;
}

/* ─── hljs classes (highlight.js injected by marked) ─── */

.chat-panel .msg-text pre code .hljs-keyword,
.memory-drawer-md pre code .hljs-keyword {
  color: var(--syntax-keyword);
}
.chat-panel .msg-text pre code .hljs-string,
.memory-drawer-md pre code .hljs-string {
  color: var(--syntax-string);
}
.chat-panel .msg-text pre code .hljs-number,
.memory-drawer-md pre code .hljs-number {
  color: var(--syntax-number);
}
.chat-panel .msg-text pre code .hljs-comment,
.memory-drawer-md pre code .hljs-comment {
  color: var(--syntax-comment);
  font-style: italic;
}
.chat-panel .msg-text pre code .hljs-function,
.memory-drawer-md pre code .hljs-function {
  color: var(--syntax-function);
}
.chat-panel .msg-text pre code .hljs-title,
.memory-drawer-md pre code .hljs-title {
  color: var(--syntax-function);
}
.chat-panel .msg-text pre code .hljs-type,
.memory-drawer-md pre code .hljs-type {
  color: var(--syntax-type);
}
.chat-panel .msg-text pre code .hljs-attr,
.memory-drawer-md pre code .hljs-attr {
  color: var(--syntax-attr);
}
.chat-panel .msg-text pre code .hljs-built_in,
.memory-drawer-md pre code .hljs-built_in {
  color: var(--syntax-builtin);
}
.chat-panel .msg-text pre code .hljs-literal,
.memory-drawer-md pre code .hljs-literal {
  color: var(--syntax-number);
}
.chat-panel .msg-text pre code .hljs-params,
.memory-drawer-md pre code .hljs-params {
  color: var(--syntax-params);
}
.chat-panel .msg-text pre code .hljs-property,
.memory-drawer-md pre code .hljs-property {
  color: var(--syntax-attr);
}
.chat-panel .msg-text pre code .hljs-punctuation,
.memory-drawer-md pre code .hljs-punctuation {
  color: var(--syntax-punctuation);
}
.chat-panel .msg-text pre code .hljs-regexp,
.memory-drawer-md pre code .hljs-regexp {
  color: var(--syntax-builtin);
}
.chat-panel .msg-text pre code .hljs-meta,
.memory-drawer-md pre code .hljs-meta {
  color: var(--syntax-type);
}
.chat-panel .msg-text pre code .hljs-selector-class,
.memory-drawer-md pre code .hljs-selector-class {
  color: var(--syntax-string);
}

/* ─── Code blocks — light theme overrides ─── */

[data-theme='light'] .chat-panel .msg-text pre,
[data-theme='light'] .chat-panel .fold-thinking pre,
[data-theme='light'] .chat-panel .thinking-content pre,
[data-theme='light'] .memory-drawer-md pre {
  background: var(--syntax-bg);
  border-color: rgba(0, 0, 0, 0.08);
}

[data-theme='light'] .chat-panel .msg-text pre code,
[data-theme='light'] .chat-panel .fold-thinking pre code,
[data-theme='light'] .chat-panel .thinking-content pre code,
[data-theme='light'] .memory-drawer-md pre code {
  color: var(--syntax-text);
}

[data-theme='light'] .chat-panel .msg-text pre code .hljs-keyword,
[data-theme='light'] .memory-drawer-md pre code .hljs-keyword {
  color: var(--syntax-keyword);
}
[data-theme='light'] .chat-panel .msg-text pre code .hljs-string,
[data-theme='light'] .memory-drawer-md pre code .hljs-string {
  color: var(--syntax-string);
}
[data-theme='light'] .chat-panel .msg-text pre code .hljs-number,
[data-theme='light'] .memory-drawer-md pre code .hljs-number {
  color: var(--syntax-number);
}
[data-theme='light'] .chat-panel .msg-text pre code .hljs-comment,
[data-theme='light'] .memory-drawer-md pre code .hljs-comment {
  color: var(--syntax-comment);
}
[data-theme='light'] .chat-panel .msg-text pre code .hljs-function,
[data-theme='light'] .chat-panel .msg-text pre code .hljs-title,
[data-theme='light'] .memory-drawer-md pre code .hljs-function,
[data-theme='light'] .memory-drawer-md pre code .hljs-title {
  color: var(--syntax-function);
}
[data-theme='light'] .chat-panel .msg-text pre code .hljs-type,
[data-theme='light'] .memory-drawer-md pre code .hljs-type {
  color: var(--syntax-type);
}
[data-theme='light'] .chat-panel .msg-text pre code .hljs-attr,
[data-theme='light'] .memory-drawer-md pre code .hljs-attr {
  color: var(--syntax-attr);
}
[data-theme='light'] .chat-panel .msg-text pre code .hljs-built_in,
[data-theme='light'] .memory-drawer-md pre code .hljs-built_in {
  color: var(--syntax-builtin);
}
[data-theme='light'] .chat-panel .msg-text pre code .hljs-literal,
[data-theme='light'] .memory-drawer-md pre code .hljs-literal {
  color: var(--syntax-number);
}
[data-theme='light'] .chat-panel .msg-text pre code .hljs-params,
[data-theme='light'] .memory-drawer-md pre code .hljs-params {
  color: var(--syntax-params);
}
[data-theme='light'] .chat-panel .msg-text pre code .hljs-property,
[data-theme='light'] .memory-drawer-md pre code .hljs-property {
  color: var(--syntax-attr);
}
[data-theme='light'] .chat-panel .msg-text pre code .hljs-punctuation,
[data-theme='light'] .memory-drawer-md pre code .hljs-punctuation {
  color: var(--syntax-punctuation);
}
[data-theme='light'] .chat-panel .msg-text pre code .hljs-regexp,
[data-theme='light'] .memory-drawer-md pre code .hljs-regexp {
  color: var(--syntax-builtin);
}
[data-theme='light'] .chat-panel .msg-text pre code .hljs-meta,
[data-theme='light'] .memory-drawer-md pre code .hljs-meta {
  color: var(--syntax-type);
}
[data-theme='light'] .chat-panel .msg-text pre code .hljs-selector-class,
[data-theme='light'] .memory-drawer-md pre code .hljs-selector-class {
  color: var(--syntax-string);
}

/* ─── Headings ──────────────────────────── */

.chat-panel .msg-text h1,
.chat-panel .msg-text h2,
.chat-panel .msg-text h3,
.chat-panel .msg-text h4,
.chat-panel .msg-text h5,
.chat-panel .msg-text h6,
.memory-drawer-md h1,
.memory-drawer-md h2,
.memory-drawer-md h3,
.memory-drawer-md h4,
.memory-drawer-md h5,
.memory-drawer-md h6 {
  margin: 0.8em 0 0.4em;
  font-weight: 600;
  line-height: 1.3;
  color: var(--text-primary);
}

.chat-panel .msg-text h1:first-child,
.chat-panel .msg-text h2:first-child,
.chat-panel .msg-text h3:first-child,
.memory-drawer-md h1:first-child,
.memory-drawer-md h2:first-child,
.memory-drawer-md h3:first-child {
  margin-top: 0;
}

.chat-panel .msg-text h1,
.memory-drawer-md h1 {
  font-size: 1.3em;
}
.chat-panel .msg-text h2,
.memory-drawer-md h2 {
  font-size: 1.15em;
}
.chat-panel .msg-text h3,
.memory-drawer-md h3 {
  font-size: 1.05em;
}

/* ─── Lists ─────────────────────────────── */

.chat-panel .msg-text ul,
.chat-panel .msg-text ol,
.memory-drawer-md ul,
.memory-drawer-md ol {
  margin: 4px 0;
  padding-left: 1.6em;
}

.chat-panel .msg-text li,
.memory-drawer-md li {
  margin: 2px 0;
}

.chat-panel .msg-text ul,
.memory-drawer-md ul {
  list-style: disc;
}
.chat-panel .msg-text ol,
.memory-drawer-md ol {
  list-style: decimal;
}

/* ─── Blockquote ────────────────────────── */

.chat-panel .msg-text blockquote,
.memory-drawer-md blockquote {
  margin: 6px 0;
  padding: 4px 0 4px 12px;
  border-left: 3px solid var(--accent-text);
  opacity: 0.85;
  color: var(--text-secondary);
}

.chat-panel .msg-text blockquote p,
.memory-drawer-md blockquote p {
  margin: 0;
}

/* ─── Horizontal rule ───────────────────── */

.chat-panel .msg-text hr,
.memory-drawer-md hr {
  border: none;
  border-top: 1px solid var(--border-default);
  margin: 12px 0;
}

/* ─── Task list (GFM) ──────────────────── */

.chat-panel .msg-text ul input[type='checkbox'],
.chat-panel .msg-text ol input[type='checkbox'],
.memory-drawer-md ul input[type='checkbox'],
.memory-drawer-md ol input[type='checkbox'] {
  appearance: none;
  -webkit-appearance: none;
  width: 15px;
  height: 15px;
  border: 1.5px solid var(--border-default);
  border-radius: 3px;
  background: transparent;
  margin-right: 6px;
  vertical-align: text-bottom;
  cursor: default;
  position: relative;
  flex-shrink: 0;
  transition: all var(--ease-out);
}

.chat-panel .msg-text ul input[type='checkbox']:checked,
.chat-panel .msg-text ol input[type='checkbox']:checked,
.memory-drawer-md ul input[type='checkbox']:checked,
.memory-drawer-md ol input[type='checkbox']:checked {
  background: var(--accent);
  border-color: var(--accent-text);
}

.chat-panel .msg-text ul input[type='checkbox']:checked::after,
.chat-panel .msg-text ol input[type='checkbox']:checked::after,
.memory-drawer-md ul input[type='checkbox']:checked::after,
.memory-drawer-md ol input[type='checkbox']:checked::after {
  content: '';
  position: absolute;
  left: 3.5px;
  top: 1px;
  width: 4px;
  height: 8px;
  border: solid var(--bg-deep);
  border-width: 0 1.5px 1.5px 0;
  transform: rotate(45deg);
}

.chat-panel .msg-text li:has(input[type='checkbox']:checked),
.memory-drawer-md li:has(input[type='checkbox']:checked) {
  text-decoration: line-through;
  opacity: 0.6;
}

/* Fix list items containing checkboxes */
.chat-panel .msg-text ul:has(input[type='checkbox']),
.chat-panel .msg-text ol:has(input[type='checkbox']),
.memory-drawer-md ul:has(input[type='checkbox']),
.memory-drawer-md ol:has(input[type='checkbox']) {
  list-style: none;
  padding-left: 0.4em;
}

/* ─── Keyboard / kbd ────────────────────── */

.chat-panel .msg-text kbd,
.memory-drawer-md kbd {
  display: inline-block;
  padding: 1px 6px;
  font-family: var(--font-mono);
  font-size: 0.82em;
  line-height: 1.4;
  color: var(--text-secondary);
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  box-shadow: 0 1px 0 var(--border-default);
}

/* ─── Definition Lists ──────────────────── */

.chat-panel .msg-text dl,
.memory-drawer-md dl {
  margin: 6px 0;
}

.chat-panel .msg-text dt,
.memory-drawer-md dt {
  font-weight: 600;
  color: var(--text-primary);
  margin-top: 6px;
}

.chat-panel .msg-text dd,
.memory-drawer-md dd {
  margin-left: 1.2em;
  color: var(--text-secondary);
  font-size: 0.95em;
}

/* ─── Abbreviation ──────────────────────── */

.chat-panel .msg-text abbr,
.memory-drawer-md abbr {
  text-decoration: underline dotted;
  text-underline-offset: 3px;
  cursor: help;
  color: var(--text-secondary);
}

/* ─── Superscript / Subscript ───────────── */

.chat-panel .msg-text sup,
.chat-panel .msg-text sub,
.memory-drawer-md sup,
.memory-drawer-md sub {
  font-size: 0.78em;
}

.chat-panel .msg-text sup,
.memory-drawer-md sup {
  vertical-align: super;
}

.chat-panel .msg-text sub,
.memory-drawer-md sub {
  vertical-align: sub;
}

/* ─── Images (if allowed in future) ─────── */

.chat-panel .msg-text img,
.memory-drawer-md img {
  max-width: 100%;
  height: auto;
  border-radius: var(--radius-sm);
  margin: 6px 0;
}

/* ─── Tables ────────────────────────────── */

.chat-panel .msg-text table,
.memory-drawer-md table {
  /* 表格溢出逃生通道：table-layout:fixed 使 width:100% 成为硬约束（table 布局下只是建议值，
     长单元格 min-content 会撑破气泡）；max-width 双保险。fixed 下超宽内容由
     overflow-wrap:anywhere 断行吸收；不可断内容（nowrap 内联块/pre）将刺出容器，
     如需滚动需外层包裹容器。
     不用 display:block——它把 table 降级为块级元素，td 失去表格布局语义按内容收缩、
     不拉伸填满，行分隔线右侧断裂出空白带（08-08 实测：表格右缘 x=868、行线只到 x=761）。
     overflow-y:hidden 防浏览器把 visible 强制计算为 auto 引入纵向滚动条；
     圆角裁剪仍由 non-visible overflow 提供。
     box-sizing:border-box 防 content-box 下 width:100% + border 1px 溢出 2px，
     触发自身 overflow-x:auto 产生右缘漂移 + 滚动区空白（13:21 实证）。 */
  table-layout: fixed;
  box-sizing: border-box;
  border-collapse: separate;
  border-spacing: 0;
  width: 100%;
  max-width: 100%;
  margin: 10px 0;
  font-size: 0.9em;
  border-radius: var(--radius-sm);
  overflow-x: auto;
  overflow-y: hidden;
  border: 1px solid var(--border-table);
}

.chat-panel .msg-text th,
.chat-panel .msg-text td,
.memory-drawer-md th,
.memory-drawer-md td {
  border-right: 1px solid var(--border-table);
  border-bottom: 1px solid var(--border-table);
  padding: 8px 12px;
  text-align: left;
  vertical-align: top;
  /* 单元格内长串（hash/路径/工具名）断行，减少对横向滚动的依赖 */
  overflow-wrap: anywhere;
}

.chat-panel .msg-text th:last-child,
.chat-panel .msg-text td:last-child,
.memory-drawer-md th:last-child,
.memory-drawer-md td:last-child {
  border-right: none;
}

.chat-panel .msg-text tr:last-child td,
.memory-drawer-md tr:last-child td {
  border-bottom: none;
}

.chat-panel .msg-text th[align='center'],
.chat-panel .msg-text td[align='center'],
.memory-drawer-md th[align='center'],
.memory-drawer-md td[align='center'] {
  text-align: center;
}

.chat-panel .msg-text th[align='right'],
.chat-panel .msg-text td[align='right'],
.memory-drawer-md th[align='right'],
.memory-drawer-md td[align='right'] {
  text-align: right;
}

.chat-panel .msg-text thead th,
.memory-drawer-md thead th {
  background: var(--bg-hover);
  font-weight: 600;
  color: var(--text-primary);
  font-size: 0.95em;
  border-bottom: 2px solid var(--border-focus);
}

.chat-panel .msg-text tbody tr:nth-child(even),
.memory-drawer-md tbody tr:nth-child(even) {
  background: rgba(127, 127, 127, 0.08);
}

.chat-panel .msg-text tbody tr:hover,
.memory-drawer-md tbody tr:hover {
  background: var(--accent-row-hover);
}

.chat-panel .msg-text tbody tr:first-child td,
.memory-drawer-md tbody tr:first-child td {
  padding-top: 10px;
}

/* ─── 消息渲染（历史 MessageItem + 流式气泡共用）─────────────────────────
   历史消息块已抽成 MessageItem.vue 子组件——scoped 样式不跨组件（子组件只有根元素
   继承父 scope id），故这一族规则改为全局 + `.chat-panel` 祖先前缀（与下方既有全局
   块的 .msg-text 规则同款约定）。前缀 + 同文件内保持原顺序 ⇒ 视觉零变化 */

/* Message */
.chat-panel .message {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding: 4px 0;
  align-items: flex-start;
}

/* Vue TransitionGroup: new messages fade in + slide up */
.chat-panel .msg-enter-active {
  transition:
    opacity 0.25s ease-out,
    transform 0.25s ease-out;
}

.chat-panel .msg-enter-from {
  opacity: 0;
  transform: translateY(6px);
}

.chat-panel .message.user {
  flex-direction: row-reverse;
}

.chat-panel .message.system {
  justify-content: center;
  padding: 8px 0;
}

/* ─── Message Grouping ──────────────────── */
.chat-panel .message.grouped {
  padding-top: 0;
}

.chat-panel .message.grouped .msg-bubble {
  margin-top: 0;
}

.chat-panel .msg-avatar {
  font-size: 28px;
  flex-shrink: 0;
  line-height: 1;
  margin-top: 2px;
  width: 28px;
  text-align: center;
}

.chat-panel .msg-avatar-hidden {
  visibility: hidden;
}

.chat-panel .msg-body {
  max-width: 65ch;
  min-width: 0;
}

.chat-panel .msg-sender {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent-text);
  margin-bottom: 4px;
  margin-left: 4px;
}

.chat-panel .msg-bubble {
  padding: 10px 14px;
  border-radius: var(--radius-lg);
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  position: relative;
}

.chat-panel .message.user .msg-bubble {
  background: var(--accent-msg-bg);
  border-color: var(--accent-msg-border);
  border-top-right-radius: 4px;
}

.chat-panel .message.agent .msg-bubble {
  border-top-left-radius: 4px;
}

.chat-panel .message.system .msg-bubble {
  background: transparent;
  border: none;
  box-shadow: none;
  font-size: 12px;
  color: var(--text-muted);
  font-style: italic;
}

/* ─── Message Time ──────────────────────── */
.chat-panel .msg-time {
  display: block;
  font-size: 10px;
  color: var(--text-muted);
  margin-top: 4px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.chat-panel .message.system .msg-time {
  text-align: center;
}

/* ─── Bubble Footer（模型 + 窗口用量 + 停止按钮）──── */
.chat-panel .msg-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 6px;
  /* 记忆行（.msg-memory-refs，flex-basis:100% + order:-1）独占第一行；
     模型/用量与时间仍在第二行两端对齐——加行不改既有两端的布局 */
  flex-wrap: wrap;
}

/* ─── 记忆引用行（M1）────────────────────────── */
.chat-panel .msg-memory-refs {
  flex-basis: 100%;
  order: -1;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  font-size: 10px;
  line-height: 1.6;
  color: var(--text-muted);
}

.chat-panel .msg-memory-refs .mem-icon {
  opacity: 0.75;
}

.chat-panel .msg-memory-refs .mem-count {
  font-variant-numeric: tabular-nums;
}

.chat-panel .msg-memory-refs .mem-sep {
  opacity: 0.45;
}

/* 条目 = 按钮而非 <a>：它开的是**站内抽屉**，不是链接（用 <a> 会带上浏览器的
   链接语义与默认样式，还得 preventDefault 拦导航）。 */
.chat-panel .msg-memory-refs .mem-link {
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  color: var(--accent-text);
  cursor: pointer;
  text-align: left;
  text-decoration: underline;
  text-underline-offset: 2px;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-panel .msg-memory-refs .mem-link:hover {
  opacity: 0.8;
}

/* 三态里「没注入」的两档弱化为纯文本：不点、不抢注意力，但仍占位可读 */
.chat-panel .msg-memory-refs .mem-muted {
  opacity: 0.7;
}

/* ─── 角标引用（R14b）──────────────────────────
   正文里的 `[n]`（猫采纳了第 n 节）渲染成上标角标；样式刻意**轻**——角标是
   正文的附属信息，读正文时不该被它打断。hover 才展开卡片。 */
.chat-panel .msg-text sup.mem-citation,
.memory-drawer-md sup.mem-citation {
  font-size: 0.68em;
  line-height: 0;
  vertical-align: super;
  color: var(--accent-text);
  background: var(--bg-hover);
  border-radius: var(--radius-sm);
  padding: 0 2px;
  margin-left: 1px;
  cursor: help;
  font-variant-numeric: tabular-nums;
}

/* hover 卡片：单浮层元素（`position: fixed` + 视口坐标，由 MessageItem 定位），
   内容 = 节标题 + 命中片开头。`pointer-events: none` —— 卡片本身不可交互，
   否则鼠标移出角标时会被卡片「接住」，mouseout 不触发、卡片关不掉 */
.chat-panel .mem-citation-card {
  position: fixed;
  z-index: 40;
  pointer-events: none;
  max-width: 340px;
  padding: 8px 10px;
  background: var(--bg-raised);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  font-size: 11px;
  line-height: 1.6;
}

.chat-panel .mem-citation-card .mem-card-title {
  color: var(--text-primary);
  font-weight: 600;
  margin-bottom: 2px;
}

/* 正文只露开头：`bodyHead` 是命中片**全文**（2026-09-22 起落全文），
   整段铺开会盖住半屏——限高 8 行，多出来的裁掉（卡片是提示，不是阅读器） */
.chat-panel .mem-citation-card .mem-card-body {
  color: var(--text-secondary);
  max-height: 8.5em;
  overflow: hidden;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* ─── 记忆抽屉（M1 形态乙）────────────────────── */
.memory-drawer-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.memory-drawer {
  display: flex;
  flex-direction: column;
  width: min(760px, 100%);
  max-height: 80vh;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  background: var(--bg-raised);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}

.memory-drawer-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-subtle);
}

.memory-drawer-title {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.memory-drawer-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  word-break: break-all;
}

.memory-drawer-anchor {
  font-size: 11px;
  color: var(--text-muted);
  word-break: break-all;
}

.memory-drawer-close {
  flex-shrink: 0;
  border: none;
  background: none;
  color: var(--text-muted);
  font-size: 14px;
  cursor: pointer;
  line-height: 1;
  padding: 2px 4px;
}

.memory-drawer-close:hover {
  color: var(--text-primary);
}

.memory-drawer-body {
  padding: 12px 16px 16px;
  overflow-y: auto;
}

.memory-drawer-caption {
  font-size: 11px;
  color: var(--text-muted);
  margin-bottom: 8px;
}

/* ─── 抽屉内 markdown（M3：`.memory-drawer-md` 是抽屉这个 markdown 落点）────────
   **本块只声明「尺度」**——基础字号及其派生的行高。票 §二.3 明写「抽屉罩局部样式、
   不裸继承正文气泡尺寸」，故基础字号不并入正文组（那是气泡的 16px）。
   其余**全部并入上方与正文并列的共享选择器组**：排版（标题层级 / 列表 / 引用 / 表格）
   与机制（行内 code 折行、代码块自滚、hljs token 色）都走同一份规则——共享组里的字号
   都是 em，随下面这个 font-size 自动缩一号；在抽屉里另写一份就是本仓反复吃过的
   「同一规则两处措辞」，改一处漏一处还全绿。落点组的机械守卫在 ChatPanel.test.ts。 */
.memory-drawer-snippet,
.memory-drawer-doc {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: 12.5px;
  line-height: 1.65;
  /* 容器是**块级**而不是 <pre>：`white-space: pre-wrap` 会把 marked 产出里标签之间的
     换行当可见空白渲染（每个块级元素之间多出一行空行）。故显式 normal——代码块的原样
     换行语义由块内 `pre` 自己声明（共享组的 `white-space: pre`）。 */
  white-space: normal;
  /* 裸长串（路径 / hash / 工具名）在段落里折行；`pre` 由共享组覆盖回 normal */
  overflow-wrap: anywhere;
}

.memory-drawer-doc {
  margin-top: 10px;
  max-height: 40vh;
  overflow-y: auto;
}

/* 容器自带 padding，首末块再叠一重 margin 会顶出一段空白。共享组只归零了
   `h1~h3:first-child` 与 `p:last-child`，表格 / 引用 / 分隔线没有——本条补全。 */
.memory-drawer-md > :first-child {
  margin-top: 0;
}
.memory-drawer-md > :last-child {
  margin-bottom: 0;
}

.memory-drawer-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  flex-wrap: wrap;
}

.memory-drawer-open {
  padding: 5px 12px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: all var(--ease-out);
}

.memory-drawer-open:hover:not(:disabled) {
  color: var(--accent-text);
  border-color: var(--accent-text);
}

.memory-drawer-open:disabled {
  opacity: 0.5;
  cursor: default;
}

.memory-drawer-hint {
  font-size: 11px;
  color: var(--text-muted);
}

.memory-drawer-error {
  margin-top: 10px;
  font-size: 12px;
  color: var(--accent-red);
}

.chat-panel .msg-footer .msg-time {
  margin-top: 0;
}

.chat-panel .msg-footer-right {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

/* 窗口用量：默认弱化色；超过告警线黄、超过交接线红（阈值来自配置） */
.chat-panel .msg-footer-info {
  font-size: 10px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
}

.chat-panel .msg-footer-info.warn {
  color: var(--accent-yellow);
  opacity: 1;
}

.chat-panel .msg-footer-info.critical {
  color: var(--accent-red);
  opacity: 1;
}

/* agent 回复耗时徽标（durationMs 随广播注入，瞬态不落库）——与模型/用量同视觉层级 */
.chat-panel .msg-duration {
  font-variant-numeric: tabular-nums;
}

/* 停止按钮：小号（AgentPanel btn-stop 同款），visibility 切换不改变布局 */
.chat-panel .btn-stop-agent {
  flex-shrink: 0;
  padding: 1px 8px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  font-size: 10px;
  font-family: inherit;
  cursor: pointer;
  transition: all var(--ease-out);
}

.chat-panel .btn-stop-agent:hover {
  border-color: var(--accent-red);
  color: var(--accent-red);
  background: rgba(224, 85, 106, 0.1);
}

/* streaming 气泡正在输出指示（弱化脉冲，与停止按钮同排） */
.chat-panel .streaming-indicator {
  font-size: 10px;
  color: var(--accent);
  opacity: 0.8;
  animation: streaming-blink 1.2s ease-in-out infinite;
  white-space: nowrap;
}

@keyframes streaming-blink {
  0%,
  100% {
    opacity: 0.45;
  }
  50% {
    opacity: 1;
  }
}

.chat-panel .msg-text {
  font-size: 16px;
  line-height: 1.65;
  color: var(--text-primary);
  /* 文本溢出逃生：长无断点串（URL/工具名/hash/路径）在普通段落中会撑破气泡——
     code 已有 word-break:break-all，但裸文本无任何断行处理（13:21 实证：40+ 字符
     工具名串溢出）。anywhere 允许在任意字符间断行（长串无自然断点）；pre 下显式
     覆盖回 normal（代码块走 overflow-x 滚动，不换行）。 */
  overflow-wrap: anywhere;
}

/* first/last paragraph margins */
.chat-panel .msg-text p,
.memory-drawer-md p {
  margin: 0 0 0.6em;
}

.chat-panel .msg-text p:last-child,
.memory-drawer-md p:last-child {
  margin-bottom: 0;
}

/* Typing */
.chat-panel .typing-cursor {
  font-size: 18px;
  color: var(--accent-text);
  animation: blink 1s step-end infinite;
  margin-top: 12px;
}

.chat-panel .typing-cursor.inline {
  margin-top: 4px;
  display: inline-block;
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}

/* ─── Streaming Message ──────────────────── */
.chat-panel .message.streaming .msg-bubble {
  border-style: dashed;
}

/* 占位气泡正文：思考动点（与流式思考折叠块 header 同款动点组件）。
   min-height 对齐一行正文，避免「空气泡只有 footer」的塌陷观感。 */
.chat-panel .placeholder-thinking {
  display: flex;
  align-items: center;
  min-height: 24px;
}

/* ─── Thinking Block (collapsible) ────────── */
.chat-panel .thinking-block {
  margin: 6px 0;
  border: 1px solid rgba(180, 160, 140, 0.3);
  border-radius: var(--radius-sm);
  background: rgba(180, 160, 140, 0.06);
  overflow: hidden;
  transition:
    border-color var(--ease-out),
    background var(--ease-out);
}

.chat-panel .thinking-block[open],
.chat-panel .thinking-block.open {
  border-color: rgba(180, 160, 140, 0.45);
  background: rgba(180, 160, 140, 0.1);
}

.chat-panel .thinking-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  cursor: pointer;
  user-select: none;
  font-size: 12px;
  color: var(--text-muted);
  transition:
    background var(--ease-in),
    color var(--ease-out);
  list-style: none; /* hide default <details> marker */
}

.chat-panel .thinking-summary::-webkit-details-marker {
  display: none;
}

.chat-panel .thinking-summary:hover {
  background: rgba(180, 160, 140, 0.1);
  color: var(--text-secondary);
}

.chat-panel .thinking-icon {
  font-size: 15px;
  line-height: 1;
}

.chat-panel .thinking-label {
  flex: 1;
  font-weight: 500;
}

/* Animated dots while streaming */
.chat-panel .thinking-dots {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  padding-bottom: 2px;
  margin-right: 6px;
}

.chat-panel .thinking-dots i {
  display: inline-block;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--accent);
  opacity: 0.5;
  animation: dotPulse 1.4s ease-in-out infinite;
}

.chat-panel .thinking-dots i:nth-child(2) {
  animation-delay: 0.2s;
}

.chat-panel .thinking-dots i:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes dotPulse {
  0%,
  80%,
  100% {
    opacity: 0.3;
    transform: scale(0.8);
  }
  40% {
    opacity: 1;
    transform: scale(1.2);
  }
}

.chat-panel .thinking-chevron {
  font-size: 10px;
  transition: transform var(--ease-out);
  opacity: 0.6;
}

.chat-panel .thinking-block[open] .thinking-chevron,
.chat-panel .thinking-block.open .thinking-chevron {
  transform: rotate(90deg);
}

.chat-panel .thinking-content {
  padding: 8px 12px 12px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary);
  border-top: 1px solid rgba(180, 160, 140, 0.18);
}

/* 修复列表序号被 overflow:hidden 裁剪的问题（历史 thinking-content + 流式 fold-thinking
   同源——两处都渲染 markdown 产出 ol/ul，容器 .thinking-block 均 overflow:hidden） */
.chat-panel .thinking-content ol,
.chat-panel .thinking-content ul,
.chat-panel .stream-fold-body .fold-thinking ol,
.chat-panel .stream-fold-body .fold-thinking ul {
  list-style-position: inside;
  padding-left: 0.4em;
}

/* ─── 思考框内嵌工具行（对齐用户「对外只露正文+思考框」）──────
   工具长在思考折叠块内部、与思考文本按时间序交错（流式由 typing.segments 有序性
   保证，工具嵌在实际发生位置；历史 thinkingContent blob 与 toolContent 两列交错序
   未存——顺序近似）。取消独立 tool-area 容器——thinking-block 是思考+工具唯一
   折叠容器。工具行保留冷色系蓝卡，在暖色思考块内作独立小卡与思考文本区分 */
.chat-panel .thinking-tool-hint {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-muted);
  opacity: 0.85;
}

/* 流式/历史折叠体共用的受控容器（流式 div.open / 历史 details 折叠体）：
   thinking 文本 + 工具行按时间序交错。基础布局两处共用 */
.chat-panel .stream-fold-body {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 2px 10px 10px;
  border-top: 1px solid rgba(180, 160, 140, 0.18);
  /* 横向兜底，不是主修：overflow-y 一旦不是 visible，未声明的 overflow-x 会被强制计算成
     auto —— 本容器天生就能出横条，有 1px 溢出就冒。主修是让代码块自己滚、行内 code 折行
     （见上方三组规则）。本行只是不让任何漏网内容把横条顶出来，不是「新增内容源免修」的
     金牌——新渲染路径仍须自证不溢出。本条落在 base 类上：流式/历史两个变体是同一个元素，
     无需各自再声明一遍。 */
  overflow-x: hidden;
}

/* flex column + 有界高度（max-height 使 height 固定）会让子项被 flex-shrink 压扁——
   `<details>` 工具行的 min-height:auto 对 flex 失效、被压缩到 ~2px 细线（"工具一条线"
   根因），点击区也消失。给直接子项 flex-shrink:0：内容超出时由容器 overflow 滚动、
   不再压缩子项——工具行回到完整卡片行（✓/✕ 状态 glyph + 名称 + 状态标签 + chevron）。
   流式路径的直接子项现在是 .stream-fold-inner（见下），故压缩防护同时落在包裹层与其
   子项两层上；历史路径（无包裹层）仍由本条直接兜住。 */
.chat-panel .stream-fold-body > * {
  flex-shrink: 0;
}

/* 思考框内跟进（stick-to-bottom）的观测对象：.stream-fold-body 的唯一子元素，高度随内容
   增长。不能观测 .stream-fold-body 自身——它 max-height:220px 固定，思考再长尺寸也不变，
   观测它等于没接。本层同时承接流式路径的条目布局（flex column + gap）；base 规则里的
   gap 对历史路径（不套本包裹层）仍是承重的，故不移除。 */
.chat-panel .stream-fold-inner {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.chat-panel .stream-fold-inner > * {
  flex-shrink: 0;
}

/* 高度上限只作用流式受控容器（.stream-fold .stream-fold-body）：
   思考再长在框内滚，不再撑爆气泡/拖累窗口滚动（6f8d27d4 调查病灶）。
   header（.thinking-summary）是容器外的兄弟，不受裁剪 */
.chat-panel .stream-fold .stream-fold-body {
  max-height: 220px;
  overflow-y: auto;
}

/* 点3：历史折叠体也有界（仅 .stored-thinking .stream-fold-body，专有后代选择器——
   不碰 .stream-fold-body 共享基础规则，避免重蹈 b12e858「共享 class 把历史也限高」的
   覆辙）。最终回复后折叠（.stored-thinking <details :open="false">）、展开仍 220px 框内滚，
   思考/中间叙述/工具在框内滚到达（用户拍板「有界就靠框内滚到达」）。 */
.chat-panel .stored-thinking .stream-fold-body {
  max-height: 220px;
  overflow-y: auto;
}

.chat-panel .stream-fold-body .fold-thinking {
  padding: 6px 2px 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary);
}

/* 历史 details 内思考文本与工具行之间的分隔 */
.chat-panel .stream-fold-body .tool-row,
.chat-panel .fold-tool-list .tool-row {
  margin-top: 2px;
}

/* 历史：思考块内工具行列表（思考文本后、同折叠块内）。
   分隔线走容器暖色系（与 .thinking-content/.stream-fold-body 一致），工具行卡片本体仍是冷色蓝卡 */
.chat-panel .fold-tool-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 12px 10px;
  border-top: 1px solid rgba(180, 160, 140, 0.18);
}

/* 消息气泡内渲染的图片 */
.chat-panel .msg-images {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}

.chat-panel .msg-image {
  max-width: 240px;
  max-height: 240px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
  cursor: pointer;
  transition: box-shadow var(--ease-out);
}

.chat-panel .msg-image:hover {
  box-shadow: var(--shadow-sm);
}

/* ─── Agent Status Indicators ──────────── */
.chat-panel .msg-agent-status {
  margin-top: 6px;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  font-size: 12px;
}

.chat-panel .agent-status-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
}

.chat-panel .status-emoji {
  font-size: 14px;
}

.chat-panel .status-avatar {
  font-size: 16px;
}

.chat-panel .status-name {
  color: var(--accent-text);
  font-weight: 500;
}

.chat-panel .status-label {
  color: var(--text-muted);
  font-size: 11px;
  margin-left: auto;
}

/* ─── Retract Button ───────────────────── */
.chat-panel .btn-retract {
  margin-top: 4px;
  padding: 2px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  transition: all var(--ease-out);
}

.chat-panel .btn-retract:hover {
  color: var(--accent-red);
  border-color: var(--accent-red);
}

.chat-panel .btn-retract-confirm {
  color: var(--accent-red) !important;
  border-color: var(--accent-red) !important;
  background: rgba(224, 85, 106, 0.1) !important;
  font-weight: 600;
}

/* ─── Restart Confirm Buttons ────────────── */
.chat-panel .restart-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.chat-panel .btn-restart {
  padding: 3px 14px;
  border: 1px solid var(--accent-text);
  border-radius: var(--radius-sm);
  background: rgba(92, 124, 250, 0.12);
  color: var(--accent-text);
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: all var(--ease-out);
}

.chat-panel .btn-restart:hover {
  background: var(--accent);
  color: var(--text-on-accent);
}

.chat-panel .btn-restart-cancel {
  border-color: var(--border-subtle);
  background: transparent;
  color: var(--text-muted);
  font-weight: 400;
}

.chat-panel .btn-restart-cancel:hover {
  border-color: var(--accent-red);
  color: var(--accent-red);
  background: rgba(224, 85, 106, 0.1);
}

.chat-panel .restart-label {
  font-size: 12px;
  color: var(--text-muted);
  animation: restart-pulse 1.6s ease-in-out infinite;
}

@keyframes restart-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}
</style>
