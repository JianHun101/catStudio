/**
 * Execution — skill 读取原语（仓库源库定位 + SKILL.md 读盘）。
 *
 * 注入层已拆除（delivery 单 A）：server 不再按 role/阶段信号把 SKILL.md 全文拼进
 * system prompt。技能由模型经 MCP read_skill 工具懒加载自取（scripts/mcp-server.mjs
 * 按名读 skills/<名>/SKILL.md）；CLI file-scan 保留给人肉开发。本模块不再被 reply.ts
 * 消费，仅保留两支通用读盘原语（getSkillsRoot / loadSkill）作为「技能如何读」的参考契约。
 * skill 缺失/名字非法/读失败 → 返回空串，永不抛（读取是增强，不是依赖）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 技能名路径守卫（名字只允许小写字母/数字/连字符——防穿越到 skills/ 外）。 */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/

// ── 仓库 skills/ 源库定位 ─────────────────────────────
// 根判定：从模块目录上溯找 pnpm-workspace.yaml（src 与 dist 布局都在仓库内，上溯必达）。
// 支持 CATSTUDY_SKILLS_DIR 环境覆盖（测试/边缘部署）；找不到 → 返回 null → 读取整体降级。
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
 * 读单份 SKILL.md，返回原样内容。
 *
 * 降级语义：名字非法（路径守卫）/ 无源库根 / 文件不存在 / 读失败 → 返回空串。
 * 调用侧跳过空串——读取是增强，任一 skill 读不到不影响其余。
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
