# Tickets: 投递外移（Skill 管领域，投递管「谁接下棒」）

实现 ADR 0014 / `docs/research/skill-delivery-decoupling-spec.md`。把「投递给谁」从 skill 内容剥出，收回到铁律层出口检查段，做成强制投递信号 + 判断式/机械式双层闭环（契约③状态机进本批）。

Work the **frontier**：下列按阻塞顺序排列，blockers 全绿的票先开工。

## T1 · 投递信号契约 + 判断式投递链路

**What to build:** agent 在回复收尾产出轻信号 `{target, intent, ref}`，消费层映射为 `post_message`（结构化路由）/ 行首 `@`；ref 以 commit_sha 为主键（定位+去重），纯会话无 commit 退 trace_id 兜底。

**Blocked by:** None — can start immediately.

- [ ] 信号形状 `{target, intent, ref}` 契约定义 + schema/类型落地
- [ ] ref 以 commit_sha 主键；纯会话退 trace_id 兜底（trace_id 仅关联列，不替代 ref）
- [ ] 产出 → 消费映射：`post_message` 首选 / 行首 `@` fallback
- [ ] 单测：已知 sha 的 commit 恰好路由到正确目标猫；纯会话消息退 trace_id 不漏
- [ ] 判断式投递原链路（agent 自由向）不被破坏

## T2 · 铁律层出口检查段承载投递信号

**What to build:** 共通铁律层（`iron-laws.ts` 的 `COMMON_IRON_LAWS`）出口检查段升级为「流程未结束**必须**产出投递信号 `{target, intent, ref}` → `post_message` / 行首 `@`」，成为每条回复收尾的强制动作。

**Blocked by:** None — can start immediately（可与 T1 并行；承载物文本与信号契约正交）。

- [ ] 铁律层出口检查段从「自问+投递」升级为「未结束必须产出信号」
- [ ] 注入仍拼入 `baseSystemPrompt`（`reply.ts:407-410`）、经 `resolveRolePlaceholders`（`reply.ts:417`）——保证可解析
- [ ] 静态源断言：出口检查段含「未结束必须产出结构化投递信号」
- [ ] 铁律注入链路测试不回归（现有 server/shared 全绿）

## T3 · skills 内容剥投递（base request-review + handoff）

**What to build:** 把 base `request-review` 的「选择审查者/@审查者/@mentioning the paired reviewer」与 `handoff` 的「行首@审查者 请审查」剥掉；refs 相对引用修正为共享 `skills/refs/review-request-template.md`（base 本地引用悬空）。只删路由，保留模板/领域资产。

**Blocked by:** T2（承载物先存在，剥掉的路由有地方去）。

- [ ] base `request-review/SKILL.md` 剥投递路由，保留模板/领域知识
- [ ] `handoff/SKILL.md` 剥「行首@审查者」，refs 统一指向共享 `skills/refs/`
- [ ] catstudy 投递型定制层（request-review、handoff）标记淘汰/清理
- [ ] 静态源断言：被剥 skill 内容不再含 `@谁`/`请谁审查`/`投给谁`
- [ ] refs 模板位置核正（唯一共享副本，无悬空引用）

## T4 · request-review 信号启用 base（剥投递后）

**What to build:** `STAGE_SIGNALS` 里停用的 request-review 信号重新启用，直接指向 base（剥投递后）；不建 catstudy 投递定制层、不做两级注入。真实审查链走通。

**Blocked by:** T3（base 先剥好）+ T1（信号契约就位）。

- [ ] `STAGE_SIGNALS`（`skill-loader.ts:78-95`）启用 request-review 信号
- [ ] 指向 base（剥投递后）；`SUPPORTED_SKILLS` 保留 request-review；不建定制层
- [ ] 端到端：每个 commit 的审查请求恰好触达审查猫一次
- [ ] 现有白名单/角色默认注入不回归

## T5 · 契约③ flow_state 状态机 + 主链机械推导

**What to build:** DB 加 `flow_state` 字段，键 `(session_id, commit_sha)`，service 在投递/事件发生时同事务更新「当前状态」（事实）；「下一步」不落库，由程序读 `flow_state` + manifest 主链机械算出（派生）。状态机只管主干道，岔道走判断式。

**Blocked by:** None — can start immediately（可与 T1-T4 并行）。

- [ ] DB 迁移加 `flow_state` 字段（键 `(session_id, commit_sha)`）
- [ ] service 在投递/事件发生时同事务更新；主链机械推导「下一步」（不落库）
- [ ] 审计日志随写（兜底留痕，与字段双保险）
- [ ] 状态机只管主干道（quality-gate PASS → request-review → receive-review → 闭环）；岔道不接管
- [ ] DB/迁移测试：同事务更新、重启 in-flight 恢复

## T6 · 完整闭环端到端测试

**What to build:** 把 US 1/3「恰好一次」真正测出闭环——判断式信号层 + 契约③状态机机械兜底叠起来才算。覆盖 hook 与判断式竞态、同 SHA 交接去重、重启 in-flight 恢复、纯会话 trace_id 兜底。

**Blocked by:** T4 + T5（判断式链与机械兜底都就位）。

- [ ] 跨通道恰好一次：hook 竞态、同 SHA 交接去重、重启 in-flight 恢复
- [ ] 纯会话 trace_id 兜底不丢
- [ ] US 1/3 全部列入测试，不再标「保留缺口」
- [ ] 全链 server/shared 全绿、无回归
