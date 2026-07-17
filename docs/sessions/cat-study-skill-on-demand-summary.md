# CatStudy Agent 按需加载 Skill — 工作交接

## 1. What — 改了什么

| 文件 | 改动 |
|------|------|
| `packages/server/src/skills/manifest.json` | 补充触发词（`apt`、`review`），移除 `agents` 映射（移到 socketio.ts），优化描述文案 |
| `packages/server/src/skills/handoff.md` | 去重 @mention 格式说明（铁律层已覆盖），精简内容 |
| `packages/server/src/skills/dependency-request.md` | 刷新文案 |
| `packages/server/src/skills/code-review.md` | 刷新文案 |
| `packages/server/src/skills/dependency-review.md` | 刷新文案 |
| `packages/server/src/skills/skill-loader.ts` | **重写**：完整的单例 SkillLoader 类，含启动加载、关键词匹配、错误处理、查询接口。旧版是未完成的 stub |
| `packages/server/src/skills/skill-loader.test.ts` | **新增**：18 个测试，覆盖初始化/单例/匹配/边界/错误降级 |
| `packages/server/src/seed-data.ts` | `HANDOFF_FORMAT`/`DEVELOPMENT_RULE`/`REVIEW_RULE` 常量拆分为 `IRON_LAWS_CODER`/`IRON_LAWS_REVIEWER`；`DemoAgent` 加 `skillModules` 字段；`systemPrompt` 只存铁律 |
| `packages/server/src/connectors/socketio.ts` | 导入 SkillLoader + 添加 `AGENT_SKILL_MODULES` 静态映射；`llmMessages[0]` 改为调用 `SkillLoader.getInstance().matchAndBuild()` |
| `packages/server/src/index.ts` | 启动流程加 Step 1.7：`SkillLoader.initialize(skillsDir)` |

## 2. Why — 关键决策

### 核心决策：铁律层/操作层分离

```
【改造前】                          【改造后】
systemPrompt = "猫设"               basePrompt = "猫设" + 铁律（出口检查/禁止自审/@mention）
  + HANDOFF_FORMAT（交接模板）         skillModules = ['handoff', ...]
  + DEVELOPMENT_RULE（开发规则）              ↓
  + REVIEW_RULE（审查规则）           runAgentReply 时关键词匹配
        ↓                                  ↓
LLM（所有规则全注入）                LLM（铁律始终在 + 操作规则按需注入）
```

**理由**：店长不会再被注入审查流程规则，吐槽猫不会再被注入开发规则——消除角色混淆，而非单纯省 token。

### 子决策

| 决策 | 理由 |
|------|------|
| SkillLoader 用模块级单例（弱依赖 import） | socketio.ts 不改函数签名，测试用 `SkillLoader.reset()` 替换 |
| `AGENT_SKILL_MODULES` 放 socketio.ts 静态 Map | 不改 DB schema，不改 shared types。Agent 名是稳定标识，后续可迁移到 DB 列 |
| manifest 用 JSON 不用 YAML | 项目无 YAML 解析器依赖，JSON 一行 `JSON.parse` 零成本 |
| manifest 解析失败阻止启动 | 错误的行为比不启动更危险 |
| 单个 .md 缺失只 warn 不阻塞 | 降级优雅——少一个操作规则比全部挂掉好 |

## 3. Tradeoff — 放弃了什么

| 放弃方案 | 原因 |
|----------|------|
| `skillModules` 存 DB 列（需 migration）| 改动面大，当前 3 个种子 Agent 的 skillModules 不会动态变化，静态 Map 够用。后续有新 Agent 时再加 DB 列 |
| `.claude/skills/manifest.yaml` 和后端 manifest 合并 | 运行时不同——CLI 管理子进程技能，后端管理 prompt 片段路由。强行合并职责不清 |
| LLM 意图分类代替关键词匹配 | 多一层 LLM 调用，延迟增加，关键词对规则触发精度足够 |
| `iron-laws.md` 作为文件由 skill-loader 统一加载 | 铁律太短（几段话），拆成文件增加维护心智负担，直接写 `seed-data.ts` 常量更直观 |

## 4. Open Questions — 不确定的点

1. **关键词误触发率**：`dependency-request` 和 `dependency-review` 共享触发词 `["安装", "install", "npm", "pip", "apt"]`。消息中说"讨论安装过程"而非"请求审批安装"时也会触发。需要观察生产环境误触发率，必要时升级到简单正则。
2. **`AGENT_SKILL_MODULES` 静态映射的维护**：新增 Agent 时需要同时在 `seed-data.ts`（`skillModules` 字段）和 `socketio.ts`（`AGENT_SKILL_MODULES` Map）两处声明。后续应该统一到 DB 列。
3. **`import.meta.url` + `fileURLToPath` 在 tsx 下的兼容性**：已验证 tsx 支持此模式，但如果有 Node.js 版本差异需要注意。

## 5. Reviewer Checklist

- [ ] `seed-data.ts`: `IRON_LAWS_CODER` 和 `IRON_LAWS_REVIEWER` 的铁律内容是否完整？有没有遗漏原 `DEVELOPMENT_RULE`/`REVIEW_RULE` 中的规则？
- [ ] `seed-data.ts`: `DemoAgent.skillModules` 字段声明是否正确？三只猫的 skillModules 分配是否合理？
- [ ] `skills/manifest.json`: 4 个 skill 的触发词是否覆盖足够？有没有明显的漏词？
- [ ] `skills/skill-loader.ts`: 单例模式是否正确？`reset()` 是否在所有测试中正确清理？
- [ ] `skills/skill-loader.ts`: `loadAll()` 的错误处理——manifest 失败抛异常、单文件缺失 warn——是否正确？
- [ ] `connectors/socketio.ts`: `AGENT_SKILL_MODULES` Map 是否与 `seed-data.ts` 的 `skillModules` 一致？
- [ ] `connectors/socketio.ts:871-884`: 动态 prompt 装配 + memory 注入的顺序是否正确？（先 matchAndBuild，后 append memoryContext）
- [ ] `index.ts`: SkillLoader 初始化时机是否在 `initDb()` 之后、Fastify listen 之前？
- [ ] 测试: 18 个 skill-loader 测试覆盖是否全面？有没有遗漏的边界情况？
- [ ] 回归: 全部 226 个已有测试是否通过？（已验证 ✅）
- [ ] TypeScript: 修改的 4 个源文件是否有类型错误？（已验证 ✅，唯一错误是 cli-utils.ts 预存问题）
- [ ] 部署: `pnpm seed` 能否正确覆盖已有 Agent 的 `system_prompt` 列？

@吐槽猫 请 review。
