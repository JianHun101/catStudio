/**
 * 检索跑批基线（R10）——把 R9 的黄金集变成**可复跑的数字**。
 *
 * ## 测的是什么（D1 契约，票面 §一）
 *
 * 被测出口 = **全链最终注入节集**：从**冻结改写文本**出发（跳过改写器，D2 冻结
 * 纪律 ⇒ 跑批是纯确定函数），走改写之后的完整链段，取最终注入 prompt 的节集合 `S`。
 *
 * | 指标 | 定义 |
 * | --- | --- |
 * | recall | 单条 = \|`expect` ∩ `S`\| / \|`expect`\|；集均 = 各条**算术平均** |
 * | 阈值前命中率 | `expect` 里**被距离阈值挡下**的节占比（来源 = probe 池 + 逐查询重搜补测） |
 * | 负例判红 | `forbid` 任一锚点落在 `S` ⇒ 整条判红（不进 recall 均值，单列清单） |
 *
 * 真实组（12）与构造组（23）**各自出分、不合成总分**（D4：两组测的是不同面）。
 *
 * ## 链段怎么来的
 *
 * 走 `runRetrievalChain`（R10 §A2 抽出的**改写之后**链段）——R9 冻结的 `rewritten`
 * 是文本数组，而生产入口 `retrieveMemoryContext` 只吃 `triggerContent`、改写器内嵌
 * 其中，外部没法喂冻结查询。故本脚本**不复制链段**（复制一份必然与生产静默漂移，
 * 基线数字就不再代表生产行为），参数/阈值/预算全与生产同源（都读 env）。
 *
 * ## 三条硬闸（票面 §三 + §修订 #1）
 *
 * - **B2 canary 反对照**（测量工具真空性）：必中条目（query 原文照抄某节标题）必须
 *   满分、必不中条目（语料外话题）必须零分。**任一不符 ⇒ 尺子恒绿/恒红 ⇒ 拒出报告**。
 * - **B5 降级硬闸**：任一条目 `queryTraces[].queryEmbedOk` 不全 true，或 `reason` 落在
 *   **合法空结果白名单**（`LEGIT_EMPTY_REASONS`）之外 ⇒ 拒出报告。这是本仓实测暴露过的坑：
 *   sidecar 撞端口致**部分**查询嵌入失败时 `reason` 仍可能是 `ok`，向量通道静默缺席
 *   ⇒ 假读数无声产生。白名单形态的理由见 `checkDegradation`（简言之：`no-hit` 这类是
 *   **真实结局**不是降级，拿它拒报告等于让一次正常空结果变成拿不到数）。
 * - **B6 空库闸**：`chunks` 行数 > 0 且 `doc_path` 去重数 == golden-check 的 `liveDocs`。
 *   `DB_PATH` 是模块级常量（`db/index.ts:16`）env 覆盖不了，故本脚本**显式** `setDb()`
 *   注入真库，且以 `readonly + fileMustExist` 打开——「静默建一个空库跑出全零」在这条
 *   打开方式下不是纪律问题，是**物理不可达**。
 *
 * ## 归因：`below_topk` 与覆盖洞的分野（本脚本唯一自己发起的检索调用）
 *
 * 候选流水有两个**结构性盲区**：`probe` 池只取首个嵌入成功的查询、`final` 只留跨查询
 * 合并后的 topK ⇒「被某条改写查询召回却排不进 topK」与「压根没召回」在流水里同形，
 * 而两者药方相反。故对**流水两条路都没出现**的锚点补一次**逐查询重搜**
 * （`collectRecheckPools`，阈值放宽到 `RECHECK_MAX_DISTANCE`）：够得着 ⇒ `below_topk`，
 * 够不着 ⇒ `not-recalled`（真覆盖洞）。重搜用的是库层现成导出 `searchChunksHybrid`
 * （与生产同源），**不复制链段**——链段仍只有 `runRetrievalChain` 一个出处。
 *
 * ## 嵌入供给（票面「必判」第一条，已实测定案）
 *
 * 独立 sidecar + **动态端口**（`EMBED_SIDECAR_PORT=0`）：活 server 的 sidecar 钉在
 * `3210`，跑批若继承该值会 `EADDRINUSE` ⇒ 降级成仅关键词通道 ⇒ 假读数。跑完
 * `stopEmbeddingSidecar()` 显式回收（只杀本进程 spawn 的实例）。**禁止假定 server 在跑。**
 *
 * ## 输出通道（与 `scan.mjs` / `golden-check.mjs` 同款）
 *
 * stdout 只出**一行结构化 JSON**（机器通道），人类可读汇总走 stderr——本仓 logger 写
 * stdout，混流会毁掉机器通道。基线报告写文件（缺省 `docs/eval/retrieval-baseline-<date>.md`）。
 *
 * **落盘同批出两份**：`<outFile>`（给人看的 Markdown）+ **同基名的 `.json` 副产品**
 * （喂给前端「检索」tab 的取数口，`routes/eval.ts` 的 `/api/eval/retrieval/*` 只读端点）。
 * 两份吃的是**同一个 ctx 对象**（`reportCtx`）——不是各自重算一遍，见 `buildReportJson`。
 *
 * ⚠️ **「同一个 ctx」反过来是 json 的 B1 承重条件**：`buildReportJson` 把 ctx **原样
 * 序列化**，所以 ctx 里任何一个每跑一变的值都会直接漏进 json。md 侧只挑其中一部分渲染，
 * **未必看得见**——首版就是这样把 sidecar 端口漏进 json 的（md 确定、json 不确定）。
 * ⇒ 进 ctx 的必须是**读数加工后的确定值**，原始随机读数不得进 ctx（见 `reportCtx.embed`）。
 * 报告本体的 B1 确定性（零时间量）对 json 同样成立：**文件写入时刻不进内容**，
 * 由端点侧读文件 mtime 给出。
 *
 * ## 确定性（B1）
 *
 * 报告里**没有任何时间量**：`retrievalMs`、sidecar 端口、跑批耗时一律不进报告，日期只在
 * 标题与文件名（且可 `--date` 注入）。同树同库连跑两遍，**md 与 json 两份产物各自**
 * 逐字节一致。
 *
 * ## 退出码
 *
 * `0` 全绿 / `1` 闸未过（尺子或降级）/ `2` 用法或读盘错误（**与「闸未过」分开**：
 * 读不到库不是标尺的问题，混成同一个码会让 CI 分不清该修环境还是修标尺）。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

import {
  buildLiveAnchorIndex,
  checkGoldenSet,
  validateGoldenSet,
  GOLDEN_KINDS,
} from './golden-check.mjs'
import { loadEnvFile } from './freeze-rewrite.mjs'

// ─── 契约常量（测试直接断言） ─────────────────────────

/** 报告里 `schema` 字段的唯一合法值（报告形态变更时递增，便于历史报告比对） */
export const BASELINE_REPORT_SCHEMA = 1

/** 必中 canary 的 id */
export const CANARY_HIT_ID = 'CANARY-HIT'
/** 必不中 canary 的 id */
export const CANARY_MISS_ID = 'CANARY-MISS'

/**
 * 必不中 canary 的查询：**语料外话题**（本仓语料 = catStudy 多猫协作系统文档索引）。
 * 选它是因为它与语料在任何通道上都无交集——实测 `reason=no-hit`、注入节集为空。
 */
export const CANARY_MISS_QUERY = '如何给南极科考站的柴油发电机做低温启动预热与燃油防凝'

