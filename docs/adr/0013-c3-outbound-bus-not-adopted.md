---
type: decision
date: 2026-09-01
status: superseded
verdict: C3 出站总线方案已废弃，不做
evidence:
  - kind: file
    ref: packages/server/src/routes/sessions.ts
  - kind: file
    ref: packages/server/src/execution/bus.ts
  - kind: commit
    ref: feb1905
  - kind: commit
    ref: b1cb4cd
---

# ADR 0013: C3（客户端事件出口收敛 single OutboundBus）— 降级为不做

> **Status**: superseded（2026-09-01 grilling 后裁定「不做」）——归档 C3 候选的降级理由，防未来重新提起时无据可依。
> **背景链**：8/28 架构审查报告（`architecture-review-2026-08-28.html`）C 编号候选，C3 系「客户端事件出口收敛进单一 Outbound bus，getIO 服务定位让位」（Worth exploring）。本单源于店长 grilling C3 时自推翻「半成品收尾」的初步推荐，裁定其成本 > 收益。

## 背景与摩擦（证据段）

- **C3 报告诉求**：客户端事件出口收敛进单一 Outbound bus，`getIO()` 服务定位让位——抽象壳（EngineBus/HandoffBus）长出后，REST 出口仍裸用 `getIO()`。
- **我的初步（误）判推荐**：把 C3 当「半成品收个尾」，即把剩余 `getIO()` 挪进 EngineBus/HandoffBus。grilling 后判为**读错了书**。
- **剩余 `getIO()` 三处（全在 `routes/sessions.ts`）**：`:137` `SESSION_UPDATE`（PUT 改会话猫咪后房间广播）、`:161` `SESSION_MESSAGES_CLEARED`（DELETE 清空消息后全局广播，多 tab 同步）、`:244` `SESSION_DELETED`（DELETE 删会话后全局广播）。
- **EngineBus/HandoffBus 的语义**（`execution/bus.ts:22`）：引擎/交接模块的**输出窄化视图**——「引擎物理上发不出未类型化事件（无逃生口）」。它只承载引擎/交接的输出，是类型安全闸。

## 决策：C3 降级为不做

**关键判据**：三处 `getIO()` 发的事件（`SESSION_UPDATE`/`SESSION_MESSAGES_CLEARED`/`SESSION_DELETED`）是 **HTTP 路由写操作之后的副作用通知**，**不是引擎/交接模块的输出**。它们与 EngineBus/HandoffBus 是**两类事件**。

- **误读路径（放弃）**：把这三处挪进 EngineBus/HandoffBus → 错误。那会稀释「引擎窄化视图」语义——bus 从此既承载引擎输出又承载 REST 副作用，类型安全闸被污染，引擎反而能发出它不该发的事件。
- **正读路径（判定为不值）**：真要收敛，须**另立一个独立于 EngineBus/HandoffBus 的 OutboundBus**（纯「服务器事件总出口」，非引擎窄化）——那是**新接口 + 改 3 路由 + connector 扩实现 + 测试**，成本高。

**且这三处 `getIO()` 无一 bug、无害、可读**——路由层主动广播是合理的，不是隐藏依赖。C3 报告的核心目标（**引擎出口无逃生口、事件类型化收敛**）已经通过 EngineBus/HandoffBus **达成**；`getIO()` 残迹是「服务定位收敛」这个**偏好**的尾巴，不是缺陷。

## Considered Options

| 方案                                               | 裁决 | 原因                                                             |
| -------------------------------------------------- | ---- | ---------------------------------------------------------------- |
| C3 完整落地（另立独立 OutboundBus）                | 不做 | 新接口 + 改 3 路由 + connector 扩实现 + 测试，成本 > 收益        |
| C3 收尾（把 3 处 getIO 挪进 EngineBus/HandoffBus） | 否决 | 稀释「引擎窄化视图」语义，污染类型安全闸，引擎能发出不该发的事件 |
| C3 降级为不做（本决策）                            | 采纳 | 核心目标已达成，getIO 残迹是偏好尾巴非缺陷                       |

## Consequences

- **C3 归档为不做**，不再是待办候选。后续若被重新提起，以此为据——收敛的是「REST 副作用出口」这类独立事件源，而非引擎输出，与 EngineBus/HandoffBus 语义正交。
- 与 C8（context 阈值配置收敛进 store，另一通道「保存后横幅不刷新」bug）区分开——C8 是真实行为不一致，作为同批前端契约收尾单项推进（已派 ds猫，commit b1cb4cd）。
- 该降级不影响 C1/C2/C4/C5/C6/C7（均已完成）与 C8（推进中）。

## 待确认

- [x] C3 裁定 = **不做**（2026-09-01 grilling 实核 sessions.ts 三处 getIO 均为 REST 副作用、非引擎输出）
- [x] C4 = 已整链拆除（feb1905），非「未做」
- [x] 真正待办 = C3 不做、C8 推进中
