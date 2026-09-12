import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isTableSeparatorRow } from './table-transcribe.js'
import { MAX_TEXT_LENGTH, segmentDocument, type SegmentReport } from './segment.js'

/** 票丙 A3–A7：回退链逐级 / 450 不变式 / 无内容丢失 / 面包屑与锚 / 纯函数静态断言 */

// flywheel → memory → src → server → packages → 仓库根
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')

/** 语料 = docs/adr + docs/plans + docs/lessons（A4/A5 的判据面） */
function corpusFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return // docs/lessons 目录可能尚不存在
    }
    for (const e of entries) {
      const p = join(dir, e)
      if (statSync(p).isDirectory()) walk(p)
      else if (e.endsWith('.md')) out.push(p)
    }
  }
  for (const d of ['docs/adr', 'docs/plans', 'docs/lessons']) walk(resolve(REPO_ROOT, d))
  return out
}

const relPath = (abs: string): string => relative(REPO_ROOT, abs).split(/[\\/]/).join('/')

function reportFor(abs: string): { rel: string; report: SegmentReport } {
  const rel = relPath(abs)
  return { rel, report: segmentDocument({ path: rel, content: readFileSync(abs, 'utf-8') }) }
}

const stripWs = (s: string): string => s.replace(/\s+/g, '')

