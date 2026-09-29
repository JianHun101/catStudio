# `docs/run/` 存量勘察清单（37 目录 · 状态 + 上浮建议）

> 段 1 产物 · 票 `docs/run/run-conclusions-float-up/ticket.md` · 派活单 = 店长消息 `77350e8b` 立票那笔
> 勘察者：ds猫 · 2026-09-29 · 基线 `dev = 77350e8b` · 树干净
> 边界（票面「段 1」）：**只读各目录 + 写本文件**。未删、未改任何既有票单目录，未动 `docs/plans|lessons|adr`、未动代码。
> 本文件是本次勘察唯一新增物。

---

## 〇、结论先行

| 建议                            |   数量 | 目录                                                                                                                                                                                                                                                                                       |
| ------------------------------- | -----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **上浮**（有结论要搬）          | **13** | `eval-system`、`multi-cat-isolation`、`retrieval-attribution`、`precommit-scope`、`retired-docs-tombstone`、`dispatch-deferral`、`flaky-precommit`、`line-endings`、`line-anchor-source-comments`、`env-number-guards`、`skill-discovery`、`skill-discovery-errata`、`lessons-first-batch` |
| **判弃·可清**（无结论要搬，清） | **12** | `agent-reply-timer`、`docs-single-writer`、`probe-no-resume`、`hook-marker-fail-open`、`eval-dir-cleanup`、`fixture-hook-leak-live-session`、`left-closed-collapse`、`sessionlist-collapsed-dead-code`、`skill-delivery-decoupling`、`vision-retire`、`m1-refs-link-timing`、`ui-redesign` |
| **不上浮·留**（活没完）         | **10** | `db-schema-governance`、`autocommit-blocking`、`commit-uuid-gate`、`test-git-env-pollution`、`docs-run-status-gate`、`hook-p3-followups`、`closeout-gate`、`a2a-memory-gate`、`frontend-perf`、`taste-skill`                                                                               |
| **在飞**                        |  **1** | `run-conclusions-float-up`（本票自身）                                                                                                                                                                                                                                                     |
| **待店长裁**                    |  **1** | `hook-fallback-delivery`（保留理由字面未兑现）                                                                                                                                                                                                                                             |

**三条要店长先看的硬结论**：

1. **本活与三张已在飞的票大面积重叠，不是从零开始。** 段 3 开工前必须先裁这层关系，否则会造出第二份平行真相源（判据 3 禁止的东西）：
   - `docs/run/docs-run-status-gate/`（`status: active`，Gate PASS，2026-09-19 立）——它的 **G2「待上浮批」** 已经点名 10 个目录、**G3** 是「存量全目录回填 status」、**G4** 是 pre-push 硬闸。**本活的段 1 与 G2/G3 是同一件事的两个版本**（G2 的清单基于 09-19 基线，仅覆盖今日 37 个中的 10 个）。
   - `docs/run/lessons-first-batch/`（`status: active`）——**lessons 侧的上浮批**，其 D2 明写「**本票须排在 G2 之前执行**」，且 §二 已抄录 8 条待落卡素材。今日 `docs/lessons/` 的 10 张卡就是它的产物（首批已落，见 §二 第 21 行）。**本活的 lessons 分支与它同构**。
   - `docs/run/hook-p3-followups/`（挂账票）——其 **F3/F4 两项本身就是上浮动作**（落 `docs/lessons/` 与 `AGENTS.md`）。
     ⇒ **建议**：段 2 先把「本票是取代 G2/G3、还是作为它们的执行面」裁掉，再逐目录拍板。三张票的边界不厘清，段 3 会产生重复落点或互相覆盖。

   > 附带实测：那张票的 **G5「陈旧度可见性」其实已经落地**（`scripts/run-docs-stale.mjs` + `closeoutSession` preflight 挂载，`e4ac0418`）——即**每次收口都已在打印陈旧清单**，但它「只打印不阻断」、无接收方动作，正是 `CONTEXT.md` 自己点名的「**有落点 ≠ 会被消费**」形态。本活若只产出清单而不接到一个会被执行的动作上，会重复这一形态。

2. **「要不要发重启审批」这条判据，在两份手册里一个字都没有。** 实测 `AGENTS.md` 与 `CONTEXT.md` 的「重启」命中数 **= 0**。而它是**每一张票收口都要做一次**的判定，今日只靠 `docs/run/**` 各票面互相复述（措辞「重启判定看运行实例而非改动面」在 `db-schema-governance/tickets.md`、`env-number-guards/tickets.md` 各出现一次；最完整的取证样本在 `multi-cat-isolation/closeout-phase-i.md` 的「重启判定（取证，非断言）」节）+ 不在仓库内的猫角色 prompt。`docs/run/**` 清掉后这条判据**无家可归**。⇒ 本案最强的上浮候选，落点建议 `AGENTS.md` Gotchas（判据 1/2/3/5 全过）。

3. **票面「35 个目录」没有错，是计数时点早于两笔立票。** 实测对账（`git ls-tree` 逐时点）：

   | 时点                                   | `docs/run/*/` 目录数 |
   | -------------------------------------- | -------------------: |
   | `77350e8b~2`（PR #204 合并后）         |  **35** ← 票面写的数 |
   | `77350e8b~1`（立 `hook-p3-followups`） |                   36 |
   | `77350e8b`（立本票，自建目录）         |               **37** |

   差 2 = `hook-p3-followups` + 本票自身目录。**验收项 1 的「35」应按磁盘实数的 37 重述**（票面自己也写了「与磁盘逐名对账」）。

