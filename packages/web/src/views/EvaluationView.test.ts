// @vitest-environment jsdom
// 挂载测试需要 DOM（mount + trigger）。文件级环境注释——根配置 environment 为默认 node
// （E4-B 测试基建结论：workspace 目录型 project 不加载 web 包内 vitest.config.ts，
// 根配置为唯一生效注入点，故 jsdom 按文件声明；web 包内单独跑时包内配置已是 jsdom，无冲突）
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import source from './EvaluationView.vue?raw'
import EvaluationView from './EvaluationView.vue'
import { api } from '@/composables/useApi'
import type { ChainHop, EvalChainsResponse, EvalL1Metrics } from '@/composables/useApi'

/**
 * E4-B 评估中心前端——两层测试：
 * 1. ?raw 静态源断言（照 SettingsView.test.ts 约定）：三 tab 结构 / 三态 / 7 类结局 / 办成率 / 角标
 * 2. 挂载测试（@vue/test-utils + jsdom，mock useApi 边界）：渲染真实数据 + 回标提交闭环
 *    （样本移出 + 角标减一）+ 接口失败错误态 + P1 链路 tab（失败跳可见 / null≠0 / 孤儿区 / 时区）。
 *
 * P1-B：链路 tab 的 mock 数据用 `ChainHop[]` / `EvalChainsResponse` 显式标注——
 * 既喂数据，也顺带把前端 DTO 与冻结契约比对一遍（类型不符编译期就炸）。
 */

// mock useApi 边界（组件只消费 api 对象；类型导出编译后消失不需要 mock）
vi.mock('@/composables/useApi', () => ({
  api: {
    getEvalScores: vi.fn(),
    getEvalAggregates: vi.fn(),
    getEvalPending: vi.fn(),
    getEvalEpisodeStats: vi.fn(),
    submitEvalReview: vi.fn(),
    getEvalL1Metrics: vi.fn(),
    getEvalChains: vi.fn(),
  },
}))

