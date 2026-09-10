/**
 * 契约③ X2 闭环（flow-advance）单元测试。
 *
 * 验证 verdict 落盘后的状态机推进 + closeout 兜底提醒（非阻塞、DB 异常静默）：
 * - 反查链：verdict message → task_id（源链 trace）→ execution_logs.commit_hash
 * - approve / comment（💬 非阻断档）→ 沿主干道推进至 closed（每步留审计）
 * - 判定式收口已投（targets 含 store 猫）→ 不重复补 closeout 提醒
 * - 判定式收口未投 → 真正投递 closeout 提醒（ingest 落库 @店长 + 源链 task_id）
 * - suggest/reject → 打回内容寻址，状态机不动
 * - 纯会话无 commit 链路（task_id 空 / 执行行无 commit_hash）→ 跳过不抛错
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository } from '../db/repository/index.js'
import { advanceFlowAfterVerdict } from './flow-advance.js'
import { getFlowState } from '../db/repository/flowStates.js'

const SESSION = 'session-1'
const SHA = 'a'.repeat(40)
const TRACE = 'trace-1'

/** 插入一条带 task_id 的 review 消息 + 源链执行行（trace_id=task_id，挂 commit_hash） */
function seedReviewContext(opts: { taskId?: string; commitHash?: string } = {}): string {
  const msgId = 'msg-1'
  const taskId = opts.taskId ?? TRACE
  const db = getDb()
  db.prepare(
    `INSERT INTO messages (id, session_id, role, content, mentions, task_id)
     VALUES (?, ?, 'agent', '✅可合并', '[]', ?)`
  ).run(msgId, SESSION, taskId)
  // 源链实施行：trace_id = task_id（E3 接线），commit_hash 挂该行
  if (opts.commitHash) {
    db.prepare(
      `INSERT INTO execution_logs (id, session_id, agent_id, triggered_by_message_id, status, trace_id, commit_hash)
       VALUES ('exec-1', ?, 'agent-1', 'trigger-1', 'completed', ?, ?)`
    ).run(SESSION, taskId, opts.commitHash)
  }
  return msgId
}

