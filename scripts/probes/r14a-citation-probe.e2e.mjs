/**
 * R14a 角标引用遵循度离线探针（**不碰生产链**）
 *
 * 票面：docs/run/eval-system/R14a-citation-marker-probe.md
 *
 * 要回答的唯一问题：**给定指示语，猫在回复里会不会标 `[n]`？标得对不对？**
 *
 * ## 形态（票面 §四裁决：**不新建离线调用链**）
 *
 * 复用现成的 adapter 工厂（`packages/server/src/llm/registry.ts` 的
 * `getAdapterForAgent`），本探针只做**调用方**。新建独立调用链 = 又造一个可能与
 * 生产不一致的真相源（「离线跑通、线上不通」）。
 *
 * ## 阶段
 *
 * - `--mode s0`（**停损点**）：4 条链路可达性。对每个 provider 发一次极短真实调用，
 *   可达 / 不可达**以实测为准**——不看端口与二进制（ollama 适配器会自拉 serve、
 *   dsh 走全局安装，静态检查会误判）。不可达记「未测」+ 原因，**不许拿别的
 *   provider 的数顶替**。
 * - `--mode s1`：`claude` 单 provider × 甲/乙两版 × N 遍 ⇒ 挑胜者。
 * - `--mode s2`：4 provider（可达者）× **胜出版本** × N 遍（`--winner jia|yi`）。
 *
 * ## 三分判据（票面 §三：**不许并成一个「遵循率」**）
 *
 * | 失效模式   | 含义                             | 修法方向         |
 * | ---------- | -------------------------------- | ---------------- |
 * | 不标       | 用了某节但一个号都没写           | 改措辞 / 加强指示 |
 * | 标错号     | 标了 `[2]` 但内容其实来自第 3 节 | 改「编号↔内容」描述 |
 * | 标不存在号 | 只注入 3 节却写 `[4]`            | 后端降级（R14b） |
 *
 * 并成一个比率会分不清「不会标」和「标错」——而这两者**修法相反**。
 * 四格**各自成列**（不互斥）：混标（既有合法号又有越界号）时不得互相掩盖。
 *
 * ## 判据面三条（票面 §四，否则读数被假阳性污染）
 *
 * 判据是「**代码字面量不是引用**」——**按机制定义，不按模式定义**：
 *
 * - **代码字面量内的 `[n]` 不计入**。机制有二形态：围栏块（``` … ```）与内联码
 *   （`` `…` ``）。猫举代码例时会写出 `[1]`；引用注入原文里的 `float[512]`
 *   （sqlite-vec 列类型）是**同一机制**的另一副面孔——S2 实测两处「标不存在号」
 *   正是它（claude / dsh 各一、同题同因）。
 *   本批 90 份回复实测：围栏 9 份 / 内联码 90 份 / **缩进代码块 0 份**；换语料即失效，
 *   见到第三种形态时同批纳入（见 `inlineCodeRanges`）。
 * - **猫复读指示语 ≠ 标了**：甲版指示语**自身含字面量 `[1]`**，猫转述/解释该指示语
 *   时会产生 `[1]`。判据取「正文里指向某节内容的标注」，复述区段内的标注单独计数
 *   并剔除（见 `instructionEchoRanges`，判据是「与指示语有 ≥ ECHO_NGRAM 的公共子串」）。
 *
 * 被剔除的三类**各自成列**进产物（`markersInFence` / `markersInCode` / `markersInEcho`），
 * **不许静默剔除**——静默剔除会让「判据面把真值扫掉」变成假绿。
 *
 * ## `--mode reclassify`（票面 §八 验收 9）
 *
 * 判据面变了 ⇒ 已跑产物的派生字段用**同一个 `classifyReply`** 重算（`reclassifyReport`）。
 * 零 LLM 调用、**不换样本**（重跑 = 另一次抽样，会把 S1/S2 对比的证据换掉）。
 *
 * 用法:
 *   node scripts/probes/r14a-citation-probe.e2e.mjs --mode s0 [--db <sqlite>] [--out <json>]
 *   node scripts/probes/r14a-citation-probe.e2e.mjs --mode s1 [--n 5] [--out <json>]
 *   node scripts/probes/r14a-citation-probe.e2e.mjs --mode s2 --winner jia [--n 5] [--out <json>]
 *   node scripts/probes/r14a-citation-probe.e2e.mjs --mode reclassify --in <旧产物> --out <新产物>
 *
 * 退出码：0 = 读到结果（含「不可达」这类结论）；1 = 环境/自举失败；2 = 用法错误。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

// ─── 注入串形状规格（票面 §四，**逐字取自 `renderSections`**）─────────
//
// ⚠️ 本探针**不许自拟记忆段格式**——形状一变，「与生产同形」就没了，
// 而读数会静默失效（探针照跑、结论不再代表生产）。
// 同步守卫见 `r14a-citation-probe.test.js` 的「形状规格守卫」组：
// `packages/server/src/memory/index.ts` 的 `renderSections` 一变即红。

/** 记忆区块头（`renderSections` 里 `【相关记忆】` 的模板字面量） */
export const MEMORY_BLOCK_HEADER = '【相关记忆】'

/** 整块前缀：`renderSections` 以 `\n\n` 起头 */
export const MEMORY_BLOCK_PREFIX = '\n\n'

/** 逐行 `序号. 正文`——序号 `i + 1` 是**最终位置**（`renderOrder` 重排后） */
export function renderMemoryBlock(sections) {
  if (sections.length === 0) return ''
  const lines = sections.map((s, i) => `${i + 1}. ${s}`)
  return `${MEMORY_BLOCK_PREFIX}${MEMORY_BLOCK_HEADER}\n${lines.join('\n')}`
}

