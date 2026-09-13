/**
 * `.husky/pre-commit` env 卫生回归护栏 —— git 注入的定位变量必须在钩子顶部被剥掉。
 *
 * 背景（票 `docs/run/test-git-env-pollution/tickets.md` · Phase A 取证
 * `docs/run/test-git-env-pollution/phase-a-evidence.md`）：在 worktree 内 commit 时，git 向钩子注入
 * **绝对** `GIT_DIR`（`.git/worktrees/<name>`）与 `GIT_INDEX_FILE`，而 `GIT_DIR` 优先级**高于** cwd
 * 探测 ⇒ 钩子里跑 `pnpm test` 时，测试里 `{ cwd: tmp }` 的 `git init/config/commit` 全被打到**真实
 * 仓库**上（共享 config 被写 `core.bare=true` / `user.*`，worktree 分支被 fake 提交篡改）。
 * 修点 = C1：钩子顶部（`set -e` 之后、`npx lint-staged` 之前）`unset` 掉定位类变量。
 *
 * 本用例 = A2/A3 承重反例。沙箱复刻真实拓扑（主仓库 + 链接 worktree + **共享 config**），钩子 =
 * 「dump 继承到的 `GIT_*`」+「**从真实 `.husky/pre-commit` 抽出的 `unset` 行**」+「node 子进程
 * payload（复刻测试的典型操作面：`{ cwd: tmp }` 出 git）」——被重放的剥离行**直接取自真实钩子
 * 文件**，故 ⇒ **把真实钩子里那行 `unset` 删掉，本用例必红**（A3 实跑过红→绿，见交付说明）；
 * 不删则绿（A2）。
 *
 * 两条防假绿（照 A1 的 dump 方法论）：
 *   1. **断言注入真的到达了钩子**（dump 里有指向 `…/worktrees/…` 的 `GIT_DIR`）——缺这一步，
 *      「注入没发生」也会让「沙箱没被污染」绿掉，验的就不是被判的那面。
 *   2. **本测试自身出 git 一律走 `cleanGitEnv()`**：它自己就常在 pre-commit 里跑，透传被注入的
 *      `GIT_DIR` 会让它自己的 git 调用认外层真实仓库（那才是真事故）。复用 `commit-uuid-gate.mjs`
 *      的导出，不另抄第 8 份复制品（OQ-2 未立单源化票，新消费方至少别再增加面）。
 *
 * 沙箱一律落 `os.tmpdir()`——不落仓库根（仓根临时产物会被 auto-commit 扫走）。
 */
import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanGitEnv } from './commit-uuid-gate.mjs'

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url))
const PRE_COMMIT = path.resolve(SCRIPTS_DIR, '..', '.husky', 'pre-commit')

/** 被测对象 = 真实钩子里「剥离注入变量」的那些行；沙箱钩子只重放它们（删行 ⇒ 抽不到 ⇒ 必红） */
function stripLines() {
  return readFileSync(PRE_COMMIT, 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^\s*unset\s/.test(l))
}

/** Windows 路径 → POSIX（钩子是 sh 跑的，反斜杠会被当转义符） */
const toPosix = (p) => p.replace(/\\/g, '/')

/** 断言性 git 调用：非 0 退出即抛（造沙箱用） */
function git(cwd, args, extraEnv = {}) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...cleanGitEnv(), ...extraEnv },
  })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${r.stderr || r.stdout}`)
  return (r.stdout || '').trim()
}

/** 读数用：失败不抛，把「命令跑不动」本身变成可断言的值 */
function gitOut(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...cleanGitEnv() } })
  return r.status === 0 ? (r.stdout || '').trim() : `<exit ${r.status}> ${(r.stderr || '').trim()}`
}

const sandboxes = []
afterAll(() => {
  for (const d of sandboxes) rmSync(d, { recursive: true, force: true })
})

/**
 * 造一个沙箱：主仓库 + 链接 worktree + **共享 config**、probe 区（钩子 / dump / payload / tmp）。
 * 隔离宿主机全局 config（`GIT_CONFIG_NOSYSTEM` + 改 `HOME`），身份写死 ⇒ 读数与宿主无关。
 */
function makeSandbox() {
  const root = mkdtempSync(path.join(tmpdir(), 'pre-commit-env-'))
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
  const at = (cwd, args) => git(cwd, args, env)

  const main = path.join(root, 'main')
  mkdirSync(main)
  at(main, ['init', '-q'])
  at(main, ['config', 'user.name', 'sandbox'])
  at(main, ['config', 'user.email', 'sandbox@local'])
  at(main, ['config', 'commit.gpgsign', 'false'])
  at(main, ['commit', '-q', '--allow-empty', '-m', 'sandbox base'])

  // 链接 worktree —— GIT_DIR 注入只在「worktree 内 commit」这一格发生（Phase A §1.2 实测）
  const wt = path.join(root, 'wt')
  at(main, ['worktree', 'add', '-q', '-b', 'wtbranch', wt])

  const probe = {
    dir: path.join(root, 'probe'),
    tmp: path.join(root, 'probe', 'tmp'), // 临时目录：**不是**仓库，payload 要在这儿建自己的
    dump: path.join(root, 'probe', 'git-env.dump'),
    payload: path.join(root, 'probe', 'payload.mjs'),
    log: path.join(root, 'probe', 'payload.log'),
  }
  mkdirSync(probe.tmp, { recursive: true })

  // payload = 测试里「{ cwd: tmp } 出 git」的最小复刻。**刻意不传 env**：继承钩子环境正是被判的那面。
  writeFileSync(
    probe.payload,
    `import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
