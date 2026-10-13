# docs/run/ — 开发文档（在飞）

这个目录放**还没结束的活**的票单。

## 谁写

`to-tickets` 切票时由**调用方**指定落点：一个活 = 一个目录 `docs/run/<work-slug>/`，
票单本体是 `docs/run/<work-slug>/tickets.md`。

一事一目录，不扁平堆单文件——本仓并行跑几十个会话 worktree，扁平命名必撞、互覆。

`<work-slug>` 用 kebab-case、不加日期前缀（日期前缀是归档件的命名词汇，本仓已不用——归档语义改由状态字段承担；
`docs/run/` 是在飞件，slug 只要本轮可读、可 grep）。

落点在调用方（`CONTEXT.md`「文档位置约定」），不写死在 `to-tickets` 正文里；
skill 只管切票，谁调用谁指定往哪落。

## 什么时候清

**活收口即清。**

活结束（合并 / 废弃 / 需求变更）时：

1. 结论**按落点分流上浮**（**点名，不二选一**）：定稿规格 → **`docs/plans/`**、经验教训 → `docs/lessons/`、架构取舍 → `docs/adr/`、操作规则 → 手册面（`AGENTS.md` / `CONTEXT.md` / `CODING_STANDARDS.md` / `CONTRIBUTING.md`）——`docs/sessions/` 归 session-summary skill 另产，不是 run 收口的上浮出口；
2. 删掉 `docs/run/<work-slug>/` 整个子目录。

本文件（`README.md`）是目录门牌，长期保留；`<work-slug>/` 子目录一个都不留。

**这一步挂在收口链上**（`CONTEXT.md`「流程约定」）——清 `<slug>/` 是收口的固定动作之一，
不靠谁记得。**落点和顺序都有讲究**：它必须提交在**要进 PR 的那个分支**上（在会话 worktree
内提交）——落在 `dev` 上就进不了 PR，远端永远清不掉 `<slug>/`；并且排在**主工作区 `ff-only`
合并回 `dev` 之前**（因而也在**更新 `.push-gate` 之前**）——`.push-gate` 必须指向最终 HEAD，
否则推送会被 pre-push 门禁阻断（`merge-base --is-ancestor` 判「有新 commit 未经 review」）。

## 为什么必须清

票单是**在飞状态**，不是知识。它的价值在活没结束时；活一结束，读者就从
「本轮实施猫」变成「下个会话的猫」，而后者要的是「为什么这么设计」，不是
「当时拆了几张票、谁 block 谁」。

排出机制的意义在这个仓有前车之鉴：`docs/plans/` 与 `docs/research/` 都是**定稿件**
（活结束即停更），守着「原地保留、读者自行判时效」的规矩——这是可接受的，因为它们
**每个活最多增一份、且定稿后不再被修改**。而 `docs/run/` 是**在飞件**：每个活、每轮改动
都往里堆，没有排出机制就会**无限增长**，几个月后没人分得清哪些票单还有效。
同样的规矩不能套在会持续生长的目录上——这才是它必须清的真正理由，与 `plans/` 定性无关。

判据表见 `CONTEXT.md`「文档位置约定」。

## 存量挂账登记（2026-10-13 · `run-conclusions-float-up` 段 3c 清点）

本目录**只应存在在飞票与挂账票**。下表是清理后的存量清点——**每行必须答出「什么动作能把它从清单上拿掉」**：只增不减的清单会让「活完了就清」不可判（判据见 `docs/lessons/open-items-list-needs-status-bits.md`）。每目录的 `status:` frontmatter 是机器面，本表是理由面。

