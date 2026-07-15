/**
 * Socket.IO 事件名称常量。
 * 前后端共享，避免字符串拼写错误。
 */

export const Events = {
  // 用户 → 服务器
  SEND_MESSAGE:     'send-message',
  CREATE_SESSION:   'create-session',
  JOIN_SESSION:     'join-session',
  LEAVE_SESSION:    'leave-session',
  CREATE_AGENT:     'create-agent',

  // 用户 → 服务器
  TOGGLE_BROADCAST: 'toggle-broadcast',

  // 服务器 → 客户端
  NEW_MESSAGE:      'new-message',
  AGENT_STATUS:     'agent-status',
  QUEUE_UPDATE:     'queue-update',
  SESSION_UPDATE:   'session-update',
  BROADCAST_MODE_CHANGED: 'broadcast-mode-changed',
  SESSION_DELETED:    'session-deleted',
  SESSION_MESSAGES_CLEARED: 'session-messages-cleared',
  AGENT_TYPING:     'agent-typing',       // 流式输出的增量
  ERROR:            'error',

  // 消息撤回
  MESSAGE_RETRACT:  'message-retract',     // 用户→服务器
  MESSAGE_RETRACTED: 'message-retracted',  // 服务器→客户端

  // Agent 执行状态（每条消息对应的 Agent 状态）
  MESSAGE_AGENT_STATUS: 'message-agent-status',

  // 服务器 → 客户端：消息元数据更新（如 mentions 在后解析后补发）
  MESSAGE_UPDATED:   'message-updated',
} as const

// ─── Redis Channel Patterns ─────────────────────────

export const Channels = {
  /** 消息流 — session-specific message broadcast */
  sessionMessages: (sessionId: string) =>
    `session:${sessionId}:messages`,

  /** 调度指令 — dispatch to a specific agent in a session */
  sessionAgent: (sessionId: string, agentName: string) =>
    `session:${sessionId}:agent:${agentName}`,

  /** Agent 状态 — global status for a specific agent */
  agentStatus: (agentName: string) =>
    `agent:${agentName}:status`,
} as const
