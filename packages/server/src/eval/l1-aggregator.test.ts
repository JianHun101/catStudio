/**
 * l1-aggregator 测试 — W1 L1 契约。
 * 真实 SQLite :memory: + mock io（只 mock 最外层投递）。覆盖：
 * 八口径聚合（分母排除 server_restart）/ 破线告警 / 滞回去重 / 恢复 / 重启清空。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Events } from '@cat-study/shared'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository } from '../db/repository/index.js'
import { getLogLevel, setLogLevel } from '../logger.js'
import {
  aggregateMetrics,
  alertThresholds,
  runL1Aggregation,
  __test_resetAlertState,
} from './l1-aggregator.js'

/** 假 bus：镜像 createSocketBus 的 emitSystemNotice——roomEmit 捕获 NEW_MESSAGE 载荷 */
const roomEmit = vi.fn()
const bus = {
  emitSystemNotice: (n: any) => roomEmit(Events.NEW_MESSAGE, { ...n, role: 'system' }),
} as any

/** FK 基础数据：session s1 + agent agent-1 + reviewer-1 + 触发消息 t1
 *  （票 6 起 execution_logs / review_verdicts / review_parse_failures 的引用列都有
 *   RESTRICT 外键 ⇒ 夹具必须造出真实存在的父行） */
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
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
       VALUES ('reviewer-1', '吐槽猫', '🐱', 'p', 'deepseek', 'deepseek-v4-flash', 'sk-test', 'reviewer')`
    )
    .run()
  seedMessage('t1')
}

function seedMessage(id: string): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO messages (id, session_id, role, content, mentions)
       VALUES (?, 's1', 'user', 'x', '[]')`
    )
    .run(id)
}

/** ISO 毫秒（⑤-a 目标口径）——判窗比较点与列同口径 */
function isoNow(offsetDays = 0): string {
  return new Date(Date.now() - offsetDays * 86400000).toISOString()
}

