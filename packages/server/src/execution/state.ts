/**
 * Execution — 回复路径模块态（第 2 刀从 socketio.ts 迁出，只搬不改）。
 *
 * 第 3 刀执行循环与随身状态迁入时继续扩充；3.5 刀收编为实例字段。
 */

/** 正在执行的消息 ID → 是否被撤回（runAgentReply 检查此标志以提前终止） */
const retractionRequests = new Map<string, boolean>()

/** 正在流式输出的 Agent 状态 → { sessionId, messageId, content, token }
 *  JOIN_SESSION 时用于恢复打字气泡（客户端切会话会清空 typingStates）；
 *  token 为本次 spawn 的随机信号 token（internal.ts 精确校验 x-signal-token） */
const activeStreams = new Map<
  string,
  { sessionId: string; messageId: string; content: string; token: string }
>()

/**
 * 只读 getter：internal.ts 校验信号用（不迁移 Map 本体——set/delete 不动，
 * 回归面最小）。依赖方向 internal.ts → execution/state.ts 无环。
 */
export function getActiveStream(
  agentId: string
): { sessionId: string; messageId: string; content: string; token: string } | undefined {
  return activeStreams.get(agentId)
}

/** 撤回标记查询（runAgentReply Window ③ 流中途检查） */
export function hasRetraction(messageId: string): boolean {
  return retractionRequests.get(messageId) === true
}

/** 标记撤回（MESSAGE_RETRACT handler） */
export function setRetraction(messageId: string): void {
  retractionRequests.set(messageId, true)
}

/** 清除撤回标记（runAgentReply 出口 / handler 失败与无执行者清理） */
export function clearRetraction(messageId: string): void {
  retractionRequests.delete(messageId)
}

/** 注册流状态（runAgentReply 流启动 + 逐 chunk 更新） */
export function setActiveStream(
  agentId: string,
  stream: { sessionId: string; messageId: string; content: string; token: string }
): void {
  activeStreams.set(agentId, stream)
}

/** 注销流状态（runAgentReply 三条出口 / executeOneAgent 异常漏斗） */
export function deleteActiveStream(agentId: string): void {
  activeStreams.delete(agentId)
}

/** 流状态条目（JOIN_SESSION 打字气泡恢复遍历） */
export function listActiveStreams(): Array<
  [string, { sessionId: string; messageId: string; content: string; token: string }]
> {
  return Array.from(activeStreams.entries())
}
