# 会话管理 v2：分组管收纳 + 回收站管删除

> **状态**：定稿（2026-11-15 用户确认「按这版开票」）。
> **取代**：`docs/plans/db-schema-governance.md` §4.1 的「用户态删除 = 归档」与票 7 的
> 归档语义。**架构依据**：`docs/adr/0016-session-groups-and-trash.md`。
> **本文件不是进度表**；实施顺序与验收状态看 `docs/run/session-groups-trash/tickets.md`。

## 一、用户故事

1. 作为用户，我要把一串会话按项目收进同一个分组，折叠起来不占地方，以便会话列表只留当前在做的。
2. 作为用户，我要删掉的会话先进回收站、7 天内能恢复，以便误点不至于永久丢消息。
3. 作为用户，我要整组删除时先看到「仅解散 / 连同会话一起删」两个选项，以便不会把「重组分组」误做成「删会话」。
4. 作为用户，我要「合并一系列会话」= 把它们归到同一组（尤其 handoff 的 `（1）` 链），而不是把消息拼成一条时间线。

## 二、数据模型

### 2.1 表结构（一条多语句迁移，runner 单事务包住）

```sql
CREATE TABLE session_groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  collapsed  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,              -- ISO 毫秒 UTC
  updated_at TEXT NOT NULL,              -- ISO 毫秒 UTC
  deleted_at TEXT                        -- ISO 毫秒 UTC；NULL = 活组
);
CREATE UNIQUE INDEX ux_session_groups_name_live
  ON session_groups(name COLLATE NOCASE) WHERE deleted_at IS NULL;

ALTER TABLE sessions ADD COLUMN group_id TEXT
  REFERENCES session_groups(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN deleted_at TEXT;   -- ISO 毫秒 UTC；NULL = 未删除

CREATE INDEX idx_sessions_group ON sessions(group_id);
CREATE INDEX idx_sessions_live  ON sessions(updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_sessions_trash ON sessions(deleted_at) WHERE deleted_at IS NOT NULL;
DROP INDEX IF EXISTS idx_sessions_active;
```

- 新列一律 **ISO 毫秒 UTC**；`sessions.created_at/updated_at` 仍是秒级 `datetime('now')`。
  **禁止同框比较**：ISO 首位是 `T`，恒大于秒级串的空格，`WHERE deleted_at < datetime('now')`
  会整片判反。截止串由 JS 算好再传。
- `sessions.group_id` 用 `ON DELETE SET NULL`：组被硬删（仅解散）时会话自动落未分组。
- `session_groups` 行数在几十量级，排序字段不另建索引。
- 组名唯一索引带 `COLLATE NOCASE`（只折叠 ASCII 大小写，中文名不受影响）：`Work` 与 `work`
  算重名；判定面与索引谓词必须同形。
- `archived_at` 列**保留但冻结**：**运行时代码**不读、不写、不 DROP（迁移、`PRAGMA` 与测试
  断言除外）；`idx_sessions_active` 退役。

### 2.2 迁移：旧归档 → 普通组「归档」

同一迁移条目内，在建表/加列之后执行：

1. 若存在 `archived_at IS NOT NULL` 的会话 → 建组 `id='legacy-archive'`、`name='归档'`、
   `collapsed=1`、时间为 ISO 毫秒。
2. 把这些会话的 `group_id` 指向该组。
3. 不清空 `archived_at`（冻结），不改 `updated_at`。

> `session_groups` 与本迁移在同一个条目里新建，迁移前不可能有同名活组；「已存在同名活组」
> 分支是死代码，不写。

dev 库预期：60 会话 / 37 归档 → 默认列表 23 条 + 折叠的「归档 37」，一条不少。

### 2.3 清扫

- `purgeAfter = deleted_at + 7×24h`，**服务端算**（`new Date(deleted_at).getTime() + 7d`）。
- 清扫主体是**两类**：会话（`sessions.deleted_at <= cutoff`）与组
  （`session_groups.deleted_at <= cutoff`）。契约是一个可注入时钟的导出函数
  `purgeExpiredTrash(now = Date.now())`（放 `db/repository/trash.ts`）；调度收在
  `trash-purge.ts` 的 `runTrashPurge(phase)`（广播与引擎槽位清理也在那里），`index.ts` 只负责
  启动扫一次 + 每小时调 `runTrashPurge`，不自带 SQL——否则「±1 分钟」这类边界没有测试缝。
