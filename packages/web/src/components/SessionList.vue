<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useChatStore, TRASH_ENABLED, formatTrashFailures, moveActionError } from '@/stores/chat'
import { api, type GroupedSession, type SessionGroup } from '@/composables/useApi'
import SessionCreateModal from './SessionCreateModal.vue'
import SessionRow from './SessionRow.vue'
import GroupDeleteModal from './GroupDeleteModal.vue'
import { createLogger } from '@/utils/logger'

const log = createLogger('SessionList')

/**
 * 回收站接线开关的可注入副本（默认跟随 store 的 `TRASH_ENABLED`）。生产由 App 默认打开；
 * 测试可显式传 `false` 复现「T2 前删除入口全禁用」的守卫形态。
 */
const props = withDefaults(defineProps<{ trashEnabled?: boolean }>(), {
  trashEnabled: TRASH_ENABLED,
})

const emit = defineEmits<{
  (e: 'open-trash'): void
  (e: 'open-session'): void
}>()

const store = useChatStore()
const showCreate = ref(false)

/** 头行回收站入口的计数：N = 回收站条目数（整组段 + 会话段之和，不是会话总数） */
const trashCount = computed(() => store.trashEntries.length)

/** 行点击 = 用户主动切回聊天：通知 App 关掉中心区的回收站视图 */
function onRowJoin(id: string): void {
  emit('open-session')
  store.joinSession(id)
}

/**
 * 左栏 = 「分组 + 未分组」（T3 票面）。
 *
 * - 活组按 `createdAt ASC`（服务端序，再本地兜一层），「未分组」永远排最后。
 * - 组内会话沿用服务端的 `updated_at DESC`（数组原序）；**移组 / 删组都不重排**。
 * - 组头会话数按本地 `sessions` 现算，不读 `group.sessionCount`（移组后它必然过期）。
 */
interface GroupSection {
  group: SessionGroup
  sessions: GroupedSession[]
}

const sections = computed<{ groups: GroupSection[]; ungrouped: GroupedSession[] }>(() => {
  const byGroup = new Map<string, GroupedSession[]>()
  const known = new Set(store.groups.map((g) => g.id))
  const ungrouped: GroupedSession[] = []
  for (const s of store.sessions) {
    const gid = s.groupId ?? null
    if (gid && known.has(gid)) {
      const list = byGroup.get(gid)
      if (list) list.push(s)
      else byGroup.set(gid, [s])
    } else {
      // 组已被删/未知的会话落未分组：不静默丢行（服务端 ON DELETE SET NULL 兜底，这里是第二道）
      ungrouped.push(s)
    }
  }
  const groups = [...store.groups]
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    .map((group) => ({ group, sessions: byGroup.get(group.id) ?? [] }))
  return { groups, ungrouped }
})

// ─── 批量选择（组件局部态，不进 store）───────────────────────────────

const selectedIds = ref<Set<string>>(new Set())
const selecting = computed(() => selectedIds.value.size > 0)

function toggleSelect(id: string): void {
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedIds.value = next
}

function clearSelection(): void {
  selectedIds.value = new Set()
  batchMoveOpen.value = false
}

// ─── 行操作 / 组操作 ────────────────────────────────────────────────

const listError = ref('')

async function moveOne(sessionId: string, groupId: string | null): Promise<void> {
  listError.value = ''
  try {
    await store.moveSessionToGroup(sessionId, groupId)
  } catch (err: any) {
    listError.value = moveActionError(err)
  }
}

async function trashOne(sessionId: string): Promise<void> {
  listError.value = ''
  if (!props.trashEnabled) {
    listError.value = '回收站暂未启用'
    return
  }
  const failed = await store.trashSessions([sessionId], {
    enabled: props.trashEnabled,
    undo: true,
  })
  if (failed.length > 0) listError.value = failed[0]!.message
}

// ─── 分组头：折叠 / 菜单 / 重命名 ────────────────────────────────────

