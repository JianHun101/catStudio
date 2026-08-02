<script setup lang="ts">
import { ref, computed } from 'vue'
import type { AgentConfig, AgentTokenStats } from '@cat-study/shared'
import { useChatStore } from '@/stores/chat'
import AgentEditModal from './AgentEditModal.vue'
import { createLogger } from '@/utils/logger'

const log = createLogger('AgentPanel')

defineProps<{
  collapsed?: boolean
}>()

const emit = defineEmits<{
  expand: []
}>()

const store = useChatStore()
const editingAgent = ref<AgentConfig | null>(null)
const showCreate = ref(false)

/** 获取 Agent 的 token 统计，保证不为 undefined */
function getTokenStats(agentId: string): AgentTokenStats | null {
  return store.agentTokenStats.get(agentId) ?? null
}

/** 获取当前上下文窗口 token 用量（驱动 handoff 的真实数字） */
function contextTokensFor(agentId: string): number {
  return store.contextTokens.get(agentId) ?? 0
}

/** 安全的 token 使用比例（处理除零）。
 *  只用 contextTokens（实时推送的当前窗口估算值）。
 *  不再 fallback 到 sessionPromptTokens（累计值）——累计值不反映当前上下文窗口大小，
 *  用它做 fallback 会给用户虚假的"已满"信号。 */
function tokenRatio(agentId: string): number {
  const ctx = contextTokensFor(agentId)
  if (ctx <= 0) return 0 // 尚无实时数据，不显示虚假进度
  const stats = getTokenStats(agentId)
  const max = stats?.maxContextTokens ?? 128000
  if (max <= 0) return 0
  return ctx / max
}

/** token 条颜色状态 */
function tokenBarClass(agentId: string): string {
  const r = tokenRatio(agentId)
  if (r >= 0.9) return 'token-critical'
  if (r >= 0.7) return 'token-warning'
  return ''
}

function agentStatus(agentId: string): string {
  const state = store.agentStates.get(agentId)
  return state?.status || 'idle'
}

function agentQueue(agentId: string): number {
  const state = store.agentStates.get(agentId)
  return state?.queueLength || 0
}

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

function statusDot(status: string): string {
  return status === 'idle' ? 'dot-idle' : 'dot-busy'
}

function openCreate(): void {
  showCreate.value = true
  emit('expand')
}

function closeEdit(): void {
  editingAgent.value = null
  store.fetchData()
}

const newAgentForm = ref({
  name: '',
  avatar: '🐱',
  systemPrompt: '',
  llmProvider: 'claude',
  llmModel: 'deepseek-v4-pro',
  llmApiKey: '',
  llmBaseUrl: '',
})
const createError = ref('')
const creating = ref(false)

