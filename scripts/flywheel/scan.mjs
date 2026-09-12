/**
 * 飞轮扫描器 —— 把白名单内的**结晶 MD** 变成 `chunks` 索引行。
 *
 * 它是**唯一「读 MD 写索引」的入口**（map Decisions 6：索引侧无独立写口）。
 * 承 Decisions 34 一–三（S1/S2/S3）/ S4（**用户裁「物理删」**）/ Decisions 20·22
 * （fail-closed 准入）/ Decisions 17（身份键）/ 票丙 `segmentDocument` / 票丁 `EmbeddingClient`。
 *
 * ## 三条不可换序的口径
 *
 * 1. **增量判据是 blob SHA 不是 mtime**（Decisions 34 三）：`git hash-object` 取该 MD
 *    当前内容指纹，与库内同 `doc_path` 行的 `origin_id` 相同即跳过。绝不用 mtime——
 *    checkout / 切分支会污染 mtime（LlamaIndex issue #21461 反例），而内容根本没变。
 * 2. **嵌入先行，写库在后**（票庚 ⑤）：sidecar 不可用 ⇒ **该件一行不写**。先切片、
 *    再整件嵌入、全绿才落库——顺序反了就会留下「有行没向量」的半截件。
 * 3. **孤儿物理删**（票庚 ⑥ S4）：见下方 `deleteStaleChunkRows` / `deleteChunksByDocPaths`
 *    两处调用点。**中止的轮次绝不删任何行**（`aborted` 时跳过孤儿清理）。
 *
 * ## 运行形态（为什么有 tsx 自举）
 *
 * 本文件是 `.mjs`（scripts 包按 Conventions 用 JS），但它要调的三件东西都是 TS：
 * `segmentDocument`（票丙）/ `EmbeddingClient`（票丁）/ `chunks` 仓储（票己·庚）。
 * 原生 `node` 不能 import `.ts` ⇒ 本文件检测到「不在 tsx 下运行」时，用仓库既有的
 * tsx CLI 入口（同 `scripts/dev.js`、`scripts/seed.js` 的路径约定）把自己重新拉起一次。
 * 于是**所有**调用方只需一条命令：`node scripts/flywheel/scan.mjs`
 * （`package.json` 的 npm script 与 `packages/server/src/index.ts` 的启动 spawn 同款）。
 *
 * ⚠️ TS 依赖一律走**动态 `import()`**：静态 import 会在模块求值期执行——**早于**自举
 * 判定 ⇒ 在原生 node 下照样炸在 import 上，自举形同虚设。
 *
 * ## 输出通道
 *
 * stdout 只出**一行结构化 JSON**（机器通道，可管道解析）；人类可读一行汇总走 **stderr**
 * ——本仓 logger（`packages/server/src/logger.ts`）写 stdout，与 JSON 同流会毁掉机器通道，
 * 故此处刻意不用 logger。
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// ─── 白名单（S1）──────────────────────────────────────

/**
 * 扫描白名单前缀（**导出常量，测试直接断言**——票庚 契约 ①）。
 *
 * 排除面（写死为「不在这里」而非黑名单）：`docs/run/**`（在飞、收口即清）、
 * `docs/research/**`（未结晶）、`docs/sessions/**`（一期不扫，列二期候选）、
 * `AGENTS.md`/`CONTEXT.md`（Decisions 1 明否）。**不枚举黑名单**——不在白名单里
 * 就是不在。
 */
export const SCAN_PREFIXES = ['docs/adr/', 'docs/lessons/', 'docs/plans/']

/** 扩展名白名单（契约 ①） */
export const SCAN_EXTENSION = '.md'

/**
 * `docs/plans/**` 额外门槛（S1）：只收已结晶的两态。
 * `进行中` 是在飞件，收进来会让「索引 = 冻结的结论」这个前提失守。
 */
export const PLAN_STATUS_CRYSTALLIZED = new Set(['已定稿', '已收口'])

