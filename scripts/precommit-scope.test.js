/**
 * `scripts/precommit-scope.mjs` 的判据矩阵 —— 票 `docs/run/precommit-scope/tickets.md` §三
 * 逐格覆盖（V1–V7、V9）。纯函数，无 I/O（唯一的 I/O 面 `projectNameOf` 单列在最后一组）。
 *
 * 两条防恒真的结构性断言（不做这两条，整张矩阵会退化成「测了个常量」）：
 *   ① **契约不变量**：`skip === true` ⇔ `projects` 为空；`skip === false` ⇒ `projects` 是
 *      `ALL_PROJECTS` 的**子序列**。矩阵每格都过一遍这条 ⇒ 单格漏写 `projects` 会被抓。
 *   ② **非恒真对照**：`docs/run/**`（跳过）与 `packages/server/**`（收窄）必须给出**不同**读数
 *      —— 若实现把所有输入都判成同一档，矩阵会全绿而门禁是坏的。
 *
 * ⚠️ **残余收口单B 起的语义变更（改本文件期望值前先读这段）**：命中任一 `packages/**` scope 时
 * 追加 `scripts`（`test-isolation-guard.test.js` 属该 project，护栏须在「改 packages 的提交口」
 * 在岗）。故本文件里**一切含 packages scope 的期望值都比改前多一个尾项 `scripts`**；
 * 期望值仍逐格写字面量（不由实现推导——一旦从实现反推，追加规则改了测试会跟着改，等于没测）。
 * 单靠 `scripts/**` 或纯文档的格子不受影响。
 */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  ALL_PROJECTS,
  HEAVY_CASES,
  buildVitestArgs,
  isFullScope,
  resolveScopes,
  projectNameOf,
} from './precommit-scope.mjs'

const ALL = [...ALL_PROJECTS]

/** 契约不变量（票面 §2.2）：每格都要过 */
function expectContract(decision) {
  expect(typeof decision.reason, 'reason 必须是字符串（供排障打印）').toBe('string')
  expect(decision.reason.length, 'reason 不得为空').toBeGreaterThan(0)
  if (decision.skip) {
    expect(decision.projects, 'skip=true ⇒ projects 必须为空').toEqual([])
  } else {
    expect(decision.projects.length, 'skip=false ⇒ projects 非空').toBeGreaterThan(0)
    // 子序列：只允许 ALL_PROJECTS 的成员，且相对顺序与 ALL_PROJECTS 一致
    const idx = decision.projects.map((p) => ALL.indexOf(p))
    expect(
      idx.every((i) => i >= 0),
      `projects 含非成员：${decision.projects.join(',')}`
    ).toBe(true)
    expect(idx, 'projects 顺序必须与 ALL_PROJECTS 一致（顺序不定 ⇒ 读数不可比）').toEqual(
      [...idx].sort((a, b) => a - b)
    )
  }
}

/** 收窄断言：跑指定 project（顺序按 ALL_PROJECTS） */
function expectScoped(paths, projects) {
  const d = resolveScopes(paths)
  expectContract(d)
  expect(d).toMatchObject({ projects, skip: false })
  return d
}

/** 全量断言 */
function expectFull(paths) {
  const d = resolveScopes(paths)
  expectContract(d)
  expect(d).toMatchObject({ projects: ALL, skip: false })
  return d
}

/** 跳过断言 */
function expectSkip(paths) {
  const d = resolveScopes(paths)
  expectContract(d)
  expect(d).toMatchObject({ projects: [], skip: true })
  return d
}