- cutoff 由 JS 生成 ISO 毫秒串后传入，**不**与秒级列（`created_at/updated_at`）同框比较。
- **归属不重叠**：整组删除产生的同批会话（`group_id` 指向一个 `deleted_at` 与之字符串相等的组）
  归**组条目**清；其余已删会话归**会话条目**清。同一行不会被两条路径各清一次。
- 组条目：先逐条清同批会话（`deleted_at = 组.deleted_at`，精确相等；组内更早单删的会话
  不碰，它属于会话条目），同批全部清完后**最后一个事务**删组行；同批为 0（防御分支）
  直接删组行。组行删除失败则该组条目下轮重试，已清的会话不会复活。
- 会话条目：**每条会话一个事务**，单条失败记日志继续。
- 物理清除顺序复用现有链：执行日志 → 消息（自带消息侧子行）→ 会话依赖
  （`purgeSessionDependents`）→ 会话行。
- probe 模式（`CATSTUDY_PROBE_MODE=1`）跳过；失败只影响该条目，下一轮重试。

## 三、接口契约

### 3.1 共享类型（`packages/shared`）

```ts
interface SessionConfig {
  // 既有字段不变
  groupId: string | null // 新增
  // 新增：最后一条**对话消息**（user/agent；系统通告不计入）的 created_at，
  // ISO 8601 毫秒 UTC（与 messages.created_at 同形）；只有系统通告的会话 = null。
  // 决策留痕：2026-11-15 真机反馈——系统通告不计入（原「不区分角色」作废）。
  // 只有 GET /api/sessions 填充，其他端点不保证带。
  lastMessageAt?: string | null
  archivedAt?: string | null // 冻结保留到「归档面清退」票，前端不再消费
}

interface SessionGroup {
  id: string
  name: string
  collapsed: boolean
  createdAt: string
  updatedAt: string
  sessionCount: number // 组内未删除会话数
}

interface TrashEntry {
  kind: 'group' | 'session'
  id: string // 组条目 = group.id；会话条目 = session.id
  name: string // 组名 / 会话标题
  deletedAt: string // ISO 毫秒
  purgeAfter: string // ISO 毫秒，= deletedAt + 7d
  daysLeft: number // ceil((purgeAfter - now) / 1d)，1..7（过期的条目列表已滤掉）
  sessionCount: number // 组条目 = 同批会话数；会话条目 = 1
  messageCount: number
  groupId: string | null // 会话条目：原组 id（组已删也保留）；组条目 = null
  groupName: string | null // 会话条目：原组名；组条目 = null
}
```

### 3.2 路由

| 方法 / 路径                                     | 语义                                                                                   | 成功                                                | 失败                                                                                    |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `GET /api/sessions`                             | 未删除会话，按 `updated_at DESC`，带 `groupId` / `lastMessageAt`（ISO 毫秒，仅本端点） | `SessionConfig[]`                                   | —                                                                                       |
| `PATCH /api/sessions/:id`                       | 既有字段 + `groupId: string \| null`                                                   | `SessionConfig`                                     | 404 会话不存在/已删；400 组不存在或已删                                                 |
| `DELETE /api/sessions/:id`                      | 移入回收站（幂等）                                                                     | `{ id, deletedAt, purgeAfter }`                     | 404 从未存在/已清除；409 busy/bound                                                     |
| `GET /api/sessions/trash`                       | 未过期条目（`deleted_at > cutoff`），`deletedAt DESC`                                  | `{ entries: TrashEntry[] }`                         | —                                                                                       |
| `POST /api/sessions/:id/restore`                | 恢复单条                                                                               | `{ session, groupId }`（原组已删则 `groupId=null`） | 404（不在回收站/已清除）；409 属于整组删除                                              |
| `DELETE /api/sessions/:id/purge`                | 彻底删除单条                                                                           | `{ id }`                                            | 404；409 未删除 / 属于整组删除                                                          |
| `GET /api/session-groups`                       | 活组，按 `created_at ASC`                                                              | `{ groups: SessionGroup[] }`                        | —                                                                                       |
| `POST /api/session-groups`                      | 新建 `{ name }`                                                                        | 201 `SessionGroup`                                  | 400 名字非法；409 重名                                                                  |
| `PATCH /api/session-groups/:id`                 | `{ name?, collapsed? }`                                                                | `SessionGroup`                                      | 404；409 重名                                                                           |
| `DELETE /api/session-groups/:id`                | 不带 `withSessions` = 仅解散（不动会话，**无 busy/bound 守卫**）                       | `{ mode: 'dissolve', id }`                          | 404                                                                                     |
| `DELETE /api/session-groups/:id?withSessions=1` | 组软删 + 同批会话进回收站（零未删会话降级为仅解散）                                    | `{ mode: 'trash' \| 'dissolve', id }`               | 404；409 busy/bound（**一行不改**）                                                     |
| `POST /api/session-groups/:id/restore`          | 恢复整组（只清同批）                                                                   | `{ group, sessions }`                               | 404（组不在回收站/已清除）                                                              |
| `DELETE /api/session-groups/:id/purge`          | 彻底删除已删组 + 同批会话                                                              | `{ id }`                                            | 404；409 组未删除；500 `GROUP_PURGE_INCOMPLETE`（组行未清成；同批会话已先清，下轮重试） |
| `DELETE /api/trash`                             | 清空回收站                                                                             | `{ purged: { groups: number, sessions: number } }`  | —                                                                                       |

