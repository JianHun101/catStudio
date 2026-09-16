/**
 * 会话收口器——店长一键收口（治「删 worktree 拆自己脚下」的坑）。
 *
 * 背景（店长 2026-08-20 实锤）：收口链路曾是店长手工敲裸命令
 * （merge → worktree remove → 删分支 → 写 gate → checkout），裸命令组合
 * 容易拆错顺序、且收口自己会话时 process.cwd() 正落在被收口的 worktree 内
 * ——物理残留清理会删掉当前进程正站着的目录树（Windows cwd 句柄无
 * FILE_SHARE_DELETE，删后进程不抛错但一切 IO 悬空 → 僵尸进程占 slot）。
 * 收口器把「顺序 + cwd 安全」收敛进一个函数，店长只调 closeoutSession。
 *
 * 设计：
 * - 6 个 @internal step（fanInCats / mergeSession / removeWorktree / reclaimCats /
 *   writeGate / checkoutDev）仅供测试直调断言每步语义；店长禁止乱序调——收口只走
 *   closeoutSession（串联全部 step，任一步失败即停，step 字段指出错处）。
 *   前两者与后两者（T-2 Phase I）分别管「猫分支 → 集成分支」与「集成分支落地后
 *   回收猫树」——**必须与 CLI cwd 的逐猫分派同批存在**，否则猫的提交会被静默
 *   连同分支一起删掉（E5）。
 * - 硬约束：每步 git 命令 cwd 固定 mainRoot（主仓库根，绝不依赖 process.cwd()
 *   作为 git 工作目录）。mainRoot 在 preflight 从 git-common-dir 探测**一次**后
 *   显式传给全部 step——自指场景（收口者 cwd 在被收口 worktree 内）下
 *   `git worktree remove` 可能半删 worktree 的 .git 指针，此时再从 cwd 重新探测
 *   mainRoot 必然失败（checkoutDev/gate 全断）；传参后 mainRoot 与 cwd 解耦，
 *   process.cwd() 只在 preflight 参与一次探测。
 * - 幂等 check-then-act：中断重跑 = 续跑，从 git 现状推导已完成的步——
 *   分支不存在 → merge 跳过；worktree 目录不存在 → remove 跳过；gate 值相同
 *   → 不重写；已在 dev → checkout no-op。
 * - preflight onDev 守卫：主仓库当前 checkout 非 dev（含 detached HEAD）→ 拒绝
 *   收口，防止 merge 把 session 提交合进错分支、随删分支不可逆丢失。
 * - push 不进收口器：收口器只做本地机械步骤（merge/删/写 gate/切分支），
 *   「本地↔共享」的 push 边界属用户决策，走 push 审批节点。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createLogger } from '../logger.js'
import { messageOf } from '../utils.js'
import {
  cleanGitEnv,
  ensureSessionWorktree,
  getMainRepoRoot,
  isPathInside,
  removeSessionWorktree,
  sessionBranch,
  sessionShortId,
  sessionWorktreePath,
} from './git-utils.js'
import {
  fanInCatBranches,
  hasMergeInProgress,
  listCatBranches,
  reclaimCatBranches,
} from './worktree-fanin.js'

const log = createLogger('session-closeout')

/** 收口失败时定位的步骤（ok:false 时 step 指出失败处；ok:true 时 step=最终完成的步） */
export type CloseoutStep =
  'preflight' | 'fanin' | 'merge' | 'worktree' | 'reclaim' | 'gate' | 'checkout'

/** closeoutSession 结果——ok:false 时 error 说明失败原因，step 定位失败步骤 */
export interface CloseoutResult {
  ok: boolean
  step: CloseoutStep
  error?: string
}

/** inspectCloseout 只读探针状态（先看后动；从 git 现状推导，绝不改任何东西） */
export interface CloseoutState {
  /** session/<8id> 分支是否存在 */
  branchExists: boolean
  /** 会话 worktree 目录是否存在 */
  worktreeExists: boolean
  /** 分支存在时：是否已是 dev 的祖先（ff-only 可合 / 已合并） */
  mergedIntoDev: boolean
  /** .push-gate 内容 === 主仓库当前 HEAD（门禁同步） */
  gateSynced: boolean
  /** 主仓库当前 checkout 分支 === dev */
  onDev: boolean
}

/** 每个 @internal step 的返回形状：null = 该步无需执行（幂等续跑） */
type StepResult = { ok: boolean; error?: string } | null

