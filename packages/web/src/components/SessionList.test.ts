import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import source from './SessionList.vue?raw'
import sessionRowSource from './SessionRow.vue?raw'
import SessionList from './SessionList.vue'
import SessionRow from './SessionRow.vue'
import GroupDeleteModal from './GroupDeleteModal.vue'
import { useChatStore } from '@/stores/chat'
import { api } from '@/composables/useApi'
import type { GroupedSession, SessionGroup } from '@/composables/useApi'

// 组件只消费 api 对象；本票用到的只有绑定查询（删组确认的阻塞判据）
vi.mock('@/composables/useApi', () => ({
  api: {
    getConnectorBindings: vi.fn(),
    getSessionGroups: vi.fn(),
  },
}))

/**
 * T3 票面验收：左栏「分组 + 未分组」、批量归组、删组默认仅解散、忙碌组第二项不可选、
 * 新建分组固定底部、无归档入口。
 */

const GROUPS: SessionGroup[] = [
  {
    id: 'g1',
    name: '小说连载',
    collapsed: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sessionCount: 2,
  },
  {
    id: 'g2',
    name: '归档',
    collapsed: false,
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    sessionCount: 0,
  },
]

function session(
  id: string,
  title: string,
  groupId: string | null,
  updatedAt: string
): GroupedSession {
  return {
    id,
    title,
    agentIds: ['a1'],
    broadcastMode: false,
    createdAt: updatedAt,
    updatedAt,
    groupId,
  }
}

const SESSIONS: GroupedSession[] = [
  session('s1', '猫咖夜话', 'g1', '2026-01-03T00:00:00.000Z'),
  session('s2', '第三章卡住了', 'g1', '2026-01-02T00:00:00.000Z'),
  session('s3', '深夜调试', null, '2026-01-01T00:00:00.000Z'),
]

let pinia: ReturnType<typeof createPinia>
let store: ReturnType<typeof useChatStore>
let wrapper: VueWrapper | null = null

function mountList(): VueWrapper {
  wrapper = mount(SessionList, {
    global: {
      plugins: [pinia],
      // v-focus 是全局指令；单测里给个空实现即可（不测聚焦行为）
      directives: { focus: { mounted() {} } },
    },
  })
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.getConnectorBindings).mockResolvedValue({ ok: true, bindings: [] } as any)
  vi.mocked(api.getSessionGroups).mockResolvedValue({ groups: [] } as any)
  pinia = createPinia()
  setActivePinia(pinia)
  store = useChatStore()
  vi.spyOn(store, 'fetchData').mockResolvedValue(undefined)
  store.groups = GROUPS
  store.sessions = SESSIONS
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('SessionList 分组渲染', () => {
  it('活组按 createdAt 序 + 未分组最后；组头计数按本地会话现算', async () => {
    // 判别力：故意打乱数组序、并把 sessionCount 写成错值——排序/计数任一走错即红
    store.groups = [
      { ...GROUPS[1]!, sessionCount: 99 },
      { ...GROUPS[0]!, sessionCount: 42 },
    ]
    const w = mountList()
    await flushPromises()

    const names = w.findAll('.group-name').map((n) => n.text())
    expect(names).toEqual(['小说连载', '归档', '未分组'])
    const counts = w.findAll('.group-count').map((n) => n.text())
    expect(counts).toEqual(['2', '0', '1'])

    // 行归属：组内两行 + 未分组一行
    const rows = w.findAllComponents(SessionRow)
    expect(rows).toHaveLength(3)
    expect(w.text()).toContain('空分组')
  })

  it('折叠点击 PATCH 落库（服务端折叠态，多 tab 一致）', async () => {
    const spy = vi.spyOn(store, 'setGroupCollapsed').mockResolvedValue(undefined)
    const w = mountList()
    await flushPromises()

    await w.findAll('.group-toggle')[0]!.trigger('click')

    expect(spy).toHaveBeenCalledWith('g1', true)
  })

  it('折叠后组内会话行不渲染，展开后恢复', async () => {
    vi.spyOn(store, 'setGroupCollapsed').mockImplementation(async (id, collapsed) => {
      store.groups = store.groups.map((g) => (g.id === id ? { ...g, collapsed } : g))
    })
    const w = mountList()
    await flushPromises()
    expect(w.findAllComponents(SessionRow)).toHaveLength(3)

    await w.findAll('.group-toggle')[0]!.trigger('click')
    await flushPromises()
    expect(w.findAllComponents(SessionRow)).toHaveLength(1)

    await w.findAll('.group-toggle')[0]!.trigger('click')
    await flushPromises()
    expect(w.findAllComponents(SessionRow)).toHaveLength(3)
  })
})