const openGroupMenuId = ref<string | null>(null)
const renamingGroupId = ref<string | null>(null)
const renameDraft = ref('')
const renameError = ref('')
const renameSaving = ref(false)

function toggleGroupMenu(id: string): void {
  openGroupMenuId.value = openGroupMenuId.value === id ? null : id
  batchMoveOpen.value = false
}

async function toggleCollapse(group: SessionGroup): Promise<void> {
  try {
    await store.setGroupCollapsed(group.id, !group.collapsed)
  } catch (err: any) {
    listError.value = err?.message || '折叠状态保存失败'
  }
}

function startRename(group: SessionGroup): void {
  openGroupMenuId.value = null
  renamingGroupId.value = group.id
  renameDraft.value = group.name
  renameError.value = ''
}

async function commitRename(group: SessionGroup): Promise<void> {
  const name = renameDraft.value.trim()
  if (!name) {
    renameError.value = '分组名不能为空'
    return
  }
  if (name === group.name) {
    renamingGroupId.value = null
    return
  }
  renameSaving.value = true
  renameError.value = ''
  try {
    await store.renameGroup(group.id, name)
    renamingGroupId.value = null
  } catch (err: any) {
    // 重名就地报错、输入框不关（票面验收）
    renameError.value =
      err?.body?.error === 'GROUP_NAME_TAKEN' ? '分组名已存在' : err?.message || '重命名失败'
  } finally {
    renameSaving.value = false
  }
}

// ─── 新建分组（固定在底栏）────────────────────────────────────────────

const creatingGroup = ref(false)
const newGroupName = ref('')
const createGroupError = ref('')
const createSaving = ref(false)

function startCreateGroup(): void {
  creatingGroup.value = true
  newGroupName.value = ''
  createGroupError.value = ''
}

async function submitCreateGroup(): Promise<void> {
  const name = newGroupName.value.trim()
  if (!name) {
    createGroupError.value = '请输入分组名'
    return
  }
  createSaving.value = true
  createGroupError.value = ''
  try {
    await store.createGroup(name)
    creatingGroup.value = false
    newGroupName.value = ''
  } catch (err: any) {
    createGroupError.value =
      err?.body?.error === 'GROUP_NAME_TAKEN' ? '分组名已存在' : err?.message || '新建分组失败'
  } finally {
    createSaving.value = false
  }
}

// ─── 批量归组 ───────────────────────────────────────────────────────

const batchMoveOpen = ref(false)
const batchError = ref('')

/** 打开批量归组浮层时收起组头菜单；两者互斥，不叠在一起。 */
function toggleBatchMove(): void {
  batchMoveOpen.value = !batchMoveOpen.value
  if (batchMoveOpen.value) openGroupMenuId.value = null
}

/**
 * 选中集随会话列表收敛：另一 tab 删掉已选会话后，头行不能还显示「已选 N」、
 * 批量动作也不能再对不存在的 id 发请求。
 */
watch(
  () => store.sessions.map((s) => s.id),
  (ids) => {
    if (selectedIds.value.size === 0) return
    const alive = new Set(ids)
    const next = new Set([...selectedIds.value].filter((id) => alive.has(id)))
    if (next.size === selectedIds.value.size) return
    selectedIds.value = next
    if (next.size === 0) batchMoveOpen.value = false
  }
)

async function batchMove(groupId: string | null): Promise<void> {
  batchError.value = ''
  const ids = [...selectedIds.value]
  try {
    await store.batchMoveToGroup(ids, groupId)
    clearSelection()
  } catch (err: any) {
    batchError.value = moveActionError(err)
  }
}

