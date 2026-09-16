/**
 * 测试隔离路径 —— **类级静态护栏**（票 `precommit-scope` A′ 扩面，验收 V14）。
 *
 * 被判面 = 「`packages/**` 与 `scripts/**` 的源码里，不存在把测试隔离文件（重启请求 /
 * 日志 / env 副本）落到 **junction 共享面** 的路径写法」。共享面 = `<任一仓库根>/node_modules/**`：
 * worktree 的 `node_modules` 是指向主仓库的 junction，故相对路径与 cwd 派生路径在主仓库、
 * 本会话 worktree、以及将来「一猫一 worktree」的各根里解析到**同一批物理文件**——两进程
 * 并发跑同一批用例时，A 的 `afterEach` 删掉 B 刚 `existsSync` 过的那一个文件 ⇒ 假红。
 *
 * 为什么是静态源断言而不是行为断言：行为面（`vi.stubEnv` 的值）**只有跑起来才可见**，
 * 而漏网的形态恰恰是「新写一个测试、顺手敲了个相对路径」——静态扫能在提交口拦下。
 *
 * ── 三条规则（对**去注释后**的代码逐行判） ──
 * - **R1**：出现 `node_modules/.cache`（含反斜杠写法）字面量 ⇒ 红。
 * - **R2**：隔离键（`RESTART_FILES_DIR` / `LOG_FILE` / `ENV_FILE_PATH`）被赋一个
 *   **字符串字面量**且该值**不是绝对路径** ⇒ 红。
 * - **R3**：同一行里隔离键与 `process.cwd()` 同现 ⇒ 红（cwd 派生同样落 junction 共享面）。
 *
 * ── 覆盖边界自陈（**未覆盖**的形态，别把绿当全绿） ──
 * (a) 值经变量中转的 cwd 派生（`const d = process.cwd() + '/x'; vi.stubEnv(KEY, d)`）——
 *     R2 只认字面量、R3 只认同行同现，该形态**不红**。词法层无法在不误伤生产代码
 *     （`process.env.X ?? process.cwd()` 是运行时兜底、合法）的前提下闭合，故显式声明。
 * (b) 非 `.ts/.js/.mjs/.cjs` 的载体（`.json` / 文档 / shell）不在扫描面内。
 * (c) 白名单文件（见下）内的**其它**行仍受判——白名单按「行匹配正则」收窄，不是整文件豁免。
 * (d) **本文件自身不自扫**（`SELF_FILE`）——它的存在意义就是包含违规样本（反向对照的夹具），
 *     自扫会把夹具判成真违规。代价：本文件若真写入隔离路径不会被拦下，由「本文件不产生
 *     任何隔离路径」这一人工事实承担，改本文件时须人工复核。
 *
 * 自指说明：R1 的正则用转义拼接构造，故本文件源码不含该字面量的连续形态（构造残留由 (d) 兜底）。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import serverVitestConfig from '../packages/server/vitest.config.js'
import { isolatedTestDir } from '../packages/server/src/test-helpers.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ─── 检测器 ───────────────────────────────────────────────

/** 隔离键：这三者的值决定测试文件写到哪儿 */
const ISOLATION_KEYS = ['RESTART_FILES_DIR', 'LOG_FILE', 'ENV_FILE_PATH']

/**
 * R1 的正则**由拼接构造**：本文件自身也在扫描面内，直接写字面量会自指命中。
 * `[\\/]` 同时吃 `/` 与 `\` 两种分隔符写法。
 */
const R1_RE = new RegExp('node_modules[\\\\/]\\.cache')

/**
 * R1 的**拆分形态**：`path.join('node_modules', '.cache', …)` —— 两段各是一个字符串字面量，
 * 中间的 `/` 由 `join` 拼出，故连续形态的正则看不见。
 * **这不是假想**：票面点名的 9 处之外，`routes/connectors.test.ts` 的 `browseTmpDir` 正是
 * 这个写法——静态扫漏掉，由 V13「主仓库 ↔ worktree 并发实跑」抓出（主仓库侧 `rmSync`
 * 删掉 worktree 正在用的同一批文件 ⇒ 假红，round 2 实证）。
 */
const R1_SPLIT_NM_RE = new RegExp('([\'"`])node_modules\\1')
const R1_SPLIT_CACHE_RE = new RegExp('([\'"`])\\.cache\\1')

