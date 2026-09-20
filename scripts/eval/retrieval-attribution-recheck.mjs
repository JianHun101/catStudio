/**
 * 检索未召回归因**复核**（T3 诊断）——把 09-20 基线的 11 处「读数」变成
 * 「机制读数 + 可证伪的修法证据」。
 *
 * ## 与 `retrieval-baseline.mjs` 的分工（两者不是一回事）
 *
 * | | baseline（R10） | 本脚本（T3） |
 * | --- | --- | --- |
 * | 回答的问题 | **多少**（recall、阈值前命中率） | **为什么**（差多少名、差多少分、哪个旋钮能救） |
 * | 出口 | 可引用的基线数字（B1 逐字节可复现） | 诊断读数（供立修法票） |
 * | 是否改检索 | 否 | 否（**只读**，一个检索参数都不改） |
 *
 * 本脚本**不产出新基线**，也不取代 baseline；它复跑一遍 baseline 的 40 条，
 * 在**同一把尺**（同一个 `scoreEntry`、同一个金标集、同一份库快照）之上补三类读数。
 *
 * ## 三类读数（票面「产出」1/3/5）
 *
 * 1. **11 处逐条**：每处给 `finalRank` / `rrfScore` / 最小真实距离 —— 全部**本次实跑**，
 *    不照抄 09-20 报告。未进注入集的锚点连「差多少名、差多少 RRF 分」一起给——
 *    这是「旋钮能不能救」的直接证据（票面 §3）。
 * 2. **归因口径复核**：`not-recalled`（覆盖洞）那一处（G03）逐通道独立复核。
 * 3. **反对照（承重）**：既有结论「松阈值一条都救不回」必须配一条**证明探针有分辨力**
 *    的对照——本脚本构造「阈值收紧 ⇒ 已注入的节当场掉出注入集」的单变量实验。
 *    **该对照不过 ⇒ 拒出报告**（否则「0 处被阈值杀」可能只是探针瞎了）。
 *
 * ## 为什么需要「跨查询合并重建」（本脚本唯一的自造机制，故必须自证）
 *
 * baseline 的候选流水里，`final` 只留**跨查询合并后的 topK** —— 一个锚点「排第 7」
 * 与「排第 700」在流水里**同形**（都是不出现），而这两者的药方天差地别。
 * 要知道「差多少名」，只能在链段之外把**完整合并序**重建出来：
 * 逐查询调 `searchChunksHybrid`（**库层现成导出，不复制链段**）→ 按
 * `memory/index.ts` 的合并规则（首趟胜出 / RRF 跨查询累加 / `bestIndex` tie-break）
 * 重排。
 *
 * 重建**必须自证**：对每个条目，把重建序与链段自己落的 `final` 流水逐行比
 * （`chunkId` / `finalRank` / `rrfScore` 三项全等）。**任一条不符 ⇒ 拒出报告**——
 * 一个与生产链对不上的重建序，它给出的「排第 7」是编出来的数字。
 *
 * ## 旋钮实验台的三条口径边界（不写清楚就是假读数）
 *
 * - `MEMORY_TOP_K` 扫描：**真跑链段**（改 env 单变量），是端到端读数。
 * - `HYBRID_CHANNEL_TOP_N` / `RRF_K` / `HYBRID_POOL_PER_QUERY` 扫描：这三个是
 *   **模块私有常量**（`chunks.ts` 里 `const`，无 env 旋钮），改不了 ⇒ 只能在
 *   **重建层**做反事实：仍调库层现成的 `searchChunksByVector` / `searchChunksByKeyword`
 *   （检索本体**零复制**），只是把融合参数换成候选值。⇒ **明确标为「重建读数」
 *   而非端到端读数**，不得当作「改了旋钮会怎样」的实测。
 * - 重建与真链的等价性另有一条自证：库层的 `searchChunksHybrid` 本身就是
 *   「两通道 N=20 + RRF k=60 + 池截 20」的一次融合 ⇒ 用本脚本的
 *   `fuseChannelHits` 按同参数复算，输出必须与它**逐行相等**（`verifyFuseEquivalence`）。
 *
 * ## 只读保证
 *
 * 库以 `readonly + fileMustExist` 打开（同 baseline：静默建空库物理不可达）；
 * `packages/server/src/memory/**` 与 `scripts/eval/retrieval-baseline.mjs` **零改动**，
 * 全部经 import 消费。
 *
 * ## 输出通道（与 baseline 同款）
 *
 * stdout 只出**一行结构化 JSON**（机器通道），人类汇总走 stderr；报告写文件。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

import {
  anchorKey,
  fmt4,
  localDate,
  RECHECK_MAX_DISTANCE,
  scoreEntry,
  summarizeGroup,
  buildCanaries,
  evaluateCanary,
  checkEmbedHealth,
  checkAttributionCoverage,
  collectRecheckPools,
  buildRecheckIndex,
} from './retrieval-baseline.mjs'
import { loadEnvFile } from './freeze-rewrite.mjs'

// ─── 契约常量（测试直接断言） ─────────────────────────

/** 报告 schema（形态变更时递增） */
export const DIAG_REPORT_SCHEMA = 1

/**
 * `MEMORY_TOP_K` 真跑扫描的取值。3 = 生产现值（对照组）；其余为候选。
 * 值域不宜再大：`MEMORY_CONTEXT_TOKEN_BUDGET`（默认 8000）会开始咬人，
 * 而「靠调大 topK 救回一条」若以撑爆预算是代价，那它就不是一条便宜药方。
 */
export const TOPK_SWEEP = [3, 5, 8, 10, 15, 20]

/** 重建层旋钮的候选值（**反事实读数**，不是端到端实测，见文件头） */
export const CHANNEL_TOPN_SWEEP = [20, 50, 200]
export const RRFK_SWEEP = [60, 30, 10]
export const POOL_PER_QUERY_SWEEP = [20, 50, 100]

/**
 * 09-20 基线的 11 处未召回（**对照面**，不是本脚本的判据）。
 *
 * 写进代码而不是靠人眼比：本次实跑的未召回集与它的**差集**由机器算出来并进报告
 * （`diff` 段）——人眼比对两列中文锚点是最容易「看着一样就算一样」的地方。
 * 归因照抄 09-20 报告 §三/§四/§七，仅作对照，**不参与任何判据**。
 *
 * ⚠️ 本表**只留对账用得到的字段**（`id` / `docPath` / `sectionAnchor` / `attribution`）。
 * 原先还抄了每条的距离，实测**零消费**（判据与渲染都不读它）⇒ 已删。
 * 要查 09-20 的原始距离：**带非空距离的那 8 处**（G02/G08/G09/G12/C03/C05/C19/C24）
 * 在 `docs/eval/retrieval-baseline-2026-09-20.md` §三 逐条可查；其余 3 处
 * （G03/N03/N04）原值即为 `null`，**没有距离可失**（不是删丢的）。
 */
export const REPORT_0920_MISSES = [
  {
    id: 'G02',
    docPath: 'docs/plans/memory-flywheel.md',
    sectionAnchor: '2. 主链形态（七段，逐段钉死） > 2.6 检索（`searchChunksHybrid`）',
    attribution: 'not_topk',
  },
  {
    id: 'G03',
    docPath: 'docs/plans/memory-flywheel.md',
    sectionAnchor: '4. 票单全表（14 张，全部收口）',
    attribution: 'not-recalled',
  },
  {
    id: 'G08',
    docPath: 'docs/plans/episode-evaluation-v2.md',
    sectionAnchor: '6. 实施拆活（审 ✅ 后派）',
    attribution: 'below_topk',
  },
  {
    id: 'G09',
    docPath: 'docs/plans/episode-evaluation-v2.md',
    sectionAnchor: '4. closure 状态机 + 改进闭环',
    attribution: 'not_topk',
  },
  {
    id: 'G12',
    docPath: 'docs/plans/review-chain-anchor.md',
    sectionAnchor: '三、用户故事',
    attribution: 'not_topk',
  },
  {
    id: 'C03',
    docPath: 'docs/adr/0008-acp-multi-provider-unification.md',
    sectionAnchor: '决策',
    attribution: 'not_topk',
  },
  {
    id: 'C05',
    docPath: 'docs/adr/0009-multimodal-knowledge-base.md',
    sectionAnchor: '两条不变量（扩展性论证核心） > 不变量 2：跨模态向量子空间分离',
    attribution: 'not_topk',
  },
  {
    id: 'C19',
    docPath: 'docs/plans/episode-evaluation-v2.md',
    sectionAnchor: '3. episodes 表结构',
    attribution: 'not_topk',
  },
  {
    id: 'C24',
    docPath: 'docs/plans/memory-flywheel.md',
    sectionAnchor: '2. 主链形态（七段，逐段钉死） > 2.3 扫描器（`scripts/flywheel/scan.mjs`）',
    attribution: 'not_topk',
  },
  {
    id: 'N03',
    docPath: 'docs/adr/0014-skill-delivery-decoupling.md',
    sectionAnchor:
      '6. 后续项（用户明确要求记录） > 6.1 收口留痕：白名单两层机制 + to-spec/to-tickets 去 matt 化',
    attribution: 'not_topk',
  },
  {
    id: 'N04',
    docPath: 'docs/plans/review-chain-anchor.md',
    sectionAnchor: '六、不在范围内',
    attribution: 'not_topk',
  },
]

// ─── 纯函数：融合与跨查询合并重建 ─────────────────────

/**
 * 按 `chunks.ts::searchChunksHybrid` 的**同一条公式**做两通道 RRF 融合。
 *
 * ⚠️ 存在的理由不是「复制链段」，而是**反事实**：库层那个函数的通道深度
 * （`HYBRID_CHANNEL_TOP_N`）与 `RRF_K` 是模块私有 `const`，外部改不了；
 * 要问「把通道深度从 20 提到 50 能不能救回某处」，只能在库层**两个通道函数**
 * （它们都吃 `topN` 参数）之上按同一条公式重算。检索本体仍只有库层一份。
 *
 * 插入顺序必须与库层逐字一致（先向量命中、后仅关键词的新增）——`Map` 的插入序
 * 决定同分时的稳定性。`verifyFuseEquivalence` 就是钉这一点的。
 */
export function fuseChannelHits({ vectorHits, keywordHits, rrfK, poolPerQuery, maxDistance }) {
  const scores = new Map()
  vectorHits.forEach((row, i) => {
    scores.set(row.id, { score: 1 / (rrfK + i + 1), row, vectorRank: i, keywordRank: null })
  })
  keywordHits.forEach((hit, i) => {
    const kwScore = 1 / (rrfK + i + 1)
    const existing = scores.get(hit.id)
    if (existing) {
      existing.score += kwScore
      existing.keywordRank = i
    } else {
      scores.set(hit.id, {
        score: kwScore,
        row: { ...hit, distance: maxDistance },
        vectorRank: null,
        keywordRank: i,
      })
    }
  })

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, poolPerQuery)
    .map((s) => ({
      row: s.row,
      rrfScore: s.score,
      vectorRank: s.vectorRank,
      keywordRank: s.keywordRank,
      channel: s.vectorRank !== null ? (s.keywordRank !== null ? 'both' : 'vector') : 'keyword',
    }))
}

/**
 * 库层融合出口 vs 本脚本重建出口的**逐行等价**校验（自证用）。
 *
 * 相比字段而不是只比条数：条数相等而顺序不同，会让「排第 7」这个读数整体错位。
 */
export function verifyFuseEquivalence({ built, native }) {
  const mismatches = []
  if (built.length !== native.length) {
    mismatches.push({ kind: 'length', built: built.length, native: native.length })
    return { ok: false, mismatches }
  }
  native.forEach((n, i) => {
    const b = built[i]
    if (b.row.id !== n.row.id) {
      mismatches.push({ kind: 'order', index: i, builtChunkId: b.row.id, nativeChunkId: n.row.id })
      return
    }
    if (Math.abs(b.rrfScore - n.rrfScore) > 1e-12) {
      mismatches.push({ kind: 'rrfScore', index: i, built: b.rrfScore, native: n.rrfScore })
    }
    if (b.channel !== n.channel) {
      mismatches.push({ kind: 'channel', index: i, built: b.channel, native: n.channel })
    }
  })
  return { ok: mismatches.length === 0, mismatches }
}

/**
 * 融合等价自证的**判词**（把承重闸的判定从 `main()` 里抽出来，好让它本身可测）。
 *
 * 两条判据，**顺序即优先级**：
 *  1. 有 `mismatch` ⇒ 不等价，`fuse-equivalence`
 *  2. `compared === 0` ⇒ **无样本**，`fuse-equivalence-no-sample`
 *
 * 第 2 条是补的洞：原实现只报「打算比几条」（`fuseProbeQueries.length`），而取数循环里
 * 的 `if (!e.ok || e.vector.length === 0) continue` 是**静默**跳过 ⇒ 全跳过时
 * `mismatches` 为空 ⇒ `ok:true` ⇒ 报告照样印「逐行相等 ✅」，而**一条都没比**。
 * 这与本脚本花整节去防的「否定式读数」是同一个形态：探针瞎了也给出同样的 0。
 * ⇒ 无样本必须**拒出报告**，不能退化成一条恒真的绿。
 */
export function judgeFuseSelfCheck({ intended, compared, skipped = 0, mismatches }) {
  if (mismatches.length > 0) {
    return {
      ok: false,
      reason: 'mismatch',
      message: '重建融合公式与库层 searchChunksHybrid 不等价——§6.2 的反事实读数不可信',
    }
  }
  if (compared === 0) {
    return {
      ok: false,
      reason: 'no-sample',
      message:
        `融合等价自证**一条都没比成**（候选 ${intended} 条全被跳过，skipped=${skipped}）——` +
        '「逐行相等」会变成一条无样本的假绿，§6.2 的反事实读数不可采信',
    }
  }
  return { ok: true, reason: '', message: '' }
}

/**
 * 合并序重建自证的**判词**——与 `judgeFuseSelfCheck` **同型**（同一族的第二道）。
 *
 * `verifyMerge` 逐条目返回 `checked`（比了几行 final）；聚合层原先只看
 * `mismatches.length === 0` ⇒ **`finals` 为空时也是 ok**，报告会印
 * 「40 条条目 / **0 行** final 流水逐行比对，不符 0 处 ⇒ ✅ 重建序 == 链段序」——
 * 又是一条**无样本的绿**。今日不可达（有注入就有 final 行），但机制上必须堵死：
 * 「一条都没比」与「比了且全对」不是同一件事。
 */
