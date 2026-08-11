/**
 * Git + npm 工具函数 — 消息撤回支持。
 *
 * - auto-commit：每轮 Agent 完成后提交改动
 * - 撤回已完成消息：git reset --hard HEAD~1
 * - 撤回进行中消息：git checkout -- . + git clean -fd
 * - npm 精确卸载：记录消息执行前后 package.json 的依赖差异
 */

import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createLogger } from '../logger.js'

const log = createLogger('git-utils')

/**
 * 动态获取当前工作目录。
 *
 * 为什么不用模块级 `const CWD = resolve(process.cwd())`：
 * 模块级捕获在 vitest worker 中会被模块缓存锁死为「首次加载时」的 cwd——
 * 全量测试时若本模块被其他路径先 import，CWD 会指向真实仓库（主工作区或 worktree 根），
 * 破坏性 git 操作（reset --hard / add -A / config）会污染真实仓库。
 * 每次调用动态取，测试在 chdir(tmp) 后调用即落在临时仓库，不依赖加载顺序。
 */
function getCwd(): string {
  return resolve(process.cwd())
}

/**
 * 清理 git 环境变量，恢复「按 cwd 探测」语义。
 *
 * git 在 worktree 内 commit 时会向 hook 注入 GIT_DIR（绝对路径，指向
 * .git/worktrees/<name>——worktree 的 .git 是文件指针，git 需显式指定
 * 仓库位置）与 GIT_INDEX_FILE（绝对路径）。hook 内跑全量 vitest 时，
 * 测试的 execSync 虽有 `cwd: tmp`，但 GIT_DIR 环境变量优先级高于 cwd
 * 探测——全部 git 操作（init/config/add/commit）被劫持到 worktree gitdir
 * 与主仓库共享 config（user.name=test、core.bare=true 污染，worktree 分支
 * 被 fake 提交篡改）。主工作区 commit 不注入 GIT_DIR（仅相对 GIT_INDEX_FILE，
 * cwd=tmp 时相对 tmp 解析无害）——店长实测实锤（2026-08-09，hook env dump）。
 * 与 getCwd() 动态化互补：前者防模块缓存锁死 cwd，本函数防 env 劫持 cwd。
 */
function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.GIT_DIR
  delete env.GIT_INDEX_FILE
  delete env.GIT_WORK_TREE
  delete env.GIT_PREFIX
  return env
}

/** 检查是否在 git 仓库内 */
function isGitRepo(): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', {
      cwd: getCwd(),
      env: cleanGitEnv(),
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

