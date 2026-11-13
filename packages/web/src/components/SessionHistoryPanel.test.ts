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
    getSessionBrowseMessages: vi.fn(),
    searchSessionMessages: vi.fn(),
  },
}))

/**
 * 右栏历史面板（C-2）。
 *
 * 几何口径：jsdom 没有布局引擎，故用 getter 模拟真实浏览器的**实测值**——结果区高度
 * 716px（1440×900）/ 896px（1440×1080）是 Chromium 里的实测读数（探针为 gitignored 临时
 * 脚本，未入库；读数与复现见 PR #243 / 收口记录），不是窗口高度。卡片高度按正文长度分三档
 * （短 55 / 中 97 / 长 139，量级取自同一次探针），日期头 21px——不再是「所有卡固定 141px +
 * 结果区等于窗口高度」的恒等式；那个 mock 曾把 5/7 自证成真，实际 652px 里装不下。
 */
const RESULTS_900 = 716
const RESULTS_1080 = 896
const HIST_GAP = 6
const DAY_BLOCK = 21 // 日期头 + 卡内间距（探针：item 118.14 − card 97.14）

let resultsH = RESULTS_900

function bodyLen(el: HTMLElement): number {
  return (el.querySelector('.hc-body')?.textContent ?? '').trim().length
}

/** 与探针里的三档内容长度对应：短 55 / 中 97 / 长 139 */
function cardHeight(len: number): number {
  return len > 100 ? 139 : len > 30 ? 97 : 55
}

beforeEach(() => {
  resultsH = RESULTS_900
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList.contains('clipped')) return 0
      if (this.classList.contains('hist-card')) return cardHeight(bodyLen(this))
      if (this.classList.contains('hist-day')) return 17
      if (this.classList.contains('hist-item')) {
        return cardHeight(bodyLen(this)) + (this.querySelector('.hist-day') ? DAY_BLOCK : 0)
      }
      return 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('hist-results') ? resultsH : 0
    },
  })
  // 只累加**未被裁掉**的项——不是 `max(clientHeight, …)` 的恒等式，装页算法装不下时这里会超
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (!this.classList.contains('hist-results')) return 0
      const items = Array.from(this.querySelectorAll<HTMLElement>('.hist-item')).filter(
        (i) => !i.classList.contains('clipped')
      )
      return items.reduce((sum, i) => sum + i.offsetHeight + HIST_GAP, 0)
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

/**
 * 27 条真实量级的历史（与探针同构：短/中/长三档混排、含 system、同一天）。
 * 716px 结果区装 8 条、896px 装 10 条——这是真实 Chromium 的读数，不是窗口高度。
 */
function historyMessages(): Message[] {
  const base = Date.parse(at(dayA, 12, 0))
  return Array.from({ length: 27 }, (_, i) => {
    const n = 27 - i
    const content =
      n % 7 === 0
        ? `第${n}条：` +
          '这是一段比较长的消息内容，用来模拟真实聊天里五行正文的卡片，包含部署、回滚、测试与环境。'.repeat(
            3
          )
        : n % 3 === 0
          ? `第${n}条：` + '中等长度的消息，大概两到三行，带一些上下文。'.repeat(2)
          : `第${n}条：短消息 ${n}`
    return msg(
      `m-${n}`,
      n % 9 === 0 ? 'system' : n % 2 === 0 ? 'agent' : 'user',
      content,
      new Date(base - i * 60_000).toISOString(),
      n % 2 === 0 ? 'a1' : null
    )
  })
}

/** 10 条短消息（全部一屏装得下），用于角色筛选 */
function shortAlternating(): Message[] {
  return Array.from({ length: 10 }, (_, i) =>
    msg(
      `s${i + 1}`,
      i % 2 === 0 ? 'user' : 'agent',
      `短 ${i + 1}`,
      at(dayA, 10, 9 - i),
      i % 2 === 0 ? null : 'a1'
    )
  )
}

/**
 * 两种 mock 场景**互不校验**，别把两处 `total` 当同一份数据：
 * - `facetsFixture` 服务「日期条」场景：8 条（days 4+3+1），只驱动日期 chip 与弹层；
 * - browse mock 服务「一屏装页」场景：27 条（`historyMessages()` 全量），只驱动装页/翻页。
 * 两个 fixture 的 total 天然不等；要改就改各自场景，不要为凑一致去改编页数据。
 */
