import { describe, it, expect } from 'vitest'
import {
  buildWaterfall,
  fmtMs,
  sharePct,
  splitMicroSpans,
  MICRO_SHARE,
  SPAN_PHASE,
  SEG_DOC,
  FIELD_DOCS,
  OUTSIDE_LABELS,
} from './spanLayout'
import type { SpanDto } from '@/composables/useApi'

/**
 * 段瀑布口径单源（R4 从 EvaluationView 抽出）——纯函数测试，无 DOM、无 mock。
 *
 * 这是「口径只有一个真相源」的**机械保证**：评估页与右侧面板共用本文件的几何，
 * 任何一侧想改口径都得先过这里。评估页那侧的渲染等价性由 EvaluationView.test.ts
 * 的 B3–B8 挂载断言（DOM 结构）守住——两套测试合起来 = 抽出前后行为等价。
 */

const T0 = Date.parse('2026-09-01T10:00:00.000Z')
const isoAt = (off: number) => new Date(T0 + off).toISOString()

/** span 行工厂（照 EvaluationView.test.ts 同款：真实库形状，字段全给） */
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

describe('buildWaterfall 口径铁律', () => {
  it('轴长 = 根段 duration_ms（不是子段之和）；子段和 > 100% 时**不得归一化**', () => {
    // 段是**嵌套**的：两个子段各自占 80% 轴长、彼此重叠 ⇒ 宽度之和 160% > 100%。
    // 若实现「归一化到 100%」，等于把根段也缩掉——总时长读数就假了。
    const spans = [
      spanRow({ id: 1, span_id: 'r', name: 'invoke_agent', duration_ms: 1000 }),
      spanRow({
        id: 2,
        span_id: 'a',
        parent_span_id: 'r',
        name: 'llm.chat',
        start_at: isoAt(0),
        duration_ms: 800,
      }),
      spanRow({
        id: 3,
        span_id: 'b',
        parent_span_id: 'r',
        name: 'memory.retrieval',
        start_at: isoAt(100),
        duration_ms: 800,
      }),
    ]
    const wf = buildWaterfall(spans)!
    expect(wf.axisMs).toBe(1000)

    // 只加**子段**：根段自己恒占满整轴（100%），混进来会把读数抬成 260%
    const sum = wf.rows.filter((r) => !r.isRoot).reduce((a, r) => a + r.widthPct, 0)
    expect(sum).toBeCloseTo(160, 6) // 160% —— 未被归一化成 100%
    expect(sum).toBeGreaterThan(150)

    // 根段自己恒占满整轴
    const root = wf.rows.find((r) => r.isRoot)!
    expect(root.leftPct).toBe(0)
    expect(root.widthPct).toBeCloseTo(100, 6)
  })

  it('轴外段（起点早于根段 / 终点晚于根段）不进轴、不计总时长，只作单行标注', () => {
    const spans = [
      spanRow({ id: 2, span_id: 'r', name: 'invoke_agent', duration_ms: 1000 }),
      // 排队段：起点早于根段（它量的是「上一跳还占着槽位」的那段时间）
      spanRow({
        id: 1,
        span_id: 'qw',
        parent_span_id: 'r',
        name: 'dispatch.queue_wait',
        start_at: isoAt(-500),
        duration_ms: 500,
      }),
      // 轮次段：终点晚于根段
      spanRow({
        id: 3,
        span_id: 'ac',
        name: 'git.auto_commit',
        start_at: isoAt(1000),
        duration_ms: 300,
      }),
    ]
    const wf = buildWaterfall(spans)!
    expect(wf.rows.map((r) => r.name)).toEqual(['invoke_agent'])
    expect(wf.outside).toHaveLength(2)
    expect(wf.outside.map((o) => o.text)).toEqual([
      '排队等待 500ms（不计入本次执行）',
      'auto-commit 300ms（不计入本次执行）',
    ])
    // 总时长口径不受轴外段影响
    expect(wf.axisMs).toBe(1000)
  })

  it('轴的起点取根段 start_at，不是 min(start_at)——那会把排队段拉进轴内', () => {
    const spans = [
      spanRow({
        id: 1,
        span_id: 'qw',
        name: 'dispatch.queue_wait',
        start_at: isoAt(-9),
        duration_ms: 9,
      }),
      spanRow({ id: 2, span_id: 'r', name: 'invoke_agent', duration_ms: 100 }),
    ]
    const wf = buildWaterfall(spans)!
    // 若误用 min(start_at) 当轴起点，根段的 leftPct 会是 9% 而非 0
    expect(wf.rows.find((r) => r.isRoot)!.leftPct).toBe(0)
  })

  it('根段按名优先（invoke_agent），不被错挂成 NULL 父的段顶替', () => {
    const spans = [
      // 错挂段：parent 也是 NULL，但名不是 invoke_agent，且起点更早
      spanRow({
        id: 1,
        span_id: 'stray',
        name: 'context.assemble',
        start_at: isoAt(-100),
        duration_ms: 50,
      }),
      spanRow({ id: 2, span_id: 'r', name: 'invoke_agent', duration_ms: 1000 }),
    ]
    const wf = buildWaterfall(spans)!
    // 轴长取 invoke_agent 的 1000，不是 stray 的 50
    expect(wf.axisMs).toBe(1000)
    // stray 起点早于根段 ⇒ 落轴外，而不是当上根段
    expect(wf.outside.map((o) => o.key)).toEqual(['stray'])
  })

  it('无根段 / 轴长非正 / 起点不可解析 ⇒ null（不是空瀑布——「不知道」≠「空」）', () => {
    expect(buildWaterfall([])).toBeNull()
    // 无根段 = **没有任何** `parent_span_id IS NULL` 的段（不是「名字不叫 invoke_agent」——
    // 后者会回落到「随便找个 NULL 父当根」，那是实现既有的兜底语义，不是无根）
    expect(
      buildWaterfall([
        spanRow({ span_id: 'x', parent_span_id: 'nope', name: 'llm.chat', duration_ms: 5 }),
      ])
    ).toBeNull()
    expect(
      buildWaterfall([spanRow({ span_id: 'r', name: 'invoke_agent', duration_ms: 0 })])
    ).toBeNull()
    expect(
      buildWaterfall([
        spanRow({ span_id: 'r', name: 'invoke_agent', start_at: '不是时间', duration_ms: 10 }),
      ])
    ).toBeNull()
  })

  it('行按时间序（start_at 升序，id 兜底同刻段）——时间序是排查读法的前提', () => {
    const spans = [
      spanRow({
        id: 3,
        span_id: 'c',
        parent_span_id: 'r',
        name: 'reply.persist',
        start_at: isoAt(90),
        duration_ms: 5,
      }),
      spanRow({ id: 1, span_id: 'r', name: 'invoke_agent', duration_ms: 100 }),
      spanRow({
        id: 2,
        span_id: 'b',
        parent_span_id: 'r',
        name: 'llm.chat',
        start_at: isoAt(20),
        duration_ms: 50,
      }),
      spanRow({
        id: 4,
        span_id: 'd',
        parent_span_id: 'r',
        name: 'diff.collect',
        start_at: isoAt(20),
        duration_ms: 1,
      }),
    ]
    const wf = buildWaterfall(spans)!
    // 同刻（isoAt(20)）时按 id 升序：b(2) 在 d(4) 前
    expect(wf.rows.map((r) => r.name)).toEqual([
      'invoke_agent',
      'llm.chat',
      'diff.collect',
      'reply.persist',
    ])
    for (let i = 1; i < wf.rows.length; i++) {
      expect(wf.rows[i].leftPct).toBeGreaterThanOrEqual(wf.rows[i - 1].leftPct)
    }
  })

  it('行携带相位 / 状态徽章判据 / 首字（只非 ok 挂徽章；ttft 只在 llm.chat）', () => {
    const spans = [
      spanRow({ id: 1, span_id: 'r', name: 'invoke_agent', duration_ms: 100 }),
      spanRow({
        id: 2,
        span_id: 'l',
        parent_span_id: 'r',
        name: 'llm.chat',
        start_at: isoAt(10),
        duration_ms: 50,
        status: 'timeout',
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
        id: 3,
        span_id: 'p',
        parent_span_id: 'r',
        name: 'reply.persist',
        start_at: isoAt(80),
        duration_ms: 2,
      }),
    ]
    const wf = buildWaterfall(spans)!
    const llm = wf.rows.find((r) => r.name === 'llm.chat')!
    expect(llm.phase).toBe('llm')
    expect(llm.bad).toBe(true) // timeout ⇒ 红条
    expect(llm.status).toBe('timeout')
    expect(llm.ttftText).toBe('3.0s')

    const ok = wf.rows.find((r) => r.name === 'reply.persist')!
    expect(ok.bad).toBe(false)
    expect(ok.ttftText).toBeNull() // 非 llm.chat 段没有首字
  })
})