async function batchTrash(): Promise<void> {
  batchError.value = ''
  if (!props.trashEnabled) {
    batchError.value = '回收站暂未启用'
    return
  }
  // 批量删除不提供撤销（票面契约）：`undo` 缺省 false
  const failed = await store.trashSessions([...selectedIds.value], {
    enabled: props.trashEnabled,
  })
  clearSelection()
  if (failed.length > 0) {
    // 部分失败：成功项已移出列表，失败项保留并逐条点名（不整批回滚、不静默吞）
    const titleOf = (id: string) => store.sessions.find((s) => s.id === id)?.title ?? id
    listError.value = formatTrashFailures(failed, titleOf)
  }
}

// ─── 删组确认 ───────────────────────────────────────────────────────

const deleteTarget = ref<SessionGroup | null>(null)
const deleteError = ref('')
const deleteSubmitting = ref(false)

/** 忙碌判据与后端一致：`status==='busy' || queueLength>0`（idle 槽位仍留 sessionId，不能算忙） */
const busyIds = computed<Set<string>>(() => {
  const ids = new Set<string>()
  for (const bySession of store.agentStates.values()) {
    for (const state of bySession.values()) {
      if (state.sessionId && (state.status === 'busy' || state.queueLength > 0)) {
        ids.add(state.sessionId)
      }
    }
  }
  return ids
})

/** 绑定查询在打开确认框时现拉（唯一真相源 = connector_bindings） */
const bindingsBySession = ref<Map<string, string>>(new Map())

async function loadBindings(): Promise<void> {
  try {
    const res = await api.getConnectorBindings()
    const next = new Map<string, string>()
    for (const b of res.bindings ?? []) next.set(b.session_id, b.platform)
    bindingsBySession.value = next
  } catch (err) {
    log.error('loadBindings failed', { error: String(err) })
  }
}

const deleteSessions = computed<GroupedSession[]>(() => {
  if (!deleteTarget.value) return []
  const section = sections.value.groups.find((g) => g.group.id === deleteTarget.value!.id)
  return section?.sessions ?? []
})

const deleteBlocked = computed(() =>
  deleteSessions.value
    .filter((s) => busyIds.value.has(s.id) || bindingsBySession.value.has(s.id))
    .map((s) => ({
      id: s.id,
      title: s.title,
      reason: (busyIds.value.has(s.id) ? 'busy' : 'bound') as 'busy' | 'bound',
      platform: bindingsBySession.value.get(s.id),
    }))
)

function openDeleteGroup(group: SessionGroup): void {
  openGroupMenuId.value = null
  deleteTarget.value = group
  deleteError.value = ''
  void loadBindings()
}

async function confirmDeleteGroup(mode: 'dissolve' | 'trash'): Promise<void> {
  if (!deleteTarget.value) return
  if (mode === 'trash' && !props.trashEnabled) {
    // 防御：关闸态下第二项不可选，不允许任何路径落到删除 API
    deleteError.value = '回收站暂未启用'
    return
  }
  deleteSubmitting.value = true
  deleteError.value = ''
  try {
    const groupId = deleteTarget.value.id
    await store.deleteGroup(groupId, mode === 'trash')
    deleteTarget.value = null
    clearSelection()
  } catch (err: any) {
    const code = err?.body?.error
    deleteError.value =
      code === 'SESSION_BUSY'
        ? '有会话正在执行，本次删除已整批取消'
        : code === 'SESSION_BOUND'
          ? '有会话已绑定外部群，本次删除已整批取消'
          : err?.message || '删除分组失败'
  } finally {
    deleteSubmitting.value = false
  }
}

// ─── 浮层收起 ──────────────────────────────────────────────────────

function onDocPointerDown(e: Event): void {
  const el = e.target as Element | null
  if (!el || typeof el.closest !== 'function') return
  if (el.closest('.group-menu') || el.closest('.group-menu-trigger')) return
  if (el.closest('.batch-move') || el.closest('.batch-move-trigger')) return
  openGroupMenuId.value = null
  batchMoveOpen.value = false
}

onMounted(() => {
  store.fetchData()
  document.addEventListener('pointerdown', onDocPointerDown, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true)
})

function closeCreate(): void {
  showCreate.value = false
  store.fetchData(true) // 创建会话后刷新列表（force：dataReady 已就绪，不 force 会静默失效）
}