const facetsFixture = {
  // total = days 之和（之前写 15 与 4+3+1 不一致，会被下一个读者当真实数据）
  total: 8,
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
    vi.mocked(api.getSessionBrowseMessages).mockResolvedValue({
      rows: historyMessages(),
      // 装页场景 27 条：与 facetsFixture 的 8 条不是同一份数据（见上方 fixture 说明）
      total: 27,
    })
    vi.mocked(api.searchSessionMessages).mockResolvedValue({ rows: [], total: 0 })
  })

  it('初始加载：facets 带本地时区偏移，浏览模式走 /messages/browse（含 system，带 total）', async () => {
    const wrapper = await mountPanel()

    expect(api.getSessionMessageFacets).toHaveBeenCalledWith('s1', -new Date().getTimezoneOffset())
    expect(api.getSessionBrowseMessages).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ limit: 50 })
    )
    expect(api.searchSessionMessages).not.toHaveBeenCalled()
    expect(wrapper.findAll('.hist-date-chip').map((c) => c.text())).toEqual([
      '全部',
      '11月13日',
      '11月12日',
      '选择日期',
      '+1 更早',
    ])
    // 浏览模式也有 total：分页条不再只有搜索模式能显示总数
    expect(wrapper.find('.hp-index').text()).toContain('共 27 条')

    wrapper.unmount()
  })

  it('搜索：Enter 提交后走 /search，正文命中处高亮 <mark>，sender 显示猫名', async () => {
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

  it('发送者命中同样高亮（搜猫名时卡上至少有一处 <mark>，不是只有正文）', async () => {
    vi.mocked(api.searchSessionMessages).mockResolvedValue({
      rows: [msg('m1', 'agent', '与关键字无关的正文', at(dayA, 10), 'a1')],
      total: 1,
    })
    const wrapper = await mountPanel()

    await wrapper.find('.hist-search-input').setValue('ds猫')
    await wrapper.find('.hist-search-input').trigger('keydown.enter')
    await flushPromises()
    await nextTick()
    await nextTick()

    expect(wrapper.findAll('.hc-body mark')).toHaveLength(0)
    expect(wrapper.findAll('.hc-sender mark').map((m) => m.text())).toEqual(['ds猫'])

    wrapper.unmount()
  })

  it('筛选 我 / 猫咪：只留对应角色，且回第 1 页', async () => {
    vi.mocked(api.getSessionBrowseMessages).mockResolvedValue({
      rows: shortAlternating(),
      total: 10,
    })
    const wrapper = await mountPanel()
    expect(wrapper.findAll('.hist-item:not(.clipped)').length).toBe(10)

    await wrapper.findAll('.hist-filter')[1].trigger('click')
    await flushPromises()
    await nextTick()
    await nextTick()
    const users = wrapper.findAll('.hist-item:not(.clipped) .hc-body').map((b) => b.text())
    expect(users).toEqual(['短 1', '短 3', '短 5', '短 7', '短 9'])

    await wrapper.findAll('.hist-filter')[2].trigger('click')
    await flushPromises()
    await nextTick()
    await nextTick()
    const agents = wrapper.findAll('.hist-item:not(.clipped) .hc-body').map((b) => b.text())
    expect(agents).toEqual(['短 2', '短 4', '短 6', '短 8', '短 10'])
    expect(wrapper.find('.hc-sender').text()).toBe('ds猫')

    wrapper.unmount()
  })

  it('空结果两种文案分开：无日期 → 没有匹配的消息；有日期 → 这一天没有消息', async () => {
    vi.mocked(api.getSessionBrowseMessages).mockResolvedValue({ rows: [], total: 0 })
    const wrapper = await mountPanel()
    expect(wrapper.find('.hist-state').text()).toBe('没有匹配的消息')

    await wrapper.findAll('.hist-date-chip')[1].trigger('click')
    await flushPromises()
    await nextTick()
    await nextTick()
    expect(wrapper.find('.hist-state').text()).toBe('这一天没有消息')

    wrapper.unmount()
  })

  it('搜索 + 日期同时为空：搜索词优先（不误报「这一天没有消息」）', async () => {
    const wrapper = await mountPanel()

    await wrapper.find('.hist-search-input').setValue('不存在')
    await wrapper.find('.hist-search-input').trigger('keydown.enter')
    await flushPromises()
    await nextTick()
    await nextTick()
    expect(wrapper.find('.hist-state').text()).toBe('没有匹配的消息')

    await wrapper.findAll('.hist-date-chip')[1].trigger('click')
    await flushPromises()
    await nextTick()
    await nextTick()
    expect(wrapper.find('.hist-state').text()).toBe('没有匹配的消息')

    wrapper.unmount()
  })

  it('搜索模式分页条显示匹配总数；角色筛选时注明未计筛选', async () => {
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
    expect(wrapper.find('.hp-note').exists()).toBe(false)

    await wrapper.findAll('.hist-filter')[1].trigger('click')
    await flushPromises()
    await nextTick()
    await nextTick()
    expect(wrapper.find('.hp-note').text()).toContain('未计角色筛选')

    wrapper.unmount()
  })
})

