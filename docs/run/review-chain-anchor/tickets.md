# 审查链锚统一 · 票单（to-tickets 产物）

> 来源 spec：`docs/plans/review-chain-anchor.md`（spec-gate PASS，commit e759788）
> 排序依据：用户裁决（2026-09-10）—— **先止当下痛，后治根因**。本票单按**执行序**排，非 spec 章节序。
> 原始痛点：`commit` 与「审查投递」硬绑定 → 每次提交（含返工）都开一条新链。

## 术语（三词钉死）

| 词            | 定义                                                                     | 落点                             |
| ------------- | ------------------------------------------------------------------------ | -------------------------------- |
| **锚**        | 链内不变的任务标识 = **`messages.task_id`**                              | 表既有列，不新增字段、不引入别名 |
| **chainType** | 投递消息上的声明字段 `first \| followup`，**对账位**（不参与链归属裁决） | 投递入参                         |
| **审查者**    | 本仓库当前 = 吐槽猫                                                      | —                                |

锚的**值**：首轮 = 该轮执行的 `trace_id`（服务端生成）；链内每跳 = **继承**触发消息的锚，不新生成、不由猫手动搬运。
驳回「消息 id 当锚」：它是 `task_id` 的**下游派生**（躺在同一张表同一列），用下游校验上游，救不了任何东西。

---

## 阶段一 · 止当下痛（无阻塞，优先）

### T-A｜兜底投递：提交与审查投递解耦

**交付**：钩子不再「每 commit 投一条」。改为「主动投递为主、漏投兜底补、全程只投一条」。返工不再叠链。

**关键设计——判定点必须在两个时刻，不能合并**

commit 发生在执行**中途**（猫在工具循环里跑 `git commit`），此刻它的回复尚未产生，「已投递吗」物理上无答案；而用户手动提交**没有执行可挂靠**，只能在钩子侧判。故：

| #   | 判定点                     | 判什么                                           | 动作                                                |
| --- | -------------------------- | ------------------------------------------------ | --------------------------------------------------- |
| ①   | 钩子（commit 时刻）        | 该 commit **有无归属执行**                       | 无归属（用户手动提交）→ **兜底投递**；有归属 → 静默 |
| ②   | 执行收尾（reply finalize） | 本执行有 commit 且其回复 mentions **不含审查者** | 补投；已含 → 静默；无 commit → 静默                 |
| ③   | 任一步判据查不动           | —                                                | **一律投递**，不静默吞                              |

**「已投递」判据**：回复的 `mentions` 含审查者（`mentions` 是文本 @ 与 `post_message` 两通道的**并集**写回，见 `serial.ts:514-517`）。
**这是启发式**——@审查者 用于非审查用途时漏兜一次 = 退回今天行为；阶段二用锚 + chainType 收紧。

**边界**：

- 投递**形态不变**（仍是现有补填请求），只改触发条件
- `--gate-deliver` 补投路径不受影响（独立入口）
- `.handoff-delivered.json` 的去向**在本票定死**（spec OQ5 遗留）：钩子只做归属后，账本键（SHA）与新判据（链）不同源 → 实施者给方案 + 证据，不自行猜
- **必须留痕**：判据每一次裁决都记日志（投/不投 + 理由）——这是本票唯一的安全网

**验收（行为可验证）**：

- [ ] 有归属的普通提交 → 钩子投 **0** 次；收尾在「回复已 @ 审查者」时也投 **0** 次（全程合计 1 条 = 主动那条）
- [ ] 返工（同链第二次 commit）→ **不新起链**（原痛点复现用例）
- [ ] agent 提交但回复未 @ 审查者 → 收尾兜底投 **1** 条
- [ ] 用户手动提交（无归属）→ 钩子兜底投 **1** 条
- [ ] 判据查询失败 → 投递（不静默）
- [ ] **端到端真机一轮**：一条真实派活 → 主动投递 → 审查 → 返工，全程**只观察到 1 条审查请求**
- [ ] 单测三分支 + handoff-gen 现有测试全绿

**重启**：钩子侧（`scripts/`）不涉重启；收尾兜底（`server/`）涉重启。

---

