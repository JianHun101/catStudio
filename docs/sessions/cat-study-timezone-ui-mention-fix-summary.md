# 时区修复 + UI 冗余箭头清理 + @mention Tab 补全光标修复

## 1. What — 具体改动

| 文件                                              | 改动                                                                                                           |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `packages/server/src/connectors/socketio.ts:117`  | 历史消息 `row.created_at` 转为 ISO 8601 UTC 格式（`replace(' ', 'T') + 'Z'`）                                  |
| `packages/server/src/routes/sessions.ts:198-199`  | `toSessionConfig()` 中 `createdAt`/`updatedAt` 同样转换                                                        |
| `packages/web/src/components/ChatPanel.vue:33-87` | 新增 `normalizeDateTime()` 防御函数；`formatTime`/`formatDate`/`dateSepIndices`/`isGrouped` 五个调用点统一使用 |
| `packages/web/src/stores/chat.ts:367,441`         | `Date.now()`（number）→ `new Date().toISOString()`（string），修复 `createdAt` 类型不一致                      |
| `packages/web/src/components/AgentPanel.vue`      | 删除 `collapsed-expand` 展开箭头按钮（line 164-174）及对应 CSS（line 276-294, 397-410, 471）                   |
| `packages/web/src/components/SessionList.vue`     | 删除 `collapsed-expand` 展开箭头按钮（line 66-68）及对应 CSS（line 168-170, 200-215, 241）                     |
| `packages/web/src/composables/useMention.ts:103`  | 暴露 `mentionStartIdx` ref 到 return 对象                                                                      |
| `packages/web/src/components/ChatPanel.vue:250`   | Tab/Enter 补全光标公式从 buggy 自搜改为 `mentionStartIdx.value + agent.name.length + 2`                        |
| `packages/web/src/components/ChatPanel.vue`       | 删除死代码 `mentionStartIdx()` 函数（原 line 258-268）                                                         |

## 2. Why — 为什么这样做

### 时区修复：服务端序列化边界转换 + 前端防御

SQLite `datetime('now')` 返回无时区标记的 UTC 字符串 `YYYY-MM-DD HH:MM:SS`。JavaScript `new Date()` 按 ECMAScript 规范将其解析为**本地时间**，导致中国用户（UTC+8）下午 4 点的消息显示为早上 8 点。

```
修复前流程:
  SQLite: datetime('now') → "2026-07-20 08:00:00" (UTC, 无时区标记)
  前端:   new Date("2026-07-20 08:00:00") → 按本地时间解析 → 08:00
  显示:   08:00（错误，实际应为 16:00）

修复后流程:
  SQLite: datetime('now') → "2026-07-20 08:00:00" (UTC)
  服务端: replace(' ', 'T') + 'Z' → "2026-07-20T08:00:00Z" (ISO 8601 UTC)
  前端:   new Date("2026-07-20T08:00:00Z") → 正确识别为 UTC
         toLocaleTimeString → 16:00（自动转为本地时区）
```

**为什么在服务端做转换而非前端**：这是序列化边界问题。服务端是数据的生产者，理应对输出格式负责。前端 `normalizeDateTime` 只是防御层——处理缓存/旧数据中可能残留的 SQLite 格式。

### UI 冗余箭头：统一收起/展开入口

Agent 面板的显示/隐藏原本有两个入口：

```
入口 1 (正确): ChatPanel 顶栏 btn-sidebar-toggle — 图标根据 open/close 状态切换
入口 2 (冗余): AgentPanel 底部 collapsed-expand 箭头 — 只在收起状态出现，功能重复
```

删除 `collapsed-expand` 后，展开动作统一由 ChatPanel 顶栏 toggle 按钮负责。SessionList 同理。

### @mention Tab 补全光标：消除双路径不一致

补全有两条路径——Tab 键和鼠标点击：

```
点击路径 (selectMention，一直正确):
  input.value.indexOf(`@${agent.name} `) + agent.name.length + 2
  → 精准定位到空格后面 ✅

Tab 路径 (onKeydown，有 bug):
  mentionStartIdx() + result.length - input.value.length + ta.value.length
  → mentionStartIdx() 从当前光标位置搜 @，但 input.value 改完后光标被浏览器重置到 0
  → 永远搜不到 @，返回 -1
  → 光标落在空格上或空格前，继续输入时光标前的字符被吞
```

修复：Tab 路径直接用 composable 保存的 `mentionStartIdx.value`（@ 触发时记录的精确位置），不再依赖运行时光标搜 @。两条路径现在走同样的计算模式。

## 3. Tradeoff — 放弃了什么方案

| 放弃                                                       | 原因                                                                                                                                                        |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 纯前端修复时区（每个 `new Date()` 调用点手工加 UTC 标记）  | 调用点分散，容易遗漏新增路径。服务端在数据源头加 `Z` 后缀是唯一真理源，前端防御层只兜底                                                                     |
| 用 `strftime('%Y-%m-%dT%H:%M:%SZ')` 替代 `datetime('now')` | SQLite 的 `strftime` 不能直接生成带 `Z` 的格式；`datetime('now') \|\| 'Z'` 可以但改动更大。当前 JS 层 replace + Z 是改动最小的方案，且对现有 SQL 语句零侵入 |
| 给 collapsed-expand 加功能而非删除                         | 已有 ChatPanel toggle 按钮实现同功能。保留两个入口增加维护负担和用户困惑                                                                                    |
| Tab 补全后不发空格，让用户自己打                           | 不符合主流聊天应用习惯（Slack/Discord/微信 @ 补全后都自动加空格）                                                                                           |

## 4. Open Questions — 不确定的点

- **`isGrouped` 的相对时间差**：修复前没走 `normalizeDateTime`，仅当两个时间戳格式一致时才正确。已加防御，但无法 100% 排除混合格式场景（如旧缓存 + 新数据）。当前风险极低，因为服务端统一了输出格式。
- **其他 `new Date()` 调用点**：前端可能还有未覆盖的日期解析路径。当前通过 `normalizeDateTime` 收敛了 ChatPanel 内的五个调用点，但 stores 或 composables 中如果新增日期解析，需要记得过这个函数。可以考虑后续把 `normalizeDateTime` 提取到 shared 工具函数。

## 5. Next Action — 希望做什么

- ✅ ~~将 `normalizeDateTime` 提取到 shared 工具函数~~（当前仅在 ChatPanel.vue 内，作为局部函数够用，暂不提取）
- 检查 `chat.ts` 和 `useApi.ts` 中是否还有其他直接 `new Date(dbString)` 的调用点
- 考虑在 shared 包中添加 `parseUTCDateTime` 工具函数，统一全项目日期解析入口
