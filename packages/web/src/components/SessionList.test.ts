import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import source from './SessionList.vue?raw'
import sessionRowSource from './SessionRow.vue?raw'
import designTokens from '../../index.html?raw'
import SessionList from './SessionList.vue'
import SessionRow from './SessionRow.vue'
import GroupDeleteModal from './GroupDeleteModal.vue'
import { useChatStore } from '@/stores/chat'
import { api } from '@/composables/useApi'
import type { GroupedSession, SessionGroup } from '@/composables/useApi'

// 组件只消费 api 对象；本票用到的有绑定查询、删除与回收站重拉
vi.mock('@/composables/useApi', () => ({
  api: {
    getConnectorBindings: vi.fn(),
    getSessionGroups: vi.fn(),
    deleteSession: vi.fn(),
    getTrash: vi.fn(),
    markSessionRead: vi.fn(),
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

function mountList(props: Record<string, unknown> = {}): VueWrapper {
  wrapper = mount(SessionList, {
    props,
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
  vi.mocked(api.deleteSession).mockResolvedValue({
    id: 's1',
    deletedAt: '2026-01-05T00:00:00.000Z',
    purgeAfter: '2026-01-12T00:00:00.000Z',
  } as any)
  vi.mocked(api.getTrash).mockResolvedValue({ entries: [] } as any)
  vi.mocked(api.markSessionRead).mockResolvedValue({ ok: true } as any)
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

    await w.find('.head-multi').trigger('click')
    await w.find('.row-check input').trigger('change')
    expect(w.find('.section-header').text()).toContain('已选 1')
    expect(w.find('.batch-move-trigger').exists()).toBe(true)
    const batchButtons = w.findAll('.batch-btn')
    expect(batchButtons.map((b) => b.text())).toEqual(['归组', '删除', '取消'])
    // T2 已接线：批量删除默认可用（关闸形态用 `trashEnabled: false` 单独钉，见下）
    expect(batchButtons[1]!.attributes('disabled')).toBeUndefined()

    await w.find('.batch-move-trigger').trigger('click')
    const targets = w.findAll('.batch-move-item').map((b) => b.text())
    expect(targets).toEqual(['小说连载', '归档', '未分组'])

    await w.findAll('.batch-move-item')[1]!.trigger('click')
    await flushPromises()

    expect(spy).toHaveBeenCalledWith(['s1'], 'g2')
    // 完成后清空选择 → 头行回到常态
    expect(w.find('.section-header').text()).not.toContain('已选')
  })

  it('已选会话被外部移除 → 收敛选中集，保持模式并显示「已选 0」', async () => {
    const w = mountList()
    await flushPromises()

    await w.find('.head-multi').trigger('click')
    await w.find('.row-check input').trigger('change')
    expect(w.find('.section-header').text()).toContain('已选 1')

    // 另一 tab 删掉 s1（store.sessions 变化，组件 watch 收敛）
    store.sessions = store.sessions.filter((s) => s.id !== 's1')
    await flushPromises()

    // 模式不自动退出：头行留在「已选 0」，用户点「取消」才回常态
    expect(w.find('.section-header').text()).toContain('已选 0')
    expect(w.find('.head-multi').exists()).toBe(false)
  })
})

describe('SessionList 选择模式（默认不占位）', () => {
  it('默认态：无复选框、无 selecting 行、头行是「会话」，多选按钮存在', async () => {
    const w = mountList()
    await flushPromises()

    expect(w.find('.row-check input').exists()).toBe(false)
    expect(w.find('.session-row.selecting').exists()).toBe(false)
    expect(w.find('.head-multi').exists()).toBe(true)
    expect(w.find('.section-header-label').text()).toBe('会话')
  })

  it('点「多选」进入：所有行出现复选框、头行「已选 0」；「取消」退出并清空', async () => {
    const w = mountList()
    await flushPromises()

    await w.find('.head-multi').trigger('click')
    expect(w.findAll('.session-row.selecting')).toHaveLength(3)
    expect(w.findAll('.row-check input')).toHaveLength(3)
    expect(w.find('.section-header').text()).toContain('已选 0')
    expect(w.findAll('.batch-btn').map((b) => b.text())).toEqual(['归组', '删除', '取消'])

    await w.findAll('.row-check input')[0]!.trigger('change')
    expect(w.find('.section-header').text()).toContain('已选 1')

    await w.findAll('.batch-btn').at(-1)!.trigger('click')
    expect(w.find('.row-check input').exists()).toBe(false)
    expect(w.find('.section-header').text()).toContain('会话')

    // 退出时选中集清空：再进模式是「已选 0」
    await w.find('.head-multi').trigger('click')
    expect(w.find('.section-header').text()).toContain('已选 0')
  })

  it('模式内点整行勾选：不调 joinSession，仍在模式内', async () => {
    const join = vi.spyOn(store, 'joinSession').mockResolvedValue(undefined)
    const w = mountList()
    await flushPromises()

    await w.find('.head-multi').trigger('click')
    const row = w.findAllComponents(SessionRow)[0]!

    await row.find('.session-item').trigger('click')
    expect(w.find('.section-header').text()).toContain('已选 1')
    expect(join).not.toHaveBeenCalled()

    await row.find('.session-item').trigger('click')
    expect(w.find('.section-header').text()).toContain('已选 0')
    expect(w.find('.head-multi').exists()).toBe(false)
  })

  it('动画源：复选框宽度过渡 + 头行淡入，均尊重 reduced-motion', () => {
    expect(sessionRowSource).toContain('.session-row.selecting .row-check')
    expect(sessionRowSource).toMatch(/width:\s*22px/)
    expect(sessionRowSource).toMatch(/transition:\s*[\s\S]*?width var\(--ease-out\)/)
    expect(sessionRowSource).toContain('@media (prefers-reduced-motion: reduce)')
    expect(sessionRowSource).not.toContain('.session-row:hover .row-check')
    expect(sessionRowSource).not.toContain('@media (hover: none)')

    expect(source).toContain('@keyframes header-in')
    expect(source).toContain('animation: header-in')
    expect(source).toContain('@media (prefers-reduced-motion: reduce)')
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

  it('关闸（trashEnabled:false）：第二项置灰、提示未启用，不依赖忙碌/绑定', async () => {
    const w = mountList({ trashEnabled: false })
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
  it('关闸（trashEnabled:false）：移入回收站禁用，点击不触发删除', async () => {
    const spy = vi.spyOn(store, 'trashSessions')
    const w = mountList({ trashEnabled: false })
    await flushPromises()

    await w.findAll('.row-more')[0]!.trigger('click')
    const trashItem = w.findAll('.row-menu .menu-item')[1]!
    expect(trashItem.attributes('aria-disabled')).toBe('true')

    await trashItem.trigger('click')
    expect(spy).not.toHaveBeenCalled()
  })

  it('单条删除 → trashSessions 带 undo:true（5 秒撤销只给单删）', async () => {
    const spy = vi.spyOn(store, 'trashSessions').mockResolvedValue([])
    const w = mountList()
    await flushPromises()

    await w.findAll('.row-more')[0]!.trigger('click')
    await w.findAll('.row-menu .menu-item')[1]!.trigger('click')

    expect(spy).toHaveBeenCalledWith(['s1'], { enabled: true, undo: true })
  })

  it('批量删除 → trashSessions 不带 undo（批量不提供撤销）', async () => {
    const spy = vi.spyOn(store, 'trashSessions').mockResolvedValue([])
    const w = mountList()
    await flushPromises()

    await w.find('.head-multi').trigger('click')
    await w.find('.row-check input').trigger('change')
    await w.findAll('.batch-btn')[1]!.trigger('click')

    expect(spy).toHaveBeenCalledWith(['s1'], { enabled: true })
  })
})

describe('SessionList 回收站入口（T4/T6）', () => {
  it('头行回收站是 15px 线稿 SVG（不是 emoji）；空时只有图标', async () => {
    const w = mountList()
    await flushPromises()

    expect(w.find('.head-trash').exists()).toBe(true)
    expect(w.find('.head-trash svg').exists()).toBe(true)
    expect(w.find('.head-trash').text()).not.toContain('🗑')
    expect(w.find('.head-badge').exists()).toBe(false)
    expect(w.find('.head-trash-count').exists()).toBe(false)
    expect(w.find('.head-trash').attributes('aria-label')).toBe('回收站')

    // 静态源：15px、currentColor、无 emoji；按钮 24px 方形同 ＋；计数内联（非绝对定位角标）
    expect(source).not.toContain('🗑')
    expect(source).toContain('width="15"')
    expect(source).toContain('height="15"')
    expect(source).toContain('stroke="currentColor"')
    const buttonCss = source.match(/\.head-trash \{[\s\S]*?\n\}/)![0]
    expect(buttonCss).toContain('height: 24px')
    expect(buttonCss).toContain('min-width: 24px')
    expect(buttonCss).toContain('width: auto')
    expect(buttonCss).toContain('padding: 0 4px')
    expect(buttonCss).toContain('border: 1px solid var(--border-subtle)')
    expect(buttonCss).not.toContain('position: absolute')
    const countCss = source.match(/\.head-trash-count \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(countCss).not.toContain('position: absolute')
    expect(source).not.toContain('.head-badge')
  })

  it('有条目时计数内联在图标右侧（同一按钮内的数字）', async () => {
    const w = mountList()
    await flushPromises()

    store.trashEntries = [
      {
        kind: 'session',
        id: 's9',
        name: '旧会话',
        deletedAt: '2026-01-05T00:00:00.000Z',
        purgeAfter: '2026-01-12T00:00:00.000Z',
        daysLeft: 7,
        sessionCount: 1,
        messageCount: 1,
        groupId: null,
        groupName: null,
      },
    ]
    await flushPromises()

    const count = w.find('.head-trash-count')
    expect(count.exists()).toBe(true)
    expect(count.text()).toBe('1')
    // 计数是按钮的直接子节点、且在 svg 之后（不叠在图标上）
    expect(count.element.parentElement).toBe(w.find('.head-trash').element)
    expect(w.find('.head-trash').attributes('title')).toContain('回收站（1 项）')
    expect(w.find('.head-trash').attributes('aria-label')).toBe('回收站，1 项')
  })

  it('点回收站向 App 投 open-trash；点会话向 App 投 open-session', async () => {
    const w = mountList()
    await flushPromises()

    await w.find('.head-trash').trigger('click')
    expect(w.emitted('open-trash')).toHaveLength(1)

    await w.findAllComponents(SessionRow)[0]!.find('.session-item').trigger('click')
    expect(w.emitted('open-session')).toHaveLength(1)
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

describe('SessionList 新建会话（T4：回收站打开时创建后回聊天）', () => {
  it('创建成功 → 投 open-session 并关闭弹窗（App 据此退出回收站）', async () => {
    store.agents = [{ id: 'a1', name: 'ds猫', avatar: '🐱', llmProvider: 'deepseek' } as never]
    const create = vi.spyOn(store, 'createSession').mockResolvedValue(undefined)
    // 全局 test-setup 把新建弹窗 stub 了；本用例要真走一遍「创建成功」，局部关掉 stub
    wrapper = mount(SessionList, {
      global: {
        plugins: [pinia],
        stubs: { SessionCreateModal: false },
        directives: { focus: { mounted() {} } },
      },
    })
    await flushPromises()

    await wrapper.find('.btn-new-session-header').trigger('click')
    await wrapper.find('.modal .input').setValue('回收站里新建的会话')
    await wrapper.find('.agent-select-item').trigger('click')
    await wrapper.find('.btn-create').trigger('click')
    await flushPromises()

    expect(create).toHaveBeenCalledWith('回收站里新建的会话', ['a1'])
    expect(wrapper.emitted('open-session')).toHaveLength(1)
    expect(wrapper.find('.modal').exists()).toBe(false)
  })
})

describe('SessionList 静态结构（归档面已退场）', () => {
  it('无归档按钮 / 无「显示已归档」开关 / 不读 showArchived', () => {
    expect(source).not.toContain('session-archive')
    expect(source).not.toContain('btn-toggle-archived')
    expect(source).not.toContain('showArchived')
  })

  it('头行是「会话」/多选/＋；组菜单两项', () => {
    expect(source).toContain('class="section-header-label">会话')
    expect(source).toContain('class="head-multi"')
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

/** 用花括号配对取 CSS 块内容（去掉最外层括号）；找不到返回 null。 */
function cssBlock(src: string, opener: string): string | null {
  const start = src.indexOf(opener)
  if (start < 0) return null
  const open = src.indexOf('{', start)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(open + 1, i)
    }
  }
  return null
}

describe('会话列表滚动条（index.html 全局样式）', () => {
  it('去掉滚动条两端的箭头按钮（全局）', () => {
    const block = designTokens.match(/::-webkit-scrollbar-button\s*\{[^}]*\}/s)

    expect(block).toBeTruthy()
    expect(block![0]).toContain('display: none')
    expect(block![0]).toContain('width: 0')
    expect(block![0]).toContain('height: 0')
  })

  it('.session-items 滑块默认透明、hover 显色；用 background-color 不用简写', () => {
    expect(designTokens).toMatch(
      /\.session-items::-webkit-scrollbar-thumb\s*\{[^}]*background-color:\s*transparent/
    )
    expect(designTokens).toMatch(
      /\.session-items:hover::-webkit-scrollbar-thumb\s*\{[^}]*background-color:\s*var\(--border-table\)/
    )
    // 简写会把 background-clip: content-box 重置掉，滑块会被拉成满宽
    expect(designTokens).not.toMatch(
      /\.session-items::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*transparent/
    )
    // Firefox 侧同步：默认透明、hover 显色
    expect(designTokens).toMatch(
      /\.session-items\s*\{[^}]*scrollbar-color:\s*transparent transparent/s
    )
    expect(designTokens).toMatch(
      /\.session-items:hover\s*\{[^}]*scrollbar-color:\s*var\(--border-table\) transparent/s
    )
  })

  it('WebKit 轨道宽度声明仍为 10px（显隐只改颜色；实际宽度由浏览器决定，不是渲染实测）', () => {
    const block = designTokens.match(/::-webkit-scrollbar\s*\{[^}]*\}/s)

    expect(block).toBeTruthy()
    expect(block![0]).toContain('width: 10px')
  })

  it('标准滚动条属性只在 Firefox 分支（@supports not selector）里生效', () => {
    const block = cssBlock(designTokens, '@supports not (selector(::-webkit-scrollbar))')

    expect(block).toBeTruthy()
    expect(block).toContain('scrollbar-width: thin')
    expect(block).toContain('scrollbar-color: var(--border-table) transparent')
    expect(block).toContain('.session-items')
    expect(block).toContain('scrollbar-color: transparent transparent')

    // Chromium 一旦在全局看到裸的 scrollbar-width / scrollbar-color 就会旁路 WebKit 定制，
    // 所以这两条声明只能待在上面的 Firefox-only 块里。
    const outside = designTokens.replace(block!, '')
    expect(outside).not.toMatch(/scrollbar-width\s*:/)
    expect(outside).not.toMatch(/scrollbar-color\s*:/)
  })
})
