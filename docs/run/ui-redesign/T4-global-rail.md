# T4 全局轨道统一 —— 设置/追踪/评估页接入 52px 主导航

## 一、背景与设计基准

用户原话：「设置页面左侧的导航栏跟原型布局不一样，执行追踪也保持一样的导航栏。全局逻辑视觉统一」。

**病灶（已实核源码）**：T1 把 52px 图标轨道做进了 `.app-layout` 内部，而 `SettingsView` / `TraceView` / `EvaluationView` 是 App 级全屏覆盖层（`v-if`/`v-else-if` 互斥 + `.app-layout` 用 `v-show` 隐藏）——**打开任一覆盖层，整条轨道消失**，三个视图各自带「页头 + ✕ 关闭按钮」作为返回手段。

**设计基准 = 原型 v6**（`C:\Users\肖锦鹏\AppData\Local\Temp\catstudy-ui-redesign-prototype-v6.html`，三个 tab 切换看）：**52px 轨道在全部视图常驻**（聊天/执行追踪/系统设置），当前视图的轨道按钮带 `.on` 高亮（accent-soft 底色 + 左缘 3px accent 指示条）；设置页 = 轨道 + 188px 大类导航 + 卡片列；追踪页 = 轨道 + 48px 标题栏（**无关闭按钮**）+ 列表。原型里不存在「✕ 关闭」——轨道就是导航。

**铁律：功能零削减。** 只动导航外壳（轨道提升 + 关闭按钮退役），三个覆盖层视图的内部功能一行不动（T2 追踪页全部功能、T3 设置页全部控件、评估中心全部功能原样保留）。

## 二、改动规格（web-only）

### A. App.vue —— 轨道提升为全局常驻

1. **轨道从 `.app-layout` 里提出来**，升到根级：根容器改 `display:flex` 行向 → `<nav class="app-rail">`（52px，永远渲染，不吃 `v-show`）+ 内容区（`flex:1; min-width:0`）。`.app-layout` 与三个覆盖层全部进内容区。
2. `.app-layout` 的 grid 摘掉第一个 52px 轨道列：四列 `52px 236px 1fr 300px` → 三列 `236px 1fr 300px`；`left-closed` 态同步调（会话栏列归零），既有「轨道留 + 会话栏 display:none 双管」语义不变——只是轨道不再归它管。
3. **轨道按钮激活态动态化**（现在是 💬 硬编码 `on`）：派生 `currentView: 'chat' | 'trace' | 'eval' | 'settings'`（无覆盖层 = chat），四个按钮按它挂 `.on` + `aria-current`。
4. **互斥开关联**（`openTrace` 已有同款语义，补齐另外两个）：`openSettings()` / `openEval()` —— 开一个关其余；💬 按钮 = 关全部覆盖层回聊天（保活语义不变：`.app-layout` 仍是 `v-show`，切回零重建）。点当前视图自己的按钮 = 无操作。
5. 气泡 footer ⚙ 带预选进追踪页（`openTrace(id)`）路径不变。

### B. 三个覆盖层 —— 关闭按钮退役

1. `SettingsView`：页头 `.settings-header`（标题 + ✕）**整个移除**——原型设置视图无页头，轨道 + 大类导航即全部导航壳。
2. `TraceView`：保留 48px 标题栏（对齐原型 `.trace-hd`），**只删 `.btn-close`**。
3. `EvaluationView`：原型 v6 未画此页——对齐追踪页形态：保留标题栏、删 `.btn-close`。
4. 三视图的 `close` emit 声明与 App.vue 上对应 `@close` 处理器一并清除。
5. **a11y 口径同步**：三视图根元素现在是 `role="dialog" aria-modal="true"`——轨道常驻后它们不再是模态（模态承诺「背景不可交互」，与轨道可点矛盾），改为普通视图容器（去 `role="dialog"`/`aria-modal`，保留 `aria-label`）。
6. **注意别误伤**：`SettingsView` 里还有**弹窗级**关闭按钮（`closePicker` 的 `.btn-close`、创建猫的 `.btn-close-sm`、`AgentEditModal` 的 `@close`）——那些是模态弹窗的，原样保留。

### C. 窄窗与既有行为

- 轨道任何窗宽常驻（52px 无挤压问题）；既有 650px/1000px 媒体查询只管会话栏/右栏，逻辑不动。
- T1 验收形态不得回退：聊天页 = 轨道 + 会话栏 + 主区 + 右栏、三条 48px 头行同线、收起/窄窗三态正常。

## 三、边界

- web-only，零 server 改动。
- 不动三个覆盖层视图的内部功能、数据流、API；不动 store。
- 轨道按钮集合不增不减（💬/⚙/📊/齿轮），不加新入口、不加 Esc 快捷键一类新交互（要加先问用户）。

## 四、验收（行为可验）

1. **四视图轨道常驻**：聊天/追踪/评估/设置四个视图下 DOM 探针均存在 `.app-rail`，且 `.on` 落在对应该视图的按钮上（聊天=💬、追踪=⚙、评估=📊、设置=齿轮）。
2. **纯轨道导航闭环**：只用轨道按钮（不碰任何 ✕）能走完 聊天→设置→追踪→评估→聊天 全环；每步视图正确切换。
3. **关闭按钮清零**：`SettingsView` 页头整段不存在；`TraceView`/`EvaluationView` 标题栏无 `.btn-close`；弹窗级关闭按钮（猫咪选择器/创建猫/AgentEditModal）仍在且可用。
4. **保活不回退**：聊天 → 设置 → 回聊天，`SessionList` 组件实例不重建（同一 DOM 节点引用或 mounted 计数=1）。
5. **T1 形态不回退**：聊天页四栏 x 坐标与 48px 头行对齐实测同 T1 验收口径；`left-closed` 收起后轨道仍在、会话栏消失。
6. **设置页形态对齐原型**：设置页 = 轨道（52px）+ 大类导航 + 卡片列，从左到右三层；大类导航各分区点击定位功能不变。
7. `pnpm test` + `pnpm lint` 全绿（worktree 内 vitest 直调口径）。
8. **真机自证截图四张**（探针口径同 T1/T2：worktree 5174 vite + 3200 只读 + 无头 Edge CDP，不碰 3200/5173）：聊天 / 设置 / 追踪 / 评估各一张，轨道与 `.on` 态清晰可见，附审查请求。

## 五、Open Questions

1. `EvaluationView` 标题栏除标题外若还有别的控件（刷新一类）——原样保留，只删 ✕；交接文档里列出该页头实际构成。
2. 覆盖层根元素的 `role="dialog"` 移除后若有无样式连带（`:modal` 一类选择器），顺手核对并如实报告。
3. 轨道 💬 按钮的 title/aria-label 文案维持「对话」，不擅自改词。

## 六、纪律

- 走 worktree；`git add <路径>` → 核对暂存区 → 裸 commit（禁 `--only`/`add -A`）；commit 带 `catstudy [$CATSTUDY_TRIGGER_MSG_ID]`。
- 票由你带入分支（复制本文件，不在 dev 上改）。
- 单轮 30 分钟硬上限——本票体量中等（App.vue 重排 + 三视图删头），一轮可完；若不够，实现落 commit 即安全，收尾分轮。
- 完成后过 quality-gate，审查投**吐槽猫**（附四张自证截图）。
- web-only ⇒ 无需重启审批，收口后 vite 热更即生效。
