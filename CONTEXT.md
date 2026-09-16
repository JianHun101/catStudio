# CatStudy — 猫咖多 Agent 对话系统

面向终端用户的本地多 Agent 对话平台。用户创建会话，与一组具有持久身份和长期记忆的拟人化 Agent 进行群聊。支持 Web 界面接入。

## Language

### Agent（猫咪角色）

一个具有固定身份、长期记忆和对话能力的 AI 实体。每个 Agent 独立配置 LLM 供应商和 API key。Agent 不自主插话——只在被调度时回复。
_Avoid_: Bot, 机器人, AI 助手

### Session（会话）

一个独立的多人对话线程。用户创建 Session 后加入一组 Agent，对话在 Session 内隔离。用户可同时打开多个 Session。
_Avoid_: 聊天室, 房间, 线程

### Slot（槽位）

Agent 的执行能力单元。每个 Agent 只有一个 Slot，同一时刻最多处理一件事。Slot 状态：`idle`（可接任务）、`busy`（执行中）。忙时新请求进入 FIFO 队列。Agent 开始推理时，前端会先显示 `thinking` 状态（连接器层发送的展示事件，非槽位状态）。
_Avoid_: 通道, 并发数

### Message（消息）

对话中的单条发言。`role` 区分 `user`（人类）、`agent`（猫咪角色）、`system`（系统通知）。Message 携带 `mentions` 列表——被 @ 的 Agent 标识——用于调度路由。
_Avoid_: 记录, 日志, 发言

### Memory（记忆）

Agent 对过往对话的一条持久化记录，以嵌入向量的形式存储，支持语义相似度检索。每次 Agent 被调度回复时触发检索，匹配的记忆注入 Agent 的推理上下文。
_Avoid_: 历史, 缓存, 上下文片段

### Embedding（嵌入向量）

文本语义的固定维度数值表示。由全局独立配置的嵌入模型在本地生成，与各 Agent 的 LLM 供应商解耦——所有记忆共享同一向量空间。
_Avoid_: 特征向量, 语义编码

### Mention（提及）

用户消息中对特定 Agent 的显式引用（@Agent名）。Mention 是调度系统的输入——被提及的 Agent 的 Slot 被检查，决定立即执行还是排队。
_Avoid_: 点名, @标记

### Dispatch Queue（调度队列）

当 Agent 槽位忙碌时，新请求按 FIFO 顺序排队等待。队列是按 Agent 独立的——每个 Agent 有自己的等待队列。
_Avoid_: 待处理列表, 任务队列

### Execution（执行引擎）

把一条被调度的消息变成一条 Agent 回复的完整过程：上下文过滤 → 记忆注入 → LLM 流式 → 落库 → 状态播报，以及启动恢复（从 DB 重新拉起中断的执行）。Connector 只负责把消息交给它，并把它的输出广播出去。
_Avoid_: 回复引擎, pipeline

### Connector（渠道适配器）

连接外部消息平台和 CatStudy 消息总线的适配器。Web Connector 通过 Socket.IO 连接浏览器。Connector 只做消息格式转换和路由，不包含业务逻辑。未来可扩展 QQ 等渠道。
_Avoid_: 插件, 桥接, 前端

### Message Bus（消息总线）

消息分发机制。核心通过 Socket.IO 房间广播实现实时消息推送。Redis Pub/Sub 作为可选补充（`agent:{name}:status` 频道用于跨进程 Agent 状态同步），Redis 不可用时系统自动降级为内存模式。频道设计预留 `session:{id}:messages` 和 `session:{id}:agent:{name}` 用于未来多进程扩展。执行引擎（Execution）的输出经 Message Bus 发出——引擎只对总线喊话，送达方式由 Connector 决定。
_Avoid_: 事件总线, 队列

### Execution Log（执行日志）

Agent 每次回复的完整执行记录。包含触发消息、开始时间、结束时间、最终状态。用于调试和审计。
_Avoid_: 日志, 请求记录

## 判据线（什么该写进本文档）

**「这个信息变了，是不是意味着架构 / 契约 / 流程变了？」** —— 是 → 写进本文档；否（只是代码实现变了）→ 不写，让代码自己说话。

- **写**（稳定，跨代码迭代仍成立）：模块目录结构、文档位置约定、补全术语、流程约定（见下四节）。
- **不写**（易变，代码是唯一真相）：函数签名、接口形状、文件行号、commit 内容。
- **与 `AGENTS.md` 分工**：操作手册、运行期不变量、暗坑 → `AGENTS.md`；术语表、目录结构、文档位置、流程约定 → 本文档——同一事实只在一处定义。

