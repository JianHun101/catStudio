<script setup lang="ts">
import { computed } from 'vue'
import type { GroupedSession, SessionGroup } from '@/composables/useApi'
import { fmtSessionTime, fmtUtcFull } from '@/utils/time'
import SessionActionsMenu from './SessionActionsMenu.vue'

/**
 * 左栏的一行会话（T3）。分组区与「未分组」区共用同一个渲染单元——两处各抄一份
 * 行结构与操作菜单，必然在下次改交互时漂移。
 *
 * 行首复选框由父级的显式选择模式（`selectMode`）控制显隐；本组件负责 checked 态与事件。
 */
const props = defineProps<{
  session: GroupedSession
  active: boolean
  checked: boolean
  unread: number
  groups: SessionGroup[]
  /** 选择模式：默认 false（行首复选框不占位、不渲染 input） */
  selectMode?: boolean
  /** 回收站接线是否就绪（默认 false = fail-safe；生产由 SessionList 显式传入开关） */
  trashEnabled?: boolean
}>()

const emit = defineEmits<{
  (e: 'select'): void
  (e: 'join'): void
  (e: 'move', groupId: string | null): void
  (e: 'trash'): void
}>()

/**
 * 第二行右侧的「最后消息时间」（T6）。数据源是服务端的 `lastMessageAt`
 * （最后一条**对话消息**的 `created_at`）——**不是 `updatedAt`**：后者只在改名/改成员/
 * 压缩时变，新消息不碰它，拿来当最后回复时间会显示陈旧值。
 * 服务端只算 user/agent，系统通告（广播、重启告警）不推进时间（2026-11-15 真机反馈）；
 * 只有系统通告的会话因此没有时间可显示。
 *
 * 无消息 / 解析失败 → 不渲染时间，第二行只剩「N 只猫咪」。
 * `title` 给完整本地时间（列表行只放得下四档短格式）。
 */
const lastMessageTime = computed<{ text: string; title: string } | null>(() => {
  const raw = props.session.lastMessageAt
  if (!raw) return null
  const text = fmtSessionTime(raw, new Date())
  if (!text) return null
  return { text, title: fmtUtcFull(raw) }
})
</script>

<template>
  <div class="session-row" :class="{ selected: checked, selecting: selectMode }">
    <label class="row-check" :title="checked ? '取消选择' : '选择会话'" @click.stop>
      <!-- 默认态不渲染 input：宽度藏起来但还能被程序化勾选，等于假隐藏 -->
      <input v-if="selectMode" type="checkbox" :checked="checked" @change="emit('select')" />
    </label>
    <button
      class="session-item"
      :class="{ active }"
      :title="session.title"
      @click="selectMode ? emit('select') : emit('join')"
    >
      <div class="session-body">
        <span class="session-title-row">
          <span class="session-title">{{ session.title }}</span>
          <span v-if="unread > 0 && !active" class="unread-dot" :title="`${unread} 条未读`"></span>
        </span>
        <span class="session-meta">
          <span class="session-cats">{{ session.agentIds.length }} 只猫咪</span>
          <span v-if="lastMessageTime" class="session-time" :title="lastMessageTime.title">{{
            lastMessageTime.text
          }}</span>
        </span>
      </div>
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

/* 选择模式里勾中的整行高亮，不只靠行首小方框 */
.session-row.selected {
  background: var(--accent-soft);
}

/* 行首复选框：默认不占位，进入选择模式才展开到 22px（input 也只在模式内渲染）。 */
.row-check {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 0;
  opacity: 0;
  overflow: hidden;
  pointer-events: none;
  cursor: pointer;
  transition:
    width var(--ease-out),
    opacity var(--ease-out);
}

.session-row.selecting .row-check {
  width: 22px;
  opacity: 1;
  pointer-events: auto;
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

/* 选择模式下隐藏行尾 ⋯：整行点击已经在勾选，两个目标叠在一起会点错 */
.session-row.selecting .session-actions {
  display: none;
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
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

/* 标题行：标题省略号 + 行尾未读红点（红点不参与收缩，标题先截） */
.session-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.session-title {
  flex: 1;
  min-width: 0;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 第二行：左「N 只猫咪」、右「最后消息时间」（T6）。两端对齐靠 flex，
   不是绝对定位——时间永远不会压到左侧文字上，窄栏里左侧先省略。 */
.session-meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 1px;
}

.session-cats {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.session-time {
  flex: none;
  color: var(--text-muted);
  white-space: nowrap;
}

/* 未读：只留 6px 红点（条数进 hover 提示），不再和日期抢第二行的位置 */
.unread-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent-red);
  margin-right: 2px;
}

@media (prefers-reduced-motion: reduce) {
  .row-check {
    transition: none;
  }
}
</style>
