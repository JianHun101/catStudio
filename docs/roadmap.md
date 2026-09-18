# 猫咖路线图（2026-08）

> 方向基准文档：MCP 结构化路由（进行中）+ 评估系统 + 向量库优化 + 知识库。
> 所有方案均经店长架构裁决 + 吐槽猫独立实核审查。实施顺序见文末依赖链。

---

## 背景：问题的根源形态

ds猫 的 @ 格式漂移导致路由信号静默丢失——「位置：@店长 请收口」嵌句中，`parseMentionsFromReply` 严格行首匹配按设计忽略，mentions 落库 `[]`，**零日志零提示，猫自认为已投递**。这不是解析 bug（2b4a391 已修），是 LLM 产出层格式漂移——clowder-ai 踩同一个坑，根因判定：**路由信号混在自由文本里，靠模型「写对位置」传递是软约束，生成惯性必然漂移**。

---

## 一、MCP 结构化路由（v4 定稿，待吐槽猫审批后开工）

### 设计核心：路由信号从文本剥离，走工具参数

clowder-ai F055 同款思路：模型调 MCP 工具 `post_message({targetCats})` 投递下一棒，参数被 schema 强制，「写错位置」的空间不存在。适配器核实：**四只核心猫（店长/ds猫/flash猫/吐槽猫）全部 `llmProvider: 'claude'` + deepseek-v4-flash**（seed-data.ts:149/:174/:199/:227），走同一 `claude` CLI（claude.ts:83-93）——Claude Code 原生内置 MCP 客户端与代理循环，挂 `--mcp-config` 即接通。deepseek.ts/openai.ts 零 A2A 消费者，出圈记后续。

### 三层防线（串行兜底，无静默丢失路径残留）

```
结构化（post_message 工具）成功 → 完事，M1 不响
    ↓ 模型不调工具 / 端点不支持 / 预校验 4xx
文本通道（行首 @ fallback）成功 → 完事，M1 不响
    ↓ 文本也没写对
M1 告警 + 点名（静默变可见，5 分钟/猫频控）
```

- **汇入式合并**：工具调用发生在流中途（回复行未落库），post_message 只记信号入内存 Map；流结束后 socketio.ts:870 合并点 `parseMentionsFromReply(正文) ∪ 信号`（Set 去重）→ `filterAllowedMentions` → **一次 dispatch、配额单计数**。现有 dispatch 递归一行不动。
- **预校验（防半成功 ACK）**：内部端点先校验目标合法性（会话成员 + 角色白名单），失败 4xx + reason → 工具返回错误 → 模型可见可纠正。
- **安全双层**：`--allowedTools mcp__catstudy__post_message` 白名单（只留一个入口）+ 随机 `SIGNAL_TOKEN`（每 spawn 生成、随 .mcp.json 下发 OS 临时目录、close 后删）。
- **复合键校验**：`activeStreams.get(agent.id)?.sessionId === 信号.sessionId`——防残留流误判、同 session 多 agent 不串扰；无活跃流拒绝自动清理 abort 残留。

### 三阶段

| 阶段                        | 内容                                                                                                                                                                                                                                                                                                                                       | Gate                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| **Phase 0 spike**           | `scripts/mcp-echo.mjs` 原生 JSON-RPC 2.0 stdio 实现 MCP 最小子集（initialize/tools/list/tools/call，~100 行零依赖）；claude.ts:83-93 同款 spawn 参数 + `--mcp-config` + 「调用 echo 工具」→ 验证 stream-json 出 tool_use 块、CLI 执行、tool_result 续流；顺带验证 `--allowedTools` 白名单语法 + `ENABLE_TOOL_SEARCH` 交互                  | go/no-go：不过 → 结构化记 blocked（外部限制），交付 Phase 2，如实向用户报告 |
| **Phase 1 结构化通道**      | `scripts/mcp-server.mjs`（1 工具 post_message）；`shared/types.ts:152-158` ChatOptions 加可选 `context?`；`llm/claude.ts` spawn 加 `--mcp-config` + `--allowedTools`、buildEnv 透传 context + SIGNAL_TOKEN；新 `routes/internal.ts`（token 校验 + 预校验 + 信号 Map）；socketio.ts:2108 传 context、:870 合并点；seed-data.ts P1/P2 prompt | spike 通过才动                                                              |
| **Phase 2 可见化 + prompt** | M1 末段内联 @ 告警 + 点名（复用 :917 模式）；M3 未知名 warn 不路由；P1 教「优先调 post_message、行首 @ fallback、叙述性提及用名字」；P2 出口检查三选一                                                                                                                                                                                     | **无论 spike 结果都做**                                                     |

### 验收标准

