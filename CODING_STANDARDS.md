# CatStudy 编码规范

本文档为 `/review` 技能的 "Standards" 轴提供检查依据。所有代码变更应满足以下标准。

## 1. 包结构

- [ ] **Monorepo 边界**：`shared/` 不含服务器或前端代码，`server/` 不含前端代码，`web/` 不含服务器逻辑
- [ ] **依赖方向**：`shared` ← `server` ← `web`（单向，无循环）
- [ ] **新依赖声明**：安装任何 npm 包前必须先声明意图并 @吐槽猫 审核

## 2. TypeScript

- [ ] **类型安全**：不使用 `any`（除非有明确注释说明原因）
  - **Blanket 豁免 ①（catch 错误处理）**：`catch (err: any)` 统一豁免——catch 变量默认 `unknown`、收窄需样板代码，82 处 call site 不要求逐条注释
  - **Blanket 豁免 ②（测试 mock）**：测试 mock 的 `as any` / `: any` 统一豁免
  - **未豁免的裸 `any`**：routes 的 `req.body/params/query` 等仍须逐一收紧；本次不做批量迁移（全仓库约 652 处），PATCH 的 `req.body as any` 已单独收口
- [ ] **Zod 校验**：所有 API 边界（路由输入/输出、Socket.IO 事件 payload）使用 Zod schema 校验
- [ ] **蛇形/驼峰转换**：数据库列名为 `snake_case`，TypeScript 为 `camelCase`，转换在 API 边界完成
- [ ] **非空断言**：`as` 类型断言优先使用 `@total-typescript/shoehorn`，避免裸 `as`

## 3. 测试

- [ ] **测试位置**：单元测试与源文件同目录（`*.test.ts`），集成测试在 `__tests__/` 下
- [ ] **内存数据库**：集成测试使用 `:memory:` SQLite（通过 `setDb()/resetDb()` 注入）
- [ ] **Mock 边界**：仅 mock 模块边界（`ioredis`），其他代码用真实实现
- [ ] **状态隔离**：Dispatch 测试在 `beforeEach` 中调用 `__test_reset()`
- [ ] **测试数据**：使用 `createTestDb()` 和 `buildTestApp()` 辅助函数

## 4. 命名与约定

- [ ] **事件常量**：Socket.IO 事件名使用 `Events` 枚举（`packages/shared/src/events.ts`），不硬编码字符串
- [ ] **文件名**：kebab-case（`seed-data.ts`、`chat-panel.vue`）
- [ ] **组件名**：Vue 组件使用 PascalCase（`ChatPanel.vue`）
- [ ] **函数名**：camelCase，动词开头（`buildContext`、`executeAgent`）

## 5. 错误处理

- [ ] **非阻塞降级**：Redis 连接失败、记忆写入失败不阻塞主流程
- [ ] **超时保护**：Agent 执行有 30 分钟超时（`AGENT_HARD_TIMEOUT_MS`，通过 `Promise.race` 实现，可环境变量覆盖）
- [ ] **日志**：使用结构化日志，包含上下文信息
- [ ] **启动弹性**：服务启动时外部依赖失败不导致进程退出

## 6. Vue 前端

- [ ] **状态管理**：全局状态使用 Pinia stores，组件本地状态用 `ref`/`reactive`
- [ ] **Scoped 样式**：组件样式使用 `<style scoped>`，全局样式放在 `src/styles/`
- [ ] **v-html 安全**：使用 `v-html` 时必须经过 DOMPurify 消毒
- [ ] **Socket.IO 事件**：使用 `packages/shared` 中定义的事件常量

## 7. 数据库

- [ ] **迁移**：Schema 变更使用 try/catch 包裹的 `ALTER TABLE`（幂等迁移）
- [ ] **JSON 字段**：`agent_ids`、`mentions` 存储为 JSON 字符串，读写时序列化/反序列化
- [ ] **WAL 模式**：SQLite 使用 WAL 模式（`PRAGMA journal_mode=WAL`）

## 8. 文件组织

- [ ] **新文件**：放在正确的包目录下（shared/server/web/scripts）
- [ ] **种子数据**：Demo 数据定义在 `packages/server/src/seed-data.ts`
- [ ] **环境变量**：`.env.example` 同步更新，敏感信息不入库

## 9. 环境变量

- [ ] **数值读取唯一入口**：数值型环境变量一律经 `envNumber(name, fallback)`（`packages/server/src/env-number.ts`）读取，不得在调用点裸用 `parseInt` / `parseFloat` / `Number(process.env.X)` 自行解析
- [ ] **坏值语义**：未设置 / 空串 / 纯空白 ⇒ 静默回退 `fallback`（那是 `env.ts` `??=` 的正常兜底面）；解析后**非有限数**（`NaN` / `±Infinity`）⇒ 打一条 warn（变量名 + 原始串 + 回退值）+ 回退 `fallback`
- [ ] **禁用「部分可解析」形态**：`parseInt` / `parseFloat` 对 `5abc` 静默取前缀值（`parseInt('5abc', 10) === 5`），**不产生 NaN** ⇒ 永远走不到 warn 分支。严格解析归 `Number()`
- [ ] **不在入口加区间钳位**：`0` / 负数原样生效；需要钳制的调用点在**调用点**显式做（如 `Math.trunc`）——钳位本身会改语义
- [ ] **每个数值键至少一条坏值回归断言**：断言须打在**真实接线点**（真键名 + 消费函数），`X=abc` ⇒ 消费点读到 `fallback`。在 helper 本体用**假键名**做单测**不构成**这些键的守卫
- [ ] **存量**：改动触碰到的裸解析点同批处置——并轨到 `envNumber`，或显式保留并在注释写明理由（部分站点现行语义是 fail-loud，并轨反而降级）
