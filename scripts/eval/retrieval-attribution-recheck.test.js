/**
 * T3 未召回归因复核测试。
 *
 * 测试面分两层（与 `retrieval-baseline.test.js` 同款分法）：
 *   - **纯单元**：融合 / 跨查询合并重建 / 自证 / 锚点读数 / 反对照判据 / FTS 词项分类，
 *     全部喂手搓对象——不碰库、不碰嵌入、不起 sidecar；
 *   - **契约静态断言**：本脚本读**链段结果对象的字段名**（`sections[].docPath`、
 *     `candidates[].source/finalRank/rrfScore/chunkId`）。这些名字是 `.mjs` 侧看不见的
 *     接缝——`memory/index.ts` 一旦改名，重建自证会**当场变红**（好），但
 *     `renderDiagnosis` 里读 `result.sections` 的那些地方会**静默读空**（坏）。
 *     故这里直接读 `memory/index.ts` 源码断言字段名仍在。
 *
 * **不测什么**：真库 + 真 sidecar 那条端到端链（要 410 chunk 的实验库与一个冷启动
 * 嵌入 sidecar）——属「系统级 e2e，手动跑」那一档，跑批读数记录在
 * `docs/run/eval-system/T3-retrieval-optimization-diagnosis.md`，不在这里假装绿。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  DIAG_REPORT_SCHEMA,
  REPORT_0920_MISSES,
  TOPK_SWEEP,
  REPO_ROOT,
  fuseChannelHits,
  verifyFuseEquivalence,
  judgeFuseSelfCheck,
  judgeMergeSelfCheck,
  mergeQueryPools,
  verifyMerge,
  readAnchor,
  summarizeProductionFace,
  splitFtsTerms,
  probeFtsTerms,
  judgeThresholdCounterControl,
  judgeKillZoneExistence,
  parseArgs,
} from './retrieval-attribution-recheck.mjs'

// ─── 手搓夹具 ─────────────────────────────────────────

/** 一个融合命中行（形状对齐库层 `ChunkHybridHit`） */
function hit(id, { rrfScore = 0, vectorRank = null, keywordRank = null, channel = 'vector' } = {}) {
  return {
    row: { id, doc_path: `docs/x${id}.md`, section_anchor: `S${id}`, distance: 0.3 },
    rrfScore,
    vectorRank,
    keywordRank,
    channel,
  }
}

/** 一个池（跨查询合并的输入单元） */
function pool(...hits) {
  return { query: 'q', hits }
}

/** 一个链段落下来的 final 流水行 */
function finalTrace(chunkId, finalRank, rrfScore) {
  return {
    source: 'final',
    chunkId,
    finalRank,
    rrfScore,
    docPath: `docs/x${chunkId}.md`,
    sectionAnchor: `S${chunkId}`,
  }
}

// ─── splitFtsTerms：引号解析（**本脚本踩过的真 bug**） ──

describe('splitFtsTerms — 按引号解析，不按空格切', () => {
  it('常规表达式逐词项拆开', () => {
    expect(splitFtsTerms('"票己" "己以"')).toEqual(['票己', '己以'])
  })

  it('含空白的 bigram **不被劈开**（按空格切会把它拆成两个，于是「跨词边界」这一类永远统计不到）', () => {
    // `buildFtsQuery('seed data')` 会产出 `"d "` 与 `" d"` 这两个含空白的词项
    const expr = '"se" "d " " d" "da"'
    expect(splitFtsTerms(expr)).toEqual(['se', 'd ', ' d', 'da'])
    // 负对照：朴素 split(' ') 会得到 6 段且没有一段含空白——这正是首版 `anySpacedTerm` 恒为 0 的成因
    expect(expr.split(' ').length).toBeGreaterThan(splitFtsTerms(expr).length)
  })

  it('空表达式 / null ⇒ 空数组（调用方零分支）', () => {
    expect(splitFtsTerms(null)).toEqual([])
    expect(splitFtsTerms('')).toEqual([])
  })

  it('空词项（`""`）跳过，不产出空串', () => {
    expect(splitFtsTerms('"" "甲"')).toEqual(['甲'])
  })
})

// ─── probeFtsTerms：三类分解 + 反事实 ─────────────────

