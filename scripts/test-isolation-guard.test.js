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
 * 而漏网的形态恰恰是「新写一个测试、顺手敲了个相对路径」——静态扫是唯一能在代码进仓前
 * 判它的形态。
 *
 * ⚠️ **执行面（别按「提交口护栏」去信它）**：本文件属 `scripts` project
 * （`scripts/vitest.config.ts` 的 include 是「任意目录下的 test.js」），`precommit-scope.mjs` 按改动面
 * 收窄 project（`packages/server/**` ⇒ 只跑 `@cat-study/server`）——故**改 server/web 的提交，
 * 提交口不跑本护栏**。它实际生效于：审查档全量、落地档全量。让 packages 改动也带上 scripts
 * project 属 scope 语义变更（`packages/server` scope ⇒ projects 不再一一对应），已报店长裁，
 * 本文件不擅改（见 report §五-4）。
 *
 * ── 三条规则 ──
 * - **R1**：出现 `node_modules/.cache`（含反斜杠写法）字面量 ⇒ 红。拆成两段字面量
 *   （`join('node_modules', '.cache')`）同样红——**逐行判 + 3 行滑窗判**（见 R1_WINDOW）。
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
 * (e) R1 拆分的跨行窗口宽度上限 = `R1_WINDOW`（3 行）。**超过 3 行**才凑齐两段字面量的
 *     拆分（如中间夹注释/空行把 `'node_modules'` 与 `'.cache'` 推到第 4 行）仍是盲区；
 *     三段以上再拆（`join('node', '_modules', …)`）与经变量中转同样不红——后者见 (a)。
 *     另：**相邻多处会多报**（实测 2 处相邻 ⇒ 报 3 条——中间那对是「前一处后半 + 后一处
 *     前半」的跨组合）。方向是 fail-closed（宁可多报不可漏报）；按窗口去重的写法不会多报，
 *     但会把相邻两处**并成一条**（漏报侧），两害相权取多报。
 * (f) **「注释剥离是词法启发式、不是解析器」这一整类的洞**（根因单一，见下）。
 *
 *     根因：`isRegexStart` 只按**左侧字符**判 `/` 是正则还是除号。`/` 左侧是 `)` / `]` /
 *     标识符时一律判除号——**但这些位置在合法 JS 里可以是正则**（`if (x) /re/.test(s)`）⇒
 *     误判后该 `/` 与其后被原样输出的字符会组成 `/*` 或 `//`，于是状态机进吞食态：
 *     **假注释起点，正文是真代码**。方向不是保守的，是**恒绿**（违规静默消失）。
 *
 *     已收口：`block` 态的**未闭合兜底**（与 `re` 态对称）——合法 JS 的块注释必闭合，故
 *     **跑到 EOF 仍在 `block` 态**即判误剥、把缓冲原文写回。实测 5 条反例
 *     （`if (x) /[/*]/`、`while`、标识符前缀 + 行首正则、`)` 前缀、`arr[0] /`）修复前
 *     5/5 吞代码、修复后 5/5 可见。
 *
 *     **刻意不采用的修法**：把 `)`/`]` 也加进正则前置集合 —— 会把 `f(x) / 2 / g` 这类
 *     **除法**误判成正则，而正则态同样「内容替换为空白」⇒ 等于新开一条遮蔽路径（拿一类
 *     假阴性换另一类）。故兜底一律走**不变量判定**（闭合性），不走前缀枚举。
 *
 *     ⚠️ **残留（同一根因，已实测复现，非推演）——三条**：
 *     - **(f1) 块注释被后文提前闭合**：误判的「块注释」若中途撞上其后某处真实的块注释
 *       闭合符（`*` 紧跟 `/`）而被提前闭合，中间那一段仍被吞 —— EOF 兜底只管「到文件尾都
 *       没闭合」的形态。实测：误判起点 + 违规行 + 一条真块注释 ⇒ 违规行**不可见**。
 *     - **(f2) `line` 态吞行尾**：误判的除法后若正则体内以 `/` `/` 开头（如 `/[//]/`），
 *       则 `//` 判据先于正则判据命中 ⇒ 进 `line` 态吞到行尾（含**同一行**的违规）。
 *       实测：`arr[0] /[//]/.test(s) ; LOG_FILE='node_modules/.cache/x'` ⇒ 违规**不可见**。
 *       `line` 态没有「未闭合」信号（行尾即合法终止）⇒ 块态那套不变量兜底**不适用**。
 *     - **(f3) `re` 态「闭合成形」抹内容**：`re` 态**不是**「不会吞」——被误判成正则起点的
 *       `/` 若在**同一行内**撞上后一个未转义 `/`（它可以是真除法、也可以是字符串里的斜杠），
 *       `re` 态即闭合，并把闭区间内的内容整体替换为等长空白（「正则内容不参与路径判定」的
 *       代价）⇒ **夹在中间的违规静默消失**。实测：`let r = i++ / 2 ; LOG_FILE =
 *       'node_modules/.cache/x'` ⇒ 违规**不可见**（`i-- / 2`、`count++ / 2`、
 *       `} / … / 2` 同）。换行兜底与 EOF 兜底**都只管「未闭合」**，对闭合形态不适用。
 *       **闭合点的精确边界（已实测，非推演）**：`reClass` 内的 `/` **不**闭合 —— 误判起点后
 *       若紧跟一个字符类，抹除段止于**类后**那个 `/`（`let r = i++ /[a/]/.test(s) ; 违规`
 *       ⇒ 违规**幸存可见**）；类后若无所属 `/`，闭合点顺延到下一个类外 `/` ⇒ 又**不可见**。
 *       准确表述是「**字符类之外**的下一个未转义 `/`」，不是「下一个 `/`」——两条都已设格。
 *       （上一版族扫表把此格写成「否（不能吞）」是**假声明**，本轮族扫复核纠正 —— 见 report §四-9。）
 *
 *     三条都无法在词法层与真注释／真除法区分（真注释正文任意；真除法与正则前缀同形）。
 *     彻底收口 = 换真 JS 解析器剥注释，属**新增依赖**、越出派活单交付面，已写进 report §四-9
 *     请店长裁；本文件不自引入。
 *     （本段刻意不写块注释闭合符字面量：它会把本 JSDoc 提前收尾 —— 与实际代码同一类坑。）
 *     触发面：(f1)/(f2) 需先有「字符类内含 `/` 或 `*` 的正则字面量 + 该正则左侧是
 *     `)`/`]`/标识符」这类写法；**(f3) 连正则字面量都不需要** —— 只要「`/` 的左侧字符落在
 *     `REGEX_PRECEDER_CHARS` 内（如 `++`/`--` 的第 2 个 `+`/`-`，或 `}`）且**同一行**另有
 *     一个 `/`」。仓内当前 0 处（`/[/*]/` 仅存在于本文件、已由 (d) 自排除）⇒ 属**潜伏**。
 * (g) 本文件的**执行面**只覆盖审查档 / 落地档全量，不含按改动面收窄的提交口（见上）。
 * (h) R3 只看「键名与 `process.cwd(` 同行」，**不区分**「真的路径表达式」与「字符串里的
 *     描述文字」——用例名 / 断言文本里同时提到两者会误报（实测：本次新增的 shutdown 用例名
 *     即命中，改措辞后消解）。这是向严侧的假阳性，改措辞或按行挂白名单即可，不算漏网。
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
 * 正则字面量的**起始**判定：`/` 左侧最近的非空白字符若属该集合（或位于文件首），
 * 此处的 `/` 是正则定界符而非除号。缺了这条判定，字符类里含 `/` 与 `*` 的正则（形如
 * 「斜杠 方括号 斜杠 星号 方括号 斜杠」）会被当成块注释起始 —— 状态机一路吞到 EOF
 * （或下一个块注释闭合序列），**其后所有违规行静默消失** ⇒ 护栏恒绿。
 * 这是自己踩过的坑，不是假想（原实现在本文件旧版 `stripComments` 里）。
 */