/** 跳过原因码（报告 `skipped[].reason`；**「跳过」永不是静默的**——契约 ④） */
export const SKIP_REASONS = {
  NO_FRONTMATTER: 'no-frontmatter',
  MISSING_TYPE: 'missing-type',
  EMPTY_EVIDENCE: 'empty-evidence',
  PLAN_NOT_CRYSTALLIZED: 'plans-not-crystallized',
  UNCHANGED: 'unchanged',
  NO_SEGMENTS: 'no-segments',
}

// ─── frontmatter 解析（受支持子集）────────────────────

/**
 * 解析文件头部 YAML frontmatter 的**受支持子集**。
 *
 * 边界规则与票丙 `stripFrontmatter`（Decisions 33 二）**逐条对齐**，避免同一个文件
 * 在切片侧与扫描侧对「有没有 frontmatter」给出两种答案：
 *   ① 仅当**第 1 行恰为 `---`**（允许空白）才进入判定；② 向下找 `---` 或 `...` 闭合；
 *   ③ **未闭合 ⇒ 判为无 frontmatter**（向严不向宽）——与切片侧「不剥、整份当正文」同判。
 *
 * 支持的 YAML 形状（**够用即止，不引 yaml 库**）：
 *   - `key: value` 标量（可选引号）
 *   - `key:` + 缩进列表，列表项是标量（`- x`）或**单层映射**（`- kind: commit` +
 *     更深缩进的 `ref: xxx` 续行）——即 `evidence` 的真实形态（map Decisions 20）
 *   - 行内流式数组 `[a, b]`（简单标量项）
 *
 * **不支持的形状不会猜**：解析不了的键直接缺席，后续按 §准入 的 fail-closed 规则
 * 处置（例如 `evidence` 认不出 ⇒ 空 ⇒ 该件跳过），而不是塞一个近似值进去。
 *
 * @returns `{ present: boolean, data: Record<string, unknown> }`
 */
export function parseFrontmatter(content) {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  if (lines.length === 0 || lines[0].trim() !== '---') return { present: false, data: {} }

  let close = -1
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t === '---' || t === '...') {
      close = i
      break
    }
  }
  if (close === -1) return { present: false, data: {} } // ③ 未闭合：判为无 frontmatter

  return { present: true, data: parseYamlSubset(lines.slice(1, close)) }
}

/** 标量：去引号、trim；其余原样（日期/中文状态一律当字符串，不做类型推断） */
function parseScalar(raw) {
  const t = raw.trim()
  if (
    t.length >= 2 &&
    ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
  ) {
    return t.slice(1, -1)
  }
  return t
}

/** 行内流式数组 `[a, b]` / `[]` → 标量数组；不是数组形状返回 null */
function parseInlineList(raw) {
  const t = raw.trim()
  if (!t.startsWith('[') || !t.endsWith(']')) return null
  const inner = t.slice(1, -1).trim()
  if (inner === '') return []
  return inner
    .split(',')
    .map((s) => parseScalar(s))
    .filter((s) => s !== '')
}

const KEY_LINE = /^([A-Za-z_][\w-]*):(.*)$/

/** 受支持子集的解析器（见 `parseFrontmatter` 的形态清单） */
function parseYamlSubset(lines) {
  const data = {}
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) {
      i++
      continue
    }
    const m = KEY_LINE.exec(line)
    if (!m) {
      i++ // 认不出的顶层形状：跳过（不猜）
      continue
    }
    const key = m[1]
    const inline = m[2].trim()

    if (inline !== '') {
      const list = parseInlineList(inline)
      data[key] = list === null ? parseScalar(inline) : list
      i++
      continue
    }

    const list = parseListBlock(lines, i + 1)
    if (list.items.length > 0) {
      data[key] = list.items
      i = list.next
      continue
    }
    data[key] = ''
    i++
  }
  return data
}

/**
 * 解析 `key:` 之后的缩进列表块。
 * 结束条件（保守，宁可少吞）：回到顶层键 / 出现非列表行 / 空行后紧跟顶层键。
 */