// ─── 独立变量：指示语措辞（**票面 §二 定稿，实施者不自拟**）────────────
//
// 遵循度是**措辞的函数**——自拟一版测出的数，对定稿版零信息量。
// ⚠️ 两版都**不作位置要求**（句末 / 词后皆可）：位置本身是待观察量，
// 在指示语里写位置要求 = 引入第二个自变量。

export const VARIANTS = {
  jia: '（以下为检索到的历史结论。若你采纳了其中某条，请在该处标注其编号，如 [1]；没有采纳的条目不标。）',
  yi: '（采纳某条时标注其编号，如 [1]。）',
}

/** 把指示语插进记忆块——位置：`【相关记忆】` 头**之后**、`1.` **之前**（票面 §四） */
export function withInstruction(sections, instruction) {
  if (sections.length === 0) return ''
  const lines = sections.map((s, i) => `${i + 1}. ${s}`)
  return `${MEMORY_BLOCK_PREFIX}${MEMORY_BLOCK_HEADER}\n${instruction}\n${lines.join('\n')}`
}

// ─── 问题集（票面 §七）：答案锚点 `expectSection` 是**必需项**──────────
//
// 「标错号」= 标了 `[2]` 但内容其实来自第 3 节——**正则算不出来**，它要的是
// 内容与节的对应关系。没有答案锚点，报告里的那一格只能编。
//
// ⚠️ 故每题带 `answerTokens`：出题时钉死「答案出自哪一节」，且**运行时机械校验**
// （`verifyQuestionAnchor`）——全部答案词只出现在该节、别节零命中。校验不过 ⇒
// `refuse`，不落报告。这把「只有一个承载节」从人工声称变成可证伪断言。

/** 每题 3 节，答案节的位次轮转（不总是第 1 节——位次本身是待观察量之外的噪声源） */
export const QUESTIONS = [
  {
    id: 'q1-closeout-module',
    question: '收口器被拆成了哪个独立模块文件（完整路径）？它的只读探针函数叫什么名字？',
    answerSection: {
      docPath: 'docs/adr/0012-session-closeout-and-push-approval.md',
      anchor: '决策（收口器部分——仍有效）',
    },
    answerTokens: ['session-closeout.ts', 'inspectCloseout'],
    answerPosition: 1,
    distractors: [
      {
        docPath: 'docs/adr/0009-multimodal-knowledge-base.md',
        anchor: '两条不变量（扩展性论证核心） > 不变量 2：跨模态向量子空间分离',
      },
      {
        docPath: 'docs/plans/db-schema-governance.md',
        anchor: '三、P0 契约（本轮实施） > 3.2 索引（③三条，已拍板）',
      },
    ],
  },
  {
    id: 'q2-visual-subspace',
    question: '视觉子空间用的是哪个模型、多少维、落在哪张表？',
    answerSection: {
      docPath: 'docs/adr/0009-multimodal-knowledge-base.md',
      anchor: '两条不变量（扩展性论证核心） > 不变量 2：跨模态向量子空间分离',
    },
    answerTokens: ['SigLIP', '768', 'image_embeddings'],
    answerPosition: 2,
    distractors: [
      {
        docPath: 'docs/adr/0012-session-closeout-and-push-approval.md',
        anchor: '决策（收口器部分——仍有效）',
      },
      {
        docPath: 'docs/plans/db-schema-governance.md',
        anchor: '三、P0 契约（本轮实施） > 3.2 索引（③三条，已拍板）',
      },
    ],
  },
  {
    id: 'q3-execution-logs-index',
    question: 'P0 这批迁移里给 execution_logs 表补的第二条索引是哪两列？',
    answerSection: {
      docPath: 'docs/plans/db-schema-governance.md',
      anchor: '三、P0 契约（本轮实施） > 3.2 索引（③三条，已拍板）',
    },
    answerTokens: ['execution_logs(session_id, started_at)'],
    answerPosition: 3,
    distractors: [
      {
        docPath: 'docs/adr/0012-session-closeout-and-push-approval.md',
        anchor: '决策（收口器部分——仍有效）',
      },
      {
        docPath: 'docs/adr/0009-multimodal-knowledge-base.md',
        anchor: '两条不变量（扩展性论证核心） > 不变量 2：跨模态向量子空间分离',
      },
    ],
  },
]

/**
 * 从库里取一节（该节可能被切成多片，按 `part_index` 拼回整节）。
 * 拼法与生产 `renderSections` 的「按节补齐整节」同口径。
 */
export function loadSection(db, ref) {
  const rows = db
    .prepare(
      'SELECT body FROM chunks WHERE doc_path = ? AND section_anchor = ? ORDER BY part_index'
    )
    .all(ref.docPath, ref.anchor)
  return rows.map((r) => r.body).join('\n')
}

/**
 * 按 `answerPosition` 把答案节与干扰节拼成最终的**注入顺序**。
 * @returns `{ sections: [{docPath, anchor, isAnswer, text}], expectSection }`
 */
export function buildQuestionInjection(db, q) {
  const total = q.distractors.length + 1
  const sections = []
  let di = 0
  for (let pos = 1; pos <= total; pos++) {
    if (pos === q.answerPosition) {
      sections.push({ ...q.answerSection, isAnswer: true, text: loadSection(db, q.answerSection) })
    } else {
      const ref = q.distractors[di++]
      sections.push({ ...ref, isAnswer: false, text: loadSection(db, ref) })
    }
  }
  return { sections, expectSection: q.answerPosition }
}

