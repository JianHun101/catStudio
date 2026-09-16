/**
 * Git + npm 工具函数 — 消息撤回支持。
 *
 * - auto-commit：每轮 Agent 完成后提交改动
 * - 撤回已完成消息：git reset --hard HEAD~1
 * - 撤回进行中消息：git checkout -- . + git clean -fd
 * - npm 精确卸载：记录消息执行前后 package.json 的依赖差异
 */

import { execFileSync, execSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
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
export function cleanGitEnv(): NodeJS.ProcessEnv {
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
export function sessionShortId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 8)
}

/** 会话分支名 */
export function sessionBranch(shortId: string): string {
  return `session/${shortId}`
}

/** 会话 worktree 路径（主仓库兄弟目录） */
export function sessionWorktreePath(mainRoot: string, shortId: string): string {
  return resolve(mainRoot, '..', SESSION_WORKTREE_PREFIX, shortId)
}

/**
 * 猫名清洗（分支/目录名用）。
 *
 * **绝不复用 `sessionShortId` 的字符过滤正则**（命名票红线 1）：那条
 * `[^a-zA-Z0-9-]` 会把中文**整串剥成空串** ⇒ 产出 `session/<sid8>-` 空后缀分支，
 * 失败形态静默（与已固化的 S3-5 同形）。猫名另立清洗，中文/字母/数字**原样保留**
 * （git 直接接受，命名票 A1–A5 真机实证，无需转义/百分号/八进制）。
 *
 * 剔除 git ref 非法字符：`\`、空白、`~ ^ : ? * [ "`、`@{`、`..`、控制字符、首尾 `.`。
 *
 * 两类**显式抛错**（不得静默降级为 id 或空串）：
 * - **含 `/`**：既会把 ref 切成嵌套层级（`session/<sid8>` 与 `session/<sid8>/x`
 *   在 ref 树里是「文件 vs 目录」冲突，ADR 0015 E1 实跑建不出来），更要紧的是
 *   **静默剔除会把 `a/b` 折成 `ab`**——与真名 `ab` 归一到同一分支 + **同一棵树**，
 *   正是本票要消灭的静默共用形态。⇒ 单列为错误而非可剔字符。
 * - **清洗后为空** ⇒ 造出空后缀分支/目录，失败形态静默。
 */