const [tmp, log] = process.argv.slice(2)
const run = (args) => {
  try {
    execFileSync('git', args, { cwd: tmp, stdio: 'pipe' })
    appendFileSync(log, 'ok   git ' + args.join(' ') + '\\n')
  } catch (e) {
    appendFileSync(log, 'FAIL git ' + args.join(' ') + ' :: ' + String(e.stderr || e).trim() + '\\n')
  }
}
run(['init', '-q', '.'])
run(['config', 'user.name', 'gate-test'])
run(['config', 'user.email', 'gate@test.local'])
run(['commit', '-q', '--allow-empty', '-m', 'fake commit from test'])
process.exit(0) // 污染有无由断言判，不由退出码判
`
  )

  // 钩子 = dump（顶部，量的是钩子进程的完整继承面）+ 真实钩子的剥离行 + 子进程
  const hooks = path.join(root, 'probe', 'hooks')
  mkdirSync(hooks)
  writeFileSync(
    path.join(hooks, 'pre-commit'),
    [
      '#!/usr/bin/env sh',
      '# 探针：把 git 注入给钩子进程的 GIT_* 原样落盘（装顶部 = 完整继承面）',
      'env | grep \'^GIT_\' | sort > "$PROBE_DUMP"',
      ...stripLines(),
      'node "$PROBE_PAYLOAD" "$PROBE_TMP" "$PROBE_LOG"',
      '',
    ].join('\n')
  )
  at(main, ['config', 'core.hooksPath', toPosix(hooks)])

  return { root, main, wt, hooks, probe, env }
}

/** 五字段读数（C4 语义）：`core.bare` / `user.name` / `user.email` / `core.hooksPath` / HEAD */
function fields(repo) {
  return {
    bare: gitOut(repo, ['rev-parse', '--is-bare-repository']),
    name: gitOut(repo, ['config', '--get', 'user.name']),
    email: gitOut(repo, ['config', '--get', 'user.email']),
    hooksPath: gitOut(repo, ['config', '--get', 'core.hooksPath']),
    head: gitOut(repo, ['rev-parse', 'HEAD']),
  }
}

const payloadLog = (s) => {
  try {
    return readFileSync(s.probe.log, 'utf8')
  } catch {
    return '<payload 未落 log>'
  }
}

describe('.husky/pre-commit：剥掉 git 注入的定位变量', () => {
  it('A2/A3 · worktree 内真 commit 触发钩子 ⇒ payload 的 git 落 cwd，沙箱真实仓库零改动', () => {
    const s = makeSandbox()
    const before = { main: fields(s.main), wt: fields(s.wt) }

    // 真机挂钩：在**链接 worktree 内**真 commit，git 自己会把 GIT_DIR 注入钩子
    const outer = spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'outer probe commit'], {
      cwd: s.wt,
      encoding: 'utf8',
      env: {
        ...cleanGitEnv(),
        ...s.env,
        PROBE_DUMP: toPosix(s.probe.dump),
        PROBE_PAYLOAD: toPosix(s.probe.payload),
        PROBE_TMP: toPosix(s.probe.tmp),
        PROBE_LOG: toPosix(s.probe.log),
      },
    })

    // ① 钩子真被 git 调起——以 dump 落盘为证（不许用 `sh 钩子` 手工跑冒充）
    expect(
      existsSync(s.probe.dump),
      `pre-commit 未被 git 调起（core.hooksPath 未生效？）\ntrigger stderr:\n${outer.stderr || ''}`
    ).toBe(true)

    // ② 注入确实到达钩子进程——缺这一步，「注入没发生」会让下面全绿（验的不是被判的那面）
    const injected = Object.fromEntries(
      readFileSync(s.probe.dump, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
    )
    expect(
      injected.GIT_DIR,
      `注入未到达钩子 ⇒ 本用例假绿。dump:\n${readFileSync(s.probe.dump, 'utf8')}`
    ).toMatch(/worktrees/)

    // ③ 剥离生效：payload 的 git 操作落在 cwd（临时目录），没被劫持到沙箱真实仓库
    expect(
      existsSync(path.join(s.probe.tmp, '.git')),
      `payload 的 git 未落在 cwd —— 剥离未生效。payload log:\n${payloadLog(s)}`
    ).toBe(true)

    // ④ 沙箱真实仓库五字段零改动（主仓 HEAD 不该动；wt HEAD 由本次触发提交推进，不比）
    expect(fields(s.main), `主仓库被改动。payload log:\n${payloadLog(s)}`).toEqual(before.main)
    expect(
      { ...fields(s.wt), head: before.wt.head },
      `worktree 仓库被改动。payload log:\n${payloadLog(s)}`
    ).toEqual(before.wt)

    // ⑤ 劫持的标志性症状：core.bare=true 后真实仓库的 git 命令直接报 must be run in a work tree
    expect(gitOut(s.main, ['status', '--short'])).not.toMatch(/must be run in a work tree/)

    // ⑥ 分支未被 fake 提交篡改（git-utils.ts 注释里的第三条症状）
    expect(gitOut(s.main, ['log', '--all', '--format=%s'])).not.toContain('fake commit from test')
  })

  it('落点 · unset 在 npx lint-staged 之前（spec-gate 硬要求，勿挪）', () => {
    const lines = readFileSync(PRE_COMMIT, 'utf8').split(/\r?\n/)
    // 只认**命令行**：注释里也会出现 lint-staged 字样，按行首匹配会把注释当调用行
    const isCommand = (l) => l.trim() !== '' && !l.trim().startsWith('#')
    const unsetIdx = lines.findIndex((l) => isCommand(l) && /^\s*unset\s/.test(l))
    const lintIdx = lines.findIndex((l) => isCommand(l) && /\blint-staged\b/.test(l))
    expect(lintIdx, '钩子里找不到 lint-staged 调用行').toBeGreaterThan(-1)
    expect(unsetIdx, '钩子里找不到 unset 剥离行').toBeGreaterThan(-1)
    expect(
      unsetIdx,
      'unset 必须在 npx lint-staged 之前 —— 否则 lint-staged 及其子进程仍在被注入的 env 下'
    ).toBeLessThan(lintIdx)
  })

  it('清单 · unset 覆盖 C2 定位类三项（清单被精简 ⇒ 真机回归静默放行）', () => {
    const line = readFileSync(PRE_COMMIT, 'utf8')
      .split(/\r?\n/)
      .find((l) => /^\s*unset\s/.test(l))
    expect(line, '钩子里找不到 unset 剥离行').toBeTruthy()
    const stripped = line.trim().split(/\s+/).slice(1) // 去行首 `unset` 本身，余下即变量清单

    // 只断言「unset 行存在 + 位置靠前」护不住**清单内容**：上一条用例的判据是「行在不在、在哪儿」，
    // 不含「剥了哪些」。把 `GIT_INDEX_FILE` 从清单里删掉（恰是票面标注「主工作区注入无害」的那项，
    // 未来清理者最可能下刀处）⇒ payload 的 `git init` 在 `cwd=tmp` 不受 index 影响、五字段读数也
    // 不含 index 字节 ⇒ 上一条用例照绿，而 worktree 内的 index 劫持已静默回归。
    // 故此处钉死 C2 清单，取**定位类三项**为下限（能改变 git 解析到**哪个仓库 / 哪个 index** 的变量）：
    // `GIT_WORK_TREE` 是票面明示的「零成本防御性冗余」且 Phase A 实测**从未被注入**（evidence §1.4），
    // 硬断言它 = 给一条永不触发的防线立断言（与 OQ-3 不给 `hooks-config.test.js` 加断言的判据同型）。
    expect(
      stripped,
      `unset 清单缺定位类变量 ⇒ 真机回归会被静默放行。实测行: ${line.trim()}`
    ).toEqual(expect.arrayContaining(['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX']))
  })
})
