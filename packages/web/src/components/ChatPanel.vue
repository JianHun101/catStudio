<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import type { Message } from '@cat-study/shared'
import { useChatStore } from '@/stores/chat'
import { useMention } from '@/composables/useMention'
import { renderMarkdown } from '@/utils/markdown'
import { parseThinkingBlocks } from '@/utils/thinking'

const store = useChatStore()
const input = ref('')
const chatContainer = ref<HTMLDivElement>()
const textareaRef = ref<HTMLTextAreaElement>()
const clearingMessages = ref(false)
const clearConfirm = ref(false) // 两步确认：第一次点变红，第二次执行
const retractConfirm = ref<string | null>(null) // 撤回确认：存 messageId

const { mentionActive, mentionSuggestions, mentionIndex, detect, select, navigate } =
  useMention(() => store.agents)

async function handleClearMessages(): Promise<void> {
  if (!store.activeSessionId) return
  // 两步确认
  if (!clearConfirm.value) {
    clearConfirm.value = true
    // 3 秒后自动重置
    setTimeout(() => { clearConfirm.value = false }, 3000)
    return
  }
  clearingMessages.value = true
  try {
    await store.clearSessionMessages(store.activeSessionId)
    clearConfirm.value = false
  } catch (err) {
    console.error('[ChatPanel] clear messages failed:', err)
  } finally {
    clearingMessages.value = false
  }
}

// Auto-scroll on new messages
watch(
  () => store.activeMessages.length,
  async () => {
    await nextTick()
    if (chatContainer.value) {
      chatContainer.value.scrollTop = chatContainer.value.scrollHeight
    }
  },
)

function onInput(e: Event): void {
  const ta = e.target as HTMLTextAreaElement
  detect(ta.value, ta.selectionStart)
}

function handleSend(): void {
  const text = input.value.trim()
  if (!text) return

  const mentionRegex = /@(\S+)/g
  const mentions: string[] = []
  let match: RegExpExecArray | null
  while ((match = mentionRegex.exec(text)) !== null) {
    mentions.push(match[1])
  }

  store.sendMessage(text, mentions)
  input.value = ''
  mentionActive.value = false
}

function onKeydown(e: KeyboardEvent): void {
  if (mentionActive.value) {
    if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
      e.preventDefault()
      const ta = textareaRef.value
      if (!ta) return
      const result = navigate(e.key, ta.value, ta.selectionStart)
      if (result !== null) {
        input.value = result
        nextTick(() => {
          ta.selectionStart = ta.selectionEnd = mentionStartIdx() + result.length - input.value.length + ta.value.length
        })
      }
      return
    }
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSend()
  }
}

function mentionStartIdx(): number {
  const text = input.value
  const cursor = textareaRef.value?.selectionStart || text.length
  for (let i = cursor - 1; i >= 0; i--) {
    if (text[i] === '@' && (i === 0 || /\s/.test(text[i - 1]))) {
      return i
    }
    if (/\s/.test(text[i])) break
  }
  return -1
}

