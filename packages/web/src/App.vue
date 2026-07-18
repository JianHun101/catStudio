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
    <aside class="panel-left" :class="{ closed: !leftOpen }">
      <div class="panel-inner">
        <SessionList />
      </div>
    </aside>

    <!--
      Toggle buttons live in the center panel as thin edge strips.
      This avoids position:absolute overlap with sidebar content (delete buttons)
      and ensures the restore handle is always findable — no 6px invisible strips.
    -->
    <main class="panel-center">
      <button
        class="edge-toggle edge-toggle-left"
        @click="toggleLeft"
        :title="leftOpen ? '收起会话列表' : '展开会话列表'"
      >
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
          <path
            v-if="leftOpen"
            d="M9 3L5 7l4 4"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <path
            v-else
            d="M5 3l4 4-4 4"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>

      <div class="center-content">
        <ChatPanel />
      </div>

      <button
        class="edge-toggle edge-toggle-right"
        @click="toggleRight"
        :title="rightOpen ? '收起 Agent 面板' : '展开 Agent 面板'"
      >
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
          <path
            v-if="rightOpen"
            d="M5 3l4 4-4 4"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <path
            v-else
            d="M9 3L5 7l4 4"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </main>

    <aside class="panel-right" :class="{ closed: !rightOpen }">
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
  grid-template-columns: 0px 1fr 300px;
}

.app-layout.right-closed {
  grid-template-columns: 260px 1fr 0px;
}

.app-layout.left-closed.right-closed {
  grid-template-columns: 0px 1fr 0px;
}

/* ─── Panels ─────────────────────────────── */

.panel-left,
.panel-right {
  background: var(--bg-base);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.panel-left {
  border-right: 1px solid var(--border-subtle);
}

.panel-right {
  border-left: 1px solid var(--border-subtle);
}

.panel-center {
  display: flex;
  flex-direction: row;
  overflow: hidden;
  background: var(--bg-deep);
}

.center-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

/* Panel inner — hidden when closed */
.panel-inner {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
}

.panel-left.closed .panel-inner,
.panel-right.closed .panel-inner {
  display: none;
}

/* ─── Edge Toggle Buttons ────────────────── */
/*
 * Thin strips at the left/right edges of the center panel.
 * Default 6px — barely visible, like a divider line.
 * Hover expands to 24px showing the chevron.
 * These live in the center panel so they NEVER overlap sidebar content
 * (delete buttons, session list, agent cards) and are ALWAYS findable
 * when a sidebar is collapsed.
 */

.edge-toggle {
  flex-shrink: 0;
  width: 6px;
  border: none;
  background: transparent;
  color: transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition:
    width 0.15s ease,
    background 0.15s ease,
    color 0.15s ease,
    border-color 0.15s ease;
}

.edge-toggle svg {
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.12s ease;
}

/* ─── Left toggle: between left panel and center content ─── */

.edge-toggle-left {
  border-right: 1px solid transparent;
}

.edge-toggle-left:hover {
  width: 24px;
  background: var(--bg-surface);
  color: var(--accent);
  border-right-color: var(--border-default);
}

.edge-toggle-left:hover svg {
  opacity: 1;
}

/* ─── Right toggle: between center content and right panel ─── */

.edge-toggle-right {
  border-left: 1px solid transparent;
}

.edge-toggle-right:hover {
  width: 24px;
  background: var(--bg-surface);
  color: var(--accent);
  border-left-color: var(--border-default);
}

.edge-toggle-right:hover svg {
  opacity: 1;
}

/* ─── Chevron direction hint when collapsed ─── */
/* When sidebar is closed, show a faint chevron so the user knows it's there */

.app-layout.left-closed .edge-toggle-left svg,
.app-layout.right-closed .edge-toggle-right svg {
  opacity: 0.45;
}

.app-layout.left-closed .edge-toggle-left,
.app-layout.right-closed .edge-toggle-right {
  color: var(--text-muted);
}
</style>
