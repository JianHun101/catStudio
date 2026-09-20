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

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFileSync, execSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  createIsolatedRepoRoot,
  removeIsolatedRepoRoot,
  type IsolatedRepoRoot,
} from '../test-helpers.js'

// ═══ 边界 mock（真实临时仓库 / 真实 git 全保留，只换日志这一个边界）═══
//
// 票 G5 的交付面之一就是「preflight 日志含陈旧清单」——**可观测面就是那条 info/warn**。
// 不 mock 就只能断言「收口没炸」，那测的是鲁棒性，不是可见性那条交付本身
// （同 `serial.test.ts` 抬 warn 那条的取法）。
const { logInfo, logWarn } = vi.hoisted(() => ({ logInfo: vi.fn(), logWarn: vi.fn() }))
vi.mock('../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: logInfo, warn: logWarn, error: vi.fn() }),
  setLogLevel: vi.fn(),
  getLogLevel: vi.fn(() => 'error'),
}))

let closeout: typeof import('./session-closeout.js')
let gitUtils: typeof import('./git-utils.js')

const origCwd = process.cwd()
/** 临时仓库夹具（壳进程唯一，见 `createIsolatedRepoRoot`）——收口器建的会话 worktree
 *  全落 `<壳>/catStudy-sessions/*`，跨进程不再对撞 */
let repoRoot: IsolatedRepoRoot
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
  repoRoot = createIsolatedRepoRoot('session-closeout-test-')
  tmp = repoRoot.repo
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
  // 删**壳**（连 `<壳>/catStudy-sessions/*` 一起，含未登记进 wtDirs 的）
  removeIsolatedRepoRoot(repoRoot)
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

// ══════════════════════════════════════════════════════════════════
// T-2 Phase I 新 step：fanInCats（⓪）/ reclaimCats（②′）
//   接线与 fan-in/回收**必须同批**（票面 §结论-2）：只把 CLI cwd 分派到猫 worktree
//   而不接 fan-in ⇒ 猫的提交停在猫分支，收口仍只合 `session/<sid8>`（停在分叉点时
//   `--ff-only` 输出 `Already up to date.` 且**退出码 0**）⇒ 照样删 worktree 与分支
//   ⇒ 猫的提交**永远没进过任何地方**（E5 静默丢活）。
// ══════════════════════════════════════════════════════════════════

