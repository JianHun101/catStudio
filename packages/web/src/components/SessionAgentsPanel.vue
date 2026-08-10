<script setup lang="ts">
import { ref, computed } from 'vue'
import { useChatStore } from '@/stores/chat'
import { api } from '@/composables/useApi'

/**
 * 会话右侧边栏——clowder-ai 精简评估面板（低密度分区卡片，评估会话当前状态用）。
 * 严禁恢复旧版 300px 高密度运行控制台（9dc5619^ 那版：进度条/停止按钮/调度队列全量）。
 * 本面板只做「状态评估」：成员卡 + tokens 数字 + 消息统计 + 队列信息 + 成员管理 + 折叠配置。
 * 停止按钮归 ChatPanel 气泡（B2 重定位），本面板不装——避免双实现。
 * 数据源全部现成：agentStates / contextTokens / activeMessages / activeSession.agentIds +
 * agents store；成员变更走 PATCH /api/sessions/:id，SESSION_UPDATE 广播自动刷新（store 已订阅）。
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
  return store.agentStates.get(agentId)?.status || 'idle'
}

function queueFor(agentId: string): number {
  return store.agentStates.get(agentId)?.queueLength || 0
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

async function removeAgent(agentId: string): Promise<void> {
  if (!store.activeSessionId) return
  actionError.value = ''
  try {
    await api.updateSessionAgents(store.activeSessionId, { removeAgentIds: [agentId] })
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

      <!-- 会话成员卡列表 -->
      <div class="section-title">会话成员</div>
      <div class="member-list">
        <div v-for="agent in memberAgents" :key="agent.id" class="member-card">
          <span class="member-avatar">{{ agent.avatar }}</span>
          <div class="member-info">
            <div class="member-top">
              <span class="member-name">{{ agent.name }}</span>
              <span
                class="status-dot"
                :class="statusFor(agent.id) === 'idle' ? 'dot-idle' : 'dot-busy'"
              ></span>
              <span class="member-status">{{ statusLabel(statusFor(agent.id)) }}</span>
            </div>
            <div class="member-meta">
              <span class="member-tokens">{{ tokensText(agent.id) }}</span>
              <span class="member-tokens-label">tokens</span>
              <span v-if="queueFor(agent.id) > 0" class="queue-badge"
                >队列 {{ queueFor(agent.id) }}</span
              >
            </div>
          </div>
          <button
            class="btn-remove"
            title="从会话移除"
            aria-label="移除"
            @click="removeAgent(agent.id)"
          >
            ✕
          </button>
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
              <span class="config-hint">开启后 Agent 可看到其他 Agent 的回复</span>
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

/* ─── 成员卡 ───────────────────────── */

.member-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.member-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: var(--bg-surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
}

.member-avatar {
  font-size: 26px;
  flex-shrink: 0;
  line-height: 1;
}

.member-info {
  flex: 1;
  min-width: 0;
}

.member-top {
  display: flex;
  align-items: center;
  gap: 6px;
}

.member-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

.member-status {
  font-size: 10px;
  color: var(--text-muted);
  margin-left: auto;
}

.member-meta {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 4px;
}

/* tokens 数字：等宽数字，评估一眼可读 */
.member-tokens {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.member-tokens-label {
  font-size: 9px;
  color: var(--text-muted);
  opacity: 0.7;
}

.queue-badge {
  margin-left: auto;
  font-size: 10px;
  font-weight: 600;
  color: var(--accent-yellow);
  background: rgba(212, 168, 84, 0.1);
  border: 1px solid rgba(212, 168, 84, 0.3);
  padding: 1px 7px;
  border-radius: 999px;
}

.btn-remove {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  font-size: 11px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--ease-out);
}

.btn-remove:hover {
  color: var(--accent-red);
  background: rgba(224, 85, 106, 0.1);
}

.member-empty {
  font-size: 11px;
  color: var(--text-muted);
  text-align: center;
  padding: 10px 0;
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
  border-color: var(--accent);
  color: var(--accent);
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
  color: var(--bg-deep);
  font-weight: 600;
}

.btn-ok:hover:not(:disabled) {
  background: var(--accent-hover);
}
</style>
