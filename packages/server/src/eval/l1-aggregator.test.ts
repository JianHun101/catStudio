/**
 * l1-aggregator 测试 — W1 L1 契约。
 * 真实 SQLite :memory: + mock io（只 mock 最外层投递）。覆盖：
 * 八口径聚合（分母排除 server_restart）/ 破线告警 / 滞回去重 / 恢复 / 重启清空。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository } from '../db/repository/index.js'
import { aggregateMetrics, runL1Aggregation, __test_resetAlertState } from './l1-aggregator.js'

/** mock io：to(session).emit 捕获 */
const roomEmit = vi.fn()
const io = { to: vi.fn().mockReturnValue({ emit: roomEmit }) } as any

/** FK 基础数据：session s1 + agent agent-1（execution_logs/verdicts 外键依赖） */
function seedBase() {
  getDb()
    .prepare(`INSERT OR IGNORE INTO sessions (id, title, agent_ids) VALUES ('s1', 't', '[]')`)
    .run()
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
       VALUES ('agent-1', '店长', '🐱', 'p', 'deepseek', 'deepseek-v4-flash', 'sk-test', 'store')`
    )
    .run()
}

function insertExecution(overrides: Record<string, unknown> = {}): void {
  getDb()
    .prepare(
      `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, error_message, error_type, latency_ms, prompt_tokens, completion_tokens)
       VALUES (?, 's1', 'agent-1', 't1', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      overrides.id ?? `log-${Math.random()}`,
      overrides.status ?? 'completed',
      overrides.error_message ?? null,
      overrides.error_type ?? null,
      overrides.latency_ms ?? 100,
      overrides.prompt_tokens ?? 10,
      overrides.completion_tokens ?? 20
    )
}

function insertVerdict(verdict: string): void {
  getDb()
    .prepare(
      `INSERT INTO review_verdicts (message_id, session_id, reviewer_agent_id, subject_agent_id, verdict)
       VALUES (?, 's1', 'reviewer-1', NULL, ?)`
    )
    .run(`m-${Math.random()}`, verdict)
}

function insertParseFailure(): void {
  getDb()
    .prepare(
      `INSERT INTO review_parse_failures (message_id, reason, raw)
       VALUES (?, 'bad_verdict', 'raw')`
    )
    .run(`f-${Math.random()}`)
}

describe('aggregateMetrics — 八口径', () => {
  beforeEach(() => {
    setDb(createTestDb())
    initRepository(getDb())
    seedBase()
  })

  afterEach(() => {
    resetDb()
    __test_resetAlertState()
  })

  it('分母排除 server_restart：completed + 普通 failed 参与成功率，infra 单独计数', () => {
    insertExecution({ status: 'completed', latency_ms: 100 })
    insertExecution({ status: 'completed', latency_ms: 300 })
    insertExecution({ status: 'failed', error_message: '执行超时', error_type: 'timeout' })
    insertExecution({
      status: 'failed',
      error_message: 'server_restart',
      error_type: 'server_restart',
    })

    const m = aggregateMetrics()
    // 分母 = 2 completed + 1 普通 failed = 3，server_restart 排除
    expect(m.successRate).toBeCloseTo(2 / 3, 5)
    expect(m.timeoutRate).toBeCloseTo(1 / 3, 5)
    expect(m.infraFailures).toBe(1)
    expect(m.avgLatencyMs).toBe(200)
    expect(m.totalTokens).toBe(10 * 4 + 20 * 4)
  })

  it('存量 failed 行 error_type NULL → COALESCE unknown 视为普通失败（不回填）', () => {
    insertExecution({ status: 'completed' })
    insertExecution({ status: 'failed', error_message: 'old error', error_type: null })
    const m = aggregateMetrics()
    expect(m.successRate).toBeCloseTo(0.5, 5)
    expect(m.infraFailures).toBe(0)
  })

  it('空窗口 → 成功率 1、各率 0、avg null', () => {
    const m = aggregateMetrics()
    expect(m.successRate).toBe(1)
    expect(m.timeoutRate).toBe(0)
    expect(m.suggestRate).toBe(0)
    expect(m.avgLatencyMs).toBeNull()
    expect(m.sampleTotal).toBe(0)
  })

  it('30 天窗口：窗口外记录不计数', () => {
    getDb()
      .prepare(
        `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, created_at)
         VALUES ('old', 's1', 'agent-1', 't1', 'failed', datetime('now', '-31 days'))`
      )
      .run()
    insertExecution({ status: 'completed' })
    const m = aggregateMetrics()
    expect(m.sampleTotal).toBe(1)
  })

  it('suggest/reject/解析失败率：verdicts 与 failures 口径', () => {
    insertExecution({ status: 'completed' })
    insertVerdict('approve')
    insertVerdict('suggest')
    insertVerdict('reject')
    insertParseFailure()
    const m = aggregateMetrics()
    expect(m.suggestRate).toBeCloseTo(1 / 3, 5)
    expect(m.rejectRate).toBeCloseTo(1 / 3, 5)
    // 解析失败率 = failures/(verdicts+failures) = 1/4
    expect(m.parseFailureRate).toBeCloseTo(0.25, 5)
  })
})

