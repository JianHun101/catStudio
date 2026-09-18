import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import source from './ReplyElapsed.vue?raw'
import ReplyElapsed from './ReplyElapsed.vue'

/**
 * ReplyElapsed 行为契约（fake timer 三态）：
 * · N < 60 → 「回复中 · 已 N 秒」逐秒递增
 * · N ≥ 60 → 「回复中 · 已 M:SS」
 * · lastBeatAt 停滞 > 25s → 红字「无响应」且秒数停走（liveness：本地时钟不能掩盖 server 已死）
 *
 * 锚点**来自 props**（服务端执行起点），所以挂载即显示正确秒数——刷新/切会话回来
 * 靠下一个心跳重发同值恢复原秒数，不归零。
 */

const T0 = 1_700_000_000_000

describe('ReplyElapsed', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function mountTimer(startedAt: number, lastBeatAt: number) {
    return mount(ReplyElapsed, { props: { startedAt, lastBeatAt } })
  }

  it('秒数由 props 锚点算出（非挂载时刻）——挂载即显真实已跑时长', () => {
    const wrapper = mountTimer(T0 - 30_000, T0)
    expect(wrapper.text()).toBe('回复中 · 已 30 秒')
  })

  it('本地 1s tick 逐秒递增（服务端心跳 10s 一跳太粗，平滑靠本地 tick）', async () => {
    const wrapper = mountTimer(T0 - 5_000, T0)
    expect(wrapper.text()).toBe('回复中 · 已 5 秒')

    vi.advanceTimersByTime(1000)
    await nextTick()
    expect(wrapper.text()).toBe('回复中 · 已 6 秒')

    vi.advanceTimersByTime(3000)
    await nextTick()
    expect(wrapper.text()).toBe('回复中 · 已 9 秒')
  })

  it('≥60s 转 M:SS（59s 仍是「N 秒」，边界不早转）', async () => {
    const under = mountTimer(T0 - 59_000, T0)
    expect(under.text()).toBe('回复中 · 已 59 秒')
    under.unmount()

    const over = mountTimer(T0 - 192_000, T0)
    expect(over.text()).toBe('回复中 · 已 3:12')

    // 秒位补零（1:05 不是 1:5）
    const padded = mountTimer(T0 - 65_000, T0)
    expect(padded.text()).toBe('回复中 · 已 1:05')
  })

  it('心跳失联 >25s → 「无响应」并停走；25s 整不翻（阈值语义「超过」）', async () => {
    const onEdge = mountTimer(T0 - 60_000, T0 - 25_000)
    expect(onEdge.text()).toBe('回复中 · 已 1:00')
    onEdge.unmount()

    const wrapper = mountTimer(T0 - 30_000, T0 - 25_001)
    expect(wrapper.text()).toBe('无响应')
    // 红字：stale class 驱动（accent-red）
    expect(wrapper.find('.reply-elapsed').classes()).toContain('stale')

    // 停走：tick 继续跑但文案不再变成秒数
    vi.advanceTimersByTime(10_000)
    await nextTick()
    expect(wrapper.text()).toBe('无响应')
  })

  it('心跳恢复（新 lastBeatAt）→ 从原锚点继续，秒数不重置', async () => {
    const wrapper = mountTimer(T0 - 40_000, T0)
    expect(wrapper.text()).toBe('回复中 · 已 40 秒')

    vi.advanceTimersByTime(10_000)
    await wrapper.setProps({ startedAt: T0 - 40_000, lastBeatAt: T0 + 10_000 })
    expect(wrapper.text()).toBe('回复中 · 已 50 秒')
  })

  it('卸载清 tick（组件随气泡卸载，timer 不得泄漏）', () => {
    const wrapper = mountTimer(T0 - 1_000, T0)
    expect(vi.getTimerCount()).toBe(1)
    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('ReplyElapsed 静态源契约', () => {
  it('每秒变化的 now 封在叶子组件内（ChatPanel 顶层不得有）', () => {
    expect(source).toContain('now = ref(Date.now())')
    expect(source).toMatch(
      /nowTimer = setInterval\(\(\) => \{\s*now\.value = Date\.now\(\)\s*\}, 1000\)/
    )
    expect(source).toMatch(/if \(nowTimer\) \{\s*clearInterval\(nowTimer\)/)
  })

  it('秒数读 now.value 而非直接 Date.now()（否则 tick 不触发重渲染）', () => {
    expect(source).toContain('Math.floor((now.value - props.startedAt) / 1000)')
    expect(source).not.toContain('Math.floor((Date.now() - props.startedAt) / 1000)')
  })

  it('liveness 阈值与 AgentStatusLabel 同值（2×10s 心跳 + 5s 余量）', () => {
    expect(source).toContain('HEARTBEAT_STALE_MS = 25_000')
    expect(source).toContain('now.value - props.lastBeatAt > HEARTBEAT_STALE_MS')
  })
})
