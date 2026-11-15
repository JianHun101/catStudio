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
  ON session_groups(name) WHERE deleted_at IS NULL;

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
- `archived_at` 列**保留但冻结**：不读、不写、不 DROP；`idx_sessions_active` 退役。

### 2.2 迁移：旧归档 → 普通组「归档」

同一迁移条目内，在建表/加列之后执行：

1. 若存在 `archived_at IS NOT NULL` 的会话，且没有同名活组「归档」→ 建组
   `id='legacy-archive'`、`name='归档'`、`collapsed=1`、时间为 ISO 毫秒。
2. 把这些会话的 `group_id` 指向该组（已存在同名活组则指向它）。
3. 不清空 `archived_at`（冻结），不改 `updated_at`。

dev 库预期：60 会话 / 37 归档 → 默认列表 23 条 + 折叠的「归档 37」，一条不少。

### 2.3 清扫

- `purgeAfter = deleted_at + 7×24h`，**服务端算**（`new Date(deleted_at).getTime() + 7d`）。
- 服务启动扫一次 + 每小时一次；选 `deleted_at <= cutoff`（cutoff 由 JS 生成 ISO 毫秒串）。
- **每条会话一个事务**，单条失败记日志继续；probe 模式（`CATSTUDY_PROBE_MODE=1`）跳过。
- 物理清除顺序复用现有链：执行日志 → 消息（自带消息侧子行）→ 会话依赖
  （`purgeSessionDependents`）→ 会话行；整组到期时最后删组行。

## 三、接口契约

### 3.1 共享类型（`packages/shared`）

```ts
interface SessionConfig {
  // 既有字段不变
  groupId: string | null // 新增
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
  daysLeft: number // ceil((purgeAfter - now) / 1d)，0..7
  sessionCount: number // 组条目 = 同批会话数；会话条目 = 1
  messageCount: number
  groupId: string | null // 会话条目：原组 id（组已删也保留）；组条目 = null
  groupName: string | null // 会话条目：原组名；组条目 = null
}
```

### 3.2 路由

| 方法 / 路径                                     | 语义                                           | 成功                                                | 失败                                    |
| ----------------------------------------------- | ---------------------------------------------- | --------------------------------------------------- | --------------------------------------- |
| `GET /api/sessions`                             | 未删除会话，按 `updated_at DESC`，带 `groupId` | `SessionConfig[]`                                   | —                                       |
| `PATCH /api/sessions/:id`                       | 既有字段 + `groupId: string \| null`           | `SessionConfig`                                     | 404 会话不存在/已删；400 组不存在或已删 |
| `DELETE /api/sessions/:id`                      | 移入回收站（幂等）                             | `{ id, deletedAt, purgeAfter }`                     | 404；409 busy/bound                     |
| `GET /api/sessions/trash`                       | 回收站条目，按 `deletedAt DESC`                | `{ entries: TrashEntry[] }`                         | —                                       |
| `POST /api/sessions/:id/restore`                | 恢复单条                                       | `{ session, groupId }`（原组已删则 `groupId=null`） | 404（不在回收站/已清除）                |
| `DELETE /api/sessions/:id/purge`                | 彻底删除单条                                   | `{ id }`                                            | 404；409 未删除                         |
| `GET /api/session-groups`                       | 活组，按 `created_at ASC`                      | `{ groups: SessionGroup[] }`                        | —                                       |
| `POST /api/session-groups`                      | 新建 `{ name }`                                | 201 `SessionGroup`                                  | 400 名字非法；409 重名                  |
| `PATCH /api/session-groups/:id`                 | `{ name?, collapsed? }`                        | `SessionGroup`                                      | 404；409 重名                           |
| `DELETE /api/session-groups/:id`                | 不带 `withSessions` = 仅解散                   | `{ mode: 'dissolve', id }`                          | 404；409 busy/bound                     |
| `DELETE /api/session-groups/:id?withSessions=1` | 组软删 + 同批会话进回收站                      | `{ mode: 'trash', id }`                             | 404；409 busy/bound（**一行不改**）     |
| `POST /api/session-groups/:id/restore`          | 恢复整组（只清同批）                           | `{ group, sessions }`                               | 404（组不在回收站/已清除）              |
| `DELETE /api/session-groups/:id/purge`          | 彻底删除已删组 + 同批会话                      | `{ id }`                                            | 404；409 组未删除                       |
| `DELETE /api/trash`                             | 清空回收站                                     | `{ purged: { groups: number, sessions: number } }`  | —                                       |