describe('runL1Aggregation — 滞回告警', () => {
  beforeEach(() => {
    setDb(createTestDb())
    initRepository(getDb())
    seedBase()
    roomEmit.mockClear()
    vi.mocked(io.to).mockClear()
    __test_resetAlertState()
  })

  afterEach(() => {
    resetDb()
    __test_resetAlertState()
  })

  /** 插 4 条执行 + 3 条结论，构造成功率 50%（4 条中 2 完成）破线 */
  function seedBrokenSuccess() {
    insertExecution({ status: 'completed' })
    insertExecution({ status: 'completed' })
    insertExecution({ status: 'failed', error_message: 'parse fail', error_type: 'parse_error' })
    insertExecution({ status: 'failed', error_message: '执行超时', error_type: 'timeout' })
  }

  it('破线 → alert:true + 告警落库 + 房间广播（mentions 写回店长）', () => {
    seedBrokenSuccess()
    const r = runL1Aggregation(io)
    expect(r.alert).toBe(true)
    expect(r.recovered).toBe(false)

    // 广播
    expect(io.to).toHaveBeenCalledWith('session:s1')
    expect(roomEmit).toHaveBeenCalledTimes(1)
    const msg = roomEmit.mock.calls[0][1] as any
    expect(msg.role).toBe('system')
    expect(msg.mentions).toEqual(['店长'])
    expect(msg.content).toContain('📊评估告警')
    expect(msg.content).toContain('执行成功率 50.0%')

    // 落库
    const row = getDb()
      .prepare(`SELECT * FROM messages WHERE session_id = 's1' AND role = 'system'`)
      .get() as any
    expect(row).toBeDefined()
    expect(JSON.parse(row.mentions)).toEqual(['店长'])
  })

  it('滞回去重：alerting 持续破线不重复投递', () => {
    seedBrokenSuccess()

    expect(runL1Aggregation(io).alert).toBe(true)
    expect(roomEmit).toHaveBeenCalledTimes(1)

    // 数据未变（仍破线）→ 第二轮不投递
    const r2 = runL1Aggregation(io)
    expect(r2.alert).toBe(false)
    expect(roomEmit).toHaveBeenCalledTimes(1)
  })

  it('恢复：alerting → 全部指标正常 → recovered:true 且不投递', () => {
    seedBrokenSuccess()
    expect(runL1Aggregation(io).alert).toBe(true)

    // 修复：清空失败记录 → 全部 completed
    getDb().prepare(`DELETE FROM execution_logs WHERE status = 'failed'`).run()
    const r = runL1Aggregation(io)
    expect(r.recovered).toBe(true)
    expect(r.alert).toBe(false)
    expect(roomEmit).toHaveBeenCalledTimes(1) // 恢复不投递
  })

  it('重启清空状态机：__test_resetAlertState 后破线重新告警', () => {
    seedBrokenSuccess()
    expect(runL1Aggregation(io).alert).toBe(true)

    __test_resetAlertState() // 模拟重启（模块级状态清空）
    roomEmit.mockClear()
    const r = runL1Aggregation(io)
    expect(r.alert).toBe(true) // 重启后最多多发一条，接受
  })

  it('阈值 env 覆盖：EVAL_ALERT_SUCCESS_RATE 提高后原数据破线', () => {
    insertExecution({ status: 'completed' })
    insertExecution({ status: 'completed' })
    insertExecution({ status: 'failed', error_message: 'x', error_type: 'unknown' })

    // 默认 0.8：成功率 2/3 ≈ 66.7% < 80% → 破线
    expect(runL1Aggregation(io).alert).toBe(true)
    __test_resetAlertState()
    roomEmit.mockClear()

    // 阈值放宽到 0.5 → 66.7% > 50% 不破线
    process.env.EVAL_ALERT_SUCCESS_RATE = '0.5'
    try {
      expect(runL1Aggregation(io).alert).toBe(false)
    } finally {
      delete process.env.EVAL_ALERT_SUCCESS_RATE
    }
  })

  it('healthy 稳态：normal 且不破线 → 静默无动作', () => {
    insertExecution({ status: 'completed' })
    insertExecution({ status: 'completed' })
    const r = runL1Aggregation(io)
    expect(r.alert).toBe(false)
    expect(r.recovered).toBe(false)
    expect(roomEmit).not.toHaveBeenCalled()
  })
})
