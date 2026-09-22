/**
 * 猫分支 fan-in —— 把某会话的全部猫分支按序合进一条**目标分支**。
 *
 * 两个入口共用同一个 merge 循环（`mergeBranchesInto`，全仓唯一一份）：
 * - **收口链**：`fanInCatBranches` → 目标 = 集成分支 `session/<sid8>`
 * - **审查面**（T-2 Phase I-b 形态 G）：`mergeCatBranchesIntoOwnBranch` → 目标 =
 *   审查者自己的猫分支，使它读到被审内容（§ `ensureExecutionWorktree`）
 *
 * 背景（ADR 0015 §6.2，E5 实测）：一猫一 worktree 落地后 `session/<sid8>` 不再收到
 * 提交（猫只在自己的分支提交），而 `closeoutSession` 只合这一条分支
 * （`session-closeout.ts` 的 `mergeSession`）。会话分支停在分叉点时 `merge --ff-only` 输出
 * `Already up to date.` 且**退出码 0** ⇒ 收口器返回 ok → 写 gate → 删掉会话
 * worktree 与会话分支，而猫的分支与 worktree 全部留在原地、从未进过任何地方。
 * 失效形态是**静默的**。⇒ 本模块是 T-2 的必备件，不是后继。
 *
 * 合并落点（ADR 0015 §6.3 方案 a）：**fan-in 关在会话集成分支上**（cwd 检出
 * `session/<sid8>` 的 worktree），dev 侧仍 `--ff-only`。理由：主工作区被收口
 * preflight 钉死在 dev，冲突没别处可去——会话 worktree 是唯一能安全承载 fan-in
 * 冲突的地方。⇒ `fanInCatBranches` 的 `cwd` 是**必填**（见下）。
 *
 * 判据全部来自 Phase S 模拟勘验（`docs/run/multi-cat-isolation/sim-report.md`，
 * 12 格实跑），不是推演：
 * - S3-1（阻断级）枚举必须带 `*`——裸前缀命中 0 条且**全链静默**
 * - S3-2 冲突码不止 `UU`（`AA`/`UU` 可并存）⇒ 守卫判 `MERGE_HEAD`，不按码枚举
 * - S3-5 `*` 可匹配空串 ⇒ 枚举侧过滤空 cat8
 * - E3 `merge --no-ff` 重跑同一条已合分支是 no-op（`Already up to date`，HEAD 不变）
 *
 * 调用点（**不再是零调用点**，Phase I 起）：
 * - 收口链 `session-closeout.ts` 的 `fanInCats` / `reclaimCats`
 * - 执行起点 `ensureExecutionWorktree`（T-2 Phase I-b 形态 G，`reply.ts` 调用）
 *
 * **冲突返投（票 9，2026-09-18 用户拍板）**：审查面 prep 撞冲突时，本模块除了
 * 抛错中止审查（fail-closed 不变），还向**冲突源分支所属的实施猫**投递一条结构化
 * 返修消息——「墙 #3 定时器重试死循环」的结构性成因就是这里**只 throw、不通知**
 * （`refuseIfMergeInProgress` 与 `mergeBranchesInto` 都只写日志，无人被叫醒 ⇒
 * 审查者静默死掉、实施者不知道要动）。返投把「轮询撞墙」变成**事件驱动**：
 * 状态变了（源分支新 sha）才重试。投递复用 `ingestUserMessage`（落库 + 广播 +
 * dispatch），**不新造管道**；这也是本模块唯一的 `db/` 与 `connectors/` 依赖。
 */

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { createLogger } from '../logger.js'
import { messageOf } from '../utils.js'
import { sessions as sessionsRepo, agents as agentsRepo } from '../db/repository/index.js'
import { ingestUserMessage } from '../connectors/ingest.js'
import {
  catSlug,
  cleanGitEnv,
  cleanupWorktreeResidue,
  ensureAgentWorktree,
  getMainRepoRoot,
  isPathInside,
  sessionBranch,
  sessionShortId,
} from './git-utils.js'

const log = createLogger('worktree-fanin')

/**
 * 冲突现场（**仅 `conflict` 时有值**）：谁撞的、撞在哪些文件上、撞那一刻它尖在哪。
 *
 * 为什么必须由 merge 循环**当场回传**、而不是让调用方事后自己查——三样里有两样
 * 事后**查不到**：
 * - ① 未合并路径在 `merge --abort` 之后就从工作区/索引里消失了（票 9 载荷①）；
 * - ② 「是哪一条来源撞的」只活在循环变量里：冲突那条**`merged` / `skipped` 两个
 *   数组都不进**，调用方拿返回值根本推不出来。
 * 让调用方自行推演 = 又造一处平行真相源（同一个事实两个算法，迟早分歧）。
 */
