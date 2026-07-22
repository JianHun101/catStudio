/**
 * 技能加载器 — 启动时一次性将 manifest + 所有 .md skill 文件读入内存。
 *
 * 设计原则:
 * - 热路径（matchAndBuild）只做内存查表 + 字符串拼接，零 I/O
 * - 模块级单例（弱依赖 import），socketio.ts 直接 import 即可
 * - manifest 解析失败阻止启动（错误的行为比不启动更危险）
 * - 单个 .md 文件缺失只 warn，其他 skill 继续工作
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createLogger } from '../logger.js'

const log = createLogger('skill-loader')

/** 转义正则特殊字符，用于动态构建 skill 名的匹配模式 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ═══ 类型定义 ═══

export interface SkillEntry {
  description: string
  triggers: string[]
  file: string
}

export interface ManifestConfig {
  skills: Record<string, SkillEntry>
}

export interface MatchResult {
  /** 最终组装好的 system prompt */
  prompt: string
  /** 命中的 skill 名称列表（调试用） */
  matchedSkills: string[]
}

// ═══ SkillLoader ═══

export class SkillLoader {
  private static instance: SkillLoader | null = null

  /** 启动时初始化单例。重复调用会重新加载（用于测试/热重载）。 */
  static initialize(skillsDir: string): SkillLoader {
    SkillLoader.instance = new SkillLoader(skillsDir)
    return SkillLoader.instance
  }

  /** 获取已初始化的单例。未初始化时抛异常。 */
  static getInstance(): SkillLoader {
    if (!SkillLoader.instance) {
      throw new Error('SkillLoader not initialized — call SkillLoader.initialize() during startup')
    }
    return SkillLoader.instance
  }

  /** 重置单例（测试用） */
  static reset(): void {
    SkillLoader.instance = null
  }

  // ═══ 实例 ═══

  private manifest: ManifestConfig
  private rules: Map<string, string> = new Map()
  private initialized = false

  private constructor(private skillsDir: string) {
    this.manifest = { skills: {} }
    this.loadAll()
  }

  // ── 加载逻辑 ──

  private loadAll(): void {
    // 1. 解析 manifest
    const manifestPath = join(this.skillsDir, 'manifest.json')
    try {
      const raw = readFileSync(manifestPath, 'utf-8')
      this.manifest = JSON.parse(raw) as ManifestConfig
      if (!this.manifest.skills || typeof this.manifest.skills !== 'object') {
        throw new Error('manifest.json 缺少 "skills" 字段或格式错误')
      }
      log.info('manifest loaded', { skillCount: Object.keys(this.manifest.skills).length })
    } catch (err: any) {
      throw new Error(`Failed to load manifest at ${manifestPath}: ${err.message}`)
    }

    // 2. 加载所有 .md 文件
    for (const [skillName, skill] of Object.entries(this.manifest.skills)) {
      const filePath = join(this.skillsDir, skill.file)
      if (!existsSync(filePath)) {
        log.warn('skill file not found — skipping', { skillName, file: skill.file })
        continue
      }
      try {
        const content = readFileSync(filePath, 'utf-8')
        this.rules.set(skillName, content)
      } catch (err: any) {
        log.error('failed to read skill file — skipping', {
          skillName,
          file: skill.file,
          error: err.message,
        })
      }
    }

    this.initialized = true
    log.info('skills loaded', {
      loadedCount: this.rules.size,
      totalCount: Object.keys(this.manifest.skills).length,
    })
  }

  // ── 匹配逻辑 ──

  /**
   * 根据触发文本匹配技能，返回组装好的 system prompt。
   *
   * @param basePrompt  Agent 的基础 prompt（铁律已在其中）
   * @param skillModules Agent 声明拥有的技能列表（能力上限约束）
   * @param triggerText 触发消息文本（用于关键词匹配）
   * @returns 组装后的完整 prompt + 调试信息
   */
  matchAndBuild(basePrompt: string, skillModules: string[], triggerText: string): MatchResult {
    const matchedSkills: string[] = []

    for (const skillName of skillModules) {
      const skill = this.manifest.skills[skillName]
      if (!skill) {
        log.warn('skill not in manifest', { skillName, agentSkills: skillModules })
        continue
      }

      // 两层触发匹配：
      //   1. 显式指令 /skillName（确定性触发，如 /handoff）
      //   2. 关键词匹配（模糊触发，如消息含"交接"）
      const slashHit = new RegExp(`(?:^|\\s)/${escapeRegex(skillName)}\\b`).test(triggerText)
      const keywordHit = skill.triggers.some((trigger) => triggerText.includes(trigger))
      if ((slashHit || keywordHit) && this.rules.has(skillName)) {
        matchedSkills.push(skillName)
      }
    }

    // 拼接: basePrompt + 各命中 skill 的内容
    let prompt = basePrompt
    for (const skillName of matchedSkills) {
      const content = this.rules.get(skillName)
      if (content) {
        prompt += content
      }
    }

    if (matchedSkills.length > 0) {
      log.debug('skills matched', { matchedSkills, triggerLen: triggerText.length })
    }

    return { prompt, matchedSkills }
  }

  // ── 查询接口（调试/测试用） ──

  getLoadedSkillNames(): string[] {
    return Array.from(this.rules.keys())
  }

  getManifest(): ManifestConfig {
    return this.manifest
  }

  isInitialized(): boolean {
    return this.initialized
  }
}
