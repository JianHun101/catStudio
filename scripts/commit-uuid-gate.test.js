/**
 * commit-uuid-gate 测试 —— C4 五态逐条 + 真机挂钩（B1 / B2）。
 *
 * 两个面：
 *   1. 判决单元面：`evaluateCommitUuid` 喂**真 SQLite 临时库文件**（承仓规「SQLite
 *      用真的」——不 mock 数据库），逐态断言**判决 + 出口文案含 uuid 原文**。
 *   2. 真机挂钩面（B2）：临时 git 仓库里真 `git commit` 两次，**以 git 确实调起
 *      `commit-msg` 为证**（认钩子自己打印的 `[commit-uuid-gate] …` 行）——不用
 *      `sh .husky/commit-msg <file>` 手工执行冒充（那证不了「钩子生效」）。
 *
 * 临时库 / 临时仓库一律落 `os.tmpdir()`——**不得落仓库根**（仓根临时产物会被
 * auto-commit 扫走）。
 *
 * 反例（B1′ 承重）：把 `hasMessageId` 的存在性查询改恒真（`SELECT 1 AS hit FROM
 * messages LIMIT 1`）⇒「查无此 id → 阻断」用例必红——实施时实跑过红→绿，见交付说明。
 *
 * 反例（票丁承重）：把 `HEX_DASH_SHAPE_RE` 那一支改回 `no-marker` ⇒ 畸形标记矩阵
 * （39 / 28 位、大写、错分组）**必红**——实施时实跑过红→绿，见交付说明。
 *
 * 反例（P2 承重）：把全候选扫描改回「只抓第一个候选」（`MARKER_CAPTURE_RE.exec(message)`）
 * ⇒「全候选扫描（P2）」那组的畸形用例与净回归用例**必红**（后者旧行为是 `not-found`、
 * 首候选实现给 `no-marker`）——实施时实跑过红→绿，见交付说明。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import {
  cleanGitEnv,
  evaluateCommitUuid,
  findNearMissMarkers,
  formatBlockMessage,
  formatPassLine,
  formatScanReport,
  formatWarning,
  resolveRepoRoot,
  scanPushRange,
  SCAN_EXIT_HIT,
  SCAN_EXIT_NOT_RUN,
} from './commit-uuid-gate.mjs'

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url))
const GATE_SRC = path.join(SCRIPTS_DIR, 'commit-uuid-gate.mjs')
const HOOK_SRC = path.join(SCRIPTS_DIR, '..', '.husky', 'commit-msg')

/** 该 id 真在库里（态「命中」的绿样本） */
const REAL_UUID = '11111111-2222-4333-8444-555555555555'
/** 形状合法、但两库都查无此行（本门禁要挡的那一类） */
const FAKE_UUID = '99999999-8888-4777-8666-555555555555'
/** 形状非法：36 位 hex 但**没有 8-4-4-4-12 分段**（够像 uuid ⇒ 态②） */
const BAD_SHAPE = '0123456789abcdef0123456789abcdef0123'
/** 形状非法：**39 位**（票丁靶心，`0b5e9e0` 事故真值——多插了一段 `31-`） */
const BAD_SHAPE_39 = 'dbb86077-de5e-4506-8f2c-31-6169d09dce33'
/** 形状非法：**28 位**（截断） */
const BAD_SHAPE_28 = 'dbb86077-de5e-4506-8f2c-6169d09'
/** 形状非法：**大写** 36 位（票丁对 P3-1 的半推翻——原先视为无标记放行） */
const BAD_SHAPE_UPPER = 'ABCDEF01-2345-4678-89AB-CDEF01234567'
/** 防误拦的反对照：散文里顺口提了标记形状，**不是**在写标记 ⇒ 必须放行 */
const PROSE_MARKER = 'docs: 说明 catstudy [uuid] 标记规则\n'

/**
 * P2 骨架：**脏候选（散文）在前、真标记在末尾**——本仓 4 笔真实 commit 的形状
 * （`40a5b835` / `9c8853a7` / `c37f1881` / `bba06f28`，首个候选全是散文里的
 * `catstudy [uuid]`，真标记在 message 末尾）。只抓第一个候选的实现会在这里静默放行。
 */
const proseThenMarker = (u) =>
  'docs: 说明 `catstudy [uuid]` 标记规则\n\nfeat(x): 干活\n\ncatstudy [' + u + ']\n'

let dir
let seq = 0
/** 本用例造出来的临时目录（真机挂钩面另开仓库）——afterEach 一并清 */
let tmpDirs = []

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'commit-uuid-gate-'))
  tmpDirs = [dir]
})

afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

/** 造一个真库；`ids` 写进 `messages` 表；`table:false` 造「库在但表缺失」 */
function makeDb(ids = [REAL_UUID], { table = true, name = null } = {}) {
  // resolve（非 join）：挂钩面传进来的 name 是**绝对路径**，join 会把它拼到 dir 后面
  const file = path.resolve(dir, name || `fixture-${seq++}.db`)
  const db = new DatabaseSync(file)
  if (table) db.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, content TEXT)')
  for (const id of ids) {
    db.prepare('INSERT INTO messages (id, content) VALUES (?, ?)').run(id, `消息 ${id}`)
  }
  db.close()
  return file
}

const dbList = (files) => files.map((file, i) => ({ label: i === 0 ? 'dev' : 'prod', file }))