function parseListBlock(lines, start) {
  const items = []
  let i = start
  while (i < lines.length) {
    const raw = lines[i]
    if (raw.trim() === '') {
      let k = i
      while (k < lines.length && lines[k].trim() === '') k++
      if (k >= lines.length || !/^\s/.test(lines[k])) break
      i = k
      continue
    }
    if (!/^\s/.test(raw)) break // 顶层键 ⇒ 块结束
    const item = /^\s*-\s*(.*)$/.exec(raw)
    if (!item) break // 缩进但不是列表项 ⇒ 块结束（不吞）

    const head = item[1].trim()
    const mapHead = KEY_LINE.exec(head)
    if (mapHead && !head.startsWith('#')) {
      const obj = { [mapHead[1]]: parseScalar(mapHead[2]) }
      i++
      // 续行：同项更深缩进的 `key: value`（遇到下一个 `-` 即止）
      while (i < lines.length) {
        const cont = lines[i]
        if (cont.trim() === '' || /^\s*-\s/.test(cont)) break
        const cm = /^\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(cont)
        if (!cm) break
        obj[cm[1]] = parseScalar(cm[2])
        i++
      }
      items.push(obj)
      continue
    }
    items.push(parseScalar(head))
    i++
  }
  return { items, next: i }
}

// ─── 准入判定（fail-closed · S2/S3）────────────────────

/**
 * 单件准入判定（Decisions 20 fail-closed）。
 *
 * **三种情况一律跳过且**进跳过报告：缺 frontmatter / `type` 缺 / `evidence` 空数组。
 * 「脏件自动挡住」不需要枚举黑名单——`docs/research/research-*.md`、无 frontmatter 的
 * 门牌 `README.md` 都天然命中第一条。
 *
 * @returns `{ ok: true, meta }` 或 `{ ok: false, reason, detail? }`
 */
export function classifyDocument({ path: relPath, content }) {
  const fm = parseFrontmatter(content)
  if (!fm.present) return { ok: false, reason: SKIP_REASONS.NO_FRONTMATTER }

  const type = typeof fm.data.type === 'string' ? fm.data.type.trim() : ''
  if (type === '') return { ok: false, reason: SKIP_REASONS.MISSING_TYPE }

  const evidence = fm.data.evidence
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return { ok: false, reason: SKIP_REASONS.EMPTY_EVIDENCE }
  }

  const status = typeof fm.data.status === 'string' ? fm.data.status.trim() : ''
  if (relPath.startsWith('docs/plans/') && !PLAN_STATUS_CRYSTALLIZED.has(status)) {
    return {
      ok: false,
      reason: SKIP_REASONS.PLAN_NOT_CRYSTALLIZED,
      detail: status === '' ? 'status 缺' : `status=${status}`,
    }
  }

  const str = (k) =>
    typeof fm.data[k] === 'string' && fm.data[k].trim() !== '' ? fm.data[k].trim() : null
  return {
    ok: true,
    meta: {
      type,
      status: status === '' ? null : status,
      date: str('date'),
      evidence,
      supersedes: str('supersedes'),
      supersededBy: str('superseded_by'),
      validFrom: str('valid_from'),
      validTo: str('valid_to'),
    },
  }
}

// ─── 白名单遍历 ───────────────────────────────────────

/** 白名单内全部候选件（仓库相对、正斜杠、**排序后返回 ⇒ 同输入同顺序**） */
export function collectCandidatePaths(root) {
  const out = []
  for (const prefix of SCAN_PREFIXES) {
    walk(path.join(root, prefix), out)
  }
  return out
    .map((abs) => path.relative(root, abs).split(path.sep).join('/'))
    .filter((rel) => SCAN_PREFIXES.some((p) => rel.startsWith(p)))
    .sort()
}

function walk(dir, out) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return // 目录不存在（例如一期还没建 docs/lessons/）：零候选，不是错误
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out)
    else if (e.isFile() && e.name.endsWith(SCAN_EXTENSION)) out.push(full)
  }
}

// ─── 主流程 ───────────────────────────────────────────

/** `body` 的 sha256 hex（**身份键里的内容指纹**——与 `chunks.ts` 的列语义一致） */
export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * 干净的 git 环境：**剔除仓库定位变量**（`GIT_DIR` / `GIT_WORK_TREE` / `GIT_INDEX_FILE` …）。
 *
 * 这些变量由 git 在跑钩子时注入子进程。不剔的话，从钩子里跑本脚本（或跑测试）时，
 * `git -C <目标>` 会被它们**劫持到外层仓库**——判据悄悄换了对象，且**不报错**
 * （实测：pre-commit 跑 `pnpm test` ⇒ `git -C <tmp> commit` 撞外层仓库而失败）。
 */
