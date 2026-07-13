<script setup lang="ts">
import { ref } from 'vue'
import { useChatStore } from '@/stores/chat'

const emit = defineEmits(['close'])
const store = useChatStore()

const title = ref('')
const selectedAgents = ref<Set<string>>(new Set())
const saving = ref(false)
const error = ref('')

function toggleAgent(id: string): void {
  const next = new Set(selectedAgents.value)
  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
  }
  selectedAgents.value = next
}

async function handleCreate(): Promise<void> {
  if (!title.value.trim()) return
  if (selectedAgents.value.size === 0) {
    error.value = '请至少选择一只猫咪'
    return
  }
  saving.value = true
  error.value = ''
  try {
    await store.createSession(title.value.trim(), [...selectedAgents.value])
    emit('close')
  } catch (err: any) {
    error.value = err.message || '创建失败'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-header">
        <h3>新建会话</h3>
        <button class="btn-close" @click="emit('close')">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path d="M4 4l10 10M14 4l-10 10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
          </svg>
        </button>
      </div>

      <div class="modal-body">
        <div class="form-group">
          <label>会话名称</label>
          <input
            v-model="title"
            type="text"
            class="input"
            placeholder="深夜话题、日常闲聊…"
            autofocus
            @keydown.enter="handleCreate"
          />
        </div>

        <div class="form-group">
          <label>选择猫咪 — 已选 {{ selectedAgents.size }} 只</label>
          <div class="agent-select-list">
            <div
              v-for="agent in store.agents"
              :key="agent.id"
              class="agent-select-item"
              :class="{ selected: selectedAgents.has(agent.id) }"
              @click="toggleAgent(agent.id)"
            >
              <div class="select-check">
                <svg v-if="selectedAgents.has(agent.id)" width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="7" fill="var(--accent)" stroke="var(--accent)" stroke-width="1"/>
                  <path d="M5 8l2 2 4-4" stroke="var(--bg-deep)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                <svg v-else width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="7" stroke="var(--text-muted)" stroke-width="1.2"/>
                </svg>
              </div>
              <span class="agent-avatar">{{ agent.avatar }}</span>
              <div class="agent-detail">
                <span class="agent-name">{{ agent.name }}</span>
                <span class="agent-provider">{{ agent.llmProvider }}</span>
              </div>
            </div>
          </div>
          <p v-if="store.agents.length === 0" class="no-agents">
            还没有 Agent，请先在右侧面板创建
          </p>
        </div>

        <div v-if="error" class="error-msg">{{ error }}</div>
      </div>

      <div class="modal-footer">
        <button class="btn btn-cancel" @click="emit('close')">取消</button>
        <button class="btn btn-create" :disabled="saving" @click="handleCreate">
          {{ saving ? '创建中…' : '创建会话' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal {
  background: var(--bg-raised);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  width: 440px;
  max-height: 80vh;
  overflow-y: auto;
  box-shadow: var(--shadow-lg);
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 18px 22px;
  border-bottom: 1px solid var(--border-subtle);
}

.modal-header h3 {
  font-size: 15px;
  font-weight: 600;
}

.btn-close {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 4px;
  border-radius: var(--radius-sm);
  transition: all var(--ease-out);
}

.btn-close:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.modal-body {
  padding: 20px 22px;
}

.form-group {
  margin-bottom: 18px;
}

.form-group label {
  display: block;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.4px;
  margin-bottom: 6px;
}

.input {
  width: 100%;
  padding: 9px 12px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  color: var(--text-primary);
  font-size: 14px;
  font-family: inherit;
  outline: none;
  transition: border-color var(--ease-out);
}

.input:focus {
  border-color: var(--accent);
}

.input::placeholder {
  color: var(--text-muted);
}

/* Agent select list */
.agent-select-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.agent-select-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  background: var(--bg-base);
  border: 1px solid var(--border-subtle);
  cursor: pointer;
  transition: all var(--ease-out);
}

.agent-select-item:hover {
  background: var(--bg-hover);
  border-color: var(--border-default);
}

.agent-select-item.selected {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.select-check {
  flex-shrink: 0;
}

.agent-avatar {
  font-size: 26px;
}

.agent-detail {
  display: flex;
  flex-direction: column;
}

.agent-name {
  font-size: 14px;
  font-weight: 500;
}

.agent-provider {
  font-size: 10px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.no-agents {
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
  padding: 12px 0;
}

/* Footer */
.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 22px;
  border-top: 1px solid var(--border-subtle);
}

.btn {
  padding: 8px 22px;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--ease-out);
}

.btn-cancel {
  background: var(--bg-hover);
  color: var(--text-secondary);
}

.btn-cancel:hover {
  background: var(--bg-surface);
  color: var(--text-primary);
}

.btn-create {
  background: var(--accent);
  color: var(--bg-deep);
  font-weight: 600;
}

.btn-create:hover:not(:disabled) {
  background: var(--accent-hover);
}

.btn-create:disabled {
  opacity: 0.4;
  cursor: default;
}

/* Error */
.error-msg {
  background: rgba(224, 85, 106, 0.1);
  color: var(--accent-red);
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  border: 1px solid rgba(224, 85, 106, 0.2);
}
</style>
