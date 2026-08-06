<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useChatStore } from '@/stores/chat'
import { api, type ConnectorBinding } from '@/composables/useApi'

const emit = defineEmits(['close'])
const store = useChatStore()

// ─── 绑定列表 ─────────────────────────────
const bindings = ref<ConnectorBinding[]>([])
const loading = ref(false)
const listError = ref('')
/** 删除两步确认：存 external_id（唯一键 (platform, external_type, external_id) 全局唯一） */
const confirmDeleteId = ref<string | null>(null)

// ─── 添加表单 ─────────────────────────────
const platform = ref('qq')
const externalType = ref<'group' | 'private'>('group')
const externalId = ref('')
const sessionId = ref('')
const saving = ref(false)
const error = ref('')

const platformOptions = [{ value: 'qq', label: 'QQ (OneBot)' }]
const typeOptions = [
  { value: 'group', label: '群聊' },
  { value: 'private', label: '私聊' },
]

/** 会话标题 join（store.sessions 即 GET /api/sessions 的结果，同源数据零额外请求）；查不到显示原始 id */
function sessionTitle(id: string): string {
  return store.sessions.find((s) => s.id === id)?.title || id
}

function typeLabel(type: string): string {
  return type === 'group' ? '群聊' : '私聊'
}

async function loadBindings(): Promise<void> {
  loading.value = true
  listError.value = ''
  try {
    const res = await api.getConnectorBindings()
    bindings.value = res.bindings
  } catch (err: any) {
    listError.value = err.message || '加载绑定列表失败'
  } finally {
    loading.value = false
  }
}

/** 表单校验对齐后端契约（externalId 纯数字、会话必选）——不通过不发请求 */
function validateForm(): boolean {
  if (!/^\d+$/.test(externalId.value.trim())) {
    error.value = 'QQ 号/群号必须是纯数字'
    return false
  }
  if (!sessionId.value) {
    error.value = '请选择要绑定的会话'
    return false
  }
  return true
}

async function handleAdd(): Promise<void> {
  error.value = ''
  if (!validateForm()) return
  saving.value = true
  try {
    await api.createConnectorBinding({
      platform: platform.value,
      externalType: externalType.value,
      externalId: externalId.value.trim(),
      sessionId: sessionId.value,
    })
    externalId.value = ''
    await loadBindings() // POST 成功后刷新列表
  } catch (err: any) {
    // 后端 400（契约校验）/ 404（会话不存在）错误同样显示
    error.value = err.message || '添加失败'
  } finally {
    saving.value = false
  }
}

/** 删除两步确认：第一次点变红，第二次执行（AgentEditModal 同款范式） */
async function handleDelete(binding: ConnectorBinding): Promise<void> {
  if (confirmDeleteId.value !== binding.external_id) {
    confirmDeleteId.value = binding.external_id
    return
  }
  error.value = ''
  try {
    await api.deleteConnectorBinding({
      platform: binding.platform,
      externalType: binding.external_type,
      externalId: binding.external_id,
    })
    confirmDeleteId.value = null
    await loadBindings() // DELETE 成功后刷新列表
  } catch (err: any) {
    error.value = err.message || '删除失败'
  }
}

onMounted(loadBindings)
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="绑定设置">
      <div class="modal-header">
        <h3>绑定设置</h3>
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
        <div class="section-title">已有绑定</div>
        <div v-if="loading" class="list-hint">加载中…</div>
        <div v-else-if="listError" class="error-msg">{{ listError }}</div>
        <div v-else-if="bindings.length === 0" class="list-hint">
          暂无绑定——添加后对应 QQ 群/私聊的消息才会接入猫咖
        </div>
        <div v-else class="binding-list">
          <div
            v-for="b in bindings"
            :key="`${b.platform}-${b.external_type}-${b.external_id}`"
            class="binding-row"
            :class="{ confirming: confirmDeleteId === b.external_id }"
          >
            <div class="binding-info">
              <span class="binding-type">{{ typeLabel(b.external_type) }}</span>
              <span class="binding-id">{{ b.external_id }}</span>
              <span class="binding-session" :title="sessionTitle(b.session_id)">
                {{ sessionTitle(b.session_id) }}
              </span>
            </div>
            <button
              class="btn-delete"
              :class="{ 'btn-delete-confirm': confirmDeleteId === b.external_id }"
              @click="handleDelete(b)"
            >
              {{ confirmDeleteId === b.external_id ? '确认删除？' : '删除' }}
            </button>
          </div>
        </div>

        <div class="section-title">添加绑定</div>
        <div class="form-group">
          <label>平台</label>
          <select v-model="platform" class="input">
            <option v-for="p in platformOptions" :key="p.value" :value="p.value">
              {{ p.label }}
            </option>
          </select>
        </div>

        <div class="form-row">
          <div class="form-group flex-1">
            <label>类型</label>
            <select v-model="externalType" class="input">
              <option v-for="t in typeOptions" :key="t.value" :value="t.value">
                {{ t.label }}
              </option>
            </select>
          </div>
          <div class="form-group flex-1">
            <label>QQ 号/群号</label>
            <input
              v-model="externalId"
              type="text"
              inputmode="numeric"
              class="input input-mono"
              placeholder="纯数字"
              v-focus
              @keydown.enter="handleAdd"
            />
          </div>
        </div>

        <div class="form-group">
          <label>绑定会话</label>
          <select v-model="sessionId" class="input">
            <option value="" disabled>选择会话…</option>
            <option v-for="s in store.sessions" :key="s.id" :value="s.id">{{ s.title }}</option>
          </select>
        </div>

        <div v-if="error" class="error-msg">{{ error }}</div>
      </div>

      <div class="modal-footer">
        <button class="btn btn-cancel" @click="emit('close')">关闭</button>
        <button class="btn btn-create" :disabled="saving" @click="handleAdd">
          {{ saving ? '添加中…' : '添加绑定' }}
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
  width: 480px;
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

.section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  margin: 0 0 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-subtle);
}

.section-title + .section-title {
  margin-top: 22px;
  padding-top: 16px;
  border-top: 1px solid var(--border-subtle);
}

/* ─── Binding list ─────────────────────── */

.binding-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.binding-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  background: var(--bg-base);
  border: 1px solid var(--border-subtle);
  transition: all var(--ease-out);
}

.binding-row.confirming {
  border-color: var(--accent-red);
  background: rgba(224, 85, 106, 0.06);
}

.binding-info {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.binding-type {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  color: var(--accent);
  background: var(--accent-tint);
  border: 1px solid var(--accent-hint-border);
  padding: 1px 6px;
  border-radius: var(--radius-sm);
}

.binding-id {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-primary);
}

.binding-session {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-muted);
}

.btn-delete {
  flex-shrink: 0;
  background: transparent;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: 11px;
  font-family: inherit;
  padding: 3px 10px;
  cursor: pointer;
  transition: all var(--ease-out);
}

.btn-delete:hover {
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

.list-hint {
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
  padding: 14px 0;
}

/* ─── Form ─────────────────────────────── */

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

select.input {
  cursor: pointer;
}

/* ─── Footer ───────────────────────────── */

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

/* ─── Error ────────────────────────────── */

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