describe('SessionList 批量归组', () => {
  it('勾选后头行变「已选 N ｜ 归组 ｜ 删除 ｜ 取消」，归组一次成功后清空选择', async () => {
    const spy = vi.spyOn(store, 'batchMoveToGroup').mockResolvedValue(undefined)
    const w = mountList()
    await flushPromises()

    await w.find('.row-check input').trigger('change')
    expect(w.find('.section-header').text()).toContain('已选 1')
    expect(w.find('.batch-move-trigger').exists()).toBe(true)
    const batchButtons = w.findAll('.batch-btn')
    expect(batchButtons.map((b) => b.text())).toEqual(['归组', '删除', '取消'])
    // T2 前回收站未接线：批量删除必须是禁用态（现有 DELETE 还是物理删除）
    expect(batchButtons[1]!.attributes('disabled')).toBeDefined()

    await w.find('.batch-move-trigger').trigger('click')
    const targets = w.findAll('.batch-move-item').map((b) => b.text())
    expect(targets).toEqual(['小说连载', '归档', '未分组'])

    await w.findAll('.batch-move-item')[1]!.trigger('click')
    await flushPromises()

    expect(spy).toHaveBeenCalledWith(['s1'], 'g2')
    // 完成后清空选择 → 头行回到常态
    expect(w.find('.section-header').text()).not.toContain('已选')
  })

  it('已选会话被外部移除 → 自动收敛选中集，头行不残留「已选 N」', async () => {
    const w = mountList()
    await flushPromises()

    await w.find('.row-check input').trigger('change')
    expect(w.find('.section-header').text()).toContain('已选 1')

    // 另一 tab 删掉 s1（store.sessions 变化，组件 watch 收敛）
    store.sessions = store.sessions.filter((s) => s.id !== 's1')
    await flushPromises()

    expect(w.find('.section-header').text()).not.toContain('已选')
  })
})

