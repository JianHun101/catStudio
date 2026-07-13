# CatStudy LLM 适配器扩展与 UI 设计改造

## 1. What — 具体改动

| 文件 | 改动 |
|------|------|
| `packages/server/src/llm/deepseek.ts` | 重构，从 Anthropic 协议端点改为 Chat Completions API（`/v1/chat/completions`），DeepSeek 主力端点 |
| `packages/server/src/llm/claude.ts` | 新建，Claude Code CLI 适配器。spawn 本地 `claude` 二进制 → 解析 NDJSON 流 → 输出 Chunk。默认通过环境变量指向 DeepSeek API，检测到 `api.anthropic.com` 时自动切换为原生 Anthropic 认证 |
| `packages/server/src/llm/openai.ts` | 新建，Codex CLI 适配器。spawn 本地 `codex` 二进制 → 经 codex-proxy 转协议 → DeepSeek。Windows 下使用 PowerShell 管道传 prompt 避免 stdin 阻塞 |
| `packages/server/src/llm/cli-utils.ts` | 新建，CLI 适配器共享工具。`resolveBin()`（兼容 Windows 中文用户名路径的二进制定位）、`messagesToPrompt()`（LLMMessage[] → 文本 prompt）、`ensureProxy()`（codex-proxy 生命周期管理）、`parseClaudeCodeOutput()`/`parseCodexOutput()`（NDJSON 流解析）、`attachIdleTimeout()`（5 分钟空闲超时）、`attachExitError()`（子进程错误日志） |
| `packages/server/src/llm/registry.ts` | 修改，注册 ClaudeAdapter 和 OpenAIAdapter。`getAdapterForAgent()` 按 `agent.llmProvider` 字段路由到三个适配器之一，按 apiKey 缓存实例 |
| `packages/web/index.html` | 重写，CSS 设计令牌系统。定义 `--bg-deep`/`--bg-base`/`--bg-surface`/`--bg-hover`/`--bg-raised` 五层表面色、`--border-subtle`/`--border-default`/`--border-focus` 三层边框、`--text-primary`/`--text-secondary`/`--text-muted` 三层文字、`--accent`(暖焦糖 `#d4a574`)/`--accent-pink`/`--accent-red`/`--accent-green`/`--accent-yellow` 强调色、`--radius-sm`~`--radius-xl` 圆角、`--shadow-sm`~`--shadow-lg` 阴影、全局 reset、自定义滚动条、选中高亮 |
| `packages/web/src/App.vue` | 修改，三面板网格布局。配色从暗蓝（`#1a1a2e`/`#16213e`/`#0f3460`）改为暖棕系（`--bg-deep`/`--bg-base`/`--border-subtle`），网格列宽从 `240px 1fr 280px` 调为 `260px 1fr 300px` |
| `packages/web/src/components/SessionList.vue` | 重写，左侧会话面板。新增 Brand 区（🐾 CatStudy 标题 + 副标题）、分组标题 + 计数徽章、会话项用 `💬` 图标 + 两行信息、删除按钮改为 SVG 垃圾桶图标、空状态提示、新建按钮用 SVG + 图标 |
| `packages/web/src/components/ChatPanel.vue` | 重写，中间聊天面板。消息气泡区分 agent（暖棕底 + 左上角圆角收窄）和 user（焦糖色调底 + 右上角圆角收窄）、系统消息居中斜体无背景、空状态改为欢迎页（🐱 大图 + 引导文字 + 提示）、广播开关从红粉改为焦糖色 + `transform` 动画、输入框 focus 边框色改为焦糖、发送按钮改为焦糖底色 + 深色文字、mention 下拉框用 `--bg-raised` 底色 + `--shadow-lg` |
| `packages/web/src/components/AgentPanel.vue` | 重写，右侧 Agent 面板。Agent 卡片增加 provider badge（如 `DEEPSEEK` 焦糖色标签）+ model 名称副行、状态改为圆点指示器（空闲灰色 / 忙碌橙色 pulse 动画）、队列徽章带 SVG 列表图标、新建表单改为可折叠区（header + body + footer 三段式）、队列区增加 SVG 标题图标 + 列表样式 |
| `packages/web/src/components/AgentEditModal.vue` | 重写，Agent 编辑弹窗。配色统一为设计令牌、provider 选项更新标签（`DeepSeek (HTTP API)` / `Claude Code (CLI)` / `Codex (CLI)` / `自定义`）、表单标签改为 uppercase 小字、头像选择器重新设计、弹窗增加 `backdrop-filter: blur(2px)` |
| `packages/web/src/components/SessionCreateModal.vue` | 重写，新建会话弹窗。Agent 选择项增加 SVG 圆形勾选图标（选中填焦糖色 + 白色对勾）、选中项边框高亮焦糖色、Agent 行增加 provider 副行、输入框 autofocus + Enter 快捷提交 |
| `scripts/dev.js` | 新建，统一开发启动器。spawn `pnpm --parallel -r dev` 作为子进程，捕获 SIGINT/SIGTERM → Windows 下 `taskkill /F /T` 杀整棵进程树 → 2 秒超时兜底 `process.exit(0)`。解决了 `pnpm dev` 直接运行时 Ctrl+C 残留子进程导致端口占用的问题 |
| `scripts/stop.js` | 新建，端口强制清理脚本。遍历 3200/5173/5174/5175 四个开发端口，`netstat + findstr` 定位 PID → `taskkill /F /PID` 逐个终止。`pnpm stop` 调用，用于兜底清理 |
| `package.json` | 修改，根包新增 `"type": "module"`（消除 ESM warning），`dev` 脚本改为 `node scripts/dev.js`，新增 `stop` 脚本 |
| `packages/server/src/index.ts` | 修改，CORS `origin` 从硬编码端口 `['http://localhost:5173', 'http://localhost:3000']` 改为正则 `[/^http:\/\/localhost:\d+$/]`，兼容 Vite 端口自动切换 |
| `packages/server/src/connectors/socketio.ts` | 修改，Socket.IO CORS 同上改为正则匹配；修复 `agent.system_prompt` → `agent.systemPrompt`（snake_case 遗留 bug） |
| `packages/server/src/llm/deepseek.ts` (type fix) | 修改，移除 `role === 'agent'` 冗余判断——`LLMMessage.role` 类型已限定为 `'system' \| 'user' \| 'assistant'`，上游 socketio.ts 已完成 `agent` → `assistant` 转换 |

