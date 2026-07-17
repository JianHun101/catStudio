# 事后分析：为什么在"讨论"会话中，吐槽猫让店长实施，店长没反应了

> 修订版 v3 — 根据吐槽猫复核意见：workspace 路径修正、P1 伪代码完善、新增关闭原因日志建议

## 1. 事件时间线（Session `0465cc4c`，Trace `3be9c860`）

| UTC 时间 | 北京 | Depth | 谁 | 动作 |
|----------|------|-------|-----|------|
| `08:09:58` | 16:09 | 0 | 用户 | @店长：如何让 agent 按需加载 skill？ |
| `08:14:13` | 16:14 | 0→1 | **店长** | 分析现状 + 提出方案，@吐槽猫 请求 review |
| `08:16:04` | 16:16 | 1→2 | **吐槽猫** | 审查完毕，指出问题，@店长 要求修改 |
| `08:18:59` | 16:18 | 2→3 | **店长** | 修订计划，@吐槽猫 再次请求 review |
| `08:20:39` | 16:20 | 3→4 | **吐槽猫** | 复核完成，@店长 告知结果 |
| `08:20:40` | 16:20 | 4 | **店长** | 🔴 启动 Claude Code CLI 开始执行 |
| `08:22-08:23` | 16:22-23 | — | **店长** | 📝 写入 `packages/server/src/skills/*`（6 个文件） |
| `08:24:01` | 16:24 | — | **店长** | 📝 修改 `packages/server/src/seed-data.ts` |
| `08:24:04` | 16:24 | — | **服务器** | 🔴 进程重启（数据库就绪） |

**文件时间戳证据**（北京时间，ls -la）：

```
packages/server/src/skills/dependency-request.md  → 2026-07-16 16:22
packages/server/src/skills/handoff.md              → 2026-07-16 16:22
packages/server/src/skills/manifest.json           → 2026-07-16 16:22
packages/server/src/skills/code-review.md          → 2026-07-16 16:23
packages/server/src/skills/dependency-review.md    → 2026-07-16 16:23
packages/server/src/skills/skill-loader.ts         → 2026-07-16 16:23
packages/server/src/seed-data.ts                   → 2026-07-16 16:24:01
```

**日志 gap**：`08:20:40.254`（claude supervisor 启动）到 `08:24:04.030`（database ready）之间，**零条日志**。无 crash 信息、无错误栈。

## 2. 根因

### 直接原因

店长收到吐槽猫的 review 结果后启动了 Claude Code CLI（`08:20:40`），在执行期间（约 3 分 24 秒后）**服务器进程被 tsx watch 杀死并重启**。`StartupReconciler`（`index.ts:33-51`）将那条 `running` 状态的 execution_log 标记为 `failed: server_restart`，但**没有重新触发 dispatch**——店长永远停在了"已启动但未回复"的状态。

### 根本原因（证据已补全）

**Agent 在执行期间将文件写入 `packages/server/src/` → tsx watch 检测到文件变更 → 杀死旧进程 → 启动新进程。**

证据链：

```
08:20:40  店长启动 Claude Code CLI
08:22:xx  店长创建 packages/server/src/skills/*.md, manifest.json  ← 写入 src/
08:23:xx  店长创建 packages/server/src/skills/skill-loader.ts       ← 写入 src/
08:24:01  店长修改 packages/server/src/seed-data.ts                  ← 写入 src/（最后触发点）
08:24:04  Server restart (database ready)                           ← 3 秒后重启
```

`seed-data.ts` 的修改时间（`08:24:01`）与服务器重启时间（`08:24:04`）仅差 **3 秒**——这正是 tsx watch 检测文件变更 → kill 旧进程 → 启动新进程的典型时间窗口。

进一步确认：
- 日志 gap 中**没有任何错误/异常日志**——如果是 OOM 或未捕获异常导致的崩溃，应该有错误输出
- `tsx watch` 的 stdout 通过 `stdio: 'inherit'` 输出到控制台而非日志文件，所以 "RESTART" 提示不会出现在 `cat-study.log` 中，但这不代表它没发生
- Claude Code CLI 没有 `cwd` 限制（`cli-utils.ts:316-347`），Agent 在项目根目录执行，可以自由写入 `src/`

### 为什么这个 bug 影响所有 Agent，不是店长专属

任何在 review 链中被 @ 的 Agent 都可能因为同一个原因丢失。如果吐槽猫在店长之前执行且写入了 src/，吐槽猫同样会被 tsx watch 杀死。这是**对称的结构性问题**，不限于特定 Agent。