/**
 * 新建会话成功：关弹窗 + 刷新列表 + 通知 App 回聊天。
 * 回收站视图下左栏 `＋` 仍可见，创建成功后中心区还停在回收站会让人以为「没生效」；
 * 不要用 App watch `activeSessionId` 兜——在回收站里删掉当前会话也会改它，会误关回收站。
 */
function onSessionCreated(): void {
  showCreate.value = false
  emit('open-session')
  store.fetchData(true)
}
</script>

<template>
  <!-- 会话列表**唯一形态**。折叠态图标列已整支删除（含 prop/emit 传递链）：
       左栏收起时 `.panel-left` 整块 `display:none`（App.vue），该分支 DOM 永不可见 = 死代码。 -->
  <div class="session-list">
    <!-- 头行：48px，与主区顶栏、右栏「成员 · N」同一水平线。
         形态按 spec §4.4：`会话` + 回收站按钮（线稿图标 + 内联计数）+ `＋`。
         批量选择态整行临时变成 `已选 N ｜ 归组 ｜ 删除 ｜ 取消`。 -->
    <div class="section-header">
      <template v-if="selecting">
        <span class="section-header-label">已选 {{ selectedIds.size }}</span>
        <span class="batch-actions">
          <button
            class="batch-btn batch-move-trigger"
            :aria-expanded="batchMoveOpen"
            @click.stop="toggleBatchMove"
          >
            归组
          </button>
          <button
            class="batch-btn danger"
            :disabled="!trashEnabled"
            :title="trashEnabled ? undefined : '回收站暂未启用'"
            @click.stop="batchTrash"
          >
            删除
          </button>
          <button class="batch-btn" @click.stop="clearSelection">取消</button>
        </span>
      </template>
      <template v-else>
        <span class="section-header-label">会话</span>
        <span class="section-header-right">
          <!-- 回收站入口（T6）：15px 线稿 SVG（非 emoji），与 ＋ 同 24px 方形/边框/悬停；
               条目数内联在图标右侧（不是绝对定位角标，不压图标）；空时只有图标。 -->
          <button
            class="head-trash"
            :class="{ 'has-items': trashCount > 0 }"
            :title="trashCount > 0 ? `回收站（${trashCount} 项）` : '回收站'"
            :aria-label="trashCount > 0 ? `回收站，${trashCount} 项` : '回收站'"
            @click="emit('open-trash')"
          >
            <svg
              class="head-trash-icon"
              width="15"
              height="15"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M2.5 4.5h11M6 4.5V3.2a.7.7 0 0 1 .7-.7h2.6a.7.7 0 0 1 .7.7v1.3"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
              <path
                d="M4 4.5l.55 8.2a1 1 0 0 0 1 .9h4.9a1 1 0 0 0 1-.9L12 4.5"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
              <path
                d="M6.7 7v3.6M9.3 7v3.6"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
              />
            </svg>
            <span v-if="trashCount > 0" class="head-trash-count">{{ trashCount }}</span>
          </button>
          <!-- 新建会话：头行右侧小号 ＋（spec §4.4 头行只留 会话 / 回收站 / ＋） -->
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
          </button>
        </span>
      </template>

      <!-- 批量归组浮层（头行 sticky 定位，不占列表滚动） -->
      <div v-if="batchMoveOpen && selecting" class="batch-move" @click.stop>
        <div class="batch-move-title">移动到分组</div>
        <button
          v-for="g in store.groups"
          :key="g.id"
          class="batch-move-item"
          @click="batchMove(g.id)"
        >
          {{ g.name }}
        </button>
        <button class="batch-move-item" @click="batchMove(null)">未分组</button>
        <div v-if="store.groups.length === 0" class="batch-move-empty">
          还没有分组，先在底部新建
        </div>
      </div>
    </div>

    <!-- 操作失败提示（移组 / 删除；成功后清空） -->
    <p v-if="listError" class="list-error">
      <span>{{ listError }}</span>
      <button class="list-error-close" title="关闭" @click="listError = ''">×</button>
    </p>
    <p v-if="batchError" class="list-error">
      <span>{{ batchError }}</span>
      <button class="list-error-close" title="关闭" @click="batchError = ''">×</button>
    </p>

    <div class="section">
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

      <!-- 分组 + 未分组 -->
      <div v-else class="session-items">
        <section v-for="section in sections.groups" :key="section.group.id" class="group-section">
          <div class="group-header">
            <button
              class="group-toggle"
              :aria-expanded="!section.group.collapsed"
              :title="section.group.collapsed ? '展开分组' : '折叠分组'"
              @click="toggleCollapse(section.group)"
            >
              <span class="group-arrow" aria-hidden="true">{{
                section.group.collapsed ? '▸' : '▾'
              }}</span>
              <span class="group-name">{{ section.group.name }}</span>
              <span class="group-count">{{ section.sessions.length }}</span>
            </button>
            <button
              class="group-menu-trigger"
              title="分组操作"
              aria-label="分组操作"
              aria-haspopup="menu"
              :aria-expanded="openGroupMenuId === section.group.id"
              @click.stop="toggleGroupMenu(section.group.id)"
            >
              ⋯
            </button>

            <div
              v-if="openGroupMenuId === section.group.id"
              class="group-menu"
              role="menu"
              @click.stop
            >
              <button class="group-menu-item" role="menuitem" @click="startRename(section.group)">
                重命名分组
              </button>
              <button
                class="group-menu-item danger"
                role="menuitem"
                @click="openDeleteGroup(section.group)"
              >
                删除分组…
              </button>
            </div>
          </div>

          <!-- 重命名：就地输入，重名报错不关框 -->
          <div v-if="renamingGroupId === section.group.id" class="rename-row">
            <input
              v-model="renameDraft"
              class="rename-input"
              maxlength="24"
              placeholder="分组名（1–24 字）"
              v-focus
              @keydown.enter="commitRename(section.group)"
              @keydown.esc="renamingGroupId = null"
            />
            <button class="mini-btn" :disabled="renameSaving" @click="commitRename(section.group)">
              保存
            </button>
            <button class="mini-btn ghost" @click="renamingGroupId = null">取消</button>
            <p v-if="renameError" class="inline-error">{{ renameError }}</p>
          </div>

          <template v-if="!section.group.collapsed">
            <SessionRow
              v-for="s in section.sessions"
              :key="s.id"
              :session="s"
              :active="store.activeSessionId === s.id"
              :checked="selectedIds.has(s.id)"
              :unread="store.unreadCounts.get(s.id) ?? 0"
              :groups="store.groups"
              :trash-enabled="trashEnabled"
              @select="toggleSelect(s.id)"
              @join="onRowJoin(s.id)"
              @move="moveOne(s.id, $event)"
              @trash="trashOne(s.id)"
            />
            <div v-if="section.sessions.length === 0" class="group-empty">空分组</div>
          </template>
        </section>

        <!-- 未分组：不是真组，只作兜底容器，永远排最后；空则不渲染 -->
        <section v-if="sections.ungrouped.length > 0" class="group-section ungrouped-section">
          <div class="group-header ungrouped-header">
            <span class="group-name ungrouped-name">未分组</span>
            <span class="group-count">{{ sections.ungrouped.length }}</span>
          </div>
          <SessionRow
            v-for="s in sections.ungrouped"
            :key="s.id"
            :session="s"
            :active="store.activeSessionId === s.id"
            :checked="selectedIds.has(s.id)"
            :unread="store.unreadCounts.get(s.id) ?? 0"
            :groups="store.groups"
            :trash-enabled="trashEnabled"
            @select="toggleSelect(s.id)"
            @join="onRowJoin(s.id)"
            @move="moveOne(s.id, $event)"
            @trash="trashOne(s.id)"
          />
        </section>

        <div v-if="store.sessions.length === 0" class="empty-sessions">
          <p>还没有会话</p>
          <p class="hint">点击上方按钮创建</p>
        </div>
      </div>
    </div>

    <!-- 新建分组固定在侧栏底部：在 `.session-items` 滚动容器**之外**，列表滚动不带走 -->
    <div class="new-group-footer">
      <form v-if="creatingGroup" class="new-group-form" @submit.prevent="submitCreateGroup">
        <input
          v-model="newGroupName"
          class="new-group-input"
          maxlength="24"
          placeholder="分组名（1–24 字）"
          v-focus
        />
        <div class="new-group-actions">
          <button type="submit" class="mini-btn" :disabled="createSaving">建</button>
          <button type="button" class="mini-btn ghost" @click="creatingGroup = false">取消</button>
        </div>
        <p v-if="createGroupError" class="inline-error">{{ createGroupError }}</p>
      </form>
      <button v-else class="btn-new-group" @click="startCreateGroup">＋ 新建分组</button>
    </div>

    <SessionCreateModal v-if="showCreate" @close="closeCreate" @created="onSessionCreated" />

    <GroupDeleteModal
      v-if="deleteTarget"
      :group="deleteTarget"
      :sessions="deleteSessions"
      :blocked="deleteBlocked"
      :trash-enabled="trashEnabled"
      :submitting="deleteSubmitting"
      :error="deleteError"
      @cancel="deleteTarget = null"
      @confirm="confirmDeleteGroup"
    />
  </div>
