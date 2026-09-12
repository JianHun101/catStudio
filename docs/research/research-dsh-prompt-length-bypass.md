# 调研笔记：dsh prompt 长度规避（file/stdin 通道 + MCP 外置实测）

> 调研单：dsh prompt 长度规避调研（ds猫），配 flash猫 的 opencode 侧调研，共同汇总成「32K 规避统一方案」ADR。
> 关联：ADR 0007（外部工具形态选型前置检查单）——本调研按「能力对账前置 / 假设标红+实测对称 / 简单形态默认 / 决策留痕」四步执行。
> 调研对象：`@deepseek-ai/dsh@0.1.0-rc.6`（锁死版本），dsh 适配器 `packages/server/src/llm/dsh.ts`。

## 背景

dsh headless task 以 positional 传入（`dsh --profile headless "task"`），命令行总长受 Windows CreateProcess 32K 限制。当前 dsh.ts 以 `messagesToPromptBounded`（保尾砍旧历史）做超限截断兜底——内容没丢完，但历史被砍，上下文不完整。目标是找 dsh 侧规避通道，且尽量与 opencode 统一。

## 一、headless 有无 file/stdin 等价通道？

### 假设（标红）

> 假设：headless 纯 positional，无 file/stdin 隐藏通道。

### 能力对账（`--help` 原文，三源证据之一）

```
$ dsh --profile headless --help
Usage: dsh --profile headless [options] [task...]
Answer one task, print the final assistant message, and exit.
Arguments:
  task        the task text; multiple words are joined by spaces
Options:
  -h, --help  show this help

$ dsh --help   （launcher 层）
Options:
  -V, --version / --profile <name> / --patch <path> (repeatable)
  --dump-config / --dump-default-config
Commands: web [options] [args...]
```

### 源码证据

- `dsh-headless/lib/startup.js:21-25`：`headlessCommand()` 只声明 `argument("[task...]")`，`program.args.join(" ")`（第 35 行）——**纯 positional，无 file/stdin 选项**。
- `dsh-cmdline/lib/index.js:26-30`：`provideCmdline` 把 launcher 解析后的 args 原样冻结为 `cmdlineArgs` snapshot——launcher 不替 app 解析任何 task 相关 flag，app 自己声明（`parseCmdline` 第 54-66 行）。launcher 侧也**无 file/stdin 通道**。
- headless 相关插件清单（`cordis.patch.yml` + `package.json`）：`headless-startup`（解析 positional → provide `HEADLESS_STARTUP_SERVICE`）、`headless-runner`（读 `config.task`）——不存在读文件/读 stdin 的插件。

### 实测输出

无（CLI 面静态证据充分，无需进程实测）。

### 结论

✅ 假设坐实：**headless 无 file/stdin 等价通道**。但「无 CLI 通道」≠「无文件通道」——见第三项，`--patch` overlay 本身就是文件通道（`--patch <path>` 只传短路径），长 prompt 可以从命令行挪进文件。

---

## 二、mcp-catstudy query_db 能否拉全 session 历史？

### 假设（标红）

> 假设：query_db 能按 session 拉 messages（created_at DESC），时延低，猫（行为层）是否主动查全待验证。

### 源码证据

- MCP server `scripts/mcp-server.mjs`（dsh 适配器 patch 已挂 `mcp-catstudy`，stdio）：`query_db` 工具参数 `{ table, conditions, limit }`，`limit` 1-100 默认 50；工具描述明示「查最近消息直接 {table:"messages"} 即可（created_at DESC）」。
- 服务端执行层 `packages/server/src/db/repository/query.ts`：`messages` 表白名单含 `session_id / role / content / created_at / mentions / task_id / dispatch_state` 等，`orderBy: 'created_at'` DESC（第 60-75 行）；`conditions` 支持 `= / > / < / LIKE` 多条件 AND；`limit` 1-100 默认 50（internal.ts:330-332）。
- 端点 `POST /api/internal/db-query`（internal.ts:283）——MCP server 经 `fetch` 调内部端点，鉴权链与 post_message 同款（`x-signal-token` + 信号三要素）。

### 测试证据（已存在的真实断言）

- `internal.test.ts:712`「无条件查 messages → 最近在前（created_at DESC）+ total 全量计数」：fixture 控序（msg-old/mid/recent 显式 created_at），断言 rows 顺序 `[msg-recent, msg-mid, msg-old]`、`total=3`。
- `internal.test.ts:786`「limit 截断 + total 仍为全量」：limit 1 → rows[0]=msg-recent、total=3——`total` 给模型「还有更多」信号，可翻页。

### 实测输出

无 live 实测（cat-study server 未运行）。机制层证据充分：**能按 `conditions: [{column:"session_id", op:"=", value:"<session>"}]` 拉该 session 全部 messages（每次 ≤100 条 + total 提示翻页）**。时延 = 单次 localhost HTTP POST，亚秒级（未实测，标为低风险假设）。

### 「猫是否主动查全」——行为层，当前不成立

机制支持，但当前 dsh猫 systemPrompt（seed-data.ts:264）只写「MCP 三工具 post_message/search_knowledge/query_db」，**没有「启动时先拉历史/上下文不足时主动 query_db」指令**——今天 dsh猫 不会主动拉全历史。若 MCP 外置定稿，需在 systemPrompt 补「启动即查该 session 最近 N 条 + 关键上下文」指令（行为层改造，非机制层）。

### 结论

✅ 机制成立：query_db 能拉全 session 历史（DESC + session_id 过滤 + 翻页）。「猫主动查全」是 prompt 行为问题，需方案配套补指令。

