/**
 * Execution — skill 运行时注入（仓库源库 + server 注入，clowder 路线第一段骨架）。
 *
 * 背景（勘察钉死）：既有 skill-consumption-architecture 是「server 零注入 + CLI file-scan」
 * ——skill 内容只对「主仓库交互式 Claude Code（人肉开发）」成立。猫 harness 的执行体大多
 * 不是 Claude CLI（seed：store/implementer/reviewer 走 opencode、图测猫走 ollama、dsh猫走
 * dsh——均无 .claude/skills file-scan 概念），且会话 worktree 只建 node_modules junction、
 * 不建 .claude/skills——唯一能 file-scan 的 claude provider cwd 又在无 .claude 的 worktree。
 * 结论：既有链路在猫流程里空转（spec-gate/quality-gate/request-review 从没进过猫的 prompt）。
 *
 * 本模块把注入点从「CLI 文件依赖」移到「server prompt 组装层」：从仓库 skills/ 源库读
 * SKILL.md，按 agent role + 触发阶段信号解析本轮要注入的技能名，拼成 system prompt 区块——
 * 注入发生在 provider 之前的组装层，opencode/ollama/dsh/claude 全 provider 一致生效，
 * worktree 隔离整体绕开（skills/ 是 git 追踪目录，随 checkout 全量携带，无 junction 依赖）。
 *
 * 边界（派活单）：
 * - 只新增注入通道；不拆 claude provider 既有的 CLI file-scan（人肉开发保留）。
 * - 不动运行摘要/记忆/知识库三块既有注入（reply.ts 顺序在它们之后、token 预算复核之前）。
 * - skill 缺失/名字非法/读失败 → 降级为空，永不阻塞回复（注入是增强，不是依赖）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** skill 名白名单（首期 role→skill 白名单 = 开发流程链 4 技能）。
 *  判据不是 source：spec-gate/quality-gate/request-review 在 manifest 为 source: self，
 *  而 implement 是 source: mattpocock 基底（manifest.yaml:214）——57d1078 已在其上增补
 *  猫咖前置门槛段，是开发流程链关键技能，故一并入白名单。真正判据 = 「开发流程链、
 *  agent 角色生命周期直接相关、内容已猫咖化」。名单外技能（纯 mattpocock/external 系）
 *  留给 CLI 原生消费不注入。
 *  名字只允许小写字母/数字/连字符——loadSkill 路径守卫依赖该格式（防穿越）。 */
const SUPPORTED_SKILLS: ReadonlySet<string> = new Set([
  'spec-gate',
  'quality-gate',
  'implement',
  'request-review',
])

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/

/**
 * role → 默认注入技能（首期映射，店长后续可调参）。
 *
 * - implementer（ds猫/flash猫/dsh猫）→ implement + quality-gate：实施猫生命周期是
 *   「拿 spec/工单 → implement → 提交前自查 quality-gate」——两技能正好盖住其两端。
 * - store（店长/架构师）→ spec-gate：spec→拆票/实施前的前半个门，属架构师职责。
 * - reviewer / vision / 缺省 → 不注入：reviewer 走审查铁律 + 收到即审，不背实施流程
 *   技能；vision 纯看图。铁律注入口径与 ironLawForRole 一致地按 role 收敛。
 */
const ROLE_DEFAULT_SKILLS: Readonly<Record<string, readonly string[]>> = {
  implementer: ['implement', 'quality-gate'],
  store: ['spec-gate'],
}

/**
 * 触发阶段信号 → 追加技能（triggerContent 含关键词时并入，与 role 默认去重）。
 * 只对开发流程链执行者（store/implementer）生效——reviewer/vision 的触发消息常引用
 * quality-gate/spec-gate/自查 等词汇（审查报告、交接文档转述），若按关键词命中会给
 * 它们注入无关实施技能，纯噪音。
 *
 * request-review 信号当前停用（见 STAGE_SIGNALS 内 TODO）：注入顶层
 * request-review/SKILL.md 会让模型读到「作者主动打包发审查请求 + @审查者」的动作指令，
 * 与猫 harness 运行时约束冲突——铁律一审查自动化（post-commit hook 自动投递、agent 只
 * 补填不自行发起）+ 该技能正文 `@审查者` 字面在 skill 块 append 后才进文本、不被
 * resolveRolePlaceholders 解析（reply.ts:417 只处理 baseSystemPrompt 一次）——照技能行事
 * 会输出字面 @审查者，mention 精确匹配落空 → 静默丢投递。待 loader 具备 skills/catstudy/
 * 子目录两级路径注入能力后，按描述猫真实审查链的 catstudy-request-review 定制层启用。
 */
interface StageSignal {
  skill: string
  keywords: readonly string[]
}

/** 阶段信号只服务开发流程链角色（store 拍 spec/拆票、implementer 实施/自查/请审） */
const DEV_FLOW_ROLES: ReadonlySet<string> = new Set(['store', 'implementer'])

