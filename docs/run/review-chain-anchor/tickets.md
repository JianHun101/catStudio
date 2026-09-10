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

**验证面说明（2026-09-10 `dd16d2c` 复审 P3-3，补交叉引用）**：上面第一条验收是**文件面**（全仓 grep），而本票的
**实害面在 DB**——铁律常量经 `getIronLaws()` 运行期注入、3 只实施猫的 `systemPrompt` 是 **seed 烘焙落库**的。
**文件面全绿 ≠ 已生效**；生效判据见 T-C 段 `:108` 与本节 `:140`（seed 后实查 DB），硬前置见 `:137`。
形态与 T-J 验收第 5 条同类（验证面 ≠ 被判面），**但本处缺口已被上述判据覆盖、非恒真假绿门**，故不升级为必改——
补这句只为防后人把文件面 grep 当作生效证明。

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

**交付**：审查类投递必须带 **锚 + `chainType`**。缺锚 / 缺 `chainType` → **入口 400** 当场退回；`chainType` 与结构推导冲突 → 拒绝，不猜测。~~审查猫保留**语义次闸**（收到绕过入口的直投且无锚 → 不审，回一句要求带）~~ —— **2026-09-10 划掉**（spec D13）：主闸落地后**不存在绕过入口的直投路径**（审查类投递生产路径 = MCP `post_message` → `/api/internal/route-signals`，纯内存不落消息；REST 过闸），次闸不可达，落进提示词即"文档说保留、其实不存在"的机制——正是本 spec 靶心。重启条件见 spec A3（**2026-09-10 收窄**：谓词由"不经过 `ingest.ts` 的消息写入路径"收紧为"绕过入口的**审查请求投递**路径"——旧谓词**今天即为真**，实测 4 条旁路直写 `messages`（`socketio.ts:686` / `attribution.ts:165` / `l1-aggregator.ts:191` / `recovery.ts:159`），全为 `role='system'` 通告、无一是审查请求投递，故**次闸划掉的结论不翻**，只是旧谓词作为"重启条件"已失效）。

**Blocked by**：T-E。

**第 0 步（未决实测，先贴结论再动手）**：入口怎么识别「agent 发起」。若无可判字段 → 走**路由级判据**：socketio `SEND_MESSAGE` 与 OneBot 连接器 = 人类入口（允许空锚），REST `/api/messages` = Agent 入口（强制锚 + `chainType`）。

**验收**：

- [ ] agent 发起的投递缺锚 → 400；用户消息空锚不受影响
- [ ] 审查类缺 `chainType` → 400；声明 `first` 但链已存在 → 拒绝；声明 `followup` 但锚为空 → 拒绝（三方向各一例）
- [ ] 结构推导查不动 → 以声明为准 + 记日志，不拒绝、不静默改归属

**T-F 复审留痕（2026-09-10 吐槽猫 ⚠️ → 店长拍板）**：见本节末「复审必改与裁决」。

---

**复审必改与裁决**：

- **必改 1｜手动提交补投通路 100% 死**（严重度由店长上调：不是"偶尔少投一条"，是 spec D5 / 用户故事 14 那条边界**整条**失效）。构造链已源级复核：`routes/messages.ts:173` 硬编码 `origin: 'agent'` → `ingest.ts` 规则 5（`!taskId` → 400）；`handoff-gen.mjs:1084` `attributed = commitUuid ? null : false`，`decideHookDelivery` 对 `false`/`null` 均 `deliver: true` ⇒ 两条无归属路径都走到 `taskId = executorInfo?.taskId`（`:1157`）为 `undefined` → payload 无锚 → 400。**修法**：反查失败时由 `handoff-gen.mjs` 自己 **mint 一个 uuid 当锚**（语义 = 新链首轮，与今日"落 NULL → 服务端生成"等价）。**否决**"给 REST 整体开豁免口"（要动验收①与 spec）。**归口 flash猫**——`handoff-gen.mjs` 是其 T-H 在飞文件，同批落地避免跨猫同文件；**e2e stub 须按 `body.taskId` 缺省返 400**，现 stub 无条件 `201`，这层"绿"正是本缺口上轮没被拦住的原因。
- **OQ-3 命名 → 统一 `chainType`**（spec D12，spec 内 **12 处 / 9 行**已回改；本行原写"13 处"系凭印象未数，计数单位口径见 spec D12 末尾「计数更正」）。根因：`chainType`→`chainRole` 是 spec **单侧**改名、从未传导工单，而店长派活单又误称"落盘 spec 也是 chainType"，三方各执一词。
- **OQ-4 → `IngestInput.origin` 改必填**（spec D15），归 **ds猫**（T-F 返工件）。原默认 `'human'` 在**生产上零消费方**（四入口已全显式标注），只为"未来新入口忘标"而存在且取**放行**侧——与主闸目的方向相反。
- **OQ-5 → 认宽口径**（"该链上已有**任何**消息"），spec 括注已同步（spec D14）；实现宽得对且向严。
- **§三 E3 端点锚源 → 新立 T-I**（spec D16，见下节）。

**补填件（`fe05bbd` 交接文档）复审 ⚠️ → 逐条处置（2026-09-10）**：

- **必改 1｜OQ-1 把"待实施"写成"已实施"** —— **认，已更正**。原文断言"**我动了** `ingest.ts:116-123` 的入参类型（`origin?` → 必填）"，**该改动不存在**：`git show fe05bbd --stat` 恰 2 个 `.md`，`ingest.ts:118` 至今 `origin?: 'human' | 'agent'`，工作区干净——文档 What 表自己写的就是 docs-only，与 OQ-1 自相矛盾。**正确表述是前置条件式**：D15 **本单未实施**；ds猫 落地时须**只增字段、零断言改动**（补必填字段若伴随断言变更 = 把测试改成适配自己的实现）；且原 Checklist 第 5 条"`tsc` 报错只出现在测试字面量层面"**在本提交上不可满足**——无改动即无报错，跑出来是"什么都没做"的空绿。
- **必改 2｜D13 重启条件谓词过宽** —— **认，已收窄**（spec A3 / spec D13 / 本文件 T-F 交付句三处同改）。**裁决不翻**：次闸划掉仍成立。
- **必改 3｜`HANDOFF_TODO_MARKER` 判据自击穿** —— **认，新立 T-J**（见下节）；代码在 `dispatch/index.ts`（server 侧），随整批重启。
- **计数更正** —— 认，spec D12 末尾 + 本文件 OQ-3 行已改。**规矩**：计数必须写明单位（N 处 / M 行）——这两个数错因不同：13 是凭印象没数，5 是把行数当处数。
- **复核通过不追**：D16 证据分级未被升级 ✓ · D15 前提成立（前提对 ≠ 已实施，见必改 1）✓ · D14 宽口径方向没反 ✓ · 引用行号 7 处逐条 grep 准确 ✓。
- **审查者建议入票**：本会话"陈述未复核的事实"计数 → 已并入 T-G 段强制 failure-mode audit（见 T-G；同日第 4 次后已加第 5 个面）。

**`7cf46a6` 交接文档复审 ⚠️ → 处置（2026-09-10，同型第 4 次）**：