const msg = (uuid) => `feat(x): 干点活\n\ncatstudy [${uuid}]\n`

describe('evaluateCommitUuid —— C4 五态', () => {
  it('态① 无 catstudy [uuid] 标记 → 放行（merge / revert / 手动提交）', () => {
    const res = evaluateCommitUuid('Merge branch "dev"\n', dbList([makeDb()]))
    expect(res.code).toBe('no-marker')
    expect(res.ok).toBe(true)
    expect(res.uuid).toBeNull()
    expect(formatPassLine(res)).toContain('无 catstudy [uuid] 标记')
  })

  it('态② 畸形标记矩阵（39 / 28 位、大写、错分组）→ 全都阻断（票丁靶心）', () => {
    // 库路径故意不存在：若实现仍去查库，落点会变成 no-db / db-error 而不是 bad-shape
    const deadDb = [{ label: 'dev', file: path.join(dir, '不存在.db') }]
    for (const bad of [BAD_SHAPE_39, BAD_SHAPE_28, BAD_SHAPE_UPPER, BAD_SHAPE]) {
      const res = evaluateCommitUuid(msg(bad), deadDb)
      // 失败信息带上被拒原文，红了能直接看出是哪一支漏了
      expect(res.code, `畸形标记 ${bad} 未被阻断（票丁的静默放行复发）`).toBe('bad-shape')
      expect(res.ok).toBe(false)
      expect(res.uuid).toBe(bad) // 被拒 uuid 原文
      expect(res.dbs).toEqual([]) // 零查询
    }
    // 事故真值单列断言：出口必须把它**原文**亮出来（否则人看不到自己写歪在哪）
    const incident = formatBlockMessage(evaluateCommitUuid(msg(BAD_SHAPE_39), deadDb))
    expect(incident).toContain(BAD_SHAPE_39)
    expect(incident).toContain('形状非法')
  })

  it('态①′ 大写 uuid 由「放行」翻为「阻断」（票丁对 P3-1 的半推翻）', () => {
    // 单列这条（矩阵里已有）是因为它**推翻了一条既有裁定**：P3-1 当初的取舍是
    // 「不改共用提取器的正则」（范围理由），不是「大写无害」（语义理由）。
    // 必须用**带字母**的 uuid：纯数字 uuid 大写后与自身相同，测不出这条。
    const res = evaluateCommitUuid(msg(BAD_SHAPE_UPPER), dbList([makeDb()]))
    expect(res.code).toBe('bad-shape')
    expect(res.ok).toBe(false)
  })

  it('态①″ 散文 `catstudy [uuid]` 不是标记 → 放行（防误拦的反对照，必须有）', () => {
    // 只加严会把正常提交拦死——正是把人推向 --no-verify 的形态
    const res = evaluateCommitUuid(PROSE_MARKER, dbList([makeDb()]))
    expect(res.code).toBe('no-marker')
    expect(res.ok).toBe(true)
    expect(res.uuid).toBeNull()
  })

  it('态①‴ 括号里写非 uuid 词（`not-a-uuid`）→ 放行', () => {
    const res = evaluateCommitUuid(msg('not-a-uuid'), dbList([makeDb()]))
    expect(res.code).toBe('no-marker')
    expect(res.ok).toBe(true)
  })

  it('态② 有标记但形状非法 → 阻断，且**不查库**', () => {
    // 库故意读不动（路径不存在）：若实现仍去查库，落点会变成 no-db 或 db-error
    const res = evaluateCommitUuid(msg(BAD_SHAPE), [
      { label: 'dev', file: path.join(dir, '不存在.db') },
    ])
    expect(res.code).toBe('bad-shape')
    expect(res.ok).toBe(false)
    expect(res.uuid).toBe(BAD_SHAPE) // 被拒 uuid 原文
    const out = formatBlockMessage(res)
    expect(out).toContain(BAD_SHAPE)
    expect(out).toContain('形状非法')
    expect(res.dbs).toEqual([]) // 零查询
  })

  it('态③ 形状合法、两库都查无此 id → 阻断（出口含 uuid 原文 / 取证命令 / 逃生口）', () => {
    const res = evaluateCommitUuid(
      msg(FAKE_UUID),
      dbList([makeDb(), makeDb()]) // 两库都真、都读得动、都没有这个 id
    )
    expect(res.code).toBe('not-found')
    expect(res.ok).toBe(false)
    const out = formatBlockMessage(res)
    expect(out).toContain(FAKE_UUID)
    expect(out).toContain('查无此行')
    expect(out).toContain('echo $CATSTUDY_TRIGGER_MSG_ID')
    expect(out).toContain('git commit --no-verify')
    // P3-2：出处提示不得写成「用户消息 id」（A2A 触发的提交按那句找必然找不到）
    expect(out).toContain('触发本次执行的那条消息 id')
    expect(out).toContain('A2A')
  })

  it('命中 → 放行（态③ 的绿样本；B1′ 反例的对照组）', () => {
    const res = evaluateCommitUuid(msg(REAL_UUID), dbList([makeDb()]))
    expect(res.code).toBe('found')
    expect(res.ok).toBe(true)
    expect(res.hit.label).toBe('dev')
    expect(formatPassLine(res)).toContain(REAL_UUID)
  })

  it('态④ 两库文件都不存在 → 放行 + 警示（判据无主体）', () => {
    const dbs = [
      { label: 'dev', file: path.join(dir, 'no-dev.db') },
      { label: 'prod', file: path.join(dir, 'no-prod.db') },
    ]
    const res = evaluateCommitUuid(msg(REAL_UUID), dbs)
    expect(res.code).toBe('no-db')
    expect(res.ok).toBe(true)
    const warn = formatWarning(res)
    expect(warn).toContain('判据无主体')
    expect(warn).toContain('未校验')
    expect(warn).toContain('no-dev.db')
  })

  it('态④′ 未解析出主仓库根（候选库为空）→ 同一出口，警示点名根解析失败', () => {
    const res = evaluateCommitUuid(msg(REAL_UUID), [])
    expect(res.code).toBe('no-db')
    expect(res.ok).toBe(true)
    expect(formatWarning(res)).toContain('未解析出主仓库根')
  })

  it('态⑤ 库存在但表缺失 → 阻断（查不动 ≠ 放行，出口带库路径与原因）', () => {
    const file = makeDb([], { table: false })
    const res = evaluateCommitUuid(msg(REAL_UUID), [{ label: 'dev', file }])
    expect(res.code).toBe('db-error')
    expect(res.ok).toBe(false)
    const out = formatBlockMessage(res)
    expect(out).toContain(REAL_UUID)
    expect(out).toContain('读取失败')
    expect(out).toContain('no such table')
  })

  it('命中优先于读不动：一库坏、另一库命中 → 放行（方向向严，不放过查无此 id 的提交）', () => {
    const broken = makeDb([], { table: false })
    const good = makeDb([REAL_UUID])
    const res = evaluateCommitUuid(msg(REAL_UUID), [
      { label: 'dev', file: broken },
      { label: 'prod', file: good },
    ])
    expect(res.code).toBe('found')
    expect(res.ok).toBe(true)
    expect(res.hit.label).toBe('prod')
  })
})

