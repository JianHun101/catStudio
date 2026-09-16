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
 * （`session-closeout.ts:102`）。会话分支停在分叉点时 `merge --ff-only` 输出
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
 */

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { createLogger } from '../logger.js'
import {
  cleanGitEnv,
  cleanupWorktreeResidue,
  ensureAgentWorktree,
  getMainRepoRoot,
  isPathInside,
  sessionBranch,
  sessionShortId,
} from './git-utils.js'

const log = createLogger('worktree-fanin')

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

/** 幂等判据：ancestor 是否已是 descendant 的祖先（原语仓里已有，`session-closeout.ts:209` 在用） */
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
      // 冲突：abort 回可重跑态。abort 失败 ⇒ recovered=false（仓库可能仍是半合并态，
      // 上层须以此为准，别假定「失败即已恢复」）。
      let recovered = false
      try {
        runGit(cwd, ['merge', '--abort'])
        recovered = !hasMergeInProgress({ cwd })
      } catch {
        recovered = false
      }
      log.error('merge conflict', { target, src, label, recovered, error: err.message })
      return { merged, skipped, conflict: true, recovered }
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
 */
export function ensureExecutionWorktree(
  sessionId: string,
  agent: { id: string; name: string; role?: string }
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
 *    `git-utils.ts:587` `isPathInside(wtPath, process.cwd())`——收口者正站在被
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
          error: err.message,
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
      log.warn('cat branch delete failed — kept', { branch: cat, error: err.message })
    }
  }

  return reclaimed
}
