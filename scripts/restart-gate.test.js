/**
 * decideRestartAction 判定逻辑单测（重启确认机制验收④：
 * dev.js 对 confirmed 且新鲜请求 → 执行；过期 → 清理；pending/损坏 → 忽略）。
 */
import { describe, it, expect } from 'vitest'
import { decideRestartAction } from './restart-gate.js'

const NOW = 1_800_000_000_000 // 固定基准时间，测试注入避免 Date.now 漂移

function makeReq(overrides = {}) {
  return JSON.stringify({
    messageId: 'msg-1',
    sessionId: 'session-1',
    reason: '测试重启',
    createdAt: new Date(NOW - 60_000).toISOString(),
    expiresAt: new Date(NOW + 10 * 60 * 1000).toISOString(),
    state: 'confirmed',
    ...overrides,
  })
}

describe('decideRestartAction', () => {
  it('confirmed 且未过期 → restart', () => {
    expect(decideRestartAction(makeReq(), NOW)).toBe('restart')
  })

  it('confirmed 恰好到过期时刻 → restart（边界不超时）', () => {
    const req = makeReq({ expiresAt: new Date(NOW).toISOString() })
    expect(decideRestartAction(req, NOW)).toBe('restart')
  })

  it('confirmed 但已过期 → expired', () => {
    const req = makeReq({ expiresAt: new Date(NOW - 1).toISOString() })
    expect(decideRestartAction(req, NOW)).toBe('expired')
  })

  it('pending（未确认）→ null（忽略）', () => {
    expect(decideRestartAction(makeReq({ state: 'pending' }), NOW)).toBeNull()
  })

  it('非法 JSON → null', () => {
    expect(decideRestartAction('not-json{{{', NOW)).toBeNull()
  })

  it('缺 expiresAt → null', () => {
    const req = JSON.stringify({ messageId: 'm', sessionId: 's', state: 'confirmed' })
    expect(decideRestartAction(req, NOW)).toBeNull()
  })

  it('空内容/未定义 → null', () => {
    expect(decideRestartAction('', NOW)).toBeNull()
    expect(decideRestartAction(null, NOW)).toBeNull()
    expect(decideRestartAction(undefined, NOW)).toBeNull()
  })
})
