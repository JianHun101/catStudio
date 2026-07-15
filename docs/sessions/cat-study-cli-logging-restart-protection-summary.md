# CatStudy CLI 子进程日志增强 + 重启防护

## 1. What — 具体改动

| 文件 | 改动 |
|------|------|
| `packages/server/src/logger.ts` | （未改）现有 JSON Lines 日志器，双路输出 stdout + 文件，`fs.appendFileSync` 即时落盘 |
| `packages/server/src/llm/cli-utils.ts` | NDJSON 解析器新增 tool 事件日志、parse 失败 debug 日志、流结束汇总；`attachExitError` 新增正常退出日志 + 全部 stderr 写 debug；新增 `spawnSupervised()` 函数 |
| `packages/server/src/llm/cli-supervisor.mjs` | **新建** — CLI 监督进程，每 1s 检测父进程存活，父进程死则杀 CLI 子进程防止孤儿 |
| `packages/server/src/llm/claude.ts` | `spawn()` → `spawnSupervised()`，用 Supervisor 包装 Claude CLI 子进程 |
| `packages/server/src/llm/openai.ts` | 保留直接 `spawn()`（Codex 需 stdin 传 prompt），导入注释说明原因 |
| `packages/server/src/llm/deepseek.ts` | 新增 `createLogger('deepseek')`，记录 API 请求参数、响应状态、错误详情、流结束汇总 |
| `packages/server/src/llm/git-utils.ts` | `gitCommit()` 记录 `git diff --stat`；`gitCleanWorkingTree()` 记录被清理文件；`gitResetHard()` 记录被回退 commit |
| `packages/server/src/connectors/socketio.ts` | `agent reply done` 后新增 `log.debug('agent reply content')` 含前 1000 字符预览；abort/retract 时记录 `partialLen` |
| `packages/server/src/index.ts` | 启动时执行 StartupReconciler：将 `status='running'` 的旧 execution_logs 标记为 `failed (server_restart)` |
| `packages/server/src/llm/cli-utils.logging.test.ts` | **新建** — 16 个测试用例：NDJSON 解析、tool 事件、parse 容错、`attachExitError` close/stderr 事件、`messagesToPrompt` |
| `scripts/dev.js` | `tsx` → `tsx watch`，TypeScript 源文件变更时自动重启 server |
| `scripts/stop.js` | `taskkill /F /PID` → `taskkill /F /T /PID`，杀整棵进程树而非仅父进程 |

## 2. Why — 为什么这样做

### 2.1 日志设计：参照 clowder-ai 但不照搬

clowder-ai 使用 Pino + OpenTelemetry 的全链路追踪体系。CatStudy 规模小得多（3 cats vs 170+ features），选择在现有 JSON Lines 日志器上做**零依赖增强**：每条日志 `ts + level + module + msg + meta`，`fs.appendFileSync` 同步写入即时落盘——进程崩溃（SIGKILL 除外）不会丢日志。

增强覆盖了 CLI 子进程的**全生命周期**：

```
spawn → "启动 Claude Code CLI" + "claude spawn details" (bin, promptLen, promptPreview)
  ├─ NDJSON 流: "claude tool event" (tool_use / tool_result — 文件修改、测试执行等)
  ├─ NDJSON 流: "claude NDJSON parse skip" (畸形行 — 不静默丢弃)
  ├─ stderr:   "claude stderr" (debug 级全量 + error 级非 Warning/info)
  └─ stream 结束: "claude stream ended" (totalChunks, totalChars)
close → "claude 正常退出" (exitCode=0) 或 "claude 退出" (exitCode≠0, signal)
agent reply → "agent reply done" + "agent reply content" (前 1000 字符)
git → "auto commit" (changedFiles: diff --stat 具体文件列表)
```

### 2.2 孤儿进程防护：CLI Supervisor

从日志分析确认了核心问题链：

```
用户 pnpm dev (想重启) → scripts/stop.js
  → taskkill /F /PID <server> (无 /T!)
    → server 进程死，Claude CLI 变孤儿
    → 端口可能未释放 (EADDRINUSE)
    → 新 server 启动失败或重复尝试
```

clowder-ai 的解决方案（参照 ADR-039 "passive frozen"）有三层，CatStudy 取其最轻量的组合：

```
┌─ dev.js ─────────────────────────────────────────┐
│  tsx watch → 文件变更自动重启（非 agent 主动触发） │
│  Ctrl+C → killAll() taskkill /F /T → 结束         │
└───────────────────────────────────────────────────┘
         │               ▲ (重启时 kill)
         ▼               │
┌─ Server (pid=1000) ──────────────────────────────┐
│  graceful shutdown → "shutting down..."           │
│  启动时 reconciler → 修复 stuck execution_logs     │
└──────────┬───────────────────────────────────────┘
           │ spawnSupervised()
           ▼
┌─ cli-supervisor.mjs (pid=1001) ──────────────────┐
│  setInterval 1s: process.kill(1000, 0)            │
│  父进程死 → SIGTERM → 3s → SIGKILL CLI            │
│  日志: "[supervisor] 父进程已退出，终止子进程"       │
└──────────┬───────────────────────────────────────┘
           │ spawn()
           ▼
┌─ Claude CLI (pid=1002) ─────────────────────────┐
│  正常执行: stdout/stderr 透传给 server             │
│  父进程被杀: supervisor 3s 内清理                  │
└──────────────────────────────────────────────────┘
```

