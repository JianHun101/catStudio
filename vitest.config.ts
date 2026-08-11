import { defineConfig } from 'vitest/config'
import { resolve } from 'path'
// @vitejs/plugin-vue 是 web 包依赖（pnpm 严格隔离，root 不可直接 import）——
// 经相对路径引用包内真实入口（E4-B 引入首个 import .vue 本体的挂载测试后踩中：
// workspace 目录型 project 的 plugins 通道在 vitest 4.1.9 实测不生效，根配置是
// 唯一确认生效的插件注入点；server/shared/scripts 测试不触碰 .vue 与 @ alias，零影响）
import vue from './packages/web/node_modules/@vitejs/plugin-vue/dist/index.mjs'

// workspace 模式下各 project 的 vitest.config.ts 不加载（vitest 4.1.9 实测）——
// 测试隔离 env 放根配置，作为默认值合并到所有 project（server 包内单独跑仍读包内配置）。
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'packages/web/src'),
      // pnpm 严格隔离：root 无 vue 包——SFC 编译产物 import 'vue' 需指向 web 包内入口
      // （bundler 入口，与 web 包 Vite 构建解析一致）
      vue: resolve(__dirname, 'packages/web/node_modules/vue/dist/vue.runtime.esm-bundler.js'),
    },
  },
  test: {
    env: {
      RESTART_FILES_DIR: 'node_modules/.cache/restart-test',
    },
  },
})