- **必改 1｜§5 Checklist 立的「marker 裸串刻意未复现」是假绿门** —— **认，成立，已改为结构化陈述**。
  实测复核（不采信转述）：该单交付消息 `0319b7f3`（len 6757）marker 命中 **1 次 @ 偏移 804**，落在
  **过程叙述行**内——文档体干净，叙述不干净。**性质**：不是"这次写漏了"，是**判据面错配**：判据扫的是
  消息 `content`（`db/repository/messages.ts:253-261`），而该单给的复核方式是「按常量 `grep -F` **工作区文件**」
  （文件面）——**恒给 ✅**。**处置**：不再设"未复现"类断言（人肉规避已由本票自证不可行），防护归 T-J 修法 1/2；
  T-J 段已补「第二例实证」与「验证面须与被判面同面」两条。
- **P3-1｜「库内对被 amend 的 sha 零命中」同型自我指涉** —— 认，**已归入 audit 第 5 面**（「自我指涉」）：
  库内确有命中，就是该交付消息自己（同时含两个 sha）。「全仓文件零命中」成立，「库内零命中」按字面为假；
  意图（无别处悬空指向）未被推翻，故不升必改。
- **P3-2｜audit 加第 5 个面** —— 认，已加（T-G 段，含"验证面须与被判面同面"）。
- **OQ-4（P3 措辞）｜T-J 修法「倾向前者」与验收第 4 条自相矛盾** —— 认，已改为「两条都必须做」（T-J 修法段）。
- **复核通过不追**：谓词三处同口径 ✓ · 4 条旁路确非审查请求投递 ✓ · 计数单位 ✓ · T-J 两处洞 ✓ ·
  `isReviewDelivery` 是稳定定义（按 `role` 判、动态查 `name`，且与 T-F 主闸同函数）✓。

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

**T-H 复审带入（2026-09-10 吐槽猫 ⚠️，同族「陈述假机制 / 守卫半闭」，本段立名分 · 不单开 commit）**：

7. **第五个消费方：`hints.ts` 陈旧 ⚠️ 重放（本票实证，实害已发生）**。`execution/hints.ts:88-115` 的
   `buildReviewLoopHint` 在可见窗口里倒序找「reviewer 发的、且 @ 了我的」消息取结论标记——而 ✅/💬 按
   分流规则**只投店长**，进不了实施猫的窗口 ⇒ 唯一能进的那条 ⚠️（对象 `94742a2`，早已修于 `a1200a7`）
   被**无限重放**，实施猫修完后仍被持续要求「逐项处理反馈」，直到它自然老出窗口才停。
   与 T-G 前四条同族：**拿窗口近似值当权威**，应一并改为按锚查最新判词。
8. **`refs` 守卫的 `catstudy/` 枚举盲区**（T-H N-c）：守卫排除 `catstudy` 后 `skills/catstudy/quality-gate/SKILL.md`
   与 `skills/catstudy/receive-review/SKILL.md` 在枚举面外（`readdirSync` 不递归）。**今天零实害**（两句实测
   既无 `refs/` 引用也无 `@`），形状同 N7——哪天有人在其中引 ref 即**零覆盖**。另：正则吃的是 `refs/x.md`
   后缀，而 `readSkillsFile('refs', name)` 把根硬编码在顶层 `skills/refs/` ⇒ 引 `catstudy/refs/cat-roles.md`
   （该文件真实存在）会去读不存在的顶层路径 → ENOENT（**响的**，可接受）。守卫标题写「全技能」，口径比实现宽。
9. **剥注释只剥整行 `//`，行尾注释未剥**（T-H N-d）：当前不误报（唯一那处恰是整行注释）；这是
   **false-positive 方向**（会红不会哑），可接受。另 `.replace(/\/\*[\s\S]*?\*\//g,'')` 会剥掉**字符串里**的 `/*`
   ——理论上可把守卫剥**瞎**（哑方向）。都很远，记一笔。

**链异常更正（`6cadc304` / `3c5ced74`，防后人修一个不存在的缺口）**：T-H 复审中 flash猫 报「审查请求疑似
未派发」，吐槽猫 查 `execution_logs` 给出的是**一条合并结论**。2026-09-10 店长复核后**拆成两条**——两个 id
**方向相反**，合写会把真缺口划进「勿往这方向排查」，方向正好反了。拆分如下（下列数字均经复核，非转述）：

- **`3c5ced74`（`12:13:41`）｜原结论成立**：请求**已派发**（`dispatch_state=done`），是执行 `70b27496`
  **crash**（`status=failed`、`error_type=unknown`、`error_message="execute crash"`、`prompt_chars=null`
  ⇒ 崩在 prompt 统计之前）。**根因是执行崩溃，不是派发缺口**，勿按「未派发」方向排查。
- **`6cadc304`（`12:07:53`）｜原结论不成立，方向相反**：该消息 `role=agent`、`mentions=["吐槽猫"]`、
  `dispatch_state=`**`null`**，以它为 `triggered_by_message_id` 的执行行 **0 条** ⇒ **确实没被派发**。
  同锚 `af02ff62` 共 **21** 条消息，`dispatch_state` 分布 `done=16 / null=5`，5 条 null **恰为**
  `6cadc304` + P0 四例（`527a2e70` / `c6613fc0` / `5eeb6a39` / `79122ef5`），且它**时间最早**
  （比次早的 `527a2e70`（`12:22:36`）早约 15 分钟）⇒ **P0 静默丢派第 5 例**，计入 T-K 证据面。
- **更正留痕**：2026-09-10 拆分，原并作一条「不是派发缺口」；其中 `6cadc304` 那半方向相反。

**同型 finding 计数 → 本票强制 failure-mode audit（2026-09-10 审查建议入票，同日第 4 次后加码）**：本会话
「陈述未复核的事实」已第 **4** 次（T-D N7 守卫半闭 → T-H `handoff-gen.e2e.mjs:1762` 失实注释 →
`fe05bbd` 交接文档 OQ-1 失实 → `7cf46a6` §5 Checklist「marker 刻意未复现」）。**第 4 次的性质与前三次不同**：
它不是"又犯一次"，而是**在同一单里声称防住了、并主动给出了复核方式，而那条复核方式根本够不着被判的面**——
加码理由在此。**不逐条打补丁**：本票开工时先做一次 **failure-mode audit**，把「断言了但没实测」当**一类**
缺陷横扫，五个面各扫一遍——① **判据**（守卫/闸门的谓词是否恒真或恒假）② **注释**（与代码是否一致）
③ **计数**（是否数过、是否写明单位）④ **谓词**（「不存在 X」类断言是否先钉死 X）
⑤ **自我指涉**（断言的对象是否包含断言自身或承载它的载体——「零命中」「未复现」「已清除」类断言必须带
scope 排除自身；且**验证面须与被判面同面**：只 grep 工作区文件而判据扫消息 `content` = 恒真的假绿门，
实例见 T-J 第二例实证）。产出清单挂本段，再动手修前四条。

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

- [x] 执行已终态、同猫并发两种情形下重跑，均判「有归属 → 静默」（各一例）
- [x] 一执行多 commit 的覆盖范围有明确裁决，且代码与裁决一致
- [x] e2e 补判据用例 + 阴性对照（旧实现下该断言必须红）

**落地留痕（flash猫，2026-09-10）**：

