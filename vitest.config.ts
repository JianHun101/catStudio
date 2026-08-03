import { defineConfig } from 'vitest/config'

// workspace 模式下各 project 的 vitest.config.ts 不加载（vitest 4.1.9 实测）——
// 测试隔离 env 放根配置，作为默认值合并到所有 project（server 包内单独跑仍读包内配置）
export default defineConfig({
  test: {
    env: {
      RESTART_FILES_DIR: 'node_modules/.cache/restart-test',
    },
  },
})
