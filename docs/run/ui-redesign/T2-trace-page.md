# T2 执行追踪（trace）查询页

> **状态：已立票，派发时机 = T1 合并后**（footer ⚙trace seam 接线 + 共享文件面 ChatPanel/MessageItem 与 T1 重叠，避免跨树互撞）。

## 一、背景与设计基准

用户裁决链：①「是不是做个单独的查询页好一些。可以过滤信息，点开可以看trace各个阶段。以及报错位置及原因」→ 推翻气泡内联展开，定查询页为主；②「prompt 快照要能看到具体内容吧，点开查看之类的。不然只显示字数没有意义」。

**设计基准 = 原型 v6 的 trace 视图**（`C:\Users\肖锦鹏\AppData\Local\Temp\catstudy-ui-redesign-prototype-v6.html`「执行追踪」tab）。勘察已收口（本会话勘察报告，39 次只读调用），关键数据面结论内联如下。

## 二、勘察结论（数据面现状，已实核）

**现成**：`execution_logs`（status/latency_ms/prompt_tokens/completion_tokens/error_type/error_message）；`spans` 表 11 段（含 `llm.chat` 带 TTFT/token 快照、`dispatch.token_wait`、`dispatch.queue_wait`）；检索流水三表（`retrieval_events/queries/candidates`，候选级 `dropped_reason`/`injected`/`injected_position` 齐全）；`/api/eval/spans`、`/api/eval/session-traces` 读口；前端 `buildWaterfall` 瀑布组件（SessionAgentsPanel 成员卡内联 trace 在用）。

**缺口（本票要补的）**：

1. **上下文决策明细零持久化**——哪条消息被可见性过滤/摘要替代/截断丢掉，只有聚合计数。→ 新写口：执行时落决策明细（新表或 execution 挂 JSON 列，实施时裁决）。
2. **prompt 分节快照不落库**（system/铁律/记忆/知识库/摘要各节内容）。→ 新写口：执行时持久化分节快照（用户明确要求「点开看具体内容」）。
3. **气泡 → execution_id 缺一跳**——`ExecutionMeta` 投影无 execution id。→ 照抄 memory-refs 的 join 模式补读口。
4. **检索流水 probe 行/未注入候选无路由**（`getRetrievalQueries`/`getRetrievalCandidates` 已存在但无 HTTP 出口）。→ 纯读口补齐。

**如实标注**：token 数全是估算（适配器不回流真实 usage，R2 明写边界）——UI 须带「估」标。存量老执行无 span/快照数据 → 详情显示「无段数据（存量行）」占位，不报错。

## 三、改动规格

### A. 页面（web）

- 新视图「执行追踪」+ 轨道 ⚙ 接线（T1 已建轨道与 seam）。
- **过滤栏**：会话 / 猫 / 状态 / 耗时阈值 / 仅看报错 + 命中计数。默认 = 当前会话、近 50 条、全部状态。
- **执行列表行**：时间 / 猫 / 摘要 / 状态徽章 / 总耗时 / 检索漏斗（注入N·引M）；failed 行淡红 + 报错类型写在行上；A2A 行显示「未检索（A2A）」。
- **展开详情**（就地）：瀑布（复用 `buildWaterfall`，失败段标红）+ 三小节默认折叠（上下文决策 / 检索明细 / prompt 快照）+ **failed 时错误框默认展开**（error_type + 原文 + 处置建议）。
- **prompt 快照**：节卡片列表，每节 = 状态标记（注入绿/截断黄/未命中灰）+ 字符数 + **点开展开当次实际注入的完整原文**（等宽、可滚动）。
- 「跳到该回复气泡 ↗」反向动线；气泡 footer ⚙trace 跳页并预选该执行（接 T1 的 seam）。

### B. 读口与新写口（server）

- 上下文决策明细写口 + 读口；prompt 分节快照写口 + 读口；messageId→executionId 关联口；检索明细读口（复用既有 repo 函数）。
- 快照含敏感面自知：system prompt 全文落库（单机本地定位，可接受，OQ 里确认）。

## 四、边界

- 不改调度/执行语义；新写口失败只 warn 不阻塞执行（与 retrieval trace 同款口径）。
- 右栏成员卡内联 trace 不动（会话级视角，互补）。
- 真实 usage 回流不做（R2 边界）。

## 五、验收（行为可验，拆票时再细化）

1. 过滤栏五件套各自过滤生效（组合至少三组实测）。
2. 列表行六读数与库中 execution_logs 逐字段对账。
3. failed 行：行上可见报错类型；展开后错误框默认开、内容 = error_message。
4. prompt 快照：点开任一节 → 显示内容与当次注入原文逐字节一致（组装式测试比对执行期快照 vs 读口返回）。
5. 上下文决策：筛入/筛出逐条带原因，总数与 `context.build` 段 item_count 对账。
6. 检索明细：注入节与 memory-refs 同源一致；丢弃原因分布计数正确。
7. 存量行（无新写口数据的老执行）显示「无段数据」占位不报错。
8. 气泡 ⚙trace 跳页预选正确执行。
9. `pnpm test` + `pnpm lint` 全绿；真机自证截图附审查请求。

## 六、Open Questions（起草 spec 阶段裁决）

1. 上下文决策与 prompt 快照的落库形态（独立表 vs execution_logs 挂 JSON 列）。
2. 快照保留策略（全量永久 vs 仅近 N 天——库体积）。
3. 列表分页口径（50/页 还是无限滚动）。

## 七、纪律

同 T1/T3：worktree、限定路径裸 commit、uuid 标记、票带入分支、quality-gate 后审查投吐槽猫。含 server 代码 ⇒ 收口后店长发起重启审批。
