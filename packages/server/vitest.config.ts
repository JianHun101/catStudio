import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      // worktree 模式：server 的 node_modules/@cat-study/shared 是主仓库安装时的
      // junction（指向主仓库 shared）——worktree 内改 shared 源码后测试解析到陈旧版。
      // 显式 alias 到本目录的 shared 源码（与根 vitest.config 同款，双保险：包内单独跑
      // 与 workspace 全量都覆盖）。
      '@cat-study/shared': resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    env: {
      MEMORY_ENABLED: 'false',
      LOG_LEVEL: 'error',
      // 固定 token 并发 cap=默认值：socketio.test.ts 并发上限用例断言「同 provider ≤2」
      // 依赖 ProviderTokenPool 默认 cap=2（token-pool.ts DEFAULT_CAP）。外部 shell 可能
      // 注入 PROVIDER_TOKEN_CAP（如根 .env=8）→ cap 漂移致 waitFor(active===2) 错过
      // 中间态超时。此处钉死默认，测试不依赖运行环境偶然状态。
      PROVIDER_TOKEN_CAP: '2',
      // 重启机制文件隔离——测试跑批的 afterEach 清理（socketio.test.ts unlinkSync）只会碰
      // 该隔离目录，不再删除运行时真实 .restart-request/.restart-done（17:38 事故根因）
      RESTART_FILES_DIR: 'node_modules/.cache/restart-test',
      // 日志文件隔离（票 F1-c c1）——同一范式、同一病灶：测试与生产原先**写同一个**
      // packages/server/data/cat-study.log（__dirname 恒为 src ⇒ dev/prod/测试三者同路径），
      // 实测测试夹具条目与生产条目逐行交错在同一个文件里 ⇒「生产上嵌入挂没挂过」不可判定。
      // 重定向到 node_modules/.cache/（构建产物区，不污染仓库）。
      LOG_FILE: 'node_modules/.cache/test-logs/cat-study-test.log',
    },
    coverage: {
      thresholds: {
        statements: 50,
        branches: 40,
        functions: 58,
        lines: 50,
      },
    },
  },
})