/** 跑一条 git 命令（cwd 固定 mainRoot，禁用 shell 注入面）；失败抛错由调用方捕获 */
function runGit(mainRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: mainRoot,
    env: cleanGitEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

/** 分支 ref 是否存在（rev-parse --verify 非零退出即不存在） */
function branchRefExists(mainRoot: string, branch: string): boolean {
  try {
    runGit(mainRoot, ['rev-parse', '--verify', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

/**
 * @internal step ⓪ 猫分支 fan-in —— 把该会话全部猫分支按序合进**集成分支**
 * （`session/<sid8>`），跑在 `mergeSession` 之前。
 *
 * **与接线必须同批**（票面 §结论-2 / D1）：只把 CLI cwd 分派到猫 worktree 而不接
 * fan-in，猫的提交就停在猫分支上，而本收口器仍只合 `session/<sid8>`——集成分支停在
 * 分叉点时 `merge --ff-only` 输出 `Already up to date.` 且**退出码 0**，收口照常删
 * worktree 与分支 ⇒ 猫的提交**永远没进过任何地方**（E5 静默丢活）。
 *
 * cwd = **会话 worktree**（`sessionWorktreePath(mainRoot, shortId)`）：它是**唯一**
 * checkout 了集成分支的地方，也是唯一能安全承载 fan-in 冲突的地方（ADR 0015 §6.3
 * 方案 a——主工作区被 preflight 钉死在 dev，冲突没别处可去）。目录不存在则先
 * `ensureSessionWorktree` 现建。
 *
 * 返回 `null` = 本步无需执行（**无猫分支**：存量会话 / 猫没提交过 / 中断重跑时已被
 * 回收）——空集是合法状态，不抛错。此判据同时避免「为一次空 fan-in 现建一棵会话
 * worktree」。
 *
 * 中止判据（票面 §二-3）：`MERGE_HEAD` 存在或 `FanInResult.conflict` ⇒ `ok:false`
 * ——**半合并态上绝不能继续 writeGate / checkoutDev**（会把仓库留在不可重跑态）。
 * `recovered` 只代表回到可重跑态，不代表冲突已解决；冲突仲裁归店长（ADR §5）。
 */
export function fanInCats(mainRoot: string, sessionId: string): StepResult {
  const shortId = sessionShortId(sessionId)
  if (!shortId) return null
  if (listCatBranches(shortId, { cwd: mainRoot }).length === 0) return null

  const wtPath = sessionWorktreePath(mainRoot, shortId)
  const cwd = existsSync(wtPath) ? wtPath : ensureSessionWorktree(sessionId)
  if (!cwd) {
    return { ok: false, error: 'fan-in 中止：会话 worktree 不可用（继续收口会丢猫分支的提交）' }
  }
  // 判据①（显式前置，且与判据②的**文案**必须分得开）：进 fan-in 之前就在半合并态 ⇒
  // 立即中止。它和「合并过程撞上冲突」的处置虽同（都停），**成因与残留状态不同**：
  // 这条什么都没动过（仓库是别人留下的半合并态），那条我们动过并尝试过 abort。
  // 混成一句话读者就分不出「该去查谁」——`recovered:false` 在两处都成立。
  if (hasMergeInProgress({ cwd })) {
    return {
      ok: false,
      error: 'fan-in 中止：会话 worktree 处于半合并态（MERGE_HEAD 存在）——收口停在此步，需人工介入',
    }
  }

  try {
    const r = fanInCatBranches(shortId, cwd)
    if (r.conflict) {
      return {
        ok: false,
        error: r.recovered
          ? 'fan-in 冲突（已 abort 回可重跑态）——冲突仲裁归店长，收口中止'
          : 'fan-in 冲突且 abort 未成功（仓库可能仍在半合并态）——需人工介入',
      }
    }
    if (r.merged.length > 0) {
      log.info('cat branches merged into session', { shortId, merged: r.merged })
    }
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: `fan-in 抛错: ${messageOf(err) ?? '未知错误'}` }
  }
}

/**
 * @internal step ②′ 回收**已合进 dev** 的猫 worktree + 猫分支，跑在 `removeWorktree`
 * 之后（此时集成分支已 ff 进 dev）。
 *
 * `integrationRef` 必须是 **`dev`**，不是 `session/<sid8>`（票面 §二-3 第 3 条）：
 * 回收的前提是「这批活**已经落进 dev**」。上一步 `mergeSession` 刚把集成分支 ff 进
 * dev ⇒ 按 dev 判 `isAncestor` 才等价于「真落地了」；按集成分支判会在「猫分支已合进
 * 集成分支、但集成分支还没落地」时**误删未落地的活**。
 *
 * **未合进 dev 的猫分支必须留存**——`reclaimCatBranches` 内部逐条判 `isAncestor`，
 * 未合的一律 `kept`（本步不越权改判）。
 */
export function reclaimCats(mainRoot: string, sessionId: string): StepResult {
  const shortId = sessionShortId(sessionId)
  if (!shortId) return null
  try {
    const reclaimed = reclaimCatBranches(shortId, 'dev', { cwd: mainRoot })
    const kept = listCatBranches(shortId, { cwd: mainRoot })
    if (reclaimed.length > 0) log.info('cat worktrees reclaimed', { shortId, reclaimed })
    if (kept.length > 0) log.warn('cat branches kept (未合进 dev)', { shortId, kept })
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: `猫 worktree 回收抛错: ${messageOf(err) ?? '未知错误'}` }
  }
}

/**
 * @internal step ① 合并会话分支进当前分支（收口时主工作区在 dev）。
 * mainRoot 由 closeoutSession preflight 探测一次传入（自指场景下后续无法再探测）。
 * 分支不存在 → null（已完成 merge + 删分支，或从未有分支——无需操作）。
 * ff-only 已合过（中断重跑）→ git 自身幂等成功（"Already up to date"）。
 */
export function mergeSession(mainRoot: string, sessionId: string): StepResult {
  const shortId = sessionShortId(sessionId)
  if (!shortId) return null
  const branch = sessionBranch(shortId)
  if (!branchRefExists(mainRoot, branch)) return null
  try {
    runGit(mainRoot, ['merge', '--ff-only', branch])
    log.info('session merged into dev', { sessionId, branch })
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: `ff-only merge ${branch} 失败: ${messageOf(err) ?? '未知错误'}` }
  }
}

/**
 * @internal step ② 移除会话 worktree（复用 removeSessionWorktree——已含
 * 删分支 + 自指守卫）。目录不存在 → null（已完成/从未建）。自指守卫场景
 * （process.cwd() 在被收口的 worktree 内）→ 物理残留允许留下（shell 不悬空
 * 第一，残留交进程退出后的收口兜底），目录仍存在不算失败。
 */
export function removeWorktree(mainRoot: string, sessionId: string): StepResult {
  const shortId = sessionShortId(sessionId)
  if (!shortId) return null
  const wtPath = sessionWorktreePath(mainRoot, shortId)
  if (!existsSync(wtPath)) return null
  try {
    removeSessionWorktree(sessionId)
  } catch (err: any) {
    return { ok: false, error: `worktree remove 抛错: ${err.message}` }
  }
  // 后验：cwd 不在其内但目录仍存在 → 物理清理失败，报错可排查；
  // cwd 在其内（自指守卫）→ 允许残留（不悬空优先）
  if (existsSync(wtPath) && !isPathInside(wtPath, resolve(process.cwd()))) {
    return { ok: false, error: 'worktree 目录移除后仍存在（物理残留清理失败）' }
  }
  return { ok: true }
}

/**
 * @internal step ③ 写 .push-gate = 主仓库当前 HEAD（merge 后的 dev HEAD）。
 * 幂等：gate 值相同不重写。重定向经 writeFileSync（禁 shell），
 * 内容统一无尾随换行（trim 后比较）。
 * sessionId 参数为统一 step 签名 (mainRoot, sessionId) 保留——四个 @internal
 * step 同签名，收口器/测试可统一调用；本步实际用不到该参数。
 */
export function writeGate(mainRoot: string, sessionId: string): StepResult {
  try {
    const head = runGit(mainRoot, ['rev-parse', 'HEAD'])
    const gatePath = resolve(mainRoot, '.push-gate')
    const existing = existsSync(gatePath) ? readFileSync(gatePath, 'utf8').trim() : ''
    if (existing !== head) {
      writeFileSync(gatePath, head, 'utf8')
      log.info('.push-gate synced', { head })
    }
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: `writeGate 失败: ${messageOf(err) ?? '未知错误'}` }
  }
}

/**
 * @internal step ④ 确保主工作区在 dev + cwd 复位。
 * 不在 dev → checkout dev（cwd mainRoot）；已在 → no-op。
 * cwd 复位：若 process.cwd() 位于已收口的 worktree 内（收口器在 worktree 内
 * 被调用的场景），chdir 到主仓库根——防止进程 cwd 悬空后一切文件 IO 失效
 * （僵尸进程占 slot 的根源，git-utils.removeSessionWorktree 注释同款教训）。
 */
export function checkoutDev(mainRoot: string, sessionId: string): StepResult {
  const shortId = sessionShortId(sessionId)
  const wtPath = shortId ? sessionWorktreePath(mainRoot, shortId) : null
  try {
    const current = runGit(mainRoot, ['branch', '--show-current'])
    if (current !== 'dev') {
      runGit(mainRoot, ['checkout', 'dev'])
      log.info('checked out dev', { from: current || '(detached)' })
    }
    if (wtPath && isPathInside(wtPath, resolve(process.cwd()))) {
      process.chdir(mainRoot)
      log.warn('cwd reset to main repo root (was inside removed worktree)', {
        from: wtPath,
        to: mainRoot,
      })
    }
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: `checkout dev 失败: ${messageOf(err) ?? '未知错误'}` }
  }
}

