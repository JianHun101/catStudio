<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import type { GroupedSession, SessionGroup } from '@/composables/useApi'

/**
 * 会话行唯一的 `⋯` 菜单：`移动到分组 ›` / `移入回收站`（T3 票面）。
 *
 * 两个关键行为：
 * 1. **侧框离开即收**：主菜单项与侧框之间有 6px 间隙，无宽限会在跨越时闪一下，故
 *    指针离开后留 160ms；期间进入侧框即取消。主菜单**不跟着关**——收起侧框只是
 *    「这次不改分组了」，不是退出操作菜单。
 * 2. **点击也能开**（触屏兜底）：点「移动到分组」切换侧框，不必悬停。
 *
 * 定位用 `position: fixed`：左栏 `.panel-left` / `.panel-inner` 都是 `overflow: hidden`，
 * 绝对定位的侧框会被裁掉。fixed 元素不受无 transform 祖先的 overflow 裁剪。
 */
const props = withDefaults(
  defineProps<{
    session: GroupedSession
    groups: SessionGroup[]
    /**
     * 回收站接线是否就绪（T4 起生产恒 true）。默认 **false**（fail-safe）：漏传时
     * 藏起危险动作，而不是放行；要显式打开。
     */
    trashEnabled?: boolean
  }>(),
  { trashEnabled: false }
)

const emit = defineEmits<{
  (e: 'move', groupId: string | null): void
  (e: 'trash'): void
}>()

/** 侧框收起宽限（覆盖 6px 主/侧间隙的跨越）；测试按 160ms 推进假时钟 */
const SUBMENU_GRACE_MS = 160

const rootEl = ref<HTMLElement | null>(null)
const triggerEl = ref<HTMLElement | null>(null)
const menuEl = ref<HTMLElement | null>(null)
const moveItemEl = ref<HTMLElement | null>(null)
const open = ref(false)
const subOpen = ref(false)
const menuStyle = ref<Record<string, string>>({})
const submenuStyle = ref<Record<string, string>>({})
let closeTimer: ReturnType<typeof setTimeout> | null = null

/** 目标组：当前所在组不出现（选自己 = 无操作） */
const moveTargets = computed(() =>
  props.groups.filter((g) => g.id !== (props.session.groupId ?? null))
)
/** 未分组会话不出现多余的「未分组」目标 */
const showUngroupedTarget = computed(() => !!props.session.groupId)

function placeMenu(): void {
  const rect = triggerEl.value?.getBoundingClientRect()
  if (!rect) return
  const width = 168
  const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
  menuStyle.value = { top: `${rect.bottom + 4}px`, left: `${left}px`, width: `${width}px` }
}

function placeSubmenu(): void {
  const itemRect = moveItemEl.value?.getBoundingClientRect()
  const menuRect = menuEl.value?.getBoundingClientRect()
  if (!itemRect || !menuRect) return
  const width = 168
  // 与主菜单面板留 6px 视觉间隙（不用 move item 的右缘——它被菜单 4px padding 内缩）
  submenuStyle.value = {
    top: `${itemRect.top}px`,
    left: `${Math.min(menuRect.right + 6, window.innerWidth - width - 8)}px`,
    width: `${width}px`,
  }
}

function clearCloseTimer(): void {
  if (closeTimer !== null) {
    clearTimeout(closeTimer)
    closeTimer = null
  }
}

function closeAll(): void {
  clearCloseTimer()
  open.value = false
  subOpen.value = false
  unbindGlobal()
}

function onDocPointerDown(e: Event): void {
  // 主菜单与侧框都是本组件 DOM 的后代（fixed 只影响定位，不影响节点归属）
  if (rootEl.value?.contains(e.target as Node)) return
  closeAll()
}

function onViewportChange(): void {
  // 菜单坐标来自点击时的 getBoundingClientRect；滚动/缩放后不再对齐，直接收起
  closeAll()
}

function bindGlobal(): void {
  document.addEventListener('pointerdown', onDocPointerDown, true)
  window.addEventListener('scroll', onViewportChange, true)
  window.addEventListener('resize', onViewportChange)
}