---

## 一、取证方法与口径

- **不采信票面自述。** 本条不是套话，是本次的实测结论：**9 个目录的票面状态申明与实况不符**——6 个写「**已立票 · 未派**」而活早已落 dev（`eval-dir-cleanup`、`fixture-hook-leak-live-session`、`hook-marker-fail-open`、`left-closed-collapse`、`retrieval-attribution`、`sessionlist-collapsed-dead-code`），3 个写 `status: active` 或「在飞」而活同样已落（`skill-discovery`、`lessons-first-batch`、`m1-refs-link-timing`）；另 `probe-no-resume` **无任何状态申明**。照票面状态判，这批会被整批误判成「等派活」。状态列一律以 **git 拓扑 + PR 归属实测**为准。
- **sha 全部实测**：本次引用/核到的 **43 个** merge/commit sha（去重后计数）逐条走 `git cat-file -t`（对象存在）+ `git merge-base --is-ancestor <sha> dev`（已落主干），**43/43 通过**。票面自报的 PR 号不作依据，只作线索。
- **状态列用既有值域，不另造词。** `CONTEXT.md` 的「文档位置约定」段已定义 `docs/run/<slug>/` 的机器值域 = `active` / `pending-float` / `floated` / `dropped`（并注明对应硬闸「票 G4，待挂载，今天无机器执行面」）。本清单直接采用该四值 + 中文注释，**不发明第五套词汇**（判据 3）。
- **本文件不写行号**（本仓口径「行号一律不留」）。指位置一律给**可 grep 的唯一名**：标题名 / 字段名 / 常量名 / 脚本名。
- **「未闭项」列只记实测仍在的**，且每条带「**什么动作能把它从清单上拿掉**」——这是 `docs/lessons/open-items-list-needs-status-bits.md` 的判据（清单只增不减会让「零未闭项才删」不可判）。本次实测该缺陷**仍在复发**（见 §四）。

**状态四值的判定口径**（可复跑）：

| 值              | 含义                                     | 判定依据                                             |
| --------------- | ---------------------------------------- | ---------------------------------------------------- |
| `active`        | 活未结束：在飞 / 有未派欠账 / 有未闭验收 | 存在「无承接载体的未闭项」或票未派                   |
| `pending-float` | 活已收口，结论尚未上浮                   | 落点在白名单/手册/代码面**均零命中**，且确有结论可搬 |
| `floated`       | 结论已在别处落盘，目录可清               | 落点实测存在（白名单 / 手册 / 代码注释 / 产物）      |
| `dropped`       | 判弃                                     | 结论已被时间证伪或被后续票取代，无搬的价值           |

---

## 二、逐目录清单（37/37）

> 格式：`状态 ｜ 关联（实测 sha/PR） ｜ 上浮建议 ｜ 理由（引判据编号）`
> **建议的目标落点写在本行**；凡建议「上浮」的，结论正文见 §三。

