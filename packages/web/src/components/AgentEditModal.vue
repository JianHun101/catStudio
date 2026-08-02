<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import type { AgentConfig } from '@cat-study/shared'
import { useChatStore } from '@/stores/chat'

const props = defineProps<{ agent: AgentConfig | null }>()
const emit = defineEmits(['close'])

const store = useChatStore()

const name = ref('')
const avatar = ref('🐱')
const systemPrompt = ref('')
const llmProvider = ref('claude')
const llmModel = ref('deepseek-v4-pro')
const llmApiKey = ref('')
const llmBaseUrl = ref('')
const llmEffortLevel = ref('high')
const saving = ref(false)
const deleting = ref(false)
const deleteConfirm = ref(false)
const error = ref('')

watch(
  () => props.agent,
  (a) => {
    if (a) {
      name.value = a.name
      avatar.value = a.avatar
      systemPrompt.value = a.systemPrompt
      llmProvider.value = a.llmProvider
      llmModel.value = a.llmModel
      llmApiKey.value = a.llmApiKey
      llmBaseUrl.value = a.llmBaseUrl || ''
      llmEffortLevel.value = a.effortLevel || 'high'
      error.value = ''
      deleteConfirm.value = false
    }
  },
  { immediate: true }
)

const providerOptions = [
  { value: 'deepseek', label: 'DeepSeek (HTTP API)' },
  { value: 'claude', label: 'Claude Code (CLI)' },
  { value: 'openai', label: 'Codex (CLI)' },
  { value: 'pi', label: 'Pi (SDK)' },
  { value: 'custom', label: '自定义' },
]

const providerHint = computed(() => {
  switch (llmProvider.value) {
    case 'claude':
      return '需要安装 Claude Code CLI: npm i -g @anthropic-ai/claude-code。Base URL 留空 = DeepSeek，填 https://api.moonshot.ai/anthropic = Kimi K3'
    case 'openai':
      return '需要安装 Codex CLI (npm i -g @openai/codex) 和 codex-proxy'
    case 'pi':
      return '需要安装 pi-coding-agent: npm i @earendil-works/pi-coding-agent'
    case 'custom':
      return '自定义 API 端点，需兼容 OpenAI Chat Completions 格式'
    default:
      return ''
  }
})

const avatarOptions = [
  '🐱',
  '😺',
  '😼',
  '😻',
  '😾',
  '😿',
  '🙀',
  '🐈',
  '🦁',
  '🐯',
  '🐶',
  '🐰',
  '🐼',
  '🦊',
  '🐮',
]

const effortOptions = [
  { value: 'low', label: 'Low (最低推理深度)' },
  { value: 'medium', label: 'Medium (中等)' },
  { value: 'high', label: 'High (较高推理深度)' },
  { value: 'max', label: 'Max (最高推理深度)' },
]

async function handleSave(): Promise<void> {
  if (!props.agent) return
  saving.value = true
  error.value = ''
  try {
    await store.updateAgent(props.agent.id, {
      name: name.value,
      avatar: avatar.value,
      systemPrompt: systemPrompt.value,
      llmProvider: llmProvider.value,
      llmModel: llmModel.value,
      llmApiKey: llmApiKey.value,
      llmBaseUrl: llmBaseUrl.value,
      effortLevel: llmEffortLevel.value,
    })
    emit('close')
  } catch (err: any) {
    error.value = err.message || '保存失败'
  } finally {
    saving.value = false
  }
}

