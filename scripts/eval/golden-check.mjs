/**
 * 检索黄金集校验器（R9 §五，D3 的**保鲜机制**）。
 *
 * ## 它回答的唯一问题
 *
 * 「黄金集里每一条 `expect` / `forbid` 锚点，**今天**还能不能解析到语料里的一块活片？」
 * 解不出 ⇒ 语料变了、该条目须重标 ⇒ 报「标尺腐烂」清单并非零退出。**它不判条目对不对**
 * （那是人的事），只判条目**指的东西还在不在**。
 *
 * ## 口径与扫描器严格同源（票面 §五「不自造第二套切片逻辑」）
 *
 * 「活块」的判据**逐条复用**扫描器链路，不新造：
 *   ① 文件在 `collectCandidatePaths`（= `SCAN_PREFIXES` 白名单）内；
 *   ② 该文件过 `classifyDocument` 准入（frontmatter / type / evidence / plans 结晶态）
 *      ——**这一条不可省**：白名单内但准入不过的文件一行索引都不会写，
 *      它的锚点永远不可能被检索命中，挂上去就是必然假红；
 *   ③ `segmentDocument` 切出的 `sectionAnchor` 集合里含该锚点。
 *
 * 三者都通过才算「活块」。②③ 合起来就是「扫描器会写出这一片」。
 *
 * ## 为什么锚点粒度是 `doc_path + section_anchor`
 *
 * 与 `retrieval_candidates` 的埋点列同粒度（D1）。**刻意不带 `content_hash`**——
 * 片级哈希随语料每次改写都变，埋点表自己也不用它（`retrievalEvents.ts` 的
 * `contentHash` 列注释：身份三元组不用 `chunks.id`，同款理由）。黄金集要的是
 * 「答案在哪一节」，节内文字怎么改，标尺不该跟着抖。
 *
 * ## 输出通道
 *
 * 与 `scripts/flywheel/scan.mjs` 同款：stdout 只出**一行结构化 JSON**（机器通道），
 * 人类可读汇总走 stderr——本仓 logger 写 stdout，混流会毁掉机器通道。
 *
 * ## 退出码
 *
 * `0` 全绿 / `1` 有腐烂 / `2` 用法或读盘错误（**与「腐烂」分开**：读不到文件
 * 不是标尺的问题，混成同一个码会让 CI 分不清该改语料还是改路径）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// ─── 契约常量（测试直接断言） ─────────────────────────

/** 黄金集 schema 版本（`version` 字段的唯一合法值） */
export const GOLDEN_SCHEMA_VERSION = 1

/** 条目三型（票面 §四 `kind` 值域） */
export const GOLDEN_KINDS = ['real', 'constructed', 'negative']

/** 锚点身份三元组里进契约的两维（第三维 `content_hash` 刻意不进，见文件头） */
export const ANCHOR_FIELDS = ['doc_path', 'section_anchor']

/**
 * 读取黄金集时**必须存在**的顶层键。
 * `meta` 是加性扩展（记冻结语料的快照读数），**不在必需集内**——老文件缺它照样能校验。
 */
export const REQUIRED_TOP_KEYS = ['version', 'entries']

// ─── schema 校验（纯函数） ────────────────────────────

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== ''

/**
 * 单条锚点形状：恰好 `doc_path` + `section_anchor` 两个非空字符串。
 * 多带的键**不报错也不消费**（向前兼容）。
 */
function anchorError(anchor, where) {
  if (anchor === null || typeof anchor !== 'object' || Array.isArray(anchor)) {
    return `${where} 必须是对象`
  }
  for (const f of ANCHOR_FIELDS) {
    if (!isNonEmptyString(anchor[f])) return `${where}.${f} 必须是非空字符串`
  }
  return null
}

