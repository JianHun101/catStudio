/**
 * recovery.ts 测试 — 静默丢重放的**锚内有序**判据（T-G 收窄）。
 *
 * 只覆盖 `replayStuckUserMessages` 的跳过/继续分叉（引擎执行段不在本文件范围：
 * 未初始化引擎时该段抛错被逐条 catch 吞掉，正是「继续走补派」的可观测痕迹）。
 *
 * 病灶：原判据是**链级存在性**（`hasAgentReplyByTaskId` = `LIMIT 1` 任意一条同锚回复），
 * 长链里链首一条旧回复就会让之后真被静默丢的消息永久跳过——既不再重放、也无痕迹。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository } from '../db/repository/index.js'

import { replayStuckUserMessages, REPLAY_STUCK_WINDOW_MINUTES } from './recovery.js'
import type { EngineBus, HandoffBus } from './bus.js'

const SESSION = 'session-1'
const ANCHOR = 'anchor-1'

/** 超窗时间戳（库内格式 'YYYY-MM-DD HH:MM:SS'，UTC）——扫描判据要求早于 now-30min */
function pastTs(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60000).toISOString().replace('T', ' ').slice(0, 19)
}

function insertMessage(opts: {
  id: string
  role: 'user' | 'agent'
  taskId: string | null
  createdAt: string
  mentions?: string
}): void {
  getDb()
    .prepare(
      `INSERT INTO messages (id, session_id, role, content, mentions, task_id, agent_id, created_at)
       VALUES (?, ?, ?, '内容', ?, ?, ?, ?)`
    )
    .run(
      opts.id,
      SESSION,
      opts.role,
      opts.mentions ?? '[]',
      opts.taskId,
      opts.role === 'agent' ? 'agent-1' : null,
      opts.createdAt
    )
}

function dispatchState(id: string): string | null {
  const row = getDb().prepare('SELECT dispatch_state FROM messages WHERE id = ?').get(id) as
    { dispatch_state: string | null } | undefined
  return row?.dispatch_state ?? null
}

describe('execution/recovery — 静默丢重放的锚内有序判据（T-G）', () => {
  beforeEach(() => {
    setDb(createTestDb())
    initRepository(getDb())
    getDb()
      .prepare(`INSERT INTO sessions (id, title, agent_ids) VALUES (?, '测试会话', '["agent-1"]')`)
      .run(SESSION)
    getDb()
      .prepare(
        `INSERT INTO agents (id, name, avatar, system_prompt, llm_provider, llm_model, llm_api_key, role)
         VALUES ('agent-1', 'ds猫', '🐱', 'p', 'deepseek', 'deepseek-v4-flash', 'sk-test', 'implementer')`
      )
      .run()
  })

  afterEach(() => {
    resetDb()
  })

  it('同锚回复**晚于**本条 → 归一 done 跳过（批量答复语义，与旧实现同结果）', async () => {
    insertMessage({ id: 'stuck-1', role: 'user', taskId: ANCHOR, createdAt: pastTs(120) })
    insertMessage({ id: 'reply-1', role: 'agent', taskId: ANCHOR, createdAt: pastTs(110) })

    await replayStuckUserMessages({} as EngineBus & HandoffBus)

    expect(dispatchState('stuck-1')).toBe('done')
  })

  it('同锚回复**均早于**本条（长链旧回复）→ 不跳过，走补派（旧实现必红）', async () => {
    // 链首一条旧 agent 回复（同锚）——旧判据 `LIMIT 1` 任意命中即跳过
    insertMessage({ id: 'old-reply', role: 'agent', taskId: ANCHOR, createdAt: pastTs(300) })
    // 本条落库晚于它、且无任何 execution_log 引用（真静默丢）
    insertMessage({ id: 'stuck-2', role: 'user', taskId: ANCHOR, createdAt: pastTs(120) })

    await replayStuckUserMessages({} as EngineBus & HandoffBus)

    // 旧实现：`hasAgentReplyByTaskId` 命中 old-reply → done（本条永不重放，断言必红）
    expect(dispatchState('stuck-2')).not.toBe('done')
  })

  it('无锚（存量链）→ 退化现状，不因新判据误伤（对照用例，非区分性）', async () => {
    insertMessage({ id: 'legacy-reply', role: 'agent', taskId: null, createdAt: pastTs(300) })
    insertMessage({ id: 'legacy-stuck', role: 'user', taskId: null, createdAt: pastTs(120) })

    await replayStuckUserMessages({} as EngineBus & HandoffBus)

    expect(dispatchState('legacy-stuck')).not.toBe('done')
  })

  it('超窗常数钉死（判据依赖的时间边界，单位=分钟）', () => {
    expect(REPLAY_STUCK_WINDOW_MINUTES).toBe(30)
  })
})
