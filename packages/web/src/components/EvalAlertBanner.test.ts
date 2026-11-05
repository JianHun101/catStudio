// @vitest-environment jsdom
/**
 * 全局评估告警横幅——挂载测试（jsdom + mock useApi 边界）。
 *
 * 覆盖：无破线不渲染 / 破线显示文案与静态指引 / 关闭写 localStorage 并隐藏 /
 * 数值变化后签名变化而重新出现 / 「去评估中心」emit。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import EvalAlertBanner from './EvalAlertBanner.vue'
import { api } from '@/composables/useApi'
import type { EvalL1Metrics, ThresholdBreach } from '@/composables/useApi'

vi.mock('@/composables/useApi', () => ({
  api: {
    getEvalL1Metrics: vi.fn(),
  },
}))

const DISMISS_KEY = 'catstudy.eval-alert.dismissed'

const thresholds = {
  successRate: 0.8,
  timeoutRate: 0.1,
  reworkRate: 0.3,
  minExecutions: 20,
  minVerdicts: 30,
}

function metricsWith(breaches: ThresholdBreach[]): EvalL1Metrics {
  return {
    windowDays: 30,
    successRate: 0.5,
    timeoutRate: 0.2,
    avgLatencyMs: 1000,
    totalTokens: 100,
    suggestRate: 0.3,
    rejectRate: 0.1,
    parseFailureRate: 0,
    infraFailures: 0,
    sampleTotal: 100,
    verdictTotal: 100,
    thresholds,
    breaches,
    insufficient: [],
  }
}

const successBreach = (value: number): ThresholdBreach => ({
  key: 'successRate',
  value,
  threshold: 0.8,
  text: `执行成功率 ${(value * 100).toFixed(1)}%（< 80%）`,
})

describe('EvalAlertBanner', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.mocked(api.getEvalL1Metrics).mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('breaches 为空 → 不渲染任何 DOM', async () => {
    vi.mocked(api.getEvalL1Metrics).mockResolvedValue(metricsWith([]))
    const wrapper = mount(EvalAlertBanner)
    await flushPromises()

    expect(wrapper.find('.eval-alert').exists()).toBe(false)
    expect(wrapper.text()).toBe('')
    wrapper.unmount()
  })

  it('破线 → 显示每条 text + 对应静态指引', async () => {
    vi.mocked(api.getEvalL1Metrics).mockResolvedValue(
      metricsWith([
        successBreach(0.5),
        { key: 'reworkRate', value: 0.4, threshold: 0.3, text: '返工率 40.0%（> 30%）' },
      ])
    )
    const wrapper = mount(EvalAlertBanner)
    await flushPromises()

    const banner = wrapper.find('.eval-alert')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('执行成功率 50.0%')
    expect(banner.text()).toContain('看失败执行的 error_type')
    expect(banner.text()).toContain('返工率 40.0%')
    expect(banner.text()).toContain('去链路 tab 看返工集中在哪几条链')
    wrapper.unmount()
  })

  it('关闭 → 写 localStorage 签名并隐藏', async () => {
    vi.mocked(api.getEvalL1Metrics).mockResolvedValue(metricsWith([successBreach(0.5)]))
    const wrapper = mount(EvalAlertBanner)
    await flushPromises()

    await wrapper.find('.eval-alert-close').trigger('click')
    expect(wrapper.find('.eval-alert').exists()).toBe(false)
    expect(localStorage.getItem(DISMISS_KEY)).toBe('successRate:0.500')
    wrapper.unmount()
  })

  it('数值变化（签名变）→ 重新出现', async () => {
    vi.mocked(api.getEvalL1Metrics).mockResolvedValue(metricsWith([successBreach(0.5)]))
    const first = mount(EvalAlertBanner)
    await flushPromises()
    await first.find('.eval-alert-close').trigger('click')
    expect(first.find('.eval-alert').exists()).toBe(false)
    first.unmount()

    // 同一浏览器存储、不同数值：签名不同 ⇒ 关闭态不延续
    vi.mocked(api.getEvalL1Metrics).mockResolvedValue(metricsWith([successBreach(0.6)]))
    const second = mount(EvalAlertBanner)
    await flushPromises()
    expect(second.find('.eval-alert').exists()).toBe(true)
    expect(second.text()).toContain('执行成功率 60.0%')
    second.unmount()
  })

  it('点「去评估中心」→ emit open-eval', async () => {
    vi.mocked(api.getEvalL1Metrics).mockResolvedValue(metricsWith([successBreach(0.5)]))
    const wrapper = mount(EvalAlertBanner)
    await flushPromises()

    await wrapper.find('.eval-alert-open').trigger('click')
    expect(wrapper.emitted('open-eval')).toHaveLength(1)
    wrapper.unmount()
  })

  it('接口失败 → 静默不渲染（横幅是旁路，不弹错误）', async () => {
    vi.mocked(api.getEvalL1Metrics).mockRejectedValue(new Error('boom'))
    const wrapper = mount(EvalAlertBanner)
    await flushPromises()

    expect(wrapper.find('.eval-alert').exists()).toBe(false)
    wrapper.unmount()
  })
})
