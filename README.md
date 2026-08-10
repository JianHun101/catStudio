# CatStudy — 猫咖多 Agent 对话系统

面向终端用户的本地多 Agent 对话平台。用户创建 Session（会话），与一组具有持久身份和长期记忆的拟人化 AI Agent（猫咪角色）进行群聊。

## 前置依赖

| 依赖                           | 版本要求 | 用途                     | 必需？                                   |
| ------------------------------ | -------- | ------------------------ | ---------------------------------------- |
| [Node.js](https://nodejs.org/) | >= 20    | 运行时                   | ✅                                       |
| [pnpm](https://pnpm.io/)       | >= 8     | 包管理 + monorepo        | ✅                                       |
| [Redis](https://redis.io/)     | >= 7.0   | Agent 状态跨进程同步     | ⚠️ 可选（单机 Web 场景可降级为内存模式） |
| Claude Code CLI                | 最新     | `claude` provider 适配器 | ❌ 仅使用该 provider 时需要              |
| Codex CLI + codex-proxy        | 最新     | `openai` provider 适配器 | ❌ 仅使用该 provider 时需要              |

### 安装前置依赖

```bash
# Node.js（推荐通过 nvm-windows / fnm / 官网安装）
node --version  # 确认 >= 20

# pnpm
npm install -g pnpm

# Redis（Windows，可选）
winget install Redis.Redis
# 安装后 Redis 作为 Windows Service 自动运行，监听 localhost:6379

# Claude Code CLI（可选——仅使用 claude provider 时）
npm install -g @anthropic-ai/claude-code

# Codex CLI + codex-proxy（可选——仅使用 openai provider 时）
npm install -g @openai/codex
# codex-proxy 需额外配置，参见 packages/server/src/llm/cli-utils.ts 中的 ensureProxy()
```

## 快速开始

```bash
# 1. 安装依赖
pnpm install

# 2. 设置 API Key
# DeepSeek 是默认 provider，3 只演示猫咪需要 DS_KEY 环境变量
set DS_KEY=sk-your-deepseek-api-key    # Windows CMD
# 或 $env:DS_KEY="sk-..."              # PowerShell
# 或 export DS_KEY="sk-..."            # Git Bash

# 3. 初始化种子数据（3 只演示猫 + 1 个演示会话）
npx tsx packages/server/src/seed.ts

# 4. 启动开发环境
pnpm dev
```

启动后打开浏览器访问 **http://localhost:5173**。

> **注意**：首次运行嵌入模型 `Xenova/bge-small-zh-v1.5`（约 100MB）会从 HuggingFace 下载并缓存到 `~/.cache/huggingface/`。下载期间记忆检索静默降级，Agent 正常回复。

## 端口分配

| 端口 | 进程                         | 说明                                   |
| ---- | ---------------------------- | -------------------------------------- |
| 3200 | server (Fastify + Socket.IO) | REST API + WebSocket                   |
| 5173 | web (Vite dev server)        | Vue 3 前端，API/socket 反向代理到 3200 |

Vite 端口冲突时自动切换到 5174、5175……CORS 已配置为 `localhost` 正则匹配，任意端口均可连接。

## 项目结构

```
catStudy/
├── packages/
│   ├── shared/          # 共享类型 + Zod Schema + 事件常量
│   │   └── src/
│   │       ├── types.ts        # AgentConfig, SessionConfig, Message, Memory…
│   │       ├── schemas.ts      # Zod 校验 (AgentCreate, SessionCreate…)
│   │       ├── events.ts       # Socket.IO 事件名 + Redis 频道模式
│   │       └── token-counter.ts# Token 计数工具（字符估算 + tiktoken）
│   ├── server/          # 后端 (Fastify + Socket.IO + SQLite)
│   │   └── src/
│   │       ├── index.ts        # 服务入口：Fastify → Socket.IO → 优雅关闭
│   │       ├── db/
│   │       │   ├── index.ts    # SQLite 初始化 (5 张表 + 迁移)
│   │       │   └── redis.ts    # Redis 客户端（可选，失败降级）
│   │       ├── llm/
│   │       │   ├── adapter.ts  # LLMAdapter 统一接口
│   │       │   ├── deepseek.ts # DeepSeek HTTP Chat Completions 适配器
│   │       │   ├── claude.ts   # Claude Code CLI spawn 适配器
│   │       │   ├── openai.ts   # Codex CLI spawn 适配器
│   │       │   ├── cli-utils.ts# CLI 适配器共享工具（resolveBin, parseOutput）
│   │       │   ├── git-utils.ts# CLI 适配器 Git workspace 隔离
│   │       │   └── registry.ts # 按 provider + apiKey 路由适配器
│   │       ├── dispatch/
│   │       │   └── index.ts    # 单槽位 FIFO 调度引擎
│   │       ├── summarizer/
│   │       │   └── index.ts    # 增量摘要引擎（fire-and-forget）
│   │       ├── handoff/
│   │       │   └── index.ts    # 会话交接（90% token 阈值自动创建新会话）
│   │       ├── skills/
│   │       │   └── skill-loader.ts # 按需技能加载器
│   │       ├── memory/
│   │       │   ├── index.ts    # 记忆存储 + 检索 + 去重
│   │       │   └── embedding.ts# HuggingFace 本地嵌入模型加载
│   │       ├── connectors/
│   │       │   ├── socketio.ts    # Socket.IO 消息收发 + 上下文过滤
│   │       │   └── a2a-mentions.ts# Agent 间 @mention 解析（行首匹配 + 代码块剥离）
│   │       ├── routes/
│   │       │   ├── agents.ts   # Agent CRUD REST API
│   │       │   └── sessions.ts # Session CRUD + 广播切换 + 消息清空
│   │       ├── seed.ts         # 种子数据（upsert 模式，幂等运行）
│   │       └── logger.ts       # 双格式日志：stdout 彩色人读 / 文件 JSON Lines
│   └── web/             # 前端 (Vue 3 + Pinia + Socket.IO Client)
│       └── src/
│           ├── App.vue         # 三面板网格布局
│           ├── main.ts         # 入口：createApp + Pinia
│           ├── components/
│           │   ├── ChatPanel.vue       # 中间聊天面板 + @提及 + 广播/清空
│           │   ├── SessionList.vue     # 左侧会话列表 + 删除
│           │   ├── AgentPanel.vue      # 右侧 Agent 状态 + 新建
│           │   ├── AgentEditModal.vue  # Agent 编辑弹窗 + provider 提示
│           │   └── SessionCreateModal.vue # 新建会话弹窗
│           ├── stores/
│           │   └── chat.ts     # Pinia 状态管理 + Socket.IO 事件绑定
│           ├── composables/
│           │   ├── useApi.ts       # REST API 封装
│           │   ├── useSocket.ts    # Socket.IO 单例
│           │   └── useMention.ts   # @提及自动补全逻辑
│           └── utils/
│               └── logger.ts       # 浏览器端轻量日志（dev 输出，prod 静默）
├── scripts/
│   ├── dev.js            # 统一开发启动器（进程树清理）
│   └── stop.js           # 端口强制清理（netstat → taskkill）
├── docs/adr/             # 架构决策记录 (6 篇)
├── CONTEXT.md            # 领域术语表
├── pnpm-workspace.yaml   # pnpm monorepo 配置
├── vitest.workspace.ts   # Vitest 工作区（shared/server/web）
└── tsconfig.base.json    # 共享 TypeScript 编译配置
```

## 可用脚本

```bash
# ─── 开发 ──────────────────────────────────
pnpm dev              # 启动 server + web（统一进程管理，Ctrl+C 彻底退出）
pnpm dev:server       # 仅启动 server (3200)
pnpm dev:web          # 仅启动 web (5173)
pnpm stop             # 强制清理 3200/5173/5174/5175 端口残留进程

# ─── 种子数据 ──────────────────────────────
npx tsx packages/server/src/seed.ts           # upsert 模式：已存在则更新配置
npx tsx packages/server/src/seed.ts --reset   # 重置模式：清空所有数据后重建

# ─── 测试 ──────────────────────────────────
pnpm test             # 运行所有测试 (当前 314 条)
pnpm test:watch       # watch 模式，文件变更自动运行
pnpm test:coverage    # 运行 + 覆盖率报告
pnpm test:server      # 仅 server 包测试
pnpm test:web         # 仅 web 包测试
pnpm test:shared      # 仅 shared 包测试

# ─── 类型检查 ──────────────────────────────
pnpm lint             # 全项目 TypeScript 类型检查
```

## 环境变量

| 变量                       | 默认值                     | 说明                                                                                             |
| -------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------ |
| `DS_KEY`                   | —                          | DeepSeek API Key（种子数据使用，3 只演示猫共用）                                                 |
| `PORT`                     | `3200`                     | Server 监听端口                                                                                  |
| `HOST`                     | `0.0.0.0`                  | Server 监听地址                                                                                  |
| `REDIS_URL`                | `redis://localhost:6379`   | Redis 连接地址                                                                                   |
| `HF_ENDPOINT`              | `https://huggingface.co`   | HuggingFace 模型下载地址（中国大陆可设为 `https://hf-mirror.com`）                               |
| `LOG_LEVEL`                | `info`                     | 日志级别：`debug` / `info` / `warn` / `error`                                                    |
| `MEMORY_DEDUP_ENABLED`     | `1`                        | 是否启用记忆去重（`0` 关闭）                                                                     |
| `MEMORY_DEDUP_THRESHOLD`   | `0.20`                     | 记忆去重余弦距离阈值（越小越严格）                                                               |
| `MEMORY_TOP_K`             | `3`                        | 检索时返回的相关记忆条数                                                                         |
| `MEMORY_ENABLED`           | `true`                     | 是否启用向量记忆（`false` 关闭，测试环境建议关闭）                                               |
| `MEMORY_EMBEDDING_MODEL`   | `Xenova/bge-small-zh-v1.5` | 本地嵌入模型名称                                                                                 |
| `SUMMARY_ENABLED`          | `true`                     | 是否启用增量摘要                                                                                 |
| `SUMMARY_MODEL`            | `deepseek-chat`            | 摘要使用的模型                                                                                   |
| `SUMMARY_API_KEY`          | 同 `DS_KEY`                | 摘要模型的 API Key                                                                               |
| `SUMMARY_BASE_URL`         | `https://api.deepseek.com` | 摘要 API 地址                                                                                    |
| `SUMMARY_INTERVAL`         | `3`                        | 每 N 轮对话触发一次增量摘要                                                                      |
| `HANDOFF_ENABLED`          | `true`                     | 是否启用 90% 阈值会话交接                                                                        |
| `HANDOFF_THRESHOLD`        | `0.9`                      | 触交接的上下文 token 占比（可经设置页「系统配置」修改，配置文件优先于 env）                      |
| `MAX_CONTEXT_TOKENS`       | `128000`                   | 单次 LLM 调用的上下文 token 预算上限                                                             |
| `TOKEN_COUNT_METHOD`       | `estimate`                 | token 计数方式：`estimate`（字符估算）或 `tiktoken`（精确计数）                                  |
| `CLI_IDLE_TIMEOUT_MS`      | `1200000`                  | CLI 适配器空闲超时（毫秒，20 分钟）                                                              |
| `AGENT_HARD_TIMEOUT_MS`    | `1800000`                  | Agent 执行硬超时（毫秒，30 分钟）                                                                |
| `CLAUDE_CODE_EFFORT_LEVEL` | `high`                     | Claude Code CLI 推理深度：`low` / `medium` / `high` / `max`                                      |
| `ONEBOT_ENABLED`           | `false`                    | 是否启用 OneBot webhook（默认 false，关闭时 webhook 返回 503）                                   |
| `ONEBOT_API_BASE`          | `http://127.0.0.1:3000`    | NapCat HTTP API 地址（出站回复用）                                                               |
| `ONEBOT_TOKEN`             | —                          | webhook 鉴权 token（设置后上报须鉴权：Bearer 或 `x-signature`，详见「QQ 接入」章节；留空不校验） |
| `NAPCAT_LAUNCH_CMD`        | —                          | dev.js 拉起 NapCat 的启动命令：完整命令行或 `{NAPCAT_PATH}` 模板（详见下文「QQ 接入」章节）      |

## QQ 接入（OneBot / NapCat）

猫咖通过 OneBot v11 协议接入 QQ：NapCat 等实现通过 HTTP 上报消息，猫咖零新增依赖（webhook 入站 + fetch 出站）。环境变量见上表 `ONEBOT_*` 与 `NAPCAT_LAUNCH_CMD`。

### 接入前提

1. 安装 NapCat（如 `D:\Software\NapCat\shell\napcat.bat`）
2. `.env` 设置 `ONEBOT_ENABLED=true`
3. NapCat HTTP 上报配置指向 `POST http://127.0.0.1:3200/api/connectors/onebot/webhook`（若设置了 `ONEBOT_TOKEN`，需在 NapCat 上报配置中填一致的**上报签名密钥**——NapCat 自动带 `x-signature` 头；直接用 HTTP 客户端 POST 才用 `Authorization: Bearer <token>` 头）

### 启动命令

`NAPCAT_LAUNCH_CMD` 两种形态，任选其一：

- **完整命令行**：直接写完整命令（如 napcat.exe 路径），含空格路径直接写不用引号——Node 自动组装加引号
- **`{NAPCAT_PATH}` 纯占位符模板**：配合配置页面「NapCat 启动路径」——页面保存的路径在启动时替换进命令，换机器/换安装位置只改页面不碰 `.env`，保存后立即生效无需重启

### 自动拉起开关（autoStart）

`dev.js` 启动时是否自动拉起 NapCat，由配置页面「NapCat」的「dev 启动时自动拉起」开关控制（存于 `.napcat-config.json` 的 `autoStart` 字段）。**旧配置无该字段 = 自动拉起（默认开启）**——现有用户升级后行为零变化；在设置页关闭后，`pnpm dev` 不再自动拉起（打印引导日志），手动「启动 NapCat」不受影响。

### 首次使用必须登录 QQ

NapCat 核心进程起来 ≠ OneBot 可用：QQ 未登录时 HTTP（默认 3000）不监听、仅 WebUI（6099）在跑。

1. 浏览器打开 `http://127.0.0.1:6099`
2. token 在 NapCat 安装目录 `shell\napcat\config\webui.json` 的 `webuiToken`

登录一次不用每次扫码：WebUI「快速登录QQ」成功后自动写 `autoLoginAccount` 到 webui.json，之后重启自动登录。

### 凭证与数据目录

登录态与消息数据在 `Tencent Files\<QQ号>\nt_qq\`（`nt_db` / `nt_data` / `nt_temp`），**不是** `NapCat\data`——该目录为空 ≠ 凭证缺失。

### 排查「操作中」永等翻转

点击启动后面板一直「操作中」时按序排查：

1. 看 `ONEBOT_API_BASE` 端口是否监听——不监听先查 WebUI 登录态（见上）
2. 再看 dev.js 启动日志警告（见下「已知边界」）

### 已知边界

`{NAPCAT_PATH}` 占位符外不能再带附加内容（如 `{NAPCAT_PATH} --flag`）——路径含空格时 cmd /c 下该组合不可解析，dev.js 启动会打警告。规避：改用无空格目录，或完整命令行形态（不含占位符）。

## 核心概念

详见 [`CONTEXT.md`](./CONTEXT.md)。关键术语：

- **Agent** — 具有固定身份和长期记忆的 AI 猫咪角色，每个 Agent 独立配置 LLM 供应商
- **Session** — 独立的多人对话线程，包含一组 Agent
- **Slot** — Agent 的执行能力单元，单槽位 + FIFO 队列调度
- **Mention** — 用户通过 `@猫咪名` 指定回复者，调度系统据此路由
- **Memory** — Agent 对过往对话的向量化持久记录，用户发言后自动检索注入上下文
- **Broadcast Mode** — 开启后所有 Agent 互相感知对方发言；默认关闭（各 Agent 只看见和自己相关的消息）
- **Token Budget** — 单次 LLM 调用的上下文 token 预算上限（默认 128K），配合 token 感知软截断和 90% 交接阈值控制上下文膨胀
- **Summary** — 每 N 轮对话触发的增量摘要，异步更新运行中的会话摘要，减少旧消息 token 消耗
- **Handoff** — 当上下文使用率达到 90% 阈值时，自动创建新会话并生成全量总结，前端无缝切换

## 架构决策

6 篇 ADR 记录在 [`docs/adr/`](./docs/adr/)：

| ADR  | 决策                                                 |
| ---- | ---------------------------------------------------- |
| 0001 | pnpm monorepo (`packages/server` / `web` / `shared`) |
| 0002 | SQLite 持久化 + Redis 消息总线双存储                 |
| 0003 | 每 Agent 独立 LLM 适配器（provider + API key）       |
| 0004 | 单槽位 + FIFO 串行调度                               |
| 0005 | Redis Pub/Sub 三频道消息总线                         |
| 0006 | sqlite-vec 向量检索记忆系统                          |

## 开发工作流

### 种子数据管理

种子数据默认 **upsert 模式**：多次运行幂等，Agent 固定 ID（`uuid.v5`），更新配置不重建。

```bash
# 正常启动（幂等）
npx tsx packages/server/src/seed.ts

# 彻底重建（清空数据 + 重新插入）
npx tsx packages/server/src/seed.ts --reset
```

### 清空会话消息

前端 ChatPanel 头部提供"清空"按钮（垃圾桶图标），或直接调用 API：

```bash
curl -X DELETE http://localhost:3200/api/sessions/<session-id>/messages
```

清空只删除 `messages` 和 `execution_logs`，保留 Session 配置、Agent 设定和向量记忆。

### 运行测试

```bash
pnpm test             # 全量：314 条（shared 43 + server 192 + web 79）
pnpm test:server      # 仅服务端
pnpm test -- --reporter=verbose  # 逐条显示
```

## 技术栈

| 层         | 技术                                                        |
| ---------- | ----------------------------------------------------------- |
| 运行时     | Node.js 20+ / TypeScript 5.5                                |
| 包管理     | pnpm workspace (monorepo)                                   |
| 后端框架   | Fastify 5                                                   |
| 实时通信   | Socket.IO 4                                                 |
| 数据库     | SQLite (better-sqlite3 + WAL + sqlite-vec 向量扩展)         |
| 消息中间件 | Redis 7 (ioredis，可选)                                     |
| LLM 推理   | DeepSeek HTTP API / Claude Code CLI / Codex CLI             |
| 嵌入模型   | HuggingFace Transformers (Xenova/bge-small-zh-v1.5, 512 维) |
| 前端框架   | Vue 3 + Vite + Pinia                                        |
| 测试       | Vitest 4                                                    |
