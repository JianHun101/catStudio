import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import SessionActionsMenu from './SessionActionsMenu.vue'
import type { GroupedSession, SessionGroup } from '@/composables/useApi'

/**
 * T3 票面验收：悬停「移动到分组」→ 侧框出现、主菜单不关；指针移到别处/空白 →
 * 侧框收起、主菜单仍在；指针进入侧框 → 保持；点击触发项也能打开；选目标后两级同关。
 */

const GROUPS: SessionGroup[] = [
  {
    id: 'g1',
    name: '小说连载',
    collapsed: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sessionCount: 1,
  },
  {
    id: 'g2',
    name: '归档',
    collapsed: true,
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    sessionCount: 0,
  },
]

function session(groupId: string | null): GroupedSession {
  return {
    id: 's1',
    title: '猫咖夜话',
    agentIds: ['a1'],
    broadcastMode: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    groupId,
  }
}

let wrapper: VueWrapper | null = null

function mountMenu(groupId: string | null = 'g1', trashEnabled = true): VueWrapper {
  wrapper = mount(SessionActionsMenu, {
    props: { session: session(groupId), groups: GROUPS, trashEnabled },
    attachTo: document.body,
  })
  return wrapper
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
})

describe('SessionActionsMenu 打开与关闭', () => {
  it('⋯ 打开主菜单：两个菜单项，侧框不默认展开', async () => {
    const w = mountMenu()
    expect(w.find('.row-menu').exists()).toBe(false)

    await w.find('.row-more').trigger('click')

    expect(w.find('.row-menu').exists()).toBe(true)
    expect(w.findAll('.menu-item').map((m) => m.text())).toEqual(['移动到分组›', '移入回收站'])
    expect(w.find('.submenu').exists()).toBe(false)
    expect(w.find('.row-more').attributes('aria-expanded')).toBe('true')
  })

  it('点击外部（pointerdown）收起主菜单', async () => {
    const w = mountMenu()
    await w.find('.row-more').trigger('click')
    expect(w.find('.row-menu').exists()).toBe(true)

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await nextTick()

    expect(w.find('.row-menu').exists()).toBe(false)
  })
})

describe('SessionActionsMenu 侧框：离开即收、主菜单不关', () => {
  it('悬停「移动到分组」出侧框，当前所在组不出现在目标里，且有「未分组」', async () => {
    const w = mountMenu('g1')
    await w.find('.row-more').trigger('click')
    await w.find('.move-item').trigger('mouseenter')

    const items = w.findAll('.submenu-item').map((i) => i.text())
    expect(items).toEqual(['归档', '未分组'])
    expect(items).not.toContain('小说连载')
  })

  it('指针离开后留 160ms 宽限：159ms 仍在，160ms 收起，主菜单不跟着关', async () => {
    const w = mountMenu('g1')
    await w.find('.row-more').trigger('click')
    await w.find('.move-item').trigger('mouseenter')
    expect(w.find('.submenu').exists()).toBe(true)

    await w.find('.move-item').trigger('mouseleave')
    vi.advanceTimersByTime(159)
    await nextTick()
    expect(w.find('.submenu').exists()).toBe(true)

    vi.advanceTimersByTime(1)
    await nextTick()
    expect(w.find('.submenu').exists()).toBe(false)
    // 侧框收起 ≠ 退出操作菜单
    expect(w.find('.row-menu').exists()).toBe(true)
  })

  it('宽限期内指针进入侧框 → 保持打开（跨 6px 间隙不闪）', async () => {
    const w = mountMenu('g1')
    await w.find('.row-more').trigger('click')
    await w.find('.move-item').trigger('mouseenter')
    await w.find('.move-item').trigger('mouseleave')
    await nextTick()
    await w.find('.submenu').trigger('mouseenter')

    vi.advanceTimersByTime(160)
    await nextTick()

    expect(w.find('.submenu').exists()).toBe(true)
  })

  it('指针移到主菜单其他项（移入回收站）→ 侧框收起、主菜单仍在', async () => {
    const w = mountMenu('g1')
    await w.find('.row-more').trigger('click')
    await w.find('.move-item').trigger('mouseenter')
    await w.find('.move-item').trigger('mouseleave')
    await w.findAll('.menu-item')[1]!.trigger('mouseenter')

    vi.advanceTimersByTime(160)
    await nextTick()

    expect(w.find('.submenu').exists()).toBe(false)
    expect(w.find('.row-menu').exists()).toBe(true)
  })
})

describe('SessionActionsMenu 点击兜底与选择目标', () => {
  it('点击「移动到分组」也能打开侧框（触屏兜底）', async () => {
    const w = mountMenu('g1')
    await w.find('.row-more').trigger('click')
    await w.find('.move-item').trigger('click')
    expect(w.find('.submenu').exists()).toBe(true)
  })

  it('选目标后 emit move 且两级菜单同关', async () => {
    const w = mountMenu('g1')
    await w.find('.row-more').trigger('click')
    await w.find('.move-item').trigger('click')

    await w.findAll('.submenu-item')[0]!.trigger('click')

    expect(w.emitted('move')?.[0]).toEqual(['g2'])
    expect(w.find('.row-menu').exists()).toBe(false)
    expect(w.find('.submenu').exists()).toBe(false)
  })

  it('未分组会话：目标里没有多余的「未分组」', async () => {
    const w = mountMenu(null)
    await w.find('.row-more').trigger('click')
    await w.find('.move-item').trigger('mouseenter')

    expect(w.findAll('.submenu-item').map((i) => i.text())).toEqual(['小说连载', '归档'])
  })

  it('移入回收站 emit trash 并关菜单', async () => {
    const w = mountMenu()
    await w.find('.row-more').trigger('click')
    await w.findAll('.menu-item')[1]!.trigger('click')

    expect(w.emitted('trash')).toHaveLength(1)
    expect(w.find('.row-menu').exists()).toBe(false)
  })

  it('关闸（trashEnabled:false）：移入回收站为禁用态，点击不 emit', async () => {
    const w = mountMenu('g1', false)
    await w.find('.row-more').trigger('click')
    const trashItem = w.findAll('.menu-item')[1]!

    expect(trashItem.attributes('aria-disabled')).toBe('true')
    expect(trashItem.classes()).toContain('disabled')
    expect(trashItem.attributes('title')).toContain('回收站暂未启用')

    await trashItem.trigger('click')

    expect(w.emitted('trash')).toBeUndefined()
  })

  it('漏传 trashEnabled → 默认禁用（fail-safe，不是默认放行）', async () => {
    wrapper = mount(SessionActionsMenu, {
      props: { session: session('g1'), groups: GROUPS },
      attachTo: document.body,
    })
    await wrapper.find('.row-more').trigger('click')
    const trashItem = wrapper.findAll('.menu-item')[1]!

    expect(trashItem.attributes('aria-disabled')).toBe('true')
    await trashItem.trigger('click')
    expect(wrapper.emitted('trash')).toBeUndefined()
  })
})
