// @vitest-environment jsdom
// 挂载测试需要 DOM（mount + trigger + 浮层定位）。文件级环境注释——根配置 environment
// 为默认 node（workspace 目录型 project 不加载 web 包内 vitest.config.ts）。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { VueWrapper, DOMWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import source from './SessionAgentsPanel.vue?raw'
import SessionAgentsPanel from './SessionAgentsPanel.vue'
import { api } from '@/composables/useApi'
import { useChatStore } from '@/stores/chat'
import type { SpanDto, SessionTraceDto } from '@/composables/useApi'

// mock useApi 边界（组件只消费 api 对象；类型导出编译后消失不需要 mock）
vi.mock('@/composables/useApi', () => ({
  api: {
    getSessionTraces: vi.fn(),
    getEvalSpans: vi.fn(),
    updateSessionAgents: vi.fn(),
  },
}))

/**
 * Verify SessionAgentsPanel.vue — 会话右侧边栏（clowder-ai 精简评估面板，单 B1）。
 *
 * Static verification tests — they read the SFC source via Vite's `?raw`
 * import to confirm the expected patterns exist. 用户决策：右侧边栏恢复但更精简
 * （低密度分区卡片：状态指示/统计计数/会话成员/队列/折叠配置），严禁恢复旧版
 * 300px 高密度运行控制台（9dc5619^ 那版：进度条/停止按钮全量）。停止按钮归
 * ChatPanel 气泡（B2），本面板不装——避免双实现。
 */

describe('SessionAgentsPanel 精简面板结构（clowder-ai 模式）', () => {
  it('无会话空态：不报错，提示选择会话', () => {
    expect(source).toContain('v-if="!store.activeSessionId"')
    expect(source).toContain('选择会话后展示成员与用量')
  })

  it('统计计数卡：消息总数 / 猫咪回复数（从 store 消息列表计数，零额外请求）', () => {
    expect(source).toContain('stat-card')
    expect(source).toContain('messageStats.total')
    expect(source).toContain('messageStats.agent')
    expect(source).toContain('store.activeMessages')
    expect(source).toContain("m.role === 'agent'")
    expect(source).toContain('消息总数')
    expect(source).toContain('猫咪回复')
  })

  it('会话成员卡：头像/名/状态点/状态文字 + 排队数徽章（agentStates 实时）', () => {
    expect(source).toContain('v-for="agent in memberAgents"')
    expect(source).toContain('agent.avatar')
    expect(source).toContain('member-name')
    expect(source).toContain('statusFor(agent.id)')
    expect(source).toContain('queueFor(agent.id)')
    expect(source).toContain('队列 {{ queueFor(agent.id) }}')
  })

  it('tokens 用数字而非进度条：{用量}/{上限}（fmtTokens，与气泡 footer 同一数字体系）', () => {
    expect(source).toContain('member-tokens')
    expect(source).toContain('tokensText(agent.id)')
    expect(source).toContain('store.contextTokens.get(agentId)')
    expect(source).toContain('store.agentTokenStats.get(agentId)?.maxContextTokens')
    expect(source).toContain('store.contextConfig.maxContextTokens')
    // 数字格式化 12.4k / 128k（k 后去末尾 .0）
    expect(source).toContain("(n / 1000).toFixed(1).replace(/\\.0$/, '') + 'k'")
    // 严禁恢复进度条渲染
    expect(source).not.toContain('token-bar')
    expect(source).not.toContain('progress')
  })

  it('调度队列信息：agentStateList 过滤会话成员 + 排队数', () => {
    expect(source).toContain('store.agentStateList.filter')
    expect(source).toContain('s.queueLength > 0')
    expect(source).toContain('调度队列')
    expect(source).toContain('暂无排队任务')
  })

  it('折叠配置层级（clowder-ai 折叠风格）：广播模式开关走 store.toggleBroadcast', () => {
    expect(source).toContain('class="config-section"')
    expect(source).toContain('config-summary')
    expect(source).toContain('store.broadcastMode')
    expect(source).toContain('store.toggleBroadcast()')
    expect(source).toContain('role="switch"')
  })

  it('成员卡不装停止按钮（归 ChatPanel 气泡，避免双实现）', () => {
    expect(source).not.toContain('interruptAgent')
    expect(source).not.toContain('stopAgent')
    expect(source).not.toContain('btn-stop')
  })
})

