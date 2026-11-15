<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useChatStore } from '@/stores/chat'
import type { TrashEntry } from '@/composables/useApi'
import { fmtUtcShort } from '@/utils/time'

/**
 * 回收站主区（T4 票面）。
 *
 * 两段列表，**条目粒度 = 删除动作粒度**（ADR 0016 D3）：
 * - 「整组删除」每条是一组（`kind:'group'`），行内只有组级恢复/永久删除；
 *   组内成员不能单条恢复/清除（服务端 409 `SESSION_IN_TRASH_GROUP`）。
 * - 「单个会话」每条是一次单独删除（`kind:'session'`）；整组删除的同批成员
 *   不会出现在这一段——两段互不重叠，恢复整组也不会复活组内更早单删的会话。
 *
 * 剩余天数是服务端算的 `daysLeft`（不信任本机时钟）；永久删除与清空都在组件内
 * 二次确认（不用 `window.confirm`）。
 */
const store = useChatStore()
const emit = defineEmits<{ (e: 'close'): void }>()

const groupEntries = computed(() => store.trashEntries.filter((e) => e.kind === 'group'))
const sessionEntries = computed(() => store.trashEntries.filter((e) => e.kind === 'session'))

/** 动作互斥：恢复/清除进行中禁用所有行按钮，防连点重复提交 */
const busy = ref(false)

type ConfirmState =
  | { kind: 'session'; id: string; title: string; body: string }
  | { kind: 'group'; id: string; title: string; body: string }
  | { kind: 'empty'; title: string; body: string }

const confirmState = ref<ConfirmState | null>(null)

onMounted(() => {
  // 进回收站即重拉：头行计数可能是上一次事件后的读数，列表口径以服务端为准
  void store.fetchTrash()
})

function daysLeftText(entry: TrashEntry): string {
  return entry.daysLeft <= 1 ? '不足 1 天' : `剩 ${entry.daysLeft} 天`
}

function askRestore(entry: TrashEntry): void {
  if (busy.value) return
  busy.value = true
  const action =
    entry.kind === 'group' ? store.restoreTrashGroup(entry.id) : store.restoreTrashSession(entry.id)
  void action.finally(() => {
    busy.value = false
  })
}

function askPurge(entry: TrashEntry): void {
  if (busy.value) return
  if (entry.kind === 'group') {
    confirmState.value = {
      kind: 'group',
      id: entry.id,
      title: `永久删除分组「${entry.name}」？`,
      body: `将永久删除该分组及同批的 ${entry.sessionCount} 个会话（${entry.messageCount} 条消息）及其执行记录。组内更早单独删除的会话不受影响；此操作不可撤销。`,
    }
  } else {
    confirmState.value = {
      kind: 'session',
      id: entry.id,
      title: `永久删除「${entry.name}」？`,
      body: `将永久删除该会话的 ${entry.messageCount} 条消息及其执行记录。此操作不可撤销。`,
    }
  }
}

function askEmpty(): void {
  if (busy.value || store.trashEntries.length === 0) return
  confirmState.value = {
    kind: 'empty',
    title: '清空回收站？',
    body: `将永久删除回收站里的 ${store.trashEntries.length} 项（整组删除的分组及同批会话、单独删除的会话），并清理消息与执行记录。此操作不可撤销。`,
  }
}

