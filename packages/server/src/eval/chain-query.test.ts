/**
 * chain-query 测试 — P1-A 纯函数契约。
 * 零 I/O：不建 DB、不起 Fastify。全部用手造 ExecHopRow 断言
 * 分组 / 段算 / flags / 排序 / 截断 / totals。
 */
import { describe, it, expect } from 'vitest'
import { buildChains, type ExecHopRow } from './chain-query.js'

const SLOW = 300_000

/** 原始行工厂——默认一条「正常完成」的跳，逐字段可覆盖 */
function row(overrides: Partial<ExecHopRow> = {}): ExecHopRow {
  return {
    execution_log_id: 'log-1',
    agent_id: 'a1',
    agent_name: 'ds猫',
    status: 'completed',
    error_type: null,
    started_at: '2026-09-01 10:00:00',
    ended_at: '2026-09-01 10:02:00',
    latency_ms: 118_500,
    reply_chars: 120,
    message_id: 'm-reply',
    triggered_by_message_id: 'm-trigger',
    chain_id: 'chain-A',
    ...overrides,
  }
}

const build = (rows: ExecHopRow[], limit = 20) => buildChains(rows, { slowMs: SLOW, limit })

describe('段算', () => {
  it('totalMs 是 ended_at − started_at（秒级 UTC 字符串 ⇒ 1000 的整数倍）', () => {
    const [hop] = build([row()]).chains[0].hops
    expect(hop.totalMs).toBe(120_000)
    expect(hop.totalMs! % 1000).toBe(0)
  })

  it('replyMs 取 latency_ms（毫秒精度，非 1000 倍数）', () => {
    const [hop] = build([row({ latency_ms: 118_543 })]).chains[0].hops
    expect(hop.replyMs).toBe(118_543)
    expect(hop.replyMs! % 1000).not.toBe(0)
  })

  it('nonReplyMs = totalMs − replyMs', () => {
    const [hop] = build([row({ latency_ms: 118_500 })]).chains[0].hops
    expect(hop.nonReplyMs).toBe(1_500)
  })

  it('replyMs 为 null（无数据）⇒ nonReplyMs 也 null，不写成 0', () => {
    const [hop] = build([row({ latency_ms: null })]).chains[0].hops
    expect(hop.replyMs).toBeNull()
    expect(hop.nonReplyMs).toBeNull()
  })

  it('segmentClamped：latency_ms > totalMs ⇒ nonReplyMs 钳到 0 且显式暴露', () => {
    // 秒级舍入：ended_at 精度 1 秒，replyMs 毫秒精度 ⇒ 可算出负的残余段
    const [hop] = build([row({ latency_ms: 120_500 })]).chains[0].hops
    expect(hop.totalMs).toBe(120_000)
    expect(hop.nonReplyMs).toBe(0)
    expect(hop.segmentClamped).toBe(true)
  })

  it('段差为正 ⇒ segmentClamped 为 false', () => {
    const [hop] = build([row({ latency_ms: 118_500 })]).chains[0].hops
    expect(hop.segmentClamped).toBe(false)
  })

  it('running 行（ended_at null）⇒ totalMs/nonReplyMs null、segmentClamped false，且仍在 hops[] 里', () => {
    const rows = [
      row({ execution_log_id: 'log-done', ended_at: '2026-09-01 10:02:00' }),
      row({
        execution_log_id: 'log-running',
        status: 'running',
        started_at: '2026-09-01 10:03:00',
        ended_at: null,
        latency_ms: null,
        reply_chars: null,
        message_id: null,
      }),
    ]
    const chain = build(rows).chains[0]
    // 正在跑的那一跳就是当前卡点——丢掉它等于把卡点藏起来
    expect(chain.hops).toHaveLength(2)
    const running = chain.hops.find((h) => h.executionLogId === 'log-running')!
    expect(running).toBeDefined()
    expect(running.totalMs).toBeNull()
    expect(running.nonReplyMs).toBeNull()
    expect(running.segmentClamped).toBe(false)
  })

  it('running 行已写入 latency_ms（diagnostics 先于 finalize）⇒ 仍算不出 nonReplyMs', () => {
    const [hop] = build([
      row({ status: 'running', ended_at: null, latency_ms: 5_000, message_id: null }),
    ]).chains[0].hops
    expect(hop.replyMs).toBe(5_000)
    expect(hop.totalMs).toBeNull()
    expect(hop.nonReplyMs).toBeNull()
  })
})

