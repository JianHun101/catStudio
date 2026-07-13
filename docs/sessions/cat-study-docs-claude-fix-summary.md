# 文档体系重构 + CLAUDE.md 创建 + Claude CLI 适配器静默失败修复

## 1. What — 具体改动

| 文件 | 改动 |
|------|------|
| `.claude/skills/session-summary/SKILL.md` | 新增输出路径规则（`docs/sessions/`），更新 Context 引用和 Post-generation 提示 |
| `docs/sessions/cat-study-*-summary.md` (x8) | 从根目录移入 `docs/sessions/`，根目录只保留 `README.md` + `CONTEXT.md` |
| `CLAUDE.md` | **新建**。项目入口文档：命令、monorepo 结构、启动序列、消息流、上下文过滤、调度引擎、LLM 适配器模式、记忆系统、数据库、测试模式、环境变量、Windows 注意事项 |
| `packages/server/src/llm/claude.ts` | 修复 3 个静默失败路径：收集 stderr 用于错误报告、检查 `hasOutput` 避免空回复、覆盖 `exitCode` 为 `null`（ENOENT）场景、移除未使用的 `attachExitError` 导入 |

## 2. Why — 为什么这样做

### 文档体系：三层检索模型

Agent（Claude Code coding agent）接手工作时的信息检索路径应该是渐进式的：

```
第 0 步: CLAUDE.md（自动加载，~200 行）
  → 理解项目骨架、常用命令、核心约定
  → 大多数场景已覆盖 → 直接工作

第 1 步: .claude/memory/（计划中，按 type/tag 查询）
  → 查关键决策、已知坑位、用户偏好
  → 每篇 50-200 字，wikilink 关联

第 2 步: docs/sessions/（完整会话记录）
  → 需要完整上下文时阅读
  → 深度回溯设计推理链
```

之前的问题：
- **没有 CLAUDE.md** — agent 每次都要自己探索项目结构，效率低且可能遗漏关键约定
- **8 个 summary 文件在根目录平铺** — 随迭代继续膨胀，组织混乱
- **session-summary skill 输出到根目录** — 新 summary 持续增加根目录噪音

CLAUDE.md 的定位：不是 README 的复述，而是 **agent 的操作手册**——只包含写代码需要的信息（启动方式、架构、约定、边界条件），不包含"功能介绍"和"快速开始"这类面向人类用户的内容。

### Claude CLI 适配器：静默失败的三个路径

Claude CLI 适配器通过 `spawn` 子进程调用 Claude Code CLI。原代码在以下三个场景全部静默失败：

```
场景 A: spawn ENOENT（cli 未安装或路径错误）
  → child.on('error') 只记日志，不产出 chunk
  → exitCode = null
  → generator 结束，只产出 { content: '', done: true }
  → 用户看到猫回复了空内容

场景 B: 进程非零退出（API key 错、网络问题）
  → attachExitError 只记日志
  → parseClaudeCodeOutput 读到 0 行
  → generator 结束，产出空 chunk
  → 用户看到猫回复了空内容（或者 dispatch 层 180s 超时）

场景 C: stderr 被丢弃
  → 运维排查时完全不知道出了什么错
```

```
修复前:
  chatStream()
    ├─ spawn(claude, ...)
    │   ├─ error  → log only ──────────────────→ 静默
    │   └─ close  → log only ──────────────────→ 静默
    ├─ parseClaudeCodeOutput()
    │   └─ 0 lines read ───────────────────────→ 静默
    └─ yield { content: '', done: true }        → 用户看到空内容

修复后:
  chatStream()
    ├─ spawn(claude, ...)
    │   ├─ stderr → 收集到变量
    │   └─ close  → log with stderr snippet
    ├─ parseClaudeCodeOutput()
    │   └─ hasOutput = false
    ├─ exitCode !== 0  → yield error + stderr detail  → 用户看到错误原因
    ├─ exitCode === null → yield "无法启动，请检查安装"  → 用户看到提示
    └─ exitCode === 0   → yield { done: true }         → 正常结束
```

### 为什么 DeepSeek adapter 没这个问题

DeepSeek adapter 走 HTTP API——请求失败时 HTTP 状态码直接变成 error response，不需要手动处理进程状态机。CLI adapter 的本质复杂度在于：它是一个**异步状态机**（启动→运行→退出），每个状态转换都可能失败，且失败信息分散在 error 事件、close 事件、stderr 流三个通道。

## 3. Tradeoff — 放弃了什么方案

| 放弃 | 原因 |
|------|------|
| 直接把 8 个 summary 内容合并进 CLAUDE.md | CLAUDE.md 应在 200 行以内（上下文窗口宝贵），8 篇 summary 合计 80k+ 字，全部放入会让 agent 丢失关键信息 |
| 用 Obsidian vault 替代 `.claude/memory/` | Obsidian 面向人类知识管理，`.claude/memory/` 是 Claude Code 原生集成，agent 自动加载、按 type/tag 程序化查询。两者可共存，不互斥 |
| 在 `claude.ts` 中复用 `attachExitError` 并增强它 | `attachExitError` 的职责是"记录日志"，而修复需要的是"产出 chunk"。两者职责不同——日志是运维面，chunk 是用户面。强行复用会破坏单一职责 |
| 用一个统一的 `spawnWithErrorHandling()` 包装器 | 每个适配器（claude/openai）的错误语义不同——Claude 是 NDJSON 流、Codex 是另一种 NDJSON 格式。过早抽象会隐藏差异。等第三个 CLI adapter 出现时再提取 |
| 把 CLI adapter 改为 HTTP API（像 DeepSeek 那样） | Claude Code 没有公开的 HTTP API，只能通过 CLI 调用。Codex 同理 |

## 4. Open Questions — 不确定的点

- **`claude -p` 的 prompt 长度限制**：Windows 命令行参数长度上限约 8191 字符，长对话可能超出。当前 `messagesToPrompt` 直接拼接所有消息为一个字符串，没有截断逻辑。如果 context 超过 8000 字符，spawn 可能失败（但这种情况尚无实际触发记录）。
- **CLI adapter 的重试策略**：当前 spawn 失败直接报错，没有重试。但 CLI 进程的失败模式（ENOENT vs 网络超时 vs API 限流）差异很大，统一重试可能导致重复计费。暂时保持无重试，由用户手动重发消息。
- **`.claude/memory/` 的实际收益**：文档体系的三层设计中，第 1 层 CLAUDE.md 已创建，第 2 层 memory 还是计划。需要在实际使用中验证 agent 按 type/tag 检索 memory 是否真的比直接读 session summary 更高效。

## 5. Next Action — 希望做什么

- ✅ ~~session-summary skill 输出路径改为 `docs/sessions/`~~
- ✅ ~~8 个 summary 文件从根目录移入 `docs/sessions/`~~
- ✅ ~~创建 `CLAUDE.md`~~
- ✅ ~~修复 Claude CLI 适配器的静默失败~~
- 从 ADR 和 session summary 中提炼关键知识点，创建 `.claude/memory/` 知识库（按 type: project/feedback/user 分类，wikilink 关联）
- 评估是否需要文档向量索引：用项目已有的 embedding → sqlite-vec 管线索引 `docs/` 目录，提供 `searchDocs()` 语义搜索
- 验证 Claude CLI 适配器修复效果：在 Windows 上以 `claude` provider 创建 Agent，确认错误信息能正常显示在前端