describe('resolveScopes · §2.1 映射表逐行', () => {
  // V1 纯文档 —— 在飞文档 / 纯文本，无测试消费者
  it.each([
    ['docs/run/precommit-scope/tickets.md'],
    ['docs/run/precommit-scope/report.md'],
    ['docs/sessions/cat-study-x-summary.md'],
    ['README.md'],
    ['CONTEXT.md'],
    ['AGENTS.md'],
    ['docs/run/nested/deep/note.md'],
  ])('V1 跳过：%s', (p) => expectSkip([p]))

  // V2 单包（+ 护栏 scripts：`packages/**` 一律追加，见文件头 ⚠️）
  it.each([
    ['packages/server/src/execution/serial.ts', ['packages/server', 'scripts']],
    ['packages/server/vitest.config.ts', ['packages/server', 'scripts']],
    ['packages/web/src/App.vue', ['packages/web', 'scripts']],
    // scripts 自身的改动**不反向**追加 packages（单B 是单向规则）
    ['scripts/precommit-scope.mjs', ['scripts']],
    ['scripts/precommit-scope.test.js', ['scripts']],
  ])('V2 单包：%s ⇒ %j', (p, projects) => expectScoped([p], projects))

  // V3 契约层 —— 三包都依赖 ⇒ 全量
  it('V3 契约层：packages/shared/** ⇒ 全量 4', () => {
    expectFull(['packages/shared/src/index.ts'])
    expectFull(['packages/shared/package.json'])
  })

  // V4 测试基础设施 —— 全量
  it.each([
    ['vitest.config.ts'],
    ['scripts/vitest.config.ts'],
    ['package.json'],
    ['pnpm-lock.yaml'],
    ['pnpm-workspace.yaml'],
    ['.husky/pre-commit'],
    ['.husky/commit-msg'],
    ['tsconfig.base.json'],
    // 票面作 `tsconfig*.json` 不限定目录 ⇒ 包内 tsconfig 也全量（向严）
    ['packages/server/tsconfig.json'],
    ['packages/web/tsconfig.node.json'],
    ['internal/tsconfig.build.json'],
  ])('V4 基础设施全量：%s', (p) => expectFull([p]))

  // V6 记忆面 —— 消费者在 server（scripts/flywheel/scan.mjs 的白名单）。
  // ⚠️ 这三格也吃到单B 的追加：映射出的 scope 是 `packages/server`，判据看的是 **scope** 而非
  // 原始路径 ⇒ 记忆面改动同样带跑护栏。这是判据的**字面后果**（§二-4 写的是「命中任一
  // `packages/**` scope」），已按实钉在此处，不当意外。
  it.each([
    ['docs/adr/0015-x.md'],
    ['docs/lessons/some-lesson.md'],
    ['docs/plans/review-chain-anchor.md'],
  ])('V6 记忆面 ⇒ packages/server（+ 护栏 scripts）：%s', (p) =>
    expectScoped([p], ['packages/server', 'scripts'])
  )

  // V7 fail-closed —— 任何无法归类的路径
  it.each([['foo.unknown'], ['src/random.txt'], ['Makefile'], ['docs/mystery.json'], ['']])(
    'V7 无法归类 ⇒ 全量（fail-closed）：%s',
    (p) => {
      expectFull([p])
    }
  )
})

describe('resolveScopes · 并集 / 优先级 / 边界', () => {
  // V5 并集 + 顺序确定
  it('V5 并集：server + web ⇒ 两个 project + 护栏 scripts，顺序确定（与入参次序无关）', () => {
    expectScoped(
      ['packages/server/a.ts', 'packages/web/b.vue'],
      ['packages/server', 'packages/web', 'scripts']
    )
    expectScoped(
      ['packages/web/b.vue', 'packages/server/a.ts'],
      ['packages/server', 'packages/web', 'scripts']
    )
  })

  it('并集：三包 + scripts ⇒ 四者减 shared（仍按 ALL_PROJECTS 顺序）', () => {
    expectScoped(
      ['scripts/x.js', 'packages/web/b.vue', 'packages/server/a.ts'],
      ['packages/server', 'packages/web', 'scripts']
    )
    expectScoped(
      ['docs/adr/a.md', 'packages/web/b.vue'],
      ['packages/server', 'packages/web', 'scripts']
    )
  })

  it('全量优先于并集：收窄项 + 契约层 ⇒ 全量', () => {
    expectFull(['packages/server/a.ts', 'packages/shared/src/index.ts'])
    expectFull(['docs/run/a.md', '.husky/pre-commit'])
  })

  it('跳过项与收窄项并存 ⇒ 仍收窄（跳过不吞掉收窄）', () => {
    expectScoped(['docs/run/a.md', 'README.md', 'packages/web/b.vue'], ['packages/web', 'scripts'])
  })

  it('包前缀优先于 `*.md 跳过`：包内 MD 取本包（向严，宁多跑不漏跑）', () => {
    expectScoped(['packages/server/README.md'], ['packages/server', 'scripts'])
    expectScoped(['packages/web/docs/notes.md'], ['packages/web', 'scripts'])
  })

  it('归一化：`./` 前缀与反斜杠写法与正斜杠等价', () => {
    expectScoped(['./packages/server/a.ts'], ['packages/server', 'scripts'])
    expectScoped(['packages\\server\\a.ts'], ['packages/server', 'scripts'])
    expectSkip([String('  docs/run/a.md  ')])
  })

  // 空列表 fail-closed（§2.2「异常一律 fail-closed」）
  it('空列表 ⇒ 全量（fail-closed：不可判定不等于可跳过）', () => {
    expectFull([])
    expectFull(undefined)
    expectFull(null)
    expectFull('packages/server/a.ts') // 非数组入参同样走 fail-closed
  })

  // 非恒真对照：两档读数必须不同（否则「判据坏了」与「全绿」不可区分）
  it('反向对照：跳过档与收窄档读数不同 ⇒ 矩阵非恒真', () => {
    const skipped = resolveScopes(['docs/run/a.md'])
    const scoped = resolveScopes(['packages/server/a.ts'])
    expect(skipped).not.toMatchObject({ projects: scoped.projects })
    expect(skipped.skip).toBe(true)
    expect(scoped.skip).toBe(false)
  })
})

