# UI B·改 落票单（全局框架 / 面板层）

> 用户拍板（逐字）：「就先使用emoji吧，后续我看看设计一些icon或者支持提交图片。按b改方案做吧。记住像原本的记忆、时间、token消耗。hover显示复制 trace 回退。这些功能都要保留。」
> 原型（唯一视觉真相源）：`D:\Game\ai\catStudy-sessions\2ad72e1c\prototype-right-panel.html`，**提案 B·改** 态。浅/深两主题都在原型里，切换可看。
> base = dev `e581e3f`。两票文件零交叠，可并行。

## 0. 全局硬约束（两票共用，违反即返工）

### 0.1 emoji 保留

- **不新增任何 SVG 线性图标**替换现有 emoji（轨道四按钮、主题切换、成员头像、picker 头像均维持现状）。
- **会话名称前不加任何小 icon**（用户明确否决：表意不清 + 占空间）。现状本就没有，别加。
- 猫头像继续用 `agent.avatar` 的 emoji/字符，**不新建 `CatAvatar.vue`**，不做首字母方块，不做拟物插画。

### 0.2 保留功能清单（每一项都必须在改动后仍然可用）

| #   | 功能                                                                                                                                     | 现状锚点                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| P1  | **记忆**：气泡记忆引用行；点开记忆抽屉看命中片段全文、次级链接打开当前文档、Esc 关闭                                                     | `ChatPanel.vue` `memoryRefs` / `.memory-drawer-*`；`MessageItem.vue` `memory-refs` |
| P2  | **时间**：消息时间戳按日分级（今天 `HH:mm` / `昨天 HH:mm` / `M月D日 HH:mm` / 跨年带年份）；执行耗时 footer；回复计时「回复中 · 已 N 秒」 | `ChatPanel.vue` `fmtMsgTime`/`fmtDateSep`/`durationText`/`ReplyElapsed`            |
| P3  | **token 消耗**：成员行 `{{ tokensText(agent.id) }}`（用量/上限）；气泡 footer 既有的 token 读数                                          | `SessionAgentsPanel.vue:446`；`ChatPanel.vue` footer                               |
| P4  | **hover 显示复制**：气泡 hover 出操作条 → 复制正文 → 按钮短暂变 ✓                                                                        | `MessageItem.vue:291-322,483-485`；`ChatPanel.vue:3859` `.message:hover .msg-acts` |
| P5  | **trace**：成员卡内联 trace 展开/收起（手风琴单开）；**回退**：同会话回退分隔线 + 确认弹窗                                               | `SessionAgentsPanel.vue:459-553`；`ChatPanel.vue:840-905,1509-1520`                |

> 改 CSS 类名/结构时，**先按上表逐项在真机点一遍**再交；任何一项失效 = 返工。P4 的 hover 机制尤其容易被「去边框 + 改 hover 底色」顺手改坏。

### 0.3 线的三档纪律（验收判据，不是审美口号）

| 档     | 用途                               | 允许强度                        |
| ------ | ---------------------------------- | ------------------------------- |
| 结构线 | 栏与栏之间                         | **0 条**（改用底色分层）        |
| 分区线 | 同栏内语义不同的两块（如右栏页脚） | alpha 0.06–0.09，两端缩进 ≥12px |
| 交互线 | 输入框、思考块折叠边界、焦点环     | alpha 0.13–0.16                 |

判据：**同一 alpha 不得同时用于两个不同语义层级**；归不了档的线一律删。

## 1. 票① 全局框架（实施：flash猫）

### 目标

三栏从「靠竖线切」改为「靠底色分层切」；选中态去竖条；头行去硬切线。

### 改动文件（仅这三个）

- `packages/web/index.html`——token 增补/调整（三档底色 + 线的三档 alpha 命名）
- `packages/web/src/App.vue`——三栏底色、删三条 1px 边框、轨道选中态去竖条、头行背景
- `packages/web/src/components/SessionList.vue`——会话项选中态去竖条（只留 accent 淡底 + 文字加深）、会话栏底色贴合、头行去 border-bottom 改渐隐

