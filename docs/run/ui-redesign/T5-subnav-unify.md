# T5 · 次级导航统一：设置贴左 + 评估换左导航 + 追踪限宽

> 立票：2026-09-28 · 店长。来源：用户三连反馈——「设置的二级导航栏还是这么宽」「评估中心把标签页换成二级导航栏统一页面逻辑」「执行追踪展示内容过宽，看起来非常吃力」+「导航栏是188px，但是左边还有大片空白」。
> 类型：纯 web 改版，零功能增减。收口后 vite 热更生效，**无重启审批**。

## 一、病灶（已实核 dev 尖端 `6b92821e`）

1. **设置页左空白**：`.settings-layout { max-width: 1100px; margin: 0 auto }`——整个设置页（导航+内容）在轨道右侧居中。宽屏下轨道与导航之间出现数百 px 纯空白（1920 屏约 380px）。原型 v6 的导航是**贴轨道左缘**的，T3 实现时容器居中化引入了偏离。
2. **导航过宽**：`.settings-nav { width: 188px }`（原型 v6 数值，「图标+文案一行下限」）。用户两轮嫌宽。
3. **评估中心是横向 tab**（`.eval-tabs`/`.tab-btn`，五 tab：观察/回标/标注/链路/检索）——与设置页左侧导航逻辑不统一。
4. **执行追踪无宽度约束**——列表与详情铺满全屏，宽屏下一行六读数跨度过大。

## 二、改动规格

### A. 新增共享组件 `SubNav.vue`（packages/web/src/components/）

- props：`items: Array<{ key, label, icon, badge? }>`，`modelValue: string`（激活 key）
- 样式即设置页现有 `.settings-nav`/`.nav-item` 收窄版：**宽 148px**、图标 14px、内边距收紧、激活态 `--accent-soft` 高亮不变
- badge（评估「回标」待办数）渲染在 label 右侧，小红点样式沿用现有角标

### B. 设置页（SettingsView.vue）

- `.settings-layout`：**`margin: 0 auto` → 贴左**（`margin: 0`），导航紧贴 52px 轨道，消灭左空白
- `.settings-nav` 188px → 148px，改用 SubNav 组件
- 内容卡片列保持 `max-width: 720px`，在**剩余区域**内居中（`.settings-content` 内 `margin: 0 auto`）

### C. 评估中心（EvaluationView.vue）

- 横向 `.eval-tabs` 整段移除，换成 SubNav（148px 左侧竖排），五 tab 一一对应、`pendingBadge` 保留
- tab 内容区逻辑一行不动
- 内容区横向少 148px——观察/链路 tab 的宽表格有横向滚动兜底，实施时逐 tab 截图自证不破版

### D. 执行追踪（TraceView.vue）

- 列表与详情统一收进 `max-width: 1100px` 内容列（与设置容器同宽），**居中**（无导航，居中不产生左空白问题）
- 过滤栏、列表行、展开详情全部收进该列

## 三、边界（铁律）

- 功能零削减零新增：设置全部控件、评估五 tab 与角标、追踪全部读数一个不少
- 不改轨道（52px）、不改聊天区、不动 server/shared
- SubNav 只被设置与评估消费；追踪无导航不引入

## 四、验收（行为可验）

1. **设置贴左**：1920px 视口下 `.settings-layout` 的 `getBoundingClientRect().left` ≤ 轨道右缘 + 24px（空白从数百 px 收敛到内边距级）
2. **导航收窄**：设置/评估两处 SubNav 实测宽 = 148px，五类标签一行不折
3. **评估换导航**：五个 tab 全部可达，回标 badge 数值与改前一致；横向 `.eval-tabs` 零残留
4. **追踪限宽**：1920px 视口下列表内容列宽 ≤ 1100px 且水平居中
5. **功能零削减**：SettingsView 既有静态断言全绿；EvaluationView tab 切换测试改锚后意图保留（不得删断言只改选择器）
6. **test + lint 全绿**
7. **真机自证截图 ×4**（1920 与 1366 两种视口 × 设置页/评估页）附审查请求——探针口径同 T1/T2（5174 vite + 3200 只读，不碰活实例）

## 五、OQ

1. 1366px 窄屏下 SubNav 148px 是否挤压内容：内容区 min-width 0 + 表格横滚兜底，截图自证。
2. SubNav 做成共享组件 vs 两处复写：共享（单一真相源），样式差异走 props/slot 不开分支。
3. 追踪列居中 vs 贴左：无导航的页面居中（与聊天 840 居中同节奏）；有导航的页面贴左（导航锚定轨道）。