/**
 * 锚点身份键（`doc_path` + `section_anchor` 成对，与埋点同粒度）。
 *
 * 分隔符用 **NUL 转义**（不是空格、不是 `::`）：锚点与路径里都常出现空格与 `::`
 * （本仓锚点含 ` > ` 与中文），用它们拼键会让 `("a b", "c")` 与 `("a", "b c")`
 * 撞成同一个键——撞键的后果是「A 锚点没命中」被算成「B 锚点命中了」，且**无任何报错**。
 *
 * ⚠️ 这里必须是**源码里的转义序列**，不能落成裸 NUL 字节：本仓 C1 实证过写入层把转义
 * 序列展开成真 NUL，而裸字节会让整个文件被 git/grep 当二进制（`grep` 直接报
 * `Binary file matches`、不再输出行号，定位手段当场失效）。
 */
export function anchorKey(docPath, sectionAnchor) {
  return `${docPath}\u0000${sectionAnchor}`
}

/** 固定 4 位小数——报告数值逐字节可比（B1）的前提之一 */
export function fmt4(x) {
  return typeof x === 'number' && Number.isFinite(x) ? x.toFixed(4) : 'n/a'
}

/** 本地日期（`YYYY-MM-DD`）。刻意不用 `toISOString()`——那是 UTC，会差 8 小时 */
export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// ─── 单条评分（纯函数） ───────────────────────────────

/**
 * 给一条黄金集条目打分（**纯函数**：结果对象由调用方给，测试可喂假 result）。
 *
 * 未进注入节集的 `expect` 锚点逐条给出**归因**——药方互不相同：
 *   - `threshold`    probe 池里、被距离阈值杀 ⇒ 药是「松阈值」
 *   - `status`       probe 池里、被 X4 状态过滤杀 ⇒ 药是「查状态/去死知识」
 *   - `not_topk`     probe 池里、距离也够，但排不进融合 topK ⇒ 药是「调 topK/看排序」
 *   - `budget`       进了融合 topK，但整节放不进预算 ⇒ 药是「加预算」
 *   - `below_topk`   流水两条路都没出现，但**逐查询重搜**能召回且过阈值
 *                    ⇒ 药是「调 topK/池深」（判别面见 `buildRecheckIndex`）
 *   - `not-recalled` 重搜（阈值放宽到 1）也够不着 ⇒ 药是「覆盖洞」
 *
 * `section_dup` 不会出现在未命中归因里：同节已有更优片代表时**整节照样注入**
 * （整节返回），故该锚点必落在 `S` 内。
 *
 * @param recheck 逐查询重搜索引（`buildRecheckIndex` 产物）。**缺省 `null` = 关掉重搜**，
 *   此时「流水两条路都没出现」一律落 `not-recalled`——那是分不开 `below_topk` 的旧口径，
 *   跑批主流程恒传入；缺省值只服务「不关心该子类」的窄用例。
 */
export function scoreEntry({ entry, result, recheck = null }) {
  const injected = new Set(result.sections.map((s) => anchorKey(s.docPath, s.sectionAnchor)))
  const probes = new Map()
  const finals = new Map()
  for (const c of result.stats.candidates) {
    const k = anchorKey(c.docPath, c.sectionAnchor)
    if (c.source === 'probe') probes.set(k, c)
    else if (c.source === 'final') finals.set(k, c)
  }

  const expect = Array.isArray(entry.expect) ? entry.expect : []
  const forbid = Array.isArray(entry.forbid) ? entry.forbid : []
  /** 阈值取自**链段自己落的参数快照**（不是脚本另读一遍 env——两处读会各自漂移） */
  const maxDistance = result.stats?.thresholdMaxDistance ?? null
  /** 把流水行里的距离/通道一并带进明细：§二 的「未召回锚点距离」读数要用 */
  const withTrace = (at, c) => ({
    ...at,
    source: 'trace',
    distance: typeof c.distance === 'number' ? c.distance : null,
    channel: c.channel ?? null,
  })

  const details = expect.map((a) => {
    const k = anchorKey(a.doc_path, a.section_anchor)
    const at = { docPath: a.doc_path, sectionAnchor: a.section_anchor }
    if (injected.has(k)) return { ...at, status: 'injected', drop: null }
    if (probes.has(k))
      return {
        ...withTrace(at, probes.get(k)),
        status: 'dropped',
        drop: probes.get(k).droppedReason,
      }
    if (finals.has(k))
      return {
        ...withTrace(at, finals.get(k)),
        status: 'dropped',
        drop: finals.get(k).droppedReason,
      }
    const rc = recheck?.get(k)
    if (rc) {
      const hit = {
        ...at,
        source: 'recheck',
        distance: typeof rc.distance === 'number' ? rc.distance : null,
        channel: rc.channel,
        queryIndex: rc.queryIndex,
        rank: rc.rank,
      }
      // 最小距离在阈值内 ⇒ 挡路的是**排序**（它本来过得了闸）；
      // 最小距离 ≥ 阈值 ⇒ 挡路的是**阈值**（旧探针池结构上看不见这一类）。
      // 关键词通道捞到过 ⇒ 不可能是阈值杀的（它没有距离概念、生产里也不过闸）。
      const blockedByThreshold =
        !rc.keywordHit &&
        hit.distance !== null &&
        maxDistance !== null &&
        hit.distance >= maxDistance
      return blockedByThreshold
        ? { ...hit, status: 'dropped', drop: 'threshold' }
        : { ...hit, status: 'below_topk', drop: null }
    }
    return { ...at, status: 'not-recalled', drop: null }
  })

  const hit = details.filter((d) => d.status === 'injected').length
  const preThreshold = details.filter((d) => d.drop === 'threshold').length
  const forbidHit = forbid
    .filter((a) => injected.has(anchorKey(a.doc_path, a.section_anchor)))
    .map((a) => ({ docPath: a.doc_path, sectionAnchor: a.section_anchor }))

  return {
    id: entry.id,
    kind: entry.kind,
    reason: result.reason,
    expectTotal: expect.length,
    hit,
    recall: expect.length > 0 ? hit / expect.length : null,
    preThreshold,
    preThresholdRate: expect.length > 0 ? preThreshold / expect.length : null,
    details,
    forbidHit,
  }
}

/** 一组条目的汇总（recall = **集均 = 各条算术平均**，票面 §一；micro 版另列一栏备查） */
export function summarizeGroup(scores) {
  const scored = scores.filter((s) => s.recall !== null)
  const sum = (xs) => xs.reduce((a, b) => a + b, 0)
  const expectTotal = sum(scored.map((s) => s.expectTotal))
  const hit = sum(scored.map((s) => s.hit))
  const pre = sum(scored.map((s) => s.preThreshold))
  return {
    n: scores.length,
    scoredN: scored.length,
    expectTotal,
    hit,
    recallMean: scored.length > 0 ? sum(scored.map((s) => s.recall)) / scored.length : null,
    microRecall: expectTotal > 0 ? hit / expectTotal : null,
    preThreshold: pre,
    preThresholdRateMean:
      scored.length > 0 ? sum(scored.map((s) => s.preThresholdRate)) / scored.length : null,
    microPreThresholdRate: expectTotal > 0 ? pre / expectTotal : null,
  }
}

// ─── 逐查询重搜（below_topk / 覆盖洞 的判别面） ─────────

/**
 * 重搜用的**宽阈值**：判别「够不够得着」时把距离闸放开，取 1。
 *
 * 为什么不直接用生产的 0.6：那样重搜池与生产池一样窄，**「被阈值杀」这一类就永远
 * 看不见**——而它恰恰是「阈值该不该松」这个问题唯一的直接证据面。
 * 为什么不用 `Infinity`：`searchChunksByVector` 的 SQL 里 `distance < ?` 是硬条件，
 * 给个有限上界才可复现；1 对归一化向量的余弦距离（值域 [0,2]）已足够宽。
 */
export const RECHECK_MAX_DISTANCE = 1

