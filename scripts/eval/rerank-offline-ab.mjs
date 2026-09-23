/**
 * R13a / S2′ —— cross-encoder 重排的**离线三臂对照**（不改生产链路一行）。
 *
 * ## 要回答的唯一问题（票面 §一）
 *
 * **在同样 ≤3 节注入量下，cross-encoder 重排能否拿回「`MEMORY_TOP_K` 放到 20 才够得着」
 * 的那些锚点？**
 *
 * | 臂 | 做法 | 注入量 |
 * | --- | --- | --- |
 * | ① | 现状：topK=3 + RRF 序 | ≤3 节 |
 * | ② | 最便宜替代：topK=5 + RRF 序 | ≤5 节 |
 * | ③ | 本票主体：topK=3 + **全序 cross-encoder 重排**（只改序、不改成员） | ≤3 节 |
 *
 * ## 边界：生产链路**零改动**
 *
 * `memory/index.ts` 的 `takenSections` 循环 / `runRetrievalChain` / `reply.ts` 的记忆注入段
 * 一行未接 —— 那是 R13b（等本票读数）。本脚本只在**跑批侧**重建全序。
 *
 * ## 重建侧复用了什么（不另写一份）
 *
 * - **检索本体**：库层 `searchChunksHybrid`（现成导出，零复制）。
 * - **合并序**：`retrieval-attribution-recheck.mjs` 的 `mergePoolsToOrder`（排序段）。
 * - **按节去重 + topK 截断**：同文件的 `injectBySection` —— 与臂①②**同一个函数**。
 *   这是刻意的：`injectBySection` 是 R13a 落地时从 `mergeQueryPools` 里**纯提取**出来的，
 *   目的就是让「按节计名额」这条规则只有一个真相源，臂③ 不会长出第二份措辞分叉。
 * - **尺子**：`scoreEntry` / `summarizeGroup` 原样（三个臂同一把尺）。
 * - **自证**：`verifyMerge` + `judgeMergeSelfCheck`（重建序 vs 链段自落的 `final` 流水）。
 *   任一条不符 ⇒ **拒出报告**。
 *
 * ⚠️ **分叉点**（票面 §五 要求写进报告）：本脚本的重建侧喂给重排的对是
 * 「**argmax 贡献趟**」——哪趟查询给该片贡献的 `rrfScore` 最大就用哪趟与它配对。
 * 生产的 `mergePoolsToOrder` 只记**首趟命中**（`queryIndex`），不记贡献趟 ⇒ 本脚本**另外
 * 算一份**（`argmaxContributionIndex`，纯附加、不改那个函数）。两者在「一片只被一趟命中」
 * 时相同，多趟命中时可能不同。
 *
 * 另一条：**嵌入失败**。生产侧单趟查询嵌入挂 ⇒ 降级为仅关键词通道、检索继续
 * （`searchChunksKeywordScored`）；本脚本同一情形 ⇒ `refuse('degradation')` 整批拒出报告。
 * 本脚本刻意更严（缺向量通道时三臂读数不可解释），故**本脚本读数不能外推到生产的嵌入故障期**。
 * 两条分叉都逐条写进报告的 §五。
 *
 * ## 不截池（票面 §五 明令）
 *
 * 全序一条不砍送打分。截池会让 `finalRank=44` 那类锚点**永远救不回**，与 R13 的立项理由
 * 直接冲突。`MAX_RERANK_PAIRS` 的取值理由见 `embed-server.mjs`。
 *
 * ## A4 与 A3 的张力（**口径说明，不是瑕疵**）
 *
 * A4 要求「跑批 json 与 md 各自 sha256 全等」，而 A3 要的是**耗时分布**——耗时天然不可复现。
 * 两者若混在一个文件里，A4 **恒不可满足**。故拆两个产物：
 *   - `rerank-offline-ab-<date>.md` / `.json` —— **确定性面**（名次/recall/判据），A4 管这里
 *   - `rerank-offline-ab-<date>.latency.json` —— **计时面**，明标不可复现，不进 A4
 * 拆开而不是「取整到毫秒碰运气」，因为后者会让 A4 变成一条**偶发假红的假门**。
 *
 * ## 输出通道（与 baseline / recheck 同款）
 *
 * stdout 只出**一行结构化 JSON**（机器通道），人类汇总走 stderr；报告写文件。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

import {
  anchorKey,
  fmt4,
  localDate,
  scoreEntry,
  summarizeGroup,
  buildCanaries,
  evaluateCanary,
  checkEmbedHealth,
  checkAttributionCoverage,
} from './retrieval-baseline.mjs'
import {
  REPORT_0920_MISSES,
  injectBySection,
  judgeMergeSelfCheck,
  mergePoolsToOrder,
  verifyMerge,
} from './retrieval-attribution-recheck.mjs'
import { buildLiveAnchorIndex, checkGoldenSet, validateGoldenSet } from './golden-check.mjs'
import { loadEnvFile } from './freeze-rewrite.mjs'

// ─── 契约常量（测试直接断言） ─────────────────────────

/** 报告 schema（形态变更时递增） */
export const RERANK_AB_REPORT_SCHEMA = 1

/** 臂① 现状（生产 `MEMORY_TOP_K` 默认值） */
export const ARM1_TOPK = 3
/** 臂② 最便宜替代（一行配置） */
export const ARM2_TOPK = 5
/** 臂③ 重排后仍取现状注入量——「同样 ≤3 节」是票面的对照前提 */
export const ARM3_TOPK = 3

/**
 * 量化交叉核对的**参考档**（比对 q8 的这把尺）。
 *
 * 取 `fp32` 而非 `fp16`——**不是偏好，是实测**：本机 onnxruntime 初始化
 * `model_fp16.onnx` 时直接抛
 * `GetIndexFromName ... does not exist: InsertedPrecisionFreeCast_/roberta/.../LayerNorm/Constant_output_0
 * for node: .../SimplifiedLayerNormFusion/`，
 * 即图优化 pass 在这种 fp16 图上出 bug；关 `graphOptimizationLevel` 才加载得起来。
 * `model.onnx`（fp32）默认档直接可用，且**不需要给 sidecar 加任何旋钮**。
 *
 * 实测两档同分（同一对：fp32 0.962977 / fp16 关优化 0.962865）⇒ 取 fp32 不损判别力，
 * 还省掉一条「诊断路径与生产路径加载参数不同」的解释负担。
 */
export const QUANT_REF_DTYPE = 'fp32'

/**
 * 量化交叉核对的**既有读数**——**证据迁移，非本批实测**。
 *
 * 为什么是常量而不是每批重跑：`--quant-crosscheck` 的参考档（见 `QUANT_REF_DTYPE`）本机实测
 * ≈ 296 ms/对（q8 的 8.5 倍）⇒ 单遍 ≈ 7.5 分钟；而 A4 要的是**同 flags 连跑两遍**的 sha256
 * 全等，两者装不进同一轮。触发条件（臂③ 增量 ≤ 0）**已经满足过**，结论已由 `batchSha` 那一批
 * 关闭；只要不换模型、不换 dtype，重跑不产生新信息。
 *
 * ⚠️ **改这段数字的唯一合法方式是重跑 `--quant-crosscheck` 并同期更新 `batchSha`**——
 * 手改会让 §三 变成一条无来源的假读数（本仓点名过的「复述面分叉」）。
 * 换模型 / 换 dtype / 换重建侧 ⇒ 本批读数作废。
 */
export const QUANT_CROSSCHECK_EVIDENCE = {
  /** 产出这批读数的提交 sha（读数落在该提交的 `*.latency.json` 里） */
  batchSha: '36a434d3',
  model: 'Xenova/bge-reranker-base',
  hitQ8: 23,
  hitRef: 24,
  hitDelta: 1,
  top3SameEntries: 25,
  argmaxSameEntries: 30,
  entries: 40,
}

/**
 * 本机时区的时刻串——**只给计时面用**（`*.latency.md` 明标不可复现，故允许含时刻）。
 *
 * 存在的理由：产物文件名里的 `--date` 是**实验身份名**（与确定性面共用、可被显式指定），
 * 不是生成时刻。用它替读数计时，等于让一个可被指定的标签替读数撒谎。
 * ⚠️ **确定性面（md / json）一个字都不许用它**——那两份是 A4 的 sha256 比对对象。
 */