describe('fmtMs —— null 是「—」不是「0ms」', () => {
  it('三档人话化 + null/undefined 显式降级', () => {
    expect(fmtMs(null)).toBe('—')
    expect(fmtMs(undefined)).toBe('—')
    expect(fmtMs(0)).toBe('0ms') // 真的是 0 才显示 0
    expect(fmtMs(500)).toBe('500ms')
    expect(fmtMs(1500)).toBe('1.5s')
    expect(fmtMs(60810)).toBe('1.0min')
    expect(fmtMs(120000)).toBe('2.0min')
  })
})

describe('sharePct —— 小段的差别全在小数位', () => {
  it('≥10% 保留 1 位，<10% 保留 2 位；轴长非正给「—」不编 0%', () => {
    expect(sharePct(10, 100)).toBe('10.0%')
    expect(sharePct(50, 100)).toBe('50.0%')
    expect(sharePct(5, 100)).toBe('5.00%')
    expect(sharePct(1, 3)).toBe('33.3%') // ≥10% 也走 1 位档（33.33… 截到 33.3）
    expect(sharePct(1, 0)).toBe('—')
  })
})

describe('splitMicroSpans —— 折叠是读法，不是丢数据', () => {
  const rows = [
    {
      key: 'a',
      name: 'llm.chat',
      isRoot: false,
      phase: 'llm',
      leftPct: 0,
      widthPct: 50,
      durationMs: 500,
      sharePct: '50.0%',
      status: 'ok',
      bad: false,
      ttftText: null,
    },
    {
      key: 'b',
      name: 'context.assemble',
      isRoot: false,
      phase: 'orch',
      leftPct: 50,
      widthPct: 0.5,
      durationMs: 5,
      sharePct: '0.50%',
      status: 'ok',
      bad: false,
      ttftText: null,
    },
  ]

  it('按轴长占比 1% 分档；两组并集 = 入参全量（一个都不丢）', () => {
    expect(MICRO_SHARE).toBe(0.01)
    const { shown, micro } = splitMicroSpans(rows, 1000)
    expect(shown.map((r) => r.key)).toEqual(['a'])
    expect(micro.map((r) => r.key)).toEqual(['b'])
    expect(shown.length + micro.length).toBe(rows.length)
  })

  it('阈值边界：恰好 1% 不算微段（`<` 不是 `<=`）', () => {
    const edge = [{ ...rows[1], durationMs: 10, key: 'edge' }] // 10/1000 = 1%
    expect(splitMicroSpans(edge, 1000).micro).toEqual([])
    expect(splitMicroSpans(edge, 1000).shown.map((r) => r.key)).toEqual(['edge'])
  })

  it('轴长非正 ⇒ 全进 shown（不猜、不折叠）', () => {
    const { shown, micro } = splitMicroSpans(rows, 0)
    expect(shown).toHaveLength(2)
    expect(micro).toHaveLength(0)
  })
})

describe('口径常量闭集（与 R2 §五 同源）', () => {
  it('段名闭集 11 条：相位与段说明一一对齐，无孤儿、无缺项', () => {
    const names = Object.keys(SPAN_PHASE).sort()
    expect(names).toHaveLength(11)
    expect(names).toEqual(Object.keys(SEG_DOC).sort())
  })

  it('轴外段友好名只登记真会落轴外的两个（排队 / auto-commit）', () => {
    expect(Object.keys(OUTSIDE_LABELS).sort()).toEqual(['dispatch.queue_wait', 'git.auto_commit'])
    // 两者都必须是已登记段名（防手滑写错名后静默回落成原名）
    for (const n of Object.keys(OUTSIDE_LABELS)) expect(SPAN_PHASE[n]).toBeTruthy()
  })

  it('字段说明只讲真展示在前端的字段（后端有、界面无的不登记）', () => {
    expect(FIELD_DOCS.map((d) => d.name)).toEqual(['耗时', '状态', '首字'])
    const blob = FIELD_DOCS.map((d) => `${d.name}${d.desc}`).join('')
    for (const ghost of ['item_count', 'operation_name', 'max_tokens', 'stream']) {
      expect(blob).not.toContain(ghost)
    }
  })
})