// ─── P2 全候选扫描：脏候选在前时不许静默放行（审查者实证的净回归）─────────────

describe('evaluateCommitUuid —— 全候选扫描（P2）', () => {
  it('脏候选在前 + 后面是**畸形标记** → 仍阻断（票丁靶心，首个候选非畸形也不放过）', () => {
    // 库路径故意不存在：若实现仍去查库，落点会变成 no-db 而不是 bad-shape
    const deadDb = [{ label: 'dev', file: path.join(dir, '不存在.db') }]
    const res = evaluateCommitUuid(proseThenMarker(BAD_SHAPE_39), deadDb)
    expect(res.code, '脏候选在前时畸形标记又被静默放行了（票丁靶心未闭合）').toBe('bad-shape')
    expect(res.ok).toBe(false)
    expect(res.uuid).toBe(BAD_SHAPE_39) // 被拒的是**畸形原文**，不是前面那个脏候选
    expect(res.dbs).toEqual([]) // 零查询
  })

  it('脏候选在前 + 后面是**形状合法但查无此 id** 的真标记 → 阻断（净回归的防线）', () => {
    // 旧 `extractCommitUuid` 在这里返回 FAKE_UUID（正则内建形状要求 ⇒ 回溯跳过脏候选）
    // ⇒ 走态③阻断。只抓第一个候选的实现会返回 `no-marker` —— 这就是净回归本身。
    const res = evaluateCommitUuid(proseThenMarker(FAKE_UUID), dbList([makeDb()]))
    expect(res.code, '脏候选把后面的真标记挡掉了（旧实现会落 not-found）').toBe('not-found')
    expect(res.ok).toBe(false)
    expect(res.uuid).toBe(FAKE_UUID) // 被查的是真标记，不是脏候选
  })

  it('脏候选在前 + 后面是**库中真值** → 放行（真值不被脏候选挡住）', () => {
    const res = evaluateCommitUuid(proseThenMarker(REAL_UUID), dbList([makeDb()]))
    expect(res.code).toBe('found')
    expect(res.ok).toBe(true)
    expect(res.uuid).toBe(REAL_UUID)
    expect(res.hit.label).toBe('dev')
  })

  it('漏写 `]` 的 `catstudy [` 不吞掉后面的真标记（捕获排除换行）', () => {
    // 放开换行（`[^\]]+`）时首个候选会一路吞到后面那个 `]`，把真标记整个吃掉 ⇒ no-marker。
    // 排除换行后该位置失配、引擎继续向后搜 ⇒ 真标记仍被看见。
    const swallow = 'chore: 手滑写了个 catstudy [oops\n\ncatstudy [' + REAL_UUID + ']\n'
    const res = evaluateCommitUuid(swallow, dbList([makeDb()]))
    expect(res.code, '漏写的 `[` 吞掉了后面的真标记').toBe('found')
    expect(res.uuid).toBe(REAL_UUID)
  })

  it('多个畸形候选 → 报**第一个**畸形原文（出口亮的是人写歪的那处）', () => {
    const message =
      'feat: x\n\ncatstudy [' + BAD_SHAPE_28 + ']\n\ncatstudy [' + BAD_SHAPE_39 + ']\n'
    const res = evaluateCommitUuid(message, [{ label: 'dev', file: path.join(dir, 'x.db') }])
    expect(res.code).toBe('bad-shape')
    expect(res.uuid).toBe(BAD_SHAPE_28)
  })

  it('脏候选 + 散文候选（无形状合法者、无畸形）→ 放行（态①″ 不受多候选影响）', () => {
    const res = evaluateCommitUuid(
      'docs: catstudy [uuid] 与 catstudy [not-a-uuid] 都只是举例\n',
      dbList([makeDb()])
    )
    expect(res.code).toBe('no-marker')
    expect(res.ok).toBe(true)
  })
})

