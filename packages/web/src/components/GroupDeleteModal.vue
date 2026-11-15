<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { GroupedSession, SessionGroup } from '@/composables/useApi'

/**
 * 删组确认框（T3 票面）：默认「仅解散」；第二项「连同 N 个会话一起移入回收站」。
 *
 * 三条硬约束：
 * 1. **默认仅解散**——删除动作里唯一不可逆的是「会话进回收站」，默认必须是可逆的那个。
 * 2. **忙碌/绑定成员让第二项置灰并红字点名**；空组只给「仅解散」。
 * 3. **切换选项不重建弹窗 DOM、不重播动画**——两个选项与确认按钮始终是同一批节点，
 *    切换只改 class/文案，不用 `:key` 绑模式（否则每次切换都销毁重建，动画重播）。
 */
const props = withDefaults(
  defineProps<{
    group: SessionGroup
    sessions: GroupedSession[]
    /** 阻塞第二项的成员（忙碌 / 已绑定外部群）；空 = 第二项可选 */
    blocked: Array<{ id: string; title: string; reason: 'busy' | 'bound'; platform?: string }>
    /** 提交中（禁用按钮防重复） */
    submitting?: boolean
    /** 服务端拒绝原因（409 等），就地显示、弹窗不关 */
    error?: string
    /**
     * 回收站接线是否就绪（T4 起生产恒 true）。默认 **false**（fail-safe）：漏传时
     * 只给可逆的「仅解散」，不让危险动作可达。
     */
    trashEnabled?: boolean
  }>(),
  { trashEnabled: false }
)

const emit = defineEmits<{
  (e: 'cancel'): void
  (e: 'confirm', mode: 'dissolve' | 'trash'): void
}>()

const mode = ref<'dissolve' | 'trash'>('dissolve')

/** 空组只能解散；有阻塞成员或回收站未接线时第二项不可选 */
const canTrash = computed(
  () => props.trashEnabled && props.sessions.length > 0 && props.blocked.length === 0
)

const blockedText = computed(() =>
  props.blocked
    .map((b) =>
      b.reason === 'busy'
        ? `「${b.title}」正在执行`
        : `「${b.title}」已绑定外部群${b.platform ? `（${b.platform}）` : ''}`
    )
    .join('；')
)

/** 阻塞名单晚到（绑定查询异步）或回收站未接线时，别让用户停在「已选第二项但按钮被禁用」的死状态 */
watch(
  () => [props.blocked.length, props.trashEnabled] as const,
  ([n, enabled]) => {
    if ((n > 0 || !enabled) && mode.value === 'trash') mode.value = 'dissolve'
  }
)
</script>

<template>
  <div class="modal-overlay" @click.self="emit('cancel')">
    <div class="modal group-delete-modal" role="dialog" aria-modal="true" aria-label="删除分组">
      <h3 class="modal-title">删除分组「{{ group.name }}」</h3>
      <p class="modal-sub">选择删除方式，确认后不可直接撤回。</p>

      <div class="mode-list">
        <button
          type="button"
          class="mode-option"
          :class="{ active: mode === 'dissolve' }"
          @click="mode = 'dissolve'"
        >
          <span class="mode-title">仅解散</span>
          <span class="mode-desc">会话保留，回到「未分组」</span>
        </button>

        <button
          v-if="sessions.length > 0"
          type="button"
          class="mode-option danger"
          :class="{ active: mode === 'trash' }"
          :disabled="!canTrash"
          @click="mode = 'trash'"
        >
          <span class="mode-title">连同 {{ sessions.length }} 个会话一起移入回收站</span>
          <span class="mode-desc">7 天内可在回收站恢复</span>
        </button>
      </div>

      <p v-if="!trashEnabled && sessions.length > 0" class="trash-hint">
        回收站暂未启用，当前只能选择「仅解散」。
      </p>
      <p v-if="blocked.length" class="blocked-hint">
        第二项不可用：{{ blockedText }}。请先停止执行或解绑外部群。
      </p>
      <p v-else-if="sessions.length === 0" class="empty-hint">空分组只能解散。</p>
      <p v-if="error" class="error-hint">{{ error }}</p>

      <div class="modal-actions">
        <button type="button" class="btn-cancel" @click="emit('cancel')">取消</button>
        <button
          type="button"
          class="btn-confirm"
          :class="{ danger: mode === 'trash' }"
          :disabled="submitting || (mode === 'trash' && !canTrash)"
          @click="emit('confirm', mode)"
        >
          {{ submitting ? '处理中…' : mode === 'trash' ? '删除分组并移入回收站' : '仅解散' }}
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
  width: 420px;
  max-width: calc(100vw - 32px);
  padding: 20px 22px;
  box-shadow: var(--shadow-lg);
}

.modal-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.modal-sub {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-muted);
}

.mode-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 16px;
}

.mode-option {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-base);
  text-align: left;
  cursor: pointer;
  font-family: inherit;
  transition:
    border-color var(--ease-out),
    background var(--ease-out);
}

.mode-option:hover:not(:disabled) {
  border-color: var(--border-default);
  background: var(--bg-hover);
}

.mode-option.active {
  border-color: var(--accent-text);
  background: var(--accent-soft);
}

.mode-option.danger.active {
  border-color: var(--accent-red);
}

.mode-option:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.mode-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}

.mode-desc {
  font-size: 11px;
  color: var(--text-muted);
}

.blocked-hint,
.empty-hint,
.trash-hint {
  margin-top: 10px;
  font-size: 11px;
  line-height: 1.5;
}

.blocked-hint {
  color: var(--accent-red);
}

.empty-hint,
.trash-hint {
  color: var(--text-muted);
}

.error-hint {
  margin-top: 8px;
  font-size: 12px;
  color: var(--accent-red);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 20px;
}

.btn-cancel,
.btn-confirm {
  padding: 7px 16px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: all var(--ease-out);
}

.btn-cancel {
  border: 1px solid var(--border-default);
  background: transparent;
  color: var(--text-secondary);
}

.btn-cancel:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.btn-confirm {
  border: 1px solid var(--accent-text);
  background: var(--accent-soft);
  color: var(--accent-text);
}

.btn-confirm.danger {
  border-color: var(--accent-red);
  background: var(--accent-red);
  color: #fff;
}

.btn-confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
