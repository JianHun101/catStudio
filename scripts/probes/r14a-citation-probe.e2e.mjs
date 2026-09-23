/**
 * R14a 角标引用遵循度离线探针（**不碰生产链**）
 *
 * 票面：docs/run/eval-system/R14a-citation-marker-probe.md
 *
 * 要回答的唯一问题：**给定指示语，猫在回复里会不会标 `[n]`？标得对不对？**
 *
 * ## 形态（票面 §四裁决：**不新建离线调用链**）
 *
 * 复用现成的 adapter 工厂（`packages/server/src/llm/registry.ts` 的
 * `getAdapterForAgent`），本探针只做**调用方**。新建独立调用链 = 又造一个可能与
 * 生产不一致的真相源（「离线跑通、线上不通」）。
 *
 * ## 阶段
 *
 * - `--mode s0`（**停损点**）：4 条链路可达性。对每个 provider 发一次极短真实调用，
 *   可达 / 不可达**以实测为准**——不看端口与二进制（ollama 适配器会自拉 serve、
 *   dsh 走全局安装，静态检查会误判）。不可达记「未测」+ 原因，**不许拿别的
 *   provider 的数顶替**。
 * - `--mode s1`：`claude` 单 provider × 甲/乙两版 × N 遍 ⇒ 挑胜者。
 * - `--mode s2`：4 provider（可达者）× 胜出版本 × N 遍。
 *
 * ## 三分判据（票面 §三：**不许并成一个「遵循率」**）
 *
 * | 失效模式   | 含义                             | 修法方向         |
 * | ---------- | -------------------------------- | ---------------- |
 * | 不标       | 用了某节但一个号都没写           | 改措辞 / 加强指示 |
 * | 标错号     | 标了 `[2]` 但内容其实来自第 3 节 | 改「编号↔内容」描述 |
 * | 标不存在号 | 只注入 3 节却写 `[4]`            | 后端降级（R14b） |
 *
 * 并成一个比率会分不清「不会标」和「标错」——而这两者**修法相反**。
 *
 * 用法:
 *   node scripts/probes/r14a-citation-probe.e2e.mjs --mode s0 [--db <sqlite>] [--out <json>]
 *
 * 退出码：0 = 读到结果（含「不可达」这类结论）；1 = 环境/自举失败；2 = 用法错误。
 */

import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

// ─── 注入串形状规格（票面 §四，**逐字取自 `renderSections`**）─────────
//
// ⚠️ 本探针**不许自拟记忆段格式**——形状一变，「与生产同形」就没了，
// 而读数会静默失效（探针照跑、结论不再代表生产）。
// 同步守卫见 `r14a-citation-probe.test.js` 的「形状规格守卫」组：
// `packages/server/src/memory/index.ts` 的 `renderSections` 一变即红。

/** 记忆区块头（`renderSections` 里 `【相关记忆】` 的模板字面量） */
export const MEMORY_BLOCK_HEADER = '【相关记忆】'

/** 整块前缀：`renderSections` 以 `\n\n` 起头 */
export const MEMORY_BLOCK_PREFIX = '\n\n'

/** 逐行 `序号. 正文`——序号 `i + 1` 是**最终位置**（`renderOrder` 重排后） */
export function renderMemoryBlock(sections) {
  if (sections.length === 0) return ''
  const lines = sections.map((s, i) => `${i + 1}. ${s}`)
  return `${MEMORY_BLOCK_PREFIX}${MEMORY_BLOCK_HEADER}\n${lines.join('\n')}`
}

// ─── 独立变量：指示语措辞（**票面 §二 定稿，实施者不自拟**）────────────
//
// 遵循度是**措辞的函数**——自拟一版测出的数，对定稿版零信息量。
// ⚠️ 两版都**不作位置要求**（句末 / 词后皆可）：位置本身是待观察量，
// 在指示语里写位置要求 = 引入第二个自变量。

export const VARIANTS = {
  jia: '（以下为检索到的历史结论。若你采纳了其中某条，请在该处标注其编号，如 [1]；没有采纳的条目不标。）',
  yi: '（采纳某条时标注其编号，如 [1]。）',
}

/** 把指示语插进记忆块——位置：`【相关记忆】` 头**之后**、`1.` **之前**（票面 §四） */
export function withInstruction(sections, instruction) {
  if (sections.length === 0) return ''
  const lines = sections.map((s, i) => `${i + 1}. ${s}`)
  return `${MEMORY_BLOCK_PREFIX}${MEMORY_BLOCK_HEADER}\n${instruction}\n${lines.join('\n')}`
}

// ─── 三分判据解析 ─────────────────────────────────────

/** 回复里出现的全部 `[n]` 编号（去重、升序） */
export function parseMarkers(text) {
  const found = new Set()
  for (const m of text.matchAll(/\[(\d+)\]/g)) found.add(Number(m[1]))
  return [...found].sort((a, b) => a - b)
}

