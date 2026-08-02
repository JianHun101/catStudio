/**
 * onebot 协议解析纯函数测试（P2 派活单契约 #5）。
 *
 * 覆盖：@机器人+@猫名 / 纯@机器人广播 / 群聊未@机器人丢弃 / 私聊直接对话 /
 * 非 roster @名过滤 / 字符串消息体降级 / 只有@无文本 / 昵称与群名片前缀
 */
import { describe, it, expect } from 'vitest'
import { parseOneBotMessage, type OneBotMessageEvent } from './onebot.js'

const roster = ['店长', 'ds猫', '吐槽猫']

const baseEvent = (overrides: Partial<OneBotMessageEvent> = {}): OneBotMessageEvent => ({
  post_type: 'message',
  message_type: 'group',
  self_id: 10000,
  user_id: 999,
  group_id: 555,
  message: [{ type: 'text', data: { text: 'hello' } }],
  sender: { user_id: 999, nickname: '小明' },
  ...overrides,
})

describe('parseOneBotMessage', () => {
  it('group: @机器人 + 文本@猫名 → mentions 含猫名，content 带昵称前缀', () => {
    const event = baseEvent({
      message: [
        { type: 'at', data: { qq: 10000 } },
        { type: 'text', data: { text: ' @ds猫 帮我看看' } },
      ],
    })
    const parsed = parseOneBotMessage(event, { roster, selfId: 10000, messageType: 'group' })
    expect(parsed).not.toBeNull()
    expect(parsed!.mentions).toEqual(['ds猫'])
    expect(parsed!.content).toBe('[小明]: @ds猫 帮我看看')
  })

  it('group: 纯 @机器人无猫名 → mentions=[] 广播', () => {
    const event = baseEvent({
      message: [
        { type: 'at', data: { qq: 10000 } },
        { type: 'text', data: { text: '在吗' } },
      ],
    })
    const parsed = parseOneBotMessage(event, { roster, selfId: 10000, messageType: 'group' })
    expect(parsed).not.toBeNull()
    expect(parsed!.mentions).toEqual([])
    expect(parsed!.content).toBe('[小明]: 在吗')
  })

  it('group: 未 @机器人 → null（闲聊不处理）', () => {
    const event = baseEvent({ message: [{ type: 'text', data: { text: '今天天气不错' } }] })
    const parsed = parseOneBotMessage(event, { roster, selfId: 10000, messageType: 'group' })
    expect(parsed).toBeNull()
  })

  it('group: @其他 QQ 不算 @机器人 → null', () => {
    const event = baseEvent({
      message: [
        { type: 'at', data: { qq: 8888 } },
        { type: 'text', data: { text: 'hello' } },
      ],
    })
    const parsed = parseOneBotMessage(event, { roster, selfId: 10000, messageType: 'group' })
    expect(parsed).toBeNull()
  })

  it('private: 不 @机器人也处理（私聊即对话），无猫名 → mentions=[] 广播', () => {
    const event = baseEvent({
      message_type: 'private',
      message: [{ type: 'text', data: { text: '你好' } }],
      sender: { user_id: 999, nickname: '小红' },
    })
    const parsed = parseOneBotMessage(event, { roster, selfId: 10000, messageType: 'private' })
    expect(parsed).not.toBeNull()
    expect(parsed!.mentions).toEqual([])
    expect(parsed!.content).toBe('[小红]: 你好')
  })

  it('文本中非 roster 的 @名不进入 mentions', () => {
    const event = baseEvent({
      message: [
        { type: 'at', data: { qq: 10000 } },
        { type: 'text', data: { text: '@路人甲 @ds猫' } },
      ],
    })
    const parsed = parseOneBotMessage(event, { roster, selfId: 10000, messageType: 'group' })
    expect(parsed!.mentions).toEqual(['ds猫'])
  })

  it('字符串消息体（CQ 码降级）按纯文本处理', () => {
    const event = baseEvent({ message: 'hello' })
    const parsed = parseOneBotMessage(event, { roster, selfId: 10000, messageType: 'private' })
    expect(parsed).not.toBeNull()
    expect(parsed!.content).toBe('[小明]: hello')
  })

  it('只有 @没有文本 → null（无内容可摄入）', () => {
    const event = baseEvent({ message: [{ type: 'at', data: { qq: 10000 } }] })
    const parsed = parseOneBotMessage(event, { roster, selfId: 10000, messageType: 'group' })
    expect(parsed).toBeNull()
  })

  it('无昵称时不加前缀', () => {
    const event = baseEvent({
      message: [
        { type: 'at', data: { qq: 10000 } },
        { type: 'text', data: { text: 'hi' } },
      ],
      sender: undefined,
    })
    const parsed = parseOneBotMessage(event, { roster, selfId: 10000, messageType: 'group' })
    expect(parsed!.content).toBe('hi')
  })

  it('群聊优先群名片（card）而非昵称', () => {
    const event = baseEvent({
      message: [
        { type: 'at', data: { qq: 10000 } },
        { type: 'text', data: { text: 'hi' } },
      ],
      sender: { user_id: 999, nickname: '小明', card: '猫友' },
    })
    const parsed = parseOneBotMessage(event, { roster, selfId: 10000, messageType: 'group' })
    expect(parsed!.content).toBe('[猫友]: hi')
  })
})
