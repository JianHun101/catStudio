/**
 * 切片器 — MD 文本进、切片出（段三 · **纯函数，不接线**）。
 *
 * 承 map Decisions 14 / 21 三·四 / 27 / 28 一 / 29。不 import `db/**`、不 import
 * `embedding.ts`、不写任何表、不加 env 开关——本模块**无任何运行时可观察行为变化**。
 *
 * ## 不变式
 *
 * - `segments.every(s => s.text.length <= 450)`（450 含**面包屑与话题锚**，Decisions 29 四 3）
 * - 不存在因超长而静默丢弃的正文：任何超长内容都落到 L3-d/e/f 某个合法边界上，
 *   L3-f 的产物**照样入库**，只额外记进 `hardCuts` 报告（Decisions 29 三）
 *
 * ## 回退链（每一级都是一个合法边界，顺序不可换）
 *
 * | 级   | 刀                                    | 适用形态       |
 * | ---- | ------------------------------------- | -------------- |
 * | L1   | `##`（无则 `#`，再无则整文件一块）    | 结构           |
 * | L2   | `###`                                 | 结构           |
 * | L3-a | 表格行 → 转写句（**全表无条件**）     | 表格           |
 * | L3-b | 条目边界 `^\s*([-*+]|\d+[.)])\s`      | 条目列表       |
 * | L3-c | 空行（段落）                          | 散文           |
 * | L3-d | 句边界 `。！？；`（标点随前片）       | 超长段落内部   |
 * | L3-e | 行边界 `\n`（**代码块专用**）         | ``` 围栏       |
 * | L3-f | 字符硬切 450 + 记例外（标记不阻断）   | 无边界连续串   |
 *
 * ## 实施期钉死的几处口径（规格未写死，此处定）
 *
 * 1. **构成分派不做比例阈值**：L3-a/b/c 实现为「边界层级 + 贪心回并」——先把块拆到
 *    表格 / 条目 / 段落三级的原子，再按 450 贪心回并。更细的边界**只在该原子自身超限时**
 *    才生效，故不需要「表格主导 18%」这类阈值，也不存在「说不出理由的分支」。
 * 2. **表格在块级一次性转写**（`transcribeTablesInBlock`），产出的行流是唯一形态；
 *    该块内的多表区分前缀以**块**为「同一节」的作用域（Decisions 27 规则 5）。
 * 3. **标题行不进 `body`**：`#` / `##` / `###` 行由面包屑承担（Decisions 21 四
 *   「标题进文本、状态进表列」），故 body 不含标题行原文。
 * 4. **`sectionAnchor` 回退**：契约写「H2 > H3 链文本」；块无 H2 时（前言块、无 `##`
 *    的文件按 `#` 重切出来的块）回退为该块的 H1 文本，全无标题时为 `''`——否则同一
 *    文件内多个无 H2 的块会共用一个空锚，`按节去重` 直接失效。
 * 5. **话题锚预算是硬约束**：锚 = 该段首句**原文**（不生成概括）。若 `面包屑 + 锚` 已
 *    占满 450，锚**整体放弃**（不截断——截断就不是「原文」了）并照常出片；锚是派生
 *    上下文、不进 `body`，放弃它不丢任何源内容。
 * 6. **L3-e 的「语言标记复制到每片」**落实为：切分时每片的 `body` 前缀**开围栏行原文**
 *    （```` ```ts ````），闭围栏行丢弃；整块放得下时原样保留开闭两行、不加前缀。
 * 7. **不跨「降级」边界回并**：某原子超限而降级切出的片直接定稿，不再与相邻原子贪心
 *    回并。代价只是偶尔切得比必要的小，不影响 450 不变式与内容保全。
 * 8. **`warnings` 是对契约的加性扩展**：C1 要求「列多于表头不得静默错位」，而
 *    `SegmentReport` 原钉死三字段无处承载 ⇒ 加一个只增不改的 `warnings` 字段。
 */

import {
  isTableSeparatorRow,
  transcribeTableBlockDetailed,
  type TranscribeWarning,
} from './table-transcribe.js'

/** 单片 `text` 字符上限（含面包屑与话题锚）——Decisions 21 三 / 29 四 3 */
export const MAX_TEXT_LENGTH = 450

/** 句边界：标点随前片（Decisions 29 三 · L3-d） */
const SENTENCE_PUNCTUATION = '。！？；'

/** 条目行（Decisions 14 · L3-b） */
const ITEM_LINE = /^\s*([-*+]|\d+[.)])\s/

