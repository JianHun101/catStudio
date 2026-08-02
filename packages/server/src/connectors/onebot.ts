/**
 * OneBot v11 协议解析——纯函数，零副作用，可单测。
 *
 * 事件 → 摄入输入的转换层，与副作用（DB 绑定查找、HTTP、ingest 调用）完全分离：
 * webhook 处理器只做：取绑定 → 取 roster → 调 parseOneBotMessage → 调 ingestUserMessage。
 *
 * 解析规则（P2 派活单契约）：
 * - segments 提取 text；at 段 qq===self_id → @机器人
 * - 文本中 @猫名（roster 名字匹配）→ mentions
 * - 仅 @机器人无猫名 → mentions=[]（广播）
 * - content 前缀 `[昵称]: ` 保留发言者身份
 *
 * 补充语义（契约未明示处，保守处理）：
 * - 群聊消息必须 @机器人 才处理（否则不是定向给猫咖的对话，返回 null 静默丢弃——
 *   避免绑定群内任何闲聊都触发全量广播）；私聊默认即对话，无需 @
 * - 只有 @ 没有文本 → null（无内容可摄入）
 */

export interface OneBotSegment {
  type: string
  data?: Record<string, unknown>
}

export interface OneBotMessageEvent {
  post_type: 'message'
  message_type: 'group' | 'private'
  /** 机器人自身 QQ 号（事件上报方填充） */
  self_id: number | string
  /** 发送者 QQ 号 */
  user_id: number | string
  group_id?: number | string
  /** segments 数组，或 CQ 码字符串（部分实现） */
  message: OneBotSegment[] | string
  sender?: {
    user_id?: number | string
    nickname?: string
    /** 群名片（群聊优先于昵称） */
    card?: string
  }
  [key: string]: unknown
}

export interface ParsedOneBotMessage {
  content: string
  /** @猫名 匹配到的 roster 成员 */
  mentions: string[]
}

export interface ParseOneBotOptions {
  /** 会话内 agent 名单，文本 @猫名 匹配用 */
  roster: string[]
  /** 机器人自身 QQ 号（at 段 qq===self_id 视为 @机器人） */
  selfId: number | string
  /** 消息类型：群聊必须 @机器人；私聊直接对话 */
  messageType: 'group' | 'private'
}

/**
 * 解析 OneBot v11 message 事件 → 摄入输入。
 * @returns 解析结果；非定向消息（群聊未 @机器人）或空文本时返回 null
 */
export function parseOneBotMessage(
  event: OneBotMessageEvent,
  opts: ParseOneBotOptions
): ParsedOneBotMessage | null {
  const { roster, selfId, messageType } = opts
  const selfIdStr = String(selfId)

  // 消息体兼容：segments 数组（标准）或字符串（CQ 码，部分实现降级为纯文本）
  const segments: OneBotSegment[] =
    typeof event.message === 'string'
      ? [{ type: 'text', data: { text: event.message } }]
      : event.message

  // 提取文本 + 检查是否 @ 了机器人
  const textParts: string[] = []
  let robotMentioned = false
  for (const seg of segments) {
    if (seg.type === 'text') {
      const t = seg.data?.text
      if (typeof t === 'string' && t) textParts.push(t)
    } else if (seg.type === 'at') {
      const qq = seg.data?.qq
      if (qq !== undefined && qq !== null && String(qq) === selfIdStr) robotMentioned = true
    }
  }
  const rawText = textParts.join(' ').trim()

  // 群聊必须 @ 机器人（未定向猫咖的闲聊不处理）；私聊即对话
  if (messageType === 'group' && !robotMentioned) return null
  if (!rawText) return null

  // 文本中 @猫名（roster 匹配）→ mentions
  const mentions: string[] = []
  for (const name of roster) {
    if (rawText.includes(`@${name}`)) mentions.push(name)
  }

  // 前缀保留发言者身份： [昵称]: 内容（群聊优先群名片）
  const nickname = event.sender?.card ?? event.sender?.nickname
  const content = nickname && nickname.trim() ? `[${nickname.trim()}]: ${rawText}` : rawText

  return { content, mentions }
}
