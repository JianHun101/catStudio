# 知识库 Phase 1 落地计划（v3，审查复核版）

> 方向基准：docs/roadmap.md 四·知识库。本计划把 roadmap 概要落成可执行规格
> （组件边界 + 接口契约 + 验收标准），供吐槽猫独立实核审批。审批通过后由
> 店长拆活派 ds猫/flash猫 实施。
>
> 关联调研：clowder-ai mcp-server 工具面（db-tools.js / shell-tools.ts 源码实读）。
>
> 修订记录：v1 经吐槽猫实核 ⚠️建议修改（1 关键裁决 + 2 事实性错误 + 3 规格
> 缺口）；v2 逐项修正——①黑名单恢复裁决（问题 1，见组件边界后裁决段）；
> ②#3 路径改 db/index.ts（问题 2）；③3.3 调用点改 socketio.ts:2103（问题 3）；
> ④3.2 阈值语义纠正（问题 4）；⑤3.5 seed 异步化规格（问题 5）；⑥3.4 测试
> 策略补齐（问题 6）；⑦3.3 检索通道与 3.2 表名安全边界（问题 7/8）。
> v3 复核修订（吐槽猫 v2 复核）——①验收 #8 升级为 28 工具全列精确比对
> （原「含 Bash 且非空」判据拦不住删减：10070d1 删到剩 25 个时同含 Bash 且
> 非空）；②验收 #1 补「嵌入成功路径」注明（与 3.5 降级存 NULL 交互，防 CI
> 误报）；③二·五补「仅 context 时加」条件（claude.test.ts:196-197 基线，
> 验收 #6 依赖）。

---

## 一、背景：知识库查询通道裁决（clowder-ai 实证）

**调研结论（源码实读）**：clowder-ai 的数据库查询**不走 shell**——shell-tools.ts
命令白名单全文六类（pwd / ls / cat / git log|status|rev-parse / git diff / git show），
**没有 sqlite3、没有任何 db 命令**。它压根不让模型通过 shell 碰数据库，而是走
独立 MCP 工具 `query_db`（db-tools.js：参数 `{ sql, params?, limit? }`，工具内部
Node 直连 SQLite，参数化查询）。

**裁决**：猫咖知识库查询通道 = **专用 MCP 工具，不开放 shell、不开放 raw SQL**。

- 与 clowder-ai 同构的部分：查询能力只经工具面暴露，shell 白名单零扩展。
- **与 clowder-ai 的形态差异**：它是 raw SQL 工具（产品需要模型查业务库），
  我们做**语义检索工具** `search_knowledge({ query, topK? })`——猫咖模型需要的
  是「检索知识文档」，不是「任意 SQL」；raw SQL 会把 messages / memories /
  execution_logs 全表暴露给模型（模型按会话隔离原则被 context 过滤，但 SQL
  通道绕过滤直接读全库），越权面过大。检索工具服务端只拼参数化 embedding
  检索 SQL，模型不可注入。

---

## 二、组件边界

| #   | 组件                                                  | 动作     | 说明                                                                                                                                                                          |
| --- | ----------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `packages/server/src/db/repository/knowledge.ts`      | **新建** | knowledge 表仓库：insertKnowledge（含向量）、searchKnowledgeByVector                                                                                                          |
| 2   | `packages/server/src/db/repository/memories.ts:76-95` | 修改     | `searchMemoriesByVector` 加可选 `table = 'memories'` 参数（默认零行为变化）；knowledge.ts 复用同一查询体                                                                      |
| 3   | `packages/server/src/db/index.ts`                     | 修改     | initDb() 的 CREATE TABLE 块新增 knowledge 表 + migrations 数组加迁移（additive，try/catch 幂等）——**本项目无 db/migrations.ts，建表与迁移全在 db/index.ts**（吐槽猫实核纠正） |
| 4   | `packages/server/src/memory/index.ts:235`             | 修改     | `buildKnowledgeContext(triggerContent)` 独立函数：检索知识库 → 输出独立【知识库】区块；`buildMemoryContext` 不动（【相关记忆】零污染）                                        |
| 5   | `packages/server/src/llm/claude.ts:137-138`           | 修改     | `--allowedTools` 白名单扩为 `mcp__catstudy__post_message, mcp__catstudy__search_knowledge`（白名单加一，仍是收窄安全面）                                                      |
| 6   | `scripts/mcp-server.mjs`                              | 修改     | 新增 `search_knowledge` 工具（复用现有 MCP 子集协议与 stdio 通道）                                                                                                            |
| 7   | `packages/server/src/routes/internal.ts`              | 修改     | 新增 `POST /api/internal/knowledge-search`（复用 SIGNAL_TOKEN 鉴权链）                                                                                                        |
| 8   | `packages/server/src/seed.ts` / `scripts/seed.js`     | 修改     | 知识库初始文档导入（seed 通道；独立端点管理面记后续）                                                                                                                         |
| 9   | `packages/server/src/llm/claude.ts:32`                | 修改     | `BUILTIN_TOOLS_DISALLOWED` 恢复 e5aa54d 的 28 工具全列（当前为空串 `[].join(',')`，10070d1/00a9a95 裸提交静默清空）——见下方关键裁决                                           |

