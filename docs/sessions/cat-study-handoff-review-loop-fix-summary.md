# 修复 handoff 审查链：从"永不触发"到"循环不中断"

## 1. What — 具体改动

| 文件                                         | 改动                                                                                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/handoff-gen.mjs`                    | 删除 `catstudy [uuid]` 跳过逻辑；移除文档模板末尾硬编码的 `@吐槽猫 请审查以上改动。`                                                      |
| `packages/server/src/connectors/socketio.ts` | 新增 `buildReviewLoopHint`、`buildHandoffTriggerHint`、`buildDynamicHints`；在 `runAgentReply` 中以 system 消息注入动态指令               |
| `packages/server/src/seed-data.ts`           | IRON_LAWS_CODER 简化（去掉分支条件）；@示例改为 `@服务员`；IRON_LAWS_REVIEWER 新增"独占一行输出结论，不含条件"约束                        |
| `packages/server/src/skills/handoff.md`      | 首句从"你写完代码后生成交接文档"改为"交接文档由 hook 自动生成，你补填 TODO 即可"                                                          |
| `scripts/handoff-gen.e2e.mjs`                | 测试 6b：从 `assert null`（应跳过）改为 `assert not null`（应生成）；mock IRON_LAWS_CODER 同步更新；新增 `assertNotContains @吐槽猫` 断言 |
| `packages/server/data/cat-study.db`          | `pnpm seed` 将新的 system prompt 写入 DB（需 `DS_KEY` 环境变量）                                                                          |

## 2. Why — 为什么这样做

### 问题链诊断

```
用户: "@店长 给前端加一个日间模式"
  → 店长写代码 → auto-commit "catstudy [uuid]"
  → post-commit hook → handoff-gen.mjs → 跳过（匹配 catstudy 正则）
  → 审查链从未启动 ✗
```

根因：`handoff-gen.mjs` 第 74 行 `if (/^catstudy\s+\[[\w-]+\]/.test(firstLine)) return null`。所有 agent 代码改动都以 `catstudy [uuid]` 格式自动提交（`socketio.ts:764`），导致 agent 写的代码**永远**不进入审查。

删除跳过后出第二个问题——死循环的担忧：

```
handoff 投递 → @店长回复 → auto-commit → post-commit → handoff 再投递 → ...
```

但这个循环**不会发生**：@店长纯文本回复无文件改动 → `git commit` 非零退出 → 返回 null → post-commit hook 不触发。循环由 git 自身阻断。

### 从 prompt 改为结构性注入

删掉跳过后，店长能收到 handoff 补填请求，但补填完不 @吐槽猫——流程又断了。尝试调 prompt 发现不可靠：

```
代码审查由 hook 触发——写完结束回复即可。   ← base prompt
@店长 请补填交接文档...补完后 @吐槽猫      ← POST 指令（user 消息）
```

LLM 优先服从 base prompt（system 消息优先级 > user 消息），导致 POST 指令被忽略。

方案改为**动态注入 system 指令**——和 base prompt 同级，但更靠后（recency bias）、更具体：

```
┌─ system: base prompt（铁律）              ← "写完代码结束回复即可"
├─ system: [指令] 收到交接文档补填请求，
│          补填完后 @吐槽猫                  ← buildHandoffTriggerHint 注入
├─ user: @店长 请补填以下交接文档...
└─ user: Direct message from 吐槽猫...
```

### 审查循环检测：lastIndexOf 而非 includes

第一次实现用 `m.content.includes('✅可合并')` 判断审查是否通过。端到端测试中发现：吐槽猫审查的是 `buildReviewLoopHint` 代码本身——审查正文引用了三个标记，`includes` 全部命中。

改用 `lastIndexOf`：三个标记中最后出现的是实际结论（IRON_LAWS_REVIEWER 强制结论在末尾独占一行）。

### 角色驱动，不硬编码

```typescript
// 之前：硬编码名称和 ID
if (agent.name !== '店长' && agent.name !== '服务员') return null
if (m.agent_id !== 'e0764bc7-...') continue

// 现在：基于 skillModules 判断角色
if (agent.skillModules?.includes('code-review')) return null // 审查者不注入
if (!parseSkillModules(senderRow.skill_modules).includes('code-review')) continue // 非审查者跳过
```

新增 agent 或改名时，只要 `skillModules` 配置正确（有 `code-review` = 审查者，没有 = coder），审查循环自动适配。

### 聚合函数而非 hook 框架

2 个 hint 不值得建注册表：

```typescript
function buildDynamicHints(agent, triggerContent, messages): string[] {
  return [
    buildReviewLoopHint(agent, messages), // 审查未过 → @reviewer
    buildHandoffTriggerHint(triggerContent), // 收到补填请求 → @吐槽猫
  ].filter(Boolean)
}
```

等长到 5+ 个再升级为 `runHooks(CONTEXT_HOOKS, ctx)`，每个 hook 函数签名不变，`runAgentReply` 无需改动。

## 3. Tradeoff — 放弃了什么方案

| 放弃                                                                  | 原因                                                                                                                   |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 在 base prompt 里写复杂分支（"如果吐槽猫给了反馈则 @回去，否则结束"） | prompt 靠 LLM 理解，token 位置靠后会被稀释，不同模型行为不一。Structural injection 每次执行实时判断，不依赖 agent 记忆 |
| 在 handoff 文档末尾硬编码 `@吐槽猫 请审查以上改动。`                  | 工作流路由不应和文档内容耦合。改为 POST wrapper 指令 + system 注入，审查触发逻辑集中管                                 |
| hook 注册表框架                                                       | 当前只有 2 个 hint，一个聚合函数就够了。签名统一，未来升级零迁移成本                                                   |
| 两次 commit（agent 先正常 message，再 catstudy 快照）                 | git 历史噪音大，两个 commit 边界人工不合理，handoff 触发时机在 agent 回复之前导致时序错乱                              |

## 4. Open Questions — 不确定的点

- **lastIndexOf 的极限场景**：如果审查者在正文末尾又引用了一次标记（如"之前说的 ✅可合并 是错的"），lastIndexOf 会取到错误位置。当前 IRON_LAWS_REVIEWER 强制"独占一行输出结论"已大幅降低风险，但非零。
- **handoff-gen 的 @店长 硬编码**：`tryPostToCatstudy` 写死了 `@店长`。如果未来新增其他 coder agent（如"服务员"），handoff 应该发给谁？当前依赖 demo session 的 agent 列表，改角色时需要手动改脚本。
- **pnpm seed 静默覆盖 API Key**：`buildDemoAgents()` 用 `process.env.DS_KEY \|\| 'sk-your-api-key-here'`，如果运行 seed 时没设 DS_KEY，所有 agent 的 key 会被重置为占位符。seed.ts 应在 key 为占位符时跳过 `llmApiKey` 字段的 upsert。

## 5. Next Action — 希望做什么

- ✅ ~~`pnpm seed` 已执行，DB prompt 已更新~~
- [ ] 将 `pnpm seed` 的 API Key 保护加入 seed.ts：当 `llmApiKey === 'sk-your-api-key-here'` 时跳过该字段的 upsert
- [ ] `handoff-gen.mjs` 的 `@店长` 改为基于 skillModules 查找 coder agent
- [ ] 监控 2-3 次真实审查循环，确认 `lastIndexOf` 标记检测无边缘误判
- [ ] 当动态 hint 超过 5 个时，将 `buildDynamicHints` 升级为注册表模式