describe('EvaluationView 静态结构（?raw）', () => {
  it('全屏视图 + 关闭按钮 emit close（照 SettingsView 模式）', () => {
    expect(source).toContain('role="dialog"')
    expect(source).toContain('aria-label="评估中心"')
    expect(source).toContain('@click="emit(\'close\')"')
  })

  it('三 tab：观察 / 回标 / 链路，默认观察，回标带待回标角标', () => {
    expect(source).toContain("const activeTab = ref<'observe' | 'review' | 'chain'>('observe')")
    expect(source).toContain(`v-show="activeTab === 'observe'"`)
    expect(source).toContain(`v-show="activeTab === 'review'"`)
    expect(source).toContain(`v-show="activeTab === 'chain'"`)
    expect(source).toContain('tab-badge')
    expect(source).toContain('pendingBadge')
  })

  it('链路 tab（P1）：概览 + 三段耗时 + 四类卡点 + 孤儿区 + 时区显式 UTC', () => {
    // 三态齐备（照观察 tab 范式：加载 / 错误 + 重试）
    expect(source).toContain('chainLoading')
    expect(source).toContain('chainError')
    expect(source).toContain('loadChains')
    // 概览条五要素
    for (const label of ['总跳数', '均跳数', '最长跳数', '孤儿跳']) {
      expect(source).toContain(label)
    }
    // 四类卡点徽章文案（带文字，不靠颜色）+ 中性段名
    for (const label of ['无回复', '超时', '无数据', '回复生成段', '非回复段']) {
      expect(source).toContain(label)
    }
    // 禁「等锁」类命名——nonReplyMs 的真实成分未实测，叫等锁段会报假数
    expect(source).not.toContain('等锁段')
    // 孤儿区恒显示（不得静默丢弃 28 行真实数据）
    expect(source).toContain('未归属跳（无链锚）')
    // 时区：必须显式当 UTC 解析（`new Date(裸串)` 按本地时区解析，差 8 小时）
    expect(source).toContain("new Date(s.replace(' ', 'T') + 'Z')")
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

  // ─── P1 链路 tab 数据 ────────────────────
  /** 一跳 = 一条 execution_logs。h2 是「失败且无回复消息」的跳——本视图存在的理由。 */
  const chainHops: ChainHop[] = [
    {
      executionLogId: 'h1',
      agentId: 'a1',
      agentName: '店长',
      status: 'completed',
      errorType: null,
      startedAt: '2026-09-01 10:00:00',
      endedAt: '2026-09-01 10:02:00',
      totalMs: 120000,
      replyMs: 118500,
      nonReplyMs: 1500,
      segmentClamped: false,
      flags: [],
      triggerMessageId: 'm1',
      replyMessageId: 'm2',
    },
    {
      executionLogId: 'h2',
      agentId: 'a2',
      agentName: '吐槽猫',
      status: 'failed',
      errorType: 'provider_error',
      startedAt: '2026-09-01 10:02:00',
      endedAt: '2026-09-01 10:02:30',
      totalMs: 30000,
      replyMs: null,
      nonReplyMs: null,
      segmentClamped: false,
      flags: ['failed', 'no_reply'],
      triggerMessageId: 'm2',
      replyMessageId: null,
    },
  ]
  const orphanHops: ChainHop[] = [
    {
      executionLogId: 'o1',
      agentId: 'a9',
      agentName: '孤儿猫甲',
      status: 'completed',
      errorType: null,
      startedAt: '2026-09-01 09:00:00',
      endedAt: '2026-09-01 09:01:00',
      totalMs: 60000,
      replyMs: 59000,
      nonReplyMs: 1000,
      segmentClamped: false,
      flags: [],
      triggerMessageId: 'm9',
      replyMessageId: null,
    },
    {
      executionLogId: 'o2',
      agentId: 'a9',
      agentName: '孤儿猫乙',
      status: 'failed',
      errorType: 'timeout',
      startedAt: '2026-09-01 09:01:00',
      endedAt: '2026-09-01 09:02:00',
      totalMs: null,
      replyMs: null,
      nonReplyMs: null,
      segmentClamped: false,
      flags: ['failed', 'slow'],
      triggerMessageId: 'm10',
      replyMessageId: null,
    },
  ]
  const l1Metrics: EvalL1Metrics = {
    windowDays: 30,
    successRate: 0.87,
    timeoutRate: 0.02,
    avgLatencyMs: 198800,
    totalTokens: 12345,
    suggestRate: 0.1,
    rejectRate: 0.05,
    parseFailureRate: 0.01,
    infraFailures: 3,
    sampleTotal: 1010,
  }
  /** totals 是窗口全量口径，`chains[]` 被 limit 截断——故 totals 与 chains.length 不必相等；
   *  但 `orphanChain.hopCount` 与 `totals.orphanHops` 在后端同源（`buildChains` 同一数组长度），
   *  且孤儿跳**不被 limit 截断**——fixture 必须保住这条，否则测的是一个不存在的形态。 */
  const chainsResponse: EvalChainsResponse = {
    windowDays: 30,
    anchor: 'coalesce(reply.task_id, trigger.task_id)',
    slowMs: 300000,
    totals: { chains: 482, hops: 1084, orphanHops: 2, avgHopsPerChain: 2.19, maxHops: 26 },
    chains: [
      {
        chainId: 'c1',
        startedAt: '2026-09-01 10:00:00',
        endedAt: '2026-09-01 10:02:30',
        spanMs: 150000,
        hopCount: 2,
        completedCount: 1,
        failedCount: 1,
        hops: chainHops,
      },
    ],
    orphanChain: { chainId: null, hopCount: 2, hops: orphanHops },
  }

  beforeEach(() => {
    vi.mocked(api.getEvalScores).mockResolvedValue({ ok: true, scores: scoreRows })
    vi.mocked(api.getEvalAggregates).mockResolvedValue({ ok: true, aggregates })
    vi.mocked(api.getEvalEpisodeStats).mockResolvedValue({ ok: true, stats })
    vi.mocked(api.getEvalPending).mockResolvedValue({ ok: true, pending: pendingRows })
    vi.mocked(api.submitEvalReview).mockResolvedValue({ ok: true, covered: false })
    vi.mocked(api.getEvalL1Metrics).mockResolvedValue(l1Metrics)
    vi.mocked(api.getEvalChains).mockResolvedValue(chainsResponse)
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

  it('链路 tab 切换 + 概览条 + L1 八口径（既有两 tab 不受影响）', async () => {
    const wrapper = mount(EvaluationView)
    await flushPromises()

    const chainTab = wrapper.findAll('button').find((b) => b.text().includes('链路'))
    expect(chainTab).toBeTruthy()
    await chainTab!.trigger('click')
    await flushPromises()
    expect(wrapper.find('.tab-btn.active').text()).toContain('链路')

    // 概览条：逐项按名取值断言（整条 toContain('2') 会被 482/1084 蒙混过关）
    const ov = (label: string) =>
      wrapper
        .findAll('.ov-item')
        .find((o) => o.text().includes(label))
        ?.text() ?? ''
    expect(ov('链')).toMatch(/链\s*482/)
    expect(ov('总跳数')).toMatch(/总跳数\s*1084/)
    expect(ov('均跳数')).toMatch(/均跳数\s*2\.19/)
    expect(ov('最长跳数')).toMatch(/最长跳数\s*26/)
    expect(ov('孤儿跳')).toMatch(/孤儿跳\s*2/)
    expect(wrapper.find('.overview-bar').text()).toContain('近 30 天')
    // L1 八口径：比率转百分比 + 耗时人话化（198800ms → 3.3min）
    const l1Grid = wrapper.find('.l1-grid').text()
    expect(l1Grid).toContain('87%')
    expect(l1Grid).toContain('3.3min')
    expect(l1Grid).toContain('基建故障')
    wrapper.unmount()
  })

  it('失败跳可见：无回复消息的执行跳仍渲染并带「失败」徽章（防按消息行分组的回归）', async () => {
    const wrapper = mount(EvaluationView)
    await flushPromises()
    await wrapper.findAll('.chain-head')[0].trigger('click')
    await flushPromises()

    // 该跳 replyMessageId 为 null（没有回复消息），却必须出现在 hops[] 里——
    // provider_error 只可能来自跳行，渲染得到它就证明「按 execution_logs 而非消息行」成立
    const failedRow = wrapper.findAll('.hop-row')[1]
    expect(failedRow.text()).toContain('吐槽猫')
    expect(failedRow.text()).toContain('provider_error')
    expect(failedRow.text()).toContain('失败')
    expect(failedRow.text()).toContain('无回复')
    // 含失败跳的链整条有可见区分
    expect(wrapper.find('.chain-has-failure').exists()).toBe(true)
    wrapper.unmount()
  })

  it('replyMs 为 null 的跳渲染「无数据」，不画成 0 长度也不用 0ms 顶替', async () => {
    const wrapper = mount(EvaluationView)
    await flushPromises()
    await wrapper.findAll('.chain-head')[0].trigger('click')
    await flushPromises()

    const failedRow = wrapper.findAll('.hop-row')[1]
    expect(failedRow.text()).toContain('无数据')
    expect(failedRow.text()).not.toContain('0ms')
    // 斜纹灰条占满整条（不是 0 宽度），且不渲染回复段
    expect(failedRow.find('.seg-nodata').exists()).toBe(true)
    expect(failedRow.find('.seg-reply').exists()).toBe(false)
    // 对照：有数据的跳是两段堆叠条
    const okRow = wrapper.findAll('.hop-row')[0]
    expect(okRow.find('.seg-reply').exists()).toBe(true)
    expect(okRow.find('.seg-nodata').exists()).toBe(false)
    wrapper.unmount()
  })

  it('avgLatencyMs 为 null 显示 — 而非 0ms（窗口内无 completed 样本）', async () => {
    vi.mocked(api.getEvalL1Metrics).mockResolvedValue({ ...l1Metrics, avgLatencyMs: null })
    const wrapper = mount(EvaluationView)
    await flushPromises()

    const card = wrapper.findAll('.l1-card').find((c) => c.text().includes('平均耗时'))
    expect(card).toBeTruthy()
    expect(card!.text()).toContain('—')
    expect(card!.text()).not.toContain('0ms')
    expect(card!.find('.l1-value').classes()).toContain('l1-nodata')
    wrapper.unmount()
  })

  it('孤儿区恒显示且条数正确（未归属跳不得静默丢弃）', async () => {
    const wrapper = mount(EvaluationView)
    await flushPromises()

    expect(wrapper.text()).toContain('未归属跳（无链锚）')
    expect(wrapper.find('.chain-orphan').text()).toMatch(/2 跳/)

    // 展开孤儿组（末位）→ 两条跳可见；正文链未展开故不混入
    const heads = wrapper.findAll('.chain-head')
    await heads[heads.length - 1].trigger('click')
    await flushPromises()
    const rows = wrapper.findAll('.hop-row')
    expect(rows.length).toBe(2)
    expect(rows[0].text()).toContain('孤儿猫甲')
    expect(rows[1].text()).toContain('孤儿猫乙')
    wrapper.unmount()
  })

  it('孤儿区在 hopCount 为 0 时显示「无」但区块不消失', async () => {
    vi.mocked(api.getEvalChains).mockResolvedValue({
      ...chainsResponse,
      orphanChain: { chainId: null, hopCount: 0, hops: [] },
    })
    const wrapper = mount(EvaluationView)
    await flushPromises()

    const orphan = wrapper.find('.chain-orphan')
    expect(orphan.exists()).toBe(true)
    expect(orphan.text()).toContain('0 跳')
    expect(orphan.find('.list-hint').text()).toBe('无')
    wrapper.unmount()
  })

  it('UTC 串按 UTC 解析再转本地展示（防差 8 小时）', async () => {
    const wrapper = mount(EvaluationView)
    await flushPromises()

    // 期望值当场按本地时区算 → 与宿主时区无关；若按裸串当本地时间解析，UTC+8 下会差 8 小时
    const d = new Date(Date.UTC(2026, 8, 1, 10, 0, 0))
    const p = (n: number) => String(n).padStart(2, '0')
    const expected = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    expect(wrapper.text()).toContain(expected)
    wrapper.unmount()
  })

  it('链路接口失败 → 链路 tab 错误态（重试按钮可点，不白屏）', async () => {
    vi.mocked(api.getEvalChains).mockRejectedValue(new Error('服务器错误：链路查询失败'))
    const wrapper = mount(EvaluationView)
    await flushPromises()

    const chainTab = wrapper.findAll('button').find((b) => b.text().includes('链路'))
    await chainTab!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('链路查询失败')
    const retries = wrapper.findAll('.btn-retry-sm')
    expect(retries.length).toBeGreaterThan(0)
    wrapper.unmount()
  })
})
