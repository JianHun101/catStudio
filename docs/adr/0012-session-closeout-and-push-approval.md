# ADR 0012: 收口器 + push 审批——收口链路收敛进函数、push 边界归用户

> **Status**: accepted（2026-08-26 店长派活单定稿）
> **实施进度**：三刀全部落地——刀 1 收口器（`llm/session-closeout.ts` + 18 测试）✅、刀 2 push 后端（MCP `type:'push'` → internal → diff 采集 → socket push 执行）✅、刀 3 push 前端（ChatPanel 审批面板 + V2 按钮）✅。每刀独立 commit 全绿可回滚。
> **背景链**：会话 worktree 收口的「删 worktree 拆自己脚下」事故（店长 2026-08-20 实锤）→ push 审批形式用户确认（按钮 4 方案 → V2 组合）→ 收口器方案定稿 → 本文档留痕。

## 背景与摩擦（证据段）

- **删 worktree 拆自己脚下**：收口链路曾是店长手工敲裸命令（merge → worktree remove → 删分支 → 写 gate → checkout），裸命令组合容易拆错顺序；且收口自己会话时 `process.cwd()` 正落在被收口的 worktree 内——物理残留清理会删掉当前进程正站着的目录树（Windows cwd 句柄无 FILE_SHARE_DELETE，删后进程不抛错但一切 IO 悬空 → 僵尸进程占 slot、FIFO 全排队）。`removeSessionWorktree`（git-utils.ts）已带自指守卫 + cwd 无关，坑只在店长手工敲裸命令时存在。
- **push 审批需要「原因 + diff」展示**：用户确认 push 审批形式需展示改动原因和代码 diff 内容，前端提供按钮点击后执行 push。
- **店长手工塞 diff 是信任漏洞**：若由店长在审批消息里手写 diff，内容与真实提交无绑定（可篡改/可漂移）；diff 必须由服务端从 git 实时采集 `origin/dev..dev`，拒绝任何手工塞入路径。

## 决策

1. **收口器独立模块** `packages/server/src/llm/session-closeout.ts`（git-utils.ts 已 619 行，收口器独立成模块；复用 `getMainRepoRoot` / `removeSessionWorktree` / `cleanGitEnv`——后两者本轮从 git-utils 导出）。接口契约：
   - `inspectCloseout(sessionId): CloseoutState` — 只读探针（branchExists/worktreeExists/mergedIntoDev/gateSynced/onDev），店长先看后动
   - `closeoutSession(sessionId): CloseoutResult` — 店长只调这个，不手工敲裸命令；失败时 `step` 定位（preflight/merge/worktree/gate/checkout）+ `error` 说明
2. **4 个 `@internal` step**（仅供测试直调，店长禁止乱序调）：
   - `mergeSession` — `git merge session/<id> --ff-only`（cwd 固定 mainRoot）
   - `removeWorktree` — **复用** `removeSessionWorktree(sessionId)`（已含删分支 + 自指守卫）
   - `writeGate` — `git rev-parse HEAD > .push-gate`（cwd mainRoot，禁 shell 重定向，writeFileSync 落盘；幂等同值不重写）
   - `checkoutDev` — `git checkout dev` + cwd 复位（process.cwd() 位于已收口 worktree 内 → chdir 到 mainRoot，防悬空 IO）