## 模块目录结构

- `packages/shared/` — Types、Zod schemas、Socket.IO 事件常量（无运行逻辑）
- `packages/server/` — Fastify + Socket.IO + SQLite + LLM adapters + dispatch + memory
  - `src/routes/` — HTTP 端点（含 `internal.ts` 的 `/api/internal/*` 信号端点）
  - `src/db/repository/` — SQLite 查询层（agents/sessions/messages/memories/executionLogs 等）
  - `src/llm/` — LLM 适配器（chatStream：DeepSeek/Claude/OpenAI/...）
  - `src/dispatch/` + `src/execution/` — 调度与执行引擎
  - `src/connectors/` — 平台适配器（socketio 等）
  - `src/env.ts` — 环境变量手动解析（无 dotenv）
- `packages/web/` — Vue 3 + Vite + Pinia + Socket.IO client
- `scripts/` — dev/seed/stop、MCP server（mcp-server.mjs + mcp-server-utils.mjs）、hooks/skills 治理（hooks-install.mjs、skills-check-manifest.mjs）
- `skills/` — 猫咖技能活源（`.claude/skills` junction 指向此处）
- `docs/` — 子目录：adr/（架构决策）、lessons/（经验教训）、sessions/（会话总结）、plans/（定稿规格）、research/（勘察报告）、run/（开发文档·在飞）；根级另有 roadmap.md、css-coding-standards.md

## 文档位置约定

- `docs/adr/` — 架构决策留痕（跨会话，给下个会话重建「为什么这么设计」的地图）
- `docs/lessons/` — 无取舍的经验（教训 / 可复用做法），跨活复用；**一份一个家**：全程住 `docs/lessons/<slug>.md`，卡片形态与状态字段见该目录门牌 `README.md`。写者不限，但落此即**必审**
- `docs/sessions/` — 会话总结（session-summary skill 产出）
- `docs/run/` — 开发文档（在飞）：to-tickets 切出的票单，落 `docs/run/<work-slug>/tickets.md`，**一事一目录**（并行会话 worktree 下扁平单文件必撞名互覆）。写者是本轮实施猫；落点由调用方指定，不写死在 skill 正文。**活收口即清**——结论上浮到 **`docs/plans/`**（点名，不二选一；`docs/sessions/` 归 session-summary skill 另产，不是 run 收口的上浮出口），本目录对应子目录删除
- `docs/plans/` — 定稿规格（to-spec 产物，如 `episode-evaluation-v2.md`、`knowledge-base-v1.md`）：活还在时就已**定稿**，活一结束即停止维护。它不承诺「仍然有效」——读者须自行判时效
- `docs/research/` — 勘察报告 / 调研结论 / 执行规格（spec）（如 `clowder-ac-evidence-and-vision-guard.md`、`skill-delivery-decoupling-spec.md`）：一次性调研或某一活的执行规格产出。**随活停更**——活进行中会随实施更新，活一结束即停止维护；属「定稿·随活过期」
- 过程决策留痕（本会话内：跳 grilling 的为什么、Gate 答案、争议裁决）→ spec 尾部 `## 决策留痕` 固定段，一行一决策、可 grep，不单独建文档

**开发文档 vs 沉淀文档判据**：

|      | 开发文档 `docs/run/`                | 沉淀文档 `lessons/` `sessions/` `adr/` | 定稿文档 `plans/` `research/`                                                                   |
| ---- | ----------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 时效 | 在飞，活结束即失效                  | 跨会话长期有效，随架构演进而更新       | `plans/`：活中即定稿、之后冻结 ／ `research/`：随活停更（活中随实施更新）；两者活结束即停止维护 |
| 读者 | 本轮实施猫 / 审查猫                 | 下个会话的猫                           | 需要「当时那份定稿规格」的人                                                                    |
| 形态 | tracer-bullet 票单 + blocking edges | 状态字段 / 决策留痕 / 会话总结         | to-spec 定稿规格 / 勘察报告 / 执行规格                                                          |
| 归宿 | 收口即清，结论上浮                  | 长期保留，持续维护                     | 原地保留，不再维护（读者自行判时效）                                                            |

## 术语补全

