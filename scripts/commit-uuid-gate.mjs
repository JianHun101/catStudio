/**
 * commit-msg 门禁 —— commit message 里的 `catstudy [uuid]` 必须真在 `messages` 表里
 *
 * 由来（`452dbfd` 事故）：commit message 的 uuid 是**手打杜撰**的，库里双查无此行
 * ⇒ 归属判据 `probeAttribution` 把「查无此 uuid」归到「用户手动提交」⇒ post-commit
 * **多投一份**交接文档。前三单同类假 uuid 没露头，只因改动全在 `docs/run/**`，被
 * 免审白名单闸走 `skip` 静默分支，压根走不到归属判据。
 *
 * ⚠️ 用户说的「pre-commit 校验」在实现上**落不到 `pre-commit`**：那个钩子在 commit
 * message 生成**之前**跑，物理上拿不到 message。git 提供 message 的钩子是
 * **`commit-msg`**（`$1` = message 文件路径）。故本门禁挂 `commit-msg`。
 *
 * ── 判据（C2 / C7：判据面与执行面同面）───────────────────────────
 * 只校验 message 里那个 uuid 在 **`messages.id`** 里存在。**不**看 `role`、
 * **不**查 `execution_logs`（「手打真 id 但无执行」是用户手动提交的合法形态，
 * 查了就是误拦）；**不**拿 `$CATSTUDY_TRIGGER_MSG_ID` 当判据（env 只是取证提示，
 * 库才是真相源）。
 *
 * ── 六态判决（C4 / 票丁 / 票 `hook-marker-fail-open`）─────────
 *   ① 无 `catstudy [uuid]` 标记；或括号里**不是标记形态**（散文 `catstudy [uuid]`、
 *      `not-a-uuid`）                      → 放行（merge / revert / 人工提交不受影响）
 *   ② 有标记，形状非法**但够像 uuid**（hex-dash 且 ≥16 位，非 8-4-4-4-12 小写 hex）
 *                                         → 阻断 exit 1（长度错 / 大写 / 错分组 = 手打的高置信信号，无需查库）
 *   ②′ **近 miss 前缀**：写了「标记意图词 + uuid 形」但前缀不是 `catstudy`
 *      （`catstance [<36 位>]` 即 `99cee01b` 事故形态）→ 阻断 exit 1（见下方「fail-open 靶心」段）
 *   ③ 有标记，形状合法，两库都查无此 id     → 阻断 exit 1（本门禁要挡的那一类）
 *   ④ 两库文件都不存在                     → **放行 + 显式警示**（判据**无主体**，不是「通过」）；见下
 *   ⑤ 库存在但读取失败（加锁超时 / 表缺失） → 阻断 exit 1（判据有主体却判不动 ⇒ 查不动 ≠ 放行）
 *
 * ── fail-open 靶心（票 `hook-marker-fail-open`）────────────────
 * 票丁把「有标记但写歪」从「无标记」里捞了出来（态②），但只捞了**括号里**写歪的。
 * **前缀写歪**（`catstance`）仍然落 ①「无标记」⇒ **静默放行**：实测（`m1` 夹具真
 * commit）`catstance [<真 uuid>]` 打印的正是「无 `catstudy [uuid]` 标记（merge /
 * revert / 手动提交）→ 放行」。后果是整条审查链断在这里——commit-msg 认得它、handoff
 * 的反查也认得它（`extractCommitUuid` 同样返回 null ⇒ 当手动提交 ⇒ 走兜底空壳），
 * 于是一笔未审代码可以无审查直达 push（`99cee01b` 已实证落在 `origin/dev` 上）。
 *
 * 根因不是「正则写窄了」，是**谓词少了一档**：原先只有「有标记」与「无标记」两个
 * 出口，而「写了标记但拼错」与「根本没写」被压进同一个出口——门禁**分不出**这两件事，
 * 于是也报不出「你写歪了」。态②′ 就是把这一档补上（判据同态②：**不查库**，拼错本身
 * 就是手打的高置信信号）。
 *
 * 边界（**有意为之**，不是漏）：态②′ 只在「没有任何形状合法的 `catstudy` 标记」时
 * 生效。message 里既有真标记又顺口提了一句写歪的，归属面已经成立，不额外阻断。
 *
 * ④ 的口径（OQ-1 裁定，维持放行）：库缺席时判据无主体；fail-closed 会让新 clone /
 * 无库环境的**每一次提交**都被拦，压力把人推向 `--no-verify`——正是 pre-push 头注释
 * 点名要止住的形态。附条件：**警示必须走 stderr**，不许静默 `exit 0`（否则「无主体」
 * 会退化成「真通过」）。
 *
 * ── 出口（C5）───────────────────────────────────────────────
 * 阻断信息含 ① 被拒 uuid 原文 ② 一句「uuid = 触发本次执行的那条消息 id（用户消息或
 * 别的猫投来的 A2A 消息皆可）」 ③ 取证命令 `echo $CATSTUDY_TRIGGER_MSG_ID` ④ 全局
 * 逃生口 `git commit --no-verify`。**不新增第二个逃生开关**（env 白名单之类）——
 * `--no-verify` 已是本仓既有唯一出口，多开一个等于把门禁变成装饰。
 *
 * ── 形态（C1 / C6 / 票丁）─────────────────────────────────────
 * 逻辑**单源在本文件**：`.husky/commit-msg` 只是把 `$1` 转交过来的 POSIX sh 薄壳
 * （承 `pre-push` → `handoff-gen.mjs`、`post-commit` → `handoff-gen.mjs` 的既有形态）。
 *
 * ⚠️ **标记捕获不复用 `extractCommitUuid`**（票丁起）。C6 的「不改 `handoff-gen.mjs`
 * 的提取器、它服务投递面」照旧成立；变的是**本门禁不再借它**。两者是**两个谓词**，
 * 不是同一条规则的两份实现——别来「收敛」：
 *   - `extractCommitUuid`（窄，定长 `/catstudy\s+\[([0-9a-f-]{36})\]/`）回答
 *     「**取出一个能用的 uuid** 反查会话」，取不出就该当手动提交；
 *   - 本门禁（宽，`MARKER_CAPTURE_RE` 抓任意候选串）回答「**有没有写标记、标记长
 *     什么样**」——畸形标记必须**先被看见**，才谈得上判它。
 *
 * 复用引入的实害（票丁靶心，`0b5e9e0` 实证）：39 位畸形标记
 * `dbb86077-de5e-4506-8f2c-6169d09dce33` 里，定长窗口只能从字面 `catstudy\s+\[`
 * 之后起算，36 位卡在第 37 位 `e` 上而 `]` 在第 40 位 ⇒ 返回 `null` ⇒ 落 ① 放行。
 * **它声明要抓的那类，恰是它抓不到的。**
 *
 * ⚠️ **必须扫「全部候选」，不能只看第一个**（P2 修正，审查者实证）。「宽捕获」不等于
 * 「抓第一个就停」——旧提取器的形状要求**内建在正则里**，脏候选匹配失败后引擎会回溯
 * **继续向后搜**，它的实际语义是「**第一个形状合法的**候选」。只抓第一个任意候选会在
 * 两种 message 上分叉（实测读数见 `commit-uuid-gate.test.js` 的「全候选」用例组）：
 *   - 脏候选在前 + 后面是**畸形标记** ⇒ 旧落 ①（真抓不到），新也只抓脏的 ⇒ 靶心失效；
 *   - 脏候选在前 + 后面是**形状合法但查无此 id** 的真标记 ⇒ 旧落 ③ 阻断，新落 ① 放行
 *     ⇒ **净回归**（本仓真实存在：`40a5b835` / `9c8853a7` / `c37f1881` / `bba06f28`
 *     四笔 commit 的第一个候选都是散文里的 `catstudy [uuid]`，真标记在末尾）。
 * 故次序是：**先找第一个形状合法者**（与旧同序，真值不被脏候选挡住）→ 找不到再看
 * **任一**候选是否够像 uuid（畸形 ⇒ ② 阻断）→ 都不是才落 ①。
 *
 * ⚠️ **大写 uuid 由「放行」翻为「阻断」**（票丁，对既有 **P3-1 的半推翻**）：P3-1
 * 当初的取舍是「不改**共用**提取器的正则」（**范围**理由），不是「大写无害」（语义
 * 理由）。门禁有了自己的捕获器后，大写正是它要抓的手打高置信信号 ⇒ 落 ② 阻断。
 * 被推翻的只有「大写 ⇒ 放行」这一条结论，`handoff-gen.mjs` 一个字未动。
 *
 * ── 根解析（C3，worktree 承重）─────────────────────────────────
 * 钩子常在 worktree 内跑，而 **worktree 的 `packages/server/data/` 里没有 `.db`**
 * （实核：只有一个 `cat-study.log`）。故根取**主仓库**：
 * `git rev-parse --path-format=absolute --git-common-dir` → 取其父目录。
 * 根解析不出来 ⇒ 候选库为空 ⇒ 落 ④（判据无主体、警示、放行），与库缺席同类。
 *
 * `DatabaseSync` **只在 `existsSync` 之后**才 new——`node:sqlite` 的构造函数会
 * **创建**空库文件，在 worktree 里跑会落一地假库（同 `retire-message-memory.mjs`
 * 既有注释）。库路径**复用** `defaultDbs(root)`，不新写一份库布局（两个真相源 =
 * 下次库改名必漏一个）。`busy_timeout` 取同源常量：**一次有界等待，不重试**。
 *
 * ── 用法 ───────────────────────────────────────────────────
 *   node scripts/commit-uuid-gate.mjs <commit-msg-file>          # 由 .husky/commit-msg 调用
 *   node scripts/commit-uuid-gate.mjs --scan-push <tip> [<base>] # 由 .husky/pre-push 调用
 *
 * 退出码（commit-msg 模式）：0 = 放行；1 = 阻断（门禁判决）；2 = 调用方错误
 * （缺参数 / message 读不到）。
 * 退出码（`--scan-push` 模式，**三档**，`pre-push` 靠它分流，别去 match emoji）：
 *   0 = 扫过且干净；1 = 命中（调用方并进阻断）；2 = 本层没跑成（调用方警示后放行）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { defaultDbs, BUSY_TIMEOUT_MS } from './flywheel/retire-message-memory.mjs'

/**
 * 标记**捕获**（宽）：`catstudy [...]` 里的整段候选串，形状判断交给下一步。
 *
 * 与 `handoff-gen.mjs` 的 `extractCommitUuid` **不是同一条规则的两份实现**（见文件头
 * 「形态」段）：那个要窄（取不出 = 手动提交），这个要宽（畸形也得先看见）。
 * 捕获组取 `[^\]\n]+`——**不**限字符集，任何写歪的内容都留到形状判断里被判；
 * **但排除换行**：标记是单行的，放开换行会让一个漏写 `]` 的 `catstudy [` 一路吞到
 * 下一个 `]`，把落在中间的**真标记整个吃掉**（实测：`catstudy [oops\n… catstudy
 * [<真值>]` 会捕成一个候选）。排掉换行后引擎在该位置失配、继续向后搜，真值仍被看见。
 */