3. **硬约束**：每步 git 命令 cwd 固定 mainRoot，绝不依赖 process.cwd() 作为 git 工作目录。mainRoot 在 `closeoutSession` preflight 从 `git-common-dir` 探测**一次**后显式传给全部 step——自指场景下 `git worktree remove` 可能半删 worktree 的 `.git` 指针，此时再从 cwd 重新探测 mainRoot 必然失败（测试实锤：`checkoutDev`/`writeGate` 全断）；传参后 mainRoot 与 cwd 解耦。
4. **幂等 check-then-act**：中断重跑 = 续跑，从 git 现状推导已完成的步——分支不存在 → merge 跳过；worktree 目录不存在 → remove 跳过；gate 值相同 → 不重写；已在 dev → checkout no-op。`git merge --ff-only` 已合过返回 "Already up to date" 幂等成功。
5. **push 不进收口器**：push 是「本地↔共享」不可逆边界，决定权归用户。收口器只做本地机械步骤（merge/删/写 gate/切分支）；push 走审批节点（见下）。
6. **push 审批契约**（复用 restart 链路，扩一条通道）：`request_user_action` MCP 工具新增 `type: 'push'`（店长收口做完本地机械步骤后发起）→ 服务端实时采集 `git log origin/dev..dev`（commits）+ `git diff origin/dev..dev`（RichBlock[]，复用 diff-collector 采集管线）→ 消息 `messageType: 'push_request'` + extra（commits + rich.blocks）→ 前端面板（reason + commit 列表 + 可折叠 diff + V3 按钮）→ 用户点确认 → socket `PUSH_CONFIRM` 执行 `git push origin dev`（cwd mainRoot）。**全程无「店长手工塞 diff」路径——diff 一律服务端实时采集**。
7. **push 状态内存化**：push 无跨进程需求（restart 需 dev.js 轮询所以落文件；push 由 socket handler 直接执行）→ 不落文件，进程内状态即可。
8. **按钮 V3（用户定稿，照 `push-button-prototype.html` 顶部组合方案实现）**：布局 A 一行 flex、确认占主导（`flex:1`）；确认按钮 D 卡片大按钮（左「dev → origin/dev · N commits」右「确认 Push」，hover 整块实心 + 上浮）；取消按钮幽灵描边 + `min-width:92px` + `padding:12px 28px`，hover 实心警示红 + 白字 + 上浮阴影。原型为 throwaway（未进 git），实施照样式令牌落 ChatPanel.vue。

## Considered Options（按钮 4 方案 → 用户裁决）

| 方案             | 形态                              | 裁决                                                                                                 |
| ---------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| A 实心主按钮     | 渐变蓝紫实心 + 白字，取消幽灵描边 | 布局采纳（一行 flex、确认 `flex:1` 主导），与「确认重启」同族                                        |
| B 危险警示       | 琥珀/橙红描边，hover 实心         | 否决为主形态（语义诚实但视觉过重）                                                                   |
| C 分段胶囊       | 确认+取消合一，中间分隔线         | 否决（省空间但视觉噪音/改面大）                                                                      |
| D 审批卡片大按钮 | 整块底条可点，左 meta 右 CTA      | 确认按钮采纳（卡片大按钮 + hover 实心上浮）；取消不退回文字链接（保留并排幽灵按钮，强化 hover 反馈） |

## Consequences

- **涟漪清单**：git-utils.ts 新增导出（`cleanGitEnv`/`sessionShortId`/`sessionBranch`/`sessionWorktreePath`，纯导出零行为变化）；`scripts/mcp-server-utils.mjs` 与 `packages/server/src/routes/internal.ts` 的 `USER_REQUEST_TYPES` 加 `'push'`；`collectPushDiffs()` 挂 `git/diff-collector.ts`（复用 `runGit`/RichBlock 管线）；shared 加 `'push_request'` MessageType / `MessageExtra.push` / `PUSH_CONFIRM`/`PUSH_CANCEL`/`PUSH_STATUS` 事件；socketio.ts 加 push 执行 handler。
- **切片**：刀 1 收口器（独立模块 + 测试，幂等重跑/cwd 无关/自指守卫）；刀 2 push 后端（MCP → internal → 采集 → 信号 → socket push 执行）；刀 3 push 前端（面板 + V3 按钮 + 审批交互）。每刀全绿独立 commit，可独立审查回滚。
- **风险点**：`closeoutSession` 的 `merge --ff-only` 依赖收口时主工作区在 dev（前 3 步假设），checkoutDev 是第 4 步兜底「确保 dev + cwd 复位」；push 执行失败（远端拒绝/网络）由 handler 错误回前端，审批态清理不悬置。
- **已知观察项**：剩余 8 个会话 worktree（008bbe9a/21687fc2/53f8ab57/705cd595/8e085d48/d1cedfd8/d85c4add/e91813c6）后续收口统一走 `closeoutSession`，避开裸命令坑。

## 待确认

- [x] ADR 编号 = **0012**（0010 留给知识库二期；0011 已占用 execution 抽取）
- [x] 按钮形态 = **V2 组合**（A 布局 + D 确认 + 强化取消），用户已在原型页定稿
- [x] push 审批 diff 来源 = **服务端实时采集**（`git log/diff origin/dev..dev`），拒绝店长手工塞
- [x] push 状态存储 = **内存化**（无跨进程需求，不落文件）
- [x] 刀 2/刀 3 实施中（派活单三刀薄切）→ 已完成：刀 1/刀 2/刀 3 全部落地（2026-08-26）
