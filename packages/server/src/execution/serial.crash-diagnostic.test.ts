/**
 * serial.ts 崩溃诊断面测试 — R5 §B（诊断取值单源 `messageOf`）。
 *
 * 靶心 = 「非 Error 抛出物落库只剩一个固定词，无值无归因」。两条真实落点：
 *
 * 1. `serial.ts` 「agent execution failed」漏斗——LLM 段抛出**任意值**（`throw 'string'`
 *    是合法 JS）时 `err.message` 恒 `undefined`，`error_message` 落成 `'unknown error'`。
 *    本文件用 `chatStream` 抛非 Error 驱动，走的就是这条漏斗。
 *
 *    **与库内 `execute crash` 行不是一族**（R6 §A 追因 + R7 除根）：那批行是 `executeRun`
 *    finally **误收口**的历史存量——`catch` 路径**从未触发过**，与「非 Error 抛出物」无关；
 *    R7 已加槽位归属校验除根、该词退役，不再新增。本文件原有的两句表述（「这是全库 19 次
 *    `execute crash` 同源族里可经公开 API 稳定复现的那条」+「`executeRun` 的 catch 走不到」）
 *    **均已失实、已随本笔删除**——后者尤为反：`executeRun` 的 catch 经公开 API **可达**，
 *    入口就是 `serial.crash-label.test.ts` 的 A2（`serial.ts:503` 无 key 分支在所有 try 之外，
 *    该分支里 `emitSystemNotice` 抛错即逃出 `executeOneAgent`，落进 `executeRun` 的 catch）。
 * 2. 用户可见的系统通知文案（`暂时无法回复: ${...}`）。
 *
 * 边界与 `serial.spans.test.ts` 同款：真实 SQLite（`createTestDb()` + `initDb()`，两张
 * 执行表真在）+ 真实 dispatch，只 mock 最外层（LLM registry / git / summarizer / memory
 * / handoff / diff / 信号表 / logger）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AgentConfig, Message, SystemNoticePayload } from '@cat-study/shared'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb, initDb } from '../db/index.js'
import { initRepository } from '../db/repository/index.js'
import { __test_reset } from '../dispatch/index.js'
import { createExecutionEngine } from './serial.js'
import type { ExecutionEngine, ExecutionEngineTestHooks } from './serial.js'
import type { EngineBus, HandoffBus } from './bus.js'
import { ensureAgentWorktree } from '../llm/git-utils.js'

const h = vi.hoisted(() => ({
  logError: vi.fn(),
  gitCommit: vi.fn(),
  collectCommitDiffs: vi.fn(),
  retrieveMemoryContext: vi.fn(),
  buildKnowledgeContext: vi.fn(),
  chatStream: vi.fn(),
}))

vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: h.logError,
  }),
  setLogLevel: vi.fn(),
}))

vi.mock('../llm/registry.js', () => ({
  getAdapterForAgent: vi.fn(() => ({ chatStream: h.chatStream })),
}))

vi.mock('../llm/git-utils.js', () => ({
  gitCommit: h.gitCommit,
  getSessionWorktreePath: vi.fn(() => null),
  ensureSessionWorktree: vi.fn(() => null),
  ensureAgentWorktree: vi.fn(() => null),
  snapshotPackageDeps: vi.fn(() => []),
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
  retrieveMemoryContext: h.retrieveMemoryContext,
  buildKnowledgeContext: h.buildKnowledgeContext,
  currentRetrievalParams: vi.fn(() => ({ topK: 3, maxDistance: 0.6, probeN: 20 })),
}))

vi.mock('../handoff/index.js', () => ({
  shouldHandoff: vi.fn(() => false),
  performHandoff: vi.fn().mockResolvedValue(undefined),
  injectSummaryIntoSystem: vi.fn((s: string) => s),
  generateFullSummary: vi.fn(),
}))

vi.mock('../git/diff-collector.js', () => ({
  collectCommitDiffs: h.collectCommitDiffs,
  GIT_TIMEOUT_MS: 5000,
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execSync: vi.fn(() => '') }
})

vi.mock('../eval/sampler.js', () => ({ maybeScoreSample: vi.fn() }))
vi.mock('../eval/verdict-parser.js', () => ({ recordReviewVerdict: vi.fn() }))
vi.mock('../llm/route-signals.js', () => ({ consumeRouteSignals: vi.fn(() => []) }))
vi.mock('../llm/user-request-signals.js', () => ({ consumeUserRequestSignals: vi.fn(() => []) }))

// ═══ 假 bus（捕获 system notice —— 用户可见文案是诊断的第三个面）═══

let notices: SystemNoticePayload[] = []

function createFakeBus(): EngineBus & HandoffBus {
  return {
    emitMessage: (_m: Message) => {},
    emitSystemNotice: (n: SystemNoticePayload) => {
      notices.push(n)
    },
    emitTyping: () => {},
    emitAgentMessageStatus: () => {},
    emitMessageUpdated: () => {},
    emitContextWindowStats: () => {},
    emitSessionHandoff: () => {},
    emitHandoffFailed: () => {},
  }
}

// ═══ 夹具 ═══

function agent(id: string, name: string): AgentConfig {
  return {
    id,
    name,
    avatar: '🐱',
    systemPrompt: 'You are a cat.',
    llmProvider: 'deepseek',
    llmModel: 'deepseek-v4-pro',
    llmApiKey: 'sk-test',
  }
}
const A1 = agent('agent-1', '店长')

async function runRound(
  engine: ExecutionEngine & ExecutionEngineTestHooks,
  triggerId: string,
  traceId: string
): Promise<boolean> {
  getDb()
    .prepare(
      `INSERT INTO messages (id, session_id, role, content, mentions, task_id)
       VALUES (?, 'session-1', 'user', '你好', '[]', NULL)`
    )
    .run(triggerId)
  return engine.executeAgentsSerial(
    'session-1',
    [A1],
    { id: triggerId, content: '你好', mentions: [] },
    traceId,
    0
  )
}

const logOf = (triggerId: string): any =>
  getDb()
    .prepare('SELECT * FROM execution_logs WHERE triggered_by_message_id = ?')
    .get(triggerId) as any

/** 「agent execution failed」漏斗的日志载荷（`:615` 那条 = 票面点名的同源点） */
const crashLogPayload = (): any | undefined => {
  const calls = h.logError.mock.calls.filter((c) => c[0] === 'agent execution failed')
  return calls.length > 0 ? calls[calls.length - 1]![1] : undefined
}

