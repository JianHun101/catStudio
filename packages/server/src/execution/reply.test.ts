/**
 * reply.ts 测试 — 同锚历史回捞上界（T-G 验收④）。
 *
 * 只覆盖 `selectTaskHistory` 这个**纯函数**截取器（`runAgentReply` 主流程需 LLM 适配器，
 * 不在本文件范围）。回捞病灶实测：单锚名下 20 条 / 7.7 万字符，原实现**无任何上限**
 * ⇒ 整段并入上下文。
 *
 * 计数口径（`estimateTokens`，@cat-study/shared）：`汉字数 × 1.5 + 非汉字数 × 0.25`，
 * 本文件每条再叠加 50 的 role 前缀开销 ⇒ n 个汉字的条目 = `ceil(n*1.5) + 50` token。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import {
  runAgentReply,
  selectTaskHistory,
  recordRetrievalTrace,
  TASK_HISTORY_MAX_MESSAGES,
  TASK_HISTORY_BUDGET_TOKENS,
} from './reply.js'
import { createEngineState } from './state.js'
import { createExecTrace } from './trace.js'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb, initDb } from '../db/index.js'
import {
  initRepository,
  executionLogs as execLogsRepo,
  retrievalEvents as retrievalRepo,
} from '../db/repository/index.js'
import { HYBRID_POOL_PER_QUERY } from '../db/repository/chunks.js'
import { memoryRoutes } from '../routes/memory.js'
import { getAdapterForAgent } from '../llm/registry.js'
import { retrieveMemoryContext, buildKnowledgeContext } from '../memory/index.js'
import type { MemoryContextResult } from '../memory/index.js'

// ─── 协作者 mock（只 mock 边界：LLM 适配器 / 子进程 / 外部 HTTP）──────────────
// 组装式用例（下方「M1 广播前连线」）要跑**真** `runAgentReply`：DB、仓储、bus 捕获、
// 上下文组装全是真的，只有「会 spawn 子进程 / 连外部服务」的协作者被换掉——
// 与 `connectors/socketio.test.ts` 同款边界。
vi.mock('../llm/registry.js', () => ({ getAdapterForAgent: vi.fn() }))
// 建 worktree 是 `execFileSync` 起 git 的同步阻塞调用，测试里不建树 ⇒ 返回 null
// （生产语义：null = 不传 cwd，适配器落 workspace/，见 reply.ts 调用点注释）
vi.mock('../llm/worktree-fanin.js', () => ({ ensureExecutionWorktree: vi.fn(() => null) }))
vi.mock('../llm/git-utils.js', () => ({
  snapshotPackageDeps: vi.fn(() => ({})),
  diffNewPackages: vi.fn(() => []),
}))
// diff 采集：内部 `execFile` 起 git（最长 5s）；本组不验它，返回 null = 「没采到」
vi.mock('../git/diff-collector.js', () => ({
  collectCommitDiffs: vi.fn(async () => null),
  GIT_TIMEOUT_MS: 5000,
}))
vi.mock('../llm/user-request-signals.js', () => ({ consumeUserRequestSignals: vi.fn(() => []) }))
vi.mock('../connectors/replyBus.js', () => ({ emitAgentReply: vi.fn() }))
vi.mock('../handoff/index.js', () => ({
  shouldHandoff: vi.fn(() => false),
  performHandoff: vi.fn(async () => {}),
  injectSummaryIntoSystem: vi.fn((s: string) => s),
  generateFullSummary: vi.fn(async () => null),
}))
// **partial factory**：`currentRetrievalParams` / `skippedRetrievalResult` 等导出必须留真
// ——`recordRetrievalTrace` 消费前者，整包替换会让同文件的 R1 用例当场 TypeError。
vi.mock('../memory/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../memory/index.js')>()
  return {
    ...actual,
    retrieveMemoryContext: vi.fn(),
    buildKnowledgeContext: vi.fn(async () => ''),
  }
})

/** 一条可落盘的检索结果（够跑通组装，字段值本身由 memory 侧用例保真） */
function makeResult(over: Partial<MemoryContextResult> = {}): MemoryContextResult {
  return {
    text: '\n\n【相关记忆】\n1. 正文',
    reason: 'ok',
    sections: [],
    stats: {
      queries: 1,
      candidateChunks: 1,
      sections: 1,
      droppedSections: 0,
      contextTokens: 12,
      budgetTokens: 8000,
      truncated: false,
      retrievalMs: 37,
      thresholdMaxDistance: 0.6,
      paramTopK: 3,
      paramProbeN: 20,
      queryTraces: [{ queryIndex: 0, queryText: '原话', queryEmbedOk: true }],
      candidates: [
        {
          queryIndex: 0,
          source: 'final',
          channel: 'vector',
          docPath: 'docs/adr/0002-b.md',
          sectionAnchor: '## 决策',
          contentHash: 'h1',
          chunkId: 7,
          breadcrumb: 'b',
          bodyHead: '候选片正文全文',
          statusAtQuery: null,
          distance: 0.293,
          rank: 0,
          rrfScore: 0.016,
          finalRank: 0,
          passedStatusFilter: null,
          injected: true,
          sectionRank: 0,
          injectedPosition: 1,
          droppedReason: null,
        },
      ],
      blockedByStatus: 0,
      droppedByThreshold: 0,
    },
    ...over,
  }
}