describe('SessionAgentsPanel 成员管理（PATCH addAgentIds/removeAgentIds）', () => {
  it('添加列表排除已在会话的 agent（addableAgents 过滤 activeSession.agentIds）', () => {
    expect(source).toContain('const addableAgents = computed')
    expect(source).toContain('store.agents.filter((a) => !ids.has(a.id))')
    expect(source).toContain('store.activeSession?.agentIds')
    expect(source).toContain('＋ 添加猫咪')
  })

  it('添加：多选 → api.updateSessionAgents(addAgentIds) → 关闭弹层（刷新由 SESSION_UPDATE 广播驱动）', () => {
    expect(source).toContain('selectedAddIds.value = []')
    expect(source).toContain('@change="togglePick(agent.id)"')
    expect(source).toContain('api.updateSessionAgents(store.activeSessionId, {')
    expect(source).toContain('addAgentIds: selectedAddIds.value')
    expect(source).toContain('pickerOpen.value = false')
    expect(source).toContain('SESSION_UPDATE')
  })

  it('移除：成员卡 ✕ → api.updateSessionAgents(removeAgentIds: [agentId])', () => {
    expect(source).toContain('removeAgent(agent.id)')
    expect(source).toContain('removeAgentIds: [agentId]')
    expect(source).toContain('aria-label="移除"')
  })

  it('多选弹层：空列表禁用确认 + 已选计数 + 取消', () => {
    expect(source).toContain('aria-modal="true"')
    expect(source).toContain('所有猫咪都已在会话中')
    expect(source).toContain(':disabled="selectedAddIds.length === 0 || adding"')
    expect(source).toContain('已选 {{ selectedAddIds.length }} 只')
  })
})

// ─── R4 弱化卡 / 内联 trace / 设置抽屉（挂载测试，mock useApi 边界）────────

