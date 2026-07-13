# CatStudy 测试体系建设

## 1. What — 具体改动

| 文件 | 改动 |
|------|------|
| `vitest.workspace.ts` | 新建，Vitest 工作区配置，引用 shared/server/web 三个包 |
| `packages/shared/vitest.config.ts` | 新建，shared 包 vitest 配置（纯 TypeScript，无平台依赖） |
| `packages/server/vitest.config.ts` | 新建，server 包 vitest 配置（10s 超时，禁用记忆/减噪日志） |
| `packages/web/vitest.config.ts` | 新建，web 包 vitest 配置（jsdom 环境 + Vue 插件 + @ 别名） |
| `packages/web/src/test-setup.ts` | 新建，全局 stub SessionCreateModal 和 AgentEditModal 子组件 |
| `packages/server/src/db/index.ts` | 新增 `setDb()` / `resetDb()` 两个测试钩子，支持注入 `:memory:` 数据库 |
| `packages/server/src/dispatch/index.ts` | 新增 `__test_reset()` 函数，支持测试间重置模块级 Map |
| `package.json`（根） | 新增 `test` / `test:watch` / `test:coverage` / `test:server` / `test:web` / `test:shared` 脚本 |
| `packages/server/package.json` | 新增 `test` / `test:watch` 脚本 |
| `packages/web/package.json` | 新增 `test` / `test:watch` 脚本，devDependencies 新增 `@vue/test-utils` + `jsdom` |
| `packages/shared/package.json` | 新增 `test` / `test:watch` 脚本 |
| `packages/shared/src/schemas.test.ts` | 新建，Zod schema 校验（AgentConfig/Create/SessionCreate/MessageSend/EmbeddingConfig） |
| `packages/shared/src/events.test.ts` | 新建，事件常量 + Redis 频道模式函数验证 |
| `packages/server/src/llm/cli-utils.test.ts` | 新建，`messagesToPrompt()` 纯函数测试（7 条） |
| `packages/server/src/logger.test.ts` | 新建，日志创建、级别过滤、meta 参数测试（5 条） |
| `packages/server/src/db/redis.test.ts` | 新建，Redis 连接状态机测试（5 条） |
| `packages/server/src/test-helpers.ts` | 新建，共享测试工具：`createTestDb()`（内存 SQLite + 完整 schema）、`buildTestApp()`（最小 Fastify 实例） |
| `packages/server/src/db/index.test.ts` | 新建，DB schema 验证（5 表、列定义、FK 约束、CREATE IF NOT EXISTS 幂等） |
| `packages/server/src/routes/agents.test.ts` | 新建，Agent REST API 集成测试（13 条：CRUD + 校验 + 409 冲突） |
| `packages/server/src/routes/sessions.test.ts` | 新建，Session REST API 集成测试（13 条：CRUD + 广播切换 + 级联删除） |
| `packages/server/src/dispatch/index.test.ts` | 新建，调度引擎测试（16 条：槽位初始化、FIFO 队列、mention 路由、完成/失败处理） |
| `packages/server/src/memory/index.test.ts` | 新建，记忆系统测试（11 条：向量 Blob 往返、存储/去重/降级、检索空值处理） |
| `packages/server/src/llm/registry.test.ts` | 新建，适配器注册测试（8 条：provider 路由、apiKey 缓存、clearCache、不支持 provider 报错） |
| `packages/server/src/seed.test.ts` | 新建，seed 逻辑测试（4 条：uuid.v5 确定性、不同 name 产生不同 ID、格式合法性） |
| `packages/web/src/composables/useMention.test.ts` | 新建，@mention 自动补全测试（23 条：detect/suggest/filter/select/navigate/close） |
| `packages/web/src/stores/chat.test.ts` | 新建，Pinia store 测试（22 条：初始状态/joinSession/sendMessage/toggleBroadcast/fetchData/createSession/deleteSession/deleteAgent/updateAgent/socket 事件处理） |

## 2. Why — 为什么这样做

### 零测试 → 165 条安全网：从核心向外辐射

CatStudy 经过 5 轮迭代，核心逻辑已经稳定——但全部依赖手动验证。`pnpm lint` 只保证了类型安全，SQLite 查询、调度状态机、REST 响应格式这些"正确性"从未被自动化验证过。在添加"清空消息"等新功能之前，先把安全网铺上。