function selectMention(idx: number): void {
  const agent = mentionSuggestions.value[idx]
  if (!agent || !textareaRef.value) return
  const newText = select(agent, input.value, textareaRef.value.selectionStart)
  input.value = newText
  nextTick(() => {
    if (textareaRef.value) {
      const pos = input.value.indexOf(`@${agent.name} `) + agent.name.length + 2
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

/** 获取某条消息的 Agent 执行状态列表 */
function statusForMessage(msgId: string) {
  return store.messageStatus.get(msgId) || []
}

/** 是否是当前 session 中最新一条用户消息 */
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
    setTimeout(() => { retractConfirm.value = null }, 3000)
    return
  }
  retractConfirm.value = null
  await store.retractMessage(store.activeSessionId, msgId)
}

function statusEmoji(status: string): string {
  switch (status) {
    case 'queued': return '📨'
    case 'thinking': return '🤔'
    case 'replying': return '⌨️'
    case 'done': return '✅'
    default: return '⏳'
  }
}

function statusLabelZh(status: string): string {
  switch (status) {
    case 'queued': return '已收到'
    case 'thinking': return '思考中'
    case 'replying': return '回复中'
    case 'done': return '完成'
    default: return status
  }
}

</script>

<template>
  <div class="chat-panel">
    <!-- Header -->
    <div class="chat-header">
      <div class="chat-header-left">
        <h2 v-if="store.activeSession">{{ store.activeSession.title }}</h2>
        <span v-else class="placeholder">选择会话开始聊天</span>
        <!-- 连接状态指示器 -->
        <span class="connection-dot" :class="{ online: store.serverOnline }" :title="store.serverOnline ? '已连接' : '连接断开'"></span>
      </div>

      <div v-if="store.activeSessionId" class="chat-header-actions">
        <button
          class="btn-clear"
          :class="{ 'btn-clear-confirm': clearConfirm }"
          title="清空所有消息"
          :disabled="clearingMessages"
          @click="handleClearMessages"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M2 4h12M5.5 4V2.5h5V4M6.5 7v5M9.5 7v5M3.5 4l.7 9.1a1 1 0 001 .9h5.6a1 1 0 001-.9l.7-9.1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
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
      </div>
    </div>

    <!-- Messages -->
    <div ref="chatContainer" class="chat-messages">
      <div v-if="!store.activeSessionId" class="empty-state">
        <div class="empty-icon">🐱</div>
        <h3>欢迎来到 CatStudy</h3>
        <p v-if="store.sessions.length > 0">从左侧选择一个会话开始聊天</p>
        <p v-else>点击左下角按钮创建一个新会话</p>
        <p class="empty-hint">在消息中使用 @猫咪名字 来指定谁来回复</p>
      </div>

      <TransitionGroup name="msg">
        <div
          v-for="msg in store.activeMessages"
          :key="msg.id"
          class="message"
          :class="msg.role"
        >
          <div class="msg-avatar">{{ avatarFor(msg.role, msg.agentId) }}</div>
          <div class="msg-body">
            <div v-if="msg.role === 'agent'" class="msg-sender">{{ senderName(msg.agentId) }}</div>
            <div class="msg-bubble">
              <div class="msg-text" v-html="renderMarkdown(msg.content)"></div>
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
            <!-- Retract button (only on latest user message) -->
            <button
              v-if="isLatestUserMessage(msg)"
              class="btn-retract"
              :class="{ 'btn-retract-confirm': retractConfirm === msg.id }"
              @click="handleRetract(msg.id)"
            >
              {{ retractConfirm === msg.id ? '确认撤回？' : '撤回' }}
            </button>
          </div>

        </div>
      </TransitionGroup>

      <!-- Streaming agent reply (live preview while agent is typing) -->
      <div
        v-for="[agentId, typing] in store.typingStates"
        :key="'streaming-' + agentId"
        class="message agent streaming"
      >
        <div class="msg-avatar">{{ avatarFor('agent', agentId) }}</div>
        <div class="msg-body">
          <div class="msg-sender">{{ senderName(agentId) }}</div>
          <div class="msg-bubble">
            <!-- 文本段：正常渲染 markdown -->
            <template v-for="(seg, si) in parseThinkingBlocks(typing.content)" :key="si">
              <div v-if="seg.kind === 'text'" class="msg-text" v-html="renderMarkdown(seg.content)"></div>
              <!-- 思考段：折叠展示 -->
              <details v-else class="thinking-block" :open="false">
                <summary class="thinking-summary">
                  <span class="thinking-icon">💭</span>
                  <span class="thinking-label">思考过程</span>
                  <span class="thinking-chevron">▶</span>
                </summary>
                <div class="thinking-content" v-html="renderMarkdown(seg.content)"></div>
              </details>
            </template>
            <span class="typing-cursor inline">|</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Input -->
    <div class="chat-input-area">
      <div class="input-wrapper">
        <textarea
          ref="textareaRef"
          v-model="input"
          class="chat-input"
          :placeholder="store.activeSessionId ? '输入消息… @猫咪名 来提及' : '请先选择会话'"
          :disabled="!store.activeSessionId"
          rows="2"
          @input="onInput"
          @keydown="onKeydown"
        ></textarea>

        <!-- Mention dropdown -->
        <div v-if="mentionActive && mentionSuggestions.length > 0" class="mention-dropdown">
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
        <div v-if="mentionActive && mentionSuggestions.length === 0" class="mention-dropdown mention-empty">
          <span>未找到匹配的猫咪</span>
        </div>
      </div>

      <button
        class="btn-send"
        :disabled="!input.trim() || !store.activeSessionId"
        @click="handleSend"
      >
        发送
      </button>
    </div>
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
  box-shadow: 0 1px 3px rgba(0,0,0,0.2);
}

.toggle-switch.on .toggle-knob {
  transform: translateX(14px);
}

/* ─── Messages ──────────────────────────── */

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 6px;
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

/* Message */
.message {
  display: flex;
  gap: 10px;
  padding: 4px 0;
  align-items: flex-start;
}

/* Vue TransitionGroup: new messages fade in + slide up */
.msg-enter-active {
  transition: opacity 0.25s ease-out, transform 0.25s ease-out;
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

.msg-avatar {
  font-size: 28px;
  flex-shrink: 0;
  line-height: 1;
  margin-top: 2px;
}

.msg-body {
  max-width: 72%;
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

.msg-text {
  font-size: 14px;
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
  50% { opacity: 0; }
}

/* ─── Streaming Message ──────────────────── */

.message.streaming .msg-bubble {
  border-style: dashed;
  opacity: 0.92;
}

/* ─── Thinking Block (collapsible) ────────── */

.thinking-block {
  margin: 6px 0;
  border: 1px solid rgba(180, 160, 140, 0.25);
  border-radius: var(--radius-sm);
  background: rgba(180, 160, 140, 0.06);
  overflow: hidden;
}

.thinking-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  cursor: pointer;
  user-select: none;
  font-size: 12px;
  color: var(--text-muted);
  transition: background var(--ease-in);
  list-style: none; /* hide default <details> marker */
}
.thinking-summary::-webkit-details-marker {
  display: none;
}

.thinking-summary:hover {
  background: rgba(180, 160, 140, 0.1);
}

.thinking-icon {
  font-size: 14px;
}

.thinking-label {
  flex: 1;
  font-weight: 500;
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
  padding: 6px 10px 10px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary);
  border-top: 1px solid rgba(180, 160, 140, 0.15);
}

/* ─── Input Area ────────────────────────── */

.chat-input-area {
  display: flex;
  gap: 10px;
  padding: 14px 20px;
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-base);
}

