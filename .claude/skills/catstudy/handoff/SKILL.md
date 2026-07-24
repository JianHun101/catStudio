---
name: catstudy-handoff
description: >
  代码完成后自动生成交接文档。从 git diff 提取文件清单、改动描述、Reviewer Checklist，
  你只需填写 Why/Tradeoff/Open Questions 三段决策内容。
  Use when: 代码改动完成、准备交接给 reviewer、写完代码要出文档。
  Not for: 自检（用 catstudy-quality-gate）、发起审查（用 catstudy-request-review）。
  Output: 完整的【工作交接】文档。
triggers:
  - '交接文档'
  - '写交接'
  - 'handoff'
  - '出交接'
  - '生成交接'
  - '工作交接'
---

# Handoff（工作交接）

代码完成后，生成交接文档。**机械部分自动推导，决策部分由你填写。**

## 核心知识

交接文档的五个部分中，文件清单和 Checklist 可以从 git diff 推导，Why/Tradeoff/Open Questions 只有写代码的人知道：

| 部分                              | 来源                                | 谁写              |
| --------------------------------- | ----------------------------------- | ----------------- |
| **What** — 文件清单 + 改动描述    | `git diff --stat` + diff 内容       | 自动生成          |
| **Why** — 关键决策                | 设计思考过程                        | **你写**          |
| **Tradeoff** — 放弃了什么         | 取舍判断                            | **你写**          |
| **Open Questions** — 不确定的点   | 写代码时的疑虑                      | **你写**          |
| **Reviewer Checklist** — 检查清单 | 代码模式匹配 + 你补充项目特定检查点 | 自动生成 + 你补充 |

> 铁律：Why / Tradeoff / Open Questions 三段不能委托给子 agent——只有写代码的人知道为什么做这些决策。
> Checklist 从 diff 中的改动类型自动匹配通用检查点，你再补充 cat-study 项目特有的检查项。

## 流程

```
WHEN 代码改动完成（commit 已存在）:

Step 1: EXTRACT — 提取改动信息
  运行这些命令，收集原始数据：
    git diff HEAD~1 --stat          → 文件清单（带 +- 行数）
    git diff HEAD~1                 → 改动内容
    git log -1 --format='%B'        → commit message（含正文）

Step 2: WHAT — 生成文件清单 + 改动描述
  从 git diff --stat 提取文件列表
  按分层排序：shared → server/db → server/routes → server/skills → server/connectors → web → scripts → config
  每个文件一句话改动描述（从 diff 内容推断，不是猜测）

Step 3: CHECKLIST — 从代码模式匹配检查点
  扫描 diff 内容，识别改动类型 → 匹配下方"检查点模板"中的通用检查项
  生成初版 Checklist，然后你补充 cat-study 项目特有的检查点
  （如 room 前缀一致性、AGENT_SKILL_MODULES 硬编码残留、parseSkillModules 两处实现一致性等）

Step 4: WHY / TRADEOFF / OPEN QUESTIONS — 你填写
  这三段必须你写。格式要求：
  - Why：用自然段落，每个关键决策一个 ### 小标题
  - Tradeoff：用表格，每行一个取舍
  - Open Questions：用列表，每个问题一个 - **主题**：描述
  如果某段确实没有内容（如没有放弃的方案），写"无"——空段会让 reviewer 不确定你是忘了还是真没有

Step 5: OUTPUT — 组合输出
  用下方输出格式，将所有部分组合成完整交接文档
  末尾行首独占一行 @吐槽猫 请审查以上改动
```

## 输出格式

严格按 `packages/server/src/skills/handoff.md` 定义的格式（**handoff.md 是格式的正规定义，以下为参考副本——如有冲突以 handoff.md 为准**）：

```markdown
【工作交接】

### 1. What — 改了什么

| 文件            | 改动           |
| --------------- | -------------- |
| path/to/file.ts | 一句话描述改动 |

### 2. Why — 关键决策

{设计决策和上下文。每个关键决策一个 ### 小标题。不要复述 What——要回答"为什么这样做是对的"。}

### 3. Tradeoff — 放弃了什么

| 放弃的方案 | 原因         |
| ---------- | ------------ |
| {方案A}    | {为什么没选} |

### 4. Open Questions — 不确定的点

- **{主题}**：{具体不确定什么，当前怎么处理的，可能的风险}

### 5. Reviewer Checklist

- [ ] {检查点1}
- [ ] {检查点2}
```

## Checklist 自动生成规则

扫描 `git diff` 内容，识别以下改动类型 → 匹配对应检查点：

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

- [ ] Windows Git Bash 兼容性？（`findstr` vs `grep`、`xargs` 参数差异）
- [ ] 空输入 / 无效输入是否正确处理？（如 `.push-gate` 空文件绕过）
- [ ] `trap` / 信号处理是否清理了临时文件和子进程？

### 新增 repository 方法（db/repository/）

- [ ] 方法签名和调用方参数类型是否一致？
- [ ] `SELECT *` 返回类型是否和 `MessageRow` / `AgentRow` 匹配？
- [ ] 是否有对应测试覆盖？返回空集 / 不存在记录的行为是否明确？

### cat-study 项目特有检查点

以下检查点只在 cat-study 项目中适用，生成 Checklist 时根据改动范围选择性加入：

- [ ] `AGENT_SKILL_MODULES` 硬编码是否已清除？（改用 DB `skill_modules` 列）
- [ ] `parseSkillModules` / `parseJsonArray` 是否有重复实现？
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

## 和其他 skill 的区别

| Skill                            | 关注点                                         | 时机             |
| -------------------------------- | ---------------------------------------------- | ---------------- |
| `catstudy-quality-gate`          | 自检（需求对照 + 测试/lint/build 证据）        | 开发完成之后     |
| **catstudy-handoff（本 skill）** | 生成交接文档（What/Why/Tradeoff/OQ/Checklist） | 自检通过之后     |
| `catstudy-request-review`        | 把交接文档送到审查者面前                       | 交接文档完成之后 |
| `catstudy-receive-review`        | 处理审查者的反馈                               | 收到 review 之后 |

## Common Mistakes

| 错误                                           | 正确做法                                        |
| ---------------------------------------------- | ----------------------------------------------- |
| 跳过 Why/Tradeoff/Open Questions，只写文件清单 | 三段决策内容必须你写，不能空                    |
| 让子 agent 读 diff 然后猜测 Why                | 子 agent 只做文件清单 + Checklist 初稿          |
| 交接文档写完后不加载 request-review            | 下一步自动加载 `catstudy-request-review`        |
| Checklist 只有通用检查点，没有项目特有的       | 从"cat-study 项目特有检查点"中按改动范围补      |
| 不确定的段跳过不写                             | 写"无"而不是空着——reviewer 需要知道你是主动选择 |

## 下一步

交接文档生成后 → **直接加载 `catstudy-request-review`** skill 发起审查。不要停下来问用户"要不要继续"。
