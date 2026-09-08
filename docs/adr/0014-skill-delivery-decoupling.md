# ADR 0014: Skill 与投递解耦——skill 管「怎么把活做对」，投递管「谁接下棒」

> **背景**：猫咖 skill 体系反复出现的病灶（request-review 信号停用、@审查者 静默丢单、DS 猫自发 @ + hook 又触发一次）不是单点 bug，而是**一类结构性病根**——「投递」被编进了 skill 内容里。本 ADR 从根上拆开这两个正交关注点，并明确这是对既有 `skill-consumption-architecture`（server 零注入 + CLI file-scan）的一次方向性延续（注入侧已定，见 skill-loader.ts），但把**投递**提到与 skill 并列的一等关注点。
> **状态**：定稿，三契约（§4）已逐项钉死（契约①轻信号、承载于铁律层出口检查段 / 契约②确定性推导为主 / 契约③字段+日志审计缝合）。投递外移拆单已放行；经用户拍板修订——**去两级路径注入、request-review 启用 base（剥投递后）淘汰 catstudy 投递定制层、契约③状态机进本批闭环（完整闭环测试）**。

## 1. 问题：投递被编进 skill 内容

典型病案——顶层 `request-review/SKILL.md` 写「作者主动打包发审查请求 + @审查者」。这一句把两层东西焊在了一起：

- **领域动作**（怎么把审查发对）✓ skill 该管的；
- **路由指令**（@审查者 = 投递给吐槽猫）✗ 编进了 skill 内容。

焊合招来的两层麻烦，都被实测钉死过：

1. **与铁律一冲突**：铁律一（`manifest.yaml:353`）「审查由 post-commit hook 机械触发、agent 只补填不自行发起」，skill 却说「作者自己 @审查者」——内容自打架。
2. **字面不解析 → 静默丢单**：`@审查者` 字面在 skill 块 append 后才进文本（`execution/skill-loader.ts` 注入晚于 `reply.ts:417` 的 `resolveRolePlaceholders`），mention 精确匹配落空 → 投递静默丢失（吐槽猫审查 P1 修复停止 request-review 信号的直接原因）。

**这证明方向错了**：把路由写死在内容里，必然在某个环节解析炸、静默丢单（P1）或双触发（DS 自发 + hook 重复）。修 P1（标注 TODO 停用）是止血，不是根治。

## 2. 判定：两个关注点正交

| 关注点    | 性质                | 回答问题                                                                         | 依赖谁                          |
| --------- | ------------------- | -------------------------------------------------------------------------------- | ------------------------------- |
| **skill** | 领域知识 / 流程规程 | 「这个活**怎么**做对」——spec-gate 检查清单、quality-gate 自查门、grilling 压测法 | 单个 agent 自身，不关心下家是谁 |
| **投递**  | 控制流 / 组织拓扑   | 「这单**谁**接下棒」——下一个 agent 是谁、何时切、何时请审/请收口                 | 会话图全貌，与领域内容无关      |

skill 依赖：离线、可版本化、可按 role 注入（已实现于 skill-loader）。投递依赖：运行时、拓扑相关、必须确定性可复算（否则无法防重投/漏投）。

## 3. 决策：投递外移除 skill，作为每次对话收尾/外层

- **skill 只管领域**：负责把活做对，内容里**不再含任何 `@谁`/`请谁审查`/`投给谁` 的指令**。
- **投递外移为「铁律层出口检查段」**（用户拍板，取代原「结尾思考」）：「投递给谁」从 skill 内容移入**铁律层出口检查段**——每条回复收尾的强制动作。铁律拼入 `baseSystemPrompt`（`execution/reply.ts:407-410`）、经过 `resolveRolePlaceholders`（`reply.ts:417`）可被解析；产出投递信号 → 调 `post_message`（结构化路由）/ 行首 `@`（fallback）。触发锚点从 skill（软、且字面死）**迁移到铁律层**（硬、可解析、每回复在场）。
- **猫咖定制层分化（非近乎消失）**：`skills/catstudy/` 的「定制增量」按份区分——handoff/request-review 偏投递规则（铁律一、A2A 审查链、收口链），但 quality-gate 与 receive-review 是**实质领域重写**：quality-gate 重写为猫咖特有门禁判据（「两条铁律合一」= 与需求对齐 + 承诺需要证据；`NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE`；凡声称完成必须附本次真实运行输出），receive-review 重写为被审者行为准则（Red→Green 修复、禁止表演性同意、技术正确性 > 社交舒适、VERIFY 三道门）。这两份领域知识并**非**继承 mattpocock 通用版。拆出投递后，定制层**部分技能（投递型）存在必要性大减、领域型保留**——剩「基础 skill（通用版领域内容）+ 猫咖领域型定制 + 投递策略（外层）」。

