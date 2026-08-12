/**
 * E2 归因分流 + closure 复验闭环测试 — v2 episode 评估规格 §4。
 * 真实 SQLite :memory:（createTestDb 含 episodes + episode_attributions 表）+ mock io
 * （只 mock 最外层投递——l1-aggregator 同款范式）。覆盖：
 * 归因映射（abandoned→replay / timeout→调查单 / parse_error→拆活单 / corrected_success→改进素材）
 * + 幂等（UNIQUE(episode_id) 不重复投递）+ closure 复验（翻转才关闭 / 未翻转保持 /
 * improvement 同轮关闭）+ open/unclassified 不动作 + replay 触发重放检查（既有机制）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository } from '../db/repository/index.js'
import { classifyEpisodes, scanZeroExecutionEpisodes } from './episodes.js'
import { runEpisodeAttribution, locateRootCause } from './attribution.js'

/** mock io：to(session).emit 捕获（l1-aggregator.test.ts 同款） */
const roomEmit = vi.fn()
const io = { to: vi.fn().mockReturnValue({ emit: roomEmit }) } as any

/** SQLite datetime 格式（UTC 'YYYY-MM-DD HH:MM:SS'）——与 datetime('now') 字符串比较一致 */
function sqliteNow(offsetMinutes = 0): string {
  return new Date(Date.now() - offsetMinutes * 60000).toISOString().replace('T', ' ').slice(0, 19)
}

/** FK 基础数据：session s1 + agent agent-1（execution_logs/attributions 外键依赖） */
function seedBase(): void {
  getDb()
    .prepare(`INSERT OR IGNORE INTO sessions (id, title, agent_ids) VALUES ('s1', 't', '[]')`)
    .run()
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
       VALUES ('agent-1', '店长', '🐱', 'p', 'deepseek', 'deepseek-v4-flash', 'sk-your-api-key-here', 'store')`
    )
    .run()
}

function insertRootMessage(overrides: Record<string, unknown> = {}): string {
  const id = (overrides.id as string) ?? `msg-${Math.random()}`
  getDb()
    .prepare(
      `INSERT INTO messages (id, session_id, role, content, task_id, created_at)
       VALUES (?, 's1', 'user', ?, ?, ?)`
    )
    .run(
      id,
      (overrides.content as string) ?? '帮我做个任务',
      (overrides.task_id as string | null) ?? null,
      (overrides.created_at as string) ?? sqliteNow()
    )
  return id
}

function insertExecution(overrides: Record<string, unknown> = {}): void {
  getDb()
    .prepare(
      `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, trace_id, started_at, ended_at, error_message, error_type, message_id)
       VALUES (?, 's1', 'agent-1', ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      (overrides.id as string) ?? `log-${Math.random()}`,
      (overrides.triggered_by as string) ?? 'msg-root',
      (overrides.status as string) ?? 'completed',
      (overrides.trace_id as string) ?? 'trace-1',
      (overrides.started_at as string) ?? sqliteNow(),
      (overrides.ended_at as string | null) ?? null,
      (overrides.error_message as string | null) ?? null,
      (overrides.error_type as string | null) ?? null,
      (overrides.message_id as string | null) ?? null
    )
}