/** 只读探针：从 git 现状推导会话收口进度（店长先看后动）。绝不修改任何状态。 */
export function inspectCloseout(sessionId: string): CloseoutState {
  const none: CloseoutState = {
    branchExists: false,
    worktreeExists: false,
    mergedIntoDev: false,
    gateSynced: false,
    onDev: false,
  }
  const mainRoot = getMainRepoRoot()
  if (!mainRoot) return none
  const shortId = sessionShortId(sessionId)
  if (!shortId) return none
  const branch = sessionBranch(shortId)
  const wtPath = sessionWorktreePath(mainRoot, shortId)

  const bExists = branchRefExists(mainRoot, branch)

  let mergedIntoDev = false
  if (bExists) {
    try {
      runGit(mainRoot, ['merge-base', '--is-ancestor', branch, 'dev'])
      mergedIntoDev = true
    } catch {
      /* 非祖先（dev 未包含该分支） */
    }
  }

  let gateSynced = false
  try {
    const head = runGit(mainRoot, ['rev-parse', 'HEAD'])
    const gatePath = resolve(mainRoot, '.push-gate')
    if (existsSync(gatePath)) {
      gateSynced = readFileSync(gatePath, 'utf8').trim() === head
    }
  } catch {
    /* gate 读取失败 → false（保守） */
  }

  let onDev = false
  try {
    onDev = runGit(mainRoot, ['branch', '--show-current']) === 'dev'
  } catch {
    /* 探测失败 → false */
  }

  return {
    branchExists: bExists,
    worktreeExists: existsSync(wtPath),
    mergedIntoDev,
    gateSynced,
    onDev,
  }
}

