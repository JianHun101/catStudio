import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    env: {
      MEMORY_ENABLED: 'false',
      LOG_LEVEL: 'error',
    },
  },
})