/**
 * 按三分判据归类一条回复。
 *
 * @param text        回复正文
 * @param sectionCount 本次注入的节数（编号 1..sectionCount）
 * @returns `{ markers, outOfRange, marked }`
 *   - `outOfRange` = 标了 `> sectionCount` 的号（**非措辞问题**，R14b 后端降级面）
 *   - `marked` = 至少标了一个**合法**号
 *   - `notMarked` = 一个号都没标（「不标」）——**注意**：这只说明没标，
 *     是否「用了却没标」要配合 `--expect` 的答案锚点判定
 */
export function classify(text, sectionCount) {
  const markers = parseMarkers(text)
  const outOfRange = markers.filter((n) => n < 1 || n > sectionCount)
  const inRange = markers.filter((n) => n >= 1 && n <= sectionCount)
  return { markers, inRange, outOfRange, marked: inRange.length > 0 }
}

// ─── 自举：原生 node 跑 `.mjs` 无法 import `.ts`（adapter 工厂是 TS）───

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

const BOOTSTRAP_FLAG = 'R14A_PROBE_TSX'

function bootstrap(argv) {
  if (process.env[BOOTSTRAP_FLAG] === '1') return false
  if (!existsSync(TSX_CLI)) {
    process.stderr.write(`[r14a] 找不到 tsx（${TSX_CLI}），请确认已执行 pnpm install\n`)
    process.exit(1)
  }
  const child = spawn(process.execPath, [TSX_CLI, fileURLToPath(import.meta.url), ...argv], {
    stdio: 'inherit',
    env: { ...process.env, [BOOTSTRAP_FLAG]: '1' },
  })
  child.on('exit', (code) => process.exit(code ?? 1))
  child.on('error', (err) => {
    process.stderr.write(`[r14a] 拉起 tsx 失败: ${err && err.message}\n`)
    process.exit(1)
  })
  return true
}

// ─── CLI ──────────────────────────────────────────────

function parseArgs(argv) {
  const args = { mode: null, db: null, out: null, provider: null, n: 5, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--mode') args.mode = argv[++i] ?? null
    else if (a === '--db') args.db = argv[++i] ?? null
    else if (a === '--out') args.out = argv[++i] ?? null
    else if (a === '--provider') args.provider = argv[++i] ?? null
    else if (a === '--n') args.n = Number(argv[++i] ?? 5)
    else if (a === '--help' || a === '-h') args.help = true
  }
  return args
}

/** S0 冒烟题：极短、不依赖记忆段——只验链路通不通 */
const SMOKE_PROMPT = '请只回复两个字：收到'

/** S0 逐 provider 超时（ms）。CLI 型适配器起进程慢，给宽些；总时长由并发封顶 */
const SMOKE_TIMEOUT_MS = 150_000

const USAGE =
  '用法: node scripts/probes/r14a-citation-probe.e2e.mjs --mode <s0|s1|s2> [--db <sqlite>] [--out <json>]\n' +
  '  --mode s0  4 条链路可达性（停损点）：每 provider 一次极短真实调用\n' +
  '  --mode s1  claude 单 provider × 甲/乙两版 × N 遍\n' +
  '  --mode s2  4 provider（可达者）× 胜出版本 × N 遍\n' +
  '  --db 缺省 <root>/packages/server/data/cat-study-dev.db（worktree 内无库 ⇒ 显式传主仓库库路径）\n'

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help || !args.mode) {
    process.stdout.write(USAGE)
    return args.help ? 0 : 2
  }

  const root = REPO_ROOT
  const dbPath = path.resolve(
    args.db ?? path.join(root, 'packages/server', 'data', 'cat-study-dev.db')
  )
  if (!existsSync(dbPath)) {
    process.stderr.write(
      `[r14a] 库不存在：${dbPath}\n` +
        '  （worktree 内没有它——它是未跟踪产物；请显式 --db 指向主仓库的库）\n'
    )
    return 1
  }

  const serverRequire = createRequire(path.join(root, 'packages', 'server', 'package.json'))
  const Database = serverRequire('better-sqlite3')
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })

  // 真实花名册（票面 §五：**以 `agents` 表实测为准**，票面那张表只是立票时读数）
  const agents = db
    .prepare(
      `SELECT name, llm_provider, llm_model, llm_api_key, llm_base_url, llm_env_extra,
              effort_level, llm_max_tokens, llm_temperature, system_prompt
       FROM agents ORDER BY name`
    )
    .all()
  db.close()

  const { getAdapterForAgent } = await import(
    pathToFileURL(path.join(root, 'packages/server/src/llm/registry.js')).href
  )

  if (args.mode === 's0') return await runS0(agents, getAdapterForAgent, args)
  process.stderr.write(`[r14a] --mode ${args.mode} 尚未实施（本轮只落 S0）\n`)
  return 1
}

// ─── S0：链路可达性 ───────────────────────────────────

/** DB 行（snake_case）→ AgentConfig（camelCase）——与 API 边界同口径 */
export function rowToAgentConfig(row) {
  return {
    id: `probe-${row.name}`,
    name: row.name,
    avatar: '',
    systemPrompt: row.system_prompt ?? '',
    llmProvider: row.llm_provider,
    llmModel: row.llm_model,
    llmApiKey: row.llm_api_key ?? '',
    llmBaseUrl: row.llm_base_url ?? undefined,
    effortLevel: row.effort_level ?? undefined,
    llmMaxTokens: row.llm_max_tokens ?? undefined,
    llmTemperature: row.llm_temperature ?? undefined,
    llmEnvExtra: row.llm_env_extra ?? undefined,
  }
}