- **交付 1 的判据源**：改问 `GET /api/messages/:id/executor`（`probeAttribution`）——它的
  `triggered_by_message_id` 反查**不带 status 过滤**，命中即「存在任一状态执行行」，正是归属的定义。
  这样**不必给写回端点加字段、不必重启 server**（本票边界是纯 `scripts/`）。
  写回命中 running 行（`updated > 0`）保留为**充分条件短路**：真值时不再打探针，模糊的 0 才问。
- **交付 2 的裁决：显式接受「只看 HEAD」**（票单二选一里的后者）。一次派发 = 一条审查请求，
  锚在该派发**最新**的 commit，投递文档改动面也就只有它。**已知缺口留痕不修**：同派发里更早的
  commit 不进这条请求的改动面。缓解事实：**主动投递路径不受影响**（T-A 主路径下猫自己写审查请求、
  自己点名 sha，审查者读 push 后的完整 diff），缺口只在「猫忘投 → 收尾兜底」支路且需 ≥2 commit。
  否决记录（**含实测证据，别重走**）：
  - 逐 commit 各投一条 → 正是 T-A 要止住的「返工每新 SHA 叠一条链」。
  - **按同一 uuid 回溯成段**（曾实现并已提交进 `bba06f2`，随后**实测否决并回退**）：
    「一条消息 @ 两只猫」在本 workflow 是**常态**（店长并行派活即一条消息），两猫的 commit
    共享 uuid 且相邻 → 回溯判为一段 → 文档 file list 混入兄弟票的文件、审查须知指向一个不属于
    本单的 diff。**现场样本**：本票自己的草稿 spans 到 ds猫 的 T-E `7dd0e14`，7 文件 / 758 insertions
    里混着 `connectors/ingest.ts`。即「修一个静默缺口，换来一个常态化的假陈述」——故回退。
- **交付 3 的非恒真证明**：新增 e2e 组 14（4 例）+ 组 15（1 例，把「只看 HEAD」钉成契约——
  断言同派发更早的 commit **不在**改动面内，哪天有人重提回溯扩展会红）。14a 把阴性对照写在用例内：
  同场景 `updated = 0`（旧判据源在此判「无归属 → 投递」）→ `decideHookDelivery(false).deliver === true`，
  即换回旧实现该断言必红。
- **名分项**：4（refs 守卫）本票已修（枚举 `skills/*/SKILL.md`，实测覆盖数 1 → 2）；5（`reply.ts:403-407`）、
  6（`phase0.ts:361` 金标）按裁决**只立名分不改**，仍挂本段。
- **返工留痕（复审 ⚠️，2026-09-10）**：`handoff-gen.e2e.mjs` 组 15 头注残留一句已被回退的 span 机制陈述
  （「文档覆盖**两者**，审查须知指向整段」），与同组另外三处（组头 / 断言 / 收尾日志）**正好相反**。成因：
  回退 span 时扫描面只开了 `handoff-gen.mjs`，而同 commit 一起改的 e2e 文件里有同源残留。已改为
  「改动面**只看 HEAD**」。**教训**：回退一个机制时，靶串要按**机制名 + 枚举全部改动文件**两种维度扫，
  不能只扫"改机制的那个文件"——这是同形状缺陷第二次出现（第一次见 T-D N7 的守卫半闭）。

---

### T-I｜E3 接线锚源更正：`/executor` 回传 `messages.task_id`（2026-09-10 新立）

**交付**：`GET /api/messages/:id/executor` 回传的 `taskId` 改为该消息行的 **`messages.task_id`**（一跳 JOIN：`execution_logs.message_id → messages.task_id`），不再回传 `execution_logs.trace_id`。

**依据（spec D16 / A4 首行）**：A4 首行要求"不再用当轮 `trace_id` 冒充链锚"，但该端点**从未有票单落点**。现回传值 = `execution_logs.trace_id`（`routes/messages.ts:63` 直选 `el.trace_id`），与 `messages.task_id` 在**显式锚投递**上必然不等——真实库实测 `cdc476ba`：锚 `de0534ca…` vs 回传 `e8809eac…`。而 `handoff-gen.mjs:1157` 正拿回传值当下一份交接文档的锚 ⇒ **返工轮换锚 → 开新链**，即 spec 头号目标（用户故事 1）**不会因 A3 主闸达成**：主闸只保证"锚非空"，不保证"链内不变"。

**证据分级**：值分歧 = 实测；"下一跳换锚" = 机制推论（所追执行 `commit_hash` 为 `null`，库中无完整两跳断链可指）。**故验收必须补端到端证据**（见下第 3 条），不接受仅凭推论收口。

**Blocked by**：T-E（锚落库）。**归口 ds猫**。含 server 侧 → 与 T-E/T-F 同批重启。

**验收**：

- [ ] 显式锚投递的消息，`/executor` 回传 `taskId` == 该消息 `messages.task_id`（真实库复现 `cdc476ba` 分歧消失）
- [ ] 无执行行 → 仍 404（不因加 JOIN 变更既有失败语义）
- [ ] 端到端两跳：显式锚投递 → 产出 commit → 下一份交接文档，**两跳锚同值**（阴性对照——改动前该断言必红）

---

### T-J｜交接去重判据自击穿：marker 裸串扫全会话（2026-09-10 新立）

**交付**：交接文档补填去重的"已补填"判据，改为**只认模板的真实占位**，不被正文对 marker 的**引用**击穿。

**缺陷（实测，非推论）**：`dispatch/index.ts:29` `HANDOFF_TODO_MARKER = 'TODO: 补填'`；判据在 `:40-51`
= `rows.some(r => r.id !== trigger && r.content.includes('Commit: '+sha) && !r.content.includes(MARKER))`。
marker 是**裸串 `String.includes` 扫全会话消息** —— 任何**描述该机制**的正文都会把自己判成"未补填"。
**而本 spec 与票单自己就在描述它**。

**实证**：`fe05bbd` 的交付消息含该串 **2 次**（一次在叙述、一次就在其「落库判据」表内）⇒ 全会话含
`Commit: fe05bbd` 的两条消息**双双不达标**（模板带占位 ✅ 正确排除；交付件带引用 ✗ 被误排除）⇒
`isStaleHandoffRequest` 对该 sha **恒为 false**，再来一次补填请求会**真的执行**
（`serial.ts:1371` 执行前 / `:1202` 出队时）。

**影响面如实标（不夸大）**：当前无待重放的补填请求，**非即刻触发**；但"去重对该 sha 已失效"是既成事实，
且正落在本 spec 要治的「无效消耗」靶心上。

**第二例实证（`7cf46a6` 复审，2026-09-10 —— 本票自证「人肉规避不可行」）**：该单交付消息（`0319b7f3`，
len 6757）marker 命中 **1 次 @ 偏移 804**，位置在猫的**「过程叙述」行内**，**不在文档体**——而作者当时正
在这份文档里声称"刻意未复现"。扫描面 `getAllSessionMessages`（`db/repository/messages.ts:253-261`，
`role != 'system'`）取的是**整条 `content`**：过程叙述与文档体**同面**。**两条推论，均已写进修法**：

1. **意图级规避不可复现**——作者越是在文档里描述本机制，越容易把字面量带进 `content`；且入口不止文档体
   （过程叙述同为 `content` 的一部分）。故**否决**一切"以后别写这几个字"式的处置，唯一出路是判据侧修。