describe('probeFtsTerms — 可命中 / 语料外 / 跨词边界 三分类', () => {
  const countTerm = (t) => ({ 甲: 3, 乙: 0, '丙 ': 5, 丁: 0 })[t] ?? 0

  it('含空白的词项落 `spaced`，**不落** `absent`（两者药方不同：一个是索引形态、一个是补语料）', () => {
    const r = probeFtsTerms({ matchExpr: '"甲" "丙 "', countTerm })
    expect(r.spaced).toEqual(['丙 '])
    expect(r.absent).toEqual([])
    expect(r.usable).toEqual(['甲'])
  })

  it('语料外词项落 `absent`；可用词项收进 `usable`', () => {
    const r = probeFtsTerms({ matchExpr: '"甲" "乙"', countTerm })
    expect(r.absent).toEqual(['乙'])
    expect(r.usable).toEqual(['甲'])
    expect(r.present.map((p) => p.term)).toEqual(['甲'])
  })

  it('`usableMatchExpr` 只用可用词项重拼（反事实探针的输入）', () => {
    const r = probeFtsTerms({ matchExpr: '"甲" "乙" "丙 "', countTerm })
    expect(r.usableMatchExpr).toBe('"甲"')
  })

  it('全部词项都不可用 ⇒ usableMatchExpr = null（不产出一个空 MATCH 去撞 FTS 语法错）', () => {
    const r = probeFtsTerms({ matchExpr: '"乙" "丙 "', countTerm })
    expect(r.usableMatchExpr).toBe(null)
    expect(r.usableHits).toBe(null)
  })

  it('`hitsOf` 注入时才给反事实命中数（纯函数不持 db —— 不注入就是 null，不是 0）', () => {
    const noProbe = probeFtsTerms({ matchExpr: '"甲"', countTerm })
    expect(noProbe.usableHits).toBe(null)
    const probed = probeFtsTerms({
      matchExpr: '"甲"',
      countTerm,
      hitsOf: (e) => (e === '"甲"' ? 7 : -1),
    })
    expect(probed.usableHits).toBe(7)
  })
})

// ─── fuseChannelHits：库层融合公式的镜像 ──────────────

describe('fuseChannelHits — 与 chunks.ts::searchChunksHybrid 同一条公式', () => {
  const rows = (ids) =>
    ids.map((id) => ({ id, doc_path: `docs/x${id}.md`, section_anchor: `S${id}`, distance: 0.3 }))

  it('RRF 分 = 1/(k + 名次 + 1)，名次 0 起', () => {
    const out = fuseChannelHits({
      vectorHits: rows([1, 2]),
      keywordHits: [],
      rrfK: 60,
      poolPerQuery: 20,
      maxDistance: 0.6,
    })
    expect(out[0].rrfScore).toBeCloseTo(1 / 61, 12)
    expect(out[1].rrfScore).toBeCloseTo(1 / 62, 12)
  })

  it('双通道命中 ⇒ 分**相加**、channel=both、两位次都留', () => {
    const out = fuseChannelHits({
      vectorHits: rows([1]),
      keywordHits: rows([1]),
      rrfK: 60,
      poolPerQuery: 20,
      maxDistance: 0.6,
    })
    expect(out).toHaveLength(1)
    expect(out[0].rrfScore).toBeCloseTo(1 / 61 + 1 / 61, 12)
    expect(out[0].channel).toBe('both')
    expect(out[0].vectorRank).toBe(0)
    expect(out[0].keywordRank).toBe(0)
  })

  it('纯关键词命中 ⇒ channel=keyword、distance 记 maxDistance 哨兵（与库层同款，**不是**真距离）', () => {
    const out = fuseChannelHits({
      vectorHits: [],
      keywordHits: rows([9]),
      rrfK: 60,
      poolPerQuery: 20,
      maxDistance: 0.6,
    })
    expect(out[0].channel).toBe('keyword')
    expect(out[0].row.distance).toBe(0.6)
    expect(out[0].vectorRank).toBe(null)
  })

  it('出口按 `poolPerQuery` 截断（**不是**调用方以为的 topK）', () => {
    const out = fuseChannelHits({
      vectorHits: rows([1, 2, 3, 4, 5]),
      keywordHits: [],
      rrfK: 60,
      poolPerQuery: 3,
      maxDistance: 0.6,
    })
    expect(out.map((h) => h.row.id)).toEqual([1, 2, 3])
  })

  it('k 越小 ⇒ 榜首权重越集中（同名次序下分的相对差距变大）', () => {
    const build = (k) =>
      fuseChannelHits({
        vectorHits: rows([1, 2]),
        keywordHits: [],
        rrfK: k,
        poolPerQuery: 20,
        maxDistance: 0.6,
      })
    const wide = build(60)
    const narrow = build(10)
    const gap = (o) => o[0].rrfScore - o[1].rrfScore
    expect(gap(narrow)).toBeGreaterThan(gap(wide))
  })
})