export interface ConflictDetail {
  /** 冲突来源分支短名（`session/<sid8>-<猫名>`） */
  source: string
  /** 冲突那一刻来源分支的尖（abort **之前**取的，与去重键同源） */
  sourceSha: string
  /** 未合并文件清单（`--diff-filter=U`，已排序；abort 前取自工作区） */
  files: string[]
}

/** fan-in 结果。`merged` / `skipped` 均为**分支短名**（`session/<sid8>-<cat8>`） */
export interface FanInResult {
  /** 本次真合进去的猫分支短名（按合入顺序） */
  merged: string[]
  /** 已合过 ⇒ 跳过（幂等） */
  skipped: string[]
  /** 撞上冲突 */
  conflict: boolean
  /** 冲突后是否已 abort 回可重跑态 */
  recovered: boolean
  /** 冲突现场——冲突返投（票 9）的载荷来源；非冲突态为 `undefined` */
  conflictDetail?: ConflictDetail
}

/** 跑一条 git 命令（统一剥 GIT_DIR 等注入变量）；失败抛错，由调用方决定语义 */
function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: cleanGitEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

/** 跑一条 git 命令，失败返回 null（存在性探测专用） */
function tryGit(cwd: string, args: string[]): string | null {
  try {
    return runGit(cwd, args)
  } catch {
    return null
  }
}

/**
 * 未合并路径清单（**只在半合并态下有输出**）。
 *
 * 判据取 `--diff-filter=U`（= "unmerged" 这个**聚合类**），不按冲突码枚举——
 * 与 S3-2 同一条教训：`UU` / `AA` 可在同一次 merge 内并存，逐个枚举必漏。
 * 这里 `U` 不是"某一个码"，而是 git 给出的全部未合并状态的合集。
 *
 * 读不到（非仓库 / git 失败）返回 `[]`：调用方（冲突返投）据此在载荷里写明
 * 「未能取得文件清单」而不是编一个空清单充数。排序只为确定性输出。
 */
function unmergedFiles(cwd: string): string[] {
  const out = tryGit(cwd, ['diff', '--name-only', '--diff-filter=U'])
  if (out === null) return []
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .sort()
}

/**
 * 枚举某会话的猫分支（返回分支短名，**已排序**）。
 *
 * 前缀必须写成 `refs/heads/session/<shortId>-*`——**通配符 `*` 不可省**。
 * git 对不含通配符的 pattern 按 `/` 边界匹配：裸前缀 `refs/heads/session/<sid8>-`
 * 只命中精确同名那一条，`-catA`/`-catB` **一条都收不到**（S3-1，阻断级）。
 * 失败形态全链静默——枚举 0 条 → 循环 0 次 → 零报错，而猫的提交确实存在。
 *
 * 空集（无猫提交过）返回 `[]`，**不抛错**：这是合法状态。
 * 排序是为了确定性——「顺序不定 ⇒ 合并结果不定」。
 */
export function listCatBranches(shortId: string, opts?: { cwd?: string }): string[] {
  const cwd = opts?.cwd ?? process.cwd()
  const prefix = `${sessionBranch(shortId)}-`
  const out = runGit(cwd, ['for-each-ref', '--format=%(refname)', `refs/heads/${prefix}*`])
  return (
    out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((ref) => (ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref))
      // S3-5：`*` 可匹配空串 ⇒ 分支 `session/<sid8>-`（cat8 为空）会被命中，过滤掉
      .filter((name) => name.length > prefix.length)
      .sort()
  )
}

/**
 * 半合并态探测：`MERGE_HEAD` 是否存在。
 *
 * **判据取 `MERGE_HEAD`，不按冲突码枚举**（S3-2）：分叉点上不存在的文件被双方
 * 各自新增 ⇒ `AA`；已存在文件被两边改 ⇒ `UU`；两者**可在同一次 merge 内并存**
 * （Phase S C4 实测 `AA both.txt | UU shared.txt`）⇒ 只查 `UU` 会漏判。
 * 判据非恒真：非冲突态 `rev-parse --verify --quiet MERGE_HEAD` 退出码非 0。
 */
