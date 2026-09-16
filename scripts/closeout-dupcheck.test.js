/**
 * `scripts/closeout-dupcheck.mjs` 的判据矩阵 —— 票 `docs/run/docs-single-writer/tickets.md`
 * §三 逐格覆盖（V1–V6、V9；V7 真仓读数走 CLI 人工留痕，见下）。
 *
 * 三条防「矩阵退化成测了个常量」的结构性断言：
 *   ① **非恒真对照**（V5，**真变异源码**）：把判据行 `blobA === blobB` 改成 `!==`，
 *      在 `os.tmpdir()` 里改出一份变异副本 import 进来 ⇒ **V1 必须变红**。不是「另写
 *      一个反判据比对」——那证明的只是测试自己；变异真的落在被测源码上才算数。
 *   ② **有面 / 无面必须可区分**：判据无面（一侧是另一侧祖先）虽然也 `exit 0`，但**必须**
 *      在 stderr 留警示。「无命中」与「没对账」读数不同，混同就是假绿门（本仓既有病）。
 *   ③ **沙箱卫生**（V9）：临时仓一律 `os.tmpdir()`；**注入的 git 定位变量必须被剥离**
 *      ——主仓 `core.bare` 被测试写成 `true` 的前科已复发 2 次，故这一格走**真注入真跑**，
 *      不是静态断言。
 *
 * V7（真仓 `dev` vs `session/4c8acf70`）**不进本套件**：它非 hermetic（读数随仓状态变），
 * 进套件等于把 CI 绑死在某次快照上。该读数按票面要求单独留在 `report.md`。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  DupcheckError,
  findDupLandings,
  inspectDupLandings,
  isDupLanding,
} from './closeout-dupcheck.mjs'
import { cleanGitEnv } from './commit-uuid-gate.mjs'

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(SCRIPTS_DIR, 'closeout-dupcheck.mjs')
const SRC = readFileSync(SCRIPT, 'utf8')
/** 本仓根（scripts/ 的父目录）——沙箱必须**不在**它下面（V9 红线 1） */
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..')

/** 外层仓库的**公共** gitdir（worktree 里 `--git-common-dir` 回主仓库）——V9 注入面用它，
 *  必须是**真存在且是别的仓**的路径，否则「注入无效」会让该格恒绿 */
function outerGitDir() {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: cleanGitEnv(),
  })
  return (r.stdout || '').trim()
}
const OUTER_GIT_DIR = outerGitDir()
const OUTER_ROOT = OUTER_GIT_DIR ? path.resolve(OUTER_GIT_DIR, '..') : REPO_ROOT

const sandboxes = []
const tmpFiles = []

/**
 * 宿主全局 git config 隔离：被测模块内部的 `git()` 读的是 `process.env`，
 * 若宿主配了 `diff.renames` / `core.quotePath` 之类，沙箱读数就不再封闭。
 * 本套件生命周期内把 HOME 挪到临时目录 ⇒ 全局 config 查无此文件。
 */
let savedHome = {}
beforeAll(() => {
  const iso = mkdtempSync(path.join(tmpdir(), 'closeout-dupcheck-home-'))
  sandboxes.push(iso)
  savedHome = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  }
  process.env.HOME = iso
  process.env.USERPROFILE = iso
  process.env.XDG_CONFIG_HOME = iso
  process.env.GIT_CONFIG_NOSYSTEM = '1'
})

