import { describe, it, expect, beforeEach } from 'vitest'
import {
  storeUserRequestSignal,
  consumeUserRequestSignals,
  __test_resetUserRequestSignals,
  __test_userRequestSignalCount,
  type UserRequestSignal,
} from './user-request-signals.js'

const signal = (over: Partial<UserRequestSignal> = {}): UserRequestSignal => ({
  sessionId: 'session-1',
  agentId: 'agent-store',
  msgId: 'msg-1',
  type: 'restart',
  reason: '服务器卡死',
  ...over,
})

describe('user-request-signals（MCP 用户请求信号存储）', () => {
  beforeEach(() => {
    __test_resetUserRequestSignals()
  })

  it('store 后按同 agent + 同 msgId 消费取走（含 type/reason/options 原样）', () => {
    storeUserRequestSignal(signal({ options: [{ id: 'a', label: '选项A' }] }))
    const consumed = consumeUserRequestSignals('session-1', 'agent-store', 'msg-1')
    expect(consumed).toHaveLength(1)
    expect(consumed[0]).toMatchObject({
      type: 'restart',
      reason: '服务器卡死',
      options: [{ id: 'a', label: '选项A' }],
    })
    // 消费即清除——重复消费取不到
    expect(consumeUserRequestSignals('session-1', 'agent-store', 'msg-1')).toHaveLength(0)
    expect(__test_userRequestSignalCount()).toBe(0)
  })

  it('messageId 标签：不同 msgId 的信号不被消费（abort 残留天然失效）', () => {
    // 旧流 msg-0 的残留信号（abort 后同 agent 重跑的场景）
    storeUserRequestSignal(signal({ msgId: 'msg-0', reason: '旧流残留' }))
    // 新流 msg-1 的信号
    storeUserRequestSignal(signal())
    const consumed = consumeUserRequestSignals('session-1', 'agent-store', 'msg-1')
    expect(consumed).toHaveLength(1)
    expect(consumed[0].reason).toBe('服务器卡死')
    // 残留仍在（无清理逻辑，靠标签天然失效）——但下轮 msg-0 流若真出现仍可消费
    expect(__test_userRequestSignalCount()).toBe(1)
    expect(consumeUserRequestSignals('session-1', 'agent-store', 'msg-0')[0].reason).toBe(
      '旧流残留'
    )
  })

  it('同 agent 同流重复投递 → 合并为一条，reason 取最后到达', () => {
    storeUserRequestSignal(signal({ reason: '第一次' }))
    storeUserRequestSignal(signal({ reason: '第二次' }))
    const consumed = consumeUserRequestSignals('session-1', 'agent-store', 'msg-1')
    expect(consumed).toHaveLength(1)
    expect(consumed[0].reason).toBe('第二次')
  })

  it('不同 session 的信号不串扰（同 agent 复合键隔离）', () => {
    storeUserRequestSignal(signal({ sessionId: 'session-2' }))
    expect(consumeUserRequestSignals('session-1', 'agent-store', 'msg-1')).toHaveLength(0)
    expect(__test_userRequestSignalCount()).toBe(1)
  })

  it('不同 agent 的信号互不消费', () => {
    storeUserRequestSignal(signal({ agentId: 'agent-impl' }))
    expect(consumeUserRequestSignals('session-1', 'agent-store', 'msg-1')).toHaveLength(0)
    expect(consumeUserRequestSignals('session-1', 'agent-impl', 'msg-1')).toHaveLength(1)
  })

  it('push 类型信号：存储 + 消费原样（type=push 与 restart 并行不互斥）', () => {
    storeUserRequestSignal(signal({ type: 'push', reason: '收口待推送' }))
    const consumed = consumeUserRequestSignals('session-1', 'agent-store', 'msg-1')
    expect(consumed).toHaveLength(1)
    expect(consumed[0]).toMatchObject({ type: 'push', reason: '收口待推送' })
  })

  it('同流 restart + push 重复投递 → 合并为一条（最后到达的 type 生效——同流只应发一个请求）', () => {
    storeUserRequestSignal(signal({ type: 'push', reason: '收口待推送' }))
    storeUserRequestSignal(signal({ type: 'restart', reason: '服务器卡死' }))
    const consumed = consumeUserRequestSignals('session-1', 'agent-store', 'msg-1')
    expect(consumed).toHaveLength(1)
    expect(consumed[0]).toMatchObject({ type: 'restart', reason: '服务器卡死' })
  })
})
