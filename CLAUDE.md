# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

CatStudy is a multi-agent chat platform where users chat with AI cat characters in sessions. Each cat agent has persistent identity, independent LLM configuration, and long-term vector memory. The system runs as a local monorepo with a Fastify + Socket.IO backend and a Vue 3 frontend.

## Commands

```bash
pnpm install              # Install all dependencies
pnpm dev                  # Start server (3200) + web (5173) via scripts/dev.js
pnpm dev:server           # Server only
pnpm dev:web              # Web only
pnpm stop                 # Force-kill processes on ports 3200/5173-5175 (scripts/stop.js)
pnpm build                # Build all packages (pnpm -r build)

# Seeding
pnpm seed                 # Upsert demo cats (idempotent) — runs scripts/seed.js
npx tsx packages/server/src/seed.ts --reset    # Wipe and rebuild

# Testing (vitest workspace: shared → server → web)
pnpm test                 # All tests across the 3 packages
pnpm test:shared          # Shared package only (Zod schemas + events)
pnpm test:server          # Server package only
pnpm test:web             # Web package only
pnpm test:watch           # Watch mode
pnpm test:coverage        # With coverage report
pnpm test -- --reporter=verbose  # Per-test output

# Type checking
pnpm lint                 # tsc --noEmit across all packages
```

## Monorepo structure

```
packages/shared/   →  Types, Zod schemas, Socket.IO event constants
packages/server/   →  Fastify + Socket.IO + SQLite + LLM adapters + dispatch + memory
packages/web/      →  Vue 3 + Vite + Pinia + Socket.IO client
scripts/           →  dev.js (process launcher), seed.js (seed wrapper), stop.js (port cleanup)
.claude/           →  settings.local.json (permissions) + custom skills (session-summary)
.agents/           →  Third-party skills from mattpocock/skills (locked via skills-lock.json)
docs/adr/          →  Architecture Decision Records (6 files)
docs/sessions/     →  Session summaries (cat-study-*-summary.md, 8 files)
```

`pnpm-workspace.yaml` allows native builds for `better-sqlite3`, `sqlite-vec`, `esbuild`, `vue-demi`, `protobufjs`, `sharp`, `onnxruntime-node`.

## Architecture (the big picture)

### Startup sequence

```
.env loading (packages/server/src/env.ts, must be first import)
  → initDb() (SQLite WAL + sqlite-vec + migrations)
  → auto-seed if agents table is empty (buildDemoAgents())
  → Redis connect (optional, failure is non-blocking)
  → Fastify listen → attach Socket.IO
  → graceful shutdown (SIGINT/SIGTERM)
```

`scripts/dev.js` spawns server and web as separate `node` processes (not `pnpm --parallel`) to avoid Windows shell output-buffering issues. Server starts first with a 500ms head start. All addresses use `127.0.0.1` (not `localhost`) to avoid Windows IPv4/IPv6 ambiguity. The Vite dev server proxies `/api` and `/socket.io` requests to `http://127.0.0.1:3200` so the web frontend sees a single origin.

### Message flow

```
User types "@店长 你好" in web UI
  → Socket.IO Events.SEND_MESSAGE
  → connector writes message to SQLite
  → broadcast to session room
  → dispatch() checks each mentioned agent's slot
    → idle → executeAgent() → slot becomes 'thinking' (LLM reasoning) → 'busy' (generating reply)
    → not idle → FIFO queue (waiting for slot to release)
  → runAgentReply():
    1. Build context: filter messages relevant to THIS agent
       (own replies, user messages @mentioning them, broadcast messages)
    2. Retrieve vector memories → inject into system prompt
    3. Call LLM adapter chatStream() → stream chunks via AGENT_TYPING events
    4. Write final reply to SQLite → emit NEW_MESSAGE
  → completeExecution() → release slot → dequeue next
```

### Context filtering (not prompt engineering)

Each agent only sees messages relevant to itself — not all messages in the session. Rules:
- Agent's own replies → visible
- User messages that @mention this agent → visible
- User messages with no @mentions (broadcast) → visible
- User messages @mentioning OTHER agents → discarded
- Other agents' replies → visible only if broadcast mode is on

This is more reliable than telling the LLM "don't speak for others."

