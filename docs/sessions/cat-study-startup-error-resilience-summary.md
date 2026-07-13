# 启动流程简化 + 前端错误恢复 + Windows 兼容修复

## 1. What — 具体改动

| 文件 | 改动 |
|------|------|
| `packages/server/src/env.ts` | **新增**：最小化 `.env` 加载器（不依赖 dotenv 包），server 启动时自动读取根目录 `.env` 文件注入 `process.env`，不覆盖已存在的环境变量 |
| `packages/server/src/seed-data.ts` | **新增**：种子数据定义模块，导出 `buildDemoAgents()`（延迟读取 DS_KEY）和 Session 常量，被 seed.ts 和 server auto-seed 共用 |
| `packages/server/src/db/index.ts` | 无改动（仅作为引用对比：DB 路径 `packages/server/data/cat-study.db`） |
| `packages/server/src/index.ts` | 导入 `./env.js`（第一行）；`initDb()` 后检测 agents 表为空则自动调用 `buildDemoAgents()` 创建种子数据；新增 `setErrorHandler` 记录完整错误日志并返回 `error` + `message` 双字段；默认 HOST 从 `0.0.0.0` 改为 `127.0.0.1` |
| `packages/server/src/routes/agents.ts` | 新增 `createLogger('agents')`；POST catch 块在 rethrow 前记录 `log.error('agent create failed', ...)` |
| `packages/server/src/seed.ts` | 重构：种子数据定义移到 `seed-data.ts`，调用 `buildDemoAgents()` 获取 agent 列表 |
| `packages/server/package.json` | 无改动（`tsx` 在 devDependencies 中，server 的 dev 脚本保持 `tsx watch src/index.ts`） |
| `packages/web/src/composables/useApi.ts` | 错误响应优先读取 `body.message`（详细错误）而非 `body.error`（泛化"Internal Server Error"）；Error 对象上附加 `status` 和 `body` 属性 |
| `packages/web/src/composables/useSocket.ts` | Socket.IO 连接地址从 `localhost:3200` 改为 `127.0.0.1:3200` |
| `packages/web/src/stores/chat.ts` | `fetchData()` 增加指数退避重试（3 次：1s / 2s / 4s），应对 server 启动慢于 Vite 的时序问题；新增 `dataReady`、`dataError` 状态并导出 |
| `packages/web/src/components/SessionList.vue` | `onMounted` 已调用 `fetchData()`；模板新增三段状态：加载中（旋转动画 + "连接服务器中"）→ 加载失败（错误信息 + 重试按钮）→ 正常列表 |
| `packages/web/src/components/AgentPanel.vue` | 同样新增加载中/失败/空列表三段状态；`handleCreate` catch 块增加 `console.error` 输出完整错误到浏览器控制台 |
| `packages/web/vite.config.ts` | 代理目标从 `localhost:3200` 改为 `127.0.0.1:3200`；`cwd` 由 dev.js 设为 web 包目录 |
| `scripts/dev.js` | **重写**：不再通过 `pnpm --parallel -r dev` + `shell: true` 启动（Windows 下进程输出被吞、server 崩溃不可见），改为直接 `spawn(node, [tsx_cli.mjs, ...])` + `spawn(node, [vite.js, --host, 0.0.0.0])`；server 先启动（500ms 头），Vite 的 cwd 设为 `packages/web/` 确保 index.html 可被找到 |
| `scripts/seed.js` | **新增**：`node scripts/seed.js [--reset]` 包装脚本，同样通过 node 直接执行 tsx cli.mjs |
| `package.json` | 新增 `"seed": "node scripts/seed.js"` 脚本 |
| `.env.example` | 更新注释，简化使用说明 |

## 2. Why — 为什么这样做

### 启动链路：从三步到一步

```
之前：
  set DS_KEY=xxx              # PowerShell 环境变量
  npx tsx .../seed.ts         # 手动播种（且 tsx 可能找不到）
  pnpm dev                    # pnpm --parallel 启动（Windows shell 问题）

之后：
  copy .env.example .env      # 仅首次
  pnpm dev                    # node scripts/dev.js — 即做全部
```

数据流：

```
pnpm dev
  └─ node scripts/dev.js
       ├─ spawn node → tsx/cli.mjs → packages/server/src/index.ts
       │    ├─ import ./env.js          ← 加载 .env → process.env
       │    ├─ initDb()                 ← 建表
       │    ├─ SELECT COUNT(*) agents   ← 为空？
       │    │    └─ buildDemoAgents()   ← 是：自动播种（此时 DS_KEY 已从 .env 注入）
       │    ├─ Redis connect            ← 可选
       │    └─ app.listen(127.0.0.1:3200)
       │
       └─ spawn node → vite.js --host 0.0.0.0  (cwd: packages/web/)
            ├─ index.html 被找到（cwd 正确）
            ├─ /api → http://127.0.0.1:3200      ← 显式 IPv4
            └─ /socket.io → ws://127.0.0.1:3200
```

### 为什么 .env 加载必须在 import 链最前面

`seed-data.ts` 的 `buildDemoAgents()` 在调用时才读 `process.env.DS_KEY`（不在模块顶层读取）。但 embedding 模块、server 其他模块也可能读环境变量。`env.ts` 作为 `index.ts` 的第一个 import，保证所有后续模块初始化时 `.env` 已生效。

### 为什么 seed 延迟到运行时而非模块加载时