// ─── 态②′ 近 miss 前缀（票 hook-marker-fail-open）──────────────────────────
//
// 靶心：**标记意图 + uuid 形**都在，就是 `catstudy` 没写对 ⇒ 原先落 ①「无标记」
// 静默放行（`99cee01b` = `catstance [bdbf52de-…]` 实证落在 origin/dev 上）。
//
// 反例（承重）：把态②′ 那一段挪回「有候选但都不合法」那一支（即首版实现），
// 下方「无 `catstudy` 候选」用例组**必红**——实施时实跑过红→绿，见交付说明。

describe('evaluateCommitUuid —— 态②′ 近 miss 前缀', () => {
  /** 库路径故意不存在：若实现去查库，落点会变成 no-db 而不是 near-miss */
  const deadDb = () => [{ label: 'dev', file: path.join(dir, '不存在.db') }]

  it('误拼矩阵（前缀写歪的各种写法）→ 全阻断，且**零查库**', () => {
    const matrix = [
      ['事故原文 catstance', `catstance [${REAL_UUID}]`],
      ['少字母 catsudy', `catsudy [${REAL_UUID}]`],
      ['多字母 catstuddy', `catstuddy [${REAL_UUID}]`],
      ['首字母大写 Catstudy', `Catstudy [${REAL_UUID}]`],
      ['全大写 CATSTUDY', `CATSTUDY [${REAL_UUID}]`],
      ['无空格 catstance[', `catstance[${REAL_UUID}]`],
      ['夹在正文里', `docs: 见 catstance [${REAL_UUID}] 一段`],
      // 前缀对了但**大小写**歪的也算写歪：主捕获正则是小写敏感，认不出它 ⇒ 同族缺口
      ['uuid 也写歪（39 位）', `catstance [${BAD_SHAPE_39}]`],
    ]
    for (const [name, body] of matrix) {
      const res = evaluateCommitUuid(`feat(x): 干活\n\n${body}\n`, deadDb())
      expect(res.code, `${name} 未被阻断（fail-open 复发）`).toBe('near-miss')
      expect(res.ok).toBe(false)
      expect(res.dbs).toEqual([]) // 零查询：拼错本身就是高置信信号，不必查库
    }
  })

  it('出口点名「写歪在哪、应该写成什么」（只说「没有标记」正是要止住的那句假话）', () => {
    const res = evaluateCommitUuid(`feat: x\n\ncatstance [${REAL_UUID}]\n`, deadDb())
    const out = formatBlockMessage(res)
    expect(out).toContain('[commit-uuid-gate] ❌ commit-msg 门禁阻断（near-miss）')
    expect(out).toContain(`catstance [${REAL_UUID}]`) // 被拒标记原文
    expect(out).toContain('catstance') // 写歪的前缀
    expect(out).toContain('catstudy') // 正确前缀
    expect(out).toContain('git commit --no-verify') // 逃生口照旧
  })

  it('反对照：散文 / 裸词 / 非 uuid 括号 —— 都不许被这条闸碰到', () => {
    // 只加严会把正常提交拦死，而误拦的压力正是把人推向 --no-verify 的形态
    const passing = [
      ['散文里的标记形状', 'docs: 说明 catstudy [uuid] 标记规则\n'],
      ['散文里的近 miss 词但括号非 uuid 形', 'docs: catstance [见附录] 是个拼错的例子\n'],
      [
        '裸词 cat（长度 3 够不到 {2,} 下限）',
        'docs: the cat [deadbeef-cafe-1234-5678-90abcdef1234]\n',
      ],
      ['别的词', 'docs: catalog [abcdef0123456789abcdef] 已更新\n'],
      ['完全无标记', 'Merge branch "dev"\n'],
    ]
    for (const [name, message] of passing) {
      const res = evaluateCommitUuid(message, dbList([makeDb()]))
      expect(res.code, `${name} 被误拦`).toBe('no-marker')
      expect(res.ok).toBe(true)
    }
  })

  it('有真标记时顺口提一句写歪的 → 不额外阻断（归属面已成立，边界有意为之）', () => {
    const res = evaluateCommitUuid(
      `feat: x\n\n以前写成 catstance [${FAKE_UUID}] 是错的\n\ncatstudy [${REAL_UUID}]\n`,
      dbList([makeDb()])
    )
    expect(res.code).toBe('found')
    expect(res.ok).toBe(true)
    expect(res.uuid).toBe(REAL_UUID)
  })

  it('前缀对、uuid 歪 → 仍报 ②bad-shape（更贴靶心的措辞优先于 ②′）', () => {
    const res = evaluateCommitUuid(`feat: x\n\ncatstudy [${BAD_SHAPE_39}]\n`, deadDb())
    expect(res.code).toBe('bad-shape')
    expect(res.uuid).toBe(BAD_SHAPE_39)
  })

  it('findNearMissMarkers 逐字剔 `catstudy`（大小写不同即算写歪）', () => {
    expect(
      findNearMissMarkers('feat: x\n\ncatstudy [11111111-2222-4333-8444-555555555555]\n')
    ).toEqual([])
    expect(
      findNearMissMarkers('feat: x\n\nCatstudy [11111111-2222-4333-8444-555555555555]\n').map(
        (h) => h.word
      )
    ).toEqual(['Catstudy'])
  })

  it('误拦面回放：全仓历史里本判据不得大面积翻案（放宽守卫）', () => {
    // 实测基线（2026-09-28，`--all --no-merges` 1192 笔、其中「今天放行」175 笔）：
    // 命中 **1** 笔，就是事故笔 `99cee01b`（word=catstance）。这里卡一个上界当
    // **放宽守卫**：判据要是哪天宽到开始吃正常散文，命中数会直接跳上去。
    // 上界取 2 而不是 1：同一族再复发一笔不该让本用例红（那是业务信号不是回归）。
    const out = spawnSync('git', ['log', '--all', '--no-merges', '--format=%H%x01%B%x02'], {
      cwd: SCRIPTS_DIR,
      encoding: 'utf8',
      maxBuffer: 1 << 28,
      env: cleanGitEnv(),
    })
    if (out.status !== 0) return // 非仓库 / 浅克隆：回放无意义，不假绿也不假红
    const commits = String(out.stdout || '')
      .split('\x02')
      .filter((s) => s.trim())
      .map((s) => s.slice(s.indexOf('\x01') + 1))
    if (commits.length < 100) return // 浅克隆：分母太小，回放没有判别力

    const flips = []
    for (const msg of commits) {
      // 只回放「今天会放行」的那批：无标记 / 散文（有形状合法标记的走查库，不受本判据影响）
      if (evaluateCommitUuid(msg, []).code !== 'no-marker') continue
      for (const nm of findNearMissMarkers(msg)) flips.push(nm.word)
    }
    expect(
      flips.length,
      `历史回放命中 ${flips.length} 笔：${flips.join('、')}`
    ).toBeLessThanOrEqual(2)
  })
})

