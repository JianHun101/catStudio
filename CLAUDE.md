# CLAUDE.md

## Commands

```bash
pnpm dev                  # server (:3200) + web (:5173) via scripts/dev.js → 实验库 cat-study-dev.db
pnpm start                # dev.js --mode production → 主库 cat-study.db（日常真实使用，记忆延续）
pnpm dev:server / dev:web # single package
pnpm stop                 # kill ports 3200, 5173-5175
pnpm test                 # vitest workspace (shared → server → web)
pnpm test:shared / :server / :web / :watch / :coverage
pnpm lint                 # tsc --noEmit across all packages
pnpm seed                 # upsert demo cats (idempotent)
npx tsx packages/server/src/seed.ts --reset  # wipe + rebuild
pnpm build                # pnpm -r build
```

## Structure

```
packages/shared/  →  Types, Zod schemas, Socket.IO event constants
packages/server/  →  Fastify + Socket.IO + SQLite + LLM adapters + dispatch + memory
packages/web/     →  Vue 3 + Vite + Pinia + Socket.IO client
scripts/          →  dev.js, seed.js, stop.js
.claude/          →  settings + custom skills
docs/adr/         →  7 architecture decision records
```

## Architecture

**Startup**: `.env` (manual parse, no dotenv) → `initDb()` (SQLite WAL + sqlite-vec + migrations) → auto-seed empty agents table → Redis (optional, failure non-blocking) → Fastify + Socket.IO → SIGINT/SIGTERM graceful shutdown.

**Message flow**: `SEND_MESSAGE` → write to SQLite → broadcast to session room → `dispatch()`:

- Each mentioned agent: idle slot → `executeAgent()`; busy → FIFO queue
- `runAgentReply()`: filter context → retrieve vector memories → `chatStream()` → `AGENT_TYPING` streaming → write reply to SQLite → `NEW_MESSAGE`
- `completeExecution()` → release slot → dequeue next

**Context filtering** (each agent only sees relevant messages):

- Own replies ✓
- User messages @mentioning this agent ✓
- User messages with no @mentions (broadcast) ✓
- User messages @mentioning OTHER agents ✗
- Other agents' replies → only if broadcast mode on

**Dispatch**: single-slot FIFO per agent (`agentSlots` Map, in-memory). Serial execution in @mention order. Hard timeout via `AGENT_HARD_TIMEOUT_MS` (30min); CLI idle timeout 20min (`cli-utils.ts`).

**LLM adapters**: `chatStream(messages, options) → AsyncIterable<Chunk>`. DeepSeek (HTTP SSE), Claude (CLI child process), OpenAI (Codex CLI). Cached per `provider:apiKey` in `registry.ts`.

**External tool form selection**: any external CLI/tool form decision must pass the ADR 0007 checklist (docs/adr/0007-external-tool-form-selection-checklist.md) — 能力对账前置 / 假设标红+实测对称 / 简单形态默认+复杂举证倒置 / 决策留痕.

**Memory**: local embeddings via Xenova/bge-small-zh-v1.5 (512-dim). Pipeline: embed → dedup check (cosine < `MEMORY_DEDUP_THRESHOLD`, default 0.20) → store. Retrieval: embed trigger → `vec_distance_cosine()` → top-K → system prompt. Fire-and-forget (failures don't block).

**Database**: SQLite `packages/server/data/cat-study.db`. Tables: `agents`, `sessions`, `messages`, `memories`, `execution_logs`. snake_case↔camelCase at API boundary. Migrations: additive ALTER TABLE in try/catch. `agent_ids`/`mentions` as JSON strings.

## Conventions

**Testing**:

- `:memory:` SQLite via `setDb()/resetDb()` hooks — no disk, FK constraints work
- Mock only at boundaries — only `ioredis`; Zod, pure functions, SQLite, Fastify all real
- Helpers: `packages/server/src/test-helpers.ts` (`createTestDb`, `buildTestApp`)
- Dispatch: `__test_reset()` between cases (clears `agentSlots`/`agentQueues`)

**测试摆放约定**（测试不零散）：

- 测试跟随被测主模块，同目录同名前缀（co-located）——`xxx.ts` 的测试就是 `xxx.test.ts`，不设集中目录；一个测试文件只测一个被测模块
- 跨模块测试挂主模块旁（`connectors/socketio.test.ts` 范式：真实 SQLite + 捕获 socket handler，只 mock 最外层）
- 测试性质四类：纯单元（无 I/O）/ 模块测试（只 mock 边界）/ 组装式模块（真实 DB + handler）/ 静态源断言（web `?raw` 读 SFC）
- 辅助文件白名单（原地保留）：`server/src/test-helpers.ts`、`web/src/test-setup.ts`——仅供测试的辅助，非测试文件
- e2e 两级：CLI 级（自包含、可进 CI）与系统级（真实 server + LLM，手动跑），命名 `.e2e.mjs` 跟随被测脚本同目录，**不纳入** vitest include
- vitest include：server/shared/web 统一 `src/**/*.test.ts`；scripts 无 src 用 `**/*.test.js`（`.e2e.mjs` 天然隔离）

**Domain glossary**: see `CONTEXT.md`. Key terms: Agent (cat character), Session (chat thread), Slot (execution unit), Memory (vector recall), Connector (platform adapter).

**收口链**（A2A 风暴治理，3d5e6cf 起机制层生效）：

- 审查结论分流：✅可合并 → 行首@架构师（收口信号直接到位）；⚠️建议修改 / ❌需重做 → 行首@作者（要改的才回作者）——结论内容仍归请求人，细节在消息正文完整给出，只改投递目标
- 实施猫提交后无需主动跟进（审查链自动收口）；若收到 ✅（兜底路径，分流失败时原链仍通）→ 行首@架构师 请收口，不自行合并，收口决策归店长
- 店长收口动作序列：确认审查结论 → ff-only 合并 → 更新 `.push-gate` → 推送 main/dev → 切回 dev
- 会话 worktree 收口（会话隔离单的提交在 `session/<8位id>` 分支）：ff-only 前先 `git merge session/<8位id>` 回 dev → `git worktree remove --force ../catStudy-sessions/<8位id>`（或 `removeSessionWorktree(<sessionId>)`）→ 删除 `session/<8位id>` 分支 → 再走标准收口序列
- 实施猫完成不单独@店长汇报（店长从审查结论自动获知），遇问题/卡住才@店长

**Env**: `.env.example` for full list. Loader at `packages/server/src/env.ts` (manual parse, NO `dotenv` — must be first import). Key: `DS_KEY`, `HF_ENDPOINT`, `MEMORY_ENABLED` (set `false` in server tests).

**Windows**:

- Use `127.0.0.1` not `localhost` (IPv4/IPv6 ambiguity)
- Spawn: `node path/to/cli.mjs` — avoid `.cmd` wrappers and `shell: true`
- Dev proxy: Vite proxies `/api` + `/socket.io` → `http://127.0.0.1:3200`
