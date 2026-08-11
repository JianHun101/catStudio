// @vitest-environment jsdom
// 挂载测试需要 DOM（mount + trigger）。文件级环境注释——根配置 environment 为默认 node
// （E4-B 测试基建结论：workspace 目录型 project 不加载 web 包内 vitest.config.ts，
// 根配置为唯一生效注入点，故 jsdom 按文件声明；web 包内单独跑时包内配置已是 jsdom，无冲突）
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import source from './EvaluationView.vue?raw'
import EvaluationView from './EvaluationView.vue'
import { api } from '@/composables/useApi'

/**
 * E4-B 评估中心前端——两层测试：
 * 1. ?raw 静态源断言（照 SettingsView.test.ts 约定）：双 tab 结构 / 三态 / 7 类结局 / 办成率 / 角标
 * 2. 挂载测试（@vue/test-utils + jsdom，mock useApi 边界）：渲染真实数据 + 回标提交闭环
 *    （样本移出 + 角标减一）+ 接口失败错误态。
 */

// mock useApi 边界（组件只消费 api 对象；类型导出编译后消失不需要 mock）
vi.mock('@/composables/useApi', () => ({
  api: {
    getEvalScores: vi.fn(),
    getEvalAggregates: vi.fn(),
    getEvalPending: vi.fn(),
    getEvalEpisodeStats: vi.fn(),
    submitEvalReview: vi.fn(),
  },
}))

describe('EvaluationView 静态结构（?raw）', () => {
  it('全屏视图 + 关闭按钮 emit close（照 SettingsView 模式）', () => {
    expect(source).toContain('role="dialog"')
    expect(source).toContain('aria-label="评估中心"')
    expect(source).toContain('@click="emit(\'close\')"')
  })

  it('双 tab：观察 / 回标，默认观察，回标带待回标角标', () => {
    expect(source).toContain("const activeTab = ref<'observe' | 'review'>('observe')")
    expect(source).toContain(`v-show="activeTab === 'observe'"`)
    expect(source).toContain(`v-show="activeTab === 'review'"`)
    expect(source).toContain('tab-badge')
    expect(source).toContain('pendingBadge')
  })

  it('三态齐全（加载 / 错误 / 空态）——接口失败给提示不白屏', () => {
    expect(source).toContain('observeLoading')
    expect(source).toContain('observeError')
    expect(source).toContain('aggregates.length === 0')
    expect(source).toContain('scores.length === 0')
    expect(source).toContain('pending.length === 0')
    expect(source).toContain('重试')
  })

  it('任务结局 7 类全集 + 办成率口径（success + corrected_success / 已分类，open 不计分母）', () => {
    for (const label of [
      '成功',
      '修正后成功',
      '需调查',
      '机制需修',
      '路由失败',
      '放弃',
      '未分类',
    ]) {
      expect(source).toContain(label)
    }
    expect(source).toContain('doneRate')
    expect(source).toContain("s.uRoot['success']")
    expect(source).toContain("s.uRoot['corrected_success']")
    expect(source).toContain('outcomePct')
    expect(source).toContain('未定论')
  })

  it('回标闭环：1-5 分单选 + 提交 → 样本移出待回标', () => {
    expect(source).toContain('role="radiogroup"')
    expect(source).toContain('v-for="n in 5"')
    expect(source).toContain('submitReview')
    expect(source).toContain('api.submitEvalReview')
    expect(source).toContain('pending.value.filter((p) => p.id !== id)')
    expect(source).toContain('stateFor(p.id)')
  })
})

