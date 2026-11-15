---
status: active
---

# Tickets: 会话管理 v2（分组 + 回收站）

把 `docs/plans/session-groups-trash.md` 切成可独立验收的票。**来源 spec**：
`docs/plans/session-groups-trash.md`；**架构依据**：`docs/adr/0016-session-groups-and-trash.md`。

## 总则（每票都适用）

- **走 worktree**：在各自的 worktree 绝对路径内干活，git 一律 `git -C <worktree> <cmd>`。
  分支从 `session/17d152b0`（含本票单与 spec）分叉；开工前先
  `git -C <worktree> merge --ff-only session/17d152b0`。
  - ds猫：`D:\Game\ai\catStudy-sessions\17d152b0-ds猫`，分支 `session/17d152b0-ds猫`
  - flash猫：`D:\Game\ai\catStudy-sessions\17d152b0-flash猫`，分支 `session/17d152b0-flash猫`
- **worktree 内 push 必失败是预期**（门禁拦未审 commit），不是配置缺失；**绝不
  `--no-verify` 绕过**。收口归店长：审查 ✅ 后由店长合并、更新 `.push-gate`、推
  `session/17d152b0`、开 PR、合并回 dev。
- **提交**：`git add <paths>` → `git diff --cached --name-only` 核对 → 裸 `git commit`；
  message 带 `catstudy [<触发消息 id>]`。不要 `git add -A`、不要 `--only`。
- **审查**：先过 `quality-gate` 自查，再按 `request-review` 门槛把审查请求投给 **吐槽猫**
  （写 commit_sha + 改了什么 + 怎么验证）。**禁止自审**。
- 测试：server 用 `:memory:` SQLite + `MEMORY_ENABLED=false`；web 测试可 `?raw` 读 SFC 做
  静态断言。worktree 内若撞 `ERR_PNPM_UNSAFE_TASK_RUN_STATE_PATH`，按既有办法直调
  `node node_modules/vitest/vitest.mjs run --project <name>`。
- **时间口径**：新列 `deleted_at` / `session_groups.created_at` 一律 ISO 毫秒 UTC；
  `sessions.created_at/updated_at` 是秒级，**禁止同框比较**。

---

## T0 · `getSessionById` 全量审计

**What to build:** 一份只读审计报告，回答「软删后每个调用点该看活会话还是含删会话」，
供 T2 切语义时逐条照做。

**Blocked by:** None — 可立即开始。

- [ ] 产出 `workspace/getSessionById-audit.md`（gitignored，**不提交**）。
- [ ] 覆盖 `git grep -n "getSessionById" packages/server/src -- ':!*.test.ts'` 的**全部**调用点：
      **28 个生产调用点 + 1 个定义行 + 1 行注释 = 30 行**（定义行在 `db/repository/sessions.ts`），
      分布在 **8 个调用方文件**；条目数与 grep 输出逐条对齐，并注明「定义行与注释行不计入调用」。
- [ ] 每条给：文件、所在函数、上下文一句、分类（活 / 含删）、理由。
- [ ] 给出「必须改用 `getSessionByIdIncludingDeleted`」的最终清单（预期：回收站列表 / 恢复 /
      清除 / 清扫 / **DELETE 的幂等回读**；其余全走默认）。
- [ ] 指出可合并/可删除的调用点（顺手项，不强制改）。
- [ ] 明确 `routes/sessions.ts` 的 **16** 处逐条归属。

---

## T1 · 分组表、迁移与分组接口

**What to build:** 左栏需要的「组」实体端到端可用：建/改名/折叠/仅解散、会话归组、
旧归档迁移成「归档」组、活跃列表按新索引查询。用户能建组并把会话移进去。

**Blocked by:** None — 可立即开始。

**改哪些文件（边界）:**

- `packages/server/src/db/migrations.ts`（**一条**多语句 `sql` 条目，`ticket: 'T1'`；不要手写
  `run` hook——静态断言禁止）