| 目录                     | 留存理由                                                                                                                        | 拿掉它的动作                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `db-schema-governance`   | 设计面已在 `docs/plans/db-schema-governance.md`，余下**全是未派的执行队列**（票 6 批二 / 票 8 / 根治剩两刀）+ 一处重启待批      | 三批执行完并各自收口                                |
| `autocommit-blocking`    | 格 2（异步 + 树锁，WIP 分支 `wip/autocommit-async-ge2`）/ 格 3 半落 / OQ「auto-commit 要不要跑人类提交门禁」**未裁**            | 店长裁「续做 or 判弃」，WIP 分支一并处置            |
| `commit-uuid-gate`       | 判据与多态已落代码 + `CONTRIBUTING.md`；OQ-C（`.husky/` 四钩子 git mode 实测仍全 `100644`）带钉死触发条件                       | 改 mode 落盘，**或**明文判「本仓不面向 Linux 检出」 |
| `docs-run-status-gate`   | G2/G3 已由本活承接（票面已登记）；**G4 pre-push 硬闸未派未落**                                                                  | G4 落地并收口                                       |
| `hook-p3-followups`      | F1/F2 未落地（F3/F4 已随 `run-conclusions-float-up` 段 3a 落）                                                                  | F1/F2 派活收口                                      |
| `a2a-memory-gate`        | OQ-1（补填提醒以 `role='user'` 落库，全落门外）/ OQ-3（预存 flake）/ **OQ-4（模块环检测守卫票从未开出）**                       | OQ-4 立票；OQ-1/OQ-3 转挂账                         |
| `frontend-perf`          | OQ1（重进长会话 O(N)，触发条件 = `getSessionHistory` 上限放宽到 >200 或用户再报卡）/ T2（服务端 typing 节流）——均带钉死触发条件 | 触发条件命中后处理                                  |
| `taste-skill`            | 两份诊断报告的多条发现项**未修且无票跟踪**（M-1 / M-4 / M-7 / M-8 等）                                                          | 立票 / 转挂账 / 判弃——三选一                        |
| `test-git-env-pollution` | 7 条观察项，其中 ⑥抢收竞态窗、⑦兜底投递假阳性明写「**是否立票待裁**」                                                           | 两条先裁；其余 5 条转挂账                           |
| `closeout-gate`          | 段 2 单点 2 裁决「**先把判据表上浮 `docs/plans/` 再清**」（判弃须先证被现有收口链取代，举证成本高）；活自 09-16 立票未派        | 判据表上浮后清目录                                  |
| `dispatch-deferral`      | 内容已上浮 `docs/plans/execution-tail-concurrency.md`，但 **V4 验收未闭**（读数见下节）                                         | V4 残留行分类完 + 店长豁免或订正后清                |

在飞（随各自收口清，不单独登记触发条件）：`run-conclusions-float-up`（本活）· `handoff-double-frame` · `message-date-timestamp` · `scroll-stick-bottom`。

### 段 3c 实测：`dispatch-deferral` 的 V4 读数**未确认沉淀**（该目录因此留）

- **判据口径**：`messages` 里「`mentions` 非空」而 `dispatch_state` 恒 `NULL` 的行（`dispatch_state` 只说明「还没发」，判据必须带时点）。
- **读数**（活库 `-dev`，2026-10-13）：全库 `mentions` 非空 **2306** 行 / `dispatch_state` 非空 **2160** 行 ⇒ 差 **146** 行恒 NULL。修复后窗口（`created_at > 2026-09-17`）：非空 **933** / 有 state **882** ⇒ 差 **51**；拆开 = `role='system'` **40** 行（系统「改进素材」通知，本就不是派发触发，全 NULL 属正常）+ `role='agent'` **11** 行。
- **11 行 agent 残留**落在 `2026-09-17 .. 2026-10-01`；近 12 天零命中（近 2 日 33 行里唯一一行 NULL 是 system 行）。派发时延本身已正常：修复后「回复落库 → 目标执行 `started_at`」实测 **2 ms / 108 ms / 125 ms** 量级，无 47 / 68 分钟级迟到。
- **一例硬反例**：`a86488bd`（2026-09-30，店长 @ds猫 的段 3c 派活单）——`execution_logs` 里以它为 `triggered_by_message_id` 的行**零条**，即该派发从未发出（13 天后由重投兜底）。**根因未分类**：延迟 / 队列随重启丢失 / 成员面静默丢弃三条机制未被区分。
- ⇒ 结论不是「近 12 天没再出现 ⇒ 沉淀」，而是「**残留行逐行分类完** 才叫沉淀」。分类动作归后续票或店长豁免。

### 清后残留：已删目录的路径引用（本批**未改**，逐类留痕）

段 3c 已清掉 25 个目录；下列引用仍指向它们。**不随本批改**的理由逐类给出——判「清干净了」时请连本表一起读。

| 面                                                                                      | 命中                                       | 不改的理由                                                                                                  |
| --------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `docs/lessons/**`（6 处）+ `docs/plans/**`（1 处）                                      | 卡片与规格的「源：`docs/run/…`」溯源行     | 白名单三目录，段 3c 边界禁改；且原句自带「（在 `docs/run/**`，活收口即清）」时效自陈，清后仍成立            |
| `docs/eval/*.json`、`docs/eval/retrieval-baseline-*.md` 生成头                          | 产物的 `ticket` 字段 / 生成头文案          | 取证快照，改了等于篡改复算产物（`retrieval-golden.json` 还是评估的黄金集本身）                              |
| `scripts/eval/retrieval-baseline.mjs`、`scripts/eval/retrieval-attribution-recheck.mjs` | 生成器里的**字符串字面量**（缺省产物路径） | 非注释，改它 = 改生成物行为；且它描述的是一条**仍指向已清目录的脚本缺省落点**，该落点要不要改属代码面，另裁 |
| `scripts/precommit-scope.test.js`（3 处）                                               | `resolveScopes(['docs/run/…'])` 的夹具入参 | 行为面：测的就是 `docs/run/**` 路径的档位判定，删了测试即失义                                               |
| `docs/run/**` 自身（在飞/挂账票内）                                                     | 各票面里对已清兄弟目录的引用               | 在飞票的过程记录，随各自收口一并消失                                                                        |
