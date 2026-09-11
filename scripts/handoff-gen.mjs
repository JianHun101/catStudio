/**
 * Handoff 交接文档生成器 — post-commit hook 自动调用。
 *
 * 从 git diff 提取机械部分（文件清单 + Reviewer Checklist），
 * 再按归属判据决定是否投递到 cat-study（T-A 起的兜底语义，见下）——投出后由当事人
 * 补填 Why / Tradeoff / Open Questions，再按 request-review 自行发起审查。
 *
 * 用法:
 *   node scripts/handoff-gen.mjs                    # post-commit：判归属后投递 HEAD（见下）
 *   node scripts/handoff-gen.mjs --no-post          # 只生成 .handoff-draft.md，不投递
 *   node scripts/handoff-gen.mjs --gate-deliver     # pre-push 门禁入口：补投 pending 队列
 *                                                   # + 兜底投递 HEAD（若尚未投递）
 *   node scripts/handoff-gen.mjs --fallback-sha=<sha>  # 收尾兜底入口（server 执行收尾调用，
 *                                                   # 补「有 commit 但回复未 @ 审查者」）
 *   node scripts/handoff-gen.mjs --cwd=/path        # 指定仓库路径
 *
 * T-A 兜底投递（2026-09-10）：post-commit **不再每 commit 必投**——先判归属
 * （`decideHookDelivery`，判据源 = **该 uuid 是否存在任一状态的执行行**，
 * 见 `probeAttribution`；T-H ① 前的判据是「写回端点返回的 running 命中行数」，
 * 两者在「执行已终态 / 同猫并发另一条在跑」时结论相反——那正是 T-H ① 治的假阴性）：
 *   - 有归属（agent 执行）→ 静默，审查请求归实施猫自己投（铁律 + request-review）
 *   - 无归属（用户终端手动提交）→ 无人会投，钩子兜底
 *   - 判据查不动 → 一律投递（不静默吞）
 * 漏投由 server 执行收尾补（`--fallback-sha`，判据见 execution/review-fallback.ts）。
 * 原痛点：钩子每 commit 必投 → 中途返工每新 SHA 叠一条链。
 *
 * T-H ②（2026-09-10）审查请求覆盖**裁决：显式接受「只看 HEAD」**——一次派发 = 一条
 * 审查请求，锚在该派发**最新的**那个 commit，投递文档的改动面也就只有它。
 * 已知缺口（留痕，不修）：同一派发里更早的 commit 不进这条请求的改动面。
 *   - **主动投递路径不受影响**（T-A 主路径）：猫自己写审查请求、自己点名 sha，
 *     审查者读 push 后的完整 diff——覆盖面由猫掌握，不由本文档决定。
 *   - 缺口仅在「猫忘投 → 收尾兜底」支路，且需该派发已产出 ≥2 个 commit。
 * 否决的替代（含实测证据，别重走）：
 *   - 逐 commit 各投一条 → 正是 T-A 要止住的「返工每新 SHA 叠一条链」。
 *   - 按同一 uuid 回溯、把改动面扩到整段 → **实测会裹进兄弟票**：店长一条消息
 *     @ 两只猫是**常态**（并行派活），两猫的 commit 共享 uuid 且相邻，回溯判为一段
 *     → 文档 file list 混入兄弟票的文件、审查须知指向一个不属于本单的 diff。
 *     flash猫 本票自己的草稿就是现场样本（spans 到 ds猫 的 T-E `7dd0e14`）。
 *
 * 投递幂等（修复重复投递，见重复投递根治计划 A+B+C+D）：
 *   .handoff-delivered.json 状态文件按 commit SHA 记录投递结果，锚点取代"内容字节"：
 *     { "delivered": { "<full-sha>": "<iso-time>" }, "pending": ["<sha>", ...] }
 *   - 同一 SHA 投递成功一次后，后续任何投递机会（post-commit / --gate-deliver /
 *     --fallback-sha）查状态直接跳过，不再重复投递
 *   - 投递失败（瞬态重试耗尽）的 SHA 记入 pending，每次投递机会先补投 pending：
 *     文档从 git 按 SHA 重新生成（确定性的，不依赖草稿文件）→ 投递 → 成功移入 delivered
 *   - 状态文件丢失/历史改写（reset）自动退化为"首次投递"——宁可多投不可漏投
 *   ⚠️ 账本与本判据的分工（T-A 定死）：账本键=SHA，答的是「同一 SHA 是否投过」
 *   （幂等锁）；归属判据源=执行行，答的是「该不该由钩子投」。两者不同源，
 *   账本无法表达归属——不合并、不互相替代。**判静默不记账本**（账本单态=真投过）：
 *   记了会把收尾兜底锁死；不给门禁加 skipped 态则是有意的——见 deliverSha 注释。
 *   pre-push 门禁的 HEAD 兜底因此仍是「有归属但猫没投」的最后一道网。
 *
 * 成功判定（修复 B）：POST 超时/5xx 后不再立即判失败，改为轮询目标会话最近消息
 * 验证"消息是否客观落库"（write→broadcast→dispatch 顺序，落库先于 dispatch 同步等待）。
 * 4xx 是确定性失败，不走落库验证直接 fatal。
 *
 * 环境变量:
 *   CATSTUDY_URL          服务器地址（默认 http://127.0.0.1:3200）
 *   CATSTUDY_SESSION_ID   目标会话 ID（人工显式指定，明确意图优先）。
 *                         投递目标选择：
 *                         1. CATSTUDY_SESSION_ID 环境变量（人工指定；同时旁路
 *                            delivered 状态跳过——显式指定即明确意图，如会话重建后重投）
 *                         2. commit message 的 catstudy [uuid] 反查消息所在会话（自动）
 *                         两者都不可用时**报错不投递**——绝不猜目标。
 *                         曾因反查失败静默降级到环境变量/API 第一个会话，
 *                         把审查文档投到错误会话（"UI优化"打偏、b8b0a6d 跨会话）。
 *   CATSTUDY_FORCE_DELIVER=1  强制投递：跳过 `docs/run/**` 免审豁免（票乙）。
 *                         **钩子永不设**——只有人工在 shell 里显式 export 才为真；
 *                         用 CATSTUDY_SESSION_ID 当这个信号是错的（它常驻，见
 *                         `isForceDeliver` 注释）。
 *   HANDOFF_VERIFY_MS    落库验证轮询预算（默认 10000ms，测试可调小）
 */

import { randomUUID } from 'node:crypto'
import { execSync } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync, unlinkSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ─── 投递状态文件 ─────────────────────────────────────────
// 按 commit SHA 幂等记录投递结果，取代"内容字节"去重锚点（重复投递根治计划 A+D）。
// 与 .push-gate / .handoff-draft.md 并列在仓库根，已加入 .gitignore。

const STATE_FILE = '.handoff-delivered.json'

/** 落库验证轮询预算（ms）。调用时惰性读取 env——测试可在 import 之后调小 */
function verifyBudgetMs() {
  return Number(process.env.HANDOFF_VERIFY_MS) || 10000
}

// ─── Public API ─────────────────────────────────────────────

/**
 * @param {Object} opts
 * @param {string} [opts.cwd]      仓库路径，默认 process.cwd()
 * @param {string} [opts.range]    git diff 范围，默认 'HEAD~1..HEAD'
 * @param {string} [opts.sha]      指定目标 commit（pending 补投用——文档从 git 按 SHA
 *                                 确定性重新生成，commitMsg/stat/shortHash 都指向该
 *                                 commit 而非 HEAD）。与 range 同传时两者一致（sha~1..sha）。
 * @returns {string|null} 生成的 markdown 内容，无改动时返回 null
 */
export function generateHandoff(opts = {}) {
  const cwd = opts.cwd || process.cwd()
  const range = opts.range || 'HEAD~1..HEAD'
  const target = opts.sha || 'HEAD'

  // 验证仓库
  if (!existsSync(join(cwd, '.git'))) {
    throw new Error(`不是 git 仓库: ${cwd}`)
  }

  // 验证 target 有效
  let targetExists = true
  try {
    execSync(`git rev-parse ${target}`, { cwd, stdio: 'pipe' })
  } catch {
    targetExists = false
  }
  if (!targetExists) {
    console.log('[handoff-gen] 仓库尚无目标 commit，跳过')
    return null
  }

  // pending 补投：range 跟随 target（sha~1..sha），保证审查须知行指向正确 commit。
  // T-H ② 裁决：**只看 target 这一个 commit**，不回溯扩展到同一 uuid 的整段——理由
  // 与实测证据见文件头（回溯会裹进兄弟票，而「一条消息 @ 两只猫」是常态）。
  const effectiveRange = opts.sha ? `${opts.sha}~1..${opts.sha}` : range

  // 处理初始 commit（无 ~1 父提交）
  let diffFiles
  try {
    diffFiles = git(cwd, `diff --name-status ${effectiveRange}`)
  } catch {
    // 回退：用 git show 获取第一个 commit 的 diff
    console.log('[handoff-gen] 检测到初始 commit，使用 git show')
    diffFiles = git(cwd, `show --name-status --format="" ${target}`)
  }

  if (!diffFiles.trim()) {
    console.log('[handoff-gen] 无文件改动，跳过')
    return null
  }

  const commitMsg = safeGit(cwd, `log -1 --pretty=%B ${target}`) || ''

  // 跳过 merge/revert commit
  // 注意：不再跳过 catstudy [uuid] 自动快照。
  // 死循环已由 git-utils.ts 的 gitCommit() 自然阻断——agent 纯文本回复无文件改动时
  // git commit 非零退出返回 null，post-commit hook 不会触发，循环自限。
  // agent 有实质代码改动的 commit 理应进入 handoff → 审查流程。
  if (commitMsg) {
    const firstLine = commitMsg.split('\n')[0]
    if (/^(Merge|Revert)/.test(firstLine)) {
      console.log('[handoff-gen] merge/revert commit，跳过')
      return null
    }
  }

  const diffStat =
    safeGit(cwd, `diff ${effectiveRange} --stat`) || safeGit(cwd, `show ${target} --stat`) || ''
  const diffBody = safeGit(cwd, `diff ${effectiveRange}`) || safeGit(cwd, `show ${target}`) || ''
  const shortHash = safeGit(cwd, `log -1 --pretty=%h ${target}`) || 'HEAD'

  // 解析文件列表
  const files = parseChangedFiles(diffFiles)

  // 按分层排序
  const sortedFiles = sortByLayer(files)

  // 检测改动类型
  const changeTypes = detectChangeTypes(sortedFiles, diffBody)

  // 生成 What 段
  const whatSection = buildWhatSection(sortedFiles, diffStat, shortHash, commitMsg)

  // 生成 Checklist
  const checklistSection = buildChecklistSection(changeTypes)

  // 组装完整文档
  return [
    '# 工作交接',
    '',
    // 审查须知只给 `git show <sha>` 绝对引用——相对范围（git diff <range>）在
    // HEAD 前进后指向漂移（吐槽猫两次审查点名，391d89a 补填单 + f161728），删掉唯一化。
    // effectiveRange 仍用于上方 diff 提取，仅展示层不再暴露相对引用。
    '> ⚠️ 审查须知：先通读改动对应的完整 diff（`git show ' +
      shortHash +
      '`），再核对本文档——本文档是作者的声明清单，不是事实本身，不要只验证文档声称的点。',
    '',
    '## 1. What — 改了什么',
    '',
    whatSection,
    '',
    '## 2. Why — 关键决策',
    '',
    '<!-- TODO: 补填 — 说明核心设计决策及理由。每个关键决策一个 ### 小标题。',
    '     不要复述 What——要回答"为什么这样做是对的"。 -->',
    '',
    '## 3. Tradeoff — 放弃了什么',
    '',
    '<!-- TODO: 补填 — 用表格列出放弃的方案及原因。',
    '     如果确实没有放弃的方案，写"无"——空段会让 reviewer 不确定你是忘了还是真没有。 -->',
    '',
    '## 4. Open Questions — 不确定的点',
    '',
    '<!-- TODO: 补填 — 每条 OQ 必须点名具体文件/符号，格式：',
    '     "我动了 X（文件/函数/语义），请重点查 Y（调用点/边界/行为）。"',
    '     目的是把 reviewer 的搜索空间从整个 diff 缩到点名的位置。',
    '     真实的不确定性，不是 bug 列表；确认没有则写"无"。 -->',
    '',
    '## 5. Reviewer Checklist',
    '',
    checklistSection,
    '',
  ].join('\n')
}

