// @vitest-environment jsdom
// 挂载测试需要 DOM（v-for 渲染 + 高度测量）。文件级环境注释——根配置 environment
// 为默认 node（workspace 目录型 project 不加载 web 包内 vitest.config.ts）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import SessionHistoryPanel from './SessionHistoryPanel.vue'
import panelSource from './SessionHistoryPanel.vue?raw'
import { api } from '@/composables/useApi'
import { useChatStore } from '@/stores/chat'
import type { Message } from '@cat-study/shared'

// mock 边界：组件只消费 api 对象（类型导出编译后消失，不需要 mock）
vi.mock('@/composables/useApi', () => ({
  api: {
    getSessionMessageFacets: vi.fn(),
    getSessionMessages: vi.fn(),
    searchSessionMessages: vi.fn(),
  },
}))

/**
 * 右栏历史面板（C-2）。
 *
 * 几何口径：jsdom 没有布局引擎（`offsetHeight` / `clientHeight` 恒为 0），故用
 * **原型 getter 模拟 CSS 口径**：卡片 141px、日期头 24px、间距 6px——与 SFC 里的
 * `.hist-card`（8+8 padding、10px meta、5 行 × 13px × 1.62 ≈ 105px）同量级。
 * 900 → 5 条、1080 → 7 条正是原型定稿的实测基准，此处用同一组几何钉死。
 */
const CARD_H = 141
const DAY_H = 24
const ITEM_GAP = 4
const HIST_GAP = 6

let viewportH = 900

function itemHeight(el: HTMLElement): number {
  const hasDay = Array.from(el.children).some((c) => c.classList.contains('hist-day'))
  return CARD_H + (hasDay ? DAY_H + ITEM_GAP : 0)
}

beforeEach(() => {
  viewportH = 900
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList.contains('hist-card')) return CARD_H
      if (this.classList.contains('hist-day')) return DAY_H
      if (this.classList.contains('hist-item')) return itemHeight(this)
      return 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('hist-results') ? viewportH : 0
    },
  })
  // 浏览器口径：scrollHeight = max(内容高度, clientHeight)——内容不超高时两者相等
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (!this.classList.contains('hist-results')) return 0
      const items = Array.from(this.querySelectorAll<HTMLElement>('.hist-item')).filter(
        (i) => !i.classList.contains('clipped')
      )
      const content = items.reduce((sum, i) => sum + i.offsetHeight + HIST_GAP, 0)
      return Math.max(viewportH, content)
    },
  })
})

afterEach(() => {
  // 还原原型，避免污染同进程里的其他 jsdom 用例
  delete (HTMLElement.prototype as any).offsetHeight
  delete (HTMLElement.prototype as any).clientHeight
  delete (HTMLElement.prototype as any).scrollHeight
})

const Y = new Date().getFullYear()
const dayA = `${Y}-11-13`
const dayB = `${Y}-11-12`
const oldDay = `${Y - 1}-12-18`

/** 本地时间构造 ISO：无论测试机在哪个时区，localDate() 都回到同一日期 */
function at(date: string, hh: number, mm = 0): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d, hh, mm, 0, 0).toISOString()
}

function msg(
  id: string,
  role: 'user' | 'agent' | 'system',
  content: string,
  createdAt: string,
  agentId: string | null = null
): Message {
  return {
    id,
    sessionId: 's1',
    agentId,
    role,
    content,
    mentions: [],
    createdAt,
  }
}

/** 12 条同一天的候选（默认筛选「全部」时全部可见） */
function twelveMessages(): Message[] {
  return Array.from({ length: 12 }, (_, i) =>
    msg(`m${i + 1}`, i % 2 === 0 ? 'user' : 'agent', `第 ${i + 1} 条内容`, at(dayA, 10, i), 'a1')
  )
}

const facetsFixture = {
  total: 15,
  days: [
    { date: dayA, count: 4 },
    { date: dayB, count: 3 },
    { date: oldDay, count: 1 },
  ],
  months: [{ month: `${Y}-11` }, { month: `${Y - 1}-12` }],
}

let pinia: ReturnType<typeof createPinia>

function setupStore(): ReturnType<typeof useChatStore> {
  pinia = createPinia()
  setActivePinia(pinia)
  const store = useChatStore()
  store.sessions = [{ id: 's1', title: 'S', agentIds: ['a1'], broadcastMode: false } as never]
  store.activeSessionId = 's1'
  store.agents = [{ id: 'a1', name: 'ds猫', avatar: '🐯' }] as never
  return store
}

