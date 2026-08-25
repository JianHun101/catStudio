/**
 * Execution — MessageBus 接口（纯类型文件，零运行时依赖，防 handoff/回复路径循环）。
 *
 * 引擎侧窄化视图 EngineBus（6 方法）+ 交接窄化视图 HandoffBus（2 方法）；
 * 生产实现 createSocketBus(io) 在 connector 侧（socketio.ts），测试用假实现。
 * 房间路由规则：载荷带 sessionId 从载荷取房间；不带（agent 状态/消息更新）为显式首参。
 */

import type { Message, ContextWindowStats, HandoffEvent } from '@cat-study/shared'
import type {
  MessageAgentStatusPayload,
  TypingUpdatePayload,
  SystemNoticePayload,
  MessageUpdatedPayload,
  HandoffFailedPayload,
} from '@cat-study/shared'

/** 执行引擎的输出窄化视图——引擎物理上发不出未类型化事件（无逃生口） */
export interface EngineBus {
  /** NEW_MESSAGE — agent 回复终稿（全量 Message） */
  emitAgentMessage(msg: Message): void
  /** NEW_MESSAGE — system 通知（9+ 手搭站点统一形状，role 隐含） */
  emitSystemNotice(n: SystemNoticePayload): void
  /** AGENT_TYPING — 流式增量 */
  emitTyping(u: TypingUpdatePayload): void
  /** MESSAGE_AGENT_STATUS — 执行进度（显式首参：载荷无 sessionId） */
  emitAgentMessageStatus(sessionId: string, s: MessageAgentStatusPayload): void
  /** MESSAGE_UPDATED — A2A mentions 写回通知 */
  emitMessageUpdated(sessionId: string, u: MessageUpdatedPayload): void
  /** CONTEXT_WINDOW_STATS — 上下文 token 用量 */
  emitContextWindowStats(stats: ContextWindowStats): void
}

/** 交接模块的输出窄化视图（performHandoff 从 io 收窄为 bus） */
export interface HandoffBus {
  /** SESSION_HANDOFF — 全局广播（语义不变，路由细节归 adapter） */
  emitSessionHandoff(e: HandoffEvent): void
  /** HANDOFF_FAILED — 会话房间 */
  emitHandoffFailed(p: HandoffFailedPayload): void
}