**投递型定制层的去留（用户拍板）**：request-review / handoff 这类以投递路由为核心的定制层，投递外移后路由离开 skill 正文，其存在理由消亡——**直接启用 base 版（剥投递后），不再建 catstudy 投递定制层，老投递版淘汰**。`skills/catstudy/` 仅保留领域型重写（quality-gate、receive-review）与共享 refs（`cat-roles.md`）；refs 资产统一指向共享 `skills/refs/review-request-template.md`（base 版本地 `refs/` 是悬空引用）。

### 3.1 两套投递通道（不是删一套，是分通道）

| 通道                               | 谁决定                                | 保证什么                                           |
| ---------------------------------- | ------------------------------------- | -------------------------------------------------- |
| **判断式**（判断式投递，一等公民） | agent 结尾思考投给谁 → `post_message` | 给 agent 自由空间（架构优化(3)「Agent 第一出口」） |
| **机械式**（兜底）                 | hook / dispatch 确定性触发            | 保证流程链**一定**跑通（agent 忘了也会拉起）       |

拆分恰好让「自由」与「必跑」各归其位。判断式管自由度，机械式管必跑——不可因拆开就删掉机械兜底，否则回到「怎么确保 agent 走 quality-gate/request-review」的老问题。

## 4. 三个已定稿契约（grilling 逐项钉死，本 ADR 落定为最终形态）

1. **路由决策的输出形状**：外层「思考投给谁」产出什么？倾向**轻信号** `{target, intent, ref}`（如 `{target: 吐槽猫, intent: review_commit, ref: <sha>}`），供投递层消费——不载全文、不比较内容。ref 对审查链事件定为 `commit_sha`（定位 + 去重都用它）；无 commit 的纯会话投递才退到 trace_id 兜底——**纯会话场景无 commit 主键可用，退 trace_id 仅作临时定位；此场景无双触发（hook 只随 commit 触发），不涉契约③的去重防线**。承载物：信号产出动作写入**铁律层出口检查段**（见 §3），非「结尾顺带想一想」的软触发。
2. **结尾思考的成本与落点**：是每个回复末尾真做一次二次推理（贵），还是从本轮上下文**确定性推导**（廉价）？倾向后者为主，必要时才升格轻推理；否则每轮多一跳 LLM 撑不住。
3. **机械兜底的判据**：投递层如何判定「agent 这一单已判断式投过谁、该不该再机械兜一击」？必须与 hook 对齐，避免回到「DS 猫自发 @ + hook 又触发一次」的重复。这是判断式与机械式的共享同步信号——**依赖内容相似度去重治不了**（两次回复内容完全不同），必须靠「该 commit 关联事件是否已有判定式投递信号」这种轻布尔。判据锁定：ref 以 **commit_sha 为主键**（定位 + 去重同源）；trace_id 仅作**关联列**（串同一趟消息线程、供跨通道归并），**绝不替代 ref 做定位/去重**——审查链两次触发（agent 自发 @ 与 hook 兜底）来自不同执行、trace_id 不同；若以 trace_id 判同源，hook 查不到 agent 那次执行留下的记录，会漏判重复。

**契约③落地形态（字段+日志审计缝合，用户拍板）**：状态机**不二选一**，而是"当前状态"与"下一步"分层——

- **当前状态**（这个 commit 走到哪一步，如是否已 quality-gate）→ DB 字段 `flow_state`，键 `(session_id, commit_sha)`，值如 `quality-gate`。service 在每次投递/事件发生时**同事务更新**。这是不变的事实，主链（manifest）调整不影响历史行。
- **下一步动作**（该触发谁、什么 intent）→ **不落库**，运行时由程序读 `flow_state` 当前状态，沿**主干道线性链段**（`implement → quality-gate → request-review → receive-review → closed`，即 T5 `FLOW_MAIN_CHAIN`）**机械算出**，全程无 agent 参与。因它是**派生数据**：若也存一列，链段一改所有历史行"下一步"全错，须跑迁移——一致性债。
  - **链段口径校准（OQ2/OQ3）**：此链段与 manifest 的**审查链段**对齐（`quality-gate.next → request-review.next → receive-review`），但 manifest **无单一线性主链表**——它是逐 skill `next` 指针（如 `spec-gate.next → to-tickets/implement`）+ `receive-review.next → request-review`（❌打回重走）回环。故「查 manifest 主链」在此是**设计语义对齐**（链段由 T5 硬编码 `FLOW_MAIN_CHAIN` 承载），**非运行时逐项读表**。前段（grilling/to-spec/spec-gate/to-tickets）属实施前规划，不在状态机范围（见 §4 状态机边界）。后续若 manifest 增加线性主链表，应回填对齐此硬编码——链调整导致的历史行差异即前述一致债。
