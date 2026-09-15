#!/usr/bin/env node
/**
 * T-2 Phase S · 一猫一 worktree 隔离 —— 12 格模拟矩阵
 *
 * 依据：docs/run/multi-cat-isolation/tickets-t2.md（唯一依据）
 * 设计：docs/run/multi-cat-isolation/adr-0015-draft.md（proposed，未定稿）
 *
 * 红线保障（票面 §四）：
 *   1. 所有实验在**系统 temp** 下的一次性仓跑，绝不碰本仓 git 状态。
 *      - 每次 git 调用都剥掉 GIT_DIR/GIT_WORK_TREE/... 注入（防 pre-commit 钩子环境泄漏）
 *      - 仓建好后 assertOutsideRepo() 硬校验 toplevel 确在系统 temp 下
 *   2. 本脚本不碰本仓 ⇒ 暂存区恒 0（不适用 git add -A）
 *   3. 删 symlink 绝不 recursive 跟穿 —— safeRm 用 lstat 判链接后 unlink
 *   4. 不 push（一次性仓无远端，origin 一律不碰）
 *   5. 结束前删净临时目录，并打印删净复核读数（除非 --keep）
 *
 * 覆盖边界自陈（防假绿门）：
 *   本脚本跑的是**手工 git 命令序列**，证明的是「git 层这么组合行不行、顺序是什么」。
 *   它**证不了**「Phase I 的生产代码会这么写」——那是 Phase T / Phase I 的事。
 *   A2 格复刻的是 git-utils.ts:379-433 的现有实现语义（不是调用生产代码：那会解析到
 *   本仓 git，违红线 1），复刻偏差风险见报告 §覆盖边界。
 *
 * 用法：
 *   node run-sim.mjs            # 跑全矩阵，结束删净
 *   node run-sim.mjs A1 C4      # 只跑指定格
 *   node run-sim.mjs --keep     # 保留临时目录（调试用）
 */

import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── 环境隔离（红线 1 的技术保障）─────────────────────────

/** git 会从环境继承的注入变量：必须在每次调用前剥掉（本仓 core.bare 污染前科即此因） */
const GIT_INJECT_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
  'GIT_NAMESPACE',
]

function cleanEnv() {
  const env = { ...process.env }
  for (const k of GIT_INJECT_KEYS) delete env[k]
  return env
}

const TMP_ROOT = mkdtempSync(join(tmpdir(), 'catstudy-sim-'))

// ── 基础设施 ─────────────────────────────────────────────

/** 跑一条 git 命令，返回 { cmd, code, out, err } —— 票面要求「命令 + 原始输出 + exit code」三联 */
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8' })
  return {
    cmd: `git ${args.join(' ')}`,
    code: r.status,
    out: (r.stdout || '').trim(),
    err: (r.stderr || '').trim(),
  }
}

/** 硬校验：仓的 toplevel 必须在系统 temp 下（红线 1 的最终防线，不靠人记） */
function assertOutsideRepo(dir) {
  const top = git(dir, ['rev-parse', '--show-toplevel'])
  if (top.code !== 0) throw new Error(`assertOutsideRepo: ${dir} 不是 git 仓`)
  const real = realpathSync(top.out).toLowerCase()
  const tmp = realpathSync(tmpdir()).toLowerCase()
  if (!real.startsWith(tmp)) {
    throw new Error(`红线违反：仓 toplevel ${real} 不在系统 temp ${tmp} 下`)
  }
}

/** 建一次性仓：dev 为初始分支 + 一个 init commit */
function makeRepo(name) {
  const dir = join(TMP_ROOT, name)
  mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q', '-b', 'dev'])
  git(dir, ['config', 'user.email', 'sim@local'])
  git(dir, ['config', 'user.name', 'sim'])
  git(dir, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(dir, 'README.md'), '# sim\n')
  git(dir, ['add', 'README.md'])
  git(dir, ['commit', '-q', '-m', 'init'])
  assertOutsideRepo(dir)
  return dir
}

/**
 * 安全删除：symlink/junction 一律 unlink（**绝不 recursive 跟穿** —— 本仓实证过
 * 跟穿会删掉主仓库 node_modules）。
 */
function safeRm(target) {
  if (!existsSync(target)) return
  const st = lstatSync(target)
  if (st.isSymbolicLink()) {
    unlinkSync(target)
    return
  }
  if (!st.isDirectory()) {
    unlinkSync(target)
    return
  }
  for (const name of readdirSync(target)) safeRm(join(target, name))
  rmdirSync(target)
}

/** 写文件 + 提交，返回 commit sha */
function commitFile(repo, file, content, msg) {
  writeFileSync(join(repo, file), content)
  git(repo, ['add', file])
  git(repo, ['commit', '-q', '-m', msg])
  return git(repo, ['rev-parse', 'HEAD']).out
}

function head(repo, ref = 'HEAD') {
  return git(repo, ['rev-parse', ref]).out
}

function commitCount(repo, ref = 'HEAD') {
  return Number(git(repo, ['rev-list', '--count', ref]).out)
}

/** 目录/文件在磁盘上是否存在（探针，用于「内容在场」类判据） */
function onDisk(p) {
  return existsSync(p)
}

/** 读某 commit 下某文件的内容（判据必须读**内容**，不能只看命令 exit 0 —— E5 的教训） */
function readAt(repo, ref, file) {
  const r = git(repo, ['show', `${ref}:${file}`])
  return r.code === 0 ? r.out : null
}

// ── 结果收集 ─────────────────────────────────────────────

const GRIDS = []
function grid(id, title, fn) {
  GRIDS.push({ id, title, fn })
}

/** 格内上下文 */
function ctxFor(name) {
  return {
    repo: makeRepo(name),
    /** 建会话分支（T-2 的分叉点） */
    makeSession(repo, sid8) {
      git(repo, ['branch', `session/${sid8}`])
      return `session/${sid8}`
    },
  }
}

// ── 组 A · 建立（3 格）───────────────────────────────────

grid('A1', '猫 worktree 分叉与共存', () => {
  const { repo, makeSession } = ctxFor('A1')
  const steps = []
  const checks = []
  const sid = 'abcd1234'

  steps.push(git(repo, ['branch', `session/${sid}`]))
  const wtSession = join(TMP_ROOT, 'A1-wt-session')
  steps.push(git(repo, ['worktree', 'add', '-q', wtSession, `session/${sid}`]))

  const wtCatA = join(TMP_ROOT, 'A1-abcd1234-catA')
  const addCat = git(repo, [
    'worktree',
    'add',
    '-q',
    '-b',
    `session/${sid}-catA`,
    wtCatA,
    `session/${sid}`,
  ])
  steps.push(addCat)

  checks.push({
    name: '猫 worktree 建立成功（exit 0）',
    pass: addCat.code === 0,
    detail: `code=${addCat.code}`,
  })

  const list = git(repo, ['worktree', 'list', '--porcelain'])
  steps.push(list)
  const wtCount = list.out.split('\n').filter((l) => l.startsWith('worktree ')).length
  checks.push({
    name: '三个 worktree 并存（主 + 会话 + 猫）',
    pass: wtCount === 3,
    detail: `list 计数=${wtCount}`,
  })

  const branches = git(repo, ['branch', '--format=%(refname:short)']).out.split('\n')
  steps.push(git(repo, ['branch', '--format=%(refname:short)']))
  checks.push({
    name: '会话分支与猫分支共存',
    pass: branches.includes(`session/${sid}`) && branches.includes(`session/${sid}-catA`),
    detail: branches.join(' | '),
  })

  checks.push({
    name: '猫 worktree 分叉点正确（HEAD == 会话分支 sha）',
    pass: head(wtCatA) === head(repo, `session/${sid}`),
    detail: `catA=${head(wtCatA).slice(0, 8)} session=${head(repo, `session/${sid}`).slice(0, 8)}`,
  })

  // 互不干扰：猫侧提交后，会话 worktree 的 HEAD 不动
  const sessionHeadBefore = head(wtSession)
  commitFile(wtCatA, 'catA.txt', 'from catA\n', 'catA work')
  steps.push(git(wtCatA, ['log', '--oneline', '-1']))
  checks.push({
    name: '猫侧提交不移动会话 worktree（互不干扰）',
    pass: head(wtSession) === sessionHeadBefore && head(wtSession) === head(repo, `session/${sid}`),
    detail: `session HEAD ${sessionHeadBefore.slice(0, 8)} → ${head(wtSession).slice(0, 8)}`,
  })

  checks.push({
    name: '两个目录物理并存、各自 toplevel 正确',
    pass:
      onDisk(wtSession) &&
      onDisk(wtCatA) &&
      realpathSync(git(wtCatA, ['rev-parse', '--show-toplevel']).out) !==
        realpathSync(git(wtSession, ['rev-parse', '--show-toplevel']).out),
    detail: `session=${onDisk(wtSession)} catA=${onDisk(wtCatA)}`,
  })

  return {
    steps,
    checks,
    verdict:
      '斜杠命名修正为连字符后，猫 worktree 可从会话分支分叉并与会话 worktree 并存；路径 <sid8>-<cat8> 与会话路径 <sid8> 互不干扰。',
  }
})