export function hasMergeInProgress(opts?: { cwd?: string }): boolean {
  const cwd = opts?.cwd ?? process.cwd()
  return tryGit(cwd, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']) !== null
}

/** 幂等判据：ancestor 是否已是 descendant 的祖先（原语仓里已有，本模块 `mergeBranchesInto` 的跳过判据在用） */
export function isAncestor(ancestor: string, descendant: string, opts?: { cwd?: string }): boolean {
  const cwd = opts?.cwd ?? process.cwd()
  try {
    runGit(cwd, ['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch {
    return false
  }
}

/**
 * 前置①（**两个入口共用**）：半合并态 ⇒ 立即返回 `{conflict:true}`，**绝不在
 * `MERGE_HEAD` 上继续合并**。E4 实测此时重跑 merge 报 `Merging is not possible
 * because you have unmerged files`，继续跑只会在坏态上叠加。交上层仲裁，不自行 abort。
 *
 * 为什么抽成共用：收口 fan-in 与审查面合并**都在写分支 ref**，一边挡一边不挡等于没挡。
 * `label` 只进日志，让两条路径的成因在日志里分得开（判据相同、**该去查谁**不同）。
 */
function refuseIfMergeInProgress(shortId: string, cwd: string, label: string): FanInResult | null {
  if (!hasMergeInProgress({ cwd })) return null
  log.error('merge refused — merge in progress (半合并态)', { shortId, cwd, label })
  return { merged: [], skipped: [], conflict: true, recovered: false }
}

/**
 * merge 循环核心（**全仓唯一一份**）：把 `sources` 逐条 `--no-ff` 合进 `target`。
 *
 * 抽出来是因为两个入口的**目标分支不同**、而循环必须同源：
 * - `fanInCatBranches` → target = **集成分支**（收口链，ADR §6.3 方案 a）
 * - `mergeCatBranchesIntoOwnBranch` → target = **审查者自己的猫分支**（形态 G）
 * 复制第二份的代价：`git-utils.ts` 头注已点过「复制必然漂移」——这里漂移的后果是
 * 两条路径的幂等 / 冲突语义悄悄分家，而两者都在写分支 ref。
 *
 * **`target` 的正确性由调用方的前置②保证**，本函数不判「该是哪条分支」——那条判据
 * 逐入口不同（收口须是集成分支，审查面须是猫分支）。
 */
function mergeBranchesInto(
  target: string,
  sources: string[],
  cwd: string,
  label: string
): FanInResult {
  const merged: string[] = []
  const skipped: string[] = []

  for (const src of sources) {
    // 幂等双保险：已合即跳过。E3 证明 no-ff 自身已幂等（重跑 `Already up to date`，
    // 不造新 merge commit），这层挡住的是「中断重跑时重复走 merge 路径」。
    if (isAncestor(src, target, { cwd })) {
      skipped.push(src)
      continue
    }
    try {
      runGit(cwd, ['merge', '--no-ff', '-m', `${label} ${src}`, src])
      merged.push(src)
    } catch (err: any) {
      // 冲突现场**必须在 abort 之前取**：abort 把工作区/索引回滚到合并前，未合并
      // 路径随之消失——事后再问「撞在哪些文件上」已无答案（票 9 载荷①）。
      // sourceSha 同理取在此刻，让去重键「源分支@源分支尖 sha」钉的是**撞的那一下**。
      const detail: ConflictDetail = {
        source: src,
        sourceSha: tryGit(cwd, ['rev-parse', src]) ?? '',
        files: unmergedFiles(cwd),
      }
      // abort 回可重跑态。abort 失败 ⇒ recovered=false（仓库可能仍是半合并态，
      // 上层须以此为准，别假定「失败即已恢复」）。
      let recovered = false
      try {
        runGit(cwd, ['merge', '--abort'])
        recovered = !hasMergeInProgress({ cwd })
      } catch {
        recovered = false
      }
      log.error('merge conflict', {
        target,
        src,
        label,
        recovered,
        files: detail.files,
        error: messageOf(err),
      })
      return { merged, skipped, conflict: true, recovered, conflictDetail: detail }
    }
  }

  return { merged, skipped, conflict: false, recovered: false }
}

/**
 * fan-in 主入口：把该会话全部猫分支按序 `--no-ff` 合进**集成分支**。
 *
 * **`cwd` 必填（刻意破例，不是洁癖）**：仓内既有惯例是 `opts?: { cwd?: string }`
 * （`gitCommit` 等），但这里若给默认值 `process.cwd()`，它指向的正是**最危险的
 * 那个落点**——把 N 条猫分支 no-ff 合进 dev 主工作区（ADR §6.3 判死的方案 b，
 * 冲突落主工作区 ⇒ 全仓阻塞）。设成必填，让编译器挡住「忘记传参」这条路径。
 *
 * 前置断言（缺一即显式失败，**不静默**）：
 * 1. 半合并态 ⇒ 立即返回 `{conflict:true}`，**绝不在 MERGE_HEAD 上继续合并**
 * 2. cwd 的 HEAD 必须是 `session/<shortId>` ⇒ 否则抛错中止
 * 3. 空集 ⇒ 返回全空结果（合法状态，但调用方须能与「枚举写错收 0 条」区分——
 *    这正是 S3-1 的教训：两者返回值相同，唯一的分辨手段是枚举本身写对 + 测试反向对照）
 *
 * **本函数是薄 wrapper**（T-2 Phase I-b 裁定 §4）：签名与前置②**原样保留** ——
 * 前置②挡的是「把 N 条猫分支合进 dev 主工作区」这条灾难路径，**不得为复用而放宽**。
 * merge 循环在 `mergeBranchesInto`（全仓唯一一份）。
 */
export function fanInCatBranches(shortId: string, cwd: string): FanInResult {
  const refused = refuseIfMergeInProgress(shortId, cwd, 'fan-in')
  if (refused) return refused

  // 前置②：cwd 必须是集成分支——否则就是灾难路径（合进 dev）。显式报错，不静默。
  const expected = sessionBranch(shortId)
  const head = tryGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (head !== expected) {
    throw new Error(
      `fan-in cwd 不在集成分支上：期望 ${expected}，实际 ${head ?? '(detached HEAD)'}（cwd=${cwd}）`
    )
  }

  return mergeBranchesInto(expected, listCatBranches(shortId, { cwd }), cwd, 'fan-in')
}

/**
 * **审查面合并**（T-2 Phase I-b 形态 G，票面 §八）：把本会话**全部猫分支**合进
 * 审查者**自己那条猫分支**，使它执行时读到的是**被审内容**。
 *
 * 要治的形态（第 1 笔实测，`report-phase-ib.md` §三 V16-b）：猫分支自集成分支 fork，
 * fan-in 前集成分支**不含**实施猫的提交；审查者的树同样自集成分支 fork ⇒
 * **文件在、路径对、内容是旧版**，且**读不出是旧的**（工作区那条路读到的*一定*是旧版）。
 *
 * 三条边界（票面 §八 契约 1 / 2 / 5）：
 * - **目标只可能是 `cwd` 当前所在的那条猫分支**（前置②显式校验）：集成分支与 `dev`
 *   在本函数内**没有任何写入路径**，V21「零分支移动」因此是结构性的而非靠约定。
 * - **来源 = `listCatBranches(shortId, { cwd: mainRoot })`**，`mainRoot` **必填**：
 *   猫树里 `process.cwd()` 是猫树本身，就地枚举会**静默收 0 条**（S3-1 同形，裁定 §5）。
 * - 幂等（V22）/ 冲突 ⇒ abort 回可重跑态（V20）：语义与 `fanInCatBranches` **同源**
 *   （同一个 `mergeBranchesInto`），不是"差不多的另一份"。
 */
export function mergeCatBranchesIntoOwnBranch(
  shortId: string,
  opts: { cwd: string; mainRoot: string }
): FanInResult {
  const { cwd, mainRoot } = opts

  const refused = refuseIfMergeInProgress(shortId, cwd, 'review-view')
  if (refused) return refused

  // 前置②：cwd 的 HEAD 必须是**本会话的猫分支**。一条判据挡两头：
  //  - 集成分支 `session/<sid8>` —— 它**不以 `-` 结尾**，故天然不匹配本前缀；
  //  - 任何别的分支（`dev` / 手工 checkout 的任意 ref）。
  // `head.length > prefix.length` 复用 `listCatBranches` 的 S3-5 过滤：`*` 可匹配空串，
  // 裸前缀那条**空后缀**分支不该被当成猫分支（它是 `catSlug` 抛错才没被生产出来的形态）。
  const prefix = `${sessionBranch(shortId)}-`
  const head = tryGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (!head || !head.startsWith(prefix) || head.length <= prefix.length) {
    throw new Error(
      `审查面合并的目标不是本会话的猫分支：期望 ${prefix}<猫名>，实际 ${head ?? '(detached HEAD)'}（cwd=${cwd}）`
    )
  }

  return mergeBranchesInto(head, listCatBranches(shortId, { cwd: mainRoot }), cwd, 'review-view')
}

// ─── 冲突返投（票 9）：撞冲突 ⇒ 带解法回家，别让人轮询撞墙 ─────────────

/** 冲突返投载荷（票 9 契约的**四样**，缺一即返修单不完整）。 */
export interface ConflictNoticeInput {
  /** 收件猫名（行首 `@` 与 `mentions` 同源） */
  catName: string
  /** ② 对撞两侧 · 审查侧——merge 的**目标**（审查者自己的猫分支） */
  targetBranch: string
  targetSha: string
  /** ② 对撞两侧 · 源侧——merge 的**来源**（实施猫自己的分支） */
  sourceBranch: string
  sourceSha: string
  /** ① 冲突文件清单（abort **之前**取的未合并路径） */
  conflictFiles: string[]
  /** 链锚 = `triggerMsg.taskId || traceId`（与执行内各处**逐字同源**） */
  chainAnchor: string
}

/** 载荷③：解法指令——**固定模板**，不随冲突内容变形（票 9 契约原文五步）。 */
const CONFLICT_FIX_STEPS = [
  '1) 在你自己的 worktree 里：git merge <审查分支>',
  '2) 解冲突（保留双方语义，别整段覆盖）',
  '3) 跑测试（node node_modules/vitest/vitest.mjs run）+ lint',
  '4) 提交（带 catstudy [uuid] 标记）',
  '5) 重新 request-review（链锚沿用本单给出的锚）',
] as const

/** 载荷④：验收条件——**预合并干净即放行**，无需回报（票 9 契约原文）。 */
const CONFLICT_ACCEPTANCE =
  'prep 能把你的分支干净合进审查分支 ⇒ 自动放行，无需回报；解不了 / 判定是设计冲突 ⇒ 升级店长仲裁（冲突仲裁归店长）。'

/**
 * 渲染返修单正文（**纯函数**，四样载荷逐样落在固定位置）。
 *
 * 抽成纯函数是为了让「四样都在」可被**逐样断言**——只断言「有消息」会把
 * 「投出去一条空壳」放过去，那正是本票要治的「状态变了但没人知道该干嘛」。
 */
export function buildConflictNotice(input: ConflictNoticeInput): string {
  const short = (sha: string): string => (sha ? sha.slice(0, 7) : '(未知)')
  // 文件清单为空有两种成因：真无未合并路径（理论不可达——没冲突就不会走到这）
  // 与「git 读不到」。**不写空清单冒充**：明写「未能取得」让读的人知道要自己查。
  const fileLines =
    input.conflictFiles.length > 0
      ? input.conflictFiles.map((f) => `- ${f}`)
      : ['- (未能取得文件清单——git 读取失败，请在自己分支上重跑 merge 自查)']

  return [
    `@${input.catName} 【冲突返投】审查准备（prep）在把你的分支合进审查分支时撞冲突，`,
    `本轮审查已中止（审查者未开跑）。需要你先与审查分支对齐，再重投审查。`,
    '',
    `① 冲突文件（${input.conflictFiles.length} 个）：`,
    ...fileLines,
    '',
    `② 对撞两侧：`,
    `- 你的分支：${input.sourceBranch} @ ${short(input.sourceSha)}`,
    `- 审查分支：${input.targetBranch} @ ${short(input.targetSha)}`,
    '',
    `③ 解法：`,
    ...CONFLICT_FIX_STEPS.map((s) => s.replace('<审查分支>', input.targetBranch)),
    '',
    `④ 验收条件：${CONFLICT_ACCEPTANCE}`,
    '',
    `（链锚：${input.chainAnchor}）`,
  ].join('\n')
}

/**
 * 去重闸：同一「源分支@源分支尖 sha」只投一次，源分支推进出新 sha 后再撞才再投
 * （防投递风暴）。
 *
 * 存放位置选**内存态**（票面允许）。按「状态落盘键控」两问自答：
 * ① **共享还是隔离**：投递发生在**本进程内的一次调用**里，不存在"全仓只有一棵树"
 *    那种事实，谈不上共享根键控；
 * ② **允不允许依赖常驻进程活着**：允许——丢状态的最坏后果是**多投一次**（方向安全）。
 *    关键判据：本闸**不是门禁**。门禁（push-gate 那类）进程死了会退化成**静默放行**，
 *    故必须落文件；本闸进程死了只会退化成**重复提醒**，多一条消息而已。
 * ⇒ 不落文件、不进 DB（进 DB 要配迁移 + 新表，为一个"最多多投一次"的节流不值）。
 */
const notifiedConflicts = new Set<string>()

/** 去重键 = 源分支名 + 源分支尖 sha（票 9 契约原文口径） */
function conflictNoticeKey(sourceBranch: string, sourceSha: string): string {
  return `${sourceBranch}@${sourceSha}`
}

/**
 * 分支后缀（= `catSlug(猫名)`）→ 会话成员猫名**列表**（调用方判歧义）。
 *
 * 逆推走 **`catSlug` 正着算**（对每个成员算一遍再比），**不做字符串反解析**：
 * 清洗是多字符→少字符的映射，反解析必然有歧义——`甲 猫` 与 `甲猫` 会被归一到
 * 同一个 slug（`serial.cat-worktree.test.ts` P3-c-2 就是这个碰撞的实证）。
 * 正算保证「谁建的这条分支」与「谁是收件人」用的是**同一个函数**。
 *
 * **返回列表而非首个匹配**：碰撞（两只会话成员归一到同一 slug）时分支只属于其中
 * 一只，而列表顺序来自 `agent_ids`、**与「谁建的树」无关** ⇒ 取首个 = 可能投给
 * 另一只猫。让调用方看见「命中几只」才判得了「是不是真知道收件人是谁」。
 *
 * 已知残余（见交付说明 OQ-3）：分支的**地面真相**是所有权标记
 * `branch.<分支名>.catAgentId`（`git-utils.ts` 的 `readCatOwner`，P3-c-2 的对应解）。
 * 这里没用它，是因为它未被导出——取用要改 `git-utils.ts`，而本票声明的改动面只有
 * 本文件；在**只差一个导出**的前提下，宁可先按「碰撞即拒投」保守处理。
 *
 * 单个成员名非法（含 `/` / 清洗后为空）⇒ `catSlug` 抛错：这类猫**建不出分支**，
 * 故不可能是冲突源——跳过它，不中断整个解析。
 */
function resolveCatNamesBySlug(sessionId: string, slug: string): string[] {
  const hits: string[] = []
  for (const id of sessionsRepo.getSessionAgentIds(sessionId)) {
    const row = agentsRepo.getAgentById(id)
    if (!row) continue
    let s: string
    try {
      s = catSlug(row.name)
    } catch {
      continue
    }
    if (s === slug) hits.push(row.name)
  }
  return hits
}

/**
 * 冲突返投**第一响应**（票 9）：把返修单投给冲突源分支所属的实施猫。
 *
 * 三条纪律：
 * - **不改 fail-closed**：本函数只投递，**任何**失败都只留痕，调用方紧接着照常
 *   `throw` —— 审查者仍然不开跑（票面「throw 语义保留」）。
 * - **不静默**：拿不到收件人 / 拿不到目标分支 / ingest 拒收 / 投递链抛错，四条
 *   路径**各自**留 `log.error`。用 error 而非 warn 是有意的：「没人被通知」正是
 *   墙 #3 的成因，它在日志里必须是显眼的，不能淹在 info 流里。
 * - **不阻塞**：`ingestUserMessage` 是 async 契约，而 `ensureExecutionWorktree`
 *   是同步函数（调用它的 `runAgentReply` 在对象字面量里直接取值）——故
 *   fire-and-forget。**但不 await ≠ 不看结果**：resolve 值照查（`ok:false` 是
 *   ingest 的正常返回，不是异常，只有 `.catch` 会漏掉它）。
 *
 * 仲裁例外不动：返投是**第一响应**，解不了 / 解错仍升级店长（票面原文）。
 */
function notifyConflictSource(opts: {
  sessionId: string
  shortId: string
  /** 审查者 worktree（merge 的 cwd）——目标分支名/sha 的地面真相来源 */
  cwd: string
  chainAnchor: string
  detail: ConflictDetail
}): void {
  try {
    const { sessionId, shortId, cwd, chainAnchor, detail } = opts

    const key = conflictNoticeKey(detail.source, detail.sourceSha)
    if (notifiedConflicts.has(key)) {
      log.info('conflict notice skipped — 同键已投过', {
        source: detail.source,
        sourceSha: detail.sourceSha,
      })
      return
    }

    const prefix = `${sessionBranch(shortId)}-`
    const slug = detail.source.startsWith(prefix) ? detail.source.slice(prefix.length) : ''
    const hits = slug ? resolveCatNamesBySlug(sessionId, slug) : []

    // **不投比投错好**。两条拒绝路径分开记，因为成因与后续动作不同：
    // - 多命中（碰撞）：分支确实属于某一只，但这里**判不出是哪只**（列表顺序来自
    //   `agent_ids`，与「谁建的树」无关）⇒ 宁可不投，也不叫醒无关的猫去改别人的分支。
    // - 零命中：猫被移出会话 / 分支名不带本会话前缀 / 陈旧分支。
    if (hits.length > 1) {
      log.error(
        'conflict notice skipped — 分支后缀对应多只会话成员（catSlug 碰撞，判不出收件人）',
        {
          sessionId,
          source: detail.source,
          slug,
          hits,
        }
      )
      return
    }
    const catName = hits[0]
    if (!catName) {
      log.error('conflict notice skipped — 源分支无对应会话成员', {
        sessionId,
        source: detail.source,
        slug,
      })
      return
    }

    // 目标分支取自 cwd 的 HEAD，**不按命名规则重推**：abort 之后 HEAD 已回到审查
    // 分支尖，这是「刚才到底往哪条分支上合」的唯一地面真相（重推 = 平行真相源）。
    const targetBranch = tryGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']) ?? ''
    if (!targetBranch) {
      log.error('conflict notice skipped — 审查分支名不可得（detached HEAD？）', { cwd })
      return
    }
    const targetSha = tryGit(cwd, ['rev-parse', 'HEAD']) ?? ''

    const content = buildConflictNotice({
      catName,
      targetBranch,
      targetSha,
      sourceBranch: detail.source,
      sourceSha: detail.sourceSha,
      conflictFiles: detail.files,
      chainAnchor,
    })

    // **先记账再投**：第二次同键冲突在投出之前就被挡住（「同键只投一次」是字面
    // 要求）。代价如实记账——投递真失败时同键不再重试，见交付说明 OQ-1。
    notifiedConflicts.add(key)

    ingestUserMessage({
      sessionId,
      content,
      mentions: [catName],
      taskId: chainAnchor,
      // 服务端发起的 agent 入口：入口主闸要求携带锚（上面 taskId 已给）。
      // 收件人是实施猫 ⇒ isReviewDelivery 为假 ⇒ 不需要 chainType。
      origin: 'agent',
    })
      .then((result) => {
        if (result.ok) {
          log.info('conflict notice delivered', {
            sessionId,
            target: catName,
            source: detail.source,
            messageId: result.messageId,
          })
        } else {
          log.error('conflict notice rejected by ingest', {
            sessionId,
            target: catName,
            source: detail.source,
            status: result.status,
            error: result.error,
          })
        }
      })
      .catch((err: any) => {
        log.error('conflict notice delivery failed', {
          sessionId,
          target: catName,
          source: detail.source,
          error: messageOf(err),
        })
      })
  } catch (err: any) {
    // 兜底：投递链的**同步**异常（DB 句柄坏 / 会话查询抛错）。它若逃逸会**替换掉**
    // 上层那条「审查面准备中止」错误——日志从此指向错误的方向，而真正的冲突现场
    // 反而没了。故就地吞下 + 留痕。
    log.error('conflict notice crashed (non-blocking)', { error: messageOf(err) })
  }
}

/**
 * **执行起点**的 cwd 解析（单源）：建/取该 agent 的目标树；审查者额外把本会话全部
 * 猫分支合进**它自己的猫分支**（形态 G）。
 *
 * 为什么合并只在这里、**不塞进 `ensureAgentWorktree`**：后者另有一个调用点
 * `serial.ts` 的 `resolveCommitTargets`（提交 / 清理目标）。那里树**已经是脏的**
 * （本猫刚改过），在其上跑 merge 会撞 `Your local changes would be overwritten`，
 * 把一条正常的收尾路径变成冲突路径；且提交期再合一遍他猫分支对「本轮干完了什么」
 * 毫无意义。⇒ 合并发生在**执行起点**，提交期复用同一棵树（此时它已含被审内容）。
 *
 * **冲突 ⇒ 显式抛错**（票面 §二-3「不静默」+ §八 契约 4）：抛在这里 = 适配器
 * `chatStream` **不会被调用** ⇒ 审查者**不带着缺内容的工作区开跑**，也不会产出一份
 * 「头头是道但审的是旧版」的回执。代价是这一轮审查没有回执（fail-closed 换可用性，
 * 方向与票面 §二-1「纪律会失守，结构不会」一致）。
 *
 * **票 9 补的那一步**：抛错**之前**先 `notifyConflictSource` 把返修单投回实施猫。
 * 原形态「只 throw、不通知」正是墙 #3 定时器重试死循环的成因——审查者静默死掉、
 * 实施者不知道要动，谁也没变，于是重试永远撞同一堵墙。投递与抛错**互不绑定**：
 * 投递怎么失败都不改 fail-closed（见 `notifyConflictSource` 的纪律段）。
 */
export function ensureExecutionWorktree(
  sessionId: string,
  agent: { id: string; name: string; role?: string },
  /**
   * **链锚**（票 9 返修消息的投递锚）= `triggerMsg.taskId || traceId`——与执行内
   * 各处链锚表达式**逐字同源**（`execution/reply.ts` / `execution/serial.ts` 的同名表达式）。
   *
   * 为什么**必填**而不是可选：返修单经 `ingestUserMessage` 投递，而入口主闸
   * （`origin: 'agent'`）硬性要求携带锚——可选参数在"忘了传"时会退化成
   * 「闸门拒收 + 一条日志」，即**这个票要治的静默失效换了个地方复发**。必填 ⇒
   * 忘传是 `tsc` 编译错误（与 spec D15「忘标变编译错误」同一条判据）。
   *
   * 非审查者路径不消费它（不合并 ⇒ 无冲突 ⇒ 无返投），但签名统一——调用点只有
   * `reply.ts` 一处，多传一个已有的局部量，换调用点形状的单一。
   */
  chainAnchor: string
): string | null {
  const path = ensureAgentWorktree(sessionId, agent)
  if (!path) return null
  // 契约 5「只对审查者生效」：非审查者的树**不进**他猫提交——灌进去等于把刚建立的
  // 隔离拆掉。判据取 `role` 而非投递信号（裁定 §2：投递级判据对审查者执行恒真）。
  if (agent.role !== 'reviewer') return path

  const shortId = sessionShortId(sessionId)
  const mainRoot = getMainRepoRoot()
  if (!shortId || !mainRoot) {
    throw new Error(
      `审查面准备中止：会话 shortId / 主仓库根不可得（sessionId=${sessionId}, shortId=${shortId ?? '(空)'}, mainRoot=${mainRoot ?? '(空)'}）`
    )
  }

  const r = mergeCatBranchesIntoOwnBranch(shortId, { cwd: path, mainRoot })
  if (r.conflict) {
    // 返投第一响应（票 9）。**放在 throw 之前**：投递链自身是 fire-and-forget 的
    // 同步段 + 微任务，这里不 await——但 ingest 的落库在同步段内完成，故下面这条
    // throw 到达上层时，返修单已经在 DB 里了（顺序可观测，见组装式测试）。
    if (r.conflictDetail) {
      notifyConflictSource({
        sessionId,
        shortId,
        cwd: path,
        chainAnchor,
        detail: r.conflictDetail,
      })
    }
    throw new Error(
      `审查面准备中止：把猫分支合进审查者自己的分支时冲突（recovered=${r.recovered}）——` +
        `审查者不带着缺内容的工作区开跑；冲突仲裁归店长`
    )
  }
  log.info('review view prepared', {
    sessionId,
    agentId: agent.id,
    merged: r.merged.length,
    skipped: r.skipped.length,
  })
  return path
}

/**
 * `git worktree list --porcelain` → 分支短名 → worktree 绝对路径。
 *
 * 用 git 自己的账本做映射，**不做字符串推导**（`session/<sid8>-<cat8>` 反推目录名
 * 在命名规则变动时会静默指错路径——而下游是删除操作）。
 * detached worktree 只有 `detached` 行、无 `branch` 行 ⇒ 天然不进映射，不会误删。
 */
function worktreeMap(cwd: string): Map<string, string> {
  const out = runGit(cwd, ['worktree', 'list', '--porcelain'])
  const map = new Map<string, string>()
  let path = ''
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      path = resolve(line.slice('worktree '.length).trim())
    } else if (line.startsWith('branch ') && path) {
      const ref = line.slice('branch '.length).trim()
      map.set(ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref, path)
    }
  }
  return map
}

/**
 * 回收**已合入**集成分支的猫 worktree + 猫分支，返回被回收的分支短名。
 *
 * 两条硬前提（ADR §6.4-4）：
 * 1. **只回收已合的**（判据 = `isAncestor(cat, integrationRef)`）——**未合分支绝不
 *    回收**，否则删掉未合的活。判据向保守偏：集成分支尚未 ff 进 dev 时按
 *    `integrationRef` 判，不会误删。
 * 2. **自指守卫**：不得清理当前进程 cwd 所在的 worktree（既有机制先例
 *    `git-utils.ts` 的 `isPathInside(wtPath, resolve(process.cwd()))`——收口者正站在被
 *    回收的 worktree 里时，物理删除会删掉当前进程正站着的目录树，Windows cwd
 *    句柄无 FILE_SHARE_DELETE，删后进程不抛错但一切 IO 悬空）。
 *
 * 顺序：**先摘 worktree 再删分支**——分支被 worktree 占用时删不掉（Phase S D2）。
 */
export function reclaimCatBranches(
  shortId: string,
  integrationRef: string,
  opts?: { cwd?: string }
): string[] {
  const cwd = opts?.cwd ?? process.cwd()
  const reclaimed: string[] = []
  const wtByBranch = worktreeMap(cwd)

  for (const cat of listCatBranches(shortId, { cwd })) {
    if (!isAncestor(cat, integrationRef, { cwd })) {
      log.warn('cat branch not merged into integration — kept', { branch: cat, integrationRef })
      continue
    }

    const wtPath = wtByBranch.get(cat)
    if (wtPath) {
      try {
        runGit(cwd, ['worktree', 'remove', '--force', wtPath])
      } catch (err: any) {
        log.warn('cat worktree remove failed — force cleaning dir', {
          branch: cat,
          wtPath,
          error: messageOf(err),
        })
      }
      // 自指守卫：cwd 在该 worktree 内 → 跳过物理残留清理（残留交给进程退出后的
      // 收口兜底）；否则链接先行安全清理（git 只删跟踪内容，node_modules 链接残留）
      if (isPathInside(wtPath, resolve(process.cwd()))) {
        log.warn('skip cat residue cleanup — cwd inside cat worktree', { branch: cat, wtPath })
      } else {
        cleanupWorktreeResidue(wtPath)
      }
    }

    try {
      runGit(cwd, ['branch', '-D', cat])
      reclaimed.push(cat)
    } catch (err: any) {
      log.warn('cat branch delete failed — kept', { branch: cat, error: messageOf(err) })
    }
  }

  return reclaimed
}
