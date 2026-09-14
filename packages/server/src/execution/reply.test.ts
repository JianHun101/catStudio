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

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  selectTaskHistory,
  recordRetrievalTrace,
  TASK_HISTORY_MAX_MESSAGES,
  TASK_HISTORY_BUDGET_TOKENS,
} from './reply.js'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb, initDb } from '../db/index.js'
import { initRepository, executionLogs as execLogsRepo } from '../db/repository/index.js'
import { HYBRID_POOL_PER_QUERY } from '../db/repository/chunks.js'
import type { MemoryContextResult } from '../memory/index.js'

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
            bodyHead: '正文前 120 字',
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
    // 参数快照仍带（现读 env，单一来源 currentRetrievalParams）
    expect(ev.threshold_max_distance).toBe(0.6)
    expect(ev.param_top_k).toBe(3)
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
