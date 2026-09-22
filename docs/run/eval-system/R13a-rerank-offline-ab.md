# R13a 票：cross-encoder 离线三臂对照（**先证有效，再谈接入**·待派）

> 来源：R13 票 §五 S0–S4 的**前置拆分**。用户 2026-09-22 拍板：① reranker 用主流模型；② 先把这几条跑完再看。
> 拆分理由：R13 原票 S2（接入生产链）改的是**猫实际读到的记忆**（行为变更）；而 S0/S1 + 离线跑批**不改任何生产行为**就能拿到全部读数。**先出数、后接链**——三臂读数若证明增量不足以覆盖新增固定开销，S2/S3 整段不必开工。
> 状态：**未开工 · 待派**。R13b（接入 + 降级 + 生产 A/B）= 原票 S2/S3/S4，**等本票读数出来由用户拍**。
> 行号基线：`dev` 当轮 HEAD。**实施者落笔前按自己那棵树重取一遍**。

## 一、要回答的唯一问题

**在同样 ≤3 节注入量下，cross-encoder 重排能否拿回「`MEMORY_TOP_K` 放到 20 才够得着」的那些锚点？**

背景读数（T3 已复现，不重跑）：

| 做法              | 注入量   | 恢复                  |
| ----------------- | -------- | --------------------- |
| topK=3（现状）    | 2.73 节  | 0/11                  |
| topK=5            | 4.36 节  | 3/11                  |
| topK=20           | 逼近预算 | 8/11                  |
| **重排 + topK=3** | ≤3 节    | **？** ← 本票要出的数 |

## 二、三臂定义（同一库快照 + 同一冻结黄金集 `docs/eval/retrieval-golden.json`）

- **臂①** 现状：topK=3 + RRF 序
- **臂②** 最便宜替代：topK=5 + RRF 序（一行配置）
- **臂③** 本票主体：topK=3 + cross-encoder 重排（只改序、不改成员）

判据（写进报告，不许只给绝对恢复数）：

- 臂③ ≥ 臂② ⇒ **有效**
- 臂③ ≈ 臂② 且注入量明显更少 ⇒ **「等价但更省注入」**，这是可写的收益，不是零
- 臂③ = 臂① 或 < 臂② ⇒ **据实关票**，结论写「瓶颈在池的成员，不在序」

⚠️ **臂② 没有 CLI 旋钮**：`retrieval-baseline.mjs` 的 CLI 只有 `--root/--db/--env/--date/--out`（见 `main()` 里 `bootstrap(process.argv.slice(2))` 的参数解析），topK 由 `MEMORY_TOP_K` 决定 ⇒ 走 `--env <临时 .env>` 面注入，**不要改脚本加旋钮**（那会把跑批工具变成被测对象）。

## 三、S0（**停损点**）：模型可得性实测

选型（用户已拍「主流」，不指定具体型号）：

- 首选 `Xenova/bge-reranker-base`（中文场景主流 bge-reranker 系的 ONNX 现成版）
- 备选 `Xenova/bge-reranker-v2-m3`（多语言更强，CPU 上明显更慢）
- 以上均为**待实测假设**，不许凭印象当结论。

S0 必须报出（四项，缺一不算过）：

1. 权重可得性（实际下载成功 / 体积）
2. tokenizer 可用
3. `@huggingface/transformers@4.2.0`（`packages/server/package.json` 已装）下用哪个 pipeline（`text-classification` 或 `feature-extraction`）能出**成对分数**
4. **单对延迟 + 批量延迟曲线**（N = 1 / 16 / 32 / 64 / ≥80）

不可得 ⇒ 停损关票，把实测证据（报错原文 / 404 / 体积）写进票面，**不许静默换模型硬凑**，也不许改成别的重排方案。

## 四、S1：sidecar 加 `POST /v1/rerank`

- 落点：`scripts/flywheel/embed-server.mjs`，复用既有 `createServer` / `GET /health` / listen 握手契约，**不新增常驻进程、不新增 npm 依赖**。
- ⚠️ **票面原缺口**：现 `MAX_BATCH = 64` 是 `POST /v1/embeddings` 的上限，而本票候选去重后**可能超过 64**（合并序上限 ≤80，实测量级见 T3 `finalRank` 最大 44）。S1 必须**显式定批量策略**（进程内分批 / 提高上限 / 单请求带 `batchSize` 参数），并在票面回填实际取值。
- **不做**：不把模型加载提到 import 期（原文件明写「import 期不加载模型」）；不阻塞 `/health` 握手。
- 失败契约照 `memory/embedding-client.ts` 的 `{ok:false, reason}`：**不返回空序**。

