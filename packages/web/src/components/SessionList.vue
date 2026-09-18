<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useChatStore } from '@/stores/chat'
import SessionCreateModal from './SessionCreateModal.vue'
import { createLogger } from '@/utils/logger'

const log = createLogger('SessionList')

defineProps<{
  collapsed?: boolean
}>()

const emit = defineEmits<{
  expand: []
}>()

const store = useChatStore()
const showCreate = ref(false)

function closeCreate(): void {
  showCreate.value = false
  store.fetchData(true) // 创建会话后刷新列表（force：dataReady 已就绪，不 force 会静默失效）
}

onMounted(() => {
  store.fetchData()
})

/**
 * 归档 / 取消归档（用户态「删除」= 归档，spec §4.1）。
 * **不要二次确认**：归档是可逆的（数据全留 + 一键取消归档），给可逆操作加确认弹窗
 * 只会训练用户无脑点「确定」——确认框留给不可逆操作。
 */
async function handleArchive(id: string, archived: boolean): Promise<void> {
  try {
    await store.setArchived(id, archived)
  } catch (err) {
    log.error(archived ? '归档失败' : '取消归档失败', { error: String(err) })
  }
}
</script>

<template>
  <!-- Collapsed: icon column（参考 Claude Desktop） -->
  <div v-if="collapsed" class="session-list-collapsed">
    <button class="collapsed-icon collapsed-brand" title="展开会话列表" @click="emit('expand')">
      🐾
    </button>

    <div class="collapsed-sessions">
      <button
        v-for="s in store.sessions"
        :key="s.id"
        class="collapsed-session-btn"
        :class="{ active: store.activeSessionId === s.id }"
        :title="s.title"
        @click="store.joinSession(s.id)"
      >
        <span class="collapsed-session-icon">💬</span>
        <span
          v-if="store.unreadCounts.get(s.id) && store.activeSessionId !== s.id"
          class="collapsed-unread"
        ></span>
      </button>
    </div>

    <button class="collapsed-icon collapsed-add" title="新建会话" @click="showCreate = true">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
      </svg>
    </button>

    <SessionCreateModal v-if="showCreate" @close="closeCreate" />
  </div>

  <!-- Expanded: full session list -->
  <div v-else class="session-list">
    <!-- Brand -->
    <div class="brand">
      <span class="brand-icon">🐾</span>
      <div class="brand-text">
        <h1>CatStudio</h1>
        <p>CatStudio 多 Agent 对话</p>
      </div>
    </div>

    <!-- Sessions -->
    <div class="section">
      <div class="section-header">
        <span>会话</span>
        <span class="section-header-right">
          <span class="section-count" v-if="store.sessions.length">{{
            store.sessions.length
          }}</span>
          <!-- 「显示已归档」开关（spec §4.1）：归档会话默认从列表隐藏 -->
          <button
            class="btn-toggle-archived"
            :class="{ active: store.showArchived }"
            :aria-pressed="store.showArchived"
            :title="store.showArchived ? '隐藏已归档会话' : '显示已归档会话'"
            @click="store.setShowArchived(!store.showArchived)"
          >
            <span>已归档</span>
          </button>
          <!-- 新建会话：标题行右侧（图1「添加成员」范式），不再占底部 footer -->
          <button
            class="btn-new-session-header"
            title="新建会话"
            aria-label="新建会话"
            @click="showCreate = true"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path
                d="M8 3v10M3 8h10"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
              />
            </svg>
            <span>新建</span>
          </button>
        </span>
      </div>

      <!-- 等待服务器启动（health check 轮询中） -->
      <div v-if="store.waitingForServer" class="status-box">
        <span class="status-spinner"></span>
        <p>等待服务器启动…</p>
        <p class="hint">后端正在初始化，请稍候</p>
      </div>

      <!-- 加载中 -->
      <div v-else-if="store.loading" class="status-box">
        <span class="status-spinner"></span>
        <p>加载数据中…</p>
        <p class="hint">正在获取会话列表</p>
      </div>

      <!-- 加载失败 -->
      <div v-else-if="store.dataError" class="status-box status-error">
        <span class="status-icon">⚠️</span>
        <p>数据加载失败</p>
        <p class="hint">{{ store.dataError }}</p>
        <button class="btn-retry" @click="store.fetchData(true)">重试</button>
      </div>

      <!-- 正常会话列表 -->
      <div v-else class="session-items">
        <div v-for="s in store.sessions" :key="s.id" class="session-row">
          <button
            class="session-item"
            :class="{ active: store.activeSessionId === s.id, archived: !!s.archivedAt }"
            @click="store.joinSession(s.id)"
          >
            <div class="session-body">
              <span class="session-title">{{ s.title }}</span>
              <span class="session-meta"
                >{{ s.agentIds.length }} 只猫咪<span
                  v-if="s.archivedAt"
                  class="session-archived-tag"
                >
                  · 已归档</span
                ></span
              >
            </div>
            <span
              v-if="store.unreadCounts.get(s.id) && store.activeSessionId !== s.id"
              class="unread-badge"
              >{{ store.unreadCounts.get(s.id)! > 99 ? '99+' : store.unreadCounts.get(s.id) }}</span
            >
          </button>
          <!-- 归档 / 取消归档：**取代**了原来的 🗑️ 物理删除按钮（spec §4.1 用户故事 7
               「删除会话 = 归档」，产品决策 = 用户态删除的唯一形态是归档）。
               `DELETE /api/sessions/:id` 后端照旧（票 8 管它的 RESTRICT/409 契约），只是
               前端不再提供一键永久删除的入口——要恢复就是把这个按钮换回 delete 那版。
               归档行在「显示已归档」开启时才上屏，故按钮语义随状态二分。 -->
          <button
            class="session-archive"
            :class="{ archived: !!s.archivedAt }"
            :title="s.archivedAt ? '取消归档' : '归档会话'"
            tabindex="-1"
            @click="handleArchive(s.id, !s.archivedAt)"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path
                d="M1.5 3.5h11v2h-11zM2.5 5.5v6a1 1 0 001 1h7a1 1 0 001-1v-6M5.5 8h3"
                stroke="currentColor"
                stroke-width="1.3"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </div>

        <div v-if="store.sessions.length === 0" class="empty-sessions">
          <p>还没有会话</p>
          <p class="hint">点击上方按钮创建</p>
        </div>
      </div>
    </div>

    <SessionCreateModal v-if="showCreate" @close="closeCreate" />
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