.input-wrapper {
  flex: 1;
  position: relative;
}

.chat-input {
  width: 100%;
  padding: 10px 14px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: 14px;
  font-family: inherit;
  line-height: 1.5;
  resize: none;
  outline: none;
  transition: border-color var(--ease-out);
}

.chat-input:focus {
  border-color: var(--accent);
}

.chat-input:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.chat-input::placeholder {
  color: var(--text-muted);
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
}

.btn-send:disabled {
  opacity: 0.3;
  cursor: default;
}
</style>

<!-- Non-scoped: markdown content rendered via v-html -->
<style>
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
  background: #1e1e2e;
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
  color: #cdd6f4;
  line-height: 1.55;
  border-radius: 0;
  word-break: normal;
  white-space: pre;
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

.chat-panel .msg-text h1 { font-size: 1.3em; }
.chat-panel .msg-text h2 { font-size: 1.15em; }
.chat-panel .msg-text h3 { font-size: 1.05em; }

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

.chat-panel .msg-text ul input[type="checkbox"],
.chat-panel .msg-text ol input[type="checkbox"] {
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

.chat-panel .msg-text ul input[type="checkbox"]:checked,
.chat-panel .msg-text ol input[type="checkbox"]:checked {
  background: var(--accent);
  border-color: var(--accent);
}

.chat-panel .msg-text ul input[type="checkbox"]:checked::after,
.chat-panel .msg-text ol input[type="checkbox"]:checked::after {
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

.chat-panel .msg-text li:has(input[type="checkbox"]:checked) {
  text-decoration: line-through;
  opacity: 0.6;
}

/* Fix list items containing checkboxes */
.chat-panel .msg-text ul:has(input[type="checkbox"]),
.chat-panel .msg-text ol:has(input[type="checkbox"]) {
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

/* 列对齐（GFM table 对齐语法 :--- :---: ---:） */
.chat-panel .msg-text th[align="center"],
.chat-panel .msg-text td[align="center"] {
  text-align: center;
}

.chat-panel .msg-text th[align="right"],
.chat-panel .msg-text td[align="right"] {
  text-align: right;
}

/* 表头 */
.chat-panel .msg-text thead th {
  background: var(--bg-hover);
  font-weight: 600;
  color: var(--text-primary);
  font-size: 0.95em;
  border-bottom: 2px solid var(--border-focus);
}

/* 斑马纹 */
.chat-panel .msg-text tbody tr:nth-child(even) {
  background: rgba(127, 127, 127, 0.08);
}

/* 行悬停 */
.chat-panel .msg-text tbody tr:hover {
  background: rgba(212, 165, 116, 0.12);
}

/* 表体行无额外背景时保持透明 */
.chat-panel .msg-text tbody tr:first-child td {
  padding-top: 10px;
}
</style>
