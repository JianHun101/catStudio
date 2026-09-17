/**
 * episodes 判定引擎测试 — v2 episode 评估契约（docs/plans/episode-evaluation-v2.md §5 验收表）。
 * 真实 SQLite :memory:（createTestDb 含 episodes 表），无 mock。
 * 覆盖：判定 1-5 全链（①在途 / ①'恢复重跑 / ②无打回 / ②'U-H 双根 / ②''NULL 根 reject /
 * ②'''双值漂移 / ③·③'时序 / ④·④'失败分流 / ⑤路由失败）+ 零执行扫描（G2-N5 + G3 + G5 + N9）
 * + upsert 幂等（⑥）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import {
  classifyEpisodes,
  scanZeroExecutionEpisodes,
  upsertEpisode,
  determineRootTriggeredBy,
  episodeStats,
  EPISODE_CLASSIFICATION_VER,
} from './episodes.js'
import type { EpisodeRow } from '../db/repository/types.js'

/** SQLite datetime 格式（UTC 'YYYY-MM-DD HH:MM:SS'）——与 datetime('now') 字符串比较一致。
 *  **仅用于 `messages.created_at`**：messages 表未随票 6 重建，写入口不传该列 ⇒ 落
 *  `DEFAULT (datetime('now'))`；零执行扫描的 `created_at < datetime('now','-30 minutes')`
 *  也要求同形串（异形串比较会因 `'T' > ' '` 恒假，窗口内恒判不出来）。 */
function sqliteNow(offsetMinutes = 0): string {
  return new Date(Date.now() - offsetMinutes * 60000).toISOString().replace('T', ' ').slice(0, 19)
}

/** 重建表时间口径（票 6：ISO 毫秒，仓库层 `nowIso()` 生成）——
 *  `execution_logs.started_at/ended_at` 与 `review_verdicts.created_at` 用它；
 *  两者在 `classifyCompleted` 里互相比较（`doneAt > lastRejectAt`），必须同形。 */
function isoNow(offsetMinutes = 0): string {
  return new Date(Date.now() - offsetMinutes * 60000).toISOString()
}

/** FK 基础数据：session s1 + agent agent-1 + reviewer-1
 *  （票 6 批一：`execution_logs` / `review_verdicts` 的引用列都是 RESTRICT 外键 ⇒
 *   夹具必须造出真实存在的父行——否则子行插不进，断言读到 undefined） */
function seedBase(): void {
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
      (overrides.started_at as string) ?? isoNow(),
      (overrides.ended_at as string | null) ?? null,
      (overrides.error_message as string | null) ?? null,
      (overrides.error_type as string | null) ?? null,
      (overrides.message_id as string | null) ?? null
    )
}

/** 插一条审查回复消息 + 对应 verdict（verdict 消息 task_id 可注入——E3 接线后 = 源链 trace_id） */
function insertVerdict(overrides: Record<string, unknown> = {}): void {
  const msgId = (overrides.msg_id as string) ?? `vmsg-${Math.random()}`
  getDb()
    .prepare(
      `INSERT INTO messages (id, session_id, role, content, task_id, created_at)
       VALUES (?, 's1', 'agent', '审查回复', ?, ?)`
    )
    .run(
      msgId,
      (overrides.task_id as string | null) ?? null,
      (overrides.msg_created_at as string) ?? sqliteNow()
    )
  getDb()
    .prepare(
      `INSERT INTO review_verdicts (message_id, session_id, reviewer_agent_id, subject_agent_id, verdict, created_at)
       VALUES (?, 's1', 'reviewer-1', NULL, ?, ?)`
    )
    .run(
      msgId,
      (overrides.verdict as string) ?? 'reject',
      (overrides.created_at as string) ?? isoNow()
    )
}

function getEpisode(rootTriggerMessageId: string): EpisodeRow | undefined {
  return getDb()
    .prepare('SELECT * FROM episodes WHERE root_trigger_message_id = ?')
    .get(rootTriggerMessageId) as EpisodeRow | undefined
}

