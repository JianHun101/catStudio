/**
 * 检索跑批基线测试（R10 B4）。
 *
 * 测试面刻意分两层：
 *   - **纯单元**：`scoreEntry` / `summarizeGroup` / 三条闸 / `evaluateCanary` /
 *     `renderReport` 全部喂手搓对象——判据面窄、可穷举、不碰库不碰嵌入；
 *   - **契约静态断言**：跑批的评分读的是**链段结果对象的字段名**
 *     （`sections[].docPath` / `candidates[].docPath` / `droppedReason`），而黄金集用
 *     **snake_case**（`doc_path`）。两侧字段名一旦被「统一」，匹配会**静默全灭**
 *     （每条都落 `not-recalled`，recall 全零，且不报任何错）。故这里直接读链段源码
 *     断言这几个字段名仍在——这是本脚本唯一无法靠类型系统兜住的接缝（脚本是 `.mjs`）。
 *
 * **不测什么**：跑真库 + 真 sidecar 那条端到端链（B1/B2/B3）不进单测——它要 526MB 的
 * 实验库与一个 30s 冷启动的嵌入 sidecar，属于「系统级 e2e，手动跑」那一档。
 * 那三条验收由 T6 实跑记录在交接文档里，不在这里假装绿。
 */
import { describe, it, expect, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  BASELINE_REPORT_SCHEMA,
  CANARY_HIT_ID,
  CANARY_MISS_ID,
  CANARY_MISS_QUERY,
  LEGIT_EMPTY_REASONS,
  MISS_RX,
  RECHECK_MAX_DISTANCE,
  REPO_ROOT,
  anchorKey,
  buildCanaries,
  buildRecheckIndex,
  buildReportJson,
  checkAttributionCoverage,
  checkCorpusGate,
  checkDegradation,
  checkEmbedHealth,
  checkIndexFreshness,
  collectRecheckPools,
  evaluateCanary,
  fmt4,
  localDate,
  main,
  missLabel,
  parseArgs,
  renderReport,
  reportJsonPath,
  rescoreWithRecheck,
  scoreEntry,
  summarizeGroup,
  summarizeMissDistances,
} from './retrieval-baseline.mjs'

// ─── 夹具 ─────────────────────────────────────────────

/** 造一个链段结果（只保留评分要读的字段；形状对齐 `MemoryContextResult`） */
function result({
  sections = [],
  candidates = [],
  queryTraces = [],
  reason = 'ok',
  thresholdMaxDistance = 0.6,
} = {}) {
  return {
    text: '',
    reason,
    sections,
    stats: { candidates, queryTraces, thresholdMaxDistance },
  }
}

/** 造一个已注入的节 */
const sec = (docPath, sectionAnchor) => ({ docPath, sectionAnchor })

/** 造一条候选流水（`source` + `droppedReason` 是评分读的判别列，距离/通道供 §二 读数用） */
const cand = (docPath, sectionAnchor, source, droppedReason, extra = {}) => ({
  docPath,
  sectionAnchor,
  source,
  droppedReason,
  distance: 0.3,
  channel: 'vector',
  ...extra,
})

/** 造一条重搜命中（`collectRecheckPools` 的池内元素形状） */
const poolHit = (docPath, sectionAnchor, rank, extra = {}) => ({
  docPath,
  sectionAnchor,
  rank,
  channel: 'vector',
  distance: 0.4,
  ...extra,
})

/** 造一个黄金集条目的最小形状 */
const entry = (over = {}) => ({
  id: 'X01',
  kind: 'constructed',
  expect: [{ doc_path: 'docs/a.md', section_anchor: '一节' }],
  forbid: [],
  ...over,
})

const A = { doc_path: 'docs/a.md', section_anchor: '一节' }
const B = { doc_path: 'docs/b.md', section_anchor: '二节' }

// ─── anchorKey ────────────────────────────────────────

describe('anchorKey — 撞键防护', () => {
  it('分隔符必须让「路径含空格」与「锚点含空格」不撞键', () => {
    // 空格分隔时这两组会拼成同一个串（"a b c"）——撞键会把 A 的未命中算成 B 的命中
    expect(anchorKey('a b', 'c')).not.toBe(anchorKey('a', 'b c'))
  })

  it('同锚点同键、异锚点异键', () => {
    expect(anchorKey(A.doc_path, A.section_anchor)).toBe(anchorKey(A.doc_path, A.section_anchor))
    expect(anchorKey(A.doc_path, A.section_anchor)).not.toBe(
      anchorKey(B.doc_path, B.section_anchor)
    )
  })

  it('源码里是转义序列，不是裸 NUL 字节（裸字节会让 grep 把文件当二进制）', () => {
    const raw = readFileSync(path.join(REPO_ROOT, 'scripts', 'eval', 'retrieval-baseline.mjs'))
    expect(raw.filter((b) => b === 0).length).toBe(0)
  })
})

// ─── 格式化与日期 ─────────────────────────────────────

describe('fmt4 / localDate — 确定性面', () => {
  it('fmt4 固定 4 位；非有限数落 n/a', () => {
    expect(fmt4(1)).toBe('1.0000')
    expect(fmt4(0.5833333333333334)).toBe('0.5833')
    expect(fmt4(0)).toBe('0.0000')
    expect(fmt4(NaN)).toBe('n/a')
    expect(fmt4(undefined)).toBe('n/a')
    expect(fmt4(null)).toBe('n/a')
  })

  it('localDate 取**本地**分量（不是 UTC——本仓 DB 时间戳是 UTC，差 8h 会成假读数）', () => {
    const d = new Date(2026, 0, 5, 23, 30) // 本地 1/5 23:30
    expect(localDate(d)).toBe('2026-01-05')
  })
})

// ─── scoreEntry ───────────────────────────────────────

