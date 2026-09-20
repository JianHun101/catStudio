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
 * ── 五态判决（C4 / 票丁）──────────────────────────────────────
 *   ① 无 `catstudy [uuid]` 标记；或括号里**不是标记形态**（散文 `catstudy [uuid]`、
 *      `not-a-uuid`）                      → 放行（merge / revert / 人工提交不受影响）
 *   ② 有标记，形状非法**但够像 uuid**（hex-dash 且 ≥16 位，非 8-4-4-4-12 小写 hex）
 *                                         → 阻断 exit 1（长度错 / 大写 / 错分组 = 手打的高置信信号，无需查库）
 *   ③ 有标记，形状合法，两库都查无此 id     → 阻断 exit 1（本门禁要挡的那一类）
 *   ④ 两库文件都不存在                     → **放行 + 显式警示**（判据**无主体**，不是「通过」）；见下
 *   ⑤ 库存在但读取失败（加锁超时 / 表缺失） → 阻断 exit 1（判据有主体却判不动 ⇒ 查不动 ≠ 放行）
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
 *   node scripts/commit-uuid-gate.mjs <commit-msg-file>   # 由 .husky/commit-msg 调用
 *
 * 退出码：0 = 放行；1 = 阻断（门禁判决）；2 = 调用方错误（缺参数 / message 读不到）。
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
 * 捕获组取 `[^\]]+`——**不**限字符集，任何写歪的内容都留到形状判断里被判。
 */
export const MARKER_CAPTURE_RE = /catstudy\s+\[([^\]]+)\]/

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

  // 捕获走**本模块自己的**宽松正则（文件头「形态」段：复用定长提取器正是票丁靶心）
  const captured = MARKER_CAPTURE_RE.exec(message || '')
  // 态 ①：无标记 ⇒ 放行（merge / revert / 人工提交不受影响）
  if (!captured) return { ...base, code: 'no-marker' }

  const uuid = captured[1]
  if (!UUID_SHAPE_RE.test(uuid)) {
    // 态 ②：够像 uuid 但形状非法 ⇒ 阻断（不查库——形状错本身就是手打/截断的高置信信号）
    if (HEX_DASH_SHAPE_RE.test(uuid)) return { ...base, ok: false, code: 'bad-shape', uuid }
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