function countEpisodes(): number {
  return (getDb().prepare('SELECT COUNT(*) AS cnt FROM episodes').get() as { cnt: number }).cnt
}

describe('determineRootTriggeredBy — G3 三阶 H 根判定', () => {
  it('判定 1：task_id 非 NULL 且匹配既有 episode chain_task_id → H', () => {
    expect(determineRootTriggeredBy({ task_id: 'trace-X', content: 'x' }, true)).toBe('H')
  })

  it('判定 2：无 task_id、带交接文档精确前缀 → H（E3 接线前唯一可工作路径）', () => {
    expect(
      determineRootTriggeredBy(
        {
          task_id: null,
          content:
            '@ds猫 请补填以下交接文档中 TODO 标注的部分（Why / Tradeoff / Open Questions）。',
        },
        false
      )
    ).toBe('H')
  })

  it('判定 3：task_id 为空或无匹配 episode 且无内容特征 → U 已知噪声', () => {
    expect(determineRootTriggeredBy({ task_id: null, content: '帮我做任务' }, false)).toBe('U')
    // G5：task_id 非 NULL 但无匹配 episode → 仍 U，不漏出判定阶梯
    expect(
      determineRootTriggeredBy({ task_id: 'task-nomatch', content: '帮我做任务' }, false)
    ).toBe('U')
  })

  it('内容特征非精确前缀（普通 @ 或疑似文本）不误判 H', () => {
    expect(
      determineRootTriggeredBy({ task_id: null, content: '@ds猫 请帮我补填一下' }, false)
    ).toBe('U')
    expect(determineRootTriggeredBy({ task_id: null, content: '请补填以下交接文档' }, false)).toBe(
      'U'
    )
  })
})