/**
 * 逐查询重搜：把该条目的**每条查询分别**丢进生产同款融合池（`searchChunksHybrid`，
 * 状态过滤与融合公式都在库层同源），只把距离阈值放宽到 `RECHECK_MAX_DISTANCE`。
 *
 * 为什么需要它：链段的候选流水有两个**结构性盲区**——`probe` 池只取自**首个嵌入
 * 成功的查询**（原话优先），`final` 只留**跨查询合并后的 topK**。于是「被第 3 条
 * 改写查询召回、但排不进 topK」与「被某条改写查询召回、卡在阈值上」这两类锚点，
 * 在流水里**两条路都不出现**，与「压根没召回」落成同一个 `not-recalled`——
 * 而它们与真覆盖洞的药方**完全相反**（调 topK / 松阈值 vs 补语料）。
 *
 * `embed` / `search` 由调用方注入（生产接 `embedText` / `searchChunksHybrid`，
 * 测试喂假实现）：本函数只负责「逐条查询跑一遍」这个骨架。
 *
 * @returns `perQuery`：每条查询一个数组（该查询池内的命中，带池内名次与通道）；
 *   该查询嵌入失败 ⇒ 空数组（**不是** `null`：调用方只 `for..of`，不必防空）。
 */
export async function collectRecheckPools({ queries, maxDistance, embed, search }) {
  const perQuery = []
  for (const q of queries) {
    const e = await embed(q)
    if (!e.ok || e.vector.length === 0) {
      perQuery.push([])
      continue
    }
    perQuery.push(
      search(e.vector, q, maxDistance).map((h, rank) => ({
        docPath: h.row.doc_path,
        sectionAnchor: h.row.section_anchor,
        rank,
        channel: h.channel,
        // 纯关键词命中带的是 `maxDistance` 哨兵、不是真距离（与链段落库面同款）⇒ 记 null
        distance: h.channel === 'keyword' ? null : h.row.distance,
      }))
    )
  }
  return perQuery
}

/**
 * 把逐查询池压成查找表 `anchorKey → { queryIndex, rank, channel, distance, keywordHit }`。
 *
 * **读数是「该锚点各查询池内的最小向量距离」**——它答的是「它最好的一次机会有多好」，
 * 而「阈值该不该松」要的正是这个紧界：只要有一趟查询里它的距离在阈值内，那挡路的就
 * 不是阈值。识别点（queryIndex / rank / channel）**跟着这个最小值走**，明细表里的
 * 「q? / rank / dist」三者才同源——否则会长出「q0 的名次配 q3 的距离」这种没法核的行。
 * 同距时保留更早的查询（`<` 而非 `<=`），保证可复现。
 *
 * `keywordHit` 单独记：关键词通道**没有距离概念**（库层填的是哨兵值），生产里也不受
 * 阈值约束 ⇒ 只要它捞到过，这个锚点就不是「阈值杀的」。
 */
export function buildRecheckIndex({ perQuery }) {
  const index = new Map()
  perQuery.forEach((hits, queryIndex) => {
    for (const h of hits) {
      const k = anchorKey(h.docPath, h.sectionAnchor)
      const vectorHit = h.channel !== 'keyword' && typeof h.distance === 'number'
      let rec = index.get(k)
      if (!rec) {
        rec = { queryIndex, rank: h.rank, channel: h.channel, distance: null, keywordHit: false }
        index.set(k, rec)
      }
      if (!vectorHit) {
        rec.keywordHit = true
        continue
      }
      if (rec.distance === null || h.distance < rec.distance) {
        rec.queryIndex = queryIndex
        rec.rank = h.rank
        rec.channel = h.channel
        rec.distance = h.distance
      }
    }
  })
  return index
}

/**
 * 一条条目的**评分接线**：先按流水打分；只要有一个未注入锚点，就跑逐查询重搜并重算。
 *
 * 为什么单独抽成函数：这套机制的价值**全在接线上**——`scoreEntry` 再对，接线一断就
 * 静默退回「把 `below_topk` 记成覆盖洞」的旧口径，而报告看上去一切正常（条数、闸、
 * 格式全绿）。抽出来后 `embed` / `search` 可注入，接线本身就能被单测用假实现钉住，
 * 不必靠「读源码确认 main 里有这么一行」。
 *
 * 全注入 ⇒ **原样返回、不重搜**（连 `embed` 都不调）：这既是成本闸（40 条里大半条
 * 目一个未命中锚点都没有），也是「重搜不碰已命中语义」的结构保证——`hit` /
 * `recall` / `forbidHit` 只读 `result.sections`，与 `recheck` 无关。
 *
 * `rechecked` 与 `score` **一起返回**：调用方据它累计「跑过重搜的条目」（进报告的自述
 * 行）。合一返回是为了不让调用方自己再判一遍——两处判据一旦分叉，报告就会说一套、
 * 实际做另一套。
 */
export async function rescoreWithRecheck({ entry, result, queries, embed, search }) {
  const score = scoreEntry({ entry, result })
  if (!score.details.some((d) => d.status !== 'injected')) return { score, rechecked: false }
  const perQuery = await collectRecheckPools({
    queries,
    maxDistance: RECHECK_MAX_DISTANCE,
    embed,
    search,
  })
  return {
    score: scoreEntry({ entry, result, recheck: buildRecheckIndex({ perQuery }) }),
    rechecked: true,
  }
}

/**
 * **未召回锚点的距离读数**（§二 结论「阈值该不该松」的依据面）——纯函数。
 *
 * 距离有两个来源、合并计：① 流水（probe / final 行自带距离）；② 逐查询重搜
 * （取该锚点**各查询池内的最小**向量距离，见 `buildRecheckIndex`）。两处都是**同一把尺**
 * （`searchChunksByVector` 的真距离），故可直接取最大值——这个最大值答的是
 * 「**最好的一次机会**里最差的那个」，它 < 阈值 ⇒ 阈值一条都没杀。
 *
 * 三分类互斥且穷尽：`keywordOnly`（只有关键词通道捞到，无距离概念）、`vectorKnown`
 * （有真距离）、其余 = 连放宽阈值都够不着 = `unreachable`（**真覆盖洞**）。
 */
export function summarizeMissDistances({ scores, maxDistance }) {
  let total = 0
  let keywordOnly = 0
  let vectorKnown = 0
  let fromTrace = 0
  let fromRecheck = 0
  let atOrAboveThreshold = 0
  let max = null
  for (const s of scores) {
    for (const d of s.details) {
      if (d.status === 'injected') continue
      total += 1
      if (d.channel === 'keyword') {
        keywordOnly += 1
        continue
      }
      if (typeof d.distance !== 'number') continue
      vectorKnown += 1
      if (d.source === 'recheck') fromRecheck += 1
      else fromTrace += 1
      max = max === null ? d.distance : Math.max(max, d.distance)
      if (maxDistance !== null && d.distance >= maxDistance) atOrAboveThreshold += 1
    }
  }
  // `total` 三分类**互斥且穷尽**：有向量距离 / 仅关键词通道（无距离概念）/ 连重搜都够不着
  return {
    total,
    keywordOnly,
    vectorKnown,
    fromTrace,
    fromRecheck,
    atOrAboveThreshold,
    unreachable: total - keywordOnly - vectorKnown,
    maxDistance: max,
  }
}

/**
 * 未召回归因的**值域与药方**。键必须与 `droppedReason` 的原值**逐字一致**
 * （`not_topk` 是下划线，不是 `not-topk`）——首版把键写成 `not-topk`，结果明细表里
 * 6 条 `not_topk` 在汇总表里**一条都不显示**，两表对不上账且不报任何错。
 * 这类静默吞并正是 `checkAttributionCoverage` 要挡的：值域外的键一律拒出报告。
 */
