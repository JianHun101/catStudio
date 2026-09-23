/**
 * R14a 角标引用探针测试。
 *
 * 两层（与 `retrieval-baseline.test.js` 同范式）：
 *   - **纯单元**：注入串拼装 / 指示语插入位置 / `[n]` 解析 / 三分判据——喂手搓输入，
 *     可穷举、不碰库不碰 LLM；
 *   - **契约静态断言（形状规格守卫）**：本探针**自己拼**注入串，而生产是
 *     `renderSections` 拼的。两边一旦漂移，探针照跑、读数看起来完全正常，但
 *     「与生产同形」这条前提**静默失效**——测的就不再是生产会注入的东西。
 *     这是 `.mjs` 探针唯一无法靠类型系统兜住的接缝，故直接读源码断言格式字面量。
 *
 * **不测什么**：`s0`/`s1`/`s2` 三条真实调用链（要真库 + 真 provider key + 真 LLM
 * 往返）——那属「系统级 e2e，手动跑」那一档，不在这里假装绿。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import {
  MEMORY_BLOCK_HEADER,
  MEMORY_BLOCK_PREFIX,
  VARIANTS,
  classify,
  parseMarkers,
  renderMemoryBlock,
  rowToAgentConfig,
  withInstruction,
} from './r14a-citation-probe.e2e.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// ─── 注入串形状（票面 §四规格，逐字）─────────────────

describe('注入串形状（票面 §四）', () => {
  it('单节：\\n\\n + 【相关记忆】 + 换行 + `1. 正文`', () => {
    expect(renderMemoryBlock(['甲'])).toBe('\n\n【相关记忆】\n1. 甲')
  })

  it('多节：逐行 `序号. 正文`，序号从 1 连续', () => {
    expect(renderMemoryBlock(['甲', '乙', '丙'])).toBe('\n\n【相关记忆】\n1. 甲\n2. 乙\n3. 丙')
  })

  it('空节集 → 空串（与生产同约定：无命中不注入整块）', () => {
    expect(renderMemoryBlock([])).toBe('')
    expect(withInstruction([], VARIANTS.jia)).toBe('')
  })

  it('前缀常量与头常量与规格字面量一致', () => {
    expect(MEMORY_BLOCK_PREFIX).toBe('\n\n')
    expect(MEMORY_BLOCK_HEADER).toBe('【相关记忆】')
  })

  it('正文含换行时保持原样（生产是 `s.parts.join("\\n")`，不折行）', () => {
    expect(renderMemoryBlock(['上\n下'])).toBe('\n\n【相关记忆】\n1. 上\n下')
  })
})

describe('指示语插入位置（票面 §四：头之后、`1.` 之前）', () => {
  it('甲版插在头与首节之间', () => {
    expect(withInstruction(['甲', '乙'], VARIANTS.jia)).toBe(
      `\n\n【相关记忆】\n${VARIANTS.jia}\n1. 甲\n2. 乙`
    )
  })

  it('乙版同位置（两版只差措辞，不差位置——位置是待观察量，不作第二个自变量）', () => {
    expect(withInstruction(['甲'], VARIANTS.yi)).toBe(`\n\n【相关记忆】\n${VARIANTS.yi}\n1. 甲`)
  })

  it('指示语不含位置要求（句末/词后等字样）', () => {
    for (const [name, text] of Object.entries(VARIANTS)) {
      expect(text, `变体 ${name} 混入了位置要求`).not.toMatch(/句末|词后|结尾|后面加|之前加/)
    }
  })

  it('编号仍是最终位置的 1..n（指示语不占号）', () => {
    const block = withInstruction(['甲', '乙', '丙'], VARIANTS.jia)
    expect(block).toContain('1. 甲')
    expect(block).toContain('3. 丙')
    expect(block).not.toContain('4. ')
  })
})

// ─── 三分判据（票面 §三：**不许并成一个「遵循率」**）──────

describe('parseMarkers', () => {
  it('取出去重升序的编号', () => {
    expect(parseMarkers('见 [2] 与 [1]，另外 [2] 再说一次')).toEqual([1, 2])
  })

  it('无标记 → 空数组', () => {
    expect(parseMarkers('这句没有角标')).toEqual([])
  })

  it('多位数字也算', () => {
    expect(parseMarkers('见 [10]')).toEqual([10])
  })

  it('不误吃合法但非角标的方括号（[abc] / [ ] / 空）', () => {
    expect(parseMarkers('数组 [abc] 与 [] 与 [ 1 ]')).toEqual([])
  })
})

describe('classify —— 三分判据各自可分', () => {
  it('不标：一个合法号都没写', () => {
    const r = classify('我用了检索到的结论，但没标号', 3)
    expect(r.marked).toBe(false)
    expect(r.inRange).toEqual([])
    expect(r.outOfRange).toEqual([])
  })

  it('标了：写的是合法范围内的号', () => {
    const r = classify('见 [2]', 3)
    expect(r.marked).toBe(true)
    expect(r.inRange).toEqual([2])
    expect(r.outOfRange).toEqual([])
  })

  it('标不存在号：号 > 注入节数，单列 outOfRange（**非措辞问题**）', () => {
    const r = classify('见 [4]', 3)
    expect(r.outOfRange).toEqual([4])
    expect(r.inRange).toEqual([])
    expect(r.marked).toBe(false)
  })

  it('标 0 号同样算越界（编号从 1 起，0 不存在）', () => {
    expect(classify('见 [0]', 3).outOfRange).toEqual([0])
  })

  it('合法号与越界号混写时两者各自成列——不互相掩盖', () => {
    const r = classify('见 [1] 和 [9]', 3)
    expect(r.inRange).toEqual([1])
    expect(r.outOfRange).toEqual([9])
    expect(r.marked).toBe(true)
  })

  it('「标错号」不由本函数判定——它需要「内容其实来自第几节」的答案锚点（S1 阶段的有标注问题集）', () => {
    // 本函数只给「标了哪些号」，判定「标错」要外部真值。这条钉住职责边界，
    // 防止后来者以为 classify 能独立给出三分全貌。
    const r = classify('见 [2]', 3)
    expect(Object.keys(r).sort()).toEqual(['inRange', 'marked', 'markers', 'outOfRange'])
  })
})

// ─── 形状规格守卫：`renderSections` 一变即红 ──────────────

describe('形状规格守卫（生产 renderSections ↔ 探针拼装）', () => {
  const src = readFileSync(path.join(REPO_ROOT, 'packages/server/src/memory/index.ts'), 'utf8')

  /** 取 `renderSections` 函数体（从其声明到下一个顶格 `}`）——不锚行号 */
  function renderSectionsBody() {
    const start = src.indexOf('function renderSections(')
    expect(start, 'renderSections 不在 memory/index.ts 里了——守卫失效，先修守卫').toBeGreaterThan(
      -1
    )
    const end = src.indexOf('\n}', start)
    expect(end, '取不到 renderSections 函数体结尾').toBeGreaterThan(start)
    return src.slice(start, end)
  }

  it('头字面量 `【相关记忆】` 仍在前缀 `\\n\\n` 之后', () => {
    expect(renderSectionsBody()).toContain('`\\n\\n【相关记忆】\\n${')
  })

  it('逐行格式仍是 `${i + 1}. `（序号 = 最终位置，从 1 起）', () => {
    expect(renderSectionsBody()).toContain('`${i + 1}. ')
  })

  it('零节返回空串（探针同约定）', () => {
    expect(renderSectionsBody()).toContain(
      `if (sections.length === 0) return { text: '', tokens: 0 }`
    )
  })

  it('探针拼装出的串与规格逐字相等（防止探针侧单方面漂移）', () => {
    // 规格串写死在断言里，**不引用探针常量**——引用常量的话探针改错时断言会跟着错。
    expect(renderMemoryBlock(['A', 'B'])).toBe('\n\n【相关记忆】\n1. A\n2. B')
  })
})