describe('verifyFuseEquivalence — 重建 vs 库层的逐行等价自证', () => {
  const a = hit(1, { rrfScore: 0.1, vectorRank: 0, channel: 'vector' })
  const b = hit(2, { rrfScore: 0.05, vectorRank: 1, channel: 'vector' })

  it('逐行相等（顺序 / 分 / 通道身份）⇒ ok', () => {
    expect(verifyFuseEquivalence({ built: [a, b], native: [a, b] }).ok).toBe(true)
  })

  it('顺序不同 ⇒ 红（只比集合会漏掉这一类）', () => {
    const r = verifyFuseEquivalence({ built: [b, a], native: [a, b] })
    expect(r.ok).toBe(false)
    expect(r.mismatches[0].kind).toBe('order')
  })

  it('条数不同 ⇒ 红且立即返回（不再逐行比——长度不等的逐行比全是噪声）', () => {
    const r = verifyFuseEquivalence({ built: [a], native: [a, b] })
    expect(r.ok).toBe(false)
    expect(r.mismatches).toHaveLength(1)
    expect(r.mismatches[0].kind).toBe('length')
  })

  it('分不同 ⇒ 红（顺序相同也不行）', () => {
    const r = verifyFuseEquivalence({ built: [a, { ...b, rrfScore: 0.06 }], native: [a, b] })
    expect(r.ok).toBe(false)
    expect(r.mismatches[0].kind).toBe('rrfScore')
  })

  it('通道身份不同 ⇒ 红', () => {
    const r = verifyFuseEquivalence({ built: [a, { ...b, channel: 'keyword' }], native: [a, b] })
    expect(r.ok).toBe(false)
    expect(r.mismatches[0].kind).toBe('channel')
  })
})

// ─── judgeFuseSelfCheck：承重闸的判词（含「无样本」那条硬闸） ────