export function localStamp(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  const offMin = -now.getTimezoneOffset()
  const sign = offMin >= 0 ? '+' : '-'
  const abs = Math.abs(offMin)
  return (
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ` +
    `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())} ` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  )
}

/** 单次重排请求的超时。**不是生产值**——生产子预算由 R13b 定，见票面 A3 ②。 */
export const RERANK_REQUEST_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 非退化判据的阈值（A5 追加断言）。
 *
 * 取 0.5 的理由：本模型的单 logit 经 sigmoid ⇒ 值域 (0,1)、0.5 是「相关/不相关」的
 * 自然分界。**关键在于判据不是「跑通了」而是「两者可分且不等」**——S0 实测的
 * `softmax([单logit]) ≡ 1` 退化会让两侧**都等于 1**，那时 `rel > 0.5 && irr < 0.5`
 * 必假 ⇒ 当场红。这正是这条断言要兜的形态。
 */
export const RERANK_RELEVANT_MIN = 0.5
export const RERANK_IRRELEVANT_MAX = 0.5

// ─── 纯函数（可单测，不碰 I/O） ───────────────────────

/**
 * **argmax 贡献趟**：哪趟查询给这一片贡献的 `rrfScore` 最大，就用哪趟与它配对。
 *
 * 为什么不是「首趟命中」（票面 §五 已裁）：一片可能被多趟查询命中，而**首趟**只是它
 * 第一次出现的地方——语义上任意（取决于改写器吐出的顺序）。贡献趟答的是「哪条查询
 * 才是把它捞上来的主力」，与 cross-encoder 要判的「这对(query, passage)有多相关」
 * 语义同一。
 *
 * 并列时取**更早**的趟（`>` 而非 `>=`）：与 `buildRecheckIndex` 的「同距保留更早查询」
 * 同一条纪律——并列时必须有确定性的选择，否则同输入两次跑批会给出不同配对。
 *
 * @returns 命中的趟下标；该片在任何池里都没有 ⇒ -1（**显式哨兵**，不编一个 0 出来）
 */
export function argmaxContributionIndex({ pools, chunkId }) {
  let bestIdx = -1
  let bestScore = -Infinity
  pools.forEach((p, qi) => {
    for (const hit of p.hits) {
      if (hit.row.id !== chunkId) continue
      if (hit.rrfScore > bestScore) {
        bestScore = hit.rrfScore
        bestIdx = qi
      }
    }
  })
  return bestIdx
}

/**
 * 把**全序**（一条不砍）配成 `(query, passage)` 对，供重排打分。
 *
 * `passage` 取自池内命中行的 `body`（`searchChunksHybrid` 返回整行 ⇒ 不必回头再查库）。
 *
 * ⚠️ `queryIndex === -1`（该片不在任何池里）**抛错**而不是回退到 `pools[0]`：
 * 那意味着「order 里的片不是从 pools 来的」，是重建链断了——回退会把一条断链伪装成
 * 一条正常读数，正是本仓反复栽的「探针瞎了也给同样的 0」。
 */
export function buildRerankPairs({ order, pools, bodyOf }) {
  return order.map((r) => {
    const qi = argmaxContributionIndex({ pools, chunkId: r.chunkId })
    if (qi < 0) {
      throw new Error(
        `重建链断：chunkId=${r.chunkId}（${r.docPath} :: ${r.sectionAnchor}）不在任何查询池里 —— ` +
          '全序与逐查询池不同源，重排配对不可信'
      )
    }
    const passage = bodyOf(r.chunkId)
    // 正文校验放在**构造处**而不是调用方的 `bodyOf` lambda 里：lambda 是接线，构造是契约。
    // 放进 lambda 的话，任何新的调用方（比如诊断模式）都可能接一个不校验的取文函数，
    // 而空串照样能进 tokenizer、照样出一个看着正常的分数。
    if (typeof passage !== 'string' || passage.length === 0) {
      throw new Error(
        `chunkId=${r.chunkId} 的正文取不到（${typeof passage}）—— 空 passage 会进 tokenizer 出一个看着正常的分数`
      )
    }
    return { chunkId: r.chunkId, queryIndex: qi, query: pools[qi].query, passage }
  })
}

/**
 * 用重排分**重排全序**——只改顺序，不改成员（成员集必须与入参逐 id 相同）。
 *
 * 同分时回退到**原始合并序**（`rrfScore` 降序、`bestIndex` 升序）：与 `mergePoolsToOrder`
 * 的 tie-break 同源。重排分是浮点，同分不常见但**不是不可能**（同一 passage 被两片共用），
 * 无 tie-break 的话 `Array.sort` 的稳定性会变成隐式依赖。
 *
 * 成员集变了 ⇒ **抛错**：那说明「重排」偷偷做了增删，而票面要的是**只改序**。
 */
export function applyRerankScores({ order, pairs, scores }) {
  if (scores.length !== order.length) {
    throw new Error(`重排返回 ${scores.length} 条 ≠ 全序 ${order.length} 条`)
  }
  if (pairs.length !== order.length) {
    throw new Error(`配对数 ${pairs.length} ≠ 全序 ${order.length} 条`)
  }
  const byId = new Map(order.map((r, i) => [r.chunkId, i]))
  if (byId.size !== order.length) {
    throw new Error(
      `全序里有重复 chunkId（${order.length} 行 / ${byId.size} 个唯一 id）——按 id 回填会错位`
    )
  }
  const rows = order.map((r, i) => ({
    ...r,
    rerankScore: scores[i],
    rerankQueryIndex: pairs[i].queryIndex,
  }))
  const sorted = [...rows].sort(
    (a, b) =>
      b.rerankScore - a.rerankScore ||
      b.rrfScore - a.rrfScore ||
      a.bestIndex - b.bestIndex ||
      byId.get(a.chunkId) - byId.get(b.chunkId)
  )
  // 成员集必须逐 id 完全相同（只改序、不改成员）。上面的 `sort` 不动长度与成员，
  // 故这条**恒真**于当前实现——留着是因为「靠实现细节保证」不是契约：将来谁把 sort
  // 换成 filter+concat 就不会再有编译期信号。判据写成**真比对**而不是恒真式。
  const sameSet =
    sorted.length === order.length &&
    new Set(sorted.map((r) => r.chunkId)).size === order.length &&
    sorted.every((r) => byId.has(r.chunkId))
  if (!sameSet) throw new Error('重排后的成员集与全序不一致——重排只许改序')
  return sorted
}

/**
 * 注入集 → 节列表（`{docPath, sectionAnchor}`），供 `scoreEntry` 的 `result.sections` 用。
 *
 * 走 `order` 过滤而不是直接用 `injectedIds` 的顺序：`Set` 的迭代序是**插入序**，虽然
 * 当前实现下与 order 序恰好一致，但那是实现细节不是契约——依赖它会在某次重构后静默错位。
 */
export function injectedSections({ order, injectedIds }) {
  const seen = new Set()
  const out = []
  for (const r of order) {
    if (!injectedIds.has(r.chunkId)) continue
    const k = anchorKey(r.docPath, r.sectionAnchor)
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ docPath: r.docPath, sectionAnchor: r.sectionAnchor })
  }
  return out
}

/**
 * **非退化断言**（A5 追加项，S0 教训固化）。
 *
 * 断言的是「这把尺子**能给出不同的读数**」，而不是「它跑通了」：
 * 已知相关对必须显著高、已知不相关对必须显著低，且**两者不相等**。
 *
 * 缺这条，`text-classification` 的 `softmax([单logit]) ≡ 1` 那类退化会让臂③ ≡ 臂①，
 * 报告得出「重排无效」⇒ **票被关错**，而所有探针都显示「跑通了」。
 */
export function judgeRerankNonDegenerate({ relevant, irrelevant }) {
  // `Number.isFinite` 而不是 `typeof === 'number'`：`NaN` 过得了 typeof 那一关，
  // 然后会掉进「不可分」分支被报成 `not-separated` —— 把一个**根本没读到数**的情形
  // 说成「读到了、只是分不开」，药方完全不同（前者查模型/接口，后者查模型质量）。
  if (!Number.isFinite(relevant) || !Number.isFinite(irrelevant)) {
    return {
      ok: false,
      reason: 'not-number',
      message: `重排分不是有限数值（相关=${relevant} 不相关=${irrelevant}）——尺子没产出可判读数`,
    }
  }
  if (relevant === irrelevant) {
    return {
      ok: false,
      reason: 'constant',
      message: `重排分恒等（相关=${relevant} 不相关=${irrelevant}）——退化尺（softmax-of-one 那类），臂③ 读数不可采信`,
    }
  }
  if (!(relevant > RERANK_RELEVANT_MIN && irrelevant < RERANK_IRRELEVANT_MAX)) {
    return {
      ok: false,
      reason: 'not-separated',
      message: `重排分不可分（相关=${relevant} 应 > ${RERANK_RELEVANT_MIN}；不相关=${irrelevant} 应 < ${RERANK_IRRELEVANT_MAX}）`,
    }
  }
  return { ok: true, reason: '', message: '' }
}

/**
 * 三臂判词（票面 §二 的判据，**顺序即优先级**）。
 *
 * 顺序不是排版问题：`arm3 === arm2` 同时满足「≈ 臂②」与「不小于臂②」，而 `arm3 === arm1`
 * 又同时满足「= 臂①」——不先判「与现状无差」，一条零增量会被写成「等价但更省」的收益。
 */
export function judgeArmVerdict({ arm1Hit, arm2Hit, arm3Hit }) {
  if (arm3Hit <= arm1Hit) {
    return {
      verdict: 'close-ticket',
      message:
        `臂③(${arm3Hit}) ≤ 臂①(${arm1Hit})：重排净差为负 ⇒ **据实关票**；` +
        `但结论**不是**「序无用」（票面 §二 的预置句已作废，见 §一 订正块）——` +
        `它在动序、且救回过锚点，真正不足的是这把 cross-encoder 在 ${ARM3_TOPK} 节注入预算下的精度`,
    }
  }
  if (arm3Hit > arm2Hit) {
    return {
      verdict: 'effective',
      message: `臂③(${arm3Hit}) > 臂②(${arm2Hit})：**有效**——同样 ≤${ARM3_TOPK} 节注入拿到更多锚点`,
    }
  }
  if (arm3Hit === arm2Hit) {
    return {
      verdict: 'equivalent-but-cheaper',
      message: `臂③ = 臂②(${arm2Hit})：**等价但更省注入**（${ARM3_TOPK} 节 vs ${ARM2_TOPK} 节）——这是可写的收益，不是零`,
    }
  }
  return {
    verdict: 'close-ticket',
    message: `臂③(${arm3Hit}) < 臂②(${arm2Hit})：重排不及一行配置 ⇒ **据实关票**`,
  }
}

/**
 * A3 ③ 降级率：给定重排的固定开销，**有多少行是「新增」闸外**。
 *
 * 「新增」= 判据是 `reason !== 'timeout'` 且加开销后过闸——**不是**「加开销后过闸的行数」。
 * 两者差在那批 `reason='timeout'` 的行上：它们**本来就闸外**（实测 ms 区间 [10002, 22011]，
 * 全 ≥ 闸值），加一笔固定开销会把它们原地重复计一遍。实测差：后者报 9，真值 1——
 * 而这一条正是「降级率」作为**特性覆盖率**读数的承重处，虚高 9 倍会把结论读反。
 *
 * 先剔再算（而不是 `overAfter - alreadyOver`）：减法默认了「本来就闸外的行必然仍在 overAfter 里」，
 * 那是**靠数据现状成立**的假设；先剔只依赖 `reason` 字段本身。
 *
 * @param {{ reason: string | null, ms: number }[]} liveRows 已剔 `skipped-a2a` 的行
 * @param {number} addedCostMs 重排固定开销（均对数 × per-pair）
 * @param {number} thresholdMs 闸值
 */
export function computeDegradation(liveRows, addedCostMs, thresholdMs) {
  const denom = liveRows.length
  const alreadyOver = liveRows.filter((r) => r.reason === 'timeout').length
  const overAfter = liveRows.filter((r) => r.ms + addedCostMs >= thresholdMs).length
  const added = liveRows.filter(
    (r) => r.reason !== 'timeout' && r.ms + addedCostMs >= thresholdMs
  ).length
  return { denom, alreadyOver, overAfter, added, rate: `${added}/${denom}` }
}

/** 分位数（最近秩法，`q∈[0,1]`）。空数组 ⇒ null（**不返回 0**：「没测」≠「测到 0」） */
export function quantile(values, q) {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))
  return s[idx]
}

// ─── 自举 / 输出（与 baseline 同款） ───────────────────

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
// 走 `packages/server/node_modules` 而不是根 node_modules：pnpm 严格隔离（无 hoist），
// tsx 是 server 包的依赖，根下没有它。与 baseline / recheck 同一条解析路径。
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

export function parseArgs(argv) {
  const args = {
    root: null,
    db: null,
    env: null,
    date: null,
    out: null,
    quantCrosscheck: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--root') args.root = argv[++i] ?? null
    else if (a === '--db') args.db = argv[++i] ?? null
    else if (a === '--env') args.env = argv[++i] ?? null
    else if (a === '--date') args.date = argv[++i] ?? null
    else if (a === '--out') args.out = argv[++i] ?? null
    else if (a === '--quant-crosscheck') args.quantCrosscheck = true
    else if (a === '--help' || a === '-h') args.help = true
  }
  return args
}

const msgOf = (err) => (err && err.message ? err.message : String(err))

/** 自举：原生 node 跑 `.mjs` 无法 import `.ts`（链段是 TS） */
function bootstrap(argv) {
  if (process.env.RERANK_AB_TSX === '1') return false
  if (!existsSync(TSX_CLI)) {
    process.stderr.write(`[eval:rerank-ab] 找不到 tsx（${TSX_CLI}），请确认已执行 pnpm install\n`)
    process.exit(2)
  }
  const child = spawn(process.execPath, [TSX_CLI, fileURLToPath(import.meta.url), ...argv], {
    stdio: 'inherit',
    env: { ...process.env, RERANK_AB_TSX: '1' },
  })
  child.on('exit', (code) => process.exit(code ?? 2))
  child.on('error', (err) => {
    process.stderr.write(`[eval:rerank-ab] 拉起 tsx 失败: ${msgOf(err)}\n`)
    process.exit(2)
  })
  return true
}

function emit(report, human) {
  process.stdout.write(JSON.stringify(report) + '\n')
  process.stderr.write(human + '\n')
}

/** 统一的「闸未过」出口：**不落文件**（同 baseline B5） */
function refuse(phase, payload, human) {
  emit({ ok: false, phase, ...payload }, `[eval:rerank-ab] 拒出报告：${human}`)
  return 1
}

// ─── 报告渲染（纯函数，A4 的确定性面） ─────────────────

/** 一条锚点在某个臂下的名次读数 */
function anchorRow({ id, docPath, sectionAnchor, merged, rerankOrder }) {
  const inOrder = (ord) => {
    const rows = ord.filter((r) => r.docPath === docPath && r.sectionAnchor === sectionAnchor)
    return rows.length > 0 ? rows[0] : null
  }
  const base = inOrder(merged.order)
  const re = rerankOrder ? inOrder(rerankOrder) : null
  return {
    id,
    docPath,
    sectionAnchor,
    rrfRank: base ? base.rank : null,
    rrfScore: base ? base.rrfScore : null,
    rerankRank: re ? re.rank : null,
    rerankScore: re ? re.rerankScore : null,
    rerankQueryIndex: re ? re.rerankQueryIndex : null,
  }
}

export function renderReport(ctx) {
  const {
    date,
    dbPath,
    goldenVersion,
    params,
    arms,
    anchors,
    canary,
    rerankSelfCheck,
    mergeCheck,
    latency,
  } = ctx
  const L = []
  L.push(`# R13a 离线三臂对照报告（${date}）`)
  L.push('')
  L.push('> **本报告只读**：生产链路（`memory/index.ts` / `reply.ts`）零改动，重排只发生在跑批侧。')
  L.push(`> 库快照：\`${dbPath}\``)
  L.push(`> 黄金集：version=${goldenVersion}；重建侧 maxDistance=${params.maxDistance}`)
  L.push('')
  L.push('## 零、口径对账：**「现状」是几？**（票面写 topK=3，实测不是）')
  L.push('')
  L.push('> 读数取自活库 `retrieval_events.param_top_k`——链段每次检索**自己落的参数快照**，')
  L.push('> 不是脚本另读一遍 env（两处读会各自漂移）。')
  L.push('')
  L.push('| param_top_k | 行数 | 时间窗 |')
  L.push('| --- | --- | --- |')
  for (const r of params.liveTopKRows) {
    L.push(`| ${r.k} | ${r.n} | ${r.fromAt} → ${r.toAt} |`)
  }
  L.push('')
  L.push(`- 本批跑批环境实配 topK = **${params.liveTopK}**`)
  L.push(
    params.liveTopK === ARM1_TOPK
      ? `- ⇒ 与票面「臂① = 现状 topK=${ARM1_TOPK}」一致。`
      : `- ⚠️ **票面「臂① = 现状 topK=${ARM1_TOPK}」已过期**：现状实配是 ${params.liveTopK}，` +
          `即**臂② 才是现行配置**、臂① 是历史配置。三臂定义不动（票面常量钉死，改了就不再是同一批对照），` +
          `但读表时「臂② 相对臂① 的差」= **已经发生过的变更**，不是候选方案。`
  )
  L.push('')
  L.push('## 一、三臂读数（票面 §一「要回答的唯一问题」）')
  L.push('')
  L.push('| 臂 | 做法 | 注入量(节均) | 命中 | recall(集均) | micro |')
  L.push('| --- | --- | --- | --- | --- | --- |')
  for (const a of arms) {
    L.push(
      `| ${a.label} | ${a.how} | ${fmt4(a.meanInjectedSections)} | ${a.hit}/${a.expectTotal} | ${fmt4(a.recallMean)} | ${fmt4(a.microRecall)} |`
    )
  }
  L.push('')
  L.push(
    `- **臂③ 相对臂② 的增量**：${arms[2].hit - arms[1].hit} 个锚点（${arms[2].hit} vs ${arms[1].hit}）`
  )
  L.push(
    `- **臂③ 相对臂① 的增量**：${arms[2].hit - arms[0].hit} 个锚点（${arms[2].hit} vs ${arms[0].hit}）`
  )
  // ⚠️ 这条必须紧跟增量行：读者最先看到的是「臂③ vs 臂②」的负差，会误以为差距来自
  // 注入预算（臂② 注入 5 节）。**臂① 才是同预算对照**（两者都 ≤3 节）。
  L.push(
    `- ⚠️ **臂① 与臂③ 是「同预算」对照**（都 ≤${ARM3_TOPK} 节）：${arms[2].hit} vs ${arms[0].hit}。`
  )
  L.push(
    `  故本批结论**不是**「重排打不过 topK=${ARM2_TOPK}」，而是**在同一个 ${ARM3_TOPK} 节预算下，` +
      '重排连 RRF 原序都没打过**。臂② 注入 ' +
      `${ARM2_TOPK} 节、是**跨预算**对照，**不能当同预算的基线**。`
  )
  L.push(`- **判词**：${ctx.verdict.verdict} —— ${ctx.verdict.message}`)
  L.push('')
  // 订正块**只在臂③ 未胜出时渲染**：票面 §二 的预置句只在那时被触发（effective 时票面判据是对的，
  // 无「订正」可言）。订正块里的名字与计数**一律动态取**——硬编码的是上一批的观测，
  // 库一长就成假话源（本仓栽过：改实现没改复述）。
  if (ctx.verdict.verdict !== 'effective') {
    const gain13 = ctx.flips.arm1ToArm3.filter((x) => x.dir === 'gain')
    const loss13 = ctx.flips.arm1ToArm3.filter((x) => x.dir === 'loss')
    const gainEg = ctx.anchors
      .filter((a) => !a.arm1 && a.arm3 && a.rrfRank !== null && a.rerankRank !== null)
      .slice(0, 3)
      .map((a) => `${a.id} 从第 ${a.rrfRank} 节拉到第 ${a.rerankRank}`)
    L.push('> ⚠️ **票面预置的结论句与实测有出入，据实订正**。票面 §二 把「臂③ = 臂① 或 < 臂②」')
    L.push(
      '> 的结论写死为「**瓶颈在池的成员，不在序**」。**净差成立**' +
        `（臂③ ${arms[2].hit}、臂① ${arms[0].hit}、臂② ${arms[1].hit}），`
    )
    L.push('> 但那个结论句**与 §一之二 的得失清单矛盾**：重排确实在动序，而且动得对——')
    L.push(
      gainEg.length > 0
        ? `> ${gainEg.join('、')}，共救回 ${gain13.length} 处。`
        : `> 本批救回 ${gain13.length} 处（逐条见 §一之二）。`
    )
    L.push(
      `> 它的净差为负是因为**同时丢了 ${loss13.length} 处**（重排把 RRF 排得靠前的节压了下去）。`
    )
    L.push('')
    L.push(
      '> ⇒ 诚实结论不是「序没用」，而是「**这把 cross-encoder 在 top-3 这个预算下的精度不够**：'
    )
    L.push(
      '> 它在少数锚点上判得很准（分差 0.34 / 0.51 / 0.96），在多片节上判错（见 §七 开放问题）」。'
    )
    L.push('> 关票的动作不变，但**别把「序无用」写进归档结论**——那会让下次立票的人跳过一条本票')
    L.push('> 已有的证据。')
    L.push('')
  }
  L.push('## 一之二、臂间得失清单（状态翻转的条目）')
  L.push('')
  L.push('> **净差会把两种相反的情形抹成同一个数**：救 8 处又丢 10 处（重排有信号但不稳）与')
  L.push('> 救 0 处丢 2 处（重排没信号）净差都是 −2，药方完全相反。故逐条列出翻转项。')
  L.push('')
  for (const [name, list] of [
    ['臂① → 臂③', ctx.flips.arm1ToArm3],
    ['臂② → 臂③', ctx.flips.arm2ToArm3],
  ]) {
    const gain = list.filter((x) => x.dir === 'gain')
    const loss = list.filter((x) => x.dir === 'loss')
    L.push(`### ${name}：救 ${gain.length} 处 / 丢 ${loss.length} 处`)
    L.push('')
    if (list.length === 0) {
      L.push('（无翻转）')
      L.push('')
      continue
    }
    L.push('| 条 | 类型 | 方向 | expect 锚点 |')
    L.push('| --- | --- | --- | --- |')
    for (const x of [...gain, ...loss]) {
      L.push(`| ${x.id} | ${x.kind} | ${x.dir === 'gain' ? '✅ 救回' : '❌ 丢失'} | ${x.anchor} |`)
    }
    L.push('')
  }
  L.push('## 二、11 处对照锚点逐条 before/after 名次（A1）')
  L.push('')
  L.push('> `rrf*` 列 = 合并序（不截断）里的**节名次**；`rerank*` 列 = 重排后同一把节名次的尺。')
  L.push('> 名次是 0 基。`—` = 该锚点压根不在池里（真覆盖洞，重排救不回）。')
  L.push('')
  L.push(
    '| 锚点 | 09-20 归因 | rrfRank | rrfScore | rerankRank | rerankScore | 配对趟 | 臂① | 臂② | 臂③ |'
  )
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const a of anchors) {
    const mark = (v) => (v ? '✅' : '❌')
    L.push(
      `| ${a.id} | ${a.attribution0920} | ${a.rrfRank ?? '—'} | ${a.rrfScore === null ? '—' : fmt4(a.rrfScore)} | ` +
        `${a.rerankRank ?? '—'} | ${a.rerankScore === null ? '—' : fmt4(a.rerankScore)} | ` +
        `${a.rerankQueryIndex === null ? '—' : 'q' + a.rerankQueryIndex} | ` +
        `${mark(a.arm1)} | ${mark(a.arm2)} | ${mark(a.arm3)} |`
    )
  }
  L.push('')
  L.push('## 三、负例不劣化（A2，承重）')
  L.push('')
  L.push('| 臂 | 判红数 | 判红条目 |')
  L.push('| --- | --- | --- |')
  for (const a of arms) {
    L.push(
      `| ${a.label} | ${a.negativeFlagged}/${a.negativeTotal} | ${a.negativeIds.join(', ') || '—'} |`
    )
  }
  L.push('')
  L.push(
    '> 现制基线 = **4/5**（`docs/eval/retrieval-baseline-2026-09-20.md` §五）。任一拳升 ⇒ A2 不过。'
  )
  L.push('>')
  // ⚠️ 基线取谁：**臂①（同预算）**，不是臂②。臂② 注入 5 节、臂①③ 注入 ≤3 节——
  // 预算不同，判红数本来就不可比，拿臂② 当负例基线是**跨预算比**。
  L.push(
    `> ⚠️ **负例基线取臂①（同预算 ≤${ARM3_TOPK} 节），不是臂②**：臂② 注入 ≤${ARM2_TOPK} 节，` +
      '预算不同 ⇒ 与它比判红数是**跨预算比**，不成立。'
  )
  L.push(
    `> 臂① ${arms[0].negativeFlagged}/${arms[0].negativeTotal} vs 臂③ ${arms[2].negativeFlagged}/${arms[2].negativeTotal}`
  )
  L.push(
    `> ⇒ **臂③ 相对同预算基线${arms[2].negativeFlagged > arms[0].negativeFlagged ? '**上升 ❌**' : '未上升 ✅'}**。`
  )
  L.push('>')
  // 方向必须点出来：判红 = 负例**被召回并注入**，越高越差。只并列数会让读者把 5/5 当好事。
  L.push(
    `> 📌 **臂②（现行配置 ${ARM2_TOPK} 节）判红 ${arms[1].negativeFlagged}/${arms[1].negativeTotal}**——` +
      '**方向要读对：判红越高越差**（A2 防的就是「多注几节把噪声也带进来」）。'
  )
  L.push(
    `> 这是 topK=${ARM2_TOPK} 的**成本面**：多注的 2 节换来的不只是更多锚点，还有更多负例被注入。`
  )
  L.push('')
  L.push('## 四、尺子自证（A5，承重）')
  L.push('')
  L.push(
    `- 检索 canary（必中 + 必不中钉同一锚点）：${canary.map((c) => `${c.id}=${c.ok ? '✅' : '❌'}`).join('；')}`
  )
  L.push(
    `- **非退化断言**：相关=${
      rerankSelfCheck.relevant === null ? '—' : rerankSelfCheck.relevant.toFixed(6)
    } / 不相关=${
      rerankSelfCheck.irrelevant === null ? '—' : rerankSelfCheck.irrelevant.toFixed(6)
    } ⇒ ${rerankSelfCheck.ok ? '✅ 可分且不等' : '❌ ' + rerankSelfCheck.reason}`
  )
  L.push(
    `- **合并序重建自证**：实比 ${mergeCheck.rows} 行 final 流水，不符 ${mergeCheck.mismatches.length} 处 ⇒ ${
      mergeCheck.ok ? '✅' : '❌'
    }`
  )
  L.push('')
  L.push('## 五、分叉点（票面 §五 要求写进报告）')
  L.push('')
  L.push(
    '- **配对规则**：本脚本用 **argmax 贡献趟**（`argmaxContributionIndex`），生产重建侧只记**首趟命中**。'
  )
  L.push('  两者在「一片只被一趟命中」时相同；多趟命中时可能不同。')
  L.push(
    '- **嵌入失败**：生产侧单趟查询嵌入挂 ⇒ **降级为仅关键词通道、检索继续**' +
      '（`memory/index.ts` 的 `searchChunksKeywordScored` 按同一条 RRF 公式补分，不是假值）；'
  )
  L.push(`  本脚本同一情形 ⇒ \`refuse('degradation')\` **整批拒出报告**（与 recheck 同一条硬闸）。`)
  L.push(
    '  本脚本刻意更严：缺向量通道时三臂读数不可解释，宁可不出报告，也不出一份「向量通道静默缺席」的读数。'
  )
  L.push(
    '  ⚠️ 故**本脚本的读数不能外推到生产在嵌入故障期的行为**——那是 `index.ts` 的降级路径，本票没测。'
  )
  L.push(
    '- 其余（检索本体 / 融合公式 / 跨查询合并 / 按节去重与 topK 截断）**同源复用**，见文件头。'
  )
  L.push('')
  L.push('## 六、延迟与降级率（A3）')
  L.push('')
  L.push('> **读数不落在本文件**，在同基名的 `...latency.md` / `...latency.json`。')
  L.push('>')
  L.push('> 理由是 A4 与 A3 的硬冲突：A4 要求本文件的 sha256 **连跑两遍全等**，而 A3 要的是')
  L.push('> **耗时分布**——耗时天然不可复现。两者同文件 ⇒ A4 **恒不可满足**（每条读数都变 ⇒')
  L.push('> 比对永远红）。故按**可复现性**切两半，而不是把毫秒取整去碰运气（那会把 A4 变成')
  L.push('> 一条偶发假红的假门）。')
  L.push('>')
  L.push('> ⚠️ **A4 的完整口径**：确定性以**库快照**为条件（「同输入」含同一份库）。本跑批读的是')
  L.push('> **活库**（dev server 正在写），故跨快照复跑必然不同——**那是输入变了，不是重排引入了**')
  L.push('> **随机性**。要复核 A4，请在**同一份库快照**上连跑两遍比对（或先备份库再跑）。')
  L.push('')
  L.push('- A3 要求的三组读数（重排段分布 / 加到检索后的分布 / 降级率推演）**全在那一份里**。')
  L.push('')
  L.push('> 本节**刻意一个数字都不落**。写了「本批 p50=1281ms」这类句子读起来方便，但它会让本文件')
  L.push('> 的 sha256 每跑必变 ⇒ A4 直接失效，而且**失效得很安静**（比对红是红的，但根因在')
  L.push('> 「为什么红」——一条被写坏的判据）。')
  L.push('')
  L.push('## 七、开放问题（**没查清就写清**，不留给下一个人重新发现）')
  L.push('')
  L.push('1. **重排只打分「节的代表片」，而注入是整节** —— 粒度不匹配。多片节（L3-f 硬切）里')
  L.push('   与查询相关的那部分如果不在代表片上，重排看到的就是别的部分。本批 13 处翻转锚点中，')
  L.push(
    '   救回组 2/5 是多片节、丢掉组 **6/8** 是多片节 —— **方向性提示明显，但 n=13、未做检验**，'
  )
  L.push('   **不足以当结论**。若将来重立票，这是第一个该查的地方。')
  // ⚠️ 本条**刻意不读 `ctx.quantCrosscheck`**：交叉核对的渲染整体移到 `renderLatencyReport`。
  // 理由（治的是结构不是措辞）：det 面（md + json）是 A4 的 sha256 比对对象，只要它引用了
  // 一个「跑批时带不带 flag」才有的字段，A4 双跑就必须两次都带上那个 flag——而 fp32 交叉核对
  // 单遍 ≈ 7.5 分钟（q8 的 8.5 倍），双跑装不进一轮。移走之后 **det 面按构造与 flag 无关**，
  // 交叉核对可以单跑一次、与 A4 解耦。读数（含批次 sha 与「证据迁移」标注）见 `...latency.md` §三。
  L.push('2. **量化（q8）已交叉核对** —— 触发条件（臂③ 增量 ≤ 0）已满足，按跑批前定死的条件跑过。')
  L.push('   读数与**批次 sha** 见 `...latency.md` §三；⚠️ 那是**既有批次的证据迁移**，')
  L.push('   **不得读作本批实测**（本批未重跑交叉核对，理由见该节）。OQ 由那份证据关闭。')
  L.push(
    '3. **「现状 topK」的口径在票面与活库之间漂移** —— 见 §零。本条影响的是**归档结论的可读性**，'
  )
  L.push('   不影响三臂读数（臂由票面常量钉死）。')
  L.push('4. **A2 的基线「现制 4/5」也是 topK=3 时代的读数** —— 按活库**现行配置**（topK=5）实测为')
  L.push('   **5/5**。两个口径给出**方向相反**的判读，而票面没写用哪个：')
  L.push('   - 按票面基线 4/5：臂③ 实测 4/5 ⇒ **不劣化**（本报告采此口径）')
  L.push('   - 按真实现制 5/5：臂③ 4/5 是**改善 1 条**；而臂② 正是现行配置本身 = 5/5')
  L.push('   ⇒ **口径已由店长裁定：采票面口径 4/5。** 理由不是「不中途改判据」，而是')
  L.push(`   **臂① 是唯一同预算（≤${ARM3_TOPK} 节）的对照**——臂② 注入 ≤${ARM2_TOPK} 节，`)
  L.push('   拿它当负例基线是**跨预算比**，不成立。')
  L.push('   ⚠️ **方向要读对**：现行配置 topK=5 拿到负例 **5/5 全中**，这是 topK=5 的**成本面**')
  L.push('   （多注 2 节，把更多噪声也带了进来），**不是「更好」**。')
  L.push('5. **重排段耗时随序列长度走，不能从 S0 曲线外推** —— S0 的 49.4ms/pair 是**填到 450 字的')
  L.push('   合成件**；本批真实切片均长更短。')
  L.push('   **任何从 S0 曲线外推 per-pair 的做法都不可采信**——外推方向随批次与**机器负载档**变：')
  L.push('   本票已实测到**方向相反**的两个档（见 `...latency.md` §一 的两档表）。')
  L.push(
    '   ⚠️ **本段刻意不写本批的 per-pair 数值**：本文件是 A4 的 sha256 比对对象，塞一个耗时数字'
  )
  L.push('   进来 ⇒ 两次跑批的 md 必然不等（负载档一变就变），**A4 当场变成恒不可满足的假门**。')
  L.push('   本批实测值一律只落在计时面（`...latency.md` / `.latency.json`）。')
  L.push('')
  return L.join('\n') + '\n'
}