export const MARKER_CAPTURE_RE = /catstudy\s+\[([^\]\n]+)\]/

/**
 * `g` 版捕获（**不导出**，仅供 `evaluateCommitUuid` 的 `matchAll` 用）。
 *
 * 为什么不给 `MARKER_CAPTURE_RE` 直接加 `g`：带 `g` 的正则 `.test()` / `.exec()` 会
 * 在调用间留 `lastIndex`，把它作为共享导出常量放出去等于泄漏状态给下一个调用点。
 * `matchAll` 内部克隆正则（不改原件的 `lastIndex`），故导出件保持无状态、`g` 版私有。
 * 每次判决新建一次（一条 commit 一次，开销可忽略）。
 */
const MARKER_CAPTURE_ALL_RE = () => new RegExp(MARKER_CAPTURE_RE.source, 'g')

/** 严格 UUID 形状：8-4-4-4-12 **小写** hex（OQ-2 裁定：维持严；误拦面实测为空） */
export const UUID_SHAPE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * 「够像 uuid 但形状不过」的判据（票丁新增）：**全 hex-dash 字符集且长度 ≥16**。
 *
 * 意义是「手打一个 uuid 却写歪了」的高置信信号——长度错（39/28 位）、大写、错分组
 * 全落在这里 ⇒ 态 ② 阻断。阈值 16 的取法：真 uuid 36 位、最短的常见截断也远长于 16，
 * 而散文里偶然出现的 hex-dash 串（如 `deadbeef`、`a-b-c`）够不到，故不会把
 * 「正文顺口提了一句」误拦成阻断。**误拦面留 OQ，实测后标注。**
 */
