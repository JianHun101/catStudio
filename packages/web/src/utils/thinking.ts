export interface ThinkingSegment {
  kind: 'text' | 'thinking'
  content: string
}

/**
 * 把含 [思考] 标记的流式内容拆成文本段和思考段。
 * 连续的 [思考] 块会合并为单个思考段，避免产生多个折叠窗口。
 *
 * 通过 split 按 [思考] 标记切分，再收集连续的思考块来合并。
 *
 * split 使用 \s* 匹配 [思考] 后的空白（含空格、换行等），确保标记格式
 * 略有偏差时仍能正确拆分（例如 [思考] 后带换行而非空格）。
 *
 * 注意：[思考] 只标记思考的"开始"，没有结束标记。因此如果思考块之间
 * 夹杂了普通文本，文本会被纳入前一个思考块。这在 Agent 打字过程中是
 * 暂时性的——完整的消息通过 NEW_MESSAGE 事件单独推送，不包含 [思考]
 * 标记。
 *
 * 示例:
 *   "[思考] A[思考] B结尾文本" → thinking("A\n\nB结尾文本")
 *   "[思考] A普通文本[思考] B" → thinking("A普通文本\n\nB")  // 已知限制
 *   "纯文本"                   → text("纯文本")
 */
export function parseThinkingBlocks(content: string): ThinkingSegment[] {
  if (!content) return []

  const segments: ThinkingSegment[] = []
  const pendingThinking: string[] = []
  // 按 [思考] 切分，保留标记在每段开头（lookahead 不消耗字符）。
  // \s* 兼容标记后无空格或仅有换行的情况。
  const THINKING_MARKER = '[思考]'
  const parts = content.split(/(?=\[思考\]\s*)/)

  for (const part of parts) {
    if (!part) continue
    if (part.startsWith(THINKING_MARKER)) {
      // 思考块：去掉前缀 "[思考]" 及紧随的空白后进入合并队列。
      // 过滤空内容——标记后只有空白时不应产生空条目。
      const inner = part.slice(THINKING_MARKER.length).replace(/^\s*/, '').trim()
      if (inner) pendingThinking.push(inner)
    } else {
      // 普通文本：先刷新已累积的思考块，再输出文本
      if (pendingThinking.length > 0) {
        segments.push({ kind: 'thinking', content: pendingThinking.join('\n\n') })
        pendingThinking.length = 0
      }
      const trimmed = part.trim()
      if (trimmed) segments.push({ kind: 'text', content: trimmed })
    }
  }

  // 末尾残留的思考块
  if (pendingThinking.length > 0) {
    segments.push({ kind: 'thinking', content: pendingThinking.join('\n\n') })
  }

  return segments
}
