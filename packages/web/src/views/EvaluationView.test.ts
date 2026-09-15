// @vitest-environment jsdom
// 挂载测试需要 DOM（mount + trigger）。文件级环境注释——根配置 environment 为默认 node
// （E4-B 测试基建结论：workspace 目录型 project 不加载 web 包内 vitest.config.ts，
// 根配置为唯一生效注入点，故 jsdom 按文件声明；web 包内单独跑时包内配置已是 jsdom，无冲突）
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { VueWrapper, DOMWrapper } from '@vue/test-utils'
import source from './EvaluationView.vue?raw'
import EvaluationView from './EvaluationView.vue'
import { api } from '@/composables/useApi'
import type { ChainHop, EvalChainsResponse, EvalL1Metrics, SpanDto } from '@/composables/useApi'

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
    getEvalSpans: vi.fn(),
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
    for (const label of ['无回复', '超时', '无数据']) {
      expect(source).toContain(label)
    }
    // R3：跳展开处已由「两段条」换成 11 段瀑布——两段条的文案与类名不得残留
    expect(source).not.toContain('回复生成段')
    expect(source).not.toContain('seg-nodata')
    for (const label of ['执行 trace', '总时长只认根段 invoke_agent', '不计入本次执行']) {
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

  // ─── R3 段分解数据 ──────────────────────
  /** 几何取自真实库（`cat-study-dev.db` 实测形状）：排队段起点为**负偏移**、
   *  `llm.chat` 占 95%、根段之外没有任何子段。轴长只认根段——子段之和必然 > 轴长
   *  （段是嵌套的，父子重复计）。 */
  const T0 = Date.parse('2026-09-01T10:00:00.000Z')
  const isoAt = (off: number) => new Date(T0 + off).toISOString()
  const spanRow = (over: Partial<SpanDto> & { span_id: string; name: string }): SpanDto => ({
    id: 0,
    parent_span_id: null,
    chain_id: 'c1',
    execution_id: 'h1',
    session_id: null,
    agent_id: null,
    operation_name: null,
    start_at: isoAt(0),
    duration_ms: 0,
    status: 'ok',
    error_type: null,
    error_message: null,
    item_count: null,
    llm: null,
    ...over,
  })
  const ROOT_MS = 60810
  const h1Spans: SpanDto[] = [
    // ⚠️ `parent_span_id` 必须挂根段——**照真实库**：`dispatch.queue_wait` 由
    // `recordSpan` 补记，而 `recordSpan` 走 `startSpan`，建它时根段已存在 ⇒ 父恒
    // 非 NULL（实测 `cat-study-dev.db` 6/6 行全挂根段，`parent_span_id IS NULL`
    // 的段只有 `invoke_agent`，61/61）。夹具若写成 NULL，`find(父为 NULL)` 会把它
    // 逮成根段，轴起点/轴长一起错位——**那是夹具失真，不是实现行为**。
    spanRow({
      id: 1,
      span_id: 'sp-qw',
      parent_span_id: 'sp-root',
      name: 'dispatch.queue_wait',
      start_at: isoAt(-109330),
      duration_ms: 109330,
    }),
    spanRow({ id: 2, span_id: 'sp-root', name: 'invoke_agent', duration_ms: ROOT_MS }),
    spanRow({
      id: 3,
      span_id: 'sp-cta',
      parent_span_id: 'sp-root',
      name: 'context.assemble',
      start_at: isoAt(1),
      duration_ms: 15,
      item_count: 5,
    }),
    spanRow({
      id: 4,
      span_id: 'sp-llm',
      parent_span_id: 'sp-root',
      name: 'llm.chat',
      operation_name: 'chat',
      start_at: isoAt(3005),
      duration_ms: 57752,
      llm: {
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        inputTokens: 100,
        outputTokens: 200,
        ttftMs: 2980,
        stream: true,
        maxTokens: 2048,
      },
    }),
    spanRow({
      id: 5,
      span_id: 'sp-rp',
      parent_span_id: 'sp-root',
      name: 'reply.persist',
      start_at: isoAt(60757),
      duration_ms: 0,
    }),
  ]

  beforeEach(() => {
    vi.mocked(api.getEvalScores).mockResolvedValue({ ok: true, scores: scoreRows })
    vi.mocked(api.getEvalAggregates).mockResolvedValue({ ok: true, aggregates })
    vi.mocked(api.getEvalEpisodeStats).mockResolvedValue({ ok: true, stats })
    vi.mocked(api.getEvalPending).mockResolvedValue({ ok: true, pending: pendingRows })
    vi.mocked(api.submitEvalReview).mockResolvedValue({ ok: true, covered: false })
    vi.mocked(api.getEvalL1Metrics).mockResolvedValue(l1Metrics)
    vi.mocked(api.getEvalChains).mockResolvedValue(chainsResponse)
    // h1 有段、h2 无段（已结束但零段行 = 存量行形态）
    vi.mocked(api.getEvalSpans).mockImplementation(async (execId: string) =>
      execId === 'h1' ? { ok: true, spans: h1Spans } : { ok: true, spans: [] }
    )
  })

  /** 展开第一条链（正文链），段数据随之拉取 */
  async function expandFirstChain(wrapper: VueWrapper): Promise<void> {
    await wrapper.findAll('.chain-head')[0].trigger('click')
    await flushPromises()
  }

  /** 取一行段的几何读数（内联定位 = 时间轴的几何量本身；jsdom 无布局引擎，
   *  `getBoundingClientRect()` 恒返回 0，故以定位值为等效几何——值与真实布局同源）。 */
  function barGeom(row: DOMWrapper<Element>): { left: number; width: number } {
    const style = row.find('.wf-bar').attributes('style') || ''
    return {
      left: Number(/left:\s*(-?[\d.]+)%/.exec(style)?.[1]),
      width: Number(/width:\s*(-?[\d.]+)%/.exec(style)?.[1]),
    }
  }

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

  // ─── R3 段瀑布（B3–B8）────────────────────

  it('B3/B4：段按 start_at 升序成行、无负偏移；轴长 = 根段耗时，子段之和 > 轴长（不得归一化）', async () => {
    const wrapper = mount(EvaluationView)
    await flushPromises()
    await expandFirstChain(wrapper)

    const rows = wrapper.findAll('.wf-row')
    // 时间序 = 行序（`dispatch.queue_wait` 起点最早，但它在轴外，故不占行）
    expect(rows.map((r) => r.find('.wf-name-hit').text())).toEqual([
      'invoke_agent',
      'context.assemble',
      'llm.chat',
      'reply.persist',
    ])

    const geoms = rows.map(barGeom)
    // 轴的起点 = 根段 `start_at` ⇒ 根段 left 恒 0；任何段都不得为负偏移
    expect(geoms[0].left).toBe(0)
    expect(geoms[0].width).toBeCloseTo(100, 6)
    for (const g of geoms) expect(g.left).toBeGreaterThanOrEqual(0)
    // 升序：后一行起点不早于前一行
    for (let i = 1; i < geoms.length; i++) {
      expect(geoms[i].left).toBeGreaterThanOrEqual(geoms[i - 1].left)
    }
    // 逐段复算几何（用 fixture 的原始时间戳独立算，不复用组件算法）
    expect(geoms[1].left).toBeCloseTo((1 / ROOT_MS) * 100, 6)
    expect(geoms[1].width).toBeCloseTo((15 / ROOT_MS) * 100, 6)
    expect(geoms[2].left).toBeCloseTo((3005 / ROOT_MS) * 100, 6)
    expect(geoms[2].width).toBeCloseTo((57752 / ROOT_MS) * 100, 6)

    // 轴长口径：显示的总时长 = 根段 duration_ms（60810ms），不是子段之和
    expect(wrapper.find('.wf-total').text()).toBe('总 1.0min')
    // 段是**嵌套**的 ⇒ 父子的宽度会重复计，之和必然 > 100%；
    // 实现**不得**归一化子段使其和 = 100%（那等于把根段也缩掉，总时长读数就假了）
    const sum = geoms.reduce((a, g) => a + g.width, 0)
    expect(sum).toBeGreaterThan(150)
    wrapper.unmount()
  })

  it('B3 静态源：数值列定宽 ⇒ 各行轴宽一致（跨行位置可比）', () => {
    // jsdom 无布局引擎，量不出轴宽——但**轴宽一致的充分条件**可静态钉死：段名列本就定宽
    // （172px）、间隙定长，故轴宽只由数值列决定。数值列一随内容伸缩，`llm.chat` 行（多
    // 一个「首字」）与失败行（多一个状态徽章）就会把 `flex: 1` 的轴挤窄。
    // 真机实测（Chromium + 真库）：llm.chat 行轴 408px vs 其余 460px，极差 52px —— 同一时刻
    // 在两行里画在不同 x 上，最大偏 12% 轴长，正好砸掉「时间序一眼看出卡在哪」。
    const nums = /\.wf-nums\s*\{([^}]*)\}/.exec(source)?.[1] ?? ''
    const track = /\.wf-track\s*\{([^}]*)\}/.exec(source)?.[1] ?? ''
    expect(track).toMatch(/flex:\s*1/) // 轴 = flex:1 的那一列
    expect(nums).toMatch(/flex:\s*0\s+0\s+\d+px/) // 数值列**定宽**（不许随内容伸缩）
  })

  it('B5：轴外段不进瀑布、不计总时长，只作独立单行标注', async () => {
    const wrapper = mount(EvaluationView)
    await flushPromises()
    await expandFirstChain(wrapper)

    // 排队段起点早于根段 ⇒ 不得出现在轴内
    expect(wrapper.findAll('.wf-name-hit').map((n) => n.text())).not.toContain(
      'dispatch.queue_wait'
    )
    const outside = wrapper.findAll('.wf-outside')
    expect(outside).toHaveLength(1)
    expect(outside[0].text()).toBe('排队等待 1.8min（不计入本次执行）')
    // 总时长不含排队（它等的是上一个 trace，计入即重复计时）
    expect(wrapper.find('.wf-total').text()).toBe('总 1.0min')
    wrapper.unmount()
  })

  it('B6：在飞跳与「有跳无段」是两种文案，均不为空白或 0', async () => {
    vi.mocked(api.getEvalChains).mockResolvedValue({
      ...chainsResponse,
      chains: [
        {
          ...chainsResponse.chains[0],
          hopCount: 3,
          hops: [
            chainHops[0],
            chainHops[1],
            // 在飞跳：`endedAt` 为 null，耗时不可得
            {
              ...chainHops[0],
              executionLogId: 'h3',
              endedAt: null,
              totalMs: null,
              replyMs: null,
              nonReplyMs: null,
            },
          ],
        },
      ],
    })
    const wrapper = mount(EvaluationView)
    await flushPromises()
    await expandFirstChain(wrapper)

    const rows = wrapper.findAll('.hop-row')
    expect(rows[0].text()).toContain('执行 trace') // 有段 → 瀑布
    expect(rows[1].text()).toContain('无段数据（存量行）') // 已结束但零段行
    expect(rows[2].text()).toContain('进行中 · 段未落库') // 在飞
    // 两种「无数据」互不串，且都不是空白 / 0
    expect(rows[1].text()).not.toContain('进行中')
    expect(rows[2].text()).not.toContain('存量行')
    expect(rows[2].text()).not.toContain('0ms')
    expect(rows[1].find('.wf-rows').exists()).toBe(false)
    expect(rows[2].find('.wf-rows').exists()).toBe(false)
    // 在飞的跳不白发请求（R2 一次执行一事务，跑着的执行查出来必然空）
    expect(api.getEvalSpans).not.toHaveBeenCalledWith('h3')
    wrapper.unmount()
  })

  it('B7：浮层命中区 = 段名本身——移到段名出，移到段身/整行不出', async () => {
    const wrapper = mount(EvaluationView)
    await flushPromises()
    await expandFirstChain(wrapper)

    const row = wrapper.findAll('.wf-row')[2] // llm.chat
    expect(wrapper.find('.span-tip').exists()).toBe(false)

    // 反例 1：段身（时间轴上的条）
    await row.find('.wf-bar').trigger('mouseenter')
    expect(wrapper.find('.span-tip').exists()).toBe(false)
    // 反例 2：整行 / 空白（段名右侧的定宽留白也在 .wf-name 里，但不在命中元素内）
    await wrapper.find('.wf-rows').trigger('mouseenter')
    await row.find('.wf-name').trigger('mouseenter')
    expect(wrapper.find('.span-tip').exists()).toBe(false)

    // 正例：只移到段名上
    await row.find('.wf-name-hit').trigger('mouseenter')
    await flushPromises()
    const tip = wrapper.find('.span-tip')
    expect(tip.exists()).toBe(true)
    expect(tip.text()).toContain('llm.chat')
    expect(tip.text()).toContain('模型流式生成')
    // 定位已真跑（贴名字的右侧/下方），不是未定位的默认态
    expect(tip.attributes('style')).toMatch(/left:\s*\d+px/)
    expect(tip.attributes('style')).toMatch(/top:\s*\d+px/)
    expect(tip.classes()).not.toContain('is-placing')
    // 浮层挂在视图根上，不在数值块内 ⇒ 该段数值读数不被它覆盖
    expect(wrapper.find('.wf-nums .span-tip').exists()).toBe(false)

    // 移出即收
    await row.find('.wf-name-hit').trigger('mouseleave')
    expect(wrapper.find('.span-tip').exists()).toBe(false)
    wrapper.unmount()
  })

  it('B8：ⓘ 悬浮出说明，且只讲真展示在前端的字段（后端有、界面无的不出现）', async () => {
    const wrapper = mount(EvaluationView)
    await flushPromises()
    await expandFirstChain(wrapper)

    const marks = wrapper.findAll('.wf-lg')
    expect(marks.map((m) => m.text())).toEqual(['耗时ⓘ', '状态ⓘ', '首字ⓘ'])

    const tips: string[] = []
    for (const m of marks) {
      await m.trigger('mouseenter')
      await flushPromises()
      const tip = wrapper.find('.span-tip')
      expect(tip.exists()).toBe(true)
      tips.push(tip.text())
      await m.trigger('mouseleave')
    }
    expect(tips[0]).toContain('总时长的权威是根段')
    expect(tips[1]).toContain('timeout')
    expect(tips[2]).toContain('ttft_ms')

    // 反例的可信度：这些字段**确实在数据里**（span 行带 item_count=5），只是界面不渲染
    expect(h1Spans.filter((s) => s.item_count === 5)).toHaveLength(1)
    // 反例：后端有、界面无的字段不得出现在任何提示里
    for (const t of tips) {
      for (const ghost of [
        'item_count',
        'itemCount',
        '产出计数',
        'operation_name',
        'max_tokens',
        'stream',
      ]) {
        expect(t).not.toContain(ghost)
      }
    }
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