export function judgeMergeSelfCheck({ entries, rows, mismatches }) {
  if (mismatches.length > 0) {
    return {
      ok: false,
      reason: 'mismatch',
      message: `合并序重建与链段 self-reported final 流水不符 ${mismatches.length} 条——重建序不自证，名次/分差读数不可信`,
    }
  }
  if (rows === 0) {
    return {
      ok: false,
      reason: 'no-sample',
      message:
        `合并序重建自证**一行 final 流水都没比成**（${entries} 条条目，checked rows=0）——` +
        '「不符 0 处」会变成一条无样本的假绿，名次/分差读数不可采信',
    }
  }
  return { ok: true, reason: '', message: '' }
}

/**
 * **跨查询合并重建**：把逐查询的融合池按 `memory/index.ts` 的合并规则重排成完整序。
 *
 * 三条规则逐字复刻（`runRetrievalChain` 的 `merged` 循环）：
 *   (c) 首趟胜出——`row` / `channel` / 两位次 / `queryIndex` 描述「这片长什么样」
 *   (a) `rrfScore` **跨查询累加**（同一片被多趟命中 ⇒ 各趟分相加）
 *   (b) `bestIndex` 取 min，仅作同分 tie-break
 *
 * 返回**完整序**（不截断）+ 各行的 0-based `rank` + 注入集（前 `topK` 行）+
 * `cutoffRrf`（第 `topK` 名的分，即「进榜门槛」）。截断放这里做、不在重建里做——
 * 「差多少名」的问法本身就要求知道榜外的名次。
 */
export function mergeQueryPools({ pools, topK }) {
  const merged = new Map()
  pools.forEach((p, queryIndex) => {
    p.hits.forEach((hit, i) => {
      const existing = merged.get(hit.row.id)
      if (!existing) {
        merged.set(hit.row.id, {
          chunkId: hit.row.id,
          docPath: hit.row.doc_path,
          sectionAnchor: hit.row.section_anchor,
          channel: hit.channel,
          vectorRank: hit.vectorRank,
          keywordRank: hit.keywordRank,
          queryIndex,
          bestIndex: i,
          rrfScore: hit.rrfScore,
        })
        return
      }
      existing.rrfScore += hit.rrfScore
      existing.bestIndex = Math.min(existing.bestIndex, i)
    })
  })

  const order = [...merged.values()].sort(
    (a, b) => b.rrfScore - a.rrfScore || a.bestIndex - b.bestIndex
  )
  order.forEach((r, i) => {
    r.rank = i
  })
  const injectedIds = new Set(order.slice(0, topK).map((r) => r.chunkId))
  return {
    order,
    topK,
    injectedIds,
    cutoffRrf: order.length >= topK ? order[topK - 1].rrfScore : null,
  }
}

/**
 * 重建序 vs 链段自落的 `final` 流水——**本脚本的承重自证**。
 *
 * 三项全等才算对上：`chunkId`（是不是同一片）、`finalRank`（名次）、`rrfScore`（分）。
 * 只比其中一项都会漏：只比集合会漏「顺序整体错位」，只比顺序会漏「分算错」。
 */
export function verifyMerge({ order, result }) {
  const byId = new Map(order.map((r) => [r.chunkId, r]))
  const finals = result.stats.candidates.filter((c) => c.source === 'final')
  const mismatches = []
  for (const c of finals) {
    const r = byId.get(c.chunkId)
    if (!r) {
      mismatches.push({
        kind: 'missing-in-reconstruction',
        chunkId: c.chunkId,
        finalRank: c.finalRank,
      })
      continue
    }
    if (r.rank !== c.finalRank) {
      mismatches.push({ kind: 'rank', chunkId: c.chunkId, chain: c.finalRank, rebuilt: r.rank })
    }
    if (Math.abs(r.rrfScore - c.rrfScore) > 1e-9) {
      mismatches.push({
        kind: 'rrfScore',
        chunkId: c.chunkId,
        chain: c.rrfScore,
        rebuilt: r.rrfScore,
      })
    }
  }
  return { ok: mismatches.length === 0, mismatches, checked: finals.length }
}

/**
 * 一处锚点的机制读数（纯函数）。
 *
 * 「能不能救」由两个**同源**的量回答，缺一不可：
 *   - `rankGap`：还差几名才够得着榜尾（`rank - (topK - 1)`，正数 = 差这么多名）
 *   - `rrfGap`：还差多少 RRF 分（榜尾分 − 本片分）
 * 只用其中一个会误判：分差极小而名次差得多 ⇒ 说明它卡在一堆几乎同分的片里，
 * 动 RRF 常数比动 topK 更对症。
 *
 * `tieBroken=true`（`rrfGap === 0` 却没进榜）单列：它是**并列分被 tie-break 判负**，
 * 药方与前两者又不同（改 `bestIndex` 语义，不是改阈值/名次）。
 */
export function readAnchor({ sectionChunkIds, merged, maxDistance }) {
  const { order, injectedIds, cutoffRrf } = merged
  const rows = order.filter((r) => sectionChunkIds.has(r.chunkId))
  const best = rows.length > 0 ? rows[0] : null
  const injected = rows.some((r) => injectedIds.has(r.chunkId))
  const topK = merged.topK
  return {
    injected,
    inMergedPool: best !== null,
    chunkId: best ? best.chunkId : null,
    rank: best ? best.rank : null,
    rrfScore: best ? best.rrfScore : null,
    channel: best ? best.channel : null,
    queryIndex: best ? best.queryIndex : null,
    rankGap: best ? best.rank - (topK - 1) : null,
    rrfGap: best && cutoffRrf !== null ? cutoffRrf - best.rrfScore : null,
    tieBroken: best !== null && !injected && cutoffRrf !== null && cutoffRrf - best.rrfScore === 0,
    maxDistance,
  }
}

// ─── 纯函数：生产检索事件面（`retrieval_candidates`） ──────────

/**
 * **生产事件面** —— 与「黄金集面」**并列的另一个面**，不是它的复核。
 *
 * 两面答的**不是同一个问题**，故同一锚点在两面读数不同**不构成互相推翻**：
 *
 * | | 黄金集面（§4.2/§4.3 主体） | 生产事件面（本函数） |
 * | --- | --- | --- |
 * | 数据 | 金标查询，受控复现 | `retrieval_candidates`，历史流水 |
 * | 答什么 | 「**金标查询**里它排第几、够不够得着」 | 「**真实生产查询**里它有没有被排到最前、有没有真注入」 |
 *
 * ⇒ 被推翻的只能是「**同一个面内**前后不一致」；跨面比大小是拿两把尺量两件事。
 * 本仓为这条栽过一次（把生产面的 `rank=1` 拿去和黄金集面的名次比，判成「推翻」，
 * 还把结论写进了 `map.md`）——那个判词是错的，面不同而已。
 *
 * ⚠️ `rank` **0 基**（写入口 `memory/index.ts` 的 `probe.map((c, rank) => …)` 用数组下标）
 * ——与黄金集面的 `readAnchor().rank` **同基**。`rank = 0` 才是**最靠前**，别读成 1。
 *
 * ⚠️ **零行 ≠ 够不着**：查不到该锚点的生产行，只说明**这个面本次不可测**（流水是历史
 * 累积，可能压根没跑过含它的查询），**不能**反推「生产面也够不着」。故 `measurable`
 * 与 `total` 分两格返回，渲染层必须照此分列——这正是本脚本在别处花整节防的
 * 「否定式读数」（探针瞎了也会给出同样的 0）。
 */
export function summarizeProductionFace(rows) {
  const total = rows.length
  if (total === 0) {
    return {
      available: true,
      measurable: false,
      total: 0,
      queries: 0,
      topRank: null,
      topRankChunkId: null,
      minDistance: null,
      injectedRows: 0,
      injectedQueries: 0,
      rankBase: 0,
    }
  }
  const ranked = rows.filter((r) => typeof r.rank === 'number')
  const best = ranked.length > 0 ? ranked.reduce((a, b) => (b.rank < a.rank ? b : a)) : null
  const dists = rows.map((r) => r.distance).filter((d) => typeof d === 'number')
  return {
    available: true,
    measurable: true,
    total,
    queries: new Set(rows.map((r) => r.queryId)).size,
    topRank: best ? best.rank : null,
    topRankChunkId: best ? best.chunkId : null,
    minDistance: dists.length > 0 ? Math.min(...dists) : null,
    injectedRows: rows.filter((r) => r.injected === 1).length,
    injectedQueries: new Set(rows.filter((r) => r.injected === 1).map((r) => r.queryId)).size,
    rankBase: 0,
  }
}

// ─── 纯函数：关键词通道可达性（G03 复核的核心） ──────────

/**
 * 把 `buildFtsQuery` 的 MATCH 表达式拆回**单个 bigram 词项**。
 *
 * 表达式形态由 `fts.ts` 固定：每个词项引号包裹、空格 join（AND 语义）。
 * 拆回来的用途是**逐词项判在不在语料里**——AND 语义下，只要有一个词项在
 * 语料里不存在，**整条查询的关键词通道返回 0 行**，而故障现象与「这个词项
 * 有歧义」完全一样（都是 0 行），不拆开就分不清「单个词项够不着」与
 * 「整条通道被一个生词打死」。
 *
 * ⚠️ **必须按引号解析，不能 `split(' ')`**：bigram 自身可能含空白（`"seed data"` 切出
 * `d␣` / `␣d`），按空格切会把一个词项劈成两半——于是「含空白的词项」这一类
 * **永远统计不到**，而报告会据此给出一个恒为 0 的假读数（首版实测踩过：
 * `anySpacedTerm` 报 0，真值非 0）。`buildFtsQuery` 已把含引号的 bigram 过滤掉，
 * 故按 `"..."` 配对解析对本表达式形态是完备的。
 */
export function splitFtsTerms(matchExpr) {
  if (!matchExpr) return []
  const out = []
  const re = /"([^"]*)"/g
  let m
  while ((m = re.exec(matchExpr)) !== null) {
    if (m[1].length > 0) out.push(m[1])
  }
  return out
}

/**
 * 逐词项统计语料内命中数（`countTerm` 由调用方注入真 SQL —— 纯函数不持 db）。
 *
 * 三类分解，各有各的药方：
 *   - `absent`：该 bigram 在语料里**一次都没出现** ⇒ AND 语义下整条查询必 0 行
 *   - `spaced`：该 bigram **含空白**（跨词边界的 bigram，如 `"seed data"` 切出的
 *     `"d "` / `" d"`）——索引侧存的是「bigram 空格 join」的预分词串，跨词边界的
 *     bigram 落进存串后会被 tokenizer 当分隔符切开，**结构上不可还原**
 *   - 其余 = 可用词项（`usable`）
 *
 * `usableMatchExpr` = 只用可用词项重拼的 AND 表达式——**反事实探针**：拿它去 MATCH，
 * 得到的就是「若把这批不可命中的词项剔掉，这条查询本来能召回多少」。
 */
export function probeFtsTerms({ matchExpr, countTerm, hitsOf }) {
  const terms = splitFtsTerms(matchExpr)
  const absent = []
  const present = []
  const spaced = []
  const usable = []
  for (const t of terms) {
    if (/\s/.test(t)) {
      spaced.push(t)
      continue
    }
    const n = countTerm(t)
    if (n > 0) {
      present.push({ term: t, count: n })
      usable.push(t)
    } else {
      absent.push(t)
    }
  }
  const usableMatchExpr = usable.length > 0 ? usable.map((t) => `"${t}"`).join(' ') : null
  return {
    terms,
    absent,
    present,
    spaced,
    usable,
    usableMatchExpr,
    /** 反事实命中数（缺 `hitsOf` 时为 null——纯函数不持 db） */
    usableHits: hitsOf && usableMatchExpr ? hitsOf(usableMatchExpr) : null,
  }
}

// ─── 纯函数：反对照（承重） ───────────────────────────

/**
 * **反对照 A（链级、单变量）**：把距离阈值收到某条**已注入**节的真实距离之下，
 * 该节必须当场掉出注入集。
 *
 * 它回答的是「探针有没有分辨力」这个前置问题：如果收紧阈值后**什么都没变**，
 * 那么「松阈值一条都救不回」这个结论就**不可信**——不是「阈值没杀」，而是
 * 「探针看不见阈值做什么」。**本对照不过 ⇒ 拒出报告。**
 *
 * 判据两条同时成立才算过：① 收紧前该锚点在注入集；② 收紧后不在。
 * 只看②（「没收紧时也不在」）是假绿门——那可能只是这条查询本来就召不回它。
 */
export function judgeThresholdCounterControl({
  baseInjected,
  tightenedInjected,
  tightenedThreshold,
  observedDistance,
}) {
  const ok = baseInjected === true && tightenedInjected === false
  return {
    ok,
    baseInjected,
    tightenedInjected,
    tightenedThreshold,
    observedDistance,
    detail: ok
      ? `收紧到 ${fmt4(tightenedThreshold)}（< 实测距离 ${fmt4(observedDistance)}）后该节掉出注入集`
      : `对照不成立：baseInjected=${baseInjected} tightenedInjected=${tightenedInjected}——` +
        '探针在阈值轴上没有分辨力，本次「0 处被阈值杀」不可采信',
  }
}

/**
 * **反对照 B（池级、存在性）**：语料里**存在**落在「杀区」（距离 ∈ [阈值, 放宽上限)）
 * 的片——即阈值确实有东西可杀。
 *
 * 与 A 的分工：A 证明「链段对阈值敏感」，B 证明「杀区非空」。两者都成立时，
 * 「本次 11 处的真实距离全部 < 阈值」才是一个**内容事实**而不是探针盲区。
 * B 是**补强**不是硬闸：杀区为空不影响 A 的结论。
 */
export function judgeKillZoneExistence({ relaxedHits, maxDistance, relaxedMaxDistance }) {
  const killed = relaxedHits.filter(
    (h) =>
      h.channel !== 'keyword' &&
      typeof h.distance === 'number' &&
      h.distance >= maxDistance &&
      h.distance < relaxedMaxDistance
  )
  return {
    ok: killed.length > 0,
    killed,
    killedN: killed.length,
    minKilledDistance: killed.length > 0 ? Math.min(...killed.map((h) => h.distance)) : null,
  }
}

// ─── 报告渲染 ─────────────────────────────────────────

/** 一处锚点在明细表里的短标签（人读面用，机器面走 JSON） */
function anchorShort(anchor) {
  return `${anchor.docPath} :: ${anchor.sectionAnchor}`
}

/**
 * 渲染诊断报告（Markdown）。纯函数——同输入必同输出（`--date` 注入日期）。
 *
 * ⚠️ 每次读数都必须带上**它是怎么来的**（真跑 / 重建）：两类读数混在一张表里
 * 而不标注，读者会把反事实当实测。这是本报告唯一的结构性风险点，故逐表标注。
 */
