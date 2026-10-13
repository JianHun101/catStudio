---
status: active
---

# 票：交接摘要注入落在占位符替换面之外（机制观察单 · 低优先级）

> 立票：2026-10-13 · 店长 · 段 3c 承接票
> 来源：段 3b 上浮 `docs/plans/skill-discovery-injection.md` 的 D3（注入次序）时带出 —— 该条的订正口径把「注入文本必须落在替换面内」写死之后，**同一批代码里还有一条落在面外的路**。
> 性质：**机制观察单**，低优先级，不阻塞任何在途链路。已实测、未修。

## 一、现象（代码面，既有缺口 · 已实读）

一句话：**交接续跑的增量摘要，是在角色占位符替换**之后**才拼进 system prompt 的**，故摘要正文里若含 `@架构师` 一类角色字面量，它会**原样漏进**最终的 system prompt。

三段实测（读源码得出，非推断）：

1. `packages/server/src/execution/reply.ts` 组装 system prompt 的次序是：先 `skillDirectorySection` 拼成 `systemPromptWithDirectory`，**然后** `resolveRolePlaceholders(systemPromptWithDirectory, …)` 产出 `finalSystemPrompt`——即目录段**在替换面内**（这是 D3 订正后的口径，正确）。
2. 该 `finalSystemPrompt` 被放进 `llmMessages[0]`。
3. 之后才在 LLM 消息装配段调用 `injectSummaryIntoSystem(llmMessages[0].content, runningSummary)`——而 `packages/server/src/handoff/index.ts` 的函数体是**裸模板拼接**（`${systemPrompt}\n\n【对话历史摘要】\n${summary}…`），**完全不经过 `resolveRolePlaceholders`**。

⇒ 摘要在替换**输出**上拼接，替换覆盖不到它。

## 二、为什么这是真缺口（而不是洁癖）

- 口径已在 `docs/plans/skill-discovery-injection.md`（D3）与 `packages/server/src/execution/reply.ts` 的注释里钉死：**注入文本若含角色占位符，必须一并被替换，否则占位符漏网 ⇒ mention 精确匹配落空 ⇒ 静默不触发**。摘要这条路是同一机制下的**唯一漏网面**。
- 与已知事故同族：`b542d24` 那条正是「占位符漏网 ⇒ 静默不触发」的形态。区别只在**后果面**——`serial.ts` 的解析兜底只管**路由**，不管 **prompt 正文**：漏进 prompt 的 `@架构师` 不会被路由解析层拦下，它就是一个躺在系统提示里的字符串。
- 触发条件具体：**交接续跑（handoff resume）** + 摘要正文含角色字面量。两条同时成立才发作，故实际频率低——这正是它被定为「低优先级观察单」而不是缺陷票的原因。

## 三、修法方向（**未裁**，派活时定）

- **方向 A（把摘要挪进替换面内）**：在 `resolveRolePlaceholders` 之前把摘要拼进去，与 `skillDirectorySection` 同待遇。代价：要确认摘要的拼接点顺序对既有测试与 token 预算无副作用（`reply.ts` 有消费点注释说明摘要恒为「纯前缀拼接」）。
- **方向 B（在摘要侧就地替换）**：`injectSummaryIntoSystem` 内部对 `summary` 调一次 `resolveRolePlaceholders`。改动面更小，但要接受「同一函数被调用两次替换」的语义。
- 两个方向都**不动**：`parseSummaryText`、摘要的生成与落库、路由解析兜底。

## 四、边界

- **本票是观察单**：只登记现象、判据与实测证据；**不动代码**（段 3c 边界）。
- 不改 `resolveRolePlaceholders` 本体（它是纯函数，两处消费点都依赖其现行语义）。
- 不把「摘要里别写 @」当解法：那是**意图级规避**，而本仓已有教训——**验证面必须与被判面同面**，靠写作者自觉规避的规则会在下一次改文案时静默失效。

## 五、验收（行为可验证）

1. **反对照先行**：构造「摘要正文含 `@架构师` 字面量」的交接续跑用例 ⇒ **修前必红**（断言最终 system prompt 里不再出现该字面量，或断言它已被替换成真实作者名）。只绿不红的用例证不了这条路径被覆盖。
2. 中性对照：摘要正文**不含**任何角色字面量时，拼接结果与修前逐字节相同（证明改动只影响该触发面）。
3. 三条守卫面各自仍绿：`skills/request-review/SKILL.md` 相关静态断言、`execution/hints.ts` 的 `resolveRolePlaceholders` 单测、`serial.ts` 的 mention 路由用例。
