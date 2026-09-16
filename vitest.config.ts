import { defineConfig } from 'vitest/config'
import { resolve } from 'path'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
// @vitejs/plugin-vue 是 web 包依赖（pnpm 严格隔离，root 不可直接 import）——
// 经相对路径引用包内真实入口（E4-B 引入首个 import .vue 本体的挂载测试后踩中：
// workspace 目录型 project 的 plugins 通道在 vitest 4.1.9 实测不生效，根配置是
// 唯一确认生效的插件注入点；server/shared/scripts 测试不触碰 .vue 与 @ alias，零影响）
import vue from './packages/web/node_modules/@vitejs/plugin-vue/dist/index.mjs'

/**
 * 缓存与测试隔离文件的落点必须**离开仓库**。worktree 的 `node_modules` 是指向主仓库的
 * junction（`ls -l` 实测为链接，本会话 worktree 的 `node_modules` 解析到 `<主仓库>/node_modules`），
 * 于是 vitest 的 `cacheDir` 默认值（`node_modules/.vite`）与测试隔离目录
 * （`node_modules/.cache/*`）在**主仓库与每个 worktree 里落到同一批物理文件**：并行跑批 =
 * 两个 vitest 进程互写同一份转换缓存、互删彼此的 `.restart-request`（`socketio.test.ts` 的
 * afterEach `unlinkSync` 只碰这个隔离目录 —— 跨 worktree 撞上就是它删别人的）。
 * 故按**本配置所在仓库根**派生 `os.tmpdir()` 下的独立子目录：主仓库与各 worktree 各一份。
 *
 * 派生键取 `__dirname`（配置目录 = 仓库根）而非 `process.cwd()`：两者在 `pnpm test` 下等价，
 * 但 cwd 会被调用方改（`--root` / 从子目录调），派生键要钉在「这是哪个仓库」上，而不是
 * 「从哪儿敲的命令」—— 后者分叉时是**静默**的（两处算同一个哈希 ⇒ 隔离凭空失效）。
 */
const REPO_ROOT = __dirname
const CACHE_ROOT = resolve(
  tmpdir(),
  'cat-study-vitest',
  createHash('sha1').update(REPO_ROOT).digest('hex').slice(0, 12)
)

export default defineConfig({
  // vitest/vite 的转换与依赖预打包缓存（默认 node_modules/.vite，落在 junction 共享面）
  cacheDir: resolve(CACHE_ROOT, 'vite'),
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'packages/web/src'),
      // worktree 模式：server/web 的 node_modules/@cat-study/shared 是主仓库安装时
      // 的 junction（指向主仓库 packages/shared）——worktree 内改 shared 源码后测试
      // 仍解析到主仓库陈旧版本（实测：shared 新增事件 undefined，双 handler 撞 undefined
      // key 全串）。显式 alias 到 vitest.config 所在目录的 shared 源码：worktree 与
      // 主仓库下都指向「当前仓库」的 shared 源码，收口后主仓库 alias 仍指向自身。
      '@cat-study/shared': resolve(__dirname, 'packages/shared/src/index.ts'),
      // pnpm 严格隔离：root 无 vue 包——SFC 编译产物 import 'vue' 需指向 web 包内入口
      // （bundler 入口，与 web 包 Vite 构建解析一致）
      vue: resolve(__dirname, 'packages/web/node_modules/vue/dist/vue.runtime.esm-bundler.js'),
    },
  },
  test: {
    // vitest 4 已弃用 vitest.workspace.ts 自动发现与 test.workspace 选项——
    // 项目定义统一走根配置 test.projects（vitest 4.1.9 实测：目录型 project 会
    // 经 resolveDirectoryConfig 加载各包 vitest.config.ts，jsdom 等隔离 env 恢复生效）。
    projects: ['packages/shared', 'packages/server', 'packages/web', 'scripts'],
    // ⚠️ 超时预算**不要**写在这里 —— 目录型 project 实测不采用根配置的这两个键
    // （vitest 4.1.9 实测：根写 `30_000`，四个 project 一个没变 —— scripts / shared / web
    //  仍落 vitest 默认 5000、server 仍落其自设 10000。未逐一验根 `test.*` 其余键，已知
    //  反例是本块 `env` 生效 —— 此处只断言这两个键，勿推广）。四处预算**各自**写在各自包
    //  的 vitest.config.ts，改一处 ≠ 改全部。
    //
    // 取值 30_000 的语义：**死锁探测预算，不是性能断言** —— 进程挂住要的是与负载无关的
    // 余量倍数；性能退化该由独立断言测，不靠调这个数。依据（本机实测）：全量 2539 用例
    // 空载跑批最坏单用例 5.19s（server `serial.cat-worktree` V2，已贴破 5s 默认线）
    // ⇒ 30_000 ≈ 5.8×；4 进程并发承压时最坏 10.49s ⇒ 余量 ≈ 2.9×。
    env: {
      // 绝对路径（离开仓库，见 CACHE_ROOT 注释）——原先是相对路径 `node_modules/.cache/restart-test`，
      // 由 `restart-request.ts` 的 `resolve(RESTART_FILES_DIR ?? process.cwd(), …)` 按 cwd 解析 ⇒
      // 恒落在 junction 共享面。末段保留 `restart-test`：`socketio.test.ts` 有断言钉着这个片段。
      RESTART_FILES_DIR: resolve(CACHE_ROOT, 'restart-test'),
    },
  },
})