## 五、S2′：离线跑批（**关键边界——不改生产链路**）

- `packages/server/src/memory/index.ts` 的 `takenSections` 循环、`runRetrievalChain`、`reply.ts` 的记忆注入段：**本票一行不改**。
- 做法：在**跑批侧**重建 `ranked` 全序（`scripts/eval/retrieval-attribution-recheck.mjs` 的重建侧已有同源代码，T5 已把它修成跟生产走——**优先复用，别另写一份**），对全序调 sidecar `/v1/rerank`，重排后取 topK=3，算 recall。
- **配对规则**（合并时一片可能被多趟查询命中）：取 **argmax 贡献趟**——即哪趟给该片贡献的 `rrfScore` 最大就用哪趟与它配对。现内存态只有「首趟命中」的 `queryIndex`，**需在重建侧自行记录贡献趟**（重建侧可自由加字段，因为不改生产）。
- **不截池**：全序一条不砍送打分。截池会让 `finalRank=44` 那类锚点永远救不回，与 R13 立项理由直接冲突。
- ⚠️ 跑批脚本的重建侧若与 `index.ts` 有分叉，**以 `index.ts` 为准**，并把分叉点写进报告。

## 六、验收标准（可证伪，逐条要读数）

- **A1｜三臂读数表**：11 处未召回锚点的**逐条 before/after 名次**，三臂各自 recall；臂③ 相对臂② 的增量单独列出。
- **A2｜负例不劣化（承重）**：negative 组 5 条判红数**不得上升**（现制 4/5，A2 防"召回暴涨稀释精度"）。
- **A3｜延迟（必给读数）**：
  - 重排段自身的耗时分布（p50 / p95），以及**加到检索总耗时后的**预计 p50 / p95
  - 硬条款：**超时率不得高于 0.86% 基线**（现网 `reason=timeout` 8/928；基线就在库，可直接对账）
  - 辅：p95 绝对值 ≤ 5s
  - ⚠️ 现网尾部**贴着 10s 闸**（`ok` 里最慢 9836ms），加固定开销最可能的后果是把 `ok` 推成 `timeout`——**而 timeout 的后果是整段记忆不注入**（`reply.ts` 的 `Promise.race` 返回 `null`）。报告必须给这条推演，不许只报「平均没变慢」。
- **A4｜确定性**：同输入连跑两遍，跑批 json 与 md **各自 sha256 全等**（B1 已确立，重排不得引入随机性）。
- **A5｜尺子自证不破**：跑批 canary（必中 + 必不中条钉在同一锚点）仍 ✅；两条不符即拒出报告的行为不变。
- **A6｜回归**：`pnpm test` 全绿；`pnpm lint` 过。
- **A7｜诊断脚本自证**：主动跑一次 `retrieval-attribution-recheck.mjs`，确认其承重自证未被打断（T4 有前科）；断了就**另立票**，别静默放过。

## 七、明写不做

- 不接生产链路（`memory/index.ts` / `reply.ts` 零改动）——那是 R13b，等读数。
- 不动 `MEMORY_TOP_K` 默认值、不动 `MEMORY_MAX_DISTANCE`、不动 `HYBRID_CHANNEL_TOP_N` / `HYBRID_POOL_PER_QUERY` / `RRF_K`。
- 不改 `chunks` 三表、不新增列、不落库重排分（那是 R13b 的决策 3）。
- 不改黄金集（R9 冻结改写器：**禁手写**）。
- 不换嵌入模型、不动扫描器 / 索引侧。

## 八、复现 / 参考

```bash
# 跑批（在 worktree 内跑；库在主仓库，worktree 里没有 data/*.db）
node scripts/eval/retrieval-baseline.mjs --db "<主仓库>/packages/server/data/cat-study-dev.db" --date <日期>
```

- 母票：`R13-cross-encoder-rerank.md`（§四 三决策 / §七 风险 / §九 明写不做）
- 归因与修法候选：`T3-retrieval-optimization-diagnosis.md`（§五 差几名 / §6.2 已排除项 / §九 候选 1-5）
- 末次截断节级语义：`T4-section-truncation-resweep.md`、`T5-recheck-section-adapt.md`