export function catSlug(catName: string): string {
  if (catName.includes('/')) {
    throw new Error(
      `猫名含 '/'，不能用作分支/目录名（静默剔除会把 a/b 折成 ab，与真名 ab 共用同一棵树）：${JSON.stringify(catName)}`
    )
  }
  const slug = catName
    .replace(/[\u0000-\u001f\u007f]/g, '') // control chars
    .replace(/[\s\\~^:?*\["@{]/g, '') // git ref 非法字符（含空白）
    .replace(/\.\./g, '') // `..` 序列
    .replace(/^\.+|\.+$/g, '') // 首尾 `.`（ref 分量不得以 `.` 开头/结尾）
  if (!slug) {
    throw new Error(`猫名清洗后为空，不能用作分支/目录名：${JSON.stringify(catName)}`)
  }
  return slug
}

/**
 * 猫分支名（一猫一工作分支，ADR 0015 D1）。后缀 = 猫名（`catSlug` 清洗）。
 *
 * **连字符而非斜杠**：`session/<sid8>` 与 `session/<sid8>/<cat>` 在 git ref 树里
 * 是「目录 vs 文件」冲突——`git branch` 与真实机制 `git worktree add -b` 均报
 * `fatal: cannot lock ref`，`pack-refs --all` 绕不过、反序（先子后父）同样失败
 * （ADR 0015 E1，仓外临时仓实跑）。失败形态是静默的：`git worktree add` 失败走
 * catch → 返回 null，猫拿不到 worktree 而无人察觉。
 */
export function catBranch(shortId: string, catName: string): string {
  return `${sessionBranch(shortId)}-${catSlug(catName)}`
}

/** 猫 worktree 路径（主仓库兄弟目录，与会话 worktree 同层） */
export function catWorktreePath(mainRoot: string, shortId: string, catName: string): string {
  return resolve(mainRoot, '..', SESSION_WORKTREE_PREFIX, `${shortId}-${catSlug(catName)}`)
}

/**
 * pnpm 包级依赖目录（不提升到根 node_modules，如 uuid、vitejs/plugin-vue）。
 * 与 WT_RESIDUE_LINK_PATHS 覆盖的残留路径一致（建与清对称）。
 */
const PACKAGE_LINK_DIRS = ['server', 'shared', 'web'] as const

/**
 * node_modules junction（Windows）：worktree 复用主仓库依赖。
 * 根链接 + 包级三条（packages/server|shared|web/node_modules）——pnpm 的包级
 * 依赖不提升到根，只建根链接时 vitest 收集阶段解析不到包级依赖（uuid、
 * vitejs/plugin-vue），pre-commit 钩子必失败（店长 2026-08-13 提交 ADR 0007
 * 时实证：三包级链接缺失 → 全量测试收集失败）。
 * 失败降级（worktree 无依赖时测试/lint 不可跑，但文件操作/提交不受影响），
 * 不阻塞主链——依赖是增强不是主链路（同 memory 嵌入失败语义）。
 * caveat：包级链接指向主仓库 packages 的 node_modules，worktree 内包名
 * cat-study/shared 解析到主仓库 packages/shared 源码——改 shared 类型后
 * worktree lint 可能误报「类型不存在」（主仓库 node_modules 里的 shared 是
 * 陈旧拷贝/坏链接时；worktree 与主仓库同 commit 时同源码无碍）。
 */
function linkNodeModules(mainRoot: string, wtPath: string): void {
  const makeLink = (src: string, dest: string, label: string): void => {
    if (!existsSync(src) || existsSync(dest)) return
    try {
      if (process.platform === 'win32') {
        // mklink 是 cmd 内建命令，必须 cmd /c 包装；junction（/J）不需要管理员权限
        execFileSync('cmd', ['/c', 'mklink', '/J', dest, src], { stdio: 'ignore' })
      } else {
        execFileSync('ln', ['-s', src, dest], { stdio: 'ignore' })
      }
      log.info('node_modules link created', { label, wtPath })
    } catch (err: any) {
      log.warn('node_modules link failed — worktree 无依赖（测试/lint 不可跑，提交不受影响）', {
        label,
        error: err.message,
      })
    }
  }

  // 根链接：pnpm 提升到根 node_modules 的依赖主体
  makeLink(resolve(mainRoot, 'node_modules'), resolve(wtPath, 'node_modules'), 'root')
  // 包级链接：pnpm 的包级依赖不提升到根，缺包级链接时 pre-commit 全量必失败
  for (const pkg of PACKAGE_LINK_DIRS) {
    const src = resolve(mainRoot, 'packages', pkg, 'node_modules')
    if (!existsSync(src)) continue // 主仓库该包未装依赖 → 无可链接
    const dest = resolve(wtPath, 'packages', pkg, 'node_modules')
    mkdirSync(dirname(dest), { recursive: true }) // worktree 可能未检出该包目录
    makeLink(src, dest, `packages/${pkg}`)
  }
}

/** 重建路径重试参数：EPERM（他进程持目录为 cwd/句柄）多为瞬时占用 */
const WT_REBUILD_RETRY_COUNT = 3
const WT_REBUILD_RETRY_DELAY_MS = 500

/** 同步休眠（有界等待用；Atomics.wait 阻塞当前线程，Node 主线程/worker 均可用） */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * 移除「无 .git 标记」的残留目录（ensureSessionWorktree 重建路径专用）。
 *
 * 处置链（店长 2026-08-13 真机 dogfood + 本机探针实证）：
 * ① 复用 cleanupWorktreeResidue——链接先行 + 复核守卫 + 总清扫；残留含
 *    junction 时跟随风险从代码结构上排除，不依赖 rmSync 版本行为承诺；
 * ② 有限重试（EPERM 多为瞬时占用——agent CLI 子进程持 cwd，进程退出即自愈）；
 * ③ 重试耗尽仍存在 → error 级日志显式暴露后返回 false，调用方降级 null
 *    （行为与旧实现一致，但不静默——会话隔离丢失一眼可见）。
 * 改名让位（renameSync）曾作为候选被探针否决：Windows 对 cwd 被持有的
 * 目录 renameSync 报 EBUSY（与 rmSync EPERM 同因——句柄无 FILE_SHARE_DELETE）。
 */
function removeStaleWorktreeDir(wtPath: string): boolean {
  for (let attempt = 0; attempt < WT_REBUILD_RETRY_COUNT; attempt++) {
    if (!existsSync(wtPath)) return true
    if (attempt > 0) sleepSync(WT_REBUILD_RETRY_DELAY_MS)
    cleanupWorktreeResidue(wtPath)
  }
  if (!existsSync(wtPath)) return true
  log.error('stale session dir removal failed — falling back to main workspace (isolation lost)', {
    wtPath,
    hint: 'held by another process (cwd/file handle) — cleanable after it exits',
  })
  return false
}

/** ensureWorktreeAt 的产出：路径 + 是否本次新建（复用不重复打 ready 日志） */
interface WorktreeReady {
  path: string
  created: boolean
}

/**
 * 建/复用 worktree 的三步判定骨架（会话 worktree 与猫 worktree 共享）。
 *
 * 抽自 ensureSessionWorktree（原实现内联）：① 目录已存在且带 `.git` 标记 → 复用；
 * 无标记（残留）→ removeStaleWorktreeDir 链接先行安全清理；② 分支不存在才建；
 * ③ `git worktree add`（**不带 `-b`**——分支已在步骤 ② 建好）。**两处调用同一份
 * 代码：复制必然漂移**（本仓既有教训：建与清的路径清单必须对称）。
 *
 * - `startPoint` 省略 → 分支从 mainRoot 当前 HEAD 分叉（会话 worktree 既有语义）
 * - `startPoint` 给出 → 从该起点分叉（猫 worktree 从集成分支 `session/<sid8>`，不是 dev）
 * - 失败一律返回 null（是否降级、降到哪由调用方决定，不在本函数内自作主张）
 */
function ensureWorktreeAt(opts: {
  mainRoot: string
  branch: string
  wtPath: string
  startPoint?: string
  /** 失败日志前缀（'session' | 'cat'）——会话路径文案逐字不变 */
  label: string
}): WorktreeReady | null {
  const { mainRoot, branch, wtPath, startPoint, label } = opts

  // 已存在 → 复用（重启恢复路径：目录与分支 ref 均持久）。
  // worktree 标记（.git 文件）存在才算有效；无标记的残留目录删除重建。
  if (existsSync(wtPath)) {
    if (existsSync(resolve(wtPath, '.git'))) return { path: wtPath, created: false }
    // 无 .git 标记 = 残留目录（上次收口只清 git 层留下的物理残留 / 崩溃残留）。
    // 旧实现直接 rmSync 扫树——残留含 junction 时「是否跟随」押在 Node 版本
    // 行为上，且 EPERM 静默降级；现走链接先行安全清理（removeStaleWorktreeDir）
    if (!removeStaleWorktreeDir(wtPath)) return null
  }

  // 分支不存在才建
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
      execFileSync('git', startPoint ? ['branch', branch, startPoint] : ['branch', branch], {
        cwd: mainRoot,
        env: cleanGitEnv(),
        stdio: 'ignore',
      })
    } catch (err: any) {
      log.warn(`${label} branch create failed — fallback to main workspace`, {
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
  return { path: wtPath, created: true }
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
 * - 无 .git 标记的残留目录 → removeStaleWorktreeDir（链接先行安全清理 +
 *   EPERM 有限重试，重试耗尽 error 日志显式暴露后返回 null——降级不静默）
 * - 分支/目录创建等其余失败 → 返回 null（降级回主工作区，行为与现网一致）
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

  const ready = ensureWorktreeAt({ mainRoot, branch, wtPath, label: 'session' })
  if (!ready) return null
  if (ready.created) log.info('session worktree ready', { sessionId, branch, wtPath })
  return ready.path
}

/** 猫 worktree 所有权配置键（分支级 git config，落 `.git/config`） */
function catOwnerConfigKey(branch: string): string {
  return `branch.${branch}.catAgentId`
}

/**
 * 读所有权标记；**未设置**（`git config --get` 退出码 1）或读失败 → null。
 *
 * 注意区分「未设置」与「设置为空串」：前者是 `catch → null`，后者是 `''`——
 * 若把 `''` 也折成 null，同一 agent 的第二次调用会走「无标记 ⇒ 抛错」分支
 * （写进去的是空串、读回来当没写），同一棵树自己复用不了自己。
 */
function readCatOwner(mainRoot: string, branch: string): string | null {
  try {
    return execFileSync('git', ['config', '--get', catOwnerConfigKey(branch)], {
      cwd: mainRoot,
      env: cleanGitEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

/** 写所有权标记；写失败抛错（不静默留下一棵无主树） */
function writeCatOwner(mainRoot: string, branch: string, agentId: string): void {
  execFileSync('git', ['config', catOwnerConfigKey(branch), agentId], {
    cwd: mainRoot,
    env: cleanGitEnv(),
    stdio: 'ignore',
  })
}

/**
 * 确保某只猫的 worktree 存在（幂等）——一猫一 worktree（ADR 0015 D1）。
 *
 * 与会话 worktree 同骨架，三处差异：
 * - 分支/目录名带**猫名**后缀（连字符，见 catBranch；`catSlug` 清洗）
 * - **从集成分支 `session/<sid8>` 分叉，不是 dev**——猫的工作起点是会话集成分支，
 *   fan-in 再把它合回该分支（ADR 0015 §6.3 方案 a：冲突关在会话 worktree 里，
 *   绝不落 dev 主工作区）
 * - **所有权标记**（§2.2）：同名不同 agent ⇒ `catBranch`/`catWorktreePath` 产出
 *   同一个路径 ⇒ 两只猫在**同一棵树**里干活，且**静默**。标记落
 *   `branch.<完整分支名>.catAgentId`（`.git/config`，**不在工作区内** ⇒ 不参与
 *   `git add -A`、不进任何提交）。建 → 写；复用 → 读回比对。
 *
 * 集成分支不存在 ⇒ **本函数先补建它**（fork 点 = 主仓库 HEAD），猫树照常建得出；
 * 补建失败（非 git 仓库 / 无法解析主仓库根）⇒ 返回 **null**：降级到哪由调用方决定，
 * 本函数**绝不自行落主仓库**（T-1 已收窄的降级路径，不得回退）。
 * 猫名含 `/` 或清洗后为空 ⇒ `catSlug` **抛错**（不静默降级为 id/空串，
 * 否则造出 `session/<sid8>-` 空后缀分支——枚举侧 S3-5 同形静默）。
 * 复用一棵**无标记**或**标记属他人**的树 ⇒ **显式抛错**（不静默复用别人的树）。
 */
export function ensureCatWorktree(
  sessionId: string,
  agentId: string,
  catName: string
): string | null {
  if (!isGitRepo()) return null
  const mainRoot = getMainRepoRoot()
  if (!mainRoot) return null
  const shortId = sessionShortId(sessionId)
  if (!shortId) return null
  if (!agentId) return null // 空 agent id 无法持有所有权标记（Phase T A5 契约保留）
  const branch = catBranch(shortId, catName)
  const wtPath = catWorktreePath(mainRoot, shortId, catName)

  // 分叉点 = 集成分支（`session/<sid8>`）。**它必须先存在**：本会话若从未有 store
  // 执行过，则无人创建它 ⇒ 猫树全建不出 ⇒ 全体降级到共享 `workspace/`
  // （`getWorkspaceDir()` 落在 gitignored 目录 ⇒ 猫的改动连 `git status` 都看不见）
  // ⇒ 收口时 `listCatBranches` 收 0 条 ⇒ **静默丢活**（OQ1，店长裁 A）。
  // 用 `ensureSessionWorktree` 而不是自写 `git branch`：单源——`ensureWorktreeAt`
  // 的建分支段是它与会话路径共享的那一份，自写会造出第二个集成分支创建点。
  // 这不改 ADR D2 的「持有者」（cwd 持有者仍是 store），只让集成分支**提前存在**；
  // store 路径在 `ensureAgentWorktree` 里仍走 `ensureSessionWorktree`，幂等复用。
  if (!ensureSessionWorktree(sessionId)) return null

  const ready = ensureWorktreeAt({
    mainRoot,
    branch,
    wtPath,
    startPoint: sessionBranch(shortId),
    label: 'cat',
  })
  if (!ready) return null

  // 所有权：先判「属于别人」（建/复用两路都要挡——分支已存在而目录缺失时
  // 走的是 created 路径，只判复用侧会让标记被静默改写）
  const owner = readCatOwner(mainRoot, branch)
  if (owner !== null && owner !== agentId) {
    throw new Error(
      `猫 worktree 所有权冲突：${branch} 的 catAgentId=${owner}，非本次调用者 ${agentId}（同名不同 agent ⇒ 拒绝共用同一棵树）`
    )
  }
  if (owner === null) {
    if (ready.created) {
      writeCatOwner(mainRoot, branch, agentId)
    } else {
      throw new Error(
        `猫 worktree 复用被拒：${branch} 无所有权标记（branch.${branch}.catAgentId 缺失）——不静默复用来路不明的树（cat=${wtPath}）`
      )
    }
  }

  if (ready.created) {
    log.info('cat worktree ready', { sessionId, agentId, catName, branch, wtPath })
  }
  return ready.path
}

/**
 * 按**角色**分派执行/提交目标树——**单源**（reply.ts 的 CLI cwd 与 serial.ts 的
 * 逐猫提交/清理共用，避免两处各写一份角色判定而漂移）。
 *
 * - `role === 'store'`（店长）→ **会话 worktree**：它是**唯一** checkout 了
 *   `session/<sid8>` 的地方，即 fan-in 的 cwd。店长搬进猫 worktree 会让
 *   「谁持有集成分支」变成需要额外机制保证的时序问题（ADR 0015 决策留痕）。
 * - 其余（含 `role` 缺失/未知）→ **各自的猫 worktree**（隔离优先）。
 *
 * 建不出 → null：不传 cwd / 跳过该树，**绝不回落主仓库**（T-1 已收窄，不得回退）。
 */
export function ensureAgentWorktree(
  sessionId: string,
  agent: { id: string; name: string; role?: string }
): string | null {
  return agent.role === 'store'
    ? ensureSessionWorktree(sessionId)
    : ensureCatWorktree(sessionId, agent.id, agent.name)
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
 * 会话 worktree 物理残留清理（removeSessionWorktree 专用）。
 *
 * 机制（店长 2026-08-13 清理 9 个历史 worktree 实测实证）：
 * `git worktree remove` 只删 git 跟踪内容；node_modules 是 linkNodeModules
 * 建的链接（win32 mklink /J junction，gitignored），git 看不见也不碰——
 * 目录物理残留，每次收口累积。
 *
 * 安全硬约束：任何 recursive 删除之前必须先移除链接本身，绝不跟随链接——
 * 链接目标 = 主仓库 node_modules，跟随 = 灾难。事实（2026-08-13 本机实测，
 * Node 24/win32）：rmSync recursive 把链接当链接删——直接作用在链接上、
 * 扫含链接的目录树均不跟随目标；但 statSync+readdirSync 朴素递归会穿透
 * junction。跟随不是「已知 bug」而是「工具/版本行为差异」——链接先行 +
 * 复核守卫把跟随从代码结构上排除，不依赖任何版本的 rmSync 行为承诺。
 * 顺序：① 逐个移除已知链接路径（lstat 链接判定，rmdir/unlink 只删链接
 * 本身）→ ② rmdir 空壳目录（packages/* → packages，自底向上；非空拒绝
 * 删，自带保险）→ ③ 复核无残留链接后才允许 recursive 总清扫；链接移除
 * 失败的窄情况跳过总清扫（残留交给收口兜底，安全优先于干净）。
 * 全程 try/catch 静默 + warn（失败不阻塞主链，与既有语义一致）。
 */
const WT_RESIDUE_LINK_PATHS = [
  'node_modules',
  'packages/node_modules',
  'packages/server/node_modules',
  'packages/shared/node_modules',
  'packages/web/node_modules',
] as const

/** 空壳目录，自底向上（packages/* 先于 packages） */
const WT_RESIDUE_SHELL_DIRS = [
  'packages/server',
  'packages/shared',
  'packages/web',
  'packages',
] as const

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

/** 只删链接本身（绝不跟随目标）；非链接路径不碰 */
function removeLinkOnly(p: string): void {
  if (!isLink(p)) return
  try {
    if (process.platform === 'win32') {
      // junction 对 rmdirSync = 删除 reparse point 本身、不跟目标（店长实测手法）；
      // 真 symlink（ln -s）rmdirSync 会失败 → unlinkSync 兜底
      try {
        rmdirSync(p)
      } catch {
        unlinkSync(p)
      }
    } else {
      unlinkSync(p)
    }
  } catch (err: any) {
    log.warn('residue link removal failed', { path: p, error: err.message })
  }
}

/** 空目录才删（rmdirSync 非空抛错即跳过，绝不 recursive） */
function rmdirEmpty(p: string): void {
  try {
    rmdirSync(p)
  } catch {
    /* 非空/不存在 → 留给后续步骤 */
  }
}

/**
 * 链接先行的物理残留清理（worktree 目录级）。
 *
 * 导出供 `worktree-fanin.ts` 的猫 worktree 回收复用——**不复制的理由同
 * ensureWorktreeAt**：这段守卫（链接先删 + 复核无链接才 recursive 清扫）是
 * 「删 symlink 绝不跟随」的唯一承载点，第二份拷贝漂移一次就是删穿主仓库
 * node_modules 的灾难。语义与调用方约束见上方大段注释。
 */
export function cleanupWorktreeResidue(wtPath: string): void {
  try {
    for (const rel of WT_RESIDUE_LINK_PATHS) {
      removeLinkOnly(resolve(wtPath, rel))
    }
    for (const rel of WT_RESIDUE_SHELL_DIRS) {
      rmdirEmpty(resolve(wtPath, rel))
    }
    // 链接移除失败的窄情况：跳过 recursive 总清扫（跟随 = 灾难），残留交给收口兜底
    if (WT_RESIDUE_LINK_PATHS.some((rel) => isLink(resolve(wtPath, rel)))) {
      log.warn('residue cleanup aborted — junction still present, recursive sweep skipped', {
        wtPath,
      })
      return
    }
    if (existsSync(wtPath)) {
      rmSync(wtPath, { recursive: true, force: true })
    }
    log.info('session worktree residue cleaned', { wtPath })
  } catch (err: any) {
    log.warn('worktree residue cleanup failed', { error: err.message })
  }
}

/**
 * child 是否等于或位于 parent 目录内（removeSessionWorktree 自指守卫专用）。
 *
 * 实现：path.relative 取相对关系——等于 → ''；位于其内 → 不以 '..' 开头且非绝对
 * 路径（不同盘符的相对结果为绝对形式）；win32 下 Node 的 path.relative 按大小写
 * 不敏感比较，天然覆盖 D:\ 与 d:\ 的盘符大小写差异。位于其外/兄弟/上级 → 以 '..'
 * 开头或绝对 → false。
 */
export function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * 销毁会话 worktree（店长收口后调用）：git worktree remove + 物理残留清理 + 删分支。
 * 失败静默（残留目录不阻塞主链，收口流程兜底）。
 *
 * 自指守卫（店长 2026-08-20 实锤）：会话隔离把 cwd 透传给 agent CLI（socketio
 * → claude/dsh 适配器），收口自己会话时 process.cwd() 正落在被收口的 worktree 内——
 * 收口者拆自己住的房子。此时物理残留清理（cleanupWorktreeResidue 的 rmSync 递归
 * 删除）会删掉当前进程正站着的目录树：Windows cwd 句柄无 FILE_SHARE_DELETE，目录
 * 被删后进程不抛错、后续一切文件 IO（日志/回复落库）悬空 → 僵尸进程占 slot、FIFO
 * 全排队。cwd 等于或位于 wtPath 内 → 只做 git 层 worktree remove + 删分支，跳过
 * 物理残留清理（残留留给进程退出后的收口兜底：removeStaleWorktreeDir 重建路径 /
 * 下次成功收口）；cwd 不在其内 → 行为与守卫前完全一致。
 */
export function removeSessionWorktree(sessionId: string): void {
  const mainRoot = getMainRepoRoot()
  if (!mainRoot) return
  const shortId = sessionShortId(sessionId)
  if (!shortId) return
  const branch = sessionBranch(shortId)
  const wtPath = sessionWorktreePath(mainRoot, shortId)
  const cwdInside = isPathInside(wtPath, resolve(process.cwd()))
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
    }
    // 自指守卫：cwd 在被收口的 worktree 内 → 物理删除会删掉当前进程正站着的目录树，
    // 跳过（残留交给进程退出后的收口兜底）；否则走既有清理——
    // git remove 成功/失败都走物理残留清理：成功路径留下 junction（gitignored，
    // git 不删）；失败路径强制清目录（旧 rmSync 兜底语义并入，且不再有跟随风险）
    if (cwdInside) {
      log.warn('skip residue cleanup — cwd inside session worktree', { sessionId, wtPath })
    } else {
      cleanupWorktreeResidue(wtPath)
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