- `packages/server/src/db/repository/sessionGroups.ts`（新建）+ `repository/index.ts`
- `packages/server/src/db/repository/sessions.ts`（`listActiveSessions` 谓词换
  `deleted_at IS NULL`；`insertSession` 支持 `groupId`；新增 `updateSessionGroup`）
- `packages/server/src/routes/sessionGroups.ts`（新建）+ 路由注册处
- `packages/server/src/routes/sessions.ts`（`PATCH` 收 `groupId`；`GET` 返回 `groupId`）
- `packages/shared/src/types.ts`（`SessionConfig.groupId`、`SessionGroup`）
- `packages/shared/src/schemas.ts`（**`SessionUpdateSchema` 加 `groupId:
z.string().nullable().optional()`**；不加则 Zod 默认剥未知键，`PATCH` 返回 200 但没动）
  - `schemas.test.ts`
- `packages/server/src/handoff/index.ts`（子会话继承父 `group_id`）
- 对应 `*.test.ts`（同目录 co-located）
- **不改**`: 回收站语义（T2）、前端（T3）、归档面清退（T5）。

**验收（行为可验证）:**

- [ ] 迁移后 `session_groups` 存在；`sessions.group_id` / `deleted_at` 存在；
      `idx_sessions_live` / `idx_sessions_trash` / `idx_sessions_group` 存在；
      `idx_sessions_active` 不存在；重放/已迁移库均幂等启动。
- [ ] 含 37 条归档的库：建「归档」组（collapsed=1），37 条 `group_id` 指向它，
      `archived_at` 与 `updated_at` 未被改写。
- [ ] `POST /api/session-groups` 建组；重名 409；名字 trim 后 1–24 字，空/超长 400。
- [ ] `PATCH` 改名/折叠生效且落库；`GET` 返回 `sessionCount`；顺序按 `created_at ASC`。
- [ ] `PATCH /api/sessions/:id { groupId }` 移动成功；不存在/已删组 400；`groupId=null` 回未分组；
      **`updated_at` 不变**。
- [ ] `SessionUpdateSchema` 单测：带 `groupId` 的 body 解析后字段仍在（防 Zod 剥未知键 →
      200 但没动）；`groupId: null` 与缺省可区分。
- [ ] `DELETE /api/session-groups/:id`（仅解散）：组行消失、会话 `group_id=NULL`、
      `deleted_at` 仍 NULL。
- [ ] handoff 子会话自动继承父 `group_id`（父在组内 / 父未分组两例）。
- [ ] `EXPLAIN QUERY PLAN` 活跃列表走 `idx_sessions_live`（组内查询的索引读数挪到 T2 的整组
      删除 `UPDATE ... WHERE group_id=?`，T1 没有对应查询）。
- [ ] 迁移测试覆盖：新库、老库、已迁移库重跑；断言 `archived_at` 冻结。

**收口注意：** T1 把 `listActiveSessions` 谓词换成 `deleted_at IS NULL` 后，旧前端默认列表会
多出 37 条归档会话（T3 尚未上）；T3 的「移入回收站」若早于 T2 接线，会接到旧的物理删除。
因此 **T1→T2→T3→T4 在同一集成分支按序验，整体一次合入 dev；任何一票都不单独发。**

---

## T2 · 回收站：软删 / 恢复 / 清扫 / 守卫

**What to build:** 删除会话进回收站保留 7 天，可恢复、可彻底删除；整组删除走组软删；
忙碌/绑定被拦；到期自动清除；已删会话不再被任何用户面/系统链路当成活会话。

**Blocked by:** T1（表与 `groupId` 契约）、T0（调用点清单）。

**改哪些文件（边界）:**

- `packages/server/src/db/repository/sessions.ts`（`getSessionById` 默认排除已删；
  新增 `getSessionByIdIncludingDeleted`；`trashSession` / `restoreSession` / `listTrash` /
  `purgeSession`；`getHandoffChild` / `getEmptyHandoffChild` 加 `deleted_at IS NULL`；
  `listAllSessionsExcludingDeleted`（或等价谓词））
- `packages/server/src/db/repository/trash.ts`（新建：`purgeExpiredTrash(now = Date.now())`，
  同时扫会话与组两类主体；不直接接触 `index.ts`，不自带调度）
- `packages/server/src/trash-purge.ts`（新建：`runTrashPurge(phase)` —— 调 `purgeExpiredTrash()`，
  发 `SESSION_PURGED` / `GROUPS_CHANGED`，逐成员清引擎槽位）
- `packages/server/src/db/repository/sessionGroups.ts`（`trashGroup` / `restoreGroup` /
  `purgeGroup` / `dissolveGroup` / `listGroups`）
- `packages/server/src/routes/sessions.ts`（DELETE / trash / restore / purge；409 守卫；
  **`GET /api/sessions` 的 `includeArchived` 分支改用排除已删的查询**）
- `packages/server/src/routes/sessionGroups.ts`（`?withSessions=1`、restore、purge）
- `packages/server/src/execution/registry.ts` 的只读使用处（忙碌判据，不改调度）
- `packages/server/src/connectors/socketio.ts`（join 拒绝已删）
- `packages/server/src/handoff/index.ts`（已删父/子边界）
- `packages/server/src/db/repository/connectorBindings.ts` 或调用侧（拒绝绑定已删会话）
- `packages/server/src/index.ts`（启动 + `setInterval` 每小时都只调 `runTrashPurge`；
  probe 模式跳过）
- `packages/shared/src/types.ts` + `events.ts`（`TrashEntry`、四个事件；`SESSION_ARCHIVED`
  **本票不动**，留给 T5）
- 对应 `*.test.ts`

**验收（行为可验证）:**

- [ ] `DELETE /api/sessions/:id`：列表消失、`/api/sessions/trash` 出现，
      `purgeAfter = deletedAt + 7d`，消息条数不变；**重复删除仍 200 且 `deletedAt` 不变**
      （`DELETE` 用 `IncludingDeleted` 读，守卫只在 `deleted_at IS NULL` 时跑）。
- [ ] 忙/排队 → 409 `SESSION_BUSY`，`deleted_at` 仍 NULL；绑定外部群 → 409
      `SESSION_BOUND`，绑定行不变。
- [ ] 恢复：回原组、`updated_at` 不变；原组已删/已清除 → `groupId=null`；过期 → 404。
- [ ] 整组删除：组与同批会话 `deleted_at` 字符串相等；id 不变；任一会话忙 → 409，
      **组与会话一行都没改**；恢复只清同批，早先单删的会话不复活；组内零未删会话时
      `?withSessions=1` 返回 `mode: 'dissolve'`，不产生空组条目。
- [ ] 仅解散：组硬删、会话 `group_id=null`、`deleted_at` 仍 NULL。
- [ ] 组条目成员单条 restore/purge/DELETE → 409 `SESSION_IN_TRASH_GROUP`；组恢复/组清除成功。
- [ ] `/api/sessions/trash` 不返回已过期但尚未清扫的条目（`deleted_at <= cutoff`），
      避免「剩 0 天还能点恢复、点了 404」。
- [ ] 恢复同名：存在同名活组（含仅大小写不同）→ 先改名（`（恢复）`，≤24 字）再清
      `deleted_at`，不撞 `ux_session_groups_name_live`。
- [ ] 到期边界：`now-7d+1min` 保留、`now-7d-1min` 清除；会话/消息/执行日志/依赖行一起消失；
      **组条目到期：组行 + 同批会话消失，早先单删的会话仍在**；probe 模式不执行。
- [ ] `purgeExpiredTrash(now)` 可注入时钟单测（不靠 `sleep`/真实时钟）；零同批组只删组行。
- [ ] 彻底删除活会话 → 409；清空回收站后条目与组行全消失。
- [ ] `getSessionById` 对已删返回 undefined、`IncludingDeleted` 返回；join、handoff 复用、
      绑定写入都拒绝已删会话。
- [ ] `GET /api/sessions?includeArchived=1` 不返回已删行；`listAllSessions` 的
      「系统链路口径」注释同批改掉。
- [ ] `EXPLAIN QUERY PLAN`：整组删除 `UPDATE ... WHERE group_id=? AND deleted_at IS NULL`
      走 `idx_sessions_group`；回收站列表走 `idx_sessions_trash`。
- [ ] 事件：单删/整组删发 `SESSION_TRASHED`；恢复发 `SESSION_RESTORED`；清除/清扫发
      `SESSION_PURGED`；payload 形状按 spec §3.3。

---

## T3 · 左栏分组、批量归组、删组确认

**What to build:** 左栏从平铺列表变成「分组 + 未分组」：折叠、移动会话、批量勾选归组、
删组确认框（默认仅解散）、新建分组固定在底部。悬停「移动到分组」出侧框，指针离开即收起。

**Blocked by:** T1（组接口）+ T2（回收站接口）。UI 骨架可先写，但**审查前必须
`git -C <worktree> merge session/17d152b0-ds猫`（T1 所在分支）或 rebase 到它**，T2 落地后再验
「移入回收站 / 批量删除」——**T2 之前禁止把菜单接到现有 `DELETE`**（那还是物理删除）。
凡涉及落库、`sessionCount`、折叠持久化的验收都在集成分支上验，不用 mock 代替。

**改哪些文件（边界）:**

- `packages/web/src/components/SessionList.vue`（主体重写）
- `packages/web/src/stores/chat.ts`（groups state、CRUD、moveSession、批量归组、
  `GROUPS_CHANGED` / `SESSION_TRASHED` 投影——只做本票需要的部分）
- `packages/web/src/composables/useApi.ts`（group / move API）
- 新增组相关子组件（如 `SessionGroupMenu.vue` / `GroupDeleteModal.vue`，按需）
- `packages/web/src/components/SessionList.test.ts` 等 co-located 测试
- **不改**`: 回收站主区（T4）、server（T1/T2）、归档接口（T5）。