### T-B｜`request-review` 技能（2026-09-10 修订：A 方案 + 范围收窄）

**背景（前置发现，决定本票形态）**：ADR 0014 §5 曾把 `request-review` 从技能层**连根拔掉**，且 `scripts/mcp-server.test.js` 有硬断言守着。本次回流是**用户拍板的反转**（§5 的移除前提「post-commit hook 机械投递」正是本轮要拆掉的），同车在 ADR 补留痕。

- **F1**：§5 称内容资产「并入 `skills/refs/review-request-template.md`」——文件在，但末行仍是「行首 @审查者 发起审查…」，正是 §3 明令禁止的路由表述（并入时漏剥）。
- **F2**：§5 称由 `code-review` 承担——实测 `skills/code-review/` **不在 `SKILL_CATALOG`**（猫经 `read_skill` 读不到），且正文携带本仓库零在场的 matt 依赖。承担者从猫可读面看**实际不存在**，即 §5 的一个未兑现前提。

**交付**：新建 `skills/request-review/SKILL.md`（照 clowder `request-review` 形式，砍掉沙盒路径 / 跨家族匹配 / PR 三块——本仓库不存在）。
含四块：

1. **前置门槛（BLOCKED 六条）**：quality-gate 通过 / 测试全绿 / 原始需求可引用 / ownership 声明 / 前端真机自证 / 根目录工件闸门。不满足 → 请求**发不出去**。
2. **R2+ 同型 finding → 强制 failure-mode audit**（作者先扫全 diff 再修）。
3. **同对象 ≥3 轮 → 停手升级到需求/方案层**（F229 20 轮教训）。
4. **模板引用**共享 `skills/refs/review-request-template.md`（**不重写模板**）。

**变更面（一个 commit）**：SKILL.md 新建 · `manifest.yaml` 登记 + `pipeline.review` 插入 · `mcp-server-utils.mjs` 8→9 · `mcp-server.test.js` 断言**翻转并加强** · `refs/review-request-template.md` 剥路由行（F1） · ADR 0014 §5 留痕（含 F2 修正）。

**边界（不反转 §6.1）**：技能正文**零路由**——不含 `@谁` / `请谁审查` / `投给谁`；派活单 / `flow_state` / handoff 都不进 skill。原「第 5 块：handoff 机械生成搬进技能」**砍掉**——撞 §6.1，且依赖 T-A 对 hook / `.handoff-delivered.json` 的结论。

**无阻塞**，可与 T-A 并行。

**验收**：

- [ ] `node scripts/skills-check-manifest.mjs` → **28/28 全覆盖**，exit 0
- [ ] 静态源断言：技能文本含上述三条领域规则（BLOCKED 六条 / failure-mode audit / ≥3 轮升级）
- [ ] 静态源断言：SKILL.md **正文零路由**（无 `@` 提及）——把 §3 不变量真正守起来，不随本次翻转一起消失
- [ ] `mcp-server.test.js` 全绿：9 技能 + 零路由断言两条都在
- [ ] `refs/review-request-template.md` 无 `@` 行
- [ ] ADR 0014 §5 留痕段落存在
- [ ] 「门槛不满足发不出去」在本票 = **猫自守 + 静态源断言**；**机械阻断归 T-F 入口主闸**，不在本票做

---

### T-C｜判词三档 `COMMENT`

**交付**：审查结论从 ✅/⚠️ 扩为 ✅/⚠️/💬。`COMMENT` **不阻断收口、不起新链、不触发返工派发**。

**无阻塞**。与 T-B 同属「审查流程升级」，建议同批。

**验收**：

- [ ] 带 `COMMENT` 的判词后，同一条链**仍可收口**（与 ⚠️ 行为可区分）
- [ ] `COMMENT` 不触发返工派发、不新起链
- [ ] 同级冲突取最严的现有规则不被打破

