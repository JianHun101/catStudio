/**
 * onebotOutbound 出站转发测试（P3 AC2/AC5）。
 *
 * 覆盖：群绑定 → send_group_msg（group_id + [猫名]: 前缀）；私聊绑定 → send_private_msg；
 * 无绑定 session → 零 fetch；多绑定逐条投递；ONEBOT_ENABLED=false → startOneBotOutbound
 * 不订阅（emit 后零 fetch）；启动订阅后 emit → 真实投递。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { createTestDb } from '../test-helpers.js'
import { setDb, resetDb, getDb } from '../db/index.js'
import { initRepository, connectorBindings as bindingsRepo } from '../db/repository/index.js'
import { deliverAgentReply, startOneBotOutbound } from './onebotOutbound.js'
import { emitAgentReply, type AgentReplyMessage } from './replyBus.js'

const msg = (overrides: Partial<AgentReplyMessage> = {}): AgentReplyMessage => ({
  id: 'msg-1',
  agentId: 'agent-ds',
  agentName: 'ds猫',
  sessionId: 'session-1',
  content: '喵，你好呀',
  ...overrides,
})

/** 造会话 + 绑定 fixture（一个会话可绑多个聊天） */
const insertBindings = () => {
  const db = getDb()
  db.prepare(
    `INSERT INTO sessions (id, title, agent_ids, created_at, updated_at)
     VALUES ('session-1', 's', '[]', datetime('now'), datetime('now'))`
  ).run()
  bindingsRepo.upsertConnectorBinding('qq', 'group', '555', 'session-1')
  bindingsRepo.upsertConnectorBinding('qq', 'private', '999', 'session-1')
  bindingsRepo.upsertConnectorBinding('wechat', 'group', '1', 'session-1')
}

describe('onebotOutbound', () => {
  let db: Database.Database

  beforeEach(() => {
    db = createTestDb()
    setDb(db)
    initRepository(db)
    process.env.ONEBOT_API_BASE = 'http://napcat:3000'
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })))
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.ONEBOT_API_BASE
    delete process.env.ONEBOT_ENABLED
    delete process.env.ONEBOT_FETCH_TIMEOUT_MS
    resetDb()
  })

  it('AC2-1: 群绑定 → send_group_msg，body 含 group_id + [猫名]: 前缀', async () => {
    insertBindings()
    const delivered = await deliverAgentReply(msg())
    expect(delivered).toBe(2) // qq group + qq private 各 1 条；wechat 绑定不投递
    const fetchMock = vi.mocked(fetch)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://napcat:3000/send_group_msg',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ group_id: 555, message: '[ds猫]: 喵，你好呀' }),
      })
    )
  })

  it('AC2-2: 私聊绑定 → send_private_msg，user_id 投递', async () => {
    insertBindings()
    await deliverAgentReply(msg())
    const fetchMock = vi.mocked(fetch)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://napcat:3000/send_private_msg',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ user_id: 999, message: '[ds猫]: 喵，你好呀' }),
      })
    )
  })

  it('AC2-3: 无绑定 session → 零 fetch', async () => {
    const delivered = await deliverAgentReply(msg({ sessionId: 'no-bindings' }))
    expect(delivered).toBe(0)
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('AC2-4: 非 qq 平台绑定不投递（只投递 PLATFORM_QQ）', async () => {
    const db2 = getDb()
    db2
      .prepare(
        `INSERT INTO sessions (id, title, agent_ids, created_at, updated_at)
       VALUES ('session-w', 'w', '[]', datetime('now'), datetime('now'))`
      )
      .run()
    bindingsRepo.upsertConnectorBinding('wechat', 'group', '1', 'session-w')
    const delivered = await deliverAgentReply(msg({ sessionId: 'session-w' }))
    expect(delivered).toBe(0)
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('AC2-5: 出站失败不抛异常（log.warn 后继续下一条）', async () => {
    insertBindings()
    vi.mocked(fetch).mockImplementationOnce(() => Promise.reject(new Error('ECONNREFUSED')))
    const delivered = await deliverAgentReply(msg())
    expect(delivered).toBe(1) // 第一条失败，第二条（私聊）成功
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2)
  })

  it('AC5: ONEBOT_ENABLED=false → startOneBotOutbound 不订阅，emit 后零 fetch', () => {
    insertBindings()
    process.env.ONEBOT_ENABLED = 'false'
    const unsubscribe = startOneBotOutbound()
    expect(unsubscribe).toBeNull()
    emitAgentReply(msg())
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('AC5-2: 启用后订阅并投递，返回的取消函数可解绑', async () => {
    insertBindings()
    process.env.ONEBOT_ENABLED = 'true'
    const unsubscribe = startOneBotOutbound()
    expect(unsubscribe).toBeTypeOf('function')

    emitAgentReply(msg())
    // deliverAgentReply 是异步 fire-and-forget——等一帧让 fetch 调用落地
    await vi.waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalled()
    })
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2)

    // 取消订阅后不再投递
    unsubscribe!()
    vi.mocked(fetch).mockClear()
    emitAgentReply(msg())
    await new Promise((r) => setTimeout(r, 10))
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('P4 #2: fetch 悬挂（NapCat 假死）→ AbortSignal.timeout 超时进 catch，不卡住投递', async () => {
    insertBindings()
    process.env.ONEBOT_FETCH_TIMEOUT_MS = '30' // env 可覆盖——测试设小值，不真等 10s
    // 模拟 NapCat 假死：fetch 悬挂——仅当 signal abort 时以 TimeoutError 拒绝
    //（与真实 fetch 行为一致；若 signal 未接线，竞速守卫 2s 后失败，测试必红）
    vi.mocked(fetch).mockImplementation(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
          )
        })
    )
    const delivered = await Promise.race([
      deliverAgentReply(msg()),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('deliverAgentReply 未超时返回——signal 未接线')), 2000)
      ),
    ])
    // 超时自然进现有 catch（TimeoutError 走 log.warn 不重试）→ 无投递
    expect(delivered).toBe(0)
    // 断言 AbortSignal 已接线到 fetch
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      'http://napcat:3000/send_group_msg',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })
})
