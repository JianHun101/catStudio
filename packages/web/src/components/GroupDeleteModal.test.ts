import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import GroupDeleteModal from './GroupDeleteModal.vue'
import type { GroupedSession, SessionGroup } from '@/composables/useApi'

/**
 * T3 票面验收：删组确认默认「仅解散」；第二项文案带会话数、选中后主按钮变红；
 * 忙碌/绑定成员让第二项置灰并红字点名；空组只有「仅解散」；切换选项不重建弹窗 DOM。
 */

const GROUP: SessionGroup = {
  id: 'g1',
  name: '小说连载',
  collapsed: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  sessionCount: 2,
}

function session(id: string, title: string): GroupedSession {
  return {
    id,
    title,
    agentIds: ['a1'],
    broadcastMode: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    groupId: 'g1',
  }
}

const SESSIONS = [session('s1', '猫咖夜话'), session('s2', '第三章卡住了')]

describe('GroupDeleteModal 默认仅解散', () => {
  it('默认选中「仅解散」，主按钮文案与 emit 都是 dissolve', async () => {
    const w = mount(GroupDeleteModal, {
      props: { group: GROUP, sessions: SESSIONS, blocked: [] },
    })

    expect(w.find('.mode-option.active').text()).toContain('仅解散')
    const confirm = w.find('.btn-confirm')
    expect(confirm.text()).toBe('仅解散')
    expect(confirm.classes()).not.toContain('danger')

    await confirm.trigger('click')
    expect(w.emitted('confirm')?.[0]).toEqual(['dissolve'])
  })

  it('第二项文案带会话数；选中后主按钮变红并 emit trash', async () => {
    const w = mount(GroupDeleteModal, {
      props: { group: GROUP, sessions: SESSIONS, blocked: [] },
    })

    const options = w.findAll('.mode-option')
    expect(options).toHaveLength(2)
    expect(options[1]!.text()).toContain('连同 2 个会话一起移入回收站')

    await options[1]!.trigger('click')

    expect(w.find('.btn-confirm').classes()).toContain('danger')
    await w.find('.btn-confirm').trigger('click')
    expect(w.emitted('confirm')?.[0]).toEqual(['trash'])
  })
})

describe('GroupDeleteModal 回收站未接线（T2 前）', () => {
  it('第二项置灰、只留「仅解散」，并给出未启用提示', async () => {
    const w = mount(GroupDeleteModal, {
      props: { group: GROUP, sessions: SESSIONS, blocked: [], trashEnabled: false },
    })

    const options = w.findAll('.mode-option')
    expect(options[1]!.attributes('disabled')).toBeDefined()
    expect(w.find('.trash-hint').text()).toContain('回收站暂未启用')
    expect(w.find('.mode-option.active').text()).toContain('仅解散')

    await w.find('.btn-confirm').trigger('click')
    expect(w.emitted('confirm')?.[0]).toEqual(['dissolve'])
  })
})

describe('GroupDeleteModal 忙碌 / 绑定成员', () => {
  it('阻塞成员让第二项置灰，红字点名原因', () => {
    const w = mount(GroupDeleteModal, {
      props: {
        group: GROUP,
        sessions: SESSIONS,
        blocked: [{ id: 's1', title: '猫咖夜话', reason: 'busy' as const }],
      },
    })

    const options = w.findAll('.mode-option')
    expect(options[1]!.attributes('disabled')).toBeDefined()
    const hint = w.find('.blocked-hint')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('猫咖夜话')
    expect(hint.text()).toContain('正在执行')
  })

  it('绑定外部群的成员同样阻塞，并带平台名', () => {
    const w = mount(GroupDeleteModal, {
      props: {
        group: GROUP,
        sessions: SESSIONS,
        blocked: [{ id: 's2', title: '第三章卡住了', reason: 'bound' as const, platform: 'qq' }],
      },
    })

    expect(w.findAll('.mode-option')[1]!.attributes('disabled')).toBeDefined()
    expect(w.find('.blocked-hint').text()).toContain('已绑定外部群（qq）')
  })

  it('阻塞名单晚到时把已选的第二项退回「仅解散」，不留禁用死状态', async () => {
    const w = mount(GroupDeleteModal, {
      props: { group: GROUP, sessions: SESSIONS, blocked: [] },
    })
    await w.findAll('.mode-option')[1]!.trigger('click')
    expect(w.find('.btn-confirm').classes()).toContain('danger')

    await w.setProps({ blocked: [{ id: 's1', title: '猫咖夜话', reason: 'busy' }] })

    expect(w.find('.mode-option.active').text()).toContain('仅解散')
    expect(w.find('.btn-confirm').classes()).not.toContain('danger')
  })
})

describe('GroupDeleteModal 空组与 DOM 稳定性', () => {
  it('空组只有「仅解散」一项', () => {
    const w = mount(GroupDeleteModal, {
      props: { group: GROUP, sessions: [], blocked: [] },
    })
    expect(w.findAll('.mode-option')).toHaveLength(1)
    expect(w.find('.empty-hint').text()).toContain('空分组只能解散')
  })

  it('切换选项不重建弹窗 DOM（根节点 / 确认按钮是同一批元素）', async () => {
    const w = mount(GroupDeleteModal, {
      props: { group: GROUP, sessions: SESSIONS, blocked: [] },
    })
    const rootEl = w.find('.group-delete-modal').element
    const confirmEl = w.find('.btn-confirm').element

    await w.findAll('.mode-option')[1]!.trigger('click')
    await w.findAll('.mode-option')[0]!.trigger('click')

    expect(w.find('.group-delete-modal').element).toBe(rootEl)
    expect(w.find('.btn-confirm').element).toBe(confirmEl)
  })

  it('服务端拒绝原因就地显示，弹窗不关', () => {
    const w = mount(GroupDeleteModal, {
      props: {
        group: GROUP,
        sessions: SESSIONS,
        blocked: [],
        error: '有会话正在执行，本次删除已整批取消',
      },
    })
    expect(w.find('.error-hint').text()).toContain('整批取消')
  })
})