const STAGE_SIGNALS: readonly StageSignal[] = [
  {
    skill: 'spec-gate',
    keywords: ['spec-gate', '规格检查', '需求自查', '开工前检查'],
  },
  {
    skill: 'quality-gate',
    keywords: ['quality-gate', 'quality gate', '提交前检查', '自查'],
  },
  // TODO(catstudy 两级路径注入)：request-review 信号停用（吐槽猫审查 P1）。
  // 注入顶层 request-review/SKILL.md 与铁律一冲突 + `@审查者` 字面不被解析（见上方注释）。
  // 待 loadSkill 支持 skills/catstudy/<name>/SKILL.md 后，按 catstudy-request-review 启用。
  // SUPPORTED_SKILLS 仍保留 'request-review'：role 默认不命中、仅防未来启用时漏加白名单。
  // {
  //   skill: 'request-review',
  //   keywords: ['request-review', 'request review', '发起审查', '请审查'],
  // },
]

/** resolveSkillsForContext 的上下文——reply.ts runAgentReply 直接可用字段 */
export interface SkillContext {
  /** agent role（缺失/未知 → 无 role 默认注入，仅阶段信号可命中） */
  role?: string
  /** 触发消息内容（阶段信号关键词来源；空 → 只按 role 默认） */
  triggerContent?: string
}

/**
 * 按 agent role + 触发阶段信号解析本轮要注入的 skill 名。
 *
 * 纯函数（不读盘）：role 默认 ∪ 阶段信号关键词命中，与白名单求交、去重，顺序稳定
 * （role 默认在前，阶段信号在后追加）。
 */
export function resolveSkillsForContext(ctx: SkillContext): string[] {
  const names = new Set<string>()
  for (const s of ROLE_DEFAULT_SKILLS[ctx.role ?? ''] ?? []) {
    if (SUPPORTED_SKILLS.has(s)) names.add(s)
  }
  const content = ctx.triggerContent ?? ''
  if (content && DEV_FLOW_ROLES.has(ctx.role ?? '')) {
    for (const { skill, keywords } of STAGE_SIGNALS) {
      if (!SUPPORTED_SKILLS.has(skill)) continue
      if (keywords.some((k) => content.includes(k))) names.add(skill)
    }
  }
  return [...names]
}

// ── 仓库 skills/ 源库定位 ─────────────────────────────
// 根判定：从模块目录上溯找 pnpm-workspace.yaml（src 与 dist 布局都在仓库内，上溯必达）。
// 支持 CATSTUDY_SKILLS_DIR 环境覆盖（测试/边缘部署）；找不到 → 返回 null → 注入整体降级。
let skillsRootCache: string | null | undefined

export function getSkillsRoot(): string | null {
  if (skillsRootCache === undefined) {
    skillsRootCache = resolveSkillsRoot()
  }
  return skillsRootCache
}

function resolveSkillsRoot(): string | null {
  const envRoot = process.env.CATSTUDY_SKILLS_DIR
  if (envRoot) return existsSync(envRoot) ? envRoot : null
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const repoRoot = findRepoRoot(moduleDir) ?? findRepoRoot(process.cwd())
  if (!repoRoot) return null
  const skillsDir = join(repoRoot, 'skills')
  return existsSync(skillsDir) ? skillsDir : null
}

function findRepoRoot(start: string): string | null {
  let cur = resolve(start)
  for (;;) {
    if (existsSync(join(cur, 'pnpm-workspace.yaml'))) return cur
    const parent = dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
}

/**
 * 读单份 SKILL.md，返回注入文本（原样内容）。
 *
 * 降级语义：名字非法（路径守卫）/ 无源库根 / 文件不存在 / 读失败 → 返回空串。
 * 调用侧（buildSkillContextBlock）跳过空串——注入是增强，任一 skill 读不到不影响其余。
 */
export function loadSkill(name: string): string {
  if (!SKILL_NAME_RE.test(name)) return ''
  const root = getSkillsRoot()
  if (!root) return ''
  const file = join(root, name, 'SKILL.md')
  try {
    if (!existsSync(file)) return ''
    return readFileSync(file, 'utf-8')
  } catch {
    return ''
  }
}

/** 拼装进 system prompt 的【技能指引】区块头（每份 SKILL.md 内容 + 注入来源说明） */
const SKILL_BLOCK_HEADER =
  '\n\n[技能指引]\n本轮按 agent role/触发阶段注入以下仓库技能定义（skills/*/SKILL.md，server ' +
  '运行时组装，不依赖执行体 file-scan）。对应场景出现时按技能要求行事；不适用则忽略：\n\n'

/**
 * 为当前上下文构建完整技能注入区块文本（resolve → load → 拼接）。
 * 无命中或全部读失败 → 返回空串（reply.ts 据空串跳过注入，零系统提示变更）。
 */
export function buildSkillContextBlock(ctx: SkillContext): string {
  const parts: string[] = []
  for (const name of resolveSkillsForContext(ctx)) {
    const md = loadSkill(name)
    if (!md.trim()) continue
    parts.push(`## 技能：${name}\n\n${md.trim()}\n`)
  }
  if (parts.length === 0) return ''
  return `${SKILL_BLOCK_HEADER}${parts.join('\n')}`
}
