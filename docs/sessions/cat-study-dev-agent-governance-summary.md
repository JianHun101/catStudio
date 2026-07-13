# CatStudy 开发 Agent 权限治理 + 消息撤回 + Agent 状态反馈

## 1. What — 具体改动

| 文件 | 改动 |
|------|------|
| `packages/shared/src/events.ts` | 新增 `MESSAGE_RETRACT`、`MESSAGE_RETRACTED`、`MESSAGE_AGENT_STATUS` 三个事件常量（15→18） |
| `packages/shared/src/events.test.ts` | 更新事件计数断言，新增撤回事件测试 |
| `packages/server/src/db/index.ts` | `execution_logs` 新增 `message_id`、`commit_hash`、`packages_installed` 三列迁移 |
| `packages/server/src/test-helpers.ts` | 测试 schema 同步新增三列 |
| `packages/server/src/llm/claude.ts` | 新增 `--permission-mode bypassPermissions`，对齐 Clowder 全权限 CLI 模式 |
| `packages/server/src/llm/git-utils.ts` | 新建 — git commit/reset/clean + npm snapshot/diff/uninstall 工具函数 |
| `packages/server/src/seed-data.ts` | 新增 `DEVELOPMENT_RULE` 和 `REVIEW_RULE` 常量，注入店长/服务员/吐槽猫 system prompt |
| `packages/server/src/connectors/socketio.ts` | 新增消息撤回 handler（kill 子进程 + git 回滚 + npm 卸载）；runAgentReply 中途撤回检测 + 包依赖快照 + git commit 自动记录；emit MESSAGE_AGENT_STATUS 在 queued/thinking/replying/done 阶段 |
| `packages/web/src/stores/chat.ts` | 健康检查轮询替代盲重试；joinSession 加入欢迎引导消息；新增 `waitingForServer` / `serverOnline` / `messageStatus` 状态；`retractMessage` action；广播模式切换系统通知；MESSAGE_AGENT_STATUS + MESSAGE_RETRACTED 事件处理；错误信息中文化 |
| `packages/web/src/composables/useApi.ts` | HTTP 状态码中文前缀；请求超时 AbortController（10s） |
| `packages/web/src/components/ChatPanel.vue` | 用户消息下方 Agent 状态指示器（📨已收到→🤔思考中→⌨️回复中→✅完成）+ 撤回按钮（两步确认）；连接状态圆点（绿色在线/红色断开）；清空消息两步确认 |
| `packages/web/src/components/SessionList.vue` | 区分"等待服务器启动"和"加载数据中"两种 loading 状态 |
| `packages/web/src/components/AgentPanel.vue` | 新增 `waitingForServer` 状态展示；创建失败中文错误分类提示 |
| `packages/web/src/stores/chat.test.ts` | 更新 joinSession 测试断言匹配新增的欢迎消息 |

## 2. Why — 为什么这样做

### 架构对齐：从 Clowder 移植三层铁律模式

本轮核心决策是在 D:\Game\ai\clowder-ai 源码分析基础上，将 Clowder 的"Prompt 约定 + 代码路由 + 硬代码守卫"三层模式移植到 CatStudy：

```
Layer 1 — Prompt 层（DEVELOPMENT_RULE / REVIEW_RULE）:
  店长: "安装包前必须先声明，@吐槽猫 请求审核。禁止声明和安装同轮出现。"
  吐槽猫: "审查必要性/安全性/影响，批准或拒绝。"

Layer 2 — Dispatch 路由层（已有，无需改动）:
  executeAgentsSerial → parseMentionsFromReply → 自动路由到吐槽猫
  depth 限制 + ping-pong breaker 防止无限循环

Layer 3 — 硬代码层（撤回 + git 回滚）:
  消息撤回 → kill 子进程 + git reset --hard / git clean
  git ignore 文件（node_modules 等）不受影响
```

Clowder 的 `ClaudeAgentService.ts` 实际使用 `PERMISSION_MODE = 'bypassPermissions'`，全放权给 CLI。安全不靠 CLI 权限拦截，靠平台层的 dispatch 路由 + prompt 约定。CatStudy 按同样思路操作。

### 消息撤回：commit 粒度回滚