describe('SessionHistoryPanel · 日期条与三级弹层', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupStore()
    vi.mocked(api.getSessionMessageFacets).mockResolvedValue(facetsFixture)
    vi.mocked(api.getSessionBrowseMessages).mockResolvedValue({
      rows: historyMessages(),
      // 装页场景 27 条：与 facetsFixture 的 8 条不是同一份数据（见上方 fixture 说明）
      total: 27,
    })
  })

  it('「选择日期」入口常驻，点开同一个三级弹层，「全部时间」可收起', async () => {
    const wrapper = await mountPanel()

    await wrapper.find('.hist-date-chip.picker').trigger('click')
    expect(wrapper.find('.hist-datepicker').exists()).toBe(true)
    expect(wrapper.find('.dp-year').text()).toBe(`${Y} 年`)

    await wrapper.find('.dp-all').trigger('click')
    expect(wrapper.find('.hist-datepicker').exists()).toBe(false)

    wrapper.unmount()
  })

  it('选老日期：弹层 年 → 月 → 日，选中后替换进日期条并高亮，回第 1 页', async () => {
    const wrapper = await mountPanel()
    vi.mocked(api.getSessionBrowseMessages).mockClear()

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
    // 服务端按本地日窗口收窄（from/to 都传），并走含 system 的 browse
    expect(api.getSessionBrowseMessages).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        from: expect.any(String),
        to: expect.any(String),
      })
    )
    expect(wrapper.find('.hp-index').text()).toBe('第 1 页 · 共 27 条')
    expect(wrapper.find('.hist-datepicker').exists()).toBe(false)

    wrapper.unmount()
  })
})

