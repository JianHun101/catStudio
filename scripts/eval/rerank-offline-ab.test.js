/**
 * R13a 跑批侧的**纯函数**测试——不碰库、不碰模型、不起 sidecar。
 *
 * 被测面（都是「错了不会报错、只会给出错读数」的那类）：
 *   - `argmaxContributionIndex` 的配对趟（错了 ⇒ 拿别趟的查询去打分，分数看着正常）
 *   - `buildRerankPairs` 的断链检测（错了 ⇒ 回退到 q0，把断链伪装成正常读数）
 *   - `applyRerankScores` 的只改序不改成员（错了 ⇒ 重排偷偷增删片）
 *   - `injectedSections` 的序（错了 ⇒ 注入集顺序错位）
 *   - `judgeRerankNonDegenerate` 的退化检测（**承重**：S0 实测的 softmax-of-one 恒 1）
 *   - `judgeArmVerdict` 的判词优先级（错了 ⇒ 零增量被写成「等价但更省」的收益）
 *
 * 组装式（真实 DB + 真跑链段）不在此处——那是 `rerank-offline-ab.mjs` 主流程，
 * 由跑批本身 + 报告里的自证闸覆盖。
 */
import { describe, it, expect } from 'vitest'

import {
  ARM1_TOPK,
  ARM2_TOPK,
  ARM3_TOPK,
  RERANK_IRRELEVANT_MAX,
  RERANK_RELEVANT_MIN,
  applyRerankScores,
  argmaxContributionIndex,
  buildRerankPairs,
  injectedSections,
  judgeArmVerdict,
  judgeRerankNonDegenerate,
  parseArgs,
  quantile,
} from './rerank-offline-ab.mjs'

/** 造一条池内命中（只带本文件用得到的字段） */
const hit = (id, rrfScore, body = `body-${id}`) => ({
  row: { id, doc_path: `docs/${id}.md`, section_anchor: `节${id}`, body },
  rrfScore,
  vectorRank: 0,
  keywordRank: null,
  channel: 'vector',
})

/** 造一份 order 行 */
const row = (
  chunkId,
  {
    docPath = `docs/${chunkId}.md`,
    sectionAnchor = `节${chunkId}`,
    rrfScore = 0.1,
    bestIndex = 0,
  } = {}
) => ({
  chunkId,
  docPath,
  sectionAnchor,
  channel: 'vector',
  vectorRank: 0,
  keywordRank: null,
  queryIndex: 0,
  bestIndex,
  rrfScore,
})

describe('argmaxContributionIndex（配对趟）', () => {
  const pools = [
    { query: 'q0', hits: [hit(1, 0.01), hit(2, 0.05)] },
    { query: 'q1', hits: [hit(2, 0.03)] },
    { query: 'q2', hits: [hit(1, 0.09)] },
  ]

  it('只被一趟命中 ⇒ 就是那趟', () => {
    const pools2 = [
      { query: 'q0', hits: [hit(7, 0.02)] },
      { query: 'q1', hits: [] },
    ]
    expect(argmaxContributionIndex({ pools: pools2, chunkId: 7 })).toBe(0)
  })

  it('多趟命中 ⇒ 取贡献 rrfScore 最大的那趟（不是首趟）', () => {
    // 片 1：q0 给 0.01、q2 给 0.09 ⇒ 贡献趟 = 2（**首趟是 0**，这是本函数存在的全部理由）
    expect(argmaxContributionIndex({ pools, chunkId: 1 })).toBe(2)
    // 片 2：q0 给 0.05、q1 给 0.03 ⇒ 贡献趟 = 0
    expect(argmaxContributionIndex({ pools, chunkId: 2 })).toBe(0)
  })

  it('并列 ⇒ 取更早的趟（同输入两次跑批必须给同一配对）', () => {
    const tie = [
      { query: 'q0', hits: [hit(9, 0.04)] },
      { query: 'q1', hits: [hit(9, 0.04)] },
    ]
    expect(argmaxContributionIndex({ pools: tie, chunkId: 9 })).toBe(0)
  })

  it('不在任何池里 ⇒ -1（显式哨兵，不编一个 0 出来）', () => {
    expect(argmaxContributionIndex({ pools, chunkId: 999 })).toBe(-1)
  })
})

