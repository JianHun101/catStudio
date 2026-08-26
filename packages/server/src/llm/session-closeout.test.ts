/**
 * session-closeout 收口器测试。
 *
 * 形态：真实临时 git 仓库（mkdtemp + git init + chdir），全真实 git——
 * 收口器复用 git-utils 的 ensureSessionWorktree/removeSessionWorktree，
 * 这些函数内部 execFileSync 全真实执行（与 git-utils.test.ts 同款）。
 *
 * @internal step 签名接收 mainRoot（由 closeoutSession preflight 探测一次传入）
 * ——测试直调时传 gitUtils.getMainRepoRoot()（= 临时仓库根），与收口器契约一致。
 *
 * 覆盖：幂等重跑（分支不存在/目录不存在 skip）、cwd 无关（chdir 到
 * worktree 内调用，git 命令仍落主仓库根）、自指守卫（cwd 在被收口
 * worktree 内 → shell 不悬空 + checkoutDev 复位 cwd）、inspect 探针字段、
 * 非 git 仓库 preflight 失败。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let closeout: typeof import('./session-closeout.js')
let gitUtils: typeof import('./git-utils.js')

const origCwd = process.cwd()
let tmp: string
const wtDirs: string[] = []

/** 清理 git 环境变量（worktree 内 hook 注入的 GIT_DIR 会劫持 cwd 探测） */
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

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** 测试直调 @internal step 时传的 mainRoot（= 临时仓库根，即主仓库根） */
function mainRoot(): string {
  return gitUtils.getMainRepoRoot()!
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'session-closeout-test-'))
  execSync('git init', { cwd: tmp, env: cleanGitEnv(), stdio: 'ignore' })
  execSync('git config user.name test', { cwd: tmp, env: cleanGitEnv(), stdio: 'ignore' })
  execSync('git config user.email test@test.local', {
    cwd: tmp,
    env: cleanGitEnv(),
    stdio: 'ignore',
  })
  execSync('git checkout -b dev', { cwd: tmp, env: cleanGitEnv(), stdio: 'ignore' })
  writeFileSync(resolve(tmp, 'a.txt'), 'init', 'utf-8')
  git('add -A')
  git('commit -m init')

  process.chdir(tmp)
  closeout = await import('./session-closeout.js')
  gitUtils = await import('./git-utils.js')
})

afterAll(() => {
  process.chdir(origCwd)
  for (const dir of wtDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 兜底清理失败忽略 */
    }
  }
  rmSync(tmp, { recursive: true, force: true })
})

/** 建会话 worktree 并在其中落一个独立 commit（dev 落后于会话分支的通用前置）。
 *  内容 = 会话 id（唯一——上一个会话合进 dev 后 change.txt 已在 dev HEAD 快照里，
 *  内容不唯一则 commit 判定无改动） */
function makeSessionCommit(id: string): string {
  const path = gitUtils.ensureSessionWorktree(id)!
  wtDirs.push(path)
  writeFileSync(resolve(path, 'change.txt'), `change ${id}`, 'utf-8')
  const hash = gitUtils.gitCommit(`catstudy [${id}]`, { cwd: path })
  expect(hash).toBeTruthy()
  return path
}

describe('inspectCloseout（只读探针）', () => {
  it('无分支无 worktree → branch/worktree/merge/gate 全 false（onDev=主工作区状态）', () => {
    const st = closeout.inspectCloseout('inspect-none-9999')
    expect(st.branchExists).toBe(false)
    expect(st.worktreeExists).toBe(false)
    expect(st.mergedIntoDev).toBe(false)
    expect(st.gateSynced).toBe(false)
    // onDev 是主工作区当前分支状态，与「会话是否存在」无关——主工作区在 dev 即 true
    expect(st.onDev).toBe(true)
  })

  it('会话分支存在但未合并 → branchExists/worktreeExists=true、mergedIntoDev=false', () => {
    const id = 'inspect-mk-0001'
    makeSessionCommit(id)
    const st = closeout.inspectCloseout(id)
    expect(st.branchExists).toBe(true)
    expect(st.worktreeExists).toBe(true)
    expect(st.mergedIntoDev).toBe(false)
    expect(st.onDev).toBe(true)
  })

  it('分支已合进 dev → mergedIntoDev=true', () => {
    const id = 'inspect-mk-0001'
    expect(closeout.mergeSession(mainRoot(), id)).toEqual({ ok: true })
    const st = closeout.inspectCloseout(id)
    expect(st.mergedIntoDev).toBe(true)
  })
})