async function handleDelete(): Promise<void> {
  if (!props.agent) return
  if (!deleteConfirm.value) {
    deleteConfirm.value = true
    return
  }
  deleting.value = true
  error.value = ''
  try {
    await store.deleteAgent(props.agent.id)
    emit('close')
  } catch (err: any) {
    error.value = err.message || '删除失败'
    deleteConfirm.value = false
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <div v-if="agent" class="modal-overlay" @click.self="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="编辑猫咪">
      <div class="modal-header">
        <div class="modal-title">
          <span class="modal-avatar">{{ agent.avatar }}</span>
          <h3>编辑 {{ agent.name }}</h3>
        </div>
        <button class="btn-close" @click="emit('close')">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path
              d="M4 4l10 10M14 4l-10 10"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>

      <div class="modal-body">
        <!-- 基本信息 -->
        <div class="form-row">
          <div class="form-group flex-1">
            <label>名字</label>
            <input v-model="name" type="text" class="input" v-focus />
          </div>
          <div class="form-group" style="width: 140px">
            <label>头像</label>
            <div class="avatar-picker">
              <button
                v-for="a in avatarOptions"
                :key="a"
                class="avatar-option"
                :class="{ selected: avatar === a }"
                @click="avatar = a"
              >
                {{ a }}
              </button>
            </div>
            <input v-model="avatar" type="text" class="input input-sm" />
          </div>
        </div>

        <!-- LLM 配置 -->
        <div class="form-section-title">LLM 配置</div>

        <div class="form-row">
          <div class="form-group flex-1">
            <label>供应商</label>
            <select v-model="llmProvider" class="input">
              <option v-for="p in providerOptions" :key="p.value" :value="p.value">
                {{ p.label }}
              </option>
            </select>
            <p v-if="providerHint" class="provider-hint">{{ providerHint }}</p>
          </div>
          <div class="form-group flex-1">
            <label>模型</label>
            <input v-model="llmModel" type="text" class="input" placeholder="deepseek-v4-pro" />
          </div>
        </div>

        <div v-if="llmProvider === 'claude'" class="form-group">
          <label>推理深度 (Effort)</label>
          <select v-model="llmEffortLevel" class="input">
            <option v-for="opt in effortOptions" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
          <p class="provider-hint">
            控制 Claude Code 的推理 token 预算。High 适用于大多数场景，Max 推理最深入但耗时最长。
          </p>
        </div>

        <div class="form-group">
          <label>API Key</label>
          <input v-model="llmApiKey" type="password" class="input input-mono" placeholder="sk-…" />
        </div>

        <div v-if="llmProvider === 'custom' || llmProvider === 'claude'" class="form-group">
          <label>Base URL</label>
          <input
            v-model="llmBaseUrl"
            type="text"
            class="input input-mono"
            :placeholder="
              llmProvider === 'claude'
                ? '留空 = DeepSeek；https://api.moonshot.ai/anthropic = Kimi K3'
                : 'https://api.example.com'
            "
          />
        </div>

        <!-- System Prompt -->
        <div class="form-section-title">角色设定 (System Prompt)</div>
        <div class="form-group">
          <textarea
            v-model="systemPrompt"
            class="input textarea-lg"
            rows="10"
            placeholder="描述这个 Agent 的角色、性格、说话风格…"
          ></textarea>
        </div>

        <div v-if="error" class="error-msg">{{ error }}</div>
      </div>

      <div class="modal-footer">
        <button
          class="btn btn-delete"
          :class="{ 'btn-delete-confirm': deleteConfirm }"
          :disabled="deleting"
          @click="handleDelete"
        >
          {{ deleting ? '删除中…' : deleteConfirm ? '确认删除？' : '删除 Agent' }}
        </button>
        <div class="footer-right">
          <button class="btn btn-cancel" @click="emit('close')">取消</button>
          <button class="btn btn-save" :disabled="saving" @click="handleSave">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
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
  width: 540px;
  max-height: 85vh;
  overflow-y: auto;
  box-shadow: var(--shadow-lg);
}

/* Header */
.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 18px 22px;
  border-bottom: 1px solid var(--border-subtle);
}

.modal-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.modal-avatar {
  font-size: 24px;
}

.modal-title h3 {
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

/* Body */
.modal-body {
  padding: 20px 22px;
}

.form-section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  margin: 20px 0 10px;
  padding-top: 16px;
  border-top: 1px solid var(--border-subtle);
}

.form-section-title:first-of-type {
  border-top: none;
  margin-top: 0;
  padding-top: 0;
}

.form-row {
  display: flex;
  gap: 14px;
}

.form-group {
  margin-bottom: 14px;
}

.form-group label {
  display: block;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.4px;
  margin-bottom: 5px;
}

.flex-1 {
  flex: 1;
}

.input {
  width: 100%;
  padding: 8px 11px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  color: var(--text-primary);
  font-size: 13px;
  font-family: inherit;
  outline: none;
  transition: border-color var(--ease-out);
}

.input:focus {
  border-color: var(--accent);
}

.input-mono {
  font-family: var(--font-mono);
  font-size: 12px;
}

.input-sm {
  margin-top: 6px;
  font-size: 14px;
}

.textarea-lg {
  resize: vertical;
  font-size: 13px;
  line-height: 1.65;
  font-family: inherit;
}

select.input {
  cursor: pointer;
}

.provider-hint {
  font-size: 11px;
  color: var(--accent);
  margin-top: 6px;
  padding: 6px 10px;
  background: var(--accent-tint);
  border: 1px solid var(--accent-hint-border);
  border-radius: var(--radius-sm);
  line-height: 1.5;
}

/* Avatar picker */
.avatar-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.avatar-option {
  width: 30px;
  height: 30px;
  font-size: 18px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--ease-out);
}

.avatar-option:hover {
  border-color: var(--accent);
}

.avatar-option.selected {
  border-color: var(--accent);
  background: var(--accent-soft);
}

/* Footer */
.modal-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 14px 22px;
  border-top: 1px solid var(--border-subtle);
}

.footer-right {
  display: flex;
  gap: 10px;
  margin-left: auto;
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

.btn-save {
  background: var(--accent);
  color: var(--bg-deep);
  font-weight: 600;
}

.btn-save:hover:not(:disabled) {
  background: var(--accent-hover);
}

.btn-save:disabled {
  opacity: 0.4;
  cursor: default;
}

.btn-delete {
  background: transparent;
  color: var(--text-muted);
  border: 1px solid var(--border-subtle);
  padding: 8px 16px;
  font-size: 12px;
}

.btn-delete:hover:not(:disabled) {
  color: var(--accent-red);
  border-color: var(--accent-red);
  background: rgba(224, 85, 106, 0.08);
}

.btn-delete-confirm {
  color: var(--accent-red);
  border-color: var(--accent-red);
  background: rgba(224, 85, 106, 0.12);
  font-weight: 600;
}

.btn-delete-confirm:hover:not(:disabled) {
  background: var(--accent-red);
  color: #fff;
}

.btn-delete:disabled {
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
  margin-top: 12px;
  border: 1px solid rgba(224, 85, 106, 0.2);
}
</style>
