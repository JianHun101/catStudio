/**
 * serial.ts 探针模式闸测试（票 `docs/run/probe-no-resume/`，判据见 `probe-mode.ts`）。
 *
 * 靶心 = 探针实例**零 CLI spawn**。判据选三层同面读数，任何一层单独绿都不够：
 * ①适配器没被调（`chatStream` 零调用）②执行审计没落（`execution_logs` 零行）
 * ③触发消息没被标态（`dispatch_state` 保持 NULL）。三层任一漏掉，就会出现
 * 「不 spawn 但库里留下一条 running 行」这类半闸形态。
 *
 * ── 为什么不需要 `vi.resetModules()` ──
 * `isProbeMode()` **读在调用点**（见 `probe-mode.ts` 文件头），故同一进程内逐用例
 * 改 env 即刻生效——与 `serial.hard-timeout-disabled.test.ts` 的加载期常量不同。
 * 那条链的整图重载在这里是纯粹的负担（还会让测试侧的 `setDb()` 打在旧模块实例上）。
 *
 * 边界与 `serial.test.ts` 同款：真实 SQLite + 真实 dispatch，只 mock 最外层
 * （LLM registry / git / summarizer / handoff / memory / diff / 信号表 / logger）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentConfig } from '@cat-study/shared'
import type { ExecutionEngine, ExecutionEngineTestHooks } from './serial.js'
import type { EngineBus, HandoffBus } from './bus.js'

// ═══ mock 实例建在模块图之外（vi.fn 句柄在用例间共享，断言直接读它）═══

const h = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  chatStream: vi.fn(),
}))

vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    // 探针闸的跳过记录只在这条通道上可见——「闸门不静默」的断言面
    info: h.logInfo,
    warn: h.logWarn,
    error: h.logError,
  }),
  setLogLevel: vi.fn(),
}))

vi.mock('../llm/registry.js', () => ({
  getAdapterForAgent: vi.fn(() => ({ chatStream: h.chatStream })),
}))

vi.mock('../llm/git-utils.js', () => ({
  gitCommit: vi.fn(),
  getSessionWorktreePath: vi.fn(() => null),
  ensureSessionWorktree: vi.fn(() => null),
  ensureAgentWorktree: vi.fn(() => null),
  snapshotPackageDeps: vi.fn(() => ({})),
  diffNewPackages: vi.fn(() => []),
  cleanGitEnv: vi.fn(() => ({ ...process.env })),
}))

vi.mock('../llm/worktree-fanin.js', () => ({
  ensureExecutionWorktree: vi.fn(() => null),
}))

vi.mock('../summarizer/index.js', () => ({
  updateRunningSummary: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../memory/index.js', () => ({
  retrieveMemoryContext: vi.fn().mockResolvedValue({
    text: '',
    reason: 'no-hit',
    sections: [],
    stats: {},
  }),
  buildKnowledgeContext: vi.fn().mockResolvedValue(''),
  currentRetrievalParams: vi.fn(() => ({ topK: 3, maxDistance: 0.6, probeN: 20 })),
  shouldSkipA2aMemory: vi.fn(() => false),
  skippedRetrievalResult: vi.fn(() => ({
    text: '',
    reason: 'skipped-a2a',
    sections: [],
    stats: {},
  })),
}))

vi.mock('../handoff/index.js', () => ({
  shouldHandoff: vi.fn(() => false),
  performHandoff: vi.fn().mockResolvedValue(undefined),
  injectSummaryIntoSystem: vi.fn((s: string) => s),
  generateFullSummary: vi.fn(),
}))

vi.mock('../git/diff-collector.js', () => ({
  collectCommitDiffs: vi.fn().mockResolvedValue(null),
  GIT_TIMEOUT_MS: 5000,
}))

// 顶层收尾的脏文件清理用真实 execSync 会命中真实仓库——恒返回空串（"干净"跳过）
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execSync: vi.fn(() => '') }
})

vi.mock('../eval/sampler.js', () => ({ maybeScoreSample: vi.fn() }))
vi.mock('../llm/route-signals.js', () => ({ consumeRouteSignals: vi.fn(() => []) }))
vi.mock('../llm/user-request-signals.js', () => ({ consumeUserRequestSignals: vi.fn(() => []) }))

// verdict-parser 是**部分工厂**的老踩点（serial.test.ts 第四次踩时改的 importOriginal）：
// 只列 recordReviewVerdict ⇒ serial.ts 拿到的 parseReviewVerdict 是 undefined。
vi.mock('../eval/verdict-parser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../eval/verdict-parser.js')>()
  return { ...actual, recordReviewVerdict: vi.fn() }
})

import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository } from '../db/repository/index.js'
import { createExecutionEngine } from './serial.js'
import * as dispatchModule from '../dispatch/index.js'
import { PROBE_MODE_ENV } from '../probe-mode.js'

const SESSION = 'session-1'
const TRIGGER = 'trigger-1'
const TRACE = 'trace-1'

const DEFAULT_AGENT: AgentConfig = {
  id: 'agent-1',
  name: '店长',
  avatar: '🐱',
  systemPrompt: 'You are a cat.',
  llmProvider: 'deepseek',
  llmModel: 'deepseek-v4-pro',
  llmApiKey: 'sk-test',
}

function createFakeBus(): EngineBus & HandoffBus {
  return {
    emitMessage: () => {},
    emitSystemNotice: () => {},
    emitTyping: () => {},
    emitAgentMessageStatus: () => {},
    emitMessageUpdated: () => {},
    emitContextWindowStats: () => {},
    emitSessionHandoff: () => {},
    emitHandoffFailed: () => {},
  }
}

/** 三层同面读数的后两层：执行审计行数 / 触发消息的 dispatch_state */
function auditRows(): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM execution_logs WHERE triggered_by_message_id = ?')
    .get(TRIGGER) as { n: number }
  return row.n
}
function triggerState(): string | null {
  const row = getDb().prepare('SELECT dispatch_state FROM messages WHERE id = ?').get(TRIGGER) as
    { dispatch_state: string | null } | undefined
  return row?.dispatch_state ?? null
}