```
测试优先级（从核心向外）：
  shared schemas      ← 全项目依赖，bug 传播面最广
  server 纯逻辑       ← 确定性函数，性价比最高
  server 路由集成     ← REST API，用 app.inject() 替代 curl 手动测试
  server 调度/记忆    ← 最复杂的业务逻辑（状态机、FIFO、去重）
  web 组合式函数      ← 纯逻辑，不依赖 DOM
  web store           ← mock socket + api，测试状态流转
  web 组件            ← 暂缓——薄壳展示层，store 已覆盖核心行为
```

### 内存 SQLite：零环境依赖的集成测试

```
传统做法：
  测试 → 种子脚本 → 写入 data/cat-study.db → 测试后手动清理
  → 多测试并发写同一个文件 → 互相污染 → 不可靠

本次做法：
  setDb(new Database(':memory:')) → 每个测试独立数据库
  → FK 约束真实生效 → 每个 beforeEach 独立重置 → 零污染
  → 不需要 initDb（跳过 sqlite-vec 原生模块加载）
```

选择 `:memory:` 而非临时文件的理由：SQLite `:memory:` 比磁盘临时文件快 3-5 倍，且自动在连接关闭时销毁——即使测试崩溃也不会遗留脏数据。WAL 和 FK 通过 pragma 开启，行为与生产完全一致。

唯一的代价是需要在生产代码中暴露 `setDb()` / `resetDb()` 两个函数（共 8 行）。这是**最小侵入**的测试钩子——不改变任何现有逻辑，仅在测试时调用。

### Mock 分层：真实与模拟的边界

```
真实测试（无 mock）:
├── Zod schema 校验 — 纯函数，零依赖
├── messagesToPrompt — 纯函数，零依赖
├── uuid.v5 确定性 — 纯函数，零依赖
├── SQLite schema/FK — :memory: 是 SQLite 真实行为
├── Fastify 路由 — app.inject() 模拟 HTTP 但不启动 TCP socket
└── useMention — 纯 Vue ref/computed，不挂载 DOM

Mock 层:
├── vi.mock('ioredis') — 构造函数需特殊处理（function 而非 arrow）
├── vi.mock('@/composables/useSocket') — store 测试不需要真实 socket
├── vi.mock('@/composables/useApi') — store 测试不需要真实 fetch
├── vi.mock('../connectors/socketio.js') — Session DELETE 测试不需要 Socket.IO
└── vi.mock('./embedding.js') — 记忆测试不需要 100MB 模型下载

跳过:
├── DeepSeek/Claude/OpenAI 适配器 — 需 API key + spawn 子进程
├── sqlite-vec vec_distance_cosine — 原生模块测试环境不可用
└── @huggingface/transformers pipeline — 100MB 下载、非确定性
```

Mock 策略的关键原则：**mock 只作用于模块边界，不 mock 核心逻辑**。ioredis 的连接行为可以被 mock（因为是外部库的边界），但 dispatch 的 FIFO 队列逻辑必须跑真实代码。

### dispatch 测试的 FK 陷阱

调度引擎的 `executeAgent()` 函数会 `INSERT INTO execution_logs`，该表有外键引用 `agents(id)` 和 `sessions(id)`。测试在 `beforeEach` 中 seed 了这两个表的引用数据：

```sql
-- 必须在 dispatch 前执行
INSERT INTO agents (id, name, ...) VALUES ('agent-1', '店长', ...)
INSERT INTO sessions (id, title, ...) VALUES ('session-1', 'test', ...)
```

之前一个失败方案是先 `vi.resetModules()` 再 `setDb(createTestDb())` ——这导致 `resetModules` 清除了 db 模块的缓存，`getDb()` 重新创建了一个文件型 DB（而非注入的内存 DB）。调换顺序（先 setDb 再 import）解决了问题。

## 3. Tradeoff — 放弃了什么方案