**谁不动**：dispatch / socketio.ts 合并点 / route-signals / mention-policy /
deepseek.ts / openai.ts / web。知识库是「读增强」，不进 A2A 链路。

---

## 二·五、关键裁决（吐槽猫审查问题 1）：恢复内置工具黑名单，纳入本单

**现状（已实核）**：e5aa54d 列全 28 工具黑名单——spike case 7 实证
`--allowedTools` 白名单**管不到内置 Bash**（case 6：bypassPermissions 下照调），
必须显式 `--disallowedTools` 黑名单才能收窄内置工具面。后续 10070d1（删
Read/Glob/Grep）、00a9a95（删完剩余全部）两个裸 `catstudy [uuid]` 提交无任何
rationale 逐步清空，当前 `const BUILTIN_TOOLS_DISALLOWED = [].join(',')` 是
**空串**。

**影响**：`--permission-mode bypassPermissions` + 空黑名单 = 模型在聊天回复中
**可调全部内置工具**（Bash/Read/Write/Agent/Workflow…），Bash 可直读全库——
本计划「不开放 shell、不开放 raw SQL」的安全裁决在空黑名单基线上**名存实亡**，
search_knowledge 的工具面收窄毫无意义。

**裁决**：恢复 e5aa54d 的 28 工具全列（含只读工具 Read/Glob/Grep——聊天回复
场景模型只需 post_message + search_knowledge + 文本；10070d1 删只读工具亦无
rationale，恢复原状）。若未来需要「模型回复时读文件/开子代理」，走 e5aa54d
OQ① 已记录的另立项路径，不在本单放开。黑名单恢复与 search_knowledge 工具面
是同一安全目标的两半，必须同批落地。

**加注条件（吐槽猫复核补）**：黑名单保持**仅 context 分支加**（`--disallowedTools`
参数只在 context 存在时拼入 args，claude.test.ts:196-197 有基线断言「无 context
参数不在」）——恢复动作不改变加注条件，无 context 调用路径零参数变化
（验收 #6 依赖此条件）；实施时禁止顺手重构为无条件加。

---

## 三、接口契约

### 3.1 knowledge 表（migrations additive）

```sql
CREATE TABLE IF NOT EXISTS knowledge (
  id         TEXT PRIMARY KEY,
  content    TEXT NOT NULL,
  embedding  BLOB,              -- 512-dim f32，同 memories.embedding 格式
  source     TEXT,              -- 来源标注（文档名/URL）
  tags       TEXT,              -- JSON 字符串数组，检索过滤预留
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)
```

独立表（不加 type 列混进 memories）：对话记忆可被 UPDATE 修正（去重三段式），
知识库是运营方维护的标准数据，**不可被对话覆盖**——复用表会让去重/更新语义
硬分叉（roadmap 已定，保持）。

### 3.2 searchKnowledgeByVector

```ts
// 复用 searchMemoriesByVector 查询体（表名参数化），maxDistance = 0.35
searchKnowledgeByVector(queryBlob: Buffer, topK: number, maxDistance = 0.35)
```