| #   | 目录                              | 状态                          | 关联（实测）                                                                                                                           | 上浮建议                                                                | 理由（判据）                                                                                                                                                                                                                                    |
| --- | --------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `a2a-memory-gate`                 | `active`（挂账）              | PR #157 → `4dc9be66`；收口笔 `1b34393c`                                                                                                | 上浮→lessons（一条）；三条未闭项转挂账                                  | 判据 1+2+4：F2 的 env 默认侧读法是可复用口诀；OQ-1/OQ-3/OQ-4 是无承接载体的欠账，清目录即蒸发                                                                                                                                                   |
| 2   | `agent-reply-timer`               | `floated`                     | PR #124 → `44c1d3b`；票③ PR #169 → `30599dbc`                                                                                          | 不上浮·清                                                               | 判据 3：结论已在 `docs/plans/agent-reply-elapsed-timer.md`；票面 §「本 run 未清」自陈物理清理归 G2                                                                                                                                              |
| 3   | `autocommit-blocking`             | `active`（挂账）              | PR #162 → `23352486`；WIP 分支 `wip/autocommit-async-ge2` 仍在                                                                         | 不上浮·留                                                               | 判据 2：已落部分是止血（代码+注释已承载），未落部分（格 2 暂缓 / 格 3 半落 / OQ 未裁）是**可执行欠账**，清了就丢                                                                                                                                |
| 4   | `closeout-gate`                   | `active`（挂账）              | 无实现；唯一提交为立票笔 `869ea9ff`                                                                                                    | **待店长裁**（派活 / 判弃 / 先上浮再清）                                | 判据 1+2+4 全过（零夹带正判据 = 双向并集等式，本仓独有且经实测），但活自 09-16 立票**未派**；判弃须先证已被现有收口链取代                                                                                                                       |
| 5   | `commit-uuid-gate`                | `active`（挂账）              | PR #66 → `ad8d41c`                                                                                                                     | 不上浮·留                                                               | 判据 3：门禁判据与多态已落代码 + `CONTRIBUTING.md`；OQ-C（`.husky/` 四钩子 git mode 实测仍全 `100644`）是**带钉死触发条件**的未闭项，随票存活                                                                                                   |
| 6   | `db-schema-governance`            | `active`（挂账）              | PR #111 → `7e5478b`；PR #112 → `d0c7c35`；PR #114 → `dbc550a`；spec `e5daf7a`                                                          | 不上浮·留                                                               | 判据 3：设计面已在 `docs/plans/db-schema-governance.md`，余下**全是未派活的执行队列**（批二 / 票 8 / 根治剩两刀）；清了丢执行面（判据 2）                                                                                                       |
| 7   | `dispatch-deferral`               | `pending-float`（V4 未闭）    | PR #98 → `51014f61`                                                                                                                    | 上浮→plans（执行收尾并发）；**V4 取数或店长豁免后**清                   | 判据 1+2：收尾段两子树并发 + 帧尾合三是设计结论（含三条行为变更契约），代码注释只写机制不写契约；但票面明文「取数前不得声称 V4 已验」                                                                                                           |
| 8   | `docs-run-status-gate`            | `active`（挂账）              | G1(a)(c) 已闭；**G5 已落** `e4ac0418`；G2/G3/G4 未派未落                                                                               | 不上浮·留                                                               | 判据 2+4：D1 状态位判据表是本仓独有设计、无第二落点；**且本活与它重叠**，见 §〇-1                                                                                                                                                               |
| 9   | `docs-single-writer`              | `floated`                     | PR #94 → `49a1099f`                                                                                                                    | 不上浮·清                                                               | 判据 3：判据/纪律已逐条落 `CONTEXT.md`「docs 单一写入口」条；零未闭项。**清前须改注释悬空引用**（见 §四）                                                                                                                                       |
| 10  | `env-number-guards`               | `pending-float`               | PR #178 → `4c2de1b7`                                                                                                                   | 上浮→lessons（定族按失效机制）；三条未闭项转挂账                        | 判据 1+2+4：规范结论已落 `CODING_STANDARDS.md` §9，但「定族按失效机制扫、不按模式扫」无白名单落点                                                                                                                                               |
| 11  | `eval-dir-cleanup`                | `floated`                     | PR #203 → `0a9f09fa`（`46bcc68e` + `43becd79`）                                                                                        | 不上浮·清                                                               | 判据 1+3：成果**就是**两份索引页本身（`docs/eval/README.md` / `scripts/eval/README.md` 实测在位），票面纯过程                                                                                                                                   |
| 12  | `eval-system`                     | `pending-float`（除 A2 挂账） | 20+ PR；末次提交 `f0a96116`；最新 PR #189 → `942a48fc`                                                                                 | 上浮→plans（新建定稿规格）+ 分批 lessons；**目录去留待店长裁**          | 判据 1+2+3：白名单三目录对整个「评估体系」**零承载**（问「为什么不用 Langfuse/RAGAS」今天在 `docs/` 查不到答案，只能翻 12800 行草稿）。**但票面记有店长「保留已关票」裁决**，见 §五                                                             |
| 13  | `fixture-hook-leak-live-session`  | `floated`                     | PR #204 → `826d38b0`（`e1b5d5f3`）                                                                                                     | 不上浮·清                                                               | 判据 3：残余四项已明文转记 `hook-p3-followups` 挂账票，不复制第二份                                                                                                                                                                             |
| 14  | `flaky-precommit`                 | `pending-float`               | PR #92 → `38be312`                                                                                                                     | 上浮→lessons；清                                                        | 判据 1+2+3：`listen(0)` 可能落到 Fetch 禁用端口黑名单是机制级根因，白名单三目录零承载；**且票面 §5.3 自认的上浮从未执行**（两次接力都没落地）                                                                                                   |
| 15  | `frontend-perf`                   | `active`（挂账）              | PR #70 → `5aa1032`                                                                                                                     | 上浮→lessons（验收阈值分辨力）；两条观察项转挂账                        | 判据 1+2+4：阈值不分档 ⇒ 恒真门，是可复用判别口诀；两条观察项带钉死触发条件但无承接载体，清了蒸发                                                                                                                                               |
| 16  | `hook-fallback-delivery`          | **待店长裁**                  | `3d68985c` 入 dev；勘误 `f11b274b`                                                                                                     | 倾向 不上浮·清——**但保留理由字面未兑现**                                | 判据 3+5：A 案结论已在 `CONTEXT.md` 流程约定；票面明写保留理由是「G1 勿删」，而 G1 根因经实测已被 R7 归属校验除根（`serial.ts` 注释自陈「该词随之退役」）。但票面条件是「G1 **兑现**或**单独立票**」，**被旁票解决**不等于两者之一 ⇒ 不替店长拍 |
| 17  | `hook-marker-fail-open`           | `floated`                     | PR #201 → `32ba68de`（`8268a7ec`）                                                                                                     | 不上浮·清                                                               | 判据 3：结论已落 `CONTRIBUTING.md` 提交规范段 + `.husky/commit-msg`、`.husky/pre-push` 头注释                                                                                                                                                   |
| 18  | `hook-p3-followups`               | `active`（挂账）              | 立票 `5be9203d`                                                                                                                        | 不上浮·留                                                               | 判据 2：F1–F4 四项**全未落地**（实测 `judgeRepoOwnership` 仍用 `startsWith(shortId)`、`AGENTS.md` 零夹具卫生条）；F3/F4 本身就是上浮动作项                                                                                                      |
| 19  | `left-closed-collapse`            | `pending-float`               | PR #196 → `fdf8c29d`（`37e6dce8` + 订正 `99cee01b`）                                                                                   | 上浮→lessons                                                            | 判据 1+2+4：grid 自动放置在 `display:none` 下的位移机制 + 单向死锁，只活在 `App.vue` 注释与 CSS 里，白名单三目录零命中                                                                                                                          |
| 20  | `line-anchor-source-comments`     | `pending-float`               | 无 PR（ff-only 直达被审 `5fa3df53`）；收口笔 `ddda39f0`                                                                                | 上浮→lessons（一条）；余者清                                            | 判据 1+2：口径条已进 `AGENTS.md`、恒真门教训已落 `docs/lessons/diff-zero-does-not-mean-no-conflict.md`（判据 3 不重复），**唯一未固化**的是「判据盲区与被判对象同形」                                                                           |
| 21  | `lessons-first-batch`             | `floated`                     | `060b3d75` / `652292a6`（经 review-view `2d5c757e` 入 dev）                                                                            | 不上浮·清（**但两条验收未闭**）                                         | 判据 3：产物**就是** `docs/lessons/` 的 10 张常驻卡。**注意：它是本活段 3 的 lessons 侧前身**，见 §〇-1                                                                                                                                         |
| 22  | `line-endings`                    | `pending-float`               | PR #89 → `a037d80`                                                                                                                     | 上浮→lessons                                                            | 判据 1+2+4：§B 两条反直觉实测（剥 CR 须刷 index stat 缓存 / tracked 二进制只对主仓成立）无任何白名单落点，`AGENTS.md` 实测零行尾内容                                                                                                            |
| 23  | `m1-refs-link-timing`             | `floated`                     | `19d27486`（经 review-view `5405087b` 入 dev）                                                                                         | 不上浮·清                                                               | 判据 3：根因与不变量逐条写在 `reply.ts` 消费点注释；母票规格归 `eval-system` 批                                                                                                                                                                 |
| 24  | `multi-cat-isolation`             | `pending-float`               | PR #87/#88/#90/#91/#95/#96/#97；`adr-0015-draft.md` 在册                                                                               | 上浮→adr（**0015 转正**）；清                                           | 判据 1+2+4+5：本目录唯一真正的知识真相源（隔离模型 + fan-in 四要件）；**ADR 草案 frontmatter 已 `accepted` 却从未转正**（`docs/adr/` 无 0015）——本目录唯一未执行的收口动作                                                                      |
| 25  | `precommit-scope`                 | `pending-float`               | PR #93 → `809033f`；残余 `1225e1d` → PR #96 → `9497b9b`                                                                                | 上浮→plans（三档判据）+ lessons（两条）；清                             | 判据 1+2：三档判据表是「哪类改动跑哪些 project」的**唯一成文定义**，检索语料无文可答；残余段无收口记录。**清前须改 `CONTEXT.md` 悬空引用**（G1(b) 未做）                                                                                        |
| 26  | `probe-no-resume`                 | `floated`                     | PR #197 → `7c2ef714`（`625eb877`）                                                                                                     | 不上浮·清                                                               | 判据 3：判据与豁免面已落 `probe-mode.ts` + `AGENTS.md` Gotchas + `.env.example`                                                                                                                                                                 |
| 27  | `retired-docs-tombstone`          | `pending-float`（带残余挂账） | PR #136/#137/#139；`273e7076` / `b4b3bb83` / `9446a505` / `cf73cd63`                                                                   | 上浮→plans（墓碑机制）+ lessons（注式订正判据）；**三处注销账带走后**清 | 判据 1+2+3：墓碑机制是记忆库定稿规格缺的一维（`docs/plans/memory-flywheel.md` 对 tombstone/verdict 零命中）；注式订正判据全仓未落                                                                                                               |
| 28  | `retrieval-attribution`           | `pending-float`               | PR #198 → `b9e5c397`                                                                                                                   | 上浮→plans（并入 `memory-flywheel`）+ lessons；`appendix.json` **待裁** | 判据 1+2+5：三桶归因是持久机制判据 + 明确消费面（后人调检索参数/语料决策）+ 结论至今未被推翻（代码默认仍是 `0.6`）。⚠️ 报告 §6 的 6 条建议**无任何承接票**                                                                                      |
| 29  | `run-conclusions-float-up`        | `active`（在飞）              | 立票 `77350e8b`                                                                                                                        | 不上浮·留（本票自身）                                                   | 本票即当前在飞主体；票面边界明文「在飞票不动」                                                                                                                                                                                                  |
| 30  | `sessionlist-collapsed-dead-code` | `floated`                     | PR #199 → `15db0844`（`6c64902e`）                                                                                                     | 不上浮·清                                                               | 判据 1+3：净删除死代码，判据以 `SessionList.test.ts` 负断言钉住，无可复用结论                                                                                                                                                                   |
| 31  | `skill-delivery-decoupling`       | `floated`                     | ADR 0014（`accepted`）；T1–T5 代码落 dev；**无 PR**                                                                                    | 不上浮·清                                                               | 判据 3+5：结论已整体落 `docs/adr/0014-skill-delivery-decoupling.md`；票面 T4 形态已被 ADR §5 修订取代而票面未回改（属记账债，不阻断清）                                                                                                         |
| 32  | `skill-discovery`                 | `pending-float`               | PR #138 → `10c442d`（`056f944`）                                                                                                       | 上浮→plans（技能注入面五裁决）                                          | 判据 1+2+4：D1–D5 注入裁决只活在票面与代码注释，白名单三目录零命中；ADR 0014 只管白名单语义、不覆盖此设计                                                                                                                                       |
| 33  | `skill-discovery-errata`          | `pending-float`               | PR #142 → `ceed5e63`（`42bf1892`）                                                                                                     | 上浮→lessons（pnpm 引擎门陷阱）                                         | 判据 1+2+4：三条机制订正持久且白名单无落点。⚠️ 票面 frontmatter `status: 在飞` 是**值域外中文**，见 §四                                                                                                                                         |
| 34  | `taste-skill`                     | `active`（挂账）              | 票 A `81d3b809` / 票 C `a87c321f` / 票 E `723dcd7f` / 票 H `e79ef7f2` / 票 I `e78de13d`·`3e02e73b`                                     | 上浮→lessons（外部判据适用性映射）；**未整改发现项另议**                | 判据 1+2+3：资产面已是真相源（`skills/` + `skills-lock.json` + `BOOTSTRAP.md`），方法内核可复用；但两份诊断报告的多条发现项**未修且无票跟踪**，清了即暗知识                                                                                     |
| 35  | `test-git-env-pollution`          | `active`（挂账）              | PR #68 → `69d543b`；PR #71 → `15e2724`（OQ-β `6f79419`）                                                                               | 机制侧上浮→lessons；**目录不上浮·留**                                   | 判据 1+2：git 向钩子注入绝对 `GIT_DIR` 的机制 + 两条腿归因判据无手册承载；但票面明文「有未闭项则保留」，7 条观察项含 **2 条「是否立票待裁」**                                                                                                   |
| 36  | `ui-redesign`                     | `floated`                     | T1–T6 全收口；PR #190–#195（T1 `74b25de0` / T2 `e0b413f8`·`f2b947d5` / T3 `aef4cdb0` / T4 `0c41a492` / T5 `faf899d4` / T6 `ecde6aba`） | 不上浮·清 + 一张 lessons                                                | 判据 1+2+3：六份规格文本均无第二份价值（形态已在 Vue 实现）；唯 T6 已裁的教训卡未产出                                                                                                                                                           |
| 37  | `vision-retire`                   | `floated`                     | PR #69 → `7e7ef65`（被审 `981241d`）                                                                                                   | 不上浮·清                                                               | 判据 3：退役结论已落 `CONTEXT.md` 角色定义条；残余属需用户定夺的**运营项**（主库会话零成员是否补员），非知识                                                                                                                                    |