async function mountPanel(): Promise<VueWrapper> {
  const wrapper = mount(SessionHistoryPanel, {
    props: { sessionId: 's1' },
    global: { plugins: [pinia] },
  })
  await flushPromises()
  await nextTick()
  await nextTick()
  return wrapper as VueWrapper
}

describe('SessionHistoryPanel · 取数口径', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupStore()
    vi.mocked(api.getSessionMessageFacets).mockResolvedValue(facetsFixture)
    vi.mocked(api.getSessionMessages).mockResolvedValue(twelveMessages())
    vi.mocked(api.searchSessionMessages).mockResolvedValue({ rows: [], total: 0 })
  })

  it('初始加载：facets 带本地时区偏移，浏览模式走 /messages（不带 q）', async () => {
    const wrapper = await mountPanel()

    expect(api.getSessionMessageFacets).toHaveBeenCalledWith('s1', -new Date().getTimezoneOffset())
    expect(api.getSessionMessages).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ limit: 50 })
    )
    expect(api.searchSessionMessages).not.toHaveBeenCalled()
    expect(wrapper.findAll('.hist-date-chip').map((c) => c.text())).toEqual([
      '全部',
      '11月13日',
      '11月12日',
      `+1 更早`,
    ])

    wrapper.unmount()
  })

  it('搜索：Enter 提交后走 /search，命中处高亮 <mark>，sender 显示猫名', async () => {
    vi.mocked(api.searchSessionMessages).mockResolvedValue({
      rows: [
        msg('m1', 'agent', '部署失败：端口被占用', at(dayA, 10), 'a1'),
        msg('m2', 'user', '端口占用是哪个进程', at(dayA, 9)),
      ],
      total: 2,
    })
    const wrapper = await mountPanel()

    await wrapper.find('.hist-search-input').setValue('端口')
    await wrapper.find('.hist-search-input').trigger('keydown.enter')
    await flushPromises()
    await nextTick()
    await nextTick()

    expect(api.searchSessionMessages).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ q: '端口', limit: 50 })
    )
    const marks = wrapper.findAll('.hc-body mark').map((m) => m.text())
    expect(marks).toEqual(['端口', '端口'])
    // 发送者列：agent 走 agents 表名字，user 显示「我」
    expect(wrapper.findAll('.hc-sender').map((s) => s.text())).toEqual(['ds猫', '我'])

    wrapper.unmount()
  })

  it('筛选 我 / 猫咪：只留对应角色，且回第 1 页', async () => {
    const wrapper = await mountPanel()
    expect(wrapper.findAll('.hist-item').length).toBe(12)

    await wrapper.findAll('.hist-filter')[1].trigger('click')
    await flushPromises()
    await nextTick()
    await nextTick()
    const users = wrapper.findAll('.hist-item:not(.clipped) .hc-body').map((b) => b.text())
    expect(users).toEqual([
      '第 1 条内容',
      '第 3 条内容',
      '第 5 条内容',
      '第 7 条内容',
      '第 9 条内容',
    ])

    await wrapper.findAll('.hist-filter')[2].trigger('click')
    await flushPromises()
    await nextTick()
    await nextTick()
    expect(wrapper.find('.hc-sender').text()).toBe('ds猫')
    expect(wrapper.text()).toContain('第 2 条内容')

    wrapper.unmount()
  })

  it('空结果两种文案分开：无日期 → 没有匹配的消息；有日期 → 这一天没有消息', async () => {
    vi.mocked(api.getSessionMessages).mockResolvedValue([])
    const wrapper = await mountPanel()
    expect(wrapper.find('.hist-state').text()).toBe('没有匹配的消息')

    await wrapper.findAll('.hist-date-chip')[1].trigger('click')
    await flushPromises()
    await nextTick()
    await nextTick()
    expect(wrapper.find('.hist-state').text()).toBe('这一天没有消息')

    wrapper.unmount()
  })

  it('搜索模式分页条显示匹配总数（total 是服务端口径，不受 limit 影响）', async () => {
    vi.mocked(api.searchSessionMessages).mockResolvedValue({
      rows: twelveMessages().slice(0, 5),
      total: 42,
    })
    const wrapper = await mountPanel()
    await wrapper.find('.hist-search-input').setValue('内容')
    await wrapper.find('.hist-search-input').trigger('keydown.enter')
    await flushPromises()
    await nextTick()
    await nextTick()
    expect(wrapper.find('.hp-index').text()).toContain('共 42 条')

    wrapper.unmount()
  })
})