const REGEX_PRECEDER_CHARS = '([{,;:=!&|?+-*%<>~^}'
/** 关键字后的 `/` 也是正则（`return /x/`）；普通标识符后是除号（`a / b`） */
const REGEX_PRECEDER_WORDS =
  /(?:^|[^\w$])(return|typeof|case|in|of|new|delete|void|do|else|yield|await|instanceof)$/

function isRegexStart(out) {
  const prev = out.slice(-32).replace(/\s+$/, '')
  if (prev === '') return true // 文件首
  const lastCh = prev[prev.length - 1]
  if (REGEX_PRECEDER_CHARS.includes(lastCh)) return true
  if (/[A-Za-z0-9_$]/.test(lastCh)) return REGEX_PRECEDER_WORDS.test(prev)
  return false
}

/**
 * 去掉注释，**保留换行与行号**（注释内容替换为空白）——保证报出的行号能直接对上源文件。
 * 字符串字面量整体保留（内含 `//` 的 URL 不会被误当行注释截断）；正则字面量整体替换为
 * 等长空白（它的**内容**不产生路径，且体内若含 `'`/`"` 不应被当字符串起始）。
 */
export function stripComments(src) {
  let out = ''
  const n = src.length
  let i = 0
  let state = 'code' // code | line | block | sq | dq | tpl | re | reClass
  /** 正则态的暂存（闭合才写入 `out`；未闭合 = 前面判错了，原样退回） */
  let reBuf = ''
  /**
   * 块注释态的暂存 —— **与正则态同款的「未闭合 ⇒ 原样退回」对称兜底**。
   *
   * 为什么需要：`/` 后紧跟 `*` 时优先判块注释（顺序正确，否则真块注释会被当正则），
   * 但左 `/` 若被正则起始启发式**误判成除号**（前缀是 `)`/`]`/标识符时），这个 `/` 与
   * 紧随的 `*` 就会被当注释起始 —— 于是**注释起点是假的、正文是真代码**。
   * 合法 JS 的块注释必闭合 ⇒ **跑到 EOF 仍在 block 态**即为误判的判据 ⇒ 原样写回。
   * 判据与前缀启发式解耦：不靠「把 `)`/`]` 也认成正则前置」（那会把 `f(x) / 2 / g`
   * 这类除法误判成正则，反而新开一条遮蔽路径）。
   *
   * `buf` 与 `placeholder` 并行累积：闭合才把占位符写进 `out`（保留换行与行号、内容不参与
   * 路径判定），未闭合则写 `buf` 原文——**两者都只在闭合/EOF 时才落盘**，故行号不会错位。
   */
  let blockBuf = ''
  let blockPlaceholder = ''
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (state === 'code') {
      if (c === '/' && d === '/') {
        state = 'line'
        i += 2
        continue
      }
      // ⚠️ 顺序即正确性：`/*` 必须先于正则态判掉（否则真块注释会被当正则），
      // 正则态又必须先于「默认按字面量输出」判掉（否则 `/[/*]/` 会进块注释态吞代码）。
      if (c === '/' && d === '*') {
        state = 'block'
        blockBuf = ''
        blockPlaceholder = ''
        i += 2
        continue
      }
      if (c === '/' && isRegexStart(out)) {
        state = 're'
        reBuf = c
        i++
        continue
      }
      if (c === "'") state = 'sq'
      else if (c === '"') state = 'dq'
      else if (c === '`') state = 'tpl'
      out += c
      i++
      continue
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code'
        out += c
      }
      i++
      continue
    }
    if (state === 'block') {
      if (c === '*' && d === '/') {
        // 真块注释闭合：此刻才把占位符写进 `out`（换行保留、行号对齐、内容不参与判定）
        out += blockPlaceholder
        blockBuf = ''
        blockPlaceholder = ''
        state = 'code'
        i += 2
        continue
      }
      blockBuf += c
      blockPlaceholder += c === '\n' ? '\n' : ' '
      i++
      continue
    }
    if (state === 're' || state === 'reClass') {
      // 正则不跨行：换行仍未闭合 ⇒ 前面把除号误判成了正则，原样退回 code 态
      if (c === '\n') {
        out += reBuf + c
        reBuf = ''
        state = 'code'
        i++
        continue
      }
      if (c === '\\') {
        reBuf += c + (d ?? '')
        i += 2
        continue
      }
      reBuf += c
      i++
      if (state === 're' && c === '[') state = 'reClass'
      else if (state === 'reClass' && c === ']') state = 're'
      else if (state === 're' && c === '/') {
        out += ' '.repeat(reBuf.length) // 正则整体占位，不参与路径判定
        reBuf = ''
        state = 'code'
      }
      continue
    }
    // 字符串态：原样保留（转义对整体吞掉，防 `'\''` 提前收尾）
    if (c === '\\') {
      out += c
      if (d !== undefined) out += d
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
    out += c
    i++
  }
  // 收尾兜底（对称于正则态的「换行未闭合」退回）：跑到 EOF 仍未闭合 = 前面判错了，
  // 把缓冲的**原文**写回（占位符丢弃）。方向是 fail-closed：只会让更多文本进入判定，
  // 不会让违规静默消失。残留形态见文件头覆盖边界 (f)。
  if (state === 'block') out += blockBuf
  else if (state === 're' || state === 'reClass') out += reBuf
  return out
}