---

## 三、建议上浮的结论正文（段 3 可直接取用）

> 写法遵票面「上浮 = **改写为定稿形态**（去过程叙事、去时间线、锚可 grep 唯一名、无行号）」，不是复制粘贴。
> **本节只列落点与要点**；正式文本在段 3 产出并走审查链。

### A. → `docs/adr/`（1 份）

**`docs/adr/0015-per-cat-worktree-isolation.md`**（由 `docs/run/multi-cat-isolation/adr-0015-draft.md` **转正**，不是新写）

草稿 frontmatter 已是 `status: accepted`、实现已全部落地，**只差转正这个动作**。转正时**必须同批改三处**（否则上浮的是假话）：① D1 命名——现文写 `cat8 = agent id 前 8 位`，实现是 `catSlug(catName)` 中文猫名；② D3 形态——现文写「一次性 detached worktree」，Phase I-b 已实测**该形态不可达**，落地的是「审查者树 = 集成分支 ∪ `listCatBranches()`」、只对 `role === 'reviewer'` 生效；③ §7-2 命名子决策状态。另需扫 `<cat8>` 复述面（`worktree-fanin.ts` 注释与测试仍有 5 处）。**文内行锚已漂移，别照抄。**

### B. → `docs/plans/`（5 份）

| 落点                                                | 来源目录                                           | 结论要点                                                                                                                                               |
| --------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **新建** `docs/plans/eval-system.md`                | `eval-system`                                      | 评估体系定稿规格，建议七节（见下方「最大出口」）                                                                                                       |
| **并入** `docs/plans/memory-flywheel.md`            | `retrieval-attribution` + `retired-docs-tombstone` | ① 检索归因三桶结论（两个旋钮都不该动 / 距离轴不可分 / 池里没有的 topK 变不出来）；② 墓碑机制（`verdict` 字段 + `#tombstone` 锚 + 查询谓词放行墓碑）    |
| **新建** `docs/plans/execution-tail-concurrency.md` | `dispatch-deferral`                                | 收尾段两子树并发启动 + 帧尾合并 await，及**三条当契约的行为变更**（落库顺序可交错 / 同猫进 FIFO 次序不定 / 配额末位竞争由确定转不确定）                |
| **新建** `docs/plans/precommit-gate-scoping.md`     | `precommit-scope`                                  | 提交口按改动面三档裁决 + `packages/**` 命中时追加 scripts + 门禁自身出错一律 fail-closed                                                               |
| **新建** `docs/plans/skill-discovery-injection.md`  | `skill-discovery`                                  | 技能发现面注入五裁决（注入面 = 可读面 / 单一真相源落 `skill-catalog.ts` 零 import 叶子 / 落点 `finalSystemPrompt` / 全 agent 一律注入 / 文案逐字复用） |