async function handleCreate(): Promise<void> {
  if (!newAgentForm.value.name.trim()) return
  creating.value = true
  createError.value = ''
  try {
    const { api } = await import('@/composables/useApi')
    await api.createAgent({
      name: newAgentForm.value.name.trim(),
      avatar: newAgentForm.value.avatar,
      systemPrompt: newAgentForm.value.systemPrompt,
      llmProvider: newAgentForm.value.llmProvider,
      llmModel: newAgentForm.value.llmModel,
      llmApiKey: newAgentForm.value.llmApiKey,
      llmBaseUrl: newAgentForm.value.llmBaseUrl || undefined,
    })
    showCreate.value = false
    newAgentForm.value = {
      name: '',
      avatar: '🐱',
      systemPrompt: '',
      llmProvider: 'claude',
      llmModel: 'deepseek-v4-pro',
      llmApiKey: '',
      llmBaseUrl: '',
    }
    await store.fetchData()
  } catch (err: any) {
    log.error('create agent failed', { error: String(err) })
    // 解析后端返回的友好错误信息，否则用通用中文提示
    let msg = err?.body?.message || err?.body?.error || err.message || ''
    if (msg.includes('UNIQUE constraint') || msg.includes('已存在')) {
      msg = '同名猫咪已存在，请换一个名字'
    } else if (msg.includes('API key') || msg.includes('apiKey')) {
      msg = 'API Key 无效或缺失，请检查后重试'
    } else if (!msg || msg.includes('Internal Server Error')) {
      msg = '服务器内部错误，请查看后端日志'
    }
    createError.value = msg || '创建失败'
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <!-- Collapsed: icon column -->
  <div v-if="collapsed" class="agent-panel-collapsed">
    <button class="collapsed-icon collapsed-add-agent" title="添加 Agent" @click="openCreate">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      </svg>
    </button>

    <div class="collapsed-agents">
      <button
        v-for="agent in store.agents"
        :key="agent.id"
        class="collapsed-agent-btn"
        :title="agent.name"
        @click="editingAgent = agent"
      >
        <span class="collapsed-agent-avatar">{{ agent.avatar }}</span>
        <span class="collapsed-agent-dot" :class="statusDot(agentStatus(agent.id))"></span>
      </button>
    </div>
  </div>

  <!-- Expanded: full agent panel -->
  <div v-else class="agent-panel">
    <!-- Header -->
    <div class="panel-header">
      <div class="header-left">
        <h3>猫咪 Agent</h3>
        <span class="header-count" v-if="store.agents.length">{{ store.agents.length }}</span>
      </div>
      <button class="btn-add" title="添加 Agent" @click="openCreate">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path
            d="M8 3v10M3 8h10"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </div>

    <!-- Agent Cards -->
    <div class="agent-cards">
      <div
        v-for="agent in store.agents"
        :key="agent.id"
        class="agent-card"
        @click="editingAgent = agent"
      >
        <div class="card-top">
          <span class="agent-avatar">{{ agent.avatar }}</span>
          <div class="agent-info">
            <span class="agent-name">{{ agent.name }}</span>
            <div class="agent-meta">
              <span class="provider-badge">{{ agent.llmProvider }}</span>
              <span class="model-name">{{ agent.llmModel }}</span>
            </div>
          </div>
          <div class="status-area">
            <span class="status-dot" :class="statusDot(agentStatus(agent.id))"></span>
            <span class="status-label">{{ statusLabel(agentStatus(agent.id)) }}</span>
          </div>
        </div>

        <!-- Token 用量条 -->
        <div v-if="getTokenStats(agent.id)" class="card-tokens">
          <div class="token-header">
            <span class="token-label">
              上下文用量
              <span
                v-if="contextTokensFor(agent.id) > 0"
                class="token-live-dot"
                title="实时数据"
              ></span>
            </span>
            <span class="token-ratio">
              {{
                tokenRatio(agent.id) >= 0.01
                  ? (tokenRatio(agent.id) * 100).toFixed(0) + '%'
                  : '&lt;1%'
              }}
            </span>
          </div>
          <div class="token-bar-bg">
            <!-- handoff 90% 触发线 -->
            <div class="token-bar-threshold" title="90% — 会话交接触发线"></div>
            <div
              class="token-bar-fill"
              :class="tokenBarClass(agent.id)"
              :style="{
                width: Math.min(tokenRatio(agent.id) * 100, 100) + '%',
              }"
            ></div>
          </div>
          <div class="token-footer">
            <span v-if="contextTokensFor(agent.id) > 0">
              窗口 {{ (contextTokensFor(agent.id) / 1000).toFixed(1) }}k /
              {{ (getTokenStats(agent.id)!.maxContextTokens / 1000).toFixed(0) }}k
            </span>
            <span v-else class="token-waiting"> 等待首次回复… </span>
            <span v-if="getTokenStats(agent.id)!.totalPromptTokens > 0" class="token-total">
              · 总计 {{ (getTokenStats(agent.id)!.totalPromptTokens / 1000).toFixed(1) }}k
            </span>
          </div>
        </div>

        <div v-if="agentQueue(agent.id) > 0" class="card-queue">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path
              d="M2 3.5h5M2 6h8M2 8.5h3"
              stroke="currentColor"
              stroke-width="1.2"
              stroke-linecap="round"
            />
          </svg>
          <span>队列 {{ agentQueue(agent.id) }} 条</span>
        </div>
      </div>

      <!-- 等待服务器启动 -->
      <div v-if="store.waitingForServer" class="agent-status">
        <span class="status-spinner"></span>
        <p>等待服务器…</p>
      </div>

      <!-- 数据加载中 -->
      <div v-else-if="store.loading" class="agent-status">
        <span class="status-spinner"></span>
        <p>加载中…</p>
      </div>

      <!-- 数据加载失败 -->
      <div v-else-if="store.dataError" class="agent-status agent-status-error">
        <span class="status-icon">⚠️</span>
        <p>数据加载失败</p>
        <p class="hint">{{ store.dataError }}</p>
        <button class="btn-retry-sm" @click="store.fetchData()">重试</button>
      </div>

      <!-- 空状态 -->
      <div v-else-if="store.agents.length === 0" class="agent-empty">
        <span class="empty-icon">🐈</span>
        <p>还没有 Agent</p>
        <p class="hint">点击右上角 + 创建第一只猫咪</p>
      </div>
    </div>

    <!-- Quick Create Form -->
    <div v-if="showCreate" class="create-section">
      <div class="create-header">
        <h4>新建 Agent</h4>
        <button class="btn-close-sm" @click="showCreate = false">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path
              d="M3 3l8 8M11 3l-8 8"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>
      <div class="create-body">
        <input v-model="newAgentForm.name" class="input" placeholder="猫咪名字" v-focus />
        <input
          v-model="newAgentForm.llmApiKey"
          class="input input-mono"
          type="password"
          placeholder="API Key (sk-…)"
        />
        <textarea
          v-model="newAgentForm.systemPrompt"
          class="input"
          rows="3"
          placeholder="角色设定…"
        ></textarea>
      </div>
      <div class="create-footer">
        <span v-if="createError" class="error-text">{{ createError }}</span>
        <button class="btn btn-cancel" @click="showCreate = false">取消</button>
        <button class="btn btn-confirm" :disabled="creating" @click="handleCreate">
          {{ creating ? '…' : '创建' }}
        </button>
      </div>
    </div>

    <!-- Queue Section -->
    <div class="queue-section">
      <h4>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path
            d="M2 4.5h6M2 7h10M2 9.5h4"
            stroke="currentColor"
            stroke-width="1.2"
            stroke-linecap="round"
          />
        </svg>
        调度队列
      </h4>
      <div v-if="store.agentStateList.every((a) => a.queueLength === 0)" class="queue-empty">
        暂无排队任务
      </div>
      <div v-else class="queue-items">
        <div
          v-for="s in store.agentStateList.filter((a) => a.queueLength > 0)"
          :key="s.agentId"
          class="queue-item"
        >
          <span class="queue-dot"></span>
          <span class="queue-agent">{{ s.agentId }}</span>
          <span class="queue-count">{{ s.queueLength }} 条</span>
        </div>
      </div>
    </div>
  </div>

  <!-- Edit Modal -->
  <AgentEditModal :agent="editingAgent" @close="closeEdit" />
</template>

<style scoped>
.agent-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* ─── Header ────────────────────────────── */

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 16px 12px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.panel-header h3 {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  letter-spacing: -0.2px;
}

.header-count {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted);
  background: var(--bg-surface);
  padding: 1px 7px;
  border-radius: 10px;
}