---

## 三、`--patch` 能否覆盖 headless task 来源？（根治方案可行性）

### 假设（标红）

> 假设：cordis 注入点能覆盖 runner 的 task 来源（`HEADLESS_STARTUP_SERVICE.task`），长 prompt 进文件绕 32K。

### 源码证据

- `profile-boot-DG5t9aNs.js:166-198` `composeProfile`：patch 层序 = bundle → profile → home → **`--patch` overlays 最后**，`rows` Map 按 `row.id` **最后写胜**。overlay 行 `- id: headless-runner` 直接覆盖 bundle 里该 loader entry。
- 合并语义（实测 dump 证明）：`name`/`inject` 保留（深度合并），仅 `config.task` 被覆盖——**不是整行替换**。
- `dsh-headless/lib/index.js:105-113`：`apply(ctx, config)` → `run(ctx, config.task, io)`——**runner 的 task 来源是 `config.task`**（bundle 默认 `!!js ctx.headlessStartup.task` 只是引用服务；覆盖后即字面量，不再读服务）。
- `dsh-headless/lib/startup.js:36`：`if (task.trim() === "") program.error(...)`——startup 插件仍要求**非空 positional**（否则拒绝启动），但 runner 忽略其内容。→ 需留一个 dummy positional（如 `run`）。
- loader `!!js` 求值：`cordis-plugin-loader/lib/index.js:279` `new Function("ctx","expr", "with(ctx){return eval(expr)}")`——`process` 全局可达（headless bundle 自带 `!!js process.env.DSH_TOOLS_MODE` / `!!js process.env.DSH_PERMISSION_MODE` 实证）。**但字面量方案不需要 `!!js`**（覆盖后 config.task 是普通字符串，无求值路径），dsh.ts 既有「不依赖 !!js env 求值」红项不触发。

### 实测输出（`--dump-config` 静态 + 运行时）

1. 小字面量 overlay → dump 显示 `headless-runner` 的 `config.task` 被覆盖，`name`/`inject` 保留。
2. **50KB 字面量 overlay** → `--dump-config` exit 0（文件 51KB，task 字段 51015 字符；YAML 重排为 `>-` 块标量，round-trip 正常）——**CreateProcess 32K 被绕过**（内容在文件里，argv 只有短 `--patch <path>`）。
3. **运行时实测**（真实 DeepSeek 调用，2.8s）：
   ```
   dsh --profile headless --patch <overlay> run
   # overlay: config.task = 'Reply with exactly this word and nothing else: PATCH_OVERRIDE_PROVEN'
   # positional = "run"（无关标记）
   → exit 0, stdout = PATCH_OVERRIDE_PROVEN
   ```
   → **runner 用的是 patch 里的 task，不是 positional**。根治方案运行时坐实。

### 结论

✅ 假设坐实：`--patch` overlay 能覆盖 `headless-runner.config.task`，长 prompt 进文件绕 32K，形态不变（一轮一进程），dsh.ts 只改传参方式。运行时已验证。

---

## dsh 规避 32K 方案矩阵

| 方案                                                                    | 绕 32K | 保一轮一进程 | 开发量                                                                                                                                 | 与 opencode 统一                                                             |
| ----------------------------------------------------------------------- | ------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **MCP 工具面外置**（query_db 拉历史，prompt 短传）                      | ✅     | ✅           | 大：prompt 补「启动即查 + 上下文不足主动查」指令；查询翻页/截断/摘要策略；compaction 配合                                              | ✅ 同通道：opencode 也能挂本地 catstudy MCP（flash猫 侧坐实）                |
| **patch 覆盖 config.task 字面量**（长 prompt 进文件，dummy positional） | ✅     | ✅           | 小：dsh.ts `chatStream` 把 `promptArg` 从 positional 移到 patch 的 `headless-runner.config.task`，留 dummy positional                  | ⚠️ 思路同源（长内容进文件 ≈ opencode `-f/--file`），但通道不同，不能代码复用 |
| `!!js` 读 stdin                                                         | ✅     | ✅           | 中且否决：`new Function` 作用域 `require` 不可达，读 stdin 需 node-addon-require-builtin 注入，复杂度高、依赖 !!js 求值（dsh.ts 红项） | ❌                                                                           |

**关键结论**：

- dsh 侧最简 32K 规避 = **patch 文件字面量覆盖 `headless-runner.config.task`**（零新依赖、零形态变化、运行时已验证）。代价只是「长 prompt 写文件」。
- 但 patch 字面量只解决「prompt 传得进」，**不解决「prompt 撑爆 context」**——历史照塞，dsh 侧有 compaction-basic / spill-policy(maxInlineBytes 50000) / token-meter 兜底，但塞得越多越逼近 context 上限。
- **与 opencode 的统一解 = MCP 工具面外置**：两边都能挂 catstudy MCP，prompt 短传 + 工具拉历史，32K 与 context 双缓解。patch 字面量是 dsh 侧低成本兜底（形态对齐 `-f/--file` 思路），可作实施一期、MCP 外置作二期。
- 行为层缺口：当前 dsh猫/各猫 systemPrompt 均未指令「启动即拉历史」——统一方案定稿后须配套补指令 + 拉取策略（触发时机/条数/摘要）。

## 待验证（诚实标注）

- query_db 实时时延（server 未运行，未 live 测；机制层时延 = localhost HTTP，低风险假设）。
- opencode 侧 `-f`/本地 MCP/acp 四路实测——flash猫 调研单，本笔记不重复。