/** 去掉围栏标记行后把所有 body 拼起来——硬切的片各自带一份开围栏前缀，只有剔除它内容才连续 */
function bodyCorpus(report: SegmentReport): string {
  return stripWs(
    report.segments
      .map((s) =>
        s.body
          .split('\n')
          .filter((l) => !/^\s*(`{3,}|~{3,})/.test(l))
          .join('\n')
      )
      .join('')
  )
}

// ---------------------------------------------------------------------------

describe('segmentDocument · A3 回退链逐级', () => {
  it('L1 · 无 `##` 时按 `#` 切；标题链进面包屑、标题行不进 body', () => {
    const content = ['# 甲节', '', '甲的内容。', '', '# 乙节', '', '乙的内容。'].join('\n')
    const r = segmentDocument({ path: 'docs/x.md', content })

    expect(r.segments).toHaveLength(2)
    expect(r.segments[0].breadcrumb).toBe('docs/x.md > 甲节')
    expect(r.segments[0].sectionAnchor).toBe('甲节')
    expect(r.segments[1].breadcrumb).toBe('docs/x.md > 乙节')
    for (const s of r.segments) expect(s.body).not.toContain('#')
  })

  it('L1 · 无任何标题 ⇒ 整文件一块，面包屑退化为路径、节锚为空串', () => {
    const r = segmentDocument({ path: 'a/b.md', content: '只有正文，没有标题。' })
    expect(r.segments).toHaveLength(1)
    expect(r.segments[0].breadcrumb).toBe('a/b.md')
    expect(r.segments[0].sectionAnchor).toBe('')
    expect(r.segments[0].body).toBe('只有正文，没有标题。')
  })

  it('L2 · 单节超 450 且含 `###` ⇒ 按 `###` 重切，节锚变 `H2 > H3`', () => {
    const filler = '填'.repeat(200) + '。'
    const content = [
      '# 顶层',
      '',
      '## 大节',
      '',
      filler,
      '',
      '### 子一',
      '',
      filler,
      '',
      '### 子二',
      '',
      filler,
    ].join('\n')
    const r = segmentDocument({ path: 'docs/x.md', content })

    expect(r.segments).toHaveLength(3)
    expect(r.segments.map((s) => s.breadcrumb)).toEqual([
      'docs/x.md > 顶层 > 大节',
      'docs/x.md > 顶层 > 大节 > 子一',
      'docs/x.md > 顶层 > 大节 > 子二',
    ])
    expect(r.segments.map((s) => s.sectionAnchor)).toEqual(['大节', '大节 > 子一', '大节 > 子二'])
    for (const s of r.segments) expect(s.body).not.toContain('###')
  })

  it('L3-a · 表格**无条件**转写：短表也转，返回值里不再有 `|` 形态', () => {
    const content = ['# T', '', '## S', '', '| 名 | 值 |', '| --- | --- |', '| 甲 | 1 |'].join('\n')
    const r = segmentDocument({ path: 'p.md', content })

    expect(r.segments).toHaveLength(1)
    expect(r.segments[0].body).toContain('名：甲；值：1')
    expect(r.segments[0].body).not.toContain('|')
    expect(r.segments[0].body).not.toContain('---')
  })

  it('L3-a · 同节多表 ⇒ 每张表带可区分前缀（表前最近一句散文）', () => {
    const content = [
      '# T',
      '',
      '## S',
      '',
      '第一张表的说明句。',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '第二张表的说明句。',
      '',
      '| c | d |',
      '| --- | --- |',
      '| 3 | 4 |',
    ].join('\n')
    const r = segmentDocument({ path: 'p.md', content })
    const body = r.segments.map((s) => s.body).join('\n')

    expect(body).toContain('【第一张表的说明句。】a：1；b：2')
    expect(body).toContain('【第二张表的说明句。】c：3；d：4')
  })

  it('L3-b · 条目边界贪心打包：每片 body 的每一行都是完整条目', () => {
    const items = Array.from({ length: 30 }, (_, i) => `- 第 ${i + 1} 条目的内容若干字符`).join(
      '\n'
    )
    const r = segmentDocument({ path: 'p.md', content: `# T\n\n## S\n\n${items}` })

    expect(r.segments.length).toBeGreaterThan(1)
    for (const s of r.segments) {
      for (const line of s.body.split('\n')) expect(line).toMatch(/^- /)
    }
    // 条目总数不丢
    const kept = r.segments.reduce((n, s) => n + s.body.split('\n').length, 0)
    expect(kept).toBe(30)
  })

  it('L3-c · 空行（段落）边界打包：片内不出现空行，段落整段进片', () => {
    const paras = Array.from({ length: 10 }, (_, i) => `第 ${i + 1} 段正文内容。`.repeat(6))
    const r = segmentDocument({ path: 'p.md', content: `# T\n\n## S\n\n${paras.join('\n\n')}` })

    expect(r.segments.length).toBeGreaterThan(1)
    for (const s of r.segments) {
      expect(s.body).not.toContain('\n\n')
      for (const line of s.body.split('\n')) expect(line.endsWith('。')).toBe(true)
    }
    expect(r.segments.reduce((n, s) => n + s.body.split('\n').length, 0)).toBe(10)
  })

  it('L3-d · 句边界：标点随前片（每片 body 收尾于句末标点）', () => {
    const sentence = '甲乙丙丁戊己庚辛壬癸'.repeat(3) + '。'
    const r = segmentDocument({ path: 'p.md', content: `# T\n\n## S\n\n${sentence.repeat(20)}` })

    expect(r.segments.length).toBeGreaterThan(1)
    for (const s of r.segments) {
      expect('。！？；').toContain(s.body.slice(-1))
      expect(s.hardCut).toBe(false)
    }
    // 标点**随前片**：不得出现以标点开头的片
    for (const s of r.segments) expect('。！？；').not.toContain(s.body.slice(0, 1))
  })

  it('L3-e · 代码块按 `\\n` 切且**开围栏行（语言标记）复制到每片**', () => {
    const code = Array.from({ length: 40 }, (_, i) => `const value${i} = ${i};`).join('\n')
    const r = segmentDocument({ path: 'p.md', content: `# T\n\n## S\n\n\`\`\`ts\n${code}\n\`\`\`` })

    expect(r.segments.length).toBeGreaterThan(1)
    for (const s of r.segments) {
      expect(s.body.startsWith('```ts')).toBe(true)
      const lines = s.body.split('\n')
      expect(lines.slice(1).some((l) => /^const value\d+ = \d+;$/.test(l))).toBe(true)
      // 闭围栏不复制（只有开围栏那一行是标记）
      expect(lines.slice(1)).not.toContain('```')
    }
    // 代码行一条不丢
    const keptLines = r.segments.flatMap((s) => s.body.split('\n').slice(1))
    expect(keptLines).toEqual(code.split('\n'))
  })

  it('L3-f · 字符硬切：产物**照样入库**，只额外记进 hardCuts 报告', () => {
    const blob = 'A'.repeat(1200) // 无句边界、无空行、无换行的连续串
    const r = segmentDocument({ path: 'p.md', content: `# T\n\n## S\n\n${blob}` })

    expect(r.segments.length).toBeGreaterThan(1)
    expect(r.segments.every((s) => s.hardCut)).toBe(true)
    expect(r.hardCuts).toHaveLength(r.segments.length)

    const budget = MAX_TEXT_LENGTH - (r.segments[0].breadcrumb.length + 1)
    expect(r.segments[0].body).toHaveLength(budget)
    // 硬切不丢内容
    expect(stripWs(r.segments.map((s) => s.body).join(''))).toBe(blob)
    // hardCuts 报告的键与片一一对应
    expect(r.hardCuts.map((h) => h.partIndex)).toEqual(r.segments.map((s) => s.partIndex))
  })

  it('确定性：同输入同输出；片序号按 (path, sectionAnchor) 分组 1-based', () => {
    const content = `# T\n\n## S\n\n${'很长的句子内容。'.repeat(80)}`
    const a = segmentDocument({ path: 'p.md', content })
    const b = segmentDocument({ path: 'p.md', content })
    expect(a).toEqual(b)

    const byAnchor = new Map<string, number[]>()
    for (const s of a.segments) {
      expect(s.partIndex).toBeGreaterThanOrEqual(1)
      expect(s.partIndex).toBeLessThanOrEqual(s.partTotal)
      byAnchor.set(s.sectionAnchor, [...(byAnchor.get(s.sectionAnchor) ?? []), s.partIndex])
    }
    for (const idx of byAnchor.values()) expect(idx).toEqual(idx.map((_, i) => i + 1))
    expect(a.maxTextLength).toBe(Math.max(...a.segments.map((s) => s.text.length)))
  })
})

describe('segmentDocument · A6 面包屑与话题锚', () => {
  const first = '锚句。'
  const s2 = '乙'.repeat(300) + '。'
  const s3 = '丙'.repeat(300) + '。'
  const content = `# 顶层\n\n## 大节\n\n### 子节\n\n${first}${s2}${s3}`

  it('多级标题的面包屑 = `路径 > H1 > H2 > H3`', () => {
    const r = segmentDocument({ path: 'docs/x.md', content })
    expect(r.segments[0].breadcrumb).toBe('docs/x.md > 顶层 > 大节 > 子节')
    expect(r.segments[0].sectionAnchor).toBe('大节 > 子节')
  })

  it('段首片无锚；非首片有锚，且锚 = 该段首句**原文**（逐字相同）', () => {
    const r = segmentDocument({ path: 'docs/x.md', content })
    expect(r.segments.length).toBeGreaterThanOrEqual(2)

    const [p1, p2] = r.segments
    const bc = p1.breadcrumb
    // 段首片：text = 面包屑 + body，无锚
    expect(p1.text).toBe(`${bc}\n${p1.body}`)
    // 非首片：text = 面包屑 + 段首句原文 + body，body 不含锚
    expect(p2.text).toBe(`${bc}\n${first}\n${p2.body}`)
    expect(p2.text.split('\n')[1]).toBe(first)
    expect(p2.body).not.toContain(first)
  })

  it('锚与面包屑都计入 450 预算：带锚片同样不超限', () => {
    const r = segmentDocument({ path: 'docs/x.md', content })
    for (const s of r.segments) expect(s.text.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH)
  })

  it('450 超预算时锚整体放弃（不截断）——否则就不是「原文」了', () => {
    const longFirst = '丁'.repeat(MAX_TEXT_LENGTH) + '。'
    const r = segmentDocument({ path: 'p.md', content: `# T\n\n## S\n\n${longFirst}${s3}` })
    for (const s of r.segments) {
      expect(s.text.length).toBeLessThanOrEqual(MAX_TEXT_LENGTH)
      if (s.partIndex > 1) expect(s.text).not.toContain(longFirst)
    }
  })
})

describe('segmentDocument · A4/A5 真实语料', () => {
  it('A4 · 450 不变式：全部真实语料每片 text ≤ 450', () => {
    const files = corpusFiles()
    expect(files.length).toBeGreaterThan(0)

    const violations: string[] = []
    let segs = 0
    let hard = 0
    let maxTextLength = 0
    for (const abs of files) {
      const { rel, report } = reportFor(abs)
      segs += report.segments.length
      hard += report.hardCuts.length
      maxTextLength = Math.max(maxTextLength, report.maxTextLength)
      for (const s of report.segments) {
        if (s.text.length > MAX_TEXT_LENGTH)
          violations.push(`${rel}#${s.partIndex} ${s.text.length}`)
      }
      if (report.maxTextLength !== Math.max(0, ...report.segments.map((s) => s.text.length))) {
        violations.push(`${rel} maxTextLength 与实际不符`)
      }
      if (report.hardCuts.length !== report.segments.filter((s) => s.hardCut).length) {
        violations.push(`${rel} hardCuts 与实际不符`)
      }
    }
    expect(violations).toEqual([])
    expect(maxTextLength).toBeLessThanOrEqual(MAX_TEXT_LENGTH)

    // 换型触发条件②「千级切片」的**第一个真实读数**——故意留痕（tickets.md 票丙签收判据
    // 要求「实测片数/硬切次数写进交付说明」），不是调试残留
    console.log(
      `[A4 实测] ${files.length} 文件 / ${segs} 片 / 硬切 ${hard} 次 / maxTextLength ${maxTextLength}`
    )
  })

  it('A5 · 无内容丢失：正文段落一段不缺（表格走值级校验）', () => {
    const missing: string[] = []
    for (const abs of corpusFiles()) {
      const { rel, report } = reportFor(abs)
      const corpus = bodyCorpus(report)
      const lines = readFileSync(abs, 'utf-8').replace(/\r\n?/g, '\n').split('\n')
      const fenced = fenceFlags(lines)
      const frontmatter = frontmatterRange(lines)

      for (let i = 0; i < lines.length; i++) {
        if (frontmatter.has(i)) continue // frontmatter 按 C3 有意剥离，不算「正文缺失」
        const line = lines[i]
        if (line.trim() === '') continue
        if (!fenced[i] && /^\s*#{1,6}\s/.test(line)) continue // 标题由面包屑承担，另行校验
        if (/^\s*(`{3,}|~{3,})/.test(line)) continue // 围栏标记行会被复制/丢弃
        if (!fenced[i] && /^\s*\|/.test(line)) continue // 表格行会被转写成句子
        const norm = stripWs(line)
        if (norm !== '' && !corpus.includes(norm)) missing.push(`${rel}: ${line.slice(0, 60)}`)
      }

      // 标题文本必须落到某片的面包屑里（不丢，只是换了个位置）
      const crumbs = report.segments.map((s) => s.breadcrumb).join('\n')
      for (let i = 0; i < lines.length; i++) {
        if (fenced[i] || frontmatter.has(i)) continue // 围栏里的 `# 注释` 不是标题
        const m = /^\s*#{1,3}\s+(.*)$/.exec(lines[i])
        if (m && !crumbs.includes(m[1].trim())) missing.push(`${rel} 标题未进面包屑: ${m[1]}`)
      }

      // 表格：每个非空单元格的**值**必须落进某片 body（转写不是丢弃）
      for (const value of tableCellValues(lines)) {
        if (!corpus.includes(stripWs(value)))
          missing.push(`${rel} 表格值丢失: ${value.slice(0, 40)}`)
      }
    }
    expect(missing).toEqual([])
  })
})

/** 独立实现：标记每行是否处于围栏代码块内（含开闭围栏行） */
function fenceFlags(lines: string[]): boolean[] {
  const out = new Array<boolean>(lines.length).fill(false)
  let char = ''
  let len = 0
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(lines[i])
    if (char === '') {
      if (m) {
        char = m[1][0]
        len = m[1].length
        out[i] = true
      }
    } else {
      out[i] = true
      if (m && m[1][0] === char && m[1].length >= len && m[2].trim() === '') {
        char = ''
        len = 0
      }
    }
  }
  return out
}

/** 独立实现：被 C3 剥离掉的 frontmatter 行索引集合（未闭合则不剥） */
function frontmatterRange(lines: string[]): Set<number> {
  const skip = new Set<number>()
  if (lines.length === 0 || lines[0].trim() !== '---') return skip
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t === '---' || t === '...') {
      for (let k = 0; k <= i; k++) skip.add(k)
      return skip
    }
  }
  return skip
}

/** 独立实现（不复用被测模块的拆分器）：抽出所有表格数据行的非空单元格值 */
function tableCellValues(lines: string[]): string[] {
  const out: string[] = []
  for (let i = 1; i < lines.length; i++) {
    if (!isTableSeparatorRow(lines[i]) || !lines[i - 1].includes('|')) continue
    let j = i + 1
    while (j < lines.length && lines[j].trim() !== '' && lines[j].includes('|')) {
      const cells = lines[j].split(/(?<!\\)\|/).map((c) => c.trim())
      if (cells.length > 1 && cells[0] === '') cells.shift()
      if (cells.length > 1 && cells[cells.length - 1] === '') cells.pop()
      for (const c of cells) {
        if (c === '') continue
        if (c.includes('<br>') || c.includes('<br/>') || c.includes('\\|')) continue // 会被规则③改写
        out.push(c)
      }
      j++
    }
    i = j - 1
  }
  return out
}

describe('segmentDocument · A11 frontmatter 剥离边界四例（C3）', () => {
  it('① 正文中间的 `---` 是水平分割线 ⇒ **不剥**', () => {
    const content = '# T\n\n上半段。\n\n---\n\n下半段。'
    const r = segmentDocument({ path: 'p.md', content })
    const body = r.segments.map((s) => s.body).join('\n')
    expect(body).toContain('上半段。')
    expect(body).toContain('下半段。')
  })

  it('② 只有开头 `---`、无闭合 ⇒ **不剥**（向严不向宽：宁可多索引，不可误删）', () => {
    const content = ['---', 'type: decision', '', '# T', '', '正文一段。'].join('\n')
    const r = segmentDocument({ path: 'p.md', content })
    const body = r.segments.map((s) => s.body).join('\n')
    // 未闭合 ⇒ 整份当普通正文，元数据行仍在（不静默丢内容）
    expect(body).toContain('type: decision')
    expect(body).toContain('正文一段。')
  })

  it('③ 剥离后首行是空行 ⇒ 不影响后续 L1 切分', () => {
    const content = ['---', 'type: decision', '---', '', '# T', '', '## 大节', '', '内容。'].join(
      '\n'
    )
    const r = segmentDocument({ path: 'p.md', content })
    expect(r.segments).toHaveLength(1)
    expect(r.segments[0].breadcrumb).toBe('p.md > T > 大节')
    expect(r.segments[0].body).toBe('内容。')
  })

  it('④ frontmatter + 无 H1 直接 `##` ⇒ 前言块为空，**不产出空片**', () => {
    const content = ['---', 'type: decision', '---', '', '## 大节', '', '内容。'].join('\n')
    const r = segmentDocument({ path: 'p.md', content })
    expect(r.segments).toHaveLength(1)
    expect(r.segments[0].sectionAnchor).toBe('大节')
    for (const s of r.segments) expect(s.body.trim()).not.toBe('')
  })

  it('闭合符 `...` 同样算闭合；剥离段不进 body / breadcrumb / warnings', () => {
    const content = [
      '---',
      'type: decision',
      'status: accepted',
      '...',
      '',
      '# T',
      '',
      '正文。',
    ].join('\n')
    const r = segmentDocument({ path: 'p.md', content })
    expect(r.warnings).toEqual([])
    expect(r.segments).toHaveLength(1)
    expect(r.segments[0].text).not.toContain('type:')
    expect(r.segments[0].text).not.toContain('status:')
    expect(r.segments[0].breadcrumb).not.toContain('type')
  })
})

describe('segmentDocument · A10 frontmatter 不进正文（真实 ADR）', () => {
  it('7 份带 frontmatter 的近期 ADR：所有片的 body 与 text 均不含元数据字面', () => {
    const withFm = [
      '0007-external-tool-form-selection-checklist.md',
      '0008-acp-multi-provider-unification.md',
      '0009-multimodal-knowledge-base.md',
      '0011-execution-engine-extraction.md',
      '0012-session-closeout-and-push-approval.md',
      '0013-c3-outbound-bus-not-adopted.md',
      '0014-skill-delivery-decoupling.md',
    ]
    const literals = ['type:', 'status:', 'evidence:', '- kind:']

    const hits: string[] = []
    for (const name of withFm) {
      const abs = resolve(REPO_ROOT, 'docs/adr', name)
      expect(readFileSync(abs, 'utf-8').startsWith('---')).toBe(true) // 该件确有 frontmatter
      const { report } = reportFor(abs)
      expect(report.segments.length).toBeGreaterThan(0)
      for (const s of report.segments) {
        for (const lit of literals) {
          if (s.body.includes(lit)) hits.push(`${name}#${s.partIndex} body 含 ${lit}`)
          if (s.text.includes(lit)) hits.push(`${name}#${s.partIndex} text 含 ${lit}`)
        }
      }
    }
    expect(hits).toEqual([])
  })
})

describe('segmentDocument · A7 纯函数静态断言', () => {
  // 读的就是被判面本身（同目录同名的真实源码文件）。此处用 readFileSync 而非 Vite `?raw`：
  // server 包没有 `vite/client` 类型面，`?raw` 会让 `pnpm lint` 挂——两者读到的字节相同。
  const readSelf = (f: string): string => readFileSync(new URL(f, import.meta.url), 'utf-8')
  const sources: Record<string, string> = {
    'segment.ts': readSelf('./segment.ts'),
    'table-transcribe.ts': readSelf('./table-transcribe.ts'),
  }

  it('源码不含文件系统 / 模型 / 环境变量 / 时钟依赖', () => {
    const names = Object.keys(sources)
    expect(names.length).toBeGreaterThanOrEqual(2)

    const forbidden = [
      "from 'fs'",
      'from "fs"',
      'node:fs',
      '@huggingface/transformers',
      'process.env',
      'Date.now',
      'new Date(',
    ]
    for (const [name, src] of Object.entries(sources)) {
      for (const token of forbidden) {
        expect(`${name}:${src.includes(token)}`).toBe(`${name}:false`)
      }
    }
  })

  it('源码不 import db/** 与 embedding.ts（本票不接线）', () => {
    for (const [name, src] of Object.entries(sources)) {
      expect(`${name}:${/from\s+['"][^'"]*db\//.test(src)}`).toBe(`${name}:false`)
      expect(`${name}:${/from\s+['"][^'"]*embedding/.test(src)}`).toBe(`${name}:false`)
    }
  })
})
