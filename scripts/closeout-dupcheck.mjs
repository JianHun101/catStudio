/**
 * 收口重复落盘检测 —— 同一份文档在两侧各写一遍时，git 3-way 会**静默吞掉一笔**
 *
 * 由来（票 `docs/run/docs-single-writer/tickets.md`）：本仓 docs 有过**两个写入口**
 * （主仓库工作区 + 会话 worktree）。两侧改到同一段 ⇒ 两笔**逐字节相同**的 patch，
 * 而 3-way merge 对「两侧改成同一内容」解析**干净**——内容确实一致，这是 git 的
 * **正确行为**，不是 bug，**没有可改的 git 开关**。所以只能在合并前**显式对账**：
 * 这是「判据面与合并面的错位」，不是配置问题。
 *
 * ── 判据（票面 §2.1，本票钉死）─────────────────────────────────
 *   ① `base = git merge-base <A> <B>`
 *   ② `ΔA` = A 侧 `base..A` 触及的文件集合；`ΔB` 同理
 *   ③ 对每个 `f ∈ ΔA ∩ ΔB`：`blobA === blobB` **且** 两侧各有 ≥1 笔提交触及 `f`
 *   ④ 命中 ⇒ 打印 文件 + 两侧 sha，`exit 1`；无命中 ⇒ `exit 0`
 *
 * **为什么 `blob 相同` 是必要条件**：blob 不同 = 正常 merge 面（3-way 走真合并），
 * 报警就是噪音；blob 相同 = 「同一份内容被写了两遍」，merge 会静默吞掉一笔——
 * 这正是要抓的形态。**不得放宽成「同文件即报警」**（红线 6）。
 *
 * ── 为什么还要「两侧各有 ≥1 笔提交触及 f」（第三条的那个 `且`）─────
 * `ΔA` 本身已经蕴含「A 侧有提交触及过 f」，故这条在绝大多数情形下是**冗余的机械
 * 复核**。保留它有两个实际作用：
 *   ① **判据语义完整**：报警的语义是「两侧**各自落过笔**」，不是「两端恰好同内容」。
 *      把两个条件分开写，读的人不会把「同内容」误当成充分条件；
 *   ② 它是 `commitsA` / `commitsB` 两个读数的**产生处**——命中时打印它们，收口方
 *      才能去 `git show` 那两笔提交裁决「保留哪一侧」。
 *
 * ── 「收口记录」为什么不会误报（票面 §2.2 要求写明）───────────────
 * 收口记录（`docs/run/<slug>/closeout.md`）的写入方是**收口方、写在 `dev` 上**，
 * 它是 **post-merge 产物**——记录的就是那次合并本身，物理上不可能先于合并存在于
 * 被合并的分支里。于是它**只出现在一侧**，机械扫描由两道闸各挡一次：
 *   ① 它不在 `ΔB` 里（B 侧从来没有这个路径）⇒ 进不了 `ΔA ∩ ΔB`；
 *   ② 即便某路径两侧都进过 `Δ`，只要一侧**删了**它，`git rev-parse <ref>:<path>`
 *      在该侧取不到 blob ⇒ 落 `skipped`，不进 `hits`（见 V3 的两格反例）。
 * 故「两侧同名文件」的机械扫描**不会**把收口记录误报成重复落盘——但要讲清为什么，
 * 否则下一个人会把 `skipped` 当成「漏报」而顺手放宽判据。
 *
 * ── 只读（红线 3）────────────────────────────────────────────
 * 只跑 `merge-base` / `diff` / `rev-parse` / `log`；**不** `checkout` / `reset` /
 * `commit` / `add`。本脚本可以安全地在收口链的任何位置跑——包括合并**之前**。
 *
 * ── 出口 ────────────────────────────────────────────────────
 *   0 = 无命中（含「判据无面」，见下）；1 = 命中（门禁判决）；2 = 调用方/环境错误
 * 与 `commit-uuid-gate.mjs` 同款三分：判决与「跑不动」必须分开——把「跑不动」
 * 混进 0 就是一条静默放行路径。
 *
 * **判据无面（vacuous）**：`merge-base` 等于 A 或 B 本身 = 一侧是另一侧的祖先
 * ⇒ 该侧 `Δ` 必为空 ⇒ 根本不存在分叉，**不可能**有「静默吞一笔」。此态 `exit 0`
 * 但**必须打警示**：它和「真跑了一遍、干净」读数不同，混同就是假绿门。
 *
 * ── 用法 ───────────────────────────────────────────────────
 *   node scripts/closeout-dupcheck.mjs --a <ref> --b <ref> [--cwd <path>]
 *   默认 `--a dev --b HEAD`；`--cwd` 默认 `process.cwd()`
 * 收口现场（会话 worktree 内）通常写全：
 *   node scripts/closeout-dupcheck.mjs --a dev --b session/<sid8>
 */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanGitEnv } from './commit-uuid-gate.mjs'

