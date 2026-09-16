import { defineConfig } from 'vitest/config'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { resolve } from 'path'

/**
 * 测试隔离根（脚本侧）—— 与 `packages/server/vitest.config.ts` 的 `ISOLATION_ROOT`
 * **同一派生公式、同一哈希键**（键 = 本配置目录的绝对路径）：主仓库与每个 worktree
 * 的 `scripts/` 绝对路径不同 ⇒ 各得一份隔离目录，多猫并行跑批互不覆盖。
 *
 * 为何必须离开仓库：worktree 的 `node_modules` 是指向主仓库的 junction ⇒ 相对路径
 * 与 cwd 派生路径在主仓库与各 worktree 里解析到**同一批物理文件**。
 * 为何键取 `__dirname` 而不是 cwd：`scripts` project 既可能在根 workspace 全量里跑
 * （cwd = 仓库根）也可能被单独拉起，cwd 派生会随调用方变（分叉时是**静默**的）。
 */
const ISOLATION_ROOT = resolve(
  tmpdir(),
  'cat-study-test-isolation',
  createHash('sha1').update(resolve(__dirname)).digest('hex').slice(0, 12)
)

export default defineConfig({
  test: {
    include: ['**/*.test.js'],
    env: {
      // 日志文件隔离（票 F1-c c1）——scripts 侧的测试会**跨包**走到 server 的
      // `memory/embedding-client.ts`（`scan.test.js` 的假 sidecar 回 500 ⇒
      // 嵌入链降级 ⇒ 真 logger 落痕），不重定向就会写进生产日志
      // `packages/server/data/cat-study.log`。与 server 侧同一范式。
      //
      // **必须绝对路径**（票 `precommit-scope` 残余收口·单A）：原先的相对路径由 logger 的
      // `path.resolve(override)` 按 cwd 解析 ⇒ 恒落在 junction 共享面（同 server 侧病灶）。
      // 末段保留 `test-logs/cat-study-test.log`。
      LOG_FILE: resolve(ISOLATION_ROOT, 'test-logs', 'cat-study-test.log'),
      // 级别同 server 侧（票 F1-c c2）——**这一项是实测补的**：只隔离路径时，
      // 全套跑批的测试日志里仍留下 1 条 `memory:embedding-client` 的 debug 行
      // （本 project 未设 LOG_LEVEL ⇒ 模块初值 debug）。§四 第 7 条要求测试轮
      // 产生的 debug 行**不出现在任何日志文件里**，故两处必须成对。
      LOG_LEVEL: 'error',
    },
  },
})