- **审计留痕** → 日志，每次投递/状态变更随写，做兜底留痕。与状态字段双保险。

**状态机边界**：只管**主干道**（机械确定，如 quality-gate PASS → 自动触发 request-review）。岔道——实现猫卡住@求助、审查❌打回、需求需澄清——**不进状态机**，走判断式投递（agent 自主）；否则状态机要在链定义堆异常转移规则，复杂度爆炸。

- **❌打回语义（OQ1，边界归 T6）**：实现是**内容寻址**——❌打回 → 作者重新实现 → 产出**新 commit_sha** → 状态机在新键、新 quality-gate 入口看到；原被打回的 `(session_id, commit_sha)` 行**自然留作历史**——对**同一 sha**，`recordFlowTransition` 是 upsert：`flow_states` 状态**字段被覆盖**（`ON CONFLICT DO UPDATE SET state`），历史留痕靠 `flow_state_events` **审计流水 append**（每条历史迁移各自留一行，该表不覆盖）。故「旧行留史」由审计流水兜住；状态字段是覆盖当前事实、不保留旧值。此「靠新 sha 自解」为隐含假设，ADR 曾一字未提；边界（❌打回后是否需清/重置 `flow_state` 键语义）**归 T6 定义**，本 ADR 只声明由内容寻址自解、旧行留史。

## 5. Consequences

- **P1 类 bug 从根上消失**：路由不再写死在 skill 内容里，「@审查者 字面不被解析 → 静默丢单」这一整类不再产生。
- **`request-review` 信号直接解禁**：投递外移 + base 版剥投递后，直接启用 base（`skills/request-review/SKILL.md` 剥掉「选择审查者/@审查者」路由，refs 修正为共享 `skills/refs/review-request-template.md`）。**无需两级路径注入**（用户拍板剖除——投递外移后为覆盖坏 base 路由而生的注入补丁失去存在理由）。
- **skill 白名单需对齐猫咖化流程链**（后续项，见 §6）：当前 `SUPPORTED_SKILLS`（skill-loader.ts:33-38）= `[spec-gate, quality-gate, implement, request-review]`，与 manifest 满链 `wayfinder → grilling → to-spec → spec-gate → to-tickets → implement → quality-gate → request-review → receive-review`（10 步）差距明显——`grilling/to-spec/to-tickets/receive-review` 缺口、`wayfinder` 按设计排除（`disable-model-invocation`）、`request-review` 信号停用待启用。投递外移后白名单判据也应重构：白名单按「领域内容是否已猫咖化 + 流程链直接相关」，投递规则从 skill 内容剥离后不再参与白名单判定。

## 6. 后续项（用户明确要求记录）

**走完这套（投递外移落地）之后，需要处理 agent skill 白名单**：

- 补齐缺口：`grilling/to-spec/to-tickets/receive-review` 按角色加入白名单/默认映射；
- ~~两级路径注入~~：**已从待办移除**（用户拍板）——投递外移后路由离开 skill 正文，为覆盖坏 base 路由而生的注入补丁失去存在理由；catstudy 投递型定制层直接淘汰、不建。
- `wayfinder` 保持排除（`disable-model-invocation: true` 是设计，人肉刻意发起）；
- 白名单判据重构：剥离投递规则后，白名单只按「领域内容猫咖化 + 流程链相关」收敛。

## Considered Options

- **A. 继续修 P1 层面（现状）**：标注 TODO 停用冲突信号、修注释口径——止血但不根治，路由仍焊在内容里，P1 类静默丢单与双触发随时复发。弃。
- **B. 只加强去重**：对「同 session + 同 target + 同审查事件」派发做幂等——治疗不了 DS 两类不同内容的消息（内容指纹不同，去重判不出同源；硬去重要么漏防、要么误杀）。弃（方向反了）。
- **C. 投递 + skill 解耦（选中）**：skill 管领域、投递管路由分通道（判断式 + 机械式），病根层面分离。本 ADR 即留痕。

## 决策留痕

- 跳 grilling 未完全：此 ADR 即 grilling 访谈对象——经多轮 grilling，§4 三契约已逐项钉死并落定为最终形态，当前状态为「定稿」（见 §4 标题与首段状态行），非「草稿即终稿」的草稿态。
- 投递外移方向：用户拍板（与 clowder「仓库源库 + server 驱动 + agent 自主」设计哲学一致）。
- 白名单后续项：用户明确要求「记录走完这套之后要处理 agent skill 白名单」——见 §6。