/**
 * 机械校验答案锚点：**全部 `answerTokens` 只出现在答案节，别节零命中**。
 *
 * 这是「只有一个承载节」的可证伪断言——校验不过说明问题集本身坏了（干扰节也
 * 答得上，或答案节根本没有这个词），此时读数对「标错号」那一格**毫无信息量**。
 */
export function verifyQuestionAnchor(sections, answerTokens) {
  const hitsPerSection = sections.map((s) => answerTokens.filter((t) => s.text.includes(t)).length)
  const full = hitsPerSection.filter((h) => h === answerTokens.length).length
  const any = hitsPerSection.filter((h) => h > 0).length
  const problems = []
  if (full === 0) problems.push('没有任何一节含全部答案词——答案词写错了或该节没被索引')
  if (any > 1) problems.push(`答案词出现在 ${any} 节——「只有一个承载节」不成立，干扰节也答得上`)
  return { ok: problems.length === 0, hitsPerSection, problems }
}

// ─── 判据面（票面 §四两条 + §八 四格口径）─────────────────

/** 围栏代码块区间（``` … ```）。票面 §四：围栏内的 `[n]` **不计入** */
export function fenceRanges(text) {
  const ranges = []
  for (const m of text.matchAll(/```[\s\S]*?```/g)) ranges.push([m.index, m.index + m[0].length])
  return ranges
}

/**
 * 内联代码区间（`` `…` ``）——票面 §四 判据面的**第三类区间**。
 *
 * ## 为什么判据是「代码字面量」而不是「围栏块」
 *
 * 票面原写「**围栏**代码块内不计入」——那是**模式名**。真正的判据是
 * 「**代码字面量不是引用**」：猫引用注入原文里的 `float[512]`（sqlite-vec 列类型）
 * 与它自己举代码例，是**同一个机制**，不是两件事。S2 实测两处 `[512]`
 * （claude / dsh 各一，同题同因）正落在内联码里 ⇒ 按旧口径被记成「标不存在号」。
 *
 * ## 与围栏的先后（承重）
 *
 * **必须先算围栏、再算内联**：内联正则 `` `[^`\n]*` `` 会匹配到 ``` 的**前两个反引号**
 * （空 span），若不排除就会把围栏定界符当内联码。
 * 此处用**重叠即丢**实现该顺序——落在围栏区间内的伪匹配整条丢弃。
 *
 * ## 形态清单（本仓实测，非假设）
 *
 * 90 份回复（S1 30 + S2 60）全量扫描：围栏 9 份、内联码 90 份、**缩进代码块 0 份**。
 * markdown 的第三种代码形态（行首四空格 / tab）在本批语料里**不存在**——
 * 换语料即失效，见到第三种时同批纳入，别假设只有这两种。
 *
 * @param {string} text
 * @param {Array<[number, number]>} fences 先用 `fenceRanges(text)` 算好；缺省自算（便于单测单独调用）
 * @returns {Array<[number, number]>} 升序不重叠的区间
 */
