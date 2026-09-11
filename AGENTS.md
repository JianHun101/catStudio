# AGENTS.md

本仓库的项目操作手册（唯一真相源）——怎么跑、边界在哪、哪些不变量不知道就会做错。
`CLAUDE.md` 只是 `@AGENTS.md` 的导入壳；术语表、目录细节与流程约定见 `CONTEXT.md`。

## Commands

```bash
pnpm dev                  # server :3200 + web :5173（scripts/dev.js）→ 实验库 cat-study-dev.db
pnpm start                # dev.js --mode production → 主库 cat-study.db（日常真实使用，记忆延续）
pnpm dev:server / dev:web # 单包启动
pnpm stop                 # 释放端口 3200、5173-5175
pnpm test                 # vitest run（projects：shared / server / web / scripts）
pnpm test:shared / :server / :web / :watch / :coverage
pnpm lint                 # 类型检查：node scripts/lint.js 直调各包 tsc/vue-tsc（不走 pnpm -r）
pnpm seed [--reset]       # upsert 演示猫与会话；--reset 先清空再重建
pnpm build                # pnpm -r build
```

## Layout

- `packages/shared/` — 类型、Zod schema、Socket.IO 事件常量（无运行逻辑）
- `packages/server/` — Fastify + Socket.IO + SQLite + LLM 适配器 + 调度 + 记忆
- `packages/web/` — Vue 3 前端（Vite + Pinia + Socket.IO client）
- `scripts/` — 开发/种子/停服、MCP server、hooks 与 skills 治理
- `skills/` — 技能活源（`.claude/skills` 是指向此处的链接，不在 `.claude` 内另存）
- `docs/` — 项目文档（ADR 在 `docs/adr/`；`docs/run/` 为开发文档·在飞；完整清单以目录为准）

子目录职责见 `CONTEXT.md`「模块目录结构」，本文不复述。

## Runtime invariants

**启动序列**: `import './env.js'` 必须是 `index.ts` 的第一行 → `initDb()`（SQLite WAL + sqlite-vec + 迁移）→ agents 表为空则自动 seed → Fastify + Socket.IO 监听 → SIGINT/SIGTERM 优雅关停（含杀掉本进程 spawn 的常驻子进程）。

**消息流**: `SEND_MESSAGE` → 落库 → 广播到 session 房间 → `dispatch()`：被 @ 的 agent 空闲则执行，忙则 FIFO 排队。

**单次执行**: 上下文过滤 → 记忆检索 → `chatStream()` 流式（`AGENT_TYPING`）→ 回复落库 → `NEW_MESSAGE` → 释放槽位并排空队列。

**上下文过滤**: 每只猫只见自己的回复 + 无 @ 的广播消息；@ 了别的猫的用户消息不可见；其他猫的回复：会话开启广播模式、或该回复 @ 了你时可见。

**调度**: 每 agent 单槽位 FIFO（内存态，按 @ 顺序串行）。`AGENT_HARD_TIMEOUT_MS`（默认 30min）是单次执行硬上限；CLI 空闲超时默认 20min（`CLI_IDLE_TIMEOUT_MS`）。

**Token 池**: `ProviderTokenPool`（`execution/token-pool.ts`）按 `provider:apiKey` 键控并发上限——`PROVIDER_TOKEN_CAP` 默认 2（0 = 不限）；token 只包 LLM 段（编排段不持），满则阻塞等待、释放按 FIFO 唤醒，等待上限 `PROVIDER_TOKEN_ACQUIRE_TIMEOUT_MS` 默认 35min（0 禁用）。

**LLM 适配器**: 按缓存键（`llm/registry.ts`，含 provider / apiKey / model / envExtra 维度）复用单实例——同键的猫共享一个实例，故需 token 池封顶并发。

**记忆**: 本地嵌入 `Xenova/bge-small-zh-v1.5`（512 维）。入库：embed → 去重（余弦距离 < `MEMORY_DEDUP_THRESHOLD`）→ 存储；检索：top-K → 注入 system prompt。fire-and-forget，失败不阻塞。

