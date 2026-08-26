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
      // 重启机制文件隔离——测试跑批的 afterEach 清理（socketio.test.ts unlinkSync）只会碰
      // 该隔离目录，不再删除运行时真实 .restart-request/.restart-done（17:38 事故根因）
      RESTART_FILES_DIR: 'node_modules/.cache/restart-test',
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