2. **验证面必须与被判面同面**——该单给的复核方式是「按常量 `grep -F` **工作区文件**」（文件面），实测零命中；
   而判据扫的是**消息 content**（消息面）。**只覆盖文件面的验证恒给 ✅，是假绿门**——本条即由该错配产生，
   与 T-J「判据自击穿」是同一个根的两张脸。

**修法（两条都必须做，不可只做其一）**：

1. **判据收紧到模板的注释形态**：实测模板占位是 `<!-- TODO: 补填 — …`（`scripts/handoff-gen.mjs:192/197/202`），
   故 marker 取 `'<!-- TODO: 补填'` 并**行首锚定**（`/^\s*<!-- TODO: 补填/m`）。**锚定是必需项，不是保险项**：
   原文写的"正文引用很少带注释符"**已被实测推翻**——真实击穿样本的引用里**就带** `<!--`（`0319b7f3`，注释符在
   偏移 799、裸串在 804），注释形态那半拦不住它，**救下它的只有行首锚定那半**。**否决**"以后别写这几个字"：
   那是让文档迁就判据（D12 已有一次同款教训）。
   - **marker 集刻意只覆盖 §2–§4（显式豁免，勿擅自扩）**：实测交接草稿的三节占位为**行首** `<!-- TODO: 补填`
     （同 `:192/197/202`），而 **§5 是 `buildChecklistSection` 的生成段**、不带 marker，降级文案为
     `<!-- handoff-gen 未检测到匹配的改动类型，请手动补填 Checkist -->`（`:658`）。**不把该降级文案纳入 marker 集**——
     「改动类型未匹配」是**正常降级**，把降级当「未补填」会让它触发补填，正是本 spec 要治的无效消耗。
   - **既存有界缺口（如实记；本票不引入也不修复）**：§2–§4 已填 + §5 停在兜底文案 → 判据判「已补填」。
     T-J 前后行为一致，写下来只为省掉下一个人的重新发现。
2. **同一函数第二处同型风险（一并修）**：`:49` 的 `content.includes('Commit: '+sha)` 同样认**引用**。
   一条**修正/台账**消息只要提到 `Commit: <sha>` 就会被当成"该 sha 的完整文档"。判据应识别**文档体**
   （长度阈值 + `## ` 小节结构 + 三个固定小节名），而非"含 sha 的任意消息"。**本单的两处修正消息正是这类**，
   可直接当回归样本。

**为什么"两条都必须做"**：修法 1 治「marker 裸串」（洞 1），修法 2 治「`Commit: <sha>` 裸匹配」（洞 2）。
**验收第 4 条只能靠修法 2 满足**——故原文"倾向前者、两者可叠加"与验收自相矛盾（`7cf46a6` 复审 OQ-4 点出），
已改。两洞同函数、同型：只修一条等于把另一张脸留在原地。

**Blocked by**：无（`dispatch/index.ts` 与链锚链无依赖）。**归口 ds猫**——同属 server 侧（与 T-F 返工 / T-I 同一批重启），且该文件在其文件面内。**唤醒排在 T-F 返工与 T-I 落地之后**（同猫三票并行会拖长每条链，且本会话已实测过一次 A2A 派发静默丢失）。含 server 侧 → 随整批重启。

**验收**：

- [ ] **阴性对照**：正文**引用** marker（如本票单 / 交接文档的「落库判据」表）且该 sha 已有完整文档 →
      `isStaleHandoffRequest` = **true**（现状为 false，即本单实测的那条）
- [ ] **正例不破**：模板真占位（未补填）→ 仍判 false
- [ ] 触发消息自身仍被排除（防自证契约④不回归）
- [ ] 引用 `Commit: <sha>` 的台账/更正消息**不**被当作"该 sha 的完整文档"
- [ ] **过程叙述面覆盖（形状照实测样本写，不照想象写）**：回归样本的消息 `content` 须把 marker 引用放在
      **过程叙述行的行中**、且**带注释符**——形状逐字对齐实测样本（`0319b7f3`：注释符在偏移 **799**、裸串在 **804**，
      上下文为 `…确为注释形态（<!-- TODO: 补填 —）——…`，**不顶行**）。「doc 体干净而叙述带引用」正是实测击穿的那一种。
      ~~不带注释符~~ 为原文误述，已据实测更正
- [ ] **区分性要求（本条的判据；缺它则"锚定"那半不可验收）**：该 fixture 在**「只收窄到注释形态、不加行首锚定」**
      的实现下**必须仍红**——实测样本的引用里就带 `<!--`，**拦不住它的是注释形态那半，救下它的只有锚定那半**。
      照原文「不带注释符」造 fixture，半吊子实现照样全绿而实测过的 bug 一字未动（同 T-C `:109` / T-H `:305` 的
      「旧实现下该断言必红」口径）

---

### T-K｜A2A 配额静默丢派：拦截只有 info 级日志 + 阈值与深度上限不相称（2026-09-10 新立）

**交付**：`execution/serial.ts` 的「单 Agent 被 @ 次数」护栏，**拦截可观测 + 阈值可配**；
并给出**重估依据**（本轮不翻双计设计）。

**缺陷（实测，非推论）**：

1. **静默面（主病灶）**：`:789` `if (count >= limit) continue` —— 拦截点
   **无 warn**；唯一的日志是 `:799`（修前为 info 级的 `log.info('agent-to-agent mention
limit filtered')`）。生产上 info 级没人看 ⇒ 从观感与排障面看就是**派活凭空消失**。
   本会话实证：4 条派活（`527a2e70` / `c6613fc0` / `5eeb6a39` / `79122ef5`）
   `dispatch_state=NULL`、执行链上无 warn。
   **更正留痕**：T-K 初立时写作"无任何日志"——**失实**，`:799` 有日志，问题是**级别**。
   修法是**抬到 warn**（与 `:916` depth limit 同口径），不是"加日志"。
   **行号口径**：本条所有行号以**本单落地后**的 `serial.ts` 为准（修前/修后各 grep 一次
   复核；修前该 `continue` 在 `:767`、info 日志在 `:772`）。
2. **额度面（不相称）**：默认阈值 `DEFAULT_MAX_MENTIONS_PER_AGENT = 5`（`:88`）与
   `MAX_AGENT_DISPATCH_DEPTH = 10`（`:85`）**不相称**：深度上限允许 10 层接力，
   配额却在第 4 轮就掐断。**双计**是根因——调度点「检查+预留」（`:790`）与执行完成处
   （`:649`，`depth>0`）**各计一次**，故实际可执行轮次 ≈ ⌈limit / 2⌉。
   `depth=0`（用户触发）不计数，长链计数**全来自 A2A**。

**重估方案与依据（本轮裁决：阈值不动，只加 warn + 可配）**：

- 双计是**刻意**的并发互斥设计（`:774-782` 注释：批内两执行体若"检查与计数分离"会双双
  放行、超限 1 条；预留写先落者可拦后到者）。**翻它 = 翻并发化决策**，超出本票范围 →
  维持，但把代价写进注释与 `.env.example`（实际轮次 ≈ limit/2）。
- 阈值改**可配**（环境变量 `MAX_MENTIONS_PER_AGENT`，解析入口 `resolveMentionLimit`，`:102`）：
  要更深的链由运营显式给更大的数，不必改代码重启。**0 / 负数 / 非法值回默认 5**，
  不开放"不限"——这是防循环护栏，与 `PROVIDER_TOKEN_CAP`（0 = 不限）**刻意不同**，
  已在 `serial.ts:90-106` 与 `.env.example` 两处写明防误推。
  **阈值现读（每次判据处读 env）而非模块加载时快照**：护栏参数不该要重启才生效，
  也让"可配"能被测试直接钉住（改 env → 行为变），不必重载模块。
