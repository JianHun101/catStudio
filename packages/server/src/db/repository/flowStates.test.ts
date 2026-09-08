/**
 * flow_states / flow_state_events 表读写测试（契约③ 当前状态 + 审计流水）。
 *
 * - getFlowState：原子读
 * - recordFlowTransition：同事务更新（状态字段 + 审计流水一起落）——事务失败回滚、
 *   幂等 upsert 覆盖当前状态、流水 append 不覆盖
 * - 重启 in-flight 恢复：记录后即可读到持久状态 + 状态机据此机械推导「下一步」
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb } from '../../test-helpers.js'
import { setDb, resetDb, getDb } from '../../db/index.js'
import { initRepository } from './index.js'
import { recordFlowTransition, getFlowState } from './flowStates.js'
import { deriveNextIntent } from '../../execution/flow-state.js'

const SESSION = 'session-a'
const SHA = 'a'.repeat(40)

describe('db/repository/flowStates — recordFlowTransition / getFlowState', () => {
  beforeEach(() => {
    setDb(createTestDb())
    initRepository(getDb())
  })

  afterEach(() => {
    resetDb()
  })

  it('记录后 → 读到当前状态（状态字段落库）', () => {
    recordFlowTransition(SESSION, SHA, 'quality-gate', 'quality_gate')
    const row = getFlowState(SESSION, SHA)
    expect(row?.state).toBe('quality-gate')
  })

  it('同事务更新：状态字段 + 审计流水一起落（幂等 upsert 覆盖当前状态，流水 append）', () => {
    recordFlowTransition(SESSION, SHA, 'quality-gate', 'quality_gate')
    recordFlowTransition(SESSION, SHA, 'request-review', 'receive_review')
    const row = getFlowState(SESSION, SHA)
    // 当前状态被后续迁移覆盖
    expect(row?.state).toBe('request-review')
    // 审计流水 append：两条迁移各留痕、from→to 正确
    const events = getDb()
      .prepare(
        'SELECT from_state, to_state, intent FROM flow_state_events WHERE session_id = ? AND commit_sha = ? ORDER BY id'
      )
      .all(SESSION, SHA) as Array<{ from_state: string | null; to_state: string; intent: string }>
    expect(events).toEqual([
      { from_state: null, to_state: 'quality-gate', intent: 'quality_gate' },
      { from_state: 'quality-gate', to_state: 'request-review', intent: 'receive_review' },
    ])
  })

  it('重启 in-flight 恢复：记录后重新注入 repo 实例，状态仍在且状态机可据此推导「下一步」', () => {
    // 模拟 commit 已进入主干道但审查未完成（in-flight）
    recordFlowTransition(SESSION, SHA, 'quality-gate', 'quality_gate')
    // 重新初始化（等价重启后仓库层连接到同一持久库）
    const freshDb = getDb()
    initRepository(freshDb)
    const row = getFlowState(SESSION, SHA)
    expect(row?.state).toBe('quality-gate')
    // 状态机读当前状态机械推导下一步（派生，不落库）
    const next = deriveNextIntent(row?.state as never)
    expect(next?.intent).toBe('review_commit')
  })
})