export const HEX_DASH_SHAPE_RE = /^[0-9a-fA-F-]{16,}$/

/**
 * 「近 miss 标记」**候选**捕获（态②′，票 `hook-marker-fail-open`）：
 * **标记意图词 + uuid 形**，前缀 `cat[A-Za-z]{2,}`。
 *
 * ⚠️ 本正则**只找候选，不定夺**——「这个词到底是不是 `catstudy` 的拼写变体」由
 * `looksLikeMisspelledMarker` 判（两步分离，同本文件既有的「宽捕获 + 形状判断」形态）。
 * 别只读这条正则就以为判据是「`cat` 打头 + uuid 形就行」：那样会把 `catalog [...]`
 * 也拦掉，实测红过（见该函数头注释）。
 *
 * 正则这一层实测选的量词（全仓 1192 笔 `--all --no-merges` commit 回放）：
 *   - 前缀下限 `{2,}`（词长 ≥5）：`catstudy`=8、`catstance`=9 都在内；**裸词 `cat`
 *     （长 3）够不到**——否则散文里的 `the cat [deadbeef-cafe-…]` 会进候选。
 *   - 括号内容沿用 `HEX_DASH_SHAPE_RE` 的口径（hex-dash ≥16）：散文里的 `[见附录]`
 *     够不到。**不要求 8-4-4-4-12**——拼错前缀的人多半也未必把 uuid 写标准，写歪的
 *     也该被看见（与态②同理）。
 *   - `\s*`（不是 `\s+`）：`catstance[uuid]` 无空格同样算写歪。
 *   - 前置 `(?<![A-Za-z])`：`xcatstance` 是另一个词，不算。
 *   - **`i` 标志**：`Catstudy [uuid]` 也是写歪（本仓既有 P3-1 半推翻的同类——
 *     大写前缀在主捕获正则里认不出来，会静默退化成「无标记」）。
 *
 * 判据方向：**命中即阻断**，故每放宽一分都直接加误拦面——放宽前先跑历史回放。
 */
