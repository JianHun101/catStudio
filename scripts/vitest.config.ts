import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['**/*.test.js'],
    env: {
      // 日志文件隔离（票 F1-c c1）——scripts 侧的测试会**跨包**走到 server 的
      // `memory/embedding-client.ts`（`scan.test.js` 的假 sidecar 回 500 ⇒
      // 嵌入链降级 ⇒ 真 logger 落痕），不重定向就会写进生产日志
      // `packages/server/data/cat-study.log`。与 server 侧同一范式、同一路径。
      LOG_FILE: 'node_modules/.cache/test-logs/cat-study-test.log',
      // 级别同 server 侧（票 F1-c c2）——**这一项是实测补的**：只隔离路径时，
      // 全套跑批的测试日志里仍留下 1 条 `memory:embedding-client` 的 debug 行
      // （本 project 未设 LOG_LEVEL ⇒ 模块初值 debug）。§四 第 7 条要求测试轮
      // 产生的 debug 行**不出现在任何日志文件里**，故两处必须成对。
      LOG_LEVEL: 'error',
    },
  },
})