// ─── B2 真机挂钩：临时 git 仓库里真 commit，认钩子自己打印的那行 ─────────────

/** 跑一条 git 命令，**stdout / stderr 都留**（成功时 execFileSync 会丢掉 stderr——
 *  而钩子的输出正是取证面，丢不得）。
 *  env 走 `cleanGitEnv()`：本测试自己也常在被 git 调起的环境里跑（pre-commit →
 *  `pnpm test`），git 注入的 `GIT_DIR` 若透传，临时仓库里的 `git commit` 会认外层
 *  仓库 —— 测试就不再封闭。剥离清单与源码同源，不另写一份。 */
function gitRun(cwd, args, extraEnv = {}) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...cleanGitEnv(), ...extraEnv },
  })
}

/** 断言性 git 调用：非 0 退出即抛（造仓库用） */
function git(cwd, args, extraEnv = {}) {
  const r = gitRun(cwd, args, extraEnv)
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${r.stderr}`)
  return r.stdout
}

/** 造一个「钩子已挂上」的临时仓库：`.husky/commit-msg` + 它依赖的三个脚本 + 库 */
function makeHookedRepo({ ids = [REAL_UUID] } = {}) {
  const repo = mkdtempSync(path.join(tmpdir(), 'commit-uuid-gate-repo-'))
  tmpDirs.push(repo)
  const env = {
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: repo, // 隔开全局 config（别让宿主机的 hooksPath / gpgsign 泄进来）
    USERPROFILE: repo,
    XDG_CONFIG_HOME: repo,
  }
  git(repo, ['init', '-q'], env)
  git(repo, ['config', 'user.email', 'gate@test.local'], env)
  git(repo, ['config', 'user.name', 'gate-test'], env)
  git(repo, ['config', 'commit.gpgsign', 'false'], env)
  git(repo, ['config', 'core.hooksPath', '.husky'], env)

  mkdirSync(path.join(repo, 'scripts', 'flywheel'), { recursive: true })
  mkdirSync(path.join(repo, '.husky'), { recursive: true })
  // 门禁脚本 import 的两个同伴一起搬过去（三文件互为单源，缺一跑不起来）
  copyFileSync(GATE_SRC, path.join(repo, 'scripts', 'commit-uuid-gate.mjs'))
  copyFileSync(
    path.join(SCRIPTS_DIR, 'handoff-gen.mjs'),
    path.join(repo, 'scripts', 'handoff-gen.mjs')
  )
  copyFileSync(
    path.join(SCRIPTS_DIR, 'flywheel', 'retire-message-memory.mjs'),
    path.join(repo, 'scripts', 'flywheel', 'retire-message-memory.mjs')
  )
  copyFileSync(HOOK_SRC, path.join(repo, '.husky', 'commit-msg'))

  // 根解析取「主仓库」= 这个临时仓库自己 ⇒ 库落它自己的 packages/server/data/
  const dataDir = path.join(repo, 'packages', 'server', 'data')
  mkdirSync(dataDir, { recursive: true })
  makeDb(ids, { name: path.join(dataDir, 'cat-study-dev.db') })

  writeFileSync(path.join(repo, 'work.txt'), 'x\n')
  git(repo, ['add', 'work.txt'], env)
  return { repo, env }
}

/** 已落地的 commit 数；HEAD 未出生（零提交）时 git 会报错 ⇒ 归 0 */
function commitCount(repo, env) {
  try {
    return git(repo, ['rev-list', '--count', 'HEAD'], env).trim()
  } catch {
    return '0'
  }
}

/** 跑一次真 `git commit`，连 stdout/stderr 一起回传（钩子输出混在其中） */
function commit(repo, env, message) {
  const r = gitRun(repo, ['commit', '-m', message], env)
  return { ok: r.status === 0, output: `${r.stdout || ''}${r.stderr || ''}` }
}

describe('B2 真机挂钩（临时仓库 · 真 git commit）', () => {
  it('假 uuid 被拒、真 uuid 通过——以 git 确实调起 commit-msg 为证', () => {
    const { repo, env } = makeHookedRepo()

    // ① 假 uuid（形状合法、库中查无）⇒ 被拒
    const bad = commit(repo, env, `feat: 假 uuid\n\ncatstudy [${FAKE_UUID}]\n`)
    expect(bad.ok, `假 uuid 竟然提交成功，输出:\n${bad.output}`).toBe(false)
    // 证据：钩子**自己**打印的那行（手工 sh 冒充不会有这条 git 侧输出）
    expect(bad.output).toContain('[commit-uuid-gate]')
    expect(bad.output).toContain('门禁阻断')
    expect(bad.output).toContain(FAKE_UUID)
    // 钩子侧压掉了 node:sqlite 的 ExperimentalWarning——别让它每次提交刷两行
    expect(bad.output).not.toContain('ExperimentalWarning')
    // 被拒后仓库里不应留下 commit
    expect(commitCount(repo, env)).toBe('0')

    // ② 库里真有的 uuid ⇒ 通过
    const good = commit(repo, env, `feat: 真 uuid\n\ncatstudy [${REAL_UUID}]\n`)
    expect(good.ok, `真 uuid 被误拦，输出:\n${good.output}`).toBe(true)
    expect(good.output).toContain('[commit-uuid-gate]')
    expect(good.output).toContain(REAL_UUID)
    expect(commitCount(repo, env)).toBe('1')

    // ③ 无标记 ⇒ 放行（merge / 手动提交不受影响）
    writeFileSync(path.join(repo, 'work2.txt'), 'y\n')
    git(repo, ['add', 'work2.txt'], env)
    const plain = commit(repo, env, 'chore: 无标记\n')
    expect(plain.ok, `无标记被误拦，输出:\n${plain.output}`).toBe(true)
    expect(plain.output).toContain('无 catstudy [uuid] 标记')
    expect(commitCount(repo, env)).toBe('2')
  }, 60_000)

  it('畸形标记（39 位）被拒——认钩子自打的 bad-shape 行（票丁真机取证）', () => {
    const { repo, env } = makeHookedRepo()

    const r = commit(repo, env, `refactor: 畸形标记\n\ncatstudy [${BAD_SHAPE_39}]\n`)
    expect(
      r.ok,
      `39 位畸形标记竟然提交成功（票丁的失效模式在真机面复发），输出:\n${r.output}`
    ).toBe(false)
    // 机器证据：钩子自己打印的判决码行（手工 sh 冒充不会有这条 git 侧输出）
    expect(r.output).toContain(`[commit-uuid-gate] ❌ commit-msg 门禁阻断（bad-shape）`)
    expect(r.output).toContain(BAD_SHAPE_39) // 被拒原文
    expect(commitCount(repo, env)).toBe('0')

    // 反对照（同一条真机路径）：散文提了一句标记形状 ⇒ 不该被这条闸拦
    // 新开一个文件（work.txt 已被上一次 commit 吃进树，改了它会是「无改动可提交」）
    writeFileSync(path.join(repo, 'work-prose.txt'), 'y\n')
    git(repo, ['add', 'work-prose.txt'], env)
    const prose = commit(repo, env, PROSE_MARKER)
    expect(prose.ok, `散文标记被误拦，输出:\n${prose.output}`).toBe(true)
    expect(commitCount(repo, env)).toBe('1')

    // P2 真机面：**脏候选在前** + 畸形标记在后 ⇒ 必须仍被拦（票丁靶心在真机路径闭合）。
    // 只抓第一个候选的实现在这里是放行 —— 即失效模式在真机面复发。
    writeFileSync(path.join(repo, 'work-prose2.txt'), 'z\n')
    git(repo, ['add', 'work-prose2.txt'], env)
    const lateBad = commit(repo, env, proseThenMarker(BAD_SHAPE_39))
    expect(
      lateBad.ok,
      `脏候选在前时 39 位畸形标记提交成功了（票丁失效模式在真机面复发），输出:\n${lateBad.output}`
    ).toBe(false)
    expect(lateBad.output).toContain('[commit-uuid-gate] ❌ commit-msg 门禁阻断（bad-shape）')
    expect(lateBad.output).toContain(BAD_SHAPE_39)
    expect(commitCount(repo, env)).toBe('1') // 被拒 ⇒ 不新增 commit
  }, 60_000)
})

describe('B2′ 真机挂钩 —— 近 miss 标记被 git 挡住（票 hook-marker-fail-open）', () => {
  it('`catstance [真 uuid]` 在 commit 那一刻被拒，附正常标记的反对照', () => {
    const { repo, env } = makeHookedRepo()

    const bad = commit(repo, env, `feat: 误拼标记\n\ncatstance [${REAL_UUID}]\n`)
    expect(bad.ok, `误拼标记竟然提交成功（fail-open 在真机面复发），输出:\n${bad.output}`).toBe(
      false
    )
    // 机器证据：钩子自己打印的判决码行（不含则说明这条闸压根没跑到）
    expect(bad.output).toContain('[commit-uuid-gate] ❌ commit-msg 门禁阻断（near-miss）')
    expect(bad.output).toContain('catstance')
    expect(commitCount(repo, env)).toBe('0')

    // 反对照 1：同一路径下正常标记照常放行
    const good = commit(repo, env, `feat: 正常标记\n\ncatstudy [${REAL_UUID}]\n`)
    expect(good.ok, `正常标记被误拦，输出:\n${good.output}`).toBe(true)
    expect(commitCount(repo, env)).toBe('1')

    // 反对照 2：无标记（merge / 手动提交形态）照常放行
    writeFileSync(path.join(repo, 'work2.txt'), 'y\n')
    git(repo, ['add', 'work2.txt'], env)
    const plain = commit(repo, env, 'chore: 无标记\n')
    expect(plain.ok, `无标记被误拦，输出:\n${plain.output}`).toBe(true)
    expect(commitCount(repo, env)).toBe('2')
  }, 60_000)
})

// ─── 推送栈近 miss 扫描（态②′ 的兜底面：搭车形态）──────────────────────────
//
// 靶心是 sha 判据**看不见**的那一面：栈顶已审 ≠ 栈内每一笔标记都写对。实测事故
// `99cee01b` 就是这么上到 origin/dev 的（父提交标记正常、tip 也审过，唯独它拼错）。
// 这里用**真仓库 + 真 refspec 范围**测扫描器本身；钩子接线由 e2e 面覆盖。

/** 造一个「有远端」的仓库：返回 {repo, bare, env, commitFile} */
function makePushRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'marker-scan-'))
  tmpDirs.push(root)
  const bare = path.join(root, 'origin.git')
  const repo = path.join(root, 'work')
  mkdirSync(repo, { recursive: true })
  const env = {
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: repo,
    USERPROFILE: repo,
    XDG_CONFIG_HOME: repo,
  }
  git(root, ['init', '-q', '--bare', '--initial-branch=main', bare], env)
  git(repo, ['init', '-q', '--initial-branch=main'], env)
  git(repo, ['config', 'user.email', 'scan@test.local'], env)
  git(repo, ['config', 'user.name', 'scan-test'], env)
  git(repo, ['config', 'commit.gpgsign', 'false'], env)
  git(repo, ['remote', 'add', 'origin', bare], env)
  const commitFile = (name, message) => {
    writeFileSync(path.join(repo, name), `${name}\n`)
    git(repo, ['add', name], env)
    git(repo, ['commit', '-q', '-m', message], env)
    return git(repo, ['rev-parse', 'HEAD'], env).trim()
  }
  return { repo, bare, env, commitFile }
}

describe('scanPushRange —— 推送栈近 miss 扫描', () => {
  it('新分支口径：扫出远端还没有的 commit，命中误拼笔', () => {
    const { repo, env, commitFile } = makePushRepo()
    commitFile('a.txt', 'chore: 基线')
    git(repo, ['push', '-q', 'origin', 'main'], env)
    commitFile('b.txt', 'fix: 正常\n\ncatstudy [11111111-2222-4333-8444-555555555555]')
    const c = commitFile('c.txt', 'docs: 误拼\n\ncatstance [11111111-2222-4333-8444-555555555555]')
    commitFile('d.txt', 'fix: 后续\n\ncatstudy [11111111-2222-4333-8444-555555555555]')

    // base 传全 0（新分支）⇒ 走 `--not --remotes`：基线已在 origin/main 上，被排除
    const res = scanPushRange({ cwd: repo, tip: 'HEAD', base: '0'.repeat(40) })
    expect(res.error).toBeNull()
    expect(res.scanned).toBe(3) // b / c / d，不含已在远端的基线
    expect(res.hits.map((h) => h.sha)).toEqual([c])
    expect(res.hits[0].word).toBe('catstance')
    expect(formatScanReport(res)).toContain('写成 `catstance`')

    // 反对照：干净栈 ⇒ 零命中（本层不许误拦）
    git(repo, ['checkout', '-q', '-b', 'clean', 'HEAD~2']) // d→c→b：退两笔才甩掉误拼笔 c
    const clean = scanPushRange({ cwd: repo, tip: 'HEAD', base: '0'.repeat(40) })
    expect(clean.hits).toEqual([])
    expect(formatScanReport(clean)).toContain('无写歪的标记')
  }, 60_000)

  it('范围口径：base..tip 只扫本次新增的那几笔', () => {
    const { repo, env, commitFile } = makePushRepo()
    const a = commitFile('a.txt', 'chore: 基线')
    git(repo, ['push', '-q', 'origin', 'main'], env)
    commitFile('b.txt', 'docs: 误拼\n\ncatstance [11111111-2222-4333-8444-555555555555]')
    const c = commitFile('c.txt', 'fix: 后续\n\ncatstudy [11111111-2222-4333-8444-555555555555]')

    // base = a ⇒ 只扫 b..c 两笔（b 命中）
    const res = scanPushRange({ cwd: repo, tip: c, base: a })
    expect(res.scanned).toBe(2)
    expect(res.hits.map((h) => h.sha.slice(0, 7))).toEqual([res.hits[0].sha.slice(0, 7)])
    expect(res.hits).toHaveLength(1)

    // 反对照：base = c（不带任何新 commit）⇒ 零命中
    const none = scanPushRange({ cwd: repo, tip: c, base: c })
    expect(none.scanned).toBe(0)
    expect(none.hits).toEqual([])
  }, 60_000)

  // 退出码是**跨进程契约**（`.husky/pre-push` 按它分流），所以钉在 CLI 面而不是函数面。
  // 靶心：命中码**不能是 1**——1 是 node 自己的失败码（`Cannot find module` / 未捕获
  // 异常），拿它当命中会让「scripts 没搬过来」的仓库把每次合法推送都拦死。
  // 实测：`pre-push-gate.e2e.mjs` 的 6 个「应当放行」场景被这条重载全数误伤。
  it('CLI 退出码契约：命中=3、跑不动=2，**都不许是 1**（node 自己的失败码）', () => {
    expect(SCAN_EXIT_HIT).not.toBe(1)
    expect(SCAN_EXIT_NOT_RUN).not.toBe(1)
    expect(SCAN_EXIT_HIT).not.toBe(SCAN_EXIT_NOT_RUN)

    const { repo, env, commitFile } = makePushRepo()
    commitFile('a.txt', 'chore: 基线')
    git(repo, ['push', '-q', 'origin', 'main'], env)
    commitFile('b.txt', 'docs: 误拼\n\ncatstance [11111111-2222-4333-8444-555555555555]')
    const hit = spawnSync(process.execPath, [GATE_SRC, '--scan-push', 'HEAD', '0'.repeat(40)], {
      cwd: repo,
      encoding: 'utf8',
      env: cleanGitEnv(),
    })
    expect(hit.status, `命中应退 ${SCAN_EXIT_HIT}，实得 ${hit.status}`).toBe(SCAN_EXIT_HIT)
    expect(hit.stdout).toContain('写成 `catstance`')

    // 非 git 目录 ⇒ 2（跑不动），警示走 stderr，**不当成命中**
    const outside = mkdtempSync(path.join(tmpdir(), 'marker-scan-cli-'))
    tmpDirs.push(outside)
    const notRun = spawnSync(process.execPath, [GATE_SRC, '--scan-push', 'HEAD'], {
      cwd: outside,
      encoding: 'utf8',
      env: cleanGitEnv(),
    })
    expect(notRun.status).toBe(SCAN_EXIT_NOT_RUN)
    expect(notRun.stderr).toContain('未跑成')
  }, 60_000)

  it('扫描跑不动（非 git 目录）⇒ error 非空、**不抛**（调用方警示后放行，不阻断）', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'marker-scan-nogit-'))
    tmpDirs.push(outside)
    const res = scanPushRange({ cwd: outside, tip: 'HEAD' })
    expect(res.error).toBeTruthy()
    expect(res.hits).toEqual([])
    // 报告走的是「未跑成」那一支，措辞不能是「干净」（否则判据无主体被当成通过）
    expect(formatScanReport(res)).toContain('未跑成')
  }, 60_000)
})

// ─── C3 根解析（worktree 承重：库在主仓库，不在 worktree）──────────────────

describe('resolveRepoRoot', () => {
  it('worktree 内解析到**主仓库根**（不是 worktree 自己）', () => {
    const root = resolveRepoRoot(SCRIPTS_DIR)
    expect(root).toBeTruthy()
    expect(existsSync(path.join(root, '.git'))).toBe(true)
    // 主仓库根下才有的东西（本测试所在 worktree 里也有 packages/ —— 判据取 .git 目录）
    expect(path.isAbsolute(root)).toBe(true)
  })

  it('非 git 目录 → null（调用方落「判据无主体」态）', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'commit-uuid-gate-nogit-'))
    try {
      expect(resolveRepoRoot(outside)).toBeNull()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('继承来的 GIT_DIR 被剥掉——cwd 才是唯一输入（钩子内跑测试踩过）', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'commit-uuid-gate-nogit-'))
    const outerGitDir = git(SCRIPTS_DIR, ['rev-parse', '--absolute-git-dir']).trim()
    try {
      // 先证明这个环境变量真的会把 cwd 架空（否则本用例是恒真的假门）
      const leaked = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
        cwd: outside,
        encoding: 'utf8',
        env: { ...process.env, GIT_DIR: outerGitDir },
      })
      expect(leaked.status).toBe(0)
      expect(leaked.stdout.trim()).toContain('.git')

      // 而 resolveRepoRoot 在同样的污染环境下仍按 cwd 判（干净 ⇒ null）
      process.env.GIT_DIR = outerGitDir
      try {
        expect(resolveRepoRoot(outside)).toBeNull()
      } finally {
        delete process.env.GIT_DIR
      }
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('cleanGitEnv 只剥 git 定位变量，不动别的（剥离清单单源）', () => {
    const env = cleanGitEnv({
      GIT_DIR: '/x/.git',
      GIT_INDEX_FILE: '/x/.git/index',
      PATH: '/usr/bin',
      HOME: '/home/x',
    })
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/x' })
  })
})