export const NEAR_MISS_CAPTURE_RE = /(?<![A-Za-z])(cat[A-Za-z]{2,})\s*\[([0-9a-fA-F-]{16,})\]/gi

/**
 * `g` 版私有工厂（同 `MARKER_CAPTURE_ALL_RE` 的理由：不给共享导出件留 `lastIndex`）。
 * ⚠️ `g` 与 `i` **必须一起给**——只给 `g` 会把 `i` 丢掉，大小写写歪那一支就测不出来了
 * （源正则带几个 flag，这里就得跟几个；这是拷贝式工厂的固有耦合点）。
 */
const NEAR_MISS_CAPTURE_ALL_RE = () => new RegExp(NEAR_MISS_CAPTURE_RE.source, 'gi')

/**
 * `--scan-push` 的两个非 0 退出码（调用方 `.husky/pre-push` 按它们分流）。
 *
 * **刻意避开 1**：1 是 node 自己的失败码（`Cannot find module` / 未捕获异常），
 * 若拿 1 当「命中」，任何「脚本没搬过来 / 语法崩了」的环境都会把所有推送判成
 * 「栈里有写歪标记」——把门禁从 fail-open 直接翻成 fail-everything。实测过：
 * `pre-push-gate.e2e.mjs` 的 6 个「应当放行」场景被这条重载全数误伤。
 * 3 不在 node 的失败码集合里，故「命中」与「跑不动」永不混淆。
 */
export const SCAN_EXIT_HIT = 3
/** 扫描没跑成（非 git 仓库 / 浅克隆 / 脚本没搬过来）——调用方警示后**放行** */
export const SCAN_EXIT_NOT_RUN = 2

/** 正确写法（判据的锚） */
const CANONICAL_MARKER_WORD = 'catstudy'
/** 公共前缀下限 `catst`——见 `looksLikeMisspelledMarker` 的阈值来历 */
const NEAR_MISS_COMMON_PREFIX = 5
/** 编辑距离上限——见 `looksLikeMisspelledMarker` 的阈值来历 */
const NEAR_MISS_EDIT_DISTANCE = 2

/** Levenshtein 编辑距离（两词都短，朴素 DP 足够；本判据不在热路径上） */
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}

/**
 * 「这个词像不像 `catstudy` 的**拼写变体**」——正则只负责**找候选**
 * （`cat…` + uuid 形的括号），本函数负责定夺，两步分离同本文件既有的「宽捕获 +
 * 形状判断」形态。
 *
 * 判据两条，**或**关系（阈值全是实测选的，不是拍的）：
 *   ① 与 `catstudy` 的**公共前缀 ≥ 5**（即 `catst` 开头）
 *   ② 与 `catstudy` 的**编辑距离 ≤ 2**
 *
 * 为什么不能只用「`cat` 开头」：**会误拦**。实施时用例组先红过一次——
 * `docs: catalog [abcdef0123456789abcdef] 已更新` 被拦成阻断。误拦合法提交的压力
 * 正是把人推向 `--no-verify` 的形态（本仓反复点名），故判据必须能区分
 * 「`cat` 打头的英文词」与「`catstudy` 写歪」。
 *
 * 为什么不能只用编辑距离：**分不开**。实测距离表：
 *   `catstance`=4（事故真值，必须抓）／`category`=4、`cats`=4、`catapult`=4（全是
 *   正常英文词，必须放）。距离 4 这一档上两类词**同分** ⇒ 单靠距离无判别力，
 *   必须叠公共前缀这条正交判据（`catstance` 前缀 5，`category`/`cats`/`catapult`
 *   前缀都只有 3–4）。
 *
 * 逐字**精确**等于 `catstudy` 才剔（不是小写后相等）：`Catstudy` 是写歪——主捕获
 * 正则是小写敏感的，认不出它 ⇒ 同族缺口（本仓 P3-1「大写 uuid」半推翻的同款）。
 *
 * 已知残余（**有意为之**，写在这里免得下一个人当漏网）：前 5 个字符就写歪的变体
 * （`catsudy` 只差一个 `t` 但前缀 4）靠 ② 兜住；再远的（如 `castdy`①②都够不到）
 * 不拦——判据每放宽一分都直接加误拦面，本票只堵「写歪的前缀被当成没写」这一族。
 */
function looksLikeMisspelledMarker(word) {
  if (word === CANONICAL_MARKER_WORD) return false
  const w = word.toLowerCase()
  let prefix = 0
  while (prefix < w.length && w[prefix] === CANONICAL_MARKER_WORD[prefix]) prefix++
  if (prefix >= NEAR_MISS_COMMON_PREFIX) return true
  return editDistance(w, CANONICAL_MARKER_WORD) <= NEAR_MISS_EDIT_DISTANCE
}

