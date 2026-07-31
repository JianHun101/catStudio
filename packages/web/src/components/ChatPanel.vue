<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import type { Message } from '@cat-study/shared'
import { useChatStore } from '@/stores/chat'
import { useMention } from '@/composables/useMention'
import { useSkillCommand, type SkillSuggestion } from '@/composables/useSkillCommand'
import { useTheme } from '@/composables/useTheme'
import { renderMarkdown } from '@/utils/markdown'
import { parseThinkingBlocks } from '@/utils/thinking'
import { createLogger } from '@/utils/logger'

const log = createLogger('ChatPanel')

const props = defineProps<{
  leftSidebarOpen: boolean
  rightSidebarOpen: boolean
}>()

const emit = defineEmits<{
  toggleLeftSidebar: []
  toggleRightSidebar: []
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

const skills = ref<SkillSuggestion[]>([])
const {
  skillActive,
  skillSuggestions,
  skillIndex,
  skillStartIdx,
  detect: detectSkill,
  select: selectSkill,
  navigate: navigateSkill,
} = useSkillCommand(() => skills.value)

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

function fetchSkills(): void {
  const agentIds = store.activeSession?.agentIds
  const url = agentIds?.length ? `/api/skills?agentIds=${agentIds.join(',')}` : '/api/skills'
  fetch(url)
    .then((r) => r.json())
    .then((data) => {
      skills.value = data.skills ?? []
    })
    .catch(() => {
      /* 静默降级——下拉框为空 */
    })
}

onMounted(() => {
  chatContainer.value?.addEventListener('scroll', checkScrollPosition, { passive: true })
  window.addEventListener('keydown', onPreviewKeydown)
  fetchSkills()
})

// 切换会话时重新拉取技能列表（不同会话的 Agent 组合不同）
watch(
  () => store.activeSession?.id,
  () => {
    fetchSkills()
  }
)

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
  // / 技能下拉框键盘导航（优先级高于 @mention）
  if (skillActive.value) {
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

function selectSkillCmd(idx: number): void {
  const skill = skillSuggestions.value[idx]
  if (!skill || !textareaRef.value) return
  const newText = selectSkill(skill, input.value, textareaRef.value.selectionStart)
  input.value = newText
  nextTick(() => {
    if (textareaRef.value) {
      const pos = skillStartIdx.value + skill.name.length + 2
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

function statusLabelZh(status: string): string {
  switch (status) {
    case 'queued':
      return '已收到'
    case 'thinking':
      return '思考中'
    case 'replying':
      return '回复中'
    case 'done':
      return '完成'
    default:
      return status
  }
}
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

        <div class="broadcast-toggle" title="开启后 Agent 可以看到其他 Agent 的回复">
          <label class="toggle-label">
            <span class="toggle-text" :class="{ on: store.broadcastMode }">广播</span>
            <button
              class="toggle-switch"
              :class="{ on: store.broadcastMode }"
              @click="store.toggleBroadcast()"
              :aria-checked="store.broadcastMode"
              role="switch"
            >
              <span class="toggle-knob"></span>
            </button>
          </label>
        </div>

        <!-- 右侧栏折叠按钮 -->
        <button
          class="btn-sidebar-toggle"
          :title="props.rightSidebarOpen ? '收起 Agent 面板' : '展开 Agent 面板'"
          :aria-label="props.rightSidebarOpen ? '收起 Agent 面板' : '展开 Agent 面板'"
          @click="emit('toggleRightSidebar')"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <template v-if="props.rightSidebarOpen">
              <rect
                x="2"
                y="3"
                width="14"
                height="12"
                rx="1.5"
                stroke="currentColor"
                stroke-width="1.4"
              />
              <path d="M11 3v12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            </template>
            <template v-else>
              <rect
                x="2"
                y="3"
                width="14"
                height="12"
                rx="1.5"
                stroke="currentColor"
                stroke-width="1.4"
              />
            </template>
          </svg>
        </button>
      </div>
    </div>

    <!-- Messages -->
    <div ref="chatContainer" class="chat-messages-wrapper" @scroll.passive="checkScrollPosition">
      <div class="chat-messages-inner" aria-live="polite">
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
          <h3>欢迎来到 CatStudy</h3>
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
                    <div
                      class="thinking-content"
                      v-html="renderMarkdown(msg.thinkingContent.replace(/\[思考\]\s*/g, ''))"
                    ></div>
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
                  <div class="msg-text" v-html="renderMarkdown(msg.content)"></div>
                  <time class="msg-time" :datetime="msg.createdAt">{{
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
                  <span class="status-label">{{ statusLabelZh(s.status) }}</span>
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

        <!-- Streaming agent reply (live preview while agent is typing) -->
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
                  v-html="renderMarkdown(seg.content)"
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

        <!-- / 技能下拉框 -->
        <div v-if="skillActive && skillSuggestions.length > 0" class="skill-dropdown">
          <div
            v-for="(skill, idx) in skillSuggestions"
            :key="skill.name"
            class="skill-item"
            :class="{ active: idx === skillIndex }"
            @mousedown.prevent="selectSkillCmd(idx)"
            @mouseenter="skillIndex = idx"
          >
            <span class="skill-trigger">/{{ skill.name }}</span>
            <span class="skill-desc">{{ skill.description }}</span>
            <span class="skill-hint">tab</span>
          </div>
        </div>
        <div v-if="skillActive && skillSuggestions.length === 0" class="skill-dropdown skill-empty">
          <span>未找到匹配的技能</span>
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
      >
        <button class="lightbox-close" aria-label="关闭大图" @click="closePreview">✕</button>
        <button
          v-if="previewImages.length > 1"
          class="lightbox-nav lightbox-prev"
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
          class="lightbox-nav lightbox-next"
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

.btn-clear:disabled {
  opacity: 0.4;
  cursor: default;
}

/* ─── Broadcast Toggle ──────────────────── */

.broadcast-toggle {
  flex-shrink: 0;
}

.toggle-label {
  display: flex;
  align-items: center;
  gap: 8px;
}

.toggle-text {
  font-size: 12px;
  color: var(--text-muted);
  font-weight: 500;
  user-select: none;
  transition: color var(--ease-out);
}
.toggle-text.on {
  color: var(--accent);
}

.toggle-switch {
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
  background: rgba(212, 165, 116, 0.08);
  border-color: rgba(212, 165, 116, 0.15);
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

.chat-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(212, 165, 116, 0.25);
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
  cursor: zoom-out;
}

.lightbox-img {
  max-width: 92vw;
  max-height: 92vh;
  object-fit: contain;
  border-radius: var(--radius-md);
  cursor: default;
}

.lightbox-close,
.lightbox-nav {
  position: absolute;
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
  top: 16px;
  right: 16px;
  width: 40px;
  height: 40px;
  font-size: 18px;
}

.lightbox-nav {
  top: 50%;
  transform: translateY(-50%);
  width: 44px;
  height: 44px;
  font-size: 26px;
  line-height: 1;
}

.lightbox-prev {
  left: 16px;
}

.lightbox-next {
  right: 16px;
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

/* Skill Dropdown — 复用 mention-dropdown 布局，微调内容 */
.skill-dropdown {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  min-width: 260px;
  max-height: 240px;
  overflow-y: auto;
  background: var(--bg-raised);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  z-index: 100;
}

.skill-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  cursor: pointer;
  transition: background var(--ease-in);
}

.skill-item:first-child {
  border-radius: var(--radius-md) var(--radius-md) 0 0;
}

.skill-item:last-child {
  border-radius: 0 0 var(--radius-md) var(--radius-md);
}

.skill-item:hover,
.skill-item.active {
  background: var(--bg-hover);
}

.skill-trigger {
  font-size: 13px;
  font-weight: 600;
  color: var(--accent);
  white-space: nowrap;
  min-width: fit-content;
}

.skill-desc {
  font-size: 13px;
  color: var(--text-muted);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-hint {
  font-size: 10px;
  color: var(--text-muted);
  background: var(--bg-surface);
  padding: 2px 7px;
  border-radius: 4px;
  font-weight: 500;
}

.skill-empty {
  padding: 12px 14px;
  font-size: 13px;
  color: var(--text-muted);
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
  border-collapse: separate;
  border-spacing: 0;
  width: 100%;
  margin: 10px 0;
  font-size: 0.9em;
  border-radius: var(--radius-sm);
  overflow: hidden;
  border: 1px solid var(--border-table);
}

.chat-panel .msg-text th,
.chat-panel .msg-text td {
  border-right: 1px solid var(--border-table);
  border-bottom: 1px solid var(--border-table);
  padding: 8px 12px;
  text-align: left;
  vertical-align: top;
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
  background: rgba(212, 165, 116, 0.12);
}

.chat-panel .msg-text tbody tr:first-child td {
  padding-top: 10px;
}
</style>
