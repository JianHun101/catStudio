/**
 * phase0.test.ts — Phase 0 选型预验证纯函数单测（统计口径 + 闸门 + 样本构造）。
 */
import { describe, it, expect } from 'vitest'
import {
  rank,
  spearman,
  verdictOf,
  agreementRate,
  gateVerdict,
  pickWinner,
  selectCandidates,
  extractPrecedingContext,
  buildExternalSamples,
} from './phase0.js'
import type { Phase0Metrics } from './phase0.js'

const mkMetrics = (over: Partial<Phase0Metrics>): Phase0Metrics => ({
  spearman: 0.85,
  agreement: 0.88,
  selfAgreement: 0.9,
  externalAgreement: 0.8,
  counted: 40,
  total: 50,
  ...over,
})

describe('rank / spearman', () => {
  it('rank: 无 ties 顺序秩', () => {
    expect(rank([10, 20, 30])).toEqual([1, 2, 3])
    expect(rank([30, 10, 20])).toEqual([3, 1, 2])
  })

  it('rank: ties 取平均秩', () => {
    expect(rank([5, 5, 10])).toEqual([1.5, 1.5, 3])
  })

  it('spearman: 完美正相关 = 1', () => {
    expect(spearman([1, 2, 3, 4, 5], [1, 2, 3, 4, 5])).toBe(1)
  })

  it('spearman: 完美负相关 = -1', () => {
    expect(spearman([1, 2, 3, 4, 5], [5, 4, 3, 2, 1])).toBe(-1)
  })

  it('spearman: 单调但非线性仍为 1（秩相关特性）', () => {
    expect(spearman([1, 2, 3], [1, 100, 101])).toBe(1)
  })

  it('spearman: 样本不足返回 NaN', () => {
    expect(Number.isNaN(spearman([1], [1]))).toBe(true)
  })
})

describe('verdictOf / agreementRate', () => {
  it('判定口径: ≥4 通过 / ≤2 不通过 / 3 不计', () => {
    expect(verdictOf(4)).toBe('pass')
    expect(verdictOf(5)).toBe('pass')
    expect(verdictOf(2)).toBe('fail')
    expect(verdictOf(1)).toBe('fail')
    expect(verdictOf(3)).toBe('ignore')
  })

  it('一致率: 双方同为 pass/fail 一致，3 分不计', () => {
    // judge: [5, 1, 3, 4]  human: [5, 2, 3, 2]
    // 5/5 pass-pass 一致；1/2 fail-fail 一致；3/3 不计；4/2 pass-fail 不一致
    const r = agreementRate([5, 1, 3, 4], [5, 2, 3, 2])
    expect(r.counted).toBe(3)
    expect(r.rate).toBeCloseTo(2 / 3, 5)
  })
})

describe('gateVerdict', () => {
  it('主指标 + 子指标全过 → pass', () => {
    expect(gateVerdict(mkMetrics({})).pass).toBe(true)
  })

  it('Spearman < 0.7 → 否决', () => {
    const v = gateVerdict(mkMetrics({ spearman: 0.69 }))
    expect(v.pass).toBe(false)
    expect(v.reasons.join()).toContain('0.69 < 0.7')
  })

  it('一致率 < 80% → 否决', () => {
    expect(gateVerdict(mkMetrics({ agreement: 0.79 })).pass).toBe(false)
  })

  it('自有族 vs 外部差 > 15pp → 否决（超阈否决）', () => {
    const v = gateVerdict(mkMetrics({ selfAgreement: 0.95, externalAgreement: 0.75 }))
    expect(v.pass).toBe(false)
    expect(v.reasons.join()).toContain('20pp > 15pp')
  })

  it('差 = 15pp 整 → 通过（≤15pp 边界）', () => {
    expect(gateVerdict(mkMetrics({ selfAgreement: 0.95, externalAgreement: 0.8 })).pass).toBe(true)
  })
})

describe('pickWinner', () => {
  const res = (name: string, spearman: number, agreement: number, pass: boolean) => ({
    name,
    pass,
    metrics: mkMetrics({ spearman, agreement }),
  })

  it('唯一通过者胜出', () => {
    const winner = pickWinner([res('a', 0.9, 0.85, true), res('b', 0.6, 0.8, false)])
    expect(winner).toBe('a')
  })

  it('主指标并列时跨族优先（kimi 非 deepseek 前缀）', () => {
    const winner = pickWinner([
      res('deepseek-v4-pro', 0.85, 0.88, true),
      res('kimi-k3[1m]', 0.85, 0.88, true),
    ])
    expect(winner).toBe('kimi-k3[1m]')
  })

  it('非并列按 (spearman, agreement) 最优', () => {
    const winner = pickWinner([
      res('kimi-k3[1m]', 0.82, 0.85, true),
      res('deepseek-v4-pro', 0.9, 0.9, true),
    ])
    expect(winner).toBe('deepseek-v4-pro')
  })

  it('无通过候选 → null（回退信号）', () => {
    expect(pickWinner([res('a', 0.5, 0.5, false)])).toBeNull()
  })
})

