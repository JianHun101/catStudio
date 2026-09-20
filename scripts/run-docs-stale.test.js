/**
 * `scripts/run-docs-stale.mjs` 的判据矩阵 —— 票 G5（形态乙 · 陈旧度可见性）。
 *
 * 形态：**真实临时 git 仓库**（`os.tmpdir()` + `git init`），提交时刻由
 * `GIT_COMMITTER_DATE` 钉死、`nowMs` 显式注入 —— 天数读数**确定**，不靠 sleep、
 * 不靠真实时钟（真实时钟会让「正好第 6 天」这类边界随跑批时刻翻转）。
 *
 * 三条防「矩阵退化成测了个常量」的结构性断言：
 *   ① **反对照乙**（不是恒全门）：1 天前的目录**必须不在** `--days 6` 清单里；
 *   ② **反对照甲**（不是恒空门）：`--days 0` 必须**扩到**全部有提交的目录；
 *   ③ **劫持防护真注入真跑**：把**别的仓库**的 `GIT_DIR` 注进 `process.env`，本脚本
 *      必须仍按 `--root` 扫——不剥就静默扫错对象（本仓 `core.bare` 被写坏的前科已复发
 *      2 次，故这一格不写成静态断言）。
 *
 * CLI 面（真 spawn）与函数面（直接 import）**都测**：前者证明入口守卫与两个输出通道，
 * 后者证明判据本身。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectStale, formatTable, main, parseArgs, readStatusField } from './run-docs-stale.mjs'
import { cleanGitEnv } from './commit-uuid-gate.mjs'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run-docs-stale.mjs')
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 固定「现在」——所有天数读数相对它算 */
const NOW = Date.parse('2026-09-20T12:00:00+08:00')
const DAY = 86_400_000
/** 相对 NOW 的 ISO 时刻（带 +08:00，与 `git log --format=%cI` 同排版） */
function agoIso(days) {
  return new Date(NOW - days * DAY).toISOString().replace('Z', '+00:00')
}

const sandboxes = []
function mkSandbox(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  sandboxes.push(dir)
  return dir
}

/** 夹具仓库里的裸 git（**必须剥继承的定位变量**，否则会认外层仓库） */
function gitIn(cwd, cmd, env = {}) {
  return execSync(`git ${cmd}`, {
    cwd,
    env: { ...cleanGitEnv(), ...env },
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

function initRepo(dir) {
  execSync('git init', { cwd: dir, env: cleanGitEnv(), stdio: 'ignore' })
  gitIn(dir, 'config user.name test')
  gitIn(dir, 'config user.email test@test.local')
  gitIn(dir, 'checkout -b dev')
  writeFileSync(path.join(dir, 'README.md'), 'root\n', 'utf-8')
  gitIn(dir, 'add -A')
  gitIn(dir, 'commit -m init')
}

/** 只碰一个目录的一次提交：`git log -1 -- <该目录>` 的读数即 `days` 天前 */
function commitDir(dir, slug, files, days, message) {
  const abs = path.join(dir, 'docs', 'run', slug)
  mkdirSync(abs, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(abs, name), content, 'utf-8')
  }
  gitIn(dir, 'add -A')
  const stamp = agoIso(days)
  gitIn(dir, `commit -m "${message}"`, { GIT_COMMITTER_DATE: stamp, GIT_AUTHOR_DATE: stamp })
}

const FM = (status) => `---\ntype: ticket\nstatus: ${status}\n---\n\n# 票\n`

let sandbox
beforeAll(() => {
  sandbox = mkSandbox('run-docs-stale-')
  if (path.resolve(sandbox).startsWith(path.resolve(REPO_ROOT) + path.sep)) {
    throw new Error(`沙箱落在仓库内（违反隔离）：${sandbox}`)
  }
  initRepo(sandbox)
  commitDir(sandbox, 'older', { 'tickets.md': FM('active') }, 10, 'older')
  commitDir(sandbox, 'no-fm', { 'tickets.md': '# 没有 frontmatter\n' }, 8, 'no-fm')
  commitDir(sandbox, 'no-tickets', { 'README.md': '无 tickets.md\n' }, 8, 'no-tickets')
  commitDir(sandbox, 'fresh', { 'tickets.md': FM('pending-float') }, 1, 'fresh')
  // 有目录、无任何提交（untracked）——**最后建**，避免被上面的 git add -A 收走
  mkdirSync(path.join(sandbox, 'docs', 'run', 'brand-new'), { recursive: true })
})

afterAll(() => {
  for (const dir of sandboxes) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 兜底清理失败忽略 */
    }
  }
})

const slugsOf = (report) => report.stale.map((r) => r.slug)

