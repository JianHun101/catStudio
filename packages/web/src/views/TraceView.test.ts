/**
 * T2 执行追踪查询页——两层测试（照 `EvaluationView.test.ts` 约定）：
 * 1. `?raw` 静态源断言：默认过滤口径 / 六读数 / 存量行占位 / token「估」标 / 懒加载分工
 * 2. 挂载测试（`@vue/test-utils` + jsdom，mock `useApi` 边界）：列表渲染 + failed 行报错类型
 *    + 展开拉详情 + 上下文决策四档 + 三小节懒加载（**不点不开**）+ 存量行占位 + 过滤改条件回第一页
 *
 * 边界：只 mock `@/composables/useApi`（网络）与 store 的取数；瀑布几何走**真**
 * `spanLayout`（它是纯函数，没有理由替身——替身会让「几何口径改了前端没跟上」不被发现）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import source from './TraceView.vue?raw'
import TraceView from './TraceView.vue'
import { useChatStore } from '@/stores/chat'
import type { ExecutionTraceRow, ExecutionDetailResponse, SpanDto } from '@/composables/useApi'

vi.mock('@/composables/useApi', () => ({
  api: {
    getTraceExecutions: vi.fn(),
    getExecutionDetail: vi.fn(),
    getPromptSection: vi.fn(),
    getRetrievalDetail: vi.fn(),
    getEvalSpans: vi.fn(),
  },
}))

const { api } = await import('@/composables/useApi')
const mocked = vi.mocked(api)

/** 一行列表读数（默认 completed；用 `over` 改成 failed / 无检索等形态） */
function row(over: Partial<ExecutionTraceRow> = {}): ExecutionTraceRow {
  return {
    executionId: 'exec-1',
    sessionId: 's1',
    sessionName: '本会话',
    agentId: 'a1',
    agentName: 'ds猫',
    agentAvatar: '🐱',
    status: 'completed',
    startedAt: '2026-09-27T06:02:00.000Z',
    endedAt: '2026-09-27T06:02:08.400Z',
    totalMs: 8400,
    promptTokens: 2100,
    completionTokens: 800,
    messageId: 'm-reply-1',
    triggerMessageId: 'm-trigger-1',
    traceId: 'trace-1',
    errorType: null,
    errorMessage: null,
    summary: '结论先行：T2 已落',
    injectedSections: 5,
    citationCount: 2,
    retrievalReason: 'ok',
    ...over,
  }
}

function detail(over: Partial<ExecutionDetailResponse> = {}): ExecutionDetailResponse {
  return {
    ok: true,
    hasDetails: true,
    execution: {
      executionId: 'exec-1',
      sessionId: 's1',
      agentId: 'a1',
      status: 'completed',
      startedAt: '2026-09-27T06:02:00.000Z',
      endedAt: '2026-09-27T06:02:08.400Z',
      totalMs: 8400,
      promptTokens: 2100,
      completionTokens: 800,
      messageId: 'm-reply-1',
      triggerMessageId: 'm-trigger-1',
      traceId: 'trace-1',
      errorType: null,
      errorMessage: null,
    },
    context: {
      counts: { kept: 24, invisible: 3, summary_replaced: 1, budget: 1 },
      repliedCount: 2,
      total: 29,
      decisions: [
        {
          ordinal: 0,
          message_id: 'm1',
          stage: 'assemble',
          decision: 'invisible',
          detail: null,
          agent_id: null,
          role: 'user',
          content_head: '@别人 的消息',
        },
        {
          ordinal: 1,
          message_id: 'm2',
          stage: 'truncate',
          decision: 'kept',
          detail: 'replied',
          agent_id: 'a1',
          role: 'user',
          content_head: '已回复过的提问',
        },
      ],
    },
    promptSections: [
      {
        sectionKey: 'system_prompt',
        label: '系统提示（本猫人格）',
        status: 'injected',
        charCount: 42,
      },
      { sectionKey: 'memory', label: '相关记忆', status: 'empty', charCount: 0 },
    ],
    retrieval: {
      reason: 'ok',
      retrievalMs: 37,
      contextTokens: 1200,
      budgetTokens: 8000,
      truncated: false,
      thresholdMaxDistance: 0.6,
      paramTopK: 3,
      paramProbeN: 20,
      paramPoolN: 20,
      taskId: 'anchor-1',
    },
    ...over,
  }
}