/** 计时面报告（**不可复现**，A4 不管它）。单独落文件，理由见主报告 §六。 */
export function renderLatencyReport(ctx) {
  const { date, dbPath, latency, arms } = ctx
  const L = []
  L.push(`# R13a 延迟与降级率（${date}）`)
  L.push('')
  L.push(`> 实测时刻：**${localStamp()}**（本机时区）。⚠️ 标题里的 \`${date}\` 是**实验身份名**`)
  L.push(
    '> （与确定性面产物共用，来自 `--date`），**不是本文件的生成时刻**——判「这份读数是哪一轮的」'
  )
  L.push('> 要看这行，别读 `--date`。')
  L.push('> ⚠️ **本文件不可复现**（耗时随机器负载变），**不参与 A4 的 sha256 比对**。')
  L.push(`> 库快照：\`${dbPath}\``)
  L.push('')
  L.push('## 一、重排段耗时分布（A3）')
  L.push('')
  L.push('| 读数 | 值 |')
  L.push('| --- | --- |')
  L.push(`| 重排段 p50 | ${latency.rerankP50} ms |`)
  L.push(`| 重排段 p95 | ${latency.rerankP95} ms |`)
  L.push(`| 重排段最大 | ${latency.rerankMax} ms |`)
  L.push(`| per-pair（实测） | ${latency.perPairMs} ms |`)
  L.push(`| 均对数/条 | ${latency.meanPairsPerEntry} |`)
  L.push(`| 检索耗时 p50（重排前） | ${latency.retrievalP50} ms |`)
  L.push(`| 检索+重排 p50 | ${latency.totalP50} ms |`)
  L.push(`| 检索+重排 p95 | ${latency.totalP95} ms |`)
  L.push(
    `| 顶破 ${latency.thresholdMs}ms 闸（黄金集面） | ${latency.overGateInGolden} / ${arms.length ? latency.degradation[0].denom : 0} |`
  )
  L.push('')
  L.push('> ⚠️ 与 S0 的 49.4ms/pair 不同不是矛盾：S0 的 passage 是**填到 450 字**的合成件，')
  L.push('> 本批是**真实切片**（长度不一，短的几十字）⇒ 单对成本随序列长度走。')
  L.push(
    `> 本批实测 per-pair **${latency.perPairMs} ms**、检索段 p50（**重排前**）**${latency.retrievalP50} ms**。`
  )
  L.push(
    '> **任何从 S0 曲线外推 per-pair 的做法都不可采信**——外推方向随**机器负载档**变。本票实测到'
  )
  L.push('> 两个**都可复现**的档（下表是对照读数，取自本票前后两次跑批，**不是本批**）：')
  L.push('>')
  L.push('> | 档 | per-pair | 检索段 p50（重排**前**） | 黄金集顶破闸 |')
  L.push('> | --- | --- | --- | --- |')
  L.push('> | 轻载 | 34.7 ms | 31 ms | 0/40 |')
  L.push('> | 重载 | 235–258 ms | 347–358 ms | 15–21/40 |')
  L.push('>')
  L.push(
    '> 判读：**检索段里没有重排**，它却与 per-pair 同幅变慢（约 11×）⇒ 两档之差是**整机负载**，'
  )
  L.push('> 不是「尺子变慢」。本批落在哪一档，拿本批的检索段 p50 与上表对读即可。')
  L.push('> ⚠️ 别再花时间归因到某个具体进程——本票三次尝试均**未**定位到争用源，而结论不依赖它。')
  L.push('')
  L.push('## 二、A3 ① timeout 基线 + ③ 降级率推演')
  L.push('')
  L.push('### A3 ① timeout 基线（**实施者独立复核**，票面明令不采信店长给的数）')
  L.push('')
  const tb = latency.timeoutBaseline
  L.push('| 读数 | 值 |')
  L.push('| --- | --- |')
  L.push(`| 分母（reason ≠ \`skipped-a2a\`） | ${tb.denom} |`)
  L.push(`| 分子（reason = \`timeout\`） | ${tb.timeout} |`)
  L.push(`| **基线** | **${tb.rate} = ${tb.pct}%** |`)
  L.push(`| 对照：不剔 \`skipped-a2a\` 的分母 | ${tb.denomAllReasons} ⇒ ${tb.pctAllReasons}% |`)
  L.push(`| \`skipped-a2a\` 行数（全部 \`retrieval_ms = 0\`） | ${tb.denomAllReasons - tb.denom} |`)
  L.push(
    `| 非 timeout 行的最慢一条 | ${tb.slowestNonTimeout} ms（距闸余量 ${latency.headroomMs} ms） |`
  )
  L.push('')
  L.push(
    `> 余量的意义：翻线所需的最小池深 N = ceil(${latency.headroomMs} / ${latency.perPairMs}) = ` +
      `${Math.ceil(latency.headroomMs / latency.perPairMs)} 对。⚠️ 这是**当前活库快照**上的读数，` +
      '活库每条新检索都会移动这条最慢行 ⇒ 余量是**会变的**。'
  )
  L.push('')
  L.push('### A3 ③ 降级率推演')
  L.push('')
  L.push('| 面 | 分母 | **新增**降级 | 降级率 | 闸外总数 |')
  L.push('| --- | --- | --- | --- | --- |')
  for (const d of latency.degradation) {
    L.push(
      `| ${d.face} | ${d.denom} | ${d.added} | ${d.rate} | ${
        d.overAfter === undefined ? '—' : d.overAfter
      } |`
    )
  }
  L.push('')
  const live = latency.degradation[1]
  L.push(
    `> 「新增」= 闸外总数 − **本来就闸外**的行。活库那 ${live.denom} 行里已有 **${live.alreadyOver}** 行是` +
      ` \`reason=timeout\`（ms 本就 ≥ ${latency.thresholdMs}）—— 不剔掉的话，加一笔固定开销会把它们` +
      '原地重复计一遍，「新增」当场虚高。'
  )
  L.push('')
  L.push('> 生产侧**尚未接重排**，「跳过重排」在今天是结构性条款（票面 A3 ②），不是既存行为。')
  L.push('> 本表是「若接上、给定子预算」的推演，**不作 R13a 的判据**。')
  L.push('>')
  L.push(
    `> ⚠️ 活库面用的是**均对数**（${latency.meanPairsPerEntry} 对/条）——那 40 条金标查询的池深` +
      '**不代表真实流量**的池深分布。要精确推演得先采真实流量的池深，本票没采。'
  )
  L.push('')
  L.push('## 三、量化交叉核对（`--quant-crosscheck`）')
  L.push('')
  const ev = QUANT_CROSSCHECK_EVIDENCE
  L.push(
    `> ⚠️ **证据迁移，非本批实测**。本批**未重跑**交叉核对：下表是批次 \`${ev.batchSha}\` 的读数，`
  )
  L.push('> 原样搬来关闭「量化（q8）造出了『重排无效』」这条替代解释。不重跑的理由——参考档')
  L.push(`> \`${QUANT_REF_DTYPE}\` 在本机实测 ≈ 296 ms/对（q8 的 8.5 倍）⇒ 单遍 ≈ 7.5 分钟，`)
  L.push(
    '> 与同样要跑两遍的 A4（确定性面 sha256 比对）装不进同一轮；而只要**不换模型 / 不换 dtype**，'
  )
  L.push(
    '> 重跑不产生新信息。**换了任何一个，这批读数即作废、必须重跑**（改数字不许手改，见常量注释）。'
  )
  L.push('')
  L.push('| 读数（批次 `' + ev.batchSha + '`） | 值 |')
  L.push('| --- | --- |')
  L.push(`| 臂③ 命中（q8） | ${ev.hitQ8} |`)
  L.push(`| 臂③ 命中（${QUANT_REF_DTYPE}） | ${ev.hitRef} |`)
  L.push(`| **命中差** | **${ev.hitDelta}** |`)
  L.push(`| top-3 节集完全相同的条目 | ${ev.top3SameEntries} / ${ev.entries} |`)
  L.push(`| argmax 片相同的条目 | ${ev.argmaxSameEntries} / ${ev.entries} |`)
  L.push(`| 模型 | \`${ev.model}\` |`)
  L.push('')
  // 判词比对用**本批**的臂① / 臂② 命中数——证据批次的臂① 会随快照漂移，拿旧臂① 比是跨批比。
  const vQ8 = judgeArmVerdict({ arm1Hit: arms[0].hit, arm2Hit: arms[1].hit, arm3Hit: ev.hitQ8 })
  const vRef = judgeArmVerdict({ arm1Hit: arms[0].hit, arm2Hit: arms[1].hit, arm3Hit: ev.hitRef })
  L.push(
    `> 判词比对（分母用**本批** 臂① ${arms[0].hit} / 臂② ${arms[1].hit}）：q8 \`${vQ8.verdict}\`、` +
      `${QUANT_REF_DTYPE} \`${vRef.verdict}\` —— ` +
      (vQ8.verdict === vRef.verdict
        ? '**判词不变** ⇒ 量化不改结论。'
        : '**判词会变** ⇒ q8 下的结论不可直接采信。')
  )
  L.push(
    '> ⚠️ 判据是**判词是否变**，不是「命中数是否有差」：命中差是噪声，不动方向（名次面另有上面两张'
  )
  L.push(
    '> 一致率表）。拿 `hitDelta` 当判据会把「有噪声但不动结论」误报成「不可采信」——那是过强的判词。'
  )
  L.push('')
  if (ctx.quantCrosscheck) {
    const q = ctx.quantCrosscheck
    L.push('### 本批实测（`--quant-crosscheck` 已跑）')
    L.push('')
    L.push(`> 模型 \`${q.model}\`，比 q8 与 ${q.refDtype} 两把尺在**同一批 pairs** 上的读数。`)
    L.push('')
    L.push('| 读数 | 值 |')
    L.push('| --- | --- |')
    L.push(`| 臂③ 命中（q8） | ${q.hitQ8} |`)
    L.push(`| 臂③ 命中（${q.refDtype}） | ${q.hitRef} |`)
    L.push(`| **命中差** | **${q.hitDelta}** |`)
    L.push(`| top-3 节集完全相同的条目 | ${q.top3SameEntries} / ${q.entries} |`)
    L.push(`| argmax 片相同的条目 | ${q.argmaxSameEntries} / ${q.entries} |`)
    L.push(`| 最大单对分数差 | ${q.maxAbsScoreDelta.toExponential(3)} |`)
    L.push('')
    L.push(`> ${q.note}`)
    L.push('')
  }
  L.push('## 四、逐条原始计时')
  L.push('')
  L.push('| 条目 | 检索 ms | 重排 ms | 对数 | passage 字符数 | ms/对 | ms/千字 |')
  L.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const t of ctx.timings) {
    const perPair = t.pairs > 0 ? t.rerankMs / t.pairs : null
    const perKChar = t.chars > 0 ? (t.rerankMs / t.chars) * 1000 : null
    L.push(
      `| ${t.id} | ${t.retrievalMs} | ${t.rerankMs} | ${t.pairs} | ${t.chars} | ` +
        `${perPair === null ? '—' : perPair.toFixed(1)} | ${perKChar === null ? '—' : perKChar.toFixed(1)} |`
    )
  }
  L.push('')
  return L.join('\n') + '\n'
}

