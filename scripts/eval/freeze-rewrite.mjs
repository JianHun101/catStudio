/**
 * 冻结改写器（R9 §六，D2 的**确定性保证**）。
 *
 * ## 它存在的唯一理由
 *
 * 跑批要能复跑出同一个数。而检索链路上唯一不确定的一环是**查询改写**（LLM 调用）。
 * 于是建集时把改写**冻下来**写进黄金集，跑批跳过改写 ⇒ 整条链退化成纯确定函数。
 *
 * ## 一条不可绕的纪律：改写文本只能从这里产出
 *
 * `rewritten` 必须由**真实改写路径** `rewriteRetrievalQueries`（`memory/query-rewrite.ts`）
 * 产出。**手写改写文本 = 把「冻结」偷换成「出题人想象」**——那冻的就不是系统的行为，
 * 而是出题人对系统行为的猜测，D2 的确定性保证当场失效，且失效是**静默**的
 * （冻结文本看起来一样规整）。
 *
 * 同款：改写落空时**不拿原 query 冒充改写文本**。原样塞入会让这一条的召回表现
 * 看起来「改写没帮上忙」，而事实是「改写这一步没跑成 / 没必要」——把机制状态
 * 记成算法特性。
 *
 * ## `rewritten: []` 的语义（**实测钉死，勿按直觉改**）
 *
 * 空数组 = **该条没有冻下来的改写**。它有三种成因，在 `rewriteRetrievalQueries`
 * 的**返回面上不可分辨**：
 *
 *   a. **改写器判定原话已足够好**——它逐行产出后有一道 `!== original` 过滤
 *      （`query-rewrite.ts` 的 `.filter((q) => q !== original)`），模型把原话
 *      原样吐回时该行被滤掉，于是结果是 `[]`。**这是正常结果，不是故障。**
 *   b. 模型没吐出可用行（空串 / 全超 200 字 / 全被引号剥离后为空）。
 *   c. 调用抛错——被 `catch` 吞成 `[]`，只在日志里留一条 warn。
 *
 * **本脚本不猜是哪一种**。它做两件事：① 空结果**重试一次**（滤掉偶发抖动）；
 * ② 仍空则记入报告的 `empty` 清单并点名，**退出码非零**——把判定权交回人。
 *
 * ### 实证：G02 是 (a)，不是 (c)
 *
 * 依据两条独立读数（2026-09-18 建集时实测）：① `LOG_FILE` 收到该次调用的
 * `completion usage`：`promptTokens=130, completionTokens=10` ⇒ **模型确实产出了
 * 文本**，不是空响应；② 同一轮 40 条 + 探针共 44 次调用，日志里 `查询改写失败`
 * **零命中** ⇒ 没有一条走的是 catch。(b)(c) 都被排除，只剩「产出的行被 `!== original`
 * 滤掉」这一条路。
 *
 * ### 为什么空着也是**可用**的冻结形态
 *
 * 跑批把 `rewritten: []` 读成「这条只有原话这一路查询」——这正是生产系统在
 * 改写不可用时的**降级行为**（`query-rewrite.ts` 文件头：「降级路径 … 返回 []，
 * 调用方退化为仅原话检索」）。所以空数组不失真，它冻的是一个真实可达的系统状态。
 *
 * ### 人工确认位 `meta.emptiesAcknowledged`
 *
 * 空清单非空 ⇒ 退出码 1（**不许静默过去**）。人核完判「是 (a)，可入集」后，
 * 把该条 id 写进黄金集顶层 `meta.emptiesAcknowledged` 数组；脚本据此把退出码
 * 收回 0。**脚本自己永不写这个键**——判定权与实施权分开。
 *
 * ## 三档语义（**缺省落安全侧**，R11）
 *
 * | 档 | 触发 | 调 LLM | 写盘 |
 * | --- | --- | --- | --- |
 * | `dry`（缺省） | 裸跑 | 否 | 否 |
 * | `check` | `--check` | 是 | 否 |
 * | `write` | `--write` | 是 | 是 |
 *
 * `--check` 与 `--write` 互斥（exit 2）——前者验「冻结可复现」，后者改冻结。
 *
 * pnpm 入口 `eval:golden:freeze`（`package.json`）**保持裸形**：它与裸跑同语义（只读体检），
 * 不给「同一条命令、两个入口、两套缺省」留缝。真改写写全为
 * `pnpm eval:golden:freeze --write`（pnpm 把脚本名之后的参数原样透传，实测
 * `--check --write` 双双到达 CLI 并落 exit 2）。别名若改带 `--write`，被误触的就不止
 * 裸脚本，而是这个看起来最无害的入口——与「缺省落破坏性一侧」是同一个错。
 *
 * ### 为什么缺省是只读的（事故实证，非理论风险）
 *
 * 首版缺省 = **真调 LLM 改写全部条目并 `writeFileSync` 覆写黄金集**。2026-09-18 R9
 * 审查窗口，审查者为验前置闸 fail-loud，在一棵**有真 DS_KEY 的审查 worktree** 里裸跑
 * 本脚本，30 秒内踩中——40 次真实 LLM 调用 + 覆写被审文件（已还原零残留）。
 *
 * 根因不是「审查态保护」缺失：脚本无法可靠自判跑在谁的树里（判据脆弱，且审查者本就
 * 在正常 checkout 里跑）。根因是**缺省落在破坏性一侧**——一个只想「看一眼」的动作，
 * 代价是打 40 次 LLM 并改写被审文件。故缺省收敛为只读体检，破坏性动作必须显式 opt-in。
 *
 * ### `dry` 为什么不报「两跑差集」
 *
 * 差集 = 重跑一遍再比对，**必然要打 LLM**——与「零 LLM」互斥（票面 §修法 那句
 * 「只打印差集」按 F1 落地为静态体检）。`dry` 报的是**当前冻结状态**：条目数、
 * 已冻结数、空改写清单、其中未经人确认的部分。要真差集走 `--check`。
 *
 * ## 前置闸（fail-loud，不静默降级）
 *
 * 跑之前先证两件事：`MEMORY_QUERY_REWRITE_ENABLED` 不为 `'0'`、`DS_KEY` 非空。
 * 不证的话，整轮 40 条会全部落空数组，看起来像「改写器什么也产不出」——
 * 而那其实是「这一步压根没通电」。
 *
 * **只对 `--check` / `--write` 是硬闸**（这两档真要打 LLM，不通即 exit 2）。
 * `dry` 档**只报告不拦**：它压根不改写，拦了反而会把 worktree 里的「零成本体检」
 * 变成 exit 2，逼人去配一个本档用不上的 key。
 *
 * ## 环境变量从哪来
 *
 * `packages/server/src/env.ts` 只读**仓库根**的 `.env`。会话 worktree 里 `.env`
 * 是 gitignore 的未跟踪件 ⇒ **worktree 内根本没有**，于是「在 worktree 里跑冻结」
 * 会直接撞上前置闸（DS_KEY 缺失）。故本脚本支持 `--env <file>`：
 * 用与 `env.ts` **同一条语义**（`KEY=VALUE` / 跳过注释空行 / 去包裹引号 /
 * **不覆盖已存在的变量**）补载一份外部 `.env`。
 * 不复用 `env.ts` 的原因：它的路径是模块常量（`resolve(__dirname,'..','..','..')/.env`），
 * 没有注入点；为一个 CLI 参数去改 server 源码属于越界（票面 §禁入）。
 *
 * ## 输出通道
 *
 * 与 `scan.mjs` / `golden-check.mjs` 同款：stdout 一行结构化 JSON，stderr 人类可读。
 *
 * ## 退出码
 *
 * `0` 空清单已全部确认 / `1` 有未确认的空改写（含 `--check` 差集非空）/
 * `2` 用法（含 `--check`+`--write` 同给）、读盘、前置闸失败。
 * `dry` 档同样按 `unacked` 判——它回答的是「黄金集当前状态是否需要人处理」，
 * 与写不写盘无关。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/** 冻结改写的唯一合法来源（写进运行报告，供复核比对） */
