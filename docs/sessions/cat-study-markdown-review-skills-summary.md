# CatStudy Markdown 渲染 + 审查技能体系搭建

## 1. What — 具体改动

| 文件 | 改动 |
|------|------|
| `packages/web/package.json` | 新增 `marked`（markdown 解析）+ `dompurify`（HTML 消毒）依赖 |
| `packages/web/src/utils/markdown.ts` | 新建 — `renderMarkdown()` 函数：`marked.parse()` → `DOMPurify.sanitize()` → 安全 HTML |
| `packages/web/src/components/ChatPanel.vue` | `{{ msg.content }}` → `v-html="renderMarkdown(msg.content)"` + 非 scoped markdown 元素样式块 |
| `pnpm-lock.yaml` | 锁定 marked + dompurify 版本 |
| `.claude/skills/manifest.yaml` | 新建 — catStudy 技能路由清单 |
| `.claude/skills/catstudy/README.md` | 新建 — catStudy 技能目录架构索引 |
| `.claude/skills/catstudy/quality-gate/SKILL.md` | 新建 — 开发自查门：7 步检查（vision → standards → tests → architecture → security → unfinished → gate） |
| `.claude/skills/catstudy/request-review/SKILL.md` | 新建 — 发起审查：生成结构化审查请求，调用现有 `/review` / `/code-review` / `/security-review` 技能 |
| `.claude/skills/catstudy/receive-review/SKILL.md` | 新建 — 接收审查反馈：Red→Green 逐项修复 + 三道验证门（CI → 功能 → 追问） |
| `.claude/skills/catstudy/refs/shared-rules.md` | 新建 — 5 条开发铁律 + 审查配对规则 |
| `.claude/skills/catstudy/refs/cat-roles.md` | 新建 — 3 只猫的角色定义 + 审查者选择策略 |
| `.claude/skills/catstudy/refs/review-standards.md` | 新建 — P1（阻塞合并）/ P2（应该修复）/ P3（锦上添花）严重度定义 |
| `.claude/skills/catstudy/refs/review-request-template.md` | 新建 — 审查请求标准格式模板 |
| `.claude/skills/refs/pr-template.md` | 新建 — PR 描述模板 |
| `CODING_STANDARDS.md` | 新建 — 供 `/review` 技能 Standards 轴使用的编码规范检查清单 |

> **注**：`.claude/skills/` 顶层同时存在 `quality-gate/`、`request-review/`、`receive-review/` 三个通用技能目录和 `refs/` 共享模板目录，与 `catstudy/` 子目录形成分层——通用版本供所有上下文使用，`catstudy/` 版本包含猫角色等猫咖特定内容。

## 2. Why — 为什么这样做

### Markdown 渲染：纯文本到富文本

猫（LLM）天生输出 markdown——代码块、列表、加粗是它们最自然的表达方式。之前 `{{ msg.content }}` 纯文本渲染导致猫发回来的所有格式都丢失了：

```
问题：
  猫说 "`` `console.log('hello')` ``" → 页面显示原始反引号
  猫说 "**重要**" → 页面显示原始星号
  猫说 "- 第一点\n- 第二点" → 页面没缩进没圆点
```

解决路径选择了 `marked + DOMPurify` 组合而非 `markdown-it` 或 `showdown`，原因是：

```
marked (60KB) — 速度最快、零配置、GitHub Flavored Markdown 默认支持
  ↓ 解析为 HTML 字符串
DOMPurify (20KB) — 白名单过滤，只放行安全标签和属性
  ↓ 消毒后的安全 HTML
v-html 绑定 — Vue 响应式渲染
```

```
用户发消息 "@店长 帮我分析这段代码"
  → LLM 回复含 ```ts ... ```
  → Socket.IO 传回原始 markdown 字符串
  → ChatPanel.vue: renderMarkdown(msg.content)
    → marked.parse("```ts\nconst x = 1;\n```")
    → "<pre><code class=\"language-ts\">const x = 1;\n</code></pre>"
    → DOMPurify.sanitize(html) → 同（无危险标签）
  → v-html 渲染出带语法高亮的代码块
```

### 审查技能体系：参照 clowder-ai 的三步链

clowder-ai 有完整的 `quality-gate → request-review → receive-review → merge-gate` 四步链，catStudy 做了精简：

```
clowder-ai                         catStudy
─────────                          ────────
quality-gate (breed-specific)  →  quality-gate (统一 7 步)
request-review (dynamic match) →  request-review (静态配对表)
receive-review (fix loop)      →  receive-review (Red→Green)
merge-gate (cloud + sandbox)   →  ❌ 省略（单猫开发无冲突场景）
```

关键适配决策：

```
catStudy 只有 3 只猫（店长/服务员/吐槽猫），不存在 clowder-ai 的 5 品种跨审查配对。
因此：
  审查者选择 → 吐槽猫首选，降级到另一开发者（服务员 ↔ 店长互审）
  品种门 → 省略，统一为 7 个通用检查步骤
  SOP 谓词 → 人工清单代替（无 CI 集成，无需 machine-checkable）
  Cloud review → 省略（3 只猫全用本地模型）
```

核心流程：

```
开发完成
  → /quality-gate（自查 7 步）
    → PASS？→ /request-review（生成审查请求 + 匹配审查者）
      → 吐槽猫审查 → 给出 P1/P2/P3 反馈
        → /receive-review（处理反馈：Red→Green）
          → 三道验证门（测试 / 功能验证 / 追问确认）
            → 全部通过 → 合入
```

### 为什么不用手写 Agent prompt 来做审查

上一轮 markdown 改动完成后，我手写了两个 `Agent(subagent_type="claude", prompt="审查安全性...")` 调用。问题：