**`eval-system` 是最大出口，建议七节**：① 形态裁决（自建零依赖，依据是**两条排除**：13 件外部 RAG 工具无一件给 IR 口径 `recall@k`、6 家 trace 平台全是查看器）；② 观察单位 = **执行跳**（不是消息行）+ 链锚 = `coalesce(回复消息.task_id, 触发消息.task_id)` + **`execution_logs.trace_id` 是「当轮执行 id」，同名不同义禁止搬运**；③ 耗时分解（`replyMs` 不只是 LLM；**禁用 `lockWaitMs` 这类字段名**；终端答案以根段 `invoke_agent` 为准、**禁止加总子段**）；④ 记忆检索采集三表（**凡事后无法可靠重算的值一律冗余进表**；身份键用三元组不用 `chunks.id`；`injected` 与 `dropped_reason` 必须分开）；⑤ 检索末次截断按节计名额（**绑定 `MEMORY_TOP_K=5`**，回落到 3 应单点 revert）；⑥ 检索评估尺（黄金集 40 条 / 标注粒度 = 节 / 跑批跳过改写器 / 两读数分开报不合成 / canary 反对照不过即拒出报告）；⑦ 判官与人的可信度（**必须带上 2026-09-20 的订正**：「三闸门全过」撑不住「判官可用」）。