export const FREEZE_SOURCE = 'memory/query-rewrite.ts :: rewriteRetrievalQueries'

/** 空结果的默认重试次数（含首次；2 = 首次 + 一次重试） */
export const DEFAULT_ATTEMPTS = 2

/** 人工确认位（顶层 `meta` 下的键名，见文件头） */
export const ACK_KEY = 'emptiesAcknowledged'

// ─── .env 补载（语义对齐 env.ts，见文件头） ────────────

/**
 * 载入一份 `.env`，**已存在的键不覆盖**（命令行/父进程已给的永远优先——
 * 与 `env.ts` 同一条规则，否则 `DS_KEY=x node ...` 会被文件静默顶掉）。
 *
 * @returns `{ loaded: number, keys: string[] }`
 */
export function loadEnvFile(file) {
  const content = readFileSync(file, 'utf8')
  const keys = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    let value = trimmed.slice(eqIdx + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (key && !(key in process.env)) {
      process.env[key] = value
      keys.push(key)
    }
  }
  return { loaded: keys.length, keys }
}

// ─── 纯函数（测试面） ─────────────────────────────────

/**
 * 前置闸：改写能力是否真的通电（**只报告不抛**，由调用方决定退出码）。
 * @returns `{ ok: true }` 或 `{ ok: false, reason: string }`
 */