describe('classifyEpisodes — 判定优先级 1-5', () => {
  beforeEach(() => {
    setDb(createTestDb())
    seedBase()
  })

  afterEach(() => {
    resetDb()
  })

  it('① 在途：存在 running 行 → open 不归因（closure 状态机 skip）', () => {
    const rootId = insertRootMessage({ id: 'msg-root', created_at: sqliteNow(10) })
    insertExecution({
      triggered_by: rootId,
      status: 'running',
      trace_id: 'trace-1',
      started_at: isoNow(9),
    })

    classifyEpisodes()
    const ep = getEpisode(rootId)
    expect(ep).toBeDefined()
    expect(ep!.episode_state).toBe('open')
    expect(ep!.outcome).toBeNull()
    expect(ep!.chain_task_id).toBe('trace-1')
  })

  it("①' 恢复重跑成功：[failed(server_restart), completed] 无 running → success 非 abandoned（G1 守卫）", () => {
    const rootId = insertRootMessage({ id: 'msg-root', created_at: sqliteNow(10) })
    insertExecution({
      triggered_by: rootId,
      status: 'failed',
      trace_id: 'trace-1',
      error_message: 'server_restart',
      error_type: 'server_restart',
      started_at: isoNow(9),
    })
    insertExecution({
      triggered_by: rootId,
      status: 'completed',
      trace_id: 'trace-1',
      started_at: isoNow(5),
      ended_at: isoNow(4),
    })

    classifyEpisodes()
    const ep = getEpisode(rootId)
    expect(ep!.outcome).toBe('success')
    expect(ep!.episode_state).toBe('classified')
    expect(ep!.chain_task_id).toBe('trace-1')
  })

  it('② 正常完成无打回 → success', () => {
    const rootId = insertRootMessage({ id: 'msg-root', created_at: sqliteNow(10) })
    insertExecution({
      triggered_by: rootId,
      status: 'completed',
      trace_id: 'trace-1',
      ended_at: isoNow(8),
    })

    classifyEpisodes()
    expect(getEpisode(rootId)!.outcome).toBe('success')
  })

  it("②' U→H 双根：两 episode 各自锚定，H 根不混入 U（root_triggered_by 区分）", () => {
    // U 根：普通用户任务
    const uRoot = insertRootMessage({ id: 'msg-u', created_at: sqliteNow(10) })
    insertExecution({
      triggered_by: uRoot,
      status: 'completed',
      trace_id: 'trace-U',
      ended_at: isoNow(8),
    })
    // H 根：交接消息（内容特征前缀），被 agent 补填执行
    const hRoot = insertRootMessage({
      id: 'msg-h',
      created_at: sqliteNow(20),
      content: '@ds猫 请补填以下交接文档中 TODO 标注的部分（Why / Tradeoff / Open Questions）。',
    })
    insertExecution({
      triggered_by: hRoot,
      status: 'completed',
      trace_id: 'trace-H',
      ended_at: isoNow(18),
    })

    classifyEpisodes()
    const uEp = getEpisode(uRoot)
    const hEp = getEpisode(hRoot)
    expect(uEp!.root_triggered_by).toBe('U')
    expect(uEp!.outcome).toBe('success')
    expect(hEp!.root_triggered_by).toBe('H')
    expect(hEp!.chain_task_id).toBe('trace-H')
    // 两 episode 各自独立，无合并
    expect(countEpisodes()).toBe(2)
  })

  it("②'' U 根 task_id NULL + 链内有 reject 且完成早于打回 → needs_investigation 非 success", () => {
    const rootId = insertRootMessage({ id: 'msg-root', created_at: sqliteNow(60) })
    insertExecution({
      triggered_by: rootId,
      status: 'completed',
      trace_id: 'trace-A',
      started_at: isoNow(50),
      ended_at: isoNow(45),
    })
    // 审查回复消息 task_id = 源链 trace_id（投递带 taskId 机制生效，E3 接线）
    insertVerdict({ task_id: 'trace-A', verdict: 'reject', created_at: isoNow(40) })

    classifyEpisodes()
    expect(getEpisode(rootId)!.outcome).toBe('needs_investigation')
  })

  it("②'' 变体：打回后重做完成（completed 晚于最近打回）→ corrected_success 非 success", () => {
    const rootId = insertRootMessage({ id: 'msg-root', created_at: sqliteNow(60) })
    insertVerdict({ task_id: 'trace-A', verdict: 'reject', created_at: isoNow(50) })
    insertExecution({
      triggered_by: rootId,
      status: 'completed',
      trace_id: 'trace-A',
      started_at: isoNow(40),
      ended_at: isoNow(30),
    })

    classifyEpisodes()
    expect(getEpisode(rootId)!.outcome).toBe('corrected_success')
  })

  it("②''' 锚源修正（T-G）：chain_task_id = 根消息 task_id（非链末 trace），reject 按锚关联到", () => {
    // **本条即 T-G 验收① 的区分性用例**：fixture 刻意让「锚」与「链末 trace」不等
    // （真实库实测 706/958 执行行如此），且判词消息挂在**锚**上——
    // 旧实现（chain_task_id = 链末 trace_id = 'trace-B'）下按 'trace-B' 查判词 0 行
    // → 误判 success，下面三处断言必红。
    const rootId = insertRootMessage({
      id: 'msg-root',
      task_id: 'anchor-A',
      created_at: sqliteNow(60),
    })
    insertExecution({
      triggered_by: rootId,
      status: 'completed',
      trace_id: 'trace-B', // 当轮追踪 id ≠ 锚（非同一个值，旧实现正是拿它去 JOIN）
      started_at: isoNow(50),
      ended_at: isoNow(45),
    })
    // 判词消息 task_id = 链锚（T-E 后 agent 回复继承触发消息的 task_id）
    insertVerdict({ task_id: 'anchor-A', verdict: 'reject', created_at: isoNow(40) })

    classifyEpisodes()
    const ep = getEpisode(rootId)
    expect(ep!.chain_task_id).toBe('anchor-A')
    expect(ep!.chain_task_id).not.toBe('trace-B')
    expect(ep!.outcome).toBe('needs_investigation')
  })

  it("②'''' 锚为空的存量链（pre-T-E）：退到链末 trace 近似值，判词仍关联（降级不制造新缺口）", () => {
    // 实测：全库 540 条链上判词命中「按锚 3 增 / 4 失」，4 条失的全是根 task_id 为 NULL
    // 的存量链（`3fee9a56` 等）。降级路径保住这 4 条——旧近似值只在**没有锚**时启用。
    const rootId = insertRootMessage({ id: 'msg-root-legacy', created_at: sqliteNow(60) }) // task_id 缺省 NULL
    insertExecution({
      triggered_by: rootId,
      status: 'completed',
      trace_id: 'trace-legacy',
      started_at: isoNow(50),
      ended_at: isoNow(45),
    })
    insertVerdict({ task_id: 'trace-legacy', verdict: 'suggest', created_at: isoNow(40) })

    classifyEpisodes()
    const ep = getEpisode(rootId)
    expect(ep!.chain_task_id).toBe('trace-legacy')
    expect(ep!.outcome).toBe('needs_investigation')
    // 对照：有锚的链不因「链末 trace 恰好也是某条消息的 task_id」而劫持锚
    expect(ep!.chain_task_id).not.toBeNull()
  })

  it('③ suggest + completed 晚于最近 suggest → corrected_success', () => {
    const rootId = insertRootMessage({ id: 'msg-root', created_at: sqliteNow(60) })
    insertVerdict({ task_id: 'trace-1', verdict: 'suggest', created_at: isoNow(40) })
    insertExecution({
      triggered_by: rootId,
      status: 'completed',
      trace_id: 'trace-1',
      started_at: isoNow(30),
      ended_at: isoNow(20),
    })

    classifyEpisodes()
    expect(getEpisode(rootId)!.outcome).toBe('corrected_success')
  })

  it("③' 时序反转：completed 早于 suggest → 非 corrected_success（needs_investigation）", () => {
    const rootId = insertRootMessage({ id: 'msg-root', created_at: sqliteNow(60) })
    insertExecution({
      triggered_by: rootId,
      status: 'completed',
      trace_id: 'trace-1',
      started_at: isoNow(50),
      ended_at: isoNow(45),
    })
    insertVerdict({ task_id: 'trace-1', verdict: 'suggest', created_at: isoNow(40) })

    classifyEpisodes()
    expect(getEpisode(rootId)!.outcome).toBe('needs_investigation')
  })

  it('④ 重启打断未恢复（仅 server_restart 失败行）→ abandoned', () => {
    const rootId = insertRootMessage({ id: 'msg-root', created_at: sqliteNow(10) })
    insertExecution({
      triggered_by: rootId,
      status: 'failed',
      trace_id: 'trace-1',
      error_message: 'server_restart',
      error_type: 'server_restart',
      started_at: isoNow(9),
    })

    classifyEpisodes()
    expect(getEpisode(rootId)!.outcome).toBe('abandoned')
  })

  it("④' [failed(server_restart), failed(timeout)] 混合失败 → 非 abandoned，按 timeout 归因 needs_investigation（N2）", () => {
    const rootId = insertRootMessage({ id: 'msg-root', created_at: sqliteNow(10) })
    insertExecution({
      triggered_by: rootId,
      status: 'failed',
      trace_id: 'trace-1',
      error_message: 'server_restart',
      error_type: 'server_restart',
      started_at: isoNow(9),
    })
    insertExecution({
      triggered_by: rootId,
      status: 'failed',
      trace_id: 'trace-1',
      error_message: '执行超时',
      error_type: 'timeout',
      started_at: isoNow(5),
    })

    classifyEpisodes()
    expect(getEpisode(rootId)!.outcome).toBe('needs_investigation')
  })

  it('⑤ 同 triggered_by 全量失败（error_type 无明确归因）→ routing_failure', () => {
    const rootId = insertRootMessage({ id: 'msg-root', created_at: sqliteNow(10) })
    insertExecution({
      triggered_by: rootId,
      status: 'failed',
      trace_id: 'trace-1',
      error_message: 'boom',
      error_type: null,
      started_at: isoNow(9),
    })
    insertExecution({
      triggered_by: rootId,
      status: 'failed',
      trace_id: 'trace-1',
      error_message: 'silent',
      error_type: 'unknown',
      started_at: isoNow(5),
    })

    classifyEpisodes()
    expect(getEpisode(rootId)!.outcome).toBe('routing_failure')
  })

  it('非重启失败行有明确 harness 归因（parse_error）→ harness_fix_needed', () => {
    const rootId = insertRootMessage({ id: 'msg-root', created_at: sqliteNow(10) })
    insertExecution({
      triggered_by: rootId,
      status: 'failed',
      trace_id: 'trace-1',
      error_message: 'JSON 解析失败',
      error_type: 'parse_error',
      started_at: isoNow(9),
    })

    classifyEpisodes()
    expect(getEpisode(rootId)!.outcome).toBe('harness_fix_needed')
  })
})

