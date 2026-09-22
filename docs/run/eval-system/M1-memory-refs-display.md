# M1 票：回复下方展示所用记忆（**读侧 + 出口，零模型**·待派）

> 来源：用户 2026-09-22。原话「索引是想记录回复用到了哪些检索到的记忆文档，方便判断使用率，以及方便用户判断真实性」→ 用户拍板：**不再手写引用面**（店长自述不可验证），改为**产品功能**；展开形态选**乙**（库内看片段 + 次级链接开当前文档）。
> 定位：**独立票**——零模型、不动检索行为，只补读口与出口。
> 状态：**未开工 · 待派**。
> 行号基线：`dev` 当轮 HEAD。**实施者落笔前按自己那棵树重取一遍**。

## 一、数据面已经端到端通了（本票不重做）

链路：`execution_logs.message_id`（= 回复消息 id）→ `retrieval_events.execution_id` → `retrieval_queries` → `retrieval_candidates`。

`retrieval_candidates` 行已带：`doc_path` / `section_anchor` / `breadcrumb` / `content_hash` / `body_head`（2026-09-22 起落**全文**，此前截 120 字）/ `status_at_query` / **`injected`** / `section_rank` / `injected_position` / `dropped_reason`。

⇒ 「这条回复注入了哪几节、排第几位、哪些没进去及为什么」**一条 SQL 全能答**，且**没注入的候选也在**（`dropped_reason` 五种因）。

## 二、缺的两块

**读侧**：`db/repository/retrievalEvents.ts` 只有 `getRetrievalQueries(retrievalId)` / `getRetrievalCandidates(retrievalId)`——**没有按 `message_id` 取的口，也没有路由**。现有 `/api/eval/*` 读的是跑批报告 JSON，**不是每条回复的真实流水**。

**出口**：`packages/web/src/components/MessageItem.vue` 的 `msg-footer` 还没有这一行。

## 三、接口契约（钉死）

### 服务端 1｜批量读口

`db/repository/retrievalEvents.ts` 新增按 **message_id 列表**取的口（防 N+1）：

- 入参：`messageIds: number[]`
- 出参：按 message id 分组的**已注入节**列表，每条含 `docPath` / `sectionAnchor` / `breadcrumb` / `sectionRank` / `injectedPosition`
- **只取 `injected = 1` 的行**（`probe` 行与未注入的 `final` 行不进 UI）
- ⚠️ 一处口径必须写进注释：`body_head` 是**命中片**的全文，而真正注入 prompt 的是 `getChunksBySection()` 补齐的**整节**。二者不等价，UI 文案与展开内容都不得声称「猫当时读到的就是这段」。

### 服务端 2｜REST 路由

- `GET /api/sessions/:id/memory-refs?messageIds=1,2,3` → `{ [messageId]: MemoryRef[] }`
  - 空数组与「消息不存在」要可区分
  - **必须校验消息属于该 session**（本仓已有跨会话越权前科）
- `GET /api/memory/doc?path=docs/adr/xxx.md` → 文档正文（形态乙的次级链接）
  - **白名单锁死 `SCAN_PREFIXES`**（`scripts/flywheel/scan.mjs` 导出，值 = `['docs/adr/', 'docs/lessons/', 'docs/plans/']`）——**从该常量导入，禁止在路由里另抄一份字面量**（同一规则两处措辞 = 本仓明令的假绿源）
  - 路径穿越守卫：`path.resolve` 后校验仍在白名单前缀内，拒 `..` / 绝对路径 / 盘符 / 反斜杠变体
  - 只读、不写、不缓存

### 前端｜底部一行（形态乙）

- `ChatPanel.vue`：消息列表就绪后**拉一次**批量口（不是每条消息各拉一次）；结果存 map
- `messageViews` 计算属性里补 `memoryRefs` 字段，按**标量/已格式化**传给 `MessageItem`
- `MessageItem.vue`：`msg-footer` 内新增一行
  - 有注入：`📎 记忆 3 条：<a>文档甲</a> / <a>文档乙</a> / <a>文档丙</a>`
  - 无注入（检索跑了但没节入选）：`未使用记忆`
  - **未检索**（`reason` 为 `skipped-a2a` / `not-enabled` / `empty-query`）：与「无注入」**分开显示**——这是「使用率」的分母口径，混在一起会把「压根没查」算成「查了没用」
  - 点文档名 → 抽屉显示该片当时全文（来自库）；抽屉内「打开当前文档」→ `GET /api/memory/doc`

⚠️ **硬契约（不得违反）**：`MessageItem.vue` 的存在意义是 O(1) 重渲染——它**不许自己 filter 整个消息数组**。所有判定必须由父组件在 `messageViews` 里算完，以标量 prop 传入（见 `ChatPanel.vue` 里 `MessageItem` 调用处的注释与现有 props 形状）。

## 四、验收标准（可证伪，逐条要读数）

- **A1｜与库对账**：任取一条有检索记录的回复，UI 显示的条数 == 该 message 在 `retrieval_candidates` 里 `injected=1` 的**不同节数**（SQL 对照，贴两条读数）。
- **A2｜三态可分**：有注入 / 无注入 / 未检索 三种显示互不混淆；各贴一条真实消息为例（含 `skipped-a2a` 一例）。
- **A3｜穿越守卫（承重）**：`?path=../../etc/passwd`、`?path=/etc/passwd`、`?path=docs/run/map.md`（白名单外）、`?path=docs/adr/../../../x` —— **四种全部被拒**，且拒绝原因是白名单/穿越而非 404。**反对照**：`?path=docs/adr/<真实文件>` 正常返回。
- **A4｜无 N+1**：一页 50 条消息 ⇒ 网络面板只有 **1 次** `memory-refs` 请求；无检索记录的消息不产生额外请求。
- **A5｜越权**：用 session A 的 id 请求 session B 的消息 id ⇒ 拒绝（不得静默返回空）。
- **A6｜渲染契约不破**：`MessageItem.vue` 内未新增对 `props.msg` 之外消息集合的遍历；改动后流式回复期间单 chunk 仍只重渲染流式气泡（贴改动后的 `messageViews` 传参形状）。
- **A7｜回归**：`pnpm test` 全绿；`pnpm lint` 过。

## 五、明写不做

- 不动检索行为：`memory/index.ts` / `chunks.ts` / `query-rewrite.ts` **零改动**。
- 不动 `retrieval_*` 三表 schema，不新增列。
- **不做聚合看板**（按文档/节的注入次数、五种丢弃原因分布）——那是 `E1-retrieval-eval-visualization.md` 的射程，本票只做「单条回复」。
- 不在 UI 上暴露 `probe` 行 / 未注入候选 / `dropped_reason`（数据在库，出口留后票）。
- 不做 GitHub blob 外链（形态丙已被否：看到的是当前分支而非当时快照，判真实性会误导）。

## 六、参考

- 三表契约与落库：`P2-design-retrieval-events.md`
- 看板方向（本票不做）：`E1-retrieval-eval-visualization.md`
- 白名单常量：`scripts/flywheel/scan.mjs` 的 `SCAN_PREFIXES`
- 渲染契约说明：`packages/web/src/components/ChatPanel.vue` 里 `MessageItem` 调用处注释
