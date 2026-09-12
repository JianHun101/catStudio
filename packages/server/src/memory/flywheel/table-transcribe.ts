/**
 * 表格转写 — 索引侧把 markdown 表格转成「列名：值」句子（map Decisions 27 / 28 一）。
 *
 * 纯字符串变换：不读文件系统、不读环境变量、不读时钟、不引模型、不引网络。MD 原表
 * **一字不动**——转写只发生在索引副本里（Decisions 1：MD 是真相源，索引是可重建投影）；
 * 叠加「小块检索、整节返回」（Decisions 14 安全网），读者拿到的永远是原表格。
 *
 * 五条规则（Decisions 27）：
 *   ① 丢弃 `|---|` 分隔行（分隔行不是数据）
 *   ② 空单元格 ⇒ 该项**整条不输出**（不留悬空的 `列名：`）
 *   ③ 转义还原：单元格内 `\|` → `|`；`<br>` / 真换行 → 空格
 *   ④ 每个数据行输出一行 `列名1：值1；列名2：值2；…`，列名取自**表头同列**
 *   ⑤ **永不输出标题行**——标题链由面包屑统一承担（Decisions 21 四），本函数不造 `#`
 *
 * 触发面 = **全表无条件转写**（Decisions 28 一）：长度只决定打包、不决定形态，索引侧
 * 此后不存在 markdown 表格形态。
 *
 * 边界（实施期补钉）：
 *   - 单元格数 > 表头列数 ⇒ **多出的值丢弃并计一次告警**（不得静默错位）
 *   - 非表格输入（无分隔行）⇒ **原样返回该块的非空行**，不 throw——转写是回退链 L3-a 的
 *     一级，判错形态会把上级逻辑拖成异常路径
 *   - 表头单元格为空 ⇒ 该列无列名，`列名：值` 拼不出来，整列跳过（同样是退化输入，
 *     不产生悬空 `：值`）
 */

/** 表格转写的告警（结构化返回，不落日志——本模块是纯函数，不产生 I/O 副作用） */
export interface TranscribeWarning {
  kind: 'extra-cells'
  /** 数据行在传入块内的行号（1-based，含表头行与分隔行） */
  row: number
  headerColumns: number
  actualColumns: number
}

export interface TranscribeResult {
  lines: string[]
  warnings: TranscribeWarning[]
}

export interface TranscribeOptions {
  /**
   * 非空时作为**每一输出行**的前缀，实现形态为 `【<prefix>】`。
   * 用途：同一节内多表时产生可区分的行（Decisions 27 规则 5）。
   */
  prefix?: string
}

/** 分隔行的单个单元格：`:?-+:?`（对齐标记） */
const SEPARATOR_CELL = /^:?-+:?$/

/**
 * 拆分一行表格为单元格（保留原始片段，由调用方 trim）。
 * 按**未转义**的 `|` 切；行首行尾的外框竖线产生的空壳剥掉。
 */
function splitRow(line: string): string[] {
  const cells = line.split(/(?<!\\)\|/)
  if (cells.length > 1 && cells[0].trim() === '') cells.shift()
  if (cells.length > 1 && cells[cells.length - 1].trim() === '') cells.pop()
  return cells
}

/**
 * 分隔行判据：含 `|`，且每个单元格都是 `:?-+:?` 形态（纯对齐符号，无正文）。
 * 单靠形状会误判 `- | -` 这类行，故调用方还要求**表头行也含 `|`**。
 */
export function isTableSeparatorRow(line: string): boolean {
  if (!line.includes('|')) return false
  const cells = splitRow(line)
  if (cells.length === 0) return false
  return cells.every((c) => SEPARATOR_CELL.test(c.replace(/\s+/g, '')))
}

/** 规则 ③：转义还原 + 单元格内换行（`<br>` / 真换行）压成空格；空白归一化 */
function normalizeCell(raw: string): string {
  return raw
    .trim()
    .replace(/\\\|/g, '|') // 规则 ③：`\|` → `|`
    .replace(/<br\s*\/?>/gi, ' ') // 规则 ③：`<br>` / `<br/>` / `<br />` → 空格
    .replace(/\r?\n/g, ' ') // 规则 ③：真换行 → 空格
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/**
 * 转写一个完整 markdown 表格块为「列名：值」句子数组（每数据行一条）。
 * 返回带告警的详细形态——`transcribeTableBlock` 是它的薄壳。
 */
export function transcribeTableBlockDetailed(
  block: string,
  opts?: TranscribeOptions
): TranscribeResult {
  const lines = block.replace(/\r\n?/g, '\n').split('\n')
  const warnings: TranscribeWarning[] = []

  // 定位分隔行：首个「自身是分隔行、且上一行含 `|`」的行（上一行即表头行）
  let sepIdx = -1
  for (let i = 1; i < lines.length; i++) {
    if (isTableSeparatorRow(lines[i]) && lines[i - 1].includes('|')) {
      sepIdx = i
      break
    }
  }

  // 非表格输入 ⇒ 原样返回非空行（不 throw）
  if (sepIdx === -1) {
    return { lines: lines.filter((l) => l.trim() !== ''), warnings }
  }

  const header = splitRow(lines[sepIdx - 1]).map(normalizeCell)
  const prefix = opts?.prefix && opts.prefix.length > 0 ? opts.prefix : ''

  const out: string[] = []
  for (let i = sepIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue
    const cells = (lines[i].includes('|') ? splitRow(lines[i]) : [lines[i]]).map(normalizeCell)

    // 边界：多出的值丢弃并计一次告警（不得静默错位）
    if (cells.length > header.length) {
      warnings.push({
        kind: 'extra-cells',
        row: i + 1,
        headerColumns: header.length,
        actualColumns: cells.length,
      })
    }

    // 规则 ④：列名取自表头同列；规则 ②：空单元格整项不输出
    const items: string[] = []
    for (let c = 0; c < header.length; c++) {
      const name = header[c]
      if (name === '') continue // 表头无名 ⇒ 拼不出 `列名：值`，整列跳过
      const value = cells[c] ?? ''
      if (value === '') continue // 规则 ②：空单元格 ⇒ 该项整条不输出
      items.push(`${name}：${value}`)
    }
    if (items.length === 0) continue // 整行皆空 ⇒ 无内容可索引

    // 规则 ⑤：只出数据句，永不输出标题行
    out.push(prefix ? `【${prefix}】${items.join('；')}` : items.join('；'))
  }

  return { lines: out, warnings }
}

/**
 * 转写一个完整 markdown 表格块为「列名：值」句子数组（每数据行一条）。
 * 非表格输入原样返回非空行；告警走 `transcribeTableBlockDetailed`。
 */
export function transcribeTableBlock(block: string, opts?: TranscribeOptions): string[] {
  return transcribeTableBlockDetailed(block, opts).lines
}