export function inlineCodeRanges(text, fences = fenceRanges(text)) {
  const ranges = []
  for (const m of text.matchAll(/`[^`\n]*`/g)) {
    const s = m.index
    const e = s + m[0].length - 1
    // 与任一围栏区间重叠 ⇒ 是围栏定界符的伪匹配（不是内联码）
    if (fences.some(([fs, fe]) => s <= fe && e >= fs)) continue
    ranges.push([s, e])
  }
  return ranges
}

/**
 * 与指示语有长公共子串的区段——**复述指示语**的载体。
 *
 * 判据：文本中任一 `ECHO_NGRAM` 长的子串也是指示语的子串 ⇒ 该区段是复述。
 * 甲版指示语**自身含字面量 `[1]`**，猫转述它时产生的 `[1]` 不是「标了」。
 * 取 8 字：短于它会把「标注」这类常用词误判成复述，长于它则漏掉「如 [1]」这种短引。
 */
export const ECHO_NGRAM = 8

export function instructionEchoRanges(text, instruction) {
  const grams = new Set()
  for (let i = 0; i + ECHO_NGRAM <= instruction.length; i++) {
    grams.add(instruction.slice(i, i + ECHO_NGRAM))
  }
  const raw = []
  for (let i = 0; i + ECHO_NGRAM <= text.length; i++) {
    if (grams.has(text.slice(i, i + ECHO_NGRAM))) raw.push([i, i + ECHO_NGRAM])
  }
  // 合并相邻/重叠区段（连同紧邻的 2 字，覆盖「如 [1]」里那个紧跟在复述后面的标注）
  const merged = []
  for (const [s, e] of raw) {
    const last = merged[merged.length - 1]
    if (last && s <= last[1] + 2) last[1] = Math.max(last[1], e)
    else merged.push([s, e])
  }
  return merged
}

function inRanges(index, ranges) {
  return ranges.some(([s, e]) => index >= s && index <= e)
}

/**
 * 抽出回复里的全部 `[n]` 标注，**按来源分列**。
 *
 * 区间判定的**顺序是语义的一部分**（重叠时先命中者定名）：
 * 围栏 → 内联码 → 复述指示语 → 正文。围栏必须先于内联码（见 `inlineCodeRanges`）。
 *
 * @returns `{ raw, effective, inFence, inEcho, inCode }`——各为去重升序的编号数组：
 *   - `raw`       = 全部 `[n]`（未过滤）
 *   - `effective` = **判据用**：剔除围栏内 + 内联码内 + 复述指示语处
 *   - `inFence` / `inEcho` / `inCode` = 被剔除的那些（**各自成列**，人工可复核）
 *
 * ⚠️ `inCode` **必须成列进产物**（run 的 `markersInCode`），**不许静默剔除**：
 * 本批真值是那 2 处 `float[512]`，但若哪天猫把真引用写进反引号（`` `[1]` ``），
 * 它与 `float[512]` **不同源**，必须看得见——静默剔除 = 又一支「判据面把真值扫掉」的假绿。
 */
export function extractMarkers(text, instruction = '') {
  const fences = fenceRanges(text)
  const codes = inlineCodeRanges(text, fences)
  const echoes = instruction ? instructionEchoRanges(text, instruction) : []
  const raw = new Set()
  const effective = new Set()
  const inFence = new Set()
  const inEcho = new Set()
  const inCode = new Set()
  for (const m of text.matchAll(/\[(\d+)\]/g)) {
    const n = Number(m[1])
    raw.add(n)
    if (inRanges(m.index, fences)) inFence.add(n)
    else if (inRanges(m.index, codes)) inCode.add(n)
    else if (inRanges(m.index, echoes)) inEcho.add(n)
    else effective.add(n)
  }
  const asc = (s) => [...s].sort((a, b) => a - b)
  return {
    raw: asc(raw),
    effective: asc(effective),
    inFence: asc(inFence),
    inEcho: asc(inEcho),
    inCode: asc(inCode),
  }
}

/**
 * 按 §八 四格口径归类一条回复（**四格各自成列、不互斥**）。
 *
 * - `correct`     标对 = 合法号集合含 `expectSection`
 * - `wrongNumber` 标错号 = 标了合法号，但**不含** `expectSection`
 * - `phantom`     标不存在号 = 出现 `> 节数` 或 `< 1` 的号（**单列**，不计入标错号）
 * - `notMarked`   不标 = 一个号都没出现
 */
export function classifyReply(markers, sectionCount, expectSection) {
  const inRange = markers.filter((n) => n >= 1 && n <= sectionCount)
  const outOfRange = markers.filter((n) => n < 1 || n > sectionCount)
  return {
    inRange,
    outOfRange,
    correct: inRange.includes(expectSection),
    wrongNumber: inRange.length > 0 && !inRange.includes(expectSection),
    phantom: outOfRange.length > 0,
    notMarked: markers.length === 0,
  }
}

// ─── 自举：原生 node 跑 `.mjs` 无法 import `.ts`（adapter 工厂是 TS）───

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

const BOOTSTRAP_FLAG = 'R14A_PROBE_TSX'

function bootstrap(argv) {
  if (process.env[BOOTSTRAP_FLAG] === '1') return false
  if (!existsSync(TSX_CLI)) {
    process.stderr.write(`[r14a] 找不到 tsx（${TSX_CLI}），请确认已执行 pnpm install\n`)
    process.exit(1)
  }
  const child = spawn(process.execPath, [TSX_CLI, fileURLToPath(import.meta.url), ...argv], {
    stdio: 'inherit',
    env: { ...process.env, [BOOTSTRAP_FLAG]: '1' },
  })
  child.on('exit', (code) => process.exit(code ?? 1))
  child.on('error', (err) => {
    process.stderr.write(`[r14a] 拉起 tsx 失败: ${err && err.message}\n`)
    process.exit(1)
  })
  return true
}

// ─── CLI ──────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    mode: null,
    db: null,
    out: null,
    in: null,
    provider: null,
    winner: null,
    n: 5,
    concurrency: 2,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--mode') args.mode = argv[++i] ?? null
    else if (a === '--db') args.db = argv[++i] ?? null
    else if (a === '--out') args.out = argv[++i] ?? null
    else if (a === '--in') args.in = argv[++i] ?? null
    else if (a === '--provider') args.provider = argv[++i] ?? null
    else if (a === '--winner') args.winner = argv[++i] ?? null
    else if (a === '--n') args.n = Number(argv[++i] ?? 5)
    else if (a === '--concurrency') args.concurrency = Number(argv[++i] ?? 2)
    else if (a === '--help' || a === '-h') args.help = true
  }
  return args
}

/** S0 冒烟题：极短、不依赖记忆段——只验链路通不通 */
const SMOKE_PROMPT = '请只回复两个字：收到'

/** S0 逐 provider 超时（ms）。CLI 型适配器起进程慢，给宽些；总时长由并发封顶 */
const SMOKE_TIMEOUT_MS = 150_000

/** S1/S2 单次调用超时（ms）——比 S0 宽：要真答一道题 */
const ANSWER_TIMEOUT_MS = 240_000

/** S1/S2 回复的 token 预算（够写短答 + 标注；不给思考留无限空间） */
const ANSWER_MAX_TOKENS = 2048

const USAGE =
  '用法: node scripts/probes/r14a-citation-probe.e2e.mjs --mode <s0|s1|s2|reclassify> [选项]\n' +
  '  --mode s0  4 条链路可达性（停损点）：每 provider 一次极短真实调用\n' +
  '  --mode s1  claude 单 provider × 甲/乙两版 × N 遍\n' +
  '  --mode s2  4 provider（可达者）× 胜出版本 × N 遍（需 --winner jia|yi）\n' +
  '  --mode reclassify  重算已有产物的派生字段（**零 LLM 调用、不换样本**，需 --in）\n' +
  '  --n <N>            每格重复遍数（默认 5，票面 §六 要求 N ≥ 5）\n' +
  '  --winner <jia|yi>  s2 的胜出版本\n' +
  '  --concurrency <k>  并发上限（默认 2——本地模型并发过高会争用）\n' +
  '  --in <json>        reclassify 的源产物（其上 runs 会被重算）\n' +
  '  --out <json>       落盘路径（票面 §八.7：docs/eval/r14a-citation-probe-<date>.json）\n' +
  '  --db 缺省 <root>/packages/server/data/cat-study-dev.db（worktree 内无库 ⇒ 显式传主仓库库路径）\n'

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help || !args.mode) {
    process.stdout.write(USAGE)
    return args.help ? 0 : 2
  }

  // reclassify 在**开库与 import adapter 之前**分流：它是派生数据的重算，
  // 零 LLM 调用、不需要 `agents` 表、也不需要 sidecar —— 走 DB 前置检查会让
  // 「worktree 里没有库」这种无关条件把它挡死。
  if (args.mode === 'reclassify') return reclassifyMode(args)

  const root = REPO_ROOT
  const dbPath = path.resolve(
    args.db ?? path.join(root, 'packages/server', 'data', 'cat-study-dev.db')
  )
  if (!existsSync(dbPath)) {
    process.stderr.write(
      `[r14a] 库不存在：${dbPath}\n` +
        '  （worktree 内没有它——它是未跟踪产物；请显式 --db 指向主仓库的库）\n'
    )
    return 1
  }

  const serverRequire = createRequire(path.join(root, 'packages', 'server', 'package.json'))
  const Database = serverRequire('better-sqlite3')
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })

  // 真实花名册（票面 §五：**以 `agents` 表实测为准**，票面那张表只是立票时读数）
  const agents = db
    .prepare(
      `SELECT name, llm_provider, llm_model, llm_api_key, llm_base_url, llm_env_extra,
              effort_level, llm_max_tokens, llm_temperature, system_prompt
       FROM agents ORDER BY name`
    )
    .all()

  const { getAdapterForAgent } = await import(
    pathToFileURL(path.join(root, 'packages/server/src/llm/registry.js')).href
  )

  try {
    if (args.mode === 's0') return await runS0(agents, getAdapterForAgent, args)
    if (args.mode === 's1')
      return await runAnswering(db, agents, getAdapterForAgent, args, ['jia', 'yi'])
    if (args.mode === 's2') {
      if (args.winner !== 'jia' && args.winner !== 'yi') {
        process.stderr.write('[r14a] --mode s2 需要 --winner <jia|yi>（胜出版本由 S1 定）\n')
        return 2
      }
      return await runAnswering(db, agents, getAdapterForAgent, args, [args.winner])
    }
  } finally {
    db.close()
  }
  process.stderr.write(`[r14a] 未知 mode: ${args.mode}\n`)
  return 2
}

// ─── 共用：跑一次真实调用并判形（**验收 6：形状漂移必须报错**）──────────

/**
 * 流式收一轮回复，并**区分三种「没有正文」**——票面 §八.6 承重项：
 *
 * | status              | 判据                                        |
 * | ------------------- | ------------------------------------------- |
 * | `ok`                | 有正文                                      |
 * | `empty-reply`       | **见到带 `content` 的 chunk**，但正文为空   |
 * | `shape-mismatch`    | 见到 chunk，但**无一条**带可识别 `content`  |
 * | `no-chunks`         | 流结束，一个 chunk 都没见到                 |
 *
 * 后两条**不得**并入 `empty-reply`：空回复是本仓实测过的真实形态，混同 = 拿假读数
 * 当结论。本仓已踩过一次（`chunk.text` vs `Chunk.content` ⇒ 四只同形假读数）。
 * **仅写注释不算**——故这里是**返回状态**，调用方据此拒出结论。
 *
 * ⚠️ 字段名是 **`content`**（`Chunk.content`，`packages/shared/src/types.ts`），
 * 不是 `text`。`kind === 'thinking' | 'tool'` 的 chunk 也带 `content`，但**不是
 * 回复正文**——只有 `kind` 缺省或 `'text'` 的计入正文。
 */
export async function collectReply(adapter, messages, options) {
  let text = ''
  let thinkingChars = 0
  let sawDone = false
  let chunksSeen = 0
  let contentChunks = 0
  let shapeSample = null
  for await (const chunk of adapter.chatStream(messages, options)) {
    if (!chunk || typeof chunk !== 'object') continue
    chunksSeen++
    if (shapeSample === null) shapeSample = Object.keys(chunk).sort()
    if (typeof chunk.content === 'string') {
      contentChunks++
      if (chunk.kind === undefined || chunk.kind === 'text') text += chunk.content
      else thinkingChars += chunk.content.length
    }
    if (chunk.done) {
      sawDone = true
      break
    }
  }
  let status
  if (text.trim().length > 0) status = 'ok'
  else if (chunksSeen === 0) status = 'no-chunks'
  else if (contentChunks === 0) status = 'shape-mismatch'
  else status = 'empty-reply'
  return { status, text, thinkingChars, sawDone, chunksSeen, contentChunks, shapeSample }
}

/** 逐行拼 system prompt 尾部的记忆块（**生产同位置**：system prompt 末尾追加） */
export function buildMessages(agent, question, sections, instruction) {
  const block = withInstruction(
    sections.map((s) => s.text),
    instruction
  )
  return [
    { role: 'system', content: `${agent.system_prompt ?? ''}${block}` },
    { role: 'user', content: question },
  ]
}

/** 并发闸（默认 2）——本地模型并发过高会争用，且失败读数难归因 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

// ─── S0：链路可达性 ───────────────────────────────────

/** DB 行（snake_case）→ AgentConfig（camelCase）——与 API 边界同口径 */
export function rowToAgentConfig(row) {
  return {
    id: `probe-${row.name}`,
    name: row.name,
    avatar: '',
    systemPrompt: row.system_prompt ?? '',
    llmProvider: row.llm_provider,
    llmModel: row.llm_model,
    llmApiKey: row.llm_api_key ?? '',
    llmBaseUrl: row.llm_base_url ?? undefined,
    effortLevel: row.effort_level ?? undefined,
    llmMaxTokens: row.llm_max_tokens ?? undefined,
    llmTemperature: row.llm_temperature ?? undefined,
    llmEnvExtra: row.llm_env_extra ?? undefined,
  }
}

/**
 * 对一个 provider 的代表猫发一次极短真实调用。
 *
 * **可达判据**：`chatStream` 至少 yield 一个非空**文本** chunk 且最终 `done`。
 * 只验链路——不看回复内容对不对（那是 S1 的事）。
 */
async function smokeOne(agent, getAdapterForAgent) {
  const startedAt = Date.now()
  const result = {
    provider: agent.llm_provider,
    agent: agent.name,
    model: agent.llm_model,
    reachable: false,
    status: null,
    reason: null,
    replyChars: 0,
    thinkingChars: 0,
    shapeSample: null,
    replyPreview: null,
    elapsedMs: 0,
  }
  try {
    const adapter = getAdapterForAgent(rowToAgentConfig(agent))
    const r = await collectReply(adapter, [{ role: 'user', content: SMOKE_PROMPT }], {
      model: agent.llm_model,
      maxTokens: 64,
      timeoutMs: SMOKE_TIMEOUT_MS,
    })
    result.status = r.status
    result.replyChars = r.text.length
    result.thinkingChars = r.thinkingChars
    result.shapeSample = r.shapeSample
    result.replyPreview = r.text.slice(0, 80)
    if (r.status === 'ok' && r.sawDone) result.reachable = true
    else if (r.status === 'shape-mismatch')
      result.reason = `形状漂移：见到 ${r.chunksSeen} 个 chunk 但无一带 content 字段（keys=${JSON.stringify(r.shapeSample)}）`
    else if (r.status === 'no-chunks') result.reason = '流结束但未见任何 chunk'
    else result.reason = r.sawDone ? 'done 但无文本（空回复形态）' : '流结束但未见 done'
  } catch (err) {
    result.reason = err && err.message ? err.message : String(err)
  }
  result.elapsedMs = Date.now() - startedAt
  return result
}

async function runS0(agents, getAdapterForAgent, args) {
  // 每 provider 一只代表猫（多只同 provider 的，取字典序第一个；实测口径以表为准）
  const byProvider = new Map()
  for (const a of agents) {
    if (!byProvider.has(a.llm_provider)) byProvider.set(a.llm_provider, a)
  }

  const picked = args.provider
    ? [...byProvider.entries()].filter(([p]) => p === args.provider)
    : [...byProvider.entries()]

  process.stderr.write(
    `[r14a] S0：${picked.length} 个 provider（${picked.map(([p]) => p).join(', ')}），` +
      `每只超时 ${SMOKE_TIMEOUT_MS}ms，并发跑\n`
  )

  // 并发：S0 只判**通不通**，与耗时无关 ⇒ 争用不影响判据（与 R13a 的计时段不同）。
  // 串行的话最坏 4×超时 = 10 分钟，装不进预算。
  const results = await Promise.all(
    picked.map(async ([, agent]) => {
      const r = await smokeOne(agent, getAdapterForAgent)
      process.stderr.write(
        `[r14a]   ${r.provider} (${r.agent}/${r.model}): ` +
          `${r.reachable ? '✅ 可达' : '❌ 未确认'} ${r.elapsedMs}ms ` +
          `reply=${r.replyChars}字${r.reason ? ` — ${r.reason}` : ''}\n`
      )
      return r
    })
  )

  const report = {
    ok: true,
    mode: 's0',
    ranAt: new Date().toISOString(),
    smokePrompt: SMOKE_PROMPT,
    timeoutMs: SMOKE_TIMEOUT_MS,
    agentsInDb: agents.map((a) => ({ name: a.name, provider: a.llm_provider, model: a.llm_model })),
    results,
  }
  process.stdout.write(JSON.stringify(report) + '\n')

  if (args.out) writeReport(args.out, report)
  return 0
}

// ─── S1 / S2：真答题 + 标注判据 ─────────────────────────

async function answerOne(agent, getAdapterForAgent, q, injected, variant) {
  const instruction = VARIANTS[variant]
  const startedAt = Date.now()
  const base = {
    provider: agent.llm_provider,
    agent: agent.name,
    model: agent.llm_model,
    questionId: q.id,
    variant,
    expectSection: injected.expectSection,
    sectionCount: injected.sections.length,
    status: null,
    replyChars: 0,
    shapeSample: null,
    elapsedMs: 0,
  }
  try {
    const adapter = getAdapterForAgent(rowToAgentConfig(agent))
    const messages = buildMessages(agent, q.question, injected.sections, instruction)
    const r = await collectReply(adapter, messages, {
      model: agent.llm_model,
      maxTokens: ANSWER_MAX_TOKENS,
      temperature: agent.llm_temperature ?? undefined,
      timeoutMs: ANSWER_TIMEOUT_MS,
    })
    const m = extractMarkers(r.text, instruction)
    const cls = classifyReply(m.effective, injected.sections.length, injected.expectSection)
    return {
      ...base,
      status: r.status,
      replyChars: r.text.length,
      thinkingChars: r.thinkingChars,
      shapeSample: r.shapeSample,
      // 原始标注原样列出（§八.1：混标时不得互相掩盖）
      markersRaw: m.raw,
      markers: m.effective,
      markersInFence: m.inFence,
      markersInEcho: m.inEcho,
      markersInCode: m.inCode,
      ...cls,
      reply: r.text,
      elapsedMs: Date.now() - startedAt,
    }
  } catch (err) {
    return {
      ...base,
      status: 'error',
      error: err && err.message ? err.message : String(err),
      markersRaw: [],
      markers: [],
      markersInFence: [],
      markersInEcho: [],
      markersInCode: [],
      inRange: [],
      outOfRange: [],
      correct: false,
      wrongNumber: false,
      phantom: false,
      notMarked: false,
      reply: '',
      elapsedMs: Date.now() - startedAt,
    }
  }
}

/** 按 provider → 代表猫（字典序第一个，与 S0 同口径） */
export function pickRepresentatives(agents) {
  const byProvider = new Map()
  for (const a of agents) if (!byProvider.has(a.llm_provider)) byProvider.set(a.llm_provider, a)
  return byProvider
}

function cellKey(provider, variant) {
  return `${provider}|${variant}`
}

/** 汇总：**四格各自成列**，分母显式写（§六 分母口径） */
export function summarize(runs) {
  const byCell = {}
  for (const r of runs) {
    const k = cellKey(r.provider, r.variant)
    const c = (byCell[k] ??= {
      n: 0,
      ok: 0,
      correct: 0,
      wrongNumber: 0,
      phantom: 0,
      notMarked: 0,
      withMarkersInCode: 0,
      shapeMismatch: 0,
      emptyReply: 0,
      noChunks: 0,
      error: 0,
    })
    c.n++
    if (r.status === 'ok') c.ok++
    if (r.status === 'shape-mismatch') c.shapeMismatch++
    if (r.status === 'empty-reply') c.emptyReply++
    if (r.status === 'no-chunks') c.noChunks++
    if (r.status === 'error') c.error++
    if (r.correct) c.correct++
    if (r.wrongNumber) c.wrongNumber++
    if (r.phantom) c.phantom++
    if (r.notMarked) c.notMarked++
    // 代码字面量里的 `[n]`：**成列计数**（不是过滤掉的垃圾，是判据面的一格读数）
    if ((r.markersInCode ?? []).length > 0) c.withMarkersInCode++
  }
  return byCell
}

async function runAnswering(db, agents, getAdapterForAgent, args, variants) {
  const byProvider = pickRepresentatives(agents)
  // S1 单 provider；S2 全 provider（可达性由 S0 结论给定，不可达者仍跑、由 status 显式分列）
  const providers = args.provider
    ? [args.provider]
    : variants.length === 1 && args.mode === 's2'
      ? [...byProvider.keys()]
      : ['claude']
  const pickedAgents = providers.map((p) => {
    const a = byProvider.get(p)
    if (!a) throw new Error(`agents 表里没有 provider=${p} 的猫`)
    return a
  })

  // 问题集 + 机械校验答案锚点（校验不过 ⇒ refuse，不落报告）
  const questionSet = []
  for (const q of QUESTIONS) {
    const injected = buildQuestionInjection(db, q)
    const check = verifyQuestionAnchor(injected.sections, q.answerTokens)
    if (!check.ok) {
      process.stderr.write(
        `[r14a] ❌ 答案锚点校验不过（${q.id}）：${check.problems.join('；')}\n` +
          `  逐节命中数=${JSON.stringify(check.hitsPerSection)}\n` +
          '  ⇒ 问题集本身坏了，「标错号」那一格对本票零信息量。不落报告。\n'
      )
      return 1
    }
    questionSet.push({
      id: q.id,
      question: q.question,
      expectSection: injected.expectSection,
      answerTokens: q.answerTokens,
      anchorCheck: check,
      sections: injected.sections,
    })
  }

  const n = Math.max(1, args.n)
  const tasks = []
  for (const agent of pickedAgents) {
    for (const variant of variants) {
      for (const qs of questionSet) {
        for (let rep = 1; rep <= n; rep++) {
          tasks.push({ agent, variant, qs, rep })
        }
      }
    }
  }

  process.stderr.write(
    `[r14a] ${args.mode.toUpperCase()}：${pickedAgents.length} provider × ${variants.length} 版本 × ` +
      `${questionSet.length} 题 × N=${n} = **${tasks.length} 次真实调用**（并发 ${args.concurrency}）\n`
  )

  const runs = await mapLimit(tasks, args.concurrency, async (t) => {
    const r = await answerOne(
      t.agent,
      getAdapterForAgent,
      { id: t.qs.id, question: t.qs.question },
      t.qs,
      t.variant
    )
    r.repeat = t.rep
    process.stderr.write(
      `[r14a]   ${r.provider}/${r.variant}/${r.questionId}#${t.rep}: ${r.status} ` +
        `markers=${JSON.stringify(r.markers)} 标对=${r.correct ? 'Y' : 'n'} ` +
        `标错=${r.wrongNumber ? 'Y' : 'n'} 越界=${r.phantom ? 'Y' : 'n'} ` +
        `未标=${r.notMarked ? 'Y' : 'n'} ${r.elapsedMs}ms\n`
    )
    return r
  })

  const report = {
    ok: true,
    mode: args.mode,
    ranAt: new Date().toISOString(),
    n,
    concurrency: args.concurrency,
    variants,
    providers: pickedAgents.map((a) => ({
      provider: a.llm_provider,
      agent: a.name,
      model: a.llm_model,
    })),
    // 指示语全文进报告：措辞是本票的**唯一自变量**，不复述它读数不可复核
    instructions: Object.fromEntries(variants.map((v) => [v, VARIANTS[v]])),
    questionSet,
    runs,
    summary: summarize(runs),
  }
  process.stdout.write(JSON.stringify(report) + '\n')

  if (args.out) writeReport(args.out, report)
  return 0
}