```
每条消息执行完成后:
  git add -A && git commit -m "catstudy [msgId]"
  execution_logs 记录 commit_hash + packages_installed

撤回（已完成消息）:
  git reset --hard HEAD~1 + 精确 npm uninstall diff 出的新包

撤回（执行中消息）:
  retractionRequests.set(msgId, true)
  → runAgentReply 循环检测 → 提前退出
  → git checkout -- . + git clean -fd（只清未追踪文件，不碰 .gitignore）
```

git clean -fd 不删除 .gitignore 中的文件（node_modules、.env 等），只删"既没追踪也没忽略"的新建文件。

### @mention 状态反馈：每消息 Agent 状态追踪

用户 @ Agent 后，消息下面实时显示每个被 @ Agent 的当前状态（已收到→思考中→回复中→完成）。这是用户判断"调用是否成功"的唯一依据——之前只有全局 Agent 状态在右侧面板，看不出是哪条消息触发了哪个 Agent。

## 3. Tradeoff — 放弃了什么方案

| 放弃 | 原因 |
|------|------|
| Docker 沙箱隔离 Agent 执行 | Windows 上安装障碍大（WSL2 + Docker Desktop），个人工具过度设计。Clowder 也不做 OS 沙箱 |
| 在 dispatch 层硬拦截 npm/pip install（正则扫描 Bash 命令） | Claude Code CLI 权限判断是内部黑盒，`-p` 模式没有 stdout/stdin 交互通道。硬拦截需要绕过 CLI 直接调 API + 自建工具执行层，代价过大 |
| 撤回时逐消息 patch 回滚（git revert 或 git apply -R） | 串行执行下后续 Agent 改动基于前序 Agent 的文件，patch 容易冲突。`git reset --hard HEAD~1` + git clean 更可靠 |
| Web UI 弹窗审批每个工具调用 | 用户明确不希望被打断。改为 Agent 间自动审批 + 撤回兜底——跑偏了就撤回，不影响流畅性 |

## 4. Open Questions — 不确定的点

- **撤回时同文件跨消息修改**：虽然限制了"只能撤回最新一条"，但如果用户在撤回后又发了新消息，新消息基于撤回后的文件状态。当前前端限制了只有最新消息显示撤回按钮，但如果用户打开两个 tab，可能绕过。后端校验了 `ORDER BY created_at DESC LIMIT 1`，理论上安全，但两个 tab 同时点撤回的竞态未处理
- **Claude Code 子进程 kill 时机**：撤回通过 `retractionRequests.set(msgId, true)` 标记，runAgentReply 循环中检查。但子进程位于 adapter 的 `chatStream` 内部，我们无法直接 kill——只能等它自然输出下一个 chunk 时检测到标记后退出。如果 Claude Code 正在长时间思考（无 token 输出），撤回延迟可能达到数秒
- **commit hash 回写的时机问题**：executeAgentsSerial 在 depth===0 时做 git commit 并回写 commit_hash。但如果 executeAgentsSerial 调用链中存在 agent 执行失败（被 catch 跳过），commit 仍然会执行——此时 commit 包含了部分 Agent 的改动。撤回时 `reset --hard HEAD~1` 会把这部分也回滚——这是正确的，因为失败 Agent 可能在执行中间改了文件
- **广播机制的实际使用**：广播模式逻辑完整，但用户侧缺乏"广播模式下 Agent 看到了什么"的可视化。当前需通过前端通知知道广播模式变更，但无法直观感受广播和非广播模式下 Agent 收到的上下文差异

## 5. Next Action — 希望做什么

- ✅ ~~前端启动体验优化~~（完成：健康检查轮询 + waitingForServer 状态）
- ✅ ~~Claude 适配器 bypassPermissions~~（完成：对齐 Clowder）
- ✅ ~~开发铁律 + 审查铁律 prompt 注入~~（完成：DEVELOPMENT_RULE + REVIEW_RULE）
- ✅ ~~消息撤回 + Agent 状态反馈~~（完成：MESSAGE_RETRACT + MESSAGE_AGENT_STATUS）
- 端到端验证：启动 dev → 发送开发任务 → 观察 Agent 状态指示器 → 点撤回 → 确认文件还原 + 包卸载 + 消息移除
- 在 ChatPanel 中增加"上下文预览"——展示当前广播模式下 Agent 能看到的上下文内容，让用户理解广播的实际效果
- 测试多 Agent review 循环的完整链路（店长写代码 → @吐槽猫 review → 吐槽猫回复 → @店长继续）
- 子进程直接 kill 优化：在 adapter 中暴露 abort controller，撤回时立即终止而非等下一个 chunk
