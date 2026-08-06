<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { api, type NapcatBrowseEntry } from '@/composables/useApi'

/**
 * NapCat 路径浏览选择器（弹窗）。浏览器 file input 拿不到本地绝对路径（安全沙箱，
 * 只能拿 C:\fakepath\…）→ 选择器走 server 只读目录导航（GET /api/connectors/napcat/
 * browse，零 spawn）：盘符列表 → 目录逐层（双击进入 / 上级返回）→ 点选文件高亮 →
 * 确定回填。选中任意文件均可回填（.exe/.bat/.cmd 带「可执行」标记便于识别），
 * 路径合法性校验在保存时由 server stat 兜底（本组件不做二次校验）。
 */
const emit = defineEmits<{
  (e: 'select', path: string): void
  (e: 'close'): void
}>()

/** 当前浏览目录——null = 盘符列表层 */
const currentDir = ref<string | null>(null)
/** 上级目录（盘符根为 null）——「↑ 上级」按钮目标 */
const parentDir = ref<string | null>(null)
const entries = ref<NapcatBrowseEntry[]>([])
const selected = ref<string>('')
const loading = ref(true)
const error = ref('')

async function load(dir: string | null): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const res = await api.browseNapcatDir(dir ?? undefined)
    currentDir.value = res.dir
    parentDir.value = res.parent
    entries.value = res.entries
    selected.value = ''
  } catch (err: any) {
    error.value = err.message || '目录读取失败'
  } finally {
    loading.value = false
  }
}

function openEntry(entry: NapcatBrowseEntry): void {
  if (entry.type !== 'dir') return
  load(currentDir.value ? joinPath(currentDir.value, entry.name) : entry.name)
}

/** 上级返回——盘符根（parent=null）时回到盘符列表层 */
function goUp(): void {
  load(parentDir.value)
}

function selectFile(entry: NapcatBrowseEntry): void {
  if (entry.type !== 'file') return
  selected.value = entry.name
}

/** 拼接完整路径（盘符列表层 entry.name 本身就是完整路径） */
function joinPath(dir: string, name: string): string {
  return dir.endsWith('\\') ? dir + name : dir + '\\' + name
}

function confirm(): void {
  if (!selected.value) return
  const full = currentDir.value ? joinPath(currentDir.value, selected.value) : selected.value
  emit('select', full)
}

onMounted(() => load(null))
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="浏览 NapCat 路径">
      <div class="modal-header">
        <h3>浏览 NapCat 路径</h3>
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
        <div class="picker-bar">
          <button class="btn-up" :disabled="!currentDir || loading" @click="goUp">↑ 上级</button>
          <span class="picker-dir mono">{{ currentDir ?? '选择磁盘' }}</span>
        </div>

        <div v-if="loading" class="list-hint">加载中…</div>
        <div v-else-if="error" class="error-msg">{{ error }}</div>
        <div v-else-if="entries.length === 0" class="list-hint">（空目录）</div>
        <div v-else class="entry-list">
          <div
            v-for="e in entries"
            :key="e.name"
            class="entry-row"
            :class="{
              'entry-dir': e.type === 'dir',
              'entry-selected': selected === e.name,
              'entry-exec': e.type === 'file' && e.executable,
            }"
            @click="e.type === 'dir' ? openEntry(e) : selectFile(e)"
          >
            <span class="entry-icon">{{ e.type === 'dir' ? '📁' : '📄' }}</span>
            <span class="entry-name mono">{{ e.name }}</span>
            <span v-if="e.type === 'file' && e.executable" class="exec-badge">可执行</span>
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <span v-if="selected" class="pick-preview mono">{{
          currentDir ? joinPath(currentDir, selected) : selected
        }}</span>
        <span v-else class="pick-preview hint">选择要启动的可执行文件（.exe / .bat / .cmd）</span>
        <button class="btn btn-cancel" @click="emit('close')">取消</button>
        <button class="btn btn-ok" :disabled="!selected" @click="confirm">确定</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal {
  width: 520px;
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

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border-subtle);
}

.modal-header h3 {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.btn-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all var(--ease-out);
}

.btn-close:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.modal-body {
  padding: 14px 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
}

.picker-bar {
  display: flex;
  align-items: center;
  gap: 10px;
}

.btn-up {
  padding: 5px 12px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-hover);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all var(--ease-out);
  flex-shrink: 0;
}

.btn-up:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent);
}

.btn-up:disabled {
  opacity: 0.4;
  cursor: default;
}

.picker-dir {
  font-size: 12px;
  color: var(--text-muted);
  word-break: break-all;
}

.entry-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 40vh;
  overflow-y: auto;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  padding: 4px;
}

.entry-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--ease-out);
}

.entry-row:hover {
  background: var(--bg-hover);
}

.entry-dir {
  color: var(--text-primary);
}

.entry-selected {
  background: rgba(96, 165, 250, 0.12);
  outline: 1px solid var(--accent);
}

.entry-icon {
  font-size: 12px;
  flex-shrink: 0;
}

.entry-name {
  flex: 1;
  font-size: 12px;
  word-break: break-all;
}

.exec-badge {
  font-size: 10px;
  font-weight: 600;
  color: #3ecf8e;
  border: 1px solid rgba(62, 207, 142, 0.4);
  border-radius: 999px;
  padding: 1px 8px;
  background: rgba(62, 207, 142, 0.08);
  flex-shrink: 0;
}

.modal-footer {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 18px;
  border-top: 1px solid var(--border-subtle);
}

.pick-preview {
  flex: 1;
  font-size: 11px;
  color: var(--text-secondary);
  word-break: break-all;
}

.pick-preview.hint {
  color: var(--text-muted);
}

.btn {
  padding: 7px 20px;
  border: none;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all var(--ease-out);
  flex-shrink: 0;
}

.btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.btn-cancel {
  background: var(--bg-hover);
  color: var(--text-secondary);
  border: 1px solid var(--border-default);
}

.btn-cancel:hover:not(:disabled) {
  color: var(--text-primary);
}

.btn-ok {
  background: var(--accent);
  color: var(--bg-deep);
}

.btn-ok:hover:not(:disabled) {
  background: var(--accent-hover);
}

.list-hint {
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
  padding: 14px 0;
}

.error-msg {
  background: rgba(224, 85, 106, 0.1);
  color: var(--accent-red);
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  border: 1px solid rgba(224, 85, 106, 0.2);
}

.mono {
  font-family: var(--font-mono);
}
</style>
