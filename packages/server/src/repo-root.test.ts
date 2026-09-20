import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { findRepoRootFrom } from './repo-root.js'

/** 本测试模块所在目录 = `packages/server/src/` */
const moduleDir = dirname(fileURLToPath(import.meta.url))

/** 飞轮扫描器锚（`index.ts` 消费的那条），真实仓中确实存在 */
const FLYWHEEL_MARKER = ['scripts', 'flywheel', 'scan.mjs'] as const

/** 陈旧度脚本锚（`session-closeout.ts` 消费的那条），真实仓中确实存在 */
const STALE_SCAN_MARKER = ['scripts', 'run-docs-stale.mjs'] as const

/** 夹具目录登记表——不复用 `os.tmpdir()` 的残留，出一个删一个 */
const fixtures: string[] = []

afterEach(() => {
  while (fixtures.length > 0) rmSync(fixtures.pop() as string, { recursive: true, force: true })
})

/**
 * 造一棵**两级布局**的真夹具树：标记文件落在仓库根，并建出源码/产物两种深度的起点目录。
 *
 * 深度与真实仓**一一对应**（`tsconfig.json` 的 `rootDir:".."` + `outDir:"./dist"`）：
 *   源码  `packages/server/src/llm/`
 *   产物  `packages/server/dist/server/src/llm/`（比源码深两层）
 */
function makeTwoLayoutFixture(marker: readonly string[]): {
  root: string
  srcStart: string
  distStart: string
  markerAbs: string
} {
  const root = mkdtempSync(resolve(tmpdir(), 'catstudy-repo-root-'))
  fixtures.push(root)
  const markerAbs = resolve(root, ...marker)
  mkdirSync(dirname(markerAbs), { recursive: true })
  writeFileSync(markerAbs, '// fixture\n', 'utf-8')
  const srcStart = resolve(root, 'packages', 'server', 'src', 'llm')
  const distStart = resolve(root, 'packages', 'server', 'dist', 'server', 'src', 'llm')
  for (const d of [srcStart, distStart]) mkdirSync(d, { recursive: true })
  return { root, srcStart, distStart, markerAbs }
}

/** 相对夹具根的 posix 风格路径——断言里比绝对路径可读 */
const relTo = (root: string, abs: string): string => relative(root, abs).split(sep).join('/')

/** 旧写法：从起点按**固定层数**上溯（被测缺陷的形态，用作反对照） */
const fixedUp = (start: string, levels: number, marker: readonly string[]): string =>
  resolve(start, ...Array<string>(levels).fill('..'), ...marker)