describe('SessionList 删组确认', () => {
  async function openDeleteModal(w: VueWrapper): Promise<VueWrapper> {
    await w.findAll('.group-menu-trigger')[0]!.trigger('click')
    await w.find('.group-menu-item.danger').trigger('click')
    await flushPromises()
    return w.findComponent(GroupDeleteModal)
  }

  it('默认「仅解散」，确认后调 deleteGroup(id, false)', async () => {
    const spy = vi.spyOn(store, 'deleteGroup').mockResolvedValue(undefined)
    const w = mountList()
    await flushPromises()

    const modal = await openDeleteModal(w)
    expect(modal.exists()).toBe(true)
    expect(modal.find('.mode-option.active').text()).toContain('仅解散')

    await modal.find('.btn-confirm').trigger('click')
    await flushPromises()

    expect(spy).toHaveBeenCalledWith('g1', false)
    expect(w.findComponent(GroupDeleteModal).exists()).toBe(false)
  })

  it('忙碌成员让第二项置灰并红字点名', async () => {
    store.agentStates = new Map([
      ['a1', new Map([['s1', { agentId: 'a1', sessionId: 's1', status: 'busy', queueLength: 0 }]])],
    ]) as any
    const w = mountList()
    await flushPromises()

    const modal = await openDeleteModal(w)
    const options = modal.findAll('.mode-option')
    expect(options[1]!.attributes('disabled')).toBeDefined()
    expect(modal.find('.blocked-hint').text()).toContain('猫咖夜话')
    expect(modal.find('.blocked-hint').text()).toContain('正在执行')
  })

  it('绑定外部群的成员同样让第二项置灰', async () => {
    vi.mocked(api.getConnectorBindings).mockResolvedValue({
      ok: true,
      bindings: [
        {
          id: 'b1',
          platform: 'qq',
          external_type: 'group',
          external_id: '123',
          session_id: 's2',
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    } as any)
    const w = mountList()
    await flushPromises()

    const modal = await openDeleteModal(w)
    expect(modal.findAll('.mode-option')[1]!.attributes('disabled')).toBeDefined()
    expect(modal.find('.blocked-hint').text()).toContain('第三章卡住了')
    expect(modal.find('.blocked-hint').text()).toContain('已绑定外部群')
  })

  it('回收站未接线（T2 前）：第二项置灰、提示未启用，不依赖忙碌/绑定', async () => {
    const w = mountList()
    await flushPromises()

    const modal = await openDeleteModal(w)
    expect(modal.findAll('.mode-option')[1]!.attributes('disabled')).toBeDefined()
    expect(modal.find('.trash-hint').text()).toContain('回收站暂未启用')
    expect(modal.find('.mode-option.active').text()).toContain('仅解散')
  })

  it('重名就地报错、输入框不关', async () => {
    vi.spyOn(store, 'renameGroup').mockRejectedValue({ body: { error: 'GROUP_NAME_TAKEN' } })
    const w = mountList()
    await flushPromises()

    await w.findAll('.group-menu-trigger')[0]!.trigger('click')
    await w.find('.group-menu-item').trigger('click')
    const input = w.find('.rename-input')
    expect(input.exists()).toBe(true)

    await input.setValue('归档')
    await w.find('.rename-row .mini-btn').trigger('click')
    await flushPromises()

    expect(w.find('.rename-input').exists()).toBe(true)
    expect(w.find('.inline-error').text()).toContain('分组名已存在')
  })
})

describe('SessionList 行菜单删除入口', () => {
  it('回收站未接线（T2 前）：移入回收站禁用，点击不触发删除', async () => {
    const spy = vi.spyOn(store, 'trashSessions')
    const w = mountList()
    await flushPromises()

    await w.findAll('.row-more')[0]!.trigger('click')
    const trashItem = w.findAll('.row-menu .menu-item')[1]!
    expect(trashItem.attributes('aria-disabled')).toBe('true')

    await trashItem.trigger('click')
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('SessionList 底部新建分组', () => {
  it('新建分组在滚动容器之外（列表滚动不带走、建组/删组位置不跳）', async () => {
    const w = mountList()
    await flushPromises()

    expect(w.find('.session-items .new-group-footer').exists()).toBe(false)
    expect(w.find('.session-list > .new-group-footer').exists()).toBe(true)
    expect(w.find('.new-group-footer').text()).toContain('新建分组')
  })

  it('输入组名提交 → createGroup(name) 并把输入态收起', async () => {
    const spy = vi.spyOn(store, 'createGroup').mockResolvedValue(GROUPS[0]!)
    const w = mountList()
    await flushPromises()

    await w.find('.btn-new-group').trigger('click')
    await w.find('.new-group-input').setValue('新组')
    await w.find('.new-group-form').trigger('submit')
    await flushPromises()

    expect(spy).toHaveBeenCalledWith('新组')
    expect(w.find('.btn-new-group').exists()).toBe(true)
  })
})

describe('SessionList 静态结构（归档面已退场）', () => {
  it('无归档按钮 / 无「显示已归档」开关 / 不读 showArchived', () => {
    expect(source).not.toContain('session-archive')
    expect(source).not.toContain('btn-toggle-archived')
    expect(source).not.toContain('showArchived')
  })

  it('头行只有「会话」/批量条 + ＋；组菜单两项', () => {
    expect(source).toContain('class="section-header-label">会话')
    expect(source).toContain('class="btn-new-session-header"')
    expect(source).toContain('重命名分组')
    expect(source).toContain('删除分组…')
  })

  it('行操作交给唯一 ⋯ 菜单（SessionActionsMenu），不在行内散落按钮', () => {
    expect(source).toContain('<SessionRow')
    expect(sessionRowSource).toContain('<SessionActionsMenu')
    expect(source).not.toContain('session-delete')
  })
})