// ─── 命令参数解析 ───────────────────────────────────────────

const RANGE_REMOVED = '--range 已移除（Fix C：投递按 commit SHA 幂等，不再生成范围版合并审文档）'

/**
 * flag 白名单：`--name` → { key: opts 键名, value: 是否取值 }。
 * **新增 flag 必须在此登记**——未登记即被下面的兜底拒绝（见 parseArgs）。
 */
const FLAGS = {
  cwd: { key: 'cwd', value: true },
  'fallback-sha': { key: 'fallbackSha', value: true },
  'no-post': { key: 'noPost', value: false },
  'gate-deliver': { key: 'gateDeliver', value: false },
}

/**
 * 解析命令行参数。**未知参数一律抛错**，绝不静默忽略。
 *
 * 为什么必须拒绝而不是忽略：**无参调用 = post-commit 投递路径**（runHandoff 的
 * 兜底分支）。忽略未知参数 → 拼错的 flag / `--help` 会静默落进那条路径并**真发出
 * 一条消息**（2026-09-10 实证：`node scripts/handoff-gen.mjs --help` 投出一条补填
 * 请求 cdc476ba）。`--range` 已因同款理由先行抛错（Fix C），此处把该判据推广到
 * 全部参数：**参数错误的后果不能是「换一条路继续干」**。
 * 同款地，取值型 flag 缺值也必须报错（旧实现 `i + 1 < argv.length` 不成立时静默
 * 跳过 → 参数被悄悄丢掉，等价于没写）。
 *
 * 出口语义：参数错误由 main 分支直接 exit 非 0（区别于运行时失败的 exit 0）。
 */
export function parseArgs(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    // 等号形式 --cwd=/path 与空格形式 --cwd /path 都支持
    const eqMatch = /^--([a-z-]+)(?:=(.*))?$/.exec(arg)
    const key = eqMatch ? eqMatch[1] : null
    if (key === 'range') throw new Error(RANGE_REMOVED)
    const spec = key ? FLAGS[key] : undefined
    if (!spec) {
      throw new Error(`未知参数：${arg}（已知：${Object.keys(FLAGS).join(' / ')}）`)
    }
    if (spec.value) {
      const value = eqMatch[2] !== undefined ? eqMatch[2] : argv[++i]
      if (value === undefined) throw new Error(`${arg} 缺少值`)
      // T-H / N5：取值型 flag 的值**不能以后随 flag 开头**——`--cwd --no-post` 会把
      // `--no-post` 当成 cwd 的值吞掉，写成 `{cwd:'--no-post'}`：本次少传一个 flag，
      // 且畸形值只有撞上后续 git 校验才暴露（`不是 git 仓库`），报错点离病因很远。
      // 值以 `-` 开头一律判参数错误（路径/sha 都不长这样），与「未知参数不静默忽略」同款：
      // **参数错误的后果不能是「换一条路继续干」**。
      if (value.startsWith('-')) {
        throw new Error(`${arg} 的值不能以 - 开头（收到 ${value}）——疑似后随 flag 被当作值吞掉`)
      }
      opts[spec.key] = value
    } else {
      if (eqMatch[2] !== undefined) throw new Error(`${arg} 不接受值（收到 ${eqMatch[2]}）`)
      opts[spec.key] = true
    }
  }
  return opts
}

// ─── Git 工具 ───────────────────────────────────────────────

function git(cwd, cmd) {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim()
}

function safeGit(cwd, cmd) {
  try {
    return execSync(`git ${cmd}`, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim()
  } catch {
    return null
  }
}

// ─── 文件解析 ───────────────────────────────────────────────

/**
 * @param {string} raw — git diff --name-status 输出
 * @returns {Array<{path: string, status: string}>}
 * 导出供单测直接断言 rename 取新路径的语义（票乙 A2）——纯函数，无副作用。
 */
export function parseChangedFiles(raw) {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t')
      const status = parts[0] || 'M'
      // Rename: "R100\told/path.js\tnew/path.js" → parts[2] 是新路径
      if (status.startsWith('R')) {
        return { status, path: parts[2] || parts[1] }
      }
      return { status, path: parts[1] || parts[0] }
    })
}

// ─── 免审白名单（票乙：纯 docs/run/** 提交不发起独立审查轮）─────────
// 在飞过程文档（`docs/run/**`：地图 / 票单 / 派活单）每落一次盘就触发一条无意义
// 审查请求 → 噪声 + 唤醒回环（map Decisions 15/18/25）。
//
// ⚠️ 边界（有意，别当漏改）：免的是**独立审查轮**，不是「上远端」。命中后不进
// `.push-gate`，pre-push 仍按「已审历史」拦——纯 docs 提交随收口批次一次性进
// 已审面，与既有规矩一致。
// ⚠️ 判静默**不记账本**：账本单态 = 「真投过」（见 deliverSha 注释）。记了会把
// server 收尾兜底（--fallback-sha）自己锁死——同一个 SHA 的兜底恰好发生在静默之后。
//
// 落点选在 `deliverSha`（4 个调用点全经此：post-commit / --gate-deliver /
// --fallback-sha / drainPending）⇒ 一处判、全覆盖。放 CLI 三个分支则漏掉
// `drainPending`（被 post-commit 与 gate-deliver 共用）。原拟落点 `review-fallback.ts`
// 已推翻：server 侧拿不到路径清单（要新开同步 git 子进程，该文件明确回避过）。

/**
 * 免审路径前缀清单。**必须带尾斜杠**——这是 `docs/run-x/a.md` 不得命中的唯一保证。
 * 本票只此一个前缀，不扩清单（Out of Scope）。
 */
export const REVIEW_EXEMPT_PREFIXES = ['docs/run/']

/**
 * 纯判据：改动路径**全部**落在免审前缀内 → 判静默（不投递、不记账本、不记 pending）。
 *
 * - 空数组必须判 `false`——`every` 对空集恒真，是陷阱（上游 generateHandoff 已对空
 *   diff 早退，此处**不依赖**它；本函数自己挡）
 * - `null` / `undefined` / 非数组（判据查不动）同样 `false`——静默只在判据明确时发生，
 *   与 `decideHookDelivery(null)`「查不动一律投递」同款精神
 * - 前缀匹配是**字符串前缀**而非路径段：靠常量带尾斜杠保证边界，不在此另写路径归一
 *
 * @param {string[]|null|undefined} paths — 仓库相对路径清单
 * @returns {boolean}
 */
export function isExemptDelivery(paths) {
  return (
    Array.isArray(paths) &&
    paths.length > 0 &&
    paths.every((p) => REVIEW_EXEMPT_PREFIXES.some((pre) => p.startsWith(pre)))
  )
}

/**
 * 强制投递开关（纯函数）：`CATSTUDY_FORCE_DELIVER=1|true` → 跳过免审豁免。
 *
 * 语义仍是**「显式意图 > 自动豁免」**，但信号源换过了——首版拿
 * `CATSTUDY_SESSION_ID` 当前置，审查回炉实测推翻：
 *
 * - 它**不是**「人工显式指定」的标记，而是 server 给每只猫的 CLI 子进程注入的
 *   **常驻变量**（`llm/claude.ts:361`、`llm/opencode.ts:91`、`llm/dsh.ts:94`）；
 * - `.husky/post-commit` 与 `.husky/pre-push` 是裸 `node` 调用，**全量继承**该 env
 *   （`execution/review-fallback.ts:153-158` 正因知道这点才显式 `delete` 它）；
 * - ⇒ 在猫驱动的每次提交/推送上它都为真，做前置等于**把免审豁免整个关死**——
 *   纯 `docs/run/**` 提交照发审查请求，本票的可证伪目标在真实环境下不成立。
 *
 * 换成一个**钩子永不设**的开关：只有人工在 shell 里显式 export 才为真。
 * 取值从宽只认 `1` / `true`（大小写与首尾空白容忍），**不做「非空即真」**——
 * 否则 `CATSTUDY_FORCE_DELIVER=0` 这种手滑会静默变成「强制投递」。
 *
 * @param {string|undefined|null} raw — 原始 env 值
 * @returns {boolean}
 */
export function isForceDeliver(raw) {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase()
  return v === '1' || v === 'true'
}

/**
 * 取单个 commit 的改动路径清单（内部 helper，不导出）。
 * 复用 `parseChangedFiles`（rename 取**新路径**），不另写解析器。
 *
 * 任何异常 → `null` ⇒ **不豁免**（照常投递）——失败方向落在「多投一条」而非
 * 「静默吞掉」，与全文件的「宁可多投不可漏投」一致。
 *
 * 已知边界（留痕，非漏改）：**根 commit**（无 `~1` 父提交）会走异常分支 → null →
 * 不豁免。真实提交恒有父提交，实际不可达；方向也是安全侧（多投一条审查请求）。
 *
 * @param {string} cwd
 * @param {string} fullSha — 完整 SHA
 * @returns {string[]|null}
 */
function changedPathsOf(cwd, fullSha) {
  try {
    return parseChangedFiles(git(cwd, `diff --name-status ${fullSha}~1..${fullSha}`)).map(
      (f) => f.path
    )
  } catch {
    return null
  }
}

/** 分层排序权重 */
const LAYER_ORDER = [
  'shared/',
  'server/src/db/',
  'server/src/routes/',
  'server/src/skills/',
  'server/src/connectors/',
  'server/src/dispatch/',
  'server/src/memory/',
  'server/src/llm/',
  'server/src/',
  'web/',
  'scripts/',
  '.husky/',
  '.claude/',
]

function getLayerRank(filePath) {
  for (let i = 0; i < LAYER_ORDER.length; i++) {
    if (filePath.includes(LAYER_ORDER[i])) return i
  }
  return LAYER_ORDER.length // 未匹配的放最后
}