function writeReport(out, report) {
  const abs = path.resolve(out)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, JSON.stringify(report, null, 2))
  process.stderr.write(`[r14a] 报告落 ${abs}\n`)
}

// ─── reclassify：判据面改了，派生字段重算（票面 §八 验收 9）─────────

/**
 * 用**当前的判据面**重算一份已有产物的派生字段。纯函数（不读盘），便于单测。
 *
 * ## 为什么不重跑
 *
 * ① 重跑 = **换样本**：LLM 随机，重跑是另一次抽样；S1/S2 对比与位次分析都锚在这
 * 90 份回复上，换样本 = 换证据。② 分类是**派生数据**：`reply` / `instruction` /
 * `sectionCount` / `expectSection` 全在产物里 ⇒ 重算**精确且零 LLM 调用**。
 *
 * ## 复用同一个 `classifyReply`（承重）
 *
 * 判据面**只此一份**。此处若另写一份分类逻辑，就是真相源分叉——正是本票立票时
 * 反对的形态（分片产物不手抄汇总，同一条理由）。
 *
 * ## 幂等
 *
 * 判据 = `runs` 与 `summary` **逐字段相等**（对已重算的产物再重算 = no-op）。
 * 戳记 `reclassified.at` 是重算时刻，**本就该变**，不纳入幂等判据。
 * key 顺序亦稳定（对象展开保序、新键位置在二次重算时不再变），故 `runs` 部分
 * 连 JSON 文本都逐字节相同。
 *
 * ## `error` 行**跳过**（不是漏掉）
 *
 * `answerOne` 的 catch 分支把派生字段**硬编码**成 `[]`/`false`（含 `notMarked: false`），
 * 那些值**不是 `classifyReply` 产出的**。重算会把 `notMarked` 从 `false` 翻成 `true`
 * ——那是**改语义**，不是改判据。故按 `status === 'error'` 整行透传，并把跳过的
 * 行**记进戳记**（`skipped` / `skippedRuns`），不许静默。
 *
 * @param {object} report 源产物（`runs` + `instructions`）
 * @param {{from?: string|null, at?: string}} [opts] `from` = 源产物标识，进戳记
 * @returns {object} 新产物（不修改入参）
 */
