/**
 * git-utils e2e 标记文件守卫测试。
 *
 * gitCommit() 的 CWD 是函数内动态取（getCwd()），不随 import 冻结——
 * 测试 chdir 到临时 git 仓库后调用，所有 git 操作自然落在临时仓库，
 * 不依赖「先 chdir 再 import」的加载顺序（模块缓存下也安全）。
 * 保留 chdir + 动态 import 仅为让测试与模块加载路径清晰。
 *
 * git-utils 所有 execSync 统一带 env: cleanGitEnv()（剔除 GIT_DIR/
 * GIT_INDEX_FILE/GIT_WORK_TREE/GIT_PREFIX）——worktree 内 commit 时 git
 * 会向 hook 注入绝对 GIT_DIR（.git 是文件指针需显式指定仓库位置），
 * env 劫持优先级高于 cwd 探测，不清理则测试的 cwd: tmp 被劫持、
 * fake 提交落真实仓库（店长 2026-08-09 实测实锤）。
 *
 * 覆盖场景：无标记文件 → auto-commit 正常；标记文件存在 → 跳过；
 * 删除标记 → 恢复。验证"文件跨进程"方案，防止回归到环境变量（不跨进程）。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, execSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const origCwd = process.cwd()
let tmp: string
let gitUtils: typeof import('./git-utils.js')

/**
 * 清理 git 环境变量（与 git-utils.ts 的 cleanGitEnv 同款）。
 * pre-commit hook 内 git 注入 GIT_DIR（worktree 场景为绝对路径），
 * 测试自身的 execSync 若不清理，git init/config/add/commit 会被劫持
 * 到真实仓库（reinit 写 core.bare、config 写共享 config、提交落真实分支）。
 */
function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.GIT_DIR
  delete env.GIT_INDEX_FILE
  delete env.GIT_WORK_TREE
  delete env.GIT_PREFIX
  return env
}

function git(cmd: string): string {
  return execSync(`git ${cmd}`, {
    cwd: tmp,
    env: cleanGitEnv(),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'git-utils-test-'))
  execSync('git init', { cwd: tmp, env: cleanGitEnv(), stdio: 'ignore' })
  execSync('git config user.name test', { cwd: tmp, env: cleanGitEnv(), stdio: 'ignore' })
  execSync('git config user.email test@test.local', {
    cwd: tmp,
    env: cleanGitEnv(),
    stdio: 'ignore',
  })
  writeFileSync(resolve(tmp, 'a.txt'), 'init', 'utf-8')
  git('add -A')
  git('commit -m init')

  // CWD 动态取（getCwd() 每次调用时 resolve）→ chdir 后调用即落在 tmp；
  // chdir 只是让测试上下文与临时仓库一致，不再有加载顺序依赖
  process.chdir(tmp)
  gitUtils = await import('./git-utils.js')
})

afterAll(() => {
  process.chdir(origCwd)
  rmSync(tmp, { recursive: true, force: true })
})

describe('gitCommit e2e marker guard', () => {
  it('无标记文件时 auto-commit 正常执行', () => {
    writeFileSync(resolve(tmp, 'b.txt'), 'b', 'utf-8')
    const hash = gitUtils.gitCommit('normal commit')
    expect(hash).toBeTruthy()
    expect(git('log -1 --pretty=%B')).toContain('normal commit')
  })

  it('标记文件存在时跳过 auto-commit，且不产生新 commit', () => {
    mkdirSync(resolve(tmp, 'scripts'), { recursive: true })
    writeFileSync(resolve(tmp, 'scripts/.e2e-testing'), 'e2e in progress', 'utf-8')
    writeFileSync(resolve(tmp, 'c.txt'), 'c', 'utf-8')

    const hash = gitUtils.gitCommit('should be skipped')
    expect(hash).toBeNull()
    expect(git('log -1 --pretty=%B')).not.toContain('should be skipped')
  })

  it('删除标记文件后恢复 auto-commit', () => {
    rmSync(resolve(tmp, 'scripts/.e2e-testing'))
    writeFileSync(resolve(tmp, 'd.txt'), 'd', 'utf-8')
    const hash = gitUtils.gitCommit('resume commit')
    expect(hash).toBeTruthy()
    expect(git('log -1 --pretty=%B')).toContain('resume commit')
  })
})

// ─── 会话 worktree（隔离实证）──────────────────────
// 临时仓库 chdir 语义：git-utils 的 getCwd() = process.cwd() = tmp（beforeAll
// 已 chdir）。worktree 目录 = tmp 的兄弟目录 catStudy-sessions/<8位id>——
// os tmpdir 下可写，测试结束由 removeSessionWorktree + afterAll 兜底清理。
// Windows junction 实测项：mklink /J 不需要管理员权限，CI/本机可跑。

