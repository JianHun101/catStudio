---
name: request-review
description: 发起审查请求前的前置门槛与轮次规则。六条 BLOCKED 门槛不满足则请求发不出去；同型 finding 二犯触发 failure-mode audit；同对象 ≥3 轮停手升级到需求/方案层。Use when a code change has passed self-check and you are about to request review. Not for writing the review conclusion, or when you are the reviewer. Output a dispatch-ready review request (template + evidence) or a BLOCKED list.
---

# request-review

发起审查请求前的门。`quality-gate` 是**自查**门（自己过），本技能是**发起侧**门（组装成可审查的形态 + 轮次裁决）；两门都过，作者才自行发起。

## 何时使用

- `quality-gate` 已通过、代码已提交，准备发起审查请求
- 收到「建议修改」后返工完成，准备再次发起（轮次规则在此生效）
- 审查者第二次提出同型 finding，需要做 failure-mode audit

## 不使用的情况

- 代码还没过 `quality-gate`（先回去过门）
- 正在处理已收到的审查反馈（用 `receive-review`）
- 你自己就是审查者

## 第 1 块：BLOCKED 前置门槛（六条）

**任一条不满足 → 请求发不出去**，先补齐再发。本技能是**作者自守门**（机械阻断在入口契约层，不在技能层做）。

| #   | 门槛                  | 不满足时的处理                                                                 |
| --- | --------------------- | ------------------------------------------------------------------------------ |
| 1   | **quality-gate 通过** | 回 `quality-gate` 跑完整步骤，拿到 PASS 才算                                   |
| 2   | **测试全绿**          | `pnpm test` + `pnpm lint` 全绿；有红先修，不接受「另一条不急」                 |
| 3   | **原始需求可引用**    | 指明发起本改动的需求 / spec / 派活单（说不清要干嘛 = 没过门）                  |
| 4   | **ownership 声明**    | 写清 Cell（shared/server/web/scripts）+ Map Delta（新增/删除/移动的文件）      |
| 5   | **前端真机自证**      | 动了前端 → 启动应用走通至少一条真实用户路径，附路径与结果                      |
| 6   | **根目录工件闸门**    | 临时文件 / 调试产物不入库：无未跟踪垃圾、`.gitignore` 覆盖到位、提交限定了路径 |

## 第 2 块：R2+ 同型 finding → 强制 failure-mode audit

同一类问题被**第二次**判出来（R2+）→ **不许单点修**。

1. **先扫全 diff**：把这一型在整份 diff 里找全，列成清单（不止被点到的那一处）
2. **问「为什么会产生」**：找出生成这只问题的模式，判断它是孤例还是机制
3. **一次修一族**：清单里每一处同批修掉；修不掉的作为 Open Question 点名具体文件/符号
4. **回复里报清单**：报「同型共 N 处 / 修了 M 处 / 余 K 处理由」

**判据**：同型问题第二次出现 = 上一轮是**点修**而不是**族修**——这是方法的缺陷，不是手滑。

## 第 3 问：这次撞出的东西要不要上浮？

发起前自问一次。**非门槛**——有就落，没有就过，不阻塞发起。

| 撞出的东西                                         | 落点                                            |
| -------------------------------------------------- | ----------------------------------------------- |
| **否决理由** —— 考虑过又放弃的方案、被推翻的旧口径 | `docs/adr/`（过 ADR 准入门槛才落）              |
| **踩坑教训** —— 撞出来的、当时没有备选方案可比的   | `docs/lessons/`（内容边界见该目录 `README.md`） |
| **操作规则** —— 以后每次都得这么做 / 不能这么做    | `AGENTS.md` Conventions                         |

本问只做**指向**——规则正文归落点所在文件，此处不重述。

## 第 4 块：同对象 ≥3 轮 → 停手升级

同一个对象（同一 commit / 同一文件 / 同一功能点）**第 3 轮**被打回 → **停止继续修**，升级到需求·方案层。

- 同一对象上打转三轮 = 问题不在实现，在**需求没钉死**或**方案选错了**
- 动作：把「三轮各修了什么、每轮为什么还不够」列出来，回到需求 / spec / 方案层重新对齐，再决定是继续修还是重做

**F229 教训**：同一对象 20 轮返工，根因是最初的需求分歧从未被摆到台面上。

## 第 5 块：模板

审查请求的正文用 `skills/refs/review-request-template.md`（共享模板，本技能**不重写**）：What / Why / Original Req / Tradeoff / Architecture Ownership / Open Questions / Reviewer Checklist / Self-Check Evidence。

- 模板里的 `{}` 占位符**逐项填实**，不留空壳
- Self-Check Evidence 必须是**跑过的真结果**（测试数、lint 输出、真机路径），不是「应该是通过」

## 输出

```
## Review Request Readiness

### 门槛（六条）
✅ 全过 / ❌ 未过：<第 N 条 + 缺什么>

### 轮次
第 N 轮 · 同型 finding：<无 / 有 → 已做 failure-mode audit：同型 N 处，修 M，余 K>

### 请求正文
<按 skills/refs/review-request-template.md 填好的正文>
```

## Common Mistakes

| 错误                                   | 正确做法                                    |
| -------------------------------------- | ------------------------------------------- |
| 测试还有红的就发请求（「另一条不急」） | 六条门槛全过才发；不过就是 BLOCKED          |
| 被指出同型问题第二次，只修点到的那处   | 先扫全 diff 列同型清单，一次修一族          |
| 第 3 轮还在原地改细节                  | 停手，升级到需求 / 方案层重新对齐           |
| 请求里写「应该没问题」                 | 附跑过的真结果：测试数、lint 输出、真机路径 |
| 自己去写审查结论                       | 结论归审查者；本技能只管发起侧              |

## 与其他 skill 区别

| skill          | 区别                                                                          |
| -------------- | ----------------------------------------------------------------------------- |
| quality-gate   | quality-gate 是自查门（自己过）；request-review 是发起侧门（组装 + 轮次裁决） |
| receive-review | request-review 管发出去之前；receive-review 管收到反馈之后                    |
