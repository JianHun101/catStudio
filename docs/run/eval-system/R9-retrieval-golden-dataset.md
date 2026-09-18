# R9 — 检索黄金集建集（RAG 评估第一刀：召回率标尺）

**出处**：grill-with-docs 五问全拍板（2026-09-18，决策 D1–D5 见下）+ 用户「开票」授权。本票是**票一（建集）**；票二（跑批基线）见 `R10-retrieval-eval-baseline.md`，**前置 = 本票收口 + 用户复核闸通过**。

**基点**：dev `44c1d3b`。产出全部是新文件（`docs/eval/` + `scripts/eval/`），零改动既有源码 ⇒ **落地无需重启**。

**走 worktree。**实施 = ds猫（D5）；店长逐条审标注；用户复核闸 = 负例全部 + 真实 12 条。

---

## 决策清单（票面本体，grilling 终审版——不得擅自偏离，偏离即停手报店长）

| #   | 决策     | 内容                                                                                                                                                                                                                                                                                                                  |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 测什么   | 标注粒度 = **节**（`doc_path + section_anchor`，**不带** `content_hash`——片级哈希随语料腐烂，与埋点表不用 `chunks.id` 同理，`retrievalEvents.ts:179`）；被测出口 = **全链**（改写之后的完整链段：跨查询合并 → 阈值过滤 → 节渲染后的最终注入节集）；指标 = recall + 阈值前命中率双读数（R10 落地，本票只为它们供数据） |
| D2  | 怎么复跑 | **标注时冻结改写**：条目 = 原 query + 冻结改写文本 + 应命中节集三件套；跑批跳过改写 ⇒ 纯确定函数。代价明牌：改写器质量不进本评估面，另立单挂账                                                                                                                                                                        |
| D3  | 放哪     | `docs/eval/retrieval-golden.json` 单文件——扫描白名单 `SCAN_PREFIXES = ['docs/adr/', 'docs/lessons/', 'docs/plans/']`（`scripts/flywheel/scan.mjs:53`）之外，**天然防自指**（黄金集文本若进索引，跑批会捞到考题自己 ⇒ 假绿）；配锚点校验脚本，**锚点解不出 = 标尺腐烂报警**                                            |
| D4  | 装什么   | **40 条 = 真实 12 + 构造 28 + 负例 4~6**（负例占总额内）；真实 12 条**不随机**、按参考性六标准选（见 §二）；**可答性闸**（见 §三）；负例 = query + 禁止命中锚点，跑批时 forbid 锚点出现即整条判红                                                                                                                     |
| D5  | 谁干     | ds猫 标注实施（六标准为判据，每条带证据）；店长逐条审；**用户复核：负例全部 + 真实 12 条**；构造 28 条店长核 + 吐槽猫审查链                                                                                                                                                                                           |

**挂账（不进本票）**：改写器质量评估 / MRR 位置指标 / bge-m3 切换闸门（等基线出数后作判据）/ `search_knowledge` 知识库域（用户已裁：知识库暂不处理，本集只覆盖经验记忆库语料 = adr/plans/lessons 三格）。

---

## 一、产出（三件）

1. **`docs/eval/retrieval-golden.json`** — 40 条黄金集（schema 见 §四）
2. **`scripts/eval/golden-check.mjs`** — 校验脚本（见 §五）
3. **`scripts/eval/freeze-rewrite.mjs`** — 冻结改写脚本（见 §六；`scripts/` 下已有 `flywheel/` 子目录先例，新辟 `eval/` 同形）

## 二、真实 12 条：参考性六标准（D4，逐条判据）

候选池 = `retrieval_queries.query_text`（`packages/server/src/db/repository/retrievalEvents.ts:164`；**该表不在 `query_db` MCP 白名单内，取证走只读 SQLite 直查活 dev 库**——`packages/server/data/cat-study-dev.db`，只读不开写事务）。grilling 实测：池内 **1841 条**、平均长 617 字符，大量是流程元话题（票/审查/commit）与单字符碎片，**不可直接用**，故：

1. **有真实命中证据**：优先取对应 `retrieval_candidates.injected = 1`（`retrievalEvents.ts:92` 语义）的查询——「系统当时真把它注入了」是参考性最硬代理
2. **跨域分层**：按命中块 `doc_path` 域分层（adr / plans / lessons 各若干），**同一域 ≤ 4 条**，git/提交流程类不许挤占
3. **形态多样**：短问题与多约束长意图都要有；剔除「整篇审查报告当 query」的畸形样本（超长不是多样性，是噪声）
4. **时间分散**：横跨多个会话周期，不集中在最近一周
5. **过可答性闸**（§三）
6. **滤不够 12 条 ⇒ 如实报缺口**，宁缺毋滥，**禁止拿次品凑数**

每条真实条目必须带**证据字段**：`retrieval_events` / `retrieval_queries` 行 id + 命中 `doc_path` + 选用理由（对照六标准逐条一句）。