const R2_RES = ISOLATION_KEYS.map((k) => ({
  key: k,
  // `KEY: 'v'` / `KEY = 'v'`（对象字面量与赋值两种形态）
  assign: new RegExp(`\\b${k}\\b\\s*[:=]\\s*(['"\`])([^'"\`]*)\\1`),
  // `stubEnv('KEY', 'v')`
  stub: new RegExp(`stubEnv\\(\\s*(['"\`])${k}\\1\\s*,\\s*(['"\`])([^'"\`]*)\\2`),
  keyRe: new RegExp(`\\b${k}\\b`),
}))

/**
 * 去掉注释，**保留换行与行号**（注释内容替换为空白）——保证报出的行号能直接对上源文件。
 * 字符串字面量整体保留（内含 `//` 的 URL 不会被误当行注释截断）。
 */
export function stripComments(src) {
  const out = []
  const n = src.length
  let i = 0
  let state = 'code' // code | line | block | sq | dq | tpl
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (state === 'code') {
      if (c === '/' && d === '/') {
        state = 'line'
        i += 2
        continue
      }
      if (c === '/' && d === '*') {
        state = 'block'
        i += 2
        continue
      }
      if (c === "'") state = 'sq'
      else if (c === '"') state = 'dq'
      else if (c === '`') state = 'tpl'
      out.push(c)
      i++
      continue
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code'
        out.push(c)
      }
      i++
      continue
    }
    if (state === 'block') {
      if (c === '*' && d === '/') {
        state = 'code'
        i += 2
        continue
      }
      out.push(c === '\n' ? '\n' : ' ')
      i++
      continue
    }
    // 字符串态：原样保留（转义对整体吞掉，防 `'\''` 提前收尾）
    if (c === '\\') {
      out.push(c)
      if (d !== undefined) out.push(d)
      i += 2
      continue
    }
    if (
      (state === 'sq' && c === "'") ||
      (state === 'dq' && c === '"') ||
      (state === 'tpl' && c === '`')
    ) {
      state = 'code'
    }
    out.push(c)
    i++
  }
  return out.join('')
}

/**
 * 判一行代码。返回命中的规则 id（`R1` / `R2` / `R3`）或 `null`。
 * 一行只报**第一条**命中的规则：R1 与 R2 常同时命中同一条白名单行，重复报会让白名单翻倍。
 */
export function detect(line) {
  if (R1_RE.test(line)) return 'R1'
  if (R1_SPLIT_NM_RE.test(line) && R1_SPLIT_CACHE_RE.test(line)) return 'R1'
  for (const r of R2_RES) {
    // assign 形态捕获组 =（引号, 值）；stub 形态 =（键引号, 值引号, 值）——
    // 两种形态的**最后一个**捕获组都是值。
    const m = r.assign.exec(line) ?? r.stub.exec(line)
    if (m && !isAbsolute(m[m.length - 1])) return 'R2'
  }
  for (const r of R2_RES) {
    if (r.keyRe.test(line) && line.includes('process.cwd(')) return 'R3'
  }
  return null
}

// ─── 扫描面 ───────────────────────────────────────────────

const SCAN_ROOTS = ['packages', 'scripts']
const EXTS = ['.ts', '.js', '.mjs', '.cjs']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.cache', 'data', '.git'])

/**
 * **本文件不自扫**：它是检测器的测试夹具——反向对照要求在模板字符串里**种入**违规样本
 * （`RESTART_FILES_DIR: 'node_modules/.cache/…'` 等），自扫会把夹具判成真违规。
 * 这是本护栏**已知的**覆盖边界（已写进文件头「覆盖边界自陈」(d)）：本文件若真写入
 * 隔离路径不会被拦下，由「本文件不产生任何隔离路径」这一人工事实承担——改本文件时
 * 须人工复核这一条。
 */
const SELF_FILE = 'scripts/test-isolation-guard.test.js'

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(name)) continue
      walk(full, acc)
    } else if (EXTS.some((e) => name.endsWith(e))) {
      acc.push(full)
    }
  }
  return acc
}

/**
 * 白名单：**按行匹配正则收窄**（不是整文件豁免）——同文件内的其它行照判。
 * `reason` 必填且非空（有断言钉着），防「加个路径就过」。
 * 每条都要求**实际命中 ≥1 行**（有断言钉着），防白名单腐烂成死条目。
 */