describe('session worktree', () => {
  const WT_DIR_PREFIX = 'catStudy-sessions'
  const wtDirs: string[] = []

  function wtPath(shortId: string): string {
    return resolve(tmp, '..', WT_DIR_PREFIX, shortId)
  }

  afterAll(() => {
    // 兜底清理（removeSessionWorktree 已尽力，残余目录 force 删）
    for (const dir of wtDirs) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* 忽略 */
      }
    }
  })

  it('ensureSessionWorktree: 建分支 + worktree + node_modules 链接，返回路径', () => {
    const path = gitUtils.ensureSessionWorktree('11111111-aaaa')
    expect(path).toBeTruthy()
    expect(path).toBe(wtPath('11111111')) // 8 位 short id
    expect(existsSync(path!)).toBe(true)
    wtDirs.push(path!)
    // 分支存在（共享 refs 可见）
    const branch = git('branch --list session/11111111')
    expect(branch).toContain('session/11111111')
  })

  it('幂等：目录已存在 → 复用同路径，不重复建', () => {
    const path1 = gitUtils.ensureSessionWorktree('11111111-aaaa')
    const path2 = gitUtils.ensureSessionWorktree('11111111-aaaa')
    expect(path2).toBe(path1)
  })

  it('node_modules junction 实测：worktree 内可见主仓库依赖（junction 透传）', () => {
    // 主仓库建 node_modules + 标记文件
    const nmSrc = resolve(tmp, 'node_modules')
    mkdirSync(nmSrc, { recursive: true })
    writeFileSync(resolve(nmSrc, 'marker.txt'), 'linked', 'utf-8')

    const path = gitUtils.ensureSessionWorktree('22222222-bbbb')
    wtDirs.push(path!)
    const nmDest = resolve(path!, 'node_modules')
    // junction/symlink 成功 → 目录存在且内容透传（直接读链接目标）
    expect(existsSync(nmDest)).toBe(true)
    const marker = readFileSync(resolve(nmDest, 'marker.txt'), 'utf-8')
    expect(marker).toBe('linked')
  })

  it('getSessionWorktreePath: 无 worktree → null；有 → 路径', () => {
    expect(gitUtils.getSessionWorktreePath('99999999-zzzz')).toBeNull()
    const path = gitUtils.ensureSessionWorktree('33333333-cccc')
    wtDirs.push(path!)
    expect(gitUtils.getSessionWorktreePath('33333333-cccc')).toBe(path)
  })

  it('非 git 仓库 → ensureSessionWorktree 返回 null（降级）', () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'git-utils-notrepo-'))
    const orig = process.cwd()
    try {
      process.chdir(notRepo)
      expect(gitUtils.ensureSessionWorktree('wt-session-0004')).toBeNull()
    } finally {
      process.chdir(orig)
      rmSync(notRepo, { recursive: true, force: true })
    }
  })

  it('验收1 核心：双会话 worktree 改同一文件 → 各自 commit 只含各自改动', () => {
    // 双会话各建 worktree（同仓库、同源 HEAD，改同一文件）
    const wtA = gitUtils.ensureSessionWorktree('wt-iso-a-0001')!
    const wtB = gitUtils.ensureSessionWorktree('wt-iso-b-0002')!
    wtDirs.push(wtA, wtB)

    const shared = resolve(tmp, 'shared.txt')
    writeFileSync(shared, 'base\n', 'utf-8')
    git('add -A')
    git('commit -m base-shared')

    // A 会话在 A worktree 改 shared.txt
    writeFileSync(resolve(wtA, 'shared.txt'), 'base\nA change\n', 'utf-8')
    gitUtils.gitCommit('catstudy [wt-iso-a]', { cwd: wtA })
    // B 会话在 B worktree 改同一文件（从各自快照改，互不可见对方改动）
    writeFileSync(resolve(wtB, 'shared.txt'), 'base\nB change\n', 'utf-8')
    gitUtils.gitCommit('catstudy [wt-iso-b]', { cwd: wtB })

    // A 分支的 commit 只含 A 改动（diff 不含 B change）
    const aDiff = execSync('git show --unified=0 HEAD -- shared.txt', {
      cwd: wtA,
      env: cleanGitEnv(),
      encoding: 'utf-8',
    })
    expect(aDiff).toContain('A change')
    expect(aDiff).not.toContain('B change')
    // B 分支同理
    const bDiff = execSync('git show --unified=0 HEAD -- shared.txt', {
      cwd: wtB,
      env: cleanGitEnv(),
      encoding: 'utf-8',
    })
    expect(bDiff).toContain('B change')
    expect(bDiff).not.toContain('A change')
    // 主工作区 dev 分支不受影响（无会话提交内容）
    const devLog = git('log --oneline --all --grep="wt-iso-a"')
    expect(devLog).toContain('catstudy [wt-iso-a]')
    const devDiff = execSync('git show --unified=0 HEAD -- shared.txt', {
      cwd: tmp,
      env: cleanGitEnv(),
      encoding: 'utf-8',
    })
    expect(devDiff).not.toContain('A change')
    expect(devDiff).not.toContain('B change')
  })

  it('removeSessionWorktree: 删目录 + 删分支', () => {
    const path = gitUtils.ensureSessionWorktree('wt-rm-000001')!
    wtDirs.push(path)
    expect(existsSync(path)).toBe(true)
    gitUtils.removeSessionWorktree('wt-rm-000001')
    expect(existsSync(path)).toBe(false)
    const branch = git('branch --list session/wt-rm-00')
    expect(branch).not.toContain('session/wt-rm-00')
  })

  /** 按 linkNodeModules 同款手法建链接：win32 mklink /J（junction，免管理员），非 win32 symlink */
  function makeJunction(linkPath: string, targetPath: string): void {
    if (process.platform === 'win32') {
      execFileSync('cmd', ['/c', 'mklink', '/J', linkPath, targetPath], { stdio: 'ignore' })
    } else {
      symlinkSync(targetPath, linkPath, 'junction')
    }
  }

  it('removeSessionWorktree: junction 物理残留清理 + 防跟随（目标 sentinel 完好）', () => {
    // root junction 目标 = 主仓库 node_modules（linkNodeModules 建，指向 tmp 的 node_modules）
    const nmSrc = resolve(tmp, 'node_modules')
    mkdirSync(nmSrc, { recursive: true })
    writeFileSync(resolve(nmSrc, 'sentinel.txt'), 'alive-root', 'utf-8')
    // 包级 junction 目标（复刻店长实测的真实残留形态：packages/*/node_modules + packages/node_modules）
    const pkgTargets = {
      root: resolve(tmp, 'pkg-nm-root'),
      server: resolve(tmp, 'pkg-nm-server'),
      shared: resolve(tmp, 'pkg-nm-shared'),
      web: resolve(tmp, 'pkg-nm-web'),
    }
    for (const [name, dir] of Object.entries(pkgTargets)) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(resolve(dir, 'sentinel.txt'), `alive-${name}`, 'utf-8')
    }

    const path = gitUtils.ensureSessionWorktree('wt-rm-junc-1')!
    wtDirs.push(path)
    // 注意：本套件 tmp 仓库无 .gitignore，前面用例的 git add -A 把 tmp/node_modules
    // 提交进了 git → worktree add 会把它以真实目录检出，linkNodeModules 见 dest 已存在
    // 而跳过。本用例要复刻真实残留形态（链接），先删检出的真实目录再按 linkNodeModules
    // 同款手法建 root 链接（win32 mklink /J junction）
    const wtNm = resolve(path, 'node_modules')
    if (existsSync(wtNm)) rmSync(wtNm, { recursive: true, force: true })
    makeJunction(wtNm, nmSrc)
    expect(lstatSync(wtNm).isSymbolicLink()).toBe(true)
    // 复刻真实残留：包级链接 + 空壳目录
    mkdirSync(resolve(path, 'packages'), { recursive: true })
    for (const pkg of ['server', 'shared', 'web']) {
      mkdirSync(resolve(path, 'packages', pkg), { recursive: true })
      makeJunction(
        resolve(path, 'packages', pkg, 'node_modules'),
        pkgTargets[pkg as keyof typeof pkgTargets]
      )
    }
    makeJunction(resolve(path, 'packages', 'node_modules'), pkgTargets.root)

    gitUtils.removeSessionWorktree('wt-rm-junc-1')

    // 目录清空 + 分支删除
    expect(existsSync(path)).toBe(false)
    const branch = git('branch --list session/wt-rm-ju')
    expect(branch).not.toContain('session/wt-rm-ju')
    // 防跟随核心断言：所有链接目标 sentinel 完好（跟随 = 全灭 = 灾难）
    expect(readFileSync(resolve(nmSrc, 'sentinel.txt'), 'utf-8')).toBe('alive-root')
    for (const [name, dir] of Object.entries(pkgTargets)) {
      expect(readFileSync(resolve(dir, 'sentinel.txt'), 'utf-8')).toBe(`alive-${name}`)
    }
  })
})
