# 票：SessionList collapsed 分支死代码清理 —— 与 display:none 同条件，永不可见

> 状态：已立票 · 未派
> 来源：left-closed 塌 0 票审查（PR #196）吐槽猫 P3 观察项 / OQ-3 复核结论
> 基线：dev `fdf8c29d`

## 现状

`packages/web/src/components/SessionList.vue` 的 `collapsed` prop 分支（收起态渲染路径）与 `App.vue` 中 `.panel-left` 的 `display:none` 恰好同条件（`!leftOpen`）——左栏一收起整个 panel 就不生成盒，`collapsed` 分支的 DOM 永不可见，是死代码。审查者已独立复核成立（left-closed 票 OQ-3）。

## 任务

1. 删除 SessionList 中 `collapsed` 分支及其 prop 传递链（`App.vue` 侧如只喂这一个消费面，一并摘掉）；
2. 删前全仓 `git grep collapsed` 确认无其他消费面（模板 / 测试 / 样式），有则在交接文档列清单并说明取舍；
3. 若现有测试钉了 collapsed 分支行为，同批删/改，并在提交说明写明。

## 验收

1. `git grep -n collapsed` 在 `packages/web/src` 零命中（或剩余命中均在交接文档点名说明理由）；
2. web 全量测试 + lint 绿；
3. 左栏展开/收起往返渲染与 dev 基线无差异（真机或 worktree vite 自证，3200/5173 只读不碰）。

## 边界

- web-only，只动 SessionList 及其直接喂参处；不重设计收起态交互（若产品上要恢复「窄条收起态」另立票，不在本票）。