- **路由顺序**：`GET /api/sessions/trash` 必须注册在 `GET /api/sessions/:id` 之前（静态路由
  优先，但显式顺序是契约的一部分，避免以后换路由库时被 `:id='trash'` 吞掉）。
- **404 面**：已删会话的详情、消息、搜索、标记已读、回退、绑定一律 404（或等价「不存在」），
  例外只有 `/restore`、`/purge`、`/trash`，**以及 `DELETE /api/sessions/:id` 的幂等重复调用**。
- **幂等删除的读取口径**：`DELETE` 先按 `getSessionByIdIncludingDeleted` 读——从未存在/已清除 →
  404；已删且不是整组条目成员 → 200 返回**首次** `deletedAt`（不重置 7 天计时）。
  已删且属于某次整组删除（所在组 `deleted_at` 与之相等）→ 409
  `SESSION_IN_TRASH_GROUP`（它已作为组条目在回收站里，单删没有可撤销的动作）。
  忙碌/绑定守卫**只在**
  `deleted_at IS NULL` 时跑，第二次删除不会被自己的忙碌状态挡回 409。
- **整组条目成员**：属于某次整组删除的会话，只能经组级恢复/清除处理；对单条调用
  restore/purge（以及重复 DELETE 一个已删成员）→ 409
  `{ error: 'SESSION_IN_TRASH_GROUP', groupId }`。否则组条目计数与恢复粒度会对不上。
- **零未删会话 + `withSessions=1`**：组内没有未删除会话（含空组）→ 不产生回收站条目，
  按「仅解散」返回 `{ mode: 'dissolve', id }`；只有至少一条未删会话才进 `mode: 'trash'`。
  由此组条目**恒有 ≥1 条同批会话**（T4 的 `sessionCount` 不会显示 0）。
- 组名规则：`trim()` 后 1–24 字，空/超长 400；活组重名 409 `{ error: 'GROUP_NAME_TAKEN' }`，
  重名判定与唯一索引同用 `COLLATE NOCASE`。
- **恢复重名顺序**：先改组名、再清 `deleted_at`（同一事务）；顺序反了会在清标志那步撞
  部分唯一索引。追加的 `（恢复）`/`（恢复 N）` 计入 24 字上限，超长截断组原名（不截后缀）。
- 忙碌/绑定 409 形状：
  `{ error: 'SESSION_BUSY' | 'SESSION_BOUND', sessions: [{ id, title, reason: 'busy' | 'bound', platform?, externalId? }] }`。
  整组删除时 `sessions` 只列阻塞成员。

### 3.3 事件

| 事件               | payload                                                  | 广播 | 触发                                                                    |
| ------------------ | -------------------------------------------------------- | ---- | ----------------------------------------------------------------------- |
| `SESSION_TRASHED`  | `{ sessionIds: string[], groupIds: string[] }`           | 全局 | 单删 / 整组删                                                           |
| `SESSION_RESTORED` | `{ groupId: string \| null, sessions: SessionConfig[] }` | 全局 | 单条恢复 / 整组恢复                                                     |
| `SESSION_PURGED`   | `{ sessionIds: string[], groupIds: string[] }`           | 全局 | 到期清扫 / 彻底删除 / 清空回收站                                        |
| `GROUPS_CHANGED`   | `{}`                                                     | 全局 | 任何组结构/归属变化：建组、改名、折叠、移动会话、仅解散、整组删、组恢复 |

