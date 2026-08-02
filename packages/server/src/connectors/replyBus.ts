/**
 * Agent 回复事件总线——模块级单例，Node 内置 EventEmitter（零新增依赖）。
 *
 * 用途：把 agent 回复完成事件从"执行链路"解耦到"外部平台转发"（QQ 出站）。
 * runAgentReply 落库广播后 emitAgentReply；onebotOutbound 订阅后把回复
 * 转发到绑定群/私聊。发送侧不感知接收侧——回复管线不被 fetch 阻塞。
 *
 * 订阅返回取消函数（与 onebotOutbound 的 startOneBotOutbound 配对使用，
 * 测试与优雅关闭都需要它）。
 */
import { EventEmitter } from 'node:events'

/** 一条已落库的 agent 回复（payload 与 socketio runAgentReply 的 finalMsg 对应） */
export interface AgentReplyMessage {
  id: string
  agentId: string
  agentName: string
  sessionId: string
  content: string
}

const bus = new EventEmitter()

/** 事件名——模块内部常量，不跨模块共享 */
const EVENT_AGENT_REPLY = 'agent-reply'

/**
 * 订阅 agent 回复事件。
 * @returns 取消订阅函数（调用后不再收到后续事件）
 */
export function onAgentReply(cb: (msg: AgentReplyMessage) => void): () => void {
  bus.on(EVENT_AGENT_REPLY, cb)
  return () => {
    bus.off(EVENT_AGENT_REPLY, cb)
  }
}

/** 发布一条 agent 回复事件（同步触发，订阅者自行处理异步） */
export function emitAgentReply(msg: AgentReplyMessage): void {
  bus.emit(EVENT_AGENT_REPLY, msg)
}