### 契约

- token 命名建议（可微调，但语义必须可读）：`--bg-menu`（轨道）/`--bg-session`（会话栏）/`--bg-paper`（主区）；暗色同名不同值。**不要复用 `--bg-deep/--bg-base` 去表达三档**——它们已被全站多处消费，改值会牵连别处。
- 色值（原型实测，浅色）：轨道 `#e5d9c8`、会话栏 `#f1eae0`、主区 `#fbf8f2`；深色：`#0d0b09` / `#1a1611` / `#14110e`。
- 三栏分界只靠底色差，**不加任何替代线**。
- 头行（会话栏头、聊天头、右栏头）：`border-bottom` 删除，改 `position: sticky` + `linear-gradient` 底部渐隐；滚动时不得出现硬切线。

### 验收

- AC1 三栏 `getComputedStyle().backgroundColor` 两两不同；相邻栏不靠任何可见边框即可分辨。
- AC2 视口内 `.panel-left`/`.panel-center`/`.panel-right`/`.app-rail` 的可见边框数 = 0（`border-*-width` 全 0）。
- AC3 轨道选中态与会话项选中态：`::before` 的 `content` 为 `none`（两处都要测）；选中仍可辨（accent 淡底 + 前景色差）。
- AC4 会话项无新增 icon 元素；猫头像仍是 `agent.avatar` 文本。
- AC5 浅/深两主题各量一次，颜色不得串（深色下三档仍两两不同）。
- AC6 `pnpm test:web` + `pnpm lint` 全绿；`SessionList.test.ts` 若有静态断言，改钉新不变式（选中态=底色，不许净删）。

## 2. 票② 面板层（实施：ds猫）

### 目标

右栏去盒化 + 页脚固定 + trace 无缝；中栏线降级为色带/淡底，输入板加大。

### 改动文件（仅这三个）

- `packages/web/src/components/SessionAgentsPanel.vue`
- `packages/web/src/components/ChatPanel.vue`
- `packages/web/src/components/MessageItem.vue`（以及仅在必要时 `ToolRow.vue`）

### 2.1 右栏契约

- 统计卡（`stat-card`）**退役**，数字不丢：头行一行显示 `成员 5` + 右对齐 `消息 N · 回复 M`。
- 成员行：**去边框、去白底**，改 `rgba(60,48,40,0.035)` 级淡面；hover 加一层 tint（约 4%）；展开态用一块 tint（**不描边**）。名字用正文色（提一档）。
- 内联 trace 与成员行**连成一块**：两者之间 `gap: 0`；同一块底色（`rgba(200,144,96,0.1)` 级）；上圆角只给成员行、下圆角只给 trace；**中间不得有任何线/缝/背景突变**。
- 底部固定页脚（**不随成员列表滚动**）：`广播模式 [开关]` + `＋ 添加猫咪`。`会话配置` 折叠卡与虚线大按钮退役，功能迁到页脚。
- **删「调度队列」分区**（`section-title 调度队列` + `queue-empty 暂无排队任务`）：队列信息只留成员行徽章 `队列 N`；头行加一枚 `队列 N` chip，**仅当存在排队时出现**。
- 保留 `member-tokens`、`avatar`、`status-dot`、手风琴 trace 全部行为。

### 2.2 中栏契约

- **工具行**：去边框，改 3px 圆头色带（左缘内缩 4px）+ 同色相淡底 8%；色带按工具类型：Read `#6b7fa8`、Grep `#8a7bd8`、Bash `#c89840`、Edit `#5a8f6e`。行间用 4px 间隙分开，不用线。
- **思考过程块**：去外描边改极淡底（alpha 0.06–0.08，外框保留一条，归**分区线**——按 §0.3 档位表 0.06–0.09 属分区档；条内三条全宽子分隔线同属分区语义，是嵌套块内子区分隔，不适用「两端缩进 ≥12px」的栏边要求）。
- **输入板**：**保留线框**（交互线，alpha 0.16 静置 / 0.24 hover / 聚焦暖色环）；默认外高约 **126px**（文本区约 64px ≈ 3 行），随内容长高（实测 8 行 → 约 234px）；发送按钮移到输入板右下角。
- **气泡**：agent 气泡去边框（白底 + 极轻阴影），user 气泡去边框（暖底）；hover 操作条（含**复制**）必须仍然出现在气泡 hover 时且位置不压正文。
- 头行去 `border-bottom` 改渐隐；输入区上方 1px 线删除，改渐隐 + 轻阴影。