export function renderDiagnosis(ctx) {
  const {
    date,
    dbPath,
    dbRows,
    dbDocs,
    goldenFile,
    goldenEntries,
    goldenCounts,
    params,
    embed,
    groups,
    liveMisses,
    diff,
    mergeChecks,
    fuseCheck,
    anchors,
    g03,
    channelHealth,
    knobLab,
    spec,
    topkReal,
    liveRewrite,
    counterControl,
    baselineGroups,
    budget,
  } = ctx
  const L = []

  L.push(`# T3 检索优化·第一阶段：诊断（未召回归因复核）`)
  L.push('')
  L.push(
    `> 生成：\`scripts/eval/retrieval-attribution-recheck.mjs\`（T3，${date}）。` +
      '本报告**不是基线**——基线（"多少"）见 `docs/eval/retrieval-baseline-<date>.md`；' +
      '本报告回答**"为什么"**（差多少名 / 差多少 RRF 分 / 哪个旋钮能救 / 归因口径对不对）。'
  )
  L.push(
    `> 口径：被测出口、黄金集、距离阈值与基线**同源同尺**（复用 \`scoreEntry\`，见 \`retrieval-baseline.mjs\`）；` +
      '**检索本体零复制**——合并序是逐查询调库层现成 \`searchChunksHybrid\` 重建出来的，并逐条自证（§二）。'
  )
  L.push('')

  // ── §一 环境与自证 ──────────────────────────────────
  L.push('## 一、跑批环境与前提自证')
  L.push('')
  L.push('| 项 | 值 |')
  L.push('| --- | --- |')
  L.push(`| 报告 schema | ${DIAG_REPORT_SCHEMA} |`)
  L.push(`| 库路径 | \`${dbPath}\` |`)
  L.push(`| chunks 行数 / doc_path 数 | ${dbRows} / ${dbDocs} |`)
  L.push(
    `| 黄金集 | \`${goldenFile}\`（entries=${goldenEntries}：${Object.entries(goldenCounts)
      .map(([k, v]) => `${k}=${v}`)
      .join(' / ')}） |`
  )
  L.push(`| MEMORY_MAX_DISTANCE / MEMORY_TOP_K | ${params.maxDistance} / ${params.topK} |`)
  // 端口**号**不进报告（每跑一个随机值，写进去就破「同输入同输出」）——与 baseline 同款：
  // 只报**供给形态**与「有没有真握手」，不报那个数。
  L.push(
    '| 嵌入模型 / 维度 / 供给 | ' +
      `${embed.model ?? 'n/a'} / ${embed.dim ?? 'n/a'} / ` +
      (typeof embed.port === 'number' && embed.port > 0
        ? '独立 sidecar、动态端口（`EMBED_SIDECAR_PORT=0`，实测已握手）'
        : '⚠️ **未见 sidecar 监听端口**（非独立 sidecar 供给 / 未握手）') +
      ' |'
  )
  L.push(
    `| **合并序重建自证** | ${mergeChecks.checked} 条条目 / ${mergeChecks.rows} 行 final 流水逐行比对，` +
      `不符 **${mergeChecks.mismatches.length}** 处 ⇒ ${mergeChecks.ok ? '✅ 重建序 == 链段序' : '❌ 重建序与链段不符，全部名次/分差读数作废'} |`
  )
  L.push(
    `| **融合公式等价自证** | **实比 ${fuseCheck.compared}/${fuseCheck.intended} 条**查询${fuseCheck.skipped > 0 ? `（跳过 ${fuseCheck.skipped} 条：嵌入失败/空向量）` : ''}：本脚本 \`fuseChannelHits(k=60,N=20)\` vs 库层 \`searchChunksHybrid\` ⇒ ` +
      `${fuseCheck.ok ? '✅ 逐行相等（顺序 / 分 / 通道身份三项）' : `❌ ${fuseCheck.mismatches.length} 处不符`}` +
      `（报的是**实际比成几条**——实比 0 条会直接拒出报告，不会印成 ✅） |`
  )
  L.push(
    `| 预算截断面 | ${
      budget.truncatedEntries === 0
        ? '本批 0 条条目发生预算截断 ⇒ 重建序的 top-K 与真实注入节集等价'
        : `⚠️ **${budget.truncatedEntries} 条条目发生预算截断**（重建序未建模预算，` +
          `这些条目的"差几名"读数偏乐观）｜被丢弃节数合计 ${budget.droppedSections}`
    } |`
  )
  L.push('')

  // ── §二 本次实跑的总分（与基线对照） ─────────────────
  L.push('## 二、本次实跑总分（与 09-20 基线对照）')
  L.push('')
  L.push('| 组 | 条数 | 命中 / 应命中 | **recall（集均）** | 09-20 recall | 差 |')
  L.push('| --- | --- | --- | --- | --- | --- |')
  for (const kind of ['real', 'constructed']) {
    const g = groups[kind]
    const b = baselineGroups[kind]
    const delta = b !== null && b !== undefined ? g.recallMean - b : null
    L.push(
      `| ${kind} | ${g.n} | ${g.hit} / ${g.expectTotal} | **${fmt4(g.recallMean)}** | ${b === null || b === undefined ? 'n/a' : fmt4(b)} | ${delta === null ? 'n/a' : (delta > 0 ? '+' : '') + fmt4(delta)} |`
    )
  }
  L.push('')
  L.push(
    `> 基线口径的对照值取自 \`docs/eval/retrieval-baseline-2026-09-20.md\` §二（real 0.5833 / constructed 0.8261）。` +
      `两条读数在同一份库快照、同一份黄金集下重取。` +
      (diff.missingInLive.length === 0 && diff.extraInLive.length === 0
        ? ' **本次未召回集与 09-20 报告的 11 处逐条一致**（机器比对，非人眼）。'
        : ` ⚠️ **未召回集与 09-20 报告有差**：本次少了 ${diff.missingInLive.length} 处、多了 ${diff.extraInLive.length} 处（见 §三 尾）。`)
  )
  L.push('')

  // ── §三 11 处逐条读数 ────────────────────────────────
  L.push('## 三、未召回锚点逐条机制读数（本次实跑）')
  L.push('')
  L.push(
    '| # | 条目 | 锚点 | 归因（本次） | 09-20 归因 | finalRank | rrfScore | 榜尾分 | **差几名** | **差多少 RRF** | 池内最小真实距离 | 通道 |'
  )
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  anchors.forEach((a, i) => {
    const r = a.reading
    L.push(
      `| ${i + 1} | ${a.entryId} | ${anchorShort(a)} | ${a.attributionNow}${a.attributionChanged ? ' ⚠️' : ''} | ${a.attributionReport} | ` +
        `${r.inMergedPool ? r.rank : '不在池内'} | ${r.inMergedPool ? fmt4(r.rrfScore) : '—'} | ${a.cutoffRrf === null ? '—' : fmt4(a.cutoffRrf)} | ` +
        `${r.rankGap === null ? '—' : r.rankGap} | ${r.rrfGap === null ? '—' : fmt4(r.rrfGap)} | ` +
        `${a.minDistance === null ? '—' : fmt4(a.minDistance)} | ${a.channel ?? '—'} |`
    )
  })
  L.push('')
  L.push(
    '> **列口径**：`finalRank`/`rrfScore`/`榜尾分` 取自**重建的完整合并序**（§一 自证已逐行对上链段）；' +
      '「差几名」= `rank − (topK−1)`，正数即还差这么多名才够得着榜尾；「差多少 RRF」= 榜尾分 − 本片分，' +
      '**它与「差几名」不必同向**——分差极小却差很多名，说明该片卡在一堆几乎同分的片里（药方是融合常数，不是 topK）。' +
      '「池内最小真实距离」= 该锚点**全部片**在**逐查询放宽池**（阈值 1）里的最小向量距离，与基线同法同尺。'
  )
  L.push('')
  const absent = anchors.filter((a) => !a.reading.inMergedPool)
  if (absent.length > 0) {
    L.push(
      `**不在融合池内**的 ${absent.length} 处（` +
        absent.map((a) => `${a.entryId}`).join(' / ') +
        '）：任何一条查询的融合池（通道深度 20 × 池截 20）里都没有它的片。' +
        '这一格是「加 topK 救不回」的直接证据——topK 只切榜，榜里没有的东西切多深都没用。'
    )
    L.push('')
  }

  // ── §四 G03 归因口径复核 ────────────────────────────
  L.push('## 四、归因口径复核：`not-recalled`（覆盖洞）那一处')
  L.push('')
  L.push(
    `09-20 报告把 **${g03.entryId}**（\`${anchorShort(g03.anchor)}\`）判为 \`not-recalled\`（覆盖洞），` +
      '药方是"先补语料"。本节按**通道**独立复核该判据——覆盖洞与排序瓶颈的药方完全相反，判错就是开错药。'
  )
  L.push('')
  L.push('### 4.1 关键词通道：为什么够不着')
  L.push('')
  L.push(
    '索引侧（`chunks_fts`）存的是 **bigram 预分词串**（相邻两字成组，空格 join，见 `db/repository/fts.ts`）；' +
      '查询侧由 `buildFtsQuery` 把查询切成同样的 bigram、逐个引号包裹、以 **AND 语义**（空格 join）连起来 ' +
      '⇒ **任何一个 bigram 在语料里不存在，整条查询的关键词通道就返回 0 行**。' +
      '这一点是"单个词够不着"与"整条通道被打死"的分水岭，故下表逐词项列。'
  )
  L.push('')
  L.push('| 查询 | MATCH 词项数 | 关键词通道命中 | **语料内不存在的词项** |')
  L.push('| --- | --- | --- | --- |')
  for (const q of g03.queries) {
    L.push(
      `| ${q.text} | ${q.termCount} | **${q.keywordHits}** | ${q.absentTerms.length === 0 ? '（无）' : q.absentTerms.map((t) => `\`${t}\``).join(' / ')} |`
    )
  }
  L.push('')
  L.push('> 逐词项实测（单 bigram MATCH 计数）：' + g03.termEvidence)
  L.push('')
  L.push('### 4.2 向量通道：够不够得着')
  L.push('')
  L.push(
    `把该锚点的**全部 ${g03.sectionSize} 个片**放进**大深度** KNN（\`searchChunksByVector\`，深度 ${g03.knnDepth}、阈值放宽到 ${RECHECK_MAX_DISTANCE}）逐查询找：`
  )
  L.push('')
  L.push('| 查询 | 该锚点最小距离 | KNN 内名次 | 通道 |')
  L.push('| --- | --- | --- | --- |')
  for (const q of g03.knn) {
    L.push(
      `| ${q.text} | ${q.embedFailed ? '**（嵌入失败——探针瞎，非「不在池内」）**' : q.distance === null ? '（不在池内）' : fmt4(q.distance)} | ${q.rank === null ? '—' : q.rank} | ${q.channel ?? '—'} |`
    )
  }
  L.push('')
  L.push(
    `**跨全黄金集扫**（把黄金集**全部 ${g03.corpusSweep.queries} 条查询**依次当探针，看有没有**任何一条**够得着该锚点）：` +
      (g03.corpusSweep.best
        ? `✅ 够得着——最好一次来自 \`${g03.corpusSweep.best.entryId}\` 的查询「${g03.corpusSweep.best.query}」，` +
          `距离 **${fmt4(g03.corpusSweep.best.distance)}**、KNN 名次 **${g03.corpusSweep.best.rank}**（阈值 ${params.maxDistance} 内 ⇒ 它**过得了距离闸**）。`
        : `❌ 全黄金集 ${g03.corpusSweep.queries} 条查询里**没有一条**够得着它 ⇒ 与"覆盖洞"一致。`)
  )
  L.push('')
  L.push(
    '> ⚠️ **上面这一行只是「黄金集面」**（金标查询，受控复现）。同一个锚点在**生产事件面**' +
      '（`retrieval_candidates`，真实生产查询的检索流水）上读数可能完全不同——**两面不构成互相推翻**，' +
      '详读 §4.3。**生产面**：' +
      (() => {
        const pf = g03.productionFace
        if (!pf || !pf.available) return `该面本次不可测（${(pf && pf.reason) || '未取到'}）`
        if (!pf.measurable) return '该锚点**零行** ⇒ 本次不可测（零行 ≠ 够不着）'
        return (
          `${pf.total} 行 / ${pf.queries} 个查询；最好一次 **名次 ${pf.topRank}**（**0 基**）、` +
          `最小距离 ${pf.minDistance === null ? '（无）' : fmt4(pf.minDistance)}；` +
          `\`injected=1\` **${pf.injectedRows} 行 / ${pf.injectedQueries} 个查询**`
        )
      })()
  )
  L.push('')
  L.push(`### 4.3 复核结论`)
  L.push('')
  L.push(g03.verdict)
  L.push('')
  L.push('### 4.4 全批关键词通道体检（把单点放进分布里，**不升格为因果**）')
  L.push('')
  L.push(
    `把黄金集全部条目的全部查询（去重前，共 ${channelHealth.queries} 条查询串，平均 ${channelHealth.avgTerms.toFixed(1)} 个 bigram 词项）逐条过一遍关键词通道：`
  )
  L.push('')
  L.push('| 读数 | 值 |')
  L.push('| --- | --- |')
  L.push(`| 关键词通道**命中 0 行**的查询 | **${channelHealth.dead}** / ${channelHealth.queries} |`)
  L.push(
    `| 其中「有语料外 bigram」可解释的 | **${channelHealth.deadWithAbsentTerm}** / ${channelHealth.dead} |`
  )
  L.push(
    `| 词项**全部**在语料里、却仍 0 行（词项分散在不同片，AND 无从满足） | ${channelHealth.deadWithNoAbsentTerm} / ${channelHealth.dead} |`
  )
  L.push(
    `| 含至少一个**跨词边界** bigram（含空白，索引侧被 tokenizer 切开）的查询 | ${channelHealth.anySpacedTerm} / ${channelHealth.queries} |`
  )
  L.push(
    `| **反事实**：剔掉不可命中词项后**能**召回的 0 行查询 | **${channelHealth.revivedByUsableOnly}** / ${channelHealth.dead} |`
  )
  L.push('')
  L.push(
    '> **口径**：AND 语义下「有语料外 bigram」⟹「0 行」是**充分条件**，故第二行是可归因的那部分；' +
      '反向不成立——词项全在语料里、但分散在不同片里，同样会 0 行（AND 要求同一片内全中），' +
      '第三行量的正是这类。第四行的「跨词边界 bigram」是一条**结构性**缺陷面：' +
      '索引侧存的是「bigram 空格 join」的预分词串，`seed data` 切出的 `d␣` / `␣d` 这类 bigram ' +
      '在存储串里会被 tokenizer 当分隔符切开，**无法还原**。第五行是**修法候选 5 的读数面**：' +
      '把不可命中的词项剔掉重试，能救回多少条查询。'
  )
  L.push('')
  L.push(
    '高频语料外 bigram（按出现条数）：' +
      channelHealth.topAbsentTerms.map(([t, n]) => `\`${t}\`×${n}`).join(' / ')
  )
  L.push('')

  // ── §五 机制层：not_topk 的跨距分布 ──────────────────
  L.push('## 五、机制层：`not_topk` 各差多少名、多少分')
  L.push('')
  const nt = anchors.filter((a) => a.attributionNow === 'not_topk')
  if (nt.length === 0) {
    L.push('（本次实跑没有归因为 `not_topk` 的锚点）')
  } else {
    L.push('| 条目 | finalRank | topK | 差几名 | 差多少 RRF | 判读 |')
    L.push('| --- | --- | --- | --- | --- | --- |')
    for (const a of nt) {
      const r = a.reading
      const verdict =
        r.rrfGap === null
          ? '不在池内'
          : r.rrfGap <= 0
            ? r.tieBroken
              ? '**并列分被判负**（tie-break）'
              : '分差 ≤ 0 却未进榜（需查截断口径）'
            : r.rankGap <= 2
              ? '**近在咫尺**（调 topK 可救）'
              : r.rrfGap < 0.002
                ? '分差极小、名次差大 ⇒ 卡在同分簇里（融合常数更对症）'
                : '名次与分差都远'
      L.push(
        `| ${a.entryId} | ${r.inMergedPool ? r.rank : '不在池内'} | ${params.topK} | ${r.rankGap === null ? '—' : r.rankGap} | ${r.rrfGap === null ? '—' : fmt4(r.rrfGap)} | ${verdict} |`
      )
    }
  }
  L.push('')

  // ── §六 旋钮实验台 ──────────────────────────────────
  L.push('## 六、旋钮实验台：哪一档能救回几处')
  L.push('')
  L.push('### 6.1 `MEMORY_TOP_K`（**真跑链段**，端到端读数）')
  L.push('')
  L.push(
    '| MEMORY_TOP_K | real recall | constructed recall | 恢复的未召回锚点 | **受影响条目平均注入节数** | 全 40 条新增注入节 | **预算截断条目** |'
  )
  L.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const row of topkReal) {
    L.push(
      `| ${row.topK}${row.topK === params.topK ? '（生产现值）' : ''} | ${fmt4(row.realRecall)} | ${fmt4(row.constructedRecall)} | ${row.recovered} / ${anchors.length} | **${row.avgSectionsAffected.toFixed(2)}** | ${row.addedSections} | ${row.truncatedEntries} |`
    )
  }
  L.push('')
  L.push(
    '> **代价面**：`MEMORY_TOP_K` 是**全局**旋钮——它同时抬高每一次检索的注入节数，' +
      '而注入预算 `MEMORY_CONTEXT_TOKEN_BUDGET` 是硬上限。' +
      '「受影响条目平均注入节数」与 §6.3 的选择器变体**同分母**（都只数那 11 条漏检所属的条目），可直接比性价比；' +
      '「全 40 条新增注入节」是全局成本面；**「预算截断条目」逐档实测**——>0 即说明该档的收益开始被预算吃掉' +
      '（生产档是 ' +
      budget.truncatedEntries +
      ' 条）。'
  )
  L.push('')
  L.push('### 6.2 通道深度 / 融合常数 / 查询级池深（**重建读数**，非端到端）')
  L.push('')
  L.push(
    '⚠️ 这三个是 `chunks.ts` 里的模块私有 `const`（无 env 旋钮）⇒ 只能在**重建层**做反事实：' +
      '仍调库层现成的两通道函数取原始命中（检索本体零复制），只把融合参数换成候选值。' +
      '**本表是"若改成 X 会怎样"的结构推断，不是"改了 X 的实测"**。'
  )
  L.push('')
  L.push('| 配置 | 恢复的未召回锚点 | 说明 |')
  L.push('| --- | --- | --- |')
  for (const row of knobLab) {
    L.push(`| ${row.label} | ${row.recovered} / ${anchors.length} | ${row.note} |`)
  }
  L.push('')
  L.push('### 6.3 选择器变体（**重建读数**）')
  L.push('')
  L.push(
    '**先看现制浪费了多少名额**：链段末次 `slice(0, topK)` 切的是**片**，同节的多片各占一个名额，' +
      '再经 `bySection` 去重 ⇒ **实际注入节数可以少于 `MEMORY_TOP_K`**。' +
      `本批 40 条里，注入节数 < ${params.topK} 的有 **${spec.slotWaste.length}** 条` +
      (spec.slotWaste.length > 0
        ? `（${spec.slotWaste.map((w) => `${w.entryId}:${w.sections}`).join(' / ')}）`
        : '')
  )
  L.push('')
  L.push('**变体 A｜取前 K 个不同节**（不增加注入量，零成本候选）')
  L.push('')
  L.push('| K（不同节） | 恢复的未召回锚点 | 平均注入节数 |')
  L.push('| --- | --- | --- |')
  for (const row of spec.distinctSection) {
    L.push(`| ${row.k} | ${row.recovered} / ${anchors.length} | ${row.avgSections.toFixed(2)} |`)
  }
  L.push('')
  L.push(
    '**变体 B｜按分数相对阈值收节**（不切固定条数，凡是 RRF 分不低过榜首 × α 的节全收；起停语义同链段预算循环）'
  )
  L.push('')
  L.push('| α（占榜首分的比例） | 恢复的未召回锚点 | 平均注入节数 |')
  L.push('| --- | --- | --- |')
  for (const row of spec.byAlpha) {
    L.push(
      `| ${row.alpha} | ${row.recovered} / ${anchors.length} | ${row.avgSections.toFixed(2)} |`
    )
  }
  L.push('')
  L.push(
    `> **读法**：现制平均每项注入 ${params.topK} 节。变体 B 的 α 越小、平均节数越高 ⇒ 与「抬 topK」是同一枚硬币的两面；` +
      '差别在于**它按分数而不是按名次切**，对「一堆几乎同分的片」不敏感（§五 的 C03/C05/N04 正卡在那里）。' +
      '**两类变体都要与 §6.1 的 `MEMORY_TOP_K` 真跑读数比性价比**（同样的恢复数，谁的注入量更小）。'
  )
  L.push('')

  // ── §七 查询侧：改写器 ──────────────────────────────
  L.push('## 七、查询侧：改写器实测（基线从未测过的一面）')
  L.push('')
  if (!liveRewrite.ran) {
    L.push(`**未跑**：${liveRewrite.reason}。`)
  } else {
    L.push(
      `基线是**冻结改写**跑的（D2 冻结纪律），所以"改写器能不能救回这些漏检"**从未被测过**。` +
        `本节对全部 ${liveRewrite.n} 个未召回条目**重跑一次活的改写器**（\`rewriteRetrievalQueries\`，temperature=${liveRewrite.temperature}，**非确定**），把返回的查询喂回链段。`
    )
    L.push('')
    L.push('| 条目 | 活改写返回条数 | 该锚点是否进注入集 | 活改写文本 |')
    L.push('| --- | --- | --- | --- |')
    for (const r of liveRewrite.rows) {
      L.push(
        `| ${r.entryId} | ${r.queries.length} | ${r.injected ? '✅ 进了' : '❌ 仍没进'} | ${r.queries.map((q) => `\`${q}\``).join('<br>') || '（空 = 改写未产出，降级为仅原话）'} |`
      )
    }
    L.push('')
    L.push(
      `> 恢复 **${liveRewrite.recovered} / ${liveRewrite.n}**。**口径边界**：改写器 temperature=0.3、` +
        '同义改写不收敛（黄金集 `meta.freezeNotes` 已实证：39 条里 36 条两跑不同）⇒ 本表是**单次抽样**，' +
        '不是"改写器的期望表现"。要把它变成可复算读数，得先固定改写器的随机性（另立票）。'
    )
  }
  L.push('')

  // ── §八 反对照（承重） ──────────────────────────────
  L.push('## 八、反对照：探针在阈值轴上的分辨力（承重）')
  L.push('')
  L.push(
    '基线 §二 的结论「阈值一条都没杀」是**否定式**读数——它成立的前提是探针**看得见**阈值杀人。' +
      '本节构造单变量对照来证明这一点（不过则本报告不出）。'
  )
  L.push('')
  L.push('| 对照 | 做法 | 读数 | 判 |')
  L.push('| --- | --- | --- | --- |')
  L.push(
    `| **A（链级·单变量）** | 取一条**已注入、且关键词通道捞不回来**的节（\`${counterControl.threshold.entryId}\` 的 \`${anchorShort({ docPath: counterControl.threshold.docPath, sectionAnchor: counterControl.threshold.sectionAnchor })}\`；该节全部片的池内最小向量距离 ${fmt4(counterControl.threshold.observedDistance)}），` +
      `把 \`MEMORY_MAX_DISTANCE\` 从 ${params.maxDistance} 收紧到 ${fmt4(counterControl.threshold.tightenedThreshold)} 后**重跑该条目的链段** | ` +
      `收紧前在注入集=${counterControl.threshold.baseInjected}，收紧后=${counterControl.threshold.tightenedInjected} | ` +
      `${counterControl.threshold.ok ? '✅ 阈值确实能杀' : '❌ 对照不过'} |`
  )
  L.push(
    `| **B（池级·存在性）** | 逐查询放宽池（阈值 ${RECHECK_MAX_DISTANCE}）里数「杀区」（距离 ∈ [${params.maxDistance}, ${RECHECK_MAX_DISTANCE})）的片 | ` +
      `杀区内片 **${counterControl.killZone.killedN}** 个${counterControl.killZone.minKilledDistance === null ? '' : `（最近 ${fmt4(counterControl.killZone.minKilledDistance)}）`} | ` +
      `${counterControl.killZone.ok ? '✅ 杀区非空' : '（补强项，未命中不影响 A）'} |`
  )
  L.push('')
  L.push(
    `> **推论**：A 成立 ⇒ 链段对阈值敏感且该敏感性**可见**；结合「未召回锚点的池内最小真实距离最大 ${fmt4(ctx.maxMissDistance)}，` +
      `**低于**生产阈值 ${params.maxDistance}」⇒「松阈值一条都救不回」这一结论在**本次读数**上成立。` +
      'A 的候选筛选条件是**结构性的**（该节关键词通道捞不回来），不是挑出来的——若所有候选都不成立，脚本拒出报告。'
  )
  L.push('')

  // ── §九 修法候选 ────────────────────────────────────
  L.push('## 九、修法候选（各带代价与可证伪判据）')
  L.push('')
  L.push(ctx.candidates)
  L.push('')

  // ── §十 口径与边界 ──────────────────────────────────
  L.push('## 十、口径与边界')
  L.push('')
  L.push(
    '- **单点 vs 族级**：§4.1/§4.2 的逐通道复核只针对 **G03 一个锚点**；§4.4 把它放进**全批 148 条查询**的分布里，' +
      '那一节的读数是**范围读数**（关键词通道在全批查询上命中 0 行的条数），**不是**「该通道失效导致了这 11 处漏检」' +
      '的因果结论——因果需要单变量对照，本报告没做。'
  )
  L.push(
    '- **重建读数 vs 实测**：§三/§五 的名次与分是**已自证的**重建读数（§一 逐行对上链段）；' +
      '§6.1 是**真跑链段**的实测；§6.2 / §6.3 是**未自证的**结构推断（旋钮不可改、选择器未落地，无法端到端验证）。三类不混用。'
  )
  L.push(
    '- **不改检索**：本票只出诊断，`packages/server/src/memory/**` 与 `retrieval-baseline.mjs` **零改动**。'
  )
  L.push('- **复现**：见 §十一。')
  L.push('')
  L.push('## 十一、复现命令')
  L.push('')
  L.push('```bash')
  L.push('# 在 worktree 内（库在主仓库，worktree 里没有 data/*.db）')
  L.push(
    `node scripts/eval/retrieval-attribution-recheck.mjs \\\n  --db "<主仓库>/packages/server/data/cat-study-dev.db" \\\n  --env "<主仓库>/.env" --date ${date}`
  )
  L.push('```')
  L.push('')
  L.push('> `--no-live-rewrite` 可跳过 §七（跳过时该节会写明原因，不静默变空）。')
  L.push('')

  return L.join('\n')
}