/**
 * V21–V22（票 `docs/run/precommit-scope/tickets-residual.md` §四 · 单B）
 * —— 命中 `packages/**` scope ⇒ 追加 `scripts`（V14 护栏在岗）。
 *
 * 为什么不并进上面那张矩阵：上面的格子测的是「逐条路径 → scope」的**映射**，本组测的是
 * **追加规则本身**及其四个边界（命中 / 本来就全量 / 跳过态不受影响 / 单向不反向）。
 * V21 认「含」（判据面 = 追加有没有发生），V22 认「按序子序列」（判据面 = 顺序契约没破）——
 * 两者都**不**要求 `projects` 等于某个字面量，映射表长什么样已由 V2–V7 逐格钉着。
 */
describe('resolveScopes · V21/V22 单B —— `packages/**` 追加 `scripts` 护栏', () => {
  /** V21 四格：`[格名, 暂存路径, 期望 projects]`。期望值逐格写**字面量**，不从实现推导。 */
  const V21_CELLS = [
    [
      'V21-① 暂存 packages/server/x.ts ⇒ 含 packages/server 且含 scripts',
      ['packages/server/x.ts'],
      ['packages/server', 'scripts'],
    ],
    [
      'V21-② 暂存 packages/shared/x.ts ⇒ 全量 4 个（本就含 scripts，追加不得去重压扁）',
      ['packages/shared/x.ts'],
      ALL,
    ],
    [
      'V21-③ 暂存 docs/run/x.md ⇒ skip: true（追加规则不得把跳过态变成「跑 scripts」）',
      ['docs/run/x.md'],
      [],
    ],
    [
      'V21-④ 暂存 scripts/x.mjs ⇒ 只 scripts（单向规则：不反向追加 packages）',
      ['scripts/x.mjs'],
      ['scripts'],
    ],
    [
      // 边界外延：**已经**因改动面自带 scripts 的格子，不得被追加成两份
      'V21-⑤ 暂存 packages/server/x.ts + scripts/x.mjs ⇒ scripts 只出现一次',
      ['packages/server/x.ts', 'scripts/x.mjs'],
      ['packages/server', 'scripts'],
    ],
  ]

  it.each(V21_CELLS)('%s', (_name, paths, expected) => {
    const d = resolveScopes(paths)
    expectContract(d) // V22 也挂在每格上（见下一组：这里是双保险，不是唯一判据）
    expect(d.projects, `projects 实测：${d.projects.join(' + ') || '(空)'}`).toEqual(expected)
    // 契约：skip ⇔ projects 空 —— V21-③ 走 skip 分支，其余走收窄/全量分支
    expect(d.skip).toBe(expected.length === 0)
  })

  // ── V22 顺序契约：逐格断言 projects 是 `ALL_PROJECTS` 的**按序子序列** ──
  it.each(V21_CELLS)('V22 按序子序列（非集合比较）：%s', (_name, paths) => {
    const { projects } = resolveScopes(paths)
    // ① 成员合法
    expect(projects.every((p) => ALL.includes(p))).toBe(true)
    // ② **按序**——不是集合比较：把期望的「正确顺序版」按 ALL_PROJECTS 重排一遍，
    //    顺序错则两者不等而红（集合比较在这里恒真，正是要避免的那种断言）。
    expect(projects).toEqual(ALL.filter((s) => projects.includes(s)))
    // ③ 无重复（追加逻辑写坏时最可能的形态是 push 两遍）
    expect(new Set(projects).size).toBe(projects.length)
  })

  it('非恒真对照：① 与 ④ 读数不同 ⇒ 追加是「按 scope 判定」而非无条件加', () => {
    const withPkg = resolveScopes(['packages/server/x.ts'])
    const scriptsOnly = resolveScopes(['scripts/x.mjs'])
    expect(withPkg.projects).toContain('scripts')
    expect(scriptsOnly.projects).toEqual(['scripts'])
    // 若实现改成「一律追加」，两条会相等而红
    expect(withPkg.projects).not.toEqual(scriptsOnly.projects)
  })

  it('跳过态不受影响：纯 docs/run/** 仍 skip，且口径不泄漏（reason 不得声称跑 scripts）', () => {
    const d = resolveScopes(['docs/run/precommit-scope/tickets-residual.md'])
    expect(d).toMatchObject({ skip: true, projects: [] })
    expect(d.reason).not.toContain('scripts')
  })

  it('reason 显式标注追加来源（排障时能分清 scripts 是追加的还是改动面自带的）', () => {
    // 追加发生 ⇒ 标注
    expect(resolveScopes(['packages/server/x.ts']).reason).toContain('含 scripts')
    // 自带（未追加）⇒ 不标注：两种来源在 hook 日志里必须可区分
    expect(resolveScopes(['scripts/x.mjs']).reason).not.toContain('含 scripts')
    expect(resolveScopes(['packages/server/x.ts', 'scripts/x.mjs']).reason).not.toContain(
      '含 scripts'
    )
    // 全量档也不该标注（它不是「收窄 + 追加」，是四条全跑）
    expect(resolveScopes(['packages/shared/x.ts']).reason).not.toContain('含 scripts')
  })
})