export function reclassifyReport(report, opts = {}) {
  const instructions = report.instructions ?? {}
  const skippedRuns = []
  const runs = (report.runs ?? []).map((run) => {
    if (run.status === 'error' || typeof run.reply !== 'string') {
      skippedRuns.push({
        provider: run.provider ?? null,
        variant: run.variant ?? null,
        questionId: run.questionId ?? null,
        repeat: run.repeat ?? null,
        status: run.status ?? null,
        why: 'error 行的派生字段非 classifyReply 产出（硬编码），重算会改语义',
      })
      return run
    }
    const m = extractMarkers(run.reply, instructions[run.variant] ?? '')
    const cls = classifyReply(m.effective, run.sectionCount, run.expectSection)
    return {
      ...run,
      markersRaw: m.raw,
      markers: m.effective,
      markersInFence: m.inFence,
      markersInEcho: m.inEcho,
      markersInCode: m.inCode,
      ...cls,
    }
  })

  return {
    ...report,
    runs,
    summary: summarize(runs),
    reclassified: {
      by: 'scripts/probes/r14a-citation-probe.e2e.mjs --mode reclassify',
      at: opts.at ?? new Date().toISOString(),
      // 「本件系重算」的判据：源产物 + 重算时刻（让人能分辨**跑出来的**与**重算出来的**）
      from: opts.from ?? null,
      // 若源产物**本身就是重算件**，把它的戳记链过来（二次重算不丢来源）
      fromReclassifiedAt: report.reclassified?.at ?? null,
      runs: runs.length,
      skipped: skippedRuns.length,
      skippedRuns,
      markersInCodeRuns: runs.filter((r) => (r.markersInCode ?? []).length > 0).length,
    },
  }
}