async function runConfirm(): Promise<void> {
  const pending = confirmState.value
  if (!pending || busy.value) return
  busy.value = true
  try {
    const ok =
      pending.kind === 'empty'
        ? await store.emptyTrash()
        : pending.kind === 'group'
          ? await store.purgeTrashGroup(pending.id)
          : await store.purgeTrashSession(pending.id)
    // 失败时保留弹窗（错误 toast 由 store 统一给），成功才关
    if (ok) confirmState.value = null
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="trash-view">
    <div class="trash-inner">
      <header class="trash-head">
        <div class="trash-head-main">
          <div class="trash-crumb">会话 / 回收站</div>
          <h1>回收站</h1>
          <p>删除的会话与分组保留 7 天，到期自动永久删除。恢复分组会把同一批删除的会话一起带回。</p>
        </div>
        <div class="trash-head-actions">
          <button type="button" class="trash-btn ghost" @click="emit('close')">返回聊天</button>
          <button
            type="button"
            class="trash-btn danger"
            :disabled="store.trashEntries.length === 0 || busy"
            @click="askEmpty"
          >
            清空回收站
          </button>
        </div>
      </header>

      <div v-if="store.trashEntries.length === 0" class="trash-empty">
        <div class="trash-empty-icon" aria-hidden="true">🗑️</div>
        <p>回收站是空的</p>
        <p class="hint">删除的会话与分组会在这里保留 7 天</p>
      </div>

      <template v-else>
        <section v-if="groupEntries.length > 0" class="trash-section">
          <div class="trash-section-label">整组删除 · {{ groupEntries.length }}</div>
          <div
            v-for="entry in groupEntries"
            :key="`group-${entry.id}`"
            class="trash-item group"
            :data-entry-kind="entry.kind"
          >
            <div class="trash-ico" aria-hidden="true">📁</div>
            <div class="trash-body">
              <div class="trash-title">{{ entry.name }}</div>
              <div class="trash-sub">
                {{ entry.sessionCount }} 个会话 · {{ entry.messageCount }} 条消息 · 删除于
                {{ fmtUtcShort(entry.deletedAt) }}
              </div>
            </div>
            <div class="trash-expire">
              <div class="expire-days" :class="{ soon: entry.daysLeft <= 1 }">
                {{ daysLeftText(entry) }}
              </div>
              <div class="expire-hint">到期自动永久删除</div>
            </div>
            <div class="trash-actions">
              <button type="button" class="row-btn" :disabled="busy" @click="askRestore(entry)">
                恢复
              </button>
              <button
                type="button"
                class="row-btn danger"
                :disabled="busy"
                @click="askPurge(entry)"
              >
                永久删除
              </button>
            </div>
          </div>
        </section>

        <section v-if="sessionEntries.length > 0" class="trash-section">
          <div class="trash-section-label">单个会话 · {{ sessionEntries.length }}</div>
          <div
            v-for="entry in sessionEntries"
            :key="`session-${entry.id}`"
            class="trash-item"
            :data-entry-kind="entry.kind"
          >
            <div class="trash-ico" aria-hidden="true">💬</div>
            <div class="trash-body">
              <div class="trash-title">{{ entry.name }}</div>
              <div class="trash-sub">
                来自「{{ entry.groupName ?? '未分组' }}」 · {{ entry.messageCount }} 条消息 · 删除于
                {{ fmtUtcShort(entry.deletedAt) }}
              </div>
            </div>
            <div class="trash-expire">
              <div class="expire-days" :class="{ soon: entry.daysLeft <= 1 }">
                {{ daysLeftText(entry) }}
              </div>
              <div class="expire-hint">到期自动永久删除</div>
            </div>
            <div class="trash-actions">
              <button type="button" class="row-btn" :disabled="busy" @click="askRestore(entry)">
                恢复
              </button>
              <button
                type="button"
                class="row-btn danger"
                :disabled="busy"
                @click="askPurge(entry)"
              >
                永久删除
              </button>
            </div>
          </div>
        </section>
      </template>
    </div>

    <!-- 二次确认（永久删除 / 清空）：组件内弹窗，不用 window.confirm -->
    <div v-if="confirmState" class="trash-modal-overlay" @click.self="confirmState = null">
      <div class="trash-modal" role="dialog" aria-modal="true" :aria-label="confirmState.title">
        <h3 class="trash-modal-title">{{ confirmState.title }}</h3>
        <p class="trash-modal-body">{{ confirmState.body }}</p>
        <div class="trash-modal-actions">
          <button
            type="button"
            class="trash-btn ghost"
            :disabled="busy"
            @click="confirmState = null"
          >
            取消
          </button>
          <button type="button" class="trash-btn danger-solid" :disabled="busy" @click="runConfirm">
            {{ busy ? '处理中…' : '永久删除' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.trash-view {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  background: var(--bg-paper);
}

.trash-inner {
  max-width: 860px;
  margin: 0 auto;
  padding: 26px 32px 40px;
}

.trash-head {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--border-subtle);
}

.trash-head-main {
  flex: 1;
  min-width: 0;
}

.trash-crumb {
  color: var(--text-muted);
  font-size: 11px;
  letter-spacing: 0.04em;
}

.trash-head h1 {
  margin: 4px 0 6px;
  font-size: 22px;
  font-weight: 650;
  color: var(--text-primary);
}

.trash-head p {
  margin: 0;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.6;
}

.trash-head-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
}

.trash-btn {
  padding: 6px 12px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: all var(--ease-out);
}

.trash-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.trash-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.trash-btn.danger {
  border-color: rgba(208, 68, 88, 0.35);
  color: var(--accent-red);
}

.trash-btn.danger:hover:not(:disabled) {
  background: rgba(208, 68, 88, 0.08);
}

.trash-btn.danger-solid {
  border-color: var(--accent-red);
  background: var(--accent-red);
  color: #fff;
}

.trash-btn.danger-solid:hover:not(:disabled) {
  filter: brightness(1.05);
}

.trash-section-label {
  margin: 22px 0 8px;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.05em;
}

.trash-item {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
  padding: 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-raised);
  transition: border-color var(--ease-out);
}

.trash-item:hover {
  border-color: var(--border-default);
}

.trash-ico {
  flex: none;
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border: 1px solid var(--border-subtle);
  border-radius: 9px;
  background: var(--bg-surface);
  font-size: 15px;
}

.trash-item.group .trash-ico {
  color: var(--accent-text);
  background: var(--accent-soft);
  border-color: rgba(180, 130, 80, 0.2);
}

.trash-body {
  flex: 1;
  min-width: 0;
}

.trash-title {
  overflow: hidden;
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 550;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.trash-sub {
  margin-top: 3px;
  overflow: hidden;
  color: var(--text-muted);
  font-size: 11px;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.trash-expire {
  flex: none;
  width: 128px;
  text-align: right;
}

.expire-days {
  color: var(--text-secondary);
  font-size: 11.5px;
}

.expire-days.soon {
  color: var(--accent-red);
}

.expire-hint {
  margin-top: 2px;
  color: var(--text-muted);
  font-size: 10px;
  opacity: 0.8;
}

.trash-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  opacity: 0;
  transition: opacity var(--ease-out);
}

.trash-item:hover .trash-actions,
.trash-actions:focus-within {
  opacity: 1;
}

/* 触屏无 hover：行内动作恒显，否则回收站无法操作 */
@media (hover: none) {
  .trash-actions {
    opacity: 1;
  }
}

.row-btn {
  padding: 4px 9px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  transition: all var(--ease-out);
}

.row-btn:hover:not(:disabled) {
  border-color: var(--border-default);
  background: var(--bg-hover);
  color: var(--text-primary);
}

.row-btn.danger {
  color: var(--accent-red);
}

.row-btn.danger:hover:not(:disabled) {
  border-color: rgba(208, 68, 88, 0.35);
  background: rgba(208, 68, 88, 0.08);
}

.row-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.trash-empty {
  margin-top: 70px;
  color: var(--text-muted);
  text-align: center;
}

.trash-empty-icon {
  margin-bottom: 8px;
  font-size: 30px;
  opacity: 0.5;
}

.trash-empty p {
  margin: 4px 0;
  font-size: 13px;
}

.trash-empty .hint {
  font-size: 11px;
  opacity: 0.8;
}

.trash-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 950;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.35);
}

.trash-modal {
  width: 420px;
  max-width: calc(100vw - 48px);
  padding: 20px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-raised);
  box-shadow: var(--shadow-lg);
}

.trash-modal-title {
  margin: 0 0 8px;
  color: var(--text-primary);
  font-size: 15px;
  font-weight: 600;
}

.trash-modal-body {
  margin: 0 0 18px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.65;
}

.trash-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
