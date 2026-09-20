/**
 * `docs/run` 陈旧度可见性 —— 列出「末次提交距今 > N 天」的 `docs/run/<slug>/`。
 *
 * 票 G5 · 形态乙。**这是可见性，不是闸**（票面 D2 原话）。它挂在 `closeoutSession`
 * 的 preflight，而收口跑在 PR 合并**之后**——此刻报出来的陈旧目录，该补进那个目录的
 * commit 已经补不回来了（PR 已合、分支已删）。正因为**拦不住**，副作用就必须为零：
 * 脚本自身的任何失败（spawn 失败 / 非零退出 / stdout 不是 JSON）**都不得让收口失败**，
 * 调用侧一律 catch 成 warn（见 `packages/server/src/llm/session-closeout.ts`）。
 *
 * ## 两个输出通道（承 `scripts/flywheel/scan.mjs` 的既有约定）
 *
 * stdout 只出**一行结构化 JSON**（机器通道，调用侧 `JSON.parse`）；人类可读清单走
 * **stderr**。本仓 logger 写 stdout，与 JSON 同流会毁掉机器通道，故此处刻意不用 logger。
 *
 * ## 判据
 *
 * 「末次提交」= `git log -1 --format=%H%x09%cI -- docs/run/<slug>`：**committer date**，
 * ISO-8601 严格格式。它与票面写的 `%ci` 是**同一时刻**的两种排版
 * （`2026-09-12T11:31:51+08:00` vs `2026-09-12 11:31:51 +0800`），可逐目录对表。
 * 取 committer 而非 author date：rebase / cherry-pick 会改写后者，前者才是「这一行
 * 什么时候进的这棵树」。
 *
 * **不按 `status` 过滤任何东西**——票面明写「待上浮是合法待办」，故 `pending-float`
 * 一视同仁地按年龄列出。`status` 列纯属**展示**：`tickets.md` 的 frontmatter 读到就
 * 显示，读不到显示 `-`，缺字段**既不报错也不过滤**（G3 回填尚未开工，今天多数目录
 * 没有该字段）。
 *
 * ## 退出码
 *
 * `0` = 产出了一份报告（清单可以为空，也可以非空；`failed` 非空**也算** 0——
 * 报告里带着失败明细，调用侧据此升级成 warn，这样「清单不完整」不会连清单一起吞掉）。
 * `1` = 脚本压根没法干活：参数非法 / `docs/run` 不存在 / root 不是 git 仓库。
 *
 * ## 复用哪一份工具
 *
 * `cleanGitEnv` 走 `./commit-uuid-gate.mjs` 的**共享单源**（`scripts/` 内既定的那份，
 * `closeout-dupcheck.mjs` / `precommit-scope.mjs` 同款）——它在 pre-commit 里踩过
 * 「临时仓库 `git commit` 认了外层 `GIT_DIR`」的真事故，键集比别处更全。
 * **不** import `flywheel/scan.mjs`：那是带 tsx 自举的重模块，让一个轻量可见性 CLI
 * 反向依赖它，等于把它的启动面一起拖进来；两者对 frontmatter 的解析口径也不通用
 * （见 `readStatusField`）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanGitEnv } from './commit-uuid-gate.mjs'

/** 默认窗口（天）——票面基线口径，可对表 */
export const DEFAULT_DAYS = 6

/** 扫描面：`<root>/docs/run/<slug>/` */
export const RUN_DOCS_REL = 'docs/run'

/** 每目录 `status` 的来源文件 */
export const TICKETS_NAME = 'tickets.md'

const MS_PER_DAY = 86_400_000

