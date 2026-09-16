/**
 * `scripts/precommit-scope.mjs` 的判据矩阵 —— 票 `docs/run/precommit-scope/tickets.md` §三
 * 逐格覆盖（V1–V7、V9）。纯函数，无 I/O（唯一的 I/O 面 `projectNameOf` 单列在最后一组）。
 *
 * 两条防恒真的结构性断言（不做这两条，整张矩阵会退化成「测了个常量」）：
 *   ① **契约不变量**：`skip === true` ⇔ `projects` 为空；`skip === false` ⇒ `projects` 是
 *      `ALL_PROJECTS` 的**子序列**。矩阵每格都过一遍这条 ⇒ 单格漏写 `projects` 会被抓。
 *   ② **非恒真对照**：`docs/run/**`（跳过）与 `packages/server/**`（收窄）必须给出**不同**读数
 *      —— 若实现把所有输入都判成同一档，矩阵会全绿而门禁是坏的。
 */
import { describe, it, expect } from 'vitest'
import { ALL_PROJECTS, resolveScopes, projectNameOf } from './precommit-scope.mjs'

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

  // V2 单包
  it.each([
    ['packages/server/src/execution/serial.ts', ['packages/server']],
    ['packages/server/vitest.config.ts', ['packages/server']],
    ['packages/web/src/App.vue', ['packages/web']],
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

  // V6 记忆面 —— 消费者在 server（scripts/flywheel/scan.mjs 的白名单）
  it.each([
    ['docs/adr/0015-x.md'],
    ['docs/lessons/some-lesson.md'],
    ['docs/plans/review-chain-anchor.md'],
  ])('V6 记忆面 ⇒ packages/server：%s', (p) => expectScoped([p], ['packages/server']))

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
  it('V5 并集：server + web ⇒ 两个 project，顺序确定（与入参次序无关）', () => {
    expectScoped(
      ['packages/server/a.ts', 'packages/web/b.vue'],
      ['packages/server', 'packages/web']
    )
    expectScoped(
      ['packages/web/b.vue', 'packages/server/a.ts'],
      ['packages/server', 'packages/web']
    )
  })

  it('并集：三包 + scripts ⇒ 四者减 shared（仍按 ALL_PROJECTS 顺序）', () => {
    expectScoped(
      ['scripts/x.js', 'packages/web/b.vue', 'packages/server/a.ts'],
      ['packages/server', 'packages/web', 'scripts']
    )
    expectScoped(['docs/adr/a.md', 'packages/web/b.vue'], ['packages/server', 'packages/web'])
  })

  it('全量优先于并集：收窄项 + 契约层 ⇒ 全量', () => {
    expectFull(['packages/server/a.ts', 'packages/shared/src/index.ts'])
    expectFull(['docs/run/a.md', '.husky/pre-commit'])
  })

  it('跳过项与收窄项并存 ⇒ 仍收窄（跳过不吞掉收窄）', () => {
    expectScoped(['docs/run/a.md', 'README.md', 'packages/web/b.vue'], ['packages/web'])
  })

  it('包前缀优先于 `*.md 跳过`：包内 MD 取本包（向严，宁多跑不漏跑）', () => {
    expectScoped(['packages/server/README.md'], ['packages/server'])
    expectScoped(['packages/web/docs/notes.md'], ['packages/web'])
  })

  it('归一化：`./` 前缀与反斜杠写法与正斜杠等价', () => {
    expectScoped(['./packages/server/a.ts'], ['packages/server'])
    expectScoped(['packages\\server\\a.ts'], ['packages/server'])
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
