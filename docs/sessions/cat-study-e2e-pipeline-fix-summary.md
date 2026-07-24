# e2e 管道修复 — workspace 隔离 + 真实 commit 触发 + 重启韧性

## 1. What — 具体改动

| 文件                                | 改动                                                                                                                                                                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/server/src/llm/claude.ts` | ClaudeAdapter 的 `spawnSupervised` 调用增加 `cwd: getWorkspaceDir()`，将 Claude Code CLI 文件编辑限制在 `workspace/` 目录                                                                                                                |
| `scripts/dev.js`                    | 新增 `restartWithRetry()` 函数（指数退避 2s/4s/8s × 3 次重试 + 失败后每 30s 持续尝试）；三处重启调用点统一替换                                                                                                                           |
| `scripts/handoff-pipeline.e2e.mjs`  | 完全重写：从手写假 handoff POST 改为 `git commit → post-commit hook → handoff-gen.mjs` 真实链路；新增 Claude Code CLI 子进程检测（`CATSTUDY_SUPERVISOR_PARENT_PID`）；吐槽猫检测增加店长消息 ID 排除；测试完成后 `git reset --soft` 清理 |

## 2. Why — 为什么这样做

### 2.1 问题诊断链

用户报告：在 "debug" 会话中，agent 尝试跑 `node scripts/handoff-pipeline.e2e.mjs` 就会导致服务器关闭。

日志分析找到三段因果链：

```
原因层          根因                                后果
─────────────────────────────────────────────────────────────
P0  workspace   ClaudeAdapter 未传 cwd → CLI 编辑         dev.js 检测文件变更
                packages/server/src/*.ts
                                  ↓
P1  重启韧性    dev.js 重启失败后静默放弃                  server 彻底死掉 16.5 分钟
                waitForServer 无重试机制
                                  ↓
P2  循环调度    e2e 测试 POST 消息 → dispatch 同一 Agent   死锁 + dev.js 重启级联
                → Agent 忙 → 测试等 Agent → Agent 等测试
```

关键日志证据：

```
09:59:32  Claude CLI #1 启动 (agent 处理 debug 会话消息)
09:59:58  REST message received (e2e 测试 POST handoff)
09:59:58  agent queued (店长正忙)
09:59:59  Claude CLI #2 启动 (处理队列中的 handoff)
────────── 16.5 分钟无日志 ──────────
10:16:25  database ready (stuck execution_logs: 1)  ← server 重启
```

无 `"shutting down..."` 日志 = server 是被 `dev.js` 的 `taskkill /F /T` 强杀的，非优雅关闭。

### 2.2 P0：为什么 `getWorkspaceDir()` 是正确方案

`pi.ts` 正确地使用了 `getWorkspaceDir()` 作为 pi agent 的 cwd，但 `claude.ts` 漏掉了。传给 `spawnSupervised` 的 `cwd` 参数直接映射到 Node.js `child_process.spawn` 的 cwd，Claude Code CLI 的所有文件操作（读 CLAUDE.md、写临时文件、编辑源码）都会限定在此目录。

```
修复前:  Claude CLI cwd = process.cwd() = 项目根 → 可编辑 packages/server/src/
修复后:  Claude CLI cwd = workspace/              → 只编辑 workspace/
```

这不影响 Claude Code CLI 通过 git 操作项目文件（CLI 自动检测 `.git` 目录向上遍历），只限制文件系统写入路径。

### 2.3 P1：为什么指数退避 + 无限兜底

`dev.js` 之前的三个重启点各自独立调用 `startServer() + waitForServer()`。Windows 上 `taskkill /F /T` 杀进程后端口释放有延迟，一次性 `waitForServer` 几乎必定失败。提取 `restartWithRetry()` 后：

```ascii
restartWithRetry("原因")
  │
  ├─ 第 1 次 → startServer + waitForServer
  │   └─ 失败 → killTree 确保旧进程死透
  │
  ├─ 第 2 次 (等 2s) → startServer + waitForServer
  │   └─ 失败
  │
  ├─ 第 3 次 (等 4s) → startServer + waitForServer
  │   └─ 失败
  │
  ├─ 第 4 次 (等 8s) → startServer + waitForServer
  │   └─ 失败
  │
  └─ 进入无限兜底模式: 每 30s 重试，直到成功
       └─ console.error 告知开发者，不静默放弃
```

### 2.4 P2：为什么 e2e 测试必须走真实 post-commit hook

旧版 e2e 测试直接 POST 手写的假 handoff 消息，两个问题：

1. **不代表实际情况**：手写消息的格式、内容、checklist 都与 `handoff-gen.mjs` 实际生成的不同
2. **绕过触发过滤**：`handoff-gen.mjs` 会跳过 `catstudy [...]` 格式的 auto-commit，手写 POST 没有这个保护

新版流程：

```ascii
e2e 测试
  │
  ├─ Step 3: 创建 scripts/.e2e-test-trigger.txt
  │         git add + commit "test: e2e 管道触发测试"
  │           │
  │           └─ .husky/post-commit
  │                └─ node scripts/handoff-gen.mjs
  │                     ├─ git diff HEAD~1..HEAD (真实 diff 分析)
  │                     ├─ 生成交接文档 (What/Why/Tradeoff/OQ/Checklist)
  │                     └─ POST /api/messages → cat-study
  │
  ├─ Step 4-5: 轮询等待店长补填 → 吐槽猫审查
  │
  └─ Step 6: git reset --soft HEAD~1 清理测试 commit
```

### 2.5 Claude Code CLI 子进程检测

e2e 测试新增 `isRunningInsideClaudeCode()` 检测。最初用 `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` 判断——但这在终端直接运行也会命中（Claude Code 自身也有这些变量）。改为用 `CATSTUDY_SUPERVISOR_PARENT_PID`——这是 CatStudy 的 `spawnSupervised()` 独有的环境变量，不会出现在其他 Claude Code 会话中。

## 3. Tradeoff — 放弃了什么方案

| 放弃                                                     | 原因                                                                                                                                      |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 检测用 `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` 环境变量 | Claude Code 桌面端自身也设置这些变量，终端直接跑 e2e 测试会误判跳过。`CATSTUDY_SUPERVISOR_PARENT_PID` 是 CatStudy 专有标记                |
| 在 e2e 测试中 mock post-commit 行为而非真触发            | 徒增维护成本，测不出真实 `handoff-gen.mjs` 的 diff 解析、checklist 生成、catstudy 快照过滤等关键逻辑                                      |
| `dev.js` 用 chokidar 替代 `fs.watch`                     | 当前场景只需"有变更"信号，不要求精确文件名。`fs.watch` 在 Windows 上原生支持 `recursive: true`（ReadDirectoryChangesW），无需引入额外依赖 |
| 给 openai.ts 也加 `getWorkspaceDir()`                    | OpenAI Codex CLI 目前非主力适配器，改动范围控制在已验证的主路径。后续可统一                                                               |

## 4. Open Questions — 不确定的点

- **workspace 目录内容管理**：Claude Code CLI 的 cwd 现在限定在 `workspace/`，但该目录可能随时间累积大量临时文件。目前没有自动清理机制——不确定是否需要在每次启动或 agent 完成后清理。
- **post-commit hook 的无限反馈环保护**：`handoff-gen.mjs` 已有 `catstudy [...]` commit 过滤来防止 auto-commit 触发新一轮 handoff。但如果 agent 生成的回复中包含类似格式的 commit message，可能产生边界情况。当前靠正则 `/^catstudy\s+\[[\w-]+\]/` 匹配行首，较为严格，但未测试过故意构造的绕过场景。
- **dev.js 无限重试的 terminal 噪声**：`restartWithRetry` 失败后每 30s 打印一次日志。如果 server 因配置错误（如端口被占用）永远无法启动，会一直刷屏。可能需要在连续失败 N 次后降频或暂停。

## 5. Next Action — 希望做什么

- [ ] 手动验证 workspace 隔离：在 debug 会话中触发 agent，确认其文件编辑只出现在 `workspace/` 目录下
- [ ] 给 `openai.ts` 也加 `cwd: getWorkspaceDir()`（Codex CLI 适配器，与 claude.ts 同模式）
- [ ] 给 `workspace/` 目录加 `.gitignore`，防止 agent 残留文件被误提交
- [ ] 在 dev.js `restartWithRetry` 的无限兜底模式中增加降频逻辑（连续失败 5 次后从 30s 降到 5min）
- [ ] 考虑让 e2e 测试支持 `--keep-session` 参数（复用指定会话而非自动查找），方便在固定会话中反复测试