/** 生成一条同锚历史（数组下标越小越旧） */
function msg(i: number, hanChars: number): { id: string; content: string } {
  return { id: `m${i}`, content: '汉'.repeat(hanChars) }
}

describe('execution/reply — selectTaskHistory（T-G 验收④ 回捞上界）', () => {
  it('超 token 预算 → 丢**最旧**、保最新（旧实现无上限，断言必红）', () => {
    // 每条 1000 汉字 = 1550 token；预算 3200 ⇒ 只留最新 2 条
    const rows = [msg(1, 1000), msg(2, 1000), msg(3, 1000)]
    const kept = selectTaskHistory(rows, new Set(), 3200)
    expect(kept.map((m) => m.id)).toEqual(['m2', 'm3'])
  })

  it('单条即超预算 → 仍保该条（宁超预算不丢最新，与 summary 层同款启发式）', () => {
    const rows = [msg(1, 100), msg(2, 50000)]
    const kept = selectTaskHistory(rows, new Set(), 3200)
    expect(kept.map((m) => m.id)).toEqual(['m2'])
  })

  it('已在近期窗口内的消息（excludeIds）不重复注入，且不占预算', () => {
    // 每条 100 汉字 = 200 token；预算 450 只够两条 ⇒ 被排除的 m3 不占额度
    const rows = [msg(1, 100), msg(2, 100), msg(3, 100)]
    const kept = selectTaskHistory(rows, new Set(['m3']), 450)
    expect(kept.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(kept.map((m) => m.id)).not.toContain('m3')
  })

  it('输出保持**时间正序**（并入上下文时旧在前、新在后）', () => {
    const rows = [msg(1, 10), msg(2, 10), msg(3, 10)]
    const kept = selectTaskHistory(rows, new Set(), TASK_HISTORY_BUDGET_TOKENS)
    expect(kept.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
  })

  it('上界常量钉死（单位：条 / token）——上限一旦被摘掉本组用例即红', () => {
    expect(TASK_HISTORY_MAX_MESSAGES).toBe(30)
    expect(TASK_HISTORY_BUDGET_TOKENS).toBe(12_000)
  })
})

// ═══ R1（P2）：检索流水埋点 ═══════════════════════════════
//
// 本组覆盖「埋点整链」的三条验收——2（写入成立 + execution_id 对账）/
// 6（超时路径 reason='timeout'）/ 14（链锚口径与 P1 一致）。
// 拆成两段证据：**组装口径**在这里直测（`recordRetrievalTrace` 只依赖 db），
// **调用点位置**由文件尾的静态源断言守——位置正是票面点名的硬要求。
describe('execution/reply — R1 检索流水埋点', () => {
  // `makeResult` 已提到模块级（组装式用例与本组共用同一份夹具，避免两处形状漂移）

  /** 造「本轮执行已开始」的最小现场：1 猫 + 1 会话 + 1 触发消息 + 1 条 running 执行行 */
  function seedRunningExecution(opts?: { triggerMessageId?: string; agentId?: string }) {
    const triggerMessageId = opts?.triggerMessageId ?? 'm-trigger'
    const agentId = opts?.agentId ?? 'agent-1'
    const db = getDb()
    db.prepare(
      `INSERT OR IGNORE INTO agents (id, name, system_prompt, llm_api_key) VALUES (?, ?, 'p', 'k')`
    ).run(agentId, `猫-${agentId}`)
    db.prepare(`INSERT OR IGNORE INTO sessions (id, title) VALUES ('sess-1', 't')`).run()
    db.prepare(
      `INSERT OR IGNORE INTO messages (id, session_id, role, content) VALUES (?, 'sess-1', 'user', 'x')`
    ).run(triggerMessageId)
    execLogsRepo.insertExecutionLog('log-1', 'sess-1', agentId, triggerMessageId, 'trace-1')
    return { triggerMessageId, agentId }
  }

  const eventRow = () =>
    getDb().prepare('SELECT * FROM retrieval_events ORDER BY id DESC LIMIT 1').get() as
      Record<string, any> | undefined

  beforeEach(() => {
    setDb(createTestDb())
    initDb()
    initRepository(getDb())
  })

  afterEach(() => {
    resetDb()
    // 参数快照类断言用 `vi.stubEnv` 钉本用例的 env ⇒ 逐用例复位，防泄漏到同块其他用例
    vi.unstubAllEnvs()
  })

  // ─── 验收 2：写入成立 + execution_id 对账 ──────────
  it('验收 2 · 真实结果落三表，execution_id 对得上 execution_logs', () => {
    const { triggerMessageId, agentId } = seedRunningExecution()
    recordRetrievalTrace({
      sessionId: 'sess-1',
      agentId,
      triggerMessageId,
      taskId: 'anchor-1',
      memoryResult: makeResult(),
      memoryTimeout: false,
      elapsedMs: 40,
    })

    expect((getDb().prepare('SELECT COUNT(*) AS n FROM retrieval_events').get() as any).n).toBe(1)
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM retrieval_queries').get() as any).n).toBe(1)
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM retrieval_candidates').get() as any).n).toBe(
      1
    )

    const ev = eventRow()!
    // 对账：该 id 就是 execution_logs 的行
    const log = getDb()
      .prepare('SELECT * FROM execution_logs WHERE id = ?')
      .get(ev.execution_id) as any
    expect(log).toBeTruthy()
    expect(log.triggered_by_message_id).toBe(triggerMessageId)
    expect(log.agent_id).toBe(agentId)
    // 内测耗时优先（同一趟），不是外侧计时
    expect(ev.retrieval_ms).toBe(37)
    expect(ev.reason).toBe('ok')
    // R1-b 验收 7：`param_pool_n` == **当前池常数**（import 真源比对，不写死 20——
    // 写死的话常数一改这条就变成假绿门）。真机对账（重启后查生产库）不在单测内。
    expect(ev.param_pool_n).toBe(HYBRID_POOL_PER_QUERY)
  })

  // ─── 验收 6：超时路径 ──────────────────────────────
  it("验收 6 · 检索超时（memoryResult===null）⇒ reason='timeout'，不 NULL 也不抛", () => {
    const { triggerMessageId, agentId } = seedRunningExecution()
    // 参数快照这条路径**无 stats 可依** ⇒ 走 `currentRetrievalParams()`（现读 env）。
    // 故断言必须钉在**本用例自己设的**值上，两重理由：
    // - 钉回默认值（3 / 0.6）是假绿门——「读 env」与「写死默认值」两种实现都能过；
    //   钉非默认值（4 / 0.7）才证「快照记的是**当时生效**的参数」。
    // - 不能依赖外部 env 恰好等于默认值：跑批进程继承服务器加载的 .env（实测
    //   `MEMORY_TOP_K=5` ⇒ 本用例曾红，且 pre-commit 会跑 server 测试 ⇒ 全仓提交被卡）。
    vi.stubEnv('MEMORY_TOP_K', '4')
    vi.stubEnv('MEMORY_MAX_DISTANCE', '0.7')
    expect(() =>
      recordRetrievalTrace({
        sessionId: 'sess-1',
        agentId,
        triggerMessageId,
        taskId: 'anchor-1',
        memoryResult: null,
        memoryTimeout: true,
        elapsedMs: 10_002,
      })
    ).not.toThrow()

    const ev = eventRow()!
    expect(ev.reason).toBe('timeout')
    // 超时那次没有内测值 ⇒ 落外侧计时；候选/查询为空但**行仍在**（不是无痕）
    expect(ev.retrieval_ms).toBe(10_002)
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM retrieval_queries').get() as any).n).toBe(0)
    // 参数快照仍带（现读 env，单一来源 currentRetrievalParams）——断的正是上面钉的值
    expect(ev.threshold_max_distance).toBe(0.7)
    expect(ev.param_top_k).toBe(4)
  })

  it("验收 6 · 检索抛错（memoryResult===null 且非超时）⇒ reason='error'", () => {
    const { triggerMessageId, agentId } = seedRunningExecution()
    recordRetrievalTrace({
      sessionId: 'sess-1',
      agentId,
      triggerMessageId,
      taskId: 'anchor-1',
      memoryResult: null,
      memoryTimeout: false,
      elapsedMs: 5,
    })
    expect(eventRow()!.reason).toBe('error')
  })

  // ─── 验收 14：链锚口径与 P1 一致 ───────────────────
  it('验收 14 · task_id 口径 = 回复消息的 task_id（triggerMsg.taskId || traceId）', () => {
    // 口径的权威是 `insertAgentMessage` 那一行：回复消息落 `triggerMsg.taskId || traceId`。
    // 触发消息带锚 ⇒ 链锚 = 该锚（与 P1 的 COALESCE(回复.task_id, 触发.task_id) 同值）
    const { triggerMessageId, agentId } = seedRunningExecution({ triggerMessageId: 'm-t1' })
    recordRetrievalTrace({
      sessionId: 'sess-1',
      agentId,
      triggerMessageId,
      taskId: 'task-123',
      memoryResult: makeResult(),
      memoryTimeout: false,
      elapsedMs: 1,
    })
    expect(eventRow()!.task_id).toBe('task-123')
  })

  it('验收 14 · 触发消息无锚时链锚退到本轮 traceId（与回复侧 || traceId 同构）', () => {
    const { triggerMessageId, agentId } = seedRunningExecution({ triggerMessageId: 'm-t2' })
    // reply.ts 调用点传的就是 `triggerMsg.taskId || traceId`；此处复现「无锚」分支
    recordRetrievalTrace({
      sessionId: 'sess-1',
      agentId,
      triggerMessageId,
      taskId: 'trace-1',
      memoryResult: makeResult(),
      memoryTimeout: false,
      elapsedMs: 1,
    })
    expect(eventRow()!.task_id).toBe('trace-1')
  })

  // ─── 兜底：找不到执行行时不编数据 ──────────────────
  it('找不到本轮 running 执行行 ⇒ 不落盘（不编 execution_id），也不抛', () => {
    seedRunningExecution()
    // 执行行已收口（completed）⇒ 本轮的 running 行不存在
    getDb().prepare("UPDATE execution_logs SET status = 'completed'").run()

    expect(() =>
      recordRetrievalTrace({
        sessionId: 'sess-1',
        agentId: 'agent-1',
        triggerMessageId: 'm-trigger',
        taskId: 'anchor-1',
        memoryResult: makeResult(),
        memoryTimeout: false,
        elapsedMs: 1,
      })
    ).not.toThrow()
    expect(eventRow()).toBeUndefined()
  })

  it('跨会话并行：只认 (会话, 猫, 触发消息) 那一行，不串到别的会话', () => {
    seedRunningExecution({ triggerMessageId: 'm-a', agentId: 'agent-1' })
    // 同一只猫在另一个会话并行执行（另起一条 running 行）
    getDb().prepare(`INSERT INTO sessions (id, title) VALUES ('sess-2', 't2')`).run()
    getDb()
      .prepare(
        `INSERT INTO messages (id, session_id, role, content) VALUES ('m-b', 'sess-2', 'user', 'y')`
      )
      .run()
    execLogsRepo.insertExecutionLog('log-2', 'sess-2', 'agent-1', 'm-b', 'trace-2')

    recordRetrievalTrace({
      sessionId: 'sess-2',
      agentId: 'agent-1',
      triggerMessageId: 'm-b',
      taskId: 'anchor-b',
      memoryResult: makeResult(),
      memoryTimeout: false,
      elapsedMs: 1,
    })

    const ev = eventRow()!
    // 窄定位的断言：同 agent 有两条 running 行（log-1/log-2），仍精确挂到 log-2。
    // 旧口径（只带 agentId）在这里会取到插入序上靠后的那条，跨会话必串。
    expect(ev.execution_id).toBe('log-2')
    expect(ev.session_id).toBe('sess-2')
    expect(ev.task_id).toBe('anchor-b')
  })

  // ═══ R2（段五）：签名与硬点（静态源断言） ═══════════════
  describe('R2 段五 · 签名与落点硬点', () => {
    const SRC = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'reply.ts'),
      'utf8'
    )

    it('验收 21 · `runAgentReply` 原 7 个参数**未变**，只新增 `trace` 一个（不做 7 参数整体收口）', () => {
      const start = SRC.indexOf('export async function runAgentReply(')
      expect(start).toBeGreaterThan(0)
      const end = SRC.indexOf('): Promise<{ content: string; msgId: string }> {', start)
      expect(end).toBeGreaterThan(start)
      const params = [...SRC.slice(start, end).matchAll(/^ {2}(\w+)[,?:]/gm)].map((m) => m[1])
      expect(params).toEqual([
        'state',
        'bus',
        'sessionId',
        'agent',
        'triggerMsg',
        'traceId',
        'signal',
        'trace',
      ])
    })

    it('硬点 3 · `llm.chat` 段的起点在 `chatStream` 调用**之前**（否则 TTFT 分母错）', () => {
      const spanStart = SRC.indexOf("trace.startSpan('llm.chat'")
      const call = SRC.indexOf('adapter.chatStream(')
      expect(spanStart).toBeGreaterThan(0)
      expect(call).toBeGreaterThan(spanStart)
    })

    it('硬点 3 · `markFirstChunk` 在 `for await` 循环体内（整段结束才记 ⇒ 首 chunk 语义丢失）', () => {
      const loop = SRC.indexOf('for await (const chunk of stream) {')
      const mark = SRC.indexOf('llmHandle.markFirstChunk()')
      const loopEnd = SRC.indexOf('} finally {', loop)
      expect(loop).toBeGreaterThan(0)
      expect(mark).toBeGreaterThan(loop)
      expect(mark).toBeLessThan(loopEnd)
    })

    it('`llm.chat` 段在 `finally` 里收口（撤回/abort 两条 return 不留 duration=0 的半截段）', () => {
      const clear = SRC.indexOf('clearInterval(heartbeatTimer)')
      const finOpen = SRC.lastIndexOf('} finally {', clear)
      const close = SRC.indexOf('trace.endSpan(llmHandle, llmStreamStatus')
      const finClose = SRC.indexOf('\n  }', close)
      expect(finOpen).toBeGreaterThan(0)
      expect(clear).toBeGreaterThan(finOpen) // clearInterval 在这个 finally 块内
      expect(close).toBeGreaterThan(clear) // 收段紧随其后（同一块）
      expect(finClose).toBeGreaterThan(close) // 且没跑出这个块
    })
  })

  // ─── 调用点位置（票 §三 硬要求，静态源断言）─────────
  describe('调用点位置（P2 §三：必须在 race 之外、if 之外）', () => {
    const SRC = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'reply.ts'),
      'utf8'
    )

    it('调用点在 10s Promise.race 的 try/catch **之后**', () => {
      const raceEnd = SRC.indexOf('记忆检索抛错，本轮不注入')
      const callSite = SRC.indexOf('recordRetrievalTrace({')
      expect(raceEnd).toBeGreaterThan(0)
      expect(callSite).toBeGreaterThan(raceEnd)
    })

    it('调用点在 `if (memoryContext)` **之外**（在它之前）', () => {
      const callSite = SRC.indexOf('recordRetrievalTrace({')
      const ifBranch = SRC.indexOf('const memoryContext = memoryResult?.text')
      expect(ifBranch).toBeGreaterThan(0)
      expect(callSite).toBeLessThan(ifBranch)
    })

    it('写库不在 race 数组内（race 里只有检索与超时两个 promise）', () => {
      const start = SRC.indexOf('memoryResult = await Promise.race([')
      const end = SRC.indexOf('])', start)
      const raceBody = SRC.slice(start, end)
      expect(raceBody).not.toContain('recordRetrievalTrace')
      expect(raceBody).toContain('retrieveMemoryContext')
    })
  })
})