afterAll(() => {
  for (const [k, v] of Object.entries(savedHome)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  for (const d of sandboxes) rmSync(d, { recursive: true, force: true })
  for (const f of tmpFiles) rmSync(f, { force: true })
})

/** 断言性 git 调用：非 0 退出即抛（造沙箱用）。env 走 `cleanGitEnv()`——本测试自身
 *  也常在 pre-commit 里跑（`pre-commit → pnpm test`），注入的 `GIT_DIR` 透传会让
 *  沙箱里的 `git commit` 认外层仓库，测试就不再封闭。剥离清单与源码同源。 */
function git(cwd, args, extraEnv = {}) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...cleanGitEnv(), ...extraEnv },
  })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${r.stderr || r.stdout}`)
  return (r.stdout || '').trim()
}

/** 造沙箱：`main` 上一个基线 commit（= 后面各分支的共同祖先），身份/配置写死 ⇒ 读数与宿主无关 */
function makeSandbox() {
  const root = mkdtempSync(path.join(tmpdir(), 'closeout-dupcheck-'))
  sandboxes.push(root)
  const env = {
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: root,
    GIT_AUTHOR_NAME: 'sandbox',
    GIT_AUTHOR_EMAIL: 'sandbox@local',
    GIT_COMMITTER_NAME: 'sandbox',
    GIT_COMMITTER_EMAIL: 'sandbox@local',
  }
  git(root, ['init', '-q', '-b', 'main'], env)
  git(root, ['config', 'user.name', 'sandbox'], env)
  git(root, ['config', 'user.email', 'sandbox@local'], env)
  git(root, ['config', 'commit.gpgsign', 'false'], env)
  writeFileSync(path.join(root, 'seed.md'), 'seed\n')
  mkdirSync(path.join(root, 'docs'), { recursive: true })
  writeFileSync(path.join(root, 'docs', 'legacy.md'), 'legacy\n') // 基线就有：供「一侧删除」那格用
  git(root, ['add', 'seed.md', 'docs/legacy.md'], env)
  git(root, ['commit', '-q', '-m', 'base'], env)
  return { root, env, base: git(root, ['rev-parse', 'HEAD'], env) }
}

/** 从 `main` 基线切出 `branch`，写 `files`（路径 → 内容）并提交一笔；`files` 为空 ⇒ 只切分支 */
function commitOn(sb, branch, files, msg) {
  git(sb.root, ['checkout', '-q', '-B', branch, 'main'], sb.env)
  const paths = Object.keys(files)
  if (paths.length === 0) return
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(sb.root, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  git(sb.root, ['add', '--', ...paths], sb.env)
  git(sb.root, ['commit', '-q', '-m', msg], sb.env)
}

/** 跑被测 CLI。**故意不洗 env**——洗 env 正是被测对象（V9），洗了就测不到 */
function runCli(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

const SAME = '同一份内容\n'
const OTHER = '另一份内容\n'

// ─── V1 受控正例 ────────────────────────────────────────────────

describe('V1 正例 · 两侧对同一文件写相同内容 ⇒ 命中', () => {
  const sb = makeSandbox()
  commitOn(sb, 'branchA', { 'docs/dup.md': SAME }, 'A 写 dup')
  commitOn(sb, 'branchB', { 'docs/dup.md': SAME }, 'B 写 dup')

  it('契约面 findDupLandings 返回 {file, shaA, shaB}', () => {
    const hits = findDupLandings({ refA: 'branchA', refB: 'branchB', cwd: sb.root })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toEqual({
      file: 'docs/dup.md',
      shaA: expect.stringMatching(/^[0-9a-f]{40}$/),
      shaB: expect.stringMatching(/^[0-9a-f]{40}$/),
    })
    // 命中的**要害**：两侧逐字节相同
    expect(hits[0].shaA).toBe(hits[0].shaB)
  })

  it('读数面带两侧提交（供收口方裁决保留哪一侧）', () => {
    const r = inspectDupLandings({ refA: 'branchA', refB: 'branchB', cwd: sb.root })
    expect(r.vacuous).toBe(false)
    expect(r.base).toBe(sb.base)
    expect(r.common).toEqual(['docs/dup.md'])
    expect(r.hits[0].commitsA).toHaveLength(1)
    expect(r.hits[0].commitsB).toHaveLength(1)
  })

  it('V6 输出可定位：exit 1 + 文件路径 + 两侧 sha 都打在 stderr', () => {
    const r = inspectDupLandings({ refA: 'branchA', refB: 'branchB', cwd: sb.root })
    const cli = runCli(['--a', 'branchA', '--b', 'branchB', '--cwd', sb.root])
    expect(cli.status).toBe(1)
    expect(cli.stderr).toContain('docs/dup.md')
    expect(cli.stderr).toContain(r.hits[0].shaA)
    expect(cli.stderr).toContain(r.hits[0].shaB)
    expect(cli.stdout).toContain('命中=1')
  })
})

// ─── V2–V4 反例 ────────────────────────────────────────────────

describe('V2 反例 · 同文件不同内容 ⇒ 不命中（正常 merge 面）', () => {
  const sb = makeSandbox()
  commitOn(sb, 'branchA', { 'docs/x.md': SAME }, 'A 写 x')
  commitOn(sb, 'branchB', { 'docs/x.md': OTHER }, 'B 写 x')

  it('blob 不同 ⇒ hits 为空，且不落 skipped（它根本没进判据）', () => {
    const r = inspectDupLandings({ refA: 'branchA', refB: 'branchB', cwd: sb.root })
    expect(r.common).toEqual(['docs/x.md'])
    expect(r.hits).toEqual([])
    expect(r.skipped).toEqual([])
    expect(runCli(['--a', 'branchA', '--b', 'branchB', '--cwd', sb.root]).status).toBe(0)
  })

  it('非恒真对照：**同一基线**上「同内容」与「不同内容」读数必须不同', () => {
    const sb = makeSandbox()
    commitOn(sb, 'sameA', { 'docs/same.md': SAME }, 'sameA')
    commitOn(sb, 'sameB', { 'docs/same.md': SAME }, 'sameB')
    commitOn(sb, 'diffA', { 'docs/diff.md': SAME }, 'diffA')
    commitOn(sb, 'diffB', { 'docs/diff.md': OTHER }, 'diffB')
    const hit = inspectDupLandings({ refA: 'sameA', refB: 'sameB', cwd: sb.root })
    const miss = inspectDupLandings({ refA: 'diffA', refB: 'diffB', cwd: sb.root })
    expect(hit.hits).toHaveLength(1)
    expect(miss.hits).toHaveLength(0)
    // 同一基线 ⇒ 拓扑与 Δ 面形状全同（各 1 文件、交集各 1），**唯一变量是 blob 是否相同**
    expect(hit.base).toBe(sb.base)
    expect(miss.base).toBe(sb.base)
    expect(hit.common).toEqual(['docs/same.md'])
    expect(miss.common).toEqual(['docs/diff.md'])
  })
})

describe('V3 反例 · 单侧 ⇒ 不命中', () => {
  it('两侧各有提交，但只有一侧触及该文件', () => {
    const sb = makeSandbox()
    commitOn(sb, 'branchA', { 'docs/only-a.md': SAME }, 'A 写 only-a')
    commitOn(sb, 'branchB', { 'docs/only-b.md': OTHER }, 'B 写 only-b')
    const r = inspectDupLandings({ refA: 'branchA', refB: 'branchB', cwd: sb.root })
    expect(r.vacuous).toBe(false)
    expect(r.hits).toEqual([])
    expect(r.common).toEqual([])
  })

  it('★ 收口记录豁免的机械面：两侧都在 Δ 里，但一侧删了它 ⇒ 取不到 blob，落 skipped', () => {
    const sb = makeSandbox()
    // A 侧删除基线文件；B 侧改它 —— 两侧**都**进 Δ，交集非空（这正是误报的候选形态）
    commitOn(sb, 'branchA', {}, 'noop placeholder')
    git(sb.root, ['rm', '-q', 'docs/legacy.md'], sb.env)
    git(sb.root, ['commit', '-q', '-m', 'A 删 legacy'], sb.env)
    commitOn(sb, 'branchB', { 'docs/legacy.md': OTHER }, 'B 改 legacy')

    const r = inspectDupLandings({ refA: 'branchA', refB: 'branchB', cwd: sb.root })
    expect(r.common).toEqual(['docs/legacy.md'])
    expect(r.hits).toEqual([])
    expect(r.skipped).toEqual([
      { file: 'docs/legacy.md', reason: '一侧 tip 上无此路径（删除）⇒ 不构成重复落盘' },
    ])
  })
})

describe('V4 反例 · 无交集 ⇒ 不命中', () => {
  const sb = makeSandbox()
  commitOn(sb, 'branchA', { 'docs/a.md': SAME }, 'A 写 a')
  commitOn(sb, 'branchB', { 'docs/b.md': SAME }, 'B 写 b')

  it('两侧改不同文件 ⇒ hits 空、交集空', () => {
    const r = inspectDupLandings({ refA: 'branchA', refB: 'branchB', cwd: sb.root })
    expect(r.vacuous).toBe(false)
    expect(r.common).toEqual([])
    expect(r.hits).toEqual([])
  })

  it('无命中路径 exit 0（V6 的零命中半边）', () => {
    const cli = runCli(['--a', 'branchA', '--b', 'branchB', '--cwd', sb.root])
    expect(cli.status).toBe(0)
    expect(cli.stdout).toContain('✅')
  })
})

// ─── V5 反向对照（真变异源码）──────────────────────────────────

describe('V5 反向对照 · 判据非恒真', () => {
  /** 变异面取**判据那一行**（注释里的散文也含 `blobA === blobB`，按短串替换会打偏 ⇒ 这里锚整行） */
  const NEEDLE = 'return blobA === blobB && commitsA.length > 0 && commitsB.length > 0'

  it('源码含唯一的判据行（替换面成立的前提——打偏则本组静默变假绿）', () => {
    const n = SRC.split(NEEDLE).length - 1
    expect(n, `判据行出现 ${n} 次，变异替换面不成立`).toBe(1)
  })

  it('把 === 改成 !== ⇒ V1 正例必须变红', async () => {
    const mutated = SRC.replace(
      "from './commit-uuid-gate.mjs'",
      `from ${JSON.stringify(pathToFileURL(path.join(SCRIPTS_DIR, 'commit-uuid-gate.mjs')).href)}`
    ).replace(NEEDLE, 'blobA !== blobB')
    expect(mutated).not.toBe(SRC)
    expect(mutated).toContain('blobA !== blobB')

    const dir = mkdtempSync(path.join(tmpdir(), 'closeout-dupcheck-mut-'))
    sandboxes.push(dir)
    const file = path.join(dir, 'mutated.mjs')
    tmpFiles.push(file)
    writeFileSync(file, mutated)

    const mod = await import(pathToFileURL(file).href)
    const sb = makeSandbox()
    commitOn(sb, 'branchA', { 'docs/dup.md': SAME }, 'A 写 dup')
    commitOn(sb, 'branchB', { 'docs/dup.md': SAME }, 'B 写 dup')

    // 未变异时命中（同 fixture 的同一读数）
    expect(
      inspectDupLandings({ refA: 'branchA', refB: 'branchB', cwd: sb.root }).hits
    ).toHaveLength(1)
    // 变异后 V1 变红 —— 证明 V1 真的在考这条判据，而不是恒真
    expect(mod.findDupLandings({ refA: 'branchA', refB: 'branchB', cwd: sb.root })).toEqual([])
    // 变异体只改判据、不改结构：Δ 面读数不变（排除「变异把模块改坏了」的伪红）
    const m = mod.inspectDupLandings({ refA: 'branchA', refB: 'branchB', cwd: sb.root })
    expect(m.common).toEqual(['docs/dup.md'])
    expect(m.vacuous).toBe(false)
  })

  it('纯函数面：blob 缺一 / 单侧零提交 都不算命中', () => {
    expect(isDupLanding('a', 'a', ['x'], ['y'])).toBe(true)
    expect(isDupLanding('a', 'b', ['x'], ['y'])).toBe(false)
    expect(isDupLanding(null, 'a', ['x'], ['y'])).toBe(false)
    expect(isDupLanding('a', null, ['x'], ['y'])).toBe(false)
    expect(isDupLanding('a', 'a', [], ['y'])).toBe(false)
    expect(isDupLanding('a', 'a', ['x'], [])).toBe(false)
  })
})

// ─── 有面 / 无面必须可区分 ─────────────────────────────────────

describe('判据无面（vacuous）与「无命中」不是同一个读数', () => {
  it('同一 commit ⇒ 抛（exit 2）：该形态每次都「无命中」，是假绿门', () => {
    const sb = makeSandbox()
    expect(() => inspectDupLandings({ refA: 'main', refB: 'main', cwd: sb.root })).toThrow(
      DupcheckError
    )
    const cli = runCli(['--a', 'main', '--b', 'main', '--cwd', sb.root])
    expect(cli.status).toBe(2)
    expect(cli.stderr).toContain('判据无主体')
  })

  it('一侧是另一侧祖先 ⇒ exit 0 但**必须**在 stderr 留警示', () => {
    const sb = makeSandbox()
    commitOn(sb, 'branchA', { 'docs/a.md': SAME }, 'A 写 a')
    const r = inspectDupLandings({ refA: 'main', refB: 'branchA', cwd: sb.root })
    expect(r.vacuous).toBe(true)
    expect(r.vacuousReason).toContain('祖先')
    const cli = runCli(['--a', 'main', '--b', 'branchA', '--cwd', sb.root])
    expect(cli.status).toBe(0)
    expect(cli.stderr).toContain('判据无面')
    expect(cli.stderr).toContain('不是「检查通过」')
  })

  it('对照：真跑了一遍且干净 ⇒ **不**打无面警示（否则警示退化成噪音）', () => {
    const sb = makeSandbox()
    commitOn(sb, 'branchA', { 'docs/a.md': SAME }, 'A 写 a')
    commitOn(sb, 'branchB', { 'docs/b.md': OTHER }, 'B 写 b')
    const cli = runCli(['--a', 'branchA', '--b', 'branchB', '--cwd', sb.root])
    expect(cli.status).toBe(0)
    expect(cli.stderr).not.toContain('判据无面')
  })

  it('ref 解析不出 / 无共同祖先 ⇒ exit 2（跑不动 ≠ 放行）', () => {
    const sb = makeSandbox()
    expect(runCli(['--a', 'nope', '--b', 'main', '--cwd', sb.root]).status).toBe(2)

    const orphan = mkdtempSync(path.join(tmpdir(), 'closeout-dupcheck-orphan-'))
    sandboxes.push(orphan)
    git(orphan, ['init', '-q', '-b', 'main'], { ...sb.env, HOME: orphan, USERPROFILE: orphan })
    git(orphan, ['config', 'user.name', 'sandbox'], { ...sb.env, HOME: orphan })
    git(orphan, ['config', 'user.email', 'sandbox@local'], { ...sb.env, HOME: orphan })
    writeFileSync(path.join(orphan, 'x.md'), 'x\n')
    git(orphan, ['add', 'x.md'], { ...sb.env, HOME: orphan })
    git(orphan, ['commit', '-q', '-m', 'orphan'], { ...sb.env, HOME: orphan })
    // 两个无共同祖先的仓 → 用同一仓的两个 root commit 模拟：merge-base 会失败
    git(orphan, ['checkout', '-q', '--orphan', 'other'], { ...sb.env, HOME: orphan })
    git(orphan, ['commit', '-q', '-m', 'orphan2', '--allow-empty'], { ...sb.env, HOME: orphan })
    expect(runCli(['--a', 'main', '--b', 'other', '--cwd', orphan]).status).toBe(2)
  })

  it('调用方错误（未知参数 / 缺值）⇒ exit 2，且不静默回落默认值', () => {
    expect(runCli(['--nope']).status).toBe(2)
    expect(runCli(['--a']).status).toBe(2)
  })
})

// ─── V9 沙箱卫生 ──────────────────────────────────────────────

describe('V9 沙箱卫生', () => {
  it('临时仓一律落 os.tmpdir()，且不在仓库根下（红线 1）', () => {
    const sb = makeSandbox()
    const tmp = realpathSync(tmpdir())
    expect(sb.root.startsWith(tmp)).toBe(true)
    expect(sb.root.startsWith(realpathSync(REPO_ROOT))).toBe(false)
  })

  it('★ 注入 GIT_DIR / GIT_INDEX_FILE 仍读沙箱仓（剥注入变量走真注入真跑）', () => {
    const sb = makeSandbox()
    commitOn(sb, 'branchA', { 'docs/dup.md': SAME }, 'A 写 dup')
    commitOn(sb, 'branchB', { 'docs/dup.md': SAME }, 'B 写 dup')

    const clean = runCli(['--a', 'branchA', '--b', 'branchB', '--cwd', sb.root])
    // 注入值必须指向**真实存在的另一个仓**（外层仓库），否则「注入无效」⇒ 本格恒绿
    expect(OUTER_GIT_DIR, '解析不出外层 gitdir ⇒ 本格失去判别力').not.toBe('')
    expect(OUTER_GIT_DIR.startsWith(realpathSync(sb.root))).toBe(false)
    const injected = runCli(['--a', 'branchA', '--b', 'branchB', '--cwd', sb.root], {
      GIT_DIR: OUTER_GIT_DIR,
      GIT_WORK_TREE: OUTER_ROOT,
      GIT_INDEX_FILE: path.join(OUTER_GIT_DIR, 'index'),
      GIT_COMMON_DIR: OUTER_GIT_DIR,
    })
    // 若剥离失效：`branchA` 在外层仓库解析不出 ⇒ exit 2，读数与 clean 不同
    expect(injected.status).toBe(clean.status)
    expect(injected.status).toBe(1)
    expect(injected.stderr).toContain('docs/dup.md')
    expect(injected.stdout).toContain(sb.base.slice(0, 7))
  })

  it('结构不变量：全源只有**一个** git 出口（剥离清单不可能漏施一处）', () => {
    const n = SRC.split('execFileSync(').length - 1
    expect(n, `execFileSync 出现 ${n} 次——新开第二个 git 出口就绕过了 cleanGitEnv`).toBe(1)
    expect(SRC).toContain('cleanGitEnv()')
  })

  it('结构不变量：只读仓（红线 3——不得 checkout / reset / commit / add）', () => {
    for (const w of ['checkout', 'reset', 'commit', 'add']) {
      expect(SRC, `源码出现写仓动词 ${w}`).not.toMatch(new RegExp(`['"]${w}['"]`))
    }
  })
})
