/**
 * worktree-fanin 测试 —— 猫分支 fan-in（枚举 / 幂等 / 守卫 / 合并 / 回收）。
 *
 * **真一次性 git 仓 + 真 worktree，不 mock git**：被测的就是 git 的组合行为，
 * mock 掉等于没测。判据全部来自 Phase S 模拟勘验（`sim-report.md`，12 格实跑）——
 * 本文件把那些格搬进仓内。
 *
 * 每格独立会话命名空间（`session/<sid8>` 及其猫分支），一格一个 sid ⇒ 格间零污染。
 * worktree 落 `<mkdtemp>/wt/`，**不碰本仓、不落仓库根**。
 *
 * 三条反向对照（V3，防恒真绿门）散落在对应格内，用 `[V3]` 标注：
 * B1 裸前缀必空 / C1 已知不在场文件名 / D2 未合分支判据必须能测出「被误删」。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// ─── D4 自指守卫专用「代理」mock ──────────────────────────
// 只包一层：git-utils 的 cleanupWorktreeResidue → vi.fn 代理真实实现（不替换），
// 用于断言「物理残留清理是否被触发」。**不 mock git**——其余导出全量委托真实实现。
// 为什么非它不可：守卫生效（cwd 在猫 worktree 内）与不生效的唯一可观测差异是
// 「残留清没清」，而 `git worktree remove` 自身是否删掉目录随平台变形
// （win32 因 cwd 句柄 EPERM 失败、Linux 成功）——只看目录存在与否会给出平台相关的假读数。
vi.mock('./git-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./git-utils.js')>()
  return { ...actual, cleanupWorktreeResidue: vi.fn(actual.cleanupWorktreeResidue) }
})

// ─── 票 9 冲突返投的**协作面** mock ────────────────────────
// 三个都是被测模块的协作者（投递管道 / 会话成员表 / 日志），按「只在边界 mock」打桩。
// **git 一律真的**：返投载荷来自真冲突现场，mock 掉 git 就是自己证自己。
// 为什么要打这三个桩：`ensureExecutionWorktree` 的投递段要读会话成员表解析收件人，
// 而本文件不建 DB——真实现会去开 `packages/server/data/*.db`（单测里绝不该发生）。
const h = vi.hoisted(() => ({
  ingestUserMessage: vi.fn(),
  getSessionAgentIds: vi.fn(() => [] as string[]),
  getAgentById: vi.fn(() => undefined as unknown),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}))

vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: h.logInfo,
    warn: h.logWarn,
    error: h.logError,
  }),
  setLogLevel: vi.fn(),
}))

vi.mock('../connectors/ingest.js', () => ({ ingestUserMessage: h.ingestUserMessage }))

vi.mock('../db/repository/index.js', () => ({
  sessions: { getSessionAgentIds: h.getSessionAgentIds },
  agents: { getAgentById: h.getAgentById },
}))

import {
  buildConflictNotice,
  ensureExecutionWorktree,
  fanInCatBranches,
  hasMergeInProgress,
  isAncestor,
  listCatBranches,
  mergeCatBranchesIntoOwnBranch,
  reclaimCatBranches,
} from './worktree-fanin.js'
import { cleanupWorktreeResidue, ensureCatWorktree, sessionBranch } from './git-utils.js'

const origCwd = process.cwd()
let tmpRoot = ''
let repo = ''
/** 本文件创建的 worktree 目录（清理用） */
const worktrees: string[] = []

/** 剥 git 环境变量——测试自身出 git 必须干净，否则被 worktree 钩子注入的 GIT_DIR 劫持
 * （本仓前科：GIT_DIR 注入把主仓 core.bare 写成 true，已复发 2 次） */
function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.GIT_DIR
  delete env.GIT_INDEX_FILE
  delete env.GIT_WORK_TREE
  delete env.GIT_PREFIX
  return env
}