/**
 * 扫出 message 里**全部**「近 miss 标记」，前缀小写后等于 `catstudy` 的剔除
 * （那是正常标记，归态①′/②/③ 走）。
 *
 * @param {string} message — commit message 全文
 * @returns {Array<{word: string, raw: string}>} `word` = 写歪的前缀原文，`raw` = 整段候选（`catstance [xxx]`）
 */
export function findNearMissMarkers(message) {
  const out = []
  for (const m of (message || '').matchAll(NEAR_MISS_CAPTURE_ALL_RE())) {
    if (!looksLikeMisspelledMarker(m[1])) continue
    out.push({ word: m[1], raw: m[0] })
  }
  return out
}

/** 出口给猫看的那句（C5 ②，P3-2 更正：A2A 触发的提交也合法） */
export const UUID_ORIGIN_HINT =
  'uuid = 触发本次执行的那条消息 id（用户消息或别的猫投来的 A2A 消息皆可）'

/**
 * 解析 git 时要剥掉的继承环境变量。
 *
 * git 跑钩子时会**注入**这些（实核：`.husky/pre-commit` 里 `env | grep ^GIT` 得
 * `GIT_DIR=D:/Game/ai/catStudy/.git/worktrees/2a86307b`、`GIT_INDEX_FILE=…/next-index-*.lock`）。
 * 透传的后果是 **cwd 形同虚设**：嵌套调用一律被解析到**外层仓库**——本票测试首跑
 * 就在 pre-commit 里踩中（临时仓库 `git commit` 认了外层的 `GIT_DIR`，`resolveRepoRoot`
 * 从临时目录返回了主仓库根）。
 *
 * 本函数的契约是「按 cwd 解析」，故根解析与测试侧 git 调用**同用**这一份剥离清单
 * （单源，别各写各的）。
 */
const INHERITED_GIT_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
  'GIT_CONFIG_PARAMETERS',
]

/** 剥掉继承来的 git 定位变量，只留「按 cwd 走」的干净环境 */
export function cleanGitEnv(base = process.env) {
  const env = { ...base }
  for (const k of INHERITED_GIT_ENV) delete env[k]
  return env
}

/**
 * 主仓库根（C3）——从 `--git-common-dir` 拿，**不是** `--show-toplevel`：
 * worktree 里 toplevel 指向 worktree 自己（其 `packages/server/data/` 无库）。
 *
 * @param {string} [cwd]
 * @returns {string|null} 解析失败返回 null（调用方落「判据无主体」态）
 */
export function resolveRepoRoot(cwd = process.cwd()) {
  try {
    const commonDir = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      // env 必须洗干净：钩子里 GIT_DIR 已被 git 注入，透传则 cwd 被架空
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: cleanGitEnv() }
    ).trim()
    if (!commonDir) return null
    // `<root>/.git`（主仓库）或 `<root>/.git/worktrees/<name>`？—— --git-common-dir
    // 恒回「公共目录」，worktree 里也是主仓库的 `<root>/.git` ⇒ 父目录即主仓库根
    return resolve(commonDir, '..')
  } catch {
    return null
  }
}

/**
 * 在一个库文件里查该 uuid 是否是 `messages.id`。**不吞异常**——读取失败由调用方
 * 判成「查不动 ≠ 放行」（态 ⑤）。
 *
 * @param {string} dbFile
 * @param {string} uuid
 * @returns {boolean}
 */
function hasMessageId(dbFile, uuid) {
  let db
  try {
    // 只在 existsSync 之后 new（构造函数会创建空库文件）
    db = new DatabaseSync(dbFile)
    // 一次有界等待：并发写事务（server 正在写）时等 5s 拿锁；超时如实报错，不重试
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    return db.prepare('SELECT 1 AS hit FROM messages WHERE id = ? LIMIT 1').get(uuid) != null
  } finally {
    try {
      db?.close()
    } catch {
      /* 关连接失败不掩盖结论 */
    }
  }
}

/**
 * 判决（纯函数，库以 `dbs` 注入 ⇒ 可拿真 SQLite 临时库单测）。
 *
 * 「命中」优先于「读不动」：只要**任一**库证明该 id 存在，存在性即成立（方向向严——
 * 永不因某库报错而放过一个查无此 id 的提交）。两库都读不动才落 ⑤。
 *
 * @param {string} message — commit message 全文
 * @param {Array<{label: string, file: string}>} dbs — 候选库（`defaultDbs(root)`）
 * @returns {{ok: boolean, code: 'no-marker'|'bad-shape'|'found'|'not-found'|'no-db'|'db-error', uuid: string|null, hit: {label: string, file: string}|null, candidates: Array<{label: string, file: string}>, dbs: Array<{label: string, file: string}>, errors: Array<{label: string, file: string, error: string}>}}
 *   `candidates` = 全部候选库（含不存在的，警示要报它们）；`dbs` = **实际查过**的库
 */
