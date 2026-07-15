# CatStudy 超时值重平衡 + 全局 lint 修复

## 1. What — 具体改动

| 文件 | 改动 |
|------|------|
| `packages/shared/src/types.ts` | `ChatOptions.timeoutMs` JSDoc 同步：默认值 120000 → 300000 |
| `packages/server/src/llm/cli-utils.ts` | CLI 空闲超时从 10min → 20min；注释去掉 clowder-ai 引用 |
| `packages/server/src/llm/deepseek.ts` | HTTP 请求超时默认值从 120s → 300s（5 分钟） |
| `packages/server/src/connectors/socketio.ts` | Dispatch 硬超时从 15min → 30min；注释去掉 clowder-ai 引用 |
| `.env.example` | 超时文档同步新值，去掉 clowder-ai 引用 |
| `packages/web/src/components/ChatPanel.vue` | 新增 `import type { Message }`，修复 TS2304 |
| `packages/web/src/stores/chat.ts` | `process.env.NODE_ENV` 改为 `import.meta.env.MODE`，修复 TS2580 |
| `packages/web/src/stores/chat.test.ts` | 4 处移除 mock.calls.find 的 `[string, Function]` 类型注解；mockMessage 补 `agentId: null` |
| `packages/server/src/dispatch/index.test.ts` | `makeMessage` 补 `agentId: null` |
| `packages/server/src/index.ts` | Fastify error handler 中 `err` 加 `as any` 类型断言 |

## 2. Why — 为什么这样做

### 超时值重新平衡

此前超时值参照了 clowder-ai 的两层比例，但取值过于保守（10min idle / 15min hard）。本次根据实际使用场景重新校准：

```
Agent 执行时间轴:
0min ──────────── 20min ──────────── 30min
 开始执行          CLI idle 触发       hard 触发
                 （可重置，正常不触发） （不可重置，最终防线）
```

- **CLI 子进程是主力**：CatStudy 大部分 agent 走 Claude/OpenAI CLI 子进程（非 HTTP API），长回复或深度推理时 10min 偏紧。调到 20min 给子进程更多余量。
- **DeepSeek HTTP 是保底**：仅在无 CLI 时回退，之前 120s 对推理模型（deepseek-reasoner 等）不够，调到 300s。
- **hard/idle 比例保持 1.5x**：idle 先触发（按输出重置，正常 agent 不会触发），hard 是绝对截止时间。30min 保证槽位不被无限占用。
- **无 CPU 探活**：clowder-ai 的 ProcessLivenessProbe 区分"忙但静默"vs"真死锁"，对 CatStudy 不必要。主力是 HTTP API 等响应期间 CPU 为 0 是正常的；CLI 子进程按输出重置 timer 已能覆盖死锁场景。

### 全局 lint 修复

`pnpm lint` 跨三个包零错误。修复了 6 个原有问题：

- **类型注解过紧**：`mock.calls.find((call: [string, Function]) => ...)` 与 vitest 的 `any[][]` 类型不兼容。去掉显式注解，让 TS 推断。
- **Message 缺字段**：两处测试 mock 缺 `agentId`（interface 要求 `string | null`），补 `null`。
- **前端引用 Node API**：`chat.ts` 用 `process.env.NODE_ENV` 但没装 `@types/node`，改用 Vite 原生的 `import.meta.env.MODE`。
- **ChatPanel.vue 缺 import**：用了 `Message` 类型但没 import。
- **Fastify error handler**：`err` 参数类型为 `unknown`（TS 4.4+），需显式断言。

## 3. Tradeoff — 放弃了什么方案

| 放弃 | 原因 |
|------|------|
| 引入 ProcessLivenessProbe（CPU 探活） | CatStudy 主力是 HTTP API（DeepSeek），等待响应期间 CPU 空闲是正常的；CLI 子进程按输出重置 timer 已足够区分"活着"和"死了" |
| hard/idle 比例改为 2x（30/60min） | CatStudy 无工具调用循环（构建/测试/PR），单次回复极少超 20min。60min 硬超时槽位占用过久，阻塞排队 agent |
| 内存超时也从 10s 上调 | 本地 SQLite 向量检索毫秒级完成，10s 已是极端兜底，没必要调整 |
| 前端 REST 超时从 10s 上调 | agent 执行走 Socket.IO 长连接，不走 REST 超时。普通 CRUD 10s 足够 |

## 4. Open Questions — 不确定的点

- **20min CLI idle 对 Claude Code CLI 是否足够**：Claude Code 在多文件编辑 + 子代理模式下可能长时间无 stdout（思考+工具调用循环中），20min 仍有可能误杀。需要通过日志观察最长静默间隔。
- **DeepSeek HTTP 300s 对 reasoning 模型是否足够**：deepseek-reasoner 的思考阶段可能超过 5 分钟（特别是复杂 prompt），但目前 CatStudy 主力是 CLI 子进程，此路径极少走。可按需通过 `ChatOptions.timeoutMs` 上调用方传递更大值。
- **30min hard 超时后用户体验**：hard 超时触发时用户看到"执行超时 (1800s)"系统消息。对于在 25 分钟处 agent 仍在正常输出的场景，突然截断的体验不佳。可考虑在 hard 超时前 N 分钟通过 Socket.IO 发警告事件。

## 5. Next Action — 希望做什么

- [ ] 观察生产日志中的 agent reply latency，确认 20min idle / 30min hard 是否足够（特别关注 Claude CLI 子进程的最长静默间隔）
- [ ] 如长期未见 idle/hard 超时触发，考虑进一步上调 idle 到 25min 或 hard 到 40min
- [ ] 考虑 hard 超时前的预警机制：在到期前 2 分钟通过 `AGENT_TYPING` 事件推送 "[agent名] 回复即将超时…"
- [ ] ✅ ~~pnpm lint 全绿（三个包零错误）~~