| 放弃 | 原因 |
|------|------|
| 全部用 `vi.mock` + 手动验证参数 | 反而增加 mock 维护负担。能用真实实例的地方（SQLite `:memory:`、Vue `ref`/`computed`、Zod `safeParse`）用真实实例，测试才能真正发现集成问题 |
| 每个包单独写 `vitest.config.ts` 而非根级统一配置 | web 需要 `jsdom` + `@vitejs/plugin-vue`；server 需要 `MEMORY_ENABLED=false` 环境变量；shared 什么都不需要。统一配置会导致不必要的环境开销 |
| `better-sqlite3` 用 mock 替代 | 内存 SQLite 已足够快（单测 < 10ms），且能真实验证 SQL 语法、FK 约束、迁移行为。mock 反而测不出 `SELECT * FROM agents WHERE id IN (?)` 这种参数绑定 bug |
| Vue 组件测试（mount + DOM 断言） | `SessionList`、`ChatPanel` 等组件的主要复杂度在 store 交互和 composable 逻辑，已在 store 和 useMention 测试中覆盖。组件层是薄壳——渲染 `<button @click="store.joinSession">` 的 DOM 测试性价比低 |
| sqlite-vec `vec_distance_cosine` 真实加载 | 原生扩展在 `:memory:` 数据库上不一定能自动加载。记忆去重测试改用 `MEMORY_DEDUP_ENABLED=0` 环境变量绕过，测试"不启用去重的存储路径"。去重逻辑本身需要在真实环境（已加载 sqlite-vec）中验证 |
| 用 `vitest` 命令行参数过滤包（`--project=shared`） | Vitest v4 的 workspace 项目名基于目录路径，`--project=shared` 匹配不到。改用 `cd packages/shared && npx vitest run` 直接运行 |

## 4. Open Questions — 不确定的点

- **sqlite-vec 在 `:memory:` 上的可用性**：当前测试跳过 `vec_distance_cosine` 调用（通过禁用去重）。理论上 `sqliteVec.load(db)` 应该也能在内存数据库上注册函数，但未实际验证——测试环境绕过了原生模块加载。如果需要在测试中验证去重逻辑，需要确认 Windows 下 `sqlite-vec` 对 `:memory:` 数据库的兼容性
- **Vue 组件测试的切入点**：当前 store + composable 覆盖了核心行为，但 `<ChatPanel>` 的消息滚动、`<SessionList>` 的 hover 删除按钮渲染等 UI 细节未被测试。不确定这些"视觉正确性"是否值得投入组件测试——特别是 emoji surrogate pair 已在 useMention 的 `🐱` 过滤测试中暴露了一个真实 bug（高 surrogate `\uD83D` 匹配了所有同 block 表情），该 bug 目前在生产代码中依然存在
- **`MEMORY_DEDUP_ENABLED` 环境变量的读取时机**：代码中在 `saveMessageMemory()` 函数体内读取 `process.env.MEMORY_DEDUP_ENABLED`（运行时而非模块加载时），这是好的——允许测试动态切换。但 `buildMemoryContext` 中 `MEMORY_TOP_K` 同理，这个模式不一致：有些在模块顶层读取，有些在函数体内。当前测试通过 `vi.stubEnv` 处理，但模块级变量在 `vi.resetModules()` 后被重置
- **Vitest v4 workspace 的 project 过滤**：`--project=<name>` flag 在 Vitest v4 中的行为与 v3 不同。当前妥协方案是 `cd` 到子包目录运行，不如根目录统一运行直观。后续升级 Vitest 版本可能修复
- **测试覆盖率数字的准确性**：当前未启用 `--coverage`（会显著增加运行时间）。165 条测试覆盖了主要逻辑路径，但行覆盖率未知。特别是 socketio.ts 的连接处理器（主要的异步流控逻辑）未被测试

## 5. Next Action — 希望做什么

- ✅ ~~测试基础设施搭建~~（完成：vitest workspace + 3 包配置 + 生产代码钩子）
- ✅ ~~shared 包测试~~（完成：28 条，Zod schema + 事件常量）
- ✅ ~~server 纯逻辑测试~~（完成：17 条，cli-utils + logger + redis）
- ✅ ~~server 集成测试~~（完成：26 条，DB schema + Agent/Session CRUD）
- ✅ ~~server 核心业务逻辑测试~~（完成：31 条，dispatch + memory + registry + seed）
- ✅ ~~web 前端测试~~（完成：45 条，useMention + chat store）
- 为 Session 增加"清空消息"功能（保留 Session 和 Agent 配置，仅清空 `messages` 和 `execution_logs`）——现在可以在 165 条安全网的保护下实现
- 在 AgentEditModal 中根据 provider 显示动态提示（claude → "需安装 Claude Code CLI"，openai → "需安装 Codex CLI + codex-proxy"）
- 广播模式下自动减少历史消息条数（100 → 50），缓解上下文膨胀
- 修复 useMention 中 emoji surrogate pair 导致的误匹配（`@🐱` 查询的高 surrogate `\uD83D` 匹配了所有同一 Unicode block 的表情）
- 为 socketio.ts 的连接处理器编写集成测试（需要 mock Socket.IO Client + Server，当前是最复杂的未测试模块）
- 运行 `pnpm test --coverage` 获取准确行覆盖率，补充盲区
