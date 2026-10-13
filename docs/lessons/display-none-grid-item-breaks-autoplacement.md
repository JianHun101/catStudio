---
type: lesson
date: 2026-09-30
status: proposed
evidence:
  - kind: commit
    ref: fdf8c29d
  - kind: file
    ref: packages/web/src/App.vue
  - kind: file
    ref: packages/web/src/App.test.ts
---

# `display:none` 的 grid item 不再是 grid item——自动放置会把后继 item 整体前移一格

## 撞出来的场景

三栏布局（`.app-layout` 的 `grid-template-columns` 是「左栏宽 + `1fr` + 右栏宽」）要做「收起会话栏」态：
`.panel-left` 加 `display:none`，首列 track 写成 0。当时的理解是「0 宽列 + 该项不占位 ⇒
主聊天区自然占满剩余宽」。

真机量出来的不是这样（1440 宽收起态）：`center=0`，右栏吃掉整条 `1fr`（1088）；
窄窗 900 更彻底——`center=right=0`，整屏空白。

## 现象

- 主聊天区宽度 **0**，不可读不可输入。
- 展开按钮跟着被挤到 0 宽，**中心点落到邻近元素上**（`elementFromPoint` 打不中它）⇒ 点不回去。
  这是**单向死锁**，不只是难看：收起是一步可达的，展开没有路径。
- 全程不报错、不告警——Grid 规范里这就是正确行为。

## 机制

`display:none` 的 grid item **不再是 grid item**：它从自动放置算法里整个消失。剩下的 item
随后被**按序前移**——第 2 个 item 落进第 1 条 track，第 3 个落进第 2 条。于是
`.panel-center` 进了那条 0 宽的 track，`.panel-right` 进了 `1fr`。

两个易混点：

- **「显式 track 仍占位」管的是 track，管不了 item 落在哪条 track。** 收起态把首列写成 0
  确实让 track 归零了，但 item 的落位仍由自动放置决定；第一版注释把后者也算进了前者。
- **位移只在「消失的不是末栏」时发生。** 末栏消失时无人后继，自动放置不位移——它留下的是
  **另一形态**：`grid-template-columns` 里那条 track 照旧占位成空列。

## 正解

**列位一律显式钉死，不依赖自动放置**：三栏各写自己的 `grid-column`（`1` / `2` / `3`）。

钉死之后「哪一栏在哪一列」与「该态下有几栏可见」解耦——不必给每个隐藏态各写一份列位。
多 track 的窄窗断点同理成立：落在不存在的 track 上对不可见元素无副作用，不生成隐式列。

## 可复用的动作

1. 凡有「隐藏某一栏」的态，先问**隐藏用的是什么手段**：`display:none` 会让该 item 退出自动
   放置（后继位移）；`visibility:hidden` 保留 grid item 身份（不位移，但 track 照旧占位）。
2. 多栏容器里**不要混用**「有的栏靠自动放置、有的栏靠显式列位」——一旦有 item 消失，
   两类 item 的落位规则就对不上。
3. 隐藏态的验收必须**量几何**，不能只看「元素在不在」：①主区宽 > 0；②主区占满剩余宽；
   ③**隐藏态下仍要能操作的那个控件，中心点 `elementFromPoint` 命中它自己**。第三条是死锁的
   唯一探针——前两条全过、第三条红，照样是完全不可用的界面。
4. **备选方案的副作用要量，别按名字信**：`visibility:hidden` 方案实测落地宽度是 **1px 不是 0**
   （border-box 下 1px `border-right` 被钳在 1px、溢出 0 宽 track），与它自己的「0 宽」口径
   自相矛盾——这类 1px 残差只有量才看得见。
5. **把不变量写成断言**：jsdom 不做 grid 布局，行为断言在本仓不可得，故本仓用静态源断言钉
   「三栏各自独立规则内必须有对应 `grid-column`」，并做了真空性反对照（摘掉钉列 ⇒ 该断言即红、
   且仅此一条红）。

## 溯源

实现落点：`packages/web/src/App.vue` 的三栏 `grid-column` 与 `.app-layout.left-closed`；
守卫在 `packages/web/src/App.test.ts`（jsdom 不做 grid 布局，行为断言在本仓不可得，
故用静态源断言 + 真空性反对照）。
落地提交：`37e6dce8`（实现）+ `99cee01b`（订正一处过强声称），PR #196 merge `fdf8c29d`。
