# CatStudy 编码规范

本文档为 `/review` 技能的 "Standards" 轴提供检查依据。所有代码变更应满足以下标准。

## 1. 包结构

- [ ] **Monorepo 边界**：`shared/` 不含服务器或前端代码，`server/` 不含前端代码，`web/` 不含服务器逻辑
- [ ] **依赖方向**：`shared` ← `server` ← `web`（单向，无循环）
- [ ] **新依赖声明**：安装任何 npm 包前必须先声明意图并 @吐槽猫 审核

## 2. TypeScript

- [ ] **类型安全**：不使用 `any`（除非有明确注释说明原因）
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
- [ ] **超时保护**：Agent 执行有 180s 超时（`Promise.race`）
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
