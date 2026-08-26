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
 * - 4 个 @internal step（mergeSession / removeWorktree / writeGate /
 *   checkoutDev）仅供测试直调断言每步语义；店长禁止乱序调——收口只走
 *   closeoutSession（串联全部 step，任一步失败即停，step 字段指出错处）。
 * - 硬约束：每步 git 命令 cwd 固定 mainRoot（主仓库根，绝不依赖 process.cwd()
 *   作为 git 工作目录）。mainRoot 在 preflight 从 git-common-dir 探测**一次**后
 *   显式传给全部 step——自指场景（收口者 cwd 在被收口 worktree 内）下
 *   `git worktree remove` 可能半删 worktree 的 .git 指针，此时再从 cwd 重新探测
 *   mainRoot 必然失败（checkoutDev/gate 全断）；传参后 mainRoot 与 cwd 解耦，
 *   process.cwd() 只在 preflight 参与一次探测。
 * - 幂等 check-then-act：中断重跑 = 续跑，从 git 现状推导已完成的步——
 *   分支不存在 → merge 跳过；worktree 目录不存在 → remove 跳过；gate 值相同
 *   → 不重写；已在 dev → checkout no-op。
 * - push 不进收口器：收口器只做本地机械步骤（merge/删/写 gate/切分支），
 *   「本地↔共享」的 push 边界属用户决策，走 push 审批节点。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { createLogger } from '../logger.js'
import {
  cleanGitEnv,
  getMainRepoRoot,
  removeSessionWorktree,
  sessionBranch,
  sessionShortId,
  sessionWorktreePath,
} from './git-utils.js'

const log = createLogger('session-closeout')

/** 收口失败时定位的步骤（ok:false 时 step 指出失败处；ok:true 时 step=最终完成的步） */
export type CloseoutStep = 'preflight' | 'merge' | 'worktree' | 'gate' | 'checkout'

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

/** child 是否等于或位于 parent 目录内（与 git-utils.isPathInside 同款语义） */
function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
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
    return { ok: false, error: `ff-only merge ${branch} 失败: ${err.message}` }
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
    return { ok: false, error: `writeGate 失败: ${err.message}` }
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
    return { ok: false, error: `checkout dev 失败: ${err.message}` }
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

/** 一键收口：merge → 删 worktree → 写 gate → checkout dev + cwd 复位。 */
export function closeoutSession(sessionId: string): CloseoutResult {
  // mainRoot 在此探测一次（process.cwd() 此时仍有效——自指场景下后续 git
  // worktree remove 会半删 cwd 所在 worktree 的 .git 指针，再探测必然失败），
  // 探测成功后显式传给全部 step，全流程与 process.cwd() 解耦。
  const mainRoot = getMainRepoRoot()
  if (!mainRoot)
    return { ok: false, step: 'preflight', error: '无法定位主仓库根（git-common-dir 探测失败）' }
  const shortId = sessionShortId(sessionId)
  if (!shortId) return { ok: false, step: 'preflight', error: 'sessionId 无法派生会话 short id' }

  const m = mergeSession(mainRoot, sessionId)
  if (m && !m.ok) return { ok: false, step: 'merge', error: m.error }

  const w = removeWorktree(mainRoot, sessionId)
  if (w && !w.ok) return { ok: false, step: 'worktree', error: w.error }

  const g = writeGate(mainRoot, sessionId)
  if (g && !g.ok) return { ok: false, step: 'gate', error: g.error }

  const c = checkoutDev(mainRoot, sessionId)
  if (c && !c.ok) return { ok: false, step: 'checkout', error: c.error }

  log.info('session closed out', { sessionId, shortId })
  return { ok: true, step: 'checkout' }
}