- 若日后确需"配额 = 轮次"语义，正确方向是**去掉双计中的一处**（保留预留、完成处只在
  "预留未生效"的路径补计），**不是**把默认值调大——调大治标且同时抬高了失控链的上限。

**Blocked by**：无。**归口 ds猫**（server 侧，与 T-F 返工 / T-I 同批重启）。

**验收**：

- [x] 配额拦截时 `log.warn`（可被日志级别过滤观察到），字段含**单位明确**的计数
      （`limit` / `skippedCount` / `remainingCount`），不再只有 info
- [x] `MAX_MENTIONS_PER_AGENT` 可配：设 1 → 首轮预留即达阈值，下一轮起被拦（warn）；
      设 0 / 非法 → 回默认 5（**不**变成不限）
- [x] 既有行为不变：阈值内（默认 5）正常审查链（A2A 深度 2-3）不受影响
      （既有环截断用例在默认阈值下仍 7 跳，断言未动）
- [x] 票单与 `.env.example` 同口径写明"双计 ⇒ 实际轮次 ≈ limit/2"

---

### T-L｜判词 marker 与后缀之间多一个空格 → 结论整条丢失（2026-09-10 新立）

**交付**：`eval/verdict-parser.ts` 与 `execution/hints.ts` 两侧对「结论 emoji 与后缀之间的空白」容忍度对齐。

**缺陷（实证，非推论）**：两侧的 marker 匹配都对 emoji 与后缀之间的空白**零容忍**。

- `verdict-parser.ts:124-126` `matchesMarker` → `^<emoji><suffix>(?=\s|$|[^\p{L}\p{N}])`（`u` 标志）：
  `✅ 可合并`（带空格）**不匹配** ⇒ 落 `bad_verdict`（`insertReviewParseFailure`），结论**不进 verdicts 表**。
- `hints.ts:94/98`：`content.lastIndexOf('✅可合并')` 同上不命中 ⇒ 静默降级为 `:110` 的
  **「未给出明确结论」**（比 parser 更隐蔽：连 failure 表都不写）。

**单变量实证**（flash猫 复跑：正则与查表**逐字取自真源码**，合成输入，唯一自变量 = emoji 后那**一个空格**）：

| 输入                      | `verdict-parser`                        | `hints`                          |
| ------------------------- | --------------------------------------- | -------------------------------- |
| `✅ 可合并`               | NO-MARKER → `bad_verdict`               | 未给出明确结论                   |
| `✅可合并`                | `approve`                               | ✅可合并                         |
| `⚠️ 建议修改`             | NO-MARKER → `bad_verdict`               | 未给出明确结论                   |
| `⚠️建议修改`              | `suggest`                               | ⚠️建议修改                       |
| `❌ 需重做` / `💬 仅评论` | NO-MARKER → `bad_verdict`               | 未给出明确结论                   |
| `✅可合并了`（对照）      | NO-MARKER → `bad_verdict`（**闸有效**） | ✅可合并（**无后闸**，见观察项） |

店长另用**真源码跑 5 条真实判词样本**（`69fc0765` / `c4c40fac` / `fde26688` + 对照 `032b6ccd` / `e2781808`）：
**3 条翻转 / 2 条对照稳定**，且翻转的两例是 `✅ 可合并` ⇒ **approve 直接丢失**——即「**该收口的收不了**」，
不只是「该返工的没返工」。

**架构裁决（2026-09-10 店长，两条）**：

1. **匹配放宽**：emoji 与后缀之间允许 `\s*`。后闸 `(?=\s|$|[^\p{L}\p{N}])` 已挡住 `✅可合并了`，
   放宽空白**不引入新误命中** —— **此闸不得因此失效**（验收 ④）。
2. **字符串表同源，匹配语义不同源**：marker 三元组（emoji / suffix / verdict）**单一来源**；
   但 `verdict-parser` 的**行首锚定 + A/B 分级**与 `hints` 的**全文 `lastIndexOf`** 语义**各自保留**——
   `verdict-parser.ts:13-14` 已裁明「两者已不同源，勿再按『同语义』对齐」。那是**语义**分叉（已裁决），
   不是**字符串集**分叉（无理由）。

**非本票验收面的观察项（记一笔，勿擅自扩修）**：`hints` 侧**没有后闸**——上表 `✅可合并了` 在 hints
判「✅可合并」（`hints.ts:106` 视为通过、不注入循环指令），而 parser 判 `bad_verdict`。两侧语义本就不同源
（裁决 2 已明确各自保留），**故本票不改**；但统一字符串表时**不要把 parser 的后闸一并移植进 hints**——
那会改变 hints 既有行为，属另一票。

**Blocked by**：无。**归口 ds猫**（server 侧，与 T-F 返工 / T-I 同批重启）。**优先级最低、明确可后置**
——T-K 到时限可直接滚下一轮。

**验收（须含区分性）**：

- [ ] ① `69fc0765` 原文 → `verdict=suggest` / `subject=ds猫`；`c4c40fac` / `fde26688` → `approve`
      （**旧实现下这三条必红** = 本条的区分性判据）
- [ ] ② **阴性对照**：`032b6ccd` / `e2781808` 修前修后**同值、不翻转**
- [ ] ③ `hints` 路径：带空格**不再**降级为「未给出明确结论」，带 / 不带空格**同判**
- [ ] ④ `✅可合并了`（后接汉字）**仍记 `bad_verdict`** —— 该闸不得因放宽空白而失效
- [ ] ⑤ 匹配放宽后，`verdict-parser` 的**行首锚定**与 A/B 分级语义未被顺带改动（裁决 2）

---

### T-M｜归属反查「消歧失败不得猜」+ 三写一读收窄（2026-09-10 新立）

**交付**：`execution_logs` 的归属反查在**指不出唯一执行者**时返回"无结论"而非猜一个；三条写路径不得制造
"跨 agent 同 hash"这种不可消歧的归属；`/executor` 回报**匹配方式**，杜绝"回退命中被说成精确命中"。

**缺陷（实证，非推论；件 1 合成单变量实验，`packages/server/src/db/repository/executionLogs.test.ts` 头注存读数）**：

fixture：一条触发消息 U + 三条执行行 `e0`(flash, completed) / `e1`(flash, running) / `e2`(ds, running)。

| 路  | 调用                                                                   | 命中行数                      | 反查返回                                        |
| --- | ---------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------- |
| A   | `updateRunningExecutionCommitHash(U, SHA)`（无 agentId）               | **2**（e1,e2）                | —                                               |
| B   | 同法**带** agentId                                                     | 1（各中自己的行）             | 各 commit 各命中作者 ✓                          |
| C   | `updateExecutionLogCommitHash(U, SHA)`（`serial.ts` depth=0 自动提交） | **3**（**ended 行 e0 被盖**） | 该函数返回 `void`，调用方拿不到行数             |
| D   | `getExecutorNameByCommitHash(SHA)`（A 之后）                           | —                             | **ds猫**（`started_at` 靠后者，与真实作者无关） |
| D   | `getExecutorNameByTriggeredBy(U)`（A 之后）                            | —                             | **ds猫**（同上）                                |