export const MISS_RX = {
  threshold: '松阈值（MEMORY_MAX_DISTANCE）',
  status: '查该节状态（死知识/废弃）',
  not_topk: '调 topK 或看排序（探针池里过闸了，但没进融合 topK）',
  budget: '加注入预算（进了融合 topK，整节放不下）',
  section_dup: '同节已有更优片代表（整节照样注入，属正常）',
  below_topk:
    '调 topK 或调池深（被某条查询召回过、也过了阈值，输在跨查询合并后的 topK 截断——与 not_topk 同药方，只是发现路径不同）',
  'not-recalled':
    '**覆盖洞**（任何一条查询的融合池都够不着，阈值放宽到 1 也一样）——先补语料/补锚点，不是调参能救的',
}

/**
 * 归因值域自检：明细里出现的归因键必须全部在 `MISS_RX` 里。
 *
 * 存在的理由：`droppedReason` 的值域由 `memory/index.ts` 决定，那边加一个新值而这边
 * 没登记 ⇒ 汇总表静默少一行（首版实测发生）。**值域外即拒出报告**，让「新增归因」
 * 变成一次显式的对齐动作，而不是一次静默的数字缩水。
 */
export function checkAttributionCoverage(scores) {
  const unknown = new Set()
  for (const s of scores) {
    for (const d of s.details) {
      if (d.status === 'injected') continue
      const key = d.drop ?? d.status
      if (!(key in MISS_RX)) unknown.add(key)
    }
  }
  return { ok: unknown.size === 0, unknown: [...unknown].sort() }
}

// ─── 闸（纯函数） ─────────────────────────────────────

/**
 * **嵌入健康度**（锐判据）：逐趟 `queryEmbedOk` 是否全 true。
 *
 * 它答的是「这趟查询的向量通道有没有跑」。**这是判降级唯一锐的读数**：实测暴露过的
 * 假读数面正是「sidecar 撞端口 ⇒ 部分查询嵌入失败，而整条链的 `reason` 仍是 `ok`」。
 * canary 与黄金集条目共用它（canary 侧尤其致命：嵌入降级时**必不中条目的 recall 也是 0**，
 * 没有这条就会把「尺子瞎了」读成「尺子判得对」）。
 *
 * @param results `Array<{ id, result }>`
 */
export function checkEmbedHealth(results) {
  const offenders = []
  for (const { id, result } of results) {
    const bad = result.stats.queryTraces.filter((q) => !q.queryEmbedOk)
    if (bad.length > 0) {
      offenders.push({
        id,
        kind: 'partial-embed-failed',
        detail: `queryIndex=${bad.map((q) => q.queryIndex).join(',')}（共 ${result.stats.queryTraces.length} 趟）`,
      })
    }
  }
  return { ok: offenders.length === 0, offenders }
}

/**
 * **合法空结果**的 `reason` 白名单——`runRetrievalChain` 会返回的值的**闭集**里，
 * 除 `ok` 之外的全部成员（逐一对齐 `memory/index.ts` 的四处 `empty(...)` 调用）。
 *
 * 这三个都答得出「为什么没有命中」（没够着 / 被 X4 状态挡光 / 预算放不下），是**真实
 * 的检索结局**，不是链段降级——拿它们拒报告等于让一次正常的空结果变成「拿不到数」。
 */
export const LEGIT_EMPTY_REASONS = new Set(['no-hit', 'filtered-empty', 'budget-exhausted'])

/**
 * **B5 降级硬闸**：逐条检查嵌入链是否**完整**工作（钝判据 + 锐判据）。
 *
 * 两条判据缺一不可：`queryEmbedOk` 逐趟布尔（锐，见 `checkEmbedHealth`）——它答「这趟
 * 查询的向量通道有没有跑」；`reason` 落在**合法空结果白名单**之外（钝）——整条链若整体
 * 降级会落 `embed-failed`。只留锐的那条会漏「嵌入全好但链段整条没跑」；只留钝的那条会漏
 * **部分**查询嵌入失败。
 *
 * 钝判据为什么是**白名单**而不是 `reason === 'embed-failed'`：这条路径上
 * （`runRetrievalChain`）`embed-failed` 的必要条件是**没有任何一条查询嵌入成功**，
 * 而那必然让每趟 `queryEmbedOk` 全 false ⇒ **锐判据已经拦下了**。把钝判据一并收窄到
 * `embed-failed`，它就退化成锐判据的副本、永远拦不到新东西。留着白名单形态，它的实际
 * 职责是「**值域外即拒**」：`memory/index.ts` 将来新增一个 reason（无论好坏）都会让报告
 * 出不来、逼一次显式对齐，而不是静默略过——与 `checkAttributionCoverage` 同一条设计。
 *
 * ⚠️ **本条只适用于黄金集条目**：canary 的必不中条目**按设计就是空结果**
 * （`reason` 恒为 `no-hit`/`filtered-empty`/`budget-exhausted`），它会一头撞上白名单
 * 之外——canary 侧走 B2 的期望分 + `checkEmbedHealth`。
 *
 * @param results `Array<{ id, result }>`
 */
export function checkDegradation(results) {
  const offenders = [...checkEmbedHealth(results).offenders]
  for (const { id, result } of results) {
    if (result.stats.queryTraces.some((q) => !q.queryEmbedOk)) continue
    if (result.reason !== 'ok' && !LEGIT_EMPTY_REASONS.has(result.reason)) {
      offenders.push({ id, kind: 'reason-not-ok', detail: `reason=${result.reason}` })
    }
  }
  return { ok: offenders.length === 0, offenders }
}

/**
 * **B6 空库闸**：库里的语料与 golden-check 看到的语料是不是同一份。
 *
 * 两个读数缺一不可：行数 > 0 挡「空库/未扫描」；`doc_path` 去重数 == `liveDocs` 挡
 * 「索引落后于语料」（多一份或少一份都说明索引不是当前语料的索引，而基线数字脱离
 * 语料快照无意义）。
 */
export function checkCorpusGate({ chunksRows, docPaths, liveDocs }) {
  if (!Number.isFinite(chunksRows) || chunksRows <= 0) {
    return { ok: false, reason: `chunks 行数 = ${chunksRows}（空库或未扫描）` }
  }
  if (!Number.isFinite(docPaths) || docPaths <= 0) {
    return { ok: false, reason: `chunks 的 doc_path 去重数 = ${docPaths}` }
  }
  if (docPaths !== liveDocs) {
    return {
      ok: false,
      reason: `chunks 的 doc_path 去重数 ${docPaths} ≠ golden-check 的 liveDocs ${liveDocs}（索引与语料不同步）`,
    }
  }
  return { ok: true }
}

/**
 * **索引新鲜度闸**（票面「必判」第三条）：`chunks.origin_id` 是扫描那一刻该文件的
 * git blob sha（`repository/chunks.ts` 的增量判据，**不是 mtime**）——拿它与**当前
 * 工作树**的 `git hash-object` 逐份比。不等 ⇒ 这份文档在扫描之后被改过 ⇒ 库里是
 * **旧正文**，跑出来的数字测的是旧索引。
 *
 * 为什么要它而不只是比块数：块数只能发现「文件集变了」，发现不了「文件改了但节名
 * 没变」——而后者恰恰是最常见的形态（润色正文、改表格、补一段话），此时
 * `golden-check` 的锚点保鲜也会过（锚点还在），标尺看着全绿、数字却是旧的。
 *
 * @param rows `Array<{ docPath, originId }>`（`chunks` 里每个 `doc_path` 一条）
 * @param hashObject `(docPath) => string | null`（取当前工作树的 blob sha；读不到给 null）
 */