describe('selectCandidates', () => {
  const rows = [
    {
      id: 'm1',
      session_id: 's',
      agent_id: 'prod-1',
      role: 'agent',
      content: 'a',
      created_at: '2026-08-01 00:01:00',
    },
    {
      id: 'm2',
      session_id: 's',
      agent_id: 'oll-1',
      role: 'agent',
      content: 'b',
      created_at: '2026-08-01 00:02:00',
    },
    {
      id: 'm3',
      session_id: 's',
      agent_id: 'ds-1',
      role: 'agent',
      content: 'c',
      created_at: '2026-08-01 00:03:00',
    },
    {
      id: 'm4',
      session_id: 's',
      agent_id: null,
      role: 'user',
      content: 'd',
      created_at: '2026-08-01 00:04:00',
    },
    {
      id: 'm5',
      session_id: 's',
      agent_id: 'gpt-1',
      role: 'agent',
      content: 'e',
      created_at: '2026-08-01 00:05:00',
    },
    {
      id: 'm6',
      session_id: 's',
      agent_id: 'legacy-1',
      role: 'agent',
      content: 'f',
      created_at: '2026-08-01 00:06:00',
    },
  ]
  const agentById = new Map([
    // 生产主猫形态：provider='opencode' + opencode-go 模型前缀 → 选中（M1 回归）
    ['prod-1', { provider: 'opencode', model: 'opencode-go/deepseek-v4-flash' }],
    // 旧 claude 直连形态（回滚路径）→ includes 判定下仍选中
    ['legacy-1', { provider: 'claude', model: 'deepseek-v4-flash' }],
    ['ds-1', { provider: 'deepseek', model: 'deepseek-v4-flash' }],
    ['oll-1', { provider: 'ollama', model: 'qwen3.5:9b' }],
    ['gpt-1', { provider: 'openai', model: 'gpt-4o' }],
  ])

  it('只选 DS 族 agent 回复（opencode-go 前缀主猫 + 旧 claude 直连都算；排除 ollama/外部族与非 agent 消息）', () => {
    const picked = selectCandidates(rows, agentById, 10)
    expect(picked.map((p) => p.messageId)).toEqual(['m1', 'm3', 'm6']) // 保持倒序输入顺序
    expect(picked.every((p) => p.content)).toBe(true)
  })

  it('count 上限生效', () => {
    expect(selectCandidates(rows, agentById, 1)).toHaveLength(1)
  })

  it('agent 不在映射中 → 排除', () => {
    const picked = selectCandidates(rows, new Map(), 10)
    expect(picked).toHaveLength(0)
  })
})

describe('extractPrecedingContext', () => {
  // DESC 序（最新在前）：m5 最新，m1 最早
  const rows = [
    { id: 'm5', role: 'agent' as const, agent_id: 'ds-1', content: 'e' },
    { id: 'm4', role: 'user' as const, agent_id: null, content: 'd' },
    { id: 'm3', role: 'agent' as const, agent_id: 'ds-1', content: 'c' },
    { id: 'm2', role: 'user' as const, agent_id: null, content: 'b' },
    { id: 'm1', role: 'agent' as const, agent_id: 'ds-1', content: 'a' },
  ]

  it('取目标之后（更早）消息、不含目标自身、时间正序（OQ① 回归）', () => {
    const ctx = extractPrecedingContext(rows, 'm3')
    // m3 之后（更早）= m2, m1；反转 = [m1, m2]（最早在前）
    expect(ctx.map((r) => r.content)).toEqual(['a', 'b'])
    expect(ctx.some((r) => r.content === 'c')).toBe(false) // 目标自身不进上下文
  })

  it('maxCount 上限生效（最多取更早 9 条）', () => {
    const ctx = extractPrecedingContext(rows, 'm5', 9)
    expect(ctx.map((r) => r.content)).toEqual(['a', 'b', 'c', 'd'])
    const limited = extractPrecedingContext(rows, 'm5', 2)
    expect(limited.map((r) => r.content)).toEqual(['c', 'd'])
  })

  it('目标是最早消息 → 空上下文', () => {
    expect(extractPrecedingContext(rows, 'm1')).toEqual([])
  })

  it('目标不存在 → 空上下文', () => {
    expect(extractPrecedingContext(rows, 'nope')).toEqual([])
  })
})

describe('buildExternalSamples', () => {
  it('20 条外部对照，humanScore 全部非空，好坏分布存在', () => {
    const samples = buildExternalSamples()
    expect(samples).toHaveLength(20)
    expect(samples.every((s) => s.humanScore !== null)).toBe(true)
    expect(samples.filter((s) => s.humanScore! >= 4).length).toBeGreaterThanOrEqual(9)
    expect(samples.filter((s) => s.humanScore! <= 2).length).toBeGreaterThanOrEqual(9)
    expect(samples.filter((s) => s.humanScore === 3).length).toBe(0)
  })
})