/** 调用方 / 环境错误（exit 2）——与门禁判决（exit 1）分开 */
export class DupcheckError extends Error {
  /** @param {string} message @param {number} [code] */
  constructor(message, code = 2) {
    super(message)
    this.name = 'DupcheckError'
    this.code = code
  }
}

/**
 * 全模块**唯一**的 git 调用出口。
 *
 * 单出口是结构不变量，不是风格偏好：剥离清单（`cleanGitEnv`）只在这里施一次，
 * 就**不可能**出现「某条 git 调用忘了洗 env」。测试里有一条静态源断言盯着这个
 * 形状（`execFileSync` 全源只出现一次）——新开第二个出口会当场变红。
 *
 * `cleanGitEnv()` 的必要性：本脚本会在 pre-commit / 钩子环境里被调起，那里 git
 * 注入了 `GIT_DIR` / `GIT_INDEX_FILE`，透传则 **cwd 形同虚设**（嵌套调用一律解析
 * 到外层仓库），临时仓沙箱测试会因此不封闭。
 */
function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: cleanGitEnv(),
    maxBuffer: 64 * 1024 * 1024,
  })
}

/** ref → commit sha；解析不出返回 `null`（不吞成空串——空串会被误当合法 ref） */
function revParseCommit(cwd, ref) {
  try {
    return git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim() || null
  } catch {
    return null
  }
}

/** `<ref>:<path>` → blob sha；该 ref 下无此路径（新增/删除）返回 `null` */
function revParseBlob(cwd, commit, file) {
  try {
    return git(cwd, ['rev-parse', '--verify', '--quiet', `${commit}:${file}`]).trim() || null
  } catch {
    return null
  }
}

/** `base..ref` 的净改动文件集。`-z`：NUL 分隔 + 关掉路径转义 ⇒ CJK/特殊字符路径原样往返 */
function changedFiles(cwd, base, commit) {
  const out = git(cwd, ['diff', '--name-only', '-z', base, commit, '--'])
  return out.split('\0').filter(Boolean)
}