**两条实现约束（别等审查才发现）:**

- **侧框必须跳出左栏**：`.panel-left` / `.panel-inner` 是 `overflow: hidden`，在行内展开会被
  裁剪。用 `position: fixed` 或 `Teleport`（`ChatPanel` 有先例），按触发项矩形定位。
- **忙碌/绑定的数据源**：忙碌读 `chat.ts` 的 `agentStates`（`Map<agentId,
Map<sessionId, AgentRuntimeState>>`，判 `status === 'busy' || queueLength > 0`；idle 槽位仍留
  sessionId，不能只看有没有槽位）；绑定调 `api.getConnectorBindings()` 取全量后按
  `binding.sessionId` 过滤（该接口没有 sessionId 参数）。**不要**等 409 回来再置灰。

**验收（行为可验证）:**

- [ ] 左栏渲染活组（created_at 序）+「未分组」最后；组头显示会话数；折叠点击 PATCH 落库，
      重载后状态保持（多 tab 一致）。
- [ ] 每行只有一个 `⋯`：`移动到分组 ›` / `移入回收站`；无归档按钮、无「显示已归档」开关。
- [ ] 悬停「移动到分组」→ 侧框出现、主菜单不关；指针移到别处/空白 → 侧框收起、主菜单仍在；
      指针进入侧框 → 保持；点击触发项也能打开；选目标后两级同关。