describe('scoreEntry — 单条评分与归因', () => {
  it('锚点在注入集 ⇒ injected、recall=1', () => {
    const s = scoreEntry({
      entry: entry(),
      result: result({ sections: [sec(A.doc_path, A.section_anchor)] }),
    })
    expect(s.hit).toBe(1)
    expect(s.recall).toBe(1)
    expect(s.details[0].status).toBe('injected')
  })

  it('探针池里被阈值杀 ⇒ status=dropped、drop=threshold、计入阈值前命中', () => {
    const s = scoreEntry({
      entry: entry(),
      result: result({ candidates: [cand(A.doc_path, A.section_anchor, 'probe', 'threshold')] }),
    })
    expect(s.hit).toBe(0)
    expect(s.recall).toBe(0)
    expect(s.preThreshold).toBe(1)
    expect(s.preThresholdRate).toBe(1)
    expect(s.details[0]).toMatchObject({ status: 'dropped', drop: 'threshold' })
  })

  it('探针池里过闸但没进融合 topK ⇒ not_topk（**不算**阈值前命中——药方不同）', () => {
    const s = scoreEntry({
      entry: entry(),
      result: result({ candidates: [cand(A.doc_path, A.section_anchor, 'probe', 'not_topk')] }),
    })
    expect(s.preThreshold).toBe(0)
    expect(s.details[0].drop).toBe('not_topk')
  })

  it('融合 topK 里但整节放不进预算 ⇒ drop=budget', () => {
    const s = scoreEntry({
      entry: entry(),
      result: result({ candidates: [cand(A.doc_path, A.section_anchor, 'final', 'budget')] }),
    })
    expect(s.details[0].drop).toBe('budget')
  })

  it('哪儿都不在 ⇒ not-recalled', () => {
    const s = scoreEntry({ entry: entry(), result: result() })
    expect(s.details[0].status).toBe('not-recalled')
    expect(s.details[0].drop).toBe(null)
  })

  it('forbid 命中 ⇒ 列入 forbidHit（判红的唯一来源）', () => {
    const s = scoreEntry({
      entry: entry({ forbid: [A] }),
      result: result({ sections: [sec(A.doc_path, A.section_anchor)] }),
    })
    expect(s.forbidHit).toHaveLength(1)
    expect(s.forbidHit[0].docPath).toBe(A.doc_path)
  })

  it('forbid 未命中 ⇒ forbidHit 空', () => {
    const s = scoreEntry({
      entry: entry({ forbid: [B] }),
      result: result({ sections: [sec(A.doc_path, A.section_anchor)] }),
    })
    expect(s.forbidHit).toHaveLength(0)
  })

  it('expect 为空 ⇒ recall = null（不是 0——「没标」与「没命中」不是一回事）', () => {
    const s = scoreEntry({ entry: entry({ expect: [], kind: 'negative' }), result: result() })
    expect(s.recall).toBe(null)
  })
})

// ─── 逐查询重搜（below_topk / 覆盖洞 的判别面） ─────────

describe('collectRecheckPools / buildRecheckIndex — 逐查询重搜', () => {
  const hit = (docPath, sectionAnchor, distance = 0.4, channel = 'vector') => ({
    row: { doc_path: docPath, section_anchor: sectionAnchor, distance },
    channel,
  })

  it('逐条查询跑一遍，映射成 {docPath, rank, channel, distance}（rank = 池内名次，0 起）', async () => {
    const perQuery = await collectRecheckPools({
      queries: ['q0', 'q1'],
      maxDistance: RECHECK_MAX_DISTANCE,
      embed: async () => ({ ok: true, vector: [1, 0] }),
      search: (v, q) => (q === 'q0' ? [hit('a.md', '一节'), hit('b.md', '二节')] : []),
    })
    expect(perQuery).toEqual([
      [
        { docPath: 'a.md', sectionAnchor: '一节', rank: 0, channel: 'vector', distance: 0.4 },
        { docPath: 'b.md', sectionAnchor: '二节', rank: 1, channel: 'vector', distance: 0.4 },
      ],
      [],
    ])
  })

  it('宽阈值是**注入**进去的，且必须比生产缺省阈值松（否则「被阈值杀」这类永远看不见）', async () => {
    const seen = []
    await collectRecheckPools({
      queries: ['q0'],
      maxDistance: RECHECK_MAX_DISTANCE,
      embed: async () => ({ ok: true, vector: [1, 0] }),
      search: (v, q, max) => {
        seen.push(max)
        return []
      },
    })
    expect(seen).toEqual([RECHECK_MAX_DISTANCE])
    expect(RECHECK_MAX_DISTANCE).toBeGreaterThan(0.6)
  })

  it('该查询嵌入失败 ⇒ 空数组（不抛；调用方只 for..of，不必防空）', async () => {
    const perQuery = await collectRecheckPools({
      queries: ['q0', 'q1'],
      maxDistance: RECHECK_MAX_DISTANCE,
      embed: async (q) => (q === 'q0' ? { ok: false, reason: 'x' } : { ok: true, vector: [1] }),
      search: () => [hit('a.md', '一节')],
    })
    expect(perQuery[0]).toEqual([])
    expect(perQuery[1]).toHaveLength(1)
  })

  it('纯关键词命中记 distance=null（库层填的是 maxDistance 哨兵，不是真距离）', async () => {
    const perQuery = await collectRecheckPools({
      queries: ['q0'],
      maxDistance: RECHECK_MAX_DISTANCE,
      embed: async () => ({ ok: true, vector: [1] }),
      search: () => [hit('a.md', '一节', RECHECK_MAX_DISTANCE, 'keyword')],
    })
    expect(perQuery[0][0].distance).toBe(null)
    expect(perQuery[0][0].channel).toBe('keyword')
  })

  it('buildRecheckIndex 取**最小距离**那次命中，识别点（查询/名次）跟着它走——不许「q0 的名次配 q3 的距离」', () => {
    const idx = buildRecheckIndex({
      perQuery: [
        [poolHit('a.md', '一节', 3, { distance: 0.55 })],
        [poolHit('a.md', '一节', 0, { distance: 0.3 }), poolHit('b.md', '二节', 2)],
      ],
    })
    expect(idx.get(anchorKey('a.md', '一节'))).toEqual({
      queryIndex: 1,
      rank: 0,
      channel: 'vector',
      distance: 0.3,
      keywordHit: false,
    })
    expect(idx.get(anchorKey('b.md', '二节'))).toMatchObject({ queryIndex: 1, rank: 2 })
  })

  it('同距时保留**更早**的查询（tie-break 确定 ⇒ B1 复跑可比）', () => {
    const idx = buildRecheckIndex({
      perQuery: [
        [poolHit('a.md', '一节', 3, { distance: 0.4 })],
        [poolHit('a.md', '一节', 0, { distance: 0.4 })],
      ],
    })
    expect(idx.get(anchorKey('a.md', '一节'))).toMatchObject({ queryIndex: 0, rank: 3 })
  })

  it('关键词命中单独记：只被关键词捞到 ⇒ distance 恒 null、keywordHit=true', () => {
    const idx = buildRecheckIndex({
      perQuery: [[poolHit('a.md', '一节', 1, { channel: 'keyword', distance: null })]],
    })
    expect(idx.get(anchorKey('a.md', '一节'))).toEqual({
      queryIndex: 0,
      rank: 1,
      channel: 'keyword',
      distance: null,
      keywordHit: true,
    })
  })

  it('先关键词、后向量 ⇒ keywordHit 保留为 true，识别点换成那次向量命中', () => {
    const idx = buildRecheckIndex({
      perQuery: [
        [poolHit('a.md', '一节', 1, { channel: 'keyword', distance: null })],
        [poolHit('a.md', '一节', 4, { distance: 0.5 })],
      ],
    })
    expect(idx.get(anchorKey('a.md', '一节'))).toEqual({
      queryIndex: 1,
      rank: 4,
      channel: 'vector',
      distance: 0.5,
      keywordHit: true,
    })
  })

  it('空池 ⇒ 空索引（Map，不是 undefined——调用方零分支）', () => {
    expect(buildRecheckIndex({ perQuery: [[], []] }).size).toBe(0)
  })
})