/** 围栏行（``` 或 ~~~，≥3 个） */
const FENCE_LINE = /^\s*(`{3,}|~{3,})(.*)$/

const H1_LINE = /^#\s+(.*)$/
const H2_LINE = /^##\s+(.*)$/
const H3_LINE = /^###\s+(.*)$/

export interface SegmentInput {
  path: string
  content: string
}

export interface Segment {
  /** 原样透传 */
  path: string
  /** 节锚（`H2 > H3` 链文本；无 H2 时回退 H1，全无标题为 `''`）——按节去重 / 整节返回的键 */
  sectionAnchor: string
  /** `相对路径 > H1 > H2 > H3`（缺级则省略），进 text */
  breadcrumb: string
  /** 该片正文，不含面包屑与话题锚 */
  body: string
  /** 嵌入文本 = breadcrumb + 话题锚（若有）+ body */
  text: string
  /** 1-based，按 `(path, sectionAnchor)` 分组计数 */
  partIndex: number
  partTotal: number
  /** 该片由 L3-f 字符硬切产生 */
  hardCut: boolean
}

export interface HardCut {
  path: string
  sectionAnchor: string
  partIndex: number
}

export interface SegmentReport {
  segments: Segment[]
  hardCuts: HardCut[]
  maxTextLength: number
  /** 加性扩展：转写期告警（见文件头「实施期钉死的几处口径」8） */
  warnings: TranscribeWarning[]
}

/** 内部工作片：字段是渲染前的原料，定稿时才算 breadcrumb / text / partIndex */
interface WorkingPart {
  headings: string[]
  sectionAnchor: string
  body: string
  anchor: string | null
  hardCut: boolean
}

/** L1 切出的一块 */
interface Block {
  h1: string
  h2: string
  lines: string[]
}

/** 已转写的行流 */
interface Transformed {
  lines: string[]
  /** 该行来自表格转写 ⇒ 不参与围栏开关判定（表格单元格里可能有 ``` ） */
  fromTable: boolean[]
}

/** L3 的原子（贪心打包的最小单位） */
interface Atom {
  kind: 'code' | 'item' | 'para'
  text: string
}

interface Ctx {
  path: string
  warnings: TranscribeWarning[]
}

// ---------------------------------------------------------------------------
// 行级工具
// ---------------------------------------------------------------------------

/**
 * 标记每一行是否处于围栏代码块内（含开闭围栏行本身）。
 * `skip[i]` 为真时该行不参与围栏开关判定。
 */
function fenceMask(lines: string[], skip?: boolean[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false)
  let openChar = ''
  let openLen = 0
  for (let i = 0; i < lines.length; i++) {
    if (skip?.[i]) continue
    const m = FENCE_LINE.exec(lines[i])
    if (openChar === '') {
      if (m) {
        openChar = m[1][0]
        openLen = m[1].length
        mask[i] = true // 开围栏行本身也在块内
      }
    } else {
      mask[i] = true
      // 闭围栏：同字符、不短于开围栏、且其后无信息串
      if (m && m[1][0] === openChar && m[1].length >= openLen && m[2].trim() === '') {
        openChar = ''
        openLen = 0
      }
    }
  }
  return mask
}

function breadcrumbOf(path: string, headings: string[]): string {
  return [path, ...headings].filter((s) => s.length > 0).join(' > ')
}

/** 面包屑在 `text` 里占的字节数（含它与后文之间的那个 `\n`） */
function textBase(breadcrumb: string): number {
  return breadcrumb.length === 0 ? 0 : breadcrumb.length + 1
}

function renderText(breadcrumb: string, anchor: string | null, body: string): string {
  return [breadcrumb, anchor ?? '', body].filter((s) => s.length > 0).join('\n')
}

/** 句边界切分：标点随前片（Decisions 29 三 · L3-d） */
function splitSentences(text: string): string[] {
  const out: string[] = []
  let cur = ''
  for (const ch of text) {
    cur += ch
    if (SENTENCE_PUNCTUATION.includes(ch)) {
      out.push(cur)
      cur = ''
    }
  }
  if (cur !== '') out.push(cur)
  return out
}

// ---------------------------------------------------------------------------
// L1 / L2：结构切
// ---------------------------------------------------------------------------