- [ ] 侧框**真机几何**不被裁剪：侧框右边界超出 236px 左栏仍完整可见（不是只断言 state）。
- [ ] 当前所在组不在目标列表；未分组会话不出现多余的「未分组」。
- [ ] 行首悬停出复选框；勾选后头行变「已选 N ｜ 归组 ｜ 删除 ｜ 取消」；批量归组一次成功，
      完成后清空选择。
- [ ] 批量删除 = N 次单条 `DELETE`；某条 409（忙碌/绑定）时其余照删，失败项保留在列表并
      toast 点名（不整批回滚，不静默吞）。
- [ ] 组头 `⋯`：重命名 / 删除分组…；重名就地报错，输入框不关。
- [ ] 删组确认：默认「仅解散」；第二项文案带会话数、选中后主按钮变红；忙碌/绑定成员让
      第二项置灰并红字点名（数据源见上，不靠 409 后置灰）；空组只有「仅解散」；切换选项不
      重建弹窗 DOM、不重播动画。
- [ ] 新建分组固定在侧栏底部：列表滚动不带走、建组/删组位置不跳。
- [ ] 删组/移会话都不改 `updatedAt` 排序（前端投影不触碰）。
- [ ] 测试：至少覆盖「侧框离开即收」「批量归组」「默认仅解散」「忙碌组第二项不可选」；

