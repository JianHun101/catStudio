# 开发流程定义：前端 gate 链 + 需求文档约定 + CONTEXT.md 翻新

> 一个活 = 一份语义命名 MD。本文档是 `docs/requirements/` 的**第一份样例**，同时记录本活自身。
> 生命周期：愿景 → 需求 → 契约 → 过程决策留痕 → 架构决策留痕 → 验收结果。
> 写者：店长（架构师）。实施：ds猫（走 session/612c61dc worktree）。

## 一、愿景

猫咖后端已有 `quality-gate → request-review → receive-review` 机械审查链（`skills/manifest.yaml` `pipeline.review`）。前端（需求 → spec → ticket → implement）只有 `use_when` 语义靠模型判断，**缺一条像审查链那样的机械轨**——这是缺口。

本活给前端补一道**前半个门** `spec-gate`（对称后端 `quality-gate` 的后半个门），把「需求进实施前必须可证伪、契约钉死」变成可机械检查的 gate；配套定义需求文档约定（`docs/requirements/`）与 CONTEXT.md 的稳定地图判据线。用户已拍板：**定义开发流程这件事本身，就用作本目录的第一份样例文档**。

## 二、需求

1. **新增 `spec-gate` skill**（前半个门）：骑在现有前端 skill（grilling → to-spec → to-tickets → implement）上，三道 check：
   - Gate A · 需求照准：需求可证伪吗？验收信号明确吗？
   - Gate B · 契约锁定：边界/契约/验收钉死吗？
   - Gate C · 反向证明：验收通过了，能否反向证明 Gate A 满足？
2. **manifest.yaml**：登记 `spec-gate` 条目（source self / category 需求流程 / use_when / prev grilling/to-spec / next to-tickets/implement / preconditions）；`pipeline:` 加前端链（现在只有 review）；`implement` 条目补 preconditions。
3. **implement/SKILL.md**：加前置门槛段——spec 在场 + 每条需求可证伪 + 跳 grilling 留痕。
4. **wayfinder/SKILL.md** 第 13 行：补「build 冲动 + 手上无 grilled spec/工单 = 地图画早了不是画完了」。
5. **docs/requirements/ + 首份样例**：一个活 = 一个语义命名 MD，六段生命周期写全。
6. **CONTEXT.md 翻新**：保留术语表，补判据线 + 四节稳定地图（模块目录结构 / 文档位置约定 / 补全术语 / 流程约定）。

## 三、契约

| 边界       | 契约                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 改哪些文件 | `skills/spec-gate/SKILL.md`（新）、`skills/manifest.yaml`、`skills/implement/SKILL.md`、`skills/wayfinder/SKILL.md`（第 13 行）、`docs/requirements/2026-09-06-dev-process-gate-flow.md`（新）、`CONTEXT.md`                                                                                                                                                                                                             |
| 不改什么   | server/shared/web 代码；`.agents/skills/`（已删死目录）；`claude.ts`/opencode/dsh 等 harness 侧                                                                                                                                                                                                                                                                                                                          |
| 验收标准   | ① spec-gate/SKILL.md 存在含 Gate A/B/C + Gate Report 输出格式；② manifest spec-gate 条目齐 + pipeline 加前端链 + implement 补 preconditions，且 `skills-check-manifest.mjs` 三方一致通过（28/28）；③ implement 前置门槛段在；④ wayfinder 第 13 行补句在；⑤ requirements 样例六段写全；⑥ CONTEXT.md 术语表保留 + 四节稳定地图 + 判据线 + 无易变项；⑦ 纯 docs/流程件不涉 app 代码 → 不要求跑全量测试，但 manifest 校验必过 |
| 留痕判据   | 没留就会被抓到（机械可查），不是「我会记住」                                                                                                                                                                                                                                                                                                                                                                             |

## 四、过程决策留痕

- **跳 grilling 约束**：因「后端审查链缺前端对称半门是流程缺口，非需求模糊需 grill」→ 故本单不单跑 grill；前段需求经多轮用户对话 + 店长定稿已够清晰（to-spec 语义：无访谈、纯综合已有讨论）
- **Gate B 契约**：[边界=纯 docs/流程件不碰 app 代码 / 契约=manifest use_when/not_for 与 SKILL.md description 三件套逐字一致 + skills-check-manifest 三方一致 / 验收=见上表 ⑦ 项] 已钉死
- **Gate 数量裁决**：spec-gate 定三道 check（A 需求照准 / B 契约锁定 / C 反向证明），对标 quality-gate 八步但收窄到「需求立不立得住」——后端 gate 查代码质量，前端 gate 查需求质量，两个门查的东西不同
- **CONTEXT.md 判据线裁决**：以「信息变了是否意味着架构/契约/流程变」为界——稳定写、易变不写（函数签名/接口形状/文件行号/commit 内容交给代码自己说话）
- **requirements 文档惯例裁决**：不按 session ID 建文件夹、不散落碎片 MD；一个活 = 一个语义命名 MD，写者是店长不是实施猫

## 五、架构决策留痕

本活为**流程/文档层定义**，无跨组件接口变更，当前无升级 ADR 的决策。若未来 spec-gate 被代码化（post-commit hook 自动跑 gate、或 manifest pipeline.dev 被机器消费），应开 ADR 记录机制边界。跨会话重建「为什么这么设计」的地图，现阶段由本文档 + CONTEXT.md 流程约定节承担。

## 六、验收结果

状态：**待收口后回填**（本样例文档随实施提交，验收在 ds猫 实施自检 + 吐槽猫审查 + 店长收口后由店长回填）。

实施自检对照（ds猫 交付时应逐项确认）：

- [ ] spec-gate/SKILL.md 存在，含 Gate A/B/C + `## Gate Report` 格式
- [ ] manifest.yaml：spec-gate 条目齐；`pipeline.dev` 前端链 + `pipeline.review` 并存；implement 补 preconditions
- [ ] implement/SKILL.md 前置门槛段在（spec 在场 + 可证伪 + 跳 grilling 留痕）
- [ ] wayfinder/SKILL.md 第 13 行补句在
- [ ] 本文件六段写全
- [ ] CONTEXT.md 术语表保留 + 四节稳定地图 + 判据线，无易变项
- [ ] `skills-check-manifest.mjs` 三方一致通过
- [ ] 无 server/shared/web 代码改动
