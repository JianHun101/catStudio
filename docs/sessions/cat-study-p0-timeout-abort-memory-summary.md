# CatStudy P0 超时修复 + 多层纵深防御 + P1 排查

## 1. What — 具体改动

| 文件 | 改动 |
|------|------|
| `packages/shared/src/types.ts` | `ChatOptions` 新增 `signal?: AbortSignal`，用于外部取消 LLM 调用 |
| `packages/server/src/llm/claude.ts` | 监听 `AbortSignal` → `child.kill('SIGTERM')` → `SIGKILL`；流循环检查 `signal.aborted` |
| `packages/server/src/llm/deepseek.ts` | 外部 signal 转发到内部 `AbortController`；流读取循环检查 `externalSignal.aborted` |
| `packages/server/src/llm/openai.ts` | 同 claude.ts 的 abort 模式 |
| `packages/server/src/llm/cli-utils.ts` | CLI idle timeout 从 5min → 10min（按输出重置）；支持 `CLI_IDLE_TIMEOUT_MS` 环境变量 |
| `packages/server/src/connectors/socketio.ts` | P0-1: AbortController 链路 (executeAgentsSerial → runAgentReply → adapter)；P0-2: validAgents 过滤；P2: retractionRequests 清理；Dispatch 超时 180s → 15min (`AGENT_HARD_TIMEOUT_MS`) |
| `.env` | 新增 `HF_ENDPOINT=https://hf-mirror.com`，修复 embedding 模型下载（P1-2） |
| `.env.example` | 新增 Agent 超时配置说明（`CLI_IDLE_TIMEOUT_MS` / `AGENT_HARD_TIMEOUT_MS`） |

## 2. Why — 为什么这样做

### 核心架构：AbortController 全链路

日志分析发现，店长的 Claude CLI 子进程在 dispatch 超时后仍在后台运行，最终写入双重回复。根因是 `Promise.race` 只 reject 不 cancel loser promise。

```
修复前:
  executeAgentsSerial 用 Promise.race 包裹 runAgentReply (180s)
    → 超时 reject → catch 块 completeExecution(false)
    → runAgentReply 仍在后台消费 chatStream
      → claude.ts spawn() 的子进程未被 kill
        → 子进程完成后写入 DB + 发 NEW_MESSAGE（双重回复）

修复后:
  executeAgentsSerial 创建 AbortController
    → 超时时 controller.abort()
      ├─ signal.aborted = true → runAgentReply 停止流处理 → 不写入 DB
      ├─ claude.ts 'abort' 事件 → child.kill('SIGTERM') → 5s 后 SIGKILL
      ├─ openai.ts 同 claude.ts
      └─ deepseek.ts 转发到内部 AbortController → fetch 中断
```

### 多层超时纵深防御（参照 clowder-ai）

clowder-ai 使用 CLI idle timeout (30min) + invocation hard timeout (60min) 两层设计。CatStudy 据此调整：

```
┌─────────────────┬──────────┬──────────────┬────────────────────┐
│      层级       │ CatStudy │  clowder-ai  │       机制          │
├─────────────────┼──────────┼──────────────┼────────────────────┤
│ CLI idle (层1)  │  10 min  │    30 min    │ 按输出重置 timer    │
│ Dispatch (层2)  │  15 min  │    60 min    │ AbortController 绝对│
│ hard/idle 比例   │  1.5x   │     2x       │ idle 先触发         │
└─────────────────┴──────────┴──────────────┴────────────────────┘
```

CatStudy 的值更保守是因为其任务更轻量（代码审查、小改动），不需要 30-60 分钟的窗口。10+15min 已覆盖日志中最长的观察 latency（~7.5min）。

### P0-2: agent-1 批量执行风暴

日志中 `agent-1`（测试用 agent ID）在 14ms 内被 dispatch 10+ 次。根因是旧测试 session 含无效 agent ID，SEND_MESSAGE handler 无条件初始化槽位并调度。修复：在 handler 中添加 `validAgents` 过滤——只对 agents 表中实际存在的 Agent 操作。

### P1-1: Agent-to-Agent @mention 未触发

DB 消息内容检查确认 `parseMentionsFromReply` 逻辑正确。16 条 agent 回复中唯一含 `@吐槽猫` 的一条 latency=448s，被旧 180s 超时 skip 掉了 mention 检测。P0-1 的 AbortController 修复（配合 15min 硬超时）已解决此问题。