- `SESSION_ARCHIVED` 退役（在「归档面清退」票删除常量与前端 `applyArchived`）。
- `SESSION_DELETED` 保留给「handoff 空壳清理」等物理删除路径。
- 全局广播（不是会话房间）：列表可见性与组结构影响所有正在看列表的 tab。

## 四、行为规则

### 4.1 删除守卫

- 忙碌判据：执行注册表 `snapshot()` 中，该会话存在 `status === 'busy' || queueLength > 0`
  的 agent。**不能**写成「槽位里留着 sessionId 就算忙」——idle 槽位仍留 sessionId，会永远 409。
- 绑定判据：`listBindingsBySession(id)` 非空。绑定接口本身也要拒绝已删会话。
- 单删幂等：`UPDATE ... SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`；已删则回读
  `getSessionByIdIncludingDeleted` 拿首次时间戳（见 §3.2「幂等删除的读取口径」）。
- 整组删除在同一事务内：组 `deleted_at` + `UPDATE sessions SET deleted_at=?
WHERE group_id=? AND deleted_at IS NULL`，**同一 ISO 毫秒串**；组内零未删会话时整组删除
  降级为仅解散（§3.2），不建回收站条目。
- `session_groups.updated_at`：改名 / 折叠 / 恢复 / 整组删除都更新它；**移动会话不改组**的
  `updated_at`（组内容变了但组本身没变），只更新会话的 `group_id`，且不改会话 `updated_at`。

### 4.2 恢复与清除

- 整组恢复：只清 `sessions.deleted_at = group.deleted_at` 的那批；组 `deleted_at=NULL`；
  若存在同名活组（`COLLATE NOCASE`），**先把组名改成 `name（恢复）`（仍冲突则 `（恢复 2）`…），
  再清 `deleted_at`**——两步同一事务，顺序反了会撞部分唯一索引。
- 单条恢复：原组是活组 → 回原组；原组已删/已清除 → `groupId=null` 并提示。属于整组删除的
  成员不走单条接口（409 `SESSION_IN_TRASH_GROUP`），只能整组恢复。
- 恢复**不改** `updated_at`（不凭空跳到列表顶部）。
- 已过期但清扫尚未跑到：`/trash` 列表按 `deleted_at > cutoff` 过滤（用户看不到「剩 0 天却
  还能点恢复」的条目）；恢复接口按 `deleted_at` 判断，过期视为不存在（404）。
- 彻底删除只接受 `deleted_at IS NOT NULL` 的行；活会话 409；整组删除的成员走组级清除。
- 清空回收站 = 对全部条目执行彻底删除（组条目连同同批会话；含过期未扫条目）。

### 4.3 系统链路过滤（必须同批）

- `getSessionById(id)` 默认加 `deleted_at IS NULL`；
  `getSessionByIdIncludingDeleted(id)` 只给回收站 / 恢复 / 清除 / 清扫 / **单删幂等回读**。
- `getHandoffChild`、`getEmptyHandoffChild` 排除已删子会话（否则回收站里的交接子会话
  会被重新拿来用）。
- `connectors/socketio.ts` 的 join 分支拒绝已删会话。
- 绑定写入（`upsertConnectorBinding` 的调用侧）拒绝已删会话。
- `listAllSessions()` 目前**唯一**生产调用点是 `GET /api/sessions?includeArchived=1`
  （`routes/sessions.ts`），**不是**评估/审计内部路径。T2 起该分支必须排除已删行
  （新增 `listAllSessionsExcludingDeleted()` 或等价谓词），否则回收站会话会从用户面列表
  漏出。`listAllSessions()` 本身留到 T5 与 `includeArchived` 参数一起清。
  `routes/sessions.ts` 共 16 处 `getSessionById` 调用，全量清单以 T0 审计为准。

### 4.4 前端定稿

```
┌ 会话 ────────────── ▣ 2 ── ＋ ┐
│ ▾ 小说连载                  2   │
│    猫咖夜话                  ⋯  │
│    第三章卡住了              ⋯  │
│ ▸ 归档（迁移）             37   │
│ 未分组                      2   │
│    深夜调试                  ⋯  │
├──────────────────────────────────┤
│ ＋ 新建分组                      │
└──────────────────────────────────┘
```