export function evaluateCommitUuid(message, dbs = []) {
  const base = { ok: true, uuid: null, hit: null, candidates: dbs, dbs: [], errors: [] }

  // 捕获走**本模块自己的**宽松正则（文件头「形态」段：复用定长提取器正是票丁靶心），
  // 且扫**全部**候选（文件头 P2 段：只抓第一个会让「脏候选在前」的 message 静默放行）
  const caps = [...(message || '').matchAll(MARKER_CAPTURE_ALL_RE())].map((m) => m[1])
  // 态②′ 的输入**必须在这里就算**：前缀写歪的 message 里压根没有 `catstudy [...]`，
  // `caps` 是空的——把判据留在下方「有候选但都不合法」那一支里，它会**一次都跑不到**
  // （实施时首版即栽在这：夹具 S2 复跑仍是「无标记 → 放行」）。两个出口都要问一次。
  const nearMiss = findNearMissMarkers(message)[0]
  // 态 ① / ①′：无 `catstudy [...]` 候选。放行前先问「是不是标记写歪了」（态②′）——
  // merge / revert / 人工提交没有标记意图 ⇒ nearMiss 为 undefined ⇒ 照旧放行。
  if (caps.length === 0) {
    if (nearMiss !== undefined)
      return { ...base, ok: false, code: 'near-miss', uuid: nearMiss.raw, nearMiss }
    return { ...base, code: 'no-marker' }
  }

  // 形状合法的候选**优先**：与旧提取器同序（它靠正则回溯拿到「第一个形状合法者」），
  // 保证前面的脏候选挡不住后面的真值 ⇒ 态③④⑤ 的输入与旧实现逐字相同
  const uuid = caps.find((c) => UUID_SHAPE_RE.test(c))
  if (uuid === undefined) {
    // 态 ②：**任一**候选够像 uuid 但形状非法 ⇒ 阻断（不查库——形状错本身就是手打/截断的高置信信号）
    const malformed = caps.find((c) => HEX_DASH_SHAPE_RE.test(c))
    if (malformed !== undefined) return { ...base, ok: false, code: 'bad-shape', uuid: malformed }
    // 态 ②′：**近 miss 前缀**（票 `hook-marker-fail-open`）——`catstudy` 没写对，但
    // 「标记意图 + uuid 形」两件都齐。放在「无标记」出口**之前**：漏了这一步，拼错的
    // 标记就会以「无标记」的措辞静默放行（文件头「fail-open 靶心」段）。
    // 位置在态② 之后：两者互斥（② 要求前缀**是** `catstudy`，②′ 要求**不是**），
    // 同现时按 ② 报——那是更贴靶心的措辞（他写对了前缀、歪在 uuid 上）。
    if (nearMiss !== undefined) {
      return { ...base, ok: false, code: 'near-miss', uuid: nearMiss.raw, nearMiss }
    }
    // 态 ①″：其余（散文 `catstudy [uuid]`、`not-a-uuid`、括号里带空格/汉字）⇒ 与「无标记」同出口。
    // 这条**必须保持放行**：只加严会把正常提交拦死（见文件头「出口」——多开一个坑就是在
    // 把人推向 --no-verify）。
    return { ...base, code: 'no-marker' }
  }

  const present = dbs.filter((d) => existsSync(d.file))
  // 态 ④：两库都不存在 ⇒ 放行 + 警示（判据无主体）
  if (present.length === 0) return { ...base, code: 'no-db', uuid }

  const errors = []
  for (const d of present) {
    try {
      if (hasMessageId(d.file, uuid)) {
        // 态 ①′：命中 ⇒ 放行
        return { ...base, code: 'found', uuid, hit: d, dbs: present }
      }
    } catch (err) {
      errors.push({ label: d.label, file: d.file, error: err?.message ?? String(err) })
    }
  }

  // 态 ⑤：库在、却一本都读不动 ⇒ 阻断（查不动 ≠ 放行）
  if (errors.length) return { ...base, ok: false, code: 'db-error', uuid, dbs: present, errors }
  // 态 ③：读得动、且都查无此 id ⇒ 阻断
  return { ...base, ok: false, code: 'not-found', uuid, dbs: present }
}