/**
 * 黄金集 schema 校验（**纯函数，不碰文件系统**——测试直接喂对象）。
 *
 * 校验面（票面 §五「schema 校验」条 + §四字段集）：
 *   - 顶层 `version` = 1、`entries` 是数组
 *   - 每条：`id` 非空且**全局唯一**、`kind` ∈ 三型、`query` 非空、
 *     `rewritten` 是字符串数组（**可为空**——空的三种成因与人工确认位见 `freeze-rewrite.mjs` 文件头）、
 *     `expect` / `forbid` 是锚点数组且形状对、`answerability` 非空（可答性闸留痕）
 *   - `negative` 条目 `forbid` **必填非空**（票面 §四 明文）
 *   - `real` 条目 `evidence.retrieval_query_id`（数字）+ `evidence.rationale`（非空）
 *     ——「真实条目带六标准理由与行 id 证据」（G1）
 *   - `expect` 为空只允许出现在 `negative`（其余两型必须有应命中节）
 *
 * @returns `{ ok: boolean, errors: string[] }`（errors 全量返回，不短路——
 *          一次修完比挤牙膏强）
 */
export function validateGoldenSet(data) {
  const errors = []

  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, errors: ['顶层必须是对象'] }
  }
  for (const k of REQUIRED_TOP_KEYS) {
    if (!(k in data)) errors.push(`顶层缺字段 \`${k}\``)
  }
  if (data.version !== GOLDEN_SCHEMA_VERSION) {
    errors.push(`version 必须是 ${GOLDEN_SCHEMA_VERSION}，实为 ${JSON.stringify(data.version)}`)
  }
  if (!Array.isArray(data.entries)) {
    errors.push('entries 必须是数组')
    return { ok: false, errors }
  }

  const seenIds = new Set()
  /** @type {Record<string, number>} 按 kind 计数，供调用方报读数 */
  const byKind = {}

  data.entries.forEach((entry, i) => {
    const at = `entries[${i}]`
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${at} 必须是对象`)
      return
    }
    const id = isNonEmptyString(entry.id) ? entry.id : null
    if (id === null) errors.push(`${at}.id 必须是非空字符串`)
    else if (seenIds.has(id)) errors.push(`${at}.id 重复：${id}`)
    else seenIds.add(id)

    const where = id === null ? at : `${at}(${id})`
    const kind = entry.kind
    if (!GOLDEN_KINDS.includes(kind)) {
      errors.push(`${where}.kind 必须是 ${GOLDEN_KINDS.join(' | ')}，实为 ${JSON.stringify(kind)}`)
    } else {
      byKind[kind] = (byKind[kind] ?? 0) + 1
    }

    if (!isNonEmptyString(entry.query)) errors.push(`${where}.query 必须是非空字符串`)

    if (!Array.isArray(entry.rewritten)) {
      errors.push(`${where}.rewritten 必须是数组（可为空数组 = 无冻下来的改写）`)
    } else {
      entry.rewritten.forEach((r, j) => {
        if (!isNonEmptyString(r)) errors.push(`${where}.rewritten[${j}] 必须是非空字符串`)
      })
    }

    for (const field of ['expect', 'forbid']) {
      const list = entry[field]
      if (!Array.isArray(list)) {
        errors.push(`${where}.${field} 必须是数组`)
        continue
      }
      list.forEach((a, j) => {
        const err = anchorError(a, `${where}.${field}[${j}]`)
        if (err) errors.push(err)
      })
    }

    if (Array.isArray(entry.expect) && entry.expect.length === 0 && kind !== 'negative') {
      errors.push(`${where}.expect 不得为空（只有 negative 允许无应命中节）`)
    }
    if (kind === 'negative' && Array.isArray(entry.forbid) && entry.forbid.length === 0) {
      errors.push(`${where}.forbid 不得为空（negative 条目的定义就是「禁止命中」）`)
    }

    if (!isNonEmptyString(entry.answerability)) {
      errors.push(`${where}.answerability 必须是非空字符串（可答性闸留痕）`)
    }

    const ev = entry.evidence
    if (kind === 'real') {
      if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) {
        errors.push(`${where}.evidence 是 real 条目必填`)
      } else {
        if (typeof ev.retrieval_query_id !== 'number' || !Number.isFinite(ev.retrieval_query_id)) {
          errors.push(`${where}.evidence.retrieval_query_id 必须是有限数字`)
        }
        if (!isNonEmptyString(ev.rationale)) {
          errors.push(`${where}.evidence.rationale 必须是非空字符串（六标准选用理由）`)
        }
      }
    } else if (ev !== undefined && ev !== null) {
      if (typeof ev !== 'object' || Array.isArray(ev)) {
        errors.push(`${where}.evidence 若存在必须是对象`)
      } else if (!isNonEmptyString(ev.rationale)) {
        errors.push(`${where}.evidence.rationale 若存在必须是非空字符串`)
      }
    }
  })

  return { ok: errors.length === 0, errors, byKind }
}

// ─── 活块索引（真切片器） ──────────────────────────────

/**
 * 用**生产切片链路**建「活块」索引：`doc_path` → 该文件当前切出的 `sectionAnchor` 集合。
 *
 * @param {object} opts
 * @param {string} opts.root     仓库根（绝对路径）
 * @param {object} opts.scanMod  `scripts/flywheel/scan.mjs`（要 `collectCandidatePaths` / `classifyDocument`）
 * @param {Function} opts.segment `segmentDocument`
 * @param {Function} [opts.readFile] `(relPath) => string`
 * @returns `{ anchors: Map<string, Set<string>>, skipped: Array<{path,reason}> }`
 *          `skipped` = 白名单内**过不了准入**的文件（它们不是活块，但要让调用方
 *          能把「锚点指着一个准入不过的文件」与「锚点拼错」分开）
 */
export function buildLiveAnchorIndex({ root, scanMod, segment, readFile }) {
  const read = readFile ?? ((rel) => readFileSync(path.join(root, rel), 'utf8'))
  const anchors = new Map()
  const skipped = []

  for (const rel of scanMod.collectCandidatePaths(root)) {
    let content
    try {
      content = read(rel)
    } catch (err) {
      skipped.push({ path: rel, reason: 'read-failed', detail: msgOf(err) })
      continue
    }
    const cls = scanMod.classifyDocument({ path: rel, content })
    if (!cls.ok) {
      skipped.push({ path: rel, reason: cls.reason, detail: cls.detail })
      continue
    }
    const set = new Set()
    for (const s of segment({ path: rel, content }).segments) set.add(s.sectionAnchor)
    anchors.set(rel, set)
  }

  return { anchors, skipped }
}

/**
 * 逐条核锚点（**纯函数**：索引由调用方给，测试可喂假索引）。
 *
 * 两种腐烂原因分开报——**药方不同**：
 *   - `doc-not-live`：该 `doc_path` 今天不是活件（不在白名单 / 过不了准入 / 文件没了）
 *     ⇒ 要么语料被移出白名单，要么条目本来就挂错了对象；
 *   - `anchor-not-found`：文件活着但**切不出这个锚**（章节改名/合并/删除）⇒ 重标该条。
 *
 * @returns `{ rotten: Array<{id,kind,field,doc_path,section_anchor,reason}>, checked: number }`
 */
export function checkGoldenSet({ data, index }) {
  const rotten = []
  let checked = 0

  for (const entry of data.entries) {
    for (const field of ['expect', 'forbid']) {
      const list = Array.isArray(entry[field]) ? entry[field] : []
      for (const a of list) {
        checked++
        const live = index.anchors.get(a.doc_path)
        let reason = null
        if (!live) reason = 'doc-not-live'
        else if (!live.has(a.section_anchor)) reason = 'anchor-not-found'
        if (reason) {
          rotten.push({
            id: entry.id,
            kind: entry.kind,
            field,
            doc_path: a.doc_path,
            section_anchor: a.section_anchor,
            reason,
          })
        }
      }
    }
  }

  return { rotten, checked }
}

/** 一行人类可读汇总（走 stderr；见文件头「输出通道」） */
export function summaryLine({ entries, byKind, checked, rotten }) {
  const kinds = GOLDEN_KINDS.map((k) => `${k}=${byKind[k] ?? 0}`).join(' ')
  return (
    `[eval:golden:check] entries=${entries} (${kinds}) anchors=${checked} ` +
    `rotten=${rotten.length}${rotten.length > 0 ? ' ⇒ 标尺腐烂' : ''}`
  )
}

// ─── CLI ──────────────────────────────────────────────

/** tsx CLI 入口（与 `scripts/flywheel/scan.mjs` / `scripts/dev.js` 同一路径约定） */
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

/** 仓库根 = 本文件往上三层（`scripts/eval/`）；**不从 cwd 派生**——见 `main` 注释 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export function parseArgs(argv) {
  const args = { file: null, root: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--file') args.file = argv[++i] ?? null
    else if (a === '--root') args.root = argv[++i] ?? null
    else if (a === '--help' || a === '-h') args.help = true
  }
  return args
}

function msgOf(err) {
  return err && err.message ? err.message : String(err)
}

/**
 * 自举：原生 node 跑 `.mjs` 无法 import `.ts`（切片器是 TS）。
 * 已在 tsx 下（子进程带哨兵环境变量）则直接干活。
 */
function bootstrap(argv) {
  if (process.env.GOLDEN_CHECK_TSX === '1') return false
  if (!existsSync(TSX_CLI)) {
    process.stderr.write(
      `[eval:golden:check] 找不到 tsx（${TSX_CLI}），请确认已执行 pnpm install\n`
    )
    process.exit(2)
  }
  const child = spawn(process.execPath, [TSX_CLI, fileURLToPath(import.meta.url), ...argv], {
    stdio: 'inherit',
    env: { ...process.env, GOLDEN_CHECK_TSX: '1' },
  })
  child.on('exit', (code) => process.exit(code ?? 2))
  child.on('error', (err) => {
    process.stderr.write(`[eval:golden:check] 拉起 tsx 失败: ${msgOf(err)}\n`)
    process.exit(2)
  })
  return true
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(
      '用法: node scripts/eval/golden-check.mjs [--file <黄金集 json>] [--root <仓库根>]\n' +
        '  校验 schema + 锚点存在性；任一失败退出码 1。\n'
    )
    return 0
  }

  // root 缺省从**脚本位置**派生而非 cwd：本脚本是 R10 跑批的前置闸，可能被
  // 从任意 cwd 拉起（server、CI、别的 worktree）——cwd 派生会让「校验哪份语料」
  // 随调用方静默变化，而锚点存在性恰恰是**对语料**的断言。
  const root = args.root ?? REPO_ROOT
  const file = args.file ?? path.join(root, 'docs', 'eval', 'retrieval-golden.json')

  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    process.stderr.write(`[eval:golden:check] 读不到黄金集 ${file}: ${msgOf(err)}\n`)
    return 2
  }

  let data
  try {
    data = JSON.parse(raw)
  } catch (err) {
    process.stderr.write(`[eval:golden:check] 黄金集不是合法 JSON: ${msgOf(err)}\n`)
    return 2
  }

  const schema = validateGoldenSet(data)
  if (!schema.ok) {
    process.stdout.write(
      JSON.stringify({ ok: false, phase: 'schema', errors: schema.errors }) + '\n'
    )
    process.stderr.write(`[eval:golden:check] schema 校验失败（${schema.errors.length} 条）\n`)
    for (const e of schema.errors) process.stderr.write(`  - ${e}\n`)
    return 1
  }

  // TS 依赖走动态 import（静态 import 会在自举判定之前求值，见 scan.mjs 同款注释）
  const { pathToFileURL } = await import('node:url')
  const scanMod = await import(pathToFileURL(path.join(root, 'scripts/flywheel/scan.mjs')).href)
  const { segmentDocument } = await import(
    pathToFileURL(path.join(root, 'packages/server/src/memory/flywheel/segment.ts')).href
  )

  const index = buildLiveAnchorIndex({ root, scanMod, segment: segmentDocument })
  const { rotten, checked } = checkGoldenSet({ data, index })

  const report = {
    ok: rotten.length === 0,
    phase: 'anchors',
    file,
    root,
    entries: data.entries.length,
    byKind: schema.byKind,
    checked,
    liveDocs: index.anchors.size,
    skippedDocs: index.skipped,
    rotten,
  }
  process.stdout.write(JSON.stringify(report) + '\n')
  process.stderr.write(
    summaryLine({ entries: data.entries.length, byKind: schema.byKind, checked, rotten }) + '\n'
  )
  for (const r of rotten) {
    process.stderr.write(
      `  - [${r.id}/${r.kind}] ${r.field} ${r.doc_path} :: ${r.section_anchor} (${r.reason})\n`
    )
  }
  return report.ok ? 0 : 1
}

// 直接执行（非被 import）时才自举 + 跑 main —— 单测 import 本模块不得触发副作用
const isEntry =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isEntry && !bootstrap(process.argv.slice(2))) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`[eval:golden:check] 未捕获异常: ${msgOf(err)}\n`)
      process.exit(2)
    })
}
