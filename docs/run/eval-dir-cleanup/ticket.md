# 票：eval 产物目录整理 —— docs/eval 14 个快照无索引，scripts/eval 5 脚本无导览

> 状态：已立票 · 未派
> 来源：用户原话「我发现 eval 下有很多混乱的文件，是干什么的」（2026-09-28）；店长答复 = 已收口检索评估线的跑批快照，不是垃圾、别删，立小票整理
> 基线：dev `cb786b6c`

## 现状

- `docs/eval/`：14 个文件平铺——R14a 引用探针 6 个（2026-09-23，s1/s2/四 provider 对照）、rerank 离线 A/B 4 个（2026-09-22，md/json/latency 双格式）、检索基线 3 个（09-19 md、09-20 md+json）、黄金集 `retrieval-golden.json`。无索引页，看不出批次与用途。
- `scripts/eval/`：5 个跑批脚本 + 各自测试（`retrieval-baseline` / `golden-check` / `freeze-rewrite` / `rerank-offline-ab` / `retrieval-attribution-recheck`），无 README。

## 任务

1. **首选方案（默认走这个）**：加索引页，不动文件位置——
   - `docs/eval/README.md`：每个文件一句话（批次日期 / 对应脚本 / 回答什么问题），标注「基线数字随语料过期」的口径；
   - `scripts/eval/README.md`：每个脚本一句话（用途 / 跑法 / 产物落点 / 前置条件如 tsx+sidecar、端口占用）。
2. 备选方案（仅当实施时认为平铺确实不可读）：按批次归子目录。**走备选前必须先核消费面**——`packages/server/src/routes/eval.ts` 以 `docs/eval` 为报告目录喂评估中心前端（其目录扫描是否递归须实测），`scripts/eval/*.mjs` 内多处硬编码 `docs/eval/retrieval-baseline-<date>.md` 等路径，`retrieval-golden.json` 被多脚本引用。移动文件 = 同批改全部引用面 + 服务端读口验证。

## 验收

1. 两个 README 落地，每个现存文件/脚本各有一行条目，无遗漏（以目录实际清单为准逐条对）；
2. 零文件删除、零内容改动（快照是历史数据，只加索引）；
3. 若走了备选方案：`git grep` 全仓对旧路径零残留命中，scripts/eval 测试全绿，评估中心前端报告列表实际拉一次确认不空；
4. lint + 受影响测试绿。

## 边界

- docs + scripts 文档面为主；备选方案才碰 `routes/eval.ts` 读口验证（也只读不改，除非扫描不递归且确需适配）。
- 不恢复跑批、不补新报告（报告断档原因 = 手工快照机制 + 评估线定序后置，另议不在本票）。