describe('buildRerankPairs（断链检测）', () => {
  const pools = [
    { query: '原话', hits: [hit(1, 0.05)] },
    { query: '改写一', hits: [hit(2, 0.07)] },
  ]
  const bodies = new Map([
    [1, '正文一'],
    [2, '正文二'],
  ])
  const bodyOf = (id) => bodies.get(id)

  it('query 取自**配对趟**、passage 取自池内行 body', () => {
    const pairs = buildRerankPairs({ order: [row(1), row(2)], pools, bodyOf })
    expect(pairs).toEqual([
      { chunkId: 1, queryIndex: 0, query: '原话', passage: '正文一' },
      { chunkId: 2, queryIndex: 1, query: '改写一', passage: '正文二' },
    ])
  })

  it('全序里的片不在任何池里 ⇒ **抛错**（不回退 q0——那会把断链伪装成正常读数）', () => {
    expect(() => buildRerankPairs({ order: [row(404)], pools, bodyOf })).toThrow(/重建链断/)
  })

  it('正文取不到（bodyOf 回非字符串）⇒ 抛错，不静默送空串去打分', () => {
    expect(() => buildRerankPairs({ order: [row(1)], pools, bodyOf: () => undefined })).toThrow(
      /正文取不到/
    )
  })
})

describe('applyRerankScores（只改序、不改成员）', () => {
  const order = [row(1, { rrfScore: 0.3 }), row(2, { rrfScore: 0.2 }), row(3, { rrfScore: 0.1 })]
  const pairs = [1, 2, 3].map((chunkId) => ({ chunkId, queryIndex: 0, query: 'q', passage: 'p' }))

  it('按重排分降序，并带上分数与配对趟', () => {
    const out = applyRerankScores({ order, pairs, scores: [0.1, 0.9, 0.5] })
    expect(out.map((r) => r.chunkId)).toEqual([2, 3, 1])
    expect(out.map((r) => r.rerankScore)).toEqual([0.9, 0.5, 0.1])
    expect(out.every((r) => r.rerankQueryIndex === 0)).toBe(true)
  })

  it('同分 ⇒ 回退 RRF 序（不依赖 Array.sort 的隐式稳定性）', () => {
    const out = applyRerankScores({ order, pairs, scores: [0.5, 0.5, 0.5] })
    expect(out.map((r) => r.chunkId)).toEqual([1, 2, 3])
  })

  it('同分同 RRF ⇒ 再回退 bestIndex，最后回退原序下标（判据全并列时仍确定）', () => {
    const flat = [row(1, { rrfScore: 0.2, bestIndex: 5 }), row(2, { rrfScore: 0.2, bestIndex: 1 })]
    const p2 = flat.map((r) => ({ chunkId: r.chunkId, queryIndex: 0, query: 'q', passage: 'p' }))
    const out = applyRerankScores({ order: flat, pairs: p2, scores: [0.5, 0.5] })
    expect(out.map((r) => r.chunkId)).toEqual([2, 1])
  })

  it('成员集逐 id 不变（长度 / 唯一性 / 归属全查）', () => {
    const out = applyRerankScores({ order, pairs, scores: [0.1, 0.2, 0.3] })
    expect(out).toHaveLength(3)
    expect(new Set(out.map((r) => r.chunkId))).toEqual(new Set([1, 2, 3]))
  })

  it('分数条数 ≠ 全序 ⇒ 抛错（不给错位的名次）', () => {
    expect(() => applyRerankScores({ order, pairs, scores: [0.1, 0.2] })).toThrow(/≠ 全序/)
  })

  it('配对数 ≠ 全序 ⇒ 抛错', () => {
    expect(() =>
      applyRerankScores({ order, pairs: pairs.slice(0, 2), scores: [0.1, 0.2, 0.3] })
    ).toThrow(/配对数/)
  })

  it('全序里有重复 chunkId ⇒ 抛错（按 id 回填会错位）', () => {
    const dup = [row(1), row(1)]
    const p2 = dup.map(() => ({ chunkId: 1, queryIndex: 0, query: 'q', passage: 'p' }))
    expect(() => applyRerankScores({ order: dup, pairs: p2, scores: [0.1, 0.2] })).toThrow(
      /重复 chunkId/
    )
  })
})

describe('injectedSections（注入集的节列表）', () => {
  it('走 order 序而不是 Set 插入序，同节多片只出一节', () => {
    const order = [
      row(1, { docPath: 'a', sectionAnchor: 's1' }),
      row(2, { docPath: 'a', sectionAnchor: 's1' }),
      row(3, { docPath: 'b', sectionAnchor: 's2' }),
    ]
    const secs = injectedSections({ order, injectedIds: new Set([1, 3]) })
    expect(secs).toEqual([
      { docPath: 'a', sectionAnchor: 's1' },
      { docPath: 'b', sectionAnchor: 's2' },
    ])
  })

  it('空注入集 ⇒ 空列表（不是 undefined）', () => {
    expect(injectedSections({ order: [row(1)], injectedIds: new Set() })).toEqual([])
  })
})