describe('judgeFuseSelfCheck — 有样本才有绿；无样本必须拒出报告', () => {
  it('实比 12 条、零不符 ⇒ ok', () => {
    const r = judgeFuseSelfCheck({ intended: 12, compared: 12, skipped: 0, mismatches: [] })
    expect(r.ok).toBe(true)
  })

  it('**实比 0 条 ⇒ 拒**（原实现只报「打算比几条」，全跳过时会印成「✅ 逐行相等」）', () => {
    const r = judgeFuseSelfCheck({ intended: 12, compared: 0, skipped: 12, mismatches: [] })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('no-sample')
    expect(r.message).toContain('一条都没比成')
  })

  it('有样本但不符 ⇒ 拒，且 reason=mismatch（**优先于** no-sample）', () => {
    const r = judgeFuseSelfCheck({
      intended: 12,
      compared: 12,
      skipped: 0,
      mismatches: [{ kind: 'order' }],
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('mismatch')
  })

  it('部分跳过但有实比样本 ⇒ 仍可 ok（跳过本身不是失败，无样本才是）', () => {
    const r = judgeFuseSelfCheck({ intended: 12, compared: 7, skipped: 5, mismatches: [] })
    expect(r.ok).toBe(true)
  })
})

// ─── judgeMergeSelfCheck：与 judgeFuseSelfCheck 同族的第二道（无样本即拒） ────

describe('judgeMergeSelfCheck — 与融合自证同型：无样本的绿不算绿', () => {
  it('比了 120 行、零不符 ⇒ ok', () => {
    const r = judgeMergeSelfCheck({ entries: 40, rows: 120, mismatches: [] })
    expect(r.ok).toBe(true)
  })

  it('**0 行 final 流水 ⇒ 拒**（原实现只看 mismatches 为空 ⇒ 印「0 行…不符 0 处 ⇒ ✅」）', () => {
    const r = judgeMergeSelfCheck({ entries: 40, rows: 0, mismatches: [] })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('no-sample')
  })

  it('有不符 ⇒ 拒，且 reason=mismatch（**优先于** no-sample）', () => {
    const r = judgeMergeSelfCheck({ entries: 40, rows: 0, mismatches: [{ kind: 'rank' }] })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('mismatch')
  })
})

// ─── summarizeProductionFace：生产事件面（与黄金集面并列的另一个面） ────

describe('summarizeProductionFace — 零行 ≠ 够不着', () => {
  const row = (o) => ({ queryId: 1, chunkId: 10, distance: 0.2, rank: 0, injected: 0, ...o })

  it('零行 ⇒ measurable=false（**不可测**），不是「够不着」', () => {
    const r = summarizeProductionFace([])
    expect(r.measurable).toBe(false)
    expect(r.total).toBe(0)
    expect(r.topRank).toBe(null)
    expect(r.injectedRows).toBe(0)
  })

  it('rank 是 **0 基**：rank=0 才是最好（别读成 1）', () => {
    const r = summarizeProductionFace([
      row({ queryId: 1, rank: 4, distance: 0.5 }),
      row({ queryId: 2, rank: 0, distance: 0.31 }),
      row({ queryId: 3, rank: 2, distance: 0.22 }),
    ])
    expect(r.topRank).toBe(0)
    expect(r.rankBase).toBe(0)
    // 最小距离与最好名次**不是同一行**——两个读数各自独立取，别混成一行
    expect(r.minDistance).toBe(0.22)
  })

  it('injected 分别按**行**与按**查询**计数（同一查询多片各算一行）', () => {
    const r = summarizeProductionFace([
      row({ queryId: 1, chunkId: 10, injected: 1 }),
      row({ queryId: 1, chunkId: 11, injected: 1 }),
      row({ queryId: 2, chunkId: 10, injected: 0 }),
    ])
    expect(r.total).toBe(3)
    expect(r.queries).toBe(2)
    expect(r.injectedRows).toBe(2)
    expect(r.injectedQueries).toBe(1)
  })

  it('全无 rank 值（keyword-only 行）⇒ topRank=null，不猜 0', () => {
    const r = summarizeProductionFace([row({ rank: null, distance: 0.4 })])
    expect(r.measurable).toBe(true)
    expect(r.topRank).toBe(null)
    expect(r.minDistance).toBe(0.4)
  })
})

// ─── mergeQueryPools：跨查询合并重建 ─────────────────

describe('mergeQueryPools — 复刻 memory/index.ts 的三条合并规则', () => {
  it('(c) 首趟胜出：row / channel / 位次 / queryIndex 由**首次出现**的那趟决定', () => {
    const { order } = mergeQueryPools({
      pools: [
        pool(hit(1, { rrfScore: 0.1, vectorRank: 3, channel: 'vector' })),
        pool(hit(1, { rrfScore: 0.2, vectorRank: 7, channel: 'both' })),
      ],
      topK: 3,
    })
    expect(order[0].vectorRank).toBe(3)
    expect(order[0].channel).toBe('vector')
    expect(order[0].queryIndex).toBe(0)
  })

  it('(a) rrfScore **跨查询累加**（同一片被多趟命中 ⇒ 分相加，不是取最大）', () => {
    const { order } = mergeQueryPools({
      pools: [pool(hit(1, { rrfScore: 0.1 })), pool(hit(1, { rrfScore: 0.2 }))],
      topK: 3,
    })
    expect(order[0].rrfScore).toBeCloseTo(0.3, 12)
  })

  it('(b) bestIndex 取 min，**同分时**才决定次序', () => {
    const { order } = mergeQueryPools({
      pools: [pool(hit(2, { rrfScore: 0.05 }), hit(1, { rrfScore: 0.05 }))],
      topK: 3,
    })
    // 同分 ⇒ 按池内名次升序：id=2 在第 0 位、id=1 在第 1 位
    expect(order.map((r) => r.chunkId)).toEqual([2, 1])
  })

  it('分高者先，与 bestIndex 无关（bestIndex 只是 tie-break）', () => {
    const { order } = mergeQueryPools({
      pools: [pool(hit(1, { rrfScore: 0.01 }), hit(2, { rrfScore: 0.9 }))],
      topK: 3,
    })
    expect(order.map((r) => r.chunkId)).toEqual([2, 1])
  })

  it('rank 是**完整序**的 0 起名次（不随 topK 截断）', () => {
    const { order } = mergeQueryPools({
      pools: [
        pool(
          hit(1, { rrfScore: 0.5 }),
          hit(2, { rrfScore: 0.4 }),
          hit(3, { rrfScore: 0.3 }),
          hit(4, { rrfScore: 0.2 })
        ),
      ],
      topK: 2,
    })
    expect(order).toHaveLength(4)
    expect(order.map((r) => r.rank)).toEqual([0, 1, 2, 3])
  })

  it('injectedIds 只含前 topK 行；cutoffRrf = 第 topK 名的分（进榜门槛）', () => {
    const { injectedIds, cutoffRrf } = mergeQueryPools({
      pools: [
        pool(hit(1, { rrfScore: 0.5 }), hit(2, { rrfScore: 0.4 }), hit(3, { rrfScore: 0.3 })),
      ],
      topK: 2,
    })
    expect([...injectedIds].sort()).toEqual([1, 2])
    expect(cutoffRrf).toBeCloseTo(0.4, 12)
  })

  it('池内不足 topK 行 ⇒ cutoffRrf = null（不是 undefined / 末位的分）', () => {
    const { cutoffRrf } = mergeQueryPools({ pools: [pool(hit(1, { rrfScore: 0.5 }))], topK: 3 })
    expect(cutoffRrf).toBe(null)
  })

  it('空池 ⇒ 空序 + 空注入集（调用方零分支）', () => {
    const { order, injectedIds, cutoffRrf } = mergeQueryPools({ pools: [], topK: 3 })
    expect(order).toEqual([])
    expect(injectedIds.size).toBe(0)
    expect(cutoffRrf).toBe(null)
  })
})

describe('verifyMerge — 重建序 vs 链段自落的 final 流水（承重自证）', () => {
  const merged = mergeQueryPools({
    pools: [pool(hit(1, { rrfScore: 0.5 }), hit(2, { rrfScore: 0.4 }))],
    topK: 3,
  })

  const resultWith = (candidates) => ({ stats: { candidates } })

  it('逐行对上（chunkId / finalRank / rrfScore 三项）⇒ ok，且报告核了几行', () => {
    const r = verifyMerge({
      order: merged.order,
      result: resultWith([finalTrace(1, 0, 0.5), finalTrace(2, 1, 0.4)]),
    })
    expect(r.ok).toBe(true)
    expect(r.checked).toBe(2)
  })

  it('名次不符 ⇒ 红', () => {
    const r = verifyMerge({ order: merged.order, result: resultWith([finalTrace(1, 1, 0.5)]) })
    expect(r.ok).toBe(false)
    expect(r.mismatches[0].kind).toBe('rank')
  })

  it('分不符 ⇒ 红（名次相同也不行）', () => {
    const r = verifyMerge({ order: merged.order, result: resultWith([finalTrace(1, 0, 0.4999)]) })
    expect(r.ok).toBe(false)
    expect(r.mismatches[0].kind).toBe('rrfScore')
  })

  it('流水里有、重建序里没有 ⇒ 红（这一类最危险：说明重建漏了整片）', () => {
    const r = verifyMerge({ order: merged.order, result: resultWith([finalTrace(999, 0, 0.5)]) })
    expect(r.ok).toBe(false)
    expect(r.mismatches[0].kind).toBe('missing-in-reconstruction')
  })

  it('只核 `source==="final"` 的行（probe 行的序号是另一套，混进来必假红）', () => {
    const r = verifyMerge({
      order: merged.order,
      result: resultWith([
        finalTrace(1, 0, 0.5),
        { source: 'probe', chunkId: 2, finalRank: null, rrfScore: null },
      ]),
    })
    expect(r.ok).toBe(true)
    expect(r.checked).toBe(1)
  })
})

// ─── readAnchor：一处锚点的机制读数 ───────────────────

describe('readAnchor — 差几名 / 差多少 RRF / 并列判负', () => {
  const sectionIds = new Set([7])
  const mergedOf = (hits, topK) => mergeQueryPools({ pools: [pool(...hits)], topK })

  it('进了注入集 ⇒ injected=true', () => {
    const merged = mergedOf([hit(7, { rrfScore: 0.5 })], 3)
    const r = readAnchor({ sectionChunkIds: sectionIds, merged, maxDistance: 0.6 })
    expect(r.injected).toBe(true)
    expect(r.rank).toBe(0)
  })

  it('差几名 = rank − (topK − 1)；差多少 RRF = 榜尾分 − 本片分', () => {
    const merged = mergedOf(
      [
        hit(1, { rrfScore: 0.5 }),
        hit(2, { rrfScore: 0.4 }),
        hit(3, { rrfScore: 0.3 }),
        hit(7, { rrfScore: 0.2 }),
      ],
      3
    )
    const r = readAnchor({ sectionChunkIds: sectionIds, merged, maxDistance: 0.6 })
    expect(r.injected).toBe(false)
    expect(r.rank).toBe(3)
    expect(r.rankGap).toBe(1)
    expect(r.rrfGap).toBeCloseTo(0.1, 12)
  })

  it('**并列分被判负** 单列（rrfGap=0 却未进榜 ⇒ 药方是 tie-break，不是阈值/名次）', () => {
    // id=7 与 id=3 同分，但 id=3 的池内名次更靠前 ⇒ 7 被 tie-break 判负
    const merged = mergedOf(
      [
        hit(3, { rrfScore: 0.3 }),
        hit(1, { rrfScore: 0.5 }),
        hit(2, { rrfScore: 0.4 }),
        hit(7, { rrfScore: 0.3 }),
      ],
      3
    )
    const r = readAnchor({ sectionChunkIds: sectionIds, merged, maxDistance: 0.6 })
    expect(r.injected).toBe(false)
    expect(r.rrfGap).toBeCloseTo(0, 12)
    expect(r.tieBroken).toBe(true)
  })

  it('不在融合池内 ⇒ rank/rrfGap 全 null（**不是** 0 / Infinity——「没有」与「差 0」必须分得开）', () => {
    const merged = mergedOf([hit(1, { rrfScore: 0.5 })], 3)
    const r = readAnchor({ sectionChunkIds: sectionIds, merged, maxDistance: 0.6 })
    expect(r.inMergedPool).toBe(false)
    expect(r.rank).toBe(null)
    expect(r.rankGap).toBe(null)
    expect(r.rrfGap).toBe(null)
    expect(r.tieBroken).toBe(false)
  })

  it('同节多片 ⇒ 取**最好**的那片（名次最小）', () => {
    const merged = mergedOf(
      [hit(1, { rrfScore: 0.9 }), hit(7, { rrfScore: 0.2 }), hit(8, { rrfScore: 0.3 })],
      1
    )
    const r = readAnchor({ sectionChunkIds: new Set([7, 8]), merged, maxDistance: 0.6 })
    expect(r.chunkId).toBe(8)
    expect(r.rank).toBe(1)
  })

  it('只出**被消费**的字段——`poolRows` / `sectionSize` 两个死字段已删（实测两出口零消费）', () => {
    const merged = mergedOf([hit(7, { rrfScore: 0.2 }), hit(8, { rrfScore: 0.3 })], 1)
    const r = readAnchor({ sectionChunkIds: new Set([7, 8]), merged, maxDistance: 0.6 })
    expect(Object.keys(r)).not.toContain('poolRows')
    expect(Object.keys(r)).not.toContain('sectionSize')
  })

  it('同节的另一片进了榜 ⇒ 该锚点算 **injected**（注入单位是节不是片）', () => {
    const merged = mergedOf([hit(8, { rrfScore: 0.9 }), hit(1, { rrfScore: 0.1 })], 1)
    const r = readAnchor({ sectionChunkIds: new Set([7, 8]), merged, maxDistance: 0.6 })
    expect(r.injected).toBe(true)
  })
})

// ─── 反对照（承重） ───────────────────────────────────

describe('judgeThresholdCounterControl — 两条同时成立才算过', () => {
  it('收紧前在注入集、收紧后不在 ⇒ ok（这才是「阈值确实能杀」）', () => {
    expect(
      judgeThresholdCounterControl({
        baseInjected: true,
        tightenedInjected: false,
        tightenedThreshold: 0.2,
        observedDistance: 0.3,
      }).ok
    ).toBe(true)
  })

  it('收紧后**仍在** ⇒ 不过（说明这条节的决定因素不是阈值，硬拿它当对照就是假绿门）', () => {
    const r = judgeThresholdCounterControl({
      baseInjected: true,
      tightenedInjected: true,
      tightenedThreshold: 0.2,
      observedDistance: 0.3,
    })
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('没有分辨力')
  })

  it('收紧前就**不在**注入集 ⇒ 不过（只查「收紧后不在」是假绿门）', () => {
    expect(
      judgeThresholdCounterControl({
        baseInjected: false,
        tightenedInjected: false,
        tightenedThreshold: 0.2,
        observedDistance: 0.3,
      }).ok
    ).toBe(false)
  })

  it('跑不起来（tightenedInjected=null）⇒ 不过，不静默放过', () => {
    expect(
      judgeThresholdCounterControl({
        baseInjected: true,
        tightenedInjected: null,
        tightenedThreshold: null,
        observedDistance: null,
      }).ok
    ).toBe(false)
  })
})

describe('judgeKillZoneExistence — 杀区（补强项，不是硬闸）', () => {
  const maxDistance = 0.6
  const relaxedMaxDistance = 1

  it('区间左闭右开 [阈值, 放宽上限)：恰好等于阈值 ⇒ 算被杀', () => {
    const r = judgeKillZoneExistence({
      relaxedHits: [{ channel: 'vector', distance: maxDistance }],
      maxDistance,
      relaxedMaxDistance,
    })
    expect(r.ok).toBe(true)
    expect(r.killedN).toBe(1)
  })

  it('恰好等于放宽上限 ⇒ 不算（那是「重搜也够不着」，另一类）', () => {
    const r = judgeKillZoneExistence({
      relaxedHits: [{ channel: 'vector', distance: relaxedMaxDistance }],
      maxDistance,
      relaxedMaxDistance,
    })
    expect(r.ok).toBe(false)
  })

  it('关键词命中不参与（它没有距离概念，哨兵值会假报成「杀区里的片」）', () => {
    const r = judgeKillZoneExistence({
      relaxedHits: [{ channel: 'keyword', distance: maxDistance }],
      maxDistance,
      relaxedMaxDistance,
    })
    expect(r.ok).toBe(false)
  })

  it('距离非数（null）不参与，不把 null 当 0 比大小', () => {
    const r = judgeKillZoneExistence({
      relaxedHits: [{ channel: 'vector', distance: null }],
      maxDistance,
      relaxedMaxDistance,
    })
    expect(r.ok).toBe(false)
  })

  it('报最近的那个被杀片距离（供报告写读数）', () => {
    const r = judgeKillZoneExistence({
      relaxedHits: [
        { channel: 'vector', distance: 0.8 },
        { channel: 'vector', distance: 0.61 },
      ],
      maxDistance,
      relaxedMaxDistance,
    })
    expect(r.minKilledDistance).toBe(0.61)
  })
})

// ─── CLI 与契约常量 ───────────────────────────────────

describe('parseArgs / 契约常量', () => {
  it('缺省：liveRewrite 开、其余为 null', () => {
    const a = parseArgs([])
    expect(a.liveRewrite).toBe(true)
    expect(a.out).toBe(null)
    expect(a.db).toBe(null)
  })

  it('`--no-live-rewrite` 关掉改写器那一节（不静默跳过——报告里会写明原因）', () => {
    expect(parseArgs(['--no-live-rewrite']).liveRewrite).toBe(false)
  })

  it('各路径参数按值取（不吞下一个 flag）', () => {
    const a = parseArgs([
      '--db',
      '/x.db',
      '--env',
      '/y.env',
      '--date',
      '2026-01-01',
      '--out',
      '/o.md',
    ])
    expect([a.db, a.env, a.date, a.out]).toEqual(['/x.db', '/y.env', '2026-01-01', '/o.md'])
  })

  it('TOPK_SWEEP 含生产缺省 3，且升序、无重复（扫描少了生产档就没法做「恢复 0」的自检）', () => {
    expect(TOPK_SWEEP).toContain(3)
    expect([...TOPK_SWEEP].sort((a, b) => a - b)).toEqual(TOPK_SWEEP)
    expect(new Set(TOPK_SWEEP).size).toBe(TOPK_SWEEP.length)
  })

  it('REPORT_0920_MISSES = 11 处，且 (条目, 锚点) 不重复（对照面塌了，「少 0 / 多 0」这句话就没意义）', () => {
    expect(REPORT_0920_MISSES).toHaveLength(11)
    const keys = REPORT_0920_MISSES.map((m) => `${m.id} :: ${m.docPath} :: ${m.sectionAnchor}`)
    expect(new Set(keys).size).toBe(11)
    for (const m of REPORT_0920_MISSES) {
      expect(m.docPath).toMatch(/^docs\//)
      expect(typeof m.attribution).toBe('string')
    }
  })

  it('schema 常量是个正整数（报告形态变更时递增；忘了递增就没人能判历史报告口径）', () => {
    expect(Number.isInteger(DIAG_REPORT_SCHEMA)).toBe(true)
    expect(DIAG_REPORT_SCHEMA).toBeGreaterThan(0)
  })
})

// ─── 契约静态断言（`.mjs` 兜不住的那条接缝） ───────────

describe('静态源断言 — 链段结果对象的字段名（改名即静默读空）', () => {
  const memorySrc = readFileSync(
    path.join(REPO_ROOT, 'packages/server/src/memory/index.ts'),
    'utf8'
  )

  it('`sections[]` 带 `docPath` / `sectionAnchor`（报告 §三 的锚点身份全靠它）', () => {
    expect(memorySrc).toMatch(/export interface RetrievedSection \{[\s\S]*?docPath: string/)
    expect(memorySrc).toMatch(/export interface RetrievedSection \{[\s\S]*?sectionAnchor: string/)
  })

  it('候选流水带 `source` / `chunkId` / `finalRank` / `rrfScore`（重建自证三项全靠它）', () => {
    for (const field of ['finalRank', 'rrfScore', 'chunkId']) {
      expect(memorySrc).toContain(field)
    }
    // `source: 'final' | 'probe'` 这个判别位——重建自证只核 final 行，判别位变了必假红
    expect(memorySrc).toMatch(/source: 'final'/)
  })

  it('末次截断仍是 `slice(0, params.topK)`（§6.3 那句「切的是片不是节」的判据面）', () => {
    expect(memorySrc).toMatch(/\.slice\(0, params\.topK\)/)
  })

  it('按节补齐仍走 `bySection`（「切 3 片只换来 2 节」这个名额浪费的机制来源）', () => {
    expect(memorySrc).toContain('bySection')
  })
})

describe('静态源断言 — 本脚本对库只读（诊断脚本绝不许写生产库）', () => {
  const selfSrc = readFileSync(
    path.join(REPO_ROOT, 'scripts/eval/retrieval-attribution-recheck.mjs'),
    'utf8'
  )

  it('库以 `readonly: true` + `fileMustExist: true` 打开（静默建空库在这条路径上物理不可达）', () => {
    expect(selfSrc).toMatch(/readonly: true/)
    expect(selfSrc).toMatch(/fileMustExist: true/)
  })

  it('不 import 任何写口（`setDb` 之后只经 repository 的读函数取数）', () => {
    expect(selfSrc).not.toContain('initRepository(db, { write')
    expect(selfSrc).not.toMatch(/db\.prepare\(\s*['"`]\s*(INSERT|UPDATE|DELETE|DROP|CREATE)/i)
  })

  it('嵌入端口恒动态（继承活 server 的固定端口 ⇒ EADDRINUSE ⇒ 降级成仅关键词通道 ⇒ 假读数）', () => {
    expect(selfSrc).toMatch(/process\.env\.EMBED_SIDECAR_PORT = '0'/)
  })

  it('来源里是**转义序列** `\\u0000`，不是裸 NUL 字节（裸字节会让 grep 把文件当二进制、定位手段当场失效）', () => {
    const raw = readFileSync(path.join(REPO_ROOT, 'scripts/eval/retrieval-attribution-recheck.mjs'))
    expect(raw.includes(0)).toBe(false)
  })
})