function sortByLayer(files) {
  return [...files].sort((a, b) => {
    const rankDiff = getLayerRank(a.path) - getLayerRank(b.path)
    if (rankDiff !== 0) return rankDiff
    return a.path.localeCompare(b.path)
  })
}

// ─── What 段生成 ────────────────────────────────────────────

function buildWhatSection(files, diffStat, shortHash, commitMsg) {
  const lines = ['| 文件 | 改动 |', '| --- | --- |']

  for (const f of files) {
    const desc = statusToDesc(f.status)
    lines.push(`| ${f.path} | ${desc} |`)
  }

  const stats = parseDiffStat(diffStat)
  if (stats) {
    lines.push('', `> Commit: ${shortHash}`)
    lines.push(`> Message: ${commitMsg.split('\n')[0]}`)
    lines.push(`> Stats: ${stats}`)
  }

  lines.push(
    '',
    '文件按分层排序（shared → server/db → server/routes → server/connectors → web → scripts → config）。'
  )
  return lines.join('\n')
}

function statusToDesc(status) {
  switch (status[0]) {
    case 'A':
      return '新文件'
    case 'D':
      return '删除'
    case 'M':
      return '修改'
    case 'R':
      return '重命名'
    default:
      return status.length > 1 ? status : '修改'
  }
}

function parseDiffStat(stat) {
  if (!stat) return null
  const lastLine = stat.split('\n').filter(Boolean).pop() || ''
  const match = lastLine.match(/(\d+)\s+files?\s+changed/)
  if (!match) return lastLine
  const insertions = lastLine.match(/(\d+)\s+insertions?/)
  const deletions = lastLine.match(/(\d+)\s+deletions?/)
  let result = `${match[0]}`
  if (insertions) result += `, ${insertions[0]}`
  if (deletions) result += `, ${deletions[0]}`
  return result
}

// ─── 改动类型检测 ──────────────────────────────────────────

/**
 * 检测改动类型，返回匹配的 Checklist 项。
 * 规则顺序有优先级——先到的规则先匹配，避免重复检查项。
 */
function detectChangeTypes(files, diff) {
  /** @type {Map<string, string[]>} */
  const typeChecks = new Map()

  for (const rule of CHANGE_TYPE_RULES) {
    if (rule.detect(files, diff)) {
      for (const check of rule.checks) {
        if (!typeChecks.has(rule.type)) {
          typeChecks.set(rule.type, [])
        }
        typeChecks.get(rule.type).push(check)
      }
    }
  }

  // 检查是否有 cat-study 项目特有检查点需要加入
  const catStudyChecks = detectCatStudyChecks(files, diff)
  if (catStudyChecks.length > 0) {
    typeChecks.set('cat-study 项目特有', catStudyChecks)
  }

  return typeChecks
}

