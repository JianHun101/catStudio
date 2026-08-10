/**
 * W1 L1 错误分类器 — 从 execution_logs.error_message 映射到七桶。
 *
 * 纯函数无 I/O（可单独测试）。关键词映射按规则顺序先匹配先得——
 * 越具体的桶排越前（server_restart 精确标记、timeout 常见词靠前）。
 * 匹配不到 → 'unknown' 兜底（存量 failed 行不回填，聚合 COALESCE 兜底）。
 */

export type ErrorType =
  | 'parse_error'
  | 'tool_error'
  | 'reasoning_error'
  | 'timeout'
  | 'iteration_limit'
  | 'context_overflow'
  | 'server_restart'
  | 'unknown'

/** 关键词映射规则（顺序敏感：先匹配先得） */
const RULES: Array<{ type: ErrorType; keywords: string[] }> = [
  // 精确标记（fixStuckExecutionLogs 直写，防御性收录）
  { type: 'server_restart', keywords: ['server_restart'] },
  // 超时（socketio Promise.race 的「执行超时 (Ns)」、CLI idle timeout、网络超时）
  { type: 'timeout', keywords: ['执行超时', 'timeout', 'timed out', 'etimedout'] },
  // 上下文超长（token 预算击穿——handoff 未拦住时的保底失败）
  {
    type: 'context_overflow',
    keywords: [
      '上下文超长',
      '上下文长度',
      'context length',
      'context overflow',
      'maximum context',
      'token limit',
    ],
  },
  // 迭代上限（A2A 递归深度/循环防护触发）
  {
    type: 'iteration_limit',
    keywords: ['iteration limit', '迭代上限', 'max iterations', 'step limit', '循环上限'],
  },
  // 解析失败（mention/JSON/结构化输出解析层错误）
  {
    type: 'parse_error',
    keywords: ['解析失败', '解析错误', 'invalid json', 'parse error', 'json 解析'],
  },
  // 工具调用错误（MCP / function call 层）
  { type: 'tool_error', keywords: ['工具调用', '工具执行', 'tool call', 'mcp', 'function call'] },
  // 推理层错误（模型侧失败）
  { type: 'reasoning_error', keywords: ['推理失败', 'reasoning error'] },
]

/**
 * 将错误消息分类到七桶之一。
 * @param msg 错误消息（可为空——finalize 失败路径可能无消息）
 * @returns 匹配到的桶，匹配不到 'unknown'
 */
export function classifyError(msg: string | null | undefined): ErrorType {
  if (!msg) return 'unknown'
  const lower = msg.toLowerCase()
  for (const rule of RULES) {
    if (rule.keywords.some((k) => lower.includes(k))) return rule.type
  }
  return 'unknown'
}
