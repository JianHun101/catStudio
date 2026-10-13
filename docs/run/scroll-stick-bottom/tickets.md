# 票单：主消息区滚动贴底改尺寸观测（ResizeObserver）

- 立项：2026-10-13，用户报「点进会话，落点既不是上次浏览位置也不是最下方」（触发消息 `0443c12c`）；用户原型裁决后说「派活」
- 派工：ds猫（纯 web，单组件），走 worktree；审查链 → 店长收口；**无需重启**（Vite HMR 覆盖）

## 根因（实证链，逐环已钉死）

1. **「上次浏览位置」不存在是现状设计**：全仓零 scrollTop 持久化（切会话只缓存消息数组）。本票**不做**这个（见 Out of Scope）。
2. 「应落底」机制现状 = **事件源穷举**：`watch(activeSessionId)` → `setTimeout(scrollToBottom, 50)`（`ChatPanel.vue:377-382`）、`watch(lastMessageId)`（`:341-353`）、流式内容 watch（`:364-374`）、`messageStatus` watch（`:385-391`）。
3. 最后一次滚动完成后内容仍在长，而主消息区**没有任何东西再纠一次位置**：
   - **SESSION_HISTORY 权威校正**：`messages` 整体替换且顶部插 welcome/交接摘要；末条消息 id 不变时 `lastMessageId` watch **不触发** → 不重滚。
   - **执行元数据回填**：`fetchSessionExecutions` 异步回来给气泡补 footer，每个气泡长高一截。
   - **图片解码**：历史消息 dataURL 图片滚动完成后才撑开。
4. 折叠块早修好同一族：`ChatPanel.vue:393-479` 三不变量（I1 跟随 / I2 让位 / I3 复位）+ sticky 位 + ResizeObserver；`:399-402` 注释明写判据——「**观测面选尺寸而非内容增长来源，后者要求穷举才正确，漏一个就静默失效**」。主消息区没挂 RO，三个 watch 就是穷举写法，SESSION_HISTORY 整体替换正是漏掉的来源。

用户看到的落点 = 50ms 那次贴底完成后内容又长了 N 像素，滚动条原地不动，视觉悬在半截。

## 改动面（契约级，`ChatPanel.vue` 为主）

1. **主消息区挂 ResizeObserver，照抄折叠块范式**：
   - 观测**内容元素**（消息列内层、`scrollHeight` 的增长源）——**不是**滚动容器 `chatContainer`：容器尺寸被视口钉死，RO 永不触发，这是最易踩的陷阱，回执须自证挂对了元素。
   - 回调纪律与折叠块同构：rAF 节流（`:434-448` 范式，防 RO loop 告警）；**只读 sticky 位、不写**；sticky 位唯一更新口仍是真滚动。
2. **sticky 位复用既有 `isAtBottom`**（`:310-324` onScroll 几何重算），不新造第二份。
3. 既有 watch **全保留**——`newMessageCount`/`showScrollDown` 指示器语义归它们，RO 只补「尺寸增长时维持贴底」。
4. `watch(activeSessionId)` 的 `setTimeout(scrollToBottom, 50)` 保留（初始落底），RO 负责其后维持。
5. **元素生命周期陷阱**：内容元素随会话切换/空态分支可能重建（模板 v-if 分支实测）⇒ 观测随元素生命周期重挂——`vFoldStick` 指令范式（`:458-479`，mounted/unmounted 严格配对）或 template ref + watch，实施者择一，回执说明选型与理由。

## 边界（Out of Scope）

- **不做「每会话 scrollTop 记忆 / 恢复上次浏览位置」**——那是新功能（存哪、何时清、与贴底语义如何共存都要另裁），用户未选，明写非目标。
- 不改 `chat.ts`、不改折叠块既有逻辑、不动后端、不加新事件。
- 渲染纪律：不引入任何每秒变化的响应式状态；RO 回调是非响应式路径，顶层响应式状态增量为零（既有静态断言守门）。

## 验收（行为可验）

- **AC1（跟随/让位两分支）**：挂载测试——`isAtBottom=true` + 内容元素尺寸增长（模拟）→ `scrollTo` 被调；`isAtBottom=false` → 不调。
- **AC2（挂对元素）**：RO observe 的目标是内容元素而非滚动容器（静态源断言或挂载断言，回执写明判据）。
- **AC3（不回归）**：既有 smart-scroll 测试全绿（lastMessageId watch、新消息指示器、会话切换落底）。
- **AC4**：全量测试 + `node scripts/lint.js` 全绿；`git diff --stat` 限 `ChatPanel.vue` + 其测试文件。
- **AC5（真机，收口时店长 Playwright 做）**：切进长会话 → 落定后滚动位置在底部（末条消息可见）；注入内容增长（SESSION_HISTORY 级替换 / 元数据回填）→ 仍钉底；向上滚动 → 增长不拽回；滚回底部 → 恢复跟随。

## 提交

- 走 worktree；`catstudy [0443c12c-a0de-4123-8bb6-e42e9bbbc1d1] fix(web): …`（40 位真 uuid，即本票触发消息）。
- 提交后按 `request-review` 发起审查；收口归店长。