/** 起一轮真实执行（probe 开关由用例提前布置 env） */
async function runOnce(): Promise<boolean> {
  const engine: ExecutionEngine & ExecutionEngineTestHooks = createExecutionEngine(createFakeBus())
  return engine.executeAgentsSerial(
    SESSION,
    [DEFAULT_AGENT],
    { fromAgent: false, id: TRIGGER, content: '你好', mentions: [] },
    TRACE,
    0
  )
}

describe('execution/serial — 探针模式闸（票 probe-no-resume）', () => {
  beforeEach(() => {
    delete process.env[PROBE_MODE_ENV]
    vi.clearAllMocks()
    const db = createTestDb()
    setDb(db)
    initRepository(db)
    dispatchModule.__test_reset()

    db.prepare(
      `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
       VALUES ('agent-1', '店长', '🐱', 'You are a cat.', 'deepseek', 'deepseek-v4-pro', 'sk-test')`
    ).run()
    db.prepare(
      `INSERT INTO sessions (id, title, agent_ids, broadcast_mode)
       VALUES (?, '测试会话', '["agent-1"]', 0)`
    ).run(SESSION)
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, mentions)
       VALUES (?, ?, 'user', '你好', '[]')`
    ).run(TRIGGER, SESSION)

    h.chatStream.mockImplementation(async function* () {
      yield { content: '收到', kind: 'text' }
    })
  })

  afterEach(() => {
    delete process.env[PROBE_MODE_ENV]
    resetDb()
  })

  it('关闸腿：执行真跑（适配器被调 + 审计落行 + 触发消息被标态）', async () => {
    await runOnce()

    // 反对照的承重面：夹具必须真够得着执行链——否则下面那条「零调用」可能只是
    // 夹具没造对（恒真的假绿门）
    expect(h.chatStream).toHaveBeenCalledTimes(1)
    expect(auditRows()).toBe(1)
    expect(triggerState()).not.toBeNull()
  })

  it('开闸腿：三层读数同时为零（不 spawn / 不落审计 / 不标态）', async () => {
    process.env[PROBE_MODE_ENV] = '1'

    const ret = await runOnce()

    expect(h.chatStream).not.toHaveBeenCalled()
    expect(auditRows()).toBe(0)
    expect(triggerState()).toBeNull()
    // 返回值 = 「是否执行过适配器」——探针下恒 false，让上层的脏文件清理也短路
    expect(ret).toBe(false)
  })

  it('开闸腿：闸门不静默——跳过记录带路径与触发面，可在探针日志里逐条读出', async () => {
    process.env[PROBE_MODE_ENV] = '1'

    await runOnce()

    const skipped = h.logWarn.mock.calls.map((c) => String(c[0]))
    expect(skipped.some((m) => m.includes('探针模式') && m.includes('拒绝执行整轮'))).toBe(true)
  })

  it('直调 execute(cmd) 的路径也被闸住（轮级闸覆盖不到它）', async () => {
    process.env[PROBE_MODE_ENV] = '1'
    const engine = createExecutionEngine(createFakeBus())

    const ret = await engine.execute({
      sessionId: SESSION,
      agentId: 'agent-1',
      triggerMessageId: TRIGGER,
      triggerContent: '你好',
      mentions: [],
      traceId: TRACE,
      depth: 0,
      pendingTriggers: [],
    })

    expect(ret).toBe(false)
    expect(h.chatStream).not.toHaveBeenCalled()
    expect(auditRows()).toBe(0)
  })
})
