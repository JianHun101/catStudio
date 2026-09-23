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
 *   - `computeDegradation` 的「新增」口径（错了 ⇒ 降级率虚高 9 倍，把覆盖率读数读反）
 *   - `renderReport` 与 `--quant-crosscheck` 的**解耦**（错了 ⇒ A4 双跑被迫都带上 7.5 分钟的交叉核对）
 *   - `renderLatencyReport` 的交叉核对**证据迁移**标注（错了 ⇒ 替代解释看着像关了其实没关）
 *
 * 组装式（真实 DB + 真跑链段）不在此处——那是 `rerank-offline-ab.mjs` 主流程，
 * 由跑批本身 + 报告里的自证闸覆盖。
 */
import { describe, it, expect } from 'vitest'

import {
  ARM1_TOPK,
  ARM2_TOPK,
  ARM3_TOPK,
  QUANT_CROSSCHECK_EVIDENCE,
  RERANK_IRRELEVANT_MAX,
  RERANK_RELEVANT_MIN,
  applyRerankScores,
  argmaxContributionIndex,
  buildRerankPairs,
  computeDegradation,
  injectedSections,
  judgeArmVerdict,
  judgeRerankNonDegenerate,
  parseArgs,
  quantile,
  renderLatencyReport,
  renderReport,
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

  // 假话源守卫：票面 §二 那句「结论写瓶颈在池的成员，不在序」**已被实测证伪**
  // （重排确实在动序、且救回过锚点，见报告 §一 订正块）。判词不许再复述它——
  // 复述面一旦留旧句，归档 json 是会被 grep 的面，读的人会当结论采信。
  it('close-ticket 的判词**不复述**已作废的「瓶颈在池的成员，不在序」', () => {
    for (const c of [
      { arm1Hit: 9, arm2Hit: 9, arm3Hit: 3 }, // 臂③ < 臂①
      { arm1Hit: 4, arm2Hit: 9, arm3Hit: 4 }, // 臂③ = 臂①
      { arm1Hit: 0, arm2Hit: 0, arm3Hit: 0 }, // 全等
      { arm1Hit: 2, arm2Hit: 9, arm3Hit: 5 }, // 夹在中间（第四个分支）
    ]) {
      const v = judgeArmVerdict(c)
      expect(v.verdict).toBe('close-ticket')
      // 守卫：**任何** close-ticket 变体都不许复述那句已被实测证伪的预置结论
      expect(v.message).not.toContain('瓶颈在池的成员')
    }
    // 臂③ ≤ 臂① 那一支（被预置句直接覆盖的情形）额外要把「不是序无用」点出来
    expect(judgeArmVerdict({ arm1Hit: 0, arm2Hit: 0, arm3Hit: 0 }).message).toContain('不是')
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

describe('computeDegradation（A3 ③ 的「新增」口径）', () => {
  const row = (reason, ms) => ({ reason, ms })

  it('本来就闸外的行不计入「新增」（9 vs 真值 1 的那条）', () => {
    const live = [
      row('ok', 9836), // 加 1319ms ⇒ 11155，翻线
      row('ok', 5240), // 加 1319ms ⇒ 6559，不翻
      row('timeout', 12000), // 本来就闸外
    ]
    const d = computeDegradation(live, 1319, 10000)
    expect(d.overAfter).toBe(2) // 闸外总数：2（含本来就闸外的那条）
    expect(d.alreadyOver).toBe(1)
    expect(d.added).toBe(1) // 「新增」只数翻线的那条
    expect(d.rate).toBe('1/3')
  })

  it('先剔再算 ≠ overAfter − alreadyOver（后者靠数据现状成立）', () => {
    // 构造一条「reason=timeout 但 ms < 闸值」的行（被中止的执行）。
    // 减法则会把它当成「本来就闸外」从分子里减掉 ⇒ 漏报一条真翻线。
    const live = [row('timeout', 500), row('ok', 9900)]
    const d = computeDegradation(live, 200, 10000)
    expect(d.overAfter).toBe(1)
    expect(d.added).toBe(1) // 减法会给 max(0, 1-1) = 0
  })

  it('恰好等于闸值算过闸（>= 不是 >）', () => {
    expect(computeDegradation([row('ok', 9000)], 1000, 10000).added).toBe(1)
    expect(computeDegradation([row('ok', 8999)], 1000, 10000).added).toBe(0)
  })

  it('空输入给 0/0，不抛也不编分母', () => {
    expect(computeDegradation([], 1319, 10000)).toEqual({
      denom: 0,
      alreadyOver: 0,
      overAfter: 0,
      added: 0,
      rate: '0/0',
    })
  })
})

/** 一份最小可渲染 ctx（只带 `renderReport` 真读的字段）——两个 describe 共用 */
const detCtx = (extra = {}) => ({
  date: '2026-09-22',
  dbPath: 'D:\\x\\snap.db',
  goldenVersion: 1,
  params: {
    maxDistance: 0.6,
    liveTopK: 5,
    liveTopKRows: [{ k: 5, n: 119, fromAt: 'a', toAt: 'b' }],
  },
  arms: [
    {
      label: '①',
      how: 'RRF',
      meanInjectedSections: 3,
      hit: 27,
      expectTotal: 35,
      recallMean: 0.77,
      microRecall: 0.77,
      negativeFlagged: 4,
      negativeTotal: 5,
      negativeIds: [],
    },
    {
      label: '②',
      how: 'RRF',
      meanInjectedSections: 5,
      hit: 29,
      expectTotal: 35,
      recallMean: 0.82,
      microRecall: 0.82,
      negativeFlagged: 5,
      negativeTotal: 5,
      negativeIds: [],
    },
    {
      label: '③',
      how: 'rerank',
      meanInjectedSections: 3,
      hit: 23,
      expectTotal: 35,
      recallMean: 0.65,
      microRecall: 0.65,
      negativeFlagged: 4,
      negativeTotal: 5,
      negativeIds: [],
    },
  ],
  anchors: [],
  canary: [{ id: 'CANARY-HIT', ok: true }],
  rerankSelfCheck: { ok: true, reason: '', relevant: 0.98, irrelevant: 0.02 },
  mergeCheck: { ok: true, mismatches: [], rows: 200, entries: 40 },
  latency: { perPairMs: 34.719 },
  verdict: { verdict: 'close-ticket', message: '据实关票' },
  flips: { arm1ToArm3: [], arm2ToArm3: [] },
  ...extra,
})

describe('renderReport —— 确定性面与 --quant-crosscheck 解耦（A4 的构造保证）', () => {
  it('带 / 不带 quantCrosscheck，renderReport 输出**逐字节相同**', () => {
    // 承重：det 面（md + json）是 A4 的 sha256 比对对象。**只要它读了一个「跑批时带不带 flag」
    // 才有的字段，A4 双跑就必须两次都带上那个 flag**——而交叉核对单遍 ≈7.5 分钟，双跑装不进一轮。
    // 这条测试钉的是**构造**（不是「跑两遍比 sha」的运气）：解耦失效当场红。
    const qc = {
      model: 'Xenova/bge-reranker-base',
      refDtype: 'fp32',
      hitQ8: 23,
      hitRef: 24,
      hitDelta: 1,
      top3SameEntries: 25,
      argmaxSameEntries: 30,
      entries: 40,
      maxAbsScoreDelta: 0.38,
      note: 'n',
    }
    expect(renderReport(detCtx({ quantCrosscheck: qc }))).toBe(renderReport(detCtx()))
  })

  it('计时数字**不得进 det 面**：只改 latency.perPairMs，renderReport 输出逐字节不变', () => {
    // 承重（本轮实测踩到）：det md 里塞一个耗时数字 ⇒ 两次跑批的 md 必然不等（负载档一变就变）
    // ⇒ **A4（两遍 sha256 全等）当场变成恒不可满足的假门**。且失败形态是「有时过有时不过」，
    // 正是本仓点名的「偶发假红的假门」。计时数字只许落在计时面。
    const a = renderReport(detCtx({ latency: { perPairMs: 34.719 } }))
    const b = renderReport(detCtx({ latency: { perPairMs: 249.513 } }))
    expect(a).toBe(b)
    expect(a).not.toContain('249.513')
    expect(a).toContain('latency.md')
  })

  it('§七.2 指向 latency.md，不再自渲染交叉核对读数（防复述面分叉）', () => {
    const md = renderReport(detCtx())
    expect(md).toContain('量化（q8）已交叉核对')
    expect(md).toContain('latency.md')
    expect(md).toContain('不得读作本批实测')
    // 本批读数不许出现在 det 面（出现即意味着 det 面又开始依赖 flag）
    expect(md).not.toContain('top-3 节集全同')
  })
})

describe('renderLatencyReport —— 交叉核对证据迁移', () => {
  const base = {
    date: '2026-09-22',
    dbPath: 'D:\\x\\snap.db',
    arms: [{ hit: 27 }, { hit: 29 }, { hit: 23 }],
    latency: {
      rerankP50: 1,
      rerankP95: 2,
      rerankMax: 3,
      perPairMs: 34.719,
      meanPairsPerEntry: 37.98,
      retrievalP50: 31,
      totalP50: 4,
      totalP95: 5,
      thresholdMs: 10000,
      overGateInGolden: 0,
      headroomMs: 164,
      degradation: [
        { face: 'golden', denom: 40, added: 0, rate: '0/40', overAfter: 0, alreadyOver: 0 },
        { face: 'live', denom: 846, added: 1, rate: '1/846', overAfter: 1, alreadyOver: 0 },
      ],
      timeoutBaseline: {
        denom: 846,
        timeout: 8,
        rate: '8/846',
        pct: 0.945,
        denomAllReasons: 933,
        pctAllReasons: 0.859,
        slowestNonTimeout: 9836,
      },
    },
    timings: [],
  }

  it('未跑交叉核对时也渲染证据块，且**明标「证据迁移」+ 批次 sha**', () => {
    // 承重：没有这块，「量化造出了『重排无效』」这条替代解释就**没有关闭证据**却会被读成已关。
    const md = renderLatencyReport(base)
    expect(md).toContain(QUANT_CROSSCHECK_EVIDENCE.batchSha)
    expect(md).toContain('证据迁移')
    expect(md).toContain('非本批实测')
    expect(md).toContain(`| ${QUANT_CROSSCHECK_EVIDENCE.hitQ8} |`)
    expect(md).toContain(`| ${QUANT_CROSSCHECK_EVIDENCE.hitRef} |`)
  })

  it('证据读数 + 本批臂① ⇒ 判词比对写进产物（证据批次的旧臂① 不作分母）', () => {
    const md = renderLatencyReport(base)
    expect(md).toMatch(/判词比对（分母用\*\*本批\*\* 臂① 27/)
  })

  it('latency md 头带实测时刻，且点名 --date 不是时刻（不让实验身份名替读数计时）', () => {
    const md = renderLatencyReport(base)
    expect(md).toMatch(/实测时刻：\*\*\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}\*\*/)
    expect(md).toContain('不是本文件的生成时刻')
  })

  it('§一 同时给 per-pair 与检索段 p50（重排前），并列出两个负载档', () => {
    const md = renderLatencyReport(base)
    expect(md).toContain('检索段 p50（**重排前**）**31 ms**')
    expect(md).toContain('轻载')
    expect(md).toContain('重载')
    expect(md).toContain('检索段里没有重排')
  })

  it('latency md 含时刻 ⇒ 它**只能**是不可复现面（不进 A4 的那份）', () => {
    // 反向锁：有人把 localStamp 挪进 renderReport，这条与上面那条「逐字节相同」会一起红。
    expect(renderLatencyReport(base)).toMatch(/实测时刻：/)
    expect(renderReport(detCtx())).not.toMatch(/实测时刻：/)
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