function insertAttribution(overrides: Record<string, unknown> = {}): void {
  getDb()
    .prepare(
      `INSERT INTO episode_attributions (id, episode_id, outcome, root_cause, action_type, action_detail, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      (overrides.id as string) ?? `attr-${Math.random()}`,
      overrides.episode_id as string,
      (overrides.outcome as string) ?? 'abandoned',
      (overrides.root_cause as string | null) ?? null,
      (overrides.action_type as string) ?? 'replay',
      (overrides.action_detail as string | null) ?? null,
      (overrides.status as string) ?? 'dispatched'
    )
}

function getAttribution(episodeId: string) {
  return getDb()
    .prepare('SELECT * FROM episode_attributions WHERE episode_id = ?')
    .get(episodeId) as any
}

function getEpisode(rootTriggerMessageId: string) {
  return getDb()
    .prepare('SELECT * FROM episodes WHERE root_trigger_message_id = ?')
    .get(rootTriggerMessageId) as any
}

function getSystemMessages(): Array<{ id: string; content: string }> {
  return getDb().prepare(`SELECT id, content FROM messages WHERE role = 'system'`).all() as Array<{
    id: string
    content: string
  }>
}

describe('E2 归因分流 — 结局 → 既有动作通道映射', () => {
  beforeEach(() => {
    setDb(createTestDb())
    initRepository(getDb()) // attribution 经 repository 投递消息（session/messages 层）
    seedBase()
    roomEmit.mockClear()
  })

  afterEach(() => {
    resetDb()
  })

  it('abandoned（零执行）→ replay 分流：归因记录 + @店长 重放检查消息，幂等不重复投递', () => {
    const rootId = insertRootMessage({ id: 'msg-root', created_at: sqliteNow(60) })
    scanZeroExecutionEpisodes()
    expect(getEpisode(rootId).outcome).toBe('abandoned')

    const first = runEpisodeAttribution(io)
    expect(first.dispatched).toBe(1)
    const attr = getAttribution(getEpisode(rootId).id)
    expect(attr.action_type).toBe('replay')
    expect(attr.root_cause).toBe('零执行超窗（落库未调度，dispatch 静默丢）')
    expect(attr.status).toBe('dispatched')
    // 投递：system 消息落库 + 房间广播 + mentions 写回店长
    const msgs = getSystemMessages()
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toContain('@店长 🔄重放检查')
    expect(msgs[0].content).toContain(rootId)
    expect(msgs[0].content).toContain('结局: abandoned')
    expect(io.to).toHaveBeenCalledWith('session:s1')
    expect(roomEmit).toHaveBeenCalledTimes(1)

    // 幂等：第二轮不再投递（UNIQUE(episode_id)）
    const second = runEpisodeAttribution(io)
    expect(second.dispatched).toBe(0)
    expect(getSystemMessages()).toHaveLength(1)
  })

  it('needs_investigation（timeout）→ 调查单：根因定位 timeout', () => {
    const rootId = insertRootMessage({ id: 'msg-root', created_at: sqliteNow(60) })
    insertExecution({
      triggered_by: rootId,
      status: 'failed',
      error_type: 'timeout',
      error_message: '执行超时',
      started_at: sqliteNow(50),
    })
    classifyEpisodes()
    expect(getEpisode(rootId).outcome).toBe('needs_investigation')

    const { dispatched } = runEpisodeAttribution(io)
    expect(dispatched).toBe(1)
    const attr = getAttribution(getEpisode(rootId).id)
    expect(attr.action_type).toBe('investigation')
    expect(attr.root_cause).toBe('timeout（配额/网络需调查）')
    expect(getSystemMessages()[0].content).toContain('@店长 📋调查单')
  })

  it('harness_fix_needed（parse_error）→ 拆活单', () => {
    const rootId = insertRootMessage({ id: 'msg-root', created_at: sqliteNow(60) })
    insertExecution({
      triggered_by: rootId,
      status: 'failed',
      error_type: 'parse_error',
      error_message: '解析失败',
      started_at: sqliteNow(50),
    })
    classifyEpisodes()
    expect(getEpisode(rootId).outcome).toBe('harness_fix_needed')

    const { dispatched } = runEpisodeAttribution(io)
    expect(dispatched).toBe(1)
    expect(getAttribution(getEpisode(rootId).id).action_type).toBe('harness_fix')
    expect(getSystemMessages()[0].content).toContain('@店长 🔧拆活单')
    expect(getSystemMessages()[0].content).toContain('harness 侧失败（error_type=parse_error）')
  })

  it('corrected_success → 改进素材：同轮分流即关闭（无动作通道可复验）', () => {
    const rootId = insertRootMessage({ id: 'msg-root', created_at: sqliteNow(60) })
    // 打回（reject）后重做完成（completed 晚于 verdict）→ corrected_success
    insertExecution({
      triggered_by: rootId,
      status: 'completed',
      trace_id: 'trace-1',
      started_at: sqliteNow(50),
      ended_at: sqliteNow(45),
    })
    getDb()
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, task_id, created_at)
         VALUES ('vmsg-1', 's1', 'agent', '审查回复', 'trace-1', ?)`
      )
      .run(sqliteNow(40))
    getDb()
      .prepare(
        `INSERT INTO review_verdicts (message_id, session_id, reviewer_agent_id, subject_agent_id, verdict, created_at)
         VALUES ('vmsg-1', 's1', 'reviewer-1', NULL, 'reject', ?)`
      )
      .run(sqliteNow(40))
    insertExecution({
      id: 'log-redo',
      triggered_by: rootId,
      status: 'completed',
      trace_id: 'trace-1',
      started_at: sqliteNow(35),
      ended_at: sqliteNow(30),
    })
    classifyEpisodes()
    expect(getEpisode(rootId).outcome).toBe('corrected_success')

    const { dispatched, resolved } = runEpisodeAttribution(io)
    expect(dispatched).toBe(1)
    expect(resolved).toBe(1) // 改进素材无复验等待，同轮关闭
    const attr = getAttribution(getEpisode(rootId).id)
    expect(attr.action_type).toBe('improvement')
    expect(attr.status).toBe('resolved')
    expect(getEpisode(rootId).episode_state).toBe('closed')
    // 改进素材也投递到店长可见（上下文过滤）
    const msgs = getSystemMessages()
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toContain('@店长 💡改进素材')
    // 投递消息 id 已写回归因记录（消息层闭环锚点）
    expect(attr.delivery_message_id).toBe(msgs[0].id)
    // 店长裁决（OQ1）：improvement 投递即终态（用户从未见过打开态），
    // 不追加「已关闭」标记——标记只对打开态票据有意义
    expect(msgs[0].content).not.toContain('✅已关闭')
  })

  it('open（在途）与 unclassified 不动作', () => {
    // running 在途 → open
    const rootRunning = insertRootMessage({ id: 'msg-run', created_at: sqliteNow(60) })
    insertExecution({
      triggered_by: rootRunning,
      status: 'running',
      trace_id: 'trace-run',
      started_at: sqliteNow(50),
    })
    // 手插 unclassified episode（判定 5 防御分支的落库形态）
    insertRootMessage({ id: 'msg-unclass', created_at: sqliteNow(60) })
    getDb()
      .prepare(
        `INSERT INTO episodes (id, root_trigger_message_id, root_triggered_by, root_message_id, task_id, chain_task_id, session_id, outcome, episode_state, classification_ver)
         VALUES ('ep-unclass', 'msg-unclass', 'U', 'msg-unclass', NULL, NULL, 's1', 'unclassified', 'classified', 'v2.1')`
      )
      .run()

    classifyEpisodes()
    expect(getEpisode(rootRunning).episode_state).toBe('open')
    const { dispatched } = runEpisodeAttribution(io)
    expect(dispatched).toBe(0)
    expect(getSystemMessages()).toHaveLength(0)
  })
})

