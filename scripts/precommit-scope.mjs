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

/**
 * 重活用例清单 —— **仅收窄档**追加到 vitest CLI 的 `--exclude`（票辛，店长裁 B2）。
 *
 * ── 判据 = 性质，且必须与「本档的改动面」相交（不是「属于哪个包」）──────
 * 一条用例该不该在**提交口**跑，问三件事：
 *   ① **相变性**：它判的面，与「收窄档的改动面」是否相交？不相交 ⇒ 此档里纯冗余。
 *   ② **判据性质**：它的输赢是否由墙钟/OS 调度主导？是 ⇒ 负载一高就自己红，与改动对错
 *      无关 —— 同步门禁只该放**确定性**检查，靠墙钟判生死的一律不进来。
 *   ③ **有无兜底**：排掉它的代价，别的档位能不能兜住？
 *
 * ①是这里最容易搞错的一条，两条**故意不列**的用例都是被①挡下的（见下）。
 *
 * ── 为什么是「排除清单」而不是「只跑白名单」（B1）──────────────
 * 两者**清单过期时的失败形态相反**，这是选 B2 的全部理由：
 *   本形态（排除）漏列一条 ⇒ 该重活用例回来跑 ⇒ **变慢、负载下可能假红 = 吵**；
 *   白名单形态 漏列一条 ⇒ 该用例**静默不跑**，没有任何人知道。
 * 选吵，不选静默。
 *
 * ── 路径为什么写成「相对 scripts/ 的路径」（实测，勿改形状）──────
 * vitest 4.1.9 实测：`--exclude` 的 glob 基准是**各 project 自己的 root**（不是仓库根），
 * 且**跨 project 全局生效**（同一次调用里给的排除项，在 server 上也确实排掉了 server 的文件）。
 *   `scripts/closeout-dupcheck.test.js` ⇒ **不生效**（证明基准不是仓库根）
 *   `closeout-dupcheck.test.js`         ⇒ 生效
 * 故写成相对 `scripts/` 的路径。**刻意不加「双星号斜杠」前缀**：那种形状会在将来
 * `scripts/<新目录>/同名文件` 出现时**被误排 = 静默少跑**；精确路径失配只会让重活用例
 * 回来跑（吵）。又是「静默 vs 吵」同一个取舍。
 *
 * ── 代价（明写，别让下一个人重新推）────────────────────────
 * 本清单生效后，一个**改坏了这些用例所覆盖的脚本**的提交，不会在提交口被它们拦下 ——
 * 它们改由 FULL 档（改 `.husky/**`、契约层、`package.json` / `vitest.config.ts`）与
 * 全量 `pnpm test` / 审查链兜住。丢的是**档**，不是**岗**。
 */
export const HEAVY_CASES = Object.freeze([
  // 逐个都实跑了单文件耗时（串行、无并发争用），见清单注释：合计占 scripts project 的 98%
  'closeout-dupcheck.test.js', // 8.8s —— 真 spawn node 跑真脚本 + 真 git 仓
  'flywheel/scan.test.js', //     5.3s —— 真 git 仓 + 全量扫描
  'pre-commit-env.test.js', //    1.3s —— 沙箱复刻主仓库/worktree/共享 config + 真 commit
  'commit-uuid-gate.test.js', //  1.2s —— 真 SQLite + 真 `git commit` 两次
])
// ↑ **故意不在清单里**的同类用例，理由都是判据①（与本档改动面不相交的在下面另外写）：
//   `test-isolation-guard.test.js`（0.9s）—— 它命中「真子进程 + 真 worktree」两条性质，
//     但判据① 反向成立：它判的正是**改 `packages/**` 的产物**（新写的测试有没有把隔离
//     路径落到 junction 共享面）。`:148-158` 的追加规则就是为它立的 —— 把它排掉，追加
//     `scripts` 这个动作本身就空了。**这是本清单唯一的「性质命中但必须留」项**。
//   `hooks-config.test.js`（44ms）—— 真 spawn git，但成本不在墙钟主导（判据②不过），
//     且它判 `.husky/hooksPath`（本仓复发 3 次的病）。排它收益为零、风险为正。

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

/**
 * 全量档判据：`decision.projects` 与 `ALL_PROJECTS` **逐元素相等**（含顺序）。
 *
 * 用逐元素比较而不是「长度相等 + 集合相等」：`projects` 的契约就是按序子序列
 * （`resolveScopes` §2.2），顺序错了本身就是坏读数，不该被判成「全量」而放过。
 * 也不写成 `projects.length === 4`：4 是今天的巧合，`ALL_PROJECTS` 增删一个包时那种写法
 * 会**静默**把新的全量档误判成收窄档（从而给它加排除项）。
 */
export function isFullScope(projects) {
  return (
    Array.isArray(projects) &&
    projects.length === ALL_PROJECTS.length &&
    projects.every((p, i) => p === ALL_PROJECTS[i])
  )
}

/**
 * 组装传给 vitest 的参数（`run` 之后的全部内容）。
 *
 * **分档**：全量档一个字节不加 `--exclude`（`.husky/**` / 契约层 / `packages/shared/**`
 * 这些入口的重活用例**在它最该在岗的位置不缺岗**）；收窄档才追加 `HEAVY_CASES`。
 *
 * 第二个条件 `includes('scripts')` 在当前 `resolveScopes` 下恒被第一条件蕴含（任何
 * `packages/**` 档都会追加 `scripts`，纯 `scripts` 档本身也含它）—— 留着是因为它把
 * 「这份清单只对 scripts 的用例有意义」这个前提**写在代码里**，而不是只写在注释里：
 * 将来若追加规则被改动，这里会退化成「不给无关档位塞无效参数」，方向安全（重活用例回来
 * 跑 = 吵，不是静默少跑）。
 */
export function buildVitestArgs(decision) {
  const args = decision.projects.flatMap((s) => ['--project', projectNameOf(s)])
  if (!isFullScope(decision.projects) && decision.projects.includes('scripts')) {
    for (const c of HEAVY_CASES) args.push('--exclude', c)
  }
  return args
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

  const args = buildVitestArgs(decision)
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