1. **绕过了已有技能** — `/code-review`、`/review`、`/security-review` 技能已经存在且经过了打磨，手写 prompt 的质量远不如这些技能里的结构化指令
2. **不可复用** — 每次审查都要重写 prompt，没有标准化输出格式
3. **无法配对** — 手写 prompt 没有审查者选择逻辑，不知道应该让吐槽猫来审
4. **没有严重度分级** — 缺乏 P1/P2/P3 分类，所有问题平铺，不知道先修哪个

新体系通过 `/catstudy-request-review` 技能封装了这些逻辑，内部调用现有 `/review` 等技能，用户只需说"请 review"。

## 3. Tradeoff — 放弃了什么方案

| 放弃 | 原因 |
|------|------|
| `markdown-it`（12KB，插件生态好）| `marked` 更轻量且 GitHub Flavored Markdown 开箱即用（表格、任务列表、删除线），`markdown-it` 需要额外装插件 |
| `highlight.js` + 代码高亮 | catStudy 是 TypeScript/Vue 辅助聊天工具，不是文档站。代码块只需等宽字体 + 背景色区分即可，不需要语言级语法高亮。减少 30KB+ |
| 用 `computed` 缓存 `renderMarkdown` 结果 | Review 反馈指出了性能问题，但当前消息量少（< 50 条），缓存引入的 key 管理和失效逻辑复杂度不值得。待消息量增长后再加 |
| `v-html` 直接渲染用户输入 | **绝不**。XSS 风险。`DOMPurify` 的白名单只放行 `p, h1-h6, ul, ol, li, a, code, pre, blockquote, table, em, strong, del, hr, br, img`，任何不在白名单的标签/属性都会被移除 |
| 创建 catStudy 自己的 code-review agent | 已有 `code-review` 技能（mattpocock），功能完备。catStudy 的审查技能只在"流程编排"层工作（何时审、谁审、审完怎么处理），审查执行委托给已有技能 |
| `merge-gate`（clowder-ai 第四步）| catStudy 单猫开发，无 PR 合入窗口冲突、无 cloud review、无 sandbox 隔离需求。三步链已覆盖全流程，第四步是过度设计 |
| 动态审查者匹配（clowder-ai 的 7 条规则）| 3 只猫不需要动态匹配引擎。静态表 `{店长→吐槽猫, 服务员→吐槽猫, 吐槽猫→店长}` 够了 |
| `img` 标签的 `alt` 降级渲染 | Review 建议：`![alt](url)` 被 DOMPurify 移除 `<img>` 后至少显示 alt 文字。当前直接丢弃，因为猫极少发图片内容，后续有需要再加 marked renderer 自定义 |

## 4. Open Questions — 不确定的点

- **猫角色定义的实际执行效果**：`cat-roles.md` 定义了店长（开发+架构）、服务员（开发+UI）、吐槽猫（审查）的分工。但这些角色定义在技能文件里，agent 的实际行为仍由 `seed-data.ts` 的 system prompt 控制。两者之间的同步是手动维护的——改了一个没改另一个就会出现角色漂移
- **审查技能的 `/` 前缀调用方式**：mattpocock 的技能通过 `/skill-name` 语法调用，catStudy 自建的 `quality-gate`、`request-review`、`receive-review` 技能在系统检测到后也会出现在可用技能列表中，但实际触发路径（`/catstudy-request-review` vs `/request-review`）取决于技能文件的命名和位置。当前在 `catstudy/` 子目录下的技能可能需要前缀，顶层的不需要——需要实际测试确认
- **Markdown 渲染的性能退化点**：`marked.parse()` + `DOMPurify.sanitize()` 每条消息每次重渲染都调用。当前消息量少时没问题，但如果一个会话有 200+ 条消息且 4 只猫同时打字（每帧渲染），主线程卡顿会变得明显。Review 建议的 `computed` 缓存方案是正确的方向，但实现复杂度需要权衡
- **审查流程中人的位置**：三步链（quality-gate → request-review → receive-review）全部在猫之间自动化完成，但最终合入决定权在哪？clowder-ai 有明确的"用户审批"节点，catStudy 当前的设计是"吐槽猫审查通过 → 店长自行合入"。如果吐槽猫和店长对某个 P2 问题有分歧，没有升级路径
- **`.claude/skills/` 顶层和 `catstudy/` 子目录中存在重复文件**：`refs/shared-rules.md` 和 `refs/review-standards.md` 在两个位置有副本。当前内容可能不同步，后续维护容易出现"改了一个忘了另一个"的问题。应该确定一份为 canonical 并删除另一份，或采用 symlink/reference 方式

## 5. Next Action — 希望做什么

- [ ] 确认 catstudy 审查技能能否通过 `/catstudy-request-review`、`/catstudy-quality-gate` 等命令正常触发
- [ ] 在实际代码变更中跑一遍完整三步链（quality-gate → request-review → receive-review），验证流程可用
- [ ] 清理 `.claude/skills/` 顶层和 `catstudy/` 子目录中的重复文件，确定 canonical 位置
- [ ] 在 `receive-review` 技能中增加"用户审批"节点——P1 修完后由用户确认是否合入，而非全自动
- [ ] Review 反馈的 markdown 性能问题（`computed` 缓存 `renderMarkdown` 结果）：在消息量超过 ~100 条后加入
- [ ] `marked` renderer 自定义：`img` 标签降级为 `[image: alt]` 占位文本
- [ ] 同步 `cat-roles.md` 中的角色定义和 `seed-data.ts` 中的 system prompt，确保一致性
- [x] ✅ ~~Markdown 渲染上线~~（commit 2ec719b）
- [x] ✅ ~~审查技能文件创建~~（.claude/skills/ + CODING_STANDARDS.md）
- [x] ✅ ~~测试通过验证~~（169 tests passed, 0 failed）
