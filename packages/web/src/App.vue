<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import SessionList from './components/SessionList.vue'
import ChatPanel from './components/ChatPanel.vue'
import AgentPanel from './components/AgentPanel.vue'

/** User manually toggled sidebars — once set, auto-hide on narrow windows respects
 *  explicit choice and won't auto-show when the window widens again. */
const leftOpen = ref(true)
const rightOpen = ref(true)
const userToggledLeft = ref(false)
const userToggledRight = ref(false)

function toggleLeft(): void {
  leftOpen.value = !leftOpen.value
  userToggledLeft.value = true
}

function toggleRight(): void {
  rightOpen.value = !rightOpen.value
  userToggledRight.value = true
}

// Media queries for responsive auto-collapse
let narrowMq: MediaQueryList | undefined
let mobileMq: MediaQueryList | undefined

function onNarrow(e: MediaQueryListEvent | MediaQueryList): void {
  if (!userToggledRight.value) {
    rightOpen.value = !e.matches
  }
}
function onMobile(e: MediaQueryListEvent | MediaQueryList): void {
  if (!userToggledLeft.value) {
    leftOpen.value = !e.matches
  }
}

onMounted(() => {
  narrowMq = window.matchMedia('(max-width: 1000px)')
  mobileMq = window.matchMedia('(max-width: 650px)')

  onNarrow(narrowMq)
  onMobile(mobileMq)

  narrowMq.addEventListener('change', onNarrow)
  mobileMq.addEventListener('change', onMobile)
})

onUnmounted(() => {
  narrowMq?.removeEventListener('change', onNarrow)
  mobileMq?.removeEventListener('change', onMobile)
})
</script>

<template>
  <div class="app-layout" :class="{ 'left-closed': !leftOpen, 'right-closed': !rightOpen }">
    <!-- Left sidebar: collapse-tab always visible as a handle, content hidden when closed -->
    <aside class="panel-left" :class="{ closed: !leftOpen }">
      <button
        class="collapse-tab"
        @click="toggleLeft"
        :title="leftOpen ? '收起会话列表' : '展开会话列表'"
      >
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
          <path v-if="leftOpen" d="M9 3L5 7l4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
          <path v-else d="M5 3l4 4-4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      <div class="panel-inner">
        <SessionList />
      </div>
    </aside>

    <main class="panel-center">
      <ChatPanel />
    </main>

    <!-- Right sidebar: same pattern -->
    <aside class="panel-right" :class="{ closed: !rightOpen }">
      <button
        class="collapse-tab"
        @click="toggleRight"
        :title="rightOpen ? '收起 Agent 面板' : '展开 Agent 面板'"
      >
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
          <path v-if="rightOpen" d="M5 3l4 4-4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
          <path v-else d="M9 3L5 7l4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      <div class="panel-inner">
        <AgentPanel />
      </div>
    </aside>
  </div>
</template>

<style scoped>
/* ─── Layout Grid ────────────────────────── */

.app-layout {
  display: grid;
  grid-template-columns: 260px 1fr 300px;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  transition: grid-template-columns 0.25s ease;
}

.app-layout.left-closed {
  grid-template-columns: 6px 1fr 300px;
}

.app-layout.right-closed {
  grid-template-columns: 260px 1fr 6px;
}

.app-layout.left-closed.right-closed {
  grid-template-columns: 6px 1fr 6px;
}

/* ─── Panels ─────────────────────────────── */

.panel-left,
.panel-right {
  position: relative;
  background: var(--bg-base);
  display: flex;
  flex-direction: column;
  overflow: hidden; /* clip content when column shrinks */
}

/* When closed: allow collapse-tab to overflow the 6px column so it's clickable */
.panel-left.closed,
.panel-right.closed {
  overflow: visible;
}

.panel-left {
  border-right: 1px solid var(--border-subtle);
}

.panel-right {
  border-left: 1px solid var(--border-subtle);
}

.panel-center {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-deep);
}

/* Panel inner — content wrapper, hidden when closed */
.panel-inner {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
  opacity: 1;
  transition: opacity 0.15s ease;
}

.panel-left.closed .panel-inner,
.panel-right.closed .panel-inner {
  opacity: 0;
  pointer-events: none;
  overflow: hidden;
}

/* ─── Collapse Tab (edge handle) ─────────── */

.collapse-tab {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 40;
  width: 16px;       /* wider invisible hit-area when panel is open */
  height: 56px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  opacity: 0;         /* hidden by default when panel is open */
  pointer-events: none;
  transition:
    opacity 0.2s ease,
    width 0.18s ease,
    background 0.18s ease,
    color 0.18s ease;
}

/* Left panel: tab on the right edge */
.panel-left .collapse-tab {
  right: 0;
  border-radius: 4px 0 0 4px;
}

/* Right panel: tab on the left edge */
.panel-right .collapse-tab {
  left: 0;
  border-radius: 0 4px 4px 0;
}

.collapse-tab svg {
  opacity: 0;
  transition: opacity 0.15s ease;
  flex-shrink: 0;
}

/* ─── Open panel: tab appears only on hover of the edge ─── */

.panel-left:not(.closed) .collapse-tab:hover,
.panel-right:not(.closed) .collapse-tab:hover {
  opacity: 1;
  pointer-events: auto;
  width: 24px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  color: var(--text-secondary);
}

.panel-left:not(.closed) .collapse-tab:hover svg,
.panel-right:not(.closed) .collapse-tab:hover svg {
  opacity: 1;
}

/* ─── Closed panel: tab always visible as a restore handle ─── */

.panel-left.closed .collapse-tab,
.panel-right.closed .collapse-tab {
  opacity: 1;
  pointer-events: auto;
  width: 24px;
  background: var(--bg-surface);
  color: var(--text-secondary);
  border: 1px solid var(--border-default);
}

.panel-left.closed .collapse-tab svg,
.panel-right.closed .collapse-tab svg {
  opacity: 1;
}

.panel-left.closed .collapse-tab:hover,
.panel-right.closed .collapse-tab:hover {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--bg-hover);
}
</style>