export function checkIndexFreshness({ rows, hashObject }) {
  const stale = []
  for (const r of rows) {
    const now = hashObject(r.docPath)
    if (now !== r.originId) stale.push({ docPath: r.docPath, db: r.originId, worktree: now })
  }
  return { ok: stale.length === 0, checked: rows.length, stale }
}

/**
 * 构造两条 canary（**B2 反对照**，测量工具的真空性）。
 *
 * 必中 = query **原文照抄某节标题**（该节的嵌入文本含面包屑与话题锚，故必中）；
 * 必不中 = 语料外话题，对**同一个锚点**判零分。两条共用同一锚点是刻意的：
 * 它把「尺子会不会答是」与「尺子会不会答否」钉在同一把尺上，恒绿与恒红各由一条兜住。
 */
export function buildCanaries({ docPath, sectionAnchor }) {
  const expect = [{ doc_path: docPath, section_anchor: sectionAnchor }]
  return [
    {
      id: CANARY_HIT_ID,
      expectKind: 'full',
      query: sectionAnchor,
      expect,
      note: 'query 原文照抄某节标题 ⇒ 该节必进注入集',
    },
    {
      id: CANARY_MISS_ID,
      expectKind: 'zero',
      query: CANARY_MISS_QUERY,
      expect,
      note: '语料外话题 ⇒ 同一锚点必不出现',
    },
  ]
}

/** 判一条 canary（纯函数）：`full` 要求 recall = 1，`zero` 要求 recall = 0 */
export function evaluateCanary({ canary, result }) {
  const s = scoreEntry({
    entry: { id: canary.id, kind: 'constructed', expect: canary.expect },
    result,
  })
  const ok = canary.expectKind === 'full' ? s.recall === 1 : s.recall === 0
  return { ...s, query: canary.query, expectKind: canary.expectKind, ok, reason: result.reason }
}

// ─── 报告渲染（纯函数，B1 的确定性面） ─────────────────

/**
 * 明细表里一个未命中锚点的归因标签：`<归因>[ q<查询> rank=<名次>][ dist=<距离>]`。
 *
 * **距离对所有未命中锚点都打**（不只是重搜判出来的那些）：§二 的「未召回锚点读数」
 * 取的就是这批 `distance` 的最大值，不逐行打出的话那个数字在报告里**无处可核**。
 * `below_topk` 另带「哪条查询捞到的、池内第几名」——它凭什么不是覆盖洞，得看得见。
 */
export function missLabel(d) {
  const key = d.drop ?? d.status
  const at = key === 'below_topk' ? ` q${d.queryIndex} rank=${d.rank}` : ''
  const dist = typeof d.distance === 'number' ? ` dist=${fmt4(d.distance)}` : ''
  return `${key}${at}${dist}`
}

/**
 * 渲染基线报告（Markdown）。**纯函数、零时间量**——同输入必同输出，这是 B1
 * 「同树同库连跑两遍逐字节一致」的实现面。
 */