describe('SessionHistoryPanel · 日期条与三级弹层', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupStore()
    vi.mocked(api.getSessionMessageFacets).mockResolvedValue(facetsFixture)
    vi.mocked(api.getSessionMessages).mockResolvedValue(twelveMessages())
  })

  it('选老日期：弹层 年 → 月 → 日，选中后替换进日期条并高亮，回第 1 页', async () => {
    const wrapper = await mountPanel()
    vi.mocked(api.getSessionMessages).mockClear()

    await wrapper.find('.hist-date-chip.more').trigger('click')
    expect(wrapper.find('.hist-datepicker').exists()).toBe(true)
    expect(wrapper.find('.dp-year').text()).toBe(`${Y} 年`)

    // 切到上一年（‹ = 更早一年）
    await wrapper.find('.dp-step[aria-label="上一年"]').trigger('click')
    expect(wrapper.find('.dp-year').text()).toBe(`${Y - 1} 年`)
    expect(wrapper.findAll('.dp-month').map((m) => m.text())).toEqual(['12 月'])

    await wrapper.find('.dp-day').trigger('click')
    await flushPromises()
    await nextTick()
    await nextTick()

    // 选中日期进日期条并高亮（跨年带年份）
    const chips = wrapper.findAll('.hist-date-chip').map((c) => c.text())
    expect(chips).toContain(`${Y - 1}年12月18日`)
    const selected = wrapper
      .findAll('.hist-date-chip')
      .find((c) => c.text() === `${Y - 1}年12月18日`)!
    expect(selected.classes()).toContain('on')
    // 服务端按本地日窗口收窄（from/to 都传）
    expect(api.getSessionMessages).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        from: expect.any(String),
        to: expect.any(String),
      })
    )
    expect(wrapper.find('.hp-index').text()).toBe('第 1 页')
    expect(wrapper.find('.hist-datepicker').exists()).toBe(false)

    wrapper.unmount()
  })
})

describe('SessionHistoryPanel · 一屏装页（不内滚）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupStore()
    vi.mocked(api.getSessionMessageFacets).mockResolvedValue(facetsFixture)
    vi.mocked(api.getSessionMessages).mockResolvedValue(twelveMessages())
  })

  function stubResizeObserver(): Array<() => void> {
    const observed: Array<() => void> = []
    class FakeRO {
      constructor(cb: () => void) {
        observed.push(cb)
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', FakeRO as never)
    return observed
  }

  it('900 高装 5 条、1080 高装 7 条（其余 clipped），结果区不内滚', async () => {
    const observed = stubResizeObserver()
    viewportH = 900
    const wrapper = await mountPanel()
    expect(wrapper.findAll('.hist-item:not(.clipped)')).toHaveLength(5)
    expect(wrapper.findAll('.hist-item.clipped')).toHaveLength(7)

    const el = wrapper.find('.hist-results').element as HTMLElement
    expect(el.scrollHeight).toBeLessThanOrEqual(el.clientHeight)

    viewportH = 1080
    observed.forEach((cb) => cb())
    await flushPromises()
    await nextTick()
    await nextTick()
    expect(wrapper.findAll('.hist-item:not(.clipped)')).toHaveLength(7)

    vi.unstubAllGlobals()
    wrapper.unmount()
  })

  it('尺寸变化重排：条数变多，且锚定原屏首条（页起点不动）', async () => {
    const observed = stubResizeObserver()

    viewportH = 900
    const wrapper = await mountPanel()
    const firstBefore = wrapper.findAll('.hist-item:not(.clipped) .hc-body')[0].text()
    expect(wrapper.findAll('.hist-item:not(.clipped)')).toHaveLength(5)

    viewportH = 1080
    expect(observed.length).toBeGreaterThan(0)
    observed.forEach((cb) => cb())
    await flushPromises()
    await nextTick()
    await nextTick()

    expect(wrapper.findAll('.hist-item:not(.clipped)')).toHaveLength(7)
    expect(wrapper.findAll('.hist-item:not(.clipped) .hc-body')[0].text()).toBe(firstBefore)

    vi.unstubAllGlobals()
    wrapper.unmount()
  })

  it('翻页：游标取当前屏最后一条（不跳过被裁掉的），上一页可回退', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) =>
      msg(`p1-${i}`, 'user', `第一页 ${i}`, at(dayA, 10, i))
    )
    vi.mocked(api.getSessionMessages).mockResolvedValueOnce(page1)
    vi.mocked(api.getSessionMessages).mockResolvedValueOnce([])
    const wrapper = await mountPanel()

    // 一屏只显示 5 条；下一页游标 = 第 5 条（不是第 50 条）
    const fifth = wrapper.findAll('.hist-item:not(.clipped) .hc-body')[4].text()
    await wrapper.findAll('.hp-btn')[1].trigger('click')
    await flushPromises()
    await nextTick()
    await nextTick()

    const secondCall = vi.mocked(api.getSessionMessages).mock.calls[1][1] as any
    expect(secondCall.before).toBe('p1-4')
    expect(fifth).toContain('第一页 4')
    expect(wrapper.find('.hp-index').text()).toBe('第 2 页')

    await wrapper.findAll('.hp-btn')[0].trigger('click')
    await flushPromises()
    await nextTick()
    await nextTick()
    expect(wrapper.find('.hp-index').text()).toBe('第 1 页')

    wrapper.unmount()
  })

  it('翻页失败：保留已读的一页，错误单独一行提示（不把结果区打成错误态）', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) =>
      msg(`p1-${i}`, 'user', `第一页 ${i}`, at(dayA, 10, i))
    )
    vi.mocked(api.getSessionMessages).mockResolvedValueOnce(page1)
    vi.mocked(api.getSessionMessages).mockRejectedValueOnce(new Error('网络抖了一下'))
    const wrapper = await mountPanel()

    await wrapper.findAll('.hp-btn')[1].trigger('click')
    await flushPromises()
    await nextTick()
    await nextTick()

    // 旧页仍在（不是空态），错误在独立一行
    expect(wrapper.findAll('.hist-item:not(.clipped)')).toHaveLength(5)
    expect(wrapper.findAll('.hist-reveal-err').map((e) => e.text())).toContain('网络抖了一下')

    wrapper.unmount()
  })
})