grid('A2', '同猫重复建 → 幂等复用（复刻 git-utils.ts:379 语义）', () => {
  const { repo, makeSession } = ctxFor('A2')
  const steps = []
  const checks = []
  const sid = 'abcd1234'
  const branch = `session/${sid}-catA`

  steps.push(git(repo, ['branch', `session/${sid}`]))

  /**
   * 复刻 ensureSessionWorktree（git-utils.ts:379-433）的判定骨架：
   *   ① 目录存在 + .git 标记存在 → 复用，返回路径
   *   ② 目录存在 + 无 .git 标记 → 残留，清理重建
   *   ③ 分支不存在才建（git branch <branch>）
   *   ④ git worktree add <path> <branch>（**无 -b**）
   *   ⑤ 任一步失败 → return null（降级主工作区）
   */
  function ensureSim(wtPath) {
    if (existsSync(wtPath) && existsSync(join(wtPath, '.git'))) {
      return { path: wtPath, via: 'reuse', code: 0 }
    }
    const branchExists = git(repo, ['rev-parse', '--verify', `refs/heads/${branch}`]).code === 0
    if (!branchExists) {
      const b = git(repo, ['branch', branch])
      if (b.code !== 0) return { path: null, via: 'branch-fail', code: b.code }
    }
    const add = git(repo, ['worktree', 'add', '-q', wtPath, branch])
    if (add.code !== 0) return { path: null, via: 'add-fail', code: add.code, err: add.err }
    return { path: wtPath, via: 'created', code: 0 }
  }

  const wtCatA = join(TMP_ROOT, 'A2-abcd1234-catA')

  // 场景 1：首次建
  const first = ensureSim(wtCatA)
  steps.push(git(repo, ['worktree', 'list', '--porcelain']))
  checks.push({
    name: '首次建 → 建出（created）',
    pass: first.via === 'created' && first.path === wtCatA,
    detail: `via=${first.via}`,
  })

  // 场景 2：同猫重复建 → 复用，不重建、报错为 0
  const second = ensureSim(wtCatA)
  checks.push({
    name: '重复建 → 复用（reuse，exit 0，不重建）',
    pass: second.via === 'reuse' && second.path === wtCatA,
    detail: `via=${second.via} code=${second.code}`,
  })

  // 场景 3：目录被清掉、分支还在 → 走「分支已存在 → 跳过建分支 → add」
  safeRm(wtCatA)
  git(repo, ['worktree', 'prune'])
  const third = ensureSim(wtCatA)
  steps.push(git(repo, ['worktree', 'list', '--porcelain']))
  checks.push({
    name: '目录清理后重建（分支已存在）→ 成功',
    pass: third.via === 'created',
    detail: `via=${third.via} err=${third.err ?? ''}`,
  })

  // 场景 4（票面点名的风险）：分支已被**另一个** worktree 占用 → 猫分支下必现
  // 注意占用者是 wtCatA（场景 3 重建的正是它），不是别的路径
  const wtOther = join(TMP_ROOT, 'A2-other-path')
  const occupied = git(repo, ['worktree', 'add', '-q', wtOther, branch])
  steps.push(occupied)
  checks.push({
    name: '【风险】分支被别的 worktree 占用 → add 失败，现有实现 return null',
    pass: occupied.code !== 0,
    detail: `code=${occupied.code} err=${occupied.err.split('\n')[0] ?? ''}`,
  })

  // 反向对照：移除**真正持有该分支的** worktree 后，同一命令必须能成功
  // （证明上面的失败来自占用、不是命令本身恒错）
  git(repo, ['worktree', 'remove', '--force', wtCatA])
  safeRm(wtCatA)
  const freed = git(repo, ['worktree', 'add', '-q', wtOther, branch])
  checks.push({
    name: '[对照] 移除持有者后同一命令成功（证明失败判据非恒真）',
    pass: freed.code === 0,
    detail: `code=${freed.code} err=${freed.err.split('\n')[0] ?? ''}`,
  })

  return {
    steps,
    checks,
    verdict:
      '幂等复用依赖「目录存在 + .git 标记」前置检查；一旦分支被另一 worktree 占用，worktree add 必失败 ⇒ 现有实现 return null 静默降级（撞 T-1 收窄后的路径）。',
  }
})

grid('A3', '双猫并存 + 提交作用域', () => {
  const { repo, makeSession } = ctxFor('A3')
  const steps = []
  const checks = []
  const sid = 'abcd1234'

  steps.push(git(repo, ['branch', `session/${sid}`]))
  const wtCatA = join(TMP_ROOT, 'A3-abcd1234-catA')
  const wtCatB = join(TMP_ROOT, 'A3-abcd1234-catB')
  steps.push(
    git(repo, ['worktree', 'add', '-q', '-b', `session/${sid}-catA`, wtCatA, `session/${sid}`])
  )
  steps.push(
    git(repo, ['worktree', 'add', '-q', '-b', `session/${sid}-catB`, wtCatB, `session/${sid}`])
  )

  const probe = 'catA-only.txt'

  // ── S2 反向对照：先让判据红一次 ──
  writeFileSync(join(wtCatB, probe), 'planted in catB\n')
  const controlSees = onDisk(join(wtCatB, probe))
  checks.push({
    name: '[对照] 探针在 catB 确实可见时能测出「可见」（先让它红一次）',
    pass: controlSees === true,
    detail: `catB 自放 → onDisk=${controlSees}`,
  })
  unlinkSync(join(wtCatB, probe))

  // ── 主判据：catA 放未提交文件 ⇒ catB 侧不可见 ──
  writeFileSync(join(wtCatA, probe), 'planted in catA\n')
  const catASees = onDisk(join(wtCatA, probe))
  const catBSees = onDisk(join(wtCatB, probe))
  checks.push({
    name: 'catA 未提交文件 ⇒ catB 工作区不可见',
    pass: catASees === true && catBSees === false,
    detail: `catA=${catASees} catB=${catBSees}`,
  })

  // ── catA 侧 git add -A 扫不到 catB 的未提交文件 ──
  commitFile(wtCatB, 'catB-only.txt', 'from catB\n', 'catB work')
  const addA = git(wtCatA, ['add', '-A'])
  steps.push(addA)
  const stagedA = git(wtCatA, ['diff', '--cached', '--name-only']).out.split('\n').filter(Boolean)
  steps.push(git(wtCatA, ['diff', '--cached', '--name-only']))
  checks.push({
    name: 'catA 侧 git add -A 不扫走 catB 的未提交文件',
    pass: !stagedA.includes('catB-only.txt'),
    detail: `catA 暂存区=[${stagedA.join(',')}]`,
  })

  checks.push({
    name: 'catB worktree 的 status 不受 catA 暂存影响（index 各一）',
    pass: git(wtCatB, ['status', '--porcelain']).out === '',
    detail: `catB status="${git(wtCatB, ['status', '--porcelain']).out}"`,
  })

  // 对照：catB 的已提交文件在 catA 侧也不在（未合并不串味）
  checks.push({
    name: '[对照] catB 已提交内容在 catA 工作区同样不可见（证明探针区分得开）',
    pass: !onDisk(join(wtCatA, 'catB-only.txt')),
    detail: `catA onDisk(catB-only)=${onDisk(join(wtCatA, 'catB-only.txt'))}`,
  })

  return {
    steps,
    checks,
    verdict:
      '两个猫 worktree 各自独立 index/工作区：未提交文件互不可见，一侧 add -A 扫不到另一侧；F1/F4 的病根在一猫一 worktree 下被结构性消除。',
  }
})