describe('窗口（反对照甲乙）', () => {
  it('--days 6：10 天 / 8 天前的在清单，1 天前的不在（反对照乙：不是恒全门）', () => {
    const r = collectStale({ root: sandbox, days: 6, nowMs: NOW })
    expect(slugsOf(r)).toEqual(['no-fm', 'no-tickets', 'older'])
    expect(slugsOf(r)).not.toContain('fresh')
    expect(r.freshCount).toBe(1)
    expect(r.scanned).toBe(5)
    expect(r.failed).toEqual([])
  })

  it('--days 0：扩到全部有提交的目录（反对照甲：窗口真在算，不是恒空门）', () => {
    const r = collectStale({ root: sandbox, days: 0, nowMs: NOW })
    expect(slugsOf(r)).toEqual(['fresh', 'no-fm', 'no-tickets', 'older'])
    expect(r.freshCount).toBe(0)
  })

  it('天数按末次提交算到日：10 天前 ⇒ daysAgo=10（不是 9/11）', () => {
    const r = collectStale({ root: sandbox, days: 6, nowMs: NOW })
    expect(r.stale.find((s) => s.slug === 'older').daysAgo).toBe(10)
    expect(r.stale.find((s) => s.slug === 'no-fm').daysAgo).toBe(8)
  })

  it('窗口可调：--days 9 把 8 天前那两条筛掉、只留 10 天前那条', () => {
    const r = collectStale({ root: sandbox, days: 9, nowMs: NOW })
    expect(slugsOf(r)).toEqual(['older'])
  })
})

describe('status 列（展示，不是判据）', () => {
  it('有 frontmatter ⇒ 原值；无 frontmatter / 无 tickets.md ⇒ "-"（不报错、不过滤）', () => {
    const r = collectStale({ root: sandbox, days: 6, nowMs: NOW })
    const by = Object.fromEntries(r.stale.map((s) => [s.slug, s.status]))
    expect(by.older).toBe('active')
    expect(by['no-fm']).toBe('-')
    expect(by['no-tickets']).toBe('-')
  })

  it('不按 status 过滤：pending-float 与 active 一视同仁（票面：待上浮是合法待办）', () => {
    const r = collectStale({ root: sandbox, days: 0, nowMs: NOW })
    expect(slugsOf(r)).toContain('fresh') // 它 status=pending-float
    expect(r.stale.find((s) => s.slug === 'fresh').status).toBe('pending-float')
  })

  it('readStatusField 只认第 1 行恰为 --- 的块；未闭合 / 缩进键 / 空值 ⇒ null', () => {
    expect(readStatusField('---\nstatus: active\n---\n')).toBe('active')
    expect(readStatusField('---\nstatus: "closed"\n---\n')).toBe('closed')
    expect(readStatusField('status: active\n---\n')).toBeNull() // 第 1 行不是 ---
    expect(readStatusField('---\nstatus: active\n')).toBeNull() // 未闭合
    expect(readStatusField('---\n  status: active\n---\n')).toBeNull() // 缩进 = 嵌套，非顶层
    expect(readStatusField('---\nstatus:\n---\n')).toBeNull() // 空值
  })
})

describe('untracked（有目录无提交）', () => {
  it('入 untracked、不入 stale、不算进 freshCount，且不报错', () => {
    const r = collectStale({ root: sandbox, days: 6, nowMs: NOW })
    expect(r.untracked).toEqual(['brand-new'])
    expect(slugsOf(r)).not.toContain('brand-new')
    expect(r.freshCount).toBe(1)
    expect(formatTable(r)).toContain('brand-new')
  })
})

describe('GIT_DIR 劫持防护（真注入真跑）', () => {
  it('注入别的仓库的 GIT_DIR ⇒ 仍按 root 扫，不认外层', () => {
    const decoy = mkSandbox('run-docs-stale-decoy-')
    initRepo(decoy)
    commitDir(decoy, 'decoy-only', { 'tickets.md': FM('active') }, 30, 'decoy')

    const saved = process.env.GIT_DIR
    try {
      process.env.GIT_DIR = path.join(decoy, '.git')
      const r = collectStale({ root: sandbox, days: 6, nowMs: NOW })
      expect(slugsOf(r)).toEqual(['no-fm', 'no-tickets', 'older'])
      expect(slugsOf(r)).not.toContain('decoy-only')
      expect(r.scanned).toBe(5)
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = saved
    }
  })
})