/** 一级切：有 `##` 按 `##`，无则按 `#`，再无则整文件一块。标题行不进 body。 */
function splitTopLevel(lines: string[]): Block[] {
  const mask = fenceMask(lines)
  const isH1 = new Array<boolean>(lines.length).fill(false)
  const isH2 = new Array<boolean>(lines.length).fill(false)
  const h1At = new Array<string>(lines.length).fill('')
  const h2At = new Array<string>(lines.length).fill('')

  let cur1 = ''
  let cur2 = ''
  for (let i = 0; i < lines.length; i++) {
    if (!mask[i]) {
      const m1 = H1_LINE.exec(lines[i])
      const m2 = m1 ? null : H2_LINE.exec(lines[i])
      if (m1) {
        cur1 = m1[1].trim()
        cur2 = ''
        isH1[i] = true
      } else if (m2) {
        cur2 = m2[1].trim()
        isH2[i] = true
      }
    }
    h1At[i] = cur1
    h2At[i] = cur2
  }

  const blocks: Block[] = []
  const push = (start: number, end: number, h2: string): void => {
    if (start >= end) return
    const body: string[] = []
    for (let i = start; i < end; i++) {
      if (isH1[i] || isH2[i]) continue // 标题行由面包屑承担
      body.push(lines[i])
    }
    blocks.push({ h1: h1At[end - 1], h2, lines: body })
  }

  const h2Idx: number[] = []
  for (let i = 0; i < lines.length; i++) if (isH2[i]) h2Idx.push(i)

  if (h2Idx.length > 0) {
    push(0, h2Idx[0], '')
    for (let k = 0; k < h2Idx.length; k++) {
      const s = h2Idx[k]
      const e = k + 1 < h2Idx.length ? h2Idx[k + 1] : lines.length
      push(s, e, h2At[s])
    }
    return blocks
  }

  const h1Idx: number[] = []
  for (let i = 0; i < lines.length; i++) if (isH1[i]) h1Idx.push(i)

  if (h1Idx.length > 0) {
    push(0, h1Idx[0], '')
    for (let k = 0; k < h1Idx.length; k++) {
      const s = h1Idx[k]
      const e = k + 1 < h1Idx.length ? h1Idx[k + 1] : lines.length
      push(s, e, '')
    }
    return blocks
  }

  push(0, lines.length, '')
  return blocks
}

/**
 * L2：单节 > 450 且含 `###` ⇒ 按 `###` 重切。
 * 返回 ≥2 块才算真的切开；无 `###` 时返回单块（调用方据此回落 L3）。
 */
function splitH3(src: Transformed): { h3: string; transformed: Transformed }[] {
  const { lines, fromTable } = src
  const mask = fenceMask(lines, fromTable)
  const h3Idx: number[] = []
  const h3Text: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (mask[i] || fromTable[i]) continue
    const m = H3_LINE.exec(lines[i])
    if (m) {
      h3Idx.push(i)
      h3Text.push(m[1].trim())
    }
  }
  if (h3Idx.length === 0) return [{ h3: '', transformed: src }]

  const out: { h3: string; transformed: Transformed }[] = []
  const push = (start: number, end: number, h3: string): void => {
    out.push({
      h3,
      transformed: { lines: lines.slice(start, end), fromTable: fromTable.slice(start, end) },
    })
  }
  push(0, h3Idx[0], '')
  for (let k = 0; k < h3Idx.length; k++) {
    const s = h3Idx[k]
    const e = k + 1 < h3Idx.length ? h3Idx[k + 1] : lines.length
    push(s, e, h3Text[k])
  }
  return out
}

// ---------------------------------------------------------------------------
// L3-a：表格无条件转写
// ---------------------------------------------------------------------------

/**
 * 就地把块内的表格区段换成转写句（Decisions 28 一：全表无条件）。
 * 同块内 ≥2 张表时，用「表前最近的一句非空散文」作区分前缀，取不到则用 `表 N`。
 */