// ─── DB 行 → AgentConfig（API 边界同口径）───────────────

describe('rowToAgentConfig', () => {
  it('snake_case 行映射到 camelCase，字段名与生产 AgentConfig 对齐', () => {
    const cfg = rowToAgentConfig({
      name: '某猫',
      system_prompt: '你是猫',
      llm_provider: 'claude',
      llm_model: 'm',
      llm_api_key: 'k',
      llm_base_url: 'http://x',
      effort_level: 'high',
      llm_max_tokens: 100,
      llm_temperature: 0.3,
      llm_env_extra: '{}',
    })
    expect(cfg.llmProvider).toBe('claude')
    expect(cfg.llmModel).toBe('m')
    expect(cfg.llmApiKey).toBe('k')
    expect(cfg.llmBaseUrl).toBe('http://x')
    expect(cfg.effortLevel).toBe('high')
    expect(cfg.llmMaxTokens).toBe(100)
    expect(cfg.llmTemperature).toBe(0.3)
    expect(cfg.systemPrompt).toBe('你是猫')
  })

  it('缺省列落 undefined，不落 null（适配器侧读的是 undefined 语义）', () => {
    const cfg = rowToAgentConfig({
      name: 'x',
      llm_provider: 'ollama',
      llm_model: 'm',
      llm_api_key: '',
    })
    expect(cfg.llmBaseUrl).toBeUndefined()
    expect(cfg.effortLevel).toBeUndefined()
    expect(cfg.llmEnvExtra).toBeUndefined()
  })
})