.btn-add {
  width: 30px;
  height: 30px;
  border-radius: var(--radius-sm);
  border: 1px dashed var(--border-default);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--ease-out);
}

.btn-add:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}

/* ─── Agent Cards ───────────────────────── */

.agent-cards {
  flex: 1;
  padding: 0 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-y: auto;
}

.agent-card {
  padding: 12px;
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  cursor: pointer;
  transition: all var(--ease-out);
}

.agent-card:hover {
  border-color: var(--border-default);
  box-shadow: var(--shadow-sm);
  background: var(--bg-hover);
}

.card-top {
  display: flex;
  gap: 10px;
  align-items: center;
}

.agent-avatar {
  font-size: 32px;
  flex-shrink: 0;
  line-height: 1;
}

.agent-info {
  flex: 1;
  min-width: 0;
}

.agent-name {
  font-size: 14px;
  font-weight: 600;
  display: block;
}

.agent-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 3px;
}

.provider-badge {
  font-size: 10px;
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-soft);
  padding: 1px 6px;
  border-radius: 4px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.model-name {
  font-size: 10px;
  color: var(--text-muted);
  /* 长模型名（如 deepseek-v4-flash）单行不换行：
     换行会撑高 agent-meta 行 → provider-badge 被 stretch 拉高 → 徽章文字贴顶 */
  white-space: nowrap;
}