/**
 * V9 附加（本项目实测补的护栏）：scope 名 → vitest project 名的映射。
 *
 * 不加这组，`resolveScopes` 的矩阵会全绿而 CLI 实际**一条 project 都跑不起来** ——
 * 实测 `--project packages/server` 报 `No projects matched the filter`（project 名取
 * `package.json.name`）。此处钉死四个真实映射，包改名而映射失配时本组先红（fail-loud）。
 */
describe('projectNameOf · scope → vitest project 名', () => {
  it('四个 scope 映射到实测的 project 名（无 package.json 的目录回落目录名）', () => {
    expect(ALL.map((s) => [s, projectNameOf(s)])).toEqual([
      ['packages/shared', '@cat-study/shared'],
      ['packages/server', '@cat-study/server'],
      ['packages/web', '@cat-study/web'],
      ['scripts', 'scripts'],
    ])
  })

  it('映射结果两两不同（撞名 ⇒ 一个 project 被跑两次、另一个被漏掉）', () => {
    const names = ALL.map(projectNameOf)
    expect(new Set(names).size).toBe(names.length)
  })
})

/**
 * 票辛（店长裁 B2）—— 重活用例分档：`buildVitestArgs` 的两档读数。
 *
 * 为什么单列一组：上面全部格子测的是 `resolveScopes` 的**判决**（该跑哪些 project），
 * 本组测的是**同一个判决如何变成 vitest 参数** —— 分档发生在这一层，判决层看不见它。
 * 不测这组，上面矩阵可以全绿而「全量档也被塞了 `--exclude`」这种坏法无人抓。
 *
 * 本组是四类测试里的**纯单元**（无 vitest 子进程），故不断言「vitest 实际跑了几个文件」
 * —— 那条属于验收探针（手工跑，见交付说明），放进来会把单测变成分钟级。
 */