function msgOf(err) {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 解析命令行。坏参数**不抛错**——返回 `error` 字符串由 `main` 统一报错退出，
 * 便于测试直接断言（与 `scan.mjs` 的同名函数同形）。
 */
export function parseArgs(argv) {
  const args = { days: DEFAULT_DAYS, root: null, help: false, error: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') {
      args.help = true
    } else if (a === '--days') {
      const raw = argv[++i]
      // `Number` 而非 `parseInt`：`5abc` 在 parseInt 下静默取 5，是**坏值伪装成合法**，
      // 正是 env 数字族（OQ-6）刚统一掉的形态。此处沿用同一口径（非整数即拒）。
      if (raw === undefined || !Number.isInteger(Number(raw)) || Number(raw) < 0) {
        args.error = `--days 需要一个非负整数，收到: ${raw === undefined ? '(缺值)' : raw}`
        return args
      }
      args.days = Number(raw)
    } else if (a === '--root') {
      const raw = argv[++i]
      if (raw === undefined) {
        args.error = '--root 需要一个路径，收到: (缺值)'
        return args
      }
      args.root = raw
    } else {
      args.error = `未知参数: ${a}`
      return args
    }
  }
  return args
}

/**
 * 取 frontmatter 里的顶层 `status` 标量（**展示用宽松读法，不是判据**）。
 *
 * 受支持子集：仅当**第 1 行恰为 `---`** 才进入判定，向下找 `---` / `...` 闭合，在其中
 * 的顶层行里匹配 `status:`（去引号）。列表 / 嵌套 / 多行标量一律不解析——本列只有
 * 一个用途（给人看的提示），解析不出来就是 `-`。
 *
 * **未闭合 ⇒ 判为无 frontmatter**（向严不向宽）——与切片侧 / 扫描侧**同一条边界**
 * （`scan.mjs` 的 `parseFrontmatter` 规则 ③）。这里若宽松放行，就会出现「本列显示了
 * status、扫描器却认为该文件没有 frontmatter」的自相矛盾读数。
 *
 * 权威 frontmatter 解析是 `scripts/flywheel/scan.mjs` 的 `parseFrontmatter`，此处
 * **刻意不复用**（理由见文件头）。差异面只影响这一列的显示，不进入任何过滤或退出码。
 */
export function readStatusField(content) {
  const lines = content.split(/\r?\n/)
  if ((lines[0] ?? '').trim() !== '---') return null
  let status = null
  let closed = false
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '---' || line.trim() === '...') {
      closed = true
      break
    }
    if (status !== null) continue
    const m = /^status:\s*(.*)$/.exec(line)
    if (m) {
      status =
        m[1]
          .trim()
          .replace(/^["']|["']$/g, '')
          .trim() || null
    }
  }
  return closed ? status : null
}