.section-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 新建会话按钮：标题行右侧小号（图1「添加成员」范式），hover 时 accent 高亮 */
.btn-new-session-header {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: all var(--ease-out);
}

.btn-new-session-header:hover {
  border-color: var(--accent-text);
  color: var(--accent-text);
  background: var(--accent-soft);
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

.session-row:hover .session-archive {
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
  position: relative;
}

.session-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 3px;
  background: var(--accent);
  border-radius: 0 2px 2px 0;
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

/* ─── Unread Badge ──────────────────────── */

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

/* ─── Archive Button ────────────────────── */

.session-archive {
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

.session-archive:hover {
  color: var(--accent-text);
  background: var(--accent-soft);
}

/* 已归档行：取消归档是「把东西拿回来」，用中性色而不是 accent——避免与归档动作抢视线 */
.session-archive.archived:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

/* 已归档行的标题压暗：与活跃会话区分开，一眼看出这行不在默认列表里 */
.session-item.archived .session-title {
  color: var(--text-muted);
}

.session-archived-tag {
  color: var(--text-muted);
}

/* ─── Archived Toggle（标题行）───────────── */

.btn-toggle-archived {
  padding: 3px 8px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 500;
  font-family: inherit;
  cursor: pointer;
  transition: all var(--ease-out);
}

.btn-toggle-archived:hover {
  border-color: var(--accent-text);
  color: var(--accent-text);
}

.btn-toggle-archived.active {
  border-color: var(--accent-text);
  color: var(--accent-text);
  background: var(--accent-soft);
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
  to {
    transform: rotate(360deg);
  }
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
  border: 1px solid var(--accent-text);
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  color: var(--accent-text);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--ease-out);
}

.btn-retry:hover {
  background: var(--accent);
  color: var(--text-on-accent);
}

.loading {
  text-align: center;
  padding: 24px;
  color: var(--text-muted);
  font-size: 12px;
}

/* ─── Collapsed Icon Column ──────────────── */

.session-list-collapsed {
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 100%;
  padding: 8px 0;
  gap: 4px;
}

.collapsed-icon {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--ease-out);
}

.collapsed-icon:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.collapsed-brand {
  font-size: 22px;
  margin-bottom: 8px;
}

.collapsed-sessions {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  width: 100%;
  padding: 0 4px;
}

.collapsed-session-btn {
  position: relative;
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--ease-out);
}

.collapsed-session-btn:hover {
  background: var(--bg-hover);
}

.collapsed-session-btn.active {
  background: var(--bg-surface);
}

.collapsed-session-btn.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 3px;
  background: var(--accent);
  border-radius: 0 2px 2px 0;
}

.collapsed-session-icon {
  font-size: 16px;
  opacity: 0.7;
}

.collapsed-unread {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent-red);
}

.collapsed-add {
  margin-top: auto;
  margin-bottom: 0;
}
</style>