- `agent_ids`（sessions 表 JSON 数组）= 会话成员，按注册顺序（无 FK 约束，成员可能被删成悬空 id）
- `segments`（messages 表 JSON）= 消息的结构化块（kind: text/thinking/tool），非拼接字符串
- `role` = 身份定位（agents.role：store/reviewer/implementer；`vision` 已于 2026-09-13 退役，老库残留行按「角色不在边表 → 放行」兜底），非状态、非消息行 role（user/agent/system）——两个 role 不是一回事
- `dispatch_state` / `execution_logs.status` = 调度与执行状态（running/completed/failed），忙闲不影响入队

## 流程约定

- 审查链（后半个门）：`quality-gate → request-review → receive-review`；收口归店长；提交后由作者按 `request-review` 自行发起审查（post-commit hook 仅对「无归属执行」的提交兜底）
- 收口链（**设计态 + PR 承载分支即 session 分支**——会话分支是 `dev` 的后代，`ff-only` 必然可合，该前提见 `scripts/worktree-create.mjs` 的 worktree 基线门禁说明；另两种情形见下方未决项条）：确认审查结论 → **清 `docs/run/` 中已收口活的 `<slug>/` 并提交到「要进 PR 的那个分支」**（本链下即 session 分支；在会话 worktree 内提交，早于主工作区的收口机械步骤；先把结论上浮到 `docs/plans/`（点名）；删除动的是已跟踪文件，必须落成 commit）→ **主工作区（检出 `dev`）`ff-only` 合并回 dev** → 更新 `.push-gate` → 推该分支 → createPr（base=dev）→ GitHub merge → 主工作区 `ff-only` 拉回 `dev` 同步 → **主工作区收口机械步骤整体落位（`closeoutSession`：merge／删 worktree + 分支／写 `.push-gate`／checkout）——必须排在「推该分支」+ PR 合并之后**（幂等性与覆盖面见 ⑤）
  - **清理 commit 必须落在 PR 承载的那个分支上、且早于 `ff-only` 合并回 dev；`.push-gate` 只在主工作区写**。五条机制约束：① 清理 commit 落在 `dev` 上就**进不了 PR**——远端永远清不掉 `<slug>/`；② `.push-gate` 是 gitignored 的 per-worktree 文件，**只有主工作区存在**（`writeGate` 硬编码 `mainRoot`，见 `packages/server/src/llm/session-closeout.ts`）——会话 worktree 内 **push 必失败是预期行为，绝不 `--no-verify` 绕过**；③ `ff-only` 合并回 dev 必须**先于**写 gate、也先于 push：合并后 `dev` HEAD 才等于待推分支 tip，门禁校验的才是你要推的东西（pre-push 取**当前检出的 HEAD**——`git rev-parse HEAD`，不看你推哪个 ref；推非检出分支时该校验空转，**属门禁本身的已知缺口**，此处只记录、不靠改文档适配）；④ `.push-gate` 必须指向**最终** HEAD，否则 `merge-base --is-ancestor` 会把新 commit 判成「未经 review」而阻断推送。即「更新 `.push-gate` 是 push 前的最后一步」——但这半句须从 `scripts/worktree-create.mjs` 的收口说明中**单独摘出**：该说明整体是**推 `dev` 的审批制旧序**（`ff-only` 合并 → **删分支** → 写 gate → push），删分支排在 push 前在旧序里成立（推的是仍在的 `dev`），整句搬进 PR 流会把待推的 session 分支带走（见 ⑤）；⑤ **主工作区的收口机械步骤（`closeoutSession`，见 `packages/server/src/llm/session-closeout.ts`）必须排在「推该分支」+ PR 合并之后**——它含 step ②「删 worktree + 分支」（`removeSessionWorktree` 内的 `git branch -D`），排在 push 前则分支已删 → `src refspec does not match any`，PR 发不起来。其 `merge`/`writeGate` 均幂等——分支已合 → `ff-only` 走 `Already up to date`（幂等**成功**，非跳过）、分支已删 → `branchRefExists` 假返回 `null` 跳过、gate 值相同不重写；故链尾无需再单列「写一次 gate」，由本步覆盖
  - **上链未覆盖的两种情形均为未决项，其完整链序「未定案、需新机制」**——本约定只固化设计态 + session 分支承载，**不在文档里发明未经验证的步骤**：
    - **分叉拓扑（`dev` 已前进、会话分支不再是其后代）**：此时 `ff-only 合并回 dev` 必然失败，承载退化为 GitHub PR 的 merge commit，本地 `ff-only` 只剩「拉回 dev 同步」这一层。已核边界：分叉态下收口器**拒绝而非误删**——`mergeSession` 的 `ff-only` 失败即返回 `step:'merge'`，不进入删 worktree/分支、不写 gate（同上 `closeoutSession`）
    - **隔离 closeout 分支承载（PR 承载分支 ≠ session 分支）——链尾不可直接落 `closeoutSession`**：该函数签名只有 `sessionId`，**没有「合哪个分支」的参数**——step ① 取的 ref 硬编码为 `sessionBranch(shortId)`（`session-closeout.ts` 的 `sessionBranch` → `git-utils.ts` 的 `session/${shortId}`），即合的是**整个 session 分支**。而隔离路径的存在前提恰是 session 分支上**有未审 commit**（没有就不必隔离）→ ff-only 一旦成功，未审 commit **静默进 dev**——**与上行相反：分叉态是拒绝，本态是误合**。该路径的收口落点未定案