function transcribeTablesInBlock(lines: string[], ctx: Ctx): Transformed {
  const mask = fenceMask(lines)

  // 先圈出所有表格区段（表头行含 `|` + 下一行是分隔行；连续含 `|` 的非空行为数据行）
  const ranges: { start: number; end: number }[] = []
  let i = 0
  while (i < lines.length) {
    if (
      !mask[i] &&
      lines[i].includes('|') &&
      i + 1 < lines.length &&
      !mask[i + 1] &&
      isTableSeparatorRow(lines[i + 1])
    ) {
      let j = i
      while (j < lines.length && !mask[j] && lines[j].trim() !== '' && lines[j].includes('|')) j++
      ranges.push({ start: i, end: j })
      i = j
      continue
    }
    i++
  }

  if (ranges.length === 0) {
    return { lines: [...lines], fromTable: new Array<boolean>(lines.length).fill(false) }
  }

  const out: string[] = []
  const fromTable: boolean[] = []
  let cursor = 0
  for (let r = 0; r < ranges.length; r++) {
    const { start, end } = ranges[r]
    for (let k = cursor; k < start; k++) {
      out.push(lines[k])
      fromTable.push(false)
    }
    const prefix = ranges.length > 1 ? nearestProsePrefix(lines, mask, start, r + 1) : ''
    const res = transcribeTableBlockDetailed(lines.slice(start, end).join('\n'), { prefix })
    for (const w of res.warnings) ctx.warnings.push(w)
    for (const line of res.lines) {
      out.push(line)
      fromTable.push(true)
    }
    cursor = end
  }
  for (let k = cursor; k < lines.length; k++) {
    out.push(lines[k])
    fromTable.push(false)
  }
  return { lines: out, fromTable }
}

/** 表前最近的一句非空散文（跳过表格行与围栏内行），取不到则 `表 N` */
function nearestProsePrefix(
  lines: string[],
  mask: boolean[],
  start: number,
  ordinal: number
): string {
  for (let i = start - 1; i >= 0; i--) {
    if (mask[i]) continue
    const t = lines[i].trim()
    if (t === '' || t.includes('|')) continue
    const first = splitSentences(t)[0]
    if (first && first.trim() !== '') return first.trim()
  }
  return `表 ${ordinal}`
}

// ---------------------------------------------------------------------------
// L3-b / L3-c：原子拆分 + 贪心打包
// ---------------------------------------------------------------------------

/** 把行流拆到 表格已转写 / 代码围栏 / 条目 / 段落 四类原子 */
function atomsOf(src: Transformed): Atom[] {
  const { lines, fromTable } = src
  const mask = fenceMask(lines, fromTable)
  const atoms: Atom[] = []
  let i = 0
  while (i < lines.length) {
    if (lines[i].trim() === '') {
      i++
      continue
    }
    if (mask[i]) {
      // L3-e 专用形态：整个围栏块是一个原子，放得下就整块不切
      let j = i
      while (j < lines.length && mask[j]) j++
      atoms.push({ kind: 'code', text: lines.slice(i, j).join('\n') })
      i = j
      continue
    }
    if (fromTable[i]) {
      // L3-a 产物：一行（一个数据行）一原子——行内再切是 `；`，由 L3-d 负责。
      // 不并进段落块，否则超长表会按 `；` 跨行碎切（表越大越碎，反噬「块不放大」）。
      atoms.push({ kind: 'para', text: lines[i] })
      i++
      continue
    }
    // L3-c：连续非空行为一个段落块
    let j = i
    while (j < lines.length && lines[j].trim() !== '' && !mask[j] && !fromTable[j]) j++
    // L3-b：段落内再按条目边界分组（条目行 + 其缩进续行）
    let cur: string[] = []
    let curItem = false
    const groups: { lines: string[]; item: boolean }[] = []
    for (const line of lines.slice(i, j)) {
      if (ITEM_LINE.test(line)) {
        if (cur.length > 0) groups.push({ lines: cur, item: curItem })
        cur = [line]
        curItem = true
      } else {
        cur.push(line)
      }
    }
    if (cur.length > 0) groups.push({ lines: cur, item: curItem })
    for (const g of groups) atoms.push({ kind: g.item ? 'item' : 'para', text: g.lines.join('\n') })
    i = j
  }
  return atoms
}

/** L3 主循环：对原子按 450 贪心回并；原子自身超限则降级切 */
function packAtoms(
  atoms: Atom[],
  headings: string[],
  sectionAnchor: string,
  ctx: Ctx
): WorkingPart[] {
  const base = textBase(breadcrumbOf(ctx.path, headings))
  const parts: WorkingPart[] = []
  let buf: string[] = []

  const flush = (): void => {
    if (buf.length === 0) return
    parts.push({ headings, sectionAnchor, body: buf.join('\n'), anchor: null, hardCut: false })
    buf = []
  }

  for (const a of atoms) {
    const fitsAlone = base + a.text.length <= MAX_TEXT_LENGTH
    const merged = buf.length > 0 ? `${buf.join('\n')}\n${a.text}` : a.text
    if (fitsAlone && base + merged.length <= MAX_TEXT_LENGTH) {
      buf.push(a.text)
      continue
    }
    flush()
    if (!fitsAlone) parts.push(...descendAtom(a, headings, sectionAnchor, ctx))
    else buf.push(a.text)
  }
  flush()
  return parts
}