### C. → `docs/lessons/`（建议 8 张，已按「避免碎片化」合并）

| 建议 slug                                          | 来源                          | 一句话内核                                                                                                                                                      |
| -------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `restart-verdict-by-live-instance.md`              | **跨目录族**（见 §〇-2）      | 判「要不要重启」看**运行实例是否受影响**（逐文件判「可执行的生产码改动」），不看文件名/目录名归类                                                               |
| `family-boundary-by-failure-mechanism.md`          | `env-number-guards`           | 「整族修」定族先写**失效机制**再全仓扫；按模式扫（只搜 `parseFloat`）会把同机制的 `parseInt` 整族留在外面                                                       |
| `distance-threshold-cannot-separate-relevance.md`  | `retrieval-attribution`       | 相关片与不相关片在距离轴上完全重叠 ⇒ 任何单一阈值都分不开；**池里没有的，topK 变不出来**                                                                        |
| `display-none-grid-item-breaks-autoplacement.md`   | `left-closed-collapse`        | `display:none` 的 grid item 不再是 grid item ⇒ 自动放置把后继 item 整体前移；修法 = 列位显式 `grid-column` 钉死                                                 |
| `listen0-can-land-on-fetch-blocked-ports.md`       | `flaky-precommit`             | `listen(0)` 可能落到 Fetch 禁用端口黑名单：服务**真的在监听**（裸 TCP 通）但 `fetch` 发请求前就拒且永不恢复；**判据必须真 fetch 一次，不能抄黑名单**            |
| `hook-inherits-git-dir-hijack.md`                  | `test-git-env-pollution`      | worktree 内 commit 时 git 向钩子注入**绝对** `GIT_DIR`（优先级高于 cwd 探测）⇒ 钩子里 `{cwd: tmp}` 的子进程被劫持到真实仓库；修法 = 钩子顶部 `unset` 定位类变量 |
| `criterion-blind-spot-looks-like-truth.md`         | `line-anchor-source-comments` | 判据的排除项恰好排掉它该抓的东西时，该档位**构造上不可达**，且读数与「本就无可指」**同形** ⇒ 全绿不等于面已清                                                   |
| `correction-note-only-protects-its-own-section.md` | `retired-docs-tombstone`      | 给 ADR/规格加文首注订正失实句，**只在注与失实句同处一节时有效**（注入面按节装配）⇒ 跨节必须改文                                                                 |

**另有 5 条候选**（`a2a-memory-gate` 的 env 布尔默认侧 / `frontend-perf` 的验收阈值分辨力 / `ui-redesign` 的注释字面量喂静态断言假红 / `skill-discovery-errata` 的 pnpm 引擎门陷阱 / `taste-skill` 的外部判据适用性映射）。**建议段 2 一并裁**：13 张新卡是碎片化风险（本仓 lessons 现有 10 张），应与既有卡合并同类项后再定数。

### D. → 手册面（落点合法性待裁，见 §五-2）

| 目标                | 来源                    | 内容                                                                 |
| ------------------- | ----------------------- | -------------------------------------------------------------------- |
| `AGENTS.md` Gotchas | **重启判据族**（§〇-2） | 见 C 表第 1 行——本条**强烈建议落手册**（每票收口都用，必须常驻可见） |

---

## 四、未闭项 / 残余挂账（清目录前必须带走，否则成暗知识）

> 判据：每条都答「**什么动作能把它从清单上拿掉**」。