describe('卡点 flags（四类互不排斥，全标不筛选）', () => {
  it('failed', () => {
    const [hop] = build([row({ status: 'failed', error_type: 'timeout' })]).chains[0].hops
    expect(hop.flags).toContain('failed')
  })

  it('no_reply：message_id 为 null（失败的跳压根不产生消息行）', () => {
    const [hop] = build([row({ status: 'failed', message_id: null })]).chains[0].hops
    expect(hop.flags).toContain('no_reply')
  })

  it('no_reply：reply_chars 为 0', () => {
    const [hop] = build([row({ reply_chars: 0 })]).chains[0].hops
    expect(hop.flags).toContain('no_reply')
  })

  it('no_reply 守卫：running 跳不标——在飞 ≠ 无回复（P1-A2）', () => {
    // 在飞跳 message_id 必为 null 是结构性必然（回复还没产生）；标 no_reply 等于
    // 在同一行并排渲染「进行中」+「无回复」——报假数，比欠报更坏。
    const [hop] = build([
      row({
        status: 'running',
        started_at: '2026-09-01 10:03:00',
        ended_at: null,
        latency_ms: null,
        reply_chars: null,
        message_id: null,
      }),
    ]).chains[0].hops
    expect(hop.flags).not.toContain('no_reply')
    // 段算全 null ⇒ slow 也进不来；running ⇒ 不进 failed / no_data。四类一个都不该有。
    expect(hop.flags).toEqual([])
  })

  it('no_reply 守卫负例：已结束的跳仍照标（防过度修正）', () => {
    // failed：压根不产生回复消息行
    expect(build([row({ status: 'failed', message_id: null })]).chains[0].hops[0].flags).toContain(
      'no_reply'
    )
    // completed 但 message_id 为 null
    expect(build([row({ message_id: null })]).chains[0].hops[0].flags).toContain('no_reply')
    // completed 且 reply_chars 为 0
    expect(build([row({ reply_chars: 0 })]).chains[0].hops[0].flags).toContain('no_reply')
  })

  it('no_reply 守卫方向向严：非 running 的未知 status 仍照标，不静默漏标', () => {
    // 守卫写成 `!== 'running'` 而非白名单 `=== 'failed' | 'completed'`：
    // 将来新增结束态 status 时，宁可多标也不静默漏标。
    const [hop] = build([row({ status: 'cancelled', message_id: null })]).chains[0].hops
    expect(hop.flags).toContain('no_reply')
  })

  it('slow：totalMs > slowMs（严格大于，等于不算）', () => {
    // 10:00:00 → 10:05:00 = 300000 = slowMs，不算慢
    const equal = build([row({ ended_at: '2026-09-01 10:05:00' })]).chains[0].hops[0]
    expect(equal.totalMs).toBe(SLOW)
    expect(equal.flags).not.toContain('slow')
    // 多 1 秒 ⇒ 算慢
    const over = build([row({ ended_at: '2026-09-01 10:05:01' })]).chains[0].hops[0]
    expect(over.flags).toContain('slow')
  })

  it('no_data：completed 且有回复却无耗时（采集修复前全表的形态）', () => {
    const [hop] = build([row({ latency_ms: null })]).chains[0].hops
    expect(hop.flags).toContain('no_data')
  })

  it('no_data 负例：completed 且有 latency ⇒ 无任何 flag', () => {
    const [hop] = build([row()]).chains[0].hops
    expect(hop.flags).toEqual([])
  })

  it('failed 且 latency 为 null ⇒ 不标 no_data（no_data 只认 completed）', () => {
    const [hop] = build([row({ status: 'failed', latency_ms: null })]).chains[0].hops
    expect(hop.flags).not.toContain('no_data')
    expect(hop.flags).toContain('failed')
  })

  it('fast-fail 的 failed 跳不带 slow（没有 totalMs 跨度就不评判慢）', () => {
    const [hop] = build([row({ status: 'failed', ended_at: '2026-09-01 10:00:01' })]).chains[0].hops
    expect(hop.flags).not.toContain('slow')
  })

  it('四类可同时命中（互不排斥）', () => {
    const [hop] = build([
      row({
        status: 'failed',
        message_id: null,
        reply_chars: 0,
        latency_ms: null,
        ended_at: '2026-09-01 11:00:00',
      }),
    ]).chains[0].hops
    // failed / no_reply / slow 同时标；no_data 不标（status 不是 completed）
    expect(new Set(hop.flags)).toEqual(new Set(['failed', 'no_reply', 'slow']))
  })
})