/**
 * 对一个 provider 的代表猫发一次极短真实调用。
 *
 * **可达判据**：`chatStream` 至少 yield 一个非空**文本** chunk 且最终 `done`。
 * 只验链路——不看回复内容对不对（那是 S1 的事）。
 *
 * ⚠️ 字段名是 **`content`**（`Chunk.content`，`packages/shared/src/types.ts`），
 * 不是 `text`。读错字段会让**每一条**都报「done 但无文本」——探针恒定给同一个
 * 假读数，且看起来像「4 个 provider 全不可达」这种合理解论。本仓反复栽的
 * 「探针瞎了也给同样的 0」正是这个形态（S0 的 `text-classification` 那次）。
 * ⚠️ `kind === 'thinking' | 'tool'` 的 chunk 也带 `content`，但**不是回复正文**——
 * 只有 `kind` 缺省或 `'text'` 的才计入。
 */
async function smokeOne(agent, getAdapterForAgent) {
  const startedAt = Date.now()
  const result = {
    provider: agent.llm_provider,
    agent: agent.name,
    model: agent.llm_model,
    reachable: false,
    reason: null,
    replyChars: 0,
    thinkingChars: 0,
    replyPreview: null,
    elapsedMs: 0,
  }
  try {
    const adapter = getAdapterForAgent(rowToAgentConfig(agent))
    let text = ''
    let thinkingChars = 0
    let sawDone = false
    const iter = adapter.chatStream([{ role: 'user', content: SMOKE_PROMPT }], {
      model: agent.llm_model,
      maxTokens: 64,
      timeoutMs: SMOKE_TIMEOUT_MS,
    })
    for await (const chunk of iter) {
      if (chunk && typeof chunk.content === 'string') {
        // thinking / tool 段不是回复正文——只计数、不计入可达判据
        if (chunk.kind === undefined || chunk.kind === 'text') text += chunk.content
        else thinkingChars += chunk.content.length
      }
      if (chunk && chunk.done) {
        sawDone = true
        break
      }
    }
    result.replyChars = text.length
    result.thinkingChars = thinkingChars
    result.replyPreview = text.slice(0, 80)
    if (sawDone && text.trim().length > 0) {
      result.reachable = true
    } else {
      // 「exit 0 无输出」是本仓实测过的形态（空 done 掩盖偶发故障）——
      // 归因不明时**不写成不可达**，写成可达性未确认，附读数
      result.reason = sawDone ? 'done 但无文本（空回复形态）' : '流结束但未见 done'
    }
  } catch (err) {
    result.reason = err && err.message ? err.message : String(err)
  }
  result.elapsedMs = Date.now() - startedAt
  return result
}

async function runS0(agents, getAdapterForAgent, args) {
  // 每 provider 一只代表猫（多只同 provider 的，取字典序第一个；实测口径以表为准）
  const byProvider = new Map()
  for (const a of agents) {
    if (!byProvider.has(a.llm_provider)) byProvider.set(a.llm_provider, a)
  }

  const picked = args.provider
    ? [...byProvider.entries()].filter(([p]) => p === args.provider)
    : [...byProvider.entries()]

  process.stderr.write(
    `[r14a] S0：${picked.length} 个 provider（${picked.map(([p]) => p).join(', ')}），` +
      `每只超时 ${SMOKE_TIMEOUT_MS}ms，并发跑\n`
  )

  // 并发：S0 只判**通不通**，与耗时无关 ⇒ 争用不影响判据（与 R13a 的计时段不同）。
  // 串行的话最坏 4×超时 = 10 分钟，装不进预算。
  const results = await Promise.all(
    picked.map(async ([, agent]) => {
      const r = await smokeOne(agent, getAdapterForAgent)
      process.stderr.write(
        `[r14a]   ${r.provider} (${r.agent}/${r.model}): ` +
          `${r.reachable ? '✅ 可达' : '❌ 未确认'} ${r.elapsedMs}ms ` +
          `reply=${r.replyChars}字${r.reason ? ` — ${r.reason}` : ''}\n`
      )
      return r
    })
  )

  const report = {
    ok: true,
    mode: 's0',
    ranAt: new Date().toISOString(),
    smokePrompt: SMOKE_PROMPT,
    timeoutMs: SMOKE_TIMEOUT_MS,
    agentsInDb: agents.map((a) => ({ name: a.name, provider: a.llm_provider, model: a.llm_model })),
    results,
  }
  process.stdout.write(JSON.stringify(report) + '\n')

  if (args.out) {
    mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true })
    writeFileSync(path.resolve(args.out), JSON.stringify(report, null, 2))
    process.stderr.write(`[r14a] 报告落 ${path.resolve(args.out)}\n`)
  }
  return 0
}

// ─── 入口 ─────────────────────────────────────────────

const isEntry =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isEntry && !bootstrap(process.argv.slice(2))) {
  process.exit(await main(process.argv.slice(2)))
}