</template>

<style scoped>
.session-list {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

/* ─── Section ───────────────────────────── */

.section {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 12px 10px;
}

/* 头行：48px 定高——与主区顶栏、右栏「成员 · N」同一水平线。
   下边框退役，改头行同底色 + 底缘渐隐；滚动内容不会撞出一条硬切线。
   nowrap 保 236px 窄栏内不折行（折行会把 48px 撑破、三条头行错位）。 */
.section-header {
  position: sticky;
  top: 0;
  z-index: 2;
  height: 48px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 14px;
  background: var(--bg-session);
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.6px;
  white-space: nowrap;
}

/* 头行底缘渐隐：盖住滚动内容的「一刀切」断口，不引入任何线（结构线 0 条）。 */
.section-header::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -16px;
  height: 16px;
  background: linear-gradient(to bottom, var(--bg-session), transparent);
  pointer-events: none;
}

.section-header-label {
  flex: none;
}

.section-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 回收站入口（T6）：与 ＋ 同 24px 方形、同边框/悬停；计数内联在图右侧，
   空时只有图标（`padding: 0` 保持 24×24 正方形）。 */
.head-trash {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 24px;
  min-width: 24px;
  padding: 0 4px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  transition: all var(--ease-out);
}

.head-trash:not(.has-items) {
  padding: 0;
  width: 24px;
}