export function renderReport(ctx) {
  const {
    date,
    dbPath,
    dbRows,
    dbDocs,
    goldenFile,
    goldenData,
    goldenCounts,
    liveDocs,
    rotten,
    indexFreshness,
    params,
    embed,
    groups,
    scores,
    canary,
    negatives,
    maxDistance,
    recheck,
  } = ctx
  const L = []
  const counts = GOLDEN_KINDS.map((k) => `${k}=${goldenCounts[k] ?? 0}`).join(' / ')

  L.push(`# 检索跑批基线 ${date}`)
  L.push('')
  L.push(
    '> 生成：`scripts/eval/retrieval-baseline.mjs`（R10）。指标定义见 `docs/run/eval-system/R10-retrieval-eval-baseline.md` §一；'
  )
  L.push(
    '> 被测出口 = **全链最终注入节集**，从**冻结改写**出发（跳过改写器）。真实组与构造组各自出分，不合成总分（D4）。'
  )
  L.push('')

  L.push('## 一、跑批参数与语料快照')
  L.push('')
  L.push('| 项 | 值 |')
  L.push('| --- | --- |')
  L.push(`| 报告 schema | ${BASELINE_REPORT_SCHEMA} |`)
  L.push(`| 库路径 | \`${dbPath}\` |`)
  L.push(`| chunks 行数 / doc_path 数 | ${dbRows} / ${dbDocs} |`)
  L.push(
    `| 黄金集 | \`${goldenFile}\`（version=${goldenData.version}，entries=${goldenData.entries.length}：${counts}） |`
  )
  L.push(`| 黄金集冻结基点 | \`${goldenData.meta?.frozenCorpusRef ?? 'n/a'}\` |`)
  L.push(`| 语料新鲜度（golden-check） | liveDocs=${liveDocs}，rotten=${rotten} |`)
  // 三个数全从 `indexFreshness` 算出来：写死 `checked/checked` 与 `stale=0` 的话，
  // 这条读数就只能反映前置闸拦没拦住，而**闸拦下时本报告根本不会生成**——即恒真字面量。
  L.push(
    `| 索引新鲜度（\`chunks.origin_id\` vs 工作树 \`git hash-object\`） | ${indexFreshness.checked - indexFreshness.stale}/${indexFreshness.checked} 份同步（stale=${indexFreshness.stale}） |`
  )
  L.push(`| MEMORY_MAX_DISTANCE | ${params.maxDistance} |`)
  L.push(`| MEMORY_TOP_K | ${params.topK} |`)
  L.push(`| 探针池 MAX_PROBE_N | ${params.probeN} |`)
  L.push(`| 嵌入模型 / 维度 | ${embed.model ?? 'n/a'} / ${embed.dim ?? 'n/a'} |`)
  // 供给形态也按**实测**报（`embed.handshaked` = sidecar 握手是否回报了监听端口）：
  // 写成恒真的字面量「动态端口」的话，哪天有人把 `EMBED_SIDECAR_PORT=0` 那行删了、
  // 报告照样声称自己是动态端口——与索引新鲜度那条同一个病（报告里的自述必须来自读数）。
  // 端口号本身**不进报告**（每跑一个随机值，写进去就破 B1）⇒ ctx 里只留这个布尔信号，
  // 布尔是在 `reportCtx` 里由 `embedStatus.port` **加工后**进来的，不在这里现算：
  // 两份视图吃同一个 ctx，加工点必须只有一处。
  L.push(
    '| 嵌入供给形态 | ' +
      (embed.handshaked === true
        ? '独立 sidecar、动态端口（`EMBED_SIDECAR_PORT=0`，避开活 server 的固定端口；实测已握手）'
        : '⚠️ **未见 sidecar 监听端口**（非独立 sidecar 供给 / 未握手）——请核供给形态') +
      ' |'
  )
  L.push('')

  L.push('## 二、总分（两组分开报，D4）')
  L.push('')
  L.push(
    '| 组 | 条数 | 应命中锚点 | 命中 | **recall（集均）** | recall（合计） | **阈值前命中率（集均）** | 阈值前命中数 |'
  )
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const kind of ['real', 'constructed']) {
    const g = groups[kind]
    L.push(
      `| ${kind} | ${g.n} | ${g.expectTotal} | ${g.hit} | **${fmt4(g.recallMean)}** | ${fmt4(g.microRecall)} | **${fmt4(g.preThresholdRateMean)}** | ${g.preThreshold} |`
    )
  }
  L.push('')
  L.push(
    `> 「集均」= 各条算术平均（票面 §一 口径）；「合计」= 总命中 / 总应命中（micro，防长条目被短条目稀释）。` +
      `阈值前命中率 = \`expect\` 里**被距离阈值（${maxDistance}）挡下**的节占比，来源 = 探针池 + 逐查询重搜补测` +
      '（探针池只取**首个嵌入成功的查询**，光靠它看不见改写查询那条路上的阈值拦截）。'
  )
  L.push('')
  // §二 结论的证据面：不是「阈值前命中率 = 0」这个指标本身（它有结构性盲区，见上），
  // 而是「未召回锚点各自的距离」这个更硬的读数。
  const missDist = summarizeMissDistances({ scores, maxDistance })
  L.push(
    `> **未召回锚点读数**（「阈值该不该松」的直接证据；本次逐查询重搜覆盖 **${recheck.entries}** 条条目）：` +
      `未进注入集 **${missDist.total}** 处，其中 ` +
      `**${missDist.vectorKnown}** 处取到真实向量距离（流水自带 ${missDist.fromTrace} 处 + 重搜补测 ${missDist.fromRecheck} 处，` +
      `后者取其各查询池内的**最小**距离 = 它最好的一次机会）、**最大 ${fmt4(missDist.maxDistance)}**（出处见明细行 \`dist=\`）` +
      (missDist.keywordOnly > 0
        ? `；另 **${missDist.keywordOnly}** 处仅关键词通道召回（无距离概念）`
        : '') +
      `。距离 ≥ 阈值的有 **${missDist.atOrAboveThreshold}** 处 ⇒ ` +
      (missDist.atOrAboveThreshold === 0
        ? '**阈值一条都没杀**，松阈值救不回任何一条未召回锚点——瓶颈在融合 topK 排序与真实覆盖洞。'
        : `松阈值可救回这 ${missDist.atOrAboveThreshold} 处。`) +
      `连重搜（阈值放宽到 ${RECHECK_MAX_DISTANCE}）都够不着的 **${missDist.unreachable}** 处 = 真覆盖洞。`
  )
  L.push('')

  // 章节号自增（首版 two 个「## 三」并列——编号是手写的，加一节就撞一次）
  const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
  let sec = 2
  const H = (title) => {
    sec += 1
    L.push(`## ${CN[sec - 1] ?? sec}、${title}`)
  }

  for (const kind of ['real', 'constructed']) {
    H(`逐条明细 — ${kind}`)
    L.push('')
    L.push('| id | reason | 应命中 | 命中 | recall | 阈值前命中 | 未进注入集的锚点（归因） |')
    L.push('| --- | --- | --- | --- | --- | --- | --- |')
    for (const s of scores.filter((x) => x.kind === kind)) {
      const miss = s.details
        .filter((d) => d.status !== 'injected')
        .map((d) => `${d.docPath} :: ${d.sectionAnchor}（${missLabel(d)}）`)
        .join('<br>')
      L.push(
        `| ${s.id} | ${s.reason} | ${s.expectTotal} | ${s.hit} | ${fmt4(s.recall)} | ${s.preThreshold} | ${miss || '—'} |`
      )
    }
    L.push('')
  }

  H('负例判红清单')
  L.push('')
  L.push('| id | 判定 | expect 命中 | forbid 命中项 |')
  L.push('| --- | --- | --- | --- |')
  for (const s of negatives) {
    const red = s.forbidHit.length > 0
    const items = s.forbidHit.map((f) => `${f.docPath} :: ${f.sectionAnchor}`).join('<br>')
    L.push(
      `| ${s.id} | ${red ? '🔴 判红' : '✅ 未命中'} | ${s.hit}/${s.expectTotal} | ${items || '—'} |`
    )
  }
  L.push('')
  L.push(
    `> 负例共 ${negatives.length} 条，判红 ${negatives.filter((s) => s.forbidHit.length > 0).length} 条。` +
      '判红的含义：`forbid`（刻意标注的「误读路径」节）被注入了 prompt。' +
      '「expect 命中」列一并列出——它把「**标错了**」（正解没进来）与「**尺子太宽**」（正解进来了、误读路径也进来了）分开，两者的药方不同。'
  )
  L.push('')

  H('canary（测量工具真空性，B2）')
  L.push('')
  L.push('| canary | 期望 | query | reason | recall | 判 |')
  L.push('| --- | --- | --- | --- | --- | --- |')
  for (const c of canary) {
    L.push(
      `| ${c.id} | ${c.expectKind} | ${c.query.length > 60 ? c.query.slice(0, 60) + '…' : c.query} | ${c.reason} | ${fmt4(c.recall)} | ${c.ok ? '✅' : '❌'} |`
    )
  }
  L.push('')
  L.push(
    '> 必中条目的 query **原文照抄某节标题**；必不中条目是语料外话题，对**同一锚点**判零分。' +
      '两条钉在同一把尺上，恒绿与恒红各由一条兜住——任一不符则本报告不出（见脚本 B2 硬闸）。'
  )
  L.push('')

  H('未召回归因汇总')
  L.push('')
  const bucket = new Map()
  for (const s of scores) {
    for (const d of s.details) {
      if (d.status === 'injected') continue
      const key = d.drop ?? d.status
      bucket.set(key, (bucket.get(key) ?? 0) + 1)
    }
  }
  L.push('| 归因 | 处数 | 药方 |')
  L.push('| --- | --- | --- |')
  // 遍历**值域**而不是「数据里出现的键」：漏登记一个键的后果是整类静默消失（首版实测），
  // 故这里以 `MISS_RX` 为准，值域外的键由 `checkAttributionCoverage` 在落盘前拦下。
  let attributed = 0
  for (const [key, rx] of Object.entries(MISS_RX)) {
    if (!bucket.has(key)) continue
    attributed += bucket.get(key)
    L.push(`| ${key} | ${bucket.get(key)} | ${rx} |`)
  }
  const totalMiss = [...bucket.values()].reduce((a, b) => a + b, 0)
  if (totalMiss === 0) L.push('| — | 0 | 全部应命中锚点均已注入 |')
  L.push('')
  // 计数单位是 **(条目, 锚点) 对**，不是锚点：同一节被两条条目标为 `expect` 时算两处
  // （两条各自独立地没命中）。去重数一并给出，免得读者把「12 处」读成「12 个节」。
  const distinctMiss = new Set()
  for (const s of scores) {
    for (const d of s.details) {
      if (d.status === 'injected') continue
      distinctMiss.add(anchorKey(d.docPath, d.sectionAnchor))
    }
  }
  L.push(
    `> 未召回归因合计 ${totalMiss} **处**（全部落在已登记值域内）。**口径**：含负例条目的 ` +
      '`expect` 锚点——§ 三 的两张明细表只列 real / constructed，故两张表的未命中数之和会小于' +
      `本表的合计（差额 = 负例的未命中）。计数单位 = **(条目, 锚点) 对**，去重后 ${distinctMiss.size} 个不同锚点` +
      (distinctMiss.size === totalMiss ? '。' : '（同一节被多条条目标为 `expect` 时按对计）。')
  )
  L.push('')

  return L.join('\n')
}

// ─── JSON 副产品（与 md 同源，评估可视化的取数口） ────────

/**
 * 报告 JSON 副产品的路径：与 md **同目录、同基名**，只换扩展名（`x.md` → `x.json`）。
 *
 * 用 `path.parse` 而不是 `outFile.replace(/\.md$/, '.json')`：`--out` 指到别的扩展名时
 * 后者会拼出 `x.txt.json`（同目录多出一份没人认得名的文件），前者恒得 `x.json`。
 */
export function reportJsonPath(outFile) {
  const parsed = path.parse(outFile)
  return path.join(parsed.dir, `${parsed.name}.json`)
}