- **路由顺序**：`GET /api/sessions/trash` 必须注册在 `GET /api/sessions/:id` 之前（静态路由
  优先，但显式顺序是契约的一部分，避免以后换路由库时被 `:id='trash'` 吞掉）。
- **404 面**：已删会话的详情、消息、搜索、标记已读、回退、绑定一律 404（或等价「不存在」），
  只有 `/restore`、`/purge`、`/trash` 例外。
- 组名规则：`trim()` 后 1–24 字，空/超长 400；活组重名 409 `{ error: 'GROUP_NAME_TAKEN' }`。
- 忙碌/绑定 409 形状：
  `{ error: 'SESSION_BUSY' | 'SESSION_BOUND', sessions: [{ id, title, reason: 'busy' | 'bound', platform?, externalId? }] }`。
  整组删除时 `sessions` 只列阻塞成员。

### 3.3 事件

| 事件               | payload                                                  | 广播 | 触发                             |
| ------------------ | -------------------------------------------------------- | ---- | -------------------------------- |
| `SESSION_TRASHED`  | `{ sessionIds: string[], groupIds: string[] }`           | 全局 | 单删 / 整组删                    |
| `SESSION_RESTORED` | `{ groupId: string \| null, sessions: SessionConfig[] }` | 全局 | 单条恢复 / 整组恢复              |
| `SESSION_PURGED`   | `{ sessionIds: string[], groupIds: string[] }`           | 全局 | 到期清扫 / 彻底删除 / 清空回收站 |
| `GROUPS_CHANGED`   | `{}`                                                     | 全局 | 建组 / 改名 / 折叠               |

- `SESSION_ARCHIVED` 退役（在「归档面清退」票删除常量与前端 `applyArchived`）。
- `SESSION_DELETED` 保留给「handoff 空壳清理」等物理删除路径。
- 全局广播（不是会话房间）：列表可见性与组结构影响所有正在看列表的 tab。

## 四、行为规则

### 4.1 删除守卫

- 忙碌判据：执行注册表 `snapshot()` 中，该会话存在 `status === 'busy' || queueLength > 0`
  的 agent。**不能**写成「槽位里留着 sessionId 就算忙」——idle 槽位仍留 sessionId，会永远 409。
- 绑定判据：`listBindingsBySession(id)` 非空。绑定接口本身也要拒绝已删会话。
- 单删幂等：`UPDATE ... SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`，重复调用
  返回首次时间戳。
- 整组删除在同一事务内：组 `deleted_at` + `UPDATE sessions SET deleted_at=?
WHERE group_id=? AND deleted_at IS NULL`，**同一 ISO 毫秒串**。

### 4.2 恢复与清除

- 整组恢复：只清 `sessions.deleted_at = group.deleted_at` 的那批；组 `deleted_at=NULL`；
  若存在同名活组，组名改成 `name（恢复）`（仍冲突则 `（恢复 2）`…）。
- 单条恢复：原组是活组 → 回原组；原组已删/已清除 → `groupId=null` 并提示。
- 恢复**不改** `updated_at`（不凭空跳到列表顶部）。
- 已过期但清扫尚未跑到：恢复接口仍按 `deleted_at` 判断，过期视为不存在（404）。
- 彻底删除只接受 `deleted_at IS NOT NULL` 的行；活会话 409。
- 清空回收站 = 对全部条目执行彻底删除（组条目连同同批会话）。

### 4.3 系统链路过滤（必须同批）

- `getSessionById(id)` 默认加 `deleted_at IS NULL`；
  `getSessionByIdIncludingDeleted(id)` 只给回收站 / 恢复 / 清除 / 清扫。
- `getHandoffChild`、`getEmptyHandoffChild` 排除已删子会话（否则回收站里的交接子会话
  会被重新拿来用）。
- `connectors/socketio.ts` 的 join 分支拒绝已删会话。
- 绑定写入（`upsertConnectorBinding` 的调用侧）拒绝已删会话。
- `listAllSessions()` 仍为「系统链路」口径：**含**已删会话，只给评估/审计等内部路径；
  用户面列表一律 `listActiveSessions()`。

### 4.4 前端定稿