// ═══ M1 缺陷修复：连线提前到广播之前（方案甲）═══════════════
//
// 病灶：`bus.emitMessage`（NEW_MESSAGE 广播）跑在「回复 ↔ 检索流水关联环」落库之前
// ——前端收到广播立刻批量拉 `/memory-refs`，读口第一环 JOIN（`getInjectedRefsByMessageIds`
// 的 `execution_logs.message_id`）此刻仍是 NULL ⇒ 最新一条回复渲染「未检索」，且前端
// 不再重查 ⇒ 假态一直挂到刷新（约 100ms 窗口，`docs/run/m1-refs-link-timing/tickets.md`）。
//
// 两段证据，缺一不可：
//  · **行为**（组装式：真 `runAgentReply` + 真 DB + 捕获 bus）：在 NEW_MESSAGE 那一刻
//    **同步**读 DB、并打真 HTTP 读口。这是承重判据——连线若留在广播之后，第一条断言必红。
//  · **位置**（静态源断言）：连线块夹在 `insertAgentMessage` 与 `bus.emitMessage` 之间，
//    且定位谓词单源（不许在调用点再写第二份）。
describe('execution/reply — M1 广播前连线', () => {
  const AGENT_ID = 'agent-m1'
  const SESSION_ID = 'sess-m1'
  const TRIGGER_ID = 'm-trigger-m1'
  const EXEC_ID = 'log-m1'

  /** 造「本轮执行已开始」的现场（回复行由 runAgentReply 自己落） */
  function seedM1(opts: { withExecutionRow?: boolean } = {}): void {
    const db = getDb()
    db.prepare(
      `INSERT INTO agents (id, name, system_prompt, llm_api_key) VALUES (?, 'ds猫', 'p', 'k')`
    ).run(AGENT_ID)
    db.prepare(`INSERT INTO sessions (id, title) VALUES (?, 't')`).run(SESSION_ID)
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, mentions)
       VALUES (?, ?, 'user', '@ds猫 干活', '["ds猫"]')`
    ).run(TRIGGER_ID, SESSION_ID)
    if (opts.withExecutionRow !== false) {
      execLogsRepo.insertExecutionLog(EXEC_ID, SESSION_ID, AGENT_ID, TRIGGER_ID, 'trace-m1')
    }
  }

  const agent = {
    id: AGENT_ID,
    name: 'ds猫',
    avatar: '🐱',
    systemPrompt: '你是测试猫',
    llmProvider: 'deepseek',
    llmModel: 'deepseek-v4-pro',
    llmApiKey: 'sk-test',
  } as any

  /** 捕获型 bus（EngineBus & HandoffBus 八个方法齐全）；`emitMessage` 回调 = 被测时点 */
  function makeBus(onMessage?: (msg: any) => void) {
    return {
      emitMessage: vi.fn((msg: any) => onMessage?.(msg)),
      emitSystemNotice: vi.fn(),
      emitTyping: vi.fn(),
      emitAgentMessageStatus: vi.fn(),
      emitMessageUpdated: vi.fn(),
      emitContextWindowStats: vi.fn(),
      emitSessionHandoff: vi.fn(),
      emitHandoffFailed: vi.fn(),
    } as any
  }

  /** 该执行行当前的 `message_id`（`undefined` = 行都不存在） */
  function linkedMessageId(): string | null | undefined {
    const row = getDb()
      .prepare('SELECT message_id FROM execution_logs WHERE id = ?')
      .get(EXEC_ID) as { message_id: string | null } | undefined
    return row?.message_id
  }

  function traceFor() {
    return createExecTrace({
      executionId: EXEC_ID,
      chainId: null,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
    })
  }

  function trigger() {
    return { id: TRIGGER_ID, content: '@ds猫 干活', mentions: ['ds猫'], fromAgent: false }
  }

  beforeEach(() => {
    setDb(createTestDb())
    initDb()
    initRepository(getDb())
    vi.mocked(retrieveMemoryContext).mockResolvedValue(makeResult())
    vi.mocked(getAdapterForAgent).mockReturnValue({
      chatStream: vi.fn(async function* () {
        yield { content: '收到，M1 验证', kind: 'text' }
      }),
    } as any)
  })

  afterEach(() => {
    resetDb()
    vi.clearAllMocks()
  })

  it('验收 1+3 · NEW_MESSAGE 那一刻：连线已在场，且真 HTTP 读口返回 injected（非 not-retrieved）', async () => {
    seedM1()
    const app = Fastify({ logger: false })
    await app.register(memoryRoutes)
    await app.ready()

    let atEmit: { dbValue: string | null | undefined; http: Promise<any> } | undefined
    const bus = makeBus((msg) => {
      // 承重读数：**同步**查 DB——emit 回调就是被测时刻本身，不是「之后某一刻」
      atEmit = {
        dbValue: linkedMessageId(),
        // 端到端形态：那一刻发起真 HTTP 读口（Fastify inject 立即排队处理）
        http: app.inject({
          method: 'GET',
          url: `/api/sessions/${SESSION_ID}/memory-refs?messageIds=${msg.id}`,
        }),
      }
    })

    const res = await runAgentReply(
      createEngineState(),
      bus,
      SESSION_ID,
      agent,
      trigger(),
      'trace-m1',
      undefined,
      traceFor()
    )

    expect(res.content).toBe('收到，M1 验证')
    // ★ 承重断言：广播那一刻 `execution_logs.message_id` 已等于回复 id
    //（修复前该值恒为 null ⇒ 前端当场拉读口拿不到流水）
    expect(atEmit!.dbValue).toBe(res.msgId)

    const resp = await atEmit!.http
    expect(resp.statusCode).toBe(200)
    const payload = resp.json()
    expect(payload[res.msgId].state).toBe('injected')
    expect(payload[res.msgId].refs[0].docPath).toBe('docs/adr/0002-b.md')
    await app.close()
  })

  it('验收 4 · abort 提前返回（无回复产出）⇒ 不连线，message_id 仍 NULL', async () => {
    seedM1()
    let emitted = false
    const bus = makeBus(() => {
      emitted = true
    })
    const controller = new AbortController()
    controller.abort('timeout')

    const res = await runAgentReply(
      createEngineState(),
      bus,
      SESSION_ID,
      agent,
      trigger(),
      'trace-m1',
      controller.signal,
      traceFor()
    )

    expect(res.content).toBe('') // 流循环在累积首个 chunk 之前就退出
    expect(emitted).toBe(false) // 没广播 ⇒ 前端也不会去拉读口
    expect(linkedMessageId()).toBeNull() // 连线只在回复落库后发生
  })

  it('OQ-1 · 找不到本轮 running 执行行 ⇒ 连线 no-op（不抛、回复照发）', async () => {
    seedM1({ withExecutionRow: false })
    const bus = makeBus()

    const res = await runAgentReply(
      createEngineState(),
      bus,
      SESSION_ID,
      agent,
      trigger(),
      'trace-m1',
      undefined,
      traceFor()
    )

    // 生产路径不可达（executeAgentCommand 先落 running 行）；真出现时也**不阻塞回复**
    expect(res.content).toBe('收到，M1 验证')
    expect(bus.emitMessage).toHaveBeenCalledTimes(1)
  })

  describe('落点硬点（静态源断言）', () => {
    const SRC = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'reply.ts'),
      'utf8'
    )

    it('连线块夹在 `insertAgentMessage` 之后、`bus.emitMessage` 之前', () => {
      // 三个锚都必须**全文件唯一**：`indexOf` 命中处若落在注释或别处，顺序断言会
      // 指向错误的面（本组首跑即被自己注释里的 `bus.emitMessage(finalMsg)` 骗过一次）
      for (const anchor of [
        'messagesRepo.insertAgentMessage(',
        'execLogsRepo.linkReplyMessage(',
        'bus.emitMessage(finalMsg)',
      ]) {
        expect(SRC.split(anchor).length - 1, `锚不唯一：${anchor}`).toBe(1)
      }
      const insert = SRC.indexOf('messagesRepo.insertAgentMessage(')
      const link = SRC.indexOf('execLogsRepo.linkReplyMessage(')
      const emit = SRC.indexOf('bus.emitMessage(finalMsg)')
      // 之后：`message_id` 有 FK 指 messages(id)，先连线后落库当场违反约束
      expect(link).toBeGreaterThan(insert)
      // 之前：连线晚于广播正是本票要关死的窗口（把 `link` 挪到 `emit` 之后本断言即红）
      expect(emit).toBeGreaterThan(link)
    })

    it('定位谓词单源：`getLogsByTriggerMessage` 在 reply.ts 内只出现一次（埋点与连线共用）', () => {
      expect(SRC.split('getLogsByTriggerMessage').length - 1).toBe(1)
    })
  })
})
