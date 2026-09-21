# R10 — 检索跑批基线（前置：R9 收口 + 用户复核闸 G6 通过）

**出处**：grill-with-docs 五问拍板（D1–D5 见 `R9-retrieval-golden-dataset.md` 决策清单）+ 用户「开票」授权。本票是**票二（跑批基线）**——把 R9 的黄金集变成「可复跑的数字」，供 bge-m3 切换、阈值校准（`MEMORY_MAX_DISTANCE` 默认 0.6，`packages/server/src/memory/index.ts:156`）等后续裁决当判据。

**开工条件（硬前置，缺一不动）**：① R9 收口（黄金集 + 校验脚本已审✅）；② 用户复核闸 G6 通过（负例全部 + 真实 12 条）。**派发对象届时由店长定**（R9 在飞期间本票只立不派）。

**基点**：届时 dev HEAD。改动面 = 新增跑批脚本 + 基线报告，零改动 server 运行路径 ⇒ 无需重启。

---

## 一、指标定义（接口契约，钉死——R10 之后所有「召回率」三个字以这里为准）

被测出口 = **全链最终注入节集**（D1）：从冻结改写文本出发，走改写之后的完整链段（跨查询合并 → 阈值过滤 → 节渲染），取最终注入 prompt 的节集合 `S`。

| 指标             | 定义                                                                                                                            | 回答的问题           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| **recall**       | 单条 = \|`expect` ∩ `S`\| / \|`expect`\|；集均 = 各条算术平均                                                                   | 该进的进了没有       |
| **阈值前命中率** | `expect` 中出现在 probe 池（`searchChunksHybrid` 融合池，`memory/index.ts:326`）但被阈值档杀（`dropped_reason` 阈值类）的节占比 | 0.6 阈值该不该松     |
| **负例判红**     | `forbid` 任一锚点出现在 `S` ⇒ 整条判红（不计入 recall 均值，单列红清单）                                                        | 死知识有没有混进注入 |

**两个读数分开报**：真实组（12）与构造组（28）各自出分，**不合成一个总分**（D4——两组测的是不同面：现有负载精度 vs 全域覆盖洞）。

## 二、跑批管线（`scripts/eval/retrieval-baseline.mjs`）

1. **前置闸**：先跑 `golden-check.mjs`（R9 产出），锚点腐烂即停
2. 读 `docs/eval/retrieval-golden.json` → 逐条取 `rewritten`（**跳过改写器**——D2 冻结纪律，跑批为纯确定函数）
3. 逐条走改写之后链段，记录：最终注入节集 + probe 池全貌（含被阈值杀掉的候选）
4. 汇总输出**基线报告**（`docs/eval/retrieval-baseline-<date>.md` 或同等形态）：两表（真实/构造）× 两指标 + 负例红清单 + 跑批参数快照（阈值/topK/poolN，对齐埋点表口径）

**必判（不许想当然）**：

- **嵌入供给**：链段要过嵌入，嵌入在 sidecar 进程（`scripts/flywheel/embed-server.mjs`，客户端 `packages/server/src/memory/embedding-client.ts:36`）。跑批是离线脚本——拉起独立 sidecar 还是复用客户端的自启动路径，**实测后定形态并写进交接文档**；禁止「假定 server 在跑」
- **DB 指向**：跑批打哪个库必须显式（默认实验库 `cat-study-dev.db`），报告里写明库路径与 chunks 行数——**基线数字脱离语料快照无意义**
- **索引新鲜度**：跑批前先确认 `chunks` 与语料同步（块数读数 + 必要时先 `pnpm flywheel:scan`），否则测的是旧索引

## 三、确定性验收（本票的命门）

- **B1 复跑字节级一致**：同一棵树、同一库连跑两遍，报告数值部分逐字节一致（日期戳除外——日期走参数注入，不许脚本内取系统时间污染 diff）
- **B2 canary 反对照**（测量工具的真空性）：构造一条**必中**条目（query 原文照抄某节标题）+ 一条**必不中**条目（语料外话题）⇒ 跑批必须把前者判满分、后者判零分；两条有任何一条不符 ⇒ 跑批脚本自身是恒绿/恒红假尺，禁止出报告
- **B3** 首份基线报告落盘（真实/构造两表 + 负例红清单 + 参数快照 + 库读数）
- **B4** `node scripts/lint.js` + 全量绿（脚本按惯例补测试）

**停手条件**：发现链段无法在不启动 server 的前提下复用（如 `retrieveMemoryContext` `memory/index.ts:247` 与 socket/会话态耦合）、或要为跑批改 `packages/server/src/**` 任何一行 ⇒ **报店长**，不自行扩面。

