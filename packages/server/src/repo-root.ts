/**
 * 仓库根定位——从任意起点**向上找**含指定标记的最近祖先目录。
 *
 * **为什么不按固定层级上溯**（`new URL('../../../..', import.meta.url)`）：源码与构建
 * 产物**深度不同**。`packages/server/tsconfig.json` 是 `rootDir: ".."` + `outDir: "./dist"`
 * ⇒ `src/llm/x.ts` 的产物落在 `packages/server/dist/server/src/llm/x.js`
 * （`package.json` 的 `"start": "node dist/server/src/index.js"` 独立印证这条），
 * 比 `src/llm/` **深两层**。固定层数必有一边解析错，且错法是**静默指向一个不存在的
 * 路径**——要等 spawn 报 ENOENT 才看得见，或在 `existsSync` 守卫下退化成「功能永不生效」。
 * 向上找对两种布局都成立。
 *
 * **存在性即自校验**：只认「确实含有 `marker` 的目录」，一路走到文件系统根都没有命中
 * 就返回 `null`——调用方据此降级（跳过 / 打 warn），而不是拿一个猜出来的路径去撞文件系统。
 *
 * 仓内先例：`execution/review-fallback.ts` 与 `routes/skills.ts` 各有一份同形状的私有
 * 副本（各自锚自己的标记文件）。本模块把「向上找」这一步抽成单源；**标记文件仍由调用
 * 方给**——「锚哪个文件才算仓库根」是调用方的语义（也决定了它要的是哪个检出），
 * 不是本模块的。
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * 从 `startDir` 起向上找**确实含有** `marker` 的最近祖先目录（**含 `startDir` 自身**）。
 *
 * 纯同步、无副作用、不起任何子进程——收口链路上不能再多一次同步 git 调用。
 * `startDir` 本身**不必真实存在**：判据只有 marker 的存在性，路径解析是纯字符串运算。
 *
 * @param startDir 起点目录（通常传模块自身所在目录，由 `import.meta.url` 派生）
 * @param marker   标记路径的**分段数组**（如 `['scripts','flywheel','scan.mjs']`），相对
 *                 「仓库根」；**整条路径必须命中**，只命中它的某个前缀目录不算
 * @returns 命中则返回该祖先的绝对路径；一路到文件系统根都无命中则 `null`
 */
export function findRepoRootFrom(startDir: string, marker: readonly string[]): string | null {
  if (marker.length === 0) {
    // 空标记会让**每个**目录都「命中」，于是返回起点自身——一个静默的错答案，
    // 比报错难查得多。本函数只被字面量调用，这条永远不该触发。
    throw new Error('findRepoRootFrom: marker 不能为空数组——空标记会让任何目录都命中')
  }
  let dir = resolve(startDir)
  for (;;) {
    if (existsSync(join(dir, ...marker))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}
