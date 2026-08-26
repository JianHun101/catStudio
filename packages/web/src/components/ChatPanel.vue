<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import type { Message } from '@cat-study/shared'
import { useChatStore } from '@/stores/chat'
import { useMention } from '@/composables/useMention'
import { useSkillCommand } from '@/composables/useSkillCommand'
import { useTheme } from '@/composables/useTheme'
import { renderMarkdown } from '@/utils/markdown'
import { parseThinkingBlocks } from '@/utils/thinking'
import { resolveDisplayPlaceholders } from '@/utils/rolePlaceholders'
import { createLogger } from '@/utils/logger'
import DiffViewer from './DiffViewer.vue'
import AgentStatusLabel from './AgentStatusLabel.vue'

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

const { skillActive, detect: detectSkill } = useSkillCommand()

// ─── Time Formatting ───────────────────────

/**
 * 将各种来源的时间戳统一转为浏览器可正确解析的 UTC 字符串。
 * - SQLite datetime('now') 格式 "YYYY-MM-DD HH:MM:SS"（无时区）→ 附加 Z
 * - 已含 Z / +HH:MM 时区的 ISO 字符串 → 原样返回
 * - 数字时间戳 → 转为 ISO 8601 UTC 字符串
 */
function normalizeDateTime(raw: string | number): string {
  if (typeof raw === 'number') return new Date(raw).toISOString()
  // 已有时区标记则原样返回
  if (/[Z+\-]\d{2}:\d{2}$/.test(raw) || raw.endsWith('Z')) return raw
  // SQLite 格式 "YYYY-MM-DD HH:MM:SS" → ISO 8601 UTC
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) {
    return raw.replace(' ', 'T') + 'Z'
  }
  return raw
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
const activeTypingStates = computed(() => {
  const filtered = new Map<string, { messageId: string; content: string; sessionId: string }>()
  const activeAgentIds = new Set(store.activeSession?.agentIds ?? [])
  store.typingStates.forEach((v, agentId) => {
    if (v.sessionId !== store.activeSessionId) return
    if (activeAgentIds.has(agentId)) filtered.set(agentId, v)
  })
  return filtered
})

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
watch(
  () => store.activeMessages.length,
  async () => {
    await nextTick()
    if (isAtBottom.value) {
      scrollToBottom()
    } else {
      newMessageCount.value++
      showScrollDown.value = true
    }
    sending.value = false
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

onMounted(() => {
  chatContainer.value?.addEventListener('scroll', checkScrollPosition, { passive: true })
  window.addEventListener('keydown', onPreviewKeydown)
})

onUnmounted(() => {
  chatContainer.value?.removeEventListener('scroll', checkScrollPosition)
  window.removeEventListener('keydown', onPreviewKeydown)
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

/** 预览打开时：Esc 关闭、←/→ 切换（多图） */
function onPreviewKeydown(e: KeyboardEvent): void {
  if (!previewVisible.value) return
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

// ─── Push approval helpers ────────────────

/**
 * push 审批按钮状态解析：默认 pending；pushing → 「推送中…」；done → 「已推送」；
 * failed → 恢复可点（服务端已回 toast）；cancelled/none → 隐藏。
 * 服务端权威状态由 PUSH_STATUS 事件驱动。
 */
function pushStateFor(
  msg: Message
): 'pending' | 'pushing' | 'done' | 'failed' | 'cancelled' | 'none' {
  if (msg.messageType !== 'push_request') return 'none'
  const st = store.pushStates.get(msg.id)
  if (st === 'pushing' || st === 'done' || st === 'failed' || st === 'cancelled' || st === 'none') {
    return st
  }
  return 'pending'
}

/** push 审批面板可点（pending/failed 可点；pushing/done/cancelled 不可点） */
function pushActionableFor(msg: Message): boolean {
  const st = pushStateFor(msg)
  return st === 'pending' || st === 'failed'
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
  try {
    await store.sendMessage(text, mentions, images)
    input.value = ''
    pastedImages.value = []
    mentionActive.value = false
    skillActive.value = false
    await nextTick()
    scrollToBottom()
  } finally {
    // Safety net: re-enable button after 10s if NEW_MESSAGE never arrives
    setTimeout(() => {
      if (sending.value) sending.value = false
    }, 10000)
  }
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

  if (e.key === 'Enter' && !e.shiftKey) {
    if (e.isComposing) return
    e.preventDefault()
    handleSend()
  }
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

function statusForMessage(msgId: string) {
  return store.messageStatus.get(msgId) || []
}

function isLatestUserMessage(msg: Message): boolean {
  if (msg.role !== 'user') return false
  const userMsgs = store.activeMessages.filter((m) => m.role === 'user')
  if (userMsgs.length === 0) return false
  return userMsgs[userMsgs.length - 1].id === msg.id
}

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

function statusEmoji(status: string): string {
  switch (status) {
    case 'queued':
      return '📨'
    case 'thinking':
      return '🤔'
    case 'replying':
      return '⌨️'
    case 'done':
      return '✅'
    default:
      return '⏳'
  }
}

// ─── renderMarkdown 记忆化（per-message）────────────────────────
// 防御放大器 2：即使还有「缓存命中满列表赋值 + SESSION_HISTORY 权威校正再赋值」两次
// 全量 render，未变消息的 markdown 也只算一次。renderMarkdown 是 CPU 密集（marked.parse
// + DOMPurify.sanitize），长会话每条消息几十 ms，秒级重渲里重复算未变消息是纯浪费。
// 键覆盖影响输出的输入：resolveDisplayPlaceholders(msg.content, store.agents) 依赖
// store/reviewer 角色的 agent 名（@架构师/@审查者 替换），故键含相关 agent 名——
// agent 改名会改变占位符替换结果，键变则缓存自然失效重算，不丢正确性。
const markdownCache = new Map<string, string>()

/** 影响 renderMarkdown 输出的 agent 名签名（占位符替换只读 store/reviewer 角色名） */
function markdownAgentNames(): string {
  const architect = store.agents.find((a) => a.role === 'store')?.name ?? ''
  const reviewer = store.agents.find((a) => a.role === 'reviewer')?.name ?? ''
  return `${architect}|${reviewer}`
}

/** 记忆化渲染正文：内容 + 相关 agent 名未变 → 直接返回缓存 html */
function renderMessageMarkdown(msg: Message): string {
  const key = `${msg.id}:${markdownAgentNames()}:${msg.content}`
  const cached = markdownCache.get(key)
  if (cached !== undefined) return cached
  const html = renderMarkdown(resolveDisplayPlaceholders(msg.content, store.agents))
  markdownCache.set(key, html)
  return html
}

/** 记忆化渲染思考内容：思考内容未变 → 直接返回缓存 html */
function renderThinkingMarkdown(msg: Message): string {
  const raw = msg.thinkingContent?.replace(/\[思考\]\s*/g, '') ?? ''
  const key = `${msg.id}:thinking:${raw}`
  const cached = markdownCache.get(key)
  if (cached !== undefined) return cached
  const html = renderMarkdown(raw)
  markdownCache.set(key, html)
  return html
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

/** 是否可停止：回复中（busy）或有排队任务（AGENT_INTERRUPT 一个按钮覆盖两场景） */
function canStopAgent(agentId: string): boolean {
  const state = store.agentStates.get(agentId)
  return state?.status === 'busy' || (state?.queueLength ?? 0) > 0
}

function stopAgent(agentId: string): void {
  store.interruptAgent(agentId)
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
          <template v-for="(msg, i) in store.activeMessages" :key="msg.id">
            <!-- Date separator (独立块级元素，不受 .message flex 影响) -->
            <div
              v-if="dateSepIndices.has(i)"
              class="date-separator"
              :key="`sep-${msg.id}`"
              :class="{ 'date-sep-system': msg.role === 'system' }"
            >
              <span>{{ formatDate(msg.createdAt) }}</span>
            </div>

            <div class="message" :class="[msg.role, { grouped: isGrouped(i) }]">
              <div v-if="!isGrouped(i)" class="msg-avatar">
                {{ avatarFor(msg.role, msg.agentId) }}
              </div>
              <div v-else class="msg-avatar msg-avatar-hidden">
                {{ avatarFor(msg.role, msg.agentId) }}
              </div>

              <div class="msg-body">
                <div v-if="msg.role === 'agent' && !isGrouped(i)" class="msg-sender">
                  {{ senderName(msg.agentId) }}
                </div>
                <div class="msg-bubble">
                  <details
                    v-if="msg.thinkingContent"
                    class="thinking-block stored-thinking"
                    :open="false"
                  >
                    <summary class="thinking-summary">
                      <span class="thinking-icon">🐾</span>
                      <span class="thinking-label">思考过程</span>
                      <span class="thinking-chevron">▶</span>
                    </summary>
                    <div class="thinking-content" v-html="renderThinkingMarkdown(msg)"></div>
                  </details>
                  <div v-if="msg.images && msg.images.length" class="msg-images">
                    <img
                      v-for="(src, i) in msg.images"
                      :key="i"
                      :src="src"
                      class="msg-image"
                      :alt="`图片${i + 1}`"
                      :title="`点击查看大图${msg.images.length > 1 ? `（${i + 1}/${msg.images.length}）` : ''}`"
                      @click="openPreview(msg.images, i)"
                    />
                  </div>
                  <div class="msg-text" v-html="renderMessageMarkdown(msg)"></div>
                  <!-- 对话内 diff 展示：extra.rich.blocks 存在才渲染（服务端采集附加，
                       永不进 LLM 上下文）；旧消息/无 extra → 纯文本回退与现网一致 -->
                  <DiffViewer
                    v-if="msg.extra?.rich?.blocks?.length"
                    :blocks="msg.extra.rich.blocks"
                  />
                  <!-- 重启确认按钮组：pending 显示 [确认重启][取消]（点击后 confirming 中显示「已确认，等待重启…」）；confirmed 显示「重启中…」；取消/过期/none 隐藏 -->
                  <div v-if="msg.messageType === 'restart_request'" class="restart-actions">
                    <template v-if="restartStateFor(msg) === 'pending'">
                      <span
                        v-if="store.confirmingRestartMessageId === msg.id"
                        class="restart-label"
                      >
                        已确认，等待重启…
                      </span>
                      <template v-else>
                        <button class="btn-restart" @click="store.confirmRestart(msg.id)">
                          确认重启
                        </button>
                        <button
                          class="btn-restart btn-restart-cancel"
                          @click="store.cancelRestart(msg.id)"
                        >
                          取消
                        </button>
                      </template>
                    </template>
                    <span v-else-if="restartStateFor(msg) === 'confirmed'" class="restart-label">
                      重启中…
                    </span>
                  </div>
                  <!-- push 审批面板：push_request 消息渲染（服务端实时采集 commits + diff，无手工塞入路径）——
                       V2 按钮：确认占主导（卡片大按钮）+ 取消并排；pushing 显示「推送中…」、done 显示「已推送」 -->
                  <div
                    v-if="msg.messageType === 'push_request' && pushStateFor(msg) !== 'none'"
                    class="push-approval"
                  >
                    <div class="push-head">收口待推送：<b>dev → origin/dev</b></div>
                    <div class="push-body">
                      <div v-if="msg.extra?.push?.commits?.length" class="commit-list">
                        <div v-for="c in msg.extra.push.commits" :key="c.sha" class="commit-item">
                          <span class="commit-hash">{{ c.sha.slice(0, 7) }}</span>
                          <span class="commit-subject">{{ c.subject }}</span>
                        </div>
                      </div>
                      <DiffViewer
                        v-if="msg.extra?.rich?.blocks?.length"
                        :blocks="msg.extra.rich.blocks"
                      />
                      <div class="push-actions">
                        <template v-if="pushStateFor(msg) === 'pushing'">
                          <span class="push-label">推送中…</span>
                        </template>
                        <template v-else-if="pushStateFor(msg) === 'done'">
                          <span class="push-label push-done">已推送</span>
                        </template>
                        <template v-else>
                          <span v-if="store.confirmingPushMessageId === msg.id" class="push-label">
                            推送中…
                          </span>
                          <template v-else>
                            <button
                              class="btn-push-confirm"
                              :disabled="!pushActionableFor(msg)"
                              @click="store.confirmPush(msg.id)"
                            >
                              <span class="push-meta">
                                <span class="push-target">dev → origin/dev</span>
                                <span class="push-count"
                                  >{{ msg.extra?.push?.commits?.length ?? 0 }} commits</span
                                >
                              </span>
                              <span class="push-cta">确认 Push</span>
                            </button>
                            <button class="btn-push-cancel" @click="store.cancelPush(msg.id)">
                              取消
                            </button>
                          </template>
                        </template>
                      </div>
                    </div>
                  </div>
                  <!-- 气泡 footer：agent 消息每条带 {模型} · {n}k/{m}k tokens——
                       分组消息同样渲染（用户要求同 agent 连续回复每条都有模型与用量）；
                       停止按钮不在此处（B2 重定位：streaming 气泡 / 用户消息状态行） -->
                  <div v-if="msg.role !== 'system'" class="msg-footer">
                    <span
                      v-if="msg.role === 'agent' && msg.agentId"
                      class="msg-footer-info"
                      :class="contextLevelFor(msg.agentId)"
                    >
                      {{ modelNameFor(msg.agentId) }} · {{ tokensTextFor(msg.agentId) }}
                    </span>
                    <span class="msg-footer-right">
                      <time class="msg-time" :datetime="msg.createdAt">{{
                        formatTime(msg.createdAt)
                      }}</time>
                    </span>
                  </div>
                  <time v-else class="msg-time" :datetime="msg.createdAt">{{
                    formatTime(msg.createdAt)
                  }}</time>
                </div>
              </div>

              <!-- Agent status indicators (on user messages) -->
              <div
                v-if="msg.role === 'user' && statusForMessage(msg.id).length > 0"
                class="msg-agent-status"
              >
                <div
                  v-for="s in statusForMessage(msg.id)"
                  :key="s.agentId"
                  class="agent-status-row"
                >
                  <span class="status-emoji">{{ statusEmoji(s.status) }}</span>
                  <span class="status-avatar">{{ s.agentAvatar }}</span>
                  <span class="status-name">{{ s.agentName }}</span>
                  <AgentStatusLabel :entry="s" />
                  <!-- 停止按钮（B2 重定位）：busy 但无流式内容时挂用户消息状态行承载——
                       streaming 中（typingStates 有该 agent）按钮在 streaming 气泡上；
                       边界明示：agent 被 agent 回复触发（广播模式）无用户消息状态行，
                       仅 streaming 气泡覆盖——窗口期短，不追求全覆盖 -->
                  <button
                    v-if="!store.typingStates.has(s.agentId) && canStopAgent(s.agentId)"
                    class="btn-stop-agent"
                    title="停止思考并清空队列"
                    aria-label="停止"
                    @click.stop="stopAgent(s.agentId)"
                  >
                    停止
                  </button>
                </div>
                <button
                  v-if="isLatestUserMessage(msg)"
                  class="btn-retract"
                  :class="{ 'btn-retract-confirm': retractConfirm === msg.id }"
                  :aria-label="retractConfirm === msg.id ? '确认撤回消息' : '撤回消息'"
                  @click="handleRetract(msg.id)"
                >
                  {{ retractConfirm === msg.id ? '确认撤回？' : '撤回' }}
                </button>
              </div>
            </div>
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
              <template v-for="(seg, si) in parseThinkingBlocks(typing.content)" :key="si">
                <div
                  v-if="seg.kind === 'text'"
                  class="msg-text"
                  v-html="renderMarkdown(resolveDisplayPlaceholders(seg.content, store.agents))"
                ></div>
                <details v-else class="thinking-block" :open="false">
                  <summary class="thinking-summary">
                    <span class="thinking-icon">🐾</span>
                    <span class="thinking-label">思考过程</span>
                    <span class="thinking-dots"><i></i><i></i><i></i></span>
                    <span class="thinking-chevron">▶</span>
                  </summary>
                  <div class="thinking-content" v-html="renderMarkdown(seg.content)"></div>
                </details>
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
                  <span class="streaming-indicator">回复中…</span>
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

        <!-- / 技能提示（SkillLoader 拆除后：skill 由 CLI 原生触发，服务端不再注入） -->
        <div v-if="skillActive" class="skill-tip">
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
  color: var(--accent);
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

/* ─── Agent Status Indicators ──────────── */

.msg-agent-status {
  margin-top: 6px;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  font-size: 12px;
}

.agent-status-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
}

.status-emoji {
  font-size: 14px;
}

.status-avatar {
  font-size: 16px;
}

.status-name {
  color: var(--accent);
  font-weight: 500;
}

.status-label {
  color: var(--text-muted);
  font-size: 11px;
  margin-left: auto;
}

/* ─── Retract Button ───────────────────── */

.btn-retract {
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

.btn-retract:hover {
  color: var(--accent-red);
  border-color: var(--accent-red);
}

.btn-retract-confirm {
  color: var(--accent-red) !important;
  border-color: var(--accent-red) !important;
  background: rgba(224, 85, 106, 0.1) !important;
  font-weight: 600;
}

/* ─── Restart Confirm Buttons ────────────── */

.restart-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

.btn-restart {
  padding: 3px 14px;
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  background: rgba(92, 124, 250, 0.12);
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: all var(--ease-out);
}

.btn-restart:hover {
  background: var(--accent);
  color: #fff;
}

.btn-restart-cancel {
  border-color: var(--border-subtle);
  background: transparent;
  color: var(--text-muted);
  font-weight: 400;
}

.btn-restart-cancel:hover {
  border-color: var(--accent-red);
  color: var(--accent-red);
  background: rgba(224, 85, 106, 0.1);
}

.restart-label {
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

/* ─── Push 审批面板（V2：确认卡片大按钮 + 强化取消）─── */

.push-approval {
  margin: 8px 0 2px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  overflow: hidden;
}

.push-head {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-subtle);
  font-size: 12px;
  color: var(--text-secondary);
}

.push-head b {
  color: var(--text-primary);
  font-weight: 600;
}

.push-body {
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.commit-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.commit-item {
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  color: var(--text-muted);
  padding: 4px 8px;
  background: var(--bg-hover);
  border-radius: var(--radius-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.commit-hash {
  color: var(--accent);
  flex-shrink: 0;
}

.commit-subject {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.push-actions {
  display: flex;
  align-items: stretch;
  gap: 8px;
}

.btn-push-confirm {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid var(--accent);
  border-radius: var(--radius-md);
  background: rgba(212, 165, 116, 0.12);
  cursor: pointer;
  transition: all var(--ease-out);
  font-family: inherit;
}

.btn-push-confirm:hover:not(:disabled) {
  background: var(--accent);
  border-color: var(--accent);
  box-shadow: 0 2px 14px rgba(212, 165, 116, 0.35);
  transform: translateY(-1px);
}

.btn-push-confirm:disabled {
  opacity: 0.5;
  cursor: default;
}

.push-meta {
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.push-target {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.push-count {
  font-size: 11px;
  color: var(--text-muted);
}

.btn-push-confirm:hover:not(:disabled) .push-target,
.btn-push-confirm:hover:not(:disabled) .push-count,
.btn-push-confirm:hover:not(:disabled) .push-cta {
  color: #1b1815;
}

.push-cta {
  font-size: 13px;
  font-weight: 700;
  color: var(--accent);
  white-space: nowrap;
}

.btn-push-cancel {
  flex: 0 0 auto;
  min-width: 92px;
  padding: 12px 28px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  transition: all var(--ease-out);
}

.btn-push-cancel:hover {
  background: var(--accent-red);
  border-color: var(--accent-red);
  color: #fff;
  box-shadow: 0 2px 14px rgba(224, 85, 106, 0.45);
  transform: translateY(-1px);
}

.btn-push-cancel:active,
.btn-push-confirm:active {
  transform: translateY(0);
  box-shadow: none;
}

.push-label {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 10px 14px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-muted);
  animation: restart-pulse 1.6s ease-in-out infinite;
}

.push-label.push-done {
  color: var(--accent-green);
  animation: none;
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

/* Message */
.message {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding: 4px 0;
  align-items: flex-start;
}

/* Vue TransitionGroup: new messages fade in + slide up */
.msg-enter-active {
  transition:
    opacity 0.25s ease-out,
    transform 0.25s ease-out;
}

.msg-enter-from {
  opacity: 0;
  transform: translateY(6px);
}

.message.user {
  flex-direction: row-reverse;
}

.message.system {
  justify-content: center;
  padding: 8px 0;
}

/* ─── Message Grouping ──────────────────── */

.message.grouped {
  padding-top: 0;
}

.message.grouped .msg-bubble {
  margin-top: 0;
}

.msg-avatar {
  font-size: 28px;
  flex-shrink: 0;
  line-height: 1;
  margin-top: 2px;
  width: 28px;
  text-align: center;
}

.msg-avatar-hidden {
  visibility: hidden;
}

.msg-body {
  max-width: 65ch;
  min-width: 0;
}

.msg-sender {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  margin-bottom: 4px;
  margin-left: 4px;
}

.msg-bubble {
  padding: 10px 14px;
  border-radius: var(--radius-lg);
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  position: relative;
}

.message.user .msg-bubble {
  background: var(--accent-msg-bg);
  border-color: var(--accent-msg-border);
  border-top-right-radius: 4px;
}

.message.agent .msg-bubble {
  border-top-left-radius: 4px;
}

.message.system .msg-bubble {
  background: transparent;
  border: none;
  box-shadow: none;
  font-size: 12px;
  color: var(--text-muted);
  font-style: italic;
}

/* ─── Message Time ──────────────────────── */

.msg-time {
  display: block;
  font-size: 10px;
  color: var(--text-muted);
  opacity: 0.6;
  margin-top: 4px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.message.system .msg-time {
  text-align: center;
}

/* ─── Bubble Footer（模型 + 窗口用量 + 停止按钮）──── */

.msg-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 6px;
}

.msg-footer .msg-time {
  margin-top: 0;
}

.msg-footer-right {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

/* 窗口用量：默认弱化色；超过告警线黄、超过交接线红（阈值来自配置） */
.msg-footer-info {
  font-size: 10px;
  color: var(--text-muted);
  opacity: 0.75;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
}

.msg-footer-info.warn {
  color: var(--accent-yellow);
  opacity: 1;
}

.msg-footer-info.critical {
  color: var(--accent-red);
  opacity: 1;
}

/* 停止按钮：小号（AgentPanel btn-stop 同款），visibility 切换不改变布局 */
.btn-stop-agent {
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

.btn-stop-agent:hover {
  border-color: var(--accent-red);
  color: var(--accent-red);
  background: rgba(224, 85, 106, 0.1);
}

/* streaming 气泡正在输出指示（弱化脉冲，与停止按钮同排） */
.streaming-indicator {
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

.msg-text {
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
.msg-text :deep(p) {
  margin: 0 0 0.6em;
}
.msg-text :deep(p:last-child) {
  margin-bottom: 0;
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
  color: var(--accent);
  border-color: var(--accent);
  background: var(--bg-surface);
  box-shadow: var(--shadow-lg);
}

/* Typing */
.typing-cursor {
  font-size: 18px;
  color: var(--accent);
  animation: blink 1s step-end infinite;
  margin-top: 12px;
}
.typing-cursor.inline {
  margin-top: 4px;
  display: inline-block;
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}

/* ─── Streaming Message ──────────────────── */

.message.streaming .msg-bubble {
  border-style: dashed;
  opacity: 0.92;
}

/* ─── Thinking Block (collapsible) ────────── */

.thinking-block {
  margin: 6px 0;
  border: 1px solid rgba(180, 160, 140, 0.3);
  border-radius: var(--radius-sm);
  background: rgba(180, 160, 140, 0.06);
  overflow: hidden;
  transition:
    border-color var(--ease-out),
    background var(--ease-out);
}

.thinking-block[open] {
  border-color: rgba(180, 160, 140, 0.45);
  background: rgba(180, 160, 140, 0.1);
}

.thinking-summary {
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
.thinking-summary::-webkit-details-marker {
  display: none;
}

.thinking-summary:hover {
  background: rgba(180, 160, 140, 0.1);
  color: var(--text-secondary);
}

.thinking-icon {
  font-size: 15px;
  line-height: 1;
}

.thinking-label {
  flex: 1;
  font-weight: 500;
}

/* Animated dots while streaming */
.thinking-dots {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  padding-bottom: 2px;
  margin-right: 6px;
}
.thinking-dots i {
  display: inline-block;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--accent);
  opacity: 0.5;
  animation: dotPulse 1.4s ease-in-out infinite;
}
.thinking-dots i:nth-child(2) {
  animation-delay: 0.2s;
}
.thinking-dots i:nth-child(3) {
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

.thinking-chevron {
  font-size: 10px;
  transition: transform var(--ease-out);
  opacity: 0.6;
}

.thinking-block[open] .thinking-chevron {
  transform: rotate(90deg);
}

.thinking-content {
  padding: 8px 12px 12px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary);
  border-top: 1px solid rgba(180, 160, 140, 0.18);
}

/* 修复列表序号被 overflow:hidden 裁剪的问题 */
.thinking-content :deep(ol),
.thinking-content :deep(ul) {
  list-style-position: inside;
  padding-left: 0.4em;
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
  color: var(--text-muted);
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

/* 消息气泡内渲染的图片 */
.msg-images {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}

.msg-image {
  max-width: 240px;
  max-height: 240px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-subtle);
  cursor: pointer;
  transition: box-shadow var(--ease-out);
}

.msg-image:hover {
  box-shadow: var(--shadow-sm);
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
  color: var(--accent);
  border-color: var(--accent);
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

/* Skill 提示框（CLI 原生触发说明，不再有补全列表） */
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
  color: var(--bg-deep);
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
.chat-panel .msg-text b {
  font-weight: 600;
  color: var(--text-primary);
}

.chat-panel .msg-text em,
.chat-panel .msg-text i {
  font-style: italic;
}

.chat-panel .msg-text del,
.chat-panel .msg-text s {
  text-decoration: line-through;
  opacity: 0.7;
}

.chat-panel .msg-text a {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.chat-panel .msg-text a:hover {
  opacity: 0.8;
}

/* ─── Inline code ───────────────────────── */

.chat-panel .msg-text code {
  font-family: 'Cascadia Code', 'Fira Code', 'Consolas', 'Monaco', monospace;
  font-size: 0.9em;
  background: rgba(127, 127, 127, 0.12);
  padding: 1px 5px;
  border-radius: 4px;
  word-break: break-all;
}

/* ─── Code blocks ───────────────────────── */

.chat-panel .msg-text pre {
  background: var(--syntax-bg);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  padding: 12px 14px;
  overflow-x: auto;
  margin: 8px 0;
  /* 覆盖 .msg-text 的 overflow-wrap:anywhere——代码块保持原样换行语义，长行走横向滚动 */
  overflow-wrap: normal;
}

.chat-panel .msg-text pre code {
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

.chat-panel .msg-text pre code .hljs-keyword {
  color: var(--syntax-keyword);
}
.chat-panel .msg-text pre code .hljs-string {
  color: var(--syntax-string);
}
.chat-panel .msg-text pre code .hljs-number {
  color: var(--syntax-number);
}
.chat-panel .msg-text pre code .hljs-comment {
  color: var(--syntax-comment);
  font-style: italic;
}
.chat-panel .msg-text pre code .hljs-function {
  color: var(--syntax-function);
}
.chat-panel .msg-text pre code .hljs-title {
  color: var(--syntax-function);
}
.chat-panel .msg-text pre code .hljs-type {
  color: var(--syntax-type);
}
.chat-panel .msg-text pre code .hljs-attr {
  color: var(--syntax-attr);
}
.chat-panel .msg-text pre code .hljs-built_in {
  color: var(--syntax-builtin);
}
.chat-panel .msg-text pre code .hljs-literal {
  color: var(--syntax-number);
}
.chat-panel .msg-text pre code .hljs-params {
  color: var(--syntax-params);
}
.chat-panel .msg-text pre code .hljs-property {
  color: var(--syntax-attr);
}
.chat-panel .msg-text pre code .hljs-punctuation {
  color: var(--syntax-punctuation);
}
.chat-panel .msg-text pre code .hljs-regexp {
  color: var(--syntax-builtin);
}
.chat-panel .msg-text pre code .hljs-meta {
  color: var(--syntax-type);
}
.chat-panel .msg-text pre code .hljs-selector-class {
  color: var(--syntax-string);
}

/* ─── Code blocks — light theme overrides ─── */

[data-theme='light'] .chat-panel .msg-text pre {
  background: var(--syntax-bg);
  border-color: rgba(0, 0, 0, 0.08);
}

[data-theme='light'] .chat-panel .msg-text pre code {
  color: var(--syntax-text);
}

[data-theme='light'] .chat-panel .msg-text pre code .hljs-keyword {
  color: var(--syntax-keyword);
}
[data-theme='light'] .chat-panel .msg-text pre code .hljs-string {
  color: var(--syntax-string);
}
[data-theme='light'] .chat-panel .msg-text pre code .hljs-number {
  color: var(--syntax-number);
}
[data-theme='light'] .chat-panel .msg-text pre code .hljs-comment {
  color: var(--syntax-comment);
}
[data-theme='light'] .chat-panel .msg-text pre code .hljs-function,
[data-theme='light'] .chat-panel .msg-text pre code .hljs-title {
  color: var(--syntax-function);
}
[data-theme='light'] .chat-panel .msg-text pre code .hljs-type {
  color: var(--syntax-type);
}
[data-theme='light'] .chat-panel .msg-text pre code .hljs-attr {
  color: var(--syntax-attr);
}
[data-theme='light'] .chat-panel .msg-text pre code .hljs-built_in {
  color: var(--syntax-builtin);
}
[data-theme='light'] .chat-panel .msg-text pre code .hljs-literal {
  color: var(--syntax-number);
}
[data-theme='light'] .chat-panel .msg-text pre code .hljs-params {
  color: var(--syntax-params);
}
[data-theme='light'] .chat-panel .msg-text pre code .hljs-property {
  color: var(--syntax-attr);
}
[data-theme='light'] .chat-panel .msg-text pre code .hljs-punctuation {
  color: var(--syntax-punctuation);
}
[data-theme='light'] .chat-panel .msg-text pre code .hljs-regexp {
  color: var(--syntax-builtin);
}
[data-theme='light'] .chat-panel .msg-text pre code .hljs-meta {
  color: var(--syntax-type);
}
[data-theme='light'] .chat-panel .msg-text pre code .hljs-selector-class {
  color: var(--syntax-string);
}

/* ─── Headings ──────────────────────────── */

.chat-panel .msg-text h1,
.chat-panel .msg-text h2,
.chat-panel .msg-text h3,
.chat-panel .msg-text h4,
.chat-panel .msg-text h5,
.chat-panel .msg-text h6 {
  margin: 0.8em 0 0.4em;
  font-weight: 600;
  line-height: 1.3;
  color: var(--text-primary);
}

.chat-panel .msg-text h1:first-child,
.chat-panel .msg-text h2:first-child,
.chat-panel .msg-text h3:first-child {
  margin-top: 0;
}

.chat-panel .msg-text h1 {
  font-size: 1.3em;
}
.chat-panel .msg-text h2 {
  font-size: 1.15em;
}
.chat-panel .msg-text h3 {
  font-size: 1.05em;
}

/* ─── Lists ─────────────────────────────── */

.chat-panel .msg-text ul,
.chat-panel .msg-text ol {
  margin: 4px 0;
  padding-left: 1.6em;
}

.chat-panel .msg-text li {
  margin: 2px 0;
}

.chat-panel .msg-text ul {
  list-style: disc;
}
.chat-panel .msg-text ol {
  list-style: decimal;
}

/* ─── Blockquote ────────────────────────── */

.chat-panel .msg-text blockquote {
  margin: 6px 0;
  padding: 4px 0 4px 12px;
  border-left: 3px solid var(--accent);
  opacity: 0.85;
  color: var(--text-secondary);
}

.chat-panel .msg-text blockquote p {
  margin: 0;
}

/* ─── Horizontal rule ───────────────────── */

.chat-panel .msg-text hr {
  border: none;
  border-top: 1px solid var(--border-default);
  margin: 12px 0;
}

/* ─── Task list (GFM) ──────────────────── */

.chat-panel .msg-text ul input[type='checkbox'],
.chat-panel .msg-text ol input[type='checkbox'] {
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
.chat-panel .msg-text ol input[type='checkbox']:checked {
  background: var(--accent);
  border-color: var(--accent);
}

.chat-panel .msg-text ul input[type='checkbox']:checked::after,
.chat-panel .msg-text ol input[type='checkbox']:checked::after {
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

.chat-panel .msg-text li:has(input[type='checkbox']:checked) {
  text-decoration: line-through;
  opacity: 0.6;
}

/* Fix list items containing checkboxes */
.chat-panel .msg-text ul:has(input[type='checkbox']),
.chat-panel .msg-text ol:has(input[type='checkbox']) {
  list-style: none;
  padding-left: 0.4em;
}

/* ─── Keyboard / kbd ────────────────────── */

.chat-panel .msg-text kbd {
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

.chat-panel .msg-text dl {
  margin: 6px 0;
}

.chat-panel .msg-text dt {
  font-weight: 600;
  color: var(--text-primary);
  margin-top: 6px;
}

.chat-panel .msg-text dd {
  margin-left: 1.2em;
  color: var(--text-secondary);
  font-size: 0.95em;
}

/* ─── Abbreviation ──────────────────────── */

.chat-panel .msg-text abbr {
  text-decoration: underline dotted;
  text-underline-offset: 3px;
  cursor: help;
  color: var(--text-secondary);
}

/* ─── Superscript / Subscript ───────────── */

.chat-panel .msg-text sup,
.chat-panel .msg-text sub {
  font-size: 0.78em;
}

.chat-panel .msg-text sup {
  vertical-align: super;
}

.chat-panel .msg-text sub {
  vertical-align: sub;
}

/* ─── Images (if allowed in future) ─────── */

.chat-panel .msg-text img {
  max-width: 100%;
  height: auto;
  border-radius: var(--radius-sm);
  margin: 6px 0;
}

/* ─── Tables ────────────────────────────── */

.chat-panel .msg-text table {
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
.chat-panel .msg-text td {
  border-right: 1px solid var(--border-table);
  border-bottom: 1px solid var(--border-table);
  padding: 8px 12px;
  text-align: left;
  vertical-align: top;
  /* 单元格内长串（hash/路径/工具名）断行，减少对横向滚动的依赖 */
  overflow-wrap: anywhere;
}

.chat-panel .msg-text th:last-child,
.chat-panel .msg-text td:last-child {
  border-right: none;
}

.chat-panel .msg-text tr:last-child td {
  border-bottom: none;
}

.chat-panel .msg-text th[align='center'],
.chat-panel .msg-text td[align='center'] {
  text-align: center;
}

.chat-panel .msg-text th[align='right'],
.chat-panel .msg-text td[align='right'] {
  text-align: right;
}

.chat-panel .msg-text thead th {
  background: var(--bg-hover);
  font-weight: 600;
  color: var(--text-primary);
  font-size: 0.95em;
  border-bottom: 2px solid var(--border-focus);
}

.chat-panel .msg-text tbody tr:nth-child(even) {
  background: rgba(127, 127, 127, 0.08);
}

.chat-panel .msg-text tbody tr:hover {
  background: var(--accent-row-hover);
}

.chat-panel .msg-text tbody tr:first-child td {
  padding-top: 10px;
}
</style>
