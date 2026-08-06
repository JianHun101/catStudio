import { describe, it, expect, beforeEach } from 'vitest'
import {
  storeRouteSignal,
  consumeRouteSignals,
  __test_resetRouteSignals,
  __test_routeSignalCount,
  type RouteSignal,
} from './route-signals.js'

const signal = (over: Partial<RouteSignal> = {}): RouteSignal => ({
  sessionId: 'session-1',
  agentId: 'agent-ds',
  msgId: 'msg-1',
  targetCats: ['店长'],
  ...over,
})

describe('route-signals（MCP 结构化路由信号存储）', () => {
  beforeEach(() => {
    __test_resetRouteSignals()
  })

  it('store 后按同 agent + 同 msgId 消费取走', () => {
    storeRouteSignal(signal())
    const consumed = consumeRouteSignals('session-1', 'agent-ds', 'msg-1')
    expect(consumed).toHaveLength(1)
    expect(consumed[0].targetCats).toEqual(['店长'])
    // 消费即清除——重复消费取不到
    expect(consumeRouteSignals('session-1', 'agent-ds', 'msg-1')).toHaveLength(0)
    expect(__test_routeSignalCount()).toBe(0)
  })

  it('messageId 标签：不同 msgId 的信号不被消费（abort 残留天然失效）', () => {
    // 旧流 msg-0 的残留信号（abort 后同 agent 重跑的场景）
    storeRouteSignal(signal({ msgId: 'msg-0', targetCats: ['吐槽猫'] }))
    // 新流 msg-1 的信号
    storeRouteSignal(signal())
    const consumed = consumeRouteSignals('session-1', 'agent-ds', 'msg-1')
    expect(consumed.flatMap((s) => s.targetCats)).toEqual(['店长'])
    // 残留仍在（无清理逻辑，靠标签天然失效）——但下轮 msg-0 流若真出现仍可消费
    expect(__test_routeSignalCount()).toBe(1)
    expect(
      consumeRouteSignals('session-1', 'agent-ds', 'msg-0').flatMap((s) => s.targetCats)
    ).toEqual(['吐槽猫'])
  })

  it('同 agent 同流重复投递 → 目标并集去重（模型多次调 post_message）', () => {
    storeRouteSignal(signal({ targetCats: ['店长'] }))
    storeRouteSignal(signal({ targetCats: ['店长', '吐槽猫'] }))
    const consumed = consumeRouteSignals('session-1', 'agent-ds', 'msg-1')
    expect(consumed).toHaveLength(1)
    expect(consumed[0].targetCats).toEqual(['店长', '吐槽猫'])
  })

  it('不同 session 的信号不串扰（同 agent 复合键隔离）', () => {
    storeRouteSignal(signal({ sessionId: 'session-2' }))
    expect(consumeRouteSignals('session-1', 'agent-ds', 'msg-1')).toHaveLength(0)
    expect(__test_routeSignalCount()).toBe(1)
  })

  it('不同 agent 的信号互不消费', () => {
    storeRouteSignal(signal({ agentId: 'agent-flash' }))
    expect(consumeRouteSignals('session-1', 'agent-ds', 'msg-1')).toHaveLength(0)
    expect(consumeRouteSignals('session-1', 'agent-flash', 'msg-1')).toHaveLength(1)
  })
})