describe('E2 closure 复验 — 结局翻转才关闭，不依赖口头确认', () => {
  beforeEach(() => {
    setDb(createTestDb())
    initRepository(getDb())
    seedBase()
    roomEmit.mockClear()
  })

  afterEach(() => {
    resetDb()
  })

  it('abandoned → 修复后重放补派成功 → 判定翻转 success → 关闭（闭环）', () => {
    const rootId = insertRootMessage({ id: 'msg-root', created_at: sqliteNow(60) })
    scanZeroExecutionEpisodes()
    runEpisodeAttribution(io)
    const epId = getEpisode(rootId).id
    expect(getAttribution(epId).status).toBe('dispatched')
    expect(getEpisode(rootId).episode_state).toBe('classified')

    // 模拟重放补派成功：产生 completed 执行链（如 replayStuckUserMessages 补派后）
    insertExecution({
      id: 'log-replay-ok',
      triggered_by: rootId,
      status: 'completed',
      trace_id: 'trace-replay',
      started_at: sqliteNow(20),
      ended_at: sqliteNow(15),
    })
    // 下一轮：判定翻转 success
    classifyEpisodes()
    expect(getEpisode(rootId).outcome).toBe('success')

    // 复验：翻转 → 关闭（不依赖口头确认，判定为准）
    const { resolved } = runEpisodeAttribution(io)
    expect(resolved).toBe(1)
    expect(getAttribution(epId).status).toBe('resolved')
    expect(getEpisode(rootId).episode_state).toBe('closed')

    // closed 终态守卫：再跑判定 + 归因不覆盖不动作
    classifyEpisodes()
    expect(getEpisode(rootId).episode_state).toBe('closed')
    expect(runEpisodeAttribution(io).resolved).toBe(0)
    expect(getAttribution(epId).status).toBe('resolved')
  })

  it('未翻转保持 dispatched：失败结局无变化时复验不关闭、不重复投递', () => {
    const rootId = insertRootMessage({ id: 'msg-root', created_at: sqliteNow(60) })
    insertExecution({
      triggered_by: rootId,
      status: 'failed',
      error_type: 'timeout',
      error_message: '执行超时',
      started_at: sqliteNow(50),
    })
    classifyEpisodes()
    runEpisodeAttribution(io)
    const epId = getEpisode(rootId).id

    // 链无变化：仍 needs_investigation → 复验不关闭
    const { resolved } = runEpisodeAttribution(io)
    expect(resolved).toBe(0)
    expect(getAttribution(epId).status).toBe('dispatched')
    expect(getEpisode(rootId).episode_state).toBe('classified')
    expect(getSystemMessages()).toHaveLength(1) // 未重复投递
    // 消息层闭环：未翻转不追加「已关闭」标记（原地不动）
    expect(getSystemMessages()[0].content).not.toContain('✅已关闭')
  })

  it('closure 复验翻转 → 已投递调查单消息原地追加「已关闭」标记（消息层闭环）', () => {
    const rootId = insertRootMessage({ id: 'msg-root', created_at: sqliteNow(60) })
    insertExecution({
      triggered_by: rootId,
      status: 'failed',
      error_type: 'timeout',
      error_message: '执行超时',
      started_at: sqliteNow(50),
    })
    classifyEpisodes()
    expect(getEpisode(rootId).outcome).toBe('needs_investigation')

    const { dispatched } = runEpisodeAttribution(io)
    expect(dispatched).toBe(1)
    const epId = getEpisode(rootId).id
    const before = getSystemMessages()[0]
    expect(before.content).toContain('@店长 📋调查单')
    expect(before.content).not.toContain('✅已关闭')
    // 投递消息 id 已写回归因记录（消息层闭环的前提）
    expect(getAttribution(epId).delivery_message_id).toBe(before.id)

    // 打回后重做完成 → 判定翻转 corrected_success
    getDb()
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, task_id, created_at)
         VALUES ('vmsg-1', 's1', 'agent', '审查回复', 'trace-1', ?)`
      )
      .run(sqliteNow(30))
    getDb()
      .prepare(
        `INSERT INTO review_verdicts (message_id, session_id, reviewer_agent_id, subject_agent_id, verdict, created_at)
         VALUES ('vmsg-1', 's1', 'reviewer-1', NULL, 'reject', ?)`
      )
      .run(sqliteNow(30))
    insertExecution({
      id: 'log-redo',
      triggered_by: rootId,
      status: 'completed',
      trace_id: 'trace-1',
      started_at: sqliteNow(20),
      ended_at: sqliteNow(15),
    })
    classifyEpisodes()
    expect(getEpisode(rootId).outcome).toBe('corrected_success')

    const { resolved } = runEpisodeAttribution(io)
    expect(resolved).toBe(1)
    expect(getAttribution(epId).status).toBe('resolved')
    expect(getEpisode(rootId).episode_state).toBe('closed')
    // 同一消息原地追加标记（id 不变，内容追加）——用户同一位置看到完整状态
    const after = getSystemMessages()[0]
    expect(after.id).toBe(before.id)
    expect(after.content).toContain('✅已关闭（结局翻转 corrected_success）')
  })

  it('routing_failure → replay 归因（root_cause 路由整体失败）', () => {
    const rootId = insertRootMessage({ id: 'msg-root', created_at: sqliteNow(60) })
    // 全部执行行失败且无明确归因（error_type NULL/unknown）→ routing_failure
    insertExecution({
      triggered_by: rootId,
      status: 'failed',
      error_message: '不明失败',
      started_at: sqliteNow(50),
    })
    classifyEpisodes()
    expect(getEpisode(rootId).outcome).toBe('routing_failure')

    const { dispatched } = runEpisodeAttribution(io)
    expect(dispatched).toBe(1)
    expect(getAttribution(getEpisode(rootId).id).action_type).toBe('replay')
    expect(getAttribution(getEpisode(rootId).id).root_cause).toBe(
      '全部执行行失败且无明确归因（路由整体失败）'
    )
  })
})

describe('locateRootCause — 根因定位分支', () => {
  beforeEach(() => {
    setDb(createTestDb())
    initRepository(getDb())
    seedBase()
  })

  afterEach(() => {
    resetDb()
  })

  it('needs_investigation：completed 后被打回（verdict 时序）→ 打回根因', () => {
    const rootMsg = {
      id: 'msg-root',
      session_id: 's1',
      content: '任务',
      task_id: null,
      created_at: sqliteNow(60),
    } as any
    // 完成链 + 后序 reject（无重做）→ verdict 根因
    const chain = [
      {
        id: 'l1',
        status: 'completed',
        trace_id: 'trace-1',
        started_at: sqliteNow(50),
        ended_at: sqliteNow(45),
        error_type: null,
        error_message: null,
      },
    ] as any
    getDb()
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, task_id, created_at)
       VALUES ('vmsg-1', 's1', 'agent', '审查回复', 'trace-1', ?)`
      )
      .run(sqliteNow(40))
    getDb()
      .prepare(
        `INSERT INTO review_verdicts (message_id, session_id, reviewer_agent_id, subject_agent_id, verdict, created_at)
       VALUES ('vmsg-1', 's1', 'reviewer-1', NULL, 'suggest', ?)`
      )
      .run(sqliteNow(40))

    expect(locateRootCause('needs_investigation', chain, rootMsg, 'trace-1')).toBe(
      '完成被打回（verdict=suggest），未重做'
    )
  })
})
