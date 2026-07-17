# CatStudy Agent 执行锁 — 防止 tsx watch 中断 Agent

## 1. What — 具体改动

| 文件 | 改动 |
|------|------|
| `.gitignore` | 新增 `.agent-busy` 忽略规则 |
| `packages/server/src/index.ts` | 启动时清理残留的 `.agent-busy` 锁文件（加在 stuck execution_logs 修复逻辑之后） |
| `packages/server/src/connectors/socketio.ts` | `executeAgentsSerial`：第一个 Claude agent 执行前 `acquireLock()`，`depth===0` 的 `gitCommit` 后 `releaseLock()`（含 dirty workspace 检查 + reset）；新增 `acquireLock`/`releaseLock` 辅助函数 |
| `scripts/dev.js` | 重构 — `tsx watch` 替换为 `tsx`（无 watch）+ `fs.watch` 自定义文件监听 + 锁文件感知的推迟重启轮询 |

## 2. Why — 为什么这样做

### 2.1 问题链

从日志分析确认了两次连续中断：

```
02:00:24  用户 @店长 → 店长开始执行（Claude CLI 启动，supervisorPid=15240）
02:00:25  ~ 02:03:54  店长编辑 packages/server/src/ 下的文件
02:03:55  tsx watch 检测到 .ts 变更 → 立即杀进程重启 → 店长被杀 (server_restart)
02:36:35  用户再次 @店长
02:40:37  再次被 tsx watch 重启杀死
02:43:47  第三次尝试 → 27 秒快速完成 → 成功
```

根因：`scripts/dev.js` 使用 `tsx watch` 运行 server。Claude Code CLI agent 编辑 `packages/server/src/` 下的 `.ts` 文件时，`tsx watch` 检测到变更立即重启，杀死正在执行的 agent。

### 2.2 为什么锁文件方案是正确的

`cli-utils.ts` 已有的 `getWorkspaceDir()` 试图通过限制 Claude CLI 的 `cwd` 来隔离文件操作，但它只能拦截相对路径——Claude Code 的 Edit 工具传递的是绝对路径，所以 `cwd` 限制形同虚设。锁文件方案不依赖 agent 使用什么路径，从外部"按住"文件监听器。

```
Agent 执行期间        Agent 完成后
─────────────────     ─────────────────
.agent-busy 存在      .agent-busy 不存在
fs.watch 检测变更     fs.watch 检测变更
  → 检查锁 → 存在        → 检查锁 → 不存在
  → 推迟重启 ⏸️          → 立即重启 ✅
  → 每秒轮询
```

### 2.3 锁的获取/释放放在同一层

`acquireLock()` 和 `releaseLock()` 都在 `executeAgentsSerial` 内：

- **获取**：`for` 循环中，遇到第一个 `provider === 'claude'` 的 agent 时获取。非 Claude agent（DeepSeek/OpenAI HTTP API）不编辑文件，不需要锁。
- **释放**：`depth === 0` 的 `finally` 块中，`gitCommit` 之后。无论执行成功或失败，锁都会释放。失败路径会先 `git checkout -- . && git clean -fd` 清理脏文件。

```
executeAgentsSerial(depth=0)
  for each agent:
    if claude && !lockAcquired → acquireLock()
    try:
      runAgentReply()        ← Claude CLI 编辑文件
      completeExecution()
      agent-to-agent dispatch → executeAgentsSerial(depth=1)
    catch → continue
  // depth === 0 only:
  try:
    gitCommit()
  finally:
    if dirty → git reset + clean
    releaseLock()
```

### 2.4 为什么用 fs.watch 而不是 chokidar

零依赖。`fs.watch` 在 Windows 上 `recursive: true` 是原生支持的（`ReadDirectoryChangesW`），这个场景下只需要"有变更发生了"的信号，不需要精确文件名。如果后续发现 Windows 上丢事件严重，可切到 chokidar。

## 3. Tradeoff — 放弃了什么方案

| 放弃 | 原因 |
|------|------|
| 只改 Claude CLI 的 `cwd` 到 `workspace/` | Claude Code 的 Edit 工具传绝对路径，`cwd` 限制只能拦截相对路径，防护不完整 |
| chokidar 文件监听 | 不想引入新依赖，`fs.watch` 在 Windows 上 `recursive: true` 对此场景足够 |
| 锁的获取在 `claude.ts`、释放在 `socketio.ts`（不对称设计） | 获取和释放不在同一层，`claude.ts` 的 `on('close')` 在 `gitCommit` 之前触发，时序错误 |
| 仅在错误路径清理脏文件 | `gitCommit` 使用 `git add -A`，成功路径提交后工作区应为干净状态，无条件检查是安全的无操作 |
| 引用计数（多 Agent 并发支持） | 当前同一 traceId 下是串行 FIFO，不同 traceId 的并发不存在。标注为 TODO 未来扩展 |

## 4. Open Questions — 不确定的点

- **Windows `fs.watch` 可靠性**：`fs.watch` 在 Windows 上使用 `ReadDirectoryChangesW`，极少数情况下可能丢事件或 `filename` 为 `null`。当前场景只需"有变更"信号，不要求精确文件名，但长期观察是否需要切 chokidar。
- **Agent 在 `workspace/` 下生成文件后依赖它们**：`workspace/` 在 `.gitignore` 中，git commit 不会提交，但文件保留在磁盘上。如果 Agent 跨重启依赖这些文件，当前方案不会丢。如果未来 Agent 需要"提交 workspace 产物到 git"，需要额外处理。
- **长时间执行的 Agent + 连续文件变更**：如果 Agent 编辑文件后继续执行（不立即完成），锁一直存在，server 不会重启。用户在此期间手动改代码也不会触发重启——这是预期行为还是 bug？当前倾向于是预期行为（Agent 执行期间不该重启），但如果用户期望"我手动改代码应该立刻生效"，则需要更细粒度的判断（区分 Agent 编辑 vs 用户编辑）。

## 5. Next Action — 希望做什么

- [ ] 在实际使用中观察：启动 `pnpm dev`，发一条 @店长 让它改代码，确认 Agent 不会被中断
- [ ] 观察 Windows 上 `fs.watch` 是否稳定触发重启（至少 10 次 Agent 执行）
- [ ] 如果 `fs.watch` 不可靠，替换为 chokidar（`npm install chokidar`，改 `scripts/dev.js` ~10 行）
- [ ] 如果未来支持多 Agent 并发，将锁的布尔值改为引用计数
- [ ] 考虑在部署/CI 场景下跳过锁机制（`dev.js` 仅在开发环境使用，生产环境用 `tsx` 直接运行无需 watch）