// ── 组 B · 审查侧（2 格）─────────────────────────────────

grid('B1', 'detached 审查 worktree 读到该 sha 的树', () => {
  const { repo, makeSession } = ctxFor('B1')
  const steps = []
  const checks = []
  const sid = 'abcd1234'

  steps.push(git(repo, ['branch', `session/${sid}`]))
  const wtCatA = join(TMP_ROOT, 'B1-abcd1234-catA')
  steps.push(
    git(repo, ['worktree', 'add', '-q', '-b', `session/${sid}-catA`, wtCatA, `session/${sid}`])
  )

  const sha = commitFile(wtCatA, 'target.txt', 'committed-version\n', 'catA commit')
  // 工作区改成脏，但不提交
  writeFileSync(join(wtCatA, 'target.txt'), 'dirty-uncommitted-version\n')

  const wtReview = join(TMP_ROOT, 'B1-review')
  const addRev = git(repo, ['worktree', 'add', '-q', '--detach', wtReview, sha])
  steps.push(addRev)

  checks.push({
    name: 'detached 审查 worktree 建立成功',
    pass: addRev.code === 0,
    detail: `code=${addRev.code}`,
  })

  const atReview = readFileSync(join(wtReview, 'target.txt'), 'utf8').trim()
  checks.push({
    name: '审查侧读到的是该 sha 的树（committed-version）',
    pass: atReview === 'committed-version',
    detail: `审查侧内容="${atReview}"`,
  })

  const atCatA = readFileSync(join(wtCatA, 'target.txt'), 'utf8').trim()
  checks.push({
    name: '[对照] catA 工作区确为脏内容（证明两处确实不同、判据有分辨力）',
    pass: atCatA === 'dirty-uncommitted-version',
    detail: `catA 工作区内容="${atCatA}"`,
  })

  checks.push({
    name: '审查 worktree 为 detached（HEAD 不挂分支）',
    pass: git(wtReview, ['symbolic-ref', '-q', 'HEAD']).code !== 0,
    detail: `symbolic-ref code=${git(wtReview, ['symbolic-ref', '-q', 'HEAD']).code}`,
  })

  return {
    steps,
    checks,
    verdict:
      'detached 审查 worktree 读到的是该 sha 的树，不受任何工作区未提交改动污染 —— 审查面与提交面可分离。',
  }
})

grid('B2', '审查 worktree 回收（含 symlink 与 Windows EPERM）', () => {
  const { repo, makeSession } = ctxFor('B2')
  const steps = []
  const checks = []
  const sid = 'abcd1234'

  steps.push(git(repo, ['branch', `session/${sid}`]))

  // ── 场景 1：干净 worktree 正常回收 ──
  const wtClean = join(TMP_ROOT, 'B2-clean')
  steps.push(
    git(repo, ['worktree', 'add', '-q', '-b', `session/${sid}-clean`, wtClean, `session/${sid}`])
  )
  const rmClean = git(repo, ['worktree', 'remove', wtClean])
  steps.push(rmClean)
  checks.push({
    name: '干净 worktree：remove 成功且目录消失、list 无残留',
    pass: rmClean.code === 0 && !onDisk(wtClean),
    detail: `code=${rmClean.code} onDisk=${onDisk(wtClean)}`,
  })

  // ── 场景 2：含未跟踪文件 → 失败形态 ──
  const wtDirty = join(TMP_ROOT, 'B2-dirty')
  steps.push(
    git(repo, ['worktree', 'add', '-q', '-b', `session/${sid}-dirty`, wtDirty, `session/${sid}`])
  )
  writeFileSync(join(wtDirty, 'untracked.txt'), 'x\n')
  const rmDirty = git(repo, ['worktree', 'remove', wtDirty])
  steps.push(rmDirty)
  checks.push({
    name: '含未跟踪文件：remove 失败（需 --force）',
    pass: rmDirty.code !== 0 && onDisk(wtDirty),
    detail: `code=${rmDirty.code} err=${rmDirty.err.split('\n')[0] ?? ''}`,
  })
  const rmForce = git(repo, ['worktree', 'remove', '--force', wtDirty])
  checks.push({
    name: '[对照] 同目录加 --force 后成功（证明失败非恒真）',
    pass: rmForce.code === 0 && !onDisk(wtDirty),
    detail: `code=${rmForce.code}`,
  })

  // ── 场景 3：symlink/junction 跟穿（本仓前科：会删掉目标）──
  const wtLink = join(TMP_ROOT, 'B2-link')
  steps.push(
    git(repo, ['worktree', 'add', '-q', '-b', `session/${sid}-link`, wtLink, `session/${sid}`])
  )
  const decoy = join(TMP_ROOT, 'B2-decoy-node_modules')
  mkdirSync(decoy, { recursive: true })
  writeFileSync(join(decoy, 'canary.txt'), 'alive\n')
  symlinkSync(decoy, join(wtLink, 'node_modules'), 'junction')

  const rmLink = git(repo, ['worktree', 'remove', '--force', wtLink])
  steps.push(rmLink)
  const decoyAliveAfterGitRemove = existsSync(join(decoy, 'canary.txt'))
  checks.push({
    name: 'git worktree remove --force 不跟穿 junction（诱饵文件仍在）',
    pass: decoyAliveAfterGitRemove,
    detail: `诱饵 canary 存活=${decoyAliveAfterGitRemove}；remove code=${rmLink.code}`,
  })

  // 物理残留清理：worktree remove 只清 git 跟踪内容，junction 残留由 safeRm 处理
  const decoyAliveAfterSafeRm = (() => {
    safeRm(wtLink)
    return existsSync(join(decoy, 'canary.txt'))
  })()
  checks.push({
    name: 'safeRm（lstat 判链接 → unlink）清残留且不跟穿（诱饵仍在）',
    pass: decoyAliveAfterSafeRm && !onDisk(wtLink),
    detail: `诱饵存活=${decoyAliveAfterSafeRm} wtLink 残留=${onDisk(wtLink)}`,
  })

  // ── 对照：Node 原生 recursive 删除在 junction 上的行为（复现本仓「跟穿」前科的尝试）──
  // 本仓实证过：删含 junction 的目录时跟穿 ⇒ 删掉主仓库 node_modules。此格在 temp 里安全复现。
  const wtLink2 = join(TMP_ROOT, 'B2-link2')
  steps.push(
    git(repo, ['worktree', 'add', '-q', '-b', `session/${sid}-link2`, wtLink2, `session/${sid}`])
  )
  const decoy2 = join(TMP_ROOT, 'B2-decoy2')
  mkdirSync(decoy2, { recursive: true })
  writeFileSync(join(decoy2, 'canary.txt'), 'alive\n')
  symlinkSync(decoy2, join(wtLink2, 'node_modules'), 'junction')
  let nativeErr = null
  try {
    rmSync(wtLink2, { recursive: true, force: true })
  } catch (e) {
    nativeErr = e.code
  }
  const decoy2Alive = existsSync(join(decoy2, 'canary.txt'))
  checks.push({
    name: '[对照] Node rmSync(recursive) 在 junction 上的行为（前科复现尝试）',
    pass: true, // 记录实测，不作断言 —— 两种结果都是有价值的读数
    detail: decoy2Alive
      ? `诱饵存活=true（Node ${process.version} 的 rmSync 未跟穿；本仓前科不在此版本复现）`
      : `诱饵被删 ⇒ 跟穿！err=${nativeErr}（safeRm 的 lstat 判链接是必需的，不是防御性冗余）`,
  })

  // ── 场景 4：Windows EPERM（他进程持 cwd）──
  const wtHeld = join(TMP_ROOT, 'B2-held')
  const sub = join(wtHeld, 'sub')
  steps.push(
    git(repo, ['worktree', 'add', '-q', '-b', `session/${sid}-held`, wtHeld, `session/${sid}`])
  )
  mkdirSync(sub, { recursive: true })
  // 持目录为 cwd 的子进程 —— 用 **ready 文件握手**确认 chdir 已完成
  // （同 git-utils.test.ts:415 既有用例 `wt-eperm` 的模式；固定 sleep 是弱写法）
  const ready = join(TMP_ROOT, 'B2-held-ready')
  const child = spawn(
    process.execPath,
    [
      '-e',
      `process.chdir(${JSON.stringify(sub)});require('fs').writeFileSync(${JSON.stringify(ready)},'ok');setInterval(()=>{},1000)`,
    ],
    { stdio: 'ignore' }
  )
  const t0 = Date.now()
  while (!existsSync(ready) && Date.now() - t0 < 10000) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
  }
  checks.push({
    name: '持 cwd 子进程已就绪（ready 握手，非固定 sleep）',
    pass: existsSync(ready),
    detail: `ready=${existsSync(ready)} 等待=${Date.now() - t0}ms`,
  })

  let eperm = null
  try {
    safeRm(wtHeld)
  } catch (e) {
    eperm = { code: e.code, msg: String(e.message).split('\n')[0] }
  }
  checks.push({
    name: 'Windows 他进程持 cwd 时的删除形态（实测，记录而非断言）',
    pass: true,
    detail: eperm
      ? `抛错 code=${eperm.code} msg=${eperm.msg}`
      : '未抛错（Node 24 下 rm 未被 cwd 阻塞）',
  })

  // 收尾：杀掉持有者并**等它真正退出**（否则 temp 删不净：Windows cwd 句柄）
  try {
    child.kill('SIGKILL')
  } catch {
    /* 已退出 */
  }
  const tKill = Date.now()
  while (Date.now() - tKill < 5000) {
    try {
      process.kill(child.pid, 0) // 信号 0 = 存在性探测
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    } catch {
      break // ESRCH = 已退出
    }
  }

  return {
    steps,
    checks,
    verdict:
      '干净 worktree 正常回收；含未跟踪需 --force；git worktree remove 本身不跟穿 junction，但只清 git 层——物理残留（symlink 空壳）必须由 safeRm 式「链接先行」清理，绝不 recursive 跟穿。',
  }
})

