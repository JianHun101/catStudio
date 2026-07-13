# CatStudy 广播模式与删除会话

## 1. What — 具体改动

| 文件 | 改动 |
|------|------|
| `packages/shared/src/types.ts` | `SessionConfig` 新增 `broadcastMode: boolean` 字段 |
| `packages/shared/src/events.ts` | 新增 `TOGGLE_BROADCAST`（客户端→服务端）和 `BROADCAST_MODE_CHANGED`（服务端→客户端）事件 |
| `packages/server/src/db/index.ts` | `sessions` 表新增 `broadcast_mode INTEGER DEFAULT 0` 列；`initDb()` 中用 try-catch 执行 ALTER TABLE 兼容已存在的表 |
| `packages/server/src/routes/sessions.ts` | 新增 `PATCH /api/sessions/:id`（切换广播模式）；修复 `DELETE /api/sessions/:id`（补删 `execution_logs`）；`toSessionConfig` 输出 `broadcastMode` |
| `packages/server/src/connectors/socketio.ts` | 上下文过滤逻辑：读取 Session 的 `broadcast_mode`，开启时保留所有 Agent 回复；其他 Agent 的消息用 `【猫咪名】说：...` 注入 LLM。新增 `TOGGLE_BROADCAST` socket 事件处理 |
| `packages/web/src/composables/useApi.ts` | 新增 `deleteSession(id)`；修复 `request()` 只在 body 存在时加 `Content-Type: application/json` |
| `packages/web/src/stores/chat.ts` | 新增 `broadcastMode` 状态、`toggleBroadcast()` 方法、`deleteSession()` 方法、`BROADCAST_MODE_CHANGED` 事件监听；`joinSession` 时同步广播模式 |
| `packages/web/src/components/ChatPanel.vue` | 聊天头部新增广播开关（toggle switch），开启后红色高亮 |
| `packages/web/src/components/SessionList.vue` | 每个会话行新增 × 删除按钮（独立 button 元素，hover 时显示），点击弹出确认对话框后删除；会话项改为 `div > button + button` 行布局 |

## 2. Why — 为什么这样做

### 广播模式开关

每个 Agent 默认只看和自己相关的消息（被 @ 的、广播、自己的回复），这从代码层面杜绝了"一人分饰多角"。但有些场景需要 Agent 之间互相感知——比如多猫接力回复时，后面的猫应该知道前面的猫说了什么。广播模式开关让用户按需选择。

```
非广播（默认）：
  用户: @店长 @服务员 今天天气？
  店长 → 只看自己的回复 + 用户消息
  服务员 → 只看自己的回复 + 用户消息

广播（开启后）：
  用户: @店长 @服务员 今天天气？
  店长 → 看到所有人的回复（服务员的标注为【服务员】说：...）
  服务员 → 看到所有人的回复（店长的标注为【店长】说：...）
```

### 上下文过滤而非 Prompt 限制（延续）

广播模式下其他 Agent 的消息不会直接作为 `assistant` role 注入（会混淆 LLM 身份认知），而是用 `【名字】说：内容` 格式以 `user` role 注入。这避免了 Agent 把别人的话当成自己的——LLM 看到的是"有人告诉我，某某说了什么"，而非"我就是某某"。

### 删除会话

之前只删 `messages` 和 `sessions`，漏了 `execution_logs`。SQLite 的外键约束 `FOREIGN KEY (session_id) REFERENCES sessions(id)` 在 DELETE 时触发，导致 500 错误。按外键依赖倒序删除——`execution_logs` → `messages` → `sessions`——解决。

### Content-Type 只在有 body 时发送

`request()` 原来无条件加 `Content-Type: application/json`。Fastify 对 DELETE/GET 等无 body 请求，看到 JSON Content-Type 就会尝试解析空 body，直接抛 `FST_ERR_CTP_EMPTY_JSON_BODY`。修复为 `hasBody ? { headers: {...} } : {}`，只在 POST/PUT/PATCH 时带 Content-Type。

### 删除按钮独立于会话按钮

最初删除 × 是 `<span @click.stop>` 嵌在 `<button @click="joinSession">` 内，依赖 `stopPropagation` 阻止冒泡。改为兄弟 `<button>` 元素——各自独立事件处理，零冒泡依赖。

## 3. Tradeoff — 放弃了什么方案

| 放弃 | 原因 |
|------|------|
| 广播模式下把其他 Agent 消息当 `assistant` role 注入 | 会混淆 LLM 身份认知——Agent 会以为别人的话是自己说的。改为 `【名字】说：...` 的 user role 格式 |
| 广播模式全局开关（非 Session 级别） | 不同 Session 可能有不同需求。Session 级别粒度为后续多 Session 场景留空间 |
| 删除按钮用 `@click.stop` 冒泡方案 | 不直观，容易出问题。兄弟元素布局更可靠 |
| 全局加 `Content-Type` header | 对无 body 的方法（DELETE/GET）反而是 bug |
| 前端触发删除后立即刷新页面 | 体验差。改为乐观更新本地状态 + 自动切换下一个会话 |

## 4. Open Questions — 不确定的点

- **广播模式下的上下文膨胀**：开启后每个 Agent 的 context 都包含所有其他 Agent 的回复，随对话轮次增长可能导致 token 消耗显著增加。后续可结合记忆检索（sqlite-vec）做截断
- **广播模式下 Agent 回复的"抢话"风险**：多条猫都能看到彼此的发言，system prompt 里需要明确约定"不要替别人说话"，否则可能出现角色串扰。当前靠强 role system prompt + `【名字】说：` 前缀约束，待更多测试验证
- **删除会话后前端状态同步**：当前仅更新本地 sessions 数组，若多 tab 打开同一会话，其他 tab 不会感知删除。后续可通过 Socket.IO 广播 `session-deleted` 事件
- **`broadcast_mode` migration 的鲁棒性**：`ALTER TABLE` 放 try-catch 里，列已存在则静默跳过。但 SQLite 的 ALTER TABLE 有其他限制（如不能加 NOT NULL 且无 DEFAULT 的列），当前方案正好有 DEFAULT，可用

## 5. Next Action — 希望做什么

- 测试广播模式下多轮对话的上下文质量和 token 消耗
- 考虑在广播模式开启时，减少历史消息条数上限（如从 100 降到 50），平衡上下文大小
- 添加 `session-deleted` Socket.IO 事件，让多 tab 客户端同步删除
- 为 session 增加"清空消息"功能（保留 session 和 agent 配置，仅清空历史）
- 增加 Agent 删除确认（当前 Agent 删除也无确认弹窗）