describe('EvaluationView 挂载测试（mock useApi）', () => {
  const scoreRows = [
    {
      id: 's1',
      message_id: 'm1',
      session_id: 'sess1',
      agent_id: 'a1',
      score: 5,
      dimensions: null,
      judge_model: 'kimi-k3',
      sample_reason: 'random',
      created_at: '2026-08-11T10:00:00',
      agent_name: '店长',
    },
    {
      id: 's2',
      message_id: 'm2',
      session_id: 'sess2',
      agent_id: 'a2',
      score: 2,
      dimensions: null,
      judge_model: 'kimi-k3',
      sample_reason: 'low_score',
      created_at: '2026-08-11T09:00:00',
      agent_name: '吐槽猫',
    },
  ]
  const aggregates = [
    { agent_id: 'a1', agent_name: '店长', count: 2, avg_score: 4.5, low_score_rate: 0.5 },
  ]
  const stats = {
    versionStale: 0,
    uRoot: {
      success: 2,
      corrected_success: 1,
      needs_investigation: 1,
      harness_fix_needed: 0,
      routing_failure: 1,
      abandoned: 1,
      unclassified: 1,
    },
    hRoot: { abandoned: 1 },
    open: 1,
  }
  const pendingRows = [
    {
      id: 'p1',
      message_id: 'm2',
      session_id: 'sess2',
      agent_id: 'a2',
      score: 2,
      dimensions: null,
      judge_model: 'kimi-k3',
      sample_reason: 'low_score',
      created_at: '2026-08-11T09:00:00',
      agent_name: '吐槽猫',
      reply_content: '这是低分回复全文 A',
      reply_created_at: '2026-08-11T09:00:00',
      context: [
        {
          id: 'c1',
          role: 'user',
          agent_id: null,
          content: '前置用户消息',
          created_at: '2026-08-11T08:59:00',
        },
      ],
    },
    {
      id: 'p2',
      message_id: 'm3',
      session_id: 'sess2',
      agent_id: 'a2',
      score: 1,
      dimensions: null,
      judge_model: 'kimi-k3',
      sample_reason: 'low_score',
      created_at: '2026-08-11T08:00:00',
      agent_name: '吐槽猫',
      reply_content: '这是低分回复全文 B',
      reply_created_at: '2026-08-11T08:00:00',
      context: [],
    },
  ]

  beforeEach(() => {
    vi.mocked(api.getEvalScores).mockResolvedValue({ ok: true, scores: scoreRows })
    vi.mocked(api.getEvalAggregates).mockResolvedValue({ ok: true, aggregates })
    vi.mocked(api.getEvalEpisodeStats).mockResolvedValue({ ok: true, stats })
    vi.mocked(api.getEvalPending).mockResolvedValue({ ok: true, pending: pendingRows })
    vi.mocked(api.submitEvalReview).mockResolvedValue({ ok: true, covered: false })
  })

  it('观察 tab 渲染真实数据：聚合卡 / 评分列表 / 结局分布 7 类 + 办成率', async () => {
    const wrapper = mount(EvaluationView)
    await flushPromises()

    const text = wrapper.text()
    // 聚合卡片（数值与 mock 一致）
    expect(text).toContain('店长')
    expect(text).toContain('样本 2')
    expect(text).toContain('均分 4.5')
    expect(text).toContain('低分率 50%')
    // 评分列表（两行 + 猫名 + 采样原因中文标签）
    expect(text).toContain('吐槽猫')
    expect(text).toContain('低分样本')
    // 结局分布 7 类计数 + open + 办成率（(2+1)/7 ≈ 43%）
    expect(text).toContain('成功 2')
    expect(text).toContain('修正后成功 1')
    expect(text).toContain('需调查 1')
    expect(text).toContain('机制需修 0')
    expect(text).toContain('路由失败 1')
    expect(text).toContain('放弃 1')
    expect(text).toContain('未分类 1')
    expect(text).toContain('未定论 1')
    expect(text).toContain('办成率')
    expect(text).toContain('43%')
    wrapper.unmount()
  })

  it('回标闭环：提交成功 → submitEvalReview 调用 + 样本移出 + 角标减一', async () => {
    const wrapper = mount(EvaluationView)
    await flushPromises()

    // 切回标 tab
    const reviewTab = wrapper.findAll('button').find((b) => b.text().includes('回标'))
    expect(reviewTab).toBeTruthy()
    await reviewTab!.trigger('click')
    await flushPromises()

    // 两条样本卡 + 角标 2
    expect(wrapper.text()).toContain('这是低分回复全文 A')
    expect(wrapper.text()).toContain('这是低分回复全文 B')
    const badgeBefore = wrapper.find('.tab-badge')
    expect(badgeBefore.exists()).toBe(true)
    expect(badgeBefore.text()).toBe('2')

    // 提交第一条（默认评分 3，无评语）
    const submitButtons = wrapper.findAll('.btn-submit')
    await submitButtons[0].trigger('click')
    await flushPromises()

    expect(api.submitEvalReview).toHaveBeenCalledWith('p1', { score: 3, comment: undefined })
    // 样本 A 移出、B 保留；角标 2 → 1
    expect(wrapper.text()).not.toContain('这是低分回复全文 A')
    expect(wrapper.text()).toContain('这是低分回复全文 B')
    expect(wrapper.find('.tab-badge').text()).toBe('1')
    wrapper.unmount()
  })

  it('回标失败 → 样本保留 + 错误提示（不白屏）', async () => {
    vi.mocked(api.submitEvalReview).mockRejectedValue(new Error('服务器错误：回标写入失败'))
    const wrapper = mount(EvaluationView)
    await flushPromises()

    const reviewTab = wrapper.findAll('button').find((b) => b.text().includes('回标'))
    await reviewTab!.trigger('click')
    await flushPromises()

    await wrapper.findAll('.btn-submit')[0].trigger('click')
    await flushPromises()

    // 样本仍在（提交失败不移出），错误提示可见
    expect(wrapper.text()).toContain('这是低分回复全文 A')
    expect(wrapper.text()).toContain('服务器错误')
    wrapper.unmount()
  })

  it('接口失败 → 观察 tab 错误态（重试按钮可点）', async () => {
    vi.mocked(api.getEvalEpisodeStats).mockRejectedValue(new Error('服务器错误：接口不可用'))
    const wrapper = mount(EvaluationView)
    await flushPromises()

    expect(wrapper.text()).toContain('接口不可用')
    expect(wrapper.find('.btn-retry-sm').exists()).toBe(true)
    wrapper.unmount()
  })
})