describe('findRepoRootFrom — 存在性锚定向上找', () => {
  it('夹具本身可信：相对深度与真实仓一一对应（防夹具悄悄换了个形状）', () => {
    const { root, srcStart, distStart } = makeTwoLayoutFixture(FLYWHEEL_MARKER)
    expect(relTo(root, srcStart)).toBe('packages/server/src/llm')
    expect(relTo(root, distStart)).toBe('packages/server/dist/server/src/llm')
  })

  it('两级布局**同解**：源码起点与产物起点都解析到同一个仓库根（真跑，非 mock）', () => {
    const { root, srcStart, distStart, markerAbs } = makeTwoLayoutFixture(FLYWHEEL_MARKER)
    expect(findRepoRootFrom(srcStart, FLYWHEEL_MARKER)).toBe(root)
    expect(findRepoRootFrom(distStart, FLYWHEEL_MARKER)).toBe(root)
    // 解出来的根**确实含有**标记文件——不是「碰巧等于某个字符串」
    expect(existsSync(resolve(root, ...FLYWHEEL_MARKER))).toBe(true)
    expect(relTo(root, markerAbs)).toBe('scripts/flywheel/scan.mjs')
  })

  it('反对照：固定层级**只在源码布局下**对——两条断言必须同时成立', () => {
    const { srcStart, distStart, markerAbs } = makeTwoLayoutFixture(FLYWHEEL_MARKER)
    // ① 源码布局下旧写法确实解得到真标记文件 ⇒ 缺陷是「布局相关」而非「一直坏」
    expect(fixedUp(srcStart, 4, FLYWHEEL_MARKER)).toBe(markerAbs)
    // ② 产物布局下它指向一个**不存在**的路径 ⇒ 必然 ENOENT / 被 existsSync 守卫吃掉
    expect(existsSync(fixedUp(distStart, 4, FLYWHEEL_MARKER))).toBe(false)
    // 只断言 ② 的话，一个「一律返回垃圾」的实现也会绿——故 ① 是承重的。
    // ③ 不写成「不等于旧答案」那种弱式：返回 null 同样满足它。要断言**正契约**——
    //   解出来的必须是**一个确实含标记的目录**。
    const got = findRepoRootFrom(distStart, FLYWHEEL_MARKER)
    expect(got).not.toBe(null)
    expect(existsSync(resolve(got as string, ...FLYWHEEL_MARKER))).toBe(true)
  })

  it('起点自身含标记 ⇒ 命中起点（「含自身」语义）', () => {
    const { srcStart } = makeTwoLayoutFixture(FLYWHEEL_MARKER)
    const nested = resolve(srcStart, ...FLYWHEEL_MARKER)
    mkdirSync(dirname(nested), { recursive: true })
    writeFileSync(nested, '// nested marker\n', 'utf-8')
    expect(findRepoRootFrom(srcStart, FLYWHEEL_MARKER)).toBe(srcStart)
  })

  it('标记必须**整条**命中：只命中它的前缀目录不算', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'catstudy-repo-root-'))
    fixtures.push(root)
    // 只有 `scripts/` 这个目录，没有 `scripts/flywheel/scan.mjs` 这个文件
    mkdirSync(resolve(root, 'scripts', 'flywheel'), { recursive: true })
    const start = resolve(root, 'packages', 'server', 'src')
    mkdirSync(start, { recursive: true })
    expect(findRepoRootFrom(start, FLYWHEEL_MARKER)).toBe(null)
  })

  it('一路到文件系统根都无命中 ⇒ null（绝不猜一个路径出来）', () => {
    const empty = mkdtempSync(resolve(tmpdir(), 'catstudy-repo-root-'))
    fixtures.push(empty)
    expect(findRepoRootFrom(empty, FLYWHEEL_MARKER)).toBe(null)
  })

  it('空标记 ⇒ 抛错，而不是静默返回起点', () => {
    // 空标记会让每个目录都「命中」⇒ 返回起点自身。那是错答案，不是降级。
    expect(() => findRepoRootFrom(moduleDir, [])).toThrow(/marker 不能为空/)
  })

  it('startDir 可以不存在——判据只有标记的存在性，路径解析是纯字符串运算', () => {
    // ① 虚构起点落在**无标记**的树下：上溯到底仍是 null（不因「目录不存在」而提前放弃）
    const bare = mkdtempSync(resolve(tmpdir(), 'catstudy-repo-root-'))
    fixtures.push(bare)
    expect(findRepoRootFrom(resolve(bare, 'never', 'created', 'at', 'all'), FLYWHEEL_MARKER)).toBe(
      null
    )

    // ② 虚构起点落在**有标记**的树下：照样上溯命中，起点自身不存在不影响
    const { root, srcStart } = makeTwoLayoutFixture(FLYWHEEL_MARKER)
    expect(findRepoRootFrom(resolve(srcStart, 'no', 'such', 'dir'), FLYWHEEL_MARKER)).toBe(root)
  })
})

describe('与真实仓库对账', () => {
  it('真实仓：源码布局与产物布局**同解**到真仓库根（产物目录不必先构建出来）', () => {
    const srcRoot = findRepoRootFrom(moduleDir, FLYWHEEL_MARKER)
    expect(srcRoot).toBeTruthy()
    // 解出来的确实是本仓根：锚文件之外再核一个与本模块无关的仓根特征
    expect(existsSync(resolve(srcRoot as string, 'pnpm-workspace.yaml'))).toBe(true)
    expect(existsSync(resolve(srcRoot as string, 'packages', 'server', 'src', 'index.ts'))).toBe(
      true
    )

    // 产物布局起点：packages/server/dist/server/src（此刻 dist 未必存在，不影响判定）
    const distStart = resolve(moduleDir, '..', 'dist', 'server', 'src')
    expect(relTo(resolve(moduleDir, '..', '..', '..'), distStart)).toBe(
      'packages/server/dist/server/src'
    )
    expect(findRepoRootFrom(distStart, FLYWHEEL_MARKER)).toBe(srcRoot)
  })

  it('生产在用的两个锚，在真实树里都命中且整条路径存在', () => {
    // 标记文件一旦搬家，这条就红——比「源码里 grep 得到某个字符串」结实
    for (const marker of [FLYWHEEL_MARKER, STALE_SCAN_MARKER]) {
      const root = findRepoRootFrom(moduleDir, marker)
      expect(root, `锚 ${marker.join('/')} 应命中真实仓库根`).toBeTruthy()
      expect(existsSync(resolve(root as string, ...marker)), `${marker.join('/')} 应真实存在`).toBe(
        true
      )
    }
  })
})