.head-trash.has-items {
  color: var(--text-secondary);
}

.head-trash:hover {
  border-color: var(--accent-text);
  color: var(--accent-text);
  background: var(--accent-soft);
}

.head-trash-icon {
  flex: none;
  display: block;
}

.head-trash-count {
  font-variant-numeric: tabular-nums;
}

/* 新建会话按钮：头行右侧小号（spec §4.4 头行 ＋），hover 时 accent 高亮 */
.btn-new-session-header {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all var(--ease-out);
}

.btn-new-session-header:hover {
  border-color: var(--accent-text);
  color: var(--accent-text);
  background: var(--accent-soft);
}

/* ─── 批量选择头行 ─────────────────────── */

.batch-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.batch-btn {
  padding: 2px 7px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  transition: all var(--ease-out);
}

.batch-btn:hover {
  border-color: var(--accent-text);
  color: var(--accent-text);
}

.batch-btn.danger {
  color: var(--accent-red);
}

.batch-btn.danger:hover {
  border-color: var(--accent-red);
}

/* 批量归组浮层：锚在 sticky 头行下方，不占列表滚动空间 */
.batch-move {
  position: absolute;
  top: 44px;
  right: 14px;
  z-index: 30;
  width: 160px;
  padding: 4px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-raised);
  box-shadow: var(--shadow-lg);
  text-transform: none;
  letter-spacing: 0;
  font-weight: 400;
}

