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

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync, execSync, spawn } from 'node:child_process'
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

// ─── removeSessionWorktree 自指守卫测试专用 mock ──────────
// 只包两层、其余全走真实：
// ① node:fs 的 rmSync → vi.fn 包裹（代理真实实现），用于断言「物理删除是否被触发」；
// ② node:child_process 的 execFileSync → 开关包裹（mockFailWorktreeRemove=true 时
//    对 git worktree remove 抛错，模拟「目录被当前进程 cwd 持有 → git 删除失败」的
//    Windows 真实语义——收口者正住在 worktree 里时 git remove 必然 EPERM），其余调用
//    全量委托真实实现。两处均为代理而非替换，既有用例行为零变化。
let mockFailWorktreeRemove = false

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, rmSync: vi.fn(actual.rmSync) }
})

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFileSync: ((...args: any[]) => {
      if (
        mockFailWorktreeRemove &&
        args[0] === 'git' &&
        Array.isArray(args[1]) &&
        args[1][0] === 'worktree' &&
        args[1][1] === 'remove'
      ) {
        throw new Error('simulated worktree remove failure (cwd held)')
      }
      return (actual.execFileSync as any)(...args)
    }) as typeof import('node:child_process').execFileSync,
  }
})

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

  it('ensureSessionWorktree: 无 .git 残留目录（含 junction）→ 链接先行重建，目标 sentinel 完好', () => {
    // 复刻真实残留形态：root + 包级共 5 链接（同 wt-rm-junc-1 用例），
    // 但目录无 .git 标记——上次收口 git 层已清、物理层残留后下次重建的形态
    const nmSrc = resolve(tmp, 'node_modules')
    mkdirSync(nmSrc, { recursive: true })
    writeFileSync(resolve(nmSrc, 'sentinel.txt'), 'alive-root', 'utf-8')
    const pkgTargets = {
      root: resolve(tmp, 'pkg-rebuild-root'),
      server: resolve(tmp, 'pkg-rebuild-server'),
      shared: resolve(tmp, 'pkg-rebuild-shared'),
      web: resolve(tmp, 'pkg-rebuild-web'),
    }
    for (const [name, dir] of Object.entries(pkgTargets)) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(resolve(dir, 'sentinel.txt'), `alive-${name}`, 'utf-8')
    }

    const shortId = 'wt-rebld'
    const path = wtPath(shortId)
    mkdirSync(path, { recursive: true })
    makeJunction(resolve(path, 'node_modules'), nmSrc)
    mkdirSync(resolve(path, 'packages'), { recursive: true })
    for (const pkg of ['server', 'shared', 'web']) {
      mkdirSync(resolve(path, 'packages', pkg), { recursive: true })
      makeJunction(
        resolve(path, 'packages', pkg, 'node_modules'),
        pkgTargets[pkg as keyof typeof pkgTargets]
      )
    }
    makeJunction(resolve(path, 'packages', 'node_modules'), pkgTargets.root)

    // 重建路径：ensureSessionWorktree 应清理残留后重建 worktree
    const got = gitUtils.ensureSessionWorktree('wt-rebld-0001')
    expect(got).toBe(path)
    wtDirs.push(path)
    expect(existsSync(resolve(path, '.git'))).toBe(true)
    expect(git('branch --list session/wt-rebld')).toContain('session/wt-rebld')
    // 防跟随核心断言：所有链接目标 sentinel 完好（链接先行清理，不碰目标）
    expect(readFileSync(resolve(nmSrc, 'sentinel.txt'), 'utf-8')).toBe('alive-root')
    for (const [name, dir] of Object.entries(pkgTargets)) {
      expect(readFileSync(resolve(dir, 'sentinel.txt'), 'utf-8')).toBe(`alive-${name}`)
    }
    // 注：tmp 仓库无 .gitignore，node_modules 被前序用例提交进 git——重建时被真实
    // 检出成目录，linkNodeModules 见 dest 已存在而跳过（本 harness 特有，不影响断言）
  })

  it.skipIf(process.platform !== 'win32')(
    'ensureSessionWorktree: EPERM（他进程持深层目录为 cwd）→ 链接仍先清、重试耗尽降级 null',
    () => {
      // 残留目录 + 4 个 junction（root/packages/node_modules + shared/web 包级），
      // 另一进程持 packages/server 为 cwd → 目录整体 rmSync 必 EPERM
      const nmSrc = resolve(tmp, 'node_modules')
      mkdirSync(nmSrc, { recursive: true })
      writeFileSync(resolve(nmSrc, 'sentinel.txt'), 'alive-root', 'utf-8')
      const pkgTargets = {
        root: resolve(tmp, 'pkg-eperm-root'),
        shared: resolve(tmp, 'pkg-eperm-shared'),
        web: resolve(tmp, 'pkg-eperm-web'),
      }
      for (const [name, dir] of Object.entries(pkgTargets)) {
        mkdirSync(dir, { recursive: true })
        writeFileSync(resolve(dir, 'sentinel.txt'), `alive-${name}`, 'utf-8')
      }

      const shortId = 'wt-eperm'
      const path = wtPath(shortId)
      mkdirSync(resolve(path, 'packages'), { recursive: true })
      mkdirSync(resolve(path, 'packages', 'server'), { recursive: true })
      makeJunction(resolve(path, 'node_modules'), nmSrc)
      for (const pkg of ['shared', 'web']) {
        mkdirSync(resolve(path, 'packages', pkg), { recursive: true })
        makeJunction(
          resolve(path, 'packages', pkg, 'node_modules'),
          pkgTargets[pkg as keyof typeof pkgTargets]
        )
      }
      makeJunction(resolve(path, 'packages', 'node_modules'), pkgTargets.root)

      // 持目录为 cwd 的子进程（ready 文件握手确保 chdir 完成）
      const ready = resolve(tmp, 'wt-eperm-ready')
      const holder = spawn(
        process.execPath,
        [
          '-e',
          `process.chdir(${JSON.stringify(resolve(path, 'packages', 'server'))});require('fs').writeFileSync(${JSON.stringify(ready)},'ok');setInterval(()=>{},1000)`,
        ],
        { stdio: 'ignore' }
      )
      const t0 = Date.now()
      while (!existsSync(ready) && Date.now() - t0 < 10000) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
      }
      expect(existsSync(ready)).toBe(true)

      try {
        // EPERM 持续（holder 不退）→ 有限重试耗尽 → 返回 null（error 日志已显式落）
        expect(gitUtils.ensureSessionWorktree('wt-eperm-0001')).toBeNull()
        wtDirs.push(path)
        // 链接先行核心断言：即便目录删不掉，junction 也必须已全部移除
        // （旧实现 rmSync 扫树遇 EPERM 中断，残留链接是否清掉取决于遍历序）
        for (const rel of [
          'node_modules',
          'packages/node_modules',
          'packages/shared/node_modules',
          'packages/web/node_modules',
        ]) {
          expect(existsSync(resolve(path, rel))).toBe(false)
        }
        // 防跟随：所有链接目标 sentinel 完好
        expect(readFileSync(resolve(nmSrc, 'sentinel.txt'), 'utf-8')).toBe('alive-root')
        for (const [name, dir] of Object.entries(pkgTargets)) {
          expect(readFileSync(resolve(dir, 'sentinel.txt'), 'utf-8')).toBe(`alive-${name}`)
        }
        // 失败路径不产生半成品（未注册 worktree、未建分支）
        expect(git('branch --list session/wt-eperm')).not.toContain('session/wt-eperm')
      } finally {
        holder.kill()
      }
    }
  )

  it('linkNodeModules: 根 + 包级 3 条链接齐建（worktree 依赖完整，pre-commit 不挂）', () => {
    // 干净子仓库（.gitignore 排除 node_modules）——主套件 tmp 的根 node_modules
    // 已被前序用例 git add -A 提交进 git，新 worktree 会真实检出成目录，
    // linkNodeModules 见 dest 已存在而跳过，根链接无从测。子仓库内 node_modules
    // 全部 gitignored → worktree add 不检出 → 4 条链接全部由 linkNodeModules 新建
    const subRepo = mkdtempSync(join(tmpdir(), 'git-utils-linknm-'))
    const sub = (cmd: string): string =>
      execSync(`git ${cmd}`, {
        cwd: subRepo,
        env: cleanGitEnv(),
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    const orig = process.cwd()
    try {
      execSync('git init', { cwd: subRepo, env: cleanGitEnv(), stdio: 'ignore' })
      execSync('git config user.name test', { cwd: subRepo, env: cleanGitEnv(), stdio: 'ignore' })
      execSync('git config user.email test@test.local', {
        cwd: subRepo,
        env: cleanGitEnv(),
        stdio: 'ignore',
      })
      writeFileSync(resolve(subRepo, '.gitignore'), 'node_modules/\n', 'utf-8')
      writeFileSync(resolve(subRepo, 'a.txt'), 'init', 'utf-8')
      for (const pkg of ['server', 'shared', 'web']) {
        mkdirSync(resolve(subRepo, 'packages', pkg), { recursive: true })
        writeFileSync(resolve(subRepo, 'packages', pkg, 'index.txt'), pkg, 'utf-8')
      }
      sub('add -A')
      sub('commit -m init')

      // 依赖目录（gitignored → 不入 git）：根 + 三包级，各带 sentinel
      const rootNm = resolve(subRepo, 'node_modules')
      mkdirSync(rootNm, { recursive: true })
      writeFileSync(resolve(rootNm, 'sentinel.txt'), 'alive-root', 'utf-8')
      for (const pkg of ['server', 'shared', 'web']) {
        const dir = resolve(subRepo, 'packages', pkg, 'node_modules')
        mkdirSync(dir, { recursive: true })
        writeFileSync(resolve(dir, 'sentinel.txt'), `alive-${pkg}`, 'utf-8')
      }

      process.chdir(subRepo)
      const path = gitUtils.ensureSessionWorktree('wt-linknm-0001')
      expect(path).toBeTruthy()
      // 4 条链接（根 + 3 包级）全部由 linkNodeModules 建成
      const rels = [
        'node_modules',
        'packages/server/node_modules',
        'packages/shared/node_modules',
        'packages/web/node_modules',
      ]
      for (const rel of rels) {
        const link = resolve(path!, rel)
        expect(existsSync(link)).toBe(true)
        expect(lstatSync(link).isSymbolicLink()).toBe(true)
      }
      // sentinel 透传（读链接目标内容——与 :155 junction 透传用例同语义）
      expect(readFileSync(resolve(path!, 'node_modules', 'sentinel.txt'), 'utf-8')).toBe(
        'alive-root'
      )
      for (const pkg of ['server', 'shared', 'web']) {
        expect(
          readFileSync(resolve(path!, 'packages', pkg, 'node_modules', 'sentinel.txt'), 'utf-8')
        ).toBe(`alive-${pkg}`)
      }
    } finally {
      // 清理：removeSessionWorktree（git 层 + 物理残留）后 chdir 还原 + 删子仓库
      try {
        gitUtils.removeSessionWorktree('wt-linknm-0001')
      } catch {
        /* 忽略清理失败 */
      }
      process.chdir(orig)
      rmSync(subRepo, { recursive: true, force: true })
    }
  })

  // ─── removeSessionWorktree 自指守卫（店长 2026-08-20 实锤：收口者正住在被收口的
  // 会话 worktree 里）──────────────────────────────────
  // 两用例共用「git worktree remove 被模拟为失败」的判定环境（目录必然残留），使
  // 「残留是否被物理清理」成为区分守卫是否生效的唯一可观测信号：
  // 守卫生效（cwd 在内）→ 跳过清理、rmSync 不触发、目录保留；
  // 不生效（cwd 在外）→ 清理照常、rmSync 触发、目录删除。

  it('自指守卫: cwd 位于 worktree 内 → 跳过物理残留清理, rmSync 不触发, 函数不抛错', () => {
    // cwd 模拟为 worktree 根（会话隔离把 cwd 透传给 agent CLI，收口自己会话时
    // process.cwd() 正等于被收口的 worktree 根——店长实例 7531d744）
    const path = gitUtils.ensureSessionWorktree('wt-self-0001')!
    wtDirs.push(path)

    mockFailWorktreeRemove = true
    const rmSyncMock = vi.mocked(rmSync)
    rmSyncMock.mockClear()
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(path)
    try {
      expect(() => gitUtils.removeSessionWorktree('wt-self-0001')).not.toThrow()
      // 自指守卫核心断言：物理残留清理被跳过 → rmSync 一次未触发
      expect(rmSyncMock).not.toHaveBeenCalled()
      // 残留保留（当前进程正站着，等进程退出后收口兜底删除）
      expect(existsSync(path)).toBe(true)
    } finally {
      cwdSpy.mockRestore()
      mockFailWorktreeRemove = false
    }
  })

  it('自指守卫: cwd 在 worktree 外 → 物理残留清理照常, rmSync 触发, 目录删除', () => {
    const path = gitUtils.ensureSessionWorktree('wt-outer-01')!
    wtDirs.push(path)

    mockFailWorktreeRemove = true
    const rmSyncMock = vi.mocked(rmSync)
    rmSyncMock.mockClear()
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmp) // tmp = 主仓库，不在 worktree 内
    try {
      expect(() => gitUtils.removeSessionWorktree('wt-outer-01')).not.toThrow()
      // 守卫不拦：物理残留清理照常执行 → rmSync 触发、目录被删
      expect(rmSyncMock).toHaveBeenCalled()
      expect(existsSync(path)).toBe(false)
    } finally {
      cwdSpy.mockRestore()
      mockFailWorktreeRemove = false
    }
  })
})