/** `base..commit` 里触及 `file` 的提交（短 sha，时间序）。`--` 之后才是路径（路径形如选项也不误读） */
function commitsTouching(cwd, base, commit, file) {
  const out = git(cwd, ['log', '--format=%h', `${base}..${commit}`, '--', file])
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

/**
 * 命中判据（纯函数，可单独喂样本测——V5 反向对照直接变异这一行）。
 *
 * **`blobA === blobB` 是本判据的全部要害**：放宽成「同文件即报警」会把正常 merge
 * 面全变成噪音，改判据须先报店长（红线 6）。
 *
 * @param {string|null} blobA
 * @param {string|null} blobB
 * @param {string[]} commitsA
 * @param {string[]} commitsB
 * @returns {boolean}
 */
export function isDupLanding(blobA, blobB, commitsA, commitsB) {
  if (blobA == null || blobB == null) return false // 一侧不存在该路径 ⇒ 不可能「同内容两遍」
  return blobA === blobB && commitsA.length > 0 && commitsB.length > 0
}

/**
 * 全量读数（CLI 用；`findDupLandings` 是它的契约投影）。
 *
 * @param {{ refA: string, refB: string, cwd?: string }} args
 * @returns {{
 *   refA: string, refB: string, cwd: string,
 *   commitA: string, commitB: string, base: string,
 *   filesA: string[], filesB: string[], common: string[],
 *   hits: Array<{file: string, shaA: string, shaB: string, commitsA: string[], commitsB: string[]}>,
 *   skipped: Array<{file: string, reason: string}>,
 *   vacuous: boolean, vacuousReason: string|null
 * }}
 * @throws {DupcheckError} ref 解析不出 / 无共同祖先 / A 与 B 同一 commit（判据无主体）
 */
export function inspectDupLandings({ refA, refB, cwd = process.cwd() }) {
  if (!refA || !refB) throw new DupcheckError('refA / refB 都必填（--a <ref> --b <ref>）')

  const commitA = revParseCommit(cwd, refA)
  if (!commitA) throw new DupcheckError(`解析不出 refA=${refA}（不是本仓的 commit-ish）`)
  const commitB = revParseCommit(cwd, refB)
  if (!commitB) throw new DupcheckError(`解析不出 refB=${refB}（不是本仓的 commit-ish）`)

  // 同一 commit ⇒ 两侧 Δ 恒为空 ⇒ 判据**无主体**。fail-loud 而非 exit 0：
  // 这个调用形态（在主工作区 `--a dev --b HEAD`）每次都「无命中」，是真假绿门。
  if (commitA === commitB) {
    throw new DupcheckError(
      `refA 与 refB 指向同一 commit ${commitA.slice(0, 7)} —— 两侧 Δ 恒为空，判据无主体（不是「通过」）`
    )
  }

  let base
  try {
    base = git(cwd, ['merge-base', commitA, commitB]).trim()
  } catch {
    base = ''
  }
  if (!base) {
    throw new DupcheckError(
      `merge-base ${commitA.slice(0, 7)} ${commitB.slice(0, 7)} 失败——无共同祖先，无法对账`
    )
  }

  const filesA = changedFiles(cwd, base, commitA)
  const filesB = changedFiles(cwd, base, commitB)
  const setB = new Set(filesB)
  const common = filesA.filter((f) => setB.has(f)) // 保 A 侧顺序，读数稳定可复算

  // 判据无面：一侧是另一侧的祖先（base 即该侧 tip）⇒ 无分叉 ⇒ 不存在静默吞笔面
  let vacuous = false
  let vacuousReason = null
  if (base === commitA || base === commitB) {
    vacuous = true
    const ancestor = base === commitA ? refA : refB
    const descendant = base === commitA ? refB : refA
    vacuousReason = `${ancestor} 是 ${descendant} 的祖先（无可合并的分叉）⇒ 无重复落盘的可能面`
  }

  const hits = []
  const skipped = []
  for (const file of common) {
    const blobA = revParseBlob(cwd, commitA, file)
    const blobB = revParseBlob(cwd, commitB, file)
    // 一侧不存在该路径（新增/删除）：无法「同内容两遍」——收口记录正是靠这条豁免
    if (blobA == null || blobB == null) {
      skipped.push({ file, reason: '一侧 tip 上无此路径（删除）⇒ 不构成重复落盘' })
      continue
    }
    if (blobA !== blobB) continue // 正常 merge 面——3-way 走真合并，不报警
    const commitsA = commitsTouching(cwd, base, commitA, file)
    const commitsB = commitsTouching(cwd, base, commitB, file)
    if (!isDupLanding(blobA, blobB, commitsA, commitsB)) {
      skipped.push({ file, reason: 'blob 相同但单侧无提交触及 ⇒ 不构成「两侧各写一遍」' })
      continue
    }
    hits.push({ file, shaA: blobA, shaB: blobB, commitsA, commitsB })
  }

  return {
    refA,
    refB,
    cwd,
    commitA,
    commitB,
    base,
    filesA,
    filesB,
    common,
    hits,
    skipped,
    vacuous,
    vacuousReason,
  }
}

/**
 * 票面 §2.1 钉死的契约面（签名与返回形状**不得改**）。
 *
 * @param {{ refA: string, refB: string, cwd?: string }} args
 * @returns {{ file: string, shaA: string, shaB: string }[]} 命中项（`shaA`/`shaB` = blob sha）
 */
export function findDupLandings({ refA, refB, cwd = process.cwd() }) {
  return inspectDupLandings({ refA, refB, cwd }).hits.map(({ file, shaA, shaB }) => ({
    file,
    shaA,
    shaB,
  }))
}

const short = (sha) => String(sha).slice(0, 7)

/** 一行读数（成功路径走 stdout） */
export function formatSummary(r) {
  return (
    `[closeout-dupcheck] a=${r.refA}@${short(r.commitA)} b=${r.refB}@${short(r.commitB)} ` +
    `base=${short(r.base)} ΔA=${r.filesA.length} ΔB=${r.filesB.length} ` +
    `交集=${r.common.length} 命中=${r.hits.length}`
  )
}

/** 无面的警示（**必须走 stderr**：它与「跑了一遍、干净」不是同一个读数） */
export function formatVacuousWarning(r) {
  return (
    `[closeout-dupcheck] ⚠️  判据无面：${r.vacuousReason}。` +
    `本次**没有**对账任何文件——这不是「检查通过」，只是无面可查`
  )
}

/** 命中块（**必须走 stderr**，与 `commit-uuid-gate` 的阻断出口同款） */
export function formatHits(r) {
  const lines = [
    '',
    `[closeout-dupcheck] ❌ 重复落盘 ${r.hits.length} 处 —— 同一份内容两侧各写一遍，merge 会**静默吞掉一笔**`,
    '',
  ]
  for (const h of r.hits) {
    lines.push(`  ${h.file}`)
    lines.push(`    blob  ${r.refA}=${h.shaA}`)
    lines.push(`          ${r.refB}=${h.shaB}   （两侧逐字节相同 ⇒ 3-way 不冲突、不报警）`)
    lines.push(`    ${r.refA} 侧提交  ${h.commitsA.join(' ')}`)
    lines.push(`    ${r.refB} 侧提交  ${h.commitsB.join(' ')}`)
  }
  lines.push('')
  lines.push('  **先裁定保留哪一侧，再合并**（本脚本只检测、不修复，红线 2）。')
  lines.push('')
  return lines.join('\n')
}

/** 跳过的文件（无面/单侧新增删除）——打到 stdout，避免与「命中」混为一谈 */
export function formatSkipped(r) {
  if (r.skipped.length === 0) return null
  return (
    `[closeout-dupcheck] 跳过 ${r.skipped.length} 处交集文件：` +
    r.skipped.map((s) => `${s.file}（${s.reason}）`).join('；')
  )
}

const USAGE =
  '用法: node scripts/closeout-dupcheck.mjs --a <ref> --b <ref> [--cwd <path>]\n' +
  '      默认 --a dev --b HEAD；--cwd 默认 process.cwd()'

/** `--a/--b/--cwd` 解析。未知参数 / 缺值 ⇒ 抛（exit 2）——绝不静默回落默认值 */
export function parseArgs(argv) {
  const opts = { refA: 'dev', refB: 'HEAD', cwd: process.cwd(), help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const take = (name) => {
      const v = argv[i + 1]
      if (v == null || v.startsWith('--')) throw new DupcheckError(`${name} 缺值`)
      i += 1
      return v
    }
    if (arg === '--a') opts.refA = take('--a')
    else if (arg === '--b') opts.refB = take('--b')
    else if (arg === '--cwd') opts.cwd = resolve(take('--cwd'))
    else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new DupcheckError(`未知参数 ${arg}`)
  }
  return opts
}

function main(argv) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (err) {
    console.error(`[closeout-dupcheck] ${err.message}\n${USAGE}`)
    return 2
  }
  if (opts.help) {
    console.log(USAGE)
    return 0
  }
  if (!opts.refA || !opts.refB) {
    console.error(`[closeout-dupcheck] refA / refB 都必填\n${USAGE}`)
    return 2
  }

  let r
  try {
    r = inspectDupLandings({ refA: opts.refA, refB: opts.refB, cwd: opts.cwd })
  } catch (err) {
    console.error(`[closeout-dupcheck] ${err?.message ?? err}`)
    return err instanceof DupcheckError ? err.code : 2
  }

  console.log(formatSummary(r))
  const skippedLine = formatSkipped(r)
  if (skippedLine) console.log(skippedLine)

  if (r.hits.length > 0) {
    console.error(formatHits(r))
    return 1
  }
  console.log(`[closeout-dupcheck] ✅ 无重复落盘（ΔA ∩ ΔB 上无 blob 相同项）`)
  if (r.vacuous) console.error(formatVacuousWarning(r)) // 警示**必须走 stderr**
  return 0
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) process.exit(main(process.argv.slice(2)))
