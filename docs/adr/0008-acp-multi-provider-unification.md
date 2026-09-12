---
type: decision
date: 2026-08-17
status: accepted
evidence:
  - kind: commit
    ref: 0583825
  - kind: file
    ref: docs/research/research-2026-08-17-acp-feasibility.md
  - kind: file
    ref: packages/server/src/llm/adapter.ts
---

# ADR 0008: 多供应商统一接入采用 ACP（connector 并存、分步迁移）

> **调研来源**：`docs/research/research-2026-08-17-acp-feasibility.md`（commit `0583825`，flash猫 调研，吐槽猫 审查 ✅可合并）。用户拍板方向「直接上 ACP」，本 ADR 将调研结论固化为架构决策。
> **过 ADR 0007 四步检查单**：能力对账前置（§1 覆盖表）／假设标红 + 实测对称（§8，🔴 转 ✅、cancel 证伪）／简单形态默认复杂举证倒置（§5.2 一轮一进程不可行证伪）／决策留痕（本 ADR 证据段引用调研笔记）。

## 决策

多供应商（opencode / claude / dsh / deepseek）统一接入采用 **ACP（Agent Client Protocol）**，以 **connector 并存 + 分步迁移**落地：

- 新增 `acp.ts` 适配器，实现既有 `chatStream(messages, options) → AsyncIterable<Chunk>` 契约（`llm/adapter.ts` 的 `LLMAdapter` 接口），**dispatch 层（slot/FIFO/context filtering/记忆注入）零改动**。
- 旧适配器（claude.ts / opencode.ts / dsh.ts / deepseek.ts）全部保留为回滚路径，registry 按需切换。
- 不直接全换——每 backend 独立接入、独立回滚。

## 采纳序（分三步）

1. **第一步（近期）**：`acp.ts` + opencode 单 backend 试点。工具循环 / fork / resume / close 取消四块均实测（调研 §3）。
2. **第二步（中期）**：claude 经 `zed-industries/claude-agent-acp` SDK adapter（⚠️ SDK 行为未实测）；deepseek（直连 API 型）经 opencode 挂 deepseek provider 间接接入。
3. **第三步（后续）**：dsh 折中另议——dsh CLI 无 acp 子命令（三源实证，调研 §1.1），官方 npm 插件包 `@deepseek-ai/dsh-acp` 为裁剪形态、与四块依赖原语冲突（对称实测，调研 §1.1b），要么自起 ACP server 另立项，要么 headless 直连 + ACP 并存。

## 契约裁决（店长拍板）

1. **取消语义统一走 `session/close`**：opencode 1.18.18 未实现 `session/cancel`（`-32601`），`session/close` 实测中断进行中 prompt → `stopReason:"cancelled"`（调研 §3.3）。适配器不得用 cancel。
2. **model 取值域对齐**：`session/set_config_option` 的 model 列表来自 opencode 本地 models，须与注册表 `agent.llmModel` 取值域对齐（调研 §3.4；registry 现无约束，测试可跑 `anthropic/claude-sonnet-4-5` / `openai/gpt-5`）。
3. **通道准则（消费者定通道，延续 f9caac6 已落锤准则）**：`options.context` 的两个动态字段**不得整体塞 `mcpServers[].env`**——
   - `triggerMsgId`：消费者是**猫自己**（commit 时读 agent 进程 env 取 uuid），必须进 **agent 进程 env**，需 per-prompt 动态机制（🔴 待验证，调研 §4.3）。
   - `triggerAuthorName`：消费者是 **MCP server**，走 `mcpServers[].env`（静态可承载）。
   - 二者分开注入——整体塞 `mcpServers[].env` 会复刻 f9caac6 的通道陷阱（MCP 子进程 env ≠ agent 进程 env）。

## Considered Options

- **维持现状（各 CLI/API 直连）**：零迁移成本，但多供应商各拼一套形态，无统一收敛点，32K / 上下文外置 / 工具面三件事逐供应商重复解决。
- **MCP 工具面外置统一**：只解「上下文外置」，不解「供应商无关」+「协议化」，是 ACP 的子集，不选。
- **直接全换 ACP**：一步到位但牵动全部猫，dsh CLI 无 acp 子命令、官方插件包为裁剪形态（调研 §1.1b 对称实测）直接暴露全覆盖缺口，回滚需整体回退——风险高。
- **connector 并存 + 分步迁移（选中）**：ACP 是唯一有行业共识的多供应商收敛点（官方 Agents 页 30+ 实现），保留旧适配器回滚路径，增量验证。

## Consequences

- 长驻进程管理成为新增复杂度：连接池/复用、session 生命周期（每轮 fork）、崩溃恢复（resume + session/list）、并发安全（多 agent 共享进程时 JSON-RPC id 对齐，🔴 待验证）——均不在现有「一轮一进程用完即退」模型内。
- 对 ADR 0007「一轮一进程 > 长驻服务」默认的重审：ACP 长驻是另一种形态，靠 fork（每轮分支隔离）+ resume（崩溃恢复）等价替换「一轮一进程」的隔离语义，经举证倒置通过检查单，不套同一默认直接否决。
- 每步实施走 connector 并存，registry 改配置即回滚（serve 适配器 d555732 先例同款）。
- 第一步 acp.ts 试点的验收标准：工具循环 / fork / resume / close 取消四块在真实 dispatch 链路下跑通，且 `triggerMsgId` 进 agent 进程 env 的 per-prompt 机制落地（🔴 转 ✅）。