/**
 * JSON 副产品的内容 = **喂给 `renderReport` 的那一份 ctx** + 顶层 `schema`。
 *
 * **一处算、两处渲染**：本函数与 `renderReport` 吃的是**同一个对象**，不是各自重算一遍。
 * 两份视图数字对不上，是这类「顺手多落一份」最典型的坏法——而且只有逐条对表才看得出，
 * 故 `main` 里那个 ctx 必须是一个 `const`，两边都引用它（`retrieval-baseline.test.js`
 * 有静态断言钉死这条接线）。
 *
 * ⚠️ **本函数原样序列化整个 ctx ⇒「ctx 必须全确定」是 B1 在 json 侧的承重条件。**
 * md 侧只挑一部分渲染，ctx 里多一个随机值未必看得出来；json 侧则**一个不落地落盘**。
 * 首版就是这么栽的：`reportCtx.embed` 透传了 `embedStatus.port`（`EMBED_SIDECAR_PORT=0`
 * ⇒ 每跑一个随机值），md 两跑逐字节一致、json 只有那一处不同。⇒ 原始读数必须先在
 * `main` 里加工成确定值再进 ctx，本函数不做过滤（过滤会把「ctx 是唯一数字来源」这条毁掉）。
 *
 * `schema` 放**顶层**（md 里那一栏在表格中）：消费方要能先判版本再决定怎么读，
 * 埋在深层字段里等于逼每个消费方自己找。
 */
export function buildReportJson(ctx) {
  return { schema: BASELINE_REPORT_SCHEMA, ...ctx }
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
  const args = { root: null, db: null, env: null, date: null, out: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--root') args.root = argv[++i] ?? null
    else if (a === '--db') args.db = argv[++i] ?? null
    else if (a === '--env') args.env = argv[++i] ?? null
    else if (a === '--date') args.date = argv[++i] ?? null
    else if (a === '--out') args.out = argv[++i] ?? null
    else if (a === '--help' || a === '-h') args.help = true
  }
  return args
}

function msgOf(err) {
  return err && err.message ? err.message : String(err)
}

/** 自举：原生 node 跑 `.mjs` 无法 import `.ts`（链段是 TS） */
function bootstrap(argv) {
  if (process.env.RETRIEVAL_BASELINE_TSX === '1') return false
  if (!existsSync(TSX_CLI)) {
    process.stderr.write(
      `[eval:retrieval:baseline] 找不到 tsx（${TSX_CLI}），请确认已执行 pnpm install\n`
    )
    process.exit(2)
  }
  const child = spawn(process.execPath, [TSX_CLI, fileURLToPath(import.meta.url), ...argv], {
    stdio: 'inherit',
    env: { ...process.env, RETRIEVAL_BASELINE_TSX: '1' },
  })
  child.on('exit', (code) => process.exit(code ?? 2))
  child.on('error', (err) => {
    process.stderr.write(`[eval:retrieval:baseline] 拉起 tsx 失败: ${msgOf(err)}\n`)
    process.exit(2)
  })
  return true
}

/** 机器通道（stdout 单行 JSON）+ 人类汇总（stderr） */
function emit(report, human) {
  process.stdout.write(JSON.stringify(report) + '\n')
  process.stderr.write(human + '\n')
}