- 头行只有 `会话` + 回收站按钮 + `＋`。回收站入口用 **15px 线稿 SVG 垃圾桶**（`currentColor`、
  1.3–1.6 stroke），**禁用 emoji**；按钮与 `＋` 同边框/悬停，高度恒 24px。几何分两态
  （`box-sizing: border-box`；15px 图标 + 1px 边框，空态内容宽 22px）：
  - **空态**：`width: 24px; padding: 0` → 实打实 **24×24**，只有一个居中图标。
  - **有计数**：`height: 24px; min-width: 24px; width: auto; padding: 0 4px`，宽度随内容增长
    （三位数约 48px，头行放得下，不挤 `＋`）。
    条目数**内联在图标右侧**（同一按钮内，`inline-flex` + `gap: 4px`），不用绝对定位角标。
    条目数 = 回收站**条目数**（组条目算 1），不是会话数；`aria-label` 非空时「回收站，N 项」，
    空时「回收站」。
- 会话行第二行：`N 只猫咪` 在左，**最后消息时间**在右（本地时区：今天 `HH:mm`、昨天
  `昨天`、同年 `M月D日`、跨年 `YYYY/M/D`；`title` 给完整 `YYYY-MM-DD HH:mm`）；无消息
  不显示。数据源 `SessionConfig.lastMessageAt` = 该会话最后一条**对话消息**（user/agent）
  的 `created_at`；系统通告（广播、重启告警）不代表会话活动，**不计入**，只有系统通告的
  会话因此不显示时间。**决策留痕：2026-11-15 真机反馈——系统通告不计入（原「不区分角色」
  作废）**，历史通告把 48 个会话的时间钉在同一秒。跨年用紧凑 `YYYY/M/D` 是有意的
  （行宽所限，与日期分隔的 `YYYY年M月D日` 不同）。**行内时间不是排序键**：列表仍按
  `updated_at DESC`，两者不一致是已知取舍；排序切换另票（T7），不在 T6 内改。
- **日期分隔不吸顶**：日期分隔保留在消息流中，但不得 `position: sticky`。原因：同一滚动
  容器内多个日期头都 sticky 会在顶部叠成一摞（后面的盖住前面的，只露出半行文字），且
  滚到旧消息时顶部仍显示最新日期，语义错误。将来若要做吸顶，必须按日期分段包裹、每段
  独立 sticky 容器；不在本单做。
- **新建分组固定在侧栏底部**（不跟列表滚动、建组/删组不跳位）。
- 每行只留一个 `⋯`：`移动到分组 ›` / `移入回收站`。
- **「移动到分组」悬停出侧框**：指针在主菜单该行或侧框内时侧框保持；指针离开两者
  即收起侧框（约 160ms 宽限，跨 6px 间隙不闪），主菜单不跟着关。点击触发项也能打开
  （触屏兜底）。
- 悬停行首出复选框；勾选后头行临时变 `已选 N ｜ 归组 ｜ 删除 ｜ 取消`。
- 组头 `⋯`：`重命名分组` / `删除分组…`；组头点击折叠，折叠态 PATCH 到服务端。
- 删组确认框两个选项：默认「仅解散」；第二项「连同 N 个会话一起移入回收站」，选中后
  主按钮变红；忙碌/绑定成员让第二项置灰并红字点名；空组只给「仅解散」。
- 回收站主区两段：「整组删除」「单个会话」；每行悬停出 `恢复 / 永久删除`；
  顶部 `清空回收站`（二次确认）；单删 5 秒撤销 toast，不弹确认。
- 删当前会话 → 切到下一个可见会话；没有则空态。

## 五、验收标准（行为可验证）

1. **迁移**：在含 37 条归档的 dev 副本上启动 → 默认列表 23 条 + 折叠「归档 37」；
   37 条 `group_id` 全指向该组，`archived_at` 仍非空，且运行时代码不读写它（迁移/测试除外）。
2. **建组/改折叠**：新建「测试组」→ 列表出现；`PATCH collapsed=true` → 重载页面仍折叠；
   重名 → 409，输入框不关。
3. **移动会话**：`PATCH groupId` → 行落入目标组；`groupId=null` → 回未分组；
   `updated_at` 不变。