function insertExecution(overrides: Record<string, unknown> = {}): void {
  getDb()
    .prepare(
      `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, started_at, error_message, error_type, latency_ms, prompt_tokens, completion_tokens)
       VALUES (?, 's1', 'agent-1', 't1', ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      overrides.id ?? `log-${Math.random()}`,
      overrides.status ?? 'completed',
      overrides.started_at ?? isoNow(),
      overrides.error_message ?? null,
      overrides.error_type ?? null,
      overrides.latency_ms ?? 100,
      overrides.prompt_tokens ?? 10,
      overrides.completion_tokens ?? 20
    )
}

function insertVerdict(verdict: string): void {
  const messageId = `m-${Math.random()}`
  seedMessage(messageId)
  getDb()
    .prepare(
      `INSERT INTO review_verdicts (message_id, session_id, reviewer_agent_id, subject_agent_id, verdict, created_at)
       VALUES (?, 's1', 'reviewer-1', NULL, ?, ?)`
    )
    .run(messageId, verdict, isoNow())
}

function insertParseFailure(): void {
  const messageId = `f-${Math.random()}`
  seedMessage(messageId)
  getDb()
    .prepare(
      `INSERT INTO review_parse_failures (message_id, reason, raw, created_at)
       VALUES (?, 'bad_verdict', 'raw', ?)`
    )
    .run(messageId, isoNow())
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

  it('30 天窗口：窗口外记录不计数（execution_logs 用 started_at 判窗）', () => {
    getDb()
      .prepare(
        `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, started_at)
         VALUES ('old', 's1', 'agent-1', 't1', 'failed', datetime('now', '-31 days'))`
      )
      .run()
    insertExecution({ status: 'completed' })
    const m = aggregateMetrics()
    expect(m.sampleTotal).toBe(1)
  })

  it('回归：execution_logs 无 created_at 列（生产 schema 形态）聚合不炸', () => {
    // 事故防线：生产建表（db/index.ts）execution_logs 无 created_at 列，只有
    // started_at/ended_at。测试夹具已对齐删列——若聚合 SQL 再引用 created_at，
    // 此测试必抛 "no such column: created_at"（原 bug 形态）。
    const cols = getDb().pragma('table_info(execution_logs)') as Array<{ name: string }>
    expect(cols.map((c) => c.name)).not.toContain('created_at')
    insertExecution({ status: 'completed' })
    insertExecution({ status: 'failed', error_message: 'x', error_type: 'timeout' })
    const m = aggregateMetrics()
    expect(m.sampleTotal).toBe(2)
    expect(m.successRate).toBeCloseTo(0.5, 5)
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
    const r = runL1Aggregation(bus)
    expect(r.alert).toBe(true)
    expect(r.recovered).toBe(false)

    // 广播
    expect(roomEmit.mock.calls[0][1].sessionId).toBe('s1')
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

    expect(runL1Aggregation(bus).alert).toBe(true)
    expect(roomEmit).toHaveBeenCalledTimes(1)

    // 数据未变（仍破线）→ 第二轮不投递
    const r2 = runL1Aggregation(bus)
    expect(r2.alert).toBe(false)
    expect(roomEmit).toHaveBeenCalledTimes(1)
  })

  it('恢复：alerting → 全部指标正常 → recovered:true 且不投递', () => {
    seedBrokenSuccess()
    expect(runL1Aggregation(bus).alert).toBe(true)

    // 修复：清空失败记录 → 全部 completed
    getDb().prepare(`DELETE FROM execution_logs WHERE status = 'failed'`).run()
    const r = runL1Aggregation(bus)
    expect(r.recovered).toBe(true)
    expect(r.alert).toBe(false)
    expect(roomEmit).toHaveBeenCalledTimes(1) // 恢复不投递
  })

  it('重启清空状态机：__test_resetAlertState 后破线重新告警', () => {
    seedBrokenSuccess()
    expect(runL1Aggregation(bus).alert).toBe(true)

    __test_resetAlertState() // 模拟重启（模块级状态清空）
    roomEmit.mockClear()
    const r = runL1Aggregation(bus)
    expect(r.alert).toBe(true) // 重启后最多多发一条，接受
  })

  it('阈值 env 覆盖：EVAL_ALERT_SUCCESS_RATE 提高后原数据破线', () => {
    insertExecution({ status: 'completed' })
    insertExecution({ status: 'completed' })
    insertExecution({ status: 'failed', error_message: 'x', error_type: 'unknown' })

    // 默认 0.8：成功率 2/3 ≈ 66.7% < 80% → 破线
    expect(runL1Aggregation(bus).alert).toBe(true)
    __test_resetAlertState()
    roomEmit.mockClear()

    // 阈值放宽到 0.5 → 66.7% > 50% 不破线
    process.env.EVAL_ALERT_SUCCESS_RATE = '0.5'
    try {
      expect(runL1Aggregation(bus).alert).toBe(false)
    } finally {
      delete process.env.EVAL_ALERT_SUCCESS_RATE
    }
  })

  it('healthy 稳态：normal 且不破线 → 静默无动作', () => {
    insertExecution({ status: 'completed' })
    insertExecution({ status: 'completed' })
    const r = runL1Aggregation(bus)
    expect(r.alert).toBe(false)
    expect(r.recovered).toBe(false)
    expect(roomEmit).not.toHaveBeenCalled()
  })
})

// ─── env 坏值回归（票 env-number-guards · 组件 B）─────────────────────
/**
 * 三个 `EVAL_ALERT_*` 键在立票读数里**连一处 env 级测试都没有**（本仓此前唯一有
 * 坏值守卫的是 `AGENT_HARD_TIMEOUT_MS`，见 `serial.hard-timeout-disabled.test.ts` A1）。
 *
 * 断言打在**真接线点**：`alertThresholds()` 是这三个键的唯一 env 读取点，
 * `runL1Aggregation` 是阈值的真消费函数（滞回状态机的破线判定）。两者都断——
 * 只断前者的话，「值对了但没进状态机」不会红。
 */
describe('env 坏值回归：EVAL_ALERT_* 三键', () => {
  beforeEach(() => {
    setDb(createTestDb())
    initRepository(getDb())
    seedBase()
    roomEmit.mockClear()
    __test_resetAlertState()
  })

  afterEach(() => {
    resetDb()
    __test_resetAlertState()
    vi.unstubAllEnvs()
  })

  /**
   * 每键一组，`seed` 造的**只有本键会破线**的数据。另两键在用例里显式钉默认值
   * ——不钉的话告警可能是被别的键打破的，本键的断言就测不到本键（假绿）。
   */
  const CASES = [
    {
      key: 'EVAL_ALERT_SUCCESS_RATE',
      field: 'successRate',
      fallback: 0.8,
      seed: () => {
        // 成功率 1/2 = 50% < 80%；超时率 0、返工率 0 都不破
        insertExecution({ status: 'completed' })
        insertExecution({ status: 'failed', error_message: 'x', error_type: 'parse_error' })
      },
    },
    {
      key: 'EVAL_ALERT_TIMEOUT_RATE',
      field: 'timeoutRate',
      fallback: 0.1,
      seed: () => {
        // 超时率 1/9 ≈ 11.1% > 10%；成功率 8/9 ≈ 88.9% ≥ 80%、返工率 0 都不破
        for (let i = 0; i < 8; i++) insertExecution({ status: 'completed' })
        insertExecution({ status: 'failed', error_message: '执行超时', error_type: 'timeout' })
      },
    },
    {
      key: 'EVAL_ALERT_REWORK_RATE',
      field: 'reworkRate',
      fallback: 0.3,
      seed: () => {
        // 返工率 (1 suggest + 1 reject) / 2 个结论 = 100% > 30%；
        // 成功率 100%、超时率 0 都不破
        insertExecution({ status: 'completed' })
        insertVerdict('suggest')
        insertVerdict('reject')
      },
    },
  ] as const

  for (const c of CASES) {
    it(`${c.key} 坏值/空串 ⇒ ${c.field} 回退 ${c.fallback}（不是 null/NaN）且真破线告警`, () => {
      vi.stubEnv('EVAL_ALERT_SUCCESS_RATE', '0.8')
      vi.stubEnv('EVAL_ALERT_TIMEOUT_RATE', '0.1')
      vi.stubEnv('EVAL_ALERT_REWORK_RATE', '0.3')
      c.seed()

      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      const prevLevel = getLogLevel()
      setLogLevel('warn') // 断言走真 logger ⇒ 级别不放 warn，「坏值出声」会退化成恒真
      try {
        // stdout 行形如 `WARN <ts> env-number <msg> <meta>`——按模块名 + 变量名双筛
        const warns = (): string[] =>
          stdoutSpy.mock.calls
            .map((x) => String(x[0]))
            .filter((l) => l.includes('env-number') && l.includes(c.key))

        vi.stubEnv(c.key, 'abc')
        expect(alertThresholds()[c.field]).toBe(c.fallback)
        // 承重面：坏值若解析成 NaN，`m.successRate < NaN` / `m.timeoutRate > NaN` 一类
        // 比较恒假 ⇒ 破线判定静默失效、告警永不触发。这条把「值对了」推到「状态机真破线」。
        expect(runL1Aggregation(bus).alert).toBe(true)
        // 正对照：坏值必须出声（否则下面的「不新增」恒真）。条数 = 读取次数，不作断言。
        expect(warns().length).toBeGreaterThan(0)
        const afterBad = warns().length

        __test_resetAlertState() // 上一轮已进 alerting；不复位则第二轮无转换沿、断言恒假
        roomEmit.mockClear()
        vi.stubEnv(c.key, '')
        expect(alertThresholds()[c.field]).toBe(c.fallback)
        expect(runL1Aggregation(bus).alert).toBe(true)
        expect(warns().length).toBe(afterBad) // 空串：调用次数可变，warn 一条都不许新增
      } finally {
        stdoutSpy.mockRestore()
        setLogLevel(prevLevel)
      }
    })
  }
})