describe('fanInCats / reclaimCats（T-2 Phase I 新 step）', () => {
  const CAT_A = { id: 'agent-cat-a', name: '暹罗猫' }
  const CAT_B = { id: 'agent-cat-b', name: '布偶猫' }

  /** 参数数组走 execFileSync（含中文分支名，不经 shell 引号解析） */
  function gitArgs(args: string[], cwd = tmp): string {
    return execFileSync('git', args, {
      cwd,
      env: cleanGitEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  }

  /**
   * 建集成分支 + 一只猫的 worktree，并在猫树上落一笔真提交。
   *
   * **沿用 `git branch` 的失败态**（分支已存在 ⇒ 非零退出）：本组各用例的 id 取
   * **恰好 8 位**（`sessionShortId` 只取前 8 位）且互不相同——这是刻意的，
   * 两个 id 若前 8 位相同就会共用集成分支，前一格留下的分支会让这一格**在夹具阶段
   * 就红**（报「Command failed: git branch ...」，看起来像生产 bug，其实是串场）。
   */
  function makeCatCommit(id: string, cat: { id: string; name: string }): string {
    const shortId = gitUtils.sessionShortId(id)
    gitArgs(['branch', gitUtils.sessionBranch(shortId)])
    const catWt = gitUtils.ensureCatWorktree(id, cat.id, cat.name)!
    expect(catWt, '集成分支在 ⇒ 猫 worktree 应建得出').toBeTruthy()
    wtDirs.push(catWt)
    // 内容**必须带 id**（与本文件 `makeSessionCommit` 的理由同源）：上一格收口后
    // dev 已含同名同内容的文件，而本格的集成分支从 dev 分叉 ⇒ 不唯一则「无改动」，
    // `gitCommit` 返回 null（实测踩过：V5 拿到 V4 的 merge commit 当 HEAD、status 空）
    writeFileSync(resolve(catWt, `from-${cat.name}.txt`), `${cat.name} 的产出 ${id}\n`, 'utf-8')
    const hash = gitUtils.gitCommit(`catstudy [${id}]`, { cwd: catWt })
    // 失败时把现场一并报出来：这个夹具一旦红，症状（`expected null to be truthy`）
    // 与成因（无改动？树不可达？）离得很远，不带读数会白烧一轮排查
    expect(
      hash,
      `gitCommit 应产生提交；实际 status=${JSON.stringify(gitArgs(['status', '--porcelain'], catWt))} head=${gitArgs(['log', '-1', '--format=%s'], catWt)}`
    ).toBeTruthy()
    return catWt
  }

  it('无猫分支 ⇒ null（空集是合法状态；不为一次空 fan-in 现建会话 worktree）', () => {
    const id = 'catn0001'
    const shortId = gitUtils.sessionShortId(id)
    expect(closeout.fanInCats(mainRoot(), id)).toBeNull()
    // 「不现建」不是推论——它同时避免了为无事发生的会话造出目录
    expect(existsSync(gitUtils.sessionWorktreePath(mainRoot(), shortId))).toBe(false)
  })

  it('V4 · 猫的改动经 fan-in 落到 dev（cat-file 读**实际内容**）+ 猫树与猫分支被回收', () => {
    const id = 'catf0001'
    const shortId = gitUtils.sessionShortId(id)
    const catWt = makeCatCommit(id, CAT_A)

    const r = closeout.closeoutSession(id)
    expect(r).toEqual({ ok: true, step: 'checkout' })

    // V4：退出码 0 从来不是判据（E5 的教训）——读 blob 本身
    expect(gitArgs(['cat-file', '-p', `dev:from-${CAT_A.name}.txt`])).toBe(
      `${CAT_A.name} 的产出 ${id}`
    )
    // 回收：猫 worktree 目录与猫分支都不在了（已合进 dev ⇒ 允许回收）
    expect(existsSync(catWt)).toBe(false)
    expect(gitArgs(['branch', '--list', gitUtils.catBranch(shortId, CAT_A.name)])).toBe('')
    expect(gitArgs(['branch', '--list', gitUtils.sessionBranch(shortId)])).toBe('')
  })

  it('V6 · reclaimCats：未合进 dev 的猫分支**必须留存**（步骤级接 D2）', () => {
    const id = 'catk0001'
    const shortId = gitUtils.sessionShortId(id)
    // 猫分支上必须有**超出 dev 的提交**——否则它本就等于 dev 的祖先，被判「已合」
    // 而回收掉（那是正确行为，不是本格要证的「未合留存」）
    const catWt = makeCatCommit(id, CAT_B)
    const orphan = gitUtils.catBranch(shortId, CAT_B.name)

    expect(closeout.reclaimCats(mainRoot(), id)).toEqual({ ok: true })
    // 未合 ⇒ 留存（判据是 `isAncestor(cat, dev)`，不是「存在即删」）
    expect(gitArgs(['branch', '--list', orphan])).not.toBe('')
    expect(existsSync(catWt)).toBe(true)
  })

  it('V5 · 中断态守卫：预置 MERGE_HEAD ⇒ 收口停在 fanin，且 merge / writeGate / checkoutDev 三格均未执行', () => {
    const id = 'catm0001'
    const shortId = gitUtils.sessionShortId(id)
    const catWt = makeCatCommit(id, CAT_A)

    // 会话 worktree 现建（fan-in 的 cwd），并在其 gitdir 里预置 MERGE_HEAD（半合并态）
    const sessWt = gitUtils.ensureSessionWorktree(id)!
    wtDirs.push(sessWt)
    const gitDir = gitArgs(['rev-parse', '--absolute-git-dir'], sessWt)
    const headSha = gitArgs(['rev-parse', 'HEAD'], sessWt)
    writeFileSync(resolve(gitDir, 'MERGE_HEAD'), `${headSha}\n`, 'utf-8')

    const devBefore = gitArgs(['rev-parse', 'HEAD'])
    const gatePath = resolve(tmp, '.push-gate')
    const gateBefore = existsSync(gatePath) ? readFileSync(gatePath, 'utf8') : null

    const orig = process.cwd()
    let r: { ok: boolean; step: string; error?: string }
    try {
      // cwd 落在会话 worktree 内 ⇒ `checkoutDev` 的 cwd 复位**若执行过**必被观测到
      process.chdir(sessWt)
      r = closeout.closeoutSession(id)
      expect(resolve(process.cwd())).toBe(resolve(sessWt)) // 格③：checkoutDev 未执行
    } finally {
      process.chdir(orig)
    }

    expect(r.ok).toBe(false)
    expect(r.step).toBe('fanin')
    expect(r.error).toContain('MERGE_HEAD')

    // 三格分别断言（票面 V5：缺一即「中止了但下游仍跑了」这种半吊子形态）
    expect(gitArgs(['rev-parse', 'HEAD'])).toBe(devBefore) // 格①：merge 未执行
    expect(existsSync(gatePath) ? readFileSync(gatePath, 'utf8') : null).toBe(gateBefore) // 格②：writeGate 未执行
    // 半合并态原样留存，没有任何东西被删（可重跑）
    expect(existsSync(catWt)).toBe(true)
    expect(gitArgs(['branch', '--list', gitUtils.catBranch(shortId, CAT_A.name)])).not.toBe('')

    // 清掉半合并态与本次产物，不串场到后续用例
    rmSync(resolve(gitDir, 'MERGE_HEAD'), { force: true })
    gitUtils.removeSessionWorktree(id)
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

describe('docs/run 陈旧度可见性（票 G5 · 形态乙）', () => {
  const STALE_SLUG = 'g5-stale-fixture'

  /**
   * 在夹具仓库落一个「末次提交 N 天前」的 `docs/run/<slug>/`。
   *
   * 提交时刻由 `GIT_COMMITTER_DATE` **钉死**（不是等出来）——`%cI` 读的就是它。
   * 这条夹具是**真目录 + 真提交**：脚本按 `git log -1 -- <路径>` 判龄，时序造不了假。
   */
  function commitRunDir(slug: string, days: number): void {
    const dir = resolve(tmp, 'docs', 'run', slug)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      resolve(dir, 'tickets.md'),
      '---\ntype: ticket\nstatus: active\n---\n\n# 夹具票\n',
      'utf-8'
    )
    const stamp = new Date(Date.now() - days * 86_400_000).toISOString()
    execSync('git add -A', { cwd: tmp, env: cleanGitEnv(), stdio: 'ignore' })
    execSync('git commit -m "g5 stale fixture"', {
      cwd: tmp,
      env: { ...cleanGitEnv(), GIT_COMMITTER_DATE: stamp, GIT_AUTHOR_DATE: stamp },
      stdio: 'ignore',
    })
  }

  it('验收：preflight 把**真脚本的真读数**打进 info（不抛错、不静默跳过）', () => {
    commitRunDir(STALE_SLUG, 20)
    const id = 'g5-log-00001'
    makeSessionCommit(id)
    logInfo.mockClear()
    logWarn.mockClear()

    const r = closeout.closeoutSession(id)
    expect(r).toEqual({ ok: true, step: 'checkout' })

    const call = logInfo.mock.calls.find((c) => c[0] === 'docs/run 陈旧清单')
    expect(call, '必须有陈旧清单那条 info——静默跳过就会找不到它').toBeTruthy()
    const payload = call![1] as {
      windowDays: number
      stale: Array<{ slug: string; daysAgo: number; status: string }>
    }
    expect(payload.windowDays).toBe(6)
    const row = payload.stale.find((s) => s.slug === STALE_SLUG)
    expect(row, '20 天前的夹具目录必须进清单').toBeTruthy()
    expect(row!.daysAgo).toBe(20)
    expect(row!.status).toBe('active')
    expect(logWarn.mock.calls.some((c) => String(c[0]).includes('陈旧度扫描失败'))).toBe(false)
  })

  it('反对照丙：脚本真失败（root 无 docs/run ⇒ 脚本退出码 1）⇒ closeout 照常 ok，只多一条 warn', () => {
    const repo2 = createIsolatedRepoRoot('session-closeout-g5-fail-')
    const orig = process.cwd()
    try {
      const r2 = repo2.repo
      execSync('git init', { cwd: r2, env: cleanGitEnv(), stdio: 'ignore' })
      execSync('git config user.name test', { cwd: r2, env: cleanGitEnv(), stdio: 'ignore' })
      execSync('git config user.email test@test.local', {
        cwd: r2,
        env: cleanGitEnv(),
        stdio: 'ignore',
      })
      execSync('git checkout -b dev', { cwd: r2, env: cleanGitEnv(), stdio: 'ignore' })
      writeFileSync(resolve(r2, 'a.txt'), 'init', 'utf-8')
      execSync('git add -A', { cwd: r2, env: cleanGitEnv(), stdio: 'ignore' })
      execSync('git commit -m init', { cwd: r2, env: cleanGitEnv(), stdio: 'ignore' })

      process.chdir(r2)
      logInfo.mockClear()
      logWarn.mockClear()

      const r = closeout.closeoutSession('g5-fail-00001')
      // **不阻断**是这一票的全部意义：脚本退 1，收口照走完
      expect(r).toEqual({ ok: true, step: 'checkout' })
      const warn = logWarn.mock.calls.find((c) => String(c[0]).includes('陈旧度扫描失败'))
      expect(warn, '失败必须留下 warn（跳过永不静默）').toBeTruthy()
      const payload = warn![1] as { error: string }
      // 取的是**脚本自家那行**，不是 import 链上 node:sqlite 的 ExperimentalWarning
      expect(payload.error).toContain('不存在')
      expect(payload.error).toContain('[run-docs-stale]')
    } finally {
      process.chdir(orig)
      removeIsolatedRepoRoot(repo2)
    }
  })

  it('scanStaleRunDocs 可直调：真 spawn 真脚本，返回结构化报告（非 mock 断言）', () => {
    const r = closeout.scanStaleRunDocs(tmp)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.report.windowDays).toBe(6)
      expect(r.report.stale.map((s) => s.slug)).toContain(STALE_SLUG)
      expect(r.report.failed).toEqual([])
    }
  })
})
