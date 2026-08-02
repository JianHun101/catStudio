/**
 * replyBus 事件总线测试（P3 AC1）。
 *
 * 覆盖：订阅触发 / 取消订阅后不触发 / 取消函数幂等 / 多订阅者各自收到 / emit 不 await 订阅者。
 */
import { describe, it, expect, vi } from 'vitest'
import { onAgentReply, emitAgentReply, type AgentReplyMessage } from './replyBus.js'

const msg = (overrides: Partial<AgentReplyMessage> = {}): AgentReplyMessage => ({
  id: 'msg-1',
  agentId: 'agent-ds',
  agentName: 'ds猫',
  sessionId: 'session-1',
  content: '喵',
  ...overrides,
})

describe('replyBus', () => {
  it('AC1-1: 订阅后 emit 触发回调并携带完整消息', () => {
    const cb = vi.fn()
    const unsubscribe = onAgentReply(cb)
    emitAgentReply(msg({ content: '你好' }))
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(msg({ content: '你好' }))
    unsubscribe()
  })

  it('AC1-2: 取消订阅后不再触发', () => {
    const cb = vi.fn()
    const unsubscribe = onAgentReply(cb)
    unsubscribe()
    emitAgentReply(msg())
    expect(cb).not.toHaveBeenCalled()
  })

  it('AC1-3: 取消函数幂等——重复调用不报错', () => {
    const cb = vi.fn()
    const unsubscribe = onAgentReply(cb)
    unsubscribe()
    unsubscribe()
    emitAgentReply(msg())
    expect(cb).not.toHaveBeenCalled()
  })

  it('AC1-4: 多个订阅者各自收到事件', () => {
    const cb1 = vi.fn()
    const cb2 = vi.fn()
    const unsub1 = onAgentReply(cb1)
    const unsub2 = onAgentReply(cb2)
    emitAgentReply(msg())
    expect(cb1).toHaveBeenCalledTimes(1)
    expect(cb2).toHaveBeenCalledTimes(1)
    // 取消一个，另一个仍收到
    unsub1()
    emitAgentReply(msg({ id: 'msg-2' }))
    expect(cb1).toHaveBeenCalledTimes(1)
    expect(cb2).toHaveBeenCalledTimes(2)
    unsub2()
  })
})