### P1-2: Memory embedding 持续失败

`.env` 缺 `HF_ENDPOINT`，`@huggingface/transformers` 从 huggingface.co 直连下载模型失败。sqlite-vec 扩展本身工作正常（验证 `vec_version() = v0.1.9`），日志中的 `vec_distance_cosine` 错误来自测试 DB（特意不加载扩展）。

## 3. Tradeoff — 放弃了什么方案

| 放弃 | 原因 |
|------|------|
| 直接在 dispatch 层 `childProcess.kill()` | dispatch 模块不持有 child process 引用。子进程由 adapter 创建，kill 逻辑应在 adapter 层，遵循单一职责 |
| 用 `Promise.race` 返回的 cleanup 函数 | `Promise.race` 不提供取消机制。AbortController 是 Web 标准解法，同时适用于 HTTP (fetch) 和子进程 (spawn) |
| 给 `LLMAdapter` 接口加新方法 `abort()` | 侵入性太大。`AbortSignal` 作为 `ChatOptions` 的可选字段更轻量，不强制所有 adapter 都实现 |
| ProcessLivenessProbe（CPU 探针） | clowder-ai 的 stall 检测机制对 CatStudy 3 猫 setup 过度设计。CLI idle timeout 按输出重置已能区分"忙但活着"和"真死锁" |
| 统一改为 30min 超时 | CatStudy agent 不做构建/测试/PR 创建，最长观察 7.5min。15min 硬超时足够，过长的超时会阻塞其他 agent 的 slot |
| 修复测试日志写入生产 log 文件的问题 | 属于单独的测试基础设施问题，跟超时/debug 不在同一范围，单独开 issue 处理 |

## 4. Open Questions — 不确定的点

- **AbortController 对 deepseek adapter 的实际效果**：当前 cats 使用 `provider=claude`（Claude Code CLI），deepseek adapter 的 abort 转发只在切换到 HTTP API 时生效。fetch 的 AbortSignal 在 Node.js 中的行为已验证正确，但需要一次实际切换测试。
- **15min 硬超时是否足够**：日志中最长 latency 448s（7.5min），15min 是 2x 余量。但如果 agent 被要求做更复杂的多文件重构，仍可能突破。可通过 `AGENT_HARD_TIMEOUT_MS` 环境变量按需调整。
- **LLM 是否会在 10-15min 窗口内产出 @mention**：P1-1 的 mention 检测代码是正确的，但取决于 LLM 是否遵守 system prompt 中的 `DEVELOPMENT_RULE`。当前 16 条回复中仅 1 条含 `@吐槽猫`，可能需要更结构化的 handoff 触发（如 `<mention>吐槽猫</mention>` 标记），而非依赖自然语言 @。
- **HF 镜像的可用性和模型缓存**：`hf-mirror.com` 是社区维护镜像，稳定性取决于维护方。首次下载 ~100MB 模型可能需要数分钟。建议预下载模型或提供 fallback 到本地 `.onnx` 文件。

## 5. Next Action — 希望做什么

- [ ] 实际运行一次完整 review 链路（店长写代码 → @吐槽猫 review → 吐槽猫回复），验证 15min 窗口内 mention 检测生效
- [ ] 验证 HF 镜像下载 embedding 模型是否成功（重启 server，观察日志 "嵌入模型加载完成"）
- [ ] 清理生产 DB 中的旧测试 session（含 `agent-1` 的 session）
- [ ] 修复测试日志写入生产 `cat-study.log` 的问题（测试 logger 应输出到独立文件或 stdout）
- [ ] 将 `cat-study.db-shm` 加入 `.gitignore`
- [ ] 评估是否需要 `<mention>name</mention>` 结构化标记代替自然语言 @mention
- [x] ✅ ~~P0-1: AbortController 全链路修复~~ — 5 files changed
- [x] ✅ ~~P0-2: agent-1 批量执行风暴~~ — validAgents 过滤
- [x] ✅ ~~P2: retractionRequests 内存泄漏~~ — runAgentReply 完成时 delete
- [x] ✅ ~~P1-1: 确认 mention 检测机制健康~~ — 根因是超时 skip，代码正确
- [x] ✅ ~~P1-2: 修复 embedding 模型下载~~ — .env 添加 HF_ENDPOINT
- [x] ✅ ~~多层超时纵深防御~~ — CLI idle 10min + Dispatch hard 15min
