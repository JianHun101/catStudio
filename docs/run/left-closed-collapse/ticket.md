# 票：left-closed 态主区塌 0 —— display:none 的 grid item 不参与自动放置，panel-center 落进 0 宽列

> 状态：已立票 · 未派
> 来源：T4 审查 OQ-1（吐槽猫移交店长裁决，店长裁决=另立票，不并入 T4）
> 基线：dev `6791c59d`（T4 收口后）

## 现象与机制

轨道收起（`leftOpen = false` → `.app-layout.left-closed`）时，会话栏 `.panel-left` 被 `display:none`（`App.vue` 的 `.app-layout.left-closed .panel-left` 规则）。`display:none` 的 grid item **不参与自动放置**——`.app-layout.left-closed` 把 grid 收成两列后，`.panel-center` 被自动放置进显式的 0 宽列，主聊天区塌成 0 宽。

A/B 同探针读数同构（T4 前后一致）——**既有缺陷，非 T4 引入、非 T4 加重**。T4 票面 §二.C 明写「媒体查询逻辑不动」，故不并入 T4 验收面。

## 修法方向（二选一，实施时定）

- 甲：`left-closed` 态把 `.panel-center` 显式 `grid-column` 钉到内容列，不依赖自动放置；
- 乙：收起态不用 `display:none`，改 `visibility` + 0 宽（须先核 T1 注释「display:none 的 item 不参与布局，但显式 track 仍占位」的原始动机，别解了一个坑造回另一个）。

## 验收

1. 轨道收起态：主聊天区正常占满剩余宽度，消息列表可读可输入；
2. 轨道展开/收起往返：布局无残影、无跳动错位；
3. 窄窗（<1000px）断点三态（轨道+会话栏 / 仅轨道 / 仅轨道且右栏隐）均不回退；
4. 全量测试 + lint 绿；真机截图（收起态主区可见）附审查请求。

## 边界

- web-only，仅 App.vue 布局面；不动轨道按钮、不动覆盖层。
