# R12 · dce2bc9 定位键声称族 + R7 注释行号 + adr-0015-draft 归因——一次扫全

> 立票：2026-09-19，店长。来源：R8 审查（吐槽猫 ✅ `3055fcb`）四项裁决的合并落实。
> 性质：**纯注释/文档扫修，零行为变更**。族修纪律票——本票的核心不是改哪几处，是**扫描模式本身**。

## 一、背景与根因

`dce2bc9`（db-schema 批一，09-18）给 `finalizeExecutionLog` / `updateExecutionLogDiagnostics` 补了 `session_id` 定位维度；R8 §A（`8d52ca7`）给 `getRunningExecutionCommitHash` 补了。**机制改了，复述这些机制定位口径的文本没扫全**——R8 只修了票面点名的 `serial.ts:1749` 禁入区外部分，吐槽猫独立扫描又抓到 `reply.ts:209` 漏网。

**根因（吐槽猫定性，店长认可）**：`dce2bc9` 自己没做族修扫描。本票把族B（定位键声称族）一次扫全，不留「再漏一处」的窗口。

**扫描模式（本票判据面，复跑必须零新增命中）**：

```
git grep -n "没有 sessionId\|没有 session_id\|WHERE 里没有" -- packages scripts docs
git grep -n "agent + 最新 running\|agent + running\|「agent" -- packages scripts docs
git grep -n "19 行\|19 次\|存量 19" -- packages scripts docs
```

## 二、修改清单（行号基线 = dev `7bdda63`，已 `git grep -n` 实测；实施时按行号纪律复测）

### §A 族B · 定位键声称（活代码注释）

1. **`packages/server/src/execution/serial.ts:1748-1749`**（R7 归属校验注释块内）：「`finalizeExecutionLog` 按『agent + 最新 running』定位，WHERE 里没有 sessionId ⇒ 跨会话也能命中」——`finalizeExecutionLog` 自 `dce2bc9` 起已是 `agent_id + session_id + 最新 running`。**改写为现态**（R8 §A 后三个定位函数全部含 session 维度）。
2. **`packages/server/src/execution/reply.ts:209`** 两处失实同句：①「`updateExecutionLogDiagnostics` 的『agent + running』」→ 现为 `agent_id + session_id + running`（`executionLogs.ts` 实测）；②由此「多带 session + trigger 两个条件」塌为「多带 **trigger** 一个」（两边现在都有 session 维度）。

### §B 计数族 · 「19」去计数化

实测（2026-09-19，吐槽猫 + ds猫 各自独立直查活库）：`error_message LIKE '%crash%'` = **18 行**，全为字面量 `execute crash`。票面/交接文档的「19」是 R6 时点的 dev 库读数。**裁：活代码注释不钉会腐烂的计数**，统一去计数化（与 R8 §B 「那批行」同款纪律）：

3. `serial.ts:38-40`（「库内 19 行…19 行是历史存量」）
4. `serial.ts:1741`（「存量 19 行」）
5. `serial.crash-label.test.ts:9-10`（「全库 19 行…19 行」——注释，**禁动任何 expect/it**）

### §C R7 注释行号漂移（OQ-6，`805cb81` 上就已错，非本轮引入）

6. `serial.ts:1742-1745`：`:806`→**:812**、`:1093`→**:1099**、`:1772`→**:1804**（决策段标记行，实测 `// ── 决策段（同步，无 await…` 在 `:1804`）；`:1765` 的 `:806`→**:812**、`:1096`→**实施时实测**（`:1099` `Promise.all` 之后的 catch 行）。

### §D adr-0015-draft 归因改写（OQ-3）

7. **`docs/run/multi-cat-isolation/adr-0015-draft.md:241`**：该段把「`execute crash` 判死后原进程未被终止、同一 agent 两条 CLI 同跑」记为「**须独立单**」的未决缺陷。R7 已钉死根因 = finally 误收口（误释放他人槽位 ⇒ 新触发双跑；非进程管理缺陷），修复 `805cb81` 已上 dev。**改写归因**：独立单 = R7，根因与修复各一句，保留原实测现象描述不动。

## 三、不动清单（存证，逐条给理由——不许「顺手」改）

| 位置                                                            | 理由                                                |
| --------------------------------------------------------------- | --------------------------------------------------- |
| `docs/run/eval-system/P1-a-backend-chain-query.md:44/:262`      | 历史票面，记录当时决策语境                          |
| `docs/run/db-schema-governance/tickets.md:314`                  | 审查回执存证                                        |
| `docs/run/eval-system/P2-design-retrieval-events.md:364`        | 历史票面                                            |
| `docs/run/eval-system/R6/R7/R8-*.md` 内的「19」                 | R6/R7 已收口票面存证；R8 票面由店长另行订正（见下） |
| `serial.crash-diagnostic.test.ts:12` 引号内「19 次」            | R8 §B 修的**引号内引用**（记录被删原句），合规      |
| `state.ts:44/46/165/191`、`bus.ts:30`、web 两处「无 sessionId」 | **另一语义**（stream/abort 遗留兼容），不属族B      |

## 四、验收

- **C1**：§A–§D 七处全改，改后文本与机制现态逐字一致（评审对照 `executionLogs.ts` 三个函数现文）
- **C2**：§一三条扫描模式复跑，活代码面（`packages/` + `scripts/`，排除不动清单）**零命中**
- **C3**：`git grep -n "19 行\|19 次\|存量 19" -- packages scripts` 零命中
- **C4**：行号纪律——先 prettier 落盘 → `git grep --cached -n` → 提交后对 HEAD 复校，零漂移
- **C5**：lint 三包绿 + server 域全量绿（注释改动不该动任何测试——红了说明越界）
- **C6 真空性**：本票纯注释，真空性由 C5 反向承担（**任何测试行为变化 = 越界信号**）

## 五、停手与禁入

- **停手**：扫描模式复跑发现本清单**之外**的新命中（= 族比已知大）⇒ 报店长，不自行扩面
- **禁入**：任何非注释/非文档代码行、测试断言、`.husky/**`、`.push-gate`、R6/R7/R8 票面文件

---

**店长附记（不占票面）**：R8 票面 `:49/:51/:57` 的「19」由店长收口侧订正为 18 并注明两时点读数差，不在本票面内。