// ── 组 C · fan-in（5 格，核心）───────────────────────────

grid('C1', '猫分支枚举（前缀边界 + 空集）', () => {
  const { repo } = ctxFor('C1')
  const steps = []
  const checks = []
  const sid = 'abcd1234'

  git(repo, ['branch', `session/${sid}`])
  git(repo, ['branch', `session/${sid}-catA`])
  git(repo, ['branch', `session/${sid}-catB`])
  git(repo, ['branch', 'session/beef5678-catA']) // 别的会话的猫
  git(repo, ['branch', `session/${sid}catC`]) // 无连字符，不该收
  git(repo, ['branch', `session/${sid}-`]) // 空后缀

  // ⚠️ 正确写法必须带 `*`：git 对不含通配符的 pattern 按 `/` 边界匹配，
  //    `refs/heads/session/<sid8>-` 收不到 `refs/heads/session/<sid8>-catA`（见下条实测）
  const enumGlob = `refs/heads/session/${sid}-*`
  const r = git(repo, ['for-each-ref', '--format=%(refname:short)', enumGlob])
  steps.push(r)
  const got = r.out.split('\n').filter(Boolean).sort()

  checks.push({
    name: '枚举 exit 0 且按 <prefix>-* 命中猫分支',
    pass:
      r.code === 0 && got.includes(`session/${sid}-catA`) && got.includes(`session/${sid}-catB`),
    detail: `命中=[${got.join(', ')}]`,
  })

  // 【S3 缺口】裸前缀（无通配符）—— 票面 C1 原文写法，实测收不到猫分支
  const bare = git(repo, [
    'for-each-ref',
    '--format=%(refname:short)',
    `refs/heads/session/${sid}-`,
  ])
  steps.push(bare)
  const bareGot = bare.out.split('\n').filter(Boolean)
  checks.push({
    name: '【坑·S3】裸前缀（无通配符）收不到带后缀的猫分支 —— 必须写 <prefix>-*',
    pass: bare.code === 0 && !bareGot.includes(`session/${sid}-catA`),
    detail: `裸前缀命中=[${bareGot.join(', ')}]（只命中精确同名）`,
  })

  // 实现选型对照：git branch --list 是否与 for-each-ref 等价（Phase I 可二选一）
  const bl = git(repo, ['branch', '--list', `session/${sid}-*`, '--format=%(refname:short)'])
  steps.push(bl)
  const blGot = bl.out.split('\n').filter(Boolean).sort()
  checks.push({
    name: '[选型] git branch --list "<prefix>-*" 与 for-each-ref 结果等价',
    pass: bl.code === 0 && JSON.stringify(blGot) === JSON.stringify(got),
    detail: `branch --list=[${blGot.join(', ')}]`,
  })

  checks.push({
    name: '不误收会话分支本身 session/<sid8>',
    pass: !got.includes(`session/${sid}`),
    detail: `含 session/${sid}=${got.includes(`session/${sid}`)}`,
  })

  checks.push({
    name: '不误收别的会话的猫分支',
    pass: !got.includes('session/beef5678-catA'),
    detail: `含 beef5678=${got.includes('session/beef5678-catA')}`,
  })

  checks.push({
    name: '不误收无连字符的同类名 session/<sid8>catC',
    pass: !got.includes(`session/${sid}catC`),
    detail: `含 ${sid}catC=${got.includes(`session/${sid}catC`)}`,
  })

  checks.push({
    name: '【边界】空后缀 session/<sid8>- 会被前缀命中（需下游防御）',
    pass: got.includes(`session/${sid}-`),
    detail: `含空后缀=${got.includes(`session/${sid}-`)}`,
  })

  // 空集场景：另起一仓，无任何猫分支
  const repo2 = makeRepo('C1-empty')
  git(repo2, ['branch', `session/${sid}`])
  const r2 = git(repo2, ['for-each-ref', '--format=%(refname:short)', enumGlob])
  steps.push(r2)
  checks.push({
    name: '空集：无猫提交过 ⇒ 空输出且 exit 0（不是报错）',
    pass: r2.code === 0 && r2.out === '',
    detail: `code=${r2.code} out="${r2.out}"`,
  })

  // 反向对照：前缀写错时必须收不到（证明枚举非恒真）
  const r3 = git(repo, [
    'for-each-ref',
    '--format=%(refname:short)',
    `refs/heads/session/zzzz9999-*`,
  ])
  checks.push({
    name: '[对照] 换一个不存在的前缀 ⇒ 空（证明前缀匹配非恒真）',
    pass: r3.code === 0 && r3.out === '',
    detail: `out="${r3.out}"`,
  })

  // ── S3-1 危害实证（端到端）：照票面原文（裸前缀）实现的 fan-in ⇒ 静默不合并 ──
  const repo3 = makeRepo('C1-danger')
  git(repo3, ['branch', `session/${sid}`])
  const dCat = join(TMP_ROOT, 'C1-danger-catA')
  git(repo3, ['worktree', 'add', '-q', '-b', `session/${sid}-catA`, dCat, `session/${sid}`])
  commitFile(dCat, 'cat-payload.txt', 'MUST-BE-MERGED\n', 'catA work')
  const dInt = join(TMP_ROOT, 'C1-danger-int')
  git(repo3, ['worktree', 'add', '-q', dInt, `session/${sid}`])

  const dCats = git(repo3, [
    'for-each-ref',
    '--format=%(refname:short)',
    `refs/heads/session/${sid}-`, // 裸前缀 —— 票面 C1 原文写法
  ])
    .out.split('\n')
    .filter(Boolean)
  const dCodes = []
  for (const c of dCats) dCodes.push(git(dInt, ['merge', '--no-ff', '-m', `fan-in ${c}`, c]).code)

  checks.push({
    name: '【S3-1 危害实证】裸前缀 fan-in：全链零报错，猫的提交却完全不在集成分支上',
    pass:
      dCats.length === 0 && dCodes.length === 0 && readAt(dInt, 'HEAD', 'cat-payload.txt') === null,
    detail: `枚举=${dCats.length}条 ⇒ 循环执行${dCodes.length}次（无错可报）⇒ HEAD:cat-payload.txt=${JSON.stringify(readAt(dInt, 'HEAD', 'cat-payload.txt'))}（猫确实提交了这条）`,
  })

  return {
    steps,
    checks,
    verdict:
      'for-each-ref 前缀枚举可用、空集返回空而非报错，且天然不误收会话分支本身与别的会话；但必须写 <prefix>-*（裸前缀只命中精确同名 ⇒ 叠上 E5 的空合并静默成功，构成一条全链零报错的静默不合并）。',
  }
})

