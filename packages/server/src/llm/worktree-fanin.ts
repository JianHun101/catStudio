/**
 * 猫分支 fan-in —— 把某会话的全部猫分支按序合进它的**集成分支**。
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
 * **本模块零调用点**（Phase I 接线）：生产行为一行未变。
 */

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { createLogger } from '../logger.js'
import { cleanGitEnv, cleanupWorktreeResidue, isPathInside, sessionBranch } from './git-utils.js'

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
 * fan-in 主入口：把该会话全部猫分支按序 `--no-ff` 合进集成分支。
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
 */
export function fanInCatBranches(shortId: string, cwd: string): FanInResult {
  // 前置①：半合并态——E4 实测此时重跑 merge 报 `Merging is not possible because
  // you have unmerged files`；继续跑只会在坏态上叠加。交上层仲裁，不自行 abort。
  if (hasMergeInProgress({ cwd })) {
    log.error('fan-in refused — merge in progress (半合并态)', { shortId, cwd })
    return { merged: [], skipped: [], conflict: true, recovered: false }
  }

  // 前置②：cwd 必须是集成分支——否则就是灾难路径（合进 dev）。显式报错，不静默。
  const expected = sessionBranch(shortId)
  const head = tryGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (head !== expected) {
    throw new Error(
      `fan-in cwd 不在集成分支上：期望 ${expected}，实际 ${head ?? '(detached HEAD)'}（cwd=${cwd}）`
    )
  }

  const merged: string[] = []
  const skipped: string[] = []

  for (const cat of listCatBranches(shortId, { cwd })) {
    // 幂等双保险：已合即跳过。E3 证明 no-ff 自身已幂等（重跑 `Already up to date`，
    // 不造新 merge commit），这层挡住的是「中断重跑时重复走 merge 路径」。
    if (isAncestor(cat, expected, { cwd })) {
      skipped.push(cat)
      continue
    }
    try {
      runGit(cwd, ['merge', '--no-ff', '-m', `fan-in ${cat}`, cat])
      merged.push(cat)
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
      log.error('fan-in conflict', { shortId, cat, recovered, error: err.message })
      return { merged, skipped, conflict: true, recovered }
    }
  }

  return { merged, skipped, conflict: false, recovered: false }
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