export function cleanGitEnv() {
  const env = { ...process.env }
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_COMMON_DIR',
    'GIT_PREFIX',
  ]) {
    delete env[key]
  }
  return env
}

/** git blob SHA（`git hash-object`）——增量判据的唯一来源，**不是 mtime** */
export function gitHashObject(root, relPath) {
  return execFileSync('git', ['-C', root, 'hash-object', '--', relPath], {
    encoding: 'utf8',
    env: cleanGitEnv(),
  }).trim()
}

/**
 * 扫描一轮。**依赖全部注入**（测试可给假实现；生产由 `main()` 装配真实件）。
 *
 * @param {object} opts
 * @param {string} opts.root          仓库根（绝对路径）
 * @param {object} opts.repo          `chunks` 仓储（见下方用到的五个函数）
 * @param {Function} opts.segment     票丙 `segmentDocument`
 * @param {object} opts.embed         票丁 `EmbeddingClient`（只用 `embedMany`）
 * @param {Function} opts.hashObject  `(relPath) => blobSha`
 * @param {Function} opts.toBlob      `number[] => Buffer`（`vectorToBlob`）
 * @param {Function} [opts.readFile]  `(relPath) => string`
 * @returns {Promise<object>} 报告 `{scanned, inserted, updated, skipped, orphansDeleted, errors, aborted}`
 */
export async function runScan(opts) {
  const { root, repo, segment, embed, hashObject, toBlob } = opts
  const readFile = opts.readFile ?? ((rel) => readFileSync(path.join(root, rel), 'utf8'))

  const report = {
    scanned: 0,
    inserted: 0,
    updated: 0,
    skipped: [],
    orphansDeleted: 0,
    errors: [],
    aborted: null,
  }

  /** 本轮**产出**的 doc_path（含 `unchanged` 跳过的件——它们照样「属于本次产出」，
      否则孤儿清理会把没变的件误删）。 */
  const produced = new Set()

  for (const rel of collectCandidatePaths(root)) {
    report.scanned++

    let content
    try {
      content = readFile(rel)
    } catch (err) {
      report.errors.push({ path: rel, reason: 'read-failed', detail: msgOf(err) })
      continue
    }

    const cls = classifyDocument({ path: rel, content })
    if (!cls.ok) {
      report.skipped.push(pick({ path: rel, reason: cls.reason, detail: cls.detail }))
      continue
    }
    produced.add(rel)

    let originId
    try {
      originId = hashObject(rel)
    } catch (err) {
      report.errors.push({ path: rel, reason: 'hash-failed', detail: msgOf(err) })
      continue
    }

    // 增量（S2）：blob SHA 相同 ⇒ 跳过。**mtime 不参与任何判定**（S4）。
    if (repo.getChunksByOrigin(originId).some((r) => r.doc_path === rel)) {
      report.skipped.push({ path: rel, reason: SKIP_REASONS.UNCHANGED })
      continue
    }

    const seg = segment({ path: rel, content })
    if (seg.segments.length === 0) {
      report.skipped.push({ path: rel, reason: SKIP_REASONS.NO_SEGMENTS })
      continue
    }

    // 嵌入先行（口径 2）：整件一次性嵌入，任一失败 ⇒ **该件一行不写**
    let results
    try {
      results = await embed.embedMany(seg.segments.map((s) => s.text))
    } catch (err) {
      report.errors.push({ path: rel, reason: 'embed-failed', detail: msgOf(err) })
      continue
    }
    const bad = results.find((r) => !r || r.ok !== true)
    if (bad) {
      // 嵌入整体未启用（MEMORY_ENABLED=false / not-enabled）：不是「这件坏了」，
      // 是「本轮不具备写索引的条件」⇒ **整轮中止**，且不删任何孤儿行。
      if (bad.reason === 'not-enabled') {
        report.aborted = { reason: 'not-enabled', at: rel }
        break
      }
      report.errors.push(
        pick({ path: rel, reason: 'embed-failed', detail: bad.reason, extra: bad.detail })
      )
      continue
    }

    try {
      for (let i = 0; i < seg.segments.length; i++) {
        const s = seg.segments[i]
        const { created } = repo.upsertChunkWithIndexes(
          {
            docPath: rel,
            sectionAnchor: s.sectionAnchor,
            contentHash: sha256Hex(s.body),
            originId,
            ...cls.meta,
            partIndex: s.partIndex,
            partTotal: s.partTotal,
            hardCut: s.hardCut ? 1 : 0,
            body: s.body,
            breadcrumb: s.breadcrumb,
          },
          toBlob(results[i].vector)
        )
        if (created) report.inserted++
        else report.updated++
      }
      // 同路径陈旧代（该件被改动 ⇒ 旧 content_hash 的行不会撞身份键）：
      // 不删则旧正文永久留在库里并被检索召回
      report.orphansDeleted += repo.deleteStaleChunkRows(rel, originId)
    } catch (err) {
      // 写失败 ⇒ **补偿删除**，回到「该件零行」而不是留半截：
      // 半截件会被下一轮的 `unchanged` 判据误判为「已完成」而永久缺片。
      report.errors.push({ path: rel, reason: 'write-failed', detail: msgOf(err) })
      try {
        repo.deleteChunksByDocPaths([rel])
      } catch (cleanupErr) {
        report.errors.push({ path: rel, reason: 'cleanup-failed', detail: msgOf(cleanupErr) })
      }
    }
  }

  // 孤儿物理删（S4）：白名单内、**不属本次产出集合**的 doc_path 三表齐删。
  // 中止的轮次**一行都不删**——本轮没写成可能只是嵌入没开，删了就是真丢数据。
  if (!report.aborted) {
    const orphans = repo
      .listChunkDocPaths()
      .filter((p) => SCAN_PREFIXES.some((prefix) => p.startsWith(prefix)))
      .filter((p) => !produced.has(p))
    report.orphansDeleted += repo.deleteChunksByDocPaths(orphans)
  }

  return report
}