⇒ 判据「**A 命中 2 行 ⇒ 全刷子因成立，写侧一并收窄**」**成立**。

1. **反查回退猜而非拒（本条主病灶）**：`getExecutorNameByTriggeredBy` / `getExecutorNameByCommitHash`
   都靠 `ORDER BY started_at DESC LIMIT 1` 收口 —— 一旦同 uuid 有两只猫在执行（店长一条消息派两单的
   **常态**），"谁是提交者"这个信息在读侧**根本不存在**，却被一个排序**冒充**成存在（D 路读数：返回的
   是"谁后开始"，与"谁提交"无关）。调用方 `handoff-gen` 拿它当补填人 ⇒ 交接文档**误投**。
2. **取证陷阱：回退命中被无条件说成"精确匹配"**（`scripts/handoff-gen.mjs:811-813` 的 `console.log` 块，
   模板串在 `:812`；grep 复核的是 **HEAD 版行号**，本单落地后该块为 `:835-837`）：
   `` `[handoff-gen] 实施者: ${body.agentName}（execution_logs 反查${commitSha ? ', commit_hash 精确匹配' : ''}）` ``
   —— 只要调用方带过 commitSha 就打"精确匹配"，**哪怕服务端根本没按 hash 命中、退回了 uuid 反查**。
   归属是猜的，日志说不是：排障时按"精确匹配"这条线索去查，方向从一开始就错。
3. **第三写者（`execution/serial.ts` depth=0 自动提交）**：`updateExecutionLogCommitHash` 无 `status`/agent
   过滤，把**本轮自动提交**的 sha 刷到该触发消息的**全部**执行行（C 路读数：3 行含 ended 行），且返回
   `void` —— 调用方连"写了几行"都看不见。它同样制造跨 agent 同 hash（⇒ 读侧只能猜）。

**修法（形状已裁 + 一处按实测改判，见下）**：

- **读侧消歧失败不得猜**：两个反查函数改为**跨 agent 多行 ⇒ `undefined`**。判据取 **distinct agent**
  而非行数（同 agent 多行 = 重试，执行者是确定的，按行数拒会把"同一只猫重试"误判成歧义、白丢归属；
  返回值仍取该 agent 最近一行）。
- **写侧不得制造不可消歧的归属**：
  - `updateRunningExecutionCommitHash` 无 agentId 分支：该 uuid 的 **running 行跨 >1 只猫 ⇒ 拒写**
    （`changes: 0` + `skippedAmbiguous: true`）；带 agentId 的精确分支不受影响。
  - `updateExecutionLogCommitHash`：同一规则（**执行行跨 >1 只猫 ⇒ 拒写**）。
- **失败语义分两种、不得混报**：`/executor` 新增 `matchedBy`（`commit` / `trigger` / `null`）与
  `ambiguous`；**"有执行行但指不出人"回 200 + `agentName: null` + `ambiguous: true`，不是 404** ——
  404 在调用方 `probeAttribution` 语义里是"无归属 ⇒ 钩子兜底投递"，把"指不出人"报成 404 会让**有归属的
  agent 提交被多投一轮**（正是 T-A / T-H 要止住的形态）。无执行行仍 404（`hasExecutorRowsForTrigger`
  与反查同 INNER JOIN 口径，"删 agent ⇒ 404 ⇒ 多投"的既有安全方向不变）。
- **措辞按服务端回报走**：`handoff-gen` 新增 `describeExecutorMatch(matchedBy, commitSha)`；**老 server
  不回报 matchedBy 时明说"匹配方式未知"**，不冒充精确匹配。

**⚠️ 一处按实测改判（与派活单验收②的字面实现不同，请审查者/店长裁决）**：派活单验收② 期望「收窄 C：ended +
running 两行 → 旧实现盖 2 条、新实现只 1 条」（字面实现 = 给 C 加 `status='running'` 过滤）。
**实测该字面实现是恒空操作，不是收窄**：C 的唯一调用点（`serial.ts` depth=0 收尾块）在所有 `execute()`
**返回之后**执行，而每个 execute 的收口漏斗（`execute` → `executeRun` → `finalizeRun` →
`completeExecution` → `finalizeExecutionLog`）**已在返回前把行置终态** —— 加 running 过滤 ⇒ 恒 0 行 ⇒
这条路径被**废掉**而非收窄（且其注释本意就是"本轮**所有**相关日志"）。故 C 的收窄点改为**同一消歧规则**
（跨 agent 拒写），保留单猫轮次的 round 快照语义（含 ended 行）。该判断为**代码路径阅读**所得，非运行期
实测，已在测试里以 `updateExecutionLogCommitHash — 单 agent → 照写，已终态行一并覆盖` 固化并写明理由。

**验收（须含区分性；「必红」= 剥掉本单改动后该断言在旧实现下的结果）**：

- [x] ① 合成 A 场景：跨 agent running → `changes=0` + `skippedAmbiguous=true` + 两行 hash 仍 NULL
      （**旧实现 `changes=2`** —— 区分性实证：把 HEAD 版 `executionLogs.ts` 逐字复制成 legacy 模块、
      同 fixture 同断言跑出 `A=2 / D=ds猫 / C=3`，与旧读数**逐个吻合**，跑完即删）
- [x] ② 读侧：跨 agent 同 hash / 跨 agent uuid → `undefined`
      （**旧实现返回 ds猫**，即 `started_at` 靠后者）
- [x] ③ `handoff-gen` 措辞：服务端回报 `matchedBy=trigger` 或**不回报**时，日志**不出现"精确匹配"**
      （**旧实现无条件打印"精确匹配"** —— HEAD 原文见上「缺陷 2」，模板里 `commitSha ? ... : ''` 与
      实际命中方式无关）
- [x] ④ 阴性对照：同一 agent 多行（重试）**不误拒**；`/executor` 无 commit 仍 `matchedBy='trigger'`；
      404（无执行行）语义不变；`probeAttribution` 的 `ambiguous ⇒ true`（有归属 ⇒ 不投）与
      `404 ⇒ false`（无归属 ⇒ 投）两向都未带跑
- [x] ⑤ 「有行但指不出人」不报 404（否则 `probeAttribution` 判"无归属"→ 钩子多投一轮）——
      路由级断言 `ambiguous: true` + 200
- [x] ⑥ 写侧拒写可观测：`routes/messages.ts` / `serial.ts` 两处 `log.warn`（`skippedAmbiguous`），
      响应体带判别位（T-K 口径：**拦截不得静默**）

**边界**：`db/repository/executionLogs.ts` · `routes/messages.ts` · `execution/serial.ts` ·
`scripts/handoff-gen.mjs` · `docs/run/review-chain-anchor/tickets.md`（本文件本轮归 flash猫独占）。
`handoff-gen.e2e.mjs` **未动**（派活单边界外）；验收③ 的区分性落在 `handoff-gen.test.js` 单测面。

**件 4｜注释溯源修正**（本单第 4 件，落地时未记入本段，T-O 轮补记）：`git show` 复核证实
**`eae5a5e` 是「实害化」锚**（其改动本身是 handoff-gen 审查须知绝对引用唯一化）、**根治是 `0fe8292`**
（其 commit body 自述「eae5a5e 错投 ds猫 实害化根因」）。原三处注释都把「根治」记在 `eae5a5e` 名下
⇒ 溯源错（会让人去查一个不是修复的 sha）。已修：

