# CatStudy 孤儿锁自动恢复 — dev.js 进程存活检测

## 1. What — 具体改动

| 文件             | 改动                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `scripts/dev.js` | 新增 `isServerAlive()` 进程存活检测 + `cleanupDeadLock()` 孤儿锁清理；文件变更路径和推迟轮询路径均加入死锁感知，避免无限等待 |

## 2. Why — 为什么这样做

### 2.1 问题链

```
16:51:40  agent busy lock acquired (pid=3156)        ← server 获取锁
16:52:47  店长 reply done ✓
16:54:55  吐槽猫 reply done ✓
16:54:55  店长 reply started (启动 Claude CLI pid=30396, parent=3156)
────── 日志终止，server 进程 3156 消失 ──────
16:55:56  Vite ws proxy: ECONNREFUSED 127.0.0.1:3200  ← server 已死
16:55:56  [dev] Agent 执行中，推迟重启...              ← 锁文件还在，dev 不重启
16:55:58  [dev] Agent 执行中，推迟重启...（重复 × ∞）
```

根因：前一版 dev.js 的重启判断只看 `.agent-busy` 锁文件**是否存在**，不验证持有锁的进程**是否还活着**。server 进程异常退出（kill、OOM、崩溃）时，锁文件变成孤儿，dev.js 的轮询永远等不到释放。

### 2.2 为什么两级检测是对的

```
isServerAlive()
  ├─ A: serverChild.exitCode === null      ← 自己的 spawn 引用，零 I/O
  └─ B: 读锁文件中 PID → process.kill(0)  ← 兜底，防止引用对不上的边界情况
```

**A 为什么优先**：dev.js 是 server 的父进程，`serverChild.exitCode` 在子进程退出时被 Node.js 运行时设为退出码，无需任何系统调用即可判断存活。绝大部分场景下 A 就够了。

**B 为什么保留**：极端情况下 `serverChild` 引用可能对不上——例如 `startServer()` 调用中的 `spawn` 还没成功就被替换了。B 通过锁文件里写的 PID 做最终兜底，成本仅为一次 `readFileSync` + `process.kill(pid, 0)`。

### 2.3 为什么 cleanupDeadLock 放在 startServer 入口而不是调用方

```
方案 A: 各调用方调用前判断         方案 B (选定): 集中到 startServer 入口
─────────────────────────────      ─────────────────────────────────────
if (shouldRestart())               startServer() {
  startServer()           →          cleanupDeadLock()   ← 一次搞定
                                       killTree(oldPid)
                                       spawn(newServer)
                                     }
```

选 B 的理由：

1. **无法误清理**：`startServer()` 只在"已经决定重启"的上下文中被调用。此时旧进程要么已死（孤儿锁），要么即将被杀（`killTree`）——无论哪种，锁都应该被清理。
2. **调用方简单**：只需关注自己的门禁逻辑（"是否该重启？"），不操心锁状态。
3. **冷启动无害**：首次 `startServer()` 时锁文件不存在，`cleanupDeadLock()` 直接 return，无语义开销。

### 2.4 两条重启路径的变化

```
.ts 文件变更 (防抖 500ms)
  ├─ 锁不存在                    → 立即重启（不变）
  ├─ 锁存在 + 进程存活            → 推迟重启（不变）
  └─ 锁存在 + 进程已死 → 孤儿锁  → 强制重启 ← 新增

推迟轮询 (每 1s)
  └─ pendingRestart
       ├─ 锁消失了               → 执行延迟重启（不变）
       └─ 锁还在但进程已死        → 执行延迟重启 ← 新增
```

## 3. Tradeoff — 放弃了什么方案

| 放弃                                                             | 原因                                                                                                                   |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 只在 socketio.ts 端防御（server 启动时检查残留锁并清理）         | 解决了冷启动场景，但热重启场景仍需 dev.js 正确判断；而且 server 进程如果死得彻底（无机会执行清理），这个防御根本跑不到 |
| dev.js 不做 PID 兜底，只用 `serverChild.exitCode`                | `serverChild` 引用在 `spawn` 失败、替换等极端情况下可能对不上，多一次 `process.kill` 的 I/O 成本可忽略                 |
| Node.js `child_process` 的 `'exit'` 事件驱动（不用轮询）         | `'exit'` 事件触发时 `pendingRestart` 可能还是 `false`（没到需要重启的状态），时序耦合复杂；1 秒轮询简单且对 CPU 零负担 |
| 在 `socketio.ts` 的 `releaseLock()` 加 `process.on('exit')` 注册 | Node.js `exit` 事件只对同步的 `process.exit()` 调用有效，对 `kill -9`/OOM/未捕获异常后的进程终止不保证执行             |

## 4. Open Questions — 不确定的点

- **server 异常退出的真正原因**：本次 server 进程 3156 在启动 Claude CLI 子进程后日志直接中断，没有 error/fatal 记录。可能是 OOM（内存不够启动 Claude CLI），也可能是外部 kill。当前修复让 dev.js 能自动恢复，但没有消除 server 退出的根因。如果下次再发生，建议检查 Windows 事件查看器或 `taskkill` 历史。
- **`process.kill(pid, 0)` 在 Windows 上的语义**：Windows 没有 POSIX 信号，Node.js 文档说 `kill(0)` 是"检查进程是否存在"的特殊情况。但 Windows 上信号模拟 `ESRCH` 的可靠性需要实际验证。

## 5. Next Action — 希望做什么

- [x] ✅ ~~删除本次孤儿 `.agent-busy` 锁文件，服务已恢复~~
- [ ] 观察下一次 server 异常退出时，dev.js 是否在 1.5 秒内自动恢复（文件变更 500ms 防抖 + 轮询 1s）
- [ ] 如果 server 反复异常退出，检查 Windows 事件查看器排查 OOM 或其他 kill 行为
- [ ] 考虑在 `socketio.ts` 的 Claude CLI 启动失败回调中主动 `releaseLock()`，减少异常退出时的孤儿锁窗口