/** `--mode reclassify` 的 CLI 面：读源产物 → 重算 → 出 stdout + 可选落盘 */
export function reclassifyMode(args) {
  if (!args.in) {
    process.stderr.write('[r14a] --mode reclassify 需要 --in <源产物.json>\n')
    return 2
  }
  const inAbs = path.resolve(args.in)
  if (!existsSync(inAbs)) {
    process.stderr.write(`[r14a] 源产物不存在：${inAbs}\n`)
    return 1
  }
  let report
  try {
    report = JSON.parse(readFileSync(inAbs, 'utf8'))
  } catch (err) {
    process.stderr.write(`[r14a] 源产物解析失败：${err && err.message}\n`)
    return 1
  }
  if (!Array.isArray(report.runs)) {
    process.stderr.write('[r14a] 源产物没有 runs 数组——重算无对象\n')
    return 1
  }

  const next = reclassifyReport(report, { from: args.in })
  process.stdout.write(JSON.stringify(next) + '\n')
  if (args.out) writeReport(args.out, next)
  process.stderr.write(
    `[r14a] 重算 ${next.reclassified.runs} 行（跳过 ${next.reclassified.skipped} 行 error）；` +
      `含代码字面量角标 ${next.reclassified.markersInCodeRuns} 行；零 LLM 调用\n`
  )
  return 0
}

// ─── 入口 ─────────────────────────────────────────────

const isEntry =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isEntry && !bootstrap(process.argv.slice(2))) {
  process.exit(await main(process.argv.slice(2)))
}