### 2.3 为什么用 tsx watch 而不是 agent 主动触发重启

之前考虑过"agent 完成后 scheduleRestart() → process.exit(0)"的方案，但 clowder-ai 明确不做 agent 触发重启。原因：

1. **时序复杂**：agent 写入文件 → tsx watch 已经会检测到 → 避免双重重启
2. **多消息并发**：一个 session 可能有多轮 A2A 链交错执行，判断"全部完成"需要额外状态机
3. **agent 不应感知运维**：agent 只管写代码，重启是基础设施的事

`tsx watch` 将重启逻辑完全解耦到进程管理层，agent 和 server 都不需要知道自己会被重启。

### 2.4 启动时修复 stuck execution_logs

参照 clowder-ai `StartupReconciler`：server 启动时扫描 `execution_logs` 中 `status='running'` 的记录，标记为 `failed`，`error_message='server_restart'`。这样即使 server 被 `taskkill /F /T` 强杀（无 graceful shutdown），下次启动时也能清理脏状态。

## 3. Tradeoff — 放弃了什么方案

| 放弃 | 原因 |
|------|------|
| Agent 完成后主动触发重启（`scheduleRestart() → process.exit()`） | 多消息并发时难以判断"全部完成"；agent 不应感知运维；tsx watch 已覆盖文件变更场景 |
| 给 Codex 适配器也用 `spawnSupervised()` | Codex 通过 stdin 传 prompt，Supervisor 当前不支持 stdin 转发。额外复杂度不值得——主力适配器是 Claude |
| 用 Pino / OpenTelemetry 替换现有日志器 | CatStudy 3 cats 规模，JSON Lines + `fs.appendFileSync` 够用。迁移成本高，收益不明显 |
| clowder-ai 的 ProcessLivenessProbe（CPU 探针） | 20min CLI idle timeout 按输出重置已能区分"忙但活着"和"真死锁"。CPU 探针对 3 cats 过度设计 |
| clowder-ai 的 ApiInstanceLease（Redis 分布式租约） | CatStudy 本地单实例运行，无多实例冲突风险 |
| `dev.js` 用 watchdog 模式（server 退出后自动重启）而不是 tsx watch | tsx watch 更精确——只在源文件变更时重启，crash 不会无限重启循环 |

## 4. Open Questions — 不确定的点

- **tsx watch 在 agent 写文件期间触发重启**：agent（Claude CLI）在执行期间可能逐步写入多个文件。tsx watch 检测到第一个文件变更就会重启，此时 agent 可能还在写其他文件。Supervisor 会清理旧 agent 进程，但新 server 启动时 agent 的部分工作丢失。当前依赖 agent 的 git commit 在全部写入完成后才触发，但 tsx watch 的重启比 git commit 更早发生。可能需要给 tsx watch 加 ignore 规则或 debounce。
- **Supervisor 的 CATSTUDY_SUPERVISOR_PARENT_PID 竞态**：如果 server 进程 PID 被操作系统回收并分配给新进程，Supervisor 会误判父进程存活。这种情况在 Windows 上概率极低（PID 回收周期长），但在高频重启场景下需注意。
- **Codex 适配器缺少 Supervisor 保护**：如果用户切换到 Codex 适配器，孤儿进程保护不生效。当有实际需要时再补（给 `spawnSupervised` 加 stdin 转发）。
- **`cli-supervisor.mjs` 在编译后的路径**：当前通过 `import.meta.url` 动态解析。tsx 编译为 JS 后路径不变（.mjs 不被编译），但如果未来改用 tsx 编译输出到 dist/，需要同步调整。

## 5. Next Action — 希望做什么

- [ ] 实际运行一次完整 A2A review 链，观察 tsx watch 重启行为——agent 写文件时是否被打断
- [ ] 如果 tsx watch 重启打断 agent，给 `tsx watch` 加 `--exclude` 规则或增加 debounce 延迟
- [ ] 验证 Supervisor 在 Windows 上对 `taskkill /F /T` 的响应——kill 整棵树时 Supervisor 自身也会被 kill，需要确认子进程清理顺序正确
- [ ] 给 `scripts/stop.js` 的 Unix 分支也加 tree kill（当前 Unix 分支用 `lsof -ti | xargs kill -9`，只杀父进程）
- [ ] 验证启动时 reconciler 正确修复上次测试遗留的 stuck execution_logs
- [x] ✅ ~~NDJSON 解析器日志增强~~ — tool 事件、parse 失败、流汇总
- [x] ✅ ~~CLI 适配器日志增强~~ — spawn 详情、prompt 预览、退出状态
- [x] ✅ ~~git-utils 文件变更日志~~ — diff --stat、cleaned files、reverted commit
- [x] ✅ ~~agent reply 内容日志~~ — 前 1000 字符预览
- [x] ✅ ~~CLI Supervisor 孤儿进程防护~~ — cli-supervisor.mjs + spawnSupervised()
- [x] ✅ ~~tsx watch 文件变更自动重启~~ — scripts/dev.js
- [x] ✅ ~~stop.js /T 杀进程树~~ — scripts/stop.js
- [x] ✅ ~~启动时修复 stuck execution_logs~~ — index.ts StartupReconciler
