---
status: closed
---

# 票单：输入板默认 2 行 + 8 行封顶滚动

- 立项：用户原话「输入框不用这么大，可以稍微矮一点；内容撑到一定大小出现滚动条就行」。
- 派工：flash猫（纯 web，单组件）；审查链 → 店长收口；**无需重启**（Vite HMR 覆盖）。
- base：本票单所在提交（其父 = `origin/dev` = `bd3f81f`；精确 sha 见派活单）。
- 与 `docs/run/ui-b-refresh/tickets.md` AC6 的关系：那张是已关票的验收历史（默认 126px / [120,132]），**不改**——改它等于重写历史。本票是新规格，活规格以代码注释与本票验收为准。

## 现状（真机读数，非估算）

用 Playwright 打 `:5173` 量的当前 dev：

| 读数                      | 当前值                                                   |
| ------------------------- | -------------------------------------------------------- |
| `.input-plate` 外高       | 128.3px                                                  |
| `.chat-input`（textarea） | 64.3px / `rows="3"`                                      |
| `max-height`              | `none`（无上限）                                         |
| `overflow-y`              | `auto`（有声明，但高度永不超过内容，所以永远不出滚动条） |

两个毛病叠加：**空着就占 3 行**，**写长了没有天花板**。要改的就是这两个数，外加把已经写了但从未生效的 `overflow-y: auto` 真正激活。

## 改动面（2 文件，边界钉死）

**1. `packages/web/src/components/ChatPanel.vue`**

- `rows="3"` → `rows="2"`。
- `.chat-input`：`min-height: 64px` → **44px**；新增 `max-height: 172px`；新增 `scrollbar-width: thin`。`overflow-y: auto` 保留（改完它才真正可能生效）。
- `.input-plate`：`min-height: 124px` → **104px**。
- `autoGrow()`：归零成 `auto` 后，用 `getComputedStyle(ta).maxHeight` 读上限并钳制——`Math.min(scrollHeight, cap)`；`cap` 解析不出（`none` / 空字符串 → `NaN`）时不钳制。**上限只在 CSS 写一次**，JS 只读不算。
- 三处注释同步重写：`autoGrow` 的 JSDoc（原「默认约 3 行，8 行 → 约 230px 外高」）、`.input-plate` 注释（原「默认约 3 行高（min-height 124px）」）、`.chat-input` 注释（原「min-height 3 行」）。

**2. `packages/web/src/components/ChatPanel.test.ts`**

- AC6 那组断言改数：`min-height: 104px`、`rows="2"`、`min-height: 44px`，describe 标题「默认约 3 行」改掉。
- 新增静态断言：`.chat-input` 含 `max-height: 172px`。
- 新增**行为**用例（必须有，不许只做静态断言）：mount 后取 `textarea.chat-input`，`Object.defineProperty` 定义 `scrollHeight`，用 `Proxy` 包 `window.getComputedStyle` 只把 `maxHeight` 换成 `172px`：
  - `scrollHeight = 300` → `style.height === '172px'`
  - `scrollHeight = 120` → `style.height === '120px'`
  - `maxHeight = 'none'` → 不钳制（`300px`）

## 不做

- 不动 `SettingsView.vue`、`App.vue`、任何 `.ts` 逻辑、`docs/run/ui-b-refresh/**`。
- 不改发送/附件按钮的视觉与位置（只验证它们在矮态下不被挤压）。

## 验收（行为可验证）

- **A1 空态**：`.input-plate` 外高 ∈ `[104,112]`；textarea ∈ `[42,46]`。
- **A2 三行**：输入 3 行文本，textarea ≈ 64px，且 `scrollHeight <= clientHeight`（未封顶，无滚动）。
- **A3 十二行**：输入 12 行文本，板高 ∈ `[230,240]`；textarea `clientHeight ≈ 172` 且 `scrollHeight > clientHeight`（真在框内滚动）。
- **A4 回落**：清空输入后回到 A1 区间。
- **A5 旧值清零**：`git grep` 在 `packages/web` 下对 `min-height: 124px`、`min-height: 64px`、`默认约 3 行` 零命中；`ChatPanel.vue` 内 `rows="3"` 零命中。
- **A6 测试与类型**：`node node_modules/vitest/vitest.mjs run packages/web/src/components/ChatPanel.test.ts` 全绿；`node scripts/lint.js` 三包通过。
- **A7 范围**：`git diff --name-only <票单提交 sha>..HEAD` 恰为上述 2 文件（票单本身已含在 base 里，不算进改动面；sha 见派活单）；提交 message 带 `catstudy [<CATSTUDY_TRIGGER_MSG_ID>]`（变量为空就停下回报，不要编 UUID）。

## 真机探针纪律

- 探针脚本放临时目录、不入库、跑完删。
- 用 **5199** 端口起 worktree 的 Vite，别碰 5173。
- 只输入、不发送（发送会写真实 dev 库）。
- 回执贴四项读数的 JSON（空态 / 3 行 / 12 行 / 清空）。

## 执行顺序

改 → A1/A2/A5 → A3（真机）→ 限定路径 `git add` 并核对 `git diff --cached --name-only` → 裸 commit → quality-gate → **自己投吐槽猫发起审查**（正文写明 commit_sha、A1–A5 读数、A3 的几何 JSON）。不 push、不合并。

- 回滚：`git revert <commit>`，纯前端样式。
- 重启判定：只改 `packages/web`，Vite HMR 下次刷新即生效，**不需要重启 server**。