| #   | 目录                     | 未闭项                                                                                                                                                                                                                           | 拿掉它的动作                                        |
| --- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1   | `dispatch-deferral`      | **V4 真仓复测**（`dispatch_state` 不得出现「mentions 非空且远超阈值仍恒 null」的行）                                                                                                                                             | 重启后取一次读数，**或**店长明文豁免                |
| 2   | `docs-run-status-gate`   | G2（待上浮批）/ G3（status 回填）/ G4（pre-push 硬闸）**未派未落**——实测无 `scripts/run-docs-gate.mjs`、`.husky/pre-push` 零相关挂载。**G5 已落**（`scripts/run-docs-stale.mjs` + `closeoutSession` preflight 挂载，`e4ac0418`） | 派活，**或**由本活段 3 承接（见 §〇-1）             |
| 3   | `lessons-first-batch`    | 验收 4（重启后查活库 `chunks` 出现 `docs/lessons/` 行）**未核**；验收 5 声明「§一/§四 两处引用旧断言作前提的句子随本票收口清理」**未清**                                                                                         | 重启后取一次 `chunks` 读数；清掉那两处句子          |
| 4   | `a2a-memory-gate`        | OQ-1（补填提醒以 `role='user'` 落库，全落门外）/ OQ-3（预存 flake 挂账）/ **OQ-4（模块环检测守卫票从未开出**，实测 `scripts/` 无该脚本）                                                                                         | OQ-4 立票；OQ-1/OQ-3 转挂账票                       |
| 5   | `frontend-perf`          | OQ1（重进长会话 O(N)，触发条件 = `getSessionHistory` 上限放宽到 >200 或用户再报卡）/ T2（服务端 typing 节流，触发条件 = 用户再报长流式卡）                                                                                       | 转挂账票（同 `hook-p3-followups` 形态）             |
| 6   | `test-git-env-pollution` | **7 条观察项**，其中 ⑥抢收竞态窗、⑦兜底投递假阳性 明写「**是否立票待裁**」                                                                                                                                                       | 两条待裁的先裁；其余 5 条转挂账                     |
| 7   | `commit-uuid-gate`       | OQ-C：`.husky/` 四钩子 git mode 实测仍全 `100644`（Linux 场景需 `git update-index --chmod=+x`）                                                                                                                                  | 改 mode 落盘，**或**明文判「本仓不面向 Linux 检出」 |
| 8   | `autocommit-blocking`    | 格 2（异步+树锁，WIP 在 `wip/autocommit-async-ge2`）/ 格 3 半落 / OQ（auto-commit 要不要跑人类提交门禁）**未裁**                                                                                                                 | 店长裁「续做 or 判弃」；WIP 分支须一并处置          |
| 9   | `retired-docs-tombstone` | 三处**注销账**（`memory-flywheel.md` 的「存量不收」已被 P1-B 正面推翻、须加注；另两处旧谓语复述）                                                                                                                                | 随该族下一票落（票面已登记「不修、随族带掉」）      |
| 10  | `retrieval-attribution`  | 报告 §6 六条建议**无承接票**（调参/埋点/补语料）                                                                                                                                                                                 | 立票，**或**店长明文判「只建议不执行、无需承接」    |
| 11  | `taste-skill`            | 两份诊断报告的多条发现项**未修且无票跟踪**（M-1/M-4/M-7/M-8 等）；票 F/G 落点未在 `docs/run/` 留文件                                                                                                                             | 立票 / 转挂账 / 判弃——三选一                        |
| 12  | `env-number-guards`      | `parseInt` 族 21 处/13 键待逐键裁；`socketio.test.ts` 用例次序耦合；上浮出口口径乙待裁                                                                                                                                           | 逐键裁 + 立票；口径乙见 §五-2                       |

**清目录前置（注释/文档悬空引用，实测）**：清下列目录前须先改指向，否则「上浮」变断链——

| 目录                     | 悬空引用                                                                                                                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `precommit-scope`        | `CONTEXT.md`「docs 单一写入口」条的括号引用仍指向 `docs/run/precommit-scope/closeout.md` §四（**这就是 G1(b)，实测未做**）；`scripts/precommit-scope.mjs` / `.test.js` 注释引本目录 |
| `docs-single-writer`     | `scripts/closeout-dupcheck.mjs` 及测试头注引本目录                                                                                                                                  |
| `flaky-precommit`        | `scripts/flywheel/embed-server.test.js` 以 `finding-2026-09-16.md` 作根因出处                                                                                                       |
| `test-git-env-pollution` | `.husky/pre-commit` 与 `scripts/pre-commit-env.test.js` 以本目录两文件为背景出处（**清前须先有 lessons 新卡**）                                                                     |

---

## 五、待店长裁（逐条附卡点）

### 1. 本活与 `docs-run-status-gate` / `lessons-first-batch` 的关系（**最优先**）

卡点：三张票目标目录重叠、判据不同版本。`docs-run-status-gate` 的 G2 清单基于 **09-19 基线（19 目录）**，只覆盖今日 37 个中的 10 个；`lessons-first-batch` 的 D2 明写「须排在 G2 之前」。**选一**：① 本活取代 G2/G3（则须在 `docs-run-status-gate` 票面登记 G2/G3 作废或改指）；② 本活是 G2/G3 的执行面（则段 2/3 按 G2 的 10 目录 + G3 的全量回填双轨走）；③ 三票合并为一。**不裁就动手，段 3 会产生重复落点。**

### 2. 上浮出口的合法值域（「口径乙」，`docs-run-status-gate` 已登记未裁）