/**
 * 推送栈近 miss 扫描（态②′ 的**兜底面**，票 `hook-marker-fail-open`）。
 *
 * 为什么 commit-msg 拦了还要在 push 上再拦一次：两者挡的**不是同一批 commit**。
 * commit-msg 只挡「本门禁装好之后、且没走 `--no-verify`」造出来的 commit；而实测
 * （`m2` 夹具真 push）存在**搭车**形态——`.push-gate` 指向 tip（tip 已审）时，栈中间
 * 一笔误拼标记的 commit 随 tip 一起放行上远端（`99cee01b` 落在 `origin/dev` 就是这个
 * 形态：它的父 `37e6dce8` 标记正常、tip 也审过，唯独它自己是 `catstance`）。
 * pre-push 的 sha 判据看的是**栈顶身份**，不看栈内每一笔的**标记写法**——这是两个面。
 *
 * 扫描范围 = **本次推送新引入该远端的 commit**：
 *   - 有远端基线（`base` 非 0）⇒ `rev-list base..tip`，即这次真正新增的那些；
 *   - 新分支（base 全 0）⇒ `rev-list tip --not --remotes`，即远端任何 ref 都还看不到的。
 * 两个口径都**避开历史存量**：`99cee01b` 已在 `origin/dev` 上，故不会被反复拦——
 * 票面边界「历史误拼数据不回填」在门禁侧的同款表达。
 *
 * **只扫近 miss，不扫「无标记」**（有意为之，不是漏）：无标记是本仓**合法**形态
 * （merge / revert / 用户手工提交），拦它等于造一台误拦机器——而误拦合法推送的压力
 * 正是本仓反复点名的、把人推向 `--no-verify` 的形态。误拼则没有任何合法来路。
 *
 * git 跑不动（仓库损坏 / 浅克隆 / 非仓库）⇒ **不阻断**，走 stderr 警示——口径同态④
 * 「判据无主体不等于通过」，理由同（砸掉每一次推送比漏一次更贵）。
 *
 * @param {{cwd?: string, tip: string, base?: string|null}} opts
 * @returns {{scanned: number, hits: Array<{sha: string, subject: string, word: string, raw: string}>, error: string|null}}
 */
export function scanPushRange({ cwd = process.cwd(), tip, base = null }) {
  const run = (args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanGitEnv(),
    })
  const zero = /^0+$/
  try {
    const range = base && !zero.test(base) ? [`${base}..${tip}`] : [tip, '--not', '--remotes'] // 新分支：远端任何 ref 都看不到的那些
    const shas = run(['rev-list', ...range])
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    const hits = []
    for (const sha of shas) {
      // %B 全文（不是 %s）：标记在 body 里，只读 subject 会整批漏
      const msg = run(['log', '-1', '--pretty=%B', sha])
      for (const nm of findNearMissMarkers(msg)) {
        hits.push({ sha, subject: msg.split('\n')[0].slice(0, 80), word: nm.word, raw: nm.raw })
      }
    }
    return { scanned: shas.length, hits, error: null }
  } catch (err) {
    return { scanned: 0, hits: [], error: err?.message ?? String(err) }
  }
}

/** `--scan-push` 给人的一行结论（命中时逐笔列出） */
export function formatScanReport(result) {
  const head = '[commit-uuid-gate]'
  if (result.error) {
    return `${head} ⚠️  推送栈近 miss 扫描未跑成（${result.error}）——本层未生效，不阻断`
  }
  if (result.hits.length === 0) {
    return `${head} 推送栈近 miss 扫描：${result.scanned} 笔，无写歪的标记 → 放行`
  }
  const lines = [
    '',
    `${head} ❌ 推送栈含 ${result.hits.length} 笔「标记前缀写歪」的 commit（扫描 ${result.scanned} 笔）`,
    '',
  ]
  for (const h of result.hits) {
    lines.push(`   - ${h.sha.slice(0, 7)}  写成 \`${h.word}\`（应为 \`catstudy\`）：${h.raw}`)
    lines.push(`     ${h.subject}`)
  }
  lines.push('')
  lines.push(
    '   这些 commit 因标记拼错被当成「无标记」，从未触发过审查——推上去等于未审代码直达远端。'
  )
  lines.push('   处置：改写 commit message（git rebase -i / git commit --amend）后重推。')
  lines.push('')
  return lines.join('\n')
}

/** 放行轨迹（一行，同时是「钩子真被 git 调起」的机器证据——B2 的取证面） */
export function formatPassLine(result) {
  const head = '[commit-uuid-gate]'
  switch (result.code) {
    case 'no-marker':
      return `${head} 无 catstudy [uuid] 标记（merge / revert / 手动提交）→ 放行`
    case 'found':
      return `${head} uuid=${result.uuid} 命中 ${result.hit.label} 库 ${result.hit.file} → 放行`
    case 'no-db':
      return `${head} uuid=${result.uuid} 判据无主体 → 放行（未校验，见下方警示）`
    default:
      return `${head} ${result.code}`
  }
}

/** 态 ④ 的警示行（OQ-1 附条件：**必须走 stderr**，不许静默 exit 0） */
export function formatWarning(result) {
  const where = result.candidates.length
    ? result.candidates.map((d) => `${d.label}=${d.file}`).join('、')
    : '未解析出主仓库根（git rev-parse --git-common-dir 失败），候选库为空'
  return `[commit-uuid-gate] ⚠️  判据无主体：${where} —— 库文件都不存在 ⇒ 本条 uuid 未校验（不是「通过」）`
}

