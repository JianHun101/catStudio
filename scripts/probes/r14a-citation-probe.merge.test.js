import { describe, expect, it } from 'vitest'

import { SHARD_PROVIDERS, mergeShards, shardFile } from './r14a-citation-probe.merge.mjs'

/** 造一条最小可被 summarize 消费的 run（字段口径与探针 answerOne 一致）。 */
function run(provider, variant, qid, flags = {}) {
  return {
    provider,
    variant,
    questionId: qid,
    status: flags.status ?? 'ok',
    correct: flags.correct ?? false,
    wrongNumber: flags.wrongNumber ?? false,
    phantom: flags.phantom ?? false,
    notMarked: flags.notMarked ?? true,
  }
}

/** 造一个分片产物。`summary` 故意写成垃圾——用来证明合并产物是**重算**而非手抄。 */
function shard(provider, runs, { n = 5, variants = ['jia'] } = {}) {
  return {
    provider,
    file: shardFile('2026-09-23', provider),
    report: {
      ok: true,
      mode: 's2',
      n,
      variants,
      instructions: { jia: '甲版指示语' },
      questionSet: [{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }],
      providers: [{ provider, agent: `${provider}猫`, model: 'm' }],
      runs,
      summary: { 手抄的垃圾: { n: 999 } },
    },
  }
}

describe('mergeShards —— runs 拼接', () => {
  it('按 SHARD_PROVIDERS 固定序拼接，不随传入序变化', () => {
    // 故意乱序传入
    const merged = mergeShards([
      shard('ollama', [run('ollama', 'jia', 'q1')]),
      shard('claude', [run('claude', 'jia', 'q1')]),
      shard('dsh', [run('dsh', 'jia', 'q1')]),
    ])
    expect(merged.runs.map((r) => r.provider)).toEqual(['claude', 'dsh', 'ollama'])
  })

  it('未知 provider 的片不丢，追加在固定序之后', () => {
    const merged = mergeShards([
      shard('claude', [run('claude', 'jia', 'q1')]),
      shard('newcat', [run('newcat', 'jia', 'q1')]),
    ])
    expect(merged.runs.map((r) => r.provider)).toEqual(['claude', 'newcat'])
  })
})

describe('mergeShards —— summary 重算（票面 §八.8 禁止手抄）', () => {
  it('summary 由 runs 重算，分片自带的假 summary 不被采信', () => {
    const merged = mergeShards([
      shard('claude', [
        run('claude', 'jia', 'q1', { correct: true, notMarked: false }),
        run('claude', 'jia', 'q2', { notMarked: true }),
      ]),
      shard('dsh', [
        run('dsh', 'jia', 'q1', { correct: true, notMarked: false }),
        run('dsh', 'jia', 'q2', { phantom: true, notMarked: false }),
      ]),
    ])
    // 手抄垃圾键不存在
    expect(merged.summary['手抄的垃圾']).toBeUndefined()
    // 逐格计数 = 真值
    expect(merged.summary['claude|jia']).toMatchObject({ n: 2, correct: 1, notMarked: 1 })
    expect(merged.summary['dsh|jia']).toMatchObject({ n: 2, correct: 1, phantom: 1 })
    // 总量对得上（重算的充分条件：n 之和 = runs 长度）
    const totalN = Object.values(merged.summary).reduce((a, c) => a + c.n, 0)
    expect(totalN).toBe(merged.runs.length)
  })

  it('status 分列（非 ok 的形态各占一列，不并进 ok）', () => {
    const merged = mergeShards([
      shard('claude', [
        run('claude', 'jia', 'q1', { status: 'shape-mismatch' }),
        run('claude', 'jia', 'q2', { status: 'empty-reply' }),
        run('claude', 'jia', 'q3', { status: 'no-chunks' }),
      ]),
    ])
    const c = merged.summary['claude|jia']
    expect(c).toMatchObject({ n: 3, ok: 0, shapeMismatch: 1, emptyReply: 1, noChunks: 1 })
  })
})

describe('mergeShards —— 缺片：显式「未测」，不顶替、不静默（票面 §八.8）', () => {
  it('缺片记 present:false + 原因，分母只数跑满的片', () => {
    const merged = mergeShards([
      shard('claude', [run('claude', 'jia', 'q1')]),
      { provider: 'dsh', file: 'x', report: null, reason: '本地模型超时' },
      { provider: 'ollama', file: 'y', report: null },
    ])
    expect(merged.providersTested).toBe(1)
    expect(merged.providersExpected).toBe(3)
    const dsh = merged.shards.find((s) => s.provider === 'dsh')
    expect(dsh).toMatchObject({ present: false, runs: 0, reason: '本地模型超时' })
    // 无原因也不静默：留确定性占位，不留 null/空串
    expect(merged.shards.find((s) => s.provider === 'ollama').reason).toBe('未提供原因')
    // 缺片的 provider 不进 providers 名单（不得用别的 provider 顶替）
    expect(merged.providers.map((p) => p.provider)).toEqual(['claude'])
  })
})

describe('mergeShards —— 拒绝悄悄改 N / 空输入', () => {
  it('分片 N 不一致时抛错（票面 §八.8：不得悄悄改 N）', () => {
    expect(() =>
      mergeShards([
        shard('claude', [run('claude', 'jia', 'q1')], { n: 5 }),
        shard('dsh', [run('dsh', 'jia', 'q1')], { n: 3 }),
      ])
    ).toThrow(/N 不一致/)
  })

  it('variants 不一致时抛错', () => {
    expect(() =>
      mergeShards([
        shard('claude', [run('claude', 'jia', 'q1')], { variants: ['jia'] }),
        shard('dsh', [run('dsh', 'jia', 'q1')], { variants: ['yi'] }),
      ])
    ).toThrow(/variants 不一致/)
  })

  it('无任何分片产物时抛错，不产出空壳合并件', () => {
    expect(() => mergeShards([{ provider: 'claude', report: null }])).toThrow(/无任何分片/)
  })
})

describe('shardFile —— 命名约定（票面 §八.8 点名的路径）', () => {
  it('按 <date>-s2-<provider>.json 生成', () => {
    expect(shardFile('2026-09-23', 'claude')).toBe(
      'docs/eval/r14a-citation-probe-2026-09-23-s2-claude.json'
    )
  })

  it('SHARD_PROVIDERS 覆盖花名册四家', () => {
    expect([...SHARD_PROVIDERS].sort()).toEqual(['claude', 'dsh', 'ollama', 'opencode'])
  })
})