/** 一行人类可读汇总（走 stderr；见文件头「输出通道」） */
export function summaryLine(report) {
  const parts = [
    `scanned=${report.scanned}`,
    `inserted=${report.inserted}`,
    `updated=${report.updated}`,
    `skipped=${report.skipped.length}`,
    `orphansDeleted=${report.orphansDeleted}`,
    `errors=${report.errors.length}`,
  ]
  if (report.aborted) parts.push(`aborted=${report.aborted.reason}`)
  return `[flywheel:scan] ${parts.join(' ')}`
}

function msgOf(err) {
  return err && err.message ? err.message : String(err)
}

/** 组装跳过/错误条目：`detail` 缺省时**不写该键**（报告形态稳定，便于断言） */
function pick({ path: p, reason, detail, extra }) {
  const out = { path: p, reason }
  if (detail) out.detail = extra ? `${detail}: ${extra}` : detail
  return out
}

// ─── CLI ──────────────────────────────────────────────

/** tsx CLI 入口（与 `scripts/dev.js` / `scripts/seed.js` 同一路径约定） */
const TSX_CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'packages',
  'server',
  'node_modules',
  'tsx',
  'dist',
  'cli.mjs'
)

export function parseArgs(argv) {
  const args = { reindex: false, root: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--reindex') args.reindex = true
    else if (a === '--root') args.root = argv[++i] ?? null
    else if (a === '--help' || a === '-h') args.help = true
  }
  return args
}

/**
 * 自举：原生 node 跑 `.mjs` 无法 import `.ts`（票丙/丁/己 的模块全是 TS）。
 * 已在 tsx 下（子进程带哨兵环境变量）则直接干活。
 */