## 2. Why — 为什么这样做

### 三种适配器，三种驱动方式

```
Provider  │  驱动方式       │  协议格式              │  切换官方
──────────┼─────────────────┼───────────────────────┼──────────────────
deepseek  │  HTTP fetch     │  Chat Completions      │  无需（原生）
claude    │  spawn CLI      │  Anthropic Messages    │  baseUrl → api.anthropic.com
openai    │  spawn CLI      │  Chat Completions      │  baseUrl → api.openai.com
```

**deepseek**（HTTP API）：直接 `fetch()` 调 `api.deepseek.com/v1/chat/completions`。零额外依赖，纯 HTTP 流式 SSE 解析。DeepSeek 原生格式，稳定性最高。

**claude**（Claude Code CLI）：spawn 本地 `claude` 二进制（`npm i -g @anthropic-ai/claude-code`），传 `-p <prompt> --output-format stream-json --verbose`，解析 NDJSON 流（`{"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}`）。通过环境变量 `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_MODEL` 等将 Claude Code 指向 DeepSeek API。检测到 `baseUrl` 含 `api.anthropic.com` 时自动切为 `x-api-key` + `anthropic-version` 头。

**openai**（Codex CLI）：spawn 本地 `codex` 二进制（`npm i -g @openai/codex`），需 `codex-proxy`（Python，`~/codex-proxy/codex_proxy.py`）做 Responses API ↔ Chat Completions 协议转换。Windows 下用 PowerShell `$input | & codex exec` 管道传 prompt 避免 cmd.exe stdin 阻塞。代理进程独立于 Server 生命周期运行，首次调用时 `ensureProxy()` 检测端口 9090 是否已监听，未监听则 spawn 并 detach。

### CLI 子进程管理

```
Agent 发消息 → getAdapterForAgent() → 取缓存 adapter
  → adapter.chatStream(messages) → messagesToPrompt() 转文本
    → spawn CLI 子进程（带 env）
      → attachIdleTimeout（5 分钟无输出 → SIGTERM → SIGKILL）
      → attachExitError（stderr 日志 + 非零退出码）
        → parseXxxOutput() 逐行 NDJSON → yield Chunk
          → 流结束 → yield { done: true }
```

关键决策：
- **NDJSON 解析用 `readline.createInterface` + `for await of`**：逐行解析，内存友好，自然适配流式输出
- **空闲超时**：CLI 子进程可能在复杂推理时长时间无 token 输出，设 5 分钟阈值避免无限挂起
- **codex-proxy 单例**：多个 Codex Agent 共用同一代理进程，模块级 `proxyStarted` 标志防止重复启动

### 暖色猫咖设计体系

参考 Discord（三面板层次区分）、Linear（精致间距与图标）、Notion（柔和色调 + 结构化表单），将原本全局暗蓝色调替换为暖棕系：

```
旧: #1a1a2e → #16213e → #0f3460  (全部是蓝色，层次不清)
新: #14110e → #1b1815 → #231f1b  (浓缩咖啡 → 暖棕 → 暖灰，五层递进)

旧 accent: #e94560 (刺眼红粉，压迫感强)
新 accent: #d4a574 (暖焦糖/拿铁色，呼应猫咪毛色)
```

五层 CSS 变量（`--bg-deep` / `--bg-base` / `--bg-surface` / `--bg-hover` / `--bg-raised`）在 `index.html :root` 中统一定义，全项目 7 个 Vue 组件通过 `var(--xxx)` 引用。改主题只需改一处。

### 进程生命周期管理