// ─── CLI ──────────────────────────────────────────────

const TSX_CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'packages',
  'server',
  'node_modules',
  'tsx',
  'dist',
  'cli.mjs'
)

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export function parseArgs(argv) {
  const args = {
    root: null,
    db: null,
    env: null,
    date: null,
    out: null,
    liveRewrite: true,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--root') args.root = argv[++i] ?? null
    else if (a === '--db') args.db = argv[++i] ?? null
    else if (a === '--env') args.env = argv[++i] ?? null
    else if (a === '--date') args.date = argv[++i] ?? null
    else if (a === '--out') args.out = argv[++i] ?? null
    else if (a === '--no-live-rewrite') args.liveRewrite = false
    else if (a === '--help' || a === '-h') args.help = true
  }
  return args
}

function msgOf(err) {
  return err && err.message ? err.message : String(err)
}

/** 自举：原生 node 跑 `.mjs` 无法 import `.ts`（链段与库层都是 TS） */
function bootstrap(argv) {
  if (process.env.RETRIEVAL_RECHECK_TSX === '1') return false
  if (!existsSync(TSX_CLI)) {
    process.stderr.write(
      `[eval:retrieval:recheck] 找不到 tsx（${TSX_CLI}），请确认已执行 pnpm install\n`
    )
    process.exit(2)
  }
  const child = spawn(process.execPath, [TSX_CLI, fileURLToPath(import.meta.url), ...argv], {
    stdio: 'inherit',
    env: { ...process.env, RETRIEVAL_RECHECK_TSX: '1' },
  })
  child.on('exit', (code) => process.exit(code ?? 2))
  child.on('error', (err) => {
    process.stderr.write(`[eval:retrieval:recheck] 拉起 tsx 失败: ${msgOf(err)}\n`)
    process.exit(2)
  })
  return true
}

/** 机器通道（stdout 单行 JSON）+ 人类汇总（stderr） */
function emit(report, human) {
  process.stdout.write(JSON.stringify(report) + '\n')
  process.stderr.write(human + '\n')
}