- **阈值语义纠正（吐槽猫问题 4）**：0.35 **不是**「同阈值链」——去重三段式的
  0.35 是 **UPDATE 阈值**，与检索无关；检索阈值是另一条线（对话记忆
  `MEMORY_MAX_DISTANCE = 0.6`）。知识库检索用 0.35 是**比对话记忆检索更严**
  的阈值（知识文档语义密度高、宁缺毋滥），不是沿用任何既有检索值。
- **表名参数化安全边界（吐槽猫问题 8）**：`table` 参数仅内部字面量——调用点
  写死 `'memories'` / `'knowledge'`，repository 入口白名单校验（非二者抛
  TypeError），参数来源**永不放宽到外部输入**（防未来实现者把参数改从请求体
  透传）。

### 3.3 【知识库】注入区块（system prompt 拼接）

`buildKnowledgeContext` 输出形态（无匹配返回空串，同 buildMemoryContext 约定）：

```
\n\n【知识库】\n1. <content>\n2. <content>
```

与【相关记忆】并列独立区块——来源权威性不同（运营方标准数据 vs 对话记忆），
检索语义不可混淆。

- **调用点（吐槽猫问题 3 纠正）**：**socketio.ts:2103**（runAgentReply 组装处，
  buildMemoryContext 同款位置）——claude.ts 是 spawn 参数面，不是 prompt 组装
  面。实现与 buildMemoryContext 相同防护形态：`Promise.race([buildKnowledgeContext(...),
超时])` 超时降级空串 + catch 空串（MEMORY_TIMEOUT_MS 同款），结果拼进
  `llmMessages[0].content`。
- **检索通道（吐槽猫问题 7）**：**单向量**（query 原样 embedText）——不改写
  双通道。改写通道服务于用户口语化 query（对话记忆检索场景），知识库查询由
  模型生成的结构化 query 发起，无口语歧义需求；命中为空 → 返回空串不注入，
  不降级模糊匹配。

### 3.4 MCP 工具 search_knowledge

```jsonc
// tools/call 入参（mcp-server.mjs 参数校验，失败返回错误文本含 reason）
{ "query": "非空字符串", "topK": "可选，1-10 整数，默认 3" }
// 返回：工具文本 = 检索结果 JSON 或错误文本（含 reason，模型可见可纠正）
```

- 服务端实现：POST `/api/internal/knowledge-search`，body `{ query, topK }`
- 鉴权复用现有链：`x-signal-token` + activeStreams lookup + 复合键 sessionId
  （internal.ts 既有校验顺序 1-4 直接复用；知识库检索无「目标猫」语义，跳过
  第 5 步目标预校验）
- 失败一律 4xx + reason（消灭半成功 ACK，与 post_message 同款）
- **测试策略（吐槽猫问题 6 补齐）**：参数校验抽为 mcp-server.mjs 可导出纯函数
  `validateSearchParams`（`{ query, topK? }` → 校验通过或错误文本），
  `scripts/mcp-server.test.js` 单测覆盖（vitest include 已匹配 scripts
  `**/*.test.js`）；工具面本体保持 spike 留档模式（不做 spawn 子进程级测试）；
  端点侧 knowledge-search 由 internal.test.ts 覆盖——三层分治，不复制历史
  「只靠端点测试覆盖 body 边界」的单层做法。

### 3.5 seed 导入

- seed-data.ts 增知识文档条目（初始 2-3 条：项目接入文档/领域标准类），
  id 固定（uuid.v5 同款命名空间）→ ON CONFLICT 幂等
- **seed 异步化（吐槽猫问题 5 补齐）**：seed.ts 当前同步入口（`function seed(): void`
  - 顶层裸调用 `seed()`），而 embedText 是 async（首次触发 ~100MB 模型下载）。
    改造：`async function seed()` + 末尾 `seed().catch(...)` 显式报错退出码；
    知识文档 INSERT 走 `await embedText(content)`；嵌入失败（embedText 抛错）→
    捕获后 embedding 存 NULL + warn，**不阻塞 seed 主流程**（重跑幂等补齐）