/** 原子自身超限 ⇒ 按顺序换刀：L3-e（代码）/ L3-d（句）→ L3-f（字符硬切） */
function descendAtom(a: Atom, headings: string[], sectionAnchor: string, ctx: Ctx): WorkingPart[] {
  if (a.kind === 'code') return descendCode(a.text, headings, sectionAnchor, ctx)
  return descendProse(a.text, headings, sectionAnchor, ctx)
}

/**
 * L3-d → L3-f：句边界贪心打包；单句仍超限 ⇒ 字符硬切。
 * 话题锚：**仅非段首片**前置该段首句原文；放不进预算则整体放弃（见文件头口径 5）。
 */
function descendProse(
  text: string,
  headings: string[],
  sectionAnchor: string,
  ctx: Ctx
): WorkingPart[] {
  const base = textBase(breadcrumbOf(ctx.path, headings))
  const sentences = splitSentences(text)
  const firstSentence = sentences[0] ?? ''
  // 锚占 `锚 + \n`；至少留 1 字给正文才用锚
  const anchorCost = firstSentence.length + 1
  const anchor = base + anchorCost < MAX_TEXT_LENGTH ? firstSentence : null
  const anchorBudget = anchor === null ? 0 : anchorCost

  const parts: WorkingPart[] = []
  let buf = ''
  const flush = (): void => {
    if (buf === '') return
    const isFirst = parts.length === 0
    parts.push({
      headings,
      sectionAnchor,
      body: buf,
      anchor: isFirst ? null : anchor,
      hardCut: false,
    })
    buf = ''
  }

  for (const s of sentences) {
    const firstBudget = MAX_TEXT_LENGTH - base
    const laterBudget = MAX_TEXT_LENGTH - base - anchorBudget
    // parts 为空 ⇒ 正在攒的是**该段首片**，不预扣锚的预算
    const mergeBudget = parts.length === 0 ? firstBudget : laterBudget
    if (buf !== '' && buf.length + s.length > mergeBudget) flush()
    const soloBudget = parts.length === 0 ? firstBudget : laterBudget
    if (s.length > soloBudget) {
      flush()
      parts.push(...hardCut(s, headings, sectionAnchor, base, anchor, parts.length === 0))
      continue
    }
    buf += s
  }
  flush()
  return parts
}

/** L3-f：字符硬切，产物照样入库，只标记 hardCut */
function hardCut(
  text: string,
  headings: string[],
  sectionAnchor: string,
  base: number,
  anchor: string | null,
  paragraphFirst: boolean
): WorkingPart[] {
  const anchorBudget = anchor === null ? 0 : anchor.length + 1
  const out: WorkingPart[] = []
  let i = 0
  while (i < text.length) {
    const isFirst = paragraphFirst && out.length === 0
    const budget = Math.max(1, MAX_TEXT_LENGTH - base - (isFirst ? 0 : anchorBudget))
    out.push({
      headings,
      sectionAnchor,
      body: text.slice(i, i + budget),
      anchor: isFirst ? null : anchor,
      hardCut: true,
    })
    i += budget
  }
  return out
}

/**
 * L3-e：代码块按 `\n` 切；开围栏行（含语言标记）复制到每片，闭围栏行丢弃。
 * 单行仍超限 ⇒ 该行走 L3-f 字符硬切。
 */