`buildDemoAgents()` 是函数而非 `const DEMO_AGENTS` 常量。ES 模块的 import 顺序虽能保证 `env.ts` 先于 `seed-data.ts` 执行，但函数调用延迟确保 DS_KEY 一定来自已加载的 `.env`。这也是为什么 `seed-data.ts` 导出 `buildDemoAgents()` 而非静态数组。

### 为什么前端需要重试而非一次失败就报错

`pnpm dev` 中 Vite 约 330ms 就绪，server 约 800ms（DB init + seed + Redis connect + listen）。用户浏览器在 Vite 就绪后立即加载页面时，后端可能还没开始监听。`fetchData()` 的指数退避重试（1s → 2s → 4s）覆盖了这个时间窗口。

```
时间线：
  0ms    Vite 就绪，用户打开浏览器
  0ms    fetchData() 第 1 次 → ECONNREFUSED（server 还没 listen）
  800ms  Server listen 就绪
  1000ms fetchData() 第 2 次 → 成功，dataReady=true
```

### 为什么全部改用 127.0.0.1 而非 localhost

Windows 上 `localhost` 可能解析到 `::1`（IPv6），而 server 原来监听 `0.0.0.0:3200`（仅 IPv4）。Vite 代理和 Socket.IO 客户端若通过 IPv6 连接会失败。统一改为 `127.0.0.1` 消除 DNS 解析歧义。

### 为什么 dev.js 需要重写而非修小 bug

原方案 `spawn('pnpm.cmd', ['--parallel', '-r', 'dev'], { shell: true })` 在 Windows 上有三个问题：
1. `shell: true` 导致 Node v24 的 DEP0190 警告
2. `pnpm --parallel` 的输出合并让 server 启动错误不可见
3. `.cmd` 文件在 Node v24 上直接 spawn 会报 `EINVAL`

新方案直接用 `process.execPath`（node 二进制）执行 tsx 和 vite 的 JS 入口文件，绕过所有 shell/.cmd 问题。

## 3. Tradeoff — 放弃了什么方案

| 放弃 | 原因 |
|------|------|
| 引入 dotenv 包 | 零依赖项目，一个 40 行的 `.env` parser 足够覆盖 `KEY=VALUE` / 引号 / 注释 / 空行 |
| Vite 使用 `--config` 参数指定配置文件 | 当 cwd 设为 `packages/web/` 后，Vite 自动找到 `vite.config.ts`，不需要 `--config` |
| server 默认监听 `0.0.0.0` | 本地开发只需本机访问；`0.0.0.0` 在某些 Windows 配置下会触发防火墙弹窗。需要外部访问时可通过 `.env` 设 `HOST=0.0.0.0` |
| 种子数据用静态常量 | 改为函数 `buildDemoAgents()` 确保 DS_KEY 在 `.env` 加载后才被读取 |
| `tsx watch` 模式 | watch 模式在 Windows 上有文件监听问题，且 dev.js 已独立管理进程生命周期，不需要 watch 重启 |
| 前端无限重试 | 3 次重试（最长 7s）覆盖 server 启动窗口。无限重试会让 loading 状态永远不结束，用户无法手动重试 |

## 4. Open Questions — 不确定的点

- **`连接服务器中` 问题仍未解决**：用户实际环境（PowerShell + Windows）中 `fetchData()` 的重试循环似乎无法完成。服务端日志显示 Socket.IO 已连接并加入 Session（说明 WebSocket 通了），但 REST API 调用结果未知。可能是 Vite 代理或浏览器的网络层问题。当前重试 3 次后应显示错误状态和重试按钮，但用户描述"一直显示连接服务器中"意味着 `loading` 未变为 `false`——可能 `fetch` 本身挂起（无超时）。需要添加 `AbortController` 超时。

- **Internal Server Error 问题待验证**：后端 agent 创建 API 在 curl/Node.js fetch 测试中全部正常（201），但用户原报告称"创建猫咪 agent 时报 Internal Server Error"。加了 `setErrorHandler` 和前端 `console.error` 后，下次出现时可在浏览器控制台和 `cat-study.log` 看到真实错误。但根因尚未确认——可能是 agent 名重复（409）、API key 缺失、或 DB 写入冲突。

- **Node.js v24 兼容性**：`sqlite-vec` 在 Node v24 上加载成功但 `vec_distance_cosine` 函数不可用（日志中有 `no such function: vec_distance_cosine`）。这不影响 agent 创建，但记忆检索静默降级。`better-sqlite3` 和 `sqlite-vec` 的原生模块是否与 Node v24 完全兼容待确认。

## 5. Next Action — 希望做什么

- [ ] **给 `fetchData` 加超时**：`fetch()` 无默认超时，若请求挂起则 loading 永远不结束。加 `AbortController` + 10s 超时确保重试循环能推进
- [ ] **验证 Internal Server Error**：在浏览器中实际创建 agent，打开 F12 控制台查看 `[AgentPanel] create agent failed:` 日志，同时检查 `cat-study.log` 中 `"module":"server"` 或 `"module":"agents"` 的 error 日志
- [ ] **检查 sqlite-vec 兼容性**：在 Node v24 上单独测试 `sqlite-vec` 的 `vec_distance_cosine` 是否可用；若不可用，考虑升级 sqlite-vec 或降级 Node
- [ ] **用户反馈**：把 `127.0.0.1:5173` 的浏览器截图和 F12 Console/Network 面板截图贴回来