---

## T4 · 回收站主区、撤销与实时同步

**What to build:** 「回收站」是一个主区视图：两段（整组删除 / 单个会话）、每行恢复/永久删除、
清空回收站；单删 5 秒撤销；多 tab 通过 socket 同步。

**Blocked by:** T2（回收站接口）+ T3（复用左栏头行入口与项目结构）。

**改哪些文件（边界）:**

- `packages/web/src/components/TrashView.vue`（新建）
- `packages/web/src/App.vue`（**中心区切换宿主**：`showTrash` 与既有 `showSettings` /
  `showEval` / `showTrace` 同构，互斥；点 🗑 进回收站、点会话回聊天）+ `App.test.ts`
- `packages/web/src/components/SessionList.vue`（头行 🗑 N 入口）
- `packages/web/src/components/SessionCreateModal.vue`（创建成功 `emit('created')`；回收站
  视图下由 `SessionList` 关弹窗并投递 `open-session`，中心区切回聊天）
- `packages/web/src/components/ChatPanel.vue`（**只做**当前会话被删→切走/空态；**不**承载
  回收站视图，也不做中心区条件渲染。撤销 toast 的宿主在 `App.vue` 根级——回收站/三个
  全屏页打开时 `ChatPanel` 被 `v-show` 隐藏，toast 挂在其内会一起被藏住）