/** 一键收口：fan-in 猫分支 → merge 会话分支 → 删 worktree → 回收猫树 → 写 gate →
 *  checkout dev + cwd 复位。（前两步各含中止判据：半合并态 / 冲突一律就地停。） */
export function closeoutSession(sessionId: string): CloseoutResult {
  // mainRoot 在此探测一次（process.cwd() 此时仍有效——自指场景下后续 git
  // worktree remove 会半删 cwd 所在 worktree 的 .git 指针，再探测必然失败），
  // 探测成功后显式传给全部 step，全流程与 process.cwd() 解耦。
  const mainRoot = getMainRepoRoot()
  if (!mainRoot)
    return { ok: false, step: 'preflight', error: '无法定位主仓库根（git-common-dir 探测失败）' }
  const shortId = sessionShortId(sessionId)
  if (!shortId) return { ok: false, step: 'preflight', error: 'sessionId 无法派生会话 short id' }

  // onDev 守卫（吐槽猫 OQ1）：收口器默认收口到 dev——mergeSession 会把会话分支合进
  // 「主仓库当前 checkout 的分支」。非 dev 分支误调会把 session 提交合进错分支，
  // 随后 removeWorktree 删分支 → 合进错分支的提交随分支删除不可逆丢失。守卫放
  // preflight 最前，任何 step 执行前先确认主工作区在 dev。
  let currentBranch = ''
  try {
    currentBranch = runGit(mainRoot, ['branch', '--show-current'])
  } catch {
    return {
      ok: false,
      step: 'preflight',
      error: '无法探测主仓库当前分支（git branch --show-current 失败）',
    }
  }
  if (currentBranch !== 'dev') {
    return {
      ok: false,
      step: 'preflight',
      error: currentBranch
        ? `主仓库当前在 ${currentBranch} 分支，非 dev——拒绝收口（防止 session 提交合进错分支）`
        : '主仓库当前处于 detached HEAD，非 dev——拒绝收口',
    }
  }

  // ⓪ fan-in 先于 merge（猫分支 → 集成分支），②′ 回收后于 removeWorktree（集成分支
  // 已落地 dev 才允许回收猫树）。两条都是 T-2 的必备件：只接线不接它们 ⇒ 猫的提交
  // 停在猫分支、收口照删（E5 静默丢活）。顺序见票面 §二-3。
  const f = fanInCats(mainRoot, sessionId)
  if (f && !f.ok) return { ok: false, step: 'fanin', error: f.error }

  const m = mergeSession(mainRoot, sessionId)
  if (m && !m.ok) return { ok: false, step: 'merge', error: m.error }

  const w = removeWorktree(mainRoot, sessionId)
  if (w && !w.ok) return { ok: false, step: 'worktree', error: w.error }

  const r = reclaimCats(mainRoot, sessionId)
  if (r && !r.ok) return { ok: false, step: 'reclaim', error: r.error }

  const g = writeGate(mainRoot, sessionId)
  if (g && !g.ok) return { ok: false, step: 'gate', error: g.error }

  const c = checkoutDev(mainRoot, sessionId)
  if (c && !c.ok) return { ok: false, step: 'checkout', error: c.error }

  log.info('session closed out', { sessionId, shortId })
  return { ok: true, step: 'checkout' }
}
