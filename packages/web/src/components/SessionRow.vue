<script setup lang="ts">
import type { GroupedSession, SessionGroup } from '@/composables/useApi'
import SessionActionsMenu from './SessionActionsMenu.vue'

/**
 * 左栏的一行会话（T3）。分组区与「未分组」区共用同一个渲染单元——两处各抄一份
 * 行结构与操作菜单，必然在下次改交互时漂移。
 *
 * 行首复选框由父级控制显隐（悬停/已选），本组件只负责 checked 态与事件。
 */
defineProps<{
  session: GroupedSession
  active: boolean
  checked: boolean
  unread: number
  groups: SessionGroup[]
  /** 回收站接线是否就绪（默认 false = fail-safe；生产由 SessionList 显式传入开关） */
  trashEnabled?: boolean
}>()

const emit = defineEmits<{
  (e: 'select'): void
  (e: 'join'): void
  (e: 'move', groupId: string | null): void
  (e: 'trash'): void
}>()
</script>

<template>
  <div class="session-row" :class="{ selected: checked }">
    <label class="row-check" :title="checked ? '取消选择' : '选择会话'" @click.stop>
      <input type="checkbox" :checked="checked" @change="emit('select')" />
    </label>
    <button class="session-item" :class="{ active }" :title="session.title" @click="emit('join')">
      <div class="session-body">
        <span class="session-title">{{ session.title }}</span>
        <span class="session-meta">{{ session.agentIds.length }} 只猫咪</span>
      </div>
      <span v-if="unread > 0 && !active" class="unread-badge">{{
        unread > 99 ? '99+' : unread
      }}</span>
    </button>
    <SessionActionsMenu
      :session="session"
      :groups="groups"
      :trash-enabled="trashEnabled"
      @move="emit('move', $event)"
      @trash="emit('trash')"
    />
  </div>
</template>

<style scoped>
.session-row {
  display: flex;
  align-items: stretch;
  border-radius: var(--radius-md);
  transition: background var(--ease-out);
}

.session-row:hover {
  background: var(--bg-hover);
}

/* 行首复选框：悬停 / 已选时才出现（spec §4.4：悬停行首出复选框） */
.row-check {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  opacity: 0;
  cursor: pointer;
  transition: opacity var(--ease-out);
}

.session-row:hover .row-check,
.session-row.selected .row-check {
  opacity: 1;
}

/* 触屏无 hover：复选框恒显，否则没有可点入口 */
@media (hover: none) {
  .row-check {
    opacity: 1;
  }
}

/* 行操作 ⋯：悬停整行才亮（`.session-actions` 是 SessionActionsMenu 的根节点，
   带本组件的 scope 标记，故这条规则写在这里而不是祖父级 SessionList）。
   触屏无 hover：媒体查询不生效，按钮恒显，避免没有悬停入口。 */
@media (hover: hover) {
  .session-actions {
    opacity: 0;
    transition: opacity var(--ease-out);
  }

  .session-row:hover .session-actions,
  .session-row.selected .session-actions,
  .session-actions:focus-within {
    opacity: 1;
  }
}

.row-check input {
  width: 13px;
  height: 13px;
  accent-color: var(--accent);
  cursor: pointer;
}

.session-item {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 6px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: all var(--ease-out);
  min-width: 0;
}

.session-item:hover {
  color: var(--text-primary);
}

/* 选中态：只留 accent 淡底 + 文字加深（左缘竖条已退役，不新增替代线）。 */
.session-item.active {
  background: var(--accent-soft);
  color: var(--text-primary);
}

.session-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.session-title {
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-meta {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 1px;
}

.unread-badge {
  flex-shrink: 0;
  min-width: 20px;
  height: 18px;
  padding: 1px 6px;
  border-radius: 10px;
  background: var(--accent-red);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
  text-align: center;
  white-space: nowrap;
}
</style>
