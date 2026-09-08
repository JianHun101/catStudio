# Spec：投递外移 — Skill 管领域，投递管「谁接下棒」

> **来源**：ADR 0014（`docs/adr/0014-skill-delivery-decoupling.md`）的执行规格。本 spec 把 ADR 的「三契约」落成可拆票、可验收的形态。**用户拍板方向已并入**：去两级注入、启用 base（剥投递后）、淘汰 catstudy 投递定制层、契约③状态机进本批（完整闭环测试）、承载物 = 铁律层出口检查段。

## Problem Statement

投递方向（「这单给谁」）焊死在 skill 内容里——`request-review` 教「作者**@审查者**」（base `skills/request-review/SKILL.md:68`、描述 L3 `@mentioning the paired reviewer`），`handoff` 教「末尾行首**@审查者 请审查**」（catstudy `handoff/SKILL.md:67`）。这一焊，三类病根实测集齐（旧注入层注释自证，request-review 因之停用）：

1. **字面不解析 → 静默丢单**：`@审查者` 字面在 skill 块 append 后才进文本（旧注入层 skill 注入晚于 `reply.ts:417` 的 `resolveRolePlaceholders`），mention 精确匹配落空 → 投递静默丢失（吐槽猫审查 P1 的直接原因）。
2. **与铁律一冲突**：铁律说「审查由 post-commit hook 机械触发、agent 只补填」，skill 却说「作者自己 @审查者」——内容自打架。
3. **双触发**：DS 猫自发 @ + hook 再追一次。

这是结构性病根（路由被编进内容），不是单点 bug。投递外移 = 把「路由」从 skill 正文拆出来，收回收口判断的**强制动作**层。

## Solution

- **skill 只管领域**（怎么把活做对），内容里**不再含任何 `@谁`/`请谁审查`/`投给谁` 的指令**。
- **投递外移为「铁律层出口检查段」**：`packages/server/src/config/iron-laws.ts` 的共通铁律层（`COMMON_IRON_LAWS`）出口检查段，从「自问 + 投递给下一棒」升级为「**流程未结束必须产出投递信号 `{targets, intent, ref}`** → 调 `post_message` / 行首 `@`」。触发锚点从 skill（软、字面死）**迁移到铁律层**（硬、可解析、每回复在场）。

### 三层可靠性叠起来（回应「外部投递不好触发」）

1. **判断式（强制）**：铁律层出口检查段——每条回复收尾的**强制动作**，agent 都走。
2. **结构化路由**：`post_message` 结构投递（不靠字面 @ 匹配，解析层确定）。
3. **机械兜底**：post-commit hook + 契约③ `flow_state` 状态机——判断式失灵时机械兜住。

## 契约（对应 ADR §4，本批一起落地）

### 契约① 信号形状 + 承载物

- **信号形状**：轻信号 `{targets, intent, ref}`（`targets` 为 **`string[]` 数组**——对齐传输层 `post_message` 的 `targetCats` 真实形状，如 `{targets: [吐槽猫], intent: review_commit, ref: <sha>}`），不载全文、不比较内容。
- **shape 对齐原则**：契约即传输层形状，不设适配层。`targets: string[]` 直接承载 `post_message` 多播（一次投多只，CLAUDE.md 明确支持）；`at-mention` 通道转成多行 `@`。**用户 2026-09-08 拍板**：弃 `target: string` 单数（对已审 T1 契约 shape 的修订，因 `planDelivery`/`buildDeliverySignal` 无生产消费点，改零涟漪）。
- **ref 主键**：以 **commit_sha 为主键**（定位 + 去重同源）；纯会话无 commit 退 **trace_id** 兜底。trace_id 仅作**关联列**，绝不替代 ref 做定位/去重。
- **承载物**：信号产出动作写入**铁律层出口检查段**（非「结尾顺带想想」软触发）；产出 → `post_message` / 行首 `@`。

### 契约② 结尾思考的成本

- 优先**确定性推导**（从本轮上下文 + manifest 主链按规则算出投给谁），必要时才升格轻推理——否则每轮多一跳 LLM 撑不住。

### 契约③ 状态机 + 机械兜底（进本批，完整闭环）

- **当前状态**（commit 走到哪步，如是否已 quality-gate）→ DB 字段 `flow_state`，键 `(session_id, commit_sha)`，值如 `quality-gate`。service 在投递/事件发生时**同事务更新**。不变的事实，主链（manifest）调整不影响历史行。
- **下一步动作**（触发谁、什么 intent）→ **不落库**，运行时程序读 `flow_state` + 查 manifest 主链 **机械算出**，全程无 agent 参与（派生数据，落库需跑迁移=一致债）。
- **审计留痕** → 日志，每次投递/状态变更随写，做兜底留痕。与字段双保险。
- **状态机边界**：只管**主干道**（机械确定，如 quality-gate PASS → 自动触发 request-review）。岔道——实现猫卡住@求助、审查❌打回、需求需澄清——**不进状态机**，走判断式投递。

## 用户故事

1. 作为审查猫，每个 commit 的审查请求**恰好触达我一次**（无双触发、无静默漏审）。
2. 作为实施猫，干完活自动把改动送到审查者面前，**不用手写 `@审查者`**（会静默死）。
3. 作为店长，已闭环的审查结论**恰好路由我一次**收口。
4. 作为架构师，**投递行为集中在一个外层**定义，改审查链拓扑不用改 N 个 skill。
5. 作为审查猫，拿到**以 commit_sha 为键**的待审信号，跨通道能对账、能去重。
6. 作为实施猫，**纯会话（无 commit）**靠 trace_id 兜底投递，闲聊类消息不漏。
7. 作为店长，skill 只装领域内容，铁律一和 skill 内容不再互撕。
8. 作为学技能的猫，skill 教我**怎么判**（该查什么），而不把「给谁」藏进正文。

