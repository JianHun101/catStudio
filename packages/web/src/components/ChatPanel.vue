<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { useChatStore } from '@/stores/chat'
import { useMention } from '@/composables/useMention'

const store = useChatStore()
const input = ref('')
const chatContainer = ref<HTMLDivElement>()
const textareaRef = ref<HTMLTextAreaElement>()
const clearingMessages = ref(false)

const { mentionActive, mentionSuggestions, mentionIndex, detect, select, navigate } =
  useMention(() => store.agents)

async function handleClearMessages(): Promise<void> {
  if (!store.activeSessionId) return
  clearingMessages.value = true
  try {
    await store.clearSessionMessages(store.activeSessionId)
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
</script>

<template>
  <div class="chat-panel">
    <!-- Header -->
    <div class="chat-header">
      <div class="chat-header-left">
        <h2 v-if="store.activeSession">{{ store.activeSession.title }}</h2>
        <span v-else class="placeholder">选择会话开始聊天</span>
      </div>

      <div v-if="store.activeSessionId" class="chat-header-actions">
        <button
          class="btn-clear"
          title="清空所有消息"
          :disabled="clearingMessages"
          @click="handleClearMessages"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M2 4h12M5.5 4V2.5h5V4M6.5 7v5M9.5 7v5M3.5 4l.7 9.1a1 1 0 001 .9h5.6a1 1 0 001-.9l.7-9.1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          {{ clearingMessages ? '…' : '清空' }}
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
        <p>从左侧选择一个会话，或创建一个新会话开始聊天</p>
        <p class="empty-hint">在消息中使用 @猫咪名字 来指定谁来回复</p>
      </div>

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
            <p class="msg-text">{{ msg.content }}</p>
          </div>
        </div>

        <!-- Typing cursor -->
        <span
          v-if="store.typingStates.get(msg.agentId || '')"
          class="typing-cursor"
        >|</span>
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
  gap: 4px;
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
  font-size: 12px;
  color: var(--text-muted);
  font-style: italic;
}

.msg-text {
  font-size: 14px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-primary);
}

/* Typing */
.typing-cursor {
  font-size: 18px;
  color: var(--accent);
  animation: blink 1s step-end infinite;
  margin-top: 12px;
}

@keyframes blink {
  50% { opacity: 0; }
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