/* Status */
.status-area {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.dot-idle {
  background: var(--text-muted);
}

.dot-busy {
  background: var(--accent-yellow);
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}

.status-label {
  font-size: 11px;
  color: var(--text-muted);
  /* 固定状态文字占位宽度（最长「回复中…」≈ 3 汉字 + 省略号）：
     状态切换时 label 宽度恒定 → status-area 整体宽度不变，
     不挤压左侧 agent-info，顶行布局不跳动、灰点锚点不漂移 */
  min-width: 4.5em;
  white-space: nowrap;
}

/* Token usage bar on card */
.card-tokens {
  margin-top: 8px;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  border: 1px solid var(--border-subtle);
}

.token-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}

.token-label {
  font-size: 10px;
  color: var(--text-muted);
  font-weight: 500;
}

.token-ratio {
  font-size: 10px;
  color: var(--text-muted);
  font-family: var(--font-mono);
}

.token-bar-bg {
  height: 4px;
  border-radius: 2px;
  background: var(--border-subtle);
  overflow: visible;
  position: relative;
}

/* 90% 交接触发线 */
.token-bar-threshold {
  position: absolute;
  left: 90%;
  top: -2px;
  bottom: -2px;
  width: 1px;
  background: var(--accent-yellow);
  opacity: 0.6;
  z-index: 2;
}

.token-bar-fill {
  height: 100%;
  border-radius: 2px;
  background: var(--accent);
  transition:
    width 0.5s var(--ease-out),
    background 0.5s var(--ease-out);
}

.token-bar-fill.token-warning {
  background: var(--accent-yellow);
}

.token-bar-fill.token-critical {
  background: var(--accent-red);
}

.token-footer {
  font-size: 9px;
  color: var(--text-muted);
  margin-top: 4px;
  font-family: var(--font-mono);
  display: flex;
  align-items: center;
  gap: 4px;
}

.token-total {
  opacity: 0.6;
}

.token-waiting {
  opacity: 0.5;
  font-style: italic;
}

/* 实时数据指示点 */
.token-live-dot {
  display: inline-block;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent-green, #4caf50);
  margin-left: 2px;
  vertical-align: middle;
  animation: live-pulse 2s infinite;
}

@keyframes live-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}

/* Queue badge on card */
.card-queue {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 8px;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  background: rgba(212, 168, 84, 0.08);
  color: var(--accent-yellow);
  font-size: 11px;
}

/* ─── Agent Status (loading/error) ───────── */

.agent-status {
  text-align: center;
  padding: 24px 16px;
  color: var(--text-muted);
  font-size: 12px;
}