- **docs 单一写入口——判据是「每份文档只有一个写入方」，而非「只有一个写入位置」**（2026-09-16 更正，依据 `docs/run/precommit-scope/closeout.md` §四）：
  - **病灶**：docs 有过**两个写入口**（主仓库工作区 + 会话 worktree）。两侧改到同一段 ⇒ 两笔**逐字节相同**的 patch，而 3-way merge 对「两侧改成同一内容」解析**干净、不冲突、不报警**——内容确实一致，是 git 的**正确行为**，**没有可改的开关**。故只能**合并前显式对账**（判据面与合并面的错位，不是配置问题）。
  - **一般 docs**（本文件自身、`docs/adr/`、`docs/plans/`、`docs/run/<slug>/` 的票面与报告、`docs/lessons/`）：写入方 = **会话 worktree**（跟代码同分支那条）；**主仓库工作区不直接编辑 docs**，只做 `ff-only` 合并。
  - **收口记录**（`docs/run/<slug>/closeout.md`）：写入方 = **收口方、写在 `dev` 上、绝不回写 worktree**——它是 **post-merge 产物**（记录的就是合并本身），物理上不可能先于合并存在于被合并的分支里。**一个写入方 ⇒ 结构上不产生重复落盘**，「只出现在 dev 一侧」不违反本纪律（反例见下方初版约束：写宽了就会长出一条没必要的绕路）。
- **收口前跑一次 `node scripts/closeout-dupcheck.mjs --a dev --b session/<sid8>`（收口链的前置动作）**：有命中 ⇒ **先裁定保留哪一侧，再合并**（脚本只检测、不修复）。出口三分：`0` 无命中／`1` 有命中／`2` 跑不动（调用方或环境错误）。**当心「判据无面」**：`dev` 是会话分支祖先时两侧无分叉，脚本 `exit 0` 但**必在 stderr 打警示**——那是「无面可查」，**不是**「检查通过」。**有落点 ≠ 会被消费**：纪律靠人记、脚本靠跑，故脚本必须挂进本链，否则它与不存在没有区别。
- 开发流程 gate 决策点：`spec-gate`（前半个门——需求可证伪/契约钉死，放行才拆票/进 implement）+ `quality-gate`（后半个门——提交前自查）
- 依赖声明优先：装任何包前先声明 + 审查者批准，声明与安装不同轮
- 记账类提交（纯文档收口记录）**免完整审查轮，但必过「数字独立抽验」**：收口记录是审计底账，一个错数字会污染此后全部取证——其中每个可被命令复现的数字（sha / parent 序 / diff stat / DB 计数 / 触发 uuid）必须由**第二只猫实测复核**，作者自报不成立。免完整轮与免审前缀是两件事：`scripts/handoff-gen.mjs` 的 `REVIEW_EXEMPT_PREFIXES`（判据为路径 `every` 命中 `docs/run/`）只决定「是否发起审查轮」，不豁免记录可信度——记账提交可静默，静默不等于免抽验
- **行号核对必须走字节级 oracle**：`git grep -n <sha> -- <path>`（或 `git show <sha>:<path> | grep -n`），**不得用 PowerShell 管道读文件取行号**——PS 5.1 在中文 ACP（如 936/GB2312）下按旧代码页解码 UTF-8 输出，双字节序列吞掉换行、行被静默合并，行号随位置累积偏移（实测同一 blob 的常量行号被读成偏小近百行），且**无任何告警**；伪影会让复核者拿错误证据推翻正确提交。`git grep` 是 C 层字节匹配、绕开 shell 解码，在任何终端下只有一种结果——佐证可用「blob sha 自哈希回环」（`git cat-file -p $B \| git hash-object --stdin` 应回吐 `$B` 本身）