grid('C2', '两猫按序 no-ff（E2 的 ff-only 对照）', () => {
  const { repo } = ctxFor('C2')
  const steps = []
  const checks = []
  const sid = 'abcd1234'

  git(repo, ['branch', `session/${sid}`])
  const wtCatA = join(TMP_ROOT, 'C2-catA')
  const wtCatB = join(TMP_ROOT, 'C2-catB')
  git(repo, ['worktree', 'add', '-q', '-b', `session/${sid}-catA`, wtCatA, `session/${sid}`])
  git(repo, ['worktree', 'add', '-q', '-b', `session/${sid}-catB`, wtCatB, `session/${sid}`])
  commitFile(wtCatA, 'fa.txt', 'from catA\n', 'catA work')
  commitFile(wtCatB, 'fb.txt', 'from catB\n', 'catB work')

  // 集成分支落到会话 worktree
  const wtInt = join(TMP_ROOT, 'C2-integration')
  steps.push(git(repo, ['worktree', 'add', '-q', wtInt, `session/${sid}`]))

  // ── 对照：ff-only 在第二条必挂（复现 E2）──
  const ffA = git(wtInt, ['merge', '--ff-only', `session/${sid}-catA`])
  steps.push(ffA)
  const ffB = git(wtInt, ['merge', '--ff-only', `session/${sid}-catB`])
  steps.push(ffB)
  checks.push({
    name: '[对照] ff-only：第一条成功、第二条必挂（复现 E2）',
    pass: ffA.code === 0 && ffB.code !== 0,
    detail: `A code=${ffA.code} / B code=${ffB.code}`,
  })
  checks.push({
    name: 'ff-only 被拒后不留半合并态（MERGE_HEAD 应为阴性）',
    pass: git(wtInt, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).code !== 0,
    detail: `MERGE_HEAD 探测 code=${git(wtInt, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).code}`,
  })

  // ── 主判据：no-ff 两条都走通，且内容在场 ──
  const repo2 = makeRepo('C2-noff')
  git(repo2, ['branch', `session/${sid}`])
  const nCatA = join(TMP_ROOT, 'C2-noff-catA')
  const nCatB = join(TMP_ROOT, 'C2-noff-catB')
  git(repo2, ['worktree', 'add', '-q', '-b', `session/${sid}-catA`, nCatA, `session/${sid}`])
  git(repo2, ['worktree', 'add', '-q', '-b', `session/${sid}-catB`, nCatB, `session/${sid}`])
  commitFile(nCatA, 'fa.txt', 'from catA\n', 'catA work')
  commitFile(nCatB, 'fb.txt', 'from catB\n', 'catB work')
  const nInt = join(TMP_ROOT, 'C2-noff-int')
  steps.push(git(repo2, ['worktree', 'add', '-q', nInt, `session/${sid}`]))

  const m1 = git(nInt, ['merge', '--no-ff', '-m', 'fan-in catA', `session/${sid}-catA`])
  steps.push(m1)
  const m2 = git(nInt, ['merge', '--no-ff', '-m', 'fan-in catB', `session/${sid}-catB`])
  steps.push(m2)

  checks.push({
    name: 'no-ff：catA / catB 两条都成功',
    pass: m1.code === 0 && m2.code === 0,
    detail: `A code=${m1.code} / B code=${m2.code}`,
  })
  checks.push({
    name: '内容在场：集成分支上 fa.txt 与 fb.txt 都在且内容正确',
    pass:
      readAt(nInt, 'HEAD', 'fa.txt') === 'from catA' &&
      readAt(nInt, 'HEAD', 'fb.txt') === 'from catB',
    detail: `fa="${readAt(nInt, 'HEAD', 'fa.txt')}" fb="${readAt(nInt, 'HEAD', 'fb.txt')}"`,
  })
  checks.push({
    name: '两次 merge 各造一个 merge commit（父数 2）',
    pass: git(nInt, ['rev-list', '--parents', '-1', head(nInt)]).out.split(' ').length === 3,
    detail: git(nInt, ['rev-list', '--parents', '-1', head(nInt)]).out,
  })

  return {
    steps,
    checks,
    verdict:
      'fan-in 必须 no-ff：ff-only 在第二条猫分支上必挂（E2 复现），no-ff 两条都走通且内容真进集成分支。',
  }
})

