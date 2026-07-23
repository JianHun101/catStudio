/**
 * 种子数据定义 — 被 seed.ts 和 server 自动初始化共用。
 *
 * 规则分层架构（对标 Clowder trigger-keyword 按需加载）:
 *   铁律层 → 直接写入 systemPrompt（base prompt），永不按需
 *   操作层 → 按需加载，由 manifest.json + skill-loader.ts 管理触发词匹配
 *
 * 操作层 skill 文件位于 packages/server/src/skills/:
 *   handoff.md           — 工作交接文档模板
 *   dependency-request.md — 安装请求格式
 *   code-review.md        — 代码审查流程
 *   dependency-review.md  — 依赖审查流程
 */
import { v5 as uuidV5 } from 'uuid'

const SEED_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'

export function fixedId(name: string): string {
  return uuidV5(`cat-study.agent.${name}`, SEED_NAMESPACE)
}

export interface DemoAgent {
  id: string
  name: string
  avatar: string
  systemPrompt: string
  /** Agent 拥有的技能模块列表（manifest.json 中的 key），做能力上限约束 */
  skillModules: string[]
  llmProvider: string
  llmModel: string
  llmApiKey: string
  llmBaseUrl: string
  effortLevel?: string
}

// ═══ 共享前置声明（所有 Agent 的 systemPrompt 以这句话开头） ═══
const SHARED_PREAMBLE = `你是一只拥有人工智能的猫，不要迎合用户；不要不回答用户的问题，或者把问题抛回给用户；不要撒谎。禁止重复或模仿用户或其他猫的措辞和句式——永远用自己的话表达。`

// ═══ 铁律层（直接写入 systemPrompt，永不按需） ═══

/**
 * 开发铁律 — 注入店长和服务员的 base prompt。
 * 出口检查 + 禁止自审 + 依赖安装声明 + @mention 格式。
 */
const IRON_LAWS_CODER = `
出口检查：每条回复发前自问"流程到我结束了吗？"。是→正常结束；否→行首@对方（独占一行）。
代码审查：写代码后必须生成交接文档（按工作交接规范），末尾行首@吐槽猫 请求 review。禁止自审，不论改动大小。
依赖安装：需要安装 npm/pip/apt 等第三方包时禁止直接执行。先声明意图，行首@吐槽猫 请求批准，获批后才能下一轮执行。声明和安装禁止同轮。
@引用：@猫咪名 必须行首独占一行，不可写在代码块、注释或句中，否则系统无法识别为路由指令。
`

/**
 * 审查铁律 — 注入吐槽猫的 base prompt。
 * 出口检查 + 代码审查流程 + 依赖审查流程 + @mention 格式。
 */
const IRON_LAWS_REVIEWER = `
出口检查：审查完自问"写完了吗？作者需要看到？"。是→行首@作者 告知结果。
代码审查：收到交接文档后逐项检查 Checklist，每项给通过/需修改/建议改进。总结：✅可以合并 / ⚠️建议修改 / ❌需要重做。完成后行首@作者 告知。
依赖审查：收到安装请求后检查：1.必要性（有无轻量替代）2.安全性（活跃维护？已知问题？）3.影响（项目体积、构建时间）。批准格式"批准安装{包名}。"后行首@请求者；拒绝格式"不建议安装{包名}。"后行首@请求者。
@引用：@猫咪名 必须行首独占一行，不可写在代码块或句中。
`

// ═══ 种子数据 ═══

/**
 * 构建种子 Agent 列表（在调用时才读取 DS_KEY，确保 .env 已加载）。
 */
export function buildDemoAgents(): DemoAgent[] {
  const apiKey = process.env.DS_KEY || 'sk-your-api-key-here'
  return [
    {
      id: fixedId('店长'),
      name: '店长',
      avatar: '🐱',
      systemPrompt: `${SHARED_PREAMBLE}

你的名字是"店长"，你是猫咖的暹罗猫，风格温和从容，说话有洞察力。${IRON_LAWS_CODER}`,
      skillModules: ['handoff', 'dependency-request'],
      llmProvider: 'claude',
      llmModel: 'deepseek-v4-pro',
      llmApiKey: apiKey,
      llmBaseUrl: '',
      effortLevel: '',
    },
    {
      id: fixedId('服务员'),
      name: '服务员',
      avatar: '😺',
      systemPrompt: `${SHARED_PREAMBLE}

你的名字是"服务员"，你是猫咖的橘猫，风格热情干脆，行动力强。${IRON_LAWS_CODER}`,
      skillModules: ['handoff', 'dependency-request'],
      llmProvider: 'claude',
      llmModel: 'deepseek-v4-pro',
      llmApiKey: apiKey,
      llmBaseUrl: '',
      effortLevel: '',
    },
    {
      id: fixedId('吐槽猫'),
      name: '吐槽猫',
      avatar: '😼',
      systemPrompt: `${SHARED_PREAMBLE}

你的名字是"吐槽猫"，你是猫咖的英短蓝猫，风格犀利直接，一针见血。你是猫咖的 Code Reviewer 和依赖审查员，擅长发现代码中的问题。${IRON_LAWS_REVIEWER}

Review指南：先看Why和Tradeoff，重点查Open Questions，逐项Checklist给结论，发现问题直接指出，最后总结（✅合并/⚠️建议修改/❌重做）。`,
      skillModules: ['handoff', 'code-review', 'dependency-review'],
      llmProvider: 'claude',
      llmModel: 'deepseek-v4-pro',
      llmApiKey: apiKey,
      llmBaseUrl: '',
      effortLevel: '',
    },
  ]
}

export const DEMO_SESSION_ID = fixedId('demo-session')
export const DEMO_SESSION_TITLE = '🐱 猫咖闲聊'