describe('scanZeroExecutionEpisodes — 零执行路径（G2-N5 + G3 + G5 + N9）', () => {
  beforeEach(() => {
    setDb(createTestDb())
    seedBase()
  })

  afterEach(() => {
    resetDb()
  })

  it("②'''' 零执行 U 根：>30min 无执行引用 → chain_task_id=NULL 判 abandoned，root_triggered_by=U", () => {
    const rootId = insertRootMessage({ id: 'msg-root', created_at: sqliteNow(31) })

    const n = scanZeroExecutionEpisodes()
    expect(n).toBe(1)
    const ep = getEpisode(rootId)
    expect(ep!.root_triggered_by).toBe('U')
    expect(ep!.chain_task_id).toBeNull()
    expect(ep!.outcome).toBe('abandoned')
    expect(ep!.episode_state).toBe('classified')
    expect(ep!.classification_ver).toBe(EPISODE_CLASSIFICATION_VER)
  })

  it('窗口内（<30min）零执行消息不生成 episode', () => {
    insertRootMessage({ id: 'msg-root', created_at: sqliteNow(10) })
    expect(scanZeroExecutionEpisodes()).toBe(0)
    expect(countEpisodes()).toBe(0)
  })

  it('有执行引用的消息不落入零执行扫描', () => {
    const rootId = insertRootMessage({ id: 'msg-root', created_at: sqliteNow(31) })
    insertExecution({
      triggered_by: rootId,
      status: 'completed',
      trace_id: 'trace-1',
      ended_at: isoNow(20),
    })
    expect(scanZeroExecutionEpisodes()).toBe(0)
  })

  it("②''''' 零执行 H 根：task_id 匹配既有 episode chain_task_id → root_triggered_by=H（非 U）", () => {
    // 先造一个 chain_task_id='trace-X' 的既有 episode（U 根执行链）
    upsertEpisode({
      rootTriggerMessageId: 'msg-u',
      rootTriggeredBy: 'U',
      rootMessageId: 'msg-u',
      taskId: null,
      chainTaskId: 'trace-X',
      sessionId: 's1',
      outcome: 'success',
      episodeState: 'classified',
    })
    // 零执行交接消息带源链 task_id（E3 接线后投递携带），无内容特征
    const hRoot = insertRootMessage({ id: 'msg-h', task_id: 'trace-X', created_at: sqliteNow(31) })

    const n = scanZeroExecutionEpisodes()
    expect(n).toBe(1)
    const ep = getEpisode(hRoot)
    expect(ep!.root_triggered_by).toBe('H')
    expect(ep!.chain_task_id).toBeNull()
    expect(ep!.outcome).toBe('abandoned')
  })

  it("②''''''' 零执行 U 根·task_id 非 NULL 无匹配 → 仍生成 episode（G5 不漏出判定阶梯）", () => {
    const rootId = insertRootMessage({
      id: 'msg-root',
      task_id: 'task-nomatch',
      created_at: sqliteNow(31),
    })

    const n = scanZeroExecutionEpisodes()
    expect(n).toBe(1)
    const ep = getEpisode(rootId)
    expect(ep!.root_triggered_by).toBe('U')
    expect(ep!.outcome).toBe('abandoned')
    expect(ep!.chain_task_id).toBeNull()
  })

  it("②'''''''' 零执行 H 根·无 task_id 带内容特征 → root_triggered_by=H（E3 前承重路径）", () => {
    const hRoot = insertRootMessage({
      id: 'msg-h',
      content: '@ds猫 请补填以下交接文档中 TODO 标注的部分（Why / Tradeoff / Open Questions）。',
      created_at: sqliteNow(31),
    })

    const n = scanZeroExecutionEpisodes()
    expect(n).toBe(1)
    const ep = getEpisode(hRoot)
    expect(ep!.root_triggered_by).toBe('H')
    expect(ep!.outcome).toBe('abandoned')
  })

  it("②''''''''' 同 session 同 task_id 已有 agent 回复 → 不判 abandoned（补填风暴根治方向 2）", () => {
    // 批量答复场景：根消息无独立 execution_log，但同 task_id 的 agent 回复
    // 已证明"这条消息事实上被执行过"——NOT EXISTS 子查询命中，不再生成 episode
    insertRootMessage({ id: 'msg-root', task_id: 'task-batch', created_at: sqliteNow(31) })
    getDb()
      .prepare(
        `INSERT INTO messages (id, session_id, agent_id, role, content, task_id, created_at)
         VALUES (?, 's1', 'agent-1', 'agent', '批量答复', ?, ?)`
      )
      .run('msg-reply', 'task-batch', sqliteNow(20))

    expect(scanZeroExecutionEpisodes()).toBe(0)
    expect(countEpisodes()).toBe(0)
  })

  it("②'''''''''' 同 session 同 task_id 的 agent 回复不存在 → 仍判 abandoned（task_id NULL/不匹配不受影响）", () => {
    // 对照：agent 回复的 task_id 与根消息不同 → 子查询不命中 → 行为不变
    insertRootMessage({ id: 'msg-root', task_id: 'task-a', created_at: sqliteNow(31) })
    getDb()
      .prepare(
        `INSERT INTO messages (id, session_id, agent_id, role, content, task_id, created_at)
         VALUES (?, 's1', 'agent-1', 'agent', '其他任务回复', ?, ?)`
      )
      .run('msg-reply-other', 'task-b', sqliteNow(20))

    expect(scanZeroExecutionEpisodes()).toBe(1)
    const ep = getEpisode('msg-root')
    expect(ep!.outcome).toBe('abandoned')
  })
})