- `db/repository/executionLogs.ts:355`（原 `:283`——**加代码后行号已漂**）
- `routes/messages.ts:101`（原 `:78`）
- `routes/messages.test.ts:413` 测试名（原报 `:410`，T-O 轮 grep 复核为 `:413`）

**行号漂移更正**（T-O 轮复核，两处）：本段上文 `:826-830` → **`:835-837`**；
件 4 的 `messages.test.ts:410` → **`:413`**。订正理由同本 spec 的一贯口径：**行号是快照，不是真相源**。

**Blocked by**：无。**归口 flash猫**（读侧 + 路由 + serial 写回 + handoff-gen 措辞）。

---

### T-N｜权威判词注入缺定向闸：`subject` 为空也照注入（2026-09-10 新立 → 已落地 `792ce85`）

**交付**：`execution/hints.ts` 的 `buildReviewLoopHint` 守卫改为 **subject 为空即不注入**（fail-closed）。
**归口 ds猫**（server 面）。**本段是落地后的补记**——代码先于票面落库，故写成事实而非待办。

**缺陷**：守卫原为
`if (latest.subject_agent_id && agent.id && latest.subject_agent_id !== agent.id) return null`
—— 第一项是 `subject_agent_id` 为**真值**，subject 为空时整个条件短路为假、**继续注入**。
旧窗口路径有定向闸，新权威判词路径没把它接回来 ⇒ **任何**猫都会收到这条循环指令。

**定性更正（店长实测推翻上轮采纳的「92% 是常态缺陷」）**：按 verdict 分档直查 dev 库（现 27 行）：

| verdict | 总数 | subject 空 | 说明                                                                                                                   |
| ------- | ---- | ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| approve | 17   | 17         | `verdict-parser.ts:221-225` 明写 approve/comment **恒置 null**（💬 不要求返工，写 subject 会让下游把观察项当返工派发） |
| comment | 4    | 4          | `hints.ts` 下一行 `if (verdict==='approve'                                                                             |     | verdict==='comment') return null` **先把这两档挡掉** ⇒ subject 空对它们**零影响** |
| suggest | 6    | **4**      | **真实触发面**                                                                                                         |

⇒ 25 里 21 是设计使然。真实触发面 = **suggest 的 4 行**；逐行查 `mentions`：**4 行全是 `["店长"]`**
（判词自己只 @ 了店长；派活单原估 3 行，ds猫 实测 4 行）⇒ 上轮「写侧补 `subject_agent_id`，信息在手」
**不成立**——clause 里压根没有非 store 目标，**写侧无信息可补**。

**修法**：`hints.ts:142` 新增 `if (!latest.subject_agent_id) return null`——**向严不向宽**（与 T-L 同口径），
而不是往写侧加数据。**不碰** `verdict-parser.ts`（写侧无信息可补，实测已证）。

**验收（含区分性，落地时实测）**：

- [x] ① subject 空 + suggest/reject → **不注入**（单变量回退实测：删掉该行 → hints **1 红**）
- [x] ② 阴性对照：subject 非空 == 本猫 → **仍注入**（三轮回退下照常绿，不因收窄误杀）
- [x] ③ subject 非空 != 本猫 → 不注入（既有不变）
- [x] ④ approve/comment → 不注入（两态，既有不变）
- [x] ⑤ 真库回归：`mentions=["店长"]` 的 suggest 链上非 reviewer 猫跑 → 不再被注入

**并入 4 条（ds猫 实施，含三处落点更正）**：

1. `flow-advance.test.ts` 弱断言 → 钉死四步（`:88-93` 逐步 `from/to/intent`）。**落点更正**：派活单写 `:86`，
   该行是注释，断言块在 `:88-93`。
2. `episodes.ts:167-170` 恢复被 T-G 删掉的 NULL 噪声说明（`chain_task_id` 上的 NULL 是**已知噪声**，不是判据）
3. tie-break `v.message_id DESC`（uuid 字典序，与时间无关）→ `m.rowid DESC`（插入序）。
   **落点更正**：派活单写 `flow-advance.ts`，**实际在 `eval/chain-verdicts.ts:53/79`**（回退实测 2 红）
4. `serial.test.ts:791` 补 T-M 拒写 warn 覆盖（此前 `gitCommit` mock 恒返 `undefined` ⇒ depth=0 收尾块
   整个不执行，拒写分支与 warn **从未被跑过**；加 `&& false` → 1 红）

**OQ（待裁，ds猫 交接文档 OQ-1）**：`verdict-parser.ts:237` 写的是 `subject.name`（**名字**），
而 `hints.ts` 比的是 `agent.id`（**uuid**）⇒ 验收②「subject 非空且 == 本猫」在生产路径上**不可达**
（恒走 ③ 不注入）。本笔不就地打补丁——属架构裁决面。

**Blocked by**：无。

---

### T-O｜pre-push 门禁审计对象错位：只看 HEAD、不读 stdin + 无祖先关系 fail-open（2026-09-10 新立 → 本笔落地）

**交付**：`.husky/pre-push` 改为**逐个校验本次推送的 refspec**；新增 `scripts/pre-push-gate.e2e.mjs`。
**归口 flash猫**（`scripts/` + hooks 面）。

**缺陷（两条，同一根因：审计对象 ≠ 执行对象）**：

1. **只看 HEAD**：`:50` `HEAD_SHA=$(git rev-parse HEAD)`，**完全不读 stdin**。于是
   `git push origin <未审 sha>:refs/heads/x` 在「HEAD 恰好停在已审点」时落进 `:63`
   `LAST_REVIEWED = HEAD_SHA → exit 0`，**整条放行**。git 在 stdin 逐行传的才是本次要推的
   `<local ref> <local sha> <remote ref> <remote sha>`——不读它等于换了判据面。
2. **无祖先关系 exit 0**（`:85-90`）：reset/rebase 后 LAST_REVIEWED 与 HEAD 无祖先关系 → 打一行
   「⚠️ 历史不一致」后 **`exit 0` 放行**（fail-open）。

**修法（四条判据，逐 refspec）**：

| 情形                               | 处置                                         |
| ---------------------------------- | -------------------------------------------- |
| `local_sha == .push-gate`          | 放行（①）                                    |
| `.push-gate` 是 `local_sha` 的祖先 | **拒**（②有未审 commit）                     |
| `local_sha` 是 `.push-gate` 的祖先 | 放行（③**已审历史的子集**——见下方「偏离」）  |
| 两边都无祖先关系                   | **拒**（④fail-closed，原为 exit 0）          |
| `local_sha` 全 0（删除 ref）       | 放行（无对象可审）                           |
| 非 40 位 hex / 长度非 40           | **拒**（看不懂的输入不放行）                 |
| 一行 refspec 都没解析出            | 回落 HEAD 校验（人工直跑 hook 时保持旧行为） |

**⚠️ 一处显式偏离派活单字面**：派活单要求「`:87` 分支改 exit 1（fail-closed）」。
字面实现会让情形③（如推一个落后的 `main`——**实测 main `53690b4` 是 dev `5d527b5` 的祖先**）
掉进 ④ 被**误拦**；误拦合法推送的压力会把 `--no-verify` 变成常规操作，正是本票要止住的形态。
故 ③ 显式放行（理由写进 hook 注释：内容全在已审面内）。**判据 4（reset/rebase 无祖先关系 → 拦）不受影响**——
那种情形落在 ④。**已报店长，可否决**。