describe('SessionHistoryPanel · 一屏装页（不内滚）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupStore()
    vi.mocked(api.getSessionMessageFacets).mockResolvedValue(facetsFixture)
    vi.mocked(api.getSessionBrowseMessages).mockResolvedValue({
      rows: historyMessages(),
      // 装页场景 27 条：与 facetsFixture 的 8 条不是同一份数据（见上方 fixture 说明）
      total: 27,
    })
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

  it('真实结果区高度：716px 装 8 条、896px 装 10 条；结果区不内滚', async () => {
    const observed = stubResizeObserver()
    resultsH = RESULTS_900
    const wrapper = await mountPanel()
    expect(wrapper.findAll('.hist-item:not(.clipped)')).toHaveLength(8)
    expect(wrapper.findAll('.hist-item.clipped')).toHaveLength(19)

    const el = wrapper.find('.hist-results').element as HTMLElement
    // clientHeight 是真实结果区高度，不是窗口高度
    expect(el.clientHeight).toBe(RESULTS_900)
    expect(el.scrollHeight).toBeLessThanOrEqual(el.clientHeight)
    // 装页是紧的：剩余空间不足以再塞下一张短卡（55+6）
    expect(el.clientHeight - el.scrollHeight).toBeLessThan(61)

    resultsH = RESULTS_1080
    observed.forEach((cb) => cb())
    await flushPromises()
    await nextTick()
    await nextTick()
    expect(wrapper.findAll('.hist-item:not(.clipped)')).toHaveLength(10)
    const el2 = wrapper.find('.hist-results').element as HTMLElement
    expect(el2.clientHeight).toBe(RESULTS_1080)
    expect(el2.scrollHeight).toBeLessThanOrEqual(el2.clientHeight)

    vi.unstubAllGlobals()
    wrapper.unmount()
  })

  it('尺寸变化重排：条数变多，且锚定原屏首条（页起点不动）', async () => {
    const observed = stubResizeObserver()

    resultsH = RESULTS_900
    const wrapper = await mountPanel()
    const firstBefore = wrapper.findAll('.hist-item:not(.clipped) .hc-body')[0].text()
    expect(wrapper.findAll('.hist-item:not(.clipped)')).toHaveLength(8)

    resultsH = RESULTS_1080
    expect(observed.length).toBeGreaterThan(0)
    observed.forEach((cb) => cb())
    await flushPromises()
    await nextTick()
    await nextTick()

    expect(wrapper.findAll('.hist-item:not(.clipped)')).toHaveLength(10)
    expect(wrapper.findAll('.hist-item:not(.clipped) .hc-body')[0].text()).toBe(firstBefore)

    vi.unstubAllGlobals()
    wrapper.unmount()
  })

  it('翻页：游标取当前屏最后一条（不跳过被裁掉的），上一页可回退', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) =>
      msg(`p1-${i}`, 'user', `第一页 ${i}`, at(dayA, 10, i))
    )
    // 服务端 DESC：最新在前（p2-4 在 9:04）
    const page2 = Array.from({ length: 5 }, (_, i) =>
      msg(`p2-${4 - i}`, 'user', `第二页 ${4 - i}`, at(dayA, 9, 4 - i))
    )
    vi.mocked(api.getSessionBrowseMessages)
      .mockResolvedValueOnce({ rows: page1, total: 50 })
      .mockResolvedValueOnce({ rows: page2, total: 50 })
      .mockResolvedValue({ rows: page1, total: 50 })
    const wrapper = await mountPanel()

    // 一屏只显示 11 条；下一页游标 = 第 11 条（不是第 50 条）
    expect(wrapper.findAll('.hist-item:not(.clipped)')).toHaveLength(11)
    await wrapper.findAll('.hp-btn')[1].trigger('click')
    await flushPromises()
    await nextTick()
    await nextTick()

    const secondCall = vi.mocked(api.getSessionBrowseMessages).mock.calls[1][1] as any
    expect(secondCall.before).toBe('p1-10')
    expect(wrapper.find('.hp-index').text()).toBe('第 2 页 · 共 50 条')
    expect(wrapper.find('.hc-body').text()).toBe('第二页 4')

    await wrapper.findAll('.hp-btn')[0].trigger('click')
    await flushPromises()
    await nextTick()
    await nextTick()
    expect(wrapper.find('.hp-index').text()).toBe('第 1 页 · 共 50 条')

    wrapper.unmount()
  })

  it('翻页失败：保留已读的一页，错误单独一行提示（不把结果区打成错误态）', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) =>
      msg(`p1-${i}`, 'user', `第一页 ${i}`, at(dayA, 10, i))
    )
    vi.mocked(api.getSessionBrowseMessages)
      .mockResolvedValueOnce({ rows: page1, total: 50 })
      .mockRejectedValueOnce(new Error('网络抖了一下'))
    const wrapper = await mountPanel()

    await wrapper.findAll('.hp-btn')[1].trigger('click')
    await flushPromises()
    await nextTick()
    await nextTick()

    // 旧页仍在（不是空态），错误在独立一行
    expect(wrapper.findAll('.hist-item:not(.clipped)')).toHaveLength(11)
    expect(wrapper.findAll('.hist-reveal-err').map((e) => e.text())).toContain('网络抖了一下')

    wrapper.unmount()
  })

  it('角色筛选把整页筛空：提示「继续翻页」，下一页按钮仍能发出请求（不是死路）', async () => {
    let calls = 0
    vi.mocked(api.getSessionBrowseMessages).mockImplementation(async () => {
      calls++
      if (calls <= 11) {
        return {
          rows: Array.from({ length: 50 }, (_, j) =>
            msg(`a-${calls}-${j}`, 'agent', `猫 ${calls}-${j}`, at(dayA, 10, j), 'a1')
          ),
          total: 500,
        }
      }
      return { rows: [], total: 500 }
    })
    const wrapper = await mountPanel()

    await wrapper.findAll('.hist-filter')[1].trigger('click')
    await flushPromises()
    await nextTick()
    await nextTick()
    // 首屏 role=all 取 1 个 chunk 就够 TARGET_ROWS；切「我」后连取 MAX_CHUNKS=10 个 chunk
    expect(calls).toBe(11)
    expect(wrapper.find('.hist-state').text()).toBe('本页没有匹配，继续翻页')

    await wrapper.findAll('.hp-btn')[1].trigger('click')
    await flushPromises()
    await nextTick()
    await nextTick()
    expect(calls).toBe(12)
    const twelfth = vi.mocked(api.getSessionBrowseMessages).mock.calls[11][1] as any
    expect(twelfth.before).toBe('a-11-49')

    wrapper.unmount()
  })
})

