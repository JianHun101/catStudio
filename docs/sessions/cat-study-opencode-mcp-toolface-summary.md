# opencode 适配器挂载 catstudy MCP 工具面（对齐 dsh 侧）

## 1. What — 具体改动

| 文件                                       | 改动                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/server/src/llm/opencode.ts`      | 新增 `writeOpencodeMcpConfig()`：context 存在时 per-spawn 生成临时 `opencode.jsonc`（`mcp.catstudy` = local + `command:["node", scripts/mcp-server.mjs]` + `environment:{CATSTUDY_*}`），以 `OPENCODE_CONFIG` env 注入子进程；finally 清理临时配置。新增 `MCP_SERVER_PATH` 常量（与 dsh 同款 cwd 假设）。`triggerMsgId` 单字段注入进程 env 的逻辑保持，通道边界对齐 dsh/ADR 0008 |
| `packages/server/src/llm/opencode.test.ts` | 更新既有「不挂 MCP」用例为「进程 env 注入 triggerMsgId + OPENCODE_CONFIG env」；新增 4 例：临时 jsonc 内容正确（command 指向 mcp-server.mjs、environment 六变量）、无 triggerAuthorName 不写该字段、finally 清理无残留、context 缺失不生成不注入                                                                                                                                 |

## 2. Why — 为什么这样做

同一个 `scripts/mcp-server.mjs` 是猫咖 MCP 工具面的唯一 server（post_message / search_knowledge / query_db / request_user_action）。此前 dsh 猫已通过 `--patch overlay` 挂载它（结构化路由），而 opencode 猫在 `opencode.ts` 明确「不挂 MCP 工具面」——只能用嵌句 @ 投递下一棒，格式漂移会静默丢单。**工具面不通用**是痛点。

本单把 opencode 适配到与 dsh 同构的形态——「每轮动态 env 适配到 opencode 静态配置」：

```
dsh:      spawn node dsh --profile headless --patch <临时.yml>   (patch 内联 CATSTUDY_*)
opencode: spawn opencode run ... + env OPENCODE_CONFIG=<临时.jsonc>  (jsonc 内 environment: CATSTUDY_*)
```

`OPENCODE_CONFIG` 是 opencode 官方追加合并的配置入口（不改全局/项目静态配置），本地 MCP 官方形态 `mcp.<name>.type="local" + command:[array] + environment:{}`，工具命名 `mcp__catstudy__*` 与 claude/dsh 链一致——research-2026-08-17-opencode-32k-avoidance §4 已实测三假设全 ✅（MCP 工具可见、environment 六变量全透传 MCP server 子进程、prompt 短传可行）。

**通道边界（ADR 0008 通道准则 / dsh OQ1 硬伤修复）**：`CATSTUDY_*` 六变量（五固定 + 可选 `triggerAuthorName`）进 MCP `environment`（工具面路由消费）；`triggerMsgId` 的消费者是猫自己（提交 commit 的 catstudy [uuid]），走 opencode **进程 env** 单字段注入——**不可**写进 MCP environment（MCP 子进程 env ≠ agent 进程 env）。两侧通道各自独立，不重复注入。

## 3. Tradeoff — 放弃了什么方案

| 放弃                                     | 原因                                                                                                                                               |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 静态写全局/项目 `opencode.json` 挂 MCP   | 会污染所有猫的 opencode 实例、MCP 工具面加 context 开销影响无关会话；per-spawn 临时文件 + `OPENCODE_CONFIG` 只影响当轮进程，finally 清理零残留     |
| 用 CLI 标志（`--mcp-config` 等）挂 MCP   | opencode run 形态无该标志语义；且会改变既有 spawn args 结构（`run --agent build --auto` 是店长拍板形态）。改用 env 注入，spawn args 零变化，不回归 |
| 把 `triggerMsgId` 塞进 MCP `environment` | 违反 ADR 0008 通道准则（消费者是猫 shell 而非 MCP server），复刻 dsh OQ1 硬伤（MCP 子进程 env ≠ agent 进程 env）；保持进程 env 单字段注入          |
| 直接嵌句 @ 投递下一棒（维持现状）        | 格式依赖 LLM 精确输出，格式漂移导致静默丢单（dsh 猫已实锤）；MCP 工具面参数被 schema 强制，无「写错位置」空间                                      |

## 4. Open Questions — 不确定的点

- **MCP 工具面 context 开销**：opencode 官方提示 MCP 工具面会加 context 开销。本单 per-spawn 只挂一个 `catstudy` server，且在需要 A2A 路由的会话（context 存在）才挂；但长会话中 MCP 工具 schema 的固定开销仍需真机观测确认无碍。当前按店长拍板先挂上，观测后再调。
- **`--thinking` 与 MCP 组合**：`run --agent build --auto --thinking` + MCP 工具循环的组合在 32K 规避调研 §4 是**裸 run** 形态实测（非 agent + thinking 组合）。真机验收需确认模型在工具循环里会主动调 `mcp__catstudy__*`（而非只嵌句 @）。当前实现对齐 dsh 行为，真机跑通才算闭环。
- **command 中 `node` 的解析**：`command:['node', MCP_SERVER_PATH]` 依赖 opencode 拉起 MCP server 时 PATH 里有 `node`。dsh 侧同样假设，win32 下 node.exe 在 PATH（CLAUDE.md「node path/to/cli.mjs」惯例）——真机确认。

## 5. Next Action — 希望做什么

- [x] opencode 适配器挂载 catstudy MCP 工具面（本单）
- [ ] 真机验收：确认 opencode 猫会主动调 `mcp__catstudy__*` 工具（post_message 结构化投递），而非嵌句 @
- [ ] 若真机确认，可将 post_message 设为 opencode 猫投递下一棒的主通道，与 dsh 猫对齐
- [ ] 记忆改造单仍挂起（"改存陈述性内容/文档"），不并入本单，等店长喊再动