export function checkRewritePreconditions() {
  if (process.env.MEMORY_QUERY_REWRITE_ENABLED === '0') {
    return { ok: false, reason: 'MEMORY_QUERY_REWRITE_ENABLED=0（改写被显式关掉）' }
  }
  if (!process.env.DS_KEY) {
    return { ok: false, reason: 'DS_KEY 未配置（worktree 内无 .env 时用 --env 指向主仓库 .env）' }
  }
  return { ok: true }
}

/**
 * 逐条冻结：`rewrite(entry.query)` → `entry.rewritten`。
 *
 * **不改入参对象**（返回新数组），副作用只有 `rewrite` 本身——测试可喂假改写器。
 * 空结果重试到 `attempts` 次为止（见文件头：空有正常成因，重试只为滤抖动）。
 *
 * @param {object} opts
 * @param {Array} opts.entries 黄金集条目
 * @param {Function} opts.rewrite `(query) => Promise<string[]>`
 * @param {Function} [opts.onProgress] `(done, total, id) => void`
 * @param {string[]} [opts.only] 只跑这些 id（缺省全跑）
 * @param {number} [opts.attempts] 见 `DEFAULT_ATTEMPTS`
 * @returns `{ entries, empty, reused }`
 *   `empty` = 走到重试上限仍为空 ⇒ 待人工判定（**不落原 query**）；
 *   `reused` = `--only` 之外原样保留的条目 id。
 */
export async function freezeRewrites({
  entries,
  rewrite,
  onProgress,
  only,
  attempts = DEFAULT_ATTEMPTS,
}) {
  const onlySet = only && only.length > 0 ? new Set(only) : null
  const out = []
  const empty = []
  const reused = []
  let done = 0
  const total = onlySet ? entries.filter((e) => onlySet.has(e.id)).length : entries.length

  for (const entry of entries) {
    if (onlySet && !onlySet.has(entry.id)) {
      reused.push(entry.id)
      out.push(entry)
      continue
    }
    let rewritten = []
    for (let i = 0; i < Math.max(1, attempts); i++) {
      const fresh = await rewrite(entry.query)
      // 纯空白也算空：它作为查询文本与空串等价，放进去只会让「有改写」变成假话
      rewritten = Array.isArray(fresh)
        ? fresh.filter((s) => typeof s === 'string' && s.trim() !== '')
        : []
      if (rewritten.length > 0) break
    }
    if (rewritten.length === 0) empty.push(entry.id)
    out.push({ ...entry, rewritten })
    done++
    if (onProgress) onProgress(done, total, entry.id)
  }

  return { entries: out, empty, reused }
}

