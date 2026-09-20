# CatStudio

本地运行的**多 Agent 对话平台**：你创建会话，和一组有固定身份与长期记忆的 AI 猫咪角色群聊；它们彼此之间也会互相 @ 协作、互相审查代码——还能通过 QQ 跟你对话。

## 这是什么

- **不是「多开几个聊天窗口」**——每只猫有独立人设、独立的 LLM 供应商配置、独立的长期记忆，同一会话内共享上下文。
- **猫与猫之间真的会对话**——被 @ 的猫会被调度执行并回复，它的回复又能 @ 下一只猫，串成可编排的协作链（A2A）。
- **除了聊天，还带一套工程化协作能力**——结构化路由投递、代码审查链、增量摘要与上下文交接、执行评估与归因。

> 开发与代码里沿用「猫咖」作为内部代号（代码字符串、日志、测试断言、角色人设），对外产品名为 **CatStudio**。

## 核心能力

- **多 Agent 群聊** —— 单会话多只猫，按 `@` 精确路由；空闲即执行、忙碌则 FIFO 排队。[`packages/server/src/dispatch/`](./packages/server/src/dispatch/)
- **A2A 协作** —— Agent 之间行首 `@` 即可互相派活，形成执行链。[`connectors/a2a-mentions.ts`](./packages/server/src/connectors/a2a-mentions.ts)
- **长期记忆** —— 本地嵌入模型 + sqlite-vec 向量检索，与关键词做 RRF 混合召回后注入上下文。[`packages/server/src/memory/`](./packages/server/src/memory/)
- **多 LLM 供应商** —— 同一会话内每只猫可用不同 provider，按 `provider + apiKey` 复用适配器实例。[`packages/server/src/llm/`](./packages/server/src/llm/)
- **上下文治理** —— 增量摘要 + 90% 阈值自动交接新会话，长对话不爆上下文。[`docs/adr/`](./docs/adr/)
- **QQ 接入** —— OneBot v11 协议，NapCat 等实现以 HTTP 上报，本项目零新增依赖。[`connectors/onebot.ts`](./packages/server/src/connectors/onebot.ts)

## 快速开始