describe('upsert 幂等（⑥）与重判覆盖', () => {
  beforeEach(() => {
    setDb(createTestDb())
    seedBase()
  })

  afterEach(() => {
    resetDb()
  })

  it('同根重复归因：覆盖更新不炸、不产生重复行；结局随链变化翻转', () => {
    const rootId = insertRootMessage({ id: 'msg-root', created_at: sqliteNow(60) })
    insertExecution({
      triggered_by: rootId,
      status: 'completed',
      trace_id: 'trace-1',
      started_at: isoNow(50),
      ended_at: isoNow(45),
    })

    classifyEpisodes()
    expect(countEpisodes()).toBe(1)
    expect(getEpisode(rootId)!.outcome).toBe('success')

    // 任务打回 → 重判翻转（review_verdicts 晚于根）
    insertVerdict({ task_id: 'trace-1', verdict: 'reject', created_at: isoNow(40) })
    classifyEpisodes()
    expect(countEpisodes()).toBe(1) // 不重复
    expect(getEpisode(rootId)!.outcome).toBe('needs_investigation')
    expect(getEpisode(rootId)!.episode_state).toBe('classified')
  })

  it('零执行扫描同消息不重复生成（root_trigger_message_id UNIQUE 兜底）', () => {
    insertRootMessage({ id: 'msg-root', created_at: sqliteNow(31) })
    expect(scanZeroExecutionEpisodes()).toBe(1)
    expect(scanZeroExecutionEpisodes()).toBe(0)
    expect(countEpisodes()).toBe(1)
  })
})

