import { defineConfig } from 'vitest/config'

export default defineConfig({
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