`pnpm --parallel -r dev` 在 Windows 上 Ctrl+C 后子进程（tsx watch, vite）可能变成孤儿进程持续占用端口。`scripts/dev.js` 作为统一启动器：spawn pnpm 作为子进程 → 捕获 SIGINT → `taskkill /F /T /PID` 杀整棵进程树。`scripts/stop.js` 作为兜底：暴力 `netstat | taskkill` 清四个开发端口。

### CORS 正则匹配

Vite 端口冲突时自动切换到 5174、5175……硬编码 `['http://localhost:5173']` 会导致后续端口被 CORS 拒绝。改为正则 `/^http:\/\/localhost:\d+$/`，任意本地端口均可连接。

## 3. Tradeoff — 放弃了什么方案

| 放弃 | 原因 |
|------|------|
| Claude/OpenAI 适配器用 HTTP API（直接 fetch） | Claude Code 和 Codex 本身是功能更丰富的 CLI 工具（含 agent loop、工具调用等），只调裸 API 等于放弃了这些能力。改用 spawn CLI 可以复用已有的 CLI 配置（DeepSeek env vars、codex-proxy） |
| 三个适配器全部走 DeepSeek Anthropic 端点 | `deepseek` 和 `claude` 都调 `/anthropic/v1/messages` 则完全冗余。改为：deepseek 走 Chat Completions（主力端点），claude 走 Anthropic Messages（不同协议格式），openai 默认走 OpenAI 官方 |
| CLI 适配器复用 `minimal-claude.js` 代码 | `minimal-claude.js` 是 CJS 独立脚本（含 `require`/硬编码 key），不适合直接 import 进 TypeScript ESM 项目。提取核心逻辑到 `cli-utils.ts` 并改为 TS + ESM |
| 用 `where` 命令查找 CLI 二进制路径 | Windows 中文用户名路径编码损坏（`Ф����` ≠ `肖锦鹏`），`npm prefix -g` + 多编码尝试更可靠 |
| UI 保持暗蓝配色只调色值 | 旧配色全部在组件内硬编码散落，改一处要全局搜索。用 CSS 变量体系彻底重写，一次定义全局生效 |
| CORS 加 `5174`、`5175` 端口 | 治标不治本。正则匹配一次解决所有未来端口切换 |
| pnpm dev 直接运行 | 子进程清理不可靠。`dev.js` 包装一层做信号转发 + 进程树清理 |
| TypeScript 类型报错留着不管 | 本 Session 涉及的 TypeScript 错误（`agent.system_prompt`、`role === 'agent'`）都是实际 bug 或死代码，顺手修掉保持零 error |

## 4. Open Questions — 不确定的点

- **Claude Code CLI 的 `--model` 参数**：当前通过环境变量 `ANTHROPIC_MODEL` 设置模型，未测试 `claude --model <name>` 是否等价。如果 CLI 支持 `--model` flag，可以简化为不设 env 直接传参
- **Codex CLI 的 stdin 阻塞**：Windows 下 `codex.cmd exec` 的 stdin 管道行为不稳定，当前用 PowerShell `$input | &` 包装。如果 Codex 后续版本修复了 Windows stdin 支持，可简化为 `spawn` 直接传 prompt
- **codex-proxy 单 key 限制**：代理进程使用首次调用 `ensureProxy()` 时传入的 API key。如果两个 Agent 有不同 DeepSeek key，第二个 Agent 会复用第一个的 key。单用户场景无影响，多用户需要 key 路由机制
- **CLI 子进程的并发安全**：同一 Agent 单槽位串行执行（FIFO），所以同一适配器实例不会被并发调用。但如果未来改为并行执行，需要确保每个 `chatStream` 调用 spawn 独立子进程
- **Claude Code / Codex 二进制未安装时的错误提示**：`resolveBin()` 在模块加载时执行，安装失败只打印 `console.warn`，`chatStream` 调用时返回友好的中文错误消息。未测试用户看到此提示后的实际操作路径
- **暖色主题在低对比度屏幕上的可读性**：`--text-secondary: #a0988e` 和 `--text-muted: #6b655c` 在低亮度或色准差的显示器上可能偏暗。如需调整，只需改 `index.html` 中的 CSS 变量

## 5. Next Action — 希望做什么

- 测试 Claude Code CLI 适配器在实际聊天中的完整链路（spawn → NDJSON 解析 → 流式输出 → 消息写入）
- 测试 Codex CLI 适配器 + codex-proxy 的端到端流程
- 对比三种 provider 在同一 prompt 下的回复质量和延迟差异
- 为 `codex-proxy` 的 key 冲突问题增加检测——如果新 Agent 的 key 与代理启动 key 不同，打印警告
- 考虑将 Claude Code / Codex 的模型参数通过 `--model` flag 传递而非环境变量，简化适配器逻辑
- 如果 CLI 方案稳定，考虑移除 `minimal-claude.js` 中对 `DEEPSEEK_API_KEY` 的硬编码依赖（当前 cli-utils.ts 从 agent 配置读取）
- 为三个适配器编写单元测试（mock spawn / fetch，验证 prompt 构造和 Chunk 输出）
- 在 `AgentEditModal` 中根据 provider 选择动态显示提示文字（如选择 `claude` 时提示"需安装 Claude Code CLI"）
