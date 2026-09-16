/**
 * pre-commit 测试门禁 —— 按暂存区改动面选 vitest project（三档：跳过 / 单包 / 全量）。
 *
 * 由来（票 `docs/run/precommit-scope/tickets.md`）：`.husky/pre-commit` 原先第三行直接
 * `pnpm test`（全量 4 project）。而 T-2 Phase I 未接线前，会话内多猫**共用一个 worktree**
 * （`llm/git-utils.ts` `ensureSessionWorktree` 按 `sessionId` 取路径），任一只猫提交都要跑
 * 全量 ⇒ 并行的结局是互相拖死（R3 实证：某猫连试 8 次全废）。收窄判据 = **改动面**：改了哪个
 * 包就跑哪个包；契约层与测试基础设施仍全量；纯文档跳过。
 *
 * ── 为什么按包而不是 `vitest related`（决策留痕）─────────────────
 * `related` 走静态 import 图：本仓存在被**运行时字符串**引用的面（如 `db/schema.ts`），图上
 * 看不见 ⇒ 漏。按包是**粗但零假阴性**的下界。宁可多跑一个包，不可漏一个消费者。
 *
 * ── fail-closed（不是可选礼仪）──────────────────────────────────
 * 门禁脚本自身出错时若回退成「跳过测试」，等于开了一条**静默放行**路径 —— 比全量慢几分钟坏
 * 得多。故：git 读失败 / 解析异常 / **暂存区为空** / 任何无法归类的路径 ⇒ 一律全量。
 *
 * ── scope 名 ≠ project 名（实测，勿想当然）─────────────────────
 * `resolveScopes` 返回的是**仓根相对路径**（票面 §2.2 钉死的形状），而 `vitest --project` 认的是
 * **project 名**，两者不等 —— 实测（vitest 4.1.9）：
 *   `--project packages/server` ⇒ `Startup Error: No projects matched the filter`
 *   `--project @cat-study/server` ⇒ 88 文件被选中
 * 即 project 名 = 包 `package.json` 的 `name`，无 `package.json` 的目录（`scripts`）回落目录名。
 * 映射走 `projectNameOf()` 读**各包 package.json**（不在本文件另抄一份包名表 —— 那会变成第二个
 * 真相源，包改名必漏一处；形状脱节的失败形态是 startup error，fail-loud 不是静默跑错）。
 *
 * ── 出口 ────────────────────────────────────────────────────
 *   跳过      → exit 0（不启 vitest）
 *   收窄/全量 → `node <root>/node_modules/vitest/vitest.mjs run --project <名> …`，退出码原样透传
 * 用 `node vitest.mjs` 而非 `npx vitest`：避开 Windows 的 `.cmd` wrapper（AGENTS.md Gotchas）。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanGitEnv } from './commit-uuid-gate.mjs'

/** 本仓库根（scripts/ 的父目录）——worktree 内即该 worktree 的根 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 全量 project 集合。**顺序即契约**：`resolveScopes` 的 `projects` 恒为本数组的子序列
 * （票面 §2.2「顺序确定，防『顺序不定 ⇒ 读数不可比』」）。
 */
export const ALL_PROJECTS = Object.freeze([
  'packages/shared',
  'packages/server',
  'packages/web',
  'scripts',
])

/** 全量触发 · 精确路径（仓根相对、正斜杠）——测试基础设施本身 */
const FULL_EXACT = new Set([
  'vitest.config.ts',
  'scripts/vitest.config.ts',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
])

/** 全量触发 · 前缀 —— 契约层（三包都依赖）+ 提交门禁自身 */
const FULL_PREFIXES = ['packages/shared/', '.husky/']

/**
 * 全量触发 · 文件名形状。票面作 `tsconfig*.json` **不限定目录**，故按 basename 匹配任意深度
 * （`packages/server/tsconfig.json` 也走全量）—— 向严侧，与票面字面一致。
 */
const FULL_BASENAME = /^tsconfig.*\.json$/

/**
 * 命中即收窄到某 scope · 前缀表。**顺序敏感**：
 *   ① 包前缀在前 —— `packages/server/README.md` 取「本包」而非「*.md 跳过」（向严：包内
 *      今天是零 MD，但将来出现被测试消费的 MD 时「跳过」会漏；宁可多跑）。
 *   ② 记忆面在后 —— 其消费者在 server（`scripts/flywheel/scan.mjs` 扫
 *      `docs/adr/` `docs/lessons/` `docs/plans/`，切成 chunk 进检索），故归 server。
 */
const SCOPE_PREFIXES = [
  ['packages/server/', 'packages/server'],
  ['packages/web/', 'packages/web'],
  ['scripts/', 'scripts'],
  ['docs/adr/', 'packages/server'],
  ['docs/lessons/', 'packages/server'],
  ['docs/plans/', 'packages/server'],
]

/** 命中即跳过 · 前缀 —— 在飞文档 / 会话产物，无测试消费者（不在记忆白名单内） */
const SKIP_PREFIXES = ['docs/run/', 'docs/sessions/']

const FULL = Symbol('full')
const SKIP = Symbol('skip')