/**
 * R1 的**跨行窗口**宽度（行）——覆盖 prettier `printWidth` 把 `join('node_modules',\n'.cache', …)`
 * 拆到多行的形态。逐行判看不见这种拆分（两段各自是 `null`），而第 10 处（`browseTmpDir`）
 * 恰恰是拆分写法，靠 V13 实跑才抓出来。窗口只判 R1：R2/R3 的语义是「同一行同现」，
 * 跨行拼接会把无关的两行凑成命中 ⇒ 假阳性。
 */
const R1_WINDOW = 3

/** R1 判据（连续形态 或 拆分形态），供逐行判与跨行窗口判共用 */
export function detectR1(text) {
  if (R1_RE.test(text)) return true
  return R1_SPLIT_NM_RE.test(text) && R1_SPLIT_CACHE_RE.test(text)
}

/** 本行**单独**携带 R1 拆分形态的哪一半（`'nm'` / `'cache'` / `null`），供跨行窗口配对 */
function halfOf(line) {
  if (R1_SPLIT_NM_RE.test(line)) return 'nm'
  if (R1_SPLIT_CACHE_RE.test(line)) return 'cache'
  return null
}

/**
 * 判一行代码。返回命中的规则 id（`R1` / `R2` / `R3`）或 `null`。
 * 一行只报**第一条**命中的规则：R1 与 R2 常同时命中同一条白名单行，重复报会让白名单翻倍。
 */