1. spike 产物留档（echo 执行 + 续流 + 白名单被接受）
2. 汇入式：流中信号 → mentions 写回含目标 + 一次 dispatch；无信号 → 与现状逐字节一致
3. M1 用 ds猫 历史失败形态（「位置：@店长 请收口」）重放 → warn + 点名 + 频控
4. 安全：复合键拒无活跃流信号；缺 token 拒；白名单拦截目标 → 4xx + reason 回模型
5. **双通道同目标** → mentions 写回一次、dispatch 一次、配额计 1；工具成功 + 末段嵌句 @ → M1 零告警
6. **正文完整无丢失**（parseClaudeCodeOutput 同事件内 text 丢弃的既有行为，MCP 放大它——实测复现则条件性修复）
7. 全 workspace 测试 + lint 全绿；`pnpm seed` 后 prompt 更新（运行配置字段不动）；提交 `catstudy [uuid]` 行号 grep 复核

### 边界

不改 DB schema（复用 mentions 列）；`parseMentionsFromReply` 语义不动（2b4a391 裁决）；用户消息协议不动；deepseek.ts/openai.ts/ollama 不动；不建收件箱（异步拉取语义与同步 dispatch 递归矛盾）；P3 公共常量收敛记后续。

---

## 二、评估系统

**客观指标先行 + llm as a judge 后置**（judge 独立离线流程读 DB 评分，不进 A2A 链——避免污染 execution_logs 指标、避免链路内角色自我评估漂移）。

- **已有 80% 观测面**：execution_logs 全生命周期（trace_id 贯穿 A2A 链、status/latency/error_message/prompt_chars/reply_chars/token 列）+ messages.dispatch_state 队列持久化 + `getAgentStats` 聚合函数已写好只差暴露。
- **首期两件事**：
  1. `routes/metrics.ts`——暴露已有聚合（执行统计、按 trace_id 拉全链路、token 汇总）
  2. **检索埋点**（新前置工程）——buildMemoryContext 记录「检索了哪些记忆、topK 命中 distance 分布」；是「召回质量」指标与向量 C 档数据驱动调参的唯一数据源
- **行为测试集**：独立 `eval/` 目录（场景 × 期望 × 断言 fixtures + 独立跑批脚本），不进 vitest include——vitest 测代码正确性，行为测试集测猫的行为质量。
- **真实 token usage**：claude.ts 未解析 `message_usage` 事件（现为 `estimateTokens` 字符估算）——与 MCP 方案的 Chunk 类型扩展合并做，一次改动两用。

---

## 三、向量库优化

现状：memories 普通表 + BLOB 列，`searchMemoriesByVector` 全表扫逐行求 `vec_distance_cosine`（无向量索引）；阈值 0.20/0.35/0.6 是拍脑袋默认。

| 档  | 优化                                                                                                                                            | 依赖                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| A   | 向量索引——**带 metric 决策**：rowid 表 + 自算 cosine（保阈值语义）vs vec0 虚拟表换 L2/内积 metric（**换表即动阈值链，0.20/0.35/0.6 全要重定**） | 可独立做                         |
| B   | 混合检索（整条 + 段落切分嵌入）治长消息语义稀释                                                                                                 | **评估基线**（否则无法度量变好） |
| C   | 换更强嵌入模型（如 bge-m3）/阈值数据驱动调参                                                                                                    | **检索埋点**（唯一数据源）       |

---

## 四、知识库

**可独立于评估基线先行**（语义价值独立，不欠评估债）。

- 独立 `knowledge` 表——对话原话实时嵌入层已退役（`memories` 表已 DROP，记忆写入口＝白名单 MD 切片进 `chunks` 三表），知识库是运营方维护的标准数据（接入文档/协议/领域标准），**不可被对话覆盖**——复用表加 type 列会让更新语义硬分叉，独立表天然隔离
- 复用 `embedText` 嵌入层；`searchMemoriesByVector` 写死 memories 表名需参数化（memories.ts:76-95）
- **独立【知识库】注入区块**，不混进【相关记忆】（来源权威性不同，检索语义不可混淆）
- 管理面：导入通道（seed 或独立端点），对话记忆自动入库语义不适用

---

## 立项顺序与依赖链

```
MCP v4（进行中）→ 评估首期（metrics 暴露 + 检索埋点）
  → 知识库（独立表，可与评估并行）
  → 向量 A 档（带 metric 决策）→ 向量 B/C（等评估基线）
  → llm as a judge（最后，独立离线流程）
```

依赖链一句话：**评估首期是后续一切「度量」的前置**——检索埋点喂 C 档调参、metrics 喂基线对比、judge 最后进；知识库是唯一不欠评估债的独立项。

---

## 开放问题（随实施推进逐项裁决）

1. spike 失败降级路径：Phase 2 先行交付、结构化记 blocked——倾向接受，不阻塞可见化收益
2. MCP server 落点 `scripts/`（mjs 零依赖）vs 新建包——倾向 scripts/，零 workspace 配置改动、零依赖审批
3. `--allowedTools` 白名单 vs `--disallowedTools` 黑名单——spike 双试定案，预判白名单可行（黑名单漏列一个工具就多一个入口）
4. 向量 A 档 metric 决策：保 cosine 阈值语义（rowid + 自算）vs 换 metric + 阈值数据驱动重调——开工时二选一
5. 行为测试集「度量什么」的维度设计——客观先行已定，judge 评分维度进第二阶段定义