卡点：实测**多数「已收口可清」目录的结论落在白名单之外**——手册（`CONTEXT.md` ×2、`CODING_STANDARDS.md`、`CONTRIBUTING.md`、`AGENTS.md`）与代码注释面。而 `CONTEXT.md`「文档位置约定」段钉死「结论上浮到 `docs/plans/`（点名，**不二选一**）」，本票判据 4 却写**四落点分流**（plans / lessons / adr + 三不沾清）。二者**语义冲突**，且本票复述面**已实测 5 处**：`AGENTS.md` Pointers 段、`CONTEXT.md` 文档位置约定段 / 判据表「归宿」行 / 收口链段、`docs/run/README.md`「什么时候清」段。
⇒ 这一裁**同时决定**：`floated_to` 的合法值域（G4 悬空落点检查的白名单）、`env-number-guards` 已填的 `floated_to: CODING_STANDARDS.md` 是否合法、以及 §三-D 那条「重启判据落 AGENTS.md」能否成立。

### 3. `eval-system/` 目录去留（**已有店长保留裁决**）

卡点：票面记有店长裁决「**本票面保留不删**——本目录实际实践是保留已关票」，理由是证据链互引、删了造死链；且该裁决自陈「若要把『保留』变成显式规则而非约定俗成，那要另改 AGENTS.md 措辞，属另一票」。⇒ 本活的「清目录」目标对 `eval-system` 是否适用？**建议：先上浮、后议清**，把「要不要打破该目录的保留惯例」单独拍板。

### 4. `hook-fallback-delivery/` 的保留条件是否算兑现

卡点：票面明文「文末挂账 G1 明写『勿随本活收口删除』，故不随收口清理；**G1 兑现或单独立票后再清**」。实测 G1 根因已被 R7 归属校验除根（`serial.ts` 注释自陈「该词随之退役」+ `serial.slot-ownership.test.ts` 钉住），但那是**被旁票解决**，既非「G1 兑现」也非「为 G1 单独立票」。⇒ 算不算满足？我倾向算（根因已除、无残留动作），但不替店长拍。

### 5. `closeout-gate/` 三选一

卡点：它的结论（零夹带正判据 = 双向并集等式；已否决候选 `M^{tree} == M^2^{tree}` 恒假）是本仓独有且经实测的，判据实现全仓零命中、活自 09-16 立票未派。⇒ 派活 / 判弃（须先证已被现有 PR 收口链取代）/ 先把判据表上浮到 `docs/plans/` 再清。

### 6. `docs/run/` 状态位回填（G3）是否随本活做

卡点：实测 **37 个目录只有 5 个带 `status:`**，其中 `skill-discovery-errata` 写的是**中文「在飞」——值域外**（2026-09-20 已统一英文，中文不是兼容别名）。其余 32 个无 frontmatter。⇒ 本活是否顺带回填？回填后 `floated_to` 的合法值域依赖第 2 条。

### 7. 一条手册缺口（顺带报，非本活范围）

实测 `CONTRIBUTING.md`（承载提交规范 / 代码审查链 / 测试约定 / 分支与 worktree，即**开发流程**）**不在 `AGENTS.md` Pointers 段**里。而 `hook-marker-fail-open` 的结论已落在该文件 ⇒ 落点存在但索引不可见。⇒ 要不要补进 Pointers，另裁。

---

## 六、本报告自证

- **零删除、零修改**：`git status --porcelain` 在写入本文件前为空；本文件是本次唯一新增物。未动 `docs/run/` 任何既有文件、未动 `docs/plans|lessons|adr`、未动 `AGENTS.md` / `CONTEXT.md`、未动任何代码。
- **未做任何 git 写操作**；未起 server、未碰 3200/5173。
- **取证面**：`git ls-tree` / `git cat-file -t` / `git merge-base --is-ancestor` / `git grep` / `git log --diff-filter` / `ls` + 计数，均为字节级或计数级 oracle。
- **未采信的转述**：本次引用的 **43 个 sha 全部独立实测**（对象存在 + 已落 dev，43/43 通过）；两处与旧盘点相反的关键判定（`hook-fallback-delivery` 的 G1、`eval-system` 的保留裁决）均回到票面原文核实后才落笔。
- **与前次盘点的关系**：`docs/run/retired-docs-tombstone/run-inventory.md`（2026-09-19，19 目录）是**同类产物的前身**，本报告**不是**它的第二版——其 §四已落格为 `docs/lessons/open-items-list-needs-status-bits.md`、§五已逐字抄入 `docs/run/docs-run-status-gate/tickets.md`，二者都不会因清目录而丢；**唯一会丢的是它 §二 的逐目录上浮清单**（尤以 B-7「`flaky-precommit` → `docs/plans/memory-flywheel.md` §2.4」**至今未执行**），本报告已在 §三-B 与第 14 行显式承接该条。**引用旧报告前请先确认其条目此后无状态变更**——它自带一条 2026-09-23 的订正，且其 §二 表已部分过时。
- **未读到 / 读不懂的**：无。全部 37 个目录的文字文件均已通读（`eval-system` 的 3 份原型 HTML 只扫头注与标题；`retrieval-attribution/appendix.json` 只读键名与开头；两个 `probe*.mjs` 只读开头注释——三者均按边界不作为结论依据）。
- **判据边界**：本报告只给状态与建议，**不替店长裁决**；§五 逐条附卡点。段 2 裁决前，本报告不构成任何「已上浮」的声称。