**验收（5 条，区分性用 `git show HEAD:.husky/pre-push` 逐字副本同场景对照）**：

- [x] ① HEAD 停在已审点 + 推**另一个未审 sha** → 拦　（**旧实现放行** ★区分性成立）
- [x] ② 推的正是 `.push-gate` 那一笔 → 放行（旧实现同）
- [x] ③ 一次推多 refspec（一审一未审）→ 拦　（**旧实现放行** ★区分性成立）
- [x] ④ reset/rebase 后无祖先关系 → 拦　（**旧实现 exit 0 放行** ★区分性成立）
- [x] ⑤ `--no-verify` 仍绕过（逃生口保留，旧实现同）
- 另：缺 `.push-gate` → 拦；内容非法 → 拦；删除 ref → 放行；无 stdin 回落 HEAD → 拦（均回归对照）

**证据**：`node scripts/pre-push-gate.e2e.mjs` → **24 passed / 0 failed**（10 场景 × legacy/current 双跑），
3 条区分性场景 legacy 与 current **结论全部相反**。**新增 1 文件**：`scripts/pre-push-gate.e2e.mjs`。

**并入 6 条**：

1. **`handoff-gen.mjs:1168` 的「已写回」无条件打印**：拒写告警后紧跟一行「已写回（命中 running 行 0）」
   ——相邻两行自相矛盾（上一行「未写回…不猜」），会把排障引向「服务端没写」而真因是「客户端没带
   agentId」，两个修法方向相反。改为**三态互斥**（未写回 / 已写回 N 行 / 调用成功但 0 行）。
   区分性实测：把旧的无条件打印放回 → e2e **2 条必红**（14g）。
2. **e2e OQ-1 瞬态保护**（**原锚已复核：`handoff-gen.e2e.mjs`（非 `.mjs`）的组 10 三个调用点确实在
   顶层裸块里、外面没有 try**——派活单「我 grep 到该行在 try 块内」是查了 `handoff-gen.mjs:726`
   （那行 `return body.sessionId` 才在 try 里），**两文件同号不同物**）。新增 `callWithTransientRetry`
   （只重试 `HANDOFF_TRANSIENT`，其余上抛）+ helper 自证两条断言。
3. **e2e stub 镜像补全**：`handleMessagePost` + `mirrorEntryGateError` 忠实镜像
   `buildDeliveryGateError` 两个 400 条件。**接了 11 处**（全部会应答 2xx 的 inline stub）；
   **3 处刻意不接并就地注明理由**——11b（设计应答就是 400，闸门被包含、零区分性）、
   13b/13c（`socket.destroy()` 永不应答，400/201 在客户端不可观测）。
   规则 B（审查类缺 chainType）在本 e2e **当前不可达**（`mentions:[fillerName]`，filler ∈ {store,
   implementer}——**DB 实测**：店长=store / ds猫·flash猫·dsh猫=implementer / reviewer 只有吐槽猫）
   ⇒ 仍实现（要忠实镜像，不要现状快照）并加诊断断言钉住「放行载荷不得点名 reviewer」。
   另加**非恒真**自证：`gatedPostBodies.length > 0`（镜像没接上时，全部投递断言会退化成恒真门）。
4. **`shortHash` vs `COMMIT_SHA_RE`**：见下方观察项（**属 ds猫 边界，本笔只记不修**）。
5. **本段（T-N/T-O 立单）+ 行号漂移更正 2 处**（见 T-M 段件 4）。
6. 顺手：e2e 临时目录**崩溃路径清理**（`process.on('exit')`）——实测残留 `handoff-e2e-nexELU`
   （mtime `13:37:11Z`，内含 `.handoff-test-lookup`+`tmp`）**正是 OQ-1 那次瞬态逃逸崩在半路留下的**。

**观察项（未修，属 ds猫 边界 `dispatch/index.ts`）**：生产者写 **7 位短 sha**（`handoff-gen.mjs:355`
`> Commit: ${shortHash}`，`:159` `--pretty=%h`），消费者 `COMMIT_SHA_RE = /Commit: ([0-9a-f]{7,})/`
（`:42`）按**等长精确子串**比对（`:86`）。生产路径两侧同源（触发消息内嵌整份文档）⇒ **当前一致、无 live bug**；
长度不一致时（消息引用 40 位全 sha 而文档是 7 位）判据返回 false ⇒ stale 检测失效 ⇒ **多派一轮**
（**fail-open 向多余工作，不是静默丢弃**）。建议修法：比对改为**前缀容忍**（取短的一方长度比较）。
**判定：低severity 观察项，不单开一单**——挂 T-J 后续。

**边界**：`.husky/pre-push` · `scripts/handoff-gen.mjs` · `scripts/handoff-gen.e2e.mjs` ·
`scripts/pre-push-gate.e2e.mjs`（新增）· 本文件。**未碰** `ingest.ts` / `routes/messages.ts` /
`dispatch/` / `serial.ts`（ds猫 面）。

**Blocked by**：无。

---

## 依赖图

```
阶段一（优先）
  T-A 兜底投递 ─┐
  T-B 技能      ├─→ T-D 文案对齐
  T-C COMMENT ──┘
阶段二（根因）
  T-E 链锚 ─→ T-F 主闸 ─→ T-G 四消费方对齐
                     └─→ T-I E3 端点锚源（与 T-G 同为"按锚查"口径，可并行）
  T-J 交接去重判据自击穿（独立，无前置——`dispatch/index.ts`，随整批重启）
  T-K A2A 配额静默丢派（独立，无前置——`execution/serial.ts`，随整批重启）
  T-L 判词 marker 空格零容忍（独立，无前置——`eval/verdict-parser.ts` + `execution/hints.ts`，随整批重启）
  T-M 归属反查消歧（独立，无前置——`db/repository/executionLogs.ts` + `routes/messages.ts`
      + `execution/serial.ts` + `scripts/handoff-gen.mjs`，随整批重启）
  T-N 判词注入定向闸 fail-closed（独立，无前置——`execution/hints.ts`，随整批重启；已落地 `792ce85`）
  T-O pre-push 门禁按 refspec 校验（独立，无前置——`.husky/pre-push` + `scripts/pre-push-gate.e2e.mjs`；
      **不需重启**：hook 是 git 每次 push 现读的脚本，落盘即生效）
```

**T-O 的生效面与 server 无关**：`.husky/pre-push` 由 git 在 push 时**直接执行文件**，不经过常驻进程
⇒ 本笔**不产生重启需求**（同批 server 侧 T-N/T-G/T-M 仍需要）。

**跨阶段无硬依赖**：阶段一的「已投递」判据用 `mentions` 启发式，不依赖锚 → T-A 可立即开工。阶段二落地后应收紧为锚判据。

## 不在范围内

- 视觉统一（全猫换 flash + 删图测猫 / vision-assist）——用户明示后置（spec D7）
- 两行 task_id 交叉互换脏数据的成因（2/882，可能旧 build 写入）——挂受控复现小单，不当定案依据
- `query_db` 白名单缺 `episodes` / `review_verdicts`——挂后续