/** 获取 git 工作树根目录 */
function getGitRoot(): string | null {
  try {
    return execSync('git rev-parse --show-toplevel', {
      cwd: getCwd(),
      env: cleanGitEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

/**
 * 获取主仓库根目录（worktree 场景与 getGitRoot 区分）。
 *
 * worktree 内 getGitRoot() 返回 worktree 自身根（指向会话分支的快照），
 * 但主仓库（server 运行时、db、e2e 标记文件）在 git-common-dir 的父目录——
 * `git rev-parse --git-common-dir` 返回共享 .git 目录（主工作区 `.git`、
 * worktree `.git/worktrees/<name>`），dirname 即主仓库根。
 * 主工作区下与 getGitRoot() 结果一致（行为零变化）。
 */
export function getMainRepoRoot(): string | null {
  try {
    const commonDir = execSync('git rev-parse --git-common-dir', {
      cwd: getCwd(),
      env: cleanGitEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (!commonDir) return null
    return dirname(resolve(getCwd(), commonDir))
  } catch {
    return null
  }
}

/**
 * e2e 测试标记文件（相对 git 根）— 存在即跳过 auto-commit。
 *
 * 为什么用文件而不是环境变量：e2e 测试进程和 server 进程是两个独立进程，
 * 环境变量不跨进程传递，server 读不到 e2e 设置的 CATSTUDY_SKIP_AUTO_COMMIT。
 * 标记文件在共享文件系统上，双方都能看到。
 */
const E2E_MARKER_REL = 'scripts/.e2e-testing'

/**
 * 检查 e2e 测试标记文件是否存在。
 *
 * 读主仓库根（getMainRepoRoot）而非 getGitRoot：worktree 内 getGitRoot 指向
 * worktree 快照，而标记文件由 e2e 在 server 主工作区创建（worktree 快照不含
 * 未跟踪的新文件）——不反推主仓库则 worktree 场景 e2e 标记失效、auto-commit
 * 不禁用，e2e 竞态重现。主工作区下两者一致，行为零变化。
 */
function isE2ETesting(): boolean {
  const root = getMainRepoRoot() ?? getGitRoot()
  if (!root) return false
  return existsSync(resolve(root, E2E_MARKER_REL))
}

/** 获取当前 HEAD commit hash */
export function getHeadCommit(): string | null {
  if (!isGitRepo()) return null
  try {
    return execSync('git rev-parse HEAD', {
      cwd: getCwd(),
      env: cleanGitEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

/**
 * git add -A && git commit。
 *
 * opts.cwd 指定提交仓库（会话 worktree 场景——auto-commit 落会话分支）；
 * 缺省提交当前 cwd 的仓库（主工作区，存量会话行为零变化）。
 */
export function gitCommit(message: string, opts?: { cwd?: string }): string | null {
  if (!isGitRepo()) return null
  const base = opts?.cwd ?? getCwd()
  // e2e 测试期间禁用自动快照，防止测试 commit 和 agent auto-commit 在同一时间轴竞态
  // → git reset --soft 会把测试 commit 和 catstudy 快照 commit 一起回退掉
  // 用标记文件（跨进程可见）而非环境变量——server 与 e2e 是不同进程
  if (isE2ETesting()) {
    log.info('auto commit skipped (e2e marker)', { message })
    return null
  }
  try {
    execSync('git add -A', { cwd: base, env: cleanGitEnv(), stdio: 'ignore' })
    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
      cwd: base,
      env: cleanGitEnv(),
      stdio: 'ignore',
    })
    const hash = execSync('git rev-parse HEAD', {
      cwd: base,
      env: cleanGitEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    log.info('auto commit', { message, hash, cwd: base })
    return hash
  } catch (err: any) {
    // 没有改动时 git commit 会非零退出，这是正常的
    log.info('auto commit skipped (no changes)', { message, cwd: base })
    return null
  }
}

/** 撤回已完成消息：git reset --hard HEAD~1 */
export function gitResetHard(): boolean {
  if (!isGitRepo()) return false
  try {
    execSync('git reset --hard HEAD~1', { cwd: getCwd(), env: cleanGitEnv(), stdio: 'ignore' })
    log.info('git reset --hard HEAD~1')
    return true
  } catch (err: any) {
    log.error('git reset failed', { error: err.message })
    return false
  }
}

/** 撤回进行中消息：还原所有未提交改动 */
export function gitCleanWorkingTree(): boolean {
  if (!isGitRepo()) return false
  try {
    execSync('git checkout -- .', { cwd: getCwd(), env: cleanGitEnv(), stdio: 'ignore' })
    execSync('git clean -fd', { cwd: getCwd(), env: cleanGitEnv(), stdio: 'ignore' })
    log.info('git checkout -- . + git clean -fd')
    return true
  } catch (err: any) {
    log.error('git clean failed', { error: err.message })
    return false
  }
}

/** 读取 package.json 中的 dependencies + devDependencies 包名集合 */
function readPkgDeps(): Set<string> {
  const pkgs = new Set<string>()
  try {
    const raw = readFileSync(resolve(getCwd(), 'package.json'), 'utf-8')
    const json = JSON.parse(raw)
    for (const key of ['dependencies', 'devDependencies'] as const) {
      if (json[key] && typeof json[key] === 'object') {
        for (const pkg of Object.keys(json[key])) {
          pkgs.add(pkg)
        }
      }
    }
  } catch {
    /* 读不到就算了 */
  }
  return pkgs
}

/** 拍快照：返回当前 package.json 中的包名集合 */
export function snapshotPackageDeps(): string[] {
  return Array.from(readPkgDeps())
}

/** 对比快照，返回新增的包名 */
export function diffNewPackages(before: string[], after: string[]): string[] {
  const beforeSet = new Set(before)
  return after.filter((pkg) => !beforeSet.has(pkg))
}

/** npm uninstall 指定包列表 */
export function npmUninstall(packages: string[]): void {
  if (packages.length === 0) return
  for (const pkg of packages) {
    try {
      execSync(`npm uninstall ${pkg}`, { cwd: getCwd(), env: cleanGitEnv(), stdio: 'ignore' })
      log.info('npm uninstall', { package: pkg })
    } catch {
      log.warn('npm uninstall failed', { package: pkg })
    }
  }
}

// ─── Session Worktree（会话隔离）─────────────────────

/** 会话 worktree 目录前缀（相对主仓库根的兄弟目录，仓库外防 junction 穿透） */
const SESSION_WORKTREE_PREFIX = 'catStudy-sessions'

/** 会话 short id（分支/目录名用，8 位，去非法字符） */
function sessionShortId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 8)
}

/** 会话分支名 */
function sessionBranch(shortId: string): string {
  return `session/${shortId}`
}

/** 会话 worktree 路径（主仓库兄弟目录） */
function sessionWorktreePath(mainRoot: string, shortId: string): string {
  return resolve(mainRoot, '..', SESSION_WORKTREE_PREFIX, shortId)
}

/**
 * node_modules junction（Windows）：worktree 复用主仓库依赖。
 * 失败降级（worktree 无依赖时测试/lint 不可跑，但文件操作/提交不受影响），
 * 不阻塞主链——依赖是增强不是主链路（同 memory 嵌入失败语义）。
 */
function linkNodeModules(mainRoot: string, wtPath: string): void {
  const src = resolve(mainRoot, 'node_modules')
  const dest = resolve(wtPath, 'node_modules')
  if (!existsSync(src) || existsSync(dest)) return
  try {
    if (process.platform === 'win32') {
      // mklink 是 cmd 内建命令，必须 cmd /c 包装；junction（/J）不需要管理员权限
      execFileSync('cmd', ['/c', 'mklink', '/J', dest, src], { stdio: 'ignore' })
    } else {
      execFileSync('ln', ['-s', src, dest], { stdio: 'ignore' })
    }
    log.info('node_modules link created', { wtPath })
  } catch (err: any) {
    log.warn('node_modules link failed — worktree 无依赖（测试/lint 不可跑，提交不受影响）', {
      error: err.message,
    })
  }
}

/**
 * 确保会话 worktree 存在（幂等）。
 *
 * 会话隔离核心：每个会话一个独立目录 + 独立分支（session/<8位id>），
 * 猫的 CLI 在 worktree 里执行——文件系统级隔离，A 会话的 auto-commit
 * 快照不会收走 B 会话正在改的文件（360608d 抢收、uuid 错挂全是共享
 * 工作区导致的）。
 *
 * - 分支从主仓库当前 HEAD 分叉（收口时店长 merge 回 dev）
 * - worktree 目录 = 主仓库兄弟目录 catStudy-sessions/<8位id>
 * - node_modules junction 复用主仓库依赖（失败降级）
 * - 任意失败 → 返回 null（降级回主工作区，行为与现网一致）
 * - 已存在（重启恢复/重复触发）→ 直接复用返回路径
 */
export function ensureSessionWorktree(sessionId: string): string | null {
  if (!isGitRepo()) return null
  const mainRoot = getMainRepoRoot()
  if (!mainRoot) return null
  const shortId = sessionShortId(sessionId)
  if (!shortId) return null
  const branch = sessionBranch(shortId)
  const wtPath = sessionWorktreePath(mainRoot, shortId)

  // 已存在 → 复用（重启恢复路径：目录与分支 ref 均持久）。
  // worktree 标记（.git 文件）存在才算有效；无标记的残留目录删除重建。
  if (existsSync(wtPath)) {
    if (existsSync(resolve(wtPath, '.git'))) return wtPath
    try {
      rmSync(wtPath, { recursive: true, force: true })
    } catch {
      return null
    }
  }

  // 分支不存在才建（从主仓库当前 HEAD 分叉）
  let branchExists = false
  try {
    execFileSync('git', ['rev-parse', '--verify', `refs/heads/${branch}`], {
      cwd: mainRoot,
      env: cleanGitEnv(),
      stdio: 'ignore',
    })
    branchExists = true
  } catch {
    /* 分支不存在 */
  }
  if (!branchExists) {
    try {
      execFileSync('git', ['branch', branch], {
        cwd: mainRoot,
        env: cleanGitEnv(),
        stdio: 'ignore',
      })
    } catch (err: any) {
      log.warn('session branch create failed — fallback to main workspace', {
        branch,
        error: err.message,
      })
      return null
    }
  }

  try {
    mkdirSync(resolve(mainRoot, '..', SESSION_WORKTREE_PREFIX), { recursive: true })
    execFileSync('git', ['worktree', 'add', wtPath, branch], {
      cwd: mainRoot,
      env: cleanGitEnv(),
      stdio: 'ignore',
    })
  } catch (err: any) {
    log.warn('worktree add failed — fallback to main workspace', {
      branch,
      wtPath,
      error: err.message,
    })
    return null
  }

  linkNodeModules(mainRoot, wtPath)
  log.info('session worktree ready', { sessionId, branch, wtPath })
  return wtPath
}

/** 查询会话 worktree 路径（目录存在才返回，无则 null——调用方走降级路径） */
export function getSessionWorktreePath(sessionId: string): string | null {
  const mainRoot = getMainRepoRoot()
  if (!mainRoot) return null
  const shortId = sessionShortId(sessionId)
  if (!shortId) return null
  const wtPath = sessionWorktreePath(mainRoot, shortId)
  return existsSync(wtPath) ? wtPath : null
}

/**
 * 销毁会话 worktree（店长收口后调用）：git worktree remove + 删分支。
 * 失败静默（残留目录不阻塞主链，收口流程兜底）。
 */
export function removeSessionWorktree(sessionId: string): void {
  const mainRoot = getMainRepoRoot()
  if (!mainRoot) return
  const shortId = sessionShortId(sessionId)
  if (!shortId) return
  const branch = sessionBranch(shortId)
  const wtPath = sessionWorktreePath(mainRoot, shortId)
  if (existsSync(wtPath)) {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', wtPath], {
        cwd: mainRoot,
        env: cleanGitEnv(),
        stdio: 'ignore',
      })
      log.info('session worktree removed', { sessionId, wtPath })
    } catch (err: any) {
      log.warn('worktree remove failed — force removing dir', { error: err.message })
      try {
        rmSync(wtPath, { recursive: true, force: true })
      } catch {
        /* 忽略 */
      }
    }
  }
  try {
    execFileSync('git', ['branch', '-D', branch], {
      cwd: mainRoot,
      env: cleanGitEnv(),
      stdio: 'ignore',
    })
    log.info('session branch deleted', { branch })
  } catch {
    /* 分支可能已删/不存在 */
  }
}