describe('parseArgs', () => {
  it('缺省：days=6（票面基线口径）、root=null', () => {
    expect(parseArgs([])).toMatchObject({ days: 6, root: null, error: null })
  })

  it('--days 0 合法（反对照甲要用）', () => {
    expect(parseArgs(['--days', '0'])).toMatchObject({ days: 0, error: null })
  })

  it('坏 --days 一律拒：非数字 / 小数 / 负数 / 缺值 / 尾随垃圾（`5abc` 不得静默取 5）', () => {
    for (const bad of [
      ['--days', 'abc'],
      ['--days', '1.5'],
      ['--days', '-1'],
      ['--days'],
      ['--days', '5abc'],
    ]) {
      const a = parseArgs(bad)
      expect(a.error, `应拒: ${bad.join(' ')}`).toBeTruthy()
    }
  })

  it('未知参数 / --root 缺值 ⇒ error；--help 置 help', () => {
    expect(parseArgs(['--nope']).error).toContain('未知参数')
    expect(parseArgs(['--root']).error).toBeTruthy()
    expect(parseArgs(['--help']).help).toBe(true)
  })
})

describe('CLI 端到端（真 spawn）', () => {
  it('stdout 单行 JSON 可 parse、stderr 是人类清单、退出码 0', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--root', sandbox], {
      encoding: 'utf8',
      env: cleanGitEnv(),
    })
    expect(r.status).toBe(0)
    const lines = r.stdout.trim().split('\n')
    expect(lines).toHaveLength(1) // 机器通道必须单行
    const report = JSON.parse(lines[0])
    expect(report.windowDays).toBe(6)
    expect(report.stale.map((s) => s.slug)).toEqual(['no-fm', 'no-tickets', 'older'])
    expect(r.stderr).toContain('older')
    expect(r.stderr).toContain('daysAgo')
  })

  it('main() 的退出码契约：--help ⇒ 0；坏参数 ⇒ 1（不抛）', () => {
    expect(main(['--help'])).toBe(0)
    expect(main(['--days', 'abc'])).toBe(1)
  })

  it('root 无 docs/run ⇒ 退出码 1 + stderr 说明（假绿比多一条 warn 危险）', () => {
    const empty = mkSandbox('run-docs-stale-empty-')
    const r = spawnSync(process.execPath, [SCRIPT, '--root', empty], {
      encoding: 'utf8',
      env: cleanGitEnv(),
    })
    expect(r.status).toBe(1)
    // 用自家 tag + 原因词断言（**不用 `docs/run` 字面量**：Windows 上 path.join 出的是
    // 反斜杠，拿正斜杠去 toContain 是恒假的假红）
    expect(r.stderr).toContain('[run-docs-stale]')
    expect(r.stderr).toContain('不存在')
    expect(r.stdout.trim()).toBe('') // 不产 JSON，免得被读成「没有陈旧目录」
  })

  it('有 docs/run 但 root 不是 git 仓库 ⇒ 退出码 1 + stderr 说明', () => {
    const noRepo = mkSandbox('run-docs-stale-norepo-')
    mkdirSync(path.join(noRepo, 'docs', 'run', 'x'), { recursive: true })
    const r = spawnSync(process.execPath, [SCRIPT, '--root', noRepo], {
      encoding: 'utf8',
      env: cleanGitEnv(),
    })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('不是 git 仓库')
  })

  it('坏参数 ⇒ 退出码 1 + 用法', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--days', 'abc'], {
      encoding: 'utf8',
      env: cleanGitEnv(),
    })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('--days')
  })
})

describe('formatTable（人类通道）', () => {
  it('空清单不报错、行数只有标题', () => {
    const table = formatTable({
      windowDays: 6,
      scanned: 3,
      stale: [],
      freshCount: 3,
      untracked: [],
      failed: [],
    })
    expect(table.split('\n')).toHaveLength(1)
    expect(table).toContain('0 / 3')
  })

  it('failed 非空时表里点名目录与错误（跳过永不静默）', () => {
    const table = formatTable({
      windowDays: 6,
      scanned: 1,
      stale: [],
      freshCount: 0,
      untracked: [],
      failed: [{ slug: 'boom', error: 'fatal: not a git repository' }],
    })
    expect(table).toContain('boom')
    expect(table).toContain('not a git repository')
  })
})

describe('沙箱卫生', () => {
  it('本套件的夹具全在 os.tmpdir() 内，无一落在仓库里', () => {
    expect(sandboxes.length).toBeGreaterThan(0)
    for (const dir of sandboxes) {
      expect(path.resolve(dir).startsWith(path.resolve(REPO_ROOT) + path.sep)).toBe(false)
      expect(path.resolve(dir).startsWith(path.resolve(tmpdir()))).toBe(true)
    }
  })

  it('夹具不是仓库本身：扫的是临时仓，读数与本仓 docs/run 无关', () => {
    // 反向哨兵：本仓确有若干陈旧目录（实测 6 个），夹具清单里**一个都不该出现**
    const r = collectStale({ root: sandbox, days: 6, nowMs: NOW })
    for (const slug of ['vision-retire', 'hook-fallback-delivery', 'commit-uuid-gate']) {
      expect(slugsOf(r)).not.toContain(slug)
    }
  })
})