function unbindGlobal(): void {
  document.removeEventListener('pointerdown', onDocPointerDown, true)
  window.removeEventListener('scroll', onViewportChange, true)
  window.removeEventListener('resize', onViewportChange)
}

function toggleMenu(): void {
  if (open.value) {
    closeAll()
    return
  }
  open.value = true
  placeMenu()
  bindGlobal()
}

function openSubmenu(): void {
  clearCloseTimer()
  subOpen.value = true
  placeSubmenu()
}

function scheduleCloseSubmenu(): void {
  clearCloseTimer()
  closeTimer = setTimeout(() => {
    subOpen.value = false
    closeTimer = null
  }, SUBMENU_GRACE_MS)
}

function toggleSubmenu(): void {
  if (subOpen.value) {
    clearCloseTimer()
    subOpen.value = false
    return
  }
  openSubmenu()
}

function pickMove(groupId: string | null): void {
  emit('move', groupId)
  closeAll()
}

function pickTrash(): void {
  if (!props.trashEnabled) return
  emit('trash')
  closeAll()
}

onBeforeUnmount(() => {
  clearCloseTimer()
  unbindGlobal()
})
</script>

<template>
  <div ref="rootEl" class="session-actions" @click.stop>
    <button
      ref="triggerEl"
      type="button"
      class="row-more"
      title="更多操作"
      aria-label="更多操作"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="toggleMenu"
    >
      <span aria-hidden="true">⋯</span>
    </button>

    <div v-if="open" ref="menuEl" class="row-menu" role="menu" :style="menuStyle">
      <div
        ref="moveItemEl"
        class="menu-item move-item"
        role="menuitem"
        aria-haspopup="menu"
        :aria-expanded="subOpen"
        @mouseenter="openSubmenu"
        @mouseleave="scheduleCloseSubmenu"
        @click="toggleSubmenu"
      >
        <span>移动到分组</span>
        <span class="menu-chevron" aria-hidden="true">›</span>
      </div>
      <div
        class="menu-item danger"
        :class="{ disabled: !trashEnabled }"
        role="menuitem"
        :aria-disabled="!trashEnabled"
        :title="trashEnabled ? undefined : '回收站暂未启用'"
        @click="pickTrash"
      >
        移入回收站
      </div>

      <div
        v-if="subOpen"
        class="submenu"
        role="menu"
        aria-label="选择分组"
        :style="submenuStyle"
        @mouseenter="clearCloseTimer"
        @mouseleave="scheduleCloseSubmenu"
      >
        <div
          v-for="g in moveTargets"
          :key="g.id"
          class="submenu-item"
          role="menuitem"
          @click="pickMove(g.id)"
        >
          {{ g.name }}
        </div>
        <div
          v-if="showUngroupedTarget"
          class="submenu-item"
          role="menuitem"
          @click="pickMove(null)"
        >
          未分组
        </div>
        <div v-if="moveTargets.length === 0 && !showUngroupedTarget" class="submenu-empty">
          暂无其他分组
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.session-actions {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
}

.row-more {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-muted);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  transition: all var(--ease-out);
}

.row-more:hover,
.row-more[aria-expanded='true'] {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.row-menu,
.submenu {
  position: fixed;
  z-index: 900;
  padding: 4px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-raised);
  box-shadow: var(--shadow-lg);
}

.menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}

.menu-item:hover,
.menu-item[aria-expanded='true'] {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.menu-item.danger {
  color: var(--accent-red);
}

.menu-item.danger:hover {
  background: var(--accent-soft);
}

.menu-item.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.menu-item.disabled:hover {
  background: transparent;
  color: var(--accent-red);
}

.menu-chevron {
  color: var(--text-muted);
  font-size: 13px;
}

.submenu-item {
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.submenu-item:hover {
  background: var(--accent-soft);
  color: var(--text-primary);
}

.submenu-empty {
  padding: 7px 10px;
  color: var(--text-muted);
  font-size: 12px;
}
</style>