## 3. 修复方案（修订后）

| 优先级 | 方向 | 说明 |
|--------|------|------|
| **P0** | **限制 Agent 写入范围在 `src/` 之外** | 将 Agent 的工作区（skills、data、生成的代码文件等）限制在 `packages/server/src/` **以外**的独立目录。对 Claude Code CLI 传递 `cwd` 到 workspace 目录，或在系统 prompt 中明确禁止写入 src/ |
| **P0** | **启动时重放未完成的 dispatch** | `StartupReconciler` 不仅要标记 `running → failed`，还应扫描 `status='failed'` 且 `error_message='server_restart'` 的 execution_log 对应的消息，检查是否仍有未处理的 @mention，重新触发 dispatch |
| **P1** | **重放前去重** | 重放前检查文件系统状态（`git status --porcelain`），如果 dirty → 说明 Agent 已部分执行，先 `git checkout -- .` 清理再重放；或发系统消息 "上次执行被中断，是否重试？" 让用户决定 |
| ~~P0~~ | ~~排除 src/ 不被 tsx watch 监控~~ | **已放弃**（方向性错误）——tsx watch 的设计目的就是监控人类代码变更，排除它会损害开发体验。正确做法是让 Agent 不写不该写的地方 |
| ~~P1~~ | ~~Agent 执行期间锁定 tsx watch~~ | **已降级为"暂不实施"**——实现成本高（需要 dev.js 和 server 之间的耦合），且只要 P0（Agent 不写 src/）做对，这个措施就不需要。观察 P0 修复效果后再决定 |

### P0 #1 详细设计：限制 Agent 写入范围

```
当前问题：
  Claude Code CLI 在项目根目录执行 → Agent 可以写入 packages/server/src/
  → tsx watch 检测到变更 → 重启 → 杀死正在执行的 Agent

修复方向 A（推荐）：传递 cwd 到独立 workspace
  - 在 spawnSupervised() 中增加 cwd 选项
  - 在项目根级创建 `workspace/` 目录（加入 .gitignore）——注意：**不放在 `packages/server/` 下**，避免将来换监控工具（nodemon、chokidar 等）时再次踩坑
  - Claude Code CLI 的 cwd 设为 workspace 目录
  - 需要修改 src/ 下文件时，Agent 只能通过生成 patch 文件间接修改

  目录结构：
  ```
  catStudy/
    workspace/              ← Agent 工作区（.gitignore）
      changes/              ← Agent 对 src/ 的修改建议（patch 文件）
      skills/               ← Agent 创建的 skills 文件
  ```

修复方向 B（辅助）：在系统 prompt 中明确禁止
  - 在 Agent 的 system prompt 中追加规则：
    "禁止直接写入 packages/server/src/ 目录。如需修改源码，将修改说明写入
     workspace/changes/ 目录下（patch 格式），由开发者手动应用。"
  - 成本低，但依赖 LLM 遵循指令（不可靠）
```

### P0 #2 详细设计：启动时重放未完成的 dispatch

```typescript
// index.ts StartupReconciler 扩展（伪代码）
async function reconcileStuckExecutions(db) {
  // 1. 标记 running → failed（现有逻辑）
  const stuckLogs = db.prepare(
    "SELECT id, agent_id, trace_id FROM execution_logs WHERE status = 'running'"
  ).all()

  if (stuckLogs.length > 0) {
    db.prepare(`UPDATE execution_logs SET status = 'failed',
      ended_at = datetime('now'), error_message = 'server_restart'
      WHERE status = 'running'`).run()
  }

  // 2. 新增：扫描需要重放的 dispatch
  //    找到 failed 的 execution 对应的 trigger message，
  //    检查该 message 中是否仍有未处理的 @mention
  const toReplay = []
  for (const log of stuckLogs) {
    // 找到触发这条 execution 的消息（通过 trace_id 关联）
    const triggerMsg = findTriggerMessage(db, log.trace_id, log.agent_id)
    if (!triggerMsg) continue

    // 检查该 Agent 是否已经回复了
    const hasReply = db.prepare(
      "SELECT 1 FROM messages WHERE session_id = ? AND agent_id = ? AND created_at > ?"
    ).get(triggerMsg.sessionId, log.agent_id, triggerMsg.createdAt)

    if (!hasReply) {
      toReplay.push({ sessionId: triggerMsg.sessionId, agentId: log.agent_id, triggerMsg })
    }
  }

  // 3. 重放（通过 io 实例 dispatch）
  if (toReplay.length > 0) {
    log.info('重放未完成的 dispatch', { count: toReplay.length })
    for (const item of toReplay) {
      await dispatchForAgent(io, item.sessionId, item.agentId, item.triggerMsg)
    }
  }
}
```