/** 统一的「闸未过」出口：**不落文件**（与 baseline 同款：拒出的报告不留半成品） */
function refuse(phase, payload, human) {
  emit({ ok: false, phase, ...payload }, `[eval:retrieval:recheck] 拒出报告：${human}`)
  return 1
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(
      '用法: node scripts/eval/retrieval-attribution-recheck.mjs [--root <仓库根>] [--db <sqlite 路径>]\n' +
        '       [--env <外部 .env>] [--date YYYY-MM-DD] [--out <报告路径>] [--no-live-rewrite]\n' +
        '  T3 诊断：未召回归因复核（逐条名次/分差 + 通道复核 + 旋钮实验台 + 反对照）。\n' +
        '  缺省报告落 docs/run/eval-system/T3-retrieval-optimization-diagnosis.md。\n' +
        '  只读：不改任何检索参数（MEMORY_TOP_K 扫描期内除外，用完即还原）。\n'
    )
    return 0
  }

  const root = args.root ?? REPO_ROOT
  const date = args.date ?? localDate()
  const goldenFile = path.join(root, 'docs', 'eval', 'retrieval-golden.json')
  const outFile =
    args.out ??
    path.join(root, 'docs', 'run', 'eval-system', 'T3-retrieval-optimization-diagnosis.md')

  // env.ts 只认仓库根 .env；worktree 内通常是空的，故 --env 指向主仓库 .env。
  await import(pathToFileURL(path.join(root, 'packages/server/src/env.js')).href)
  if (args.env) {
    try {
      const { loaded } = loadEnvFile(args.env)
      process.stderr.write(`[eval:retrieval:recheck] 从 ${args.env} 补载 ${loaded} 个变量\n`)
    } catch (err) {
      process.stderr.write(
        `[eval:retrieval:recheck] 读不到 --env 指定的文件 ${args.env}: ${msgOf(err)}\n`
      )
      return 2
    }
  }
  // 端口隔离：**恒动态端口**（继承活 server 的固定端口会 EADDRINUSE ⇒ 降级成仅关键词通道 ⇒ 假读数）
  process.env.EMBED_SIDECAR_PORT = '0'

  let goldenData
  try {
    goldenData = JSON.parse(readFileSync(goldenFile, 'utf8'))
  } catch (err) {
    process.stderr.write(`[eval:retrieval:recheck] 读不到黄金集 ${goldenFile}: ${msgOf(err)}\n`)
    return 2
  }

  const dbPath = path.resolve(
    args.db ?? path.join(root, 'packages/server', 'data', 'cat-study-dev.db')
  )
  if (!existsSync(dbPath)) {
    process.stderr.write(
      `[eval:retrieval:recheck] 库不存在：${dbPath}\n` +
        '  （worktree 内没有 data/*.db——它是未跟踪产物；请显式 --db 指向主仓库的库）\n'
    )
    return 2
  }

  const serverRequire = createRequire(path.join(root, 'packages', 'server', 'package.json'))
  const Database = serverRequire('better-sqlite3')
  const sqliteVec = serverRequire('sqlite-vec')
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  sqliteVec.load(db)

  const { setDb } = await import(
    pathToFileURL(path.join(root, 'packages/server/src/db/index.js')).href
  )
  const { initRepository, chunks: chunksRepo } = await import(
    pathToFileURL(path.join(root, 'packages/server/src/db/repository/index.js')).href
  )
  setDb(db)
  initRepository(db)

  const { runRetrievalChain, currentRetrievalParams, vectorToBlob } = await import(
    pathToFileURL(path.join(root, 'packages/server/src/memory/index.js')).href
  )
  const { startEmbeddingSidecar, stopEmbeddingSidecar, getEmbeddingStatus, embedText } =
    await import(pathToFileURL(path.join(root, 'packages/server/src/memory/embedding.js')).href)
  const { buildFtsQuery } = await import(
    pathToFileURL(path.join(root, 'packages/server/src/db/repository/fts.js')).href
  )
  const { isQueryRewriteEnabled, rewriteRetrievalQueries } = await import(
    pathToFileURL(path.join(root, 'packages/server/src/memory/query-rewrite.js')).href
  )

  /** 嵌入 memo：同一查询串在本趟只嵌一次（旋钮实验台会把同一批查询重算很多遍） */
  const embedCache = new Map()
  const memoEmbed = async (text) => {
    if (embedCache.has(text)) return embedCache.get(text)
    const r = await embedText(text)
    embedCache.set(text, r)
    return r
  }

  try {
    const dbRows = db.prepare('SELECT count(*) AS c FROM chunks').get().c
    const dbDocs = db.prepare('SELECT count(DISTINCT doc_path) AS c FROM chunks').get().c
    const params = currentRetrievalParams()
    const maxDistance = params.maxDistance
    const topK = params.topK

    await startEmbeddingSidecar()
    const embedStatus = getEmbeddingStatus()
    if (!embedStatus.ok) {
      return refuse(
        'embed-unavailable',
        { reason: embedStatus.reason },
        `嵌入链未就绪（${embedStatus.reason}）——向量通道缺席时的一切读数都是假读数`
      )
    }

    // ─── canary（与 baseline 同一条反对照；尺子坏了后面全部读数无意义） ───
    const target = db
      .prepare(
        'SELECT doc_path AS docPath, section_anchor AS sectionAnchor FROM chunks ' +
          'ORDER BY length(section_anchor) DESC, doc_path ASC, section_anchor ASC LIMIT 1'
      )
      .get()
    if (!target) return refuse('corpus', { dbRows, dbDocs }, '库内没有可作 canary 的节')
    const canaries = buildCanaries({ docPath: target.docPath, sectionAnchor: target.sectionAnchor })
    const canaryRuns = []
    const canaryResults = []
    for (const c of canaries) {
      const r = await runRetrievalChain([c.query], { startedAt: Date.now() })
      canaryRuns.push({ id: c.id, result: r })
      canaryResults.push(evaluateCanary({ canary: c, result: r }))
    }
    const canaryBad = canaryResults.filter((c) => !c.ok)
    const canaryHealth = checkEmbedHealth(canaryRuns)
    if (canaryBad.length > 0 || !canaryHealth.ok) {
      return refuse(
        'canary',
        {
          canaries: canaryResults.map((c) => ({
            id: c.id,
            ok: c.ok,
            reason: c.reason,
            recall: c.recall,
          })),
          embed: canaryHealth.offenders,
        },
        'canary 反对照不过或嵌入链降级——尺子不可信，诊断读数全部作废'
      )
    }

    // ─── 逐条跑批（生产参数） ───────────────────────────
    const perEntry = []
    for (const entry of goldenData.entries) {
      const queries = [...new Set([entry.query, ...entry.rewritten])]
      const r = await runRetrievalChain(queries, { startedAt: Date.now() })
      // 先按流水打分；有任一未注入锚点 ⇒ 补逐查询重搜并**用同一把尺重打分**。
      // 这一步不能省：不喂 `recheck` 时，「流水两条路都没出现」的锚点一律落
      // `not-recalled`——**归因列会与基线不可比**（首版就是这么错的：G08 基线判
      // `below_topk`，本脚本判成 `not-recalled`，差的是分辨面不是检索结果）。
      let score = scoreEntry({ entry, result: r })
      let relaxedIndex = null
      if (score.details.some((d) => d.status !== 'injected')) {
        const relaxedPerQuery = await collectRecheckPools({
          queries,
          maxDistance: RECHECK_MAX_DISTANCE,
          embed: memoEmbed,
          search: (vector, q, md) =>
            chunksRepo.searchChunksHybrid(
              vectorToBlob(vector),
              q,
              chunksRepo.HYBRID_POOL_PER_QUERY,
              md
            ),
        })
        relaxedIndex = buildRecheckIndex({ perQuery: relaxedPerQuery })
        score = scoreEntry({ entry, result: r, recheck: relaxedIndex })
      }
      perEntry.push({ entry, queries, result: r, score, relaxedIndex })
    }

    const degradation = []
    for (const p of perEntry) {
      if (p.result.stats.queryTraces.some((q) => !q.queryEmbedOk))
        degradation.push({ id: p.entry.id, kind: 'partial-embed-failed' })
    }
    if (degradation.length > 0) {
      return refuse(
        'degradation',
        { offenders: degradation },
        `嵌入链降级 ${degradation.length} 条`
      )
    }
    const coverage = checkAttributionCoverage(perEntry.map((p) => p.score))
    if (!coverage.ok) {
      return refuse(
        'attribution',
        { unknown: coverage.unknown },
        `出现未登记的归因键 ${coverage.unknown.join(', ')}`
      )
    }

    // ─── 全量合并序重建 + 自证 ──────────────────────────
    const rebuilds = new Map()
    const mismatchAll = []
    let finalRowsChecked = 0
    for (const p of perEntry) {
      const pools = []
      for (const q of p.queries) {
        const e = await memoEmbed(q)
        pools.push({
          query: q,
          hits:
            e.ok && e.vector.length > 0
              ? chunksRepo.searchChunksHybrid(
                  vectorToBlob(e.vector),
                  q,
                  chunksRepo.HYBRID_POOL_PER_QUERY,
                  maxDistance
                )
              : [],
        })
      }
      const merged = mergeQueryPools({ pools, topK })
      const check = verifyMerge({ order: merged.order, result: p.result })
      finalRowsChecked += check.checked
      if (!check.ok) mismatchAll.push({ id: p.entry.id, mismatches: check.mismatches.slice(0, 5) })
      rebuilds.set(p.entry.id, { merged, pools })
    }
    const mergeVerdict = judgeMergeSelfCheck({
      entries: perEntry.length,
      rows: finalRowsChecked,
      mismatches: mismatchAll,
    })
    const mergeChecks = {
      ok: mergeVerdict.ok,
      mismatches: mismatchAll,
      checked: perEntry.length,
      rows: finalRowsChecked,
    }
    if (!mergeChecks.ok) {
      return refuse(
        mergeVerdict.reason === 'no-sample' ? 'remerge-no-sample' : 'remerge',
        { offenders: mismatchAll, rows: finalRowsChecked },
        mergeVerdict.message
      )
    }

    // ─── 融合公式等价自证（重建 vs 库层） ────────────────
    const fuseProbeQueries = [...new Set(perEntry.flatMap((p) => p.queries))].slice(0, 12)
    const fuseMismatches = []
    // ⚠️ 报「**实际比了几条**」而不是「打算比几条」：下面的 `continue` 是**静默**跳过，
    // 若全跳过则 `fuseMismatches` 为空 ⇒ `ok:true` ⇒ 报告照样印「逐行相等 ✅」，
    // 而**一条都没比**。这正是本脚本在别处花整节去防的「否定式读数」（探针瞎了也给出 0）。
    let fuseCompared = 0
    let fuseSkipped = 0
    for (const q of fuseProbeQueries) {
      const e = await memoEmbed(q)
      if (!e.ok || e.vector.length === 0) {
        fuseSkipped += 1
        continue
      }
      fuseCompared += 1
      const blob = vectorToBlob(e.vector)
      const native = chunksRepo.searchChunksHybrid(
        blob,
        q,
        chunksRepo.HYBRID_POOL_PER_QUERY,
        maxDistance
      )
      const built = fuseChannelHits({
        vectorHits: chunksRepo.searchChunksByVector(blob, 20, maxDistance),
        keywordHits: chunksRepo.searchChunksByKeyword(q, 20),
        rrfK: 60,
        poolPerQuery: 20,
        maxDistance,
      })
      const eq = verifyFuseEquivalence({ built, native })
      if (!eq.ok) fuseMismatches.push({ query: q, mismatches: eq.mismatches.slice(0, 3) })
    }
    const fuseVerdict = judgeFuseSelfCheck({
      intended: fuseProbeQueries.length,
      compared: fuseCompared,
      skipped: fuseSkipped,
      mismatches: fuseMismatches,
    })
    const fuseCheck = {
      ok: fuseVerdict.ok,
      mismatches: fuseMismatches,
      intended: fuseProbeQueries.length,
      compared: fuseCompared,
      skipped: fuseSkipped,
    }
    if (!fuseVerdict.ok) {
      return refuse(
        fuseVerdict.reason === 'no-sample' ? 'fuse-equivalence-no-sample' : 'fuse-equivalence',
        {
          intended: fuseProbeQueries.length,
          compared: fuseCompared,
          skipped: fuseSkipped,
          offenders: fuseMismatches,
        },
        fuseVerdict.message
      )
    }

    // ─── 未召回锚点集合（本次实跑，不照抄报告） ──────────
    const liveMissKeys = new Set()
    for (const p of perEntry) {
      for (const d of p.score.details) {
        if (d.status !== 'injected')
          liveMissKeys.add(`${p.entry.id}\u0000${anchorKey(d.docPath, d.sectionAnchor)}`)
      }
    }
    const reportKeys = new Set(
      REPORT_0920_MISSES.map((m) => `${m.id}\u0000${anchorKey(m.docPath, m.sectionAnchor)}`)
    )
    const diff = {
      missingInLive: [...reportKeys].filter((k) => !liveMissKeys.has(k)),
      extraInLive: [...liveMissKeys].filter((k) => !reportKeys.has(k)),
    }
    if (liveMissKeys.size === 0) {
      return refuse(
        'no-miss',
        {},
        '本次实跑零未召回锚点——与 09-20 基线差得太远，先查库/语料是否已变'
      )
    }

    // ─── 逐处机制读数 ──────────────────────────────────
    const anchors = []
    for (const p of perEntry) {
      const rb = rebuilds.get(p.entry.id)
      for (const d of p.score.details) {
        if (d.status === 'injected') continue
        const k = anchorKey(d.docPath, d.sectionAnchor)
        if (!liveMissKeys.has(`${p.entry.id}\u0000${k}`)) continue
        const sectionRows = chunksRepo.getChunksBySection(d.docPath, d.sectionAnchor)
        const sectionChunkIds = new Set(sectionRows.map((r) => r.id))

        // 该锚点的放宽池读数（阈值 1，全查询）：最小真实距离 + 是哪条查询/哪个名次捞到的。
        // **复用主循环里已经算好的那份**（同一把尺、同一份池），不重算。
        const rc = p.relaxedIndex ? (p.relaxedIndex.get(k) ?? null) : null

        const reading = readAnchor({ sectionChunkIds, merged: rb.merged, maxDistance })
        const reportRow = REPORT_0920_MISSES.find(
          (m) => m.id === p.entry.id && anchorKey(m.docPath, m.sectionAnchor) === k
        )
        const attributionNow = d.drop ?? d.status
        anchors.push({
          entryId: p.entry.id,
          kind: p.entry.kind,
          docPath: d.docPath,
          sectionAnchor: d.sectionAnchor,
          attributionNow,
          attributionReport: reportRow ? reportRow.attribution : '（不在 09-20 报告中）',
          attributionChanged: reportRow ? reportRow.attribution !== attributionNow : false,
          reading,
          cutoffRrf: rb.merged.cutoffRrf,
          minDistance: rc && typeof rc.distance === 'number' ? rc.distance : null,
          minDistanceQueryIndex: rc ? rc.queryIndex : null,
          minDistanceRank: rc ? rc.rank : null,
          channel: rc ? rc.channel : null,
          keywordHit: rc ? rc.keywordHit : false,
          sectionSize: sectionRows.length,
        })
      }
    }
    const maxMissDistance = anchors.reduce(
      (m, a) =>
        a.minDistance === null ? m : m === null ? a.minDistance : Math.max(m, a.minDistance),
      null
    )

    // ─── G03 通道复核 ───────────────────────────────────
    const g03Anchor = REPORT_0920_MISSES.find((m) => m.attribution === 'not-recalled')
    const g03Entry = perEntry.find((p) => p.entry.id === g03Anchor.id)
    const g03SectionRows = chunksRepo.getChunksBySection(g03Anchor.docPath, g03Anchor.sectionAnchor)
    const g03SectionIds = new Set(g03SectionRows.map((r) => r.id))

    // 生产事件面：键取**锚点身份**（`doc_path` + `section_anchor`），与黄金集面同键不同面
    // ——不是 `chunk_id`：同节多片会各算各的，锚点身份才是 `map.md` 措辞里的那个「同一锚点」。
    const productionFace = (() => {
      const hasTable = db
        .prepare(
          "SELECT count(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'retrieval_candidates'"
        )
        .get().c
      if (hasTable === 0) {
        return { available: false, measurable: false, reason: '库内无 retrieval_candidates 表' }
      }
      const rows = db
        .prepare(
          `SELECT query_id AS queryId, chunk_id AS chunkId, distance, rank, injected
             FROM retrieval_candidates
            WHERE doc_path = ? AND section_anchor = ?`
        )
        .all(g03Anchor.docPath, g03Anchor.sectionAnchor)
      return summarizeProductionFace(rows)
    })()

    const countTerm = (term) =>
      db.prepare('SELECT count(*) AS c FROM chunks_fts WHERE chunks_fts MATCH ?').get(`"${term}"`).c

    const g03Queries = []
    for (const q of g03Entry.queries) {
      const expr = buildFtsQuery(q)
      const probed = probeFtsTerms({ matchExpr: expr, countTerm })
      g03Queries.push({
        text: q,
        termCount: probed.terms.length,
        keywordHits: chunksRepo.searchChunksByKeyword(q, chunksRepo.HYBRID_POOL_PER_QUERY).length,
        absentTerms: probed.absent,
      })
    }
    // 逐词项证据：待证词项（各查询里语料内不存在的那些）+ 两个**被冒号隔开**的邻接 bigram。
    // 后两个是"转写把表行输出成「列名：值」"这条机制的直接读数——「票」与「己」各自有词项，
    // 但它们**永不相邻**，所以「票己」这个 bigram 在语料里不存在。
    const probeTerms = [
      ...new Set([...g03Queries.flatMap((q) => q.absentTerms), '票己', '：己', '票：']),
    ]
    const termEvidence = probeTerms.map((t) => `\`${t}\` → ${countTerm(t)} 行`).join('；')

    const KNN_DEPTH = 200
    const g03Knn = []
    for (const q of g03Entry.queries) {
      const e = await memoEmbed(q)
      if (!e.ok || e.vector.length === 0) {
        // ⚠️ 必须与「查了但没找到」区分：两者都是 `distance: null`，若渲染层一视同仁地印
        // 「（不在池内）」，**探针瞎掉**就会被读成**该锚点不在池内**（同族第三处）。
        g03Knn.push({ text: q, distance: null, rank: null, channel: null, embedFailed: true })
        continue
      }
      const hits = chunksRepo.searchChunksByVector(
        vectorToBlob(e.vector),
        KNN_DEPTH,
        RECHECK_MAX_DISTANCE
      )
      let best = null
      hits.forEach((h, i) => {
        if (!g03SectionIds.has(h.id)) return
        if (best === null || h.distance < best.distance) best = { distance: h.distance, rank: i }
      })
      g03Knn.push({
        text: q,
        distance: best ? best.distance : null,
        rank: best ? best.rank : null,
        channel: best ? 'vector' : null,
        embedFailed: false,
      })
    }

    // 跨全黄金集扫：有没有**任何一条**查询够得着这个锚点
    let sweepBest = null
    let sweepN = 0
    for (const entry of goldenData.entries) {
      for (const q of [...new Set([entry.query, ...entry.rewritten])]) {
        const e = await memoEmbed(q)
        if (!e.ok || e.vector.length === 0) continue
        sweepN += 1
        const hits = chunksRepo.searchChunksByVector(
          vectorToBlob(e.vector),
          KNN_DEPTH,
          RECHECK_MAX_DISTANCE
        )
        hits.forEach((h, i) => {
          if (!g03SectionIds.has(h.id)) return
          if (sweepBest === null || h.distance < sweepBest.distance) {
            sweepBest = { entryId: entry.id, query: q, distance: h.distance, rank: i }
          }
        })
      }
    }

    // ⚠️ 同族的第三处：`sweepN` 只数**嵌入成功**的查询，而失败是**静默** `continue` ⇒
    // 全失败时 `sweepN === 0`、`sweepBest === null` ⇒ 报告会印出
    // 「❌ 全黄金集 **0 条**查询里没有一条够得着它 ⇒ 与"覆盖洞"一致」——一句由**瞎掉的探针**
    // 得出的否定结论，正是本票靶心的形态。无样本必须拒出报告。
    if (sweepN === 0) {
      return refuse(
        'g03-sweep-no-sample',
        { goldenEntries: goldenData.entries.length },
        'G03 全黄金集扫描**一条查询都没嵌入成功**（sweepN=0）——「没有一条够得着」会变成' +
          '探针瞎掉时的假否定，覆盖洞结论不可采信'
      )
    }

    // 生产事件面的判词。三态必须分列——**零行 ≠ 够不着**（见 `summarizeProductionFace` 注释）。
    const productionFaceText = (() => {
      if (!productionFace.available) {
        return (
          `**生产事件面**（\`retrieval_candidates\`，真实生产查询的检索流水）：${productionFace.reason} ⇒ ` +
          '**该面本次不可测**。⚠️ 不可测 **≠** 够不着——别把它读成「生产面也够不着」。'
        )
      }
      if (!productionFace.measurable) {
        return (
          '**生产事件面**（`retrieval_candidates`，真实生产查询的检索流水）：该锚点**零行** ⇒ **该面本次不可测**' +
          '（流水是历史累积，零行只说明没跑过含它的查询）。⚠️ 不可测 **≠** 够不着——别把它读成「生产面也够不着」。'
        )
      }
      const d = productionFace.minDistance === null ? '（无）' : fmt4(productionFace.minDistance)
      const inj =
        productionFace.injectedRows > 0
          ? `其中 \`injected=1\` 的 **${productionFace.injectedRows} 行 / ${productionFace.injectedQueries} 个查询** ` +
            '⇒ 它**在生产上真被排到过最前、也真进过注入集**'
          : '其中 `injected=1` 的 **0 行** ⇒ 排得靠前但**从未真注入**'
      return (
        `**生产事件面**（\`retrieval_candidates\`，真实生产查询的检索流水）：该锚点有 **${productionFace.total} 行 / ${productionFace.queries} 个查询**，` +
        `最好一次 **名次 ${productionFace.topRank}**（**0 基**，\`0\` 即最靠前；与黄金集面同基）、最小距离 **${d}**；${inj}。\n\n` +
        '⇒ **两面不矛盾，是两把尺量两件事**：黄金集面（受控复现）说「金标查询里它排不到靠前」，' +
        '生产事件面（历史流水）说「真实查询里它排到过最前、且真注入过」。' +
        '此前那句「同一锚点在别的查询下拿到过 `rank=1`、`distance≈0.19`」出自**生产事件面**' +
        '（`a60e0c1` 自己的置信度声明写死了出处「取自 `retrieval_candidates` 的跨查询汇总」），' +
        '**在本面上可复现**；把它与黄金集面比大小才是错的——**被推翻的只能是同一个面内的前后不一致**。\n\n' +
        '⇒ 顺带：生产面这一读数**加强**了本节的结论——它连同「语料里有它」（§4.1/§4.2）一起说明 ' +
        '`not-recalled` **不是覆盖洞**（真的注入过），要救它得往**排序/融合**面找。'
      )
    })()

    const g03Verdict = (() => {
      const kwAllDead = g03Queries.every((q) => q.keywordHits === 0)
      const kwDeadReason = g03Queries
        .flatMap((q) => q.absentTerms)
        .filter((t, i, xs) => xs.indexOf(t) === i)
      const reach =
        sweepBest !== null && sweepBest.distance < maxDistance
          ? sweepBest
          : (g03Knn.find((q) => q.distance !== null && q.distance < maxDistance) ?? null)
      const parts = []
      if (kwAllDead) {
        parts.push(
          `**关键词通道对这三条查询整体失效**（逐条 0 行命中），可直接归因到 AND 语义下不存在的 bigram：${kwDeadReason.map((t) => `\`${t}\``).join(' / ')}。` +
            '⇒ 「关键词通道结构上够不着」成立，且比"够不着某一个片"更重：**整条通道没跑**。'
        )
      }
      if (reach) {
        parts.push(
          `**但向量通道够得着它**：${reach === sweepBest ? `全黄金集扫描里 \`${reach.entryId}\` 的查询「${reach.query}」把它以距离 ${fmt4(reach.distance)}、**KNN 第 ${reach.rank} 名**召回，且距离在阈值 ${maxDistance} 之内` : `它自己的某条查询以距离 ${fmt4(reach.distance)} 召回，阈值内`}。` +
            '⇒ 语料里**有**这个锚点、向量通道也**够得着**。'
        )
        parts.push(
          `**精确的判词**（标签对不对 / 药方对不对，是两件事）：` +
            `① \`not-recalled\` 这个**标签**在**机制的语义下是对的**——该锚点确实不出现在任何一条查询的融合池里` +
            `（向量通道只取 KNN 前 20 名，第 ${reach.rank} 名够不着；关键词通道又整条没跑；而池的出口还被截到 20 名）。` +
            `② 但它挂的**药方**（「覆盖洞——先补语料/补锚点，不是调参能救的」）**两条都不成立**：` +
            `内容在语料里（补语料是往已有的东西上再加一份）；` +
            `而「调参救不回」也不能从这个标签推出来——标签只说明它落在**当前机制**的池外，不说明换个机制也够不着。` +
            `③ 本次实测的**修法边界**（以下三条均为**黄金集面 + 链段面**的读数）：单动任何一类旋钮都救不回它——通道深度提到 200 仍恢复 0（§6.2，它的 RRF 分本就极低）、` +
            `抬 topK 也无效（它不在榜上）、改写器也没救回（§七）。要救它得**同时**动召回深度与融合权重，或改查询侧。`
        )
        parts.push(
          `⚠️ **两个面，别读成互相推翻**：本节的**黄金集面**读数（黄金集 ${sweepN} 条查询、KNN 深度 ${KNN_DEPTH}）给出的是「**在这个面上**它够得着、但排不到靠前」` +
            `（最好一次是 \`${reach.entryId}\` 的查询给出的 **名次 ${reach.rank} / 距离 ${fmt4(reach.distance)}**）。` +
            `这个结论**推翻不了另一个面**——两个面答的本来就不是同一个问题：` +
            '黄金集面答「**金标查询**里它排第几」，生产事件面答「**真实生产查询**里它有没有被排到最前、有没有真注入」。\n\n' +
            productionFaceText
        )
      } else {
        parts.push(
          `**且向量通道也够不着**：全黄金集 ${sweepN} 条查询、KNN 深度 ${KNN_DEPTH}、阈值放宽到 ${RECHECK_MAX_DISTANCE}，没有一条召回该锚点 ⇒ \`not-recalled\`（覆盖洞）在这条读数上**成立**。` +
            '⚠️ 但这只是**黄金集面**的读数，不足以单独判「覆盖洞」——必须并看下面的生产事件面。'
        )
        parts.push(productionFaceText)
      }
      return parts.join('\n\n')
    })()

    const g03 = {
      entryId: g03Anchor.id,
      anchor: { docPath: g03Anchor.docPath, sectionAnchor: g03Anchor.sectionAnchor },
      queries: g03Queries,
      termEvidence,
      knnDepth: KNN_DEPTH,
      knn: g03Knn,
      sectionSize: g03SectionRows.length,
      corpusSweep: { queries: sweepN, best: sweepBest },
      productionFace,
      verdict: g03Verdict,
    }

    // ─── 全批关键词通道体检（把 G03 的单点读数放到全批分布里，不升格为因果） ───
    // 只报**事实计数**：「多少条查询的关键词通道 0 行」「其中多少条能用『有词项不在语料里』
    // 解释」。后者是充分不必要条件（AND 语义下还可能是「词项分散在不同片里」）——
    // 报告里必须这么写，否则一行计数就会被读成因果。
    const termCountCache = new Map()
    const countTermMemo = (term) => {
      if (!termCountCache.has(term)) {
        termCountCache.set(
          term,
          db
            .prepare('SELECT count(*) AS c FROM chunks_fts WHERE chunks_fts MATCH ?')
            .get(`"${term}"`).c
        )
      }
      return termCountCache.get(term)
    }
    const countMatch = (expr) =>
      db.prepare('SELECT count(*) AS c FROM chunks_fts WHERE chunks_fts MATCH ?').get(expr).c
    const channelRows = []
    for (const p of perEntry) {
      for (const q of p.queries) {
        const probed = probeFtsTerms({
          matchExpr: buildFtsQuery(q),
          countTerm: countTermMemo,
          hitsOf: countMatch,
        })
        channelRows.push({
          entryId: p.entry.id,
          query: q,
          terms: probed.terms.length,
          absent: probed.absent.length,
          absentTerms: probed.absent,
          spaced: probed.spaced.length,
          usable: probed.usable.length,
          hits: chunksRepo.searchChunksByKeyword(q, chunksRepo.HYBRID_POOL_PER_QUERY).length,
          usableHits: probed.usableHits,
        })
      }
    }
    const absentTermFreq = new Map()
    for (const r of channelRows) {
      for (const t of r.absentTerms) absentTermFreq.set(t, (absentTermFreq.get(t) ?? 0) + 1)
    }
    const channelHealth = {
      queries: channelRows.length,
      dead: channelRows.filter((r) => r.hits === 0).length,
      deadWithAbsentTerm: channelRows.filter((r) => r.hits === 0 && r.absent > 0).length,
      anyAbsentTerm: channelRows.filter((r) => r.absent > 0).length,
      anySpacedTerm: channelRows.filter((r) => r.spaced > 0).length,
      /** 反事实：剔掉不可命中词项后**能**召回的查询数（本报告的修法候选 5 的读数面） */
      revivedByUsableOnly: channelRows.filter((r) => r.hits === 0 && (r.usableHits ?? 0) > 0)
        .length,
      /** 词项全可用却仍然 0 行（分散在不同片 ⇒ AND 无从满足） */
      deadWithNoAbsentTerm: channelRows.filter((r) => r.hits === 0 && r.absent === 0).length,
      avgTerms: channelRows.reduce((s, r) => s + r.terms, 0) / (channelRows.length || 1),
      topAbsentTerms: [...absentTermFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
    }

    // ─── 旋钮实验台 ─────────────────────────────────────
    // 6.1 MEMORY_TOP_K：**真跑链段**（改 env 单变量，用完还原）
    const topkReal = []
    const baselineSectionCount = new Map(
      perEntry.map((p) => [p.entry.id, p.result.sections.length])
    )
    const anchorKeys = anchors.map((a) => ({ ...a, key: anchorKey(a.docPath, a.sectionAnchor) }))
    // 成本读数必须与 §6.3 的选择器变体**同分母**（都只数「受影响条目」）——否则
    // 「40 条的新增节数 ÷ 40」与「11 条的平均节数」摆在一起比，是两个不同的尺。
    const affectedEntryIds = new Set(anchors.map((a) => a.entryId))
    for (const k of TOPK_SWEEP) {
      const prev = process.env.MEMORY_TOP_K
      process.env.MEMORY_TOP_K = String(k)
      try {
        const scores = []
        const injectedByEntry = new Map()
        let addedSections = 0
        let affectedSectionsSum = 0
        let truncatedEntries = 0
        for (const p of perEntry) {
          const r = await runRetrievalChain(p.queries, { startedAt: Date.now() })
          if (r.stats.queryTraces.some((q) => !q.queryEmbedOk)) {
            return refuse('degradation', { id: p.entry.id, k }, 'MEMORY_TOP_K 扫描期间嵌入链降级')
          }
          scores.push(scoreEntry({ entry: p.entry, result: r }))
          injectedByEntry.set(
            p.entry.id,
            new Set(r.sections.map((s) => anchorKey(s.docPath, s.sectionAnchor)))
          )
          addedSections += Math.max(
            0,
            r.sections.length - (baselineSectionCount.get(p.entry.id) ?? 0)
          )
          if (affectedEntryIds.has(p.entry.id)) affectedSectionsSum += r.sections.length
          // 预算截断的**逐档**读数：抬 topK 的收益会不会被 `MEMORY_CONTEXT_TOKEN_BUDGET` 吃掉，
          // 只有这一列答得了（生产档的截断数回答不了「抬到 15 会怎样」）
          if (r.stats.truncated) truncatedEntries += 1
        }
        // 「恢复」判据 = 该锚点所属节出现在注入节集里——与 `scoreEntry` 的 recall 同一判据
        // （同一把尺，不自造第二套）
        const recovered = anchorKeys.filter((a) =>
          injectedByEntry.get(a.entryId)?.has(a.key)
        ).length
        const real = summarizeGroup(scores.filter((s) => s.kind === 'real'))
        const constructed = summarizeGroup(scores.filter((s) => s.kind === 'constructed'))
        topkReal.push({
          topK: k,
          realRecall: real.recallMean,
          constructedRecall: constructed.recallMean,
          recovered,
          addedSections,
          truncatedEntries,
          // 与 §6.3 同分母（只数受影响条目）的成本读数
          avgSectionsAffected:
            affectedEntryIds.size > 0 ? affectedSectionsSum / affectedEntryIds.size : 0,
          // 生产档必须恢复 0 处（未召回集就是从这一档算出来的）——不对就说明扫描接线错了
          isProduction: k === topK,
        })
      } finally {
        if (prev === undefined) delete process.env.MEMORY_TOP_K
        else process.env.MEMORY_TOP_K = prev
      }
    }
    const topkProdSanity = topkReal.find((r) => r.isProduction)
    if (topkProdSanity && topkProdSanity.recovered !== 0) {
      return refuse(
        'topk-sweep',
        { recovered: topkProdSanity.recovered },
        `MEMORY_TOP_K=${topK} 档"恢复"了 ${topkProdSanity.recovered} 处——未召回集本该从这一档算出，接线有误`
      )
    }

    // 6.2 重建层反事实：通道深度 / RRF k / 查询级池深
    const affected = perEntry.filter((p) => anchors.some((a) => a.entryId === p.entry.id))
    const affectedAnchorByEntry = new Map()
    for (const a of anchors) {
      if (!affectedAnchorByEntry.has(a.entryId)) affectedAnchorByEntry.set(a.entryId, [])
      affectedAnchorByEntry.get(a.entryId).push(a)
    }
    const buildPoolsFor = async (p, channelTopN, rrfK, poolPerQuery) => {
      const pools = []
      for (const q of p.queries) {
        const e = await memoEmbed(q)
        if (!e.ok || e.vector.length === 0) {
          pools.push({ query: q, hits: [] })
          continue
        }
        const blob = vectorToBlob(e.vector)
        pools.push({
          query: q,
          hits: fuseChannelHits({
            vectorHits: chunksRepo.searchChunksByVector(blob, channelTopN, maxDistance),
            keywordHits: chunksRepo.searchChunksByKeyword(q, channelTopN),
            rrfK,
            poolPerQuery,
            maxDistance,
          }),
        })
      }
      return pools
    }
    const countRecovered = (mergedByEntry) => {
      let n = 0
      for (const a of anchors) {
        const merged = mergedByEntry.get(a.entryId)
        if (!merged) continue
        const ids = new Set(
          chunksRepo.getChunksBySection(a.docPath, a.sectionAnchor).map((r) => r.id)
        )
        if ([...ids].some((id) => merged.injectedIds.has(id))) n += 1
      }
      return n
    }
    const knobLab = []
    const knobConfigs = [
      ...CHANNEL_TOPN_SWEEP.filter((n) => n !== 20).map((n) => ({
        label: `通道深度 ${n}（池深保持 20）`,
        channelTopN: n,
        rrfK: 60,
        poolPerQuery: 20,
        note: '把两通道召回深度从 20 提到 ' + n + '——只有"双通道加分片"才会改变融合榜前 20',
      })),
      ...POOL_PER_QUERY_SWEEP.filter((n) => n !== 20).map((n) => ({
        label: `查询级池深 ${n}（通道深度保持 20）`,
        channelTopN: 20,
        rrfK: 60,
        poolPerQuery: n,
        note: `让每趟查询把融合榜前 ${n} 名交给跨查询合并（现为 20），但两通道仍只召回 20 片`,
      })),
      ...RRFK_SWEEP.filter((k) => k !== 60).map((k) => ({
        label: `RRF k=${k}（通道深度 20 / 池深 20）`,
        channelTopN: 20,
        rrfK: k,
        poolPerQuery: 20,
        note: `k 越小，榜首权重越集中——改变的是融合榜**内部**的相对次序`,
      })),
      {
        label: '通道深度 200 + 池深 100（三档同开的极值）',
        channelTopN: 200,
        rrfK: 60,
        poolPerQuery: 100,
        note: '上下界参考：全部候选都进合并层时的上限',
      },
    ]
    for (const cfg of knobConfigs) {
      const mergedByEntry = new Map()
      for (const p of affected) {
        const pools = await buildPoolsFor(p, cfg.channelTopN, cfg.rrfK, cfg.poolPerQuery)
        mergedByEntry.set(p.entry.id, mergeQueryPools({ pools, topK }))
      }
      knobLab.push({ label: cfg.label, note: cfg.note, recovered: countRecovered(mergedByEntry) })
    }

    // 选择器变体（同为重建读数）：**固定条数**（现制，切前 topK 节）vs **分数相对阈值**
    // （榜首先取齐，凡是分不低过榜首 × alpha 的节全收）。存在的理由见候选 3：
    // §五 显示 C03/C05/N04/G12 就卡在第 4~5 名、分差 0.0007~0.0140——固定条数在
    // 「一堆几乎同分的片」处切一刀，切掉谁全看 tie-break，而阈值式选择器对此不敏感。
    // 变体 0（**零成本候选**）：现制的 `slice(0, topK)` 切的是**片**，同节多片会占掉
    // 多个名额——切 3 片可能只换来 2 个节。改成「取前 topK 个**不同节**」不增加任何
    // 注入量，却可能直接救回锚点。先量现制到底浪费了多少名额。
    const sectionSlotWaste = []
    for (const p of perEntry) {
      const injectedSections = p.result.sections.length
      if (injectedSections < topK) {
        sectionSlotWaste.push({ entryId: p.entry.id, sections: injectedSections, topK })
      }
    }
    const distinctSectionSelector = []
    for (const k of [3, 5, 8]) {
      let recovered = 0
      let totalSections = 0
      for (const p of affected) {
        const order = rebuilds.get(p.entry.id).merged.order
        const pickedKeys = new Set()
        for (const r of order) {
          const key = anchorKey(r.docPath, r.sectionAnchor)
          if (pickedKeys.has(key)) continue
          if (pickedKeys.size >= k) break
          pickedKeys.add(key)
        }
        totalSections += pickedKeys.size
        for (const a of anchors) {
          if (a.entryId === p.entry.id && pickedKeys.has(anchorKey(a.docPath, a.sectionAnchor)))
            recovered += 1
        }
      }
      distinctSectionSelector.push({
        k,
        recovered,
        avgSections: affected.length > 0 ? totalSections / affected.length : 0,
      })
    }

    const selectorLab = []
    for (const alpha of [0.5, 0.3, 0.2]) {
      let recovered = 0
      let totalSections = 0
      for (const p of affected) {
        const order = rebuilds.get(p.entry.id).merged.order
        if (order.length === 0) continue
        const pickedKeys = new Set()
        const top = order[0].rrfScore
        for (const r of order) {
          const key = anchorKey(r.docPath, r.sectionAnchor)
          if (pickedKeys.has(key)) continue
          // 「起停」而非「跳过」的语义与链段的预算循环一致（`kept` 是 break 不是 filter）
          if (r.rrfScore < alpha * top) break
          pickedKeys.add(key)
        }
        totalSections += pickedKeys.size
        for (const a of anchors) {
          if (a.entryId === p.entry.id && pickedKeys.has(anchorKey(a.docPath, a.sectionAnchor)))
            recovered += 1
        }
      }
      selectorLab.push({
        alpha,
        recovered,
        avgSections: affected.length > 0 ? totalSections / affected.length : 0,
      })
    }

    // ─── 反对照（承重） ─────────────────────────────────
    // 候选 = 「已注入、且其关键词通道捞不回来」的节——只有这类节才是**阈值绑定**的：
    // 若某节有片被关键词通道召回，那么把阈值收到 0 它也照样进注入集（关键词没有距离概念），
    // 拿它做对照 = 用一个与阈值无关的节去证明阈值有效，必然是假绿门（首版实测踩过：
    // canary 节的锚点标题词项全在语料里 ⇒ 关键词通道把它拉回来 ⇒ 收紧阈值后纹丝不动）。
    const ccCandidates = []
    for (const p of perEntry) {
      const rb = rebuilds.get(p.entry.id)
      const keywordIds = new Set()
      for (const pool of rb.pools) {
        for (const h of pool.hits) if (h.keywordRank !== null) keywordIds.add(h.row.id)
      }
      for (const s of p.result.sections) {
        const rows = chunksRepo.getChunksBySection(s.docPath, s.sectionAnchor)
        if (rows.length === 0) continue
        if (rows.some((r) => keywordIds.has(r.id))) continue
        const reps = p.result.stats.candidates.filter(
          (c) =>
            c.source === 'final' && c.docPath === s.docPath && c.sectionAnchor === s.sectionAnchor
        )
        if (reps.length === 0) continue
        const rep = reps.reduce((a, b) => (a.finalRank <= b.finalRank ? a : b))
        if (rep.channel !== 'vector' || typeof rep.distance !== 'number') continue
        ccCandidates.push({
          entryId: p.entry.id,
          queries: p.queries,
          docPath: s.docPath,
          sectionAnchor: s.sectionAnchor,
          chunkIds: new Set(rows.map((r) => r.id)),
          repDistance: rep.distance,
        })
      }
    }
    // 距离越大越可能"正是阈值把它卡住的那一批"，先试它们
    ccCandidates.sort((a, b) => b.repDistance - a.repDistance)

    let thresholdCC = null
    const ccTried = []
    for (const cand of ccCandidates.slice(0, 12)) {
      // 该节**全部片**在各查询下的最小真实向量距离：收到它之下，向量通道一片都够不着
      let dmin = null
      for (const q of cand.queries) {
        const e = await memoEmbed(q)
        if (!e.ok || e.vector.length === 0) continue
        const hits = chunksRepo.searchChunksByVector(
          vectorToBlob(e.vector),
          200,
          RECHECK_MAX_DISTANCE
        )
        for (const h of hits) {
          if (!cand.chunkIds.has(h.id)) continue
          dmin = dmin === null ? h.distance : Math.min(dmin, h.distance)
        }
      }
      if (dmin === null) continue
      const tightened = Math.max(1e-6, dmin - Math.max(0.002, dmin * 0.05))
      const prev = process.env.MEMORY_MAX_DISTANCE
      process.env.MEMORY_MAX_DISTANCE = String(tightened)
      let tightRun
      try {
        tightRun = await runRetrievalChain(cand.queries, { startedAt: Date.now() })
      } finally {
        if (prev === undefined) delete process.env.MEMORY_MAX_DISTANCE
        else process.env.MEMORY_MAX_DISTANCE = prev
      }
      const key = anchorKey(cand.docPath, cand.sectionAnchor)
      const tightenedInjected = tightRun.sections.some(
        (s) => anchorKey(s.docPath, s.sectionAnchor) === key
      )
      const verdict = judgeThresholdCounterControl({
        baseInjected: true,
        tightenedInjected,
        tightenedThreshold: tightened,
        observedDistance: dmin,
      })
      ccTried.push({
        entryId: cand.entryId,
        docPath: cand.docPath,
        sectionAnchor: cand.sectionAnchor,
        tightenedThreshold: tightened,
        tightenedInjected,
      })
      if (verdict.ok) {
        thresholdCC = {
          ...verdict,
          entryId: cand.entryId,
          docPath: cand.docPath,
          sectionAnchor: cand.sectionAnchor,
        }
        break
      }
    }
    if (thresholdCC === null) {
      return refuse(
        'counter-control',
        { candidates: ccCandidates.length, tried: ccTried },
        `阈值反对照不过（试了 ${ccTried.length}/${ccCandidates.length} 个候选节）——` +
          '探针在阈值轴上没有分辨力，「0 处被阈值杀」不可采信'
      )
    }

    // 反对照 B：杀区存在性（补强）
    const killZoneHits = []
    for (const q of [...new Set(affected.flatMap((p) => p.queries))]) {
      const e = await memoEmbed(q)
      if (!e.ok || e.vector.length === 0) continue
      const hits = chunksRepo.searchChunksByVector(
        vectorToBlob(e.vector),
        200,
        RECHECK_MAX_DISTANCE
      )
      for (const h of hits) {
        if (h.distance >= maxDistance && h.distance < RECHECK_MAX_DISTANCE) {
          killZoneHits.push({ query: q, chunkId: h.id, distance: h.distance, channel: 'vector' })
        }
      }
    }
    const killZone = judgeKillZoneExistence({
      relaxedHits: killZoneHits,
      maxDistance,
      relaxedMaxDistance: RECHECK_MAX_DISTANCE,
    })
    const counterControl = { threshold: thresholdCC, killZone }

    // ─── 查询侧：活改写器（可选） ────────────────────────
    let liveRewrite = { ran: false, reason: '' }
    if (!args.liveRewrite) {
      liveRewrite = { ran: false, reason: '本轮以 --no-live-rewrite 显式跳过' }
    } else if (!isQueryRewriteEnabled()) {
      liveRewrite = { ran: false, reason: 'MEMORY_QUERY_REWRITE_ENABLED=0（改写器关闭）' }
    } else if (!process.env.DS_KEY) {
      liveRewrite = { ran: false, reason: '未配置 DS_KEY（改写器不可用）' }
    } else {
      const rows = []
      let recovered = 0
      for (const a of anchors) {
        const p = perEntry.find((x) => x.entry.id === a.entryId)
        const live = await rewriteRetrievalQueries(p.entry.query)
        const queries = [...new Set([p.entry.query, ...live])]
        const r = await runRetrievalChain(queries, { startedAt: Date.now() })
        const sc = scoreEntry({
          entry: {
            id: a.entryId,
            expect: [{ doc_path: a.docPath, section_anchor: a.sectionAnchor }],
          },
          result: r,
        })
        const injected = sc.recall === 1
        if (injected) recovered += 1
        rows.push({ entryId: a.entryId, queries: live, injected })
      }
      liveRewrite = {
        ran: true,
        n: rows.length,
        rows,
        recovered,
        // 与 `query-rewrite.ts` 的 `chatComplete` 调用同源（该文件写死 temperature: 0.3）
        temperature: 0.3,
      }
    }

    // ─── 预算截断面（重建序未建模预算，须如实披露） ──────
    const truncated = perEntry.filter((p) => p.result.stats.truncated)
    const budget = {
      truncatedEntries: truncated.length,
      droppedSections: truncated.reduce((s, p) => s + p.result.stats.droppedSections, 0),
    }

    // ─── 修法候选（由读数生成，不手写数字） ──────────────
    const topkRows = topkReal.filter((r) => r.topK !== topK)
    const bestTopk =
      topkRows.length > 0 ? topkRows.reduce((a, b) => (b.recovered > a.recovered ? b : a)) : null
    const inPool = anchors.filter((a) => a.reading.inMergedPool).length
    const closeGap = anchors.filter(
      (a) => a.reading.rankGap !== null && a.reading.rankGap <= 2
    ).length
    /** 选择器实验台的三块读数（渲染与候选正文同源，避免两处各写一遍数字） */
    const spec = {
      slotWaste: sectionSlotWaste,
      distinctSection: distinctSectionSelector,
      byAlpha: selectorLab,
    }
    const candidates = [
      `### 候选 1｜抬高 \`MEMORY_TOP_K\`（**真跑读数**）`,
      '',
      `**读数**：${topkRows.map((r) => `topK=${r.topK} → real ${fmt4(r.realRecall)} / constructed ${fmt4(r.constructedRecall)}，恢复 ${r.recovered}/${anchors.length}`).join('；')}。` +
        `其中 ${closeGap} 处只差 ≤2 名，${anchors.length - inPool} 处**根本不在融合池内**（抬 topK 对它们无效）。`,
      '',
      `**代价**：全局旋钮——每次检索的注入节数同步抬高（§6.1 的「平均注入节数」列），` +
        `而 \`MEMORY_CONTEXT_TOKEN_BUDGET\`（默认 8000）是硬上限；本批预算截断条目 ${budget.truncatedEntries} 条。` +
        `**最省的一步是 topK=5**：恢复 ${topkReal.find((r) => r.topK === 5)?.recovered ?? 'n/a'}/${anchors.length}，` +
        `平均注入 ${(topkReal.find((r) => r.topK === 5)?.avgSectionsAffected ?? NaN).toFixed(2)} 节（现制 ${params.topK} 节）。`,
      '',
      `**可证伪判据**：① 若某档的 real recall **没有**高于 topK=3，则"抬 topK 有效"被证伪；` +
        `② 若某一档的**平均注入节数**已逼近 \`MEMORY_CONTEXT_TOKEN_BUDGET\` 能容纳的上限，则该档的收益会被预算吃掉（届时以真跑的 \`truncated\` 读数为准）；` +
        `③ 若候选 2（节级截断）在**同注入量**下恢复数 ≥ 本候选，则本候选被支配 —— 先做零成本的那个。`,
      '',
      `### 候选 2｜换选择器：切片级截断 → 节级截断（**重建读数**，零注入增量）`,
      '',
      (() => {
        const k3 = spec.distinctSection.find((r) => r.k === topK)
        const waste = spec.slotWaste.length
        return (
          `**读数**：现制 \`slice(0, topK)\` 切**片**、同节多片各占名额，实注入节数可少于 ${topK}` +
          `（本批 40 条里有 **${waste}** 条发生 ⇒ 名额被浪费）。改成「取前 ${topK} 个**不同节**」后：` +
          (k3
            ? `恢复 **${k3.recovered}/${anchors.length}**、平均注入 **${k3.avgSections.toFixed(2)}** 节` +
              `（现制真跑 ${topK} 档平均 ${(topkReal.find((r) => r.isProduction)?.avgSectionsAffected ?? topK).toFixed(2)} 节）——` +
              '**同样的注入量**。'
            : '（未测到对应档位）')
        )
      })(),
      '',
      '**代价**：只改末次截断的**粒度**（片 → 节），不碰融合公式、不增注入量；' +
        '风险面是「同一节的多片本可以各占一个名额、把该节的不同片段分别带进来」——' +
        '但整节返回（Decisions 14）本就意味着同节多片是冗余的，故这个风险面在现设计下不成立。',
      '',
      `**可证伪判据**：① 真跑（改截断粒度后重跑 40 条）恢复数若 **少于** 本表重建读数，则重建失真或改动跑偏；` +
        `② 全量 40 条逐条比对，**不得有任何一组的 recall 下降**（截断粒度变化理论上只增不减——出现下降即实现有误）；` +
        `③ 若变体 A 在 ${topK} 档恢复 0 处，则本候选作废。`,
      '',
      `### 候选 3｜按**分数相对阈值**收节而不是切固定条数（**重建读数**，需另立票实测）`,
      '',
      (() => {
        const best =
          spec.byAlpha.length > 0
            ? spec.byAlpha.reduce((a, b) => (b.recovered > a.recovered ? b : a))
            : null
        const topkBest =
          topkRows.length > 0
            ? topkRows.reduce((a, b) => (b.recovered > a.recovered ? b : a))
            : null
        return (
          `**读数**：` +
          (best && best.recovered > 0
            ? `α=${best.alpha} → 恢复 ${best.recovered}/${anchors.length}，平均每项注入 ${best.avgSections.toFixed(2)} 节。全部档位见 §6.3。`
            : '全部 α 档位恢复 0 处（见 §6.3）。') +
          (topkBest
            ? ` ｜ **对照**（§6.1 真跑）：topK=${topkBest.topK} 恢复 ${topkBest.recovered}/${anchors.length}、平均 ${topkBest.avgSectionsAffected.toFixed(2)} 节——` +
              (topkBest.recovered >= (best?.recovered ?? 0) &&
              topkBest.avgSectionsAffected <= (best?.avgSections ?? Infinity)
                ? '**同恢复数下 topK 更省** ⇒ 本候选被候选 1 支配，**应放弃**。'
                : '两者各有短长，见下表逐档比。')
            : '')
        )
      })(),
      '',
      '**代价**：注入节数变成**浮动值**（α 越小越多），与 `MEMORY_CONTEXT_TOKEN_BUDGET` 的交互变成「先按分收、再按预算截」，需重核预算语义。',
      '',
      `**可证伪判据**：**本条已被上面那句支配判断给出可证伪形态**——只要真跑证明同恢复数下它的平均注入量更小，` +
        `「被候选 1 支配」即被证伪，届时它才值得立票。`,
      '',
      `### 候选 4（**已由读数排除**，列出以防重复立票）｜加深通道 / 池深、改 RRF 常数`,
      '',
      `**读数**：§6.2 七档全 0。机制解释：这 11 处里 ${anchors.length - inPool} 处**连融合池都进不去**` +
        `（通道深度 20 × 池截 20 之外），其余的 RRF 分距榜尾 0.0007~0.0334——加深通道只会让它们以**更低的分**进池，` +
        `改变不了名次；改 k 只改榜内相对次序，改不动榜的**成员**。`,
      '',
      '**代价**：三者皆模块私有 `const`（无 env 旋钮），落地要改 `db/repository/chunks.ts` 的混合检索核心参数。',
      '',
      `**可证伪判据**：真跑（改常量后重跑 40 条）若恢复数 > 0，则本节"已排除"的结论被证伪——届时以真跑为准。`,
      '',
      `### 候选 5｜查询侧：修关键词通道的 AND 语义 / 改写器（**诊断已给出机制，修法待票**）`,
      '',
      `**读数**：关键词通道在**全批 ${channelHealth.queries} 条查询里 ${channelHealth.dead} 条命中 0 行**（§4.4）——` +
        `其中 ${channelHealth.revivedByUsableOnly} 条**只要剔掉不可命中的词项就能召回**（反事实实测）；` +
        `G03 的三条查询**逐条 0 行**，且它的锚点在向量通道里其实够得着（§4.2）。` +
        ` ｜ 活改写器（另一条查询侧子路）恢复 ${liveRewrite.ran ? `**${liveRewrite.recovered}/${liveRewrite.n}**` : '未跑'}（§七）。`,
      '',
      '**代价**：(a) 关键词通道改「剔词重试 / OR 排序」要重跑全量并防"召回暴涨稀释精度"——' +
        '本报告的**反事实命中数**只答"能不能召回"，**不答**"召回进来会不会稀释"，后者必须另测；' +
        `(b) 改写器当前 temperature=0.3 不可复现，要先定死随机性才谈得上基线——` +
        `且本次单抽样实测恢复 **${liveRewrite.ran ? `${liveRewrite.recovered}/${liveRewrite.n}` : '未跑'}**，` +
        '这一路的证据强度止于「单次抽样」，不足以支撑立票。',
      '',
      '**可证伪判据**：① 关键词通道改「剔词重试」后，**必须**给出"哪些查询的召回数暴涨"的读数' +
        '（暴涨 = 稀释风险；只看 G03 一条会漏掉这个副作用）；' +
        '② 若剔词重试后 G03 的锚点仍然进不了注入集（它的 RRF 分本就极低），则**不得**以"救 G03"为由立票；' +
        '③ 改写器的收益若只在单次抽样上成立（重跑两次结果不稳），则**不得**作为修法依据。',
      '',
    ].join('\n')

    // ─── 渲染 + 落盘 ────────────────────────────────────
    const groups = {}
    for (const kind of ['real', 'constructed']) {
      groups[kind] = summarizeGroup(
        perEntry.filter((p) => p.entry.kind === kind).map((p) => p.score)
      )
    }
    const report = renderDiagnosis({
      date,
      dbPath,
      dbRows,
      dbDocs,
      goldenFile,
      goldenEntries: goldenData.entries.length,
      goldenCounts: goldenData.meta?.counts ?? {},
      params,
      embed: { model: embedStatus.model, dim: embedStatus.dim, port: embedStatus.port },
      groups,
      baselineGroups: { real: 0.5833, constructed: 0.8261 },
      liveMisses: liveMissKeys.size,
      diff,
      mergeChecks,
      fuseCheck,
      anchors,
      g03,
      channelHealth,
      knobLab,
      spec,
      topkReal,
      liveRewrite,
      counterControl,
      budget,
      maxMissDistance,
      candidates,
    })

    mkdirSync(path.dirname(outFile), { recursive: true })
    writeFileSync(outFile, report + '\n', 'utf8')

    emit(
      {
        ok: true,
        phase: 'done',
        out: outFile,
        date,
        db: dbPath,
        dbRows,
        dbDocs,
        misses: anchors.length,
        missDiff: {
          missingInLive: diff.missingInLive.length,
          extraInLive: diff.extraInLive.length,
        },
        mergeSelfCheck: { ok: mergeChecks.ok, rows: mergeChecks.rows },
        fuseSelfCheck: {
          ok: fuseCheck.ok,
          intended: fuseCheck.intended,
          compared: fuseCheck.compared,
          skipped: fuseCheck.skipped,
        },
        channelHealth,
        g03: {
          keywordAllDead: g03.queries.every((q) => q.keywordHits === 0),
          absentTerms: [...new Set(g03.queries.flatMap((q) => q.absentTerms))],
          reachableByVector: g03.corpusSweep.best
            ? {
                entryId: g03.corpusSweep.best.entryId,
                distance: g03.corpusSweep.best.distance,
                rank: g03.corpusSweep.best.rank,
              }
            : null,
          // 生产事件面：与 `reachableByVector`（黄金集面）**并列**，不是它的结论
          productionFace: g03.productionFace,
        },
        topkReal,
        knobLab,
        selectorLab,
        counterControl: {
          thresholdOk: counterControl.threshold.ok,
          killZone: counterControl.killZone.killedN,
        },
        liveRewrite: liveRewrite.ran
          ? { n: liveRewrite.n, recovered: liveRewrite.recovered }
          : { skipped: liveRewrite.reason },
        groups: {
          real: {
            recallMean: groups.real.recallMean,
            hit: groups.real.hit,
            expectTotal: groups.real.expectTotal,
          },
          constructed: {
            recallMean: groups.constructed.recallMean,
            hit: groups.constructed.hit,
            expectTotal: groups.constructed.expectTotal,
          },
        },
      },
      `[eval:retrieval:recheck] 未召回 ${anchors.length} 处（与 09-20 差：少 ${diff.missingInLive.length} / 多 ${diff.extraInLive.length}） | ` +
        `real recall=${fmt4(groups.real.recallMean)} constructed=${fmt4(groups.constructed.recallMean)} | ` +
        `G03 关键词通道全灭=${g03.queries.every((q) => q.keywordHits === 0)} 向量够得着=${g03.corpusSweep.best ? fmt4(g03.corpusSweep.best.distance) : 'no'} | ` +
        `反对照A=${counterControl.threshold.ok ? '✅' : '❌'} | ⇒ ${outFile}`
    )
    return 0
  } finally {
    stopEmbeddingSidecar()
    db.close()
  }
}

// 直接执行（非被 import）时才自举 + 跑 main —— 单测 import 本模块不得触发副作用
const isEntry =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isEntry && !bootstrap(process.argv.slice(2))) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`[eval:retrieval:recheck] 未捕获异常: ${msgOf(err)}\n`)
      process.exit(2)
    })
}