### 2.3 验收

- AC1 右栏视口内可见边框数 ≤ 1（唯一允许 = 页脚上方的分区线，两端缩进 ≥12px）。
- AC2 成员列表滚动 500px 后，页脚 `getBoundingClientRect().top` 不变（固定态）。
- AC3 trace 展开：成员行与 trace 之间**缝隙 = 0**（`getBoundingClientRect` 上边界相接），背景色一致，中间无 `border`。
- AC4 队列：`queueLength=0` 时头行无 chip、无「暂无排队任务」文本；`queueLength=2` 时头行 chip 与成员行徽章同时出现。
- AC5 工具行四色带按类型取值正确（读 `getComputedStyle().borderLeftColor` 或等价实现），四行行高一致。
- AC6 输入板默认外高 ∈ [120,132]，输入 8 行后 ≥200；聚焦有可辨环。
- AC7 **保留功能全绿**（§0.2 的 P1–P5 逐项真机/挂载级验证）：记忆抽屉可开可关、时间戳四档格式、耗时 footer、成员 tokens、hover 复制变 ✓、trace 手风琴、回退弹窗。
- AC8 emoji 零替换：`SessionAgentsPanel` 与 `ChatPanel` 中头像/图标仍是文本 emoji，新增 `<svg>` 数 = 0（既有 svg 不动）。
- AC9 静态源断言改钉新不变式：`SessionAgentsPanel.test.ts` 现有 `stat-card`/`消息总数`/`调度队列`/`暂无排队任务` 等断言必须改钉（如「头行含统计」「页脚含广播开关」「队列 chip 条件渲染」），**不许净删**；`ChatPanel.test.ts` 的 `?raw` 断言（滚动 sticky、memory-drawer-md、tick 纪律）不得失效。
- AC10 `pnpm test:web` + `pnpm lint` 全绿；diff 仅限 §2 三文件（+ 必要测试文件）。

## 3. 非目标（明确不做）

- 不做「记住上次浏览位置」（滚动位置持久化）——独立功能，未立项。
- 不改后端、不改 store 数据流、不加依赖。
- 不做暗色主题的额外配色调优（沿用 token；若暗色下三档不可辨，在票内微调并回报）。
- 不换 emoji 为 SVG、不新建头像组件。

## 4. 提交与审查

- 走 worktree；提交标记 `catstudy [<40 位真 uuid>] feat(web): ...`（uuid 用真实触发消息 id，禁自铸）。
- 提交后按 `request-review` 发起审查，**审查须知写进请求**：先通读完整 diff 再核对本文档。
- 收口归店长；纯 web，**不需要重启**。

## 5. 收口记录

- **票① 全局框架**：`1fb2c9b`（审查 ✅）→ PR #219 → dev `682433c4`。
- **票② 面板层**：交付 `6b68c42`，内容面 = `4833d90`（tree 同为 `8feb58ad612665a5081408ef19979512987d52ea`，两条空 diff 实测成立）；审查 💬 仅评论零返工（R1 三条必修项落地：线 token 单源、`--bg-deep` 语义分流、交付态干净）→ PR #220 → dev `d88361c3`。
- 收口裁决：`--line-interactive-strong` 判为交互线的 hover/聚焦**状态档**，非第三档语义；思考块内三条全宽子分隔线判分区语义、不要求 12px 缩进；`index.html` 属店长返工令授权补的状态档；深色两栏 6/5/3 色差等用户实看后再定。
- 视觉真相源仍是原型 `D:\Game\ai\catStudy-sessions\2ad72e1c\prototype-right-panel.html` 的「提案 B·改」态；本票单为在飞记录，收口后以代码与原型为准。