// ─── 主流程 ───────────────────────────────────────────

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(
      '用法: node scripts/eval/rerank-offline-ab.mjs [--root <仓库根>] [--db <sqlite>]\n' +
        '       [--env <外部 .env>] [--date YYYY-MM-DD] [--out <报告路径>]\n' +
        '  R13a 离线三臂对照（topK=3 / topK=5 / topK=3+重排）。**生产链路零改动**。\n' +
        '  报告缺省落 docs/eval/rerank-offline-ab-<date>.md，同批另出 .json（均确定性）\n' +
        '  与 .latency.md / .latency.json（计时面，不可复现）。\n' +
        `  --quant-crosscheck  追加 q8-vs-${QUANT_REF_DTYPE} 排序一致性核对（诊断，默认关）。\n` +
        '                      触发条件是跑批前定死的：臂③ 增量 ≈0 或为负时才跑。\n'
    )
    return 0
  }

  const root = args.root ?? REPO_ROOT
  const date = args.date ?? localDate()
  const goldenFile = path.join(root, 'docs', 'eval', 'retrieval-golden.json')
  const outFile = args.out ?? path.join(root, 'docs', 'eval', `rerank-offline-ab-${date}.md`)
  const jsonFile = outFile.replace(/\.md$/, '.json')
  const latencyFile = outFile.replace(/\.md$/, '.latency.json')
  const latencyMdFile = outFile.replace(/\.md$/, '.latency.md')

  await import(pathToFileURL(path.join(root, 'packages/server/src/env.js')).href)
  if (args.env) {
    try {
      const { loaded } = loadEnvFile(args.env)
      process.stderr.write(`[eval:rerank-ab] 从 ${args.env} 补载 ${loaded} 个变量\n`)
    } catch (err) {
      process.stderr.write(`[eval:rerank-ab] 读不到 --env 指定的文件 ${args.env}: ${msgOf(err)}\n`)
      return 2
    }
  }

  // 端口隔离：恒动态端口（同 baseline——继承活 server 的端口会 EADDRINUSE 降级成假读数）
  process.env.EMBED_SIDECAR_PORT = '0'

  let goldenData
  try {
    goldenData = JSON.parse(readFileSync(goldenFile, 'utf8'))
  } catch (err) {
    process.stderr.write(`[eval:rerank-ab] 读不到黄金集 ${goldenFile}: ${msgOf(err)}\n`)
    return 2
  }
  const schema = validateGoldenSet(goldenData)
  if (!schema.ok) {
    return refuse(
      'golden-schema',
      { errors: schema.errors },
      `黄金集 schema 不过（${schema.errors.length} 条）`
    )
  }

  const dbPath = path.resolve(
    args.db ?? path.join(root, 'packages', 'server', 'data', 'cat-study-dev.db')
  )
  if (!existsSync(dbPath)) {
    process.stderr.write(
      `[eval:rerank-ab] 库不存在：${dbPath}\n  （worktree 内没有 data/*.db，它是未跟踪产物；请 --db 指向主仓库的库）\n`
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

  const embedCache = new Map()
  const memoEmbed = async (text) => {
    if (embedCache.has(text)) return embedCache.get(text)
    const r = await embedText(text)
    // 只缓存成功（族修：一次瞬时失败不固化成整趟永久失败）
    if (r && r.ok && r.vector && r.vector.length > 0) embedCache.set(text, r)
    return r
  }

  try {
    // ─── 前置闸：golden-check（锚点腐烂即停） ───
    const scanMod = await import(pathToFileURL(path.join(root, 'scripts/flywheel/scan.mjs')).href)
    const { segmentDocument } = await import(
      pathToFileURL(path.join(root, 'packages/server/src/memory/flywheel/segment.ts')).href
    )
    const index = buildLiveAnchorIndex({ root, scanMod, segment: segmentDocument })
    const { rotten, checked } = checkGoldenSet({ data: goldenData, index })
    if (rotten.length > 0) {
      return refuse(
        'golden-rotten',
        { rotten, checked },
        `黄金集锚点腐烂 ${rotten.length} 处（标尺过期，先回 R9 流程重标）`
      )
    }

    const params = currentRetrievalParams()
    /** 重建侧用**生产的 maxDistance**（0.6）——`verifyMerge` 要拿重建序与链段落库的
     *  `final` 流水逐行比，两者参数不同则比的是两件事。 */
    const maxDistance = params.maxDistance
    /** 环境里**实配**的 topK。⚠️ 它**不决定任何臂**（三臂由票面常量钉死），只用来对账：
     *  票面写「臂① = 现状 topK=3」，而活库参数快照显示现状早已是 5（见报告「口径对账」段）。
     *  把实配值报出来、不拿它去改臂的定义——否则「臂①」会随环境漂移，三臂就不再是同一批。 */
    const liveTopK = params.topK
    /** 活库里的 `param_top_k` 分布（判「现状是几」的**唯一**权威面：链段自己落的快照，
     *  不是脚本另读一遍 env——两处读会各自漂移）。 */
    const liveTopKRows = db
      .prepare(
        'SELECT param_top_k AS k, count(*) AS n, min(created_at) AS fromAt, max(created_at) AS toAt ' +
          'FROM retrieval_events GROUP BY param_top_k ORDER BY n DESC'
      )
      .all()

    await startEmbeddingSidecar()
    const embedStatus = getEmbeddingStatus()
    if (!embedStatus.ok) {
      return refuse(
        'embed-unavailable',
        { reason: embedStatus.reason },
        `嵌入链未就绪（${embedStatus.reason}）`
      )
    }
    if (!embedStatus.port) {
      return refuse(
        'embed-unavailable',
        { reason: 'no-port' },
        '嵌入链无握手端口——无法调 /v1/rerank'
      )
    }
    const sidecarBase = `http://127.0.0.1:${embedStatus.port}`

    const callRerank = async (pairs) => {
      const res = await fetch(`${sidecarBase}/v1/rerank`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairs }),
        signal: AbortSignal.timeout(RERANK_REQUEST_TIMEOUT_MS),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        throw new Error(
          `/v1/rerank HTTP ${res.status}: ${body?.reason ?? '?'} ${body?.detail ?? ''}`
        )
      }
      if (!body || !Array.isArray(body.scores)) {
        throw new Error(`/v1/rerank 响应形态不符：${JSON.stringify(body)?.slice(0, 200)}`)
      }
      return { scores: body.scores, model: body.model }
    }

    // ─── 尺子第一关：重排自身可不可分（A5 非退化）───
    // 这条**必须在跑批之前**：退化尺会给出「臂③ ≡ 臂①」的假读数把票关错（S0 实测）。
    const canaryTarget = db
      .prepare(
        'SELECT doc_path AS docPath, section_anchor AS sectionAnchor FROM chunks ' +
          'ORDER BY length(section_anchor) DESC, doc_path ASC, section_anchor ASC LIMIT 1'
      )
      .get()
    if (!canaryTarget) return refuse('corpus', {}, '库内没有可作 canary 的节')
    const canaryBody = db
      .prepare(
        'SELECT body FROM chunks WHERE doc_path = ? AND section_anchor = ? ORDER BY part_index LIMIT 1'
      )
      .get(canaryTarget.docPath, canaryTarget.sectionAnchor).body
    const canaryQuery = canaryTarget.sectionAnchor
    const negPassage =
      '把三个端口按顺序释放，释放之前先确认占用者是本进程自己 spawn 的子进程；' +
      '不是的话就跳过并打日志，避免误杀用户手工启动的实例。'
    const rerankProbe = await callRerank([
      { query: canaryQuery, passage: canaryBody },
      { query: canaryQuery, passage: negPassage },
    ])
    const rerankSelfCheck = {
      ...judgeRerankNonDegenerate({
        relevant: rerankProbe.scores[0],
        irrelevant: rerankProbe.scores[1],
      }),
      relevant: rerankProbe.scores[0],
      irrelevant: rerankProbe.scores[1],
      model: rerankProbe.model,
    }
    if (!rerankSelfCheck.ok) {
      return refuse(
        'rerank-degenerate',
        { selfCheck: rerankSelfCheck },
        `重排尺退化（${rerankSelfCheck.reason}）：${rerankSelfCheck.message}`
      )
    }

    // ─── 尺子第二关：检索 canary（必中 + 必不中钉同一锚点）───
    const canaries = buildCanaries({
      docPath: canaryTarget.docPath,
      sectionAnchor: canaryTarget.sectionAnchor,
    })
    const canaryRuns = []
    const canaryResults = []
    for (const c of canaries) {
      const r = await runRetrievalChain([c.query], { startedAt: Date.now() })
      canaryRuns.push({ id: c.id, result: r })
      canaryResults.push(evaluateCanary({ canary: c, result: r }))
    }
    const canaryHealth = checkEmbedHealth(canaryRuns)
    const canaryBad = canaryResults.filter((c) => !c.ok)
    if (canaryBad.length > 0 || !canaryHealth.ok) {
      return refuse(
        'canary',
        { canaries: canaryResults.map((c) => ({ id: c.id, ok: c.ok, reason: c.reason })) },
        `检索 canary 不过或嵌入链降级——尺子不可信，三臂读数全部作废`
      )
    }

    // ─── 逐条跑批：三臂 ───
    const perEntry = []
    const mismatchAll = []
    let finalRowsChecked = 0
    const timings = []

    for (const entry of goldenData.entries) {
      const queries = [...new Set([entry.query, ...entry.rewritten])]

      const tRet0 = Date.now()
      const result = await runRetrievalChain(queries, { startedAt: Date.now() })
      const retrievalMs = result.stats?.retrievalMs ?? Date.now() - tRet0

      // 逐查询池（生产 maxDistance —— 与链段同参数，verifyMerge 才比得上）
      const pools = []
      for (const q of queries) {
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

      // ⚠️ `rank` 是 `injectBySection` **写进行对象**的，不是 `mergePoolsToOrder` 给的
      // ——`verifyMerge` 逐行核 `r.rank`，漏了这一步它会把 40 条全判红（`rebuilt: undefined`）。
      // 首次实跑正是被这条自证当场拦下的，不是靠人眼。
      const merged1 = injectBySection({ order: mergePoolsToOrder({ pools }), topK: ARM1_TOPK })
      const order = merged1.order

      const check = verifyMerge({ order, result })
      finalRowsChecked += check.checked
      if (!check.ok) mismatchAll.push({ id: entry.id, mismatches: check.mismatches.slice(0, 5) })

      // ── 臂②：同一份合并序，只换 topK ──
      // ⚠️ **必须给行副本**（`map(r => ({...r}))`，不是 `[...order]`）：`injectBySection`
      // 会把 `rank` 写回行对象，而浅拷贝数组只复制引用 ⇒ 共用同一批行时后算的臂会覆盖
      // 先算的臂的 `rank`，A1 的 before/after 名次**静默串台**。
      const merged2 = injectBySection({ order: order.map((r) => ({ ...r })), topK: ARM2_TOPK })

      // ── 臂③：全序（一条不砍）送重排，再按同一规则取 topK ──
      const bodyById = new Map()
      for (const p of pools) for (const h of p.hits) bodyById.set(h.row.id, h.row.body)
      // 取文只负责「查」；「取不到就抛」的判据在 `buildRerankPairs` 里（构造处，一处即可）
      const pairs = buildRerankPairs({ order, pools, bodyOf: (id) => bodyById.get(id) })
      const t0 = Date.now()
      const { scores } = await callRerank(pairs.map(({ query, passage }) => ({ query, passage })))
      const rerankMs = Date.now() - t0
      const rerankOrder = applyRerankScores({ order, pairs, scores })
      const merged3 = injectBySection({ order: rerankOrder, topK: ARM3_TOPK })

      // 三臂各建一份「注入集换了、其余照旧」的 result 交给**同一把尺**
      const armScore = (merged) => {
        const sections = injectedSections({ order: merged.order, injectedIds: merged.injectedIds })
        return scoreEntry({ entry, result: { ...result, sections } })
      }
      const s1 = armScore(merged1)
      const s2 = armScore(merged2)
      const s3 = armScore(merged3)

      perEntry.push({
        entry,
        result,
        order,
        rerankOrder,
        merged1,
        merged2,
        merged3,
        s1,
        s2,
        s3,
        // 量化交叉核对（可选诊断）要用：同一批 pairs + q8 的分数 + q8 的 top-3 节集
        pairs,
        rerankScores: scores,
        top3Sections: injectedSections({
          order: merged3.order,
          injectedIds: merged3.injectedIds,
        }),
        sectionCounts: [
          merged1.injectedIds.size,
          merged2.injectedIds.size,
          merged3.injectedIds.size,
        ],
      })
      timings.push({
        id: entry.id,
        retrievalMs,
        rerankMs,
        pairs: pairs.length,
        // 归因用：本条全部 pairs 的 **passage 字符总数**。S0 曲线是 450 字合成件上测的，
        // 本批 per-pair 高出 5 倍——若不记长度，「切片更长」就只是个**未经检验的假设**。
        // §四 的 `ms/千字` 列稳定 ⇒ 长度归因成立；乱 ⇒ 另有他因（批大小 / 负载）。
        chars: pairs.reduce((a, p) => a + p.passage.length, 0),
      })
    }

    // ─── 降级硬闸：跑批途中嵌入挂了 ⇒ 三臂读数全是假读数（与 recheck 同一条） ───
    const degraded = perEntry
      .filter((p) => p.result.stats?.queryTraces?.some((q) => !q.queryEmbedOk))
      .map((p) => p.entry.id)
    if (degraded.length > 0) {
      return refuse(
        'degradation',
        { offenders: degraded },
        `嵌入链降级 ${degraded.length} 条——向量通道可能静默缺席`
      )
    }

    const mergeVerdict = judgeMergeSelfCheck({
      entries: perEntry.length,
      rows: finalRowsChecked,
      mismatches: mismatchAll,
    })
    const mergeCheck = {
      ok: mergeVerdict.ok,
      mismatches: mismatchAll,
      rows: finalRowsChecked,
      entries: perEntry.length,
    }
    if (!mergeCheck.ok) {
      return refuse(
        mergeVerdict.reason === 'no-sample' ? 'remerge-no-sample' : 'remerge',
        { offenders: mismatchAll, rows: finalRowsChecked },
        mergeVerdict.message
      )
    }

    const coverage = checkAttributionCoverage(perEntry.map((p) => p.s1))
    if (!coverage.ok) {
      return refuse(
        'attribution',
        { unknown: coverage.unknown },
        `出现未登记的归因键 ${coverage.unknown.join(', ')}`
      )
    }

    // ─── 汇总 ───
    const scored = [perEntry.map((p) => p.s1), perEntry.map((p) => p.s2), perEntry.map((p) => p.s3)]
    const nonNeg = (arr) => arr.filter((s) => s.kind !== 'negative')
    const armsMeta = [
      { label: '① 现状 topK=3', how: 'RRF 序' },
      { label: '② topK=5', how: 'RRF 序（一行配置）' },
      { label: '③ topK=3 + 重排', how: 'cross-encoder 全序重排' },
    ]
    const arms = scored.map((s, i) => {
      const g = summarizeGroup(nonNeg(s))
      const neg = s.filter((x) => x.kind === 'negative')
      const meanInj =
        perEntry.reduce((a, p) => a + p.sectionCounts[i], 0) / Math.max(1, perEntry.length)
      return {
        label: armsMeta[i].label,
        how: armsMeta[i].how,
        hit: g.hit,
        expectTotal: g.expectTotal,
        recallMean: g.recallMean,
        microRecall: g.microRecall,
        meanInjectedSections: meanInj,
        negativeFlagged: neg.filter((x) => x.forbidHit.length > 0).length,
        negativeTotal: neg.length,
        negativeIds: neg.filter((x) => x.forbidHit.length > 0).map((x) => x.id),
      }
    })
    const verdict = judgeArmVerdict({
      arm1Hit: arms[0].hit,
      arm2Hit: arms[1].hit,
      arm3Hit: arms[2].hit,
    })

    // ── 臂间得失（票面 A1：「臂③ 相对臂② 的增量单独列出」）──
    // 只列**状态翻转**的条目：汇总表给了净差（+N/−M），但净差会把「救了 6 处、又丢 8 处」
    // 抹成「−2」——而这两种情形的药方完全不同（前者说明重排有信号只是不稳，后者说明没信号）。
    const hitOf = (s) => s.details.some((d) => d.status === 'injected')
    const flipped = (a, b) =>
      perEntry
        .filter((p) => a(p) !== b(p))
        .map((p) => ({
          id: p.entry.id,
          kind: p.entry.kind,
          dir: b(p) ? 'gain' : 'loss',
          anchor: p.entry.expect?.[0]
            ? `${p.entry.expect[0].doc_path} :: ${p.entry.expect[0].section_anchor}`
            : '—',
        }))
    const flips = {
      arm1ToArm3: flipped(
        (p) => hitOf(p.s1),
        (p) => hitOf(p.s3)
      ),
      arm2ToArm3: flipped(
        (p) => hitOf(p.s2),
        (p) => hitOf(p.s3)
      ),
    }

    // A1：11 处对照锚点 + 本次实跑的**全部**未命中锚点（臂①面）
    const byId = new Map(perEntry.map((p) => [p.entry.id, p]))
    const anchorRows = []
    for (const m of REPORT_0920_MISSES) {
      const p = byId.get(m.id)
      if (!p) continue
      const row = anchorRow({
        id: m.id,
        docPath: m.docPath,
        sectionAnchor: m.sectionAnchor,
        merged: p.merged1,
        rerankOrder: p.rerankOrder,
      })
      anchorRows.push({
        ...row,
        attribution0920: m.attribution,
        arm1: p.s1.details.some((d) => d.status === 'injected'),
        arm2: p.s2.details.some((d) => d.status === 'injected'),
        arm3: p.s3.details.some((d) => d.status === 'injected'),
      })
    }

    // ─── A3：延迟与降级率 ───
    const rerankMsList = timings.map((t) => t.rerankMs)
    const retrievalMsList = timings.map((t) => t.retrievalMs)
    const totalMsList = timings.map((t) => t.retrievalMs + t.rerankMs)
    const totalPairs = timings.reduce((a, t) => a + t.pairs, 0)
    const totalRerankMs = rerankMsList.reduce((a, b) => a + b, 0)
    const perPairMs = totalPairs > 0 ? totalRerankMs / totalPairs : null
    const THRESHOLD_MS = 10000

    // 降级率两面：① 黄金集实测面；② 活库分布面（用**真实池深**推固定开销）
    const liveRows = db
      .prepare(
        "SELECT retrieval_ms AS ms, reason FROM retrieval_events WHERE reason <> 'skipped-a2a' AND retrieval_ms IS NOT NULL"
      )
      .all()
    const meanPairs = totalPairs / Math.max(1, timings.length)
    /** A3 ①：timeout 基线。**分母剔 `skipped-a2a`**（那些行 `retrieval_ms` 恒 0，永不可能 timeout
     *  ⇒ 计入分母属稀释）。票面明令实施者独立复核，故这里**自己算一遍**并把对照分母一并报出。 */
    const denomAllReasons = db
      .prepare('SELECT COUNT(*) AS n FROM retrieval_events WHERE retrieval_ms IS NOT NULL')
      .get().n
    const timeoutCount = liveRows.filter((r) => r.reason === 'timeout').length
    const okOnly = liveRows.filter((r) => r.reason !== 'timeout').map((r) => r.ms)
    const timeoutBaseline = {
      denom: liveRows.length,
      timeout: timeoutCount,
      rate: `${timeoutCount}/${liveRows.length}`,
      pct: liveRows.length ? +((timeoutCount / liveRows.length) * 100).toFixed(3) : null,
      denomAllReasons,
      pctAllReasons:
        denomAllReasons > 0 ? +((timeoutCount / denomAllReasons) * 100).toFixed(3) : null,
      slowestNonTimeout: okOnly.length ? Math.max(...okOnly) : null,
    }
    const headroomMs =
      timeoutBaseline.slowestNonTimeout === null
        ? null
        : THRESHOLD_MS - timeoutBaseline.slowestNonTimeout
    const liveDeg = computeDegradation(liveRows, meanPairs * perPairMs, THRESHOLD_MS)
    const overGolden = totalMsList.filter((ms) => ms >= THRESHOLD_MS).length
    const degradation = [
      {
        face: '黄金集（实测 retrievalMs + 实测 rerankMs）',
        denom: timings.length,
        added: overGolden,
        rate: `${overGolden}/${timings.length}`,
      },
      {
        face: `活库全量（推演：+${meanPairs.toFixed(1)} 对 × ${perPairMs.toFixed(1)}ms）`,
        denom: liveDeg.denom,
        added: liveDeg.added,
        rate: liveDeg.rate,
        alreadyOver: liveDeg.alreadyOver,
        overAfter: liveDeg.overAfter,
      },
    ]
    const latency = {
      rerankP50: quantile(rerankMsList, 0.5),
      rerankP95: quantile(rerankMsList, 0.95),
      rerankMax: rerankMsList.length ? Math.max(...rerankMsList) : null,
      perPairMs: perPairMs === null ? null : +perPairMs.toFixed(3),
      meanPairsPerEntry: +meanPairs.toFixed(2),
      retrievalP50: quantile(retrievalMsList, 0.5),
      totalP50: quantile(totalMsList, 0.5),
      totalP95: quantile(totalMsList, 0.95),
      thresholdMs: THRESHOLD_MS,
      timeoutBaseline,
      headroomMs,
      overGateInGolden: totalMsList.filter((ms) => ms >= THRESHOLD_MS).length,
      pairsTotal: totalPairs,
      degradation,
    }

    // ─── 量化交叉核对（**可选诊断，默认关**；触发条件见下）───
    //
    // 触发条件是**跑批前就定死的**（店长裁决）：「仅当臂③ 相对臂② 增量 ≈ 0 或为负时才跑
    // q8-vs-<参考档> 一致性」——只有结论是「重排无效」时，量化误差才是必须排除的替代解释。
    // 先定条件再跑批，防出数后挪判据。
    //
    // 它**不改任何已报的臂**：只拿同一批 `pairs` 换一把 dtype 的尺子再算一遍臂③，
    // 看结论是不是量化造出来的。故产物落**计时/不可复现面**，不落确定性面。
    let quantCrosscheck = null
    if (args.quantCrosscheck) {
      const { createTransformersReranker, RERANK_MODEL } = await import(
        pathToFileURL(path.join(root, 'scripts/flywheel/embed-server.mjs')).href
      )
      const ref = createTransformersReranker(RERANK_MODEL, QUANT_REF_DTYPE)
      const rows = []
      let hitRef = 0
      for (const p of perEntry) {
        const scores = await ref.rerank(p.pairs.map(({ query, passage }) => ({ query, passage })))
        const refOrder = applyRerankScores({ order: p.order, pairs: p.pairs, scores })
        const refMerged = injectBySection({ order: refOrder, topK: ARM3_TOPK })
        const sections = injectedSections({
          order: refMerged.order,
          injectedIds: refMerged.injectedIds,
        })
        const s = scoreEntry({ entry: p.entry, result: { ...p.result, sections } })
        if (p.entry.kind !== 'negative') hitRef += s.hit
        const keysOf = (secs) => secs.map((x) => anchorKey(x.docPath, x.sectionAnchor)).sort()
        const a = keysOf(p.top3Sections)
        const b = keysOf(sections)
        rows.push({
          id: p.entry.id,
          top3Same: a.length === b.length && a.every((x, i) => x === b[i]),
          argmaxSame: p.rerankOrder[0].chunkId === refOrder[0].chunkId,
          maxAbsScoreDelta: Math.max(...scores.map((v, i) => Math.abs(v - p.rerankScores[i]))),
        })
      }
      quantCrosscheck = {
        model: RERANK_MODEL,
        dtypes: ['q8', QUANT_REF_DTYPE],
        refDtype: QUANT_REF_DTYPE,
        hitQ8: arms[2].hit,
        hitRef,
        hitDelta: hitRef - arms[2].hit,
        top3SameEntries: rows.filter((r) => r.top3Same).length,
        argmaxSameEntries: rows.filter((r) => r.argmaxSame).length,
        entries: rows.length,
        maxAbsScoreDelta: Math.max(...rows.map((r) => r.maxAbsScoreDelta)),
        note:
          `hitRef（${QUANT_REF_DTYPE}）与 hitQ8 的差 = 量化对**结论**的影响；` +
          'top3SameEntries = 量化对**名次**的影响。' +
          '两者都小 ⇒ 「重排无效」不是量化造出来的（量化作为替代解释被排除）。',
      }
      process.stderr.write(
        `[eval:rerank-ab] 量化交叉核对：q8 命中 ${arms[2].hit} / ${QUANT_REF_DTYPE} 命中 ${hitRef}` +
          `（Δ=${quantCrosscheck.hitDelta}）；top-3 节集全同 ${quantCrosscheck.top3SameEntries}/${rows.length} 条；` +
          `argmax 全同 ${quantCrosscheck.argmaxSameEntries}/${rows.length} 条；` +
          `最大分数差 ${quantCrosscheck.maxAbsScoreDelta.toExponential(3)}\n`
      )
    }

    const ctx = {
      date,
      dbPath,
      quantCrosscheck,
      flips,
      goldenVersion: goldenData.version,
      params: { liveTopK, maxDistance, liveTopKRows },
      arms,
      anchors: anchorRows,
      canary: canaryResults.map((c) => ({ id: c.id, ok: c.ok })),
      rerankSelfCheck,
      mergeCheck,
      verdict,
      latency,
    }

    // ─── 落盘：确定性面（md + json）+ 计时面（latency.json）───
    const md = renderReport(ctx)
    const reportJson = {
      schema: RERANK_AB_REPORT_SCHEMA,
      date,
      dbPath,
      goldenVersion: goldenData.version,
      params: { liveTopK, maxDistance, liveTopKRows },
      armTopK: [ARM1_TOPK, ARM2_TOPK, ARM3_TOPK],
      arms,
      anchors: anchorRows,
      flips,
      canary: ctx.canary,
      rerankSelfCheck,
      mergeCheck,
      verdict,
      ok: true,
    }
    mkdirSync(path.dirname(outFile), { recursive: true })
    // 确定性面：**一个计时数字都不含**（A4 的比对对象）
    writeFileSync(outFile, md, 'utf-8')
    writeFileSync(jsonFile, JSON.stringify(reportJson, null, 2) + '\n', 'utf-8')
    // 计时面：单独落两枚，耗时不可复现，混进上面两份会把 A4 的 sha256 比对变成偶发假红
    writeFileSync(
      latencyFile,
      JSON.stringify(
        {
          schema: RERANK_AB_REPORT_SCHEMA,
          date,
          note: '计时面 + 可选诊断，不可复现，不进 A4',
          timings,
          latency,
          quantCrosscheck,
        },
        null,
        2
      ) + '\n',
      'utf-8'
    )
    writeFileSync(latencyMdFile, renderLatencyReport({ ...ctx, timings }), 'utf-8')

    // A4：确定性面的 sha256 **打进运行日志**——下批复核直接从两遍日志里对读，
    // 不必再靠人工声明「我这两遍是同一份输入」。**不写进产物自身**（产物含自己的 sha 会自我指涉）。
    const shaOf = (f) => createHash('sha256').update(readFileSync(f)).digest('hex')
    const sha256Pair = { md: shaOf(outFile), json: shaOf(jsonFile) }

    const human = [
      `[eval:rerank-ab] 三臂（命中/应中）：`,
      ...arms.map(
        (a) =>
          `  ${a.label}  节均=${a.meanInjectedSections.toFixed(2)}  ${a.hit}/${a.expectTotal}  recall=${fmt4(a.recallMean)}`
      ),
      `  判词: ${verdict.verdict} —— ${verdict.message}`,
      `  负例判红: ${arms.map((a) => a.negativeFlagged).join(' / ')}（基线 4/5）`,
      `  重排段 p50=${latency.rerankP50}ms p95=${latency.rerankP95}ms per-pair=${latency.perPairMs}ms`,
      `  报告: ${outFile}`,
      `  A4 sha256: md=${sha256Pair.md}`,
      `             json=${sha256Pair.json}`,
    ].join('\n')

    emit(
      { ...reportJson, outFile, jsonFile, latencyFile, latencyMdFile, sha256: sha256Pair },
      human
    )
    return 0
  } finally {
    stopEmbeddingSidecar()
    try {
      db.close()
    } catch {
      /* 只读库关不掉不阻塞退出 */
    }
  }
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntry && !bootstrap(process.argv.slice(2))) {
  main().catch((err) => {
    process.stderr.write(`[eval:rerank-ab] 异常退出: ${err?.stack || err}\n`)
    process.exit(2)
  })
}