describe('mergeSession（@internal step ①）', () => {
  it('会话分支存在且 dev 落后 → ff-only 合并成功（dev 前进、分支保留）', () => {
    const id = 'merge-mk-00001'
    makeSessionCommit(id)
    const devBefore = git('rev-parse HEAD')
    const r = closeout.mergeSession(mainRoot(), id)
    expect(r).toEqual({ ok: true })
    expect(git('rev-parse HEAD')).not.toBe(devBefore)
    // merge 不删分支（删分支是 removeWorktree 的职责）
    expect(git('branch --list session/merge-mk')).toContain('session/merge-mk')
  })

  it('已合并后重跑 → 仍 ok（Already up to date 幂等）', () => {
    const r = closeout.mergeSession(mainRoot(), 'merge-mk-00001')
    expect(r).toEqual({ ok: true })
  })

  it('分支不存在 → null（幂等续跑）', () => {
    expect(closeout.mergeSession(mainRoot(), 'merge-none-0001')).toBeNull()
  })
})

describe('removeWorktree（@internal step ②）', () => {
  it('目录存在 → 删目录 + 删分支，返回 ok', () => {
    const id = 'rm-mk-000001'
    const path = gitUtils.ensureSessionWorktree(id)!
    wtDirs.push(path)
    expect(existsSync(path)).toBe(true)
    const r = closeout.removeWorktree(mainRoot(), id)
    expect(r).toEqual({ ok: true })
    expect(existsSync(path)).toBe(false)
    expect(git('branch --list session/rm-mk-00')).not.toContain('session/rm-mk-00')
  })

  it('目录不存在 → null（幂等续跑）', () => {
    expect(closeout.removeWorktree(mainRoot(), 'rm-none-00001')).toBeNull()
  })
})

describe('writeGate（@internal step ③）', () => {
  it('写 .push-gate = 主仓库当前 HEAD', () => {
    const head = git('rev-parse HEAD')
    const r = closeout.writeGate(mainRoot(), 'gate-00000001')
    expect(r).toEqual({ ok: true })
    expect(readFileSync(resolve(tmp, '.push-gate'), 'utf8').trim()).toBe(head)
  })

  it('同值幂等：不重写（mtime 不变）', () => {
    closeout.writeGate(mainRoot(), 'gate-00000001')
    const gatePath = resolve(tmp, '.push-gate')
    const m1 = statSync(gatePath).mtimeMs
    sleepSync(5)
    const r = closeout.writeGate(mainRoot(), 'gate-00000001')
    expect(r).toEqual({ ok: true })
    expect(statSync(gatePath).mtimeMs).toBe(m1)
  })

  it('gate 值漂移 → 重写回 HEAD（门禁始终与 dev 同步）', () => {
    writeFileSync(resolve(tmp, '.push-gate'), 'deadbeef', 'utf-8')
    const head = git('rev-parse HEAD')
    const r = closeout.writeGate(mainRoot(), 'gate-00000001')
    expect(r).toEqual({ ok: true })
    expect(readFileSync(resolve(tmp, '.push-gate'), 'utf8').trim()).toBe(head)
  })
})

describe('checkoutDev（@internal step ④）', () => {
  it('已在 dev → no-op ok', () => {
    const r = closeout.checkoutDev(mainRoot(), 'chk-none-0001')
    expect(r).toEqual({ ok: true })
    expect(git('branch --show-current')).toBe('dev')
  })

  it('不在 dev → checkout dev 切回', () => {
    git('checkout -b other-branch')
    expect(git('branch --show-current')).toBe('other-branch')
    const r = closeout.checkoutDev(mainRoot(), 'chk-none-0001')
    expect(r).toEqual({ ok: true })
    expect(git('branch --show-current')).toBe('dev')
  })

  it('cwd 位于已收口 worktree 内 → 复位到主仓库根（shell 不悬空）', () => {
    const id = 'chk-cwd-00001'
    const path = gitUtils.ensureSessionWorktree(id)!
    wtDirs.push(path)
    const orig = process.cwd()
    const mr = mainRoot() // 在 cwd 被半删 worktree 破坏前取（真实场景 closeoutSession preflight 一次探测）
    try {
      process.chdir(path)
      // 先收掉 worktree（自指守卫：cwd 在内 → 物理残留跳过，目录壳保留）
      expect(closeout.removeWorktree(mr, id)).toEqual({ ok: true })
      expect(closeout.checkoutDev(mr, id)).toEqual({ ok: true })
      expect(resolve(process.cwd())).toBe(resolve(tmp))
    } finally {
      process.chdir(orig)
    }
  })
})