function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, {
    cwd,
    env: cleanGitEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

function gitOrNull(args: string[], cwd = repo): string | null {
  try {
    return git(args, cwd)
  } catch {
    return null
  }
}

function head(cwd = repo, ref = 'HEAD'): string {
  return git(['rev-parse', ref], cwd)
}

function commitCount(cwd = repo): number {
  return Number(git(['rev-list', '--count', 'HEAD'], cwd))
}

/** 可达 merge commit 数（「空合并不造垃圾 commit」的直接判据） */
function mergeCount(cwd = repo): number {
  return Number(git(['rev-list', '--count', '--merges', 'HEAD'], cwd))
}

function commitFile(cwd: string, name: string, content: string, msg: string): void {
  writeFileSync(resolve(cwd, name), content, 'utf-8')
  git(['add', '--', name], cwd)
  git(['commit', '-m', msg], cwd)
}

/** 读某 ref 上的文件内容；文件不存在 → null（「不在场」判据用）。
 * 注意：走 `git()` ⇒ **首尾空白被 trim**（内部换行保留） */
function readAt(cwd: string, ref: string, file: string): string | null {
  return gitOrNull(['show', `${ref}:${file}`], cwd)
}

const catRef = (sid: string, cat: string): string => `${sessionBranch(sid)}-${cat}`

/** 建集成分支 + 其 worktree（幂等：分支已存在则只建 worktree） */
function addIntegration(sid: string): string {
  if (gitOrNull(['rev-parse', '--verify', `refs/heads/${sessionBranch(sid)}`]) === null) {
    git(['branch', sessionBranch(sid)])
  }
  const p = join(tmpRoot, 'wt', `${sid}-int`)
  git(['worktree', 'add', '-q', p, sessionBranch(sid)])
  worktrees.push(p)
  return p
}

/** 建猫分支（从集成分支分叉）+ 其 worktree */
function addCat(sid: string, cat: string): string {
  const p = join(tmpRoot, 'wt', `${sid}-${cat}`)
  git(['worktree', 'add', '-q', '-b', catRef(sid, cat), p, sessionBranch(sid)])
  worktrees.push(p)
  return p
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'wt-fanin-test-'))
  repo = join(tmpRoot, 'repo')
  mkdirSync(repo, { recursive: true })
  git(['init', '-q', '-b', 'dev'], repo)
  git(['config', 'user.name', 'test'], repo)
  git(['config', 'user.email', 'test@test.local'], repo)
  commitFile(repo, 'base.txt', 'base\n', 'base commit')
})