## 三、可答性闸（D4，硬闸）

> **入集资格 = 该 query 的答案确实存在于当前 MD 语料（adr/plans/lessons）中。**

标注时先答「这题在语料里有解吗」：无解 ⇒ **不入集**（也不当负例——负例定义是「有解但不许命中某块」，不是「无解」）。可答性判定写在条目里（`answerability` 字段，一句话指明答案在哪个 doc_path 哪节），供店长与用户复核抽查。构造 28 条同受此闸（构造方向 = 从语料反向出题，天然有解，但须在字段里指明解的位置）。

## 四、条目 schema（接口契约，字段集钉死）

```jsonc
{
  "version": 1,
  "entries": [
    {
      "id": "G01", // 稳定 id，重排不变
      "kind": "real", // real | constructed | negative
      "query": "原 query 文本",
      "rewritten": ["冻结改写文本"], // §六产物，禁手写；数组（改写可能多路）
      "expect": [
        // 应命中节集（节粒度，D1）
        {
          "doc_path": "docs/adr/0007-external-tool-form-selection-checklist.md",
          "section_anchor": "...",
        },
      ],
      "forbid": [], // negative 条目必填：禁止命中锚点（同粒度）
      "answerability": "答案位于 docs/adr/0007 §…", // 可答性闸留痕
      "evidence": {
        // real 必填：retrieval_queries 行 id 等
        "retrieval_query_id": 1234,
        "rationale": "对照六标准的选用理由",
      },
    },
  ],
}
```

`kind: negative` 条目 `expect` 可为空、`forbid` 必填；其余两种 `forbid` 可空（允许顺手标已知的死知识雷区，如已作废决策）。

## 五、校验脚本 `golden-check.mjs`（D3 的保鲜机制）

两类检查，任一失败即非零退出：

- **schema 校验**：字段齐、kind 值域、id 唯一、negative 条目 `forbid` 非空
- **锚点存在性校验**：每条 `expect`/`forbid` 的 `doc_path + section_anchor` 必须能解析到**当前语料里的活块**（解析口径与扫描器切片口径一致——复用 `scripts/flywheel/` 的切片器，**不自造第二套切片逻辑**）；解不出 ⇒ 报「标尺腐烂」清单（语料变了，该条目须重标）

配 `pnpm` 脚本入口（命名随仓库惯例，如 `eval:golden:check`）。**该脚本同时是 R10 跑批的前置闸**（跑批前先校验，腐烂即停）。

## 六、冻结改写纪律（D2）

- `rewritten` 必须由**真实改写路径**产出：`rewriteRetrievalQueries`（`packages/server/src/memory/query-rewrite.ts:70`；开关 `isQueryRewriteEnabled` `:42`）——用 `freeze-rewrite.mjs` 调它，输入 query 清单、输出改写文本写回 JSON
- **禁止手写改写文本**——手写等于把「冻结」偷换成「出题人想象」，D2 的确定性保证即失效
- 改写是 LLM 调用 ⇒ 允许失败/波动；某条改写失败 ⇒ 该条标记待重跑，**不拿原 query 冒充改写文本**（原样塞入须显式标注并经店长确认）

## 验收

- **G1**：40 条齐（12 + 28 + 负例 4~6），每条字段齐、可答性留痕、真实条目带六标准理由与行 id 证据
- **G2**：`golden-check.mjs` 全绿（含锚点存在性）；**真空性反对照**——故意改坏一条锚点 ⇒ 校验必须报腐烂且退出非零
- **G3**：`freeze-rewrite.mjs` 可复跑（同一清单两跑，产出文本一致——LLM 波动则如实报差集，不掩盖）
- **G4**：真实 12 条**逐条**附「滤前池读数」（1841 → 过六标准后剩几 → 选了哪条），缺口如实报
- **G5**：`node scripts/lint.js` + 全量绿（新脚本按仓库测试惯例补 `golden-check.test.js`）
- **G6 用户复核闸**：负例全部 + 真实 12 条交用户过目——**此闸不过，R10 不开工**

**停手条件**：要动 `scan.mjs` 白名单、要把黄金集搬进 DB、或发现切片器无法复用 ⇒ 报店长，不自行扩面。

## 禁入

- `docs/adr/` `docs/lessons/` `docs/plans/`（本票只读语料，一字不改）
- `packages/server/src/**`（改写/检索本体零改动；`freeze-rewrite.mjs` 只能调、不能改）
- `.husky/**`、`.push-gate`

## 行号纪律（沿用 R7/R8 实证有效版）

**先 prettier 落盘 → 再 `git grep -n` 字节路径复核 → 提交后对 `HEAD` 再核一遍。**

## 交付形态

- commit 1：`docs/eval/retrieval-golden.json` + 校验脚本 + 冻结脚本 + 测试（**过审查**——`docs/eval/` 不在免审白名单 `docs/run/**` 内）
- 交接文档按 `request-review` 门槛补填；用户复核闸（G6）在审查链之外、由店长呈递
