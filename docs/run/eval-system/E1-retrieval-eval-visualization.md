# E1：检索评估可视化（报告 JSON 出口 + 只读端点 + 前端第五 tab）+ 标注卡上文

<!-- label: wayfinder:ticket -->
<!-- 来源: map.md「检索召回上不去」/「标注样本的呈现面缺上下文」两条（用户 2026-09-20 批「可视化 + 加上文」） -->
<!-- 状态: 已派活（ds猫 `6a871c8`）· 首轮审查 ⚠️ 一条 · 返工中，未收口 -->

> ⚠️ **本票立票晚于派活**（2026-09-20 补记）：契约与验收原先只活在派活单消息里，
> `git ls-files docs/run | grep -iE 'E1'` 实测**零命中**。补落本文件是为了让契约有耐久落点，
> **不是新增约束**——授权面以派活单为准，契约以本文为准。

## 一、背景（为什么要有这条）

`docs/eval/` 是**检索线**的评估报告，但它是**手工跑批的 CLI 产物**，且只落 markdown——
结构化数据（`groups` / `scores` / `canary`）算完只在内存里，`emit` 出去的是完成信封（3 个标量摘要）。
⇒ 前端「没画」不是缺页面，是**根本没有机器可读出口**。

RAG 记忆系统的度量因此有三个面：① 尺子（黄金集 40 条）② 分数（跑批 md，**只有人眼读**）
③ 原始观测（`retrieval_*` 三表，**零读侧**）。**本票只治 ②**；③ 无票。

## 二、契约（店长拍板，形状不许改）

**A｜JSON 副产品** —— 落盘处同批多写 `<outFile 换 .json>`；内容 = 喂给 `renderReport` 的
**同一份 ctx** + 顶层 `schema`。**一处算、两处渲染**，不许第二遍计算。
拒出路径（`refuse()`）⇒ md/json **都不落**（不许「md 拒了、json 落了」）。

> 这条契约的承重含义：**ctx 是落盘源**，故 **ctx 里不得有任何「落盘非法」的值**
> （每次运行都变的量、时间量）。见 §五 的 ⚠️ 裁决。

**B｜只读端点** —— `GET /api/eval/retrieval/reports`（列全部，日期倒序）+
`GET /api/eval/retrieval/report?date=YYYY-MM-DD`（缺省=最新）。
无报告 ⇒ **404 + reason**，不许静默空对象；「调用方把日期写错」与「那天没有报告」必须分成两态。
路径解析**必须**走 `repo-root.ts` 的 `findRepoRootFrom`（marker `['docs','eval','retrieval-golden.json']`）
——**禁止自己拼固定层级**（G5 产物布局教训）。响应形态 `{ok:true,...}`，与 `label/pool` 同族。

**C｜前端第五 tab** —— `activeTab` 加 `'retrieval'`，排在「链路」之后。
顶部**必须有承重的快照声明**：报告日期 + 「数字永远是**上一次跑批**的结果，**不是当前水位**」。
它**不是装饰**——跑批要起嵌入 sidecar、跑几分钟，前端不能触发（会撞活 server 的嵌入端口）。
空态**不是错误**（手工产物，还没跑过批就是空）。

**D｜标注卡上文** —— `label/pool` 每个样本加 `context`，值 = `getContextBefore(session_id, created_at, 10)`，
**与 `routes/eval.ts` 的 pending 逐字同款**（回标 tab 早就在用）。**不用新写查询。**
**盲标契约不动**：盲标禁的是**判官分**，从未禁上下文。

> **点名风险（随票带上）**：`getContextBefore` 走**字符串比较**（`db/repository/evalScores.ts` `created_at < ?`），
> 而 `messages.created_at` 的 DDL 默认是 `datetime('now')`（**空格格式**，`db/migrations.ts`）。
> 2026-09-20 实测：dev 库全 ISO-T、主库全空格格式，**两库各自内部自洽** ⇒ 字典序仍等于时间序，今天两侧都成立。
> 但**混存**一旦发生，空格行会被判成「早于一切」⇒ 静默返回错的上文。**非本票引入**（`/review/pending` 已在用）。

## 三、边界（不做）

`db/migrations.ts`（不加表不加列）· `repo-root.ts` · `docs/eval/**` 既有两份 md ·
判官线任何面 · 检索实现 · `EVAL_SAMPLE_RATE`（打开采样率 = 运营成本决策，归用户）。

## 四、验收（可证伪）

1. 跑批（`--out` 指 `%TEMP%`，**别覆盖 `docs/eval/` 既有报告、别落仓库根**）⇒ 同批出 `.json`
2. `scores.length===40`、顶层 `schema` 在位
3. **json 与 md 数字逐条一致**（对 `0.5833`）——防「两个视图两份数据」的承重探针
4. 拒出路径两份都不落
5. 端点 404 / 200 各一路
6. 路径解析**产物布局下同解**（负对照：固定层级必红）
7. 四 tab 零回归
8. 标注池取「之前**最近一条** user」（两条 user 夹具，取错拿第一条必红）
9. 跨会话不泄漏
10. 响应**键集**（递归比对，**不是 grep 词**）不含判官分字段

> ⚠️ **验收 1 的字面形式在真语料上必假红**：写的是「响应 JSON 全文 grep 不到 `score`/`judge`」——
> 猫的回复正文本来就会讨论 score/judge。**承重的是第 10 条的键集递归断言**，全文 grep 只是夹具辅助探针。
> **禁止的「修法」**：为让全文 grep 变绿去截断/清洗正文——那会毁掉本票「正文不截断」的硬要求
> （Phase 0 那批 1200 字符截断正是样本报废的原因）。

## 五、状态与裁决（2026-09-20）

- 实现 `6a871c8`（ds猫，父提交 = dev tip）。首轮审查 **⚠️ 一条**：
  `buildReportJson(ctx) = { schema, ...ctx }` 把整个 ctx 摊进落盘 JSON，
  而 `reportCtx.embed.port` 是 sidecar 握手的**真实随机端口** ⇒ 同树同库两跑 JSON **不逐字节一致**
  （实测差异只有这一处：`"port": 3593` vs `4132`），破了同文件 `:687` 的明文禁令，
  以及 `:61` / `:66` / `useApi.ts`（「报告本体 = 同一份 ctx」）三处 B1 声明。
- **店长裁决：走「甲」——ctx 里不得有落盘非法的值。**
  判据不是省事，是**契约面**：若一个值不许进产物，它就**不该进 ctx**；
  「乙」（只让 `buildReportJson` 过滤掉端口）会让「json = 同一份 ctx」这条**既有契约当场变成假话**，
  并要连带削弱 `retrieval-baseline.test.js` 的同引用断言。字段名须**自描述**
  （建议 `embed: { model, dim, handshaked: boolean }`），`useApi.ts` 的 DTO 同步。
- **同批须订正三处失实声明**（`:61` / `:66` / `:687`）——不改代码只改注释 = 留下「注释说一件没发生的事」。
- **跨票先例**：T3（`21c6061`）独立撞上同一类并已按「只报供给形态与是否真握手，**不报数**」落地
  ⇒ 甲与本仓既有形态一致。

## 六、关联

- [map.md](map.md) —「检索召回上不去」/「标注样本的呈现面缺上下文」两条
- [J1](J1-judge-credibility-standing-loop.md) — `human_labels` 表与 `/judge-agreement` 即契约 D 的载体
- T3：`T3-retrieval-optimization-diagnosis.md`（flash猫 `21c6061`，**尚未进 dev**）——契约 A 的产物正是 T3 类诊断的机器入口