### Dispatch: single-slot FIFO

Each agent has exactly one execution slot (`agentSlots` Map, in-memory). @mention multiple agents → they execute serially in order, so later agents see earlier agents' replies (like real group chat). Max execution time is 180s per agent (via `Promise.race` timeout). Slot state is published to Redis `agent:{name}:status` channel when available.

### LLM adapter pattern

`LLMAdapter` interface: `chatStream(messages, options) → AsyncIterable<Chunk>`. Three implementations:
- **DeepSeek** (`deepseek.ts`): HTTP Chat Completions API, streaming SSE
- **Claude** (`claude.ts`): Spawns Claude Code CLI as child process
- **OpenAI** (`openai.ts`): Spawns Codex CLI as child process

`registry.ts` caches adapters by `provider:apiKey` key. Each agent independently chooses its provider/model/apiKey.

### Memory system

Local embeddings via `@huggingface/transformers` (Xenova/bge-small-zh-v1.5, 512-dim). Pipeline:
1. User message → `embedText()` → `saveMessageMemory()` stores one row per agent (same embedding BLOB)
2. Before LLM call → `buildMemoryContext()` embeds trigger text → `searchMemories()` via `vec_distance_cosine()` in sqlite-vec → top-K results formatted and appended to system prompt
3. Dedup on write: skip if cosine distance to any existing memory < `MEMORY_DEDUP_THRESHOLD` (default 0.20)

Memory is fire-and-forget — failures are logged but never block the message flow.

### Database

SQLite at `packages/server/data/cat-study.db`. Five tables: `agents`, `sessions`, `messages`, `memories`, `execution_logs`. Column naming is `snake_case` in DB, `camelCase` in TypeScript — conversion happens at API boundary. Migrations are additive `ALTER TABLE` statements wrapped in try/catch (skip if column exists). `agent_ids` and `mentions` are stored as JSON strings.

## Key conventions

### Domain terminology

See `CONTEXT.md` for the full glossary. Critical terms: **Agent** (cat character, not bot), **Session** (chat thread), **Slot** (execution capacity, one per agent), **Mention** (@agent-name), **Memory** (vector-stored semantic recall), **Connector** (platform adapter, not plugin).

### Testing patterns

- **`:memory:` SQLite** for integration tests — no disk I/O, auto-cleanup, FK constraints work. Inject via `setDb()/resetDb()` hooks (8 lines of test-only code in production).
- **Mock only at module boundaries**: Zod schemas, pure functions, SQLite behavior, and Fastify `app.inject()` all run REAL code. Only `ioredis` is mocked.
- **Test helpers** in `packages/server/src/test-helpers.ts`: `createTestDb()` (in-memory with full schema, no sqlite-vec) and `buildTestApp()` (minimal Fastify).
- **Dispatch tests** call `__test_reset()` between cases to clear the module-level `agentSlots`/`agentQueues` Maps.

### Session summary format

After each development session, generate a summary using the `session-summary` skill (defined at `.claude/skills/session-summary/SKILL.md`). Output goes to `docs/sessions/cat-study-<slug>-summary.md`. Required sections: What (file change table, ordered shared→server→web→scripts→root), Why (design reasoning with ASCII diagrams), Tradeoff (rejected alternatives table), Open Questions (real uncertainties, not bugs), Next Action (checkbox-style, completed items struck through).

### Environment variables

See `.env.example`. Key ones: `DS_KEY` (DeepSeek API key, used by demo cats), `HF_ENDPOINT` (set to `https://hf-mirror.com` for mainland China), `MEMORY_*` family for memory tuning, `MEMORY_ENABLED` (set to `false` in server tests to skip embedding model loading). The `.env` loader (`packages/server/src/env.ts`) does NOT use the `dotenv` package — it reads the file manually and only sets variables not already in `process.env`.

### Windows considerations

- All addresses use `127.0.0.1` instead of `localhost` (avoids IPv4/IPv6 resolution ambiguity)
- Process spawning avoids `.cmd` wrappers and `shell: true` — use `node path/to/cli.mjs` directly
- `scripts/stop.js` uses `netstat -ano | findstr` + `taskkill /F /T /PID` for cleanup
