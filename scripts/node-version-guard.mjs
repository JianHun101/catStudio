/**
 * Node 运行时下限守卫 —— MCP server 启动链路最前面的**故障点断言**（票 §3-2）。
 *
 * 为什么要有它（这是**已知故障点**，不是防御性编程）：
 * `mcp-server-utils.mjs` 用静态 import 直连 `packages/shared/src/skill-catalog.ts`
 * （技能白名单 / 目录的唯一真相源），依赖 Node 原生 TypeScript 类型剥离——该特性
 * 22.6 起需 `--experimental-strip-types`，**22.18.0 起默认开启**（已回移植到 22.x LTS）。
 * 低于该版本时那条 import 抛 `ERR_UNKNOWN_FILE_EXTENSION`，MCP server 直接起不来。
 * 而 harness 是用**裸 `node`** 拉起它的（`packages/server/src/llm/claude.ts:23`、
 * `dsh.ts:38`、`opencode.ts:25` 三处 `command: ['node', …]`），**不经 pnpm**
 * ⇒ `pnpm-workspace.yaml` 的 `engineStrict` 拦不到这条路径（票 §2-订正 2 实测）。
 * 本模块就是覆盖该路径的那道闸：与其让猫吃一坨 ESM loader 堆栈，不如直说
 * 「要哪个版本 / 当前哪个 / 哪些工具面会死」。
 *
 * 三条硬约束（改之前先读）：
 *
 * 1. **零 import** —— 尤其**不得** import 任何 `.ts`。它唯一的立身之本就是「抢在
 *    `.ts` 之前跑」，自己再拉一条 `.ts` 依赖就把自己废了（票 §7-3 有静态断言钉着）。
 * 2. **自检写在本模块顶层**（文件末尾那一行），不是只导出函数。
 * 3. **接线必须让 utils 走动态 import** —— 这条与票面字面量不同，是本单的**实测订正**：
 *    ESM 先把**整个模块图加载完**（load）再求值（evaluate），而 `.ts` 的
 *    `ERR_UNKNOWN_FILE_EXTENSION` 抛在**加载**阶段 ⇒ 就算本模块是 `mcp-server.mjs`
 *    的第一条 `static import`，它的顶层也**永远轮不到执行**（票面「按 import 顺序求值」
 *    的推理漏了加载阶段）。实测复现：
 *      `node --no-experimental-strip-types scripts/mcp-server.mjs`
 *      → 守卫静默，直接 ERR_UNKNOWN_FILE_EXTENSION（该 flag 精确复现 22.17 行为）。
 *    故 `mcp-server.mjs` 里引用 utils 那一行必须是 `await import(...)`。A/B 对照与
 *    端到端断言见 `scripts/node-version-guard.test.js`。
 */

/**
 * 本仓运行时下限 —— Node 原生 TypeScript 类型剥离**默认开启**的版本。
 *
 * 口径唯一真相源是 `package.json` 的 `engines.node`；本常量必须与它一致，
 * 由 `node-version-guard.test.js` 的「口径一致性」用例钉死（改一处不改另一处即变红）。
 */
export const MIN_NODE_VERSION = '22.18.0'

/** 不满足下限时的退出码（非 0，供 harness / 上层脚本判定）。 */
export const GUARD_EXIT_CODE = 1

/**
 * 解析 `major.minor.patch` 三段。
 *
 * 预发布 / 构建后缀（`-rc.1` / `+build` / `-nightly20250101`）**忽略**——
 * `22.18.0-rc.1` 按 `22.18.0` 判，与 npm semver 的「预发布 < 正式」细节不一致，
 * 对本守卫的用途（版本太低就大声拒）无害。
 *
 * @param {unknown} version
 * @returns {[number, number, number] | null} 不可解析返回 null
 */
export function parseSemver(version) {
  if (typeof version !== 'string') return null
  const matched = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  if (!matched) return null
  return [Number(matched[1]), Number(matched[2]), Number(matched[3])]
}