| 依赖                           | 版本       | 必需？                                    |
| ------------------------------ | ---------- | ----------------------------------------- |
| [Node.js](https://nodejs.org/) | >= 22.18.0 | ✅                                        |
| [pnpm](https://pnpm.io/)       | >= 8       | ✅                                        |
| `opencode` CLI                 | 最新       | ✅ 演示角色的默认 provider（5 个里 4 个） |
| Claude Code CLI / Codex CLI    | 最新       | ❌ 仅使用对应 provider 适配器时需要       |

```bash
node --version  # 确认 >= 22.18.0
pnpm install

npm i -g opencode-ai       # 演示角色默认走 opencode CLI（若尚未安装）
opencode auth login        # 登录 opencode（若尚未登录）

export DS_KEY="sk-..."     # 可选：只有 dsh 试点猫需要（Git Bash）
#   set DS_KEY=sk-...            # Windows CMD
#   $env:DS_KEY="sk-..."         # PowerShell

pnpm seed   # 灌种子数据（5 个演示角色 + 1 个演示会话）
pnpm dev    # 启动 server :3200 + web :5173
```

> **演示角色的默认供应商是 opencode**：店长 / ds猫 / flash猫 / 吐槽猫 的 `llmProvider` 都是 `opencode`（模型 `opencode-go/deepseek-v4-flash`，走 opencode Go 订阅）；只有 dsh猫 用 `dsh` 并消费 `DS_KEY`。想换成别的供应商，在界面的 agent 设置里改「供应商」下拉即可——适配器共 7 个，见下「技术栈」。

浏览器打开 **http://localhost:5173**，后端在 3200。Vite 端口被占用时自动切换 5174、5175。

> 首次运行会下载本地嵌入模型 `Xenova/bge-small-zh-v1.5`（约 100MB）到 `~/.cache/huggingface/`；下载期间记忆检索静默降级，Agent 正常回复。中国大陆可设 `HF_ENDPOINT=https://hf-mirror.com`。

### 常用脚本

| 命令                               | 作用                                   |
| ---------------------------------- | -------------------------------------- |
| `pnpm dev` / `pnpm start`          | 开发模式 / 生产模式（生产模式走主库）  |
| `pnpm dev:server` / `pnpm dev:web` | 只起 server (:3200) / 只起 web (:5173) |
| `pnpm seed` / `pnpm seed --reset`  | 灌种子数据（幂等）/ 清空后重建         |
| `pnpm build`                       | 全仓构建                               |
| `pnpm test`                        | 跑全部测试（`vitest run`）             |
| `pnpm lint`                        | 类型检查（各包 tsc / vue-tsc）         |
| `pnpm stop`                        | 清理 3200 / 5173-5175 端口残留进程     |

## 架构总览

| 包 / 目录          | 职责                                                    |
| ------------------ | ------------------------------------------------------- |
| `packages/shared/` | 共享类型、Zod schema、Socket.IO 事件常量（无运行逻辑）  |
| `packages/server/` | Fastify + Socket.IO + SQLite + LLM 适配器 + 调度 + 记忆 |
| `packages/web/`    | Vue 3 前端（Vite + Pinia + Socket.IO client）           |
| `scripts/`         | 开发 / 种子 / 停服、MCP server、git 钩子与技能治理      |
| `skills/`          | 技能活源（`.claude/skills` 是指向此处的链接）           |
| `docs/`            | 文档：ADR、定稿规格、调研、开发过程记录                 |

`packages/server/src/` 的主要模块：

| 模块          | 职责                                                    |
| ------------- | ------------------------------------------------------- |
| `llm/`        | 供应商适配器 + 按 provider/key 的注册表与并发 token 池  |
| `dispatch/`   | 单槽位 FIFO 调度引擎、`@mention` 投递策略               |
| `memory/`     | 切片检索与上下文构建（向量 + 关键词 RRF 混合）          |
| `connectors/` | Socket.IO 收发、OneBot(QQ) 接入、消息入库               |
| `routes/`     | REST API（agents / sessions / messages / connectors …） |
| `db/`         | SQLite 初始化（WAL + sqlite-vec + 迁移）与仓储层        |

技术栈：

| 层       | 技术                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------- |
| 运行时   | Node.js 22.18.0+ / TypeScript 5.5                                                                        |
| 后端     | Fastify 5 + Socket.IO 4 + SQLite (better-sqlite3 + WAL + sqlite-vec)                                     |
| LLM 推理 | 7 个 provider 适配器：`deepseek` / `claude` / `openai`(Codex CLI) / `pi` / `ollama` / `opencode` / `dsh` |
| 嵌入模型 | Xenova/bge-small-zh-v1.5（512 维，跑在独立 sidecar 进程）                                                |
| 前端     | Vue 3 + Vite + Pinia ／ 测试 Vitest 4                                                                    |

模块职责与目录细节见 [`CONTEXT.md`](./CONTEXT.md)；运行时不变量与边界见 [`AGENTS.md`](./AGENTS.md)。

## 配置

全部环境变量与默认值见 [`.env.example`](./.env.example)（含逐项注释）。最常用的几项：

| 变量                     | 默认值                     | 说明                                        |
| ------------------------ | -------------------------- | ------------------------------------------- |
| `DS_KEY`                 | —                          | DeepSeek API Key（仅 dsh 试点猫需要，可选） |
| `PORT` / `HOST`          | `3200` / `127.0.0.1`       | Server 监听端口与地址                       |
| `LOG_LEVEL`              | `info`                     | `debug` / `info` / `warn` / `error`         |
| `MEMORY_ENABLED`         | `true`                     | 是否启用向量记忆                            |
| `MEMORY_EMBEDDING_MODEL` | `Xenova/bge-small-zh-v1.5` | 本地嵌入模型                                |
| `HANDOFF_THRESHOLD`      | `0.9`                      | 上下文占比达此值触发会话交接                |
| `ONEBOT_ENABLED`         | `false`                    | 是否启用 QQ 接入                            |
| `AGENT_HARD_TIMEOUT_MS`  | `1800000`                  | 单次执行硬超时（毫秒，30 分钟）             |

## 文档地图

| 位置                                           | 内容                                       |
| ---------------------------------------------- | ------------------------------------------ |
| [`CONTEXT.md`](./CONTEXT.md)                   | 领域术语表、模块目录结构——**先读这个**     |
| [`AGENTS.md`](./AGENTS.md)                     | 项目操作手册：命令、运行时不变量、边界与坑 |
| [`CODING_STANDARDS.md`](./CODING_STANDARDS.md) | 编码规范                                   |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md)         | 开发流程：提交门禁、审查链、测试约定       |
| [`docs/adr/`](./docs/adr/)                     | 架构决策记录（13 篇）                      |
| [`docs/plans/`](./docs/plans/)                 | 定稿规格（7 篇）                           |
| [`docs/lessons/`](./docs/lessons/)             | 踩坑沉淀                                   |
| [`docs/research/`](./docs/research/)           | 技术调研                                   |
| [`docs/eval/`](./docs/eval/)                   | 检索质量基线与黄金集                       |
| [`docs/run/`](./docs/run/)                     | 开发文档·在飞（过程记录）                  |
| [`docs/sessions/`](./docs/sessions/)           | 会话摘要（过程记录）                       |

## QQ 接入（OneBot / NapCat）

NapCat 等 OneBot v11 实现以 HTTP 上报消息，本项目零新增依赖（webhook 入站 + fetch 出站）。

1. 安装 NapCat，`.env` 设 `ONEBOT_ENABLED=true`
2. 上报地址指向 `POST http://127.0.0.1:3200/api/connectors/onebot/webhook`
3. 若设了 `ONEBOT_TOKEN`：NapCat 侧填**上报签名密钥**（它自动带 `x-signature` 头）；用 HTTP 客户端直连才走 `Authorization: Bearer <token>`
4. 是否让 `pnpm dev` 自动拉起 NapCat，由 `NAPCAT_LAUNCH_CMD` 与设置页开关控制

**登录坑**：NapCat 核心进程起来 ≠ OneBot 可用——QQ 未登录时 HTTP（默认 3000）不监听，只有 WebUI（6099）在跑。浏览器打开 `http://127.0.0.1:6099`，token 在 NapCat 安装目录 `shell/napcat/config/webui.json` 的 `webuiToken`。点「快速登录QQ」成功后会自动写 `autoLoginAccount`，之后重启免扫码。

**凭证目录**：登录态与消息数据在 `Tencent Files\<QQ号>\nt_qq\`（`nt_db` / `nt_data` / `nt_temp`），**不是** `NapCat\data`——后者为空 ≠ 凭证缺失。

**占位符边界**：`NAPCAT_LAUNCH_CMD` 用 `{NAPCAT_PATH}` 模板时，占位符外不能再带附加内容（如 `{NAPCAT_PATH} --flag`）——路径含空格时 `cmd /c` 下不可解析，启动会打警告。规避：改用无空格目录，或写不带占位符的完整命令行。

## MCP 工具层

LLM 侧通过 MCP 工具与系统交互，当前 9 个：

| 工具                     | 用途                                      |
| ------------------------ | ----------------------------------------- |
| `post_message`           | 结构化路由投递：投给会话内下一棒 Agent    |
| `query_db`               | 排障取证：按白名单表/列查数据库           |
| `query_session_messages` | 回读会话历史消息（含 thinking / tool 块） |
| `list_session_members`   | 列出会话成员（agentId / name / role）     |
| `request_user_action`    | 请求用户介入（如重启 server，需用户批准） |
| `search_knowledge`       | 检索运营方知识库                          |
| `read_skill`             | 按名读取技能正文（懒加载）                |
| `list_skills`            | 列出技能清单                              |
| `create_pr`              | 创建 GitHub PR（收口链发布关）            |

工具定义见 [`scripts/mcp-server-utils.mjs`](./scripts/mcp-server-utils.mjs)，服务端实现见 [`connectors/socketio.ts`](./packages/server/src/connectors/socketio.ts)。

## 演示角色

`pnpm seed` 内置 5 个角色（类型：store / implementer / reviewer）：

| 角色    | 类型        | 职责                         |
| ------- | ----------- | ---------------------------- |
| 店长    | store       | 架构师：组件设计、派活、收口 |
| ds猫    | implementer | 实施工程师                   |
| flash猫 | implementer | 实施工程师                   |
| dsh猫   | implementer | 实施工程师（dsh 试点）       |
| 吐槽猫  | reviewer    | 审查者：代码审查             |

## License

[MIT](./LICENSE) © 2026 JianHun101
