/**
 * SkillLoader 测试
 *
 * 验证:
 * - 初始化加载 manifest + skill 文件
 * - 关键词匹配（命中/未命中/部分命中/边界）
 * - 错误处理（缺失文件、错误 manifest）
 * - 空 skillModules 安全降级
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SkillLoader, escapeRegex } from './skill-loader.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const TEST_SKILLS_DIR = join(__dirname, '__test_skills__')

function createTestManifest(): void {
  const manifest = {
    skills: {
      handoff: {
        description: '工作交接文档模板',
        triggers: ['交接', 'handoff'],
        file: 'handoff.md',
      },
      'code-review': {
        description: '代码审查流程',
        triggers: ['review', '审查'],
        file: 'code-review.md',
      },
      'dep-review': {
        description: '依赖审查流程',
        triggers: ['安装', 'install'],
        file: 'dep-review.md',
      },
    },
  }
  writeFileSync(join(TEST_SKILLS_DIR, 'manifest.json'), JSON.stringify(manifest), 'utf-8')
  writeFileSync(join(TEST_SKILLS_DIR, 'handoff.md'), '\n## 工作交接规范\n交接模板内容\n', 'utf-8')
  writeFileSync(
    join(TEST_SKILLS_DIR, 'code-review.md'),
    '\n## 代码审查流程\n审查流程内容\n',
    'utf-8'
  )
  // dep-review.md 不创建，测试缺失文件场景
}

describe('SkillLoader', () => {
  beforeEach(() => {
    SkillLoader.reset()
    // 清理和重建测试目录
    if (existsSync(TEST_SKILLS_DIR)) {
      rmSync(TEST_SKILLS_DIR, { recursive: true, force: true })
    }
    mkdirSync(TEST_SKILLS_DIR, { recursive: true })
  })

  afterEach(() => {
    SkillLoader.reset()
    if (existsSync(TEST_SKILLS_DIR)) {
      rmSync(TEST_SKILLS_DIR, { recursive: true, force: true })
    }
  })

  // ─── 初始化 ───

  describe('initialize', () => {
    it('loads manifest and available skill files', () => {
      createTestManifest()
      const loader = SkillLoader.initialize(TEST_SKILLS_DIR)

      expect(loader.isInitialized()).toBe(true)
      const names = loader.getLoadedSkillNames()
      // handoff + code-review 应该加载成功，dep-review 文件缺失应被跳过
      expect(names).toContain('handoff')
      expect(names).toContain('code-review')
    })

    it('throws when manifest.json is missing', () => {
      // 不创建 manifest
      expect(() => SkillLoader.initialize(TEST_SKILLS_DIR)).toThrow(/Failed to load manifest/)
    })

    it('throws when manifest.json is invalid JSON', () => {
      writeFileSync(join(TEST_SKILLS_DIR, 'manifest.json'), 'not valid json{', 'utf-8')
      expect(() => SkillLoader.initialize(TEST_SKILLS_DIR)).toThrow(/Failed to load manifest/)
    })

    it('throws when manifest is missing "skills" field', () => {
      writeFileSync(
        join(TEST_SKILLS_DIR, 'manifest.json'),
        JSON.stringify({ other: true }),
        'utf-8'
      )
      expect(() => SkillLoader.initialize(TEST_SKILLS_DIR)).toThrow(/缺少 "skills"/)
    })

    it('skips skill files that do not exist (graceful degradation)', () => {
      createTestManifest()
      const loader = SkillLoader.initialize(TEST_SKILLS_DIR)

      // dep-review.md 不存在，应被跳过但不应影响其他 skill
      const names = loader.getLoadedSkillNames()
      expect(names).not.toContain('dep-review')
      expect(names.length).toBeGreaterThanOrEqual(2)
      expect(loader.isInitialized()).toBe(true)
    })
  })

  // ─── 单例 ───

  describe('singleton', () => {
    it('getInstance throws before initialization', () => {
      expect(() => SkillLoader.getInstance()).toThrow(/not initialized/)
    })

    it('getInstance returns the initialized instance', () => {
      createTestManifest()
      const loader = SkillLoader.initialize(TEST_SKILLS_DIR)
      expect(SkillLoader.getInstance()).toBe(loader)
    })

    it('reset clears the singleton', () => {
      createTestManifest()
      SkillLoader.initialize(TEST_SKILLS_DIR)
      SkillLoader.reset()
      expect(() => SkillLoader.getInstance()).toThrow(/not initialized/)
    })

    it('re-initialize replaces the singleton', () => {
      createTestManifest()
      const loader1 = SkillLoader.initialize(TEST_SKILLS_DIR)
      const loader2 = SkillLoader.initialize(TEST_SKILLS_DIR)
      expect(loader2).not.toBe(loader1)
      expect(SkillLoader.getInstance()).toBe(loader2)
    })
  })

  // ─── matchAndBuild ───

  describe('matchAndBuild', () => {
    const BASE_PROMPT = '你是一只AI猫。'

    beforeEach(() => {
      createTestManifest()
      SkillLoader.initialize(TEST_SKILLS_DIR)
    })

    it('returns basePrompt unchanged when no skillModules declared', () => {
      const loader = SkillLoader.getInstance()
      const result = loader.matchAndBuild(BASE_PROMPT, [], '请帮我交接代码')

      expect(result.prompt).toBe(BASE_PROMPT)
      expect(result.matchedSkills).toEqual([])
    })

    it('returns basePrompt unchanged when no keywords matched', () => {
      const loader = SkillLoader.getInstance()
      const result = loader.matchAndBuild(BASE_PROMPT, ['handoff'], '今天天气真好')

      expect(result.prompt).toBe(BASE_PROMPT)
      expect(result.matchedSkills).toEqual([])
    })

    it('matches single skill by keyword', () => {
      const loader = SkillLoader.getInstance()
      const result = loader.matchAndBuild(
        BASE_PROMPT,
        ['handoff', 'code-review'],
        '请帮我做一个交接'
      )

      expect(result.matchedSkills).toContain('handoff')
      expect(result.matchedSkills).not.toContain('code-review')
      expect(result.prompt).toContain('工作交接规范')
      expect(result.prompt).toContain(BASE_PROMPT)
      expect(result.prompt).not.toContain('代码审查流程')
    })

    it('matches multiple skills when multiple keywords present', () => {
      const loader = SkillLoader.getInstance()
      const result = loader.matchAndBuild(
        BASE_PROMPT,
        ['handoff', 'code-review'],
        '请 review 这个交接文档'
      )

      expect(result.matchedSkills).toContain('handoff')
      expect(result.matchedSkills).toContain('code-review')
      expect(result.prompt).toContain('工作交接规范')
      expect(result.prompt).toContain('代码审查流程')
    })

    it('skips skills not in agent.skillModules (cap constraint)', () => {
      const loader = SkillLoader.getInstance()
      const result = loader.matchAndBuild(BASE_PROMPT, ['handoff'], '请 review 这个代码')

      // review 触发词命中了 code-review，但 agent 没有声明这个 skill
      expect(result.matchedSkills).not.toContain('code-review')
      expect(result.prompt).not.toContain('代码审查流程')
    })

    it('skips skills whose file failed to load', () => {
      const loader = SkillLoader.getInstance()
      const result = loader.matchAndBuild(BASE_PROMPT, ['dep-review'], '请帮我安装 react')

      expect(result.matchedSkills).toEqual([])
      expect(result.prompt).toBe(BASE_PROMPT)
    })

    // ─── 显式 /skillName 指令匹配 ───

    it('matches by slash command /skillName', () => {
      const loader = SkillLoader.getInstance()
      const result = loader.matchAndBuild(BASE_PROMPT, ['handoff'], '/handoff 请帮我做交接')

      expect(result.matchedSkills).toContain('handoff')
      expect(result.prompt).toContain('工作交接规范')
    })

    it('matches slash command at start of line', () => {
      const loader = SkillLoader.getInstance()
      const result = loader.matchAndBuild(BASE_PROMPT, ['code-review'], '/code-review 这段代码')

      expect(result.matchedSkills).toContain('code-review')
      expect(result.prompt).toContain('代码审查流程')
    })

    it('matches slash command mid-message after whitespace', () => {
      const loader = SkillLoader.getInstance()
      const result = loader.matchAndBuild(BASE_PROMPT, ['handoff'], '我已经写完了 /handoff 请审查')

      expect(result.matchedSkills).toContain('handoff')
    })

    it('slash regex does NOT match URLs (file:/// — no space before /)', () => {
      // 直接测正则：keyword 触发层会意外命中（handoff 是 trigger），
      // 这里验证正则本身不受 file:/// 干扰
      const re = new RegExp(`(?:^|\\s)/${escapeRegex('handoff')}(?=$|[\\s,，。！？、!?：:()（）])`)
      expect(re.test('file:///handoff')).toBe(false)
      expect(re.test('参考 file:///handoff/docs')).toBe(false)
    })

    it('slash regex does NOT match URLs (https:// — no space before /)', () => {
      const re = new RegExp(`(?:^|\\s)/${escapeRegex('handoff')}(?=$|[\\s,，。！？、!?：:()（）])`)
      expect(re.test('https://example.com/handoff')).toBe(false)
    })

    it('matches CJK skill name by slash command', () => {
      // \b 对 CJK 不生效 → 用显式标点边界
      const loader = SkillLoader.getInstance()
      const result = loader.matchAndBuild(BASE_PROMPT, ['handoff'], '/交接 代码')

      expect(result.matchedSkills).toContain('handoff')
    })

    it('slash command followed by CJK punctuation still matches', () => {
      const loader = SkillLoader.getInstance()
      const result = loader.matchAndBuild(BASE_PROMPT, ['handoff'], '/交接，代码写好了')

      expect(result.matchedSkills).toContain('handoff')
    })

    it('prompt starts with basePrompt', () => {
      const loader = SkillLoader.getInstance()
      const result = loader.matchAndBuild(BASE_PROMPT, ['handoff'], '交接一下代码')

      expect(result.prompt.startsWith(BASE_PROMPT)).toBe(true)
    })
  })

  // ─── 查询接口 ───

  describe('query methods', () => {
    it('getManifest returns parsed manifest', () => {
      createTestManifest()
      const loader = SkillLoader.initialize(TEST_SKILLS_DIR)

      const manifest = loader.getManifest()
      expect(manifest.skills).toBeDefined()
      expect(manifest.skills['handoff']).toBeDefined()
      expect(manifest.skills['handoff'].triggers).toContain('交接')
    })

    it('getLoadedSkillNames returns only successfully loaded skills', () => {
      createTestManifest()
      const loader = SkillLoader.initialize(TEST_SKILLS_DIR)

      const names = loader.getLoadedSkillNames()
      expect(names).toContain('handoff')
      expect(names).toContain('code-review')
      expect(names).not.toContain('dep-review')
    })
  })
})