afterAll(() => {
  for (const wt of worktrees) {
    try {
      git(['worktree', 'remove', '--force', wt], repo)
    } catch {
      /* 已被回收/外力删除 → 忽略 */
    }
  }
  try {
    git(['worktree', 'prune'], repo)
  } catch {
    /* 忽略 */
  }
  process.chdir(origCwd)
  try {
    rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
})

// ─── 组 B · 枚举 ──────────────────────────────────────────

describe('组 B · 猫分支枚举', () => {
  it('B1 通配前缀命中：3 条猫分支全部枚举到（含 V3 裸前缀反向对照）', () => {
    const sid = 'b0000001'
    git(['branch', sessionBranch(sid)])
    // 乱序创建 —— 让「已排序」断言有意义
    git(['branch', catRef(sid, 'catC')])
    git(['branch', catRef(sid, 'catA')])
    git(['branch', catRef(sid, 'catB')])

    const got = listCatBranches(sid, { cwd: repo })
    expect(got).toEqual([catRef(sid, 'catA'), catRef(sid, 'catB'), catRef(sid, 'catC')])

    // ── [V3] 反向对照：裸前缀（无 `*`）收不到任何一条猫分支 ──
    // 这正是 S3-1（阻断级）的形态：枚举 0 条 → 循环 0 次 → 全链零报错。
    // 本格若把实现改回裸前缀，上面那条断言必然变红 —— 证明它测得出这种静默空集。
    const bareRefs = git([
      'for-each-ref',
      '--format=%(refname)',
      `refs/heads/${sessionBranch(sid)}-`,
    ])
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    expect(bareRefs).toHaveLength(0)
    expect(got).toHaveLength(3)
  })

  it('B2 空集：无猫提交过 → []，不抛错', () => {
    const sid = 'b0000002'
    git(['branch', sessionBranch(sid)]) // 只有集成分支，无猫分支
    expect(() => listCatBranches(sid, { cwd: repo })).not.toThrow()
    expect(listCatBranches(sid, { cwd: repo })).toEqual([])

    // 对照：完全不存在的前缀同样空 —— 证明「非错误」不是靠吞异常装出来的
    expect(listCatBranches('zzzz9999', { cwd: repo })).toEqual([])
  })

  it('B3 不误收会话分支本身', () => {
    const sid = 'b0000003'
    git(['branch', sessionBranch(sid)])
    git(['branch', catRef(sid, 'catA')])
    const got = listCatBranches(sid, { cwd: repo })
    expect(got).toContain(catRef(sid, 'catA'))
    expect(got).not.toContain(sessionBranch(sid))
  })

  it('B4 不误收旁支：前缀像但无连字符', () => {
    const sid = 'b0000004'
    git(['branch', sessionBranch(sid)])
    git(['branch', `${sessionBranch(sid)}catC`]) // 无连字符
    git(['branch', catRef(sid, 'catA')])
    const got = listCatBranches(sid, { cwd: repo })
    expect(got).toEqual([catRef(sid, 'catA')])
    expect(got).not.toContain(`${sessionBranch(sid)}catC`)
  })

  it('B5 过滤空 cat8：`session/<sid8>-` 不在结果里（S3-5）', () => {
    const sid = 'b0000005'
    git(['branch', sessionBranch(sid)])
    git(['branch', `${sessionBranch(sid)}-`]) // 空后缀：`*` 可匹配空串 ⇒ 会被前缀命中
    git(['branch', catRef(sid, 'catA')])
    const got = listCatBranches(sid, { cwd: repo })
    expect(got).toEqual([catRef(sid, 'catA')])
    expect(got).not.toContain(`${sessionBranch(sid)}-`)
  })

  it('B6 确定性：同一状态下两次调用结果顺序一致', () => {
    const sid = 'b0000006'
    git(['branch', sessionBranch(sid)])
    for (const c of ['catD', 'catB', 'catE', 'catA', 'catC']) git(['branch', catRef(sid, c)])
    const first = listCatBranches(sid, { cwd: repo })
    const second = listCatBranches(sid, { cwd: repo })
    expect(second).toEqual(first)
    expect(first).toEqual(['catA', 'catB', 'catC', 'catD', 'catE'].map((c) => catRef(sid, c)))
  })
})

// ─── 组 C · fan-in（核心）────────────────────────────────

describe('组 C · fan-in', () => {
  it('C1 按序 no-ff：两猫分支全部真进集成分支（逐条验内容在场）', () => {
    const sid = 'c1000001'
    const wtInt = addIntegration(sid)
    const wtA = addCat(sid, 'catA')
    const wtB = addCat(sid, 'catB')
    commitFile(wtA, 'from-catA.txt', 'PAYLOAD-CAT-A\n', 'catA work')
    commitFile(wtB, 'from-catB.txt', 'PAYLOAD-CAT-B\n', 'catB work')

    const res = fanInCatBranches(sid, wtInt)
    expect(res.conflict).toBe(false)
    expect(res.recovered).toBe(false)
    expect(res.merged).toEqual([catRef(sid, 'catA'), catRef(sid, 'catB')])
    expect(res.skipped).toEqual([])

    // 内容**在场**：读实际文件，不是只看 exit 0（E5 的教训：空合合同样 exit 0）
    expect(readAt(wtInt, 'HEAD', 'from-catA.txt')).toBe('PAYLOAD-CAT-A')
    expect(readAt(wtInt, 'HEAD', 'from-catB.txt')).toBe('PAYLOAD-CAT-B')

    // ── [V3] 反向对照：已知不在场的文件名 ⇒ 同一判据必须报不在场 ──
    expect(readAt(wtInt, 'HEAD', 'definitely-not-present-9c1f.txt')).toBeNull()
    expect(readAt(wtInt, 'HEAD', 'from-catA.txt')).not.toBeNull()
  })

  it('C2 整链幂等：重跑 → merged 空、skipped 两条、HEAD 不变、无新 commit', () => {
    const sid = 'c2000001'
    const wtInt = addIntegration(sid)
    const wtA = addCat(sid, 'catA')
    const wtB = addCat(sid, 'catB')
    commitFile(wtA, 'c2-a.txt', 'A\n', 'catA work')
    commitFile(wtB, 'c2-b.txt', 'B\n', 'catB work')

    const first = fanInCatBranches(sid, wtInt)
    expect(first.merged).toHaveLength(2) // 前提：首跑真合了两条
    const head1 = head(wtInt)
    const count1 = commitCount(wtInt)

    const second = fanInCatBranches(sid, wtInt)
    expect(second.merged).toEqual([])
    expect(second.skipped).toEqual([catRef(sid, 'catA'), catRef(sid, 'catB')])
    expect(second.conflict).toBe(false)
    expect(head(wtInt)).toBe(head1)
    expect(commitCount(wtInt)).toBe(count1)
  })

  it('C3 空合并：猫分支 == 分叉点 → 不造 merge commit（含「有提交时必造」对照）', () => {
    const sid = 'c3000001'
    const wtInt = addIntegration(sid)
    const wtA = addCat(sid, 'catA')
    const wtB = addCat(sid, 'catB') // 零提交
    commitFile(wtA, 'c3-a.txt', 'A\n', 'catA work')

    // 前提：catB == 分叉点
    expect(head(wtB)).toBe(head(repo, sessionBranch(sid)))
    const mergesBefore = mergeCount(wtInt)
    const countBefore = commitCount(wtInt)

    const res = fanInCatBranches(sid, wtInt)
    expect(res.merged).toEqual([catRef(sid, 'catA')])
    expect(res.skipped).toEqual([catRef(sid, 'catB')])
    // 只多了 catA 那一笔 merge commit —— 空猫分支没造垃圾 commit。
    // 注意 rev-list --count 数的是**可达提交**：catA 的 1 个提交 + 1 个 merge commit = +2
    expect(mergeCount(wtInt)).toBe(mergesBefore + 1)
    expect(commitCount(wtInt)).toBe(countBefore + 2)

    // ── 对照：catB 真提交后，同一路径必须造 merge commit（证明上条判据非恒真）──
    commitFile(wtB, 'c3-b.txt', 'B\n', 'catB work')
    const res2 = fanInCatBranches(sid, wtInt)
    expect(res2.merged).toEqual([catRef(sid, 'catB')])
    expect(mergeCount(wtInt)).toBe(mergesBefore + 2)
    expect(commitCount(wtInt)).toBe(countBefore + 4)
  })

  it('C4 冲突守卫：真冲突 → conflict:true 且已恢复（MERGE_HEAD 消失、可重跑）', () => {
    const sid = 'c4000001'
    commitFile(repo, 'c4-shared.txt', 'line1\nbase\nline3\n', 'c4 base shared')
    const wtInt = addIntegration(sid)
    const wtA = addCat(sid, 'catA')
    const wtB = addCat(sid, 'catB')
    // 双方改同一文件 ⇒ UU；双方各自新增同名文件 ⇒ AA（S3-2：两种码可并存）
    commitFile(wtA, 'c4-shared.txt', 'line1\nfrom-A\nline3\n', 'catA edits')
    commitFile(wtA, 'c4-both.txt', 'added-by-A\n', 'catA adds')
    commitFile(wtB, 'c4-shared.txt', 'line1\nfrom-B\nline3\n', 'catB edits')
    commitFile(wtB, 'c4-both.txt', 'added-by-B\n', 'catB adds')

    // 对照：非冲突态守卫为阴性（证明探测非恒真）
    expect(hasMergeInProgress({ cwd: wtInt })).toBe(false)

    const res = fanInCatBranches(sid, wtInt)
    expect(res.conflict).toBe(true)
    expect(res.recovered).toBe(true)
    expect(res.merged).toEqual([catRef(sid, 'catA')]) // catA 合成功，catB 冲突

    // 恢复到「可重跑态」
    expect(hasMergeInProgress({ cwd: wtInt })).toBe(false)
    expect(git(['status', '--porcelain'], wtInt)).toBe('')
    // abort 只退本次 merge：catA 的合并成果仍在场
    expect(readAt(wtInt, 'HEAD', 'c4-both.txt')).toBe('added-by-A')
    expect(readAt(wtInt, 'HEAD', 'c4-shared.txt')).toBe('line1\nfrom-A\nline3')

    // 真能重跑：catB 仍是 unmerged（冲突源未消）⇒ 再次冲突，不是「卡死后什么都跑不动」
    const rerun = fanInCatBranches(sid, wtInt)
    expect(rerun.conflict).toBe(true)
    expect(rerun.recovered).toBe(true)
    expect(hasMergeInProgress({ cwd: wtInt })).toBe(false)
  })

  it('C5 半合并态入口：预置 MERGE_HEAD → 立即失败、不继续合并（含 AA+UU 证据）', () => {
    const sid = 'c5000001'
    commitFile(repo, 'c5-shared.txt', 'base\n', 'c5 base')
    const wtInt = addIntegration(sid)
    const wtA = addCat(sid, 'catA')
    const wtB = addCat(sid, 'catB')
    commitFile(wtA, 'c5-shared.txt', 'A\n', 'catA edits')
    commitFile(wtA, 'c5-both.txt', 'A\n', 'catA adds')
    commitFile(wtB, 'c5-shared.txt', 'B\n', 'catB edits')
    commitFile(wtB, 'c5-both.txt', 'B\n', 'catB adds')

    // 手工制造半合并态（不合，留着 MERGE_HEAD）
    gitOrNull(['merge', '--no-ff', '-m', 'manual catA', catRef(sid, 'catA')], wtInt)
    gitOrNull(['merge', '--no-ff', '-m', 'manual catB', catRef(sid, 'catB')], wtInt)
    expect(hasMergeInProgress({ cwd: wtInt })).toBe(true)

    // S3-2 证据：冲突码不止 UU —— AA（双方各自新增同名文件）与 UU 并存
    const codes = git(['status', '--porcelain'], wtInt)
      .split('\n')
      .map((l) => l.slice(0, 2))
    expect(codes).toContain('UU')
    expect(codes).toContain('AA')

    const res = fanInCatBranches(sid, wtInt)
    expect(res.conflict).toBe(true)
    expect(res.merged).toEqual([]) // 一条都没合
    expect(res.skipped).toEqual([])
    // 不自行 abort：把仲裁权留给上层，且**绝不**在半合并态上继续跑
    expect(res.recovered).toBe(false)
    expect(hasMergeInProgress({ cwd: wtInt })).toBe(true)

    // ── 对照：清干净后同一调用**走完了循环**（证明上面的「一条都没合」不是恒真）──
    // abort 把 HEAD 退回手工 catA 合并那笔 ⇒ 集成分支已包含 catA ⇒ 它这次进 skipped
    // （幂等判据生效）；catB 仍是冲突源 ⇒ 撞真冲突。区分「入口即返」与「真的跑了」
    // 的字段是 skipped 非空 + recovered=true（入口即返那次的形状是双空 + recovered=false）。
    git(['merge', '--abort'], wtInt)
    const res2 = fanInCatBranches(sid, wtInt)
    expect(res2.skipped).toEqual([catRef(sid, 'catA')])
    expect(res2.recovered).toBe(true)
    expect(hasMergeInProgress({ cwd: wtInt })).toBe(false)
  })

  it('C6 cwd 守卫：cwd 检出 dev → 显式失败，不把猫分支合进去', () => {
    const sid = 'c6000001'
    git(['branch', sessionBranch(sid)])
    // repo 检出的是 dev —— 这就是 ADR §6.3 判死的方案 (b)：合进去 = 冲突落主工作区
    expect(() => fanInCatBranches(sid, repo)).toThrow(/集成分支/)
    // 未合任何东西
    expect(git(['log', '--oneline', `dev..${sessionBranch(sid)}`])).toBe('')

    // 对照：切到集成分支后同一调用不抛（证明守卫不是「总是抛」）
    const wtInt = addIntegration(sid)
    expect(() => fanInCatBranches(sid, wtInt)).not.toThrow()
  })
})

// ─── 组 D · 回收 ─────────────────────────────────────────

describe('组 D · 猫 worktree / 分支回收', () => {
  it('D1 回收已合：已合猫分支 + 其 worktree 被回收干净、分支 ref 消失', () => {
    const sid = 'd1000001'
    const wtInt = addIntegration(sid)
    const wtA = addCat(sid, 'catA')
    commitFile(wtA, 'd1-payload.txt', 'PAYLOAD\n', 'catA work')

    const res = fanInCatBranches(sid, wtInt)
    expect(res.merged).toEqual([catRef(sid, 'catA')])
    // 收口：集成分支 ff-only 进 dev
    git(['merge', '--ff-only', sessionBranch(sid)])
    expect(readAt(repo, 'dev', 'd1-payload.txt')).toBe('PAYLOAD')

    const reclaimed = reclaimCatBranches(sid, sessionBranch(sid), { cwd: wtInt })
    expect(reclaimed).toEqual([catRef(sid, 'catA')])
    expect(gitOrNull(['rev-parse', '--verify', `refs/heads/${catRef(sid, 'catA')}`])).toBeNull()
    expect(existsSync(wtA)).toBe(false)
    // 集成分支本身不受影响
    expect(gitOrNull(['rev-parse', '--verify', `refs/heads/${sessionBranch(sid)}`])).not.toBeNull()
  })

  it('D2 未合不回收：未合猫分支必须留存（含 V3 判据分辨力对照）', () => {
    const sid = 'd2000001'
    const wtInt = addIntegration(sid)
    const wtA = addCat(sid, 'catA')
    commitFile(wtA, 'd2-a.txt', 'A\n', 'catA work')
    expect(fanInCatBranches(sid, wtInt).merged).toEqual([catRef(sid, 'catA')])

    // 之后才起的猫：它的提交**不在**集成分支上
    const wtB = addCat(sid, 'catB')
    commitFile(wtB, 'd2-b.txt', 'B\n', 'catB work')

    // ── [V3] 反向对照：判据必须真能区分「已合/未合」──
    // 必须取在 reclaim **之前**（回收会删掉 catA 分支，ref 没了 isAncestor 恒 false）。
    // 若实现漏掉 isAncestor 判断（或把它写反），catB 会被回收，紧接着的
    // existsSync/ref 断言必然变红 —— 即判据能测出「未合分支被误删」。
    expect(isAncestor(catRef(sid, 'catB'), sessionBranch(sid), { cwd: wtInt })).toBe(false)
    expect(isAncestor(catRef(sid, 'catA'), sessionBranch(sid), { cwd: wtInt })).toBe(true)

    const reclaimed = reclaimCatBranches(sid, sessionBranch(sid), { cwd: wtInt })

    // 未合分支与其 worktree 双双留存（删了就丢活）——**存活断言刻意排在
    // `reclaimed` 深比较之前**：判据被破坏时，先响的必须是「活没了」这件事本身，
    // 而不是一个数组内容不符（实测：拆掉守卫后 `reclaimed` 会多出 catB，
    // 只有把这条排前面，红才是直接指向「误删未合的活」）。
    expect(gitOrNull(['rev-parse', '--verify', `refs/heads/${catRef(sid, 'catB')}`])).not.toBeNull()
    expect(existsSync(wtB)).toBe(true)
    expect(readAt(wtB, 'HEAD', 'd2-b.txt')).toBe('B')
    expect(reclaimed).toEqual([catRef(sid, 'catA')])
  })

  it('D3 孤儿分支：worktree 已被删、只剩分支 ⇒ 也能枚举到并回收', () => {
    const sid = 'd3000001'
    const wtInt = addIntegration(sid)
    const wtA = addCat(sid, 'catA')
    commitFile(wtA, 'd3-a.txt', 'A\n', 'catA work')
    expect(fanInCatBranches(sid, wtInt).merged).toEqual([catRef(sid, 'catA')])

    // 外力删掉 worktree（模拟层已清、物理残留/崩溃残留形态）
    git(['worktree', 'remove', '--force', wtA])
    expect(existsSync(wtA)).toBe(false)
    expect(listCatBranches(sid, { cwd: wtInt })).toContain(catRef(sid, 'catA'))

    const reclaimed = reclaimCatBranches(sid, sessionBranch(sid), { cwd: wtInt })
    expect(reclaimed).toEqual([catRef(sid, 'catA')])
    expect(gitOrNull(['rev-parse', '--verify', `refs/heads/${catRef(sid, 'catA')}`])).toBeNull()
  })

  it('D4 自指守卫：cwd 在被回收的猫 worktree 内 → 跳过物理清理（含反向对照）', () => {
    const sid = 'd4000001'
    const wtInt = addIntegration(sid)
    const wtA = addCat(sid, 'catA')
    commitFile(wtA, 'd4-a.txt', 'A\n', 'catA work')
    expect(fanInCatBranches(sid, wtInt).merged).toEqual([catRef(sid, 'catA')])

    const cleanupMock = vi.mocked(cleanupWorktreeResidue)

    // ── 自指：process.cwd() 落在被回收的 worktree 内 ──
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(wtA)
    try {
      cleanupMock.mockClear()
      expect(() => reclaimCatBranches(sid, sessionBranch(sid), { cwd: wtInt })).not.toThrow()
      // 核心断言：物理残留清理被跳过（当前进程正站着这棵树，删了 IO 悬空）
      expect(cleanupMock).not.toHaveBeenCalled()
    } finally {
      cwdSpy.mockRestore()
    }
    // git 层照做：分支已被回收（守卫只拦物理清理，不拦回收本身）
    expect(gitOrNull(['rev-parse', '--verify', `refs/heads/${catRef(sid, 'catA')}`])).toBeNull()

    // ── 反向对照：cwd 在外 → 物理清理照常触发（证明上条不是「从不调用」）──
    const wtB = addCat(sid, 'catB')
    commitFile(wtB, 'd4-b.txt', 'B\n', 'catB work')
    expect(fanInCatBranches(sid, wtInt).merged).toEqual([catRef(sid, 'catB')])

    const outerSpy = vi.spyOn(process, 'cwd').mockReturnValue(repo)
    try {
      cleanupMock.mockClear()
      const reclaimed = reclaimCatBranches(sid, sessionBranch(sid), { cwd: wtInt })
      expect(reclaimed).toEqual([catRef(sid, 'catB')])
      expect(cleanupMock).toHaveBeenCalled()
    } finally {
      outerSpy.mockRestore()
    }
  })
})

// ─── 组 E · 冲突返投载荷（票 9）───────────────────────────
//
// 本组只测**载荷的取与渲染**（纯逻辑 + 真 git）：投递动作本身（谁收、去重、失败
// 留痕）挂在组装面（`serial.cat-worktree.test.ts`），那里有真 DB 与真 ingest。
// 分工理由：本文件不建 DB，而投递链要读会话成员表；硬凑一份 DB 会让「文件清单
// 取得对不对」这个真判据淹在夹具噪音里。

describe('组 E · 冲突返投载荷（票 9）', () => {
  /**
   * E1 冲突现场三样齐：**谁撞的 / 撞在哪些文件 / 撞那一刻它尖在哪**。
   *
   * 末两行是本设计判据的直接读数——「必须当场回传、不能事后自查」不是风格偏好：
   * abort 回可重跑态之后，`--diff-filter=U` 恒空，同一问题**已无答案**。
   */
  it('E1 冲突现场：回传来源分支 / 其 sha / 未合并文件清单（abort 后已不可得）', () => {
    const sid = 'e1000001'
    commitFile(repo, 'e1-shared.txt', 'line1\nbase\nline3\n', 'e1 base shared')
    git(['branch', sessionBranch(sid)])
    const wtA = addCat(sid, 'catA') // 审查侧：合并的**目标**
    const wtB = addCat(sid, 'catB') // 冲突来源
    // UU（双方改同一文件）+ AA（双方各自新增同名文件）并存 —— S3-2 的形态：
    // 按冲突码逐个枚举必漏，故清单判据取 `--diff-filter=U`（unmerged 聚合类）
    commitFile(wtA, 'e1-shared.txt', 'line1\nfrom-A\nline3\n', 'catA edits')
    commitFile(wtA, 'e1-both.txt', 'added-by-A\n', 'catA adds')
    commitFile(wtB, 'e1-shared.txt', 'line1\nfrom-B\nline3\n', 'catB edits')
    commitFile(wtB, 'e1-both.txt', 'added-by-B\n', 'catB adds')

    const sourceSha = git(['rev-parse', catRef(sid, 'catB')])
    const res = mergeCatBranchesIntoOwnBranch(sid, { cwd: wtA, mainRoot: repo })

    expect(res.conflict).toBe(true)
    expect(res.conflictDetail).toBeDefined()
    expect(res.conflictDetail!.source).toBe(catRef(sid, 'catB'))
    expect(res.conflictDetail!.sourceSha).toBe(sourceSha)
    expect(res.conflictDetail!.files).toEqual(['e1-both.txt', 'e1-shared.txt'])

    // ── 设计判据实证：事后自查这条路**是死的**（不是「麻烦」）──
    expect(hasMergeInProgress({ cwd: wtA })).toBe(false) // 已 abort 回可重跑态
    expect(git(['diff', '--name-only', '--diff-filter=U'], wtA)).toBe('') // 清单已消失
  })

  /** 非冲突态**不得**带现场（否则返投闸会拿着空壳去投一条没头没尾的返修单） */
  it('E1b 反向对照：无冲突的合并返回 conflictDetail 为 undefined', () => {
    const sid = 'e1000002'
    git(['branch', sessionBranch(sid)])
    const wtA = addCat(sid, 'catA')
    const wtB = addCat(sid, 'catB')
    commitFile(wtA, 'e1b-a.txt', 'A\n', 'catA work')
    commitFile(wtB, 'e1b-b.txt', 'B\n', 'catB work')

    const res = mergeCatBranchesIntoOwnBranch(sid, { cwd: wtA, mainRoot: repo })
    expect(res.conflict).toBe(false)
    expect(res.conflictDetail).toBeUndefined()
  })

  /**
   * E2 载荷四样**逐样可断言**。
   *
   * 票面验收 1 点名「载荷四字段逐一断言，不只断言『有消息』」——只断言「投出去了」
   * 会把「一条没有文件清单、没有对撞 sha、没有解法」的空壳放过去，而收件猫拿到
   * 空壳照样动不了手（墙 #3 原样复发，只是多了一条消息）。
   */
  it('E2 载荷四样：文件清单 / 对撞两侧 / 解法指令 / 验收条件逐样在正文里', () => {
    const text = buildConflictNotice({
      catName: '暹罗猫',
      targetBranch: 'session/e2000001-吐槽猫',
      targetSha: 'abcdef1234567890',
      sourceBranch: 'session/e2000001-暹罗猫',
      sourceSha: '0123456789abcdef',
      conflictFiles: ['packages/server/src/a.ts', 'packages/server/src/b.ts'],
      chainAnchor: 'chain-anchor-uuid',
    })

    // 收件人：行首 @（与 `mentions` 同源的可见形态）
    expect(text.startsWith('@暹罗猫 ')).toBe(true)

    // ① 冲突文件清单——**逐条**在，且条数写明
    expect(text).toContain('① 冲突文件（2 个）')
    expect(text).toContain('- packages/server/src/a.ts')
    expect(text).toContain('- packages/server/src/b.ts')

    // ② 对撞两侧——源与目标各**分支名 + 短 sha**
    expect(text).toContain('- 你的分支：session/e2000001-暹罗猫 @ 0123456')
    expect(text).toContain('- 审查分支：session/e2000001-吐槽猫 @ abcdef1')

    // ③ 解法指令——固定模板五步，且审查分支名**已代入**（不留占位符）
    expect(text).toContain('③ 解法：')
    expect(text).toContain('git merge session/e2000001-吐槽猫')
    expect(text).toContain('跑测试')
    expect(text).toContain('重新 request-review')
    expect(text).not.toContain('<审查分支>')

    // ④ 验收条件——「合并干净即放行」
    expect(text).toContain('④ 验收条件：')
    expect(text).toContain('干净合进审查分支')

    // 链锚：实施猫重投审查时沿用同一条链（否则返修工作挂到链外）
    expect(text).toContain('chain-anchor-uuid')
  })

  /**
   * E3 反向对照：「文件清单为空」不得被渲染成一条**看起来完整**的空清单。
   *
   * 读不到未合并路径有两个成因（真无冲突 / git 读不到），而两者的正确处置都是
   * 「让收件人自己查」——所以正文必须**明写未能取得**。这条同时是 E2 的对照：
   * 有清单时同一位置是文件条目，不是那句兜底话术（证明上面不是恒真断言）。
   */
  it('E3 空清单明写「未能取得」，不拿空清单冒充（含有清单时的对照）', () => {
    const base = {
      catName: '暹罗猫',
      targetBranch: 'session/e3000001-吐槽猫',
      targetSha: 'abcdef1234567890',
      sourceBranch: 'session/e3000001-暹罗猫',
      sourceSha: '0123456789abcdef',
      chainAnchor: 'anchor-3',
    }

    const emptyText = buildConflictNotice({ ...base, conflictFiles: [] })
    expect(emptyText).toContain('① 冲突文件（0 个）')
    expect(emptyText).toContain('未能取得文件清单')

    const withFile = buildConflictNotice({ ...base, conflictFiles: ['x.ts'] })
    expect(withFile).toContain('① 冲突文件（1 个）')
    expect(withFile).toContain('- x.ts')
    expect(withFile).not.toContain('未能取得文件清单')
  })
})

// ─── 组 F · 冲突返投的**失败路径**（票 9 验收 4：不静默、不改 fail-closed）──
//
// 正面路径（谁收到、四样载荷、去重）在 `serial.cat-worktree.test.ts` V23（真 DB +
// 真 ingest）。这里专测**投递坏掉时**的语义：三条失败路径各自留痕，且**冲突照常抛**。
// 失败路径必须在单元面测——组装面没法在飞行中把 ingest 弄坏（那正是它真实的地方）。

describe('组 F · 冲突返投失败路径（票 9）', () => {
  /** 审查者身份（`role: 'reviewer'` 才进合并分支） */
  const REVIEWER_AGENT = { id: 'rev-1', name: '吐槽猫', role: 'reviewer' }

  /** 等一次宏任务——投递链的 `.then/.catch` 排在微任务队列上 */
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  /** 会话成员表桩：源分支后缀 `暹罗猫` 能解析到 impl-1 */
  function stubMembers(names: Array<{ id: string; name: string }>): void {
    h.getSessionAgentIds.mockReturnValue(names.map((n) => n.id))
    h.getAgentById.mockImplementation(((id: string) =>
      names.find((n) => n.id === id)) as unknown as typeof h.getAgentById)
  }

  /**
   * 造一对**真冲突**的猫分支。
   *
   * 两处刻意：
   * - 猫树用 `ensureCatWorktree` 建在**规范路径**上——`ensureExecutionWorktree` 内部
   *   走的就是它；若沿用组 C/D 的 `addCat`（建在 `wt/` 下），git 会因「分支已被检出」
   *   而建树失败 → `ensureExecutionWorktree` 返回 null → 整格静默不测（正是本票要治
   *   的那种静默降级，不能让它长在测试夹具里）。
   * - 冲突落在**本格独有**的文件上，与其它格的 `base.txt` 互不干扰。
   */
  function addConflictPair(sid: string, revCat: string, implCat: string): void {
    const f = `${sid}-shared.txt`
    commitFile(repo, f, 'line1\nbase\nline3\n', `${sid} base shared`)
    git(['branch', sessionBranch(sid)])
    const revWt = ensureCatWorktree(sid, 'rev-1', revCat)
    const implWt = ensureCatWorktree(sid, 'impl-1', implCat)
    if (!revWt || !implWt) throw new Error(`组 F 前提不成立：猫 worktree 建不出（${sid}）`)
    commitFile(revWt, f, 'line1\nfrom-rev\nline3\n', 'rev edits')
    commitFile(implWt, f, 'line1\nfrom-impl\nline3\n', 'impl edits')
  }

  beforeEach(() => {
    h.ingestUserMessage.mockReset()
    h.getSessionAgentIds.mockReset().mockReturnValue([])
    h.getAgentById.mockReset()
    h.logInfo.mockReset()
    h.logWarn.mockReset()
    h.logError.mockReset()
  })

  afterEach(() => {
    process.chdir(origCwd)
  })

  it('F1 投递被 ingest 拒收（落库失败）⇒ log.error 留痕，冲突仍照常抛错', async () => {
    const sid = 'f1000001'
    process.chdir(repo)
    addConflictPair(sid, '吐槽猫', '暹罗猫')
    stubMembers([
      { id: 'rev-1', name: '吐槽猫' },
      { id: 'impl-1', name: '暹罗猫' },
    ])
    h.ingestUserMessage.mockResolvedValue({ ok: false, status: 500, error: '消息写入失败，请重试' })

    // fail-closed 不变：抛的是**冲突**那条，投递失败不改变它
    expect(() => ensureExecutionWorktree(sid, REVIEWER_AGENT, 'anchor-f1')).toThrow(
      /审查面准备中止：把猫分支合进审查者自己的分支时冲突/
    )
    await flush()
    expect(h.logError).toHaveBeenCalledWith(
      'conflict notice rejected by ingest',
      expect.objectContaining({ status: 500, target: '暹罗猫' })
    )
    // 确实**试过**投（证明下面 F3 的 not.toHaveBeenCalled 不是「永远不投」）
    expect(h.ingestUserMessage).toHaveBeenCalledTimes(1)
  })

  it('F2 投递链自身抛错 ⇒ log.error 留痕，且不替换掉「审查面准备中止」', async () => {
    const sid = 'f1000002'
    process.chdir(repo)
    addConflictPair(sid, '吐槽猫', '暹罗猫')
    stubMembers([
      { id: 'rev-1', name: '吐槽猫' },
      { id: 'impl-1', name: '暹罗猫' },
    ])
    h.ingestUserMessage.mockRejectedValue(new Error('db gone'))

    // 抛出的必须是冲突那条：投递链异常若逃逸，日志会指向错误的方向，真冲突现场反而没了
    expect(() => ensureExecutionWorktree(sid, REVIEWER_AGENT, 'anchor-f2')).toThrow(
      /审查面准备中止：把猫分支合进审查者自己的分支时冲突/
    )
    await flush()
    expect(h.logError).toHaveBeenCalledWith(
      'conflict notice delivery failed',
      expect.objectContaining({ error: 'db gone' })
    )
  })

  it('F3 源分支无对应会话成员 ⇒ log.error 留痕、不投错人（含 not-called 反向对照）', () => {
    const sid = 'f1000003'
    process.chdir(repo)
    addConflictPair(sid, '吐槽猫', '暹罗猫')
    // 会话里只剩审查者：源分支的 `暹罗猫` 已被移出会话（或它是别的会话的遗留分支）
    stubMembers([{ id: 'rev-1', name: '吐槽猫' }])

    expect(() => ensureExecutionWorktree(sid, REVIEWER_AGENT, 'anchor-f3')).toThrow(
      /审查面准备中止：把猫分支合进审查者自己的分支时冲突/
    )
    // 宁可不投，不可投错：给无关的猫派一份不属于它的返修单比不派更坏
    expect(h.ingestUserMessage).not.toHaveBeenCalled()
    expect(h.logError).toHaveBeenCalledWith(
      'conflict notice skipped — 源分支无对应会话成员',
      expect.objectContaining({ source: catRef(sid, '暹罗猫') })
    )
  })
})