describe('buildVitestArgs · 票辛 B2 —— 重活用例分档', () => {
  const NAMES = ALL.map(projectNameOf)
  /** 抽 `--exclude` 的值（CLI 里成对出现：`--exclude <glob>`） */
  const excludesOf = (args) => args.filter((_, i) => args[i - 1] === '--exclude')
  const projectsOf = (args) => args.filter((_, i) => args[i - 1] === '--project')

  it('全量档：一个 `--exclude` 都不带（重活用例在它最该在岗的位置不缺岗）', () => {
    // 三条真实全量入口，分别覆盖「命中 FULL 前缀」「命中 FULL 精确」「fail-closed」
    const fullInputs = [
      ['.husky/pre-commit'],
      ['packages/shared/src/index.ts'],
      ['foo.unknown'],
      [],
    ]
    for (const staged of fullInputs) {
      const d = resolveScopes(staged)
      expect(isFullScope(d.projects), `${staged.join(',') || '(空)'} 应为全量档`).toBe(true)
      const args = buildVitestArgs(d)
      expect(excludesOf(args), `全量档不得带排除项：${staged.join(',') || '(空)'}`).toEqual([])
      expect(projectsOf(args), '全量档仍须选中四个 project').toEqual(NAMES)
    }
  })

  it('收窄档（packages + 追加护栏）：带齐清单每一项，顺序与 HEAVY_CASES 一致', () => {
    const d = resolveScopes(['packages/server/x.ts'])
    expect(d.projects).toEqual(['packages/server', 'scripts']) // 前提：确为收窄档
    const args = buildVitestArgs(d)
    expect(projectsOf(args)).toEqual(['@cat-study/server', 'scripts'])
    expect(excludesOf(args)).toEqual([...HEAVY_CASES])
  })

  it('收窄档（仅 scripts）：同样带齐 —— 本文件自己的提交就走这条', () => {
    const d = resolveScopes(['scripts/precommit-scope.mjs'])
    expect(d.projects).toEqual(['scripts'])
    expect(excludesOf(buildVitestArgs(d))).toEqual([...HEAVY_CASES])
  })

  // 非恒真对照：两档若要相等，只能是实现了「一律加」或「一律不加」——都是坏的
  it('反向对照：全量档与收窄档的参数读数必须不同', () => {
    const full = buildVitestArgs(resolveScopes(['.husky/pre-commit']))
    const scoped = buildVitestArgs(resolveScopes(['scripts/x.mjs']))
    expect(full.includes('--exclude')).toBe(false)
    expect(scoped.includes('--exclude')).toBe(true)
    expect(full).not.toEqual(scoped)
  })

  it('参数成对且不互相吞：`--exclude` 个数 = 清单长度，`--project` 个数 = project 数', () => {
    const args = buildVitestArgs(resolveScopes(['scripts/x.mjs']))
    expect(args.filter((a) => a === '--exclude').length).toBe(HEAVY_CASES.length)
    expect(args.filter((a) => a === '--project').length).toBe(1)
    // 无空串 / undefined 混进参数数组（spawnSync 会把它们当真实参数传给 vitest）
    expect(args.every((a) => typeof a === 'string' && a.length > 0)).toBe(true)
  })

  // 死条目防线：清单里写错路径 ⇒ 该条**静默失效**（重活用例又跑起来 = 吵，方向安全但仍该抓）。
  // 这是本组唯一的 I/O（本地文件存在性，微秒级）—— 换来的是一条清单自检。
  it('清单每一项在 scripts/ 下真实存在（防拼错路径的死条目）', () => {
    for (const c of HEAVY_CASES) {
      expect(existsSync(resolve(import.meta.dirname, c)), `清单条目不存在：scripts/${c}`).toBe(true)
    }
  })
})

describe('isFullScope · 判据（逐元素相等，含顺序）', () => {
  it('四个成员且顺序一致 ⇒ 全量档', () => {
    expect(isFullScope([...ALL_PROJECTS])).toBe(true)
  })

  it('顺序不同 / 多一个 / 少一个 / 为空 ⇒ 都不是全量档', () => {
    // 顺序是契约（§2.2）：顺序坏了本身就是坏读数，不该被当成全量放过
    expect(isFullScope([...ALL_PROJECTS].reverse())).toBe(false)
    expect(isFullScope([...ALL_PROJECTS, 'scripts'])).toBe(false)
    expect(isFullScope(ALL_PROJECTS.slice(0, 3))).toBe(false)
    expect(isFullScope([])).toBe(false)
    expect(isFullScope(['scripts'])).toBe(false)
  })

  it('非数组入参不抛（本函数不负责 fail-closed，但不得炸在判据里）', () => {
    expect(isFullScope(undefined)).toBe(false)
    expect(isFullScope(null)).toBe(false)
  })
})
