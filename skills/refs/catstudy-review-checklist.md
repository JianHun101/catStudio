# cat-study 项目特有 Diff 审查检查点清单

供 diff 审查（code-review）实际扫描时参照的**检查项列表**。原宿主 `skills/catstudy/handoff/SKILL.md` 随投递层移除（handoff 改名 session-handoff），此为内容资产迁移——**审查判据必须保留文件载体**，不能只剩审查者记忆兜底。

> 来源：`skills/catstudy/handoff/SKILL.md`（88... 移除）「Checklist 自动生成规则」段。投递型定制层 `catstudy/request-review` 亦移除，属纯投递路由，无领域资产丢失。

## 用途

审查者/作者在扫描 diff 时按改动类型命中对应检查项。属于**领域审查内容**，与投递机制无关，故独立保存，不随投递层删除。被 base `quality-gate` / `code-review` 或 `catstudy/quality-gate` 引用（见此处引用关系）。

## 分类：通用检查点

按 diff 改动类型匹配，命中对应项：

### 正则 / 字符串匹配

- [ ] 正则是否覆盖 CJK 字符边界？（`\b` 对中文不生效）
- [ ] 是否有 ReDoS 风险？（嵌套量词、回溯爆炸）
- [ ] 特殊字符是否正确 escape？（`escapeRegex` 或等价处理）
- [ ] 空字符串 / 纯空白 / 超长输入是否处理？

### DB migration（ALTER TABLE / CREATE TABLE）

- [ ] 迁移是否幂等（重复执行不报错）？
- [ ] 存量数据的默认值是否正确？
- [ ] 是否有对应的回滚方案？
- [ ] 新增列的约束（NOT NULL / DEFAULT）和旧数据兼容？

### 状态管理 / 生命周期（slot、lock、timer、Map）

- [ ] 新增字段在所有退出路径是否都设值/清理？
- [ ] 是否有竞态窗口？（两个 async 操作之间的间隙）
- [ ] 资源（timer / listener / stream / interval）是否正确释放？
- [ ] 异常路径是否也执行了清理？

### API endpoint（新增/修改路由）

- [ ] 参数校验是否完整（Zod / 手动）？
- [ ] 错误响应是否包含有用信息（而非裸 500）？
- [ ] 向后兼容是否保证？
- [ ] REST verb 和路径是否符合项目约定？

### 前端组件（Vue SFC / composable）

- [ ] 空态（无数据）是否正确展示？
- [ ] 加载态（fetching）是否有指示？
- [ ] 错误态（请求失败）是否有用户提示？
- [ ] 是否需要 AbortController（组件卸载时取消进行中的请求）？
- [ ] `watch` / `onMounted` / event listener 是否在 `onUnmounted` 中清理？

### 环境变量 / 配置解析

- [ ] `parseInt` / `parseFloat` 结果是否做了 `isNaN` 校验？
- [ ] 默认值是否合理？
- [ ] 是否有对应 `.env.example` 更新？

### 类型 / 接口变更（shared/types.ts、schemas.ts）

- [ ] `null` / `undefined` 是否区分处理？
- [ ] 类型收窄是否完整？
- [ ] Zod schema 和 TypeScript 类型是否一致？

### 事件 / 消息（Socket.IO / EventEmitter）

- [ ] 事件名是否使用 `Events` 常量而非裸字符串？
- [ ] room / channel 名称前后端是否一致？（前缀、分隔符）
- [ ] 是否有对应的事件监听者？

### LLM / Prompt 变更（seed-data.ts、system prompt、skill .md）

- [ ] seed-data 改了 prompt → 是否确认 `pnpm seed` 后 DB 中的实际 prompt 已更新？
- [ ] system prompt 精简后是否丢掉了必需的格式约束？（如 @mention 行首规则）
- [ ] 新增/修改 skill 内容是否和对应 manifest.json trigger 同步？

### Shell 脚本（.husky/、scripts/）

- [ ] Windows Git Bash 兼容性？（CRLF 行尾、`findstr` vs `grep`、`xargs` 参数差异）
- [ ] 空输入 / 无效输入是否正确处理？（如 `.push-gate` 空文件绕过）
- [ ] `trap` / 信号处理是否清理了临时文件和子进程？

### 新增 repository 方法（db/repository/）

- [ ] 方法签名和调用方参数类型是否一致？
- [ ] `SELECT *` 返回类型是否和 `MessageRow` / `AgentRow` 匹配？
- [ ] 新增方法是否在 `db/repository/index.ts` 中 re-export？（忘了 export → 调用方 import 不到）
- [ ] 是否有对应测试覆盖？返回空集 / 不存在记录的行为是否明确？

## cat-study 项目特有检查点

以下检查点只在 cat-study 项目中适用，审查时根据改动范围选择性加入：

- [ ] 角色化规则语境是否残留写死猫名？（应只按角色表述，真名仅存于 agents 表 role 字段）
- [ ] `skill_modules` 是否保持清空？（操作层已拆除，机制保留空跑，勿重新登记）
- [ ] `retractionRequests` Map 在所有退出路径是否正确清理？（Window ② 提前 return、Window ③ abort return、超时路径）
- [ ] `activeStreams` Map 的 delete 是否和 `retractionRequests.delete` 配对？
- [ ] `agentSlots` 的 `currentTriggerMessageId` 是否在所有状态变更点更新？
- [ ] 前端 `fetchSkills()` 是否有 AbortController？（快速切换 session 场景）
- [ ] 前端 store action 失败时是否清理了 `pending*` 状态？（`pendingHandoffSummary` 等）
- [ ] `messages.agent_id` 无 FK 约束 → 级联删除是否手动覆盖？
- [ ] `.push-gate` / pre-push hook — 空文件 / 无效 SHA / 仅空白字符是否被正确拦截？
- [ ] `parseInt('0') || default` 零值被吞？含 `parseInt` / `parseFloat` 的 env var 解析是否用 `isNaN` 校验？
- [ ] `@作者` 占位符 — 用户触发路径（非 A2A）是否被替换为实际用户名？
- [ ] `seed.ts --reset` 流程 — 表删除顺序是否符合 FK 依赖？（memories → messages → execution_logs → sessions → agents）
- [ ] Redis 不可用时 dispatch 状态变更 — 是否有桥接 fallback？（`emitViaBridge` / Socket.IO 直接广播）
- [ ] Socket.IO room 前缀一致性 — `socket.join(\`session:${id}\`)`vs`io.to(id)` 是否对齐？
- [ ] Window ②（流式前）撤回保护 — 是否因 `role = 'user'` 硬编码误杀 A2A 路径？