## 禁入

- `packages/server/src/**`（跑批只能调现成导出，不改实现）
- `docs/eval/retrieval-golden.json`（黄金集是 R9 已审产物；发现标尺问题 ⇒ 报店长回 R9 流程重标，**不许在跑批票里顺手改尺**）
- `.husky/**`、`.push-gate`

## 交付形态

- 单 commit：跑批脚本 + 测试 + 首份基线报告（过审查；基线报告若落 `docs/eval/` 同此 commit）
- 交接文档按 `request-review` 门槛补填；行号纪律同 R9（先 prettier → 再 grep → 提交后复核）

## 挂账（R9/R10 之外，已明牌）

- 改写器质量评估（D2 代价面，另立单）
- bge-m3 切换闸门：本票基线出数后，切换裁决 = 「新模型 recall 不掉点」
- MRR / 位置效应（注入排序层）、负收益率（注入消费侧）、索引覆盖率读数（扫描器 skipped 汇总出口）——均挂后续，见 grilling 盘点清单

---

## 修订 #1（2026-09-19，店长裁定：解禁 `memory/index.ts` 纯抽取， ds猫 停手报裁的响应）

**缘由**（双方独立核验一致）：票面「从冻结改写出发、跳过改写器」在现有代码**无入口**——`retrieveMemoryContext`（`memory/index.ts:247`）把查询集锁死在内嵌改写器（`:276-277`），导出签名无注入点；改写缓存是模块私有**内存 Map**（`query-rewrite.ts:40`，`clearRewriteCache` 只清不写），外部进程无法预热。基线数字必须真代表生产行为（bge-m3 切换、阈值校准拿它当判据），故采纳 ds猫 甲案：**抽链段**，否乙（复制 ~70 行第二实现会静默漂移）、否丙（改口径则 D1 契约作废）。

**禁入修订**：禁入清单中 `packages/server/src/**` 收窄为「除 `packages/server/src/memory/index.ts` 的**纯抽取**外」。其余禁入不变。

**§A2 接口契约（新增，审查锚点）**：

- 新导出 `runRetrievalChain(queries: string[], opts?: { startedAt?: number }): Promise<MemoryContextResult>`——承载 `:279` 起的全部链段（逐查询嵌入降级 → 混合检索 → 跨查询 RRF 合并 → 阈值过滤 → 节补齐 → 预算截断 → 渲染），参数/threshold/budget 仍读 env，**不加新旋钮**（保生产/跑批口径自动同源）
- `queries[0]` = 原始查询（探针池「原话优先」语义依赖顺序）；**去重挪进链段入口**（幂等，脚本侧不再自担——漏去重会让重复查询的 RRF 分双倍计）
- `retrieveMemoryContext` 瘦身为：enabled 闸 → 剥 mention → 空查询闸 → 改写 → 调 `runRetrievalChain`，并把自己的 `t0` 经 `startedAt` 传入——**`retrievalMs` 口径不变**（含改写耗时），这是埋点面零漂移的硬要求
- 零行为变更举证：纯代码搬移（diff 层面可核）+ 既有 `memory/index.test.ts` 断言**一行不改**全绿（它对 queryTraces/降级/渲染的断言就是回归网）

**验收增补**：

- **B5 降级硬闸**：任一条目 `reason !== 'ok'` 或 `queryTraces[].queryEmbedOk` 不全 true ⇒ **拒绝出报告**（非零退出、不落文件）——ds猫 实测暴露的坑：sidecar 撞端口致部分查询嵌入失败时 `reason` 仍可能 `ok`，向量通道静默缺席 ⇒ 假读数无声产生
- **B6 空库闸**：跑批启动探针——`chunks` 行数 > 0 且 `doc_path` 去重数 == golden-check 的 `liveDocs`（当前实测 395 行 / 13 份），不符即拒跑。`DB_PATH` 是模块级常量（`db/index.ts:16`）env 覆盖不了，脚本必须 `setDb()` 显式注入真库，否则静默建空库跑全零
- 嵌入供给形态已实测定案：`EMBED_SIDECAR_PORT=0` 动态端口独立 sidecar（避开活 server 的 3210），跑完 `stopEmbeddingSidecar()` 显式回收——「必判」第一条据此销项

**重启面修订**：基点行「零改动 server 运行路径 ⇒ 无需重启」自此**作废**——本票含 server 源码改动（纯抽取），落地后需重启，归收口链发起。
