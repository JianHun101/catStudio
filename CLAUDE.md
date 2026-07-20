# CLAUDE.md

## Commands

```bash
pnpm dev                  # server (:3200) + web (:5173) via scripts/dev.js
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
docs/adr/         →  6 architecture decision records
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

**Memory**: local embeddings via Xenova/bge-small-zh-v1.5 (512-dim). Pipeline: embed → dedup check (cosine < `MEMORY_DEDUP_THRESHOLD`, default 0.20) → store. Retrieval: embed trigger → `vec_distance_cosine()` → top-K → system prompt. Fire-and-forget (failures don't block).

**Database**: SQLite `packages/server/data/cat-study.db`. Tables: `agents`, `sessions`, `messages`, `memories`, `execution_logs`. snake_case↔camelCase at API boundary. Migrations: additive ALTER TABLE in try/catch. `agent_ids`/`mentions` as JSON strings.

## Conventions

**Testing**:

- `:memory:` SQLite via `setDb()/resetDb()` hooks — no disk, FK constraints work
- Mock only at boundaries — only `ioredis`; Zod, pure functions, SQLite, Fastify all real
- Helpers: `packages/server/src/test-helpers.ts` (`createTestDb`, `buildTestApp`)
- Dispatch: `__test_reset()` between cases (clears `agentSlots`/`agentQueues`)

**Domain glossary**: see `CONTEXT.md`. Key terms: Agent (cat character), Session (chat thread), Slot (execution unit), Memory (vector recall), Connector (platform adapter).

**Env**: `.env.example` for full list. Loader at `packages/server/src/env.ts`. Key: `DS_KEY`, `HF_ENDPOINT`, `MEMORY_ENABLED` (set `false` in server tests).

**Windows**:

- Use `127.0.0.1` not `localhost` (IPv4/IPv6 ambiguity)
- Spawn: `node path/to/cli.mjs` — avoid `.cmd` wrappers and `shell: true`
- Dev proxy: Vite proxies `/api` + `/socket.io` → `http://127.0.0.1:3200`