**生产者侧贯通（2026-09-10 T-D 复审 必改 2，随 T-D 返工补）**：本票原实现只动**消费方**（`verdict-parser` / `flow-advance` / `hints`），**生产者侧零落点**——审查猫自己的 prompt 与它读的 refs 仍只写三档 → 「机器认 💬、猫从不发 💬」，**本票全部改动不可达**。已补齐全部枚举落点：`seed-data.ts`（`REVIEWER_DUTIES` 三行 + 吐槽猫 `systemPrompt` 的 Review 指南 + 3 只实施猫 prompt + `mention-policy.ts` 注释）、`skills/refs/review-standards.md` 结论表、`skills/refs/shared-rules.md` 分流、`skills/catstudy/refs/cat-roles.md`、`skills/receive-review/SKILL.md`、`skills/refs/pr-template.md`、`README.md`。

- **向严不向宽边界已写进 prompt**：💬 只装「不要求返工的观察项」，判不准时取严——**不得把已判定的 ⚠️ 因"问题不大"改判 💬**。
- **新增生效判据**（并入 T-D 段那条 seed 硬前置）：吐槽猫 `agents.system_prompt` 与 `IRON_LAWS_REVIEWER` **contains** `💬仅评论`。
- **回归护栏**：`seed-data.test.ts` 新增断言把「猫能发 💬」钉成契约——**改动前该断言必红**（HEAD 版本 `seed-data.ts` 中 💬 出现 0 次，实测）。

---

### T-D｜文案对齐

**交付**：铁律、`skills/quality-gate/SKILL.md`（现写死「通过后由 post-commit hook 自动触发审查」）、system prompt —— 全部改为「由 Agent 自己投递，建议使用 `request-review`」。

**Blocked by**：T-A（钩子行为已变）、T-B（技能已存在）。

**验收**：

- [ ] 全仓 grep 无残留「自动触发审查」表述
- [ ] 文案指向的技能名真实存在

**T-B 复审连带（2026-09-10 吐槽猫 ⚠️，计数消费方清单）**：同一「8→9」事实在仓库有 7 处落点，T-B 修掉 5 处（`mcp-server-utils.mjs` 工具描述 + `listSkills` 注释、`mcp-server.test.js` 两处测试名、`manifest.yaml` 27/27→28/28）。**余下各处归 T-D 一并收**，勿再按单点修：

- `manifest.yaml:325`「投递型定制层（handoff/request-review）…已移除」——与同文件 `:345-347` 的 `pipeline.review` 现直接矛盾
- `manifest.yaml:340` / `:351`（铁律一「post-commit hook 触发 handoff-gen，Agent 只补填不自行发起」）
- `docs/adr/0014:68` 白名单枚举仍 8 项、仍写「request-review 已从技能层移除」
- `docs/research/skill-delivery-decoupling-spec.md:80`、`skills/refs/shared-rules.md:28/44/96/97` 路由口径（历史快照 / 共享 ref，两者本票均未动）

**收口硬前置（2026-09-10 吐槽猫 ⚠️ 实测，T-D 复审带入）**：本票的文案**不会自动生效**——铁律三段（`COMMON_IRON_LAWS` / `CODER_DUTIES` / `REVIEWER_DUTIES`）经 `getIronLaws()` **运行期注入**，改常量 + 重启即生效；但 3 只实施猫的 `systemPrompt` 与知识库文档是 **seed 烘焙落库**的（`db/repository/agents.ts:113-115` 的 `ON CONFLICT(name) DO UPDATE SET system_prompt = excluded.system_prompt`），**只有跑 `pnpm seed` 才写**。

- **机制更正（原表述错）**：铁律与 DB 角色块是**叠加**关系，不是覆盖——`execution/reply.ts:403-407` 的守卫 `!agent.systemPrompt.includes(ironLaw)` 实测**恒真**（旧库 prompt 668 字不可能包含 1727 字新铁律）→ **不 seed，实施猫 prompt 里同时存在**「post-commit 自动投递审查链」与「自行发起」两条互斥指令。
- **生效判据**（seed 后实查 DB）：3 只实施猫的 `agents.system_prompt` **not contains** `post-commit 自动投递审查链`，且 **contains** `request-review`。
- **落哪个库**：本会话走 dev 库（`db/index.ts:13`，`NODE_ENV≠production`）；prod 库（`cat-study.db`）下次启用前同样要跑。
- **执行者**：写 DB 状态，归店长**收口时**执行，不在实施猫权限内。

---

## 阶段二 · 治根因（链锚统一）