## 边界（In / Out of Scope）

### In

- skill 内容剥投递（base `request-review` 剥「选择审查者/@审查者」，`handoff` 剥「行首@审查者」）。
- 铁律层出口检查段承载投递信号产出。
- 投递信号 `{targets, intent, ref}` 契约 + 判断式投递链路（`post_message`/行首 `@` 消费）。
- request-review 信号**直接启用 base**（剥投递后），不建 catstudy 投递定制层；老投递版淘汰。
- 契约③ `flow_state` 状态机 + 主链机械推导（进本批）。
- 完整闭环端到端测试。

### Out of Scope

- **两级路径注入**：**不做**（投递外移后 no reason；剔除）。
- §6 白名单重构（补 grilling/to-spec/to-tickets/receive-review + 判据重构）——投递外移之后。
- wayfinder（`disable-model-invocation` 是设计，人肉刻意发起）。
- 步骤→角色映射（grilling→谁 / invite-review→谁）——先不定，落地时浮现。
- 通用 mattpocock 基础 skill 的全面改写（只动投递相关）。

## 改哪些文件（勘察后的真实锚点）

- `packages/server/src/config/iron-laws.ts` — 共通铁律层出口检查段承载投递信号（**承载物**）。铁律拼入 `execution/reply.ts:407-410` 的 `baseSystemPrompt`、经 `reply.ts:417` `resolveRolePlaceholders`。
- `packages/server/src/execution/reply.ts` — 投递信号产出 + 消费的接缝；`baseSystemPrompt`/`finalSystemPrompt` 组装（L407-442）；skill 块 append 在 L622（晚于替换——这正是字面 @ 不被解析的根）。
- `scripts/mcp-server-utils.mjs` — `read_skill`/`list_skills`/`SKILL_CATALOG`（P2 流程链 8 技能；注入层改造后 server 不再全文注入，模型经 read_skill 自取正文，request-review 已从流程链移除——单级路径，**不建两级注入**）。
- `skills/request-review/SKILL.md`（base）— 剥「选择审查者/@审查者/@mentioning the paired reviewer」路由；`refs/review-request-template.md` 相对引用**悬空**，修正为共享 `skills/refs/review-request-template.md`。
- `skills/catstudy/handoff/SKILL.md` — 剥「行首@审查者 请审查」；`../../refs/...` 统一指向共享 `skills/refs/`。
- `skills/catstudy/request-review/SKILL.md`、`skills/catstudy/handoff/SKILL.md` — 投递型定制层：**淘汰**（投递外移后 no reason）；领域型重写（`quality-gate`、`receive-review`）与共享 `cat-roles.md` 保留。
- DB：新增 `flow_state` 字段（`packages/server/src/db/` 迁移）→ 用于契约③。

## 测试决策

- 信号形状/ref 主键/trace_id 兜底：**纯单元**断言产出 + 消费 `{targets, intent, ref}`；ref 以 commit_sha 键、纯会话退 trace_id。
- 内容剥离：**静态源断言**——被剥 skill 内容不再含 `@谁`/`请谁审查`/`投给谁`。
- 铁律层承载：静态源断言出口检查段含「未结束必须产出投递信号」。
- request-review 启用：组装式/端到端断言真实审查链走通，每个 commit 恰好触达审查猫一次。
- 契约③状态机：DB/迁移真实测试——`flow_state` 同事务更新、主链机械推导（下一步不落库）、重启 in-flight 恢复。
- 现有 server/shared 全绿不回归；判断式投递原链路（agent 自由向）不破坏。

## Gate Report

### Gate A · 需求照准

✅ User Story 1/2/3/5/6 均可证伪 + 验收信号明确；US 4/7/8 为架构性陈述，映射到「内容剥离 + 铁律层承载」静态断言（弱信号但可静态验证）。**US 1/3「恰好一次」本批可证伪**（状态机进本批，不欠账）。

### Gate B · 契约锁定

✅ 边界（In/Out）双向钉死；三契约逐条锁定；承载物明确为铁律层出口检查段；Out of Scope（两级注入/§6/wayfinder/步骤映射）单列。

### Gate C · 反向证明

✅ 内容剥投递 + 铁律层承载 + 信号契约 + 状态机闭环，能反证 US 1-8。某条需求无验收项覆盖 = Gate C 过不去；已全量覆盖。

### Gate Result

✅ **PASS → 可拆票**。

## 决策留痕

- 跳 grilling 未完全：本 spec 即 grilling 访谈对象，ADR §4 三契约已逐项钉死（用户拍板）。
- 承载物 = 铁律层出口检查段：用户拍板，取代「结尾思考」软触发（触发可靠性净增益）。
- 去两级注入 + 启用 base + 淘汰老投递版：用户拍板（投递外移后注入补丁无存在理由）。
- 契约③状态机进本批：用户要求「完整闭环测试」，不标保留缺口。
- refs 资产位置：`skills/refs/review-request-template.md` 为唯一共享副本，base 版本地引用悬空（已核实）。
- 路径勘正：reply 实际在 `packages/server/src/execution/`、注入侧在 `scripts/mcp-server-utils.mjs`（ADR 旧引用 `src/` 已一并勘正）。