function descendCode(
  text: string,
  headings: string[],
  sectionAnchor: string,
  ctx: Ctx
): WorkingPart[] {
  const lines = text.split('\n')
  const openMatch = lines.length > 0 ? FENCE_LINE.exec(lines[0]) : null
  const open = openMatch ? lines[0] : ''
  let content = open === '' ? lines : lines.slice(1)
  if (openMatch && content.length > 0) {
    const m = FENCE_LINE.exec(content[content.length - 1])
    if (
      m &&
      m[1][0] === openMatch[1][0] &&
      m[1].length >= openMatch[1].length &&
      m[2].trim() === ''
    ) {
      content = content.slice(0, -1)
    }
  }

  const prefix = open === '' ? '' : `${open}\n`
  const base = textBase(breadcrumbOf(ctx.path, headings)) + prefix.length
  const parts: WorkingPart[] = []
  let buf: string[] = []
  const flush = (): void => {
    if (buf.length === 0) return
    parts.push({
      headings,
      sectionAnchor,
      body: prefix + buf.join('\n'),
      anchor: null,
      hardCut: false,
    })
    buf = []
  }

  for (const line of content) {
    if (base + line.length > MAX_TEXT_LENGTH) {
      flush()
      const chunks = hardCut(line, headings, sectionAnchor, base, null, true)
      // 硬切的片同样带上开围栏行，保持「这是代码」的可辨识性
      for (const c of chunks) parts.push({ ...c, body: prefix + c.body })
      continue
    }
    if (buf.length > 0 && base + `${buf.join('\n')}\n${line}`.length > MAX_TEXT_LENGTH) flush()
    buf.push(line)
  }
  flush()
  return parts
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/** 一块的定稿：能放下就整块出片；否则 L2 重切，再否则 L3 */
function processBlock(block: Block, ctx: Ctx): WorkingPart[] {
  const transformed = transcribeTablesInBlock(block.lines, ctx)
  const bodyText = transformed.lines.join('\n').trim()
  if (bodyText === '') return []

  const headings = [block.h1, block.h2].filter((s) => s.length > 0)
  const sectionAnchor = block.h2 || block.h1 || ''
  const base = textBase(breadcrumbOf(ctx.path, headings))

  if (base + bodyText.length <= MAX_TEXT_LENGTH) {
    return [{ headings, sectionAnchor, body: bodyText, anchor: null, hardCut: false }]
  }

  const subs = splitH3(transformed)
  if (subs.length > 1) {
    const out: WorkingPart[] = []
    for (const sub of subs) {
      out.push(...processSubBlock(block, sub, ctx))
    }
    return out
  }

  return packAtoms(atomsOf(transformed), headings, sectionAnchor, ctx)
}

/** L2 切出的 `###` 子块：不再重切 `###`，直接整块出片或落 L3 */
function processSubBlock(
  block: Block,
  sub: { h3: string; transformed: Transformed },
  ctx: Ctx
): WorkingPart[] {
  const bodyText = sub.transformed.lines.join('\n').trim()
  if (bodyText === '') return []

  const headings = [block.h1, block.h2, sub.h3].filter((s) => s.length > 0)
  const sectionAnchor = [block.h2, sub.h3].filter((s) => s.length > 0).join(' > ')
  const base = textBase(breadcrumbOf(ctx.path, headings))

  if (base + bodyText.length <= MAX_TEXT_LENGTH) {
    return [{ headings, sectionAnchor, body: bodyText, anchor: null, hardCut: false }]
  }

  return packAtoms(atomsOf(sub.transformed), headings, sectionAnchor, ctx)
}

/**
 * 切片入口：MD 文本进、切片出。同输入同输出；不读时钟 / 环境变量 / 文件系统。
 */
export function segmentDocument(input: SegmentInput): SegmentReport {
  const ctx: Ctx = { path: input.path, warnings: [] }
  const lines = input.content.replace(/\r\n?/g, '\n').split('\n')

  const working: WorkingPart[] = []
  for (const block of splitTopLevel(lines)) {
    working.push(...processBlock(block, ctx))
  }

  const totals = new Map<string, number>()
  for (const p of working) {
    totals.set(p.sectionAnchor, (totals.get(p.sectionAnchor) ?? 0) + 1)
  }

  const seen = new Map<string, number>()
  const segments: Segment[] = []
  const hardCuts: HardCut[] = []
  let maxTextLength = 0

  for (const p of working) {
    const n = (seen.get(p.sectionAnchor) ?? 0) + 1
    seen.set(p.sectionAnchor, n)

    const breadcrumb = breadcrumbOf(input.path, p.headings)
    let text = renderText(breadcrumb, p.anchor, p.body)
    // 不变式保险丝：面包屑极端超长时逐级退让，保证 text ≤ 450 恒成立
    if (text.length > MAX_TEXT_LENGTH) text = renderText('', p.anchor, p.body)
    if (text.length > MAX_TEXT_LENGTH) text = p.body

    maxTextLength = Math.max(maxTextLength, text.length)
    segments.push({
      path: input.path,
      sectionAnchor: p.sectionAnchor,
      breadcrumb,
      body: p.body,
      text,
      partIndex: n,
      partTotal: totals.get(p.sectionAnchor) ?? 1,
      hardCut: p.hardCut,
    })
    if (p.hardCut) hardCuts.push({ path: input.path, sectionAnchor: p.sectionAnchor, partIndex: n })
  }

  return { segments, hardCuts, maxTextLength, warnings: ctx.warnings }
}