describe('SessionHistoryPanel · 跳转主区', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupStore()
    vi.mocked(api.getSessionMessageFacets).mockResolvedValue(facetsFixture)
    vi.mocked(api.getSessionMessages).mockResolvedValue(twelveMessages())
  })

  it('点结果调 store.revealMessage(id)；面板保持打开；返回 false 显式提示', async () => {
    const store = useChatStore()
    const spy = vi.spyOn(store, 'revealMessage').mockResolvedValue(true)
    const wrapper = await mountPanel()

    await wrapper.find('.hist-card').trigger('click')
    await flushPromises()
    expect(spy).toHaveBeenCalledWith('m1')
    expect(wrapper.find('.session-history-panel').exists()).toBe(true)
    expect(wrapper.find('.hist-reveal-err').exists()).toBe(false)

    spy.mockResolvedValue(false)
    await wrapper.findAll('.hist-card')[1].trigger('click')
    await flushPromises()
    expect(wrapper.find('.hist-reveal-err').text()).toBe('该消息已在会话开头之前')

    wrapper.unmount()
  })
})

describe('SessionHistoryPanel · 形态值（静态）', () => {
  it('宽度 100%（不设宽、不拉伸）、无叠层/位移；结果区 overflow hidden（不内滚）', () => {
    const root = /\.session-history-panel\s*\{([^}]*)\}/.exec(panelSource)?.[1] ?? ''
    expect(root).toMatch(/width:\s*100%/)
    expect(root).not.toMatch(/(^|[\s;])width:\s*\d+px/)
    expect(panelSource).not.toContain('position: fixed')
    expect(panelSource).not.toContain('transform:')
    expect(panelSource).not.toContain('overlay')
    // 结果区不内滚：overflow hidden（装不下由装页逻辑裁，翻页给下一页）
    const results = /\.hist-results\s*\{([^}]*)\}/.exec(panelSource)?.[1] ?? ''
    expect(results).toMatch(/overflow:\s*hidden/)
  })

  it('卡片口径：5 行正文 / 13px / 1.62（原型定稿读数）', () => {
    const body = /\.hc-body\s*\{([^}]*)\}/.exec(panelSource)?.[1] ?? ''
    expect(body).toMatch(/font-size:\s*13px/)
    expect(body).toMatch(/line-height:\s*1\.62/)
    expect(body).toMatch(/-webkit-line-clamp:\s*5/)
  })
})