describe('closeoutSession（一键收口）', () => {
  it('全流程：merge → 删 worktree → 写 gate → checkout dev，状态全部达成', () => {
    const id = 'co-full-00001'
    makeSessionCommit(id)
    const r = closeout.closeoutSession(id)
    expect(r).toEqual({ ok: true, step: 'checkout' })
    expect(git('branch --list session/co-full-0')).not.toContain('session/co-full-0')
    expect(git('branch --show-current')).toBe('dev')
    const head = git('rev-parse HEAD')
    expect(readFileSync(resolve(tmp, '.push-gate'), 'utf8').trim()).toBe(head)
    const st = closeout.inspectCloseout(id)
    expect(st.branchExists).toBe(false)
    expect(st.worktreeExists).toBe(false)
    expect(st.gateSynced).toBe(true)
    expect(st.onDev).toBe(true)
  })

  it('幂等重跑：再次 closeoutSession → ok:true 不报错（中断续跑语义）', () => {
    const r = closeout.closeoutSession('co-full-00001')
    expect(r).toEqual({ ok: true, step: 'checkout' })
  })

  it('在 worktree 内被调（自指场景）：merge 落主仓库根、cwd 复位、分支删除', () => {
    const id = 'co-self-00001'
    const path = makeSessionCommit(id)
    const orig = process.cwd()
    try {
      process.chdir(path)
      const r = closeout.closeoutSession(id)
      expect(r).toEqual({ ok: true, step: 'checkout' })
      expect(resolve(process.cwd())).toBe(resolve(tmp))
      expect(git('branch --list session/co-self-0')).not.toContain('session/co-self-0')
      expect(readFileSync(resolve(tmp, '.push-gate'), 'utf8').trim()).toBe(git('rev-parse HEAD'))
    } finally {
      process.chdir(orig)
    }
  })

  it('非 git 仓库 → preflight fail（不抛错、step 定位）', () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'session-closeout-notrepo-'))
    const orig = process.cwd()
    try {
      process.chdir(notRepo)
      const r = closeout.closeoutSession('co-notrepo-01')
      expect(r.ok).toBe(false)
      expect(r.step).toBe('preflight')
      expect(r.error).toBeTruthy()
    } finally {
      process.chdir(orig)
      rmSync(notRepo, { recursive: true, force: true })
    }
  })

  it('主仓库不在 dev 分支 → preflight 拒绝（不合并、不删 worktree/分支、不写 gate）', () => {
    const id = 'co-offdev-01'
    const path = makeSessionCommit(id)
    const devHead = git('rev-parse HEAD')
    git('checkout -b not-dev-branch')
    try {
      const r = closeout.closeoutSession(id)
      expect(r.ok).toBe(false)
      expect(r.step).toBe('preflight')
      expect(r.error).toContain('非 dev')
      // 守卫在 preflight 最前：merge/worktree/gate/checkout 全未触碰
      expect(git('rev-parse HEAD')).toBe(devHead)
      const branch = gitUtils.sessionBranch(gitUtils.sessionShortId(id))
      expect(git(`branch --list ${branch}`)).toContain(branch)
      expect(existsSync(path)).toBe(true)
      expect(git('branch --show-current')).toBe('not-dev-branch')
    } finally {
      git('checkout dev')
    }
  })

  it('detached HEAD → preflight 拒绝（无 checkout 分支，收口目标不定）', () => {
    const id = 'co-detach-01'
    makeSessionCommit(id)
    git('checkout --detach HEAD')
    try {
      const r = closeout.closeoutSession(id)
      expect(r.ok).toBe(false)
      expect(r.step).toBe('preflight')
      expect(r.error).toContain('detached')
      expect(git('rev-parse --abbrev-ref HEAD')).toBe('HEAD')
    } finally {
      git('checkout dev')
    }
  })
})