export function detect(line) {
  if (detectR1(line)) return 'R1'
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
    // 收窄到**那条兜底写法本身**（原为 /napcat/，会豁免该文件任何含 "napcat" 的行 —— 过宽）
    lineMatch: /RESTART_FILES_DIR\s*\?\?\s*process\.cwd\(\)/,
    reason:
      '同 restart-request.ts：NapCat 请求/配置文件的生产侧定位（`RESTART_FILES_DIR ?? process.cwd()`）' +
      '——dev.js 轮询的就是仓库根的 `.napcat-request`，落 cwd 是设计意图。测试侧已在' +
      'connectors.test.ts 里经 isolatedTestDir 隔离',
  },
]

const rel = (abs) => relative(REPO_ROOT, abs).split('\\').join('/')

/**
 * 判一个源文件（**已去注释**）的违规行。抽成纯函数是为了让跨行窗口这条判据可做反向对照——
 * 只跑真仓库的话，「窗口判据坏了」与「仓库里恰好没有跨行形态」在读数上不可区分。
 *
 * @returns {{file: string, line: number, rule: string, text: string}[]}
 */
export function scanSource(file, code) {
  const lines = code.split('\n')
  const raw = []
  lines.forEach((line, idx) => {
    const rule = detect(line)
    if (rule) raw.push({ file, line: idx + 1, rule, text: line.trim() })
  })
  // 跨行窗口（只判 R1）：逐行看不见的「两段字面量被 pretty 换行拆开」形态。
  // 锚点 = **携带前半段字面量**的那一行，判据 = 「本行携带一半 + 其后 R1_WINDOW-1 行内携带另一半」。
  // ⚠️ 不用「上一窗口是否命中」去重——那种按窗口去重的写法会把**两处相邻的真实违规并成一条**
  // （实测读数：两处相邻 ⇒ 报 1 条；本实现改为 2 处 ⇒ 报 3 条）。多报在 fail-closed 侧，
  // 漏报不是；代价与理由见覆盖边界 (e)。
  for (let i = 0; i + 1 < lines.length; i++) {
    if (detectR1(lines[i])) continue // 本行已完整命中 ⇒ 逐行 pass 报过，不再当锚点
    const half = halfOf(lines[i])
    if (!half) continue // 锚点必须自己携带一半
    const rest = lines.slice(i + 1, i + R1_WINDOW)
    const other = half === 'nm' ? R1_SPLIT_CACHE_RE : R1_SPLIT_NM_RE
    if (!rest.some((l) => other.test(l))) continue
    raw.push({
      file,
      line: i + 1,
      rule: 'R1',
      text: `[跨行 ${R1_WINDOW} 行窗口] ${lines
        .slice(i, i + R1_WINDOW)
        .map((l) => l.trim())
        .filter(Boolean)
        .join(' ⏎ ')}`,
    })
  }
  return raw
}

