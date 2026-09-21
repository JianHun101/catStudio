<div align="center">

# CatStudio

**多 Agent 协作平台 —— 把孤立的 Agent CLI 变成一支有纪律的团队**

_每只猫有独立身份、独立上下文、独立供应商，共享同一份记忆索引；它们互相 @ 派活、互相审查、跨会话交接。_

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![pnpm](https://img.shields.io/badge/pnpm-8+-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

</div>

---

## 为什么选 CatStudio？

你有 Claude Code、Codex、dsh、opencode —— 每个都很强，各有所长。但同时用它们意味着**你**变成了路由器：在终端之间复制粘贴上下文，手动追踪谁说了什么、谁在做哪一步，大把时间花在中间调度上。

CatStudio 把这些孤立的 Agent 变成一支真正的团队 —— 持久身份、共享记忆、跨供应商协作、可编排的派活链。多数框架帮你*调用* Agent，CatStudio 帮你**编排**它们。

> CatStudio 不替代你的 Agent CLI —— 它是 CLI *之上*那一层。

## 快速开始

### 前置条件

| 依赖                           | 版本       | 必需？                           |
| ------------------------------ | ---------- | -------------------------------- |
| [Node.js](https://nodejs.org/) | >= 22.18.0 | 必需                             |
| [pnpm](https://pnpm.io/)       | >= 8       | 必需                             |
| Claude Code CLI                | 最新       | 必需（演示角色默认 provider）    |
| Codex CLI                      | 最新       | 可选（仅用 `openai` 适配器时）   |
| dsh CLI                        | 最新       | 可选（仅用 `dsh` 适配器时）      |
| opencode CLI                   | 最新       | 可选（仅用 `opencode` 适配器时） |

四个 CLI 都是**外部 CLI**，不在 `package.json` 依赖里 —— `pnpm install` 不会装它们，用到哪个装哪个。

### 跑起来

```bash
node --version  # 确认 >= 22.18.0
pnpm install
npm i -g @anthropic-ai/claude-code   # 演示角色默认走 Claude Code CLI

export DS_KEY="sk-..."   # 必填；Git Bash。CMD 用 set，PowerShell 用 $env:
pnpm seed                # 灌种子数据（5 个演示角色 + 1 个演示会话）
pnpm dev                 # 启动 server :3200 + web :5173
```

浏览器打开 **http://localhost:5173**，后端在 3200（Vite 端口被占用时自动切 5174、5175）。

> **演示角色默认走 Claude Code CLI**：5 个角色里 4 个的 provider 是 `claude`（模型 `deepseek-flash`），经 Claude Code CLI 打 DeepSeek 的 Anthropic 兼容端点；只有 dsh猫 用 `dsh`。所以 `DS_KEY` 是**必填**——不填时这 4 个角色会被 no-key 守卫拦下（界面提示「还没有配置 API Key」），不是静默降级。想换供应商，在界面的 agent 设置里改「供应商」下拉即可。

> 首次运行会下载嵌入模型 `Xenova/bge-small-zh-v1.5`（约 90MB）。**它缓存在 `node_modules/.pnpm/@huggingface+transformers@*/node_modules/@huggingface/transformers/.cache/` 内**，`pnpm install` 会清掉、需重新下载；下载期间记忆检索静默降级（服务端记日志），Agent 正常回复。中国大陆可设 `HF_ENDPOINT=https://hf-mirror.com`。

### 试用还是日常自用

`pnpm dev` 走实验库 `cat-study-dev.db`，随便折腾；`pnpm start` 走主库 `cat-study.db`，**记忆延续**，日常用这个。全部环境变量与默认值见 [`.env.example`](./.env.example)。

## 核心能力

| 能力              | 说明                                                              |
| ----------------- | ----------------------------------------------------------------- |
| **多 Agent 协作** | 单会话多只猫，按 `@` 精确路由派活；空闲即执行、忙碌则 FIFO 排队   |
| **A2A 派活链**    | Agent 之间行首 `@` 互相派活，一条回复串起下一棒，形成可编排执行链 |
| **长期记忆**      | 本地嵌入模型 + 向量检索，与关键词做 RRF 混合召回后注入上下文      |
| **上下文治理**    | 增量摘要 + 90% 阈值自动交接新会话，长对话不爆上下文               |
| **多 LLM 供应商** | 同一会话内每只猫可用不同 provider，适配器按 `provider + key` 复用 |
| **结构化路由**    | 投递、回读、检索、请求用户介入都走 MCP 工具，不靠文本约定         |
| **QQ 接入**       | OneBot v11 协议，NapCat 等实现以 HTTP 上报，本项目零新增依赖      |

## 支持的 Agent CLI

| CLI / 服务      | 对应 provider | 免 key | 说明                            |
| --------------- | ------------- | ------ | ------------------------------- |
| Claude Code CLI | `claude`      | 否     | 演示角色默认（5 个里 4 个走它） |
| dsh CLI         | `dsh`         | 否     | 演示角色（dsh 猫）              |
| Codex CLI       | `openai`      | 否     | 适配器支持                      |
| opencode CLI    | `opencode`    | 是     | 适配器支持，可零 key 跑         |
| Ollama          | `ollama`      | 是     | 本地模型，可零 key 跑           |

另有 `deepseek`（直连 API）与 `pi` 两个适配器不走 CLI —— 共 **7 个** provider 适配器。

## 架构

```
┌──────────────┐  WebSocket  ┌───────────────────────────────┐
│  Web (Vue 3) │◄───────────►│  Server (Fastify + Socket.IO) │
└──────────────┘             │  dispatch · memory · llm      │
                             └───────────────┬───────────────┘
      ┌──────────────────────┬───────────────┴──────────────┐
      ▼                      ▼                              ▼
  SQLite + sqlite-vec   Agent CLI 子进程             嵌入 sidecar
  （会话 / 记忆）      （claude / dsh / …）       （bge-small-zh）
```

技术栈：

| 层     | 技术                                                                         |
| ------ | ---------------------------------------------------------------------------- |
| 运行时 | Node.js 22.18.0+ / TypeScript 5.5 · Fastify 5 + Socket.IO 4 + SQLite · Vue 3 |

模块职责与目录细节见 [`CONTEXT.md`](./CONTEXT.md)；运行时不变量、边界与坑见 [`AGENTS.md`](./AGENTS.md)。

## 常用命令

| 命令                               | 作用                                   |
| ---------------------------------- | -------------------------------------- |
| `pnpm dev` / `pnpm start`          | 实验库 / 主库（记忆延续，日常用这个）  |
| `pnpm dev:server` / `pnpm dev:web` | 只起 server (:3200) / 只起 web (:5173) |
| `pnpm seed` / `pnpm seed --reset`  | 灌种子数据（幂等）/ 清空后重建         |
| `pnpm build`                       | 全仓构建                               |
| `pnpm test`                        | 跑全部测试（`vitest run`）             |
| `pnpm lint`                        | 类型检查（各包 tsc / vue-tsc）         |
| `pnpm stop`                        | 清理 3200 / 5173-5175 端口残留进程     |

## MCP 工具层

LLM 侧通过 9 个 MCP 工具与系统交互：`post_message`（结构化路由投递）、`query_db`（排障取证）、`query_session_messages`（回读历史）、`list_session_members`、`request_user_action`（请求用户介入，如重启 server）、`search_knowledge`、`read_skill` / `list_skills`（技能懒加载）、`create_pr`（创建 GitHub PR）。

`pnpm seed` 内置 5 个演示角色：店长（store，架构师）/ ds猫、flash猫、dsh猫（implementer，实施）/ 吐槽猫（reviewer，审查）。

## QQ 接入（OneBot / NapCat）

`.env` 设 `ONEBOT_ENABLED=true`，把 NapCat 等 OneBot v11 实现的上报地址指向 `POST http://127.0.0.1:3200/api/connectors/onebot/webhook` 即可（零新增依赖：webhook 入站 + fetch 出站）。

> **登录坑**：NapCat 核心进程起来 ≠ OneBot 可用——QQ 未登录时 HTTP（默认 3000）不监听，只有 WebUI（6099）在跑，token 在安装目录 `shell/napcat/config/webui.json` 的 `webuiToken`。
> **凭证目录**：登录态与消息数据在 `Tencent Files\<QQ号>\nt_qq\`，**不是** `NapCat\data`——后者为空 ≠ 凭证缺失。
> **占位符边界**：`NAPCAT_LAUNCH_CMD` 用 `{NAPCAT_PATH}` 模板时，占位符外不能再带附加内容（如 `{NAPCAT_PATH} --flag`）——路径含空格时 `cmd /c` 下不可解析。规避：改用无空格目录，或写不带占位符的完整命令行。

## 文档

| 位置                                   | 内容                                       |
| -------------------------------------- | ------------------------------------------ |
| [`CONTEXT.md`](./CONTEXT.md)           | 领域术语表、模块目录结构——**先读这个**     |
| [`AGENTS.md`](./AGENTS.md)             | 项目操作手册：命令、运行时不变量、边界与坑 |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | 开发流程：提交门禁、审查链、测试约定       |
| [`docs/adr/`](./docs/adr/)             | 架构决策记录（13 篇）                      |
| [`docs/plans/`](./docs/plans/)         | 定稿规格（7 篇）                           |
| [`docs/lessons/`](./docs/lessons/)     | 踩坑沉淀                                   |
| [`docs/research/`](./docs/research/)   | 技术调研                                   |

## License

[MIT](./LICENSE) © 2026 JianHun101