4. **handoff 继承**：从组内会话交接 → 子会话 `group_id` = 父组；父会话已删 → 子会话未分组。
5. **单删**：`DELETE` 后默认列表无它、`/trash` 有它、`purgeAfter = deletedAt + 7d`、
   消息条数不变；连点两次第二次仍 200 且 `deletedAt` 不变（不是 404）。
6. **忙碌 409**：有猫 busy/排队时删除 → 409，`deleted_at` 仍 NULL。
7. **绑定 409**：绑定 QQ 群的会话删除 → 409，绑定行与 `deleted_at` 都不变。
8. **恢复**：回到原组、消息完整、`updatedAt` 不变；原组已删 → `groupId=null`；
   过期/已清除 → 404。
9. **整组删除**：组内会话全部进回收站且 `deleted_at` 两两相等；组行 `deleted_at` 同值；
   任一会话忙碌 → 409 且**一行都没改**；恢复后组 id 不变，组内更早单删的会话**不复活**；
   `/trash` 里只出现一条组条目，同批成员不在「单个会话」段重复出现。
10. **仅解散**：组行消失、会话 `group_id=NULL`、`deleted_at` 仍 NULL。
11. **到期边界**：`now-7d+1min` 不删；`now-7d-1min` 被清，且会话、消息、执行日志、
    四类依赖行一起消失；probe 模式不执行清扫。
12. **彻底删除/清空**：活会话 purge → 409；清空后 `/trash` 为空，组与会话行均消失。
13. **读取口径**：`getSessionById` 对已删行返回 undefined；`...IncludingDeleted` 返回；
    join 已删会话、handoff 复用已删子会话、给已删会话写绑定均被拒。
14. **前端**：悬停「移动到分组」出侧框；指针移到别处或空白处 → 侧框收起、主菜单还在；
    指针进入侧框 → 保持；批量勾选归组一次成功；删组确认默认仅解散。
15. **多 tab**：删除/恢复/整组删/清空在另一 tab 实时反映；`GROUPS_CHANGED` 后组列表刷新
    （移动会话、仅解散也发）。
16. **索引**：`EXPLAIN QUERY PLAN` 中活跃列表走 `idx_sessions_live`，回收站走
    `idx_sessions_trash`；无 `idx_sessions_active` 残留。
17. **组内索引**：整组删除的 `UPDATE sessions SET deleted_at=? WHERE group_id=? AND
deleted_at IS NULL` 的 `EXPLAIN QUERY PLAN` 走 `idx_sessions_group`（T2 验，不在 T1 验）。
18. **`includeArchived` 不漏删**：`GET /api/sessions?includeArchived=1` 不返回 `deleted_at`
    非空的行（T2 起，T5 删参数）。
19. **组条目到期**：整组删除后调 `purgeExpiredTrash(now = 组.deleted_at + 7d + 1min)` →
    组行与同批会话行消失；组内更早单删的会话仍在（属会话条目）；零同批防御分支只删组行。
20. **组条目成员只走组级**：对组条目成员单条 restore/purge/DELETE → 409 `SESSION_IN_TRASH_GROUP`，
    组条目仍完整；经组恢复/组清除则成功。
21. **恢复重名顺序**：存在同名活组时，组恢复成功、名变为 `name（恢复）`（≤24 字），
    不抛唯一索引冲突（`COLLATE NOCASE` 下 `Name`/`name` 也算同名）。
22. **最后消息时间**：`GET /api/sessions` 每项带 `lastMessageAt`（该会话最后一条**对话
    消息**（user/agent；系统通告不计入）的 `created_at`；值已是 ISO 毫秒 UTC 串，**含且仅含
    一个 `Z`，不得再拼接 `Z`**；无对话消息
    `null`）；**当前会话**新消息落库后行内时间即时更新，其余会话在刷新/**切回**/
    `GROUPS_CHANGED` 重拉后一致——「切回」的落点是 `joinSession` 切到另一个会话时重拉列表
    （首屏自动 join 与同会话重入不重拉；`NEW_MESSAGE` 是房间广播，非当前会话收不到，
    不要求跨 tab 即时）；`SESSION_UPDATE`（改名/改成员）不得把时间抹掉，恢复/撤销后时间
    回来，清空/回退后与剩余消息一致。会话行显示本地时区的 `HH:mm` / `昨天` / `M月D日` /
    `YYYY/M/D`，无消息不显示；行内时间按渲染时刻计算、**不订阅时钟**，跨零点不自动刷新，
    下一次列表刷新/数据变化时校正（已知取舍，不做全局 tick）。断线重连只重发 `JOIN_SESSION`、
    不回填列表，当前会话行时间随下次切回/刷新校正；撤回最新消息（`MESSAGE_RETRACTED`）也
    不在六条路径内，行内时间停在被删条，随下次刷新/切回校正——两者均为已知边界，不在本单补。