function scanRepo() {
  const files = SCAN_ROOTS.flatMap((r) => walk(join(REPO_ROOT, r)))
  const raw = []
  for (const abs of files) {
    const file = rel(abs)
    if (file === SELF_FILE) continue
    raw.push(...scanSource(file, stripComments(readFileSync(abs, 'utf-8'))))
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

  it('R1 跨行拆分（pretty 换行）→ 也红；窗口只认 R1，不把无关两行凑成 R2/R3', () => {
    // prettier printWidth=100 下最可能出现的形态：join 的两段各占一行
    const split = "const d = path.join(\n  'node_modules',\n  '.cache',\n  'restart-test'\n)\n"
    // 逐行判**看不见**这条 —— 这不是修辞，是加窗口的理由（窗口拿掉 ⇒ 下面那条断言红）
    expect(split.split('\n').every((l) => !detectR1(l))).toBe(true)
    expect(scanSource('x.js', split).length).toBe(1)
    // 同一段只报一次（同一对不被重叠窗口重复计数）
    expect(scanSource('x.js', "'node_modules'\n'.cache'\n").length).toBe(1)
    // **相邻两处真实违规不得并成一条** —— 按窗口去重的旧写法实测并成 1 条，此为修复的对照。
    // 报 3 条 > 2 处：中间那对是「第 1 处的后半 + 第 2 处的前半」这一跨组合，属 fail-closed
    // 侧的多报（宁可多报，不可漏报），已写进覆盖边界 (e)。
    expect(scanSource('x.js', "'node_modules'\n'.cache'\n'node_modules'\n'.cache'\n").length).toBe(
      3
    )
    // 只有一段 → 不红
    expect(scanSource('x.js', "const d = path.join(\n  'node_modules',\n  'x'\n)\n").length).toBe(0)
    // 窗口**不**判 R2/R3：隔离键与相对值分处两行，不是违规（不然假阳性满天飞）
    expect(scanSource('x.js', 'const KEY = RESTART_FILES_DIR\nconst v = "rel/x"\n').length).toBe(0)
    expect(
      scanSource('x.js', 'const KEY = RESTART_FILES_DIR\nconst c = process.cwd()\n').length
    ).toBe(0)
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

  it('正则字面量不吞后续代码（`/[/*]/` 曾让块注释态吞到 EOF ⇒ 护栏恒绿）', () => {
    // 这条是**修复的反向对照**：修复前 `/[/*]/` 里第二个 `/`+`*` 被判成块注释起始，
    // 无闭合则吞到文件尾，第 2 行的违规**根本进不了 detect**。
    const src = "const re = /[/*]/\nconst LOG_FILE = 'node_modules/.cache/x'\n"
    const stripped = stripComments(src)
    expect(stripped.split('\n')[1]).toContain('LOG_FILE') // 第 2 行没被吞
    expect(detect(stripped.split('\n')[1])).toBe('R1')
    // 真块注释仍要被剥掉（修复不得反向误伤：`/*` 判定必须排在正则判定之前）
    const withBlock = "const a = 1 /* LOG_FILE: 'x/y.log' */\nconst b = 2\n"
    expect(detect(stripComments(withBlock).split('\n')[0])).toBe(null)
    // 除号不得被误判成正则（`a / b` 后跟字符串，不能吞）
    const div = "const ratio = a / b ; LOG_FILE: 'rel.log'\n"
    expect(detect(stripComments(div))).toBe('R2')
    // `return /re/` 这类关键字后置的正则：不吞后续行
    const ret = "function f() { return /[/]/.test(s) }\nLOG_FILE: 'rel.log'\n"
    expect(detect(stripComments(ret).split('\n')[1])).toBe('R2')
  })

  it('块注释态未闭合兜底：`)/]`/标识符前缀令 `/` 误判成除号时，EOF 仍在 block 态 ⇒ 原样写回', () => {
    // 这一格是**上一条只修了半程**的对照：`= /[/*]/` 被正则态接住了，但左 `/` 前缀是
    // `)` / `]` / 标识符时走的是「除号」分支 ⇒ `/` 与 `[` 原样输出 ⇒ 紧随的 `/`+`*`
    // 被当注释起始。合法 JS 的块注释必闭合，故 EOF 仍在 block 态即判误剥、**原文写回**。
    const BAD = "const LOG_FILE = 'node_modules/.cache/x'\n"
    const cases = [
      ['if(x) 前缀', `if (x) /[/*]/.test(y)\n${BAD}`],
      ['while 前缀', `while (a) /[/*]/g.test(b)\n${BAD}`],
      ['标识符前缀 + 行首正则', `const z = foo\n/[/*]/.test(y)\n${BAD}`],
      [') 前缀 + 行首正则', `f(x)\n/[/*]/.test(y)\n${BAD}`],
      ['下标前缀', `arr[0] /[/*]/.test(s)\n${BAD}`],
    ]
    for (const [name, src] of cases) {
      const stripped = stripComments(src)
      const lines = stripped.split('\n')
      // 违规行必须**活着**（修复前这 5 格全部输出全空白）
      expect(
        lines.filter((l) => l.includes('LOG_FILE')),
        name
      ).toHaveLength(1)
      expect(detect(lines.find((l) => l.includes('LOG_FILE'))), name).toBe('R1')
      // 行号不得因「缓冲到 EOF 才写回」而错位：违规行在 `out` 里的下标必须与源一致
      expect(
        lines.findIndex((l) => l.includes('LOG_FILE')),
        name
      ).toBe(src.split('\n').findIndex((l) => l.includes('LOG_FILE')))
      expect(lines, name).toHaveLength(src.split('\n').length)
    }
  })

  it('已声明边界 (f) 的三条**残留**（同根因）：(f1) 块被后文闭合、(f2) `line` 态吞行尾、(f3) `re` 态闭合成形', () => {
    // ⚠️ 本格钉的是**覆盖边界 (f) 明写的已知洞**，不是「期望行为」。将来若真修好
    // （例如换真 JS 解析器），本格会红 —— 那正是提醒「把 (f) 的声明同步改掉」。
    // 三条同根因：`isRegexStart` 只按左侧字符判正则/除号，`)`/`]`/标识符后的正则被误判成除法。
    //
    // (f1) EOF 兜底只管「到文件尾都没闭合」；误判的假块注释若中途撞上其后某处真实
    //      块注释闭合符而被提前闭合，中间那一段仍不可见。
    const src = `if (x) /[/*]/.test(y)\nconst LOG_FILE = 'node_modules/.cache/x'\n/* 真注释 */\n`
    const stripped = stripComments(src)
    expect(stripped).not.toContain('LOG_FILE') // ← 洞的实测读数
    // 对照：同一段代码**去掉后文的 `*/`** ⇒ EOF 兜底生效、违规可见（证明上一条不是恒绿）
    const noCloser = `if (x) /[/*]/.test(y)\nconst LOG_FILE = 'node_modules/.cache/x'\n`
    expect(stripComments(noCloser)).toContain('LOG_FILE')

    // (f2) 同根因的第二条：误判的除法后，正则体内以 `/` `/` 开头 ⇒ `//` 判据先于正则判据
    //      命中 ⇒ 进 `line` 态吞到行尾（含**同一行**的违规）。`line` 态没有「未闭合」信号
    //      （行尾即合法终止）⇒ 块态那套不变量兜底不适用。
    const lineSwallow = `arr[0] /[//]/.test(s) ; LOG_FILE = 'node_modules/.cache/x'\n`
    expect(stripComments(lineSwallow)).not.toContain('LOG_FILE') // ← 洞的实测读数
    // 对照：**同行无 `//`** 的同类正则 ⇒ 违规可见（证明上一条不是恒绿）
    expect(stripComments(`arr[0] /[ab]/.test(s) ; LOG_FILE = 'rel/x.log'\n`)).toContain('LOG_FILE')

    // (f3) 同根因的第三条：被误判成正则起点的 `/`（左侧是 `+`/`-`/`}` 等前缀字符）若在
    //      **同一行内**撞上后一个未转义 `/`（真除法、字符串里的斜杠均可），`re` 态即闭合、
    //      两端之间整体替换为等长空白 ⇒ 夹在中间的违规**静默消失**。这条**不需要正则字面量**。
    //      两条兜底（换行 / EOF）都只管「未闭合」，对闭合形态不适用。
    const reClosed = [
      ['i++ 前缀', `let r = i++ / 2 ; LOG_FILE = 'node_modules/.cache/x'\n`],
      ['i-- 前缀', `let r = i-- / 2 ; LOG_FILE = 'node_modules/.cache/x'\n`],
      ['} 前缀', `function f(){} / LOG_FILE = 'node_modules/.cache/x' / 2\n`],
    ]
    for (const [name, src] of reClosed) {
      expect(stripComments(src), name).not.toContain('LOG_FILE') // ← 洞的实测读数
    }
    // 对照：把闭合斜杠**移到违规之前** ⇒ 抹除段不含违规 ⇒ 可见（证明上一条不是恒绿）
    expect(
      detect(stripComments(`let r = i++ / 2 / 3 ; LOG_FILE = 'node_modules/.cache/x'\n`))
    ).toBe('R1')

    // (f3) 的**闭合点边界**（成对两格，钉的是「我描述的边界」本身 —— 写窄/写宽都会在此露出）：
    // `reClass` 内的 `/` **不**闭合 ⇒ 误判起点后紧跟字符类时，抹除段止于**类后**那个 `/`
    // ⇒ 违规幸存（可见）。
    expect(
      stripComments(`let r = i++ /[a/]/.test(s) ; LOG_FILE = 'node_modules/.cache/x'\n`)
    ).toContain('LOG_FILE')
    // 而字符类后**没有**类外后继 `/`（除 `node_modules/` 里那个）⇒ 闭合点顺延、抹除段变长
    // ⇒ 违规再次不可见。两格合起来证明闭合点是「**字符类之外**的下一个未转义 `/`」。
    expect(stripComments(`let r = i++ /[a/] ; LOG_FILE = 'node_modules/.cache/x'\n`)).not.toContain(
      'LOG_FILE'
    )
  })
})

describe('全仓扫描：packages/** + scripts/** 零违规（白名单外）', () => {
  it('扫到的文件数足够多（防空扫恒绿）', () => {
    const { files } = scanRepo()
    expect(files.length).toBeGreaterThan(150)
  })

  it('白名单外无违规；白名单内条目**全部**有理由且真正命中（防死条目）', () => {
    const { raw } = scanRepo()

    // 计数键是**白名单条目本身**而不是 file —— 同一文件挂两条目时按 file 计数会合并，
    // 死条目检查随之失效（其中一条从未命中也看不出来）。
    const hitCount = new Map(WHITELIST.map((w) => [w, 0]))
    const unwhitelisted = []
    for (const v of raw) {
      const w = WHITELIST.find((x) => x.file === v.file && x.lineMatch.test(v.text))
      if (w) hitCount.set(w, hitCount.get(w) + 1)
      else unwhitelisted.push(v)
    }

    // 违规逐条列出（断言消息里带 file:line，失败时不用再捞）
    expect(unwhitelisted.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.text}`)).toEqual([])

    // 白名单非死条目：每条都必须真的豁免到至少一行
    const dead = WHITELIST.filter((w) => hitCount.get(w) === 0).map(
      (w) => `${w.file} :: ${w.lineMatch}`
    )
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
