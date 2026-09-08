---
name: spec-gate
description: 需求/规格进入实施前的自查门（前半个门，对称后端 quality-gate）。检查需求可证伪性、验收信号、边界/契约/验收是否钉死，通过后才能拆票/实施。Use when requirements or a spec is ready and needs a falsifiability + contract-lock check before tickets are cut or code is built. Not for code that is already being implemented or reviewed (use quality-gate), or fuzzy ideas that still need grilling (use grilling/to-spec). Output a Gate Report (PASS/FAIL with per-item results).
---

# spec-gate

需求 → 实施之间的**前半个门**。对称后端 `quality-gate`（提交前自查）——spec-gate 在拆票/动工前自查「需求本身立不立得住」。

## 何时使用

- 一份 spec（或一组需求）已成型，准备拆票（to-tickets）或进入实施（implement）之前
- 需求来源是 grilling / to-spec / to-tickets 的产出
- 跳过了 grilling、直接拿到需求时（更该过门，见「决策留痕」）

## 不使用的情况

- 需求还是模糊想法、需要先 grill（用 `grilling` / `to-spec`）
- 代码已在实施或审查中（用 `quality-gate` / `code-review`）

## 检查步骤

### Gate A · 需求照准

- [ ] 每条需求**可证伪**吗？（存在一个可观察的结果能证明它没被满足）
- [ ] **验收信号**明确吗？（谁、在什么输入下、观察到什么输出/行为）
- [ ] 没有「应该更好用」「尽量快」这类不可测措辞

### Gate B · 契约锁定

- [ ] **边界**钉死：做什么、明确不做什么（Out of Scope 同样写清）
- [ ] **契约**钉死：跨组件/跨 skill 的接口、数据形状、触发条件写清
- [ ] **验收**钉死：每条需求对应一个可执行验收项（不是一句「测一下」）

### Gate C · 反向证明

- [ ] 反向推演：若所有验收项都通过，能否**反向证明 Gate A 的需求全部被满足**？
- [ ] 有没有「验收全绿但需求其实没做」的漏网需求？（某条需求无验收项覆盖 = Gate C 不过）

## 输出

自查通过后，输出以下格式：

```
## Gate Report

### Gate A · 需求照准
✅ 全部可证伪 + 验收信号明确 / ❌ 以下需求不可证伪/缺验收信号：...

### Gate B · 契约锁定
✅ 边界/契约/验收已钉死 / ⚠️ 以下未钉死：...

### Gate C · 反向证明
✅ 验收通过能反证 Gate A 满足 / ⚠️ 以下需求验收覆盖不到：...

### Gate Result
✅ PASS → 可拆票/进 implement
❌ FAIL → 以下需求先回炉（grill / 补验收）：...
```

## 决策留痕（两层，判据 = 没留就会被抓到，不是「我会记住」）

- **过程决策留痕**（本会话内）：跳 grilling 的「为什么」、Gate A 答案、争议裁决 → 承载物是 spec 尾部固定段：

  ```markdown
  ## 决策留痕

  - 跳 grilling：因 [原因] → 故本单不单跑 grill
  - Gate B 契约：[边界=xxx / 契约=xxx / 验收=xxx] 已钉死
  ```

  格式固定（一行一决策、可 grep）→ 让「没留」（spec 无此段、段内关键决策为空）能被审查链机械抓到。

- **架构决策留痕**（跨会话）：进 `docs/adr/`，寿命跨会话，给下个会话重建「为什么这么设计」的地图。

## 衔接

- PASS → 拆票（`to-tickets`）→ 实施（`implement`）
- FAIL → 回 `grilling` / `to-spec` 补需求，或补验收项，再重新过门
- `implement` 侧另有前置门槛（spec 在场 + 需求可证伪 + 跳 grilling 留痕，见 `implement/SKILL.md`）——spec-gate 是它的执行侧检查

## Common Mistakes

| 错误                                              | 正确做法                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| 需求写「提升体验」就过门                          | Gate A 要求可证伪：什么指标/行为算满足，不可测措辞回炉                     |
| 只检查需求本身，不检查验收项与需求的映射          | Gate C 反向推演：每条需求都要有验收项能反证                                |
| 跳了 grilling 不留原因                            | spec 尾部 `## 决策留痕` 固定段写死「为什么」，否则审查可抓                 |
| 边界只写「做 X」不写「不做什么」                  | Gate B 边界要双向：Out of Scope 同样钉死                                   |
| Gate Report 只写 ✅ 不列证据                      | 每项附实际证据（哪条需求、哪个验收项、哪个契约点）                         |
| 把 spec-gate 当 quality-gate 用（等代码写完才查） | spec-gate 在拆票/动工前查需求；代码写完走 quality-gate，两个门查的东西不同 |

## 与其他 skill 区别

| skill                | 区别                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------- |
| quality-gate         | spec-gate 是需求/规格进实施前的**前门**；quality-gate 是代码提交审查前的**后门**自查        |
| grilling             | grilling 用提问压测计划、产出需求理解；spec-gate 对已成型 spec 做可证伪/契约/验收静态 check |
| to-spec / to-tickets | spec-gate 检查它们产出的质量、是它们之间/之前的 gate，不替代产出本身                        |
| code review          | spec-gate PASS 才拆票/实施；code review 是代码完成后审查（post-commit hook 自动触发）       |