### P1 详细设计：重放前去重

```typescript
// 在重放前检查工作区状态
// WORKSPACE_ROOT = 项目根目录（package.json 所在目录），即主 git 仓库的根
import { execSync } from 'child_process'

const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..') // packages/server → 项目根

const status = execSync('git status --porcelain', { cwd: WORKSPACE_ROOT }).toString()

if (status.trim()) {
  // 工作区 dirty — Agent 已经做了部分工作
  // 选项 A：自动清理重来
  execSync('git checkout -- .', { cwd: WORKSPACE_ROOT })  // 清理已追踪文件的修改
  execSync('git clean -fd', { cwd: WORKSPACE_ROOT })       // 清理未追踪的文件和目录（Agent 新建的 skills/*.md 等）

  // 选项 B（推荐为默认）：让用户决定
  // io.to(`session:${sessionId}`).emit(Events.NEW_MESSAGE, {
  //   role: 'system',
  //   content: `上次执行被中断（工作区有未提交的修改），是否重试？`
  // })
}
```

> **选项 B 推荐为默认**，理由：
> - Agent 可能已经写了 5 个文件、花了 3 分钟，自动丢弃用户体验很差
> - 在 Web UI 中发系统消息询问的边际成本很低（一条 `NEW_MESSAGE` emit）
> - 自动清理还有风险：Agent 写的可能是**正确的代码**，只是还没来得及 commit
> - 选项 A 可作为可配置选项（如环境变量 `AUTO_RESET_ON_REPLAY=1`）供 CI 等场景使用

## 4. 放弃的方案

| 方案 | 理由 |
|------|------|
| 排除 src/ 不被 tsx watch 监控（原 P0 #1） | 方向性错误。tsx watch 应该监控 src/，问题在于 Agent 不该往 src/ 写 |
| Agent 执行期间锁定 tsx watch（原 P1） | 实现成本高，需要 dev.js ↔ server 耦合。P0 做对后不再需要 |
| 仅修复店长的 system prompt | 治标不治本。bug 是结构性的，所有 Agent 都受影响 |

## 5. Open Questions

1. **workspace 目录 vs Agent 自由度的权衡**：如果把 Claude Code CLI 的 cwd 限制在 workspace 目录，Agent 如何修改 `packages/server/src/` 下的代码（这是它有时被要求做的事）？是否需要一种"提 PR"机制让 Agent 间接修改 src/？
2. **重放的安全边界**：如果重启发生在 Agent 已经写入部分文件但未 commit 时，git checkout 清理是否安全？如果 Agent 写的是非 git 追踪的文件（如 skills/），git checkout 不会清理——是否需要额外的清理逻辑？
3. **tsx watch 的 debounce**：`tsx watch` 是否有 `--debounce` 或类似参数可以设置？如果有，加一个 5-10 秒的 debounce 可以减少 Agent 写多个文件时频繁重启的问题（但这不是根本修复，只是降低概率）
4. **【建议】补充服务器关闭原因日志**：当前服务器关闭时没有记录关闭原因（是 SIGTERM？SIGINT？还是 tsx watch kill？），导致事后无法从日志中区分"被人杀"和"自己崩"。建议在 `gracefulShutdown` 中加一条 `log.info('server shutting down', { signal, pid: process.pid })`。另外可以考虑将 tsx watch 的 stdout pipe 到日志文件（目前是 `stdio: 'inherit'` 到控制台），以便事后确认重启链。

## 6. Reviewer Checklist

- [ ] P0 #1：Agent workspace 隔离方案是否接受推荐方向 A（cwd 到独立 workspace）？有没有更好的方案？
- [ ] P0 #1：workspace 目录结构设计（项目根级 `workspace/`）是否合理？
- [ ] P0 #2：启动重放逻辑——去重策略选 A（自动清理）还是 B（询问用户）？
- [ ] P1：重放前去重的 git checkout 是否安全？边缘情况考虑充分了吗？
- [ ] Open Question 1：Agent 间接修改 src/ 的机制你有更好的想法吗？
- [ ] 通用性确认：修复是否覆盖了所有 Agent（不只是店长）的场景？

@吐槽猫 请 review 修订后的分析报告。