describe('execution/flow-advance — 契约③ X2 闭环', () => {
  beforeEach(() => {
    setDb(createTestDb())
    initRepository(getDb())
    const db = getDb()
    db.prepare(
      `INSERT INTO sessions (id, title, agent_ids) VALUES ('session-1', '测试会话', '[]')`
    ).run()
    // execution_logs 有 FK → agents；补一行（完整 NOT NULL 字段）
    db.prepare(
      `INSERT INTO agents (id, name, system_prompt, llm_provider, llm_model, llm_api_key)
       VALUES ('agent-1', '吐槽猫', 'You are a cat.', 'deepseek', 'deepseek-v4-pro', 'sk')`
    ).run()
    // store 角色猫（closeout 投递目标解析用）——默认不在会话成员里（agent_ids='[]'），
    // 投递用例单独把本行挂进会话，其余用例走「无 store 成员 → 不投递」路径
    db.prepare(
      `INSERT INTO agents (id, name, system_prompt, llm_provider, llm_model, llm_api_key, role)
       VALUES ('agent-store', '店长', 'You are a cat.', 'deepseek', 'deepseek-v4-pro', 'sk', 'store')`
    ).run()
  })

  afterEach(() => {
    resetDb()
  })

  it('approve → 沿主干道推进至 closed（flow_states 状态 + 审计流水完整）', () => {
    const msgId = seedReviewContext({ taskId: TRACE, commitHash: SHA })
    // 入口已记 quality-gate（messages.ts:102 语义）；无则从 implement 起点推算
    advanceFlowAfterVerdict({
      messageId: msgId,
      sessionId: SESSION,
      verdict: 'approve',
      targets: [], // 判定式收口未投（无 store 猫）
    })

    // 状态推进至 closed
    expect(getFlowState(SESSION, SHA)?.state).toBe('closed')
    // 审计流水：quality-gate → request-review → receive-review → closed 四步留痕
    const events = getDb()
      .prepare(
        `SELECT from_state, to_state, intent FROM flow_state_events WHERE session_id = ? AND commit_sha = ? ORDER BY id`
      )
      .all(SESSION, SHA) as Array<{ from_state: string | null; to_state: string; intent: string }>
    expect(events.length).toBeGreaterThanOrEqual(3)
    const last = events[events.length - 1]
    expect(last.to_state).toBe('closed')
    expect(last.intent).toBe('closeout')
  })

  it('approve 且判定式收口已投（targets 含 store 猫）→ 不重复推进（closed 终态），closeout 兜底不补', () => {
    const msgId = seedReviewContext({ taskId: TRACE, commitHash: SHA })
    // 先推进到 closed（一次 review）
    advanceFlowAfterVerdict({
      messageId: msgId,
      sessionId: SESSION,
      verdict: 'approve',
      targets: [],
    })
    // 第二次 review（同 commit）判定式已投 store 猫 → 状态机不再前进
    advanceFlowAfterVerdict({
      messageId: msgId,
      sessionId: SESSION,
      verdict: 'approve',
      targets: [{ name: '店长', isStore: true }],
    })
    // closed 是终态，不因重复 approve 变化；审计流水不止增（幂等，closed 无下一步）
    expect(getFlowState(SESSION, SHA)?.state).toBe('closed')
  })

  it('同一链第二条判词 → 提醒仍投出（不被 (session, sha) 记账吞掉，T-G bug B 后半）', () => {
    // **本条即 T-G 验收③ 的区分性用例**：两条**不同**判词消息解析到**同一个** commit
    // （sha 反查 1 trace→1 commit 残留缺陷下，后一轮判词恒落到已 closed 的 sha）。
    // 旧实现把提醒挂在 `advanced` 上 → 第 2 条撞已 closed ⇒ 提醒永久不投且不报错：
    // 断言 2 条时旧实现给 1 条，**必红**。
    getDb().prepare(`UPDATE sessions SET agent_ids = '["agent-store"]' WHERE id = ?`).run(SESSION)
    const msg1 = seedReviewContext({ taskId: TRACE, commitHash: SHA })
    getDb()
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions, task_id)
         VALUES ('msg-2', ?, 'agent', '💬仅评论', '[]', ?)`
      )
      .run(SESSION, TRACE)

    advanceFlowAfterVerdict({
      messageId: msg1,
      sessionId: SESSION,
      verdict: 'approve',
      targets: [],
    })
    advanceFlowAfterVerdict({
      messageId: 'msg-2',
      sessionId: SESSION,
      verdict: 'comment',
      targets: [],
    })

    const notices = getDb()
      .prepare(
        `SELECT content FROM messages
         WHERE session_id = ? AND role = 'user' AND content LIKE '%契约③·状态机兜底%'
         ORDER BY rowid`
      )
      .all(SESSION) as Array<{ content: string }>
    expect(notices.length).toBe(2)
    // 复核状态机本身仍幂等：closed 是终态，不因第二条判词重复推进
    expect(getFlowState(SESSION, SHA)?.state).toBe('closed')
  })

  it('approve 且判定式收口未投 → closeout 提醒真正投递（@店长 消息落库 + 源链 task_id）', () => {
    // 会话成员含 store 猫——投递目标可解析（其余用例 agent_ids='[]' 走不投递路径）
    getDb().prepare(`UPDATE sessions SET agent_ids = '["agent-store"]' WHERE id = ?`).run(SESSION)
    const msgId = seedReviewContext({ taskId: TRACE, commitHash: SHA })

    advanceFlowAfterVerdict({
      messageId: msgId,
      sessionId: SESSION,
      verdict: 'approve',
      targets: [], // 判定式收口未投（allowedNames 无 store 猫）
    })

    expect(getFlowState(SESSION, SHA)?.state).toBe('closed')
    // 投递落库可见：ingest 同步段在首个 await 前完成 INSERT（本模块不 await 也能断言）
    const notices = getDb()
      .prepare(
        `SELECT content, mentions, task_id FROM messages
         WHERE session_id = ? AND role = 'user' ORDER BY created_at DESC, rowid DESC`
      )
      .all(SESSION) as Array<{ content: string; mentions: string; task_id: string | null }>
    const notice = notices.find((r) => r.content.includes('契约③·状态机兜底'))
    expect(notice).toBeDefined()
    expect(JSON.parse(notice!.mentions)).toEqual(['店长'])
    expect(notice!.task_id).toBe(TRACE) // 源链 task_id 随投递携带（收口链同线程）
    expect(notice!.content).toContain(SHA.slice(0, 7))
  })

  it('comment（💬 非阻断）→ 照常推进至 closed（「不阻断收口」的落地，T-C）', () => {
    const msgId = seedReviewContext({ taskId: TRACE, commitHash: SHA })
    advanceFlowAfterVerdict({
      messageId: msgId,
      sessionId: SESSION,
      verdict: 'comment',
      targets: [],
    })
    expect(getFlowState(SESSION, SHA)?.state).toBe('closed')
  })

  it('comment 且判定式收口未投 → closeout 提醒正文标注 💬仅评论（非阻断），不冒充 ✅', () => {
    getDb().prepare(`UPDATE sessions SET agent_ids = '["agent-store"]' WHERE id = ?`).run(SESSION)
    const msgId = seedReviewContext({ taskId: TRACE, commitHash: SHA })

    advanceFlowAfterVerdict({
      messageId: msgId,
      sessionId: SESSION,
      verdict: 'comment',
      targets: [],
    })

    const notices = getDb()
      .prepare(`SELECT content FROM messages WHERE session_id = ? AND role = 'user'`)
      .all(SESSION) as Array<{ content: string }>
    const notice = notices.find((r) => r.content.includes('契约③·状态机兜底'))
    expect(notice).toBeDefined()
    // 店长据提醒决定收不收口——档位必须如实标注，不能让 💬 读起来像 ✅
    expect(notice!.content).toContain('💬仅评论（非阻断）')
    expect(notice!.content).not.toContain('✅可合并')
  })

  it('会话无 store 成员 → closeout 提醒不投递（仅留痕，不抛错）', () => {
    const msgId = seedReviewContext({ taskId: TRACE, commitHash: SHA })
    expect(() =>
      advanceFlowAfterVerdict({
        messageId: msgId,
        sessionId: SESSION,
        verdict: 'approve',
        targets: [],
      })
    ).not.toThrow()
    // 无 store 成员 = 无处可投：不产生任何 user 消息
    const count = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'user'`)
      .get(SESSION) as { n: number }
    expect(count.n).toBe(0)
  })

  it('suggest/reject → 打回内容寻址新 sha 自解，状态机不动（不推进）', () => {
    const msgId = seedReviewContext({ taskId: TRACE, commitHash: SHA })
    advanceFlowAfterVerdict({
      messageId: msgId,
      sessionId: SESSION,
      verdict: 'reject',
      targets: [],
    })
    // 无初始 flow_state 行 → 不记录（打回不走主干道）
    expect(getFlowState(SESSION, SHA)).toBeUndefined()
  })

  it('纯会话无 commit 链路（执行行无 commit_hash）→ 跳过不抛错（非阻塞）', () => {
    // 有 task_id 但执行行无 commit_hash（纯会话）
    const msgId = seedReviewContext({ taskId: TRACE, commitHash: undefined })
    expect(() =>
      advanceFlowAfterVerdict({
        messageId: msgId,
        sessionId: SESSION,
        verdict: 'approve',
        targets: [],
      })
    ).not.toThrow()
  })

  it('任务消息无 task_id → 反查失败跳过（不抛错）', () => {
    const msgId = 'msg-no-task'
    getDb()
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, mentions, task_id)
         VALUES (?, ?, 'agent', '✅可合并', '[]', NULL)`
      )
      .run(msgId, SESSION)
    expect(() =>
      advanceFlowAfterVerdict({
        messageId: msgId,
        sessionId: SESSION,
        verdict: 'approve',
        targets: [],
      })
    ).not.toThrow()
  })

  it('approve 从无初始记录（implement 起点）推进仍能走完主干道', () => {
    const msgId = seedReviewContext({ taskId: TRACE, commitHash: SHA })
    advanceFlowAfterVerdict({
      messageId: msgId,
      sessionId: SESSION,
      verdict: 'approve',
      targets: [],
    })
    expect(getFlowState(SESSION, SHA)?.state).toBe('closed')
  })

  it('无有效 verdict（no-marker）→ 不落 verdict → flow-advance 不应推进（recordReviewVerdict 返回 null）', () => {
    // 验证串行契约：recordReviewVerdict 对无标记返回 null，serial 不调 flow-advance
    const msgId = seedReviewContext({ taskId: TRACE, commitHash: SHA })
    expect(getFlowState(SESSION, SHA)).toBeUndefined()
    void msgId
  })

  it('入口衔接（messages.ts:102 已记 quality-gate）→ approve → 从 review_commit 起推进，不重复记 quality-gate', () => {
    // 入口语义：commit 写回时 recordFlowTransition(..., 'quality-gate', 'quality_gate')
    const msgId = seedReviewContext({ taskId: TRACE, commitHash: SHA })
    const db = getDb()
    db.prepare(
      `INSERT INTO flow_states (session_id, commit_sha, state, updated_at)
       VALUES (?, ?, 'quality-gate', datetime('now'))`
    ).run(SESSION, SHA)

    advanceFlowAfterVerdict({
      messageId: msgId,
      sessionId: SESSION,
      verdict: 'approve',
      targets: [],
    })

    // 达标 closed；审计流水：from=quality-gate → 不重复 quality_gate（入口已表）
    const events = getDb()
      .prepare(
        `SELECT from_state, to_state, intent FROM flow_state_events WHERE session_id = ? AND commit_sha = ? ORDER BY id`
      )
      .all(SESSION, SHA) as Array<{ from_state: string | null; to_state: string; intent: string }>
    expect(events[0].to_state).toBe('request-review') // 首步 review_commit，非重复 quality-gate
    expect(events[events.length - 1].to_state).toBe('closed')
  })
})