const WHITELIST = [
  {
    file: 'packages/server/vitest.config.ts',
    lineMatch: /\bLOG_FILE\b/,
    reason:
      'LOG_FILE 族不在本票范围（票面明写：restart 族 9 处收口，LOG_FILE 两处另立单）——' +
      '本行改的是 RESTART_FILES_DIR，LOG_FILE 仍相对路径，待后续单收口',
  },
  {
    file: 'scripts/vitest.config.ts',
    lineMatch: /\bLOG_FILE\b/,
    reason: '同上：LOG_FILE 族另立单，本票不碰',
  },
  {
    file: 'packages/server/src/logger.test.ts',
    // 两行：stubEnv 那行含 `LOG_FILE`，断言那行只含路径末段 `test-logs`
    lineMatch: /\bLOG_FILE\b|test-logs/,
    reason:
      '**故意**用相对路径：该用例断言的是 resolveLogFile() 这个**纯函数**的返回值语义' +
      '（`path.resolve(相对值)`），全程不写文件、不落盘 ⇒ 不产生任何跨根共享的物理文件，' +
      '与「隔离目录落共享面」的失败形态无关。LOG_FILE 族另立单时一并评估',
  },
  {
    file: 'packages/server/src/restart-request.ts',
    lineMatch: /\bRESTART_FILES_DIR\b/,
    reason:
      '生产侧运行时兜底 `process.env.RESTART_FILES_DIR ?? process.cwd()`——生产进程 cwd 就是' +
      '仓库根，写真实 `.restart-request` 正是**设计意图**（dev.js 轮询该文件）。它不是测试隔离，' +
      '不落 junction 共享面的失败形态',
  },
  {
    file: 'packages/server/src/config/context-config.ts',
    lineMatch: /\bRESTART_FILES_DIR\b/,
    reason: '同 restart-request.ts：生产侧 `?? process.cwd()` 兜底，非测试隔离',
  },
  {
    file: 'packages/server/src/routes/connectors.ts',
    lineMatch: /napcat/,
    reason:
      '同 restart-request.ts：NapCat 请求/配置文件的生产侧定位（`RESTART_FILES_DIR ?? process.cwd()`）' +
      '——dev.js 轮询的就是仓库根的 `.napcat-request`，落 cwd 是设计意图。测试侧已在' +
      'connectors.test.ts 里经 isolatedTestDir 隔离',
  },
]

const rel = (abs) => relative(REPO_ROOT, abs).split('\\').join('/')

function scanRepo() {
  const files = SCAN_ROOTS.flatMap((r) => walk(join(REPO_ROOT, r)))
  /** @type {{file: string, line: number, rule: string, text: string}[]} */
  const raw = []
  for (const abs of files) {
    const file = rel(abs)
    if (file === SELF_FILE) continue
    const code = stripComments(readFileSync(abs, 'utf-8'))
    code.split('\n').forEach((line, idx) => {
      const rule = detect(line)
      if (rule) raw.push({ file, line: idx + 1, rule, text: line.trim() })
    })
  }
  return { files, raw }
}

// ─── 用例 ───────────────────────────────────────────────