function bootstrap(argv) {
  if (process.env.FLYWHEEL_SCAN_TSX === '1') return false
  if (!existsSync(TSX_CLI)) {
    process.stderr.write(`[flywheel:scan] 找不到 tsx（${TSX_CLI}），请确认已执行 pnpm install\n`)
    process.exit(1)
  }
  const child = spawn(process.execPath, [TSX_CLI, fileURLToPath(import.meta.url), ...argv], {
    stdio: 'inherit',
    env: { ...process.env, FLYWHEEL_SCAN_TSX: '1' },
  })
  child.on('exit', (code) => process.exit(code ?? 1))
  child.on('error', (err) => {
    process.stderr.write(`[flywheel:scan] 拉起 tsx 失败: ${err.message}\n`)
    process.exit(1)
  })
  return true
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(
      '用法: node scripts/flywheel/scan.mjs [--reindex] [--root <仓库根>]\n' +
        '  --reindex  先清空三表再全量重扫（drop → create → scan → embed）\n'
    )
    return 0
  }

  const root = args.root ?? process.cwd()

  // TS 依赖一律动态 import（见文件头「运行形态」）。
  // **env 必须最先加载**（承 AGENTS.md：`import './env.js'` 要排在所有模块初始化之前）——
  // server 的启动 spawn 天然继承已加载的 process.env，而手动 `pnpm flywheel:scan` 是新进程，
  // 不加载就会让「MEMORY_ENABLED 等开关」在两条通道上取到不同的值。
  await import('../../packages/server/src/env.js')

  // ─── 端口隔离（票辰不变量）───────────────────────────────────────────────
  // **不变量**：扫描器拉起的 sidecar 是**短命私有**的，恒用动态端口（`0` = OS 分配）；
  // **固定端口 `EMBED_SIDECAR_PORT` 只属于主 server 的 sidecar**。
  // 不覆盖的后果 = 扫描器的 sidecar 去抢主 server 的端口 ⇒ `EADDRINUSE` ⇒ 握手超时
  // ⇒ 整轮扫描判「嵌入不可用」而一行不写（恰是有新内容、最需要它成的场景）。
  //
  // 位置刚性：**早于 `new EmbeddingClient()`**，且放在 env.js 之后——两条到达本进程的
  // 通道（① server 启动时 spawn 本脚本、② 手动 `pnpm flywheel:scan`）都必经 `main()`，
  // 故**一处覆盖即覆盖两条通道**；父进程（index.ts）替子进程表达其内部需求是知识泄漏，
  // 同一条不变量写两处 = 两个真相源。放 env.js **之后**的语义是「对已解析结果做显式
  // 覆盖」，不依赖 env.js「不覆盖已存在变量」这条实现细节。
  process.env.EMBED_SIDECAR_PORT = '0'

  const { initDb, getDb } = await import('../../packages/server/src/db/index.js')
  const { initRepository, chunks: chunksRepo } =
    await import('../../packages/server/src/db/repository/index.js')
  const { segmentDocument } = await import('../../packages/server/src/memory/flywheel/segment.js')
  const { EmbeddingClient } = await import('../../packages/server/src/memory/embedding-client.js')
  const { vectorToBlob } = await import('../../packages/server/src/memory/index.js')

  initDb()
  initRepository(getDb())

  if (args.reindex) {
    const cleared = chunksRepo.deleteChunksByDocPaths(chunksRepo.listChunkDocPaths())
    process.stderr.write(`[flywheel:scan] --reindex 清空索引行 ${cleared}\n`)
  }

  const client = new EmbeddingClient()
  try {
    const report = await runScan({
      root,
      repo: chunksRepo,
      segment: segmentDocument,
      embed: client,
      hashObject: (rel) => gitHashObject(root, rel),
      toBlob: vectorToBlob,
    })
    process.stdout.write(JSON.stringify(report) + '\n')
    process.stderr.write(summaryLine(report) + '\n')
    // 退出码 = 「有没有件该写而没写成」。`not-enabled` **不算失败**——那是「功能没开」，
    // 不是「功能坏了」（票丁契约 ① 的同一条分界）；否则嵌入关着时每次启动都刷一条 warn。
    return report.errors.length > 0 ? 1 : 0
  } finally {
    client.stop()
  }
}

// 直接执行（非被 import）时才自举 + 跑 main —— 单测 import 本模块不得触发副作用
const isEntry =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isEntry && !bootstrap(process.argv.slice(2))) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`[flywheel:scan] 未捕获异常: ${msgOf(err)}\n`)
      process.exit(1)
    })
}