grid('C3', '整链幂等（含 S2 反向对照）', () => {
  const { repo } = ctxFor('C3')
  const steps = []
  const checks = []
  const sid = 'abcd1234'

  git(repo, ['branch', `session/${sid}`])
  const wtCatA = join(TMP_ROOT, 'C3-catA')
  const wtCatB = join(TMP_ROOT, 'C3-catB')
  git(repo, ['worktree', 'add', '-q', '-b', `session/${sid}-catA`, wtCatA, `session/${sid}`])
  git(repo, ['worktree', 'add', '-q', '-b', `session/${sid}-catB`, wtCatB, `session/${sid}`])
  commitFile(wtCatA, 'fa.txt', 'from catA\n', 'catA work')
  commitFile(wtCatB, 'fb.txt', 'from catB\n', 'catB work')
  const wtInt = join(TMP_ROOT, 'C3-int')
  steps.push(git(repo, ['worktree', 'add', '-q', wtInt, `session/${sid}`]))

  /** 整链：按序 no-ff 合并全部猫分支 */
  function runChain() {
    const results = []
    for (const cat of ['catA', 'catB']) {
      results.push(git(wtInt, ['merge', '--no-ff', '-m', `fan-in ${cat}`, `session/${sid}-${cat}`]))
    }
    return results
  }

  const firstRun = runChain()
  steps.push(...firstRun)
  const head1 = head(wtInt)
  const count1 = commitCount(wtInt)

  checks.push({
    name: '首次整链跑通（两条都 exit 0）',
    pass: firstRun.every((r) => r.code === 0),
    detail: `codes=[${firstRun.map((r) => r.code).join(',')}]`,
  })

  // ── 主判据：重跑整链 ⇒ HEAD 不变、无新 commit、exit 0 ──
  const secondRun = runChain()
  steps.push(...secondRun)
  const head2 = head(wtInt)
  const count2 = commitCount(wtInt)
  checks.push({
    name: '整链重跑：HEAD 不变 + commit 数不变 + exit 0',
    pass: head2 === head1 && count2 === count1 && secondRun.every((r) => r.code === 0),
    detail: `HEAD ${head1.slice(0, 8)}→${head2.slice(0, 8)} count ${count1}→${count2}`,
  })

  // ── S2 反向对照：造一次真变更 ⇒ 判据必须测出 HEAD 变化 ──
  const beforeProbe = head(wtInt)
  const countBeforeProbe = commitCount(wtInt)
  commitFile(wtCatA, 'fa-extra.txt', 'new work\n', 'catA new work')
  const probeRun = runChain()
  steps.push(...probeRun)
  const afterProbe = head(wtInt)
  const countAfterProbe = commitCount(wtInt)
  checks.push({
    name: '[对照] 有新提交时判据能测出 HEAD 变化（证明幂等判据非恒真）',
    pass: afterProbe !== beforeProbe && countAfterProbe > countBeforeProbe,
    detail: `HEAD ${beforeProbe.slice(0, 8)}→${afterProbe.slice(0, 8)} count ${countBeforeProbe}→${countAfterProbe}`,
  })

  // ── 回滚 ⇒ 判据回到「不变」──
  git(wtInt, ['reset', '--hard', beforeProbe])
  git(wtCatA, ['reset', '--hard', 'HEAD~1'])
  const rollbackRun = runChain()
  steps.push(...rollbackRun)
  checks.push({
    name: '回滚后重跑：回到「HEAD 不变」（判据恢复绿）',
    pass: head(wtInt) === beforeProbe && rollbackRun.every((r) => r.code === 0),
    detail: `HEAD=${head(wtInt).slice(0, 8)} 期望=${beforeProbe.slice(0, 8)}`,
  })

  return {
    steps,
    checks,
    verdict:
      '整链幂等成立：重跑无新 merge commit、HEAD 不变、exit 0；反向对照证明该判据能测出新提交（非恒真）。中断重跑的安全基石确认。',
  }
})

grid('C4', '真冲突 → MERGE_HEAD 守卫 + 恢复路径', () => {
  const { repo } = ctxFor('C4')
  const steps = []
  const checks = []
  const sid = 'abcd1234'

  // 分叉点先放一个双方都会改的文件 ⇒ 冲突码 UU（票面原文判据）
  commitFile(repo, 'shared.txt', 'line1\nbase\nline3\n', 'base shared file')
  git(repo, ['branch', `session/${sid}`])
  const wtCatA = join(TMP_ROOT, 'C4-catA')
  const wtCatB = join(TMP_ROOT, 'C4-catB')
  git(repo, ['worktree', 'add', '-q', '-b', `session/${sid}-catA`, wtCatA, `session/${sid}`])
  git(repo, ['worktree', 'add', '-q', '-b', `session/${sid}-catB`, wtCatB, `session/${sid}`])
  // 双方改同一文件的同一行 ⇒ UU；双方各自新增同名不同内容文件 ⇒ AA
  commitFile(wtCatA, 'shared.txt', 'line1\nfrom-catA\nline3\n', 'catA edits shared')
  commitFile(wtCatA, 'both.txt', 'added-by-A\n', 'catA adds both')
  commitFile(wtCatB, 'shared.txt', 'line1\nfrom-catB\nline3\n', 'catB edits shared')
  commitFile(wtCatB, 'both.txt', 'added-by-B\n', 'catB adds both')

  const wtInt = join(TMP_ROOT, 'C4-int')
  steps.push(git(repo, ['worktree', 'add', '-q', wtInt, `session/${sid}`]))
  const headBefore = head(wtInt)
  const rA = git(wtInt, ['merge', '--no-ff', '-m', 'fan-in catA', `session/${sid}-catA`])
  steps.push(rA)
  // 冲突前的 HEAD = catA 合完之后（merge --abort 的恢复目标）
  const headBeforeConflict = head(wtInt)

  // ── 对照：非冲突态 MERGE_HEAD **不**存在（证明探测非恒真）──
  const probeClean = git(wtInt, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])
  checks.push({
    name: '[对照] 非冲突态 MERGE_HEAD 探测为阴性（证明守卫非恒真）',
    pass: probeClean.code !== 0,
    detail: `rev-parse MERGE_HEAD code=${probeClean.code}`,
  })

  const rB = git(wtInt, ['merge', '--no-ff', '-m', 'fan-in catB', `session/${sid}-catB`])
  steps.push(rB)
  const statusOut = git(wtInt, ['status', '--porcelain']).out
  steps.push(git(wtInt, ['status', '--porcelain']))

  checks.push({
    name: '真冲突：merge 非 0 退出',
    pass: rB.code !== 0,
    detail: `code=${rB.code}`,
  })
  checks.push({
    name: '冲突后 MERGE_HEAD 存在（守卫能探测到）',
    pass: git(wtInt, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).code === 0,
    detail: `MERGE_HEAD=${head(wtInt, 'MERGE_HEAD').slice(0, 8)}`,
  })
  const UNMERGED_CODES = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']
  const presentCodes = statusOut
    .split('\n')
    .map((l) => l.slice(0, 2))
    .filter((c) => UNMERGED_CODES.includes(c))
  checks.push({
    name: '冲突后存在未合并路径（票面所述 UU 实测在场）',
    pass: presentCodes.includes('UU'),
    detail: `status="${statusOut.replace(/\n/g, ' | ')}" 未合并码=[${[...new Set(presentCodes)].join(',')}]`,
  })
  checks.push({
    name: '【S3】双方各自新增同名文件 ⇒ 冲突码是 AA（不是 UU），守卫须覆盖全码集',
    pass: presentCodes.includes('AA'),
    detail: `实测码=[${[...new Set(presentCodes)].join(',')}]；票面只点名 UU ⇒ 只查 UU 会漏判此形态`,
  })

  // ── 恢复路径 1：merge --abort ──
  const abort = git(wtInt, ['merge', '--abort'])
  steps.push(abort)
  checks.push({
    name: '恢复路径① merge --abort：MERGE_HEAD 消失 + status 干净 + HEAD 回到本次 merge 前',
    pass:
      abort.code === 0 &&
      git(wtInt, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).code !== 0 &&
      git(wtInt, ['status', '--porcelain']).out === '' &&
      head(wtInt) === headBeforeConflict,
    detail: `code=${abort.code} status="${git(wtInt, ['status', '--porcelain']).out}" HEAD=${head(wtInt).slice(0, 8)} 期望=${headBeforeConflict.slice(0, 8)}（分叉点 ${headBefore.slice(0, 8)} 是错的期望——abort 只退本次 merge）`,
  })

  // ── 恢复路径 2：reset --hard ──
  git(wtInt, ['merge', '--no-ff', '-m', 'fan-in catB again', `session/${sid}-catB`])
  const reset = git(wtInt, ['reset', '--hard', headBefore])
  steps.push(reset)
  checks.push({
    name: '恢复路径② reset --hard：MERGE_HEAD 消失 + 可重跑',
    pass:
      reset.code === 0 &&
      git(wtInt, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).code !== 0 &&
      git(wtInt, ['status', '--porcelain']).out === '',
    detail: `code=${reset.code} status="${git(wtInt, ['status', '--porcelain']).out}"`,
  })

  // 重跑证明恢复后确实可跑（不是「看着干净」）
  const rerun = git(wtInt, ['merge', '--no-ff', '-m', 'fan-in catA rerun', `session/${sid}-catA`])
  steps.push(rerun)
  checks.push({
    name: '恢复后重跑：merge 正常返回（exit 0）',
    pass: rerun.code === 0,
    detail: `code=${rerun.code}`,
  })

  return {
    steps,
    checks,
    verdict:
      '真冲突留下 MERGE_HEAD + 未合并码（实测 UU 与 AA 并存）；守卫（rev-parse --verify MERGE_HEAD）能可靠探测且非恒真；两条恢复路径（merge --abort / reset --hard）都能把仓库带回可重跑态。只按 UU 判会漏 AA 形态。',
  }
})