describe('SessionAgentsPanel R4 · 弱化卡与内联 trace', () => {
  const T0 = Date.parse('2026-09-01T10:00:00.000Z')
  const isoAt = (off: number) => new Date(T0 + off).toISOString()

  /** span 行工厂（照 EvaluationView.test.ts 同款：真实库形状，字段全给） */
  const spanRow = (over: Partial<SpanDto> & { span_id: string; name: string }): SpanDto => ({
    id: 0,
    parent_span_id: null,
    chain_id: 'c1',
    execution_id: 'e1',
    session_id: 's1',
    agent_id: 'a1',
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

  const ROOT_MS = 60_000
  /** 真实库形状：排队段起点为**负偏移**（轴外）；两个子段**重叠** ⇒ 宽度之和 167% > 100%，
   *  实现不得归一化（归一化 = 把根段也缩掉，总时长读数就假了）。 */
  const spansFixture: SpanDto[] = [
    spanRow({
      id: 1,
      span_id: 'sp-qw',
      parent_span_id: 'sp-root',
      name: 'dispatch.queue_wait',
      start_at: isoAt(-109330),
      duration_ms: 109330,
    }),
    spanRow({ id: 2, span_id: 'sp-root', name: 'invoke_agent', duration_ms: ROOT_MS }),
    // 故意**乱序**给出：llm.chat 时间上晚于 context.assemble，却排在数组更前面
    spanRow({
      id: 3,
      span_id: 'sp-llm',
      parent_span_id: 'sp-root',
      name: 'llm.chat',
      start_at: isoAt(3005),
      duration_ms: 50_000,
      llm: {
        provider: 'deepseek',
        model: 'm',
        inputTokens: 1,
        outputTokens: 2,
        ttftMs: 2980,
        stream: true,
        maxTokens: 2048,
      },
    }),
    spanRow({
      id: 5,
      span_id: 'sp-mem',
      parent_span_id: 'sp-root',
      name: 'memory.retrieval',
      start_at: isoAt(3005),
      duration_ms: 50_000,
    }),
    spanRow({
      id: 4,
      span_id: 'sp-cta',
      parent_span_id: 'sp-root',
      name: 'context.assemble',
      start_at: isoAt(1),
      duration_ms: 15,
    }),
  ]

  /** a1 完成 / a2 在飞（`endedAt` null）/ a3 **本会话零执行**（不出现在数组里） */
  const tracesFixture: SessionTraceDto[] = [
    {
      agentId: 'a1',
      executionId: 'e1',
      status: 'completed',
      startedAt: isoAt(0),
      endedAt: isoAt(ROOT_MS),
      totalMs: ROOT_MS,
    },
    {
      agentId: 'a2',
      executionId: 'e2',
      status: 'running',
      startedAt: isoAt(0),
      endedAt: null,
      totalMs: null,
    },
  ]

  let pinia: ReturnType<typeof createPinia>

  beforeEach(() => {
    // 清调用记录（保留 implementation）——否则「本测试没发请求」这类断言会被
    // 前一条测试的调用污染（mock 是文件级共享的）
    vi.clearAllMocks()
    pinia = createPinia()
    setActivePinia(pinia)
    const store = useChatStore()
    store.sessions = [
      { id: 's1', title: 'S', agentIds: ['a1', 'a2', 'a3'], broadcastMode: false } as never,
    ]
    store.activeSessionId = 's1'
    store.agents = [
      { id: 'a1', name: '店长', avatar: '🐱' },
      { id: 'a2', name: 'ds猫', avatar: '🐯' },
      { id: 'a3', name: '图测猫', avatar: '🐈' },
    ] as never
    store.agentStates = new Map([
      [
        'a1',
        new Map([
          ['s1', { agentId: 'a1', sessionId: 's1', status: 'idle', queueLength: 0 } as never],
        ]),
      ],
      [
        'a2',
        new Map([
          ['s1', { agentId: 'a2', sessionId: 's1', status: 'busy', queueLength: 2 } as never],
        ]),
      ],
    ])
    store.contextTokens = new Map([['a1', 12400]])

    vi.mocked(api.getSessionTraces).mockResolvedValue({ ok: true, traces: tracesFixture })
    vi.mocked(api.getEvalSpans).mockImplementation(async (execId: string) =>
      execId === 'e1' ? { ok: true, spans: spansFixture } : { ok: true, spans: [] }
    )
    vi.mocked(api.updateSessionAgents).mockResolvedValue({ ok: true } as never)
  })

  async function mountPanel(): Promise<VueWrapper> {
    const wrapper = mount(SessionAgentsPanel, { global: { plugins: [pinia] } })
    await flushPromises()
    return wrapper as VueWrapper
  }

  function cardOf(wrapper: VueWrapper, name: string): DOMWrapper<Element> {
    return wrapper.findAll('.member-card').find((c) => c.find('.member-name').text() === name)!
  }

  it('B1 弱化卡：一行装完头像热区 / 名 / 色点 / tokens / 队列徽章；状态中文 label 不再视觉呈现', async () => {
    const wrapper = await mountPanel()
    const card = cardOf(wrapper, '店长')

    expect(card.find('.avatar-btn').text()).toBe('🐱')
    expect(card.find('.member-name').text()).toBe('店长')
    expect(card.find('.status-dot').exists()).toBe(true)
    expect(card.find('.member-tokens').text()).toBe('12.4k / 128k')

    // 状态中文 label 视觉丢弃 = 本票唯一的信息丢失。色点色义不变（idle → dot-idle）
    expect(card.find('.status-dot').classes()).toContain('dot-idle')
    expect(card.text()).not.toContain('空闲')
    // ……但语义没丢：色点挂 aria-label，屏幕阅读器仍读得出状态
    expect(card.find('.status-dot').attributes('aria-label')).toBe('空闲')

    // queue>0 徽章保留；移除入口保留（常态隐形、hover/聚焦现身——故仍在 DOM 里）
    const busy = cardOf(wrapper, 'ds猫')
    expect(busy.find('.queue-badge').text()).toContain('队列 2')
    expect(busy.find('.status-dot').classes()).toContain('dot-busy')
    expect(busy.find('.btn-remove').attributes('aria-label')).toBe('移除')

    wrapper.unmount()
  })

  it('B2 热区独立：点头像开抽屉且**不**展开；点卡片体展开且**不**开抽屉', async () => {
    // ── 等效几何（jsdom 无布局引擎，`getBoundingClientRect()` 恒返回 0）──
    // 取**驱动真实布局的源数据** + 结构独立性，与 EvaluationView.test.ts 的 barGeom 同款手法。
    const avatarCss = /\.avatar-btn\s*\{([^}]*)\}/.exec(source)?.[1] ?? ''
    expect(avatarCss).toMatch(/width:\s*30px/) // 30px 独立热区
    expect(avatarCss).toMatch(/height:\s*30px/)
    expect(avatarCss).toMatch(/flex-shrink:\s*0/) // 不被 flex 压窄（压窄 = 热区变小）

    const wrapper = await mountPanel()
    const card = cardOf(wrapper, '店长')
    const avatar = card.find('.avatar-btn')
    // 结构独立：头像与卡片体是**两个不同元素**（不是同一个 hitbox 被两套逻辑抢）
    expect(avatar.element.tagName).toBe('BUTTON')
    expect(avatar.element).not.toBe(card.element)

    // 行为独立 ①：点头像 ⇒ 抽屉开、trace **不**展开
    await avatar.trigger('click')
    await flushPromises()
    expect(wrapper.find('.drawer').exists()).toBe(true)
    expect(wrapper.find('.trace-inline').exists()).toBe(false)

    await wrapper.find('.drawer .btn-close').trigger('click')
    await flushPromises()
    expect(wrapper.find('.drawer').exists()).toBe(false)

    // 行为独立 ②：点卡片体 ⇒ trace 展开、抽屉**不**开
    await card.find('.member-name').trigger('click')
    await flushPromises()
    expect(wrapper.find('.trace-inline').exists()).toBe(true)
    expect(wrapper.find('.drawer').exists()).toBe(false)

    wrapper.unmount()
  })

  it('B3 手风琴单开：展开另一张卡时，前一张自动收回', async () => {
    const wrapper = await mountPanel()

    await cardOf(wrapper, '店长').find('.member-name').trigger('click')
    await flushPromises()
    expect(cardOf(wrapper, '店长').classes()).toContain('expanded')
    expect(wrapper.findAll('.trace-inline')).toHaveLength(1)

    await cardOf(wrapper, 'ds猫').find('.member-name').trigger('click')
    await flushPromises()
    expect(cardOf(wrapper, 'ds猫').classes()).toContain('expanded')
    expect(cardOf(wrapper, '店长').classes()).not.toContain('expanded')
    expect(wrapper.findAll('.trace-inline')).toHaveLength(1) // 同时至多一张

    // 点已展开的卡 ⇒ 收回（全收起）
    await cardOf(wrapper, 'ds猫').find('.member-name').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('.trace-inline')).toHaveLength(0)

    wrapper.unmount()
  })

  it('B4 段清单按时间顺序排（上→下 = 执行先后），且只列非根段', async () => {
    const wrapper = await mountPanel()
    await cardOf(wrapper, '店长').find('.member-name').trigger('click')
    await flushPromises()

    // fixture 是乱序给的；渲染序必须是 start_at 升序（同刻按 id）——
    // 旧版按时长降序只能答「谁最大」，答不了「谁先坏」
    const names = wrapper.findAll('.seglist .segn').map((n) => n.text())
    expect(names).toEqual(['context.assemble', 'llm.chat', 'memory.retrieval'])
    // 根段不进行 —— 它的耗时已经在头部当总时长显示（列出来是同一数字重复两遍）
    expect(names).not.toContain('invoke_agent')

    wrapper.unmount()
  })

  it('B5 口径三铁律：轴长只认根段 / 在飞显式「采集中」/ queue_wait 不进轴不计总时长', async () => {
    const wrapper = await mountPanel()
    await cardOf(wrapper, '店长').find('.member-name').trigger('click')
    await flushPromises()

    // ① 总时长 = 根段 duration_ms（60000 → 1.0min），不是子段之和
    expect(wrapper.find('.ti-total').text()).toBe('1.0min')
    // 段条宽度直接用单源几何（子段重叠 ⇒ 之和 167% > 100%，**不归一化**）
    const widths = wrapper
      .findAll('.segbar .seg')
      .map((s) => Number(/width:\s*(-?[\d.]+)%/.exec(s.attributes('style') || '')?.[1]))
    expect(widths.reduce((a, w) => a + w, 0)).toBeGreaterThan(150)
    expect(widths.reduce((a, w) => a + w, 0)).toBeCloseTo(
      (15 / ROOT_MS) * 100 + (50000 / ROOT_MS) * 100 * 2,
      4
    )

    // ③ queue_wait 是轴外段：不进瀑布、不计总时长，只作单行标注
    const segNames = wrapper.findAll('.seglist .segn').map((n) => n.text())
    expect(segNames).not.toContain('dispatch.queue_wait')
    const outside = wrapper.findAll('.ti-outside')
    expect(outside).toHaveLength(1)
    expect(outside[0].text()).toContain('排队等待')
    expect(outside[0].text()).toContain('不计入本次执行')

    // ② 在飞（a2：endedAt 为 null）⇒ 显式「采集中」，不是 0 也不是空白
    await cardOf(wrapper, 'ds猫').find('.member-name').trigger('click')
    await flushPromises()
    const inFlight = wrapper.find('.trace-inline')
    expect(inFlight.text()).toContain('采集中')
    expect(inFlight.text()).not.toContain('0ms')
    expect(inFlight.find('.seglist').exists()).toBe(false)
    expect(inFlight.find('.ti-total').exists()).toBe(false) // 根段没到手 ⇒ 不显示总时长
    // 在飞不白发请求（段在收尾才落库，跑着的执行查出来必然空）
    expect(api.getEvalSpans).not.toHaveBeenCalledWith('e2')

    wrapper.unmount()
  })

  it('B5 附：本会话零执行的猫展开后显式「本会话暂无执行」（不是 0、不是空白）', async () => {
    const wrapper = await mountPanel()
    await cardOf(wrapper, '图测猫').find('.member-name').trigger('click')
    await flushPromises()

    const inline = wrapper.find('.trace-inline')
    expect(inline.exists()).toBe(true)
    expect(inline.text()).toContain('本会话暂无执行')
    expect(inline.text()).not.toContain('0ms')
    expect(api.getEvalSpans).not.toHaveBeenCalled() // 没执行 id 可拉

    wrapper.unmount()
  })

  it('B7 浮层命中区 = 段名本身：移到段名出，移到段条 / 空白不出', async () => {
    const wrapper = await mountPanel()
    await cardOf(wrapper, '店长').find('.member-name').trigger('click')
    await flushPromises()
    expect(wrapper.find('.span-tip').exists()).toBe(false)

    // 反例 1：段条（时间轴上的条）
    await wrapper.findAll('.segbar .seg')[0].trigger('mouseenter')
    expect(wrapper.find('.span-tip').exists()).toBe(false)
    // 反例 2：段清单容器本身（空白）
    await wrapper.find('.seglist').trigger('mouseenter')
    expect(wrapper.find('.span-tip').exists()).toBe(false)

    // 正例：移到段名上
    const llmName = wrapper.findAll('.seglist .segn').find((n) => n.text() === 'llm.chat')!
    await llmName.trigger('mouseenter')
    await flushPromises()
    const tip = wrapper.find('.span-tip')
    expect(tip.exists()).toBe(true)
    expect(tip.text()).toContain('llm.chat')
    expect(tip.text()).toContain('模型流式生成') // 文案来自 spanLayout 的 SEG_DOC（与评估页同一份）
    expect(tip.attributes('style')).toMatch(/left:\s*\d+px/)
    expect(tip.attributes('style')).toMatch(/top:\s*\d+px/)

    await llmName.trigger('mouseleave')
    expect(wrapper.find('.span-tip').exists()).toBe(false)

    wrapper.unmount()
  })

  it('折叠微段默认关（时间序下全列）；开启后微段收成一行合计，且不丢数据', async () => {
    const wrapper = await mountPanel()
    await cardOf(wrapper, '店长').find('.member-name').trigger('click')
    await flushPromises()

    // 默认全列 —— 折叠中间的微段会切断因果链
    expect(wrapper.findAll('.seglist .segrow')).toHaveLength(3)
    expect(wrapper.find('.ti-more').text()).toBe('折叠微段')

    await wrapper.find('.ti-more').trigger('click')
    await flushPromises()
    // context.assemble（15ms / 60000ms = 0.025% < 1%）被折叠；其余 2 行 + 1 行合计
    const rows = wrapper.findAll('.seglist .segrow')
    expect(rows).toHaveLength(3)
    expect(rows[2].text()).toContain('已折叠 1 个微段')
    expect(rows[2].text()).toContain('15ms') // 合计耗时照实给，不静默吞掉
    expect(wrapper.find('.ti-more').text()).toBe('展开全部 3 段（时间序）')

    // 折叠态下段条同步收窄（不是「清单收了、条还画着」）
    expect(wrapper.findAll('.segbar .seg')).toHaveLength(2)

    wrapper.unmount()
  })

  it('B9 原型对照：抽屉 360px、头像热区独立、卡片 8×10 内边距（形态值静态钉住）', () => {
    const block = (sel: string) => {
      const re = new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`)
      return re.exec(source)?.[1] ?? ''
    }
    // 屏①：内边距 10×12 → 8×10、色点 7px
    expect(block('.member-card')).toMatch(/padding:\s*8px 10px/)
    expect(block('.status-dot')).toMatch(/width:\s*7px/)
    // 屏③：抽屉 360px（在抽屉组件里，见 AgentSettingsDrawer.test.ts）
    expect(source).toContain('AgentSettingsDrawer')
  })
})