/** 阻断信息（C5 四项：uuid 原文 / 出处提示 / 取证命令 / 逃生口） */
export function formatBlockMessage(result) {
  // 首行带 `[commit-uuid-gate]` 前缀：放行有轨迹行、阻断有这行——两个分支都留「钩子
  // 真被 git 调起」的机器证据（B2 的取证面：手工 `sh 钩子 <file>` 不会有 git 侧输出）
  // 首行带判决码（票丁）：放行轨迹行有状态、阻断行原先只有散文 ⇒ 真机验收探针
  // （「认钩子自打的 `[commit-uuid-gate] bad-shape` 行」）无从下手。码是**机器证据**，
  // 与 formatPassLine 同面；散文留给下面三行讲原因。
  const lines = [
    '',
    `[commit-uuid-gate] ❌ commit-msg 门禁阻断（${result.code}）：catstudy [uuid] 校验未过`,
    '',
  ]
  if (result.code === 'bad-shape') {
    lines.push(`  被拒 uuid: ${result.uuid}`)
    lines.push('  原因: uuid 形状非法——要求 8-4-4-4-12 小写 hex（大写/截断/手打都不认）')
  } else if (result.code === 'near-miss') {
    // 出口的承重点是**点名写歪在哪**：只说「没有标记」正是本态要止住的那句假话
    // （人按那句去查，会以为门禁没看见他的标记，而不是「你拼错了」）。
    lines.push(`  被拒标记: ${result.uuid}`)
    lines.push(
      `  原因: 标记前缀疑似拼错——写成 \`${result.nearMiss.word}\`，应为 \`catstudy\`（拼错的标记会被当成「无标记」，审查链静默断在这里）`
    )
    lines.push('  正确写法: catstudy [<uuid>]')
  } else if (result.code === 'not-found') {
    lines.push(`  被拒 uuid: ${result.uuid}`)
    lines.push(
      `  原因: 该 id 在 messages 表查无此行（已查 ${result.dbs.map((d) => d.label).join('、')}）——多为手打杜撰或复制走了样`
    )
  } else {
    lines.push(`  被拒 uuid: ${result.uuid}`)
    lines.push('  原因: 库存在但读取失败（加锁超时 / 表缺失）——查不动 ≠ 放行')
    for (const e of result.errors) lines.push(`    - ${e.label} 库 ${e.file}: ${e.error}`)
  }
  lines.push('')
  lines.push(`  ${UUID_ORIGIN_HINT}`)
  lines.push('  取证（真值取自环境变量，服务端注入）: echo $CATSTUDY_TRIGGER_MSG_ID')
  lines.push('  确认无误后逃生（本仓既有唯一出口）: git commit --no-verify')
  lines.push('')
  return lines.join('\n')
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (isMain) {
  // ── 推送栈扫描模式（由 .husky/pre-push 调用，见 scanPushRange 头注释）──
  //   node scripts/commit-uuid-gate.mjs --scan-push <tip> [<base>]
  // base 缺省 / 全 0 ⇒ 按「新分支」口径只扫远端还没有的 commit。
  if (process.argv[2] === '--scan-push') {
    const tip = process.argv[3]
    if (!tip) {
      console.error(
        '[commit-uuid-gate] 用法: node scripts/commit-uuid-gate.mjs --scan-push <tip> [<base>]'
      )
      process.exit(2)
    }
    const result = scanPushRange({ tip, base: process.argv[4] ?? null })
    if (result.error) {
      console.error(formatScanReport(result))
      process.exit(SCAN_EXIT_NOT_RUN)
    }
    console.log(formatScanReport(result))
    // 命中用 **3** 而不是 1：退出码 1 是 **node 自己的失败码**（模块找不到 / 未捕获
    // 异常都是 1），拿它当「命中」会让「脚本压根没搬过来」的仓库被判成有写歪标记
    // ⇒ 把所有合法推送拦死。实测：`pre-push-gate.e2e.mjs` 的 6 个「应当放行」场景
    // 全被这条误伤（夹具仓库里没有 scripts/），根因就是这个重载。
    process.exit(result.hits.length ? SCAN_EXIT_HIT : 0)
  }

  const msgFile = process.argv[2]
  if (!msgFile) {
    // 调用方错误（钩子恒传 $1）——exit 2，与门禁判决（exit 1）分开
    console.error('[commit-uuid-gate] 用法: node scripts/commit-uuid-gate.mjs <commit-msg-file>')
    process.exit(2)
  }

  let message
  try {
    message = readFileSync(msgFile, 'utf8')
  } catch (err) {
    console.error(`[commit-uuid-gate] 读不到 message 文件 ${msgFile}: ${err?.message ?? err}`)
    process.exit(2)
  }

  const root = resolveRepoRoot()
  // 根解析不出来 ⇒ 候选库为空 ⇒ evaluate 落「判据无主体」（与库缺席同一出口）
  const result = evaluateCommitUuid(message, root ? defaultDbs(root) : [])

  if (result.ok) {
    console.log(formatPassLine(result))
    if (result.code === 'no-db') console.error(formatWarning(result)) // 警示**必须走 stderr**
    process.exit(0)
  }

  console.error(formatBlockMessage(result))
  process.exit(1)
}
