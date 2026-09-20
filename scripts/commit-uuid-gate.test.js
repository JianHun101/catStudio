/**
 * commit-uuid-gate 测试 —— C4 五态逐条 + 真机挂钩（B1 / B2）。
 *
 * 两个面：
 *   1. 判决单元面：`evaluateCommitUuid` 喂**真 SQLite 临时库文件**（承仓规「SQLite
 *      用真的」——不 mock 数据库），逐态断言**判决 + 出口文案含 uuid 原文**。
 *   2. 真机挂钩面（B2）：临时 git 仓库里真 `git commit` 两次，**以 git 确实调起
 *      `commit-msg` 为证**（认钩子自己打印的 `[commit-uuid-gate] …` 行）——不用
 *      `sh .husky/commit-msg <file>` 手工执行冒充（那证不了「钩子生效」）。
 *
 * 临时库 / 临时仓库一律落 `os.tmpdir()`——**不得落仓库根**（仓根临时产物会被
 * auto-commit 扫走）。
 *
 * 反例（B1′ 承重）：把 `hasMessageId` 的存在性查询改恒真（`SELECT 1 AS hit FROM
 * messages LIMIT 1`）⇒「查无此 id → 阻断」用例必红——实施时实跑过红→绿，见交付说明。
 *
 * 反例（票丁承重）：把 `HEX_DASH_SHAPE_RE` 那一支改回 `no-marker` ⇒ 畸形标记矩阵
 * （39 / 28 位、大写、错分组）**必红**——实施时实跑过红→绿，见交付说明。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import {
  cleanGitEnv,
  evaluateCommitUuid,
  formatBlockMessage,
  formatPassLine,
  formatWarning,
  resolveRepoRoot,
} from './commit-uuid-gate.mjs'

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url))
const GATE_SRC = path.join(SCRIPTS_DIR, 'commit-uuid-gate.mjs')
const HOOK_SRC = path.join(SCRIPTS_DIR, '..', '.husky', 'commit-msg')

/** 该 id 真在库里（态「命中」的绿样本） */
const REAL_UUID = '11111111-2222-4333-8444-555555555555'
/** 形状合法、但两库都查无此行（本门禁要挡的那一类） */
const FAKE_UUID = '99999999-8888-4777-8666-555555555555'
/** 形状非法：36 位 hex 但**没有 8-4-4-4-12 分段**（够像 uuid ⇒ 态②） */
const BAD_SHAPE = '0123456789abcdef0123456789abcdef0123'
/** 形状非法：**39 位**（票丁靶心，`0b5e9e0` 事故真值——多插了一段 `31-`） */
const BAD_SHAPE_39 = 'dbb86077-de5e-4506-8f2c-31-6169d09dce33'
/** 形状非法：**28 位**（截断） */
const BAD_SHAPE_28 = 'dbb86077-de5e-4506-8f2c-6169d09'
/** 形状非法：**大写** 36 位（票丁对 P3-1 的半推翻——原先视为无标记放行） */
const BAD_SHAPE_UPPER = 'ABCDEF01-2345-4678-89AB-CDEF01234567'
/** 防误拦的反对照：散文里顺口提了标记形状，**不是**在写标记 ⇒ 必须放行 */
const PROSE_MARKER = 'docs: 说明 catstudy [uuid] 标记规则\n'

let dir
let seq = 0
/** 本用例造出来的临时目录（真机挂钩面另开仓库）——afterEach 一并清 */
let tmpDirs = []

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'commit-uuid-gate-'))
  tmpDirs = [dir]
})

afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

/** 造一个真库；`ids` 写进 `messages` 表；`table:false` 造「库在但表缺失」 */
function makeDb(ids = [REAL_UUID], { table = true, name = null } = {}) {
  // resolve（非 join）：挂钩面传进来的 name 是**绝对路径**，join 会把它拼到 dir 后面
  const file = path.resolve(dir, name || `fixture-${seq++}.db`)
  const db = new DatabaseSync(file)
  if (table) db.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, content TEXT)')
  for (const id of ids) {
    db.prepare('INSERT INTO messages (id, content) VALUES (?, ?)').run(id, `消息 ${id}`)
  }
  db.close()
  return file
}