describe('judgeRerankNonDegenerate（A5 非退化断言，承重）', () => {
  it('可分且不等 ⇒ 过', () => {
    expect(judgeRerankNonDegenerate({ relevant: 0.9979, irrelevant: 0.0000889 }).ok).toBe(true)
  })

  it('**两者相等 ⇒ constant 红**（S0 的 softmax-of-one 恒 1 正是这个形状）', () => {
    const v = judgeRerankNonDegenerate({ relevant: 1, irrelevant: 1 })
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('constant')
    // 恒 0 同判：退化可以不只往 1 退化
    expect(judgeRerankNonDegenerate({ relevant: 0, irrelevant: 0 }).reason).toBe('constant')
  })

  it('不等但**不可分**（都 > 0.5）⇒ not-separated 红', () => {
    const v = judgeRerankNonDegenerate({ relevant: 0.9, irrelevant: 0.8 })
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('not-separated')
  })

  it('恰好落在阈值上 ⇒ 红（0.5 是分界本身，不是「相关」）', () => {
    expect(judgeRerankNonDegenerate({ relevant: RERANK_RELEVANT_MIN, irrelevant: 0.1 }).ok).toBe(
      false
    )
    expect(judgeRerankNonDegenerate({ relevant: 0.9, irrelevant: RERANK_IRRELEVANT_MAX }).ok).toBe(
      false
    )
  })

  it('非数值 ⇒ not-number（不把 undefined 当 0 判）', () => {
    expect(judgeRerankNonDegenerate({ relevant: undefined, irrelevant: 0.1 }).reason).toBe(
      'not-number'
    )
    expect(judgeRerankNonDegenerate({ relevant: NaN, irrelevant: 0.1 }).reason).toBe('not-number')
  })
})

describe('judgeArmVerdict（判词优先级）', () => {
  it('臂③ > 臂② ⇒ 有效', () => {
    expect(judgeArmVerdict({ arm1Hit: 0, arm2Hit: 3, arm3Hit: 5 }).verdict).toBe('effective')
  })

  it('臂③ = 臂② > 臂① ⇒ 等价但更省注入', () => {
    expect(judgeArmVerdict({ arm1Hit: 0, arm2Hit: 5, arm3Hit: 5 }).verdict).toBe(
      'equivalent-but-cheaper'
    )
  })

  it('**臂③ = 臂② = 臂① ⇒ 关票**（不能判成「等价但更省」——那是把零增量写成收益）', () => {
    expect(judgeArmVerdict({ arm1Hit: 0, arm2Hit: 0, arm3Hit: 0 }).verdict).toBe('close-ticket')
  })

  it('臂③ = 臂① < 臂② ⇒ 关票（即便「≈ 臂②」不成立，也不能算有效）', () => {
    expect(judgeArmVerdict({ arm1Hit: 4, arm2Hit: 9, arm3Hit: 4 }).verdict).toBe('close-ticket')
  })

  it('臂① < 臂③ < 臂② ⇒ 关票（不如一行配置）', () => {
    expect(judgeArmVerdict({ arm1Hit: 2, arm2Hit: 9, arm3Hit: 5 }).verdict).toBe('close-ticket')
  })

  it('臂③ < 臂① ⇒ 关票', () => {
    expect(judgeArmVerdict({ arm1Hit: 9, arm2Hit: 9, arm3Hit: 3 }).verdict).toBe('close-ticket')
  })

  it('臂③ > 臂② > 臂① ⇒ 有效（增量方向对就得判有效，不论幅度）', () => {
    expect(judgeArmVerdict({ arm1Hit: 1, arm2Hit: 2, arm3Hit: 3 }).verdict).toBe('effective')
  })
})

describe('quantile（最近秩法）', () => {
  it('空数组 ⇒ null（「没测」不是「测到 0」）', () => {
    expect(quantile([], 0.5)).toBeNull()
  })

  it('单元素 ⇒ 它自己', () => {
    expect(quantile([7], 0.5)).toBe(7)
    expect(quantile([7], 0.95)).toBe(7)
  })

  it('不插值：p50 / p95 取最近的实读值', () => {
    const v = [10, 20, 30, 40, 50]
    expect(quantile(v, 0.5)).toBe(30)
    expect(quantile(v, 0.95)).toBe(50)
    expect(quantile(v, 1)).toBe(50)
  })

  it('乱序输入先排序（不假设调用方给的是有序的）', () => {
    expect(quantile([50, 10, 30], 0.5)).toBe(30)
  })
})

describe('parseArgs', () => {
  it('默认不跑量化交叉核对（诊断面默认关）', () => {
    expect(parseArgs([]).quantCrosscheck).toBe(false)
  })

  it('--quant-crosscheck 才开', () => {
    expect(parseArgs(['--quant-crosscheck']).quantCrosscheck).toBe(true)
  })

  it('三臂 topK 契约值钉死（臂① 现状 / 臂② 一行配置 / 臂③ 同现状注入量）', () => {
    expect([ARM1_TOPK, ARM2_TOPK, ARM3_TOPK]).toEqual([3, 5, 3])
  })
})