describe('SessionHistoryPanel · 过期响应与跳转主区', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setupStore()
    vi.mocked(api.getSessionMessageFacets).mockResolvedValue(facetsFixture)
    vi.mocked(api.getSessionBrowseMessages).mockResolvedValue({
      rows: twelveMessages(),
      total: 12,
    })
    vi.mocked(api.searchSessionMessages).mockResolvedValue({ rows: [], total: 0 })
  })

  it('浏览请求未回时按 Enter 搜索：旧响应晚到不得覆盖新结果', async () => {
    let resolveBrowse!: (v: { rows: Message[]; total: number }) => void
    vi.mocked(api.getSessionBrowseMessages).mockReturnValue(
      new Promise((resolve) => {
        resolveBrowse = resolve as never
      }) as never
    )
    const wrapper = mount(SessionHistoryPanel, {
      props: { sessionId: 's1' },
      global: { plugins: [pinia] },
    })
    await nextTick()

    vi.mocked(api.searchSessionMessages).mockResolvedValue({
      rows: [msg('s-1', 'user', '搜索命中', at(dayA, 10))],
      total: 1,
    })
    await wrapper.find('.hist-search-input').setValue('命中')
    await wrapper.find('.hist-search-input').trigger('keydown.enter')
    await flushPromises()
    await nextTick()
    await nextTick()
    expect(wrapper.text()).toContain('搜索命中')

    resolveBrowse({ rows: twelveMessages(), total: 12 })
    await flushPromises()
    await nextTick()
    await nextTick()
    expect(wrapper.text()).toContain('搜索命中')
    expect(wrapper.text()).not.toContain('第 1 条内容')

    wrapper.unmount()
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
    expect(wrapper.find('.hist-reveal-note').exists()).toBe(false)

    spy.mockResolvedValue(false)
    await wrapper.findAll('.hist-card')[1].trigger('click')
    await flushPromises()
    expect(wrapper.find('.hist-reveal-err').text()).toBe('该消息已在会话开头之前')
    // 真实失败留在红色错误态，不落到中性说明里
    expect(wrapper.find('.hist-reveal-note').exists()).toBe(false)

    wrapper.unmount()
  })

  it('revealMessage 失败且有 olderError 时显示真实错误，不归因成「开头之前」', async () => {
    const store = useChatStore()
    const spy = vi.spyOn(store, 'revealMessage').mockResolvedValue(false)
    store.olderError = '网络断了'
    const wrapper = await mountPanel()

    await wrapper.find('.hist-card').trigger('click')
    await flushPromises()
    expect(spy).toHaveBeenCalled()
    expect(wrapper.find('.hist-reveal-err').text()).toBe('网络断了')

    wrapper.unmount()
  })

  it('system 结果不可跳转：给专门文案，不白翻 50 轮后误报「开头之前」', async () => {
    vi.mocked(api.getSessionBrowseMessages).mockResolvedValue({
      rows: [msg('sys-1', 'system', '重启完成', at(dayA, 10))],
      total: 1,
    })
    const store = useChatStore()
    const spy = vi.spyOn(store, 'revealMessage').mockResolvedValue(false)
    const wrapper = await mountPanel()

    await wrapper.find('.hist-card').trigger('click')
    await flushPromises()
    expect(spy).not.toHaveBeenCalled()
    // 中性说明走 .hist-reveal-note（muted 色），不能落到 .hist-reveal-err 红态上
    expect(wrapper.find('.hist-reveal-note').text()).toBe('系统通知不在主消息流中显示')
    expect(wrapper.find('.hist-reveal-err').exists()).toBe(false)

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

  it('system 中性说明用 muted 色，红色错误态保留 accent-red（两类不混用）', () => {
    const note = /\.hist-reveal-note\s*\{([^}]*)\}/.exec(panelSource)?.[1] ?? ''
    expect(note).toMatch(/color:\s*var\(--text-muted\)/)
    const err = /\.hist-reveal-err\s*\{([^}]*)\}/.exec(panelSource)?.[1] ?? ''
    expect(err).toMatch(/color:\s*var\(--accent-red\)/)
  })
})