describe('分组与孤儿', () => {
  it('按 chain_id 分组，链内跳按 started_at 升序', () => {
    const rows = [
      row({ execution_log_id: 'c', started_at: '2026-09-01 10:04:00' }),
      row({ execution_log_id: 'a', started_at: '2026-09-01 10:00:00' }),
      row({ execution_log_id: 'b', started_at: '2026-09-01 10:02:00' }),
    ]
    const chain = build(rows).chains[0]
    expect(chain.hops.map((h) => h.executionLogId)).toEqual(['a', 'b', 'c'])
  })

  it('同秒跳按 execution_log_id 升序（started_at 精度 1 秒，同秒是常态）', () => {
    const rows = [
      row({ execution_log_id: 'z', started_at: '2026-09-01 10:00:00' }),
      row({ execution_log_id: 'm', started_at: '2026-09-01 10:00:00' }),
      row({ execution_log_id: 'a', started_at: '2026-09-01 10:00:00' }),
    ]
    const chain = build(rows).chains[0]
    expect(chain.hops.map((h) => h.executionLogId)).toEqual(['a', 'm', 'z'])
  })

  it('孤儿跳全部落进 orphanChain，chains[] 里不含它们', () => {
    const rows = [
      row({ execution_log_id: 'ok-1', chain_id: 'chain-A' }),
      row({ execution_log_id: 'orphan-1', chain_id: null }),
      row({ execution_log_id: 'orphan-2', chain_id: null }),
    ]
    const res = build(rows)
    expect(res.chains).toHaveLength(1)
    expect(res.chains[0].hops.map((h) => h.executionLogId)).toEqual(['ok-1'])
    expect(res.orphanChain.chainId).toBeNull()
    expect(res.orphanChain.hopCount).toBe(2)
    expect(res.orphanChain.hops.map((h) => h.executionLogId)).toEqual(['orphan-1', 'orphan-2'])
  })

  it('orphanChain 恒在——无孤儿时 hopCount 0 / hops []，字段不省略', () => {
    const res = build([row()])
    expect(res.orphanChain).toEqual({ chainId: null, hopCount: 0, hops: [] })
  })

  it('totals.hops 含孤儿跳，totals.chains / maxHops / avgHopsPerChain 不含', () => {
    const rows = [
      row({ execution_log_id: 'a1', chain_id: 'chain-A' }),
      row({ execution_log_id: 'a2', chain_id: 'chain-A' }),
      row({ execution_log_id: 'b1', chain_id: 'chain-B' }),
      // 孤儿桶 3 跳 > 任何真链——若误把它算进 maxHops 会得到 3，正确答案是 2
      row({ execution_log_id: 'o1', chain_id: null }),
      row({ execution_log_id: 'o2', chain_id: null }),
      row({ execution_log_id: 'o3', chain_id: null }),
    ]
    const { totals } = build(rows)
    expect(totals.chains).toBe(2)
    expect(totals.hops).toBe(6)
    expect(totals.orphanHops).toBe(3)
    expect(totals.maxHops).toBe(2)
    expect(totals.avgHopsPerChain).toBe(1.5)
  })

  it('空输入 ⇒ 全零，不抛', () => {
    const res = build([])
    expect(res.totals).toEqual({
      chains: 0,
      hops: 0,
      orphanHops: 0,
      avgHopsPerChain: 0,
      maxHops: 0,
    })
    expect(res.chains).toEqual([])
    expect(res.orphanChain.hopCount).toBe(0)
  })
})

describe('链级聚合', () => {
  it('startedAt/endedAt 取链内最早/最晚，spanMs 是两者之差', () => {
    const rows = [
      row({
        execution_log_id: 'a',
        started_at: '2026-09-01 10:00:00',
        ended_at: '2026-09-01 10:02:00',
      }),
      row({
        execution_log_id: 'b',
        started_at: '2026-09-01 10:30:00',
        ended_at: '2026-09-01 11:04:06',
      }),
    ]
    const chain = build(rows).chains[0]
    expect(chain.startedAt).toBe('2026-09-01 10:00:00')
    expect(chain.endedAt).toBe('2026-09-01 11:04:06')
    expect(chain.spanMs).toBe(3_846_000)
    expect(chain.hopCount).toBe(2)
  })

  it('completedCount / failedCount 逐跳计数（running 两边都不进）', () => {
    const rows = [
      row({ execution_log_id: 'a', status: 'completed' }),
      row({ execution_log_id: 'b', status: 'failed', message_id: null }),
      row({ execution_log_id: 'c', status: 'running', ended_at: null, message_id: null }),
    ]
    const chain = build(rows).chains[0]
    expect(chain.completedCount).toBe(1)
    expect(chain.failedCount).toBe(1)
    expect(chain.hopCount).toBe(3)
  })

  it('startedAt/endedAt 是 UTC 字符串原样透传，不做时区转换', () => {
    const chain = build([row()]).chains[0]
    expect(chain.startedAt).toBe('2026-09-01 10:00:00')
    expect(chain.hops[0].startedAt).toBe('2026-09-01 10:00:00')
  })
})