const dbList = (files) => files.map((file, i) => ({ label: i === 0 ? 'dev' : 'prod', file }))

const msg = (uuid) => `feat(x): 干点活\n\ncatstudy [${uuid}]\n`

describe('evaluateCommitUuid —— C4 五态', () => {
  it('态① 无 catstudy [uuid] 标记 → 放行（merge / revert / 手动提交）', () => {
    const res = evaluateCommitUuid('Merge branch "dev"\n', dbList([makeDb()]))
    expect(res.code).toBe('no-marker')
    expect(res.ok).toBe(true)
    expect(res.uuid).toBeNull()
    expect(formatPassLine(res)).toContain('无 catstudy [uuid] 标记')
  })

  it('态② 畸形标记矩阵（39 / 28 位、大写、错分组）→ 全都阻断（票丁靶心）', () => {
    // 库路径故意不存在：若实现仍去查库，落点会变成 no-db / db-error 而不是 bad-shape
    const deadDb = [{ label: 'dev', file: path.join(dir, '不存在.db') }]
    for (const bad of [BAD_SHAPE_39, BAD_SHAPE_28, BAD_SHAPE_UPPER, BAD_SHAPE]) {
      const res = evaluateCommitUuid(msg(bad), deadDb)
      // 失败信息带上被拒原文，红了能直接看出是哪一支漏了
      expect(res.code, `畸形标记 ${bad} 未被阻断（票丁的静默放行复发）`).toBe('bad-shape')
      expect(res.ok).toBe(false)
      expect(res.uuid).toBe(bad) // 被拒 uuid 原文
      expect(res.dbs).toEqual([]) // 零查询
    }
    // 事故真值单列断言：出口必须把它**原文**亮出来（否则人看不到自己写歪在哪）
    const incident = formatBlockMessage(evaluateCommitUuid(msg(BAD_SHAPE_39), deadDb))
    expect(incident).toContain(BAD_SHAPE_39)
    expect(incident).toContain('形状非法')
  })

  it('态①′ 大写 uuid 由「放行」翻为「阻断」（票丁对 P3-1 的半推翻）', () => {
    // 单列这条（矩阵里已有）是因为它**推翻了一条既有裁定**：P3-1 当初的取舍是
    // 「不改共用提取器的正则」（范围理由），不是「大写无害」（语义理由）。
    // 必须用**带字母**的 uuid：纯数字 uuid 大写后与自身相同，测不出这条。
    const res = evaluateCommitUuid(msg(BAD_SHAPE_UPPER), dbList([makeDb()]))
    expect(res.code).toBe('bad-shape')
    expect(res.ok).toBe(false)
  })

  it('态①″ 散文 `catstudy [uuid]` 不是标记 → 放行（防误拦的反对照，必须有）', () => {
    // 只加严会把正常提交拦死——正是把人推向 --no-verify 的形态
    const res = evaluateCommitUuid(PROSE_MARKER, dbList([makeDb()]))
    expect(res.code).toBe('no-marker')
    expect(res.ok).toBe(true)
    expect(res.uuid).toBeNull()
  })

  it('态①‴ 括号里写非 uuid 词（`not-a-uuid`）→ 放行', () => {
    const res = evaluateCommitUuid(msg('not-a-uuid'), dbList([makeDb()]))
    expect(res.code).toBe('no-marker')
    expect(res.ok).toBe(true)
  })

  it('态② 有标记但形状非法 → 阻断，且**不查库**', () => {
    // 库故意读不动（路径不存在）：若实现仍去查库，落点会变成 no-db 或 db-error
    const res = evaluateCommitUuid(msg(BAD_SHAPE), [
      { label: 'dev', file: path.join(dir, '不存在.db') },
    ])
    expect(res.code).toBe('bad-shape')
    expect(res.ok).toBe(false)
    expect(res.uuid).toBe(BAD_SHAPE) // 被拒 uuid 原文
    const out = formatBlockMessage(res)
    expect(out).toContain(BAD_SHAPE)
    expect(out).toContain('形状非法')
    expect(res.dbs).toEqual([]) // 零查询
  })

  it('态③ 形状合法、两库都查无此 id → 阻断（出口含 uuid 原文 / 取证命令 / 逃生口）', () => {
    const res = evaluateCommitUuid(
      msg(FAKE_UUID),
      dbList([makeDb(), makeDb()]) // 两库都真、都读得动、都没有这个 id
    )
    expect(res.code).toBe('not-found')
    expect(res.ok).toBe(false)
    const out = formatBlockMessage(res)
    expect(out).toContain(FAKE_UUID)
    expect(out).toContain('查无此行')
    expect(out).toContain('echo $CATSTUDY_TRIGGER_MSG_ID')
    expect(out).toContain('git commit --no-verify')
    // P3-2：出处提示不得写成「用户消息 id」（A2A 触发的提交按那句找必然找不到）
    expect(out).toContain('触发本次执行的那条消息 id')
    expect(out).toContain('A2A')
  })

  it('命中 → 放行（态③ 的绿样本；B1′ 反例的对照组）', () => {
    const res = evaluateCommitUuid(msg(REAL_UUID), dbList([makeDb()]))
    expect(res.code).toBe('found')
    expect(res.ok).toBe(true)
    expect(res.hit.label).toBe('dev')
    expect(formatPassLine(res)).toContain(REAL_UUID)
  })

  it('态④ 两库文件都不存在 → 放行 + 警示（判据无主体）', () => {
    const dbs = [
      { label: 'dev', file: path.join(dir, 'no-dev.db') },
      { label: 'prod', file: path.join(dir, 'no-prod.db') },
    ]
    const res = evaluateCommitUuid(msg(REAL_UUID), dbs)
    expect(res.code).toBe('no-db')
    expect(res.ok).toBe(true)
    const warn = formatWarning(res)
    expect(warn).toContain('判据无主体')
    expect(warn).toContain('未校验')
    expect(warn).toContain('no-dev.db')
  })

  it('态④′ 未解析出主仓库根（候选库为空）→ 同一出口，警示点名根解析失败', () => {
    const res = evaluateCommitUuid(msg(REAL_UUID), [])
    expect(res.code).toBe('no-db')
    expect(res.ok).toBe(true)
    expect(formatWarning(res)).toContain('未解析出主仓库根')
  })

  it('态⑤ 库存在但表缺失 → 阻断（查不动 ≠ 放行，出口带库路径与原因）', () => {
    const file = makeDb([], { table: false })
    const res = evaluateCommitUuid(msg(REAL_UUID), [{ label: 'dev', file }])
    expect(res.code).toBe('db-error')
    expect(res.ok).toBe(false)
    const out = formatBlockMessage(res)
    expect(out).toContain(REAL_UUID)
    expect(out).toContain('读取失败')
    expect(out).toContain('no such table')
  })

  it('命中优先于读不动：一库坏、另一库命中 → 放行（方向向严，不放过查无此 id 的提交）', () => {
    const broken = makeDb([], { table: false })
    const good = makeDb([REAL_UUID])
    const res = evaluateCommitUuid(msg(REAL_UUID), [
      { label: 'dev', file: broken },
      { label: 'prod', file: good },
    ])
    expect(res.code).toBe('found')
    expect(res.ok).toBe(true)
    expect(res.hit.label).toBe('prod')
  })
})