grid('C5', '空合并（猫零提交）不造垃圾 commit', () => {
  const { repo } = ctxFor('C5')
  const steps = []
  const checks = []
  const sid = 'abcd1234'

  git(repo, ['branch', `session/${sid}`])
  const wtCatA = join(TMP_ROOT, 'C5-catA')
  const wtCatB = join(TMP_ROOT, 'C5-catB')
  git(repo, ['worktree', 'add', '-q', '-b', `session/${sid}-catA`, wtCatA, `session/${sid}`])
  // catB 零提交：分支 == 分叉点
  git(repo, ['worktree', 'add', '-q', '-b', `session/${sid}-catB`, wtCatB, `session/${sid}`])
  commitFile(wtCatA, 'fa.txt', 'from catA\n', 'catA work')

  const wtInt = join(TMP_ROOT, 'C5-int')
  steps.push(git(repo, ['worktree', 'add', '-q', wtInt, `session/${sid}`]))

  checks.push({
    name: '前提：catB 分支 == 分叉点（零提交）',
    pass: head(repo, `session/${sid}-catB`) === head(repo, `session/${sid}`),
    detail: `catB=${head(repo, `session/${sid}-catB`).slice(0, 8)} session=${head(repo, `session/${sid}`).slice(0, 8)}`,
  })

  const m1 = git(wtInt, ['merge', '--no-ff', '-m', 'fan-in catA', `session/${sid}-catA`])
  steps.push(m1)
  const headAfterA = head(wtInt)
  const countAfterA = commitCount(wtInt)

  const m2 = git(wtInt, ['merge', '--no-ff', '-m', 'fan-in catB', `session/${sid}-catB`])
  steps.push(m2)
  const countAfterB = commitCount(wtInt)

  checks.push({
    name: '空合并：exit 0 且输出 Already up to date',
    pass: m2.code === 0 && /already up to date/i.test(m2.out + m2.err),
    detail: `code=${m2.code} out="${(m2.out || m2.err).split('\n')[0]}"`,
  })
  checks.push({
    name: '空合并不造 merge commit（commit 数不变、HEAD 不变）',
    pass: countAfterB === countAfterA && head(wtInt) === headAfterA,
    detail: `count ${countAfterA}→${countAfterB} HEAD ${headAfterA.slice(0, 8)}→${head(wtInt).slice(0, 8)}`,
  })

  // 对照：catB 有提交时同一命令必须造 commit（证明上条判据非恒真）
  commitFile(wtCatB, 'fb.txt', 'from catB\n', 'catB work')
  const countBeforeReal = commitCount(wtInt)
  const m3 = git(wtInt, ['merge', '--no-ff', '-m', 'fan-in catB real', `session/${sid}-catB`])
  steps.push(m3)
  checks.push({
    name: '[对照] catB 有提交时 no-ff 确实造 commit（证明判据非恒真）',
    pass: m3.code === 0 && commitCount(wtInt) > countBeforeReal,
    detail: `count ${countBeforeReal}→${commitCount(wtInt)}`,
  })

  return {
    steps,
    checks,
    verdict:
      '猫零提交时 no-ff 合并是 no-op（exit 0 / Already up to date / 不造 commit）—— 每轮收口不会因空猫分支堆积垃圾 commit。',
  }
})

// ── 组 D · 收口与回收（2 格）─────────────────────────────

grid('D1', 'dev 侧 ff-only + 内容在场（含 S2 反对照）', () => {
  const { repo } = ctxFor('D1')
  const steps = []
  const checks = []
  const sid = 'abcd1234'

  git(repo, ['branch', `session/${sid}`])
  const wtCatA = join(TMP_ROOT, 'D1-catA')
  git(repo, ['worktree', 'add', '-q', '-b', `session/${sid}-catA`, wtCatA, `session/${sid}`])
  const marker = 'catA-payload-7f3a.txt'
  commitFile(wtCatA, marker, 'UNIQUE-CAT-A-PAYLOAD\n', 'catA work')

  const wtInt = join(TMP_ROOT, 'D1-int')
  steps.push(git(repo, ['worktree', 'add', '-q', wtInt, `session/${sid}`]))
  steps.push(git(wtInt, ['merge', '--no-ff', '-m', 'fan-in catA', `session/${sid}-catA`]))
  const intSha = head(wtInt)

  // dev 侧 ff-only
  const ff = git(repo, ['merge', '--ff-only', `session/${sid}`])
  steps.push(ff)

  checks.push({
    name: '集成分支 ff-only 进 dev 成功',
    pass: ff.code === 0 && head(repo, 'dev') === intSha,
    detail: `code=${ff.code} dev=${head(repo, 'dev').slice(0, 8)} int=${intSha.slice(0, 8)}`,
  })

  // ── 主判据：内容**在场**（不是「命令 exit 0」）──
  const payload = readAt(repo, 'dev', marker)
  checks.push({
    name: '猫的提交内容确实出现在 dev 上（读内容，非看 exit code）',
    pass: payload === 'UNIQUE-CAT-A-PAYLOAD',
    detail: `dev:${marker} = "${payload}"`,
  })

  // ── S2 反向对照：已知不在场的文件名 ⇒ 同一判据必须报不在场 ──
  const absent = readAt(repo, 'dev', 'definitely-not-present-9c1f.txt')
  checks.push({
    name: '[对照] 已知不在场文件名 ⇒ 判据报不在场（证明非恒真）',
    pass: absent === null,
    detail: `dev:definitely-not-present = ${JSON.stringify(absent)}`,
  })

  // E5 对照：会话分支停在分叉点时的空合并会静默成功
  const repo2 = makeRepo('D1-e5')
  git(repo2, ['branch', `session/${sid}`])
  const r2 = git(repo2, ['merge', '--ff-only', `session/${sid}`])
  steps.push(r2)
  checks.push({
    name: '[对照·E5] 会话分支停在分叉点 ⇒ ff-only 静默成功（exit 0 却什么都没进来）',
    pass: r2.code === 0 && !onDisk(join(repo2, marker)),
    detail: `code=${r2.code} out="${(r2.out || r2.err).split('\n')[0]}"`,
  })

  return {
    steps,
    checks,
    verdict:
      '端到端锚点成立：集成分支 ff-only 进 dev 后猫的提交内容确实在场。「命令 exit 0」不足以判定（E5 对照：空合合同样 exit 0）——判据必须读内容。',
  }
})

