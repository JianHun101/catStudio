import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    // 死锁探测预算，非性能断言 —— 依据与实测读数见根 vitest.config.ts（**四处独立**：
    // 根配置的这两个键实测不被目录型 project 采用）。
    testTimeout: 30_000,
    hookTimeout: 30_000,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    coverage: {
      thresholds: {
        statements: 60,
        branches: 50,
        functions: 45,
        lines: 60,
      },
    },
  },
})
