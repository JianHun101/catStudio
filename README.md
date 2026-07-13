# CatStudy — 猫咖多 Agent 对话系统

面向终端用户的本地多 Agent 对话平台。用户创建 Session（会话），与一组具有持久身份和长期记忆的拟人化 AI Agent（猫咪角色）进行群聊。支持 Web 界面和 QQ Bot 等多渠道接入。

## 前置依赖

| 依赖 | 版本要求 | 用途 | 必需？ |
|------|----------|------|--------|
| [Node.js](https://nodejs.org/) | >= 20 | 运行时 | ✅ |
| [pnpm](https://pnpm.io/) | >= 8 | 包管理 + monorepo | ✅ |
| [Redis](https://redis.io/) | >= 7.0 | 消息总线 Pub/Sub | ⚠️ 可选（单机 Web 场景可降级为内存总线） |
| Claude Code CLI | 最新 | `claude` provider 适配器 | ❌ 仅使用该 provider 时需要 |
| Codex CLI + codex-proxy | 最新 | `openai` provider 适配器 | ❌ 仅使用该 provider 时需要 |

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

| 端口 | 进程 | 说明 |
|------|------|------|
| 3200 | server (Fastify + Socket.IO) | REST API + WebSocket |
| 5173 | web (Vite dev server) | Vue 3 前端，API/socket 反向代理到 3200 |

Vite 端口冲突时自动切换到 5174、5175……CORS 已配置为 `localhost` 正则匹配，任意端口均可连接。

## 项目结构

```
catStudy/
├── packages/
│   ├── shared/          # 共享类型 + Zod Schema + 事件常量
│   │   └── src/
│   │       ├── types.ts        # AgentConfig, SessionConfig, Message, Memory…
│   │       ├── schemas.ts      # Zod 校验 (AgentCreate, SessionCreate…)
│   │       └── events.ts       # Socket.IO 事件名 + Redis 频道模式
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
│   │       │   ├── cli-utils.ts# CLI 适配器共享工具
│   │       │   └── registry.ts # 按 provider + apiKey 路由适配器
│   │       ├── dispatch/
│   │       │   └── index.ts    # 单槽位 FIFO 调度引擎
│   │       ├── memory/
│   │       │   ├── index.ts    # 记忆存储 + 检索 + 去重
│   │       │   └── embedding.ts# HuggingFace 本地嵌入模型加载
│   │       ├── connectors/
│   │       │   └── socketio.ts # Socket.IO 消息收发 + 上下文过滤
│   │       ├── routes/
│   │       │   ├── agents.ts   # Agent CRUD REST API
│   │       │   └── sessions.ts # Session CRUD + 广播切换 + 消息清空
│   │       ├── seed.ts         # 种子数据（upsert 模式，幂等运行）
│   │       └── logger.ts       # 结构化 JSON 日志
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
│           └── composables/
│               ├── useApi.ts       # REST API 封装
│               ├── useSocket.ts    # Socket.IO 单例
│               └── useMention.ts   # @提及自动补全逻辑
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
pnpm test             # 运行所有测试 (当前 168 条)
pnpm test:watch       # watch 模式，文件变更自动运行
pnpm test:coverage    # 运行 + 覆盖率报告
pnpm test:server      # 仅 server 包测试
pnpm test:web         # 仅 web 包测试
pnpm test:shared      # 仅 shared 包测试

# ─── 类型检查 ──────────────────────────────
pnpm lint             # 全项目 TypeScript 类型检查
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DS_KEY` | — | DeepSeek API Key（种子数据使用，3 只演示猫共用） |
| `PORT` | `3200` | Server 监听端口 |
| `HOST` | `0.0.0.0` | Server 监听地址 |
| `REDIS_URL` | `redis://localhost:6379` | Redis 连接地址 |
| `HF_ENDPOINT` | `https://huggingface.co` | HuggingFace 模型下载地址（中国大陆可设为 `https://hf-mirror.com`） |
| `LOG_LEVEL` | `info` | 日志级别：`debug` / `info` / `warn` / `error` |
| `MEMORY_DEDUP_ENABLED` | `1` | 是否启用记忆去重（`0` 关闭） |
| `MEMORY_DEDUP_THRESHOLD` | `0.20` | 记忆去重余弦距离阈值（越小越严格） |
| `MEMORY_TOP_K` | `3` | 检索时返回的相关记忆条数 |

## 核心概念

详见 [`CONTEXT.md`](./CONTEXT.md)。关键术语：

- **Agent** — 具有固定身份和长期记忆的 AI 猫咪角色，每个 Agent 独立配置 LLM 供应商
- **Session** — 独立的多人对话线程，包含一组 Agent
- **Slot** — Agent 的执行能力单元，单槽位 + FIFO 队列调度
- **Mention** — 用户通过 `@猫咪名` 指定回复者，调度系统据此路由
- **Memory** — Agent 对过往对话的向量化持久记录，用户发言后自动检索注入上下文
- **Broadcast Mode** — 开启后所有 Agent 互相感知对方发言；默认关闭（各 Agent 只看见和自己相关的消息）

## 架构决策

6 篇 ADR 记录在 [`docs/adr/`](./docs/adr/)：

| ADR | 决策 |
|-----|------|
| 0001 | pnpm monorepo (`packages/server` / `web` / `shared`) |
| 0002 | SQLite 持久化 + Redis 消息总线双存储 |
| 0003 | 每 Agent 独立 LLM 适配器（provider + API key） |
| 0004 | 单槽位 + FIFO 串行调度 |
| 0005 | Redis Pub/Sub 三频道消息总线 |
| 0006 | sqlite-vec 向量检索记忆系统 |

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
pnpm test             # 全量：168 条（shared 28 + server 76 + web 64）
pnpm test:server      # 仅服务端
pnpm test -- --reporter=verbose  # 逐条显示
```

## 技术栈

| 层 | 技术 |
|----|------|
| 运行时 | Node.js 20+ / TypeScript 5.5 |
| 包管理 | pnpm workspace (monorepo) |
| 后端框架 | Fastify 5 |
| 实时通信 | Socket.IO 4 |
| 数据库 | SQLite (better-sqlite3 + WAL + sqlite-vec 向量扩展) |
| 消息中间件 | Redis 7 (ioredis) |
| LLM 推理 | DeepSeek HTTP API / Claude Code CLI / Codex CLI |
| 嵌入模型 | HuggingFace Transformers (Xenova/bge-small-zh-v1.5, 512 维) |
| 前端框架 | Vue 3 + Vite + Pinia |
| 测试 | Vitest 4 |