23. **顶部不重叠**：滚到任意位置，聊天区顶部不存在两个日期分隔停在同一位置或互相遮挡，
    也不存在被另一个分隔遮掉一半的文字（视口自然裁切不算）；两天消息同屏时两个分隔
    同时可见是正常的。日期分隔不吸顶（随消息流移出视口），且不再用 `z-index: 5` 遮内容。
24. **回收站入口**：头行按钮内是 15px 线稿垃圾桶 SVG（`currentColor`），不是 emoji；
    按钮高度恒 24px、与 `＋` 同边框/悬停；**空态 `width: 24px; padding: 0`**（实测
    24×24，不是 25×24），有计数时 `min-width: 24px; width: auto; padding: 0 4px`（宽度
    随内容增长）；有内容时条目数内联在图标右侧、与图标/`＋` 不重叠；空时仅图标；点击仍
    打开回收站；条目数 = 回收站条目数（组条目算 1）；`aria-label` 非空时「回收站，N 项」、
    空时「回收站」。

## 六、不在范围内

- 不做多标签 / 一个会话进多个组；不做嵌套分组。
- 不把多条会话的消息物理合并成一条时间线。
- 不做拖拽入组 / 拖拽排序（v1 用菜单；排序按 `created_at`）；拖拽只作为原型增强。
- 不做回收站搜索、分页、按日期再分层；7 天量级按删除动作分两段够用。
- 不做「删除后还能继续对话」——删除即冻结，恢复后才能继续。
- 不做「确认后自动停止在途执行」——只返回 409。
- 不改评估/记忆检索口径；`saveMemory` 零实现消费，记忆只读 `docs/` 白名单 MD。
- 回收站主区空态图标（`TrashView.vue` 的 `🗑️`）不在本票范围；「禁用 emoji」只约束左栏入口。
- 不把列表排序从 `updated_at DESC` 切到 `lastMessageAt`（T7 另票，先定口径与索引）。

## 七、决策留痕

- **跳 grilling**：用户在四轮原型（ds猫 / flash猫 / 吐槽猫 / 店长合成）后直接拍板
  「按这版开票」，需求已由原型与五条实测事实压过，不再单跑 grill。
- **Gate B 契约**：边界 = 本文 §六；契约 = §二 表结构 + §三 接口/事件 + §四 行为规则；
  验收 = §五 21 条。
- **推翻的历史口径**：`db-schema-governance.md` §4.1「删除 = 归档」在本文件生效日反转；
  该 spec 已同步加指针，不再作为现行口径引用。
- **店长自我推翻两处**：确认框不提供停止按钮（v1 只 409）；回收站退出记忆检索是伪任务，
  已从验收删除。
- **条目粒度不变量**：回收站条目 = 删除动作粒度，实现不得按 `group_id` 聚合；否则组内
  早先单删的会话会被并入组记录并在恢复时复活。

## Gate Report

### Gate A · 需求照准

✅ 四条用户故事均有可观察验收：§五 1/2–4/5–8/9–14 分别覆盖收纳、交接、删除恢复、整组确认；
无「更好用 / 尽量快」类不可测措辞。

### Gate B · 契约锁定

✅ 边界见 §六（含明确不做项）；契约见 §二/§三/§四（DDL、接口表、409 形状、事件 payload、
前端交互）；验收见 §五（21 条均可执行）。

### Gate C · 反向证明

✅ 21 条全过可反证四条故事：故事 1 ← 验收 1/2/3/16；故事 2 ← 5/6/7/8/11/12/13/15/18/19/21；
故事 3 ← 9/10/14/15/20；故事 4 ← 3/4/14。17 是索引支撑项（性能回归），不单独反证故事；
无未被验收覆盖的故事。

### Gate Result

✅ PASS → 可拆票 / 进入实施（票单见 `docs/run/session-groups-trash/tickets.md`）。