const CHANGE_TYPE_RULES = [
  {
    type: '正则 / 字符串匹配',
    detect: (_files, diff) =>
      /\bnew\s+RegExp\b/.test(diff) ||
      /\bescapeRegex\b/.test(diff) ||
      (/[^.\w]\.test\(/.test(diff) && /\/.*\/[gimsu]*/.test(diff)),
    checks: [
      '正则是否覆盖 CJK 字符边界？（`\\b` 对中文不生效）',
      '是否有 ReDoS 风险？（嵌套量词、回溯爆炸）',
      '特殊字符是否正确 escape？（`escapeRegex` 或等价处理）',
      '空字符串 / 纯空白 / 超长输入是否处理？',
    ],
  },
  {
    type: 'DB migration',
    detect: (files, _diff) =>
      files.some((f) => f.path.includes('db/index.ts')) ||
      files.some((f) => f.path.includes('migration')),
    checks: [
      '迁移是否幂等（重复执行不报错）？',
      '存量数据的默认值是否正确？',
      '是否有对应的回滚方案？',
      '新增列的约束（NOT NULL / DEFAULT）和旧数据兼容？',
    ],
  },
  {
    type: 'DB migration',
    detect: (_files, diff) => /\bALTER\s+TABLE\b/i.test(diff) || /\bCREATE\s+TABLE\b/i.test(diff),
    checks: [], // 已在上方添加
  },
  {
    type: '状态管理 / 生命周期',
    detect: (files, _diff) =>
      files.some(
        (f) =>
          f.path.includes('dispatch/') ||
          f.path.includes('socketio.ts') ||
          f.path.includes('retractionRequests')
      ),
    checks: [
      '新增字段在所有退出路径是否都设值/清理？',
      '是否有竞态窗口？（两个 async 操作之间的间隙）',
      '资源（timer / listener / stream / interval）是否正确释放？',
      '异常路径是否也执行了清理？',
    ],
  },
  {
    type: 'API endpoint',
    detect: (files, _diff) =>
      files.some((f) => f.path.includes('routes/') && !f.path.includes('test')),
    checks: [
      '参数校验是否完整（Zod / 手动）？',
      '错误响应是否包含有用信息（而非裸 500）？',
      '向后兼容是否保证？',
      'REST verb 和路径是否符合项目约定？',
    ],
  },
  {
    type: '前端组件',
    detect: (files, _diff) => files.some((f) => f.path.includes('web/')),
    checks: [
      '空态（无数据）是否正确展示？',
      '加载态（fetching）是否有指示？',
      '错误态（请求失败）是否有用户提示？',
      '是否需要 AbortController（组件卸载时取消进行中的请求）？',
      '`watch` / `onMounted` / event listener 是否在 `onUnmounted` 中清理？',
    ],
  },
  {
    type: '环境变量 / 配置解析',
    detect: (_files, diff) =>
      /\bprocess\.env\./.test(diff) ||
      /\bparseInt\(/.test(diff) ||
      /\bparseFloat\(/.test(diff) ||
      /\bisNaN\(/.test(diff),
    checks: [
      '`parseInt` / `parseFloat` 结果是否做了 `isNaN` 校验？',
      '默认值是否合理？',
      '是否有对应 `.env.example` 更新？',
    ],
  },
  {
    type: '类型 / 接口变更',
    detect: (files, _diff) =>
      files.some(
        (f) =>
          f.path.includes('types.ts') || f.path.includes('schemas.ts') || f.path.includes('shared/')
      ),
    checks: [
      '`null` / `undefined` 是否区分处理？',
      '类型收窄是否完整？',
      'Zod schema 和 TypeScript 类型是否一致？',
    ],
  },
  {
    type: '事件 / 消息',
    detect: (files, _diff) =>
      files.some((f) => f.path.includes('socketio') || f.path.includes('connectors')) ||
      /\bEvents\.\w+/.test(_diff),
    checks: [
      '事件名是否使用 `Events` 常量而非裸字符串？',
      'room / channel 名称前后端是否一致？（前缀、分隔符）',
      '是否有对应的事件监听者？',
    ],
  },
  {
    type: 'LLM / Prompt 变更',
    detect: (files, _diff) =>
      files.some(
        (f) =>
          f.path.includes('seed-data') ||
          f.path.includes('skills/') ||
          f.path.includes('systemPrompt') ||
          f.path.includes('system_prompt')
      ),
    checks: [
      'seed-data 改了 prompt → 是否确认 `pnpm seed` 后 DB 中的实际 prompt 已更新？',
      'system prompt 精简后是否丢掉了必需的格式约束？（如 @mention 行首规则）',
      '新增/修改 skill 内容是否和对应 manifest.json trigger 同步？',
    ],
  },
  {
    type: 'Shell 脚本',
    detect: (files, _diff) =>
      files.some(
        (f) =>
          f.path.includes('.husky/') ||
          (f.path.includes('scripts/') &&
            (f.path.endsWith('.sh') || f.path.endsWith('.js') || f.path.endsWith('.mjs')))
      ),
    checks: [
      'Windows Git Bash 兼容性？（CRLF 行尾、`findstr` vs `grep`、`xargs` 参数差异）',
      '空输入 / 无效输入是否正确处理？（如 `.push-gate` 空文件绕过）',
      '`trap` / 信号处理是否清理了临时文件和子进程？',
    ],
  },
  {
    type: '新增 repository 方法',
    detect: (files, _diff) => files.some((f) => f.path.includes('repository/')),
    checks: [
      '方法签名和调用方参数类型是否一致？',
      '`SELECT *` 返回类型是否和 `MessageRow` / `AgentRow` 匹配？',
      '新增方法是否在 `db/repository/index.ts` 中 re-export？',
      '是否有对应测试覆盖？返回空集 / 不存在记录的行为是否明确？',
    ],
  },
]

// ─── cat-study 特有检查点检测 ───────────────────────────────

/** @returns {string[]} */
function detectCatStudyChecks(files, diff) {
  const checks = []

  // 检查是否存在 AGENT_SKILL_MODULES 硬编码
  if (
    diff.includes('AGENT_SKILL_MODULES') ||
    diff.includes('skillModules') ||
    diff.includes('skill_modules')
  ) {
    checks.push('`AGENT_SKILL_MODULES` 硬编码是否已清除？（改用 DB `skill_modules` 列）')
    checks.push('`parseSkillModules` / `parseJsonArray` 是否有重复实现？')
  }

  // dispatch / socketio 改动的特有检查
  if (files.some((f) => f.path.includes('dispatch/') || f.path.includes('socketio'))) {
    if (!checks.some((c) => c.includes('retractionRequests'))) {
      checks.push(
        '`retractionRequests` Map 在所有退出路径是否正确清理？（Window ② 提前 return、Window ③ abort return、超时路径）'
      )
    }
    if (!checks.some((c) => c.includes('activeStreams'))) {
      checks.push('`activeStreams` Map 的 delete 是否和 `retractionRequests.delete` 配对？')
    }
    checks.push('`agentSlots` 的 `currentTriggerMessageId` 是否在所有状态变更点更新？')
    checks.push(
      'Socket.IO room 前缀一致性 — `socket.join(`session:${id}`)` vs `io.to(id)` 是否对齐？'
    )
    checks.push("Window ②（流式前）撤回保护 — 是否因 `role = 'user'` 硬编码误杀 A2A 路径？")
  }

  // Redis / bridge 相关
  if (diff.includes('emitViaBridge') || diff.includes('Redis') || diff.includes('redis')) {
    checks.push(
      'Redis 不可用时 dispatch 状态变更 — 是否有桥接 fallback？（`emitViaBridge` / Socket.IO 直接广播）'
    )
  }

  // seed.ts 改动
  if (files.some((f) => f.path.includes('seed.ts'))) {
    checks.push(
      '`seed.ts --reset` 流程 — 表删除顺序是否符合 FK 依赖？（memories → messages → execution_logs → sessions → agents）'
    )
  }

  // env var 解析
  if (diff.includes('parseInt') && diff.includes('||')) {
    checks.push(
      "`parseInt('0') || default` 零值被吞？含 `parseInt` / `parseFloat` 的 env var 解析是否用 `isNaN` 校验？"
    )
  }

  // pre-push / .push-gate 改动
  if (files.some((f) => f.path.includes('.husky/') || f.path.includes('.push-gate'))) {
    checks.push('`.push-gate` / pre-push hook — 空文件 / 无效 SHA / 仅空白字符是否被正确拦截？')
  }

  // 前端改动
  if (files.some((f) => f.path.includes('web/'))) {
    checks.push(
      '前端 store action 失败时是否清理了 `pending*` 状态？（`pendingHandoffSummary` 等）'
    )
  }

  // agent 相关改动
  if (files.some((f) => f.path.includes('agent'))) {
    checks.push('`messages.agent_id` 无 FK 约束 → 级联删除是否手动覆盖？')
  }

  // 占位符
  if (diff.includes('@作者') || diff.includes('@author')) {
    checks.push('`@作者` 占位符 — 用户触发路径（非 A2A）是否被替换为实际用户名？')
  }

  return checks
}

// ─── Checklist 段生成 ──────────────────────────────────────

function buildChecklistSection(changeTypes) {
  const lines = []

  if (changeTypes.size === 0) {
    lines.push('<!-- handoff-gen 未检测到匹配的改动类型，请手动补填 Checkist -->')
    return lines.join('\n')
  }

  for (const [type, checks] of changeTypes) {
    if (checks.length === 0) continue
    lines.push(`### ${type}`)
    lines.push('')
    for (const check of checks) {
      lines.push(`- [ ] ${check}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

// ─── cat-study 投递 ──────────────────────────────────────────

/**
 * 从 commit message 提取 catstudy [uuid] 中的消息 id。
 * uuid 即触发消息 id（socketio.ts gitCommit 用 `catstudy [${triggerMsg.id}]` 生成）。
 * 非自动快照 commit（手动提交）返回 null——这类 commit 走 fallback 链。
 * @param {string} commitMsg — git log -1 --pretty=%B 输出
 * @returns {string|null}
 */
export function extractCommitUuid(commitMsg) {
  const m = /catstudy\s+\[([0-9a-f-]{36})\]/.exec(commitMsg || '')
  return m ? m[1] : null
}

/**
 * 从最近 commit message 的 uuid 反查触发消息所在会话。
 * GET /api/messages/:id → { sessionId }——永远指向"用户实际发起这条消息的会话"，
 * 比环境变量硬编码（会话重建即失效）和 API 猜第一个（按 updated_at 排序）都准。
 * 反查失败（手动 commit 无 uuid / 消息已删 404 / server 不可达）返回 null 并输出
 * 明确原因——调用方必须**报错不投递**，禁止降级兜底（曾因 404 后静默降级到
 * 环境变量，把审查文档投到错误会话）。
 * @param {string} cwd — 仓库路径
 * @param {string} serverUrl — cat-study server 地址
 * @param {string} [sha] — 指定 commit（pending 补投：旧 commit 的 uuid 反查各自会话；
 *                         缺省为 HEAD）
 * @returns {Promise<string|null>}
 */
export async function resolveCommitSessionId(cwd, serverUrl, sha) {
  const commitMsg = safeGit(cwd, sha ? `log -1 --pretty=%B ${sha}` : 'log -1 --pretty=%B')
  const uuid = extractCommitUuid(commitMsg)
  if (!uuid) {
    console.log(
      '[handoff-gen] ⚠️  commit message 无 catstudy [uuid]（手动提交）——无法反查投递目标，不投递'
    )
    return null
  }
  try {
    const res = await fetch(`${serverUrl}/api/messages/${uuid}`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) {
      console.log(
        `[handoff-gen] ⚠️  commit uuid 反查失败 (HTTP ${res.status})：消息 ${uuid} 不存在或已删除——不投递`
      )
      return null
    }
    const body = await res.json()
    if (body?.sessionId) {
      console.log(`[handoff-gen] 目标会话: ${body.sessionId}（commit uuid ${uuid} 反查）`)
      return body.sessionId
    }
    console.log(`[handoff-gen] ⚠️  反查响应缺少 sessionId（消息 ${uuid}）——不投递`)
  } catch {
    console.log(`[handoff-gen] ⚠️  cat-study server 不可达 (${serverUrl})，无法反查投递目标`)
    // 瞬态故障（典型场景：post-commit 撞上 dev.js 重启窗口，实测停机 ~1.4s）：
    // 抛带标记错误，由调用方按"瞬态 → 延迟重试"处理；404/无 uuid 等确定性失败
    // 仍返回 null（报错不投递，禁止降级兜底）。
    const err = new Error('cat-study server 不可达，反查失败')
    err.code = 'HANDOFF_TRANSIENT'
    throw err
  }
  return null
}

/**
 * 投递去重：这份交接文档（实际投递的完整消息内容）是否已在此会话投过。
 *
 * 背景：post-commit 每 commit 必投递，commit 由自动化流程产生、频率不可控，
 * 同一份文档曾被投 8+ 次（5253e8c 的补填请求反复进队列）。去重检查在 POST 前
 * 拉取目标会话最近消息，若存在内容完全相同的消息则跳过。
 *
 * 锚点必须是**实际投递的包裹消息**（buildHandoffMessage 产物）而非原始 markdown——
 * 会话里存的是包裹后的完整消息，旧实现拿原始 markdown 比包裹消息，逐字节永不相等，
 * 去重实为死代码（"投 8+ 次"的放大器之一）。状态文件（delivered）是主防线，
 * 这里是状态文件丢失后的内容级兜底。
 *
 * 检查失败（server 不可达/列表 404）不阻塞投递——宁可多投一次也不漏投。
 *
 * @param {string} serverUrl
 * @param {string} sessionId
 * @param {string} message — 实际投递的完整消息内容（buildHandoffMessage 产物）
 * @returns {Promise<boolean>} 已投递过返回 true
 */
async function alreadyDelivered(serverUrl, sessionId, message) {
  try {
    const res = await fetch(`${serverUrl}/api/sessions/${sessionId}/messages?limit=100`, {
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return false
    const msgs = await res.json()
    return (msgs || []).some(
      (m) => m?.role === 'user' && m?.content && m.content.trim() === message.trim()
    )
  } catch {
    console.log('[handoff-gen] ⚠️  去重检查失败（消息列表不可达）——继续投递，宁可多投不可漏投')
    return false
  }
}

/**
 * 日志措辞：这次反查到底是**怎么**命中的（T-M 取证陷阱修复）。
 *
 * 旧实现写的是 `${commitSha ? ', commit_hash 精确匹配' : ''}`——只要调用方传了
 * commitSha 就无条件打"精确匹配"，**哪怕服务端根本没按 hash 命中、退回了 uuid 反查**。
 * 于是排障时看到的那行日志正好把"回退猜的"说成"精确匹配的"：归属是猜的，日志说不是。
 * 现在只认服务端回报的 `matchedBy`，拿不到就**明说不知道**——宁可少说，不可谎报。
 *
 * @param {'commit'|'trigger'|undefined} matchedBy — 服务端回报的命中方式
 * @param {string} [commitSha] — 调用方是否带过 commit
 * @returns {string} 可直接拼进括号的片段（含前导分隔符，空串表示无需补充）
 */
export function describeExecutorMatch(matchedBy, commitSha) {
  if (matchedBy === 'commit') return ', commit_hash 精确匹配'
  if (matchedBy === 'trigger') {
    return commitSha ? ', commit_hash 未命中→回退触发消息反查' : ', 按触发消息反查'
  }
  return commitSha ? '，匹配方式未知（服务端未回报 matchedBy）' : ''
}

/**
 * 反查"实施者"——执行触发消息的 agent 名（交接文档补填人）。
 * GET /api/messages/:uuid/executor?commit=<sha> → { agentName, taskId, matchedBy, ambiguous }。
 * 带 commitSha 时服务端**优先**按 execution_logs.commit_hash 精确匹配——同 uuid 多
 * 执行者（一封派活消息触发多只猫）各 commit 各命中各的实施者，根治
 * "取最近开始执行"误指；hash 未命中（老 commit 没写回 hash）或没传 commitSha 时
 * 回退触发消息反查。回退**不等于**精确命中——措辞按 `matchedBy` 走
 * （`describeExecutorMatch`）。
 * 多执行者且消歧不了时服务端回 `ambiguous: true`（agentName 为 null）→ 这里返回
 * null，调用方兜底 @店长（T-M：**不猜**）。
 *
 * 任何失败都返回 null 而非抛出：补填人反查是增强不是硬依赖——
 * 目标会话反查（resolveCommitSessionId）才是主链，它失败已由调用方 fatal/transient
 * 处理；此处失败兜底 @店长 即可，不值得为此阻断投递。
 *
 * 返回对象含 taskId（= 命中执行行的 trace_id）：E3 接线——投递 payload 携带源链
 * task_id（与 chain_task_id 同源反查 commit_hash → execution_logs → trace_id），
 * 审查回复落库 task_id = 源链 trace_id，verdict JOIN m.task_id = chain_task_id 才匹配。
 * taskId 缺失（反查失败/无执行记录/执行行 trace_id 为空）→ undefined——调用方
 * (`attemptDeliver`) 据此自铸锚，不再「无锚硬投」（T-F 必改 1：无锚载荷必被入口 400 拒）。
 *
 * @param {string} serverUrl
 * @param {string} uuid — commit message 里的 catstudy [uuid]（触发消息 id）
 * @param {string} [commitSha] — 当前 commit 完整 sha（commit_hash 精确匹配用）
 * @returns {Promise<{agentName: string, taskId?: string}|null>} 无执行记录/不可达 → null
 */
export async function resolveExecutorName(serverUrl, uuid, commitSha) {
  try {
    const url = commitSha
      ? `${serverUrl}/api/messages/${uuid}/executor?commit=${encodeURIComponent(commitSha)}`
      : `${serverUrl}/api/messages/${uuid}/executor`
    const res = await fetch(url, {
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) {
      console.log(`[handoff-gen] ⚠️  实施者反查失败 (HTTP ${res.status})——兜底 @店长 补填`)
      return null
    }
    const body = await res.json()
    if (body?.agentName) {
      console.log(
        `[handoff-gen] 实施者: ${body.agentName}（execution_logs 反查${describeExecutorMatch(body.matchedBy, commitSha)}）`
      )
      const taskId = typeof body.taskId === 'string' && body.taskId ? body.taskId : undefined
      if (taskId) {
        console.log(
          `[handoff-gen] 源链 taskId: ${taskId.slice(0, 8)}…（投递 payload 携带，E3 接线）`
        )
      } else {
        console.log(`[handoff-gen] ⚠️  反查响应缺 taskId——投递时自铸锚（T-F 必改 1）`)
      }
      return { agentName: body.agentName, taskId }
    }
    // T-M：有执行行但指不出唯一执行者（同 uuid 多执行者，按 commit 也消歧不了）——
    // 服务端已明确回报。这是**兜底 @店长**，不是"反查不可用"，日志必须分开，
    // 否则排障时会把"归属指不出来"误读成"server 挂了"。
    if (body?.ambiguous === true) {
      console.log(
        `[handoff-gen] ⚠️  归属不可消歧（同 uuid 多执行者，commit_hash 也指不出唯一实施者）——兜底 @店长 补填`
      )
      return null
    }
    console.log(`[handoff-gen] ⚠️  实施者反查响应缺少 agentName——兜底 @店长 补填`)
  } catch {
    console.log(`[handoff-gen] ⚠️  cat-study server 不可达，实施者反查失败——兜底 @店长 补填`)
  }
  return null
}

/**
 * 构造投递消息：@实施者 补填 TODO → 补完后 @吐槽猫 审查。
 * 与 pre-push 曾投的"裸草稿 + mentions:["吐槽猫"]"不同——统一为补填请求形状，
 * 全部投递路径共用这一个形状。
 * @param {string} content — 完整交接文档 markdown
 * @param {string} [fillerName='店长'] — 补填人（实施者反查未命中时兜底店长）
 */
export function buildHandoffMessage(content, fillerName = '店长') {
  return [
    `@${fillerName} 请补填以下交接文档中 TODO 标注的部分（Why / Tradeoff / Open Questions）。`,
    '',
    '补填规则：',
    '- **Why**（关键决策）：从 commit message 和文件改动推导每个关键决策及理由。不要复述 What——要回答"为什么这样做是对的"。',
    '- **Tradeoff**（放弃了什么）：如果放弃过其他方案，用表格列出方案及原因。确认没有则写"无"——空段会让 reviewer 不确定你是忘了还是真没有。',
    '- **Open Questions**（不确定的点）：每条必须点名具体文件/符号——"我动了 X 的语义，请重点查 Y"。把吐槽猫的搜索空间从整个 diff 缩到点名的位置。真实的不确定性，不是 bug 列表；确认没有则写"无"。',
    '',
    '补完后在**末尾行首独占一行** @吐槽猫 进行代码审查，并在审查请求中附上审查须知：**先通读完整 diff 再核对本文档**——本文档是声明清单不是事实本身，不要只验证文档声称的点。',
    '',
    '---',
    '',
    content,
  ].join('\n')
}

/**
 * 落库验证（重复投递根治计划 Fix B 的核心）：POST 超时/5xx 后轮询目标会话最近消息，
 * 以"消息是否客观落库"判定投递是否成功。
 *
 * 为什么轮询而不是立即判失败：消息写入顺序是 write → broadcast → dispatch，
 * dispatch 在 slot idle 时同步等待 agent 完整回复（分钟级），POST 的 5s 超时必然
 * abort——但消息其实早已落库。验证把成功判定从"网络往返及时返回"改成"客观落库"，
 * 误判失败→草稿滞留→重投的循环被结构性切断。
 *
 * 与 alreadyDelivered 的区别：不吞错——server 持续不可达要抛出来转瞬态重试，
 * 而不是视为"没投过"。
 *
 * @param {string} serverUrl
 * @param {string} sessionId
 * @param {string} message — 实际 POST 的消息内容（buildHandoffMessage 产物）
 * @returns {Promise<boolean>} 消息已落库 → true；轮询耗尽仍未落库 → false
 * @throws 首次请求即连接失败（server 不可达）或轮询期间持续不可达——调用方转 transient
 */
async function verifyDelivered(serverUrl, sessionId, message) {
  const budget = verifyBudgetMs()
  const deadline = Date.now() + budget
  let lastErr = null
  let first = true
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${serverUrl}/api/sessions/${sessionId}/messages?limit=100`, {
        signal: AbortSignal.timeout(3000),
      })
      if (res.ok) {
        const msgs = await res.json()
        if (
          (msgs || []).some(
            (m) => m?.role === 'user' && m?.content && m.content.trim() === message.trim()
          )
        ) {
          console.log('[handoff-gen] ✅ 落库验证命中——消息已投递到目标会话')
          return true
        }
        lastErr = null // 服务器可达但消息未落库 → 继续等
      } else {
        lastErr = new Error(`HTTP ${res.status}`)
      }
    } catch (err) {
      if (first) throw err // 首次请求就连接失败 → server 不可达，不空等轮询预算
      lastErr = err
    }
    first = false
    await new Promise((r) => setTimeout(r, 1000))
  }
  if (lastErr) throw lastErr
  console.log(`[handoff-gen] ⚠️  落库验证超时（${budget}ms）——消息未出现在目标会话，判定投递失败`)
  return false
}

/**
 * POST 后的不确定结果（超时/连接失败/5xx）统一走落库验证。
 * @returns {Promise<'ok'|'transient'>}
 */
async function verifyOrTransient(serverUrl, sessionId, message) {
  try {
    const ok = await verifyDelivered(serverUrl, sessionId, message)
    return ok ? 'ok' : 'transient'
  } catch {
    return 'transient'
  }
}

/**
 * T-H ①（2026-09-10）归属探针：该触发消息 uuid 是否存在**任一状态**的执行行。
 *
 * 为什么必须问「任一状态」而不是「running 命中行数」（T-A OQ-1 的假阴性，本票
 * 的靶心）：running 命中数把三个不同事实压成同一个 0——
 *   ① 该 uuid **从无执行行** → 真·用户手动提交 → 该投；
 *   ② 执行**已终态**（猫在收尾后才提交 / `--amend` / 收尾竞态）→ agent 提交 → 该静默；
 *   ③ **同 uuid 同猫并发另一条在跑**（写回按 agentId 精确命中，落到别人行上）→ 同上。
 * 后两者被判「无归属」→ 钩子多投一条 → 正是 T-A 要止住的「白起一轮」。
 *
 * 判据源 = `GET /api/messages/:id/executor`：**200 即「存在可反查执行行」**——
 * 反查不带 status 过滤（`db/repository/executionLogs.ts`），恰是归属的定义。
 *
 * ⚠️ T-M 起 `agentName` 非空**不再是**「有执行行」的同义词：同 uuid 多执行者且
 * 消歧不了时，端点回 **200 + `agentName: null` + `ambiguous: true`**（不是 404 —
 * 404 在本函数语义里是"无归属"，那会把有归属的 agent 提交判成钩子该兜底 → 多投
 * 一轮，正是 T-A / T-H 要止住的"白起一轮"）。故这里必须显式认 `ambiguous`：
 * 它是"有执行行"的**直接证据**（服务端只在有行时才回它）。
 *
 * 与写回响应的关系：写回命中 running 行（`updated > 0`）是归属的**充分条件**，
 * 调用方据此短路、不调本探针；`updated === 0` 才落到这里（三种可能见上）。
 *
 * 三态（③ 降级语义：判据查不动一律投递，不静默吞）：
 *   true  200 且有 agentName            → 有归属（存在执行行）→ 不投
 *   true  200 且 ambiguous === true     → 有归属（存在执行行，只是指不出人）→ 不投
 *   false 404                           → 无归属（从无执行行）  → 投
 *   null  其他 HTTP / 不可达 / 响应不可解析 → 查不动 → 投
 *
 * 已知窄口径（失败方向安全，不是穷尽）：executor 端点 INNER JOIN agents，agent 行
 * 被删则 404 → 判「无归属」→ 多投一条（`hasExecutorRowsForTrigger` 同口径，T-M 起
 * 仍如此）。多投是本判据的**安全方向**（宁可多投不可漏投），与 ③ 降级同向，
 * 故不为此加路径。
 *
 * @param {string} serverUrl
 * @param {string} uuid — commit message 里的 catstudy [uuid]
 * @returns {Promise<boolean|null>}
 */
export async function probeAttribution(serverUrl, uuid) {
  try {
    const res = await fetch(`${serverUrl}/api/messages/${encodeURIComponent(uuid)}/executor`, {
      signal: AbortSignal.timeout(3000),
    })
    if (res.status === 404) return false
    if (!res.ok) return null
    const body = await res.json().catch(() => null)
    // T-M：有执行行但指不出唯一执行者 —— 服务端只在**有行**时才回 ambiguous，
    // 故它是"有归属"的直接证据（不投）。
    if (body && body.ambiguous === true) return true
    // 200 但响应缺 agentName（端点契约变了 / 被代理改写）→ 不假装它是「有归属」，
    // 也不假装是「无归属」——查不动，走降级投递。
    return body && typeof body.agentName === 'string' && body.agentName ? true : null
  } catch {
    return null
  }
}

/**
 * T-A ①（2026-09-10）钩子侧归属判据：这个 commit 该不该由 post-commit 钩子兜底投递。
 * 判据源见 `probeAttribution`（T-H ① 起 = 「该 uuid 是否存在任一状态执行行」；
 * 此前是写回端点返回的 running 命中行数——两者在「执行已终态 / 同猫并发」时结论
 * 相反，那正是 T-H ① 治的假阴性）。
 *
 * 语义：有归属 ⇒ commit 由某只猫提交 ⇒ 审查请求归实施猫自己投（铁律 +
 * request-review），钩子静默（原痛点：钩子每 commit 必投 → 返工每新 SHA 叠一条链）；
 * 无归属 ⇒ 用户在终端手动提交，没有任何猫会替它投，钩子兜底。
 *
 * 三态（③ 降级语义：判据查不动一律投递，不静默吞）：
 *   true  有归属 → 不投
 *   false 无归属 → 投
 *   null  查不动（探针失败 / 响应不可解析）→ 投
 *
 * ⚠️ 与 `.handoff-delivered.json` 的分工（T-A 定死）：账本是「同一 SHA 是否已投过」
 * 的幂等锁（键=SHA），本判据是「该不该由钩子投」的归属判定（源=执行行）——两者
 * 不同源，账本无法表达归属，故不合并、不互相替代。
 *
 * @param {boolean|null} attributed — 该 commit 是否有归属执行
 * @returns {{ deliver: boolean, reason: string }}
 */
export function decideHookDelivery(attributed) {
  if (attributed === true) {
    return {
      deliver: false,
      reason: '该 commit 有归属执行（agent 提交）——实施猫负责主动投递，钩子静默',
    }
  }
  if (attributed === false) {
    return { deliver: true, reason: '该 commit 无归属执行（用户手动提交）——兜底投递' }
  }
  return { deliver: true, reason: '归属判据查不动——一律投递（不静默吞）' }
}

/**
 * 单次投递尝试：确定目标会话 + POST 交接文档。
 *
 * @param {string} content — 完整的交接文档 markdown
 * @param {string} cwd — 工作目录
 * @param {string} serverUrl — cat-study server 地址
 * @param {Object} [opts]
 * @param {string} [opts.sha] — 目标 commit（pending 补投时传旧 commit SHA，
 *                              反查该 commit 自己的 uuid 所在会话；缺省为 HEAD）
 * @returns {Promise<'ok'|'transient'|'fatal'|'skip'>}
 *   ok       — 投递成功（POST 2xx，或超时/5xx 后落库验证命中）
 *   transient— 瞬态故障（连接失败 / 5xx / 落库验证未命中），调用方可延迟重试
 *   fatal    — 确定性失败（无 uuid / 404 / 4xx），重试无意义
 *   skip     — T-A ① 归属判据判静默（有归属，审查请求归实施猫自己投），非错误
 */
async function attemptDeliver(content, cwd, serverUrl, opts = {}) {
  // 获取 session ID：CATSTUDY_SESSION_ID（人工显式指定，明确意图优先）
  // → commit uuid 反查（自动，永远指向"用户实际发起这条消息的会话"）。
  // 原则：两者都不可用时**报错不投递**——绝不猜目标。曾因反查失败静默降级到
  // 环境变量/含店长会话/API 第一个，把审查文档投到错误会话（"UI优化"打偏、
  // b8b0a6d 跨会话事故），错误的投递比不投递更糟。
  let sessionId = process.env.CATSTUDY_SESSION_ID
  if (sessionId) {
    console.log(`[handoff-gen] 目标会话: ${sessionId}（CATSTUDY_SESSION_ID 人工显式指定）`)
  } else {
    try {
      sessionId = await resolveCommitSessionId(cwd, serverUrl, opts.sha)
    } catch (err) {
      if (err?.code === 'HANDOFF_TRANSIENT') return 'transient'
      throw err
    }
  }

  if (!sessionId) {
    console.log('[handoff-gen] ❌ 无法确定投递目标会话（反查失败且未人工指定 CATSTUDY_SESSION_ID）')
    console.log('  .handoff-draft.md 已生成但**未投递**——草稿滞留，等门禁重试或人工处理')
    console.log('  处置：确认 cat-study server 运行、commit 含 catstudy [uuid]，')
    console.log('        或显式设置 CATSTUDY_SESSION_ID 后重新生成投递')
    return 'fatal'
  }

  // 构造消息：@实施者 补填 TODO → 补完后 @吐槽猫（所有投递路径共用这一形状）。
  // 实施者 = execution_logs 反查"执行触发消息的 agent"——转派场景下触发消息是
  // 店长的派活消息，执行者是实施猫；反查 sender 会派错人。未命中（手动提交
  // 无 uuid / 无执行记录）兜底店长收尾。
  const commitMsg = safeGit(cwd, opts.sha ? `log -1 --pretty=%B ${opts.sha}` : 'log -1 --pretty=%B')
  const commitUuid = extractCommitUuid(commitMsg)
  const commitSha = safeGit(cwd, opts.sha ? `rev-parse ${opts.sha}` : 'rev-parse HEAD')

  // 补填风暴根治方向 1：该 commit 已审 ✅ → 跳过补填投递。hook 每 commit 必投、
  // 去重键只防同 SHA、hook 不查审查结论——已闭环提交照样被反复补填（收口批次
  // 扎堆 8 个 SHA 各投一次 + 补填请求反复进队列的第四层因果）。
  // 失败语义钉死：端点不可达/超时/HTTP 错误 → 静默降级照常投递——verdict 查询是
  // 纯优化，宁多投不丢补填（补填是审查链必需环节，多投只是噪音、少投丢审查）。
  if (commitSha) {
    try {
      const res = await fetch(`${serverUrl}/api/handoff/verdict?sha=${commitSha}`, {
        signal: AbortSignal.timeout(3000),
      })
      if (res.ok) {
        const body = await res.json()
        if (body?.approved) {
          console.log(
            `[handoff-gen] ⏭️  该 commit 已审 ✅（${commitSha.slice(0, 7)}）——跳过补填投递（verdict 反查命中 approve）`
          )
          return 'ok'
        }
      } else {
        console.log(
          `[handoff-gen] ⚠️  verdict 反查异常 (HTTP ${res.status})——照常投递（verdict 是纯优化，宁多投不丢补填）`
        )
      }
    } catch {
      console.log(
        `[handoff-gen] ⚠️  verdict 反查失败（server 不可达/超时）——照常投递（verdict 是纯优化，宁多投不丢补填）`
      )
    }
  }
  let fillerName = '店长'
  /** 投递载荷的链锚。两条来路：E3 接线的源链 task_id（executor 反查同源，
   *  commit_hash → execution_logs → trace_id）；取不到则**自铸**（见下方 T-F 必改 1）。 */
  let taskId
  /** T-A ① / T-H ① 归属三态：null=查不动（判据查不动一律投递）；无 uuid = 无归属 */
  let attributed = commitUuid ? null : false
  /** 归属结论的**来源**（留痕用）——两条来路（写回短路 / 探针）不可混称，
   *  否则日志会把没跑过的机制说成跑过（本 spec 一直在治的「陈述假机制」）。 */
  let attributionFrom = commitUuid ? '待定' : 'commit message 无 catstudy [uuid]'
  if (commitUuid) {
    // 写回 commit_hash（agent 人工提交路径此前从不写，只有 socketio 自动提交
    // 兜底写）——executor 反查按 commit 精确匹配的前提。失败仅告警不阻断投递：
    // 老 server 无此端点（404）或 server 不可达时退化 uuid 逻辑 + 兜底店长。
    // 携带 CATSTUDY_AGENT_ID（claude.ts spawn env 注入、post-commit 父进程链
    // 继承）——同 uuid 双 running 行按 agent_id 精确命中自己的行，根治双 running
    // 写回互覆错投（eae5a5e 实害化）；无 env（终端手动提交）不带，服务端 fallback。
    const agentId = process.env.CATSTUDY_AGENT_ID
    try {
      const res = await fetch(`${serverUrl}/api/messages/${commitUuid}/commit-hash`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commitHash: commitSha, ...(agentId ? { agentId } : {}) }),
        signal: AbortSignal.timeout(3000),
      })
      if (res.ok) {
        // 写回响应仍读——但它**不再是归属判据源**（T-H ①：它数的是 running 命中行，
        // 在「执行已终态 / 同猫并发另一条在跑」时为 0，会把 agent 提交误判成手动提交）。
        // 判据改问 probeAttribution（见下）。
        const body = await res.json().catch(() => null)
        const updated = Number(body?.updated)
        // 唯一保留的用法：命中 running 行 ⇒ 该 uuid 的执行行**必然存在** ⇒ 归属成立。
        // 这是**充分条件**（不是判据本身）：真值时短路掉探针那次往返；为 0 时无信息量
        // （终态行 / 并发行 / 真无行三种都可能是 0），交给探针分辨。
        if (Number.isFinite(updated) && updated > 0) {
          attributed = true
          attributionFrom = '写回命中 running 行（充分条件，未打探针）'
        }
        // T-M：跨多只猫且没带 agentId 时服务端**拒写**（0 行是"拒写"，不是"没命中"）。
        // 单独一行日志——两类 0 的后续处置不同（一个去问探针，一个是真没归属线索）。
        //
        // 三态**互斥**：旧实现在拒写告警之后无条件再打一行「已写回 execution_logs
        // （命中 running 行 0）」——相邻两行自相矛盾（上一行「未写回…不猜」/ 下一行
        // 「已写回」）。日志是本票唯一的观测面，自相矛盾的一行会把排障引向
        //「服务端没写」而不是「客户端没带 agentId」——两个完全不同的修法方向。
        if (body?.skippedAmbiguous === true) {
          console.log(
            `[handoff-gen] ⚠️  commit_hash 未写回：同 uuid 多只猫在跑且无 CATSTUDY_AGENT_ID，归属不可消歧——不猜（T-M）`
          )
        } else if (Number.isFinite(updated) && updated > 0) {
          console.log(
            `[handoff-gen] commit_hash 已写回 execution_logs（${(commitSha || '').slice(0, 7)}，命中 running 行 ${updated}）`
          )
        } else {
          // updated 非有限值 = 响应体缺失/非数字（老 server），同样不能说「已写回」
          console.log(
            `[handoff-gen] commit_hash 写回调用成功但命中 0 行（${(commitSha || '').slice(0, 7)}，updated=${body?.updated ?? '未知'}）——无 running 行可写，交探针分辨`
          )
        }
      }
    } catch {
      console.log(
        `[handoff-gen] ⚠️  commit_hash 写回失败——executor 反查退化 uuid 逻辑（兜底 @店长）`
      )
    }
  }
  // 判据**只属于 post-commit 入口**（runHandoff 无其他入口 flag 时传 opts.judgeAttribution；
  // 钩子就是无参调用，不做显式 flag——挂了 flag 而钩子不传 = 判据在生产路径上不跑）。
  // --gate-deliver 补投 与 收尾兜底（--fallback-sha）是独立入口，判据不适用——
  // 前者补的是「当时判定该投但投失败」的 SHA，后者补的是「有归属但猫没投」，
  // 两者都必然有归属，再判一次只会把自己判静默（自己吞掉自己）。
  // 留痕：每次裁决一行日志（投/不投 + 理由 + 探针读数）——本票唯一安全网。
  if (opts.judgeAttribution) {
    // T-H ①：探针单独问一次。写回**必须**在判据之前（静默路径也要记 commit_hash——
    // 收尾兜底与 verdict 反查都靠它），而「任一状态执行行」这个事实写回响应给不了
    // （它只数 running 命中行）→ 模糊情形比 T-A 多一次往返，是买正确性的代价。
    // attributed 已被写回短路成 true（命中 running 行）时不问——那已是充分条件。
    if (commitUuid && attributed === null) {
      attributed = await probeAttribution(serverUrl, commitUuid)
      attributionFrom =
        attributed === null ? '探针查不动' : attributed ? '探针：存在执行行' : '探针：无执行行'
    }
    const verdict = decideHookDelivery(attributed)
    console.log(
      `[handoff-gen] 🔎 兜底投递判据: ${verdict.deliver ? '投递' : '静默'}——${verdict.reason}` +
        `（归属来源：${attributionFrom}）`
    )
    // 返回 'skip' 而非 'ok'：'ok' 会被 deliverSha 记进 delivered 账本，
    // 把这个 SHA 的收尾兜底（--fallback-sha）当场锁死（探针实测：兜底恒被
    // 「已投递过（状态文件）」跳过）。静默不是投递，账本不能记。
    if (!verdict.deliver) return 'skip'
  }
  if (commitUuid) {
    const executorInfo = (await resolveExecutorName(serverUrl, commitUuid, commitSha)) || null
    fillerName = executorInfo?.agentName || '店长'
    // E3 接线：源链 task_id 随投递携带（ingest.ts 已支持 taskId 字段）——审查链
    // verdict 消息与任务链共享 task_id，JOIN 匹配成立。
    taskId = executorInfo?.taskId
  }

  // T-F 必改 1（2026-09-10）：**任何无锚载荷自铸锚**——入口主闸下「有则带、无则不带」
  // 已经不是一个选项。REST 通道固定以 `origin: 'agent'` 摄入（`routes/messages.ts`），
  // 主闸规则 5 对 agent 入口缺 taskId 一律 400；4xx 是确定性失败、不重试，于是文档
  // 直接死掉、连 pending 都不留。原实现恰好在两条路径上不带锚：
  //   ① commit message 无 `catstudy [uuid]`（用户终端手动提交）→ 整个 if 块跳过；
  //   ② 有 uuid 但反查不到执行行（executor 404 / 响应无 taskId）→ `executorInfo?.taskId` 为 undefined。
  // 两条都落在 post-commit 兜底判据的「该投」侧（`decideHookDelivery(false|null).deliver === true`）
  // ——即 spec D5 / 用户故事 14 那条「手动提交补投」边界整条失效。
  // 自铸语义 = **新链首轮**：与「落 NULL → 服务端 `anchor = taskId || traceId` 兜底」
  // 完全等价（同一条兜底规则，只是挪到客户端显式表达），对服务端与被审链零行为变化。
  // 粒度也对齐：服务端每消息生成一次，这里每次投递尝试生成一次（重试即重投，
  // 与「重试可能产生重复消息」的既有语义同源）。
  if (!taskId) {
    taskId = randomUUID()
    console.log(
      `[handoff-gen] 无源链锚（${
        commitUuid ? '有 uuid 但反查未命中 taskId' : 'commit message 无 catstudy [uuid]'
      }）——自铸锚 ${taskId}（语义=新链首轮，等价服务端 traceId 兜底）`
    )
  }
  const message = buildHandoffMessage(content, fillerName)

  // 投递去重：同一份文档已投过则跳过（锚点：实际投递的完整消息）
  if (await alreadyDelivered(serverUrl, sessionId, message)) {
    console.log(
      `[handoff-gen] ⏭️  该交接文档已在此会话中投递过，跳过重复投递 (session: ${sessionId})`
    )
    return 'ok'
  }

  try {
    const res = await fetch(`${serverUrl}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        content: message,
        mentions: [fillerName],
        ...(taskId ? { taskId } : {}),
      }),
      signal: AbortSignal.timeout(5000),
    })

    if (res.ok) {
      console.log(`[handoff-gen] ✅ 交接文档已投递到 cat-study (session: ${sessionId})`)
      console.log(`  ${fillerName} 将自动补填 Why/Tradeoff/OQ → @吐槽猫 审查`)
      console.log('  在 cat-study 会话页面可实时查看审查进度')
      return 'ok'
    }
    const errText = await res.text().catch(() => '')
    console.log(
      `[handoff-gen] ⚠️  投递失败 (HTTP ${res.status}${errText ? ': ' + errText.slice(0, 120) : ''})`
    )
    // 4xx：确定性错误（会话已删 / 请求格式错），重试无意义，不做落库验证
    if (res.status >= 400 && res.status < 500) {
      if (process.env.CATSTUDY_SESSION_ID) {
        console.log(
          '  🔍 目标会话 ID 由 CATSTUDY_SESSION_ID 人工指定——4xx 通常意味着会话已删除或重建'
        )
        console.log('    请将环境变量更新为有效会话 ID 后重试')
      }
      return 'fatal'
    }
    // 5xx：消息可能已落库（write→broadcast→dispatch 顺序，落库先于 dispatch）——
    // 落库验证，命中即视为成功
    return await verifyOrTransient(serverUrl, sessionId, message)
  } catch {
    // 超时/连接失败：POST 可能已到达并落库（dispatch 同步等待拖超时）——落库验证
    console.log(`[handoff-gen] ⚠️  cat-study server 响应超时/不可达 (${serverUrl})——落库验证`)
    return await verifyOrTransient(serverUrl, sessionId, message)
  }
}

/**
 * 将交接文档投递到 cat-study，让店长 agent 自动补填 TODO 部分。
 *
 * 消息格式：@店长 补填 Why/Tradeoff/OQ → 补完后 @吐槽猫 审查。
 * 整个链路不需要用户手动操作。
 *
 * 瞬态重试：投递常撞上 dev.js 重启窗口（agent 完成 → 锁释放 → dev.js 延迟重启，
 * 实测停机 ~1.4s）。连接失败 / 5xx / 落库验证未命中等瞬态故障延迟 2s 重试
 * （最多 2 次）即覆盖；确定性失败（无 uuid / 404 / 4xx）不重试，报错后草稿滞留。
 *
 * @param {string} content — 完整的交接文档 markdown
 * @param {string} [cwd] — 工作目录
 * @param {Object} [opts] — 透传 attemptDeliver（如 { sha, judgeAttribution }）
 * @returns {Promise<'ok'|'transient'|'fatal'|'skip'>} 最后一次尝试的结果
 */
export async function tryPostToCatstudy(content, cwd, opts = {}) {
  const serverUrl = process.env.CATSTUDY_URL || 'http://127.0.0.1:3200'
  const maxAttempts = 3 // 首次 + 2 次重试
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      console.log(
        `[handoff-gen] 投递重试 ${attempt - 1}/${maxAttempts - 1}（2s 后，覆盖 dev.js 重启窗口 ~1.4s）...`
      )
      await new Promise((r) => setTimeout(r, 2000))
    }
    const result = await attemptDeliver(content, cwd, serverUrl, opts)
    if (result !== 'transient') return result
  }
  console.log('[handoff-gen] ❌ 投递重试耗尽——.handoff-draft.md 草稿滞留')
  console.log('  处置：确认 cat-study server 运行后手动重跑 node scripts/handoff-gen.mjs，')
  console.log('        或等待下次投递机会自动补投（pending 队列）')
  return 'transient'
}

// ─── 投递状态文件（Fix A+D：按 commit SHA 幂等） ─────────────

function statePath(cwd) {
  return join(cwd, STATE_FILE)
}

/**
 * 读取状态文件；缺失/损坏一律视作空状态（退化"首次投递"，宁可多投不可漏投）。
 * raw 字段 = 盘上原文，作为 writeState 合并的基线（判断是否有并发进程改动过）。
 * 导出供 e2e 直接测合并语义（并发写场景确定性断言）。
 */
export function readState(cwd) {
  let raw = ''
  try {
    raw = readFileSync(statePath(cwd), 'utf-8')
    const parsed = JSON.parse(raw)
    return {
      delivered: parsed?.delivered && typeof parsed.delivered === 'object' ? parsed.delivered : {},
      pending: Array.isArray(parsed?.pending) ? parsed.pending : [],
      raw,
    }
  } catch {
    return { delivered: {}, pending: [], raw }
  }
}

/**
 * 写状态文件：tmp + rename 原子替换（半写不可见）。
 *
 * 写前重读盘上内容，与 state.raw（本进程的读取基线）对比合并——post-commit 与
 * 自动快照的 post-commit 会并发运行（实测事故 2026-08-01：一个进程的 3 次重试
 * 窗口 ~15s，期间下一个 commit 的 hook 已启动，直接覆盖会丢掉并发进程刚写入的
 * pending 条目 → 该 commit 文档永不补投）。
 *
 * 合并规则（以基线为准，不是无脑并集）：
 * - 盘上相对基线无变化 → 本进程的删除语义权威（prune 移除非祖先、fatal 移除
 *   死 pending 不会被盘上旧条目"复活"）
 * - 盘上相对基线有变化 → 只并入"基线里没有、对方新增"的条目（delivered 保留
 *   对方已投成功的记录；pending 保留对方新增的待补投——丢 pending 即丢文档）；
 *   对方删除的条目（基线有、盘上无）尊重，不恢复
 * 残留竞态窗口极小（两进程在对方写入后、rename 前同时读盘，毫秒级），git hooks
 * 由 index.lock 串行化提交，实际不达；最坏退化路径有内容级去重兜底。
 */
export function writeState(cwd, state) {
  const p = statePath(cwd)
  const onDisk = readState(cwd)
  const delivered = { ...state.delivered }
  const pending = [...new Set(state.pending)]
  if (onDisk.raw !== state.raw) {
    // 并发修改：只并入基线里没有的新条目
    const base = JSON.parse(state.raw || '{}') || {}
    const baseDelivered = base.delivered && typeof base.delivered === 'object' ? base.delivered : {}
    const basePending = Array.isArray(base.pending) ? base.pending : []
    for (const sha of Object.keys(onDisk.delivered)) {
      if (!baseDelivered[sha]) delivered[sha] = onDisk.delivered[sha]
    }
    for (const sha of onDisk.pending) {
      if (!basePending.includes(sha) && !delivered[sha]) pending.push(sha)
    }
  }
  const finalPending = pending.filter((sha) => !delivered[sha])
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify({ delivered, pending: finalPending }, null, 2) + '\n', 'utf-8')
  renameSync(tmp, p)
}

/** @param {string} sha — 完整 SHA */
function isAncestorOfHead(cwd, sha) {
  try {
    execSync(`git merge-base --is-ancestor ${sha} HEAD`, { cwd, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/**
 * 历史改写自愈：delivered/pending 中不是当前 HEAD 祖先的 SHA 全部移除。
 * e2e 管道会 reset --hard 改写历史——旧 SHA 已不存在，留着会让状态"超前"、
 * 误跳过新历史中的同内容 commit；清除后按首次投递重新幂等恢复。
 */
function pruneState(cwd) {
  const state = readState(cwd)
  const headSha = safeGit(cwd, 'rev-parse HEAD')
  if (!headSha) return // 仓库无 commit，不动状态
  let changed = false
  for (const sha of Object.keys(state.delivered)) {
    if (!isAncestorOfHead(cwd, sha)) {
      delete state.delivered[sha]
      changed = true
    }
  }
  const kept = state.pending.filter((sha) => isAncestorOfHead(cwd, sha))
  if (kept.length !== state.pending.length) {
    state.pending = kept
    changed = true
  }
  if (changed) {
    writeState(cwd, state)
    console.log('[handoff-gen] ♻️  状态文件已清理失效条目（历史改写自愈）')
  }
}

/** 把 'HEAD' 解析为完整 SHA（pending 条目存的就是完整 SHA） */
function resolveFullSha(cwd, sha) {
  if (sha === 'HEAD') return safeGit(cwd, 'rev-parse HEAD')
  return sha
}

/**
 * 投递单个 commit 的文档并更新状态（Fix A+D 的单一状态入口）。
 *
 * - delivered 命中 → 跳过（幂等；CATSTUDY_SESSION_ID 显式指定时旁路——明确意图，
 *   如会话重建后重投）
 * - ok → 记 delivered、移出 pending
 * - skip（T-A ①：归属判据判静默 / 票乙：改动全在免审前缀内）→ **不记账本、
 *   不记 pending**，原样返回
 * - fatal → 移出 pending（确定性失败重试无意义，死 SHA 不滞留）
 * - transient（重试已耗尽）→ 记入 pending，下次投递机会自动补投
 *
 * @param {Object} [opts] — 透传 tryPostToCatstudy（如 { judgeAttribution: true }，
 *                          仅 post-commit 入口传——见 decideHookDelivery）
 * @returns {Promise<'ok'|'transient'|'fatal'|'skip'>}
 */
async function deliverSha(cwd, serverUrl, sha, content, opts = {}) {
  const fullSha = resolveFullSha(cwd, sha)
  const state = readState(cwd)
  if (state.delivered[fullSha]) {
    if (!process.env.CATSTUDY_SESSION_ID) {
      console.log(`[handoff-gen] ⏭️  ${fullSha.slice(0, 7)} 已投递过（状态文件）——跳过，不重复投递`)
      // 顺带清出 pending：delivered 与 pending 不应同时存在（跳过路径也要移，否则
      // 该 SHA 每次投递机会都会被 drainPending 重新处理一遍）
      if (state.pending.includes(fullSha)) {
        state.pending = state.pending.filter((s) => s !== fullSha)
        writeState(cwd, state)
      }
      return 'ok'
    }
    console.log(
      `[handoff-gen] ℹ️  ${fullSha.slice(0, 7)} 已投递过，但 CATSTUDY_SESSION_ID 显式指定——按明确意图重新投递`
    )
  }

  // 免审白名单（票乙）：改动**全部**在 `docs/run/**` 内 → 判静默，不 POST、不记账本。
  // 位置在 delivered 早退**之后**（已投过的不重复判）、tryPostToCatstudy **之前**
  // （省掉整条投递链路：会话反查 / 实施者反查 / POST）。
  // 前置 = **显式意图 > 自动豁免**，但信号源是 `CATSTUDY_FORCE_DELIVER` 而**不是**
  // `CATSTUDY_SESSION_ID`——首版用后者，而它在猫的 CLI 环境里常驻 ⇒ 豁免恒不生效
  // （详见 `isForceDeliver` 注释；e2e 16d 把这个生产形态钉成回归用例）。
  //
  // 已知代价（审查回炉留痕，非漏改）：本早退同时跳过 `attemptDeliver` 里的
  // **commit_hash 写回**（同文件 :1262 声明「静默路径也要记 commit_hash」）。
  // 对免审提交而言这条链锚没有消费方——免审提交不进审查链，收尾兜底
  // （--fallback-sha）也正是在它身上静默；下游若另有依赖，属架构面（OQ3）。
  //
  // 返回既有 'skip'：与归属静默同一语义（非错误、不记账本，见上方注释）。
  const paths = changedPathsOf(cwd, fullSha)
  if (!isForceDeliver(process.env.CATSTUDY_FORCE_DELIVER) && isExemptDelivery(paths)) {
    console.log(
      `[handoff-gen] ⏭️  ${fullSha.slice(0, 7)} 改动全在免审前缀内（${paths.join(', ')}）` +
        `——静默，不投递（连带跳过 commit_hash 写回）`
    )
    return 'skip'
  }

  const result = await tryPostToCatstudy(content, cwd, { sha, ...opts })
  if (result === 'skip') {
    // T-A ①：归属判据判静默——**不记账本**。账本记的是「真投过」，静默不是投递；
    // 若在此记 delivered，server 收尾兜底（--fallback-sha）会被自己这条记录锁死
    // （同一个 SHA 的兜底投递恰好发生在静默之后）。账本语义保持单态：投过才算。
    return 'skip'
  }
  if (result === 'ok') {
    state.delivered[fullSha] = new Date().toISOString()
  }
  state.pending = state.pending.filter((s) => s !== fullSha) // ok/fatal 移出；transient 下面重新记入
  if (result === 'transient') {
    if (!state.pending.includes(fullSha)) state.pending.push(fullSha)
  }
  writeState(cwd, state)
  return result
}

/**
 * 补投 pending 队列（每次投递机会先处理）：
 * 交接文档是 `git show <sha>` 的确定性生成结果，重新生成必然得到同一文档——
 * pending 只记 SHA 不存内容，草稿被覆盖不影响补投（Fix D）。
 */
async function drainPending(cwd, serverUrl) {
  const state = readState(cwd)
  if (!state.pending.length) return
  for (const sha of [...state.pending]) {
    if (!isAncestorOfHead(cwd, sha)) {
      // 历史改写后 SHA 失效（prune 兜底），正常不会走到这里
      console.log(
        `[handoff-gen] ⏭️  pending 中 ${sha.slice(0, 7)} 不是当前 HEAD 祖先（历史已改写）——移除`
      )
      state.pending = state.pending.filter((s) => s !== sha)
      writeState(cwd, state)
      continue
    }
    const doc = generateHandoff({ cwd, sha, range: `${sha}~1..${sha}` })
    if (doc === null) {
      // 无文件改动/merge commit → 无内容可投，直接记已投
      state.delivered[sha] = new Date().toISOString()
      state.pending = state.pending.filter((s) => s !== sha)
      writeState(cwd, state)
      continue
    }
    console.log(`[handoff-gen] 📤 补投 pending: ${sha.slice(0, 7)}（从 git 重新生成）`)
    await deliverSha(cwd, serverUrl, sha, doc)
  }
}

/**
 * --fallback-sha 入口（T-A ②）：**收尾兜底投递**。
 *
 * 调用方是 cat-study server 的执行收尾（`execution/review-fallback.ts`）：判定
 * 「本次执行有 commit，但其回复 mentions 未含审查者」时补投——把「钩子每 commit
 * 必投」换成「猫主动投、漏了收尾补」的第二道闸。
 *
 * 与 post-commit 入口的关键差别：**不跑归属判据**。本入口的 SHA 正是从
 * execution_logs.commit_hash 取来的，必然有归属——再判一次只会把自己判静默。
 * 幂等由 `.handoff-delivered.json` 账本兜（同一 SHA 全流程至多投一条），
 * 与 post-commit 入口共用账本，故两个入口叠加也不会重复投。
 *
 * ⚠️ 覆盖面契约（T-H ② 裁决，有意如此）：本入口只拿到 `execution_logs.commit_hash`
 * 里的**一个** sha（`getRunningExecutionCommitHash` 取该 agent 最新 running 行的单列），
 * 故补投文档的改动面 = 那一个 commit。同一次执行若提交了多个 commit，更早的那些
 * **不在**本请求的改动面内——这是「一次派发 = 一条审查请求」的代价，替代方案
 * （逐 commit 各投 / 按 uuid 回溯成段）均已实测否决，理由与现场证据见文件头 T-H ②。
 *
 * @returns {Promise<'ok'|'transient'|'fatal'|'skip'>}
 */
export async function deliverFallbackSha(cwd, serverUrl, sha) {
  const fullSha = resolveFullSha(cwd, sha)
  if (!fullSha) {
    console.log(`[handoff-gen] ⚠️  收尾兜底：sha 无法解析（${sha}）——跳过`)
    return 'skip'
  }
  const doc = generateHandoff({ cwd, sha: fullSha, range: `${fullSha}~1..${fullSha}` })
  if (!doc) {
    // merge commit / 空提交 → 无文件改动，无内容可投（与 drainPending 同款处理）
    console.log(`[handoff-gen] ⏭️  收尾兜底：${fullSha.slice(0, 7)} 无文件改动——无内容可投，跳过`)
    return 'skip'
  }
  console.log(
    `[handoff-gen] 📤 收尾兜底投递：${fullSha.slice(0, 7)}（执行收尾判定回复未 @ 审查者）`
  )
  return await deliverSha(cwd, serverUrl, fullSha, doc)
}

/**
 * --gate-deliver 兜底：HEAD 若尚未投递则生成并投递（覆盖 post-commit 中途崩溃窗口）。
 *
 * 判据只认 `.handoff-delivered.json` 账本，而 T-A 后账本**只记「真投过」**：
 * 钩子判静默不记账、猫的主动投递也不记账。故留一个窄窗口——**猫已主动投递、
 * 判决尚未产出**时 push 被门禁拦下 → 账本无记录 → 对同一 SHA 再投一条补填请求。
 * 取舍（T-A 复盘裁决）：**有意**不给账本加「已静默」态——加了会连「收尾兜底
 * spawn 失败」时的最后一道网一起关掉，与票单 ③「判据查不动一律投递」相反。
 * 窗口窄、无害（同形状请求，最多多唤醒一次）；approve 闸已拦掉「已审 ✅」的大多数。
 */
async function deliverHeadIfUndelivered(cwd, serverUrl) {
  const headSha = safeGit(cwd, 'rev-parse HEAD')
  if (!headSha) return
  const state = readState(cwd)
  if (state.delivered[headSha] && !process.env.CATSTUDY_SESSION_ID) return
  const doc = generateHandoff({ cwd })
  if (doc) await deliverSha(cwd, serverUrl, 'HEAD', doc)
}

// ─── CLI entry ──────────────────────────────────
// 放在文件末尾，确保所有 const 已初始化（ESM TDZ）

/**
 * CLI 主流程（导出以便 e2e 进程内调用——stub server 与调用方同进程；
 * 某些沙箱环境会阻断子进程对 127.0.0.1 的 TCP，execSync 起的 CLI 连不上 stub）。
 * @param {Object} args — parseArgs 产物（{ cwd?, noPost?, gateDeliver? }）
 */
export async function runHandoff(args) {
  const cwd = args.cwd || process.cwd()

  // --no-post：只生成草稿，不投递、不碰状态文件（人工预审用）
  if (args.noPost) {
    const result = generateHandoff(args)
    if (result) {
      writeFileSync(join(cwd, '.handoff-draft.md'), result, 'utf-8')
      console.log('📋 .handoff-draft.md 已生成')
    }
    return
  }

  const serverUrl = process.env.CATSTUDY_URL || 'http://127.0.0.1:3200'

  // 历史改写自愈（幂等）
  pruneState(cwd)

  // pre-push 门禁入口：补投 pending 队列 + 兜底投递 HEAD（若尚未投递）
  if (args.gateDeliver) {
    await drainPending(cwd, serverUrl)
    await deliverHeadIfUndelivered(cwd, serverUrl)
    return
  }

  // 收尾兜底入口（T-A ②）：server 在执行收尾判定「有 commit 但回复未 @ 审查者」
  // 时调用，指定 SHA 生成并投递。独立入口——不跑归属判据（见 deliverFallbackSha）。
  if (args.fallbackSha) {
    await deliverFallbackSha(cwd, serverUrl, args.fallbackSha)
    return
  }

  // post-commit 路径：先补投 pending（每次投递机会先处理），再生成并投递 HEAD
  await drainPending(cwd, serverUrl)
  const result = generateHandoff(args)
  if (result) {
    writeFileSync(join(cwd, '.handoff-draft.md'), result, 'utf-8')
    console.log('📋 .handoff-draft.md 已生成')

    // 投递到 cat-study（judgeAttribution：post-commit 入口才判归属——T-A ①；有归属则静默不发）
    const outcome = await deliverSha(cwd, serverUrl, 'HEAD', result, { judgeAttribution: true })
    if (outcome === 'ok') {
      // 投递成功 → 清理本地草稿（内容已在 cat-study 消息管道中）
      try {
        unlinkSync(join(cwd, '.handoff-draft.md'))
        console.log('  (本地 .handoff-draft.md 已清理——内容在 cat-study 管道中)')
      } catch {
        // 清理失败不影响主流程
      }
    }
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (isMain) {
  // 参数解析独立于主流程：**参数错误 = 调用方错误**，必须 exit 非 0 且**绝不投递**
  // （不落进无参的 post-commit 投递路径——那正是必改 2 要封的类）。
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error('[handoff-gen] 参数错误:', err.message)
    process.exit(2)
  }
  try {
    await runHandoff(args)
  } catch (err) {
    // 运行时失败：post-commit hook 不应阻断 commit，失败时只告警（exit 0）
    console.error('[handoff-gen] 生成失败:', err.message)
    process.exit(0)
  }
}