/** 列 `<root>/docs/run/` 下的目录名（已排序；不递归、不跟符号链接） */
export function listRunSlugs(root) {
  const base = path.join(root, RUN_DOCS_REL)
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

/**
 * 某个目录的末次提交。**无任何提交 ⇒ `null`**（目录存在但 git 眼里不存在——新建未提交）。
 * root 不是 git 仓库时抛错，由调用方（`main` 预检 / `collectStale` 逐目录）处置。
 */
export function lastCommitOf(root, slug) {
  const rel = `${RUN_DOCS_REL}/${slug}`
  const out = execFileSync('git', ['-C', root, 'log', '-1', '--format=%H%x09%cI', '--', rel], {
    encoding: 'utf8',
    env: cleanGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  if (!out) return null
  const [sha, date] = out.split('\t')
  return { sha, date }
}

/** 读某目录 `tickets.md` 的 status；文件不存在 / 无 frontmatter / 读失败 ⇒ `null`（显示为 `-`） */
function readStatus(root, slug) {
  try {
    return readStatusField(readFileSync(path.join(root, RUN_DOCS_REL, slug, TICKETS_NAME), 'utf8'))
  } catch {
    return null
  }
}

/**
 * 盘点一遍。`nowMs` 显式传入（**不在函数体里读时钟**）——测试用固定提交时刻 + 固定
 * `nowMs` 得到确定性读数，不靠 `sleep` / 不靠真实时钟。
 *
 * @returns {{ root: string, windowDays: number, scanned: number,
 *             stale: Array<{slug: string, status: string, sha: string, date: string, daysAgo: number}>,
 *             freshCount: number, untracked: string[],
 *             failed: Array<{slug: string, error: string}> }}
 */
export function collectStale({ root, days, nowMs }) {
  const slugs = listRunSlugs(root)
  const stale = []
  const untracked = []
  const failed = []
  let freshCount = 0

  for (const slug of slugs) {
    let last
    try {
      last = lastCommitOf(root, slug)
    } catch (err) {
      // 单目录查询失败不连坐：记进 failed（调用侧据此把整条日志升级成 warn），继续扫
      failed.push({ slug, error: msgOf(err) })
      continue
    }
    if (!last) {
      untracked.push(slug)
      continue
    }
    const daysAgo = Math.floor((nowMs - Date.parse(last.date)) / MS_PER_DAY)
    if (daysAgo > days) {
      stale.push({
        slug,
        status: readStatus(root, slug) ?? '-',
        sha: last.sha,
        date: last.date,
        daysAgo,
      })
    } else {
      freshCount += 1
    }
  }

  return { root, windowDays: days, scanned: slugs.length, stale, freshCount, untracked, failed }
}

function pad(s, width) {
  const str = String(s)
  return str.length >= width ? `${str} ` : str + ' '.repeat(width - str.length)
}

/** 人类可读表（stderr 通道）。列名刻意留 ASCII——CJK 表头在等宽字体下按 2 列宽渲染，
 *  与 `padEnd` 的按字符计数不一致，会错行。 */
export function formatTable(report) {
  const { windowDays, stale, scanned, untracked, failed } = report
  const lines = [
    `[run-docs-stale] docs/run 陈旧清单（末次提交距今 > ${windowDays} 天）：` +
      `${stale.length} / ${scanned} 个目录`,
  ]
  if (stale.length > 0) {
    lines.push(
      `  ${pad('slug', 34)}${pad('status', 16)}${pad('daysAgo', 9)}${pad('lastCommit', 28)}sha`
    )
    for (const r of stale) {
      lines.push(
        `  ${pad(r.slug, 34)}${pad(r.status, 16)}${pad(r.daysAgo, 9)}${pad(r.date, 28)}${r.sha.slice(0, 12)}`
      )
    }
  }
  if (untracked.length > 0) {
    lines.push(`  (无任何提交，年龄不可算，未计入: ${untracked.join(', ')})`)
  }
  if (failed.length > 0) {
    lines.push(`  ⚠ 以下目录 git 查询失败，清单可能不完整:`)
    for (const f of failed) lines.push(`    ${f.slug}: ${f.error}`)
  }
  return lines.join('\n')
}

const USAGE =
  '用法: node scripts/run-docs-stale.mjs [--days N] [--root <仓库根>]\n' +
  '  --days N   陈旧窗口，末次提交距今 > N 天者列出（默认 6）\n' +
  '  --root     仓库根，默认 process.cwd()\n' +
  'stdout = 单行 JSON（机器通道）；stderr = 人类可读清单\n'

/**
 * CLI 入口。返回退出码（不 `process.exit`，便于测试直接调）。
 */
export function main(argv = process.argv.slice(2), { nowMs = Date.now() } = {}) {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(USAGE)
    return 0
  }
  if (args.error) {
    process.stderr.write(`[run-docs-stale] ${args.error}\n${USAGE}`)
    return 1
  }

  const root = path.resolve(args.root ?? process.cwd())
  const base = path.join(root, RUN_DOCS_REL)
  if (!existsSync(base)) {
    // fail-loud：这里返回空报告会被读成「没有陈旧目录」，而真相是「压根没扫到面」。
    // 这是**可见性工具的假绿**，比多一条 warn 危险得多，故宁可退出码 1。
    process.stderr.write(`[run-docs-stale] ${base} 不存在——没有可盘点的面（root=${root}）\n`)
    return 1
  }
  try {
    execFileSync('git', ['-C', root, 'rev-parse', '--git-dir'], {
      encoding: 'utf8',
      env: cleanGitEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    process.stderr.write(`[run-docs-stale] root 不是 git 仓库（root=${root}）: ${msgOf(err)}\n`)
    return 1
  }

  const report = collectStale({ root, days: args.days, nowMs })
  process.stdout.write(`${JSON.stringify(report)}\n`)
  process.stderr.write(`${formatTable(report)}\n`)
  return 0
}

// 直接执行（非被 import）时才跑 main —— 单测 import 本模块不得触发副作用
const isEntry =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isEntry) {
  process.exit(main())
}