function spansFixture(): SpanDto[] {
  return [
    {
      span_id: 'sp-root',
      parent_span_id: null,
      chain_id: null,
      execution_id: 'exec-1',
      name: 'invoke_agent',
      start_at: '2026-09-27T06:02:00.000Z',
      duration_ms: 8000,
      status: 'ok',
      item_count: null,
      llm: null,
    },
    {
      span_id: 'sp-ctx',
      parent_span_id: 'sp-root',
      chain_id: null,
      execution_id: 'exec-1',
      name: 'context.assemble',
      start_at: '2026-09-27T06:02:00.100Z',
      duration_ms: 1200,
      status: 'ok',
      item_count: 29,
      llm: null,
    },
    {
      span_id: 'sp-llm',
      parent_span_id: 'sp-root',
      chain_id: null,
      execution_id: 'exec-1',
      name: 'llm.chat',
      start_at: '2026-09-27T06:02:02.000Z',
      duration_ms: 6000,
      status: 'error',
      item_count: null,
      llm: {
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        inputTokens: 2100,
        outputTokens: 800,
        ttftMs: 420,
        stream: true,
        maxTokens: 8192,
      },
    },
  ] as SpanDto[]
}

async function mountView(preselect: string | null = null): Promise<VueWrapper<any>> {
  const wrapper = mount(TraceView, {
    props: { preselectExecutionId: preselect },
    global: { stubs: { teleport: true } },
  })
  await flush()
  return wrapper
}

/** `onMounted` 里有一次 await（load），要多等几个 tick 才能看到渲染结果 */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await nextTick()
}