.agent-status .status-spinner {
  display: inline-block;
  width: 20px;
  height: 20px;
  border: 2px solid var(--border-default);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin-bottom: 8px;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.agent-status .status-icon {
  font-size: 22px;
  display: block;
  margin-bottom: 6px;
}

.agent-status .hint {
  font-size: 10px;
  opacity: 0.7;
  margin-top: 3px;
}

.agent-status-error {
  color: var(--accent-red);
}

.agent-status-error .hint {
  color: var(--text-muted);
  max-width: 180px;
  margin: 2px auto 8px;
  word-break: break-all;
}

.btn-retry-sm {
  padding: 4px 14px;
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--ease-out);
}

.btn-retry-sm:hover {
  background: var(--accent);
  color: var(--bg-deep);
}

/* Empty */
.agent-empty {
  text-align: center;
  padding: 32px 16px;
  color: var(--text-muted);
}

.agent-empty .empty-icon {
  font-size: 32px;
  display: block;
  margin-bottom: 8px;
  opacity: 0.5;
}

.agent-empty p {
  font-size: 13px;
}

.agent-empty .hint {
  font-size: 11px;
  opacity: 0.7;
  margin-top: 4px;
}

/* ─── Quick Create ──────────────────────── */

.create-section {
  margin: 0 12px 12px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
  overflow: hidden;
}

.create-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-subtle);
}

.create-header h4 {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
}

.btn-close-sm {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 2px;
  border-radius: 4px;
  transition: color var(--ease-out);
}

.btn-close-sm:hover {
  color: var(--text-primary);
}

.create-body {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.create-body .input {
  width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  color: var(--text-primary);
  font-size: 12px;
  font-family: inherit;
  outline: none;
  transition: border-color var(--ease-out);
}

.create-body .input:focus {
  border-color: var(--accent);
}

.create-body textarea.input {
  resize: vertical;
  line-height: 1.5;
}

.input-mono {
  font-family: var(--font-mono);
  font-size: 11px !important;
}

.create-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--border-subtle);
}

.error-text {
  font-size: 11px;
  color: var(--accent-red);
  margin-right: auto;
}

.btn {
  padding: 6px 16px;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--ease-out);
}

.btn-cancel {
  background: var(--bg-hover);
  color: var(--text-secondary);
}

.btn-cancel:hover {
  background: var(--bg-raised);
  color: var(--text-primary);
}

.btn-confirm {
  background: var(--accent);
  color: var(--bg-deep);
  font-weight: 600;
}

.btn-confirm:hover:not(:disabled) {
  background: var(--accent-hover);
}

.btn-confirm:disabled {
  opacity: 0.4;
  cursor: default;
}

/* ─── Queue Section ─────────────────────── */

.queue-section {
  padding: 12px 16px 16px;
  border-top: 1px solid var(--border-subtle);
}

.queue-section h4 {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: 10px;
}

.queue-empty {
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
  padding: 16px 0;
}

.queue-items {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.queue-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
}

.queue-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent-yellow);
}

.queue-agent {
  flex: 1;
  color: var(--text-secondary);
}

.queue-count {
  color: var(--accent-yellow);
  font-weight: 500;
}

/* ─── Collapsed Icon Column ──────────────── */

.agent-panel-collapsed {
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 100%;
  padding: 8px 0;
  gap: 4px;
}

.agent-panel-collapsed .collapsed-icon {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
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

.agent-panel-collapsed .collapsed-icon:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.collapsed-add-agent {
  margin-bottom: 8px;
}

.collapsed-agents {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  width: 100%;
  padding: 0 4px;
}

.collapsed-agent-btn {
  position: relative;
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--ease-out);
}

.collapsed-agent-btn:hover {
  background: var(--bg-hover);
}

.collapsed-agent-avatar {
  font-size: 22px;
  line-height: 1;
}

.collapsed-agent-dot {
  position: absolute;
  bottom: 4px;
  right: 4px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.collapsed-agent-dot.dot-idle {
  background: var(--text-muted);
}

.collapsed-agent-dot.dot-busy {
  background: var(--accent-yellow);
  animation: pulse 2s infinite;
}
</style>