describe('scoreEntry — 重搜把 below_topk 从覆盖洞里拆出来', () => {
  /** 造一个重搜索引（只放一条锚点，其余锚点按「重搜也够不着」处理） */
  const recheckFor = (a, rc) => new Map([[anchorKey(a.doc_path, a.section_anchor), rc]])
  const rc = (over = {}) => ({
    queryIndex: 1,
    rank: 5,
    channel: 'vector',
    distance: 0.4,
    keywordHit: false,
    ...over,
  })

  it('流水两条路都没出现、重搜命中且距离在阈值内 ⇒ below_topk（药方是排序，不是补语料）', () => {
    const s = scoreEntry({ entry: entry(), result: result(), recheck: recheckFor(A, rc()) })
    expect(s.details[0]).toMatchObject({
      status: 'below_topk',
      drop: null,
      queryIndex: 1,
      rank: 5,
      channel: 'vector',
      distance: 0.4,
    })
    expect(s.hit).toBe(0)
    expect(s.preThreshold).toBe(0) // 它不是被阈值杀的
  })

  it('重搜命中但真实距离 ≥ 阈值 ⇒ 落 threshold 桶（**旧探针池结构上看不见这一类**）', () => {
    const s = scoreEntry({
      entry: entry(),
      result: result(),
      recheck: recheckFor(A, rc({ distance: 0.75 })),
    })
    expect(s.details[0]).toMatchObject({ status: 'dropped', drop: 'threshold', distance: 0.75 })
    expect(s.preThreshold).toBe(1) // 阈值前命中率把它算进来（它正是「松阈值能救」的那类）
  })

  it('阈值取自**链段落的参数快照**（不是脚本另读一遍 env——两处读会各自漂移）', () => {
    const r = result({ thresholdMaxDistance: 0.35 })
    const s = scoreEntry({
      entry: entry(),
      result: r,
      recheck: recheckFor(A, rc({ distance: 0.5 })),
    })
    expect(s.details[0].drop).toBe('threshold') // 0.5 ≥ 0.35 ⇒ 阈值杀的（若读成 0.6 会误判成 below_topk）
  })

  it('关键词通道命中 ⇒ below_topk（无距离概念，生产里也不受阈值约束）', () => {
    const s = scoreEntry({
      entry: entry(),
      result: result(),
      recheck: recheckFor(A, rc({ channel: 'keyword', distance: null, keywordHit: true })),
    })
    expect(s.details[0]).toMatchObject({ status: 'below_topk', distance: null })
  })

  it('关键词捞到过、但另一次向量命中的距离 ≥ 阈值 ⇒ 仍判 below_topk（关键词通道本就不受阈值约束）', () => {
    const s = scoreEntry({
      entry: entry(),
      result: result(),
      recheck: recheckFor(A, rc({ distance: 0.9, keywordHit: true })),
    })
    expect(s.details[0].status).toBe('below_topk')
  })

  it('重搜也够不着 ⇒ not-recalled（真覆盖洞）', () => {
    const s = scoreEntry({ entry: entry(), result: result(), recheck: new Map() })
    expect(s.details[0]).toMatchObject({ status: 'not-recalled', drop: null })
  })

  it('不传 recheck ⇒ 关掉重搜（旧口径，两条路都没出现即覆盖洞）', () => {
    const s = scoreEntry({ entry: entry(), result: result() })
    expect(s.details[0].status).toBe('not-recalled')
  })

  it('流水行自带距离/通道一并进明细，并标 `source: trace`（§二 读数要按来源分列）', () => {
    const s = scoreEntry({
      entry: entry(),
      result: result({
        candidates: [cand(A.doc_path, A.section_anchor, 'probe', 'threshold', { distance: 0.9 })],
      }),
    })
    expect(s.details[0]).toMatchObject({
      status: 'dropped',
      drop: 'threshold',
      distance: 0.9,
      source: 'trace',
    })
  })

  it('重搜判出来的标 `source: recheck`（报告要能说清哪个数是从哪来的）', () => {
    const s = scoreEntry({ entry: entry(), result: result(), recheck: recheckFor(A, rc()) })
    expect(s.details[0].source).toBe('recheck')
  })
})

