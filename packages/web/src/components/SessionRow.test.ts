import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SessionRow from './SessionRow.vue'
import type { GroupedSession } from '@/composables/useApi'

/**
 * 会话行第二行（T6）：左「N 只猫咪」、右「最后消息时间」。
 *
 * 时间分档的枚举在 `utils/time.test.ts`（纯函数）；本文件只钉组件接线：
 *   - 数据源是 `lastMessageAt`，**不是 `updatedAt`**（后者不随消息更新）
 *   - 无消息 → 不渲染时间节点
 *   - `title` 给完整本地时间
 */

const p2 = (n: number) => String(n).padStart(2, '0')

/** 本地时刻 → 服务端形态 ISO 串 */
const isoAt = (d: Date) => d.toISOString()

/** 今天的某个本地时刻（同自然日即可，不依赖当前钟点在哪一档） */
const todayAt = (h: number, mi: number) => {
  const d = new Date()
  d.setHours(h, mi, 0, 0)
  return d
}

const yesterdayAt = (h: number, mi: number) => {
  const d = todayAt(h, mi)
  d.setDate(d.getDate() - 1)
  return d
}

function session(overrides: Partial<GroupedSession> = {}): GroupedSession {
  return {
    id: 's1',
    title: '猫咖夜话',
    agentIds: ['a1', 'a2'],
    broadcastMode: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    groupId: null,
    ...overrides,
  }
}

function mountRow(s: GroupedSession) {
  return mount(SessionRow, {
    props: { session: s, active: false, checked: false, unread: 0, groups: [] },
  })
}

describe('SessionRow 最后消息时间（T6）', () => {
  it('无 lastMessageAt → 不渲染时间，第二行只有「N 只猫咪」', () => {
    const w = mountRow(session({ lastMessageAt: null }))

    expect(w.find('.session-time').exists()).toBe(false)
    expect(w.find('.session-meta').text()).toBe('2 只猫咪')
  })

  it('今天 → `HH:mm`；title 给完整 `YYYY-MM-DD HH:mm`', () => {
    const d = todayAt(9, 5)
    const w = mountRow(session({ lastMessageAt: isoAt(d) }))

    const time = w.find('.session-time')
    expect(time.text()).toBe('09:05')
    expect(time.attributes('title')).toBe(
      `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} 09:05`
    )
    // 左侧元信息不受影响
    expect(w.find('.session-cats').text()).toBe('2 只猫咪')
  })

  it('昨天 → 只显示 `昨天`', () => {
    const w = mountRow(session({ lastMessageAt: isoAt(yesterdayAt(22, 30)) }))

    expect(w.find('.session-time').text()).toBe('昨天')
  })

  it('数据源是 lastMessageAt 而不是 updatedAt（后者不随消息更新）', () => {
    // updatedAt 是今天、lastMessageAt 是昨天：显示「昨天」才证明取的是消息时间。
    // 如果实现误用 updatedAt，这里会显示今天的 HH:mm ⇒ 红。
    const w = mountRow(
      session({ updatedAt: isoAt(todayAt(12, 0)), lastMessageAt: isoAt(yesterdayAt(22, 30)) })
    )

    expect(w.find('.session-time').text()).toBe('昨天')
  })

  it('解析失败 → 不渲染时间（不把原始串塞进列表行）', () => {
    const w = mountRow(session({ lastMessageAt: '不是时间' }))

    expect(w.find('.session-time').exists()).toBe(false)
  })
})