/** 归一化：反斜杠 → 正斜杠、去 `./` 前缀、去首尾空白 */
function normalize(p) {
  return String(p).trim().replace(/\\/g, '/').replace(/^\.\//, '')
}

/** 单条路径 → `FULL` / `SKIP` / scope 字符串。判定顺序即优先级（全量最优先）。 */
function classify(p) {
  if (FULL_EXACT.has(p) || FULL_PREFIXES.some((pre) => p.startsWith(pre))) return FULL
  if (FULL_BASENAME.test(p.slice(p.lastIndexOf('/') + 1))) return FULL
  for (const [pre, scope] of SCOPE_PREFIXES) if (p.startsWith(pre)) return scope
  if (SKIP_PREFIXES.some((pre) => p.startsWith(pre))) return SKIP
  if (p.endsWith('.md')) return SKIP
  return FULL // 无法归类 —— fail-closed
}

function fullDecision(reason) {
  return { projects: [...ALL_PROJECTS], skip: false, reason: `全量 4 project —— ${reason}` }
}

/**
 * 暂存区路径 → 该跑哪些 project。
 *
 * @param {string[]} stagedPaths 仓根相对路径（正斜杠）；相对/反斜杠写法一并归一化
 * @returns {{ projects: string[], skip: boolean, reason: string }}
 *   契约：`skip === true` ⇒ `projects` 为空；`skip === false` ⇒ `projects` 非空，
 *   且恒为 `ALL_PROJECTS` 的子序列（顺序确定）。
 */
export function resolveScopes(stagedPaths) {
  // 空列表 fail-closed：`git diff --cached --name-only` 在钩子环境异常时可能回空串，
  // 那与「真的没暂存」不可区分 —— 按「不可判定 ⇒ 跑全量」处理。
  if (!Array.isArray(stagedPaths) || stagedPaths.length === 0) {
    return fullDecision('暂存区为空或不可解析（fail-closed）')
  }

  const scopes = new Set()
  let skipped = 0
  for (const raw of stagedPaths) {
    const p = normalize(raw)
    const verdict = classify(p)
    if (verdict === FULL) return fullDecision(`命中全量触发项 ${p}`)
    if (verdict === SKIP) {
      skipped += 1
      continue
    }
    scopes.add(verdict)
  }

  if (scopes.size === 0) {
    return {
      projects: [],
      skip: true,
      reason: `跳过 —— ${skipped} 条路径全为文档/在飞产物（无测试消费者）`,
    }
  }
  const projects = ALL_PROJECTS.filter((s) => scopes.has(s))

  // ── V14 护栏在岗保证（票 `precommit-scope` 残余收口·单B，店长裁 B）────────────
  // `scripts/test-isolation-guard.test.js` 属 `scripts` project，判的是「测试隔离路径是否
  // 落到 junction 共享面」——而该写法**最常出现在改 `packages/**` 的提交里**（新写一个测试、
  // 顺手敲了个相对路径）。只按改动面收窄 ⇒ 改 packages 时护栏不跑 = **在它最该拦的位置上
  // 不在岗**。故命中任一 `packages/**` scope 时追加 `scripts`（实测代价 ~4.4s/次提交）。
  // `scripts` 恒在 `ALL_PROJECTS` 末位（顺序即契约）⇒ **末尾追加即保序**，不排序、不去重重排。
  let appended = false
  if (projects.some((s) => s.startsWith('packages/')) && !scopes.has('scripts')) {
    projects.push('scripts')
    appended = true
  }
  const suffix = appended ? '（含 scripts：V14 护栏随 packages 改动在岗）' : ''
  return { projects, skip: false, reason: `按改动面收窄到 ${projects.join(' + ')}${suffix}` }
}

/**
 * scope（仓根相对目录）→ vitest project 名。
 * 单源 = 该包 `package.json` 的 `name`；读不到（`scripts` 无 package.json）⇒ 回落目录名。
 */
export function projectNameOf(scope) {
  try {
    const name = JSON.parse(readFileSync(resolve(ROOT, scope, 'package.json'), 'utf8')).name
    if (name) return name
  } catch {
    // 无 package.json 或不可读 —— vitest 对这类目录即用目录名作 project 名
  }
  return scope.slice(scope.lastIndexOf('/') + 1)
}

/** 暂存区路径读数 —— `--cached` 保证只读暂存区，不受工作区未暂存改动影响 */
function gitStagedPaths() {
  const out = execFileSync('git', ['diff', '--cached', '--name-only'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // 剥 git 注入的定位变量：本脚本就在 pre-commit 里跑，透传 GIT_DIR/GIT_INDEX_FILE 会让
    // 「读暂存区」这条命令被劫持到**另一个**仓库（钩子顶部已 unset，此处是第二道防御 +
    // 手动调用本脚本时的唯一防线）
    env: cleanGitEnv(),
  })
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

function main() {
  let decision
  try {
    decision = resolveScopes(gitStagedPaths())
  } catch (err) {
    decision = fullDecision(`git 读失败或解析异常（fail-closed）：${err?.message ?? err}`)
  }
  console.log(`[precommit-scope] ${decision.reason}`)

  if (decision.skip) {
    console.log('[precommit-scope] 跳过测试')
    return 0
  }

  const args = decision.projects.flatMap((s) => ['--project', projectNameOf(s)])
  const vitest = resolve(ROOT, 'node_modules', 'vitest', 'vitest.mjs')
  console.log(`[precommit-scope] run: node ${vitest} run ${args.join(' ')}`)
  const r = spawnSync(process.execPath, [vitest, 'run', ...args], { cwd: ROOT, stdio: 'inherit' })
  if (r.error) {
    console.error(`[precommit-scope] 拉起 vitest 失败：${r.error.message}`)
    return 1
  }
  return r.status ?? 1
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) process.exit(main())
