# T3 系统设置页对齐与美观改版

## 一、背景与设计基准

用户原话：「顺带优化下系统配置那边前端 ui，有些框都没对齐」「设置按 catstudy-ui-redesign-prototype.html（v1）的布局比例走」「左侧缺少系统配置导航栏」「莫名的换行文字」。

**设计基准 = 原型 v6 的设置视图**（`C:\Users\肖锦鹏\AppData\Local\Temp\catstudy-ui-redesign-prototype-v6.html`，切到「系统设置」tab；一次性产物，规格已全部内联本票）。

**铁律：现网设置页功能零削减。** 实施第一步 = 从现网 `SettingsView` 源码抄录全部控件/分区清单进交接文档，验收逐项打勾。未经用户同意不新增设置项。

## 二、改动规格（web-only）

- **左侧 188px 图标导航**：分组「系统配置」（运行参数 / 铁律 / 猫咪管理 / 会话模板）+「接入」（NapCat QQ），带线框 SVG 图标（原型有成品）；选中态 accent-soft 高亮。现网实际有哪些分区以源码为准，原型分组仅作形态参照——**分区集合跟随现网，不增不减**。
- **右侧 720px 卡片列**：每卡 = 标题 + 一句「这页改了什么时候生效」说明 + 表单行。
- **表单行定宽网格**：`grid-template-columns: 148px 1fr`，label 右对齐——所有控件左缘从同一垂直线起跑（治「框没对齐」的根治手段）。
- **`.ctl` 弹性容器**：每行控件与提示文字包进 `display:flex; flex-wrap:nowrap` 的容器（治「莫名的换行」——根因是 grid 里 input 后裸跟的元素被挤到下一行）。
- **控件统一 34px 高**（input/select/按钮）；focus 态 = 边框 `--border-focus` + 3px `--accent-glow` 光晕。
- 只读运行参数用 **kv 行**：右对齐键 + mono 值 + 来源徽章（常量/env/活库），不与可编辑表单混排。
- 开关用既有 toggle 形态（原型 `.sw` 成品样式）。
- 色板零新增，沿用现有 CSS 变量。

## 三、边界

- 不动任何设置项的读写逻辑、API、store action——纯样式与结构重排。
- 不动导航轨道 / 聊天页 / 右栏（T1 的面）。
- web-only，无 server 改动。

## 四、验收（行为可验）

1. **功能对照表**：交接文档含现网控件清单；改版后逐项在场且可操作（改值 → 保存 → 生效路径不变）。
2. 对齐实测：每个 `.frow` 的控件左缘 x 坐标全等（DOM 实测，容差 ≤1px）。
3. 无折行：1280px 宽度下所有 `.ctl` 内容同行不折（`getBoundingClientRect` 高度 = 34px 行高容差内）。
4. 左侧导航各分区可点、定位到对应卡片。
5. `pnpm test` + `pnpm lint` 全绿（worktree 内 vitest 直调口径）。
6. **真机自证截图**：设置页整页 + 一个 focus 态特写，附审查请求。

## 五、Open Questions

1. 现网设置页若有原型未画的分区/控件——原样保留并按本规格套版式，交接文档里逐个列出。
2. 窄窗口（<1100px）下左侧导航收起为图标列还是隐藏？（建议收成纯图标列，写明）

## 六、纪律

- 走 worktree；`git add <路径>` → 核对暂存区 → 裸 commit（禁 `--only`/`add -A`）；commit 带 `catstudy [$CATSTUDY_TRIGGER_MSG_ID]`。
- 票由你带入分支。
- 完成后过 quality-gate，审查投**吐槽猫**（附自证截图）。
- web-only ⇒ 无需重启审批，收口后 vite 热更即生效。