### T-E｜链锚贯通：首轮自动生成 + 全链继承

**交付**：锚 = `messages.task_id`。**首轮由服务端自动生成**（值 = 该轮 `trace_id`，今天已生成、只是没落列：`ingest.ts:70-71` 生成 `traceId`，`:103` 落的是调用方的 `taskId || null`）；链内每跳原样继承（`reply.ts:822`、`serial.ts:743`）。

**猫不需要手动传锚**——它在触发消息里，自动带上。`|| traceId` 静默兜底**降级为首轮生成**，不再是漏带逃生舱。

**验收**：

- [ ] 发一条真实用户消息 → 落库行的**锚（task_id）非空**，且 = 该轮执行的 `trace_id`
- [ ] 该链首轮回复的锚 = 触发消息的锚（不引入第二个值）
- [ ] 再走一跳 A2A（@ 某猫）→ 下一跳回复的锚**不变**
- [ ] 带显式锚的 REST 注入原样落库（不被覆盖）

---

### T-F｜投递契约 + 入口主闸

**交付**：审查类投递必须带 **锚 + `chainType`**。缺锚 / 缺 `chainType` → **入口 400** 当场退回；`chainType` 与结构推导冲突 → 拒绝，不猜测。审查猫保留**语义次闸**（收到绕过入口的直投且无锚 → 不审，回一句要求带）。

**Blocked by**：T-E。

**第 0 步（未决实测，先贴结论再动手）**：入口怎么识别「agent 发起」。若无可判字段 → 走**路由级判据**：socketio `SEND_MESSAGE` 与 OneBot 连接器 = 人类入口（允许空锚），REST `/api/messages` = Agent 入口（强制锚 + `chainType`）。

**验收**：

- [ ] agent 发起的投递缺锚 → 400；用户消息空锚不受影响
- [ ] 审查类缺 `chainType` → 400；声明 `first` 但链已存在 → 拒绝；声明 `followup` 但锚为空 → 拒绝（三方向各一例）
- [ ] 结构推导查不动 → 以声明为准 + 记日志，不拒绝、不静默改归属

---

### T-G｜四消费方按锚对齐（含两条 live bug）

**交付**：评估归档（`eval/episodes.ts`）、收口推进（`execution/flow-advance.ts`）、重放跳过（`execution/recovery.ts`）、上下文回捞（`execution/reply.ts`）全部改按锚查。同时修掉**今天就在静默出错**的两条：

- **评估判 `success` 失真**：链末 trace 在 `messages` 表 0 行 → verdict 空集 → `classifyCompleted` 判 `success`，打回检测形同不存在
- **收口提醒指错 sha / 真提醒被吞**：`getCommitHashByTraceId` 假设 1 trace→1 commit，实测 1:N → 恒取最新 → 提醒写错 sha；且 `flow_states` 按 (session, sha) exactly-once → 第二条判词撞已 close → **真提醒永久不投且不报错**

**Blocked by**：T-E、T-F。

**验收**：

- [ ] 同一条链的判词**查得到**（现状 0 行 → 修复后命中），评估不再无条件判 `success`
- [ ] 一条链挂多 commit 时，收口提醒的 sha = **被审的那个**
- [ ] 同一链的第二条判词**仍能投出提醒**（不被 (session, sha) 记账吞掉）
- [ ] 回捞限定链内 + 条数/时间窗上限（治一个 task_id 名下 20 条 / 7.7 万字符）

---

### T-H｜T-A 复盘三合一：判据收紧 · 多 commit 覆盖 · 判据 e2e

**来源**：T-A 审查（吐槽猫，2026-09-10）在 OQ 逐条落锤时点出的三条同族缺口——同一处归属判据的三个失效面，**一次修**，不按单点修。

**无阻塞**：与 T-E / T-F / T-G 无依赖，可独立开工。

**交付**：

1. **归属判据假阴性**（T-A OQ-1）：`scripts/handoff-gen.mjs` 的 `attributed = updated > 0` 只数 `status='running'` 行，
   于是「该 uuid 从无执行行」（= 真手动提交，该投）与「执行已终态 / 同猫并发另一条在跑」**同得 0**
   → 后两者被误判成手动提交 → 多投一条。改判据为「**该 uuid 存在任一状态的执行行 → 有归属 → 静默**」。