/**
 * 两跑差集（G3：可复跑 ⇒ 差集为空；LLM 波动则**如实报差集**，不掩盖）。
 *
 * @returns `{ changed: [{id, before, after}], empty: string[] }`
 *   `empty` = 本次跑空的条目（含从未冻结过的）
 */
export function diffRewrites({ before, after }) {
  const beforeById = new Map(before.map((e) => [e.id, e]))
  const changed = []
  const empty = []

  for (const e of after) {
    if (e.rewritten.length === 0) {
      empty.push(e.id)
      continue
    }
    const prev = beforeById.get(e.id)
    const prevList = prev && Array.isArray(prev.rewritten) ? prev.rewritten : []
    if (prevList.length !== e.rewritten.length || prevList.some((v, i) => v !== e.rewritten[i])) {
      changed.push({ id: e.id, before: prevList, after: e.rewritten })
    }
  }

  return { changed, empty }
}

/**
 * 空清单里**尚未被人确认**的部分（见文件头「人工确认位」）。
 * @param {string[]} empty 本次跑出的空条目 id
 * @param {unknown} acked 黄金集顶层 `meta.emptiesAcknowledged`
 */
export function unackedEmpties(empty, acked) {
  const ack = new Set(Array.isArray(acked) ? acked.filter((s) => typeof s === 'string') : [])
  return empty.filter((id) => !ack.has(id))
}

/**
 * `dry` 档的只读体检（见文件头「三档语义」）。
 *
 * **不接 `rewrite` 参数**——这不是省略，是结构性保证：本函数在签名上就够不着改写器，
 * 于是「零 LLM 调用」不靠纪律维持，靠签名面维持。
 *
 * @param {object} opts
 * @param {Array} opts.entries 黄金集条目
 * @param {string[]} [opts.only] 只跑这些 id（缺省全跑）
 * @param {unknown} [opts.acked] 黄金集顶层 `meta.emptiesAcknowledged`
 * @returns `{ total, frozen, empty, unacked, wouldRewrite }`
 *   `wouldRewrite` = 若改走 `--write` 会重跑的条目数（`--only` 过滤后）
 */
export function inspectFrozen({ entries, only, acked }) {
  const onlySet = only && only.length > 0 ? new Set(only) : null
  const empty = []
  let frozen = 0
  let wouldRewrite = 0

  for (const entry of entries) {
    const list = Array.isArray(entry.rewritten) ? entry.rewritten : []
    if (list.length > 0) frozen++
    else empty.push(entry.id)
    if (!onlySet || onlySet.has(entry.id)) wouldRewrite++
  }

  return {
    total: entries.length,
    frozen,
    empty,
    unacked: unackedEmpties(empty, acked),
    wouldRewrite,
  }
}

/**
 * 档位判定（见文件头「三档语义」）。
 * @returns `'dry' | 'check' | 'write'`；`--check` 与 `--write` 同给 ⇒ `null`（用法错，调用方判）
 */
export function resolveMode({ check, write }) {
  if (check && write) return null
  if (write) return 'write'
  if (check) return 'check'
  return 'dry'
}

/** 一行人类可读汇总（走 stderr） */
export function summaryLine({ total, frozen, empty, unacked, changed, mode }) {
  const parts = [`[eval:golden:freeze] mode=${mode}`, `entries=${total}`, `frozen=${frozen}`]
  if (empty && empty.length > 0) parts.push(`empty=${empty.length}`)
  if (unacked) parts.push(`unacked=${unacked.length}`)
  if (changed) parts.push(`changed=${changed.length}`)
  return parts.join(' ')
}

