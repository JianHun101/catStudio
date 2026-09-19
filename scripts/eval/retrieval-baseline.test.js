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
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  BASELINE_REPORT_SCHEMA,
  CANARY_HIT_ID,
  CANARY_MISS_ID,
  CANARY_MISS_QUERY,
  MISS_RX,
  REPO_ROOT,
  anchorKey,
  buildCanaries,
  checkAttributionCoverage,
  checkCorpusGate,
  checkDegradation,
  checkEmbedHealth,
  checkIndexFreshness,
  evaluateCanary,
  fmt4,
  localDate,
  parseArgs,
  renderReport,
  scoreEntry,
  summarizeGroup,
} from './retrieval-baseline.mjs'

// ─── 夹具 ─────────────────────────────────────────────

/** 造一个链段结果（只保留评分要读的字段；形状对齐 `MemoryContextResult`） */
function result({ sections = [], candidates = [], queryTraces = [], reason = 'ok' } = {}) {
  return { text: '', reason, sections, stats: { candidates, queryTraces } }
}

/** 造一个已注入的节 */
const sec = (docPath, sectionAnchor) => ({ docPath, sectionAnchor })

/** 造一条候选流水（`source` + `droppedReason` 是评分唯一读的两列） */
const cand = (docPath, sectionAnchor, source, droppedReason) => ({
  docPath,
  sectionAnchor,
  source,
  droppedReason,
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

  it('嵌入全好但 reason 非 ok ⇒ checkDegradation 也拦（钝判据）', () => {
    const d = checkDegradation([
      {
        id: 'G02',
        result: result({ reason: 'no-hit', queryTraces: [{ queryIndex: 0, queryEmbedOk: true }] }),
      },
    ])
    expect(d.ok).toBe(false)
    expect(d.offenders[0]).toMatchObject({ id: 'G02', kind: 'reason-not-ok' })
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
    // droppedReason 的三个 probe 值与一个 final 值 + 本脚本自造的 not-recalled
    for (const k of ['threshold', 'status', 'not_topk', 'budget', 'not-recalled']) {
      expect(MISS_RX).toHaveProperty(k)
    }
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
    embed: { model: 'm', dim: 512 },
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
        details: [{ docPath: 'd2', sectionAnchor: 's2', status: 'dropped', drop: 'threshold' }],
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