describe('R5 §B · 执行崩溃诊断可归因', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    notices = []
    __test_reset()
    const db = createTestDb()
    setDb(db)
    initDb()
    initRepository(db)
    db.prepare(
      `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key)
       VALUES ('agent-1', '店长', '🐱', 'p', 'deepseek', 'deepseek-v4-pro', 'sk-test')`
    ).run()
    db.prepare(
      `INSERT INTO sessions (id, title, agent_ids, broadcast_mode)
       VALUES ('session-1', '测试会话', '["agent-1"]', 0)`
    ).run()

    h.retrieveMemoryContext.mockResolvedValue({
      text: '',
      reason: 'no-hit',
      sections: [],
      stats: {},
    })
    h.buildKnowledgeContext.mockImplementation(async (_c: string, onHits?: (n: number) => void) => {
      onHits?.(0)
      return ''
    })
    h.collectCommitDiffs.mockResolvedValue(null)
    h.gitCommit.mockReturnValue(null)
    vi.mocked(ensureAgentWorktree).mockReturnValue(null)
    h.chatStream.mockImplementation(async function* () {
      yield { content: '收到', kind: 'text' }
    })
  })

  afterEach(() => {
    resetDb()
  })

  it('基线 · 正常执行落 completed 且 error_message 保持 null（本票零回归面）', async () => {
    const engine = createExecutionEngine(createFakeBus())
    await runRound(engine, 'msg-ok', 'trace-ok')
    expect(logOf('msg-ok').status).toBe('completed')
    expect(logOf('msg-ok').error_message).toBeNull()
  })

  it('B1 · `throw "boom-string"` → error_message 含 boom-string（不再是固定词）', async () => {
    h.chatStream.mockImplementation(() => {
      throw 'boom-string'
    })
    const engine = createExecutionEngine(createFakeBus())
    await runRound(engine, 'msg-b1', 'trace-b1')

    const row = logOf('msg-b1')
    expect(row.status).toBe('failed')
    expect(row.error_message).toContain('boom-string')
    // 判别力锚：修复前该列是 `'unknown error'`（`err.message` 对字符串恒 undefined）
    expect(row.error_message).not.toBe('unknown error')
  })

  it('B1b · 异步生成器内 `throw "boom-async"` → 同样可归因', async () => {
    h.chatStream.mockImplementation(async function* () {
      throw 'boom-async'
      // eslint-disable-next-line no-unreachable
      yield { content: '', kind: 'text' }
    })
    const engine = createExecutionEngine(createFakeBus())
    await runRound(engine, 'msg-b1b', 'trace-b1b')

    expect(logOf('msg-b1b').error_message).toContain('boom-async')
  })

  it('B2 · `throw { code: 42 }` → 落可辨识信息，不是 `[object Object]`', async () => {
    h.chatStream.mockImplementation(() => {
      throw { code: 42 }
    })
    const engine = createExecutionEngine(createFakeBus())
    await runRound(engine, 'msg-b2', 'trace-b2')

    const em = logOf('msg-b2').error_message as string
    expect(em).toContain('42')
    expect(em).not.toBe('[object Object]')
    expect(em).not.toBe('unknown error')
  })

  it('B3 · `throw new Error("x")` → error_message 逐字 === "x"（Error 路径零回归）', async () => {
    h.chatStream.mockImplementation(() => {
      throw new Error('x')
    })
    const engine = createExecutionEngine(createFakeBus())
    await runRound(engine, 'msg-b3', 'trace-b3')

    expect(logOf('msg-b3').error_message).toBe('x')
  })

  it('B4 · 取诊断失败（循环引用）→ 不抛、落兜底值、收口路径照常走完', async () => {
    const circular: Record<string, unknown> = { k: 1 }
    circular.self = circular
    h.chatStream.mockImplementation(() => {
      throw circular
    })
    const engine = createExecutionEngine(createFakeBus())

    await expect(runRound(engine, 'msg-b4', 'trace-b4')).resolves.toBeDefined()
    const row = logOf('msg-b4')
    expect(row.status).toBe('failed')
    expect(row.error_message).toBe('unknown error') // 取不出信息 → 兜底词

    // 收口照常走完：槽位已释放 ⇒ 同一只猫的下一轮能真的跑起来（栈死则这里排队不执行）
    h.chatStream.mockImplementation(async function* () {
      yield { content: '收到', kind: 'text' }
    })
    await runRound(engine, 'msg-b4-next', 'trace-b4-next')
    expect(logOf('msg-b4-next').status).toBe('completed')
  })

  it('B5 · 票面点名的同源日志点（`agent execution failed`）同样落出可辨识 error', async () => {
    h.chatStream.mockImplementation(() => {
      throw 'boom-log'
    })
    const engine = createExecutionEngine(createFakeBus())
    await runRound(engine, 'msg-b5', 'trace-b5')

    expect(crashLogPayload()?.error).toBe('boom-log')
    // 判别力锚：修复前该字段是 `undefined`（`err.message` 对字符串恒 undefined）
    expect(crashLogPayload()?.error).not.toBeUndefined()
  })

  it('B6 · 用户可见文案带出可辨识原因（不是「系统错误」空壳）', async () => {
    h.chatStream.mockImplementation(() => {
      throw 'boom-notice'
    })
    const engine = createExecutionEngine(createFakeBus())
    await runRound(engine, 'msg-b6', 'trace-b6')

    const notice = notices.find((n) => n.content.includes('暂时无法回复'))
    expect(notice).toBeTruthy()
    expect(notice!.content).toContain('boom-notice')
    expect(notice!.content).not.toContain('系统错误')
  })

  it('B7 · 取不出信息时用户可见文案退回兜底词（不落空尾）', async () => {
    h.chatStream.mockImplementation(() => {
      throw {}
    })
    const engine = createExecutionEngine(createFakeBus())
    await runRound(engine, 'msg-b7', 'trace-b7')

    const notice = notices.find((n) => n.content.includes('暂时无法回复'))
    expect(notice!.content).toContain('系统错误')
  })
})
