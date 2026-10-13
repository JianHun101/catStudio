# 票：记忆检索归因 —— 用户报「记忆片跟说的内容关系不大」，先归因再决定动不动 0.6 / topK

> 状态：已立票 · 未派
> 来源：用户原话「为什么我观察到，索引到的记忆片跟我说的内容关系不大。要把距离调的更严格吗。还是 topk 不够大？」（2026-09-28）；店长裁决 = 先归因再调参，参数两旋钮（`MEMORY_MAX_DISTANCE` / `MEMORY_TOP_K`）在归因出来前一律不动
> 基线：dev `cb786b6c`

## 背景口径（已核实，勿再翻案）

- 检索语料 = `docs/adr` + `docs/lessons` + `docs/plans` 三目录 MD 切片（现活库约 514 片 / 30 篇）；对话原话写口已整体退役——语料覆盖天生有缺口。
- 嵌入模型 `Xenova/bge-small-zh-v1.5`（512 维，sidecar 进程）；换 bge-m3 已裁决·时机未授权，本票不出这个结论。
- `MEMORY_MAX_DISTANCE = 0.6` 是余弦距离**上限**（调小才收紧）；`MEMORY_TOP_K = 3` 按**节**计注入名额。
- 检索流水埋点已落地：`retrieval_events` / `retrieval_queries` / `retrieval_candidates` 三表（写口 `packages/server/src/db/repository/retrievalEvents.ts`），候选行带 `distance`、`droppedReason`（`threshold` / `not_topk` / `budget` / `section_dup`）、`bodyHead` 全文、`source`（final / probe）。

## 理论预断（待数据证实或推翻，写在这里防实施猫走偏）

用户「感觉完全没关系」与 0.6 的理论行为**不矛盾**：bge 系模型的余弦相似度分布压缩在窄锥里，语义无关的中文文本对常落在相似度 0.3–0.5（= 距离 0.5–0.7），0.6 的阈值足以把「真不相关」的片放进来。所以「阈值误放」在理论上成立；但「空手而归」（语料里根本没有相关文档，阈值再宽再窄都没用）同样成立——两者药方相反，只能靠数据分桶。

## 任务

从活库（`cat-study-dev.db`，以当前活实例为准，先钉库再取样）拉一批真实会话的检索流水，逐条归因。建议口径（实施时可调，但要在报告里写明分母）：

1. 取样：最近 ≥50 个 `retrieval_events`（或最近 30 天全部，取小者），要求能 join 回触发它的用户消息（event → message）。
2. 每个 event 判三桶（判定依据必须引 candidate 行 + 消息内容，不许只凭距离拍）：
   - **空手而归**：probe 池（阈值前 KNN）里就没有与用户消息语义相关的片——语料缺口，调参无效；
   - **阈值误杀**：probe 池里有相关片，但被 `droppedReason = 'threshold'` 挡掉——该**放宽** 0.6；
   - **阈值误放**：final 注入的片判「与消息不相关」——这才轮到收紧 0.6 或换模型。
3. 附加分布读数（不分桶也要给）：final 片的 distance 分布、被 threshold 丢弃片的 distance 分布、注入片为空（0 片注入）的 event 占比。
4. 产出：归因报告落 `docs/run/retrieval-attribution/report.md` + 数据附录 JSON（每 event 一行：消息 id / 三桶判定 / 判定依据摘录 / 距离读数）。报告尾部给调参建议，但**只建议、不执行**。

## 验收

1. 报告覆盖 ≥50 个真实检索 event（不足则写明实际分母与时间窗），每条归因给出支撑行（消息 id + candidate 行标识），可复查；
2. 三桶各有计数与至少 2 个样例摘录；某一桶为 0 也要显式写「0，取证方式=……」，不许缺桶；
3. 结论（动不动 0.6 / topK / 建议换模型 / 建议补文档）必须与桶计数方向一致——「阈值误放为主 ⇒ 建议收紧」这类因果链在报告里可逐条对；
4. 全程只读活库与源码：不改任何检索参数、不改黄金集、不重启活实例、不碰 `:3200`/`:5173`。

## 边界

- 纯取证票：server/scripts 零改动，产出只有 `docs/run/retrieval-attribution/` 下两份文件。
- 不跑 `retrieval-baseline` 跑批（手工快照、抢端口），本票数据全部来自既有埋点表。
- 换 bge-m3 的授权裁决不在本票；本票只回答「0.6 和 topK 该不该动、往哪边动」。
