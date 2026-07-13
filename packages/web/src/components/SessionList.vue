<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useChatStore } from '@/stores/chat'
import SessionCreateModal from './SessionCreateModal.vue'

const store = useChatStore()
const showCreate = ref(false)

onMounted(() => {
  store.fetchData()
})

async function handleDelete(id: string): Promise<void> {
  if (!confirm('确定要删除这个会话吗？消息将被永久删除。')) return
  try {
    await store.deleteSession(id)
  } catch (err) {
    console.error('[SessionList] 删除失败:', err)
  }
}
</script>

<template>
  <div class="session-list">
    <!-- Brand -->
    <div class="brand">
      <span class="brand-icon">🐾</span>
      <div class="brand-text">
        <h1>CatStudy</h1>
        <p>猫咖多 Agent 对话</p>
      </div>
    </div>

    <!-- Sessions -->
    <div class="section">
      <div class="section-header">
        <span>会话</span>
        <span class="section-count" v-if="store.sessions.length">{{ store.sessions.length }}</span>
      </div>

      <!-- 加载中 -->
      <div v-if="store.loading" class="status-box">
        <span class="status-spinner"></span>
        <p>连接服务器中…</p>
        <p class="hint">等待后端启动</p>
      </div>

      <!-- 加载失败（服务器未就绪或网络错误） -->
      <div v-else-if="store.dataError" class="status-box status-error">
        <span class="status-icon">⚠️</span>
        <p>无法连接服务器</p>
        <p class="hint">{{ store.dataError }}</p>
        <button class="btn-retry" @click="store.fetchData()">重试</button>
      </div>

      <!-- 正常会话列表 -->
      <div v-else class="session-items">
        <div
          v-for="s in store.sessions"
          :key="s.id"
          class="session-row"
        >
          <button
            class="session-item"
            :class="{ active: store.activeSessionId === s.id }"
            @click="store.joinSession(s.id)"
          >
            <span class="session-icon">💬</span>
            <div class="session-body">
              <span class="session-title">{{ s.title }}</span>
              <span class="session-meta">{{ s.agentIds.length }} 只猫咪</span>
            </div>
          </button>
          <button
            class="session-delete"
            title="删除会话"
            @click="handleDelete(s.id)"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M2 4h10M5 4V3a1 1 0 011-1h2a1 1 0 011 1v1M11 4v7a1 1 0 01-1 1H4a1 1 0 01-1-1V4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>

        <div v-if="store.sessions.length === 0" class="empty-sessions">
          <p>还没有会话</p>
          <p class="hint">点击下方按钮创建</p>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <div class="panel-footer">
      <button class="btn-new-session" @click="showCreate = true">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
        </svg>
        <span>新建会话</span>
      </button>
    </div>

    <SessionCreateModal v-if="showCreate" @close="showCreate = false; store.fetchData()" />
  </div>
</template>

<style scoped>
.session-list {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* ─── Brand ─────────────────────────────── */

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 20px 18px 16px;
  border-bottom: 1px solid var(--border-subtle);
}

.brand-icon {
  font-size: 28px;
  line-height: 1;
}

.brand-text h1 {
  font-size: 16px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: -0.3px;
}

.brand-text p {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 1px;
}

/* ─── Section ───────────────────────────── */

.section {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 12px 10px;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.6px;
}

.section-count {
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 10px;
  font-weight: 500;
}

.session-items {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* ─── Session Row ───────────────────────── */

.session-row {
  display: flex;
  align-items: stretch;
  border-radius: var(--radius-md);
  transition: background var(--ease-out);
}

.session-row:hover {
  background: var(--bg-hover);
}

.session-row:hover .session-delete {
  opacity: 1;
}

.session-item {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 10px;
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

.session-item.active {
  background: var(--bg-surface);
  color: var(--text-primary);
  box-shadow: var(--shadow-sm);
}

.session-icon {
  font-size: 18px;
  flex-shrink: 0;
  opacity: 0.7;
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

/* ─── Delete Button ─────────────────────── */

.session-delete {
  flex-shrink: 0;
  width: 32px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  opacity: 0;
  transition: all var(--ease-out);
  display: flex;
  align-items: center;
  justify-content: center;
}

.session-delete:hover {
  color: var(--accent-red);
  background: rgba(224, 85, 106, 0.12);
}

/* ─── Empty State ───────────────────────── */

.empty-sessions {
  text-align: center;
  padding: 32px 16px;
  color: var(--text-muted);
  font-size: 13px;
}

.empty-sessions .hint {
  font-size: 11px;
  margin-top: 4px;
  opacity: 0.7;
}

/* ─── Footer ────────────────────────────── */

.panel-footer {
  padding: 12px 14px;
  border-top: 1px solid var(--border-subtle);
}

.btn-new-session {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 9px;
  border: 1px dashed var(--border-default);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--ease-out);
}

.btn-new-session:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}

/* ─── Status Box ─────────────────────────── */

.status-box {
  text-align: center;
  padding: 32px 16px;
  color: var(--text-muted);
  font-size: 13px;
}

.status-box .hint {
  font-size: 11px;
  opacity: 0.7;
  margin-top: 4px;
}

.status-spinner {
  display: inline-block;
  width: 24px;
  height: 24px;
  border: 2px solid var(--border-default);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin-bottom: 12px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.status-icon {
  font-size: 28px;
  display: block;
  margin-bottom: 8px;
}

.status-error {
  color: var(--accent-red);
}

.status-error .hint {
  color: var(--text-muted);
  max-width: 200px;
  margin: 4px auto 12px;
  word-break: break-all;
}

.btn-retry {
  padding: 6px 18px;
  border: 1px solid var(--accent);
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--ease-out);
}

.btn-retry:hover {
  background: var(--accent);
  color: var(--bg-deep);
}

.loading {
  text-align: center;
  padding: 24px;
  color: var(--text-muted);
  font-size: 12px;
}
</style>