describe('排序与截断', () => {
  /** 造一条跨度可控的链 */
  const chainOf = (id: string, startHour: number, spanMs: number): ExecHopRow[] => {
    const start = `2026-09-01 ${String(startHour).padStart(2, '0')}:00:00`
    const endMs = Date.parse(`${start.replace(' ', 'T')}Z`) + spanMs
    const end = new Date(endMs).toISOString().replace('T', ' ').slice(0, 19)
    return [row({ execution_log_id: `${id}-1`, chain_id: id, started_at: start, ended_at: end })]
  }

  it('chains[] 按 spanMs 降序（回答「哪里耗时最长」）', () => {
    const rows = [
      ...chainOf('short', 8, 60_000),
      ...chainOf('long', 9, 3_600_000),
      ...chainOf('mid', 10, 600_000),
    ]
    expect(build(rows).chains.map((c) => c.chainId)).toEqual(['long', 'mid', 'short'])
  })

  it('spanMs 并列时按 chainId 升序——分页/重复请求不抖动', () => {
    const rows = [...chainOf('zeta', 8, 60_000), ...chainOf('alpha', 9, 60_000)]
    const a = build(rows).chains.map((c) => c.chainId)
    const b = build([...rows].reverse()).chains.map((c) => c.chainId)
    expect(a).toEqual(['alpha', 'zeta'])
    expect(b).toEqual(a) // 输入顺序反过来，输出仍相同
  })

  it('limit 只截链不截跳——每条返回链的 hops.length === hopCount（绝不出现半条链）', () => {
    const rows = [
      ...chainOf('c1', 8, 3_600_000),
      ...chainOf('c2', 9, 600_000),
      ...chainOf('c3', 10, 60_000),
    ]
    const res = build(rows, 2)
    expect(res.chains).toHaveLength(2)
    for (const c of res.chains) {
      expect(c.hops).toHaveLength(c.hopCount)
    }
    // 被截掉的是最短的那条，整条消失——不是留半条
    expect(res.chains.map((c) => c.chainId)).toEqual(['c1', 'c2'])
  })

  it('totals 不受 limit 影响（截断前后完全相同）', () => {
    const rows = [
      ...chainOf('c1', 8, 3_600_000),
      ...chainOf('c2', 9, 600_000),
      ...chainOf('c3', 10, 60_000),
      row({ execution_log_id: 'o1', chain_id: null }),
    ]
    expect(build(rows, 1).totals).toEqual(build(rows, 20).totals)
    expect(build(rows, 1).totals.chains).toBe(3)
    expect(build(rows, 1).totals.orphanHops).toBe(1)
  })

  it('孤儿桶不受 limit 影响——limit 只截真链', () => {
    const rows = [
      ...chainOf('c1', 8, 3_600_000),
      ...chainOf('c2', 9, 600_000),
      row({ execution_log_id: 'o1', chain_id: null }),
      row({ execution_log_id: 'o2', chain_id: null }),
    ]
    const res = build(rows, 1)
    expect(res.chains).toHaveLength(1)
    expect(res.orphanChain.hopCount).toBe(2)
  })

  it('limit 为 0 ⇒ 不返回任何链，但 totals 仍是全窗口', () => {
    const rows = [...chainOf('c1', 8, 3_600_000), ...chainOf('c2', 9, 600_000)]
    const res = build(rows, 0)
    expect(res.chains).toEqual([])
    expect(res.totals.chains).toBe(2)
  })

  it('链内全是在飞跳（无 ended_at）⇒ spanMs null 且排最后，不参与跨度比较', () => {
    const rows = [
      ...chainOf('done', 8, 60_000),
      row({ execution_log_id: 'r1', chain_id: 'inflight', ended_at: null, status: 'running' }),
    ]
    const res = build(rows)
    expect(res.chains.map((c) => c.chainId)).toEqual(['done', 'inflight'])
    expect(res.chains[1].spanMs).toBeNull()
  })
})
