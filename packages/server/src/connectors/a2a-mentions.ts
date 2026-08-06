/**
 * Agent-to-Agent @mention 解析 — 从 Agent 回复文本中提取路由意图。
 *
 * 独立模块，无外部依赖，可单独测试。
 *
 * 设计参考：Cat Café 项目 docs/lessons/04-a2a-routing.md
 */

/**
 * 从 Agent 回复文本中提取 @mention 的 Agent 名称。
 *
 * 与用户消息不同（用户消息用前端解析的 mentions 数组），Agent 回复
 * 中的 @mention 需要服务端解析。采用**严格行首匹配**策略：
 *
 * 1. 先剥离代码块（```...```），防止代码注释/文档示例里的 @mention 误触发
 * 2. 剥离行内代码（`...`）——逐行剥离，反引号配对不跨行
 * 3. 对剩余文本做行首匹配：只有出现在行首的 @name 才视为路由意图
 *
 * 理由：用户消息可能在任何位置写 @，但 Agent 的输出经常在代码注释、
 * 文档引用、引用他人话语中提到其他 Agent 的名字，行首匹配能区分
 * "主动喊话"和"提及名字"。
 *
 * @example
 * // ✅ 正确触发
 * parseMentionsFromReply('@吐槽猫 请 review', ['吐槽猫', '店长'])
 * // → ['吐槽猫']
 *
 * @example
 * // ❌ 代码注释中的不触发
 * parseMentionsFromReply('// @吐槽猫 这里需要优化', ['吐槽猫'])
 * // → []（行内代码被剥离后该行变为空）
 *
 * @example
 * // ❌ 代码块中的不触发
 * parseMentionsFromReply('```\n@吐槽猫\n```', ['吐槽猫'])
 * // → []
 *
 * @example
 * // ❌ 句中的不触发
 * parseMentionsFromReply('请 @吐槽猫 review 一下', ['吐槽猫'])
 * // → []
 */
export function parseMentionsFromReply(content: string, agentNames: string[]): string[] {
  // 1. 剥离代码块（```...```），包括有语言标记的
  const noCodeBlocks = content.replace(/```[\s\S]*?```/g, '')

  // 2. 剥离行内代码（`...`）——逐行剥离：反引号配对不跨行。
  //    全文成对匹配在反引号总数为奇数时配对错位，会吞掉配对之间的所有文本
  //    （含行首 @mention，造成 A2A 派活静默丢单）；逐行剥离后奇数反引号
  //    只影响本行，行首 @mention 天然安全
  const noInlineCode = noCodeBlocks
    .split('\n')
    .map((line) => line.replace(/`[^`]*`/g, ''))
    .join('\n')

  // 3. 行首匹配：只匹配出现在行首（允许前导空白）的 @name
  return agentNames.filter((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // 使用 (?=\s|$) 而非 \b，因为 \b 对中文字符不生效
    // (?=\s|$) = @name 后面必须是空白或行尾，防止 @店长 误匹配 @店长助理
    return new RegExp(`^\\s*@${escaped}(?=\\s|$)`, 'mi').test(noInlineCode)
  })
}