2. **一执行多 commit 的审查请求覆盖**（T-A OQ-4）：同一执行提交多个 commit 时，钩子（`runHandoff`）与收尾兜底
   （`getRunningExecutionCommitHash`）**都只看 HEAD**，补投文档的 `range` 也只有 `sha~1..sha`
   → 早期 commit **全流程拿不到审查请求**（与既有 post-commit 行为同口径，非 T-A 引入，但 T-H 要裁决）。
   需定：逐 commit 覆盖，还是显式接受「只看 HEAD」并写进 Tradeoff。
3. **判据的 e2e 覆盖**（T-A N4）：`scripts/handoff-gen.e2e.mjs` 的 stub server 无 commit-hash 端点
   → `attributed=null` → 走降级投递，**三条判据在 e2e 里全不生效**（这也是 e2e 仍全绿的原因）。
   补一条「stub 返回 `updated:1` → POST **0** 次」，并附**阴性对照**证明该断言能区分新旧（不是恒真）。

**T-D 复审带入（2026-09-10 吐槽猫 ⚠️，同族「假机制陈述 / 守卫半闭」，本票立名分、不单开票）**：

4. **refs 守卫只覆盖单个 SKILL.md**（T-D N7）：`scripts/mcp-server.test.js` 的 refs 枚举派生实测只扫 `request-review/SKILL.md`；
   全仓另一个引 refs 的 `receive-review/SKILL.md:24 → refs/review-standards.md` **零覆盖**（该 ref 实测 `@` = 0，无实害）。扩成扫 `skills/*/SKILL.md` 是三行改。
5. **`execution/reply.ts:403-407` 防重复注入守卫是死代码**（T-D N8）：实测 DB prompt 从不含完整铁律 → 恒追加。
   非 T-D 引入，但它是「旧库出现双份 / 矛盾 prompt」的机制底座——留痕以免下个读者继续以为「运行期注入会覆盖 seed 烘焙」。
6. **`eval/phase0.ts:361` ext-05 金标答案陈述假机制**（T-D OQ-5）：仍写「post-commit hook 据此自动投递审查链」。
   T-D 有意未改（eval golden 是已收口基线，改金标会扰动 judge 校准的历史可比性；且它不注入任何猫的 prompt）——在此立名分，别无限期挂着。

**顺带观察项**（本单一起看，不必单独修）：

- **N5** 取值型 flag 被后随 flag 贪吃（`--cwd --no-post` → `{cwd:'--no-post'}`）：自限于 git 校验（畸形值立刻撞
  `不是 git 仓库`），进不去投递路径。硬化方式 = 取值以 `-` 开头即报错。
- **N6** `spawnReviewFallback` 的 `stdio:'ignore'` 吞掉子进程失败原因；`stdio:['ignore','ignore','inherit']`
  （inherit 传父进程 fd、**不建 pipe**）与 `child.unref()` 不冲突，实测父进程 9ms 退出。

**验收**：

- [ ] 执行已终态、同猫并发两种情形下重跑，均判「有归属 → 静默」（各一例）
- [ ] 一执行多 commit 的覆盖范围有明确裁决，且代码与裁决一致
- [ ] e2e 补判据用例 + 阴性对照（旧实现下该断言必须红）

---

## 依赖图

```
阶段一（优先）
  T-A 兜底投递 ─┐
  T-B 技能      ├─→ T-D 文案对齐
  T-C COMMENT ──┘
阶段二（根因）
  T-E 链锚 ─→ T-F 主闸 ─→ T-G 四消费方对齐
```

**跨阶段无硬依赖**：阶段一的「已投递」判据用 `mentions` 启发式，不依赖锚 → T-A 可立即开工。阶段二落地后应收紧为锚判据。

## 不在范围内

- 视觉统一（全猫换 flash + 删图测猫 / vision-assist）——用户明示后置（spec D7）
- 两行 task_id 交叉互换脏数据的成因（2/882，可能旧 build 写入）——挂受控复现小单，不当定案依据
- `query_db` 白名单缺 `episodes` / `review_verdicts`——挂后续
