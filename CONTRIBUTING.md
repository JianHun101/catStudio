# 贡献指南

面向要改这个仓库的人。**先读 [`AGENTS.md`](./AGENTS.md)**（命令、运行时不变量、边界与坑）与 [`CONTEXT.md`](./CONTEXT.md)（术语表）。

## 环境准备

```bash
# Node.js >= 22.18.0 + pnpm >= 8
pnpm install          # 装依赖（prepare 会固化 core.hooksPath=.husky）
pnpm dev              # server :3200 + web :5173
pnpm lint             # 类型检查（各包 tsc / vue-tsc）
pnpm test             # vitest run
```

## 分支与 worktree

- `main` 是生产分支，`dev` 是集成分支；日常提交落 `dev`，收口时由维护者 ff-only 快进到 `main`。
- 较大改动走独立 worktree（`node scripts/worktree-create.mjs <feature>` → 分支 `feat/<feature>`，基线 `dev`）。worktree 内一切 git 操作带 `-C <worktree>`。
- **worktree 内 `git push` 会被拒绝，这是预期的**——门禁拦的是「分支带着未审查的 commit」，不是配置缺失。**不要用 `--no-verify` 绕过。**

## 提交规范

提交消息必须带 `catstudy [uuid]` 标记：

```
<type>(<scope>): <摘要>

catstudy [<uuid>]
```

- `uuid` 是触发本次改动的那条消息 id（本仓的调度系统会给每次执行注入 `CATSTUDY_TRIGGER_MSG_ID`），`.husky/commit-msg` 会拿它去 `messages` 表校验存在性（[`scripts/commit-uuid-gate.mjs`](./scripts/commit-uuid-gate.mjs)）——**查无即拒**。手打或杜撰的 uuid 会挂在提交那一刻；无标记的 merge / revert / 手动提交照旧放行。
- **提交前限定路径**：`git add <paths>` → `git diff --cached --name-only` 核对暂存区 → 裸 `git commit`。裸 commit 提交**整个**暂存区，所以核对步是限定路径的替代保证。多人在同一工作区并行时**不要** `git add -A`。
- 不要用 `git commit --only`：`.husky/pre-commit` 为挡 git 注入污染会 `unset GIT_INDEX_FILE`，而 `--only` 正是靠这个变量把临时索引递给钩子的。
- 逃生口是 `git commit --no-verify`。它存在，但只用于已知的钩子误报（例如 CI 注入的环境变量导致夹具假红）；绕过门禁推未审分支是不行的——`pre-push` 还有一道。

## 代码审查链

1. 实施者提交 commit（限定路径，见上）。
2. 实施者补填交接文档（Why / Tradeoff / Open Questions），然后发起审查请求。
3. 审查者给结论：
   - ✅ 可合并 / 💬 仅评论（非阻断）→ 维护者收口：ff-only 合并 → 更新推送门禁 → 发起 push → 合并回 `main`。
   - ⚠️ 建议修改 / ❌ 需重做 → 回到实施者修改后重新发起。
4. 收口决策归维护者（架构师角色），实施者不自行合并。

配套：仓库自带 git 钩子（pre-commit / commit-msg / pre-push）与 diff 收集器，审查输入即来自这些钩子收集的 diff。

## 测试约定

- **测试跟随被测模块**，同目录同名前缀（co-located）——`xxx.ts` 的测试就是 `xxx.test.ts`，不设集中目录；一个测试文件只测一个被测模块。
- 跨模块测试挂主模块旁，只 mock 最外层边界。
- **只在边界 mock**：子进程 / 文件系统 / 网络 / logger / 被测模块的协作者。Zod、纯函数、SQLite、Fastify 用真的。
- server 测试用 `:memory:` SQLite（`setDb()` / `resetDb()` 钩子），并设 `MEMORY_ENABLED=false`。
- 辅助文件白名单（原地保留，非测试文件）：`packages/server/src/test-helpers.ts`、`packages/web/src/test-setup.ts`。
- e2e 两级：CLI 级（自包含、可进 CI）与系统级（真实 server + LLM，手动跑），命名 `*.e2e.mjs` 跟随被测脚本同目录，**不纳入** vitest include。
- vitest include：`packages/*/src/**/*.test.ts`；`scripts/` 用 `**/*.test.js`。

```bash
pnpm test                        # 全量
pnpm test:server                 # 仅服务端
pnpm test:watch                  # watch 模式
pnpm test:coverage               # 覆盖率
pnpm test -- --reporter=verbose  # 逐条显示
```

## 种子数据管理

种子数据默认 **upsert 模式**：多次运行幂等，Agent 用固定 ID（`uuid.v5`），更新配置不重建。运行配置（`llm_*` / `effort`）仅首次 INSERT 写入、UPDATE 永不覆盖——**数据库是运行配置的权威**。

```bash
pnpm seed              # 幂等（等价 npx tsx packages/server/src/seed.ts）
pnpm seed --reset      # 清空数据后重建
```

## 清空会话消息

前端 ChatPanel 头部有「清空」按钮，或直接调 API：

```bash
curl -X DELETE http://127.0.0.1:3200/api/sessions/<session-id>/messages
```

只删 `messages` 和 `execution_logs`，保留会话配置、Agent 设定与向量记忆。

## 常用脚本

```bash
pnpm dev / pnpm start    # 开发模式 / 生产模式（生产走主库）
pnpm dev:server          # 仅 server (:3200)
pnpm dev:web             # 仅 web (:5173)
pnpm stop                # 清理 3200 / 5173-5175 端口残留进程
pnpm build               # 全仓构建
pnpm lint                # 类型检查
```