describe('P5 全量重评（classification_ver 驱动，规格 §3 承重假设）', () => {
  beforeEach(() => {
    setDb(createTestDb())
    seedBase()
  })

  afterEach(() => {
    resetDb()
  })

  it('规则升级后重跑全量判定：旧版本结局被覆盖为新版本结局（幂等覆盖）', () => {
    const rootId = insertRootMessage({ id: 'msg-root', created_at: sqliteNow(60) })
    insertExecution({
      triggered_by: rootId,
      status: 'completed',
      trace_id: 'trace-1',
      started_at: isoNow(50),
      ended_at: isoNow(45),
    })
    // 模拟旧规则（v2.0）已判 abandoned 的存量行——schema 无变化，直接覆盖重评
    getDb()
      .prepare(
        `INSERT INTO episodes (id, root_trigger_message_id, root_triggered_by, root_message_id, task_id, chain_task_id, session_id, outcome, episode_state, classification_ver)
         VALUES ('ep-old', 'msg-root', 'U', 'msg-root', NULL, 'trace-1', 's1', 'abandoned', 'classified', 'v2.0')`
      )
      .run()

    expect(episodeStats().versionStale).toBe(1)
    classifyEpisodes()
    const ep = getEpisode(rootId)!
    // 覆盖更新：同根不产生重复行（UNIQUE 冲突键）
    expect(countEpisodes()).toBe(1)
    // 旧结局被当前规则重判覆盖（abandoned → success），版本号随当前常量更新
    expect(ep.outcome).toBe('success')
    expect(ep.classification_ver).toBe(EPISODE_CLASSIFICATION_VER)
    expect(episodeStats().versionStale).toBe(0)
  })

  it('episodeStats：U 根任务结局计数 / H 根不计任务结局 / open 与版本偏差分行', () => {
    // U 根 success（执行链完成）
    const uOk = insertRootMessage({ id: 'msg-u-ok', created_at: sqliteNow(60) })
    insertExecution({
      triggered_by: uOk,
      status: 'completed',
      trace_id: 'trace-u',
      started_at: isoNow(50),
      ended_at: isoNow(45),
    })
    // U 根 abandoned（零执行超窗——无 @ 闲聊暴露语义）
    insertRootMessage({ id: 'msg-u-drop', created_at: sqliteNow(60) })
    // H 根（交接消息被静默丢）→ 内容特征判定 H，不计任务结局
    insertRootMessage({
      id: 'msg-h-drop',
      created_at: sqliteNow(60),
      content: '@ds猫 请补填以下交接文档中 TODO 标注的部分（Why / Tradeoff / Open Questions）。',
    })
    // open 行（running 在途，outcome NULL）
    const uRunning = insertRootMessage({ id: 'msg-u-run', created_at: sqliteNow(60) })
    insertExecution({
      triggered_by: uRunning,
      status: 'running',
      trace_id: 'trace-run',
      started_at: isoNow(50),
    })

    classifyEpisodes()
    const stats = episodeStats()
    expect(stats.uRoot.success).toBe(1)
    expect(stats.uRoot.abandoned).toBe(1)
    expect(stats.uRoot.needs_investigation).toBeUndefined()
    // H 根计入 hRoot（不双计到 uRoot）
    expect(stats.hRoot.abandoned).toBe(1)
    expect(stats.uRoot.abandoned).toBe(1) // U 根的 abandoned 与 H 根互不干扰
    expect(stats.open).toBe(1)
    expect(stats.versionStale).toBe(0)
  })
})