describe('rescoreWithRecheck — 评分接线：重搜**真的被接上**', () => {
  /**
   * 这组测的是**接线**，不是纯函数语义（后者在上一组已穷举）。
   *
   * 为什么必须测它：整套重搜机制的价值全在接线上——`scoreEntry` 再对，只要 `main`
   * 没把索引建出来传进去，`below_topk` 就静默退回「覆盖洞」，而报告看起来一切正常。
   * 抽出函数 + 注入假 `embed`/`search` 后，「有没有真去重搜」是可断言的**行为**，
   * 不必靠读者去源码里找那一行。
   */
  /** `collectRecheckPools` 的 `search` 返回值形状（库层的命中行） */
  const rawHit = (docPath, sectionAnchor, distance = 0.4, channel = 'vector') => ({
    row: { doc_path: docPath, section_anchor: sectionAnchor, distance },
    channel,
  })

  it('有未注入锚点 ⇒ 真去重搜并改判 below_topk、rechecked=true', async () => {
    const out = await rescoreWithRecheck({
      entry: entry(),
      result: result(),
      queries: ['q0', 'q1'],
      embed: async () => ({ ok: true, vector: [1] }),
      search: (v, q) => (q === 'q1' ? [rawHit(A.doc_path, A.section_anchor, 0.4)] : []),
    })
    expect(out.rechecked).toBe(true)
    expect(out.score.details[0]).toMatchObject({
      status: 'below_topk', // 不接线的话这里会是 not-recalled（= 上轮那个误判）
      drop: null,
      source: 'recheck',
      distance: 0.4,
    })
  })

  it('全注入 ⇒ 原样返回、**连 embed 都不调**（成本闸，也是「重搜不碰已命中语义」的结构保证）', async () => {
    let embedCalls = 0
    const out = await rescoreWithRecheck({
      entry: entry(),
      result: result({ sections: [sec(A.doc_path, A.section_anchor)] }),
      queries: ['q0'],
      embed: async () => {
        embedCalls += 1
        return { ok: true, vector: [1] }
      },
      search: () => [],
    })
    expect(out.rechecked).toBe(false)
    expect(embedCalls).toBe(0)
    expect(out.score).toMatchObject({ hit: 1, recall: 1 })
  })

  it('宽阈值**透到检索层**（接线漏传 maxDistance ⇒ 重搜退回生产窄阈值，「被阈值杀」永远看不见）', async () => {
    const seen = []
    await rescoreWithRecheck({
      entry: entry(),
      result: result(),
      queries: ['q0'],
      embed: async () => ({ ok: true, vector: [1] }),
      search: (v, q, max) => {
        seen.push(max)
        return []
      },
    })
    expect(seen).toEqual([RECHECK_MAX_DISTANCE])
  })

  it('重搜跑的是**同一条目的同一组查询**（原话 + 全部冻结改写），不是只有原话', async () => {
    const asked = []
    await rescoreWithRecheck({
      entry: entry(),
      result: result(),
      queries: ['原话', '改写一', '改写二'],
      embed: async (q) => {
        asked.push(q)
        return { ok: true, vector: [1] }
      },
      search: () => [],
    })
    expect(asked).toEqual(['原话', '改写一', '改写二'])
  })

  it('main 的逐条跑批**真接上了这条线**（静态断言：把调用摘掉即红）', () => {
    const src = readFileSync(
      path.join(REPO_ROOT, 'scripts', 'eval', 'retrieval-baseline.mjs'),
      'utf8'
    )
    const start = src.indexOf('// ─── 逐条跑批')
    const end = src.indexOf('// ─── B5 降级硬闸')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start) // 两个锚点任一改名 ⇒ 空切片会让下面的断言恒真
    const loop = src.slice(start, end)
    // 分数必须来自接线函数，且生产的嵌入器真被绑上去（而非另起一个未接线的分叉）
    expect(loop).toMatch(/=\s*await rescoreWithRecheck\(\{/)
    expect(loop).toContain('embed: embedText')
    // 旁路面：循环里不得再**直接**调 scoreEntry 打分——那正是「重搜被静默关掉」的形态
    expect(loop).not.toContain('scoreEntry(')
  })
})

describe('summarizeMissDistances — §二 结论的证据面', () => {
  const det = (over = {}) => ({
    docPath: 'd',
    sectionAnchor: 's',
    status: 'dropped',
    drop: 'x',
    ...over,
  })

  it('三分类互斥且穷尽：有向量距离 / 仅关键词 / 够不着；距离按来源分列', () => {
    const r = summarizeMissDistances({
      scores: [
        {
          details: [
            det({ distance: 0.5, channel: 'vector', source: 'trace' }),
            det({ distance: 0.9, channel: 'both', source: 'recheck' }),
            det({ distance: null, channel: 'keyword' }),
            det({ distance: null, channel: null }), // not-recalled：连重搜都没够着
            det({ status: 'injected', drop: null }), // 命中的不算
          ],
        },
      ],
      maxDistance: 0.6,
    })
    expect(r).toEqual({
      total: 4,
      keywordOnly: 1,
      vectorKnown: 2,
      fromTrace: 1,
      fromRecheck: 1,
      atOrAboveThreshold: 1,
      unreachable: 1,
      maxDistance: 0.9,
    })
    // 三分类必须是个划分（否则报告里「合计 N 处」与三个子数对不上账）
    expect(r.keywordOnly + r.vectorKnown + r.unreachable).toBe(r.total)
  })

  it('全在阈值内 ⇒ atOrAboveThreshold = 0（报告里那句「阈值一条都没杀」的判据）', () => {
    const r = summarizeMissDistances({
      scores: [{ details: [det({ distance: 0.5427, channel: 'vector' })] }],
      maxDistance: 0.6,
    })
    expect(r.atOrAboveThreshold).toBe(0)
    expect(r.maxDistance).toBe(0.5427)
  })

  it('一个距离都没有 ⇒ maxDistance = null（不是 -Infinity / NaN）', () => {
    const r = summarizeMissDistances({ scores: [{ details: [det()] }], maxDistance: 0.6 })
    expect(r.maxDistance).toBe(null)
    expect(r.unreachable).toBe(1)
  })

  it('空集 ⇒ 全零、不抛', () => {
    expect(summarizeMissDistances({ scores: [], maxDistance: 0.6 })).toEqual({
      total: 0,
      keywordOnly: 0,
      vectorKnown: 0,
      fromTrace: 0,
      fromRecheck: 0,
      atOrAboveThreshold: 0,
      unreachable: 0,
      maxDistance: null,
    })
  })
})

// ─── summarizeGroup ───────────────────────────────────

describe('summarizeGroup — 集均 vs 合计', () => {
  const s = (expectTotal, hit, preThreshold = 0) => ({
    expectTotal,
    hit,
    preThreshold,
    recall: expectTotal > 0 ? hit / expectTotal : null,
    preThresholdRate: expectTotal > 0 ? preThreshold / expectTotal : null,
  })

  it('集均 = 各条算术平均；合计 = 总命中/总应命中（两条口径确实不同）', () => {
    const g = summarizeGroup([s(1, 1), s(2, 0)])
    expect(g.recallMean).toBe(0.5) // (1 + 0) / 2
    expect(g.microRecall).toBeCloseTo(1 / 3) // 1 / 3
    expect(g.expectTotal).toBe(3)
    expect(g.hit).toBe(1)
  })

  it('recall=null 的条目（expect 空）不进均值，但计入条数', () => {
    const g = summarizeGroup([s(1, 1), s(0, 0)])
    expect(g.n).toBe(2)
    expect(g.scoredN).toBe(1)
    expect(g.recallMean).toBe(1)
  })

  it('空组 ⇒ 均值为 null 而不是 NaN', () => {
    const g = summarizeGroup([])
    expect(g.recallMean).toBe(null)
    expect(g.microRecall).toBe(null)
  })
})

// ─── 三条闸 ───────────────────────────────────────────

describe('checkEmbedHealth / checkDegradation — B5 降级硬闸', () => {
  it('**部分**查询嵌入失败 ⇒ 命中（这是实测暴露的假读数面：reason 仍是 ok）', () => {
    const h = checkEmbedHealth([
      {
        id: 'G01',
        result: result({
          queryTraces: [
            { queryIndex: 0, queryEmbedOk: true },
            { queryIndex: 1, queryEmbedOk: false },
          ],
        }),
      },
    ])
    expect(h.ok).toBe(false)
    expect(h.offenders[0]).toMatchObject({ id: 'G01', kind: 'partial-embed-failed' })
  })

  it('**合法空结果**（no-hit / filtered-empty / budget-exhausted）不算降级——拿它拒报告 = 正常空结果变成拿不到数', () => {
    for (const reason of ['no-hit', 'filtered-empty', 'budget-exhausted']) {
      const d = checkDegradation([
        {
          id: 'G02',
          result: result({ reason, queryTraces: [{ queryIndex: 0, queryEmbedOk: true }] }),
        },
      ])
      expect(d.ok).toBe(true)
    }
  })

  it('整链降级（embed-failed）⇒ 拦（钝判据）', () => {
    const d = checkDegradation([
      {
        id: 'G02',
        result: result({
          reason: 'embed-failed',
          queryTraces: [{ queryIndex: 0, queryEmbedOk: true }],
        }),
      },
    ])
    expect(d.ok).toBe(false)
    expect(d.offenders[0]).toMatchObject({ id: 'G02', kind: 'reason-not-ok' })
  })

  it('**值域外**的 reason 也拦（白名单形态的意义：新增 reason 必须显式对齐，不许静默放行）', () => {
    const d = checkDegradation([
      {
        id: 'G03',
        result: result({
          reason: 'some-new-reason',
          queryTraces: [{ queryIndex: 0, queryEmbedOk: true }],
        }),
      },
    ])
    expect(d.ok).toBe(false)
    expect(d.offenders[0].detail).toContain('some-new-reason')
  })

  it('白名单与链段实际值域**逐字对齐**（静态断言：链段新增一个 reason 就会红）', () => {
    const src = readFileSync(
      path.join(REPO_ROOT, 'packages', 'server', 'src', 'memory', 'index.ts'),
      'utf8'
    )
    const start = src.indexOf('export async function runRetrievalChain(')
    const end = src.indexOf('function renderOrder(')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start) // 两个锚点任一改名 ⇒ 空切片会让下面的断言恒真
    const reasons = [...src.slice(start, end).matchAll(/empty\('([^']+)'/g)].map((m) => m[1])
    // `runRetrievalChain` 能返回的非 ok reason 是**闭集**：白名单 + embed-failed（后者由锐判据兜）
    expect(new Set(reasons)).toEqual(new Set([...LEGIT_EMPTY_REASONS, 'embed-failed']))
  })

  it('全好 ⇒ 放行', () => {
    const d = checkDegradation([
      { id: 'G03', result: result({ queryTraces: [{ queryIndex: 0, queryEmbedOk: true }] }) },
    ])
    expect(d.ok).toBe(true)
  })
})

describe('checkCorpusGate — B6 空库闸', () => {
  it('行数为 0 ⇒ 拦（空库/未扫描）', () => {
    expect(checkCorpusGate({ chunksRows: 0, docPaths: 0, liveDocs: 13 }).ok).toBe(false)
  })

  it('doc_path 数与 liveDocs 不等 ⇒ 拦（索引与语料不同步，两个方向都拦）', () => {
    expect(checkCorpusGate({ chunksRows: 395, docPaths: 12, liveDocs: 13 }).ok).toBe(false)
    expect(checkCorpusGate({ chunksRows: 395, docPaths: 14, liveDocs: 13 }).ok).toBe(false)
  })

  it('行数 > 0 且 doc_path 数 == liveDocs ⇒ 放行', () => {
    expect(checkCorpusGate({ chunksRows: 395, docPaths: 13, liveDocs: 13 }).ok).toBe(true)
  })
})

describe('checkIndexFreshness — 索引新鲜度闸（必判第三条）', () => {
  const rows = [
    { docPath: 'docs/a.md', originId: 'sha-a' },
    { docPath: 'docs/b.md', originId: 'sha-b' },
  ]

  it('逐份 blob sha 相同 ⇒ 放行', () => {
    const f = checkIndexFreshness({
      rows,
      hashObject: (p) => (p === 'docs/a.md' ? 'sha-a' : 'sha-b'),
    })
    expect(f.ok).toBe(true)
    expect(f.checked).toBe(2)
  })

  it('**内容改了但节名没变**（最常见形态）⇒ 拦——块数看不出这种漂移', () => {
    const f = checkIndexFreshness({
      rows,
      hashObject: (p) => (p === 'docs/a.md' ? 'sha-a-新' : 'sha-b'),
    })
    expect(f.ok).toBe(false)
    expect(f.stale).toEqual([{ docPath: 'docs/a.md', db: 'sha-a', worktree: 'sha-a-新' }])
  })

  it('文件在工作树里没了（读不到 ⇒ null）⇒ 也算落后（库里留着已删正文）', () => {
    const f = checkIndexFreshness({ rows, hashObject: (p) => (p === 'docs/a.md' ? null : 'sha-b') })
    expect(f.ok).toBe(false)
    expect(f.stale[0].worktree).toBe(null)
  })
})

describe('checkAttributionCoverage — 归因值域自检', () => {
  it('已登记的值域（含 not_topk 下划线形态）⇒ 放行', () => {
    const scores = [
      {
        details: [
          { status: 'dropped', drop: 'not_topk' },
          { status: 'injected', drop: null },
        ],
      },
      { details: [{ status: 'not-recalled', drop: null }] },
    ]
    expect(checkAttributionCoverage(scores).ok).toBe(true)
  })

  it('**未登记的键 ⇒ 拒**（首版把 not_topk 写成 not-topk，汇总表静默少一整类）', () => {
    const c = checkAttributionCoverage([{ details: [{ status: 'dropped', drop: 'not-topk' }] }])
    expect(c.ok).toBe(false)
    expect(c.unknown).toEqual(['not-topk'])
  })

  it('值域表的键与链段实际会产出的值逐字对齐（防未来加值静默）', () => {
    // droppedReason 的三个 probe 值与一个 final 值 + 本脚本自造的 below_topk / not-recalled
    for (const k of ['threshold', 'status', 'not_topk', 'budget', 'below_topk', 'not-recalled']) {
      expect(MISS_RX).toHaveProperty(k)
    }
  })

  it('重搜判出来的 below_topk 也在值域内（它是本脚本自造的状态，最易漏登记）', () => {
    const c = checkAttributionCoverage([{ details: [{ status: 'below_topk', drop: null }] }])
    expect(c.ok).toBe(true)
  })
})

// ─── canary ───────────────────────────────────────────

describe('buildCanaries / evaluateCanary — B2 反对照', () => {
  const canaries = buildCanaries({ docPath: A.doc_path, sectionAnchor: A.section_anchor })

  it('两条 canary 钉在**同一个锚点**上（恒绿与恒红各由一条兜住）', () => {
    expect(canaries).toHaveLength(2)
    expect(canaries[0].expect).toEqual(canaries[1].expect)
    expect(canaries[0].expectKind).toBe('full')
    expect(canaries[1].expectKind).toBe('zero')
  })

  it('必中：query 原文照抄锚点；判据 = 该锚点进了注入集', () => {
    expect(canaries[0].query).toBe(A.section_anchor)
    const hit = evaluateCanary({
      canary: canaries[0],
      result: result({ sections: [sec(A.doc_path, A.section_anchor)] }),
    })
    expect(hit.ok).toBe(true)
    expect(hit.recall).toBe(1)
  })

  it('恒红尺：必中条目没命中 ⇒ ok=false', () => {
    const bad = evaluateCanary({ canary: canaries[0], result: result() })
    expect(bad.ok).toBe(false)
  })

  it('必不中：语料外话题不该召回同一锚点 ⇒ ok=true', () => {
    const miss = evaluateCanary({ canary: canaries[1], result: result({ reason: 'no-hit' }) })
    expect(miss.ok).toBe(true)
    expect(miss.recall).toBe(0)
    expect(canaries[1].query).toBe(CANARY_MISS_QUERY)
  })

  it('恒绿尺：必不中条目反而命中了 ⇒ ok=false（尺子对什么都答「是」）', () => {
    const bad = evaluateCanary({
      canary: canaries[1],
      result: result({ sections: [sec(A.doc_path, A.section_anchor)] }),
    })
    expect(bad.ok).toBe(false)
  })

  it('canary id 常量与构造结果一致（报告/机器通道按 id 对账）', () => {
    expect(canaries.map((c) => c.id)).toEqual([CANARY_HIT_ID, CANARY_MISS_ID])
  })
})

// ─── renderReport ─────────────────────────────────────

describe('renderReport — 确定性与内容面', () => {
  const ctx = () => ({
    date: '2026-01-01',
    dbPath: 'X:/db.sqlite',
    dbRows: 395,
    dbDocs: 13,
    goldenFile: 'X:/golden.json',
    goldenData: { version: 1, entries: [], meta: { frozenCorpusRef: 'abc' } },
    goldenCounts: { real: 12, constructed: 23, negative: 5 },
    liveDocs: 13,
    rotten: 0,
    indexFreshness: { checked: 13, stale: 0 },
    params: { maxDistance: 0.6, topK: 3, probeN: 20 },
    embed: { model: 'm', dim: 512, port: 1660 },
    groups: {
      real: {
        n: 1,
        scoredN: 1,
        expectTotal: 1,
        hit: 1,
        recallMean: 1,
        microRecall: 1,
        preThreshold: 0,
        preThresholdRateMean: 0,
        microPreThresholdRate: 0,
      },
      constructed: {
        n: 1,
        scoredN: 1,
        expectTotal: 1,
        hit: 0,
        recallMean: 0,
        microRecall: 0,
        preThreshold: 1,
        preThresholdRateMean: 1,
        microPreThresholdRate: 1,
      },
    },
    scores: [
      {
        id: 'G01',
        kind: 'real',
        reason: 'ok',
        expectTotal: 1,
        hit: 1,
        recall: 1,
        preThreshold: 0,
        details: [{ docPath: 'd', sectionAnchor: 's', status: 'injected', drop: null }],
        forbidHit: [],
      },
      {
        id: 'C01',
        kind: 'constructed',
        reason: 'ok',
        expectTotal: 1,
        hit: 0,
        recall: 0,
        preThreshold: 1,
        details: [
          {
            docPath: 'd2',
            sectionAnchor: 's2',
            status: 'dropped',
            drop: 'threshold',
            distance: 0.75,
            channel: 'vector',
          },
        ],
        forbidHit: [],
      },
      {
        id: 'C02',
        kind: 'constructed',
        reason: 'ok',
        expectTotal: 2,
        hit: 0,
        recall: 0,
        preThreshold: 0,
        details: [
          {
            docPath: 'd3',
            sectionAnchor: 's3',
            status: 'below_topk',
            drop: null,
            distance: 0.45,
            channel: 'vector',
            queryIndex: 1,
            rank: 5,
          },
          // 覆盖洞：连重搜都够不着 ⇒ 无距离、无通道
          { docPath: 'd4', sectionAnchor: 's4', status: 'not-recalled', drop: null },
        ],
        forbidHit: [],
      },
    ],
    canary: [
      {
        id: CANARY_HIT_ID,
        query: 'q1',
        expectKind: 'full',
        reason: 'ok',
        recall: 1,
        ok: true,
        forbidHit: [],
      },
      {
        id: CANARY_MISS_ID,
        query: CANARY_MISS_QUERY,
        expectKind: 'zero',
        reason: 'no-hit',
        recall: 0,
        ok: true,
        forbidHit: [],
      },
    ],
    negatives: [
      {
        id: 'N01',
        kind: 'negative',
        reason: 'ok',
        expectTotal: 1,
        hit: 0,
        recall: 0,
        preThreshold: 0,
        details: [],
        forbidHit: [{ docPath: 'd3', sectionAnchor: 's3' }],
      },
    ],
    maxDistance: 0.6,
    recheck: { entries: 2 },
  })

  it('同输入必同输出（B1 的实现面）', () => {
    expect(renderReport(ctx())).toBe(renderReport(ctx()))
  })

  it('章节号连续且无重复（首版两个「## 三」并列）', () => {
    const heads = renderReport(ctx())
      .split('\n')
      .filter((l) => l.startsWith('## '))
      .map((l) => l.slice(3, 4))
    expect(new Set(heads).size).toBe(heads.length)
  })

  it('canary / 负例 / 归因三节都在，且不含任何时间量', () => {
    const md = renderReport(ctx())
    expect(md).toContain('canary')
    expect(md).toContain('N01')
    expect(md).toContain('threshold')
    expect(md).toContain(`schema | ${BASELINE_REPORT_SCHEMA}`)
    // 时间量不进报告：耗时/端口出现即破坏 B1（同树同库两跑字节一致）
    expect(md).not.toMatch(/retrievalMs|耗时|ms\b/)
  })

  it('归因表遍历值域：数据里出现的键必须被列出（不许静默吞）', () => {
    const md = renderReport(ctx())
    expect(md).toContain('| threshold | 1 |')
    expect(md).toContain('| below_topk | 1 |')
  })

  it('索引新鲜度读数**随数据变**（不是恒真的 `checked/checked` + `stale=0` 字面量）', () => {
    expect(renderReport({ ...ctx(), indexFreshness: { checked: 13, stale: 3 } })).toContain(
      '10/13 份同步（stale=3）'
    )
  })

  it('嵌入供给形态也按**实测**报：没握手到监听端口就打警告（同族：报告里的自述必须来自读数）', () => {
    const ok = renderReport(ctx())
    expect(ok).toContain('实测已握手')
    expect(ok).not.toContain('⚠️ **未见 sidecar 监听端口**')
    const bad = renderReport({ ...ctx(), embed: { model: 'm', dim: 512, port: undefined } })
    expect(bad).toContain('⚠️ **未见 sidecar 监听端口**')
    // 端口号本身不进报告（每跑一个随机值 ⇒ 破 B1）
    expect(ok).not.toMatch(/端口\D{0,8}\d{2,}/)
  })

  it('§二 带未召回锚点读数：最大距离 / 阈值杀几条 / 真覆盖洞三个数都从数据算', () => {
    const md = renderReport(ctx())
    expect(md).toContain('未召回锚点读数')
    expect(md).toContain('最大 0.7500')
    expect(md).toContain('距离 ≥ 阈值的有 **1** 处')
    expect(md).toContain(
      `连重搜（阈值放宽到 ${RECHECK_MAX_DISTANCE}）都够不着的 **1** 处 = 真覆盖洞`
    )
  })

  it('全在阈值内 ⇒ 报告写「阈值一条都没杀」（判词随数据翻转，不是写死的结论）', () => {
    const c = ctx()
    c.scores = [c.scores[2]] // 只留 below_topk(0.45) + 覆盖洞那条
    const md = renderReport(c)
    expect(md).toContain('阈值一条都没杀')
    expect(md).not.toContain('松阈值可救回')
  })

  it('§七 计数单位 = (条目, 锚点) 对，并给出**去重后**的锚点数', () => {
    const md = renderReport(ctx())
    expect(md).toContain('未召回归因合计 3 **处**')
    expect(md).toContain('去重后 3 个不同锚点')
  })
})

describe('missLabel — 明细表的归因标签', () => {
  it('below_topk 带上「哪条查询、池内第几名、距离」（判它是重搜判出来的，得可复核）', () => {
    expect(
      missLabel({
        status: 'below_topk',
        drop: null,
        queryIndex: 2,
        rank: 16,
        distance: 0.4724,
        channel: 'vector',
      })
    ).toBe('below_topk q2 rank=16 dist=0.4724')
  })

  it('关键词通道召回的 below_topk 不带距离（没有距离概念）', () => {
    expect(
      missLabel({ status: 'below_topk', drop: null, queryIndex: 0, rank: 3, distance: null })
    ).toBe('below_topk q0 rank=3')
  })

  it('其余归因原样输出（dropped 用 drop、无 drop 用 status）+ 距离', () => {
    expect(missLabel({ status: 'dropped', drop: 'not_topk', distance: 0.4998 })).toBe(
      'not_topk dist=0.4998'
    )
    expect(missLabel({ status: 'not-recalled', drop: null, distance: null })).toBe('not-recalled')
  })

  it('**每个**带距离的未命中锚点都打出 dist（§二 的最大值要能在表里核到出处）', () => {
    for (const key of ['threshold', 'status', 'not_topk', 'budget', 'section_dup']) {
      expect(missLabel({ status: 'dropped', drop: key, distance: 0.5 })).toContain('dist=0.5000')
    }
  })
})

// ─── CLI 参数 ─────────────────────────────────────────

describe('parseArgs', () => {
  it('认全部开关；未知参数不吞后面的值', () => {
    const a = parseArgs([
      '--root',
      '/r',
      '--db',
      '/d.db',
      '--env',
      '/e',
      '--date',
      '2026-01-01',
      '--out',
      '/o.md',
    ])
    expect(a).toEqual({
      root: '/r',
      db: '/d.db',
      env: '/e',
      date: '2026-01-01',
      out: '/o.md',
      help: false,
    })
  })

  it('--help', () => {
    expect(parseArgs(['--help']).help).toBe(true)
  })

  it('缺省全 null（缺省值在 main 里落，不在解析器里埋）', () => {
    expect(parseArgs([])).toEqual({
      root: null,
      db: null,
      env: null,
      date: null,
      out: null,
      help: false,
    })
  })
})

// ─── 契约静态断言（脚本是 .mjs，类型系统兜不住的接缝） ────

describe('与链段结果对象的字段名契约（静默全灭面）', () => {
  const src = readFileSync(
    path.join(REPO_ROOT, 'packages', 'server', 'src', 'memory', 'index.ts'),
    'utf8'
  )

  it('链段仍导出 runRetrievalChain(queries, opts.startedAt)', () => {
    expect(src).toContain('export async function runRetrievalChain(')
    expect(src).toMatch(/rawQueries: string\[\]/)
    expect(src).toMatch(/startedAt\?: number/)
  })

  it('结果对象用 **camelCase**（`docPath`）而黄金集用 snake_case（`doc_path`）——两侧一旦被「统一」，评分静默全灭', () => {
    expect(src).toContain('export interface RetrievedSection')
    expect(src).toMatch(/docPath: string/)
    expect(src).toMatch(/sectionAnchor: string/)
    // 候选流水（final / probe 两路）产出的也是 camelCase
    expect(src).toContain('docPath: s.row.doc_path')
    expect(src).toContain('docPath: c.docPath')
    expect(src).toContain('droppedReason:')
  })
})

// ─── E1 契约 A：JSON 副产品 ────────────────────────────

describe('buildReportJson / reportJsonPath — JSON 副产品（E1 契约 A）', () => {
  const ctxFixture = () => ({
    date: '2026-01-01',
    dbRows: 410,
    groups: { real: { recallMean: 0.5833 }, constructed: { recallMean: 0.8261 } },
    scores: [{ id: 'G01' }],
  })

  it('路径：同目录、同基名，只换扩展名', () => {
    expect(reportJsonPath(path.join('a', 'b', 'retrieval-baseline-2026-01-01.md'))).toBe(
      path.join('a', 'b', 'retrieval-baseline-2026-01-01.json')
    )
  })

  it('路径：`--out` 指到别的扩展名 / 没扩展名 ⇒ 都恒得 `.json`', () => {
    // `outFile.replace(/\.md$/, '.json')` 那种写法会拼出 `x.txt.json`——同目录多出一份
    // 没人认得名的文件，而报告清单只认 `retrieval-baseline-<date>.json`
    expect(reportJsonPath(path.join('a', 'x.txt'))).toBe(path.join('a', 'x.json'))
    expect(reportJsonPath(path.join('a', 'noext'))).toBe(path.join('a', 'noext.json'))
  })

  it('内容 = 顶层 `schema` + **同一份** ctx（`toBe` 同引用，不是深拷贝或重拼）', () => {
    const ctx = ctxFixture()
    const out = buildReportJson(ctx)
    expect(out.schema).toBe(BASELINE_REPORT_SCHEMA)
    // 逐字段**同引用**：两份视图数字对不上是这类「顺手多落一份」最典型的坏法，
    // 而同引用能从结构上排除「json 那边自己又算了一遍」
    for (const [k, v] of Object.entries(ctx)) expect(out[k]).toBe(v)
    expect(Object.keys(out).sort()).toEqual([...Object.keys(ctx), 'schema'].sort())
  })

  it('一处算两处渲染（静态）：md 与 json 吃的是**同一个 `reportCtx` 标识符**', () => {
    const src = readFileSync(
      path.join(REPO_ROOT, 'scripts', 'eval', 'retrieval-baseline.mjs'),
      'utf8'
    )
    const start = src.indexOf('const reportCtx = {')
    // 终点取**两笔写之后**的锚（不能取 `writeFileSync(jsonOutFile`——那正是 `buildReportJson`
    // 调用所在的行，切在它上面会把要断言的调用本身排除在外）
    const end = src.indexOf('const redCount', start)
    expect(start).toBeGreaterThan(-1)
    // 锚点任一改名 ⇒ 空切片会让下面的断言恒真（同「逐条跑批」那条的写法）
    expect(end).toBeGreaterThan(start)
    const seg = src.slice(start, end)
    expect(seg).toContain('renderReport(reportCtx)')
    expect(seg).toContain('buildReportJson(reportCtx)')
    // 旁路面：json 那边不得自己再拼一份 ctx
    expect(seg).not.toMatch(/buildReportJson\(\{/)
  })

  it('拒出路径 ⇒ md 与 json **都不落**（真跑 `main`，打到 golden-schema 闸）', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'rb-refuse-'))
    const outFile = path.join(root, 'out', 'retrieval-baseline-2026-01-01.md')
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      // `main` 进 root 后第一件事就是 import 它的 env.js——给个空实现，让流程能走到黄金集闸
      mkdirSync(path.join(root, 'packages', 'server', 'src'), { recursive: true })
      writeFileSync(path.join(root, 'packages', 'server', 'src', 'env.js'), '')
      mkdirSync(path.join(root, 'docs', 'eval'), { recursive: true })
      // schema 不过的黄金集 ⇒ `refuse('golden-schema')`；这道闸在**碰库、起 sidecar 之前**，
      // 所以本用例不需要 526MB 实验库与嵌入 sidecar（那是系统级 e2e 那一档）
      writeFileSync(path.join(root, 'docs', 'eval', 'retrieval-golden.json'), '{"version":1}')

      const code = await main(['--root', root, '--out', outFile])

      expect(code).toBe(1)
      // 确认打到的**就是** golden-schema 那道闸，而不是某个更早的意外返回（否则这条用例
      // 会在「什么都没发生」的情况下绿）
      const emitted = stdout.mock.calls.map((c) => String(c[0])).join('')
      expect(emitted).toContain('"phase":"golden-schema"')
      expect(emitted).toContain('"ok":false')
      // 两份都不落：产一份半截产物会被读成「跑过了，没问题」
      expect(existsSync(outFile)).toBe(false)
      expect(existsSync(reportJsonPath(outFile))).toBe(false)
    } finally {
      stdout.mockRestore()
      stderr.mockRestore()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