// ─── B2 真机挂钩：临时 git 仓库里真 commit，认钩子自己打印的那行 ─────────────

/** 跑一条 git 命令，**stdout / stderr 都留**（成功时 execFileSync 会丢掉 stderr——
 *  而钩子的输出正是取证面，丢不得）。
 *  env 走 `cleanGitEnv()`：本测试自己也常在被 git 调起的环境里跑（pre-commit →
 *  `pnpm test`），git 注入的 `GIT_DIR` 若透传，临时仓库里的 `git commit` 会认外层
 *  仓库 —— 测试就不再封闭。剥离清单与源码同源，不另写一份。 */
function gitRun(cwd, args, extraEnv = {}) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...cleanGitEnv(), ...extraEnv },
  })
}

/** 断言性 git 调用：非 0 退出即抛（造仓库用） */
function git(cwd, args, extraEnv = {}) {
  const r = gitRun(cwd, args, extraEnv)
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${r.stderr}`)
  return r.stdout
}

/** 造一个「钩子已挂上」的临时仓库：`.husky/commit-msg` + 它依赖的三个脚本 + 库 */
function makeHookedRepo({ ids = [REAL_UUID] } = {}) {
  const repo = mkdtempSync(path.join(tmpdir(), 'commit-uuid-gate-repo-'))
  tmpDirs.push(repo)
  const env = {
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: repo, // 隔开全局 config（别让宿主机的 hooksPath / gpgsign 泄进来）
    USERPROFILE: repo,
    XDG_CONFIG_HOME: repo,
  }
  git(repo, ['init', '-q'], env)
  git(repo, ['config', 'user.email', 'gate@test.local'], env)
  git(repo, ['config', 'user.name', 'gate-test'], env)
  git(repo, ['config', 'commit.gpgsign', 'false'], env)
  git(repo, ['config', 'core.hooksPath', '.husky'], env)

  mkdirSync(path.join(repo, 'scripts', 'flywheel'), { recursive: true })
  mkdirSync(path.join(repo, '.husky'), { recursive: true })
  // 门禁脚本 import 的两个同伴一起搬过去（三文件互为单源，缺一跑不起来）
  copyFileSync(GATE_SRC, path.join(repo, 'scripts', 'commit-uuid-gate.mjs'))
  copyFileSync(
    path.join(SCRIPTS_DIR, 'handoff-gen.mjs'),
    path.join(repo, 'scripts', 'handoff-gen.mjs')
  )
  copyFileSync(
    path.join(SCRIPTS_DIR, 'flywheel', 'retire-message-memory.mjs'),
    path.join(repo, 'scripts', 'flywheel', 'retire-message-memory.mjs')
  )
  copyFileSync(HOOK_SRC, path.join(repo, '.husky', 'commit-msg'))

  // 根解析取「主仓库」= 这个临时仓库自己 ⇒ 库落它自己的 packages/server/data/
  const dataDir = path.join(repo, 'packages', 'server', 'data')
  mkdirSync(dataDir, { recursive: true })
  makeDb(ids, { name: path.join(dataDir, 'cat-study-dev.db') })

  writeFileSync(path.join(repo, 'work.txt'), 'x\n')
  git(repo, ['add', 'work.txt'], env)
  return { repo, env }
}

/** 已落地的 commit 数；HEAD 未出生（零提交）时 git 会报错 ⇒ 归 0 */
function commitCount(repo, env) {
  try {
    return git(repo, ['rev-list', '--count', 'HEAD'], env).trim()
  } catch {
    return '0'
  }
}

/** 跑一次真 `git commit`，连 stdout/stderr 一起回传（钩子输出混在其中） */
function commit(repo, env, message) {
  const r = gitRun(repo, ['commit', '-m', message], env)
  return { ok: r.status === 0, output: `${r.stdout || ''}${r.stderr || ''}` }
}

describe('B2 真机挂钩（临时仓库 · 真 git commit）', () => {
  it('假 uuid 被拒、真 uuid 通过——以 git 确实调起 commit-msg 为证', () => {
    const { repo, env } = makeHookedRepo()

    // ① 假 uuid（形状合法、库中查无）⇒ 被拒
    const bad = commit(repo, env, `feat: 假 uuid\n\ncatstudy [${FAKE_UUID}]\n`)
    expect(bad.ok, `假 uuid 竟然提交成功，输出:\n${bad.output}`).toBe(false)
    // 证据：钩子**自己**打印的那行（手工 sh 冒充不会有这条 git 侧输出）
    expect(bad.output).toContain('[commit-uuid-gate]')
    expect(bad.output).toContain('门禁阻断')
    expect(bad.output).toContain(FAKE_UUID)
    // 钩子侧压掉了 node:sqlite 的 ExperimentalWarning——别让它每次提交刷两行
    expect(bad.output).not.toContain('ExperimentalWarning')
    // 被拒后仓库里不应留下 commit
    expect(commitCount(repo, env)).toBe('0')

    // ② 库里真有的 uuid ⇒ 通过
    const good = commit(repo, env, `feat: 真 uuid\n\ncatstudy [${REAL_UUID}]\n`)
    expect(good.ok, `真 uuid 被误拦，输出:\n${good.output}`).toBe(true)
    expect(good.output).toContain('[commit-uuid-gate]')
    expect(good.output).toContain(REAL_UUID)
    expect(commitCount(repo, env)).toBe('1')

    // ③ 无标记 ⇒ 放行（merge / 手动提交不受影响）
    writeFileSync(path.join(repo, 'work2.txt'), 'y\n')
    git(repo, ['add', 'work2.txt'], env)
    const plain = commit(repo, env, 'chore: 无标记\n')
    expect(plain.ok, `无标记被误拦，输出:\n${plain.output}`).toBe(true)
    expect(plain.output).toContain('无 catstudy [uuid] 标记')
    expect(commitCount(repo, env)).toBe('2')
  }, 60_000)

  it('畸形标记（39 位）被拒——认钩子自打的 bad-shape 行（票丁真机取证）', () => {
    const { repo, env } = makeHookedRepo()

    const r = commit(repo, env, `refactor: 畸形标记\n\ncatstudy [${BAD_SHAPE_39}]\n`)
    expect(
      r.ok,
      `39 位畸形标记竟然提交成功（票丁的失效模式在真机面复发），输出:\n${r.output}`
    ).toBe(false)
    // 机器证据：钩子自己打印的判决码行（手工 sh 冒充不会有这条 git 侧输出）
    expect(r.output).toContain(`[commit-uuid-gate] ❌ commit-msg 门禁阻断（bad-shape）`)
    expect(r.output).toContain(BAD_SHAPE_39) // 被拒原文
    expect(commitCount(repo, env)).toBe('0')

    // 反对照（同一条真机路径）：散文提了一句标记形状 ⇒ 不该被这条闸拦
    // 新开一个文件（work.txt 已被上一次 commit 吃进树，改了它会是「无改动可提交」）
    writeFileSync(path.join(repo, 'work-prose.txt'), 'y\n')
    git(repo, ['add', 'work-prose.txt'], env)
    const prose = commit(repo, env, PROSE_MARKER)
    expect(prose.ok, `散文标记被误拦，输出:\n${prose.output}`).toBe(true)
    expect(commitCount(repo, env)).toBe('1')
  }, 60_000)
})

// ─── C3 根解析（worktree 承重：库在主仓库，不在 worktree）──────────────────

describe('resolveRepoRoot', () => {
  it('worktree 内解析到**主仓库根**（不是 worktree 自己）', () => {
    const root = resolveRepoRoot(SCRIPTS_DIR)
    expect(root).toBeTruthy()
    expect(existsSync(path.join(root, '.git'))).toBe(true)
    // 主仓库根下才有的东西（本测试所在 worktree 里也有 packages/ —— 判据取 .git 目录）
    expect(path.isAbsolute(root)).toBe(true)
  })

  it('非 git 目录 → null（调用方落「判据无主体」态）', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'commit-uuid-gate-nogit-'))
    try {
      expect(resolveRepoRoot(outside)).toBeNull()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('继承来的 GIT_DIR 被剥掉——cwd 才是唯一输入（钩子内跑测试踩过）', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'commit-uuid-gate-nogit-'))
    const outerGitDir = git(SCRIPTS_DIR, ['rev-parse', '--absolute-git-dir']).trim()
    try {
      // 先证明这个环境变量真的会把 cwd 架空（否则本用例是恒真的假门）
      const leaked = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
        cwd: outside,
        encoding: 'utf8',
        env: { ...process.env, GIT_DIR: outerGitDir },
      })
      expect(leaked.status).toBe(0)
      expect(leaked.stdout.trim()).toContain('.git')

      // 而 resolveRepoRoot 在同样的污染环境下仍按 cwd 判（干净 ⇒ null）
      process.env.GIT_DIR = outerGitDir
      try {
        expect(resolveRepoRoot(outside)).toBeNull()
      } finally {
        delete process.env.GIT_DIR
      }
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('cleanGitEnv 只剥 git 定位变量，不动别的（剥离清单单源）', () => {
    const env = cleanGitEnv({
      GIT_DIR: '/x/.git',
      GIT_INDEX_FILE: '/x/.git/index',
      PATH: '/usr/bin',
      HOME: '/home/x',
    })
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/x' })
  })
})