- `packages/web/src/stores/chat.ts`（trash state、restore/purge/empty、`SESSION_TRASHED/
SESSION_RESTORED/SESSION_PURGED` 处理、5 秒撤销）
- `packages/web/src/composables/useApi.ts`（trash API）
- 对应 `*.test.ts`
- **不改**`: server（T2）、归档面（T5）。

**验收（行为可验证）:**

- [ ] 头行显示 `🗑 N`（空时只显示图标）；点击切到回收站主区，再点会话回到聊天；
      切换由 `App.vue` 的中心区状态驱动（`ChatPanel` 里不出现第二套视图）。
- [ ] 两段列表：「整组删除」每条显示组名、会话数、消息数、删除时间、剩余天数；
      「单个会话」显示标题、原组名、消息数、剩余天数；同批会话不出现在第二段。
- [ ] 「整组删除」段的成员不出现「恢复 / 永久删除」单条按钮（组级动作 409）；两段的
      恢复/清除分别打对应接口。
- [ ] 「单个会话」段每行悬停出「恢复 / 永久删除」；永久删除二次确认；清空回收站二次确认。
- [ ] 单删：行消失 + 5 秒 toast「已移入回收站 · 剩 7 天 / 撤销」；点撤销恢复；
      toast 5 秒自动消失；删当前会话自动切到下一个。
- [ ] 整组恢复后组回到列表、同批会话回组；早先单删的会话仍留在回收站。
- [ ] 多 tab：删除/恢复/整组删/清空实时反映；当前打开的会话被删 → 切走。
- [ ] 过期/已清除的恢复返回 404 时，前端刷新回收站并提示。
- [ ] 测试：至少覆盖「撤销」「两段分组不串」「切走」「事件投影」。

**收口登记（P3，不阻断，T5 顺手处理）:**

- `App.vue` 首字节 BOM：Vite/tsc 会剥掉、测试全绿；不为此改写已受审且真机探针通过的
  `a0cf02f2` 树，T5 与其他 web 收尾同批删。
- `ChatPanel` 保活/滚动恢复无仓库内回归测试：`App.test.ts` 只钉静态源（`v-show` /
  `:hidden`），探针未测 scroll。T5 补组件级用例，或探针步骤「滚到中间 → 进回收站 →
  返回 → `scrollTop` 恢复」。
- 同一处边缘：隐藏期间 `activeSessionId` 若变化（另一 tab 删掉当前会话），切回可能把旧
  会话的 `scrollTop` 恢复到新会话；只在隐藏前用户向上滚过时触发，与上条同批修。
- `trashLoadError` 仅在列表为空时提示；已有条目时刷新失败保留旧列表（已接受）。
- `trash-purge.ts` 反依赖 `routes/sessionGroups.ts` 的 `emitGroupsChanged`；启动接线
  （`runTrashPurge('startup')` / `setInterval` / `clearInterval`）无测试。同属 T5
  「helper 迁出路由层 + 静态源断言」。

---

## T5 · 归档面清退（契约收尾）

**What to build:** 把归档的最后一层用户面与代码面拆掉，确保「两条轴」没有第二套入口。

**Blocked by:** T1（服务端已改）、T2（`includeArchived` 分支已改）、T3（前端不再用归档）。

**改哪些文件（边界）:**

- `packages/server/src/routes/sessions.ts`（删 `POST /archive|unarchive`、
  `includeArchived` 参数）
- `packages/server/src/db/repository/sessions.ts`（删 `archiveSession` / `unarchiveSession`；
  清掉读 `archived_at` 的注释与分支；**列保留**）
- `packages/shared/src/types.ts`（删 `SessionConfig.archivedAt`）、`events.ts`
  （删 `SESSION_ARCHIVED`）、`events.test.ts`
- `packages/web/src/components/SessionList.vue` 残留、`stores/chat.ts`（`applyArchived` /
  `showArchived` 全删）、`useApi.ts`（archive 调用）
- `packages/web/src/App.vue`（仅删首字节 BOM）、`packages/web/src/components/ChatPanel.vue`
  （补滚动恢复回归；`activeSessionId` 在隐藏期间变化时贴底）
- `packages/server/src/trash-purge.ts` / `routes/sessionGroups.ts`：把 `emitGroupsChanged`
  迁到 `connectors/` 或独立 `broadcast.ts`，两处共用；补启动接线静态源断言
- 旧归档测试用例（删或改成「已退役」断言）
- **不改**`: 表结构（列保留）、迁移条目（历史 checksum 不能动）。

**验收（行为可验证）:**

- [ ] 全仓 `git grep archivedAt` 在 `packages/**` 非测试面零命中；`git grep archiveSession`
      零命中；`SESSION_ARCHIVED` 零命中。
- [ ] snake_case 面另扫：`archived_at` 只在迁移 / 测试 / `PRAGMA` 断言命中，运行时代码零命中
      （`archivedAt` 驼峰 grep 抓不到 migrations 与 repo 里的下划线写法）。
- [ ] 复述面同批扫：`listActiveSessions` / `listAllSessions` 的 docstring、`migrations.ts` 里
      `idx_sessions_active` 的历史注释、`routes/sessions.ts` 的归档段注释。
- [ ] `pnpm lint` 三包绿；server + web 全量测试绿。
- [ ] dev 库迁移后的 37 条归档会话仍在「归档」组、可正常打开、删除；无任何归档入口。
- [ ] `archived_at` 列仍在（`PRAGMA table_info`），迁移 checksum 未变。
- [ ] 收口登记清账：`App.vue` 首字节无 BOM；`ChatPanel` 滚动恢复回归（含隐藏期间
      `activeSessionId` 变更边缘）绿；启动接线三处有静态源断言；`trash-purge.ts` 不再
      import `routes/**`。