- **seed.test.ts 适配面为零**（已实核）：现有测试只测 seed-data.ts 纯数据
  （buildDemoAgents），不跑 seed() 执行体——只需新增知识条目断言（确定性 id /
  非空 content / 幂等 id 固定），不触发真 embedding

---

## 四、验收标准

1. 迁移后建表成功；seed 导入 2-3 条 → 表内有对应行 + embedding 非 NULL
   （**嵌入成功路径**——嵌入失败按 3.5 降级存 NULL + warn，此时本条断言不
   适用，防 CI 首次触发 ~100MB 模型下载被限时误报）
2. `searchKnowledgeByVector` 命中相关文档且 topK 排序正确（distance 升序）
3. **回归基线**：searchMemoriesByVector 表名参数化后默认行为与现状逐字节一致
   （memories.test.ts 全绿即证）
4. 【知识库】区块独立出现在 prompt；【相关记忆】内容零污染（无知识库条目混入）
5. search_knowledge 工具：`validateSearchParams` 单测覆盖（合法入参通过 /
   空 query / topK 越界 → 错误文本）；端点合法调用返回检索结果 JSON；错误
   文本含 reason；未知工具错误文本不变
6. 白名单双工具并存：post_message 零回归（既有 internal +11 用例全绿）；
   无 context 调用路径零参数变化（claude.ts 既有基线用例全绿）
7. 全 workspace 测试 + lint 三包全绿；提交 `catstudy [uuid]` 行号 grep 复核
8. **黑名单恢复（关键裁决验收）**：claude.ts 的 BUILTIN_TOOLS_DISALLOWED 恢复
   e5aa54d 的 28 工具全列；claude.test.ts 新增断言 **全列精确比对**（吐槽猫复核
   升级）：测试内定义 28 工具期望数组 `EXPECTED_DISALLOWED`（基准：Bash, Read,
   Write, Edit, Glob, Grep, NotebookEdit, WebFetch, WebSearch, Agent, Workflow,
   TaskCreate, TaskUpdate, TaskGet, TaskList, TaskOutput, TaskStop, SendMessage,
   AskUserQuestion, EnterPlanMode, ExitPlanMode, EnterWorktree, ExitWorktree,
   ScheduleWakeup, CronCreate, CronDelete, CronList, Skill），断言
   `args[args.indexOf('--disallowedTools') + 1] === EXPECTED_DISALLOWED.join(',')`
   ——「含 Bash 且非空」判据拦不住删减（10070d1 删到剩 25 个时同样含 Bash 且
   非空，历史实证），全列比对才是防静默清空/删减再犯的完整闭环；同时保持
   **仅 context 分支加**（无 context 分支既有基线断言参数不在，
   claude.test.ts:196-197，与验收 #6 同源）

---

## 五、边界（不做）

- 不做向量索引（A 档另立项，带 metric 决策）
- 不做 raw SQL 工具（本计划安全裁决）
- 不做知识库管理端点（导入通道 seed 先行，独立端点记后续）
- 不改 memories 表语义 / 去重三段式阈值链（0.20/0.35/0.6 不动）——0.35 仅
  去重 UPDATE 阈值，与知识库检索 maxDistance=0.35（检索值，语义不同）互不干扰
- 不做对话自动入库（运营方标准数据语义不适用，roadmap 已定）
- 不碰 MCP v4 既有面：post_message 工具、内部端点校验链、socketio 合并点零改动

---

## 六、Open Questions（随实施推进裁决）

1. 知识库检索 maxDistance=0.35 是否需要数据驱动微调——知识文档语义密度高于
   对话记忆，0.35 已比记忆检索（MEMORY_MAX_DISTANCE=0.6）更严，首期定 0.35
   先行、检索埋点（评估首期）落地后数据驱动微调
2. search_knowledge 是否纳入 M1 防线检查范围——当前 M1 只盯 @ 形态，知识库
   工具调用失败（如 query 为空）是否需要可见化告警，首期不纳入
3. 【知识库】区块是否全量注入还是按查询命中注入——按命中注入（本计划），
   若未来知识库条目增多需 topK 配额管理