```
┌ 会话 ─────────────── 🗑 2 ── ＋ ┐
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

- 头行只有 `会话` + `🗑 N` + `＋`；回收站入口在头行（有内容显示 `N`）。
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
   37 条 `group_id` 全指向该组，`archived_at` 仍非空且无代码读写。
2. **建组/改折叠**：新建「测试组」→ 列表出现；`PATCH collapsed=true` → 重载页面仍折叠；
   重名 → 409，输入框不关。
3. **移动会话**：`PATCH groupId` → 行落入目标组；`groupId=null` → 回未分组；
   `updated_at` 不变。
4. **handoff 继承**：从组内会话交接 → 子会话 `group_id` = 父组；父会话已删 → 子会话未分组。
5. **单删**：`DELETE` 后默认列表无它、`/trash` 有它、`purgeAfter = deletedAt + 7d`、
   消息条数不变；连点两次 `deletedAt` 不变。
6. **忙碌 409**：有猫 busy/排队时删除 → 409，`deleted_at` 仍 NULL。
7. **绑定 409**：绑定 QQ 群的会话删除 → 409，绑定行与 `deleted_at` 都不变。
8. **恢复**：回到原组、消息完整、`updatedAt` 不变；原组已删 → `groupId=null`；
   过期/已清除 → 404。
9. **整组删除**：组内会话全部进回收站且 `deleted_at` 两两相等；组行 `deleted_at` 同值；
   任一会话忙碌 → 409 且**一行都没改**；恢复后组 id 不变，组内更早单删的会话**不复活**。
10. **仅解散**：组行消失、会话 `group_id=NULL`、`deleted_at` 仍 NULL。
11. **到期边界**：`now-7d+1min` 不删；`now-7d-1min` 被清，且会话、消息、执行日志、
    四类依赖行一起消失；probe 模式不执行清扫。
12. **彻底删除/清空**：活会话 purge → 409；清空后 `/trash` 为空，组与会话行均消失。
13. **读取口径**：`getSessionById` 对已删行返回 undefined；`...IncludingDeleted` 返回；
    join 已删会话、handoff 复用已删子会话、给已删会话写绑定均被拒。
14. **前端**：悬停「移动到分组」出侧框；指针移到别处或空白处 → 侧框收起、主菜单还在；
    指针进入侧框 → 保持；批量勾选归组一次成功；删组确认默认仅解散。
15. **多 tab**：删除/恢复/整组删/清空在另一 tab 实时反映；`GROUPS_CHANGED` 后组列表刷新。
16. **索引**：`EXPLAIN QUERY PLAN` 中活跃列表走 `idx_sessions_live`，回收站走
    `idx_sessions_trash`，组内查询走 `idx_sessions_group`；无 `idx_sessions_active` 残留。

## 六、不在范围内

- 不做多标签 / 一个会话进多个组；不做嵌套分组。
- 不把多条会话的消息物理合并成一条时间线。
- 不做拖拽入组 / 拖拽排序（v1 用菜单；排序按 `created_at`）；拖拽只作为原型增强。
- 不做回收站搜索、分页、按日期再分层；7 天量级按删除动作分两段够用。
- 不做「删除后还能继续对话」——删除即冻结，恢复后才能继续。
- 不做「确认后自动停止在途执行」——只返回 409。
- 不改评估/记忆检索口径；`saveMemory` 零实现消费，记忆只读 `docs/` 白名单 MD。

## 七、决策留痕

- **跳 grilling**：用户在四轮原型（ds猫 / flash猫 / 吐槽猫 / 店长合成）后直接拍板
  「按这版开票」，需求已由原型与五条实测事实压过，不再单跑 grill。
- **Gate B 契约**：边界 = 本文 §六；契约 = §二 表结构 + §三 接口/事件 + §四 行为规则；
  验收 = §五 16 条。
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
前端交互）；验收见 §五（16 条均可执行）。

### Gate C · 反向证明

✅ 16 条全过可反证四条故事：故事 1 ← 验收 1/2/3/16；故事 2 ← 5/6/7/8/11/12/13；
故事 3 ← 9/10/14；故事 4 ← 3/4/14。无未被验收覆盖的故事。

### Gate Result

✅ PASS → 可拆票 / 进入实施（票单见 `docs/run/session-groups-trash/tickets.md`）。
