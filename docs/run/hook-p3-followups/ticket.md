# hook 面 P3 挂账票（fixture-hook-leak 收口遗留）

> 来源：fixture-hook-leak 票（PR #204 → dev `826d38b0`）审查 P3 观察项，吐槽猫提出、店长收口时裁决挂账。
> 性质：小活合集，四项互不依赖，可一票做完也可拆。均不阻塞任何在途链路。
> 状态：已立票·未派。

## 背景

fixture-hook-leak 票给 handoff 投递链加了仓库归属校验（`judgeRepoOwnership`），审查 ✅ 收口。审查中确认了两个方向的残余面，均因「改文件变 sha、门禁搭不上车」未随收口带走，集中挂账于此。

## 范围（四项）

### F1. OQ-2 前缀收紧（一行改动）

`handoff-gen.mjs` 归属判据中 worktree 目录名匹配用 `startsWith(shortId)`，理论互认面存在（短前缀互相包含）。server 侧真实命名只有 `<shortId>`（会话）/ `<shortId>-<猫名>`（猫）两形态（`git-utils.ts` 同源函数实证），收紧为「等值或 `shortId + '-'` 前缀」零行为损失。

- 验收：收紧后既有测试全绿；补一条「短前缀互包含不互认」的负断言。

### F2. OQ-1 收窄前置文档化

主仓根形态合法投递的前置是「目标会话的 worktree 在册」，而 `ensureSessionWorktree` 是懒建（POST /api/sessions 不建）。「主仓根提交 ∧ 会话从无 agent 活动 ⇒ 拒投」的收窄真实存在（fail-closed 方向、有 stderr 告警，非静默）。

- 验收（二选一）：`scripts/handoff-pipeline.e2e.mjs` 头注释标注该前置；或 `stepFindSession` 新建会话后顺手触发一次 worktree 注册。

### F3. 上浮落点①：docs/lessons 静态断言折白坑

e2e 19e 用 `tryPostToCatstudy` 直调判据规避 `runHandoff` 早退假绿——「验证面 ≠ 被判面」的反制实例，值得固化进 `docs/lessons/`（该目录在检索白名单内，写入即进全猫 prompt，措辞须过「写文档给 agent 看」口径）。

### F4. 上浮落点②：AGENTS.md 夹具卫生条目

「临时仓库真造 commit 测钩子前，先剥 `CATSTUDY_SESSION_ID` 等环境变量（与剥 GIT_DIR 同族）」写进 AGENTS.md Gotchas——夹具泄漏活会话已两次实证（`e09340a` / `3f8047c`）。

## 边界

- F1/F2 动 `scripts/`，需走完整审查链；F3/F4 是 docs 面但 `docs/lessons` 与 `AGENTS.md` 均不在免审白名单（`docs/run/**` only），同批过审。
- 四项可一笔提交（同族挂账），也可 F1+F2 一笔、F3+F4 一笔。
- 不动 `judgeRepoOwnership` 判据语义本身（F1 是收紧匹配面，不改三形态分类）。

## 验收标准

1. F1：匹配逻辑收紧 + 负断言测试，全量测试绿；
2. F2：所选落点改动落地，e2e 261 全绿不回退；
3. F3/F4：文本落位，无行号锚（走可 grep 唯一名）；
4. lint 三包绿；提交带真 `catstudy [uuid]` 标记。