.batch-move-title {
  padding: 6px 8px;
  color: var(--text-muted);
  font-size: 11px;
}

.batch-move-item {
  display: block;
  width: 100%;
  padding: 7px 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}

.batch-move-item:hover {
  background: var(--accent-soft);
  color: var(--text-primary);
}

.batch-move-empty {
  padding: 7px 8px;
  color: var(--text-muted);
  font-size: 11px;
}

.list-error {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 14px;
  color: var(--accent-red);
  font-size: 11px;
  line-height: 1.4;
}

.list-error-close {
  margin-left: auto;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: 13px;
  cursor: pointer;
}

/* ─── 列表滚动区 ────────────────────────── */

.session-items {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* ─── 分组头 ────────────────────────────── */

.group-section {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.group-header {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 0;
}

.group-toggle {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 5px 6px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  font-family: inherit;
  font-size: 11px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}

.group-toggle:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.group-arrow {
  flex: none;
  width: 10px;
  color: var(--text-muted);
  font-size: 10px;
}

.group-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group-count {
  flex: none;
  min-width: 18px;
  padding: 0 6px;
  border-radius: 10px;
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: 10px;
  font-weight: 500;
  text-align: center;
}

.group-menu-trigger {
  flex: none;
  width: 24px;
  height: 22px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
}

.group-header:hover .group-menu-trigger,
.group-menu-trigger[aria-expanded='true'] {
  opacity: 1;
}

/* 触屏无 hover：组头 ⋯ 恒显，否则无法打开组菜单 */
@media (hover: none) {
  .group-menu-trigger {
    opacity: 1;
  }
}

.group-menu-trigger:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.group-menu {
  position: absolute;
  top: 100%;
  right: 0;
  z-index: 20;
  width: 140px;
  padding: 4px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-raised);
  box-shadow: var(--shadow-lg);
}

.group-menu-item {
  display: block;
  width: 100%;
  padding: 7px 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}

.group-menu-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.group-menu-item.danger {
  color: var(--accent-red);
}

.group-menu-item.danger:hover {
  background: var(--accent-soft);
}

.group-empty {
  padding: 4px 10px 6px 22px;
  color: var(--text-muted);
  font-size: 11px;
  opacity: 0.8;
}

.ungrouped-header {
  padding-left: 6px;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
}

.ungrouped-name {
  flex: 1;
}

/* ─── 重命名 / 新建分组的输入行 ─────────── */

.rename-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
}

.rename-input,
.new-group-input {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  color: var(--text-primary);
  font-size: 12px;
  font-family: inherit;
  outline: none;
}

.rename-input:focus,
.new-group-input:focus {
  border-color: var(--accent);
}

.inline-error {
  flex-basis: 100%;
  color: var(--accent-red);
  font-size: 11px;
}

.mini-btn {
  flex: none;
  padding: 4px 10px;
  border: 1px solid var(--accent-text);
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  color: var(--accent-text);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
}

.mini-btn.ghost {
  border-color: var(--border-subtle);
  background: transparent;
  color: var(--text-muted);
}

.mini-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ─── 新建分组（固定在侧栏底部）──────────── */

.new-group-footer {
  flex: none;
  padding: 8px 14px 12px;
  background: var(--bg-session);
}

.new-group-form {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}

.new-group-actions {
  display: flex;
  gap: 4px;
}

.btn-new-group {
  width: 100%;
  padding: 7px 10px;
  border: 1px dashed var(--border-default);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: all var(--ease-out);
}

.btn-new-group:hover {
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
</style>
