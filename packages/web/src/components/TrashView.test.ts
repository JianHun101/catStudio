import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import TrashView from './TrashView.vue'
import { useChatStore } from '@/stores/chat'
import type { TrashEntry } from '@/composables/useApi'

/**
 * T4 票面验收：回收站两段（整组删除 / 单个会话）互不串；组条目只走组级恢复/清除；
 * 永久删除与清空二次确认；空态；进回收站即重拉。
 */

const entry = (over: Partial<TrashEntry>): TrashEntry => ({
  kind: 'session',
  id: 's1',
  name: '旧会话',
  deletedAt: '2026-01-05T00:00:00.000Z',
  purgeAfter: '2026-01-12T00:00:00.000Z',
  daysLeft: 5,
  sessionCount: 1,
  messageCount: 3,
  groupId: null,
  groupName: null,
  ...over,
})

const GROUP_ENTRY = entry({
  kind: 'group',
  id: 'g1',
  name: '小说连载',
  sessionCount: 2,
  messageCount: 9,
})
const SESSION_ENTRY = entry({
  kind: 'session',
  id: 's1',
  name: '深夜调试',
  groupId: 'g2',
  groupName: '归档',
})

let pinia: ReturnType<typeof createPinia>
let store: ReturnType<typeof useChatStore>
let wrapper: VueWrapper | null = null

function mountView(): VueWrapper {
  wrapper = mount(TrashView, { global: { plugins: [pinia] } })
  return wrapper
}

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  store = useChatStore()
  vi.spyOn(store, 'fetchTrash').mockResolvedValue(undefined)
  store.trashEntries = []
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.restoreAllMocks()
})

describe('TrashView 两段列表', () => {
  it('按 kind 分两段，字段齐全，同批成员不在会话段重复', async () => {
    store.trashEntries = [GROUP_ENTRY, SESSION_ENTRY]
    const w = mountView()
    await flushPromises()

    const labels = w.findAll('.trash-section-label').map((n) => n.text())
    expect(labels[0]).toContain('整组删除 · 1')
    expect(labels[1]).toContain('单个会话 · 1')

    const groupRow = w.find('.trash-item[data-entry-kind="group"]')
    expect(groupRow.text()).toContain('小说连载')
    expect(groupRow.text()).toContain('2 个会话')
    expect(groupRow.text()).toContain('9 条消息')
    expect(groupRow.text()).toContain('剩 5 天')

    const sessionRow = w.find('.trash-item[data-entry-kind="session"]')
    expect(sessionRow.text()).toContain('深夜调试')
    expect(sessionRow.text()).toContain('来自「归档」')
    expect(sessionRow.text()).toContain('3 条消息')
    // 组条目只有一行，没有把成员展开成可单条恢复的行
    expect(w.findAll('.trash-item[data-entry-kind="group"]')).toHaveLength(1)
    expect(w.findAll('.trash-item')).toHaveLength(2)
  })

  it('剩余不足 1 天转红', async () => {
    store.trashEntries = [entry({ daysLeft: 1 })]
    const w = mountView()
    await flushPromises()

    expect(w.find('.expire-days').classes()).toContain('soon')
    expect(w.find('.expire-days').text()).toContain('不足 1 天')
  })

  it('空态：两段都不渲染，清空按钮禁用', async () => {
    const w = mountView()
    await flushPromises()

    expect(w.find('.trash-empty').text()).toContain('回收站是空的')
    expect(w.findAll('.trash-section')).toHaveLength(0)
    expect(w.find('.trash-btn.danger').attributes('disabled')).toBeDefined()
  })

  it('进回收站即重拉（服务端为权威口径）', async () => {
    mountView()
    await flushPromises()
    expect(store.fetchTrash).toHaveBeenCalled()
  })
})

describe('TrashView 动作', () => {
  it('会话条目「恢复」→ restoreTrashSession；组条目「恢复」→ restoreTrashGroup', async () => {
    store.trashEntries = [GROUP_ENTRY, SESSION_ENTRY]
    const restoreOne = vi.spyOn(store, 'restoreTrashSession').mockResolvedValue(true)
    const restoreGroup = vi.spyOn(store, 'restoreTrashGroup').mockResolvedValue(true)
    const w = mountView()
    await flushPromises()

    await w.find('.trash-item[data-entry-kind="session"] .row-btn').trigger('click')
    expect(restoreOne).toHaveBeenCalledWith('s1')

    await w.find('.trash-item[data-entry-kind="group"] .row-btn').trigger('click')
    expect(restoreGroup).toHaveBeenCalledWith('g1')
  })

  it('永久删除二次确认：点行内按钮只开弹窗，确认后才调 purge', async () => {
    store.trashEntries = [SESSION_ENTRY]
    const purge = vi.spyOn(store, 'purgeTrashSession').mockResolvedValue(true)
    const w = mountView()
    await flushPromises()

    await w.find('.trash-item .row-btn.danger').trigger('click')
    expect(purge).not.toHaveBeenCalled()
    expect(w.find('.trash-modal').text()).toContain('永久删除「深夜调试」？')
    expect(w.find('.trash-modal').text()).toContain('不可撤销')

    await w.find('.trash-btn.danger-solid').trigger('click')
    await flushPromises()

    expect(purge).toHaveBeenCalledWith('s1')
    expect(w.find('.trash-modal').exists()).toBe(false)
  })

  it('清空回收站二次确认（条目数进文案），确认后调 emptyTrash', async () => {
    store.trashEntries = [GROUP_ENTRY, SESSION_ENTRY]
    const empty = vi.spyOn(store, 'emptyTrash').mockResolvedValue(true)
    const w = mountView()
    await flushPromises()

    await w.find('.trash-btn.danger').trigger('click')
    expect(empty).not.toHaveBeenCalled()
    expect(w.find('.trash-modal').text()).toContain('2 项')

    await w.find('.trash-btn.danger-solid').trigger('click')
    await flushPromises()

    expect(empty).toHaveBeenCalled()
  })

  it('清除失败时弹窗保留（错误 toast 由 store 统一提示）', async () => {
    store.trashEntries = [SESSION_ENTRY]
    vi.spyOn(store, 'purgeTrashSession').mockResolvedValue(false)
    const w = mountView()
    await flushPromises()

    await w.find('.trash-item .row-btn.danger').trigger('click')
    await w.find('.trash-btn.danger-solid').trigger('click')
    await flushPromises()

    expect(w.find('.trash-modal').exists()).toBe(true)
  })

  it('「返回聊天」向 App 投 close', async () => {
    store.trashEntries = [SESSION_ENTRY]
    const w = mountView()
    await flushPromises()

    await w.find('.trash-btn.ghost').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
  })
})