**数据库**: SQLite `packages/server/data/cat-study.db`（dev 模式为 `cat-study-dev.db`；WAL + sqlite-vec）；表与查询层见 `packages/server/src/db/`。API 边界做 snake_case ↔ camelCase 转换。

## Gotchas

- `import './env.js'` 必须是 `packages/server/src/index.ts` 的第一个 import（手写 .env 解析，无 dotenv）——顺序错了，模块初始化时环境变量还是空的
- 用 `127.0.0.1` 不用 `localhost`（IPv4/IPv6 歧义）
- spawn 外部 CLI 用 `node path/to/cli.mjs`——避开 `.cmd` wrapper 与 `shell: true`（Windows 会 EINVAL）
- server 测试用 `:memory:` SQLite（`setDb()`/`resetDb()` 钩子，无磁盘、FK 生效）并设 `MEMORY_ENABLED=false`；内存态用例间用 `__test_reset*` 钩子复位（`execution/registry.ts`、`execution/serial.ts`）
- worktree 内 git 操作一律 `git -C <worktree> <cmd>`；别在即将删除的目录里驻留进程——Windows 下持 cwd 会让目录删除 EPERM 留空壳
- Vite dev 代理：`/api` + `/socket.io` → `http://127.0.0.1:3200`
- 会话 worktree 不可用时 CLI cwd 落 `workspace/` 子目录，此时 `CLAUDE.md` 的 `@AGENTS.md` 不展开（CLI 只展开 cwd 子树内的 import，父目录相对路径与绝对路径均不展开）——本手册在该路径下不加载

## Conventions

**测试摆放**（测试不零散）：

- 测试跟随被测主模块，同目录同名前缀（co-located）——`xxx.ts` 的测试就是 `xxx.test.ts`，不设集中目录；一个测试文件只测一个被测模块
- 跨模块测试挂主模块旁（`connectors/socketio.test.ts` 范式：真实 SQLite + 捕获 socket handler，只 mock 最外层）
- 测试性质四类：纯单元（无 I/O）/ 模块测试（只 mock 边界）/ 组装式模块（真实 DB + handler）/ 静态源断言（web `?raw` 读 SFC）
- 辅助文件白名单（原地保留）：`server/src/test-helpers.ts`、`web/src/test-setup.ts`——仅供测试的辅助，非测试文件
- e2e 两级：CLI 级（自包含、可进 CI）与系统级（真实 server + LLM，手动跑），命名 `.e2e.mjs` 跟随被测脚本同目录，**不纳入** vitest include
- vitest include：server/shared/web 统一 `src/**/*.test.ts`；scripts 无 src 用 `**/*.test.js`（`.e2e.mjs` 天然隔离）

**测试 mock 边界**：只在边界 mock（子进程 / 文件系统 / 网络 / logger / 被测模块的协作者）；Zod、纯函数、SQLite、Fastify 用真的。

**提交**：`git commit --only <paths>` 限定路径；多 Agent 并行时勿 `git add -A`（会扫走别人未提交的文件）。

**外部工具形态选型**：任何外部 CLI/工具形态决策必须过 ADR 0007 清单（`docs/adr/0007-external-tool-form-selection-checklist.md`）——能力对账前置 / 假设标红+实测对称 / 简单形态默认+复杂举证倒置 / 决策留痕。

## Pointers

- `CONTEXT.md` — 术语表、模块目录结构、文档位置约定、流程约定
- `docs/adr/` — 架构决策记录（新增前先读既有编号）
- `docs/run/` — 开发文档·在飞（本轮票单）；活收口即清，结论上浮到 `docs/requirements/`/`docs/sessions/`
- `CODING_STANDARDS.md` — 编码规范
- `.env.example` — 全部环境变量与默认值
- `README.md` — 面向用户的项目说明
