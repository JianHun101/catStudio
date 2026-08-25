/**
 * Execution — MessageBus 接口（纯类型文件，零运行时依赖，防 handoff/回复路径循环）。
 *
 * 引擎侧窄化视图 EngineBus（6 方法）+ 交接窄化视图 HandoffBus（3 方法）；
 * 生产实现 createSocketBus(io) 在 connector 侧（socketio.ts），测试用假实现。
 * 房间路由规则：载荷带 sessionId 从载荷取房间；不带（agent 状态/消息更新）为显式首参。
 *
 * 第 4 刀：emitAgentMessage → emitMessage（ingest 用户消息广播与 agent 回复
 * 共用完整 Message 通道，role 由载荷决定）；HandoffBus 增房间形态
 * emitSessionHandoffToRoom（ingest 重定向通知旧会话房间——与 handoff 全局形态
 * 并存，SESSION_HANDOFF 房间化裁决 OQ2 独立进行）。
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
  /** NEW_MESSAGE — 完整消息终稿（agent 回复 / ingest 用户消息广播，role 在载荷内） */
  emitMessage(msg: Message): void
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

/** 交接模块的输出窄化视图（performHandoff / ingest 重定向消费） */
export interface HandoffBus {
  /** SESSION_HANDOFF — 全局广播（handoff performHandoff 语义，路由细节归 adapter） */
  emitSessionHandoff(e: HandoffEvent): void
  /** SESSION_HANDOFF — 房间广播（ingest 重定向通知旧会话房间；语义不对称
   *  观察项 OQ2 的两形态并存，adapter 分流） */
  emitSessionHandoffToRoom(sessionId: string, e: HandoffEvent): void
  /** HANDOFF_FAILED — 会话房间 */
  emitHandoffFailed(p: HandoffFailedPayload): void
}