/** 统一的「闸未过」出口：**不落文件**（票面 B5 明写） */
function refuse(phase, payload, human) {
  emit({ ok: false, phase, ...payload }, `[eval:retrieval:baseline] 拒出报告：${human}`)
  return 1
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(
      '用法: node scripts/eval/retrieval-baseline.mjs [--root <仓库根>] [--db <sqlite 路径>]\n' +
        '       [--env <外部 .env>] [--date YYYY-MM-DD] [--out <报告路径>]\n' +
        '  跑 R9 黄金集的检索基线；报告缺省落 docs/eval/retrieval-baseline-<date>.md，\n' +
        '  同批另出同基名的 .json（前端「检索」tab 与 /api/eval/retrieval/* 的取数口）。\n' +
        '  --db 缺省 <root>/packages/server/data/cat-study-dev.db（worktree 内无库 ⇒ 显式传主仓库库路径）。\n' +
        '  --date 可注入（B1 复跑比对用；日期不进数值面）。\n'
    )
    return 0
  }

  const root = args.root ?? REPO_ROOT
  const date = args.date ?? localDate()
  const goldenFile = path.join(root, 'docs', 'eval', 'retrieval-golden.json')
  const outFile = args.out ?? path.join(root, 'docs', 'eval', `retrieval-baseline-${date}.md`)

  // env.ts 只认仓库根 .env；worktree 内通常是空的，故 --env 指向主仓库 .env。
  await import(pathToFileURL(path.join(root, 'packages/server/src/env.js')).href)
  if (args.env) {
    try {
      const { loaded } = loadEnvFile(args.env)
      process.stderr.write(`[eval:retrieval:baseline] 从 ${args.env} 补载 ${loaded} 个变量\n`)
    } catch (err) {
      process.stderr.write(
        `[eval:retrieval:baseline] 读不到 --env 指定的文件 ${args.env}: ${msgOf(err)}\n`
      )
      return 2
    }
  }

  // 端口隔离：**恒动态端口**，位置刚性（早于任何 EmbeddingClient 构造）。见文件头
  // 「嵌入供给」——继承活 server 的 3210 会 EADDRINUSE 降级成仅关键词通道 ⇒ 假读数。
  process.env.EMBED_SIDECAR_PORT = '0'

  // ─── 黄金集读取 + schema 闸 ─────────────────────────
  let goldenData
  try {
    goldenData = JSON.parse(readFileSync(goldenFile, 'utf8'))
  } catch (err) {
    process.stderr.write(`[eval:retrieval:baseline] 读不到黄金集 ${goldenFile}: ${msgOf(err)}\n`)
    return 2
  }
  const schema = validateGoldenSet(goldenData)
  if (!schema.ok) {
    return refuse(
      'golden-schema',
      { errors: schema.errors },
      `黄金集 schema 不过（${schema.errors.length} 条），先修 R9 产物`
    )
  }

  // ─── B6：显式注入真库（readonly + fileMustExist = 静默建空库物理不可达） ───
  const dbPath = path.resolve(
    args.db ?? path.join(root, 'packages/server', 'data', 'cat-study-dev.db')
  )
  if (!existsSync(dbPath)) {
    // 提示语按「缺省」与「显式传了 --db」分叉：对已经传了 --db 的人再讲 worktree 是噪声，
    // 他此刻要听的是「你给的这个路径不存在」。
    process.stderr.write(
      `[eval:retrieval:baseline] 库不存在：${dbPath}\n` +
        (args.db
          ? '  （--db 指定的路径不存在：核对拼写，或先确认该库已生成）\n'
          : '  （缺省库路径指向仓库内的 data/*.db——worktree 内没有它，它是未跟踪产物；' +
            '跑批请显式 --db 指向主仓库的库）\n')
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

  try {
    const dbRows = db.prepare('SELECT count(*) AS c FROM chunks').get().c
    const dbDocs = db.prepare('SELECT count(DISTINCT doc_path) AS c FROM chunks').get().c

    // ─── 前置闸：golden-check（R9 产物）——锚点腐烂即停 ───
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

    const corpus = checkCorpusGate({
      chunksRows: dbRows,
      docPaths: dbDocs,
      liveDocs: index.anchors.size,
    })
    if (!corpus.ok) {
      return refuse('corpus', { dbRows, dbDocs, liveDocs: index.anchors.size }, corpus.reason)
    }

    // 索引新鲜度（必判第三条）：块数只发现「文件集变了」，这里发现「文件改了但节名没变」
    const docRows = db
      .prepare('SELECT DISTINCT doc_path AS docPath, origin_id AS originId FROM chunks')
      .all()
    const freshness = checkIndexFreshness({
      rows: docRows,
      hashObject: (rel) => {
        try {
          return scanMod.gitHashObject(root, rel)
        } catch {
          return null
        }
      },
    })
    if (!freshness.ok) {
      return refuse(
        'stale-index',
        { stale: freshness.stale, checked: freshness.checked },
        `索引落后于语料 ${freshness.stale.length}/${freshness.checked} 份——` +
          '跑的是旧正文。先 `pnpm flywheel:scan` 重扫再跑批'
      )
    }

    // ─── 嵌入链就绪（独立 sidecar，动态端口）──────────────
    await startEmbeddingSidecar()
    const embedStatus = getEmbeddingStatus()
    if (!embedStatus.ok) {
      return refuse(
        'embed-unavailable',
        { reason: embedStatus.reason },
        `嵌入链未就绪（${embedStatus.reason}）——向量通道缺席时的一切读数都是假读数`
      )
    }

    // ─── B2 canary：选一条**真实可召回**的节（最长锚点 ⇒ 最具判别性） ───
    const target = db
      .prepare(
        'SELECT doc_path AS docPath, section_anchor AS sectionAnchor FROM chunks ' +
          'ORDER BY length(section_anchor) DESC, doc_path ASC, section_anchor ASC LIMIT 1'
      )
      .get()
    if (!target) {
      return refuse('corpus', { dbRows, dbDocs }, '库内没有可作 canary 的节')
    }
    const canaries = buildCanaries({ docPath: target.docPath, sectionAnchor: target.sectionAnchor })
    const canaryRuns = []
    const canaryResults = []
    for (const c of canaries) {
      const r = await runRetrievalChain([c.query], { startedAt: Date.now() })
      canaryRuns.push({ id: c.id, result: r })
      canaryResults.push(evaluateCanary({ canary: c, result: r }))
    }
    // B2 期望分 + 嵌入健康度（后者不可省：嵌入降级时必不中条目的 recall 同样是 0，
    // 只判期望分会把「尺子瞎了」读成「尺子判得对」——这正是反对照要防的假绿）。
    const canaryHealth = checkEmbedHealth(canaryRuns)
    const canaryBad = canaryResults.filter((c) => !c.ok)
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
        canaryBad.length > 0
          ? `canary 反对照不过（${canaryBad.map((c) => c.id).join(', ')}）——测量工具是恒绿/恒红假尺`
          : `canary 嵌入链降级（${canaryHealth.offenders.map((o) => o.id).join(', ')}）——期望分为 0 可能是「没看见查询」而非「真不命中」`
      )
    }

    // ─── 逐条跑批 ───────────────────────────────────────
    const results = []
    const scores = []
    const rechecked = []
    for (const entry of goldenData.entries) {
      const queries = [entry.query, ...entry.rewritten]
      const r = await runRetrievalChain(queries, { startedAt: Date.now() })
      results.push({ id: entry.id, result: r })
      // 逐条评分：这条有**任何**未注入锚点就走逐查询重搜——`below_topk` 的判别需要它，
      // §二 的「最小距离」读数也需要它（已有归因的锚点虽不改判，读数要换成紧界）。
      // 判据与接线都在 `rescoreWithRecheck` 里（那里可注入假 embed/search 单测）。
      const { score, rechecked: didRecheck } = await rescoreWithRecheck({
        entry,
        result: r,
        queries,
        embed: embedText,
        search: (vector, q, maxDistance) =>
          chunksRepo.searchChunksHybrid(
            vectorToBlob(vector),
            q,
            chunksRepo.HYBRID_POOL_PER_QUERY,
            maxDistance
          ),
      })
      if (didRecheck) rechecked.push(entry.id)
      scores.push(score)
    }

    // ─── B5 降级硬闸 ────────────────────────────────────
    const degradation = checkDegradation(results)
    if (!degradation.ok) {
      return refuse(
        'degradation',
        { offenders: degradation.offenders },
        `嵌入链降级 ${degradation.offenders.length} 条（向量通道可能静默缺席）`
      )
    }

    // ─── 归因值域自检（明细与汇总必须对得上账） ─────────────
    const coverage = checkAttributionCoverage(scores)
    if (!coverage.ok) {
      return refuse(
        'attribution',
        { unknown: coverage.unknown },
        `出现未登记的归因键 ${coverage.unknown.join(', ')}——` +
          '先把它登记进 MISS_RX 再跑（否则汇总表会静默少一整类，明细与汇总对不上账）'
      )
    }

    // ─── 渲染 + 落盘 ────────────────────────────────────
    const groups = {}
    for (const kind of ['real', 'constructed']) {
      groups[kind] = summarizeGroup(scores.filter((s) => s.kind === kind))
    }
    const negatives = scores.filter((s) => s.kind === 'negative')
    const params = currentRetrievalParams()
    // ⚠️ 这一个 `const` 是 md 与 json **两份视图的唯一数字来源**——改成内联字面量、
    // 或让 json 那边自己再拼一份，两份读数就会各自漂移（且只在逐条对表时看得出来）。
    const reportCtx = {
      date,
      dbPath,
      dbRows,
      dbDocs,
      goldenFile,
      goldenData,
      goldenCounts: schema.byKind ?? {},
      liveDocs: index.anchors.size,
      rotten: rotten.length,
      indexFreshness: { checked: freshness.checked, stale: freshness.stale.length },
      params,
      // ⚠️ 这里**不得**透传 `embedStatus.port` 原值：`EMBED_SIDECAR_PORT=0` ⇒ 每跑一个随机端口，
      // 而 `buildReportJson` 把 ctx 原样序列化 ⇒ 写进去就破 json 的 B1（md 侧只取下面这个
      // 布尔、看不见，所以两跑 md 一致而 json 不一致）。**原始读数在此加工成确定值**。
      embed: {
        model: embedStatus.model,
        dim: embedStatus.dim,
        handshaked: typeof embedStatus.port === 'number' && embedStatus.port > 0,
      },
      groups,
      scores,
      canary: canaryResults,
      negatives,
      maxDistance: params.maxDistance,
      recheck: { entries: rechecked.length },
    }
    const report = renderReport(reportCtx)
    const jsonOutFile = reportJsonPath(outFile)

    // 两份**同批**落盘：拒出路径（上面的 `refuse`）在更早处 return，故 md/json 都不落。
    // 顺序上 md 在前——落到这里已经过了全部硬闸，两笔写不再有分支。
    mkdirSync(path.dirname(outFile), { recursive: true })
    writeFileSync(outFile, report + '\n', 'utf8')
    writeFileSync(jsonOutFile, JSON.stringify(buildReportJson(reportCtx)) + '\n', 'utf8')

    const redCount = negatives.filter((s) => s.forbidHit.length > 0).length
    emit(
      {
        ok: true,
        phase: 'done',
        out: outFile,
        outJson: jsonOutFile,
        date,
        db: dbPath,
        dbRows,
        dbDocs,
        entries: goldenData.entries.length,
        groups: {
          real: {
            n: groups.real.n,
            recallMean: groups.real.recallMean,
            preThresholdRateMean: groups.real.preThresholdRateMean,
          },
          constructed: {
            n: groups.constructed.n,
            recallMean: groups.constructed.recallMean,
            preThresholdRateMean: groups.constructed.preThresholdRateMean,
          },
        },
        negatives: { n: negatives.length, red: redCount },
        rechecked,
        canary: canaryResults.map((c) => ({ id: c.id, recall: c.recall, ok: c.ok })),
      },
      `[eval:retrieval:baseline] entries=${goldenData.entries.length} ` +
        `real recall=${fmt4(groups.real.recallMean)} 阈值前=${fmt4(groups.real.preThresholdRateMean)} | ` +
        `constructed recall=${fmt4(groups.constructed.recallMean)} 阈值前=${fmt4(groups.constructed.preThresholdRateMean)} | ` +
        `negatives red=${redCount}/${negatives.length} | canary ✅ | ⇒ ${outFile} + ${jsonOutFile}`
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
      process.stderr.write(`[eval:retrieval:baseline] 未捕获异常: ${msgOf(err)}\n`)
      process.exit(2)
    })
}