// ─── CLI ──────────────────────────────────────────────

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

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export function parseArgs(argv) {
  const args = {
    file: null,
    root: null,
    env: null,
    check: false,
    write: false,
    only: null,
    attempts: null,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--file') args.file = argv[++i] ?? null
    else if (a === '--root') args.root = argv[++i] ?? null
    else if (a === '--env') args.env = argv[++i] ?? null
    else if (a === '--only')
      args.only = (argv[++i] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    else if (a === '--attempts') args.attempts = parseInt(argv[++i] ?? '', 10)
    else if (a === '--check') args.check = true
    else if (a === '--write') args.write = true
    else if (a === '--help' || a === '-h') args.help = true
  }
  return args
}

function msgOf(err) {
  return err && err.message ? err.message : String(err)
}

/** 自举：原生 node 跑 `.mjs` 无法 import `.ts`（改写器是 TS） */
function bootstrap(argv) {
  if (process.env.GOLDEN_FREEZE_TSX === '1') return false
  if (!existsSync(TSX_CLI)) {
    process.stderr.write(
      `[eval:golden:freeze] 找不到 tsx（${TSX_CLI}），请确认已执行 pnpm install\n`
    )
    process.exit(2)
  }
  const child = spawn(process.execPath, [TSX_CLI, fileURLToPath(import.meta.url), ...argv], {
    stdio: 'inherit',
    env: { ...process.env, GOLDEN_FREEZE_TSX: '1' },
  })
  child.on('exit', (code) => process.exit(code ?? 2))
  child.on('error', (err) => {
    process.stderr.write(`[eval:golden:freeze] 拉起 tsx 失败: ${msgOf(err)}\n`)
    process.exit(2)
  })
  return true
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(
      '用法: node scripts/eval/freeze-rewrite.mjs [--file <json>] [--root <仓库根>]\n' +
        '       [--env <外部 .env>] [--only G01,G02] [--attempts N] [--check | --write]\n' +
        '  缺省 = 只读体检（**零 LLM、零写盘**）：报条目数 / 已冻结数 / 空改写与未确认清单。\n' +
        '  --write = 调用真实改写器并写回 rewritten（真改写，会打 LLM；缺省不是它）。\n' +
        '  --check = 只重跑比对差集、不写盘（会打 LLM，用于验证冻结可复现）。\n' +
        '  --check 与 --write 互斥。\n'
    )
    return 0
  }

  const mode = resolveMode(args)
  if (!mode) {
    process.stderr.write(
      '[eval:golden:freeze] --check 与 --write 互斥：前者只比对不写盘，后者真改写并写回。' +
        '（都不给 = 只读体检，安全）\n'
    )
    return 2
  }

  const root = args.root ?? REPO_ROOT
  const file = args.file ?? path.join(root, 'docs', 'eval', 'retrieval-golden.json')
  const attempts = Number.isFinite(args.attempts) ? args.attempts : DEFAULT_ATTEMPTS

  // env.ts 只认仓库根 .env；先让它跑一遍（worktree 内通常是空的），再用 --env 补载。
  const { pathToFileURL } = await import('node:url')
  await import(pathToFileURL(path.join(root, 'packages/server/src/env.js')).href)
  if (args.env) {
    try {
      const { loaded } = loadEnvFile(args.env)
      process.stderr.write(`[eval:golden:freeze] 从 ${args.env} 补载 ${loaded} 个变量\n`)
    } catch (err) {
      process.stderr.write(
        `[eval:golden:freeze] 读不到 --env 指定的文件 ${args.env}: ${msgOf(err)}\n`
      )
      return 2
    }
  }

  const pre = checkRewritePreconditions()

  // dry 档在硬闸**之外**：它压根不改写，前置闸只作为体检项报告（见文件头「前置闸」）。
  if (mode !== 'dry' && !pre.ok) {
    process.stdout.write(
      JSON.stringify({ ok: false, phase: 'precondition', reason: pre.reason }) + '\n'
    )
    process.stderr.write(`[eval:golden:freeze] 前置闸未过：${pre.reason}\n`)
    return 2
  }

  let before
  try {
    before = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    process.stderr.write(`[eval:golden:freeze] 读不到/解析不了黄金集 ${file}: ${msgOf(err)}\n`)
    return 2
  }
  const acked = before.meta ? before.meta[ACK_KEY] : undefined

  // ─── dry：只读体检。**本分支内不得出现任何 LLM import / 写盘** ───
  // （测试用「假 root 下没有 query-rewrite.ts」来硬证这一点：走岔了会 ERR_MODULE_NOT_FOUND）
  if (mode === 'dry') {
    const info = inspectFrozen({ entries: before.entries, only: args.only, acked })
    process.stdout.write(
      JSON.stringify({
        ok: info.unacked.length === 0,
        mode: 'dry',
        file,
        source: FREEZE_SOURCE,
        llmCalls: 0,
        wrote: false,
        precondition: pre,
        ...info,
      }) + '\n'
    )
    process.stderr.write(summaryLine({ ...info, mode: 'dry' }) + '\n')
    if (info.unacked.length > 0) {
      process.stderr.write(`  未确认的空改写：${info.unacked.join(', ')}\n`)
    }
    process.stderr.write(
      '  只读体检：未调用改写器、未写盘。' +
        `真改写请加 --write（将重跑 ${info.wouldRewrite} 条）；` +
        '验证冻结可复现请加 --check。\n'
    )
    return info.unacked.length === 0 ? 0 : 1
  }

  const { rewriteRetrievalQueries } = await import(
    pathToFileURL(path.join(root, 'packages/server/src/memory/query-rewrite.ts')).href
  )

  const { entries, empty } = await freezeRewrites({
    entries: before.entries,
    rewrite: (q) => rewriteRetrievalQueries(q),
    only: args.only,
    attempts,
    onProgress: (done, total, id) => {
      if (done % 10 === 0 || done === total) process.stderr.write(`  … ${done}/${total} (${id})\n`)
    },
  })
  const frozen = entries.length - empty.length
  const unacked = unackedEmpties(empty, acked)

  if (mode === 'check') {
    const diff = diffRewrites({ before: before.entries, after: entries })
    const diffUnacked = unackedEmpties(diff.empty, acked)
    const ok = diff.changed.length === 0 && diffUnacked.length === 0
    process.stdout.write(
      JSON.stringify({
        ok,
        mode: 'check',
        source: FREEZE_SOURCE,
        frozen,
        empty: diff.empty,
        unacked: diffUnacked,
        changed: diff.changed,
      }) + '\n'
    )
    process.stderr.write(
      summaryLine({
        total: entries.length,
        frozen,
        empty: diff.empty,
        unacked: diffUnacked,
        changed: diff.changed,
        mode: 'check',
      }) + '\n'
    )
    return ok ? 0 : 1
  }

  const next = { ...before, entries }
  writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8')
  process.stdout.write(
    JSON.stringify({
      ok: unacked.length === 0,
      mode: 'write',
      file,
      source: FREEZE_SOURCE,
      frozen,
      empty,
      unacked,
    }) + '\n'
  )
  process.stderr.write(
    summaryLine({ total: entries.length, frozen, empty, unacked, mode: 'write' }) + '\n'
  )
  if (empty.length > 0) {
    process.stderr.write(
      `  空改写（**未**用原 query 冒充）：${empty.join(', ')}\n` +
        `  成因三种、返回面不可分辨（见本文件头）；判为「原话已足够」后把 id 写进 meta.${ACK_KEY} 即可归零。\n`
    )
  }
  return unacked.length === 0 ? 0 : 1
}

const isEntry =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isEntry && !bootstrap(process.argv.slice(2))) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`[eval:golden:freeze] 未捕获异常: ${msgOf(err)}\n`)
      process.exit(2)
    })
}