describe('TraceView 静态结构（?raw）', () => {
  it('全屏视图 + 关闭按钮 emit close（照 EvaluationView 模式）', () => {
    expect(source).toContain('role="dialog"')
    expect(source).toContain('aria-label="执行追踪"')
    expect(source).toContain("emit('close')")
  })

  it('过滤栏五件套齐：会话 / 猫 / 状态 / 耗时阈值 / 仅看报错', () => {
    for (const anchor of ['fSessionId', 'fAgentId', 'fStatus', 'fMinLatencySec', 'fErrorsOnly']) {
      expect(source, anchor).toContain(anchor)
    }
    expect(source).toContain('耗时 &gt;')
    expect(source).toContain('仅看报错')
  })

  it('默认口径 = 当前会话 + 50/页（票 §三A）；过滤条件变更**回第一页**', () => {
    expect(source).toContain("const fSessionId = ref<string>(store.activeSessionId ?? '')")
    expect(source).toContain('const PAGE_SIZE = 50')
    // 不回第一页的话，改条件后停在第 3 页看的是新条件的第 3 页——错位
    expect(source).toContain('function reload(): void {')
    expect(source).toMatch(/offset\.value = 0\s*\n\s*void load\(\)/)
  })

  it('耗时阈值 UI 是秒、请求是毫秒——换算只在取值那一处', () => {
    expect(source).toContain('fMinLatencySec')
    expect(source).toContain('Math.round(fMinLatencySec.value * 1000)')
  })

  it('token 读数一律带「估」标（适配器不回流真实 usage，R2 边界）', () => {
    expect(source).toContain('est-tag')
    expect(source).toContain('估算 token')
  })

  it('三小节懒加载：prompt 正文与检索明细都是**点开才拉**（首屏不付最大 payload）', () => {
    // 节正文只在 toggleSection 里取，且按 (executionId, key) 现取
    expect(source).toContain('async function toggleSection')
    expect(source).toContain('api.getPromptSection(id, meta.sectionKey)')
    expect(source).toContain('async function loadRetrieval')
    expect(source).toContain('api.getRetrievalDetail(id)')
  })

  it('展开新行时清空上一行的三小节与正文缓存（防「点开 B 行看到 A 行的 prompt」）', () => {
    expect(source).toMatch(/watch\(expandedId, \(\) => \{[\s\S]*?sectionContent\.value = \{\}/)
    expect(source).toMatch(/watch\(expandedId, \(\) => \{[\s\S]*?retrievalLoaded\.value = false/)
  })

  it('存量行占位是「无数据」而非报错；totalMs 为 null 显示「—」不显示 0', () => {
    expect(source).toContain('无段数据（存量行）')
    expect(source).toContain('无快照数据（存量行）')
    expect(source).toContain('无决策数据（存量行）')
    expect(source).toMatch(/function msText\(ms: number \| null\)[\s\S]*?ms === null \? '—'/)
  })

  it('A2A 行显示「未检索（A2A）」——**不是**「没检索到」（两态必须分开）', () => {
    expect(source).toContain("r.retrievalReason === 'skipped-a2a'")
    expect(source).toContain('未检索（A2A）')
  })

  it('瀑布几何来自 utils/spanLayout（唯一真相源），本文件不内联几何', () => {
    expect(source).toContain("from '@/utils/spanLayout'")
    expect(source).toContain('buildWaterfall(spans.value)')
    // 时间格式化也走唯一真相源
    expect(source).toContain("from '@/utils/time'")
  })

  it('报错处置提示是**唯一表述点**（模板里不再散一份映射）', () => {
    expect(source).toContain('const ERROR_HINT')
    expect(source).toContain('function errorHint')
    // 只应有一处定义（模板调函数，不内联词表）
    expect(source.split('const ERROR_HINT').length - 1).toBe(1)
  })
})

describe('TraceView 行为（挂载）', () => {
  let wrapper: VueWrapper<any> | null = null

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    const store = useChatStore()
    store.sessions = [
      { id: 's1', title: '本会话' } as any,
      { id: 's2', title: '另一个会话' } as any,
    ]
    store.activeSessionId = 's1'
    mocked.getTraceExecutions.mockResolvedValue({
      ok: true,
      total: 1,
      limit: 50,
      offset: 0,
      executions: [row()],
    })
    mocked.getExecutionDetail.mockResolvedValue(detail())
    mocked.getEvalSpans.mockResolvedValue({ ok: true, spans: spansFixture() } as any)
    mocked.getRetrievalDetail.mockResolvedValue({
      ok: true,
      reason: 'ok',
      queries: [{ id: 1, query_index: 0, query_text: 'T2 怎么做', query_embed_ok: 1 }],
      candidates: [
        {
          id: 1,
          query_id: 1,
          source: 'final',
          channel: 'vector',
          doc_path: 'docs/adr/0002-b.md',
          section_anchor: '## 决策',
          distance: 0.293,
          rank: 0,
          rrf_score: 0.016,
          final_rank: 0,
          passed_status_filter: null,
          injected: 1,
          section_rank: 0,
          injected_position: 1,
          dropped_reason: null,
          body_head: '正文',
          breadcrumb: 'b',
        },
        {
          id: 2,
          query_id: 1,
          source: 'probe',
          channel: 'vector',
          doc_path: 'docs/adr/0003-c.md',
          section_anchor: '## 决策',
          distance: 0.71,
          rank: 1,
          rrf_score: null,
          final_rank: null,
          passed_status_filter: 1,
          injected: 0,
          section_rank: null,
          injected_position: null,
          dropped_reason: 'threshold',
          body_head: '正文2',
          breadcrumb: 'c',
        },
      ],
      droppedReasons: { threshold: 1 },
    })
    mocked.getPromptSection.mockResolvedValue({
      ok: true,
      key: 'system_prompt',
      content: '你是 ds猫。',
      charCount: 6,
    })
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
  })

  it('列表渲染六个读数：时间 / 猫 / 摘要 / 状态 / 耗时 / 检索漏斗', async () => {
    wrapper = await mountView()
    const head = wrapper.find('.row-head')
    expect(head.exists()).toBe(true)
    expect(head.find('.rh-agent').text()).toBe('ds猫')
    expect(head.find('.rh-sum').text()).toBe('结论先行：T2 已落')
    expect(head.find('.rh-status').text()).toBe('完成')
    expect(head.find('.rh-ms').text()).toBe('8.4s')
    // 检索漏斗与「📎 记忆」行同口径：注入 N 节 · 引 M 号
    expect(head.find('.rh-funnel').text()).toBe('注入5节 · 引2')
  })

  it('failed 行：整行带 row-failed，且报错类型**直接写在行上**（列表层就有答案）', async () => {
    mocked.getTraceExecutions.mockResolvedValue({
      ok: true,
      total: 1,
      limit: 50,
      offset: 0,
      executions: [
        row({ status: 'failed', errorType: 'timeout', errorMessage: '执行超时 (1800s)' }),
      ],
    })
    wrapper = await mountView()
    expect(wrapper.find('.tv-row').classes()).toContain('row-failed')
    expect(wrapper.find('.rh-err').text()).toBe('timeout')
  })

  it('A2A 行：漏斗位显示「未检索（A2A）」，不显示注入数', async () => {
    mocked.getTraceExecutions.mockResolvedValue({
      ok: true,
      total: 1,
      limit: 50,
      offset: 0,
      executions: [row({ retrievalReason: 'skipped-a2a', injectedSections: 0, citationCount: 0 })],
    })
    wrapper = await mountView()
    expect(wrapper.find('.rh-funnel').text()).toBe('未检索（A2A）')
  })

  it('点行头 → 并行拉详情与段，渲出瀑布 + 决策两行（含「已回复标注」细节）', async () => {
    wrapper = await mountView()
    await wrapper.find('.row-head').trigger('click')
    await flush()

    expect(mocked.getExecutionDetail).toHaveBeenCalledWith('exec-1')
    expect(mocked.getEvalSpans).toHaveBeenCalledWith('exec-1')
    // 瀑布：根段 8s ⇒ llm.chat 6s 占 75%
    const rows = wrapper.findAll('.segrow')
    expect(rows.length).toBeGreaterThanOrEqual(3)
    expect(wrapper.text()).toContain('llm.chat')
    // 失败段标红（status=error）
    expect(wrapper.find('.seg-err').exists()).toBe(true)
    // 决策四档：默认展开的是上下文决策
    expect(wrapper.find('.dc-invisible').text()).toBe('不可见')
    expect(wrapper.find('.dc-kept').text()).toBe('筛入（已回复标注）')
  })

  it('三小节懒加载：**不点开就不发请求**（首屏不付最大 payload）', async () => {
    wrapper = await mountView()
    await wrapper.find('.row-head').trigger('click')
    await flush()
    // 只开了「上下文决策」（默认展开），检索与 prompt 正文都还没拉
    expect(mocked.getRetrievalDetail).not.toHaveBeenCalled()
    expect(mocked.getPromptSection).not.toHaveBeenCalled()

    const btns = wrapper.findAll('.dsec-btn')
    // 第二个 dsec-btn = 检索明细
    await btns[1].trigger('click')
    await flush()
    expect(mocked.getRetrievalDetail).toHaveBeenCalledWith('exec-1')
    expect(wrapper.text()).toContain('T2 怎么做')
    // 丢弃原因分布（threshold → 中文标签）
    expect(wrapper.text()).toContain('距离超阈值')
  })

  it('prompt 快照：点开某节才拉正文，再点收起', async () => {
    wrapper = await mountView()
    await wrapper.find('.row-head').trigger('click')
    await flush()
    await wrapper.findAll('.dsec-btn')[2].trigger('click')
    await flush()

    const psHeads = wrapper.findAll('.ps-head')
    expect(psHeads).toHaveLength(2)
    // 节状态：injected → 已注入；empty → 本轮为空（**不是报错**）
    expect(psHeads[0].find('.ps-status').text()).toBe('已注入')
    expect(psHeads[1].find('.ps-status').text()).toBe('本轮为空')

    await psHeads[0].trigger('click')
    await flush()
    expect(mocked.getPromptSection).toHaveBeenCalledWith('exec-1', 'system_prompt')
    expect(wrapper.find('.ps-body').text()).toBe('你是 ds猫。')

    // 再点收起：不发第二次请求
    await wrapper.findAll('.ps-head')[0].trigger('click')
    await flush()
    expect(wrapper.find('.ps-body').exists()).toBe(false)
    expect(mocked.getPromptSection).toHaveBeenCalledTimes(1)
  })

  it('存量行：`hasDetails: false` → 决策区与快照区都显示占位，**不是报错**', async () => {
    mocked.getExecutionDetail.mockResolvedValue(
      detail({
        hasDetails: false,
        context: {
          counts: { kept: 0, invisible: 0, summary_replaced: 0, budget: 0 },
          repliedCount: 0,
          total: 0,
          decisions: [],
        },
        promptSections: [],
      })
    )
    mocked.getEvalSpans.mockResolvedValue({ ok: true, spans: [] } as any)
    wrapper = await mountView()
    await wrapper.find('.row-head').trigger('click')
    await flush()

    expect(wrapper.text()).toContain('无段数据（存量行）')
    expect(wrapper.text()).toContain('无决策数据（存量行）')
    expect(wrapper.find('.tv-err').exists()).toBe(false)
  })

  it('在飞执行无段：显示「还在跑」而**不是**「存量行」（两态混说会让人把没采到读成在跑）', async () => {
    mocked.getTraceExecutions.mockResolvedValue({
      ok: true,
      total: 1,
      limit: 50,
      offset: 0,
      executions: [row({ status: 'running', endedAt: null, totalMs: null })],
    })
    mocked.getExecutionDetail.mockResolvedValue(
      detail({
        execution: { ...detail().execution, status: 'running', endedAt: null, totalMs: null },
      })
    )
    mocked.getEvalSpans.mockResolvedValue({ ok: true, spans: [] } as any)
    wrapper = await mountView()
    await wrapper.find('.row-head').trigger('click')
    await flush()

    expect(wrapper.text()).toContain('段数据在本次执行收尾时一次性落库')
    expect(wrapper.text()).not.toContain('无段数据（存量行）')
    // totalMs 为 null ⇒ 「—」而不是 0
    expect(wrapper.find('.rh-ms').text()).toBe('—')
  })

  it('failed 执行：错误框默认展开，内容 = errorMessage，并给出处置提示', async () => {
    mocked.getTraceExecutions.mockResolvedValue({
      ok: true,
      total: 1,
      limit: 50,
      offset: 0,
      executions: [
        row({ status: 'failed', errorType: 'timeout', errorMessage: '执行超时 (1800s)' }),
      ],
    })
    mocked.getExecutionDetail.mockResolvedValue(
      detail({
        execution: {
          ...detail().execution,
          status: 'failed',
          errorType: 'timeout',
          errorMessage: '执行超时 (1800s)',
        },
      })
    )
    wrapper = await mountView()
    await wrapper.find('.row-head').trigger('click')
    await flush()

    expect(wrapper.find('.dsec-error').exists()).toBe(true)
    expect(wrapper.find('.err-body').text()).toBe('执行超时 (1800s)')
    // 认得的类型给处置提示；值域外的类型给空串（宁可不说，不瞎指方向）
    expect(wrapper.find('.err-hint').text()).toContain('AGENT_HARD_TIMEOUT_MS')
  })

  it('过滤：改任一条件都带 offset=0 重拉（停在第 3 页看新条件是错位的）', async () => {
    wrapper = await mountView()
    mocked.getTraceExecutions.mockClear()
    await wrapper.find('.tf-chk input').setValue(true)
    await flush()

    expect(mocked.getTraceExecutions).toHaveBeenCalledTimes(1)
    const arg = mocked.getTraceExecutions.mock.calls[0][0] as any
    expect(arg.errorsOnly).toBe(true)
    expect(arg.offset).toBe(0)
    expect(arg.sessionId).toBe('s1') // 默认口径 = 当前会话
  })

  it('预选（气泡 ⚙ 进来）：自动展开该行', async () => {
    wrapper = await mountView('exec-1')
    expect(mocked.getExecutionDetail).toHaveBeenCalledWith('exec-1')
    expect(wrapper.find('.row-head').attributes('aria-expanded')).toBe('true')
  })

  it('详情加载失败：展开区显示错误，**列表本身仍在**（不炸整页）', async () => {
    mocked.getExecutionDetail.mockRejectedValue(new Error('资源不存在：execution not found'))
    wrapper = await mountView()
    await wrapper.find('.row-head').trigger('click')
    await flush()
    expect(wrapper.text()).toContain('资源不存在：execution not found')
    expect(wrapper.find('.row-head').exists()).toBe(true)
  })
})