/**
 * 三段数值比较（**不是**字符串比较——`'22.9.0' > '22.18.0'` 是字符串陷阱）。
 *
 * @returns {-1 | 0 | 1}
 * @throws 任一侧不可解析时抛——调用方若要容错，先用 `parseSemver` 判可解析性
 */
export function compareSemver(a, b) {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (!left || !right) throw new Error(`无法解析版本号：${String(a)} / ${String(b)}`)
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1
  }
  return 0
}

/**
 * 运行版本是否满足下限。
 *
 * 版本串**不可解析 → 判拒**（fail-closed）：本守卫存在的意义就是把「静默哑掉」
 * 换成「大声失败」，认不出版本时放行正好退回它要防的那件事。
 *
 * @param {string} [version] 默认取当前运行版本
 */
export function isSupportedNodeVersion(version = process.versions.node) {
  if (!parseSemver(version)) return false
  return compareSemver(version, MIN_NODE_VERSION) >= 0
}

/**
 * 拒绝路径的 stderr 文案。
 *
 * 工具面清单**静态写死**：此刻 utils 连加载都过不去（正是本守卫要报的那个错），
 * 读不到 `MCP_TOOLS`。为防它与真实工具面漂移，测试断言文案里出现
 * `MCP_TOOLS` 的**每一个** name（`node-version-guard.test.js`）——加工具不改这里即变红。
 */
export function buildUnsupportedMessage(version) {
  return [
    `[catstudy] MCP server 拒绝启动：需要 Node >= ${MIN_NODE_VERSION}，当前 ${version || '(读不到)'}。`,
    '',
    '原因：本脚本静态 import packages/shared/src/skill-catalog.ts（技能白名单/目录的唯一真相源），',
    '依赖 Node 原生 TypeScript 类型剥离——22.6 起需 --experimental-strip-types，22.18.0 起默认开启。',
    '低于该版本时那条 import 抛 ERR_UNKNOWN_FILE_EXTENSION。',
    '',
    '受影响：本进程承载的**全部** MCP 工具面 —— 猫会失去结构化投递与技能自取能力：',
    '  post_message（投递下一棒）/ read_skill、list_skills（技能自取）/',
    '  search_knowledge（知识库检索）/ query_db、query_session_messages（排障取证）/',
    '  list_session_members（会话成员）/ request_user_action（请求用户介入）/ create_pr（提 PR）',
    '',
    `修复：升级 Node 到 >= ${MIN_NODE_VERSION}（package.json 的 engines.node 已声明该下限）。`,
    '注：harness 用裸 node 拉起本进程，不经 pnpm —— pnpm 的 engines 校验拦不到这条路。',
  ].join('\n')
}

/**
 * 断言运行版本满足下限；不满足则把诊断写 stderr 并退出。
 *
 * 出口（stderr / exit）可注入，供测试覆盖拒绝路径而不真的杀掉测试进程。
 *
 * @returns {boolean} 满足下限 → true；拒绝（仅注入出口时能观察到返回）→ false
 */
export function assertNodeVersion({
  version = process.versions.node,
  stderr = process.stderr,
  exit = (code) => process.exit(code),
} = {}) {
  if (isSupportedNodeVersion(version)) return true
  stderr.write(`${buildUnsupportedMessage(version)}\n`)
  exit(GUARD_EXIT_CODE)
  return false
}

// ── 接线：模块顶层自检 ────────────────────────────────────────────────
// `mcp-server.mjs` 把它当第一条 import ⇒ 求值即自检，早于 utils（及其 `.ts`）加载。
// ⚠️ 这条顶层调用是**有意的副作用**：任何 import 本模块的上下文都会触发（含测试）。
// 在受支持版本上它是 no-op；在不受支持的版本上杀掉 import 方**正是设计意图**。
assertNodeVersion()