describe('检测器非恒真（反向对照：种入违规必须红、合规必须绿）', () => {
  it('R1：相对 node_modules/.cache 字面量 → 红', () => {
    expect(detect(`      RESTART_FILES_DIR: 'node_modules/.cache/restart-test',`)).toBe('R1')
    expect(detect(`const D = resolve(__dirname, '../node_modules/.cache/x')`)).toBe('R1')
  })

  it('R1 拆分形态：join 的两段字面量 → 也红（连续形态正则看不见，V13 实跑抓出的漏网形态）', () => {
    expect(detect(`const d = path.join('node_modules', '.cache', 'restart-test-browse')`)).toBe(
      'R1'
    )
    expect(detect(`const d = join("node_modules", ".cache")`)).toBe('R1')
    // 只出现其一 → 不红（`node_modules` 单独出现是合法依赖引用）
    expect(detect(`import x from 'node_modules/.pnpm/foo'`)).toBe(null)
    expect(detect(`const d = path.join('node_modules', 'x')`)).toBe(null)
  })

  it('R2：隔离键赋一个非绝对字面量 → 红；赋绝对路径 → 绿', () => {
    expect(detect(`vi.stubEnv('RESTART_FILES_DIR', 'restart-test-x')`)).toBe('R2')
    expect(detect(`  LOG_FILE: 'some/relative/log.txt',`)).toBe('R2')
    expect(detect(`  ENV_FILE_PATH = '.env.test'`)).toBe('R2')
    expect(detect(`vi.stubEnv('RESTART_FILES_DIR', isolatedTestDir('restart-test-x'))`)).toBe(null)
    expect(detect(`  LOG_FILE: resolve(ISOLATION_ROOT, 'logs/x.log'),`)).toBe(null)
  })

  it('R3：隔离键与 process.cwd() 同行 → 红；只出现其一 → 绿', () => {
    expect(detect(`const RESTART_FILES_DIR = resolve(process.cwd(), 'x')`)).toBe('R3')
    expect(detect(`const lockFile = resolve(process.cwd(), '.agent-busy')`)).toBe(null)
  })

  it('注释里的违规**不**报（判据须与实现同面：注释不产生路径）', () => {
    expect(detect(stripComments(`// RESTART_FILES_DIR: 'node_modules/.cache/x'`).trim())).toBe(null)
    expect(detect(stripComments(`/* vi.stubEnv('LOG_FILE', 'a/b.log') */`).trim())).toBe(null)
    // 字符串里的 `//` 不得把行尾当注释吞掉（URL 场景）
    expect(detect(stripComments(`const u = 'http://x/y' ; LOG_FILE: 'rel.log'`))).toBe('R2')
  })

  it('字符串转义不提前收尾（反斜杠转义引号不得被当成字符串结束）', () => {
    const code = stripComments(`const s = 'a\\'b' ; LOG_FILE: 'rel.log'`)
    expect(detect(code)).toBe('R2')
  })
})

describe('全仓扫描：packages/** + scripts/** 零违规（白名单外）', () => {
  it('扫到的文件数足够多（防空扫恒绿）', () => {
    const { files } = scanRepo()
    expect(files.length).toBeGreaterThan(150)
  })

  it('白名单外无违规；白名单内条目**全部**有理由且真正命中（防死条目）', () => {
    const { raw } = scanRepo()

    const hitCount = new Map(WHITELIST.map((w) => [`${w.file}`, 0]))
    const unwhitelisted = []
    for (const v of raw) {
      const w = WHITELIST.find((x) => x.file === v.file && x.lineMatch.test(v.text))
      if (w) hitCount.set(w.file, hitCount.get(w.file) + 1)
      else unwhitelisted.push(v)
    }

    // 违规逐条列出（断言消息里带 file:line，失败时不用再捞）
    expect(unwhitelisted.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.text}`)).toEqual([])

    // 白名单非死条目：每条都必须真的豁免到至少一行
    const dead = WHITELIST.filter((w) => hitCount.get(w.file) === 0).map((w) => w.file)
    expect(dead).toEqual([])

    // 理由必填非空
    expect(
      WHITELIST.filter((w) => !w.reason || w.reason.trim().length < 20).map((w) => w.file)
    ).toEqual([])
  })
})

describe('V12 双模式：隔离路径恒为绝对且不落仓库内', () => {
  it('包配置解析出的 RESTART_FILES_DIR 与 test-helpers 同源、绝对、在仓库外', () => {
    const value = serverVitestConfig.test.env.RESTART_FILES_DIR
    expect(isAbsolute(value)).toBe(true)
    // 不在仓库内（这是本票的全部意义：worktree 的 node_modules 是指向主仓库的 junction）。
    // 跨盘符时 path.relative 直接返回绝对路径 ⇒ 两种「在外」都要认。
    const step = relative(REPO_ROOT, value)
    expect(step.startsWith('..') || isAbsolute(step)).toBe(true)
    expect(value).not.toContain('node_modules')
    // 末段保留 restart-test：socketio.test.ts 有断言钉着这个片段
    expect(value.endsWith('restart-test')).toBe(true)
  })

  it('两份派生公式（配置面 / test-helpers 面）解析到**同一个**目录（防公式漂移）', () => {
    // 配置面不能 import test-helpers（会把 better-sqlite3 拖进配置加载期）⇒ 公式复制了两份。
    // 复制就有漂移风险，此断言把「两份公式同解」钉死：任一处改了键或拼接方式，这条先红。
    expect(serverVitestConfig.test.env.RESTART_FILES_DIR).toBe(isolatedTestDir('restart-test'))
  })
})