grid('D2', '回收（孤儿分支可枚举 + 未合分支不回收）', () => {
  const { repo } = ctxFor('D2')
  const steps = []
  const checks = []
  const sid = 'abcd1234'

  git(repo, ['branch', `session/${sid}`])
  const wtCatA = join(TMP_ROOT, 'D2-catA')
  const wtCatB = join(TMP_ROOT, 'D2-catB')
  git(repo, ['worktree', 'add', '-q', '-b', `session/${sid}-catA`, wtCatA, `session/${sid}`])
  git(repo, ['worktree', 'add', '-q', '-b', `session/${sid}-catB`, wtCatB, `session/${sid}`])
  commitFile(wtCatA, 'fa.txt', 'from catA\n', 'catA work')
  commitFile(wtCatB, 'fb.txt', 'from catB\n', 'catB work')

  const wtInt = join(TMP_ROOT, 'D2-int')
  steps.push(git(repo, ['worktree', 'add', '-q', wtInt, `session/${sid}`]))
  // 只合 catA ⇒ catB 未合
  const mA = git(wtInt, ['merge', '--no-ff', '-m', 'fan-in catA', `session/${sid}-catA`])
  steps.push(mA)
  git(repo, ['merge', '--ff-only', `session/${sid}`])

  // ── 孤儿分支场景：catB 的 worktree 目录被外力删掉（模拟残留）──
  safeRm(wtCatB)
  git(repo, ['worktree', 'prune'])
  steps.push(git(repo, ['worktree', 'list', '--porcelain']))

  // 必须带 `*`（同 C1 的坑）
  const enumR = git(repo, [
    'for-each-ref',
    '--format=%(refname:short)',
    `refs/heads/session/${sid}-*`,
  ])
  steps.push(enumR)
  const cats = enumR.out.split('\n').filter(Boolean)
  checks.push({
    name: 'worktree 被删后，孤儿分支仍能被前缀枚举到',
    pass: cats.includes(`session/${sid}-catB`),
    detail: `枚举=[${cats.join(', ')}]`,
  })

  // ── 回收：仅回收「已合进 dev」的猫分支 ──
  /** 猫分支 → 其 worktree 路径（显式映射，不做字符串推导） */
  const wtOfCat = {
    [`session/${sid}-catA`]: wtCatA,
    [`session/${sid}-catB`]: wtCatB,
  }
  const reused = []
  const kept = []
  for (const cat of cats) {
    const merged = git(repo, ['merge-base', '--is-ancestor', cat, 'dev']).code === 0
    if (!merged) {
      kept.push(cat)
      continue
    }
    // 先摘 worktree（有的话），再删分支 —— 顺序不能反，分支被 worktree 占用时删不掉
    const wtPath = wtOfCat[cat]
    if (wtPath && onDisk(wtPath)) {
      git(repo, ['worktree', 'remove', '--force', wtPath])
      safeRm(wtPath)
    }
    git(repo, ['branch', '-D', cat])
    reused.push(cat)
  }

  const remaining = git(repo, [
    'for-each-ref',
    '--format=%(refname:short)',
    `refs/heads/session/${sid}-*`,
  ])
    .out.split('\n')
    .filter(Boolean)
  steps.push(git(repo, ['branch', '--format=%(refname:short)']))

  checks.push({
    name: '已合猫分支（catA）被回收',
    pass: reused.includes(`session/${sid}-catA`) && !remaining.includes(`session/${sid}-catA`),
    detail: `回收=[${reused.join(', ')}] 剩余=[${remaining.join(', ')}]`,
  })
  checks.push({
    name: '【硬前提】未合猫分支（catB）**不被回收**',
    pass: kept.includes(`session/${sid}-catB`) && remaining.includes(`session/${sid}-catB`),
    detail: `保留=[${kept.join(', ')}]`,
  })
  checks.push({
    name: '会话分支本身不在回收面内',
    pass: remaining.every((b) => b !== `session/${sid}`),
    detail: `session/${sid} 仍在=${git(repo, ['rev-parse', '--verify', `refs/heads/session/${sid}`]).code === 0}`,
  })

  // 反向对照：把参数换成 dev，同一判据必须报「已合」（证明 is-ancestor 判据非恒真）
  const ctrlMerged = git(repo, ['merge-base', '--is-ancestor', 'dev', 'dev'])
  const ctrlUnmerged = git(repo, ['merge-base', '--is-ancestor', `session/${sid}-catB`, 'dev'])
  checks.push({
    name: '[对照] is-ancestor 判据有分辨力（dev 自身=已合 / catB=未合）',
    pass: ctrlMerged.code === 0 && ctrlUnmerged.code !== 0,
    detail: `dev↦dev code=${ctrlMerged.code} / catB↦dev code=${ctrlUnmerged.code}`,
  })

  return {
    steps,
    checks,
    verdict:
      '回收可识别孤儿分支（worktree 已删仍可枚举）；「已合才回收」用 merge-base --is-ancestor 判定，未合分支被正确保留 —— 不会把未合的活删掉。',
  }
})

// ── 运行器 ───────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2)
  const keep = argv.includes('--keep')
  const wanted = argv.filter((a) => !a.startsWith('--')).map((s) => s.toUpperCase())
  const targets = wanted.length ? GRIDS.filter((g) => wanted.includes(g.id)) : GRIDS

  console.log(`T-2 Phase S 模拟矩阵 · 临时根 = ${TMP_ROOT}`)
  console.log(
    `git ${git(TMP_ROOT, ['--version']).out.replace('git version ', 'v')} · node ${process.version}`
  )
  console.log('')

  const results = []
  for (const g of targets) {
    const r = (() => {
      try {
        return g.fn()
      } catch (e) {
        return {
          steps: [],
          checks: [{ name: '格执行抛错', pass: false, detail: String(e.message).split('\n')[0] }],
          verdict: `抛错：${e.message}`,
        }
      }
    })()
    results.push({ id: g.id, title: g.title, ...r })

    console.log(`── ${g.id} · ${g.title} ${'─'.repeat(Math.max(0, 46 - g.title.length))}`)
    for (const s of r.steps) {
      const out = (s.out || s.err || '').split('\n')[0].slice(0, 100)
      console.log(`   $ ${s.cmd}`)
      console.log(`     code=${s.code}${out ? ` | ${out}` : ''}`)
    }
    for (const c of r.checks) {
      console.log(`   ${c.pass ? '✓' : '✗'} ${c.name}`)
      if (c.detail) console.log(`       ${c.detail}`)
    }
    console.log(`   ⇒ ${r.verdict}`)
    console.log('')
  }

  // 汇总表
  console.log('═'.repeat(78))
  console.log('汇总')
  console.log('═'.repeat(78))
  let allPass = true
  for (const r of results) {
    const pass = r.checks.filter((c) => c.pass).length
    const total = r.checks.length
    const ok = pass === total
    if (!ok) allPass = false
    console.log(
      `${ok ? '✓' : '✗'} ${r.id.padEnd(4)} ${String(pass).padStart(2)}/${total}  ${r.title}`
    )
  }
  console.log('')
  console.log(
    `格数 ${results.length} · 断言 ${results.reduce((a, r) => a + r.checks.length, 0)} 条`
  )

  // 清理 + 删净复核读数
  if (!keep) {
    const before = existsSync(TMP_ROOT)
    safeRm(TMP_ROOT)
    console.log('')
    console.log(`删净复核：${TMP_ROOT} 删除前存在=${before} 删除后存在=${existsSync(TMP_ROOT)}`)
  } else {
    console.log('')
    console.log(`--keep：临时根保留在 ${TMP_ROOT}`)
  }

  process.exitCode = allPass ? 0 : 1
}

main()
