# R11 · freeze-rewrite 缺省翻转 —— 缺省落安全侧，真改写必须显式 `--write`

> 状态：已派活（ds猫） · 前置：无（R9 已收口 `05e411c`） · 面：scripts-only，零 server 改动，**不需重启**

## 背景（事故实证，非理论风险）

R9 审查窗口，吐槽猫为验前置闸 fail-loud，在**有真 DS_KEY 的审查 worktree** 里裸跑 `node scripts/eval/freeze-rewrite.mjs`（无参数）——缺省语义 = **真调 LLM 40 次改写并 `writeFileSync` 覆写被审文件**（`scripts/eval/freeze-rewrite.mjs:402`），30 秒内踩中。已还原零残留，但代价 = 40 次真实 LLM 调用。

**根因**（ds猫 作为作者的自查结论，店长认可）：不是「审查态保护」缺失（脚本无法可靠自判跑在谁的树里，判据脆弱），而是**缺省落在破坏性一侧**——

- 缺省 = 调真实改写器 + 写回（帮助文本自述，`:315`）
- `--check`（`:278`）才是安全侧：只重跑比对差集、不写盘
- 前置闸（`:132-136`）只查 `MEMORY_QUERY_REWRITE_ENABLED != '0'` + `DS_KEY` 非空——**没有任何防误触形态保护**

## 修法（契约，二选一由实施者定，理由写进交接文档）

- **甲（首选）**：缺省 = 只打印差集（**不调 LLM、不写盘**）；真改写必须显式 `--write`（LLM 调用随 `--write` 一并 opt-in）。`--check` 语义保留或并入缺省，由实施者按兼容性裁。
- **乙**：缺省行为不变，但裸跑（无 `--write`/`--check` 任一）直接 fail-loud 退出并打印用法。

同步面（必须同票改）：

- `package.json:14` `eval:golden:freeze` script —— 若缺省语义翻转，该入口的常用形态要不要带 `--write` 由实施者裁，写进交接文档
- `scripts/eval/freeze-rewrite.test.js` —— 既有断言随新语义调整，**不许拿恒真断言凑账面**
- 文件头 docstring（`:56-76` 一段）与 `--help` 文本（`:314-315`）——**族修纪律：复述旧缺省语义的文本一并扫干净，回报清单**

## 验收

- **F1**：裸跑（无参）⇒ 零 LLM 调用、零写盘（测试用假 query-rewrite 模块断言调用次数 = 0）
- **F2**：`--write` ⇒ 行为与现行缺省完全一致（改写 + 写回 + 空改写确认位语义不变，`emptiesAcknowledged` 机器永不自写）
- **F3**：真空性反对照 —— 临时把缺省分支改回旧行为 ⇒ F1 必须变红
- **F4**：`pnpm lint` + scripts 域全量绿；行号 `git grep -n` 复核

## 停手条件

要动 `golden-check.mjs` / `retrieval-golden.json` 数据面 / `scan.mjs` ⇒ 报店长，不自行扩面。

## 禁入

`docs/eval/retrieval-golden.json`（本票只动 CLI 语义）、`packages/**`、`.husky/**`、`.push-gate`

## 行号基线

引自 dev `05e411c`（`git grep -n` 实测）：写盘点 `:402`、前置闸 `:132-136`、`--check` 解析 `:278`、帮助文本 `:314-315`、pnpm 入口 `package.json:13-14`。
