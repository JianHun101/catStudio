/**
 * 回复正文里的角标引用解析（R14b）——**纯函数，无 I/O、不落库**。
 *
 * 猫被指示语要求「采纳了某条历史结论就在该处标注其编号」，本模块把回复正文里的
 * `[n]` 拆成两列，供读口（`routes/memory.ts` 的 `memory-refs`）映射到注入节。
 *
 * ## 判据按**机制**定义，不按模式定义（R14a 同款口径）
 *
 * 判据是「**代码字面量不是引用**」——猫举代码例（`arr[1]`）与引用注入原文里的
 * `float[512]`（sqlite-vec 列类型）是**同一个机制**、不是两件事。机制有两形态：
 * **围栏块**（``` … ```）与**内联码**（`` `…` ``）。两形态内的号一律进
 * `markersInCode`，**成列可见、不许静默剔除**——哪天猫把真引用写进反引号，
 * 要能被看见（静默剔除会让「判据面把真值扫掉」变成假绿）。
 *
 * **缩进代码块（行首四空格 / tab）不处理**：R14a 的 90 份真实回复全量扫描里
 * 围栏 9 份 / 内联码 90 份 / **缩进 0 份**；前端按 AST 渲染时该形态亦天然豁免。
 * 换语料即失效——见到第三种形态时同批纳入，别假设只有这两种。
 *
 * ## 两处口径（**与 R14a 离线探针的判据面有意不同**，别照抄探针读数反推这里）
 *
 * 1. **不做复述剔除**（票 §四 边界）：甲版指示语自身含字面量 `[1]`，猫转述指示语
 *    时会产生 `[1]`。探针的 `instructionEchoRanges` 服务的是**离线聚合读数**
 *    （分母口径要干净），而生产面是**逐条 hover 展示**——误标的代价是一张错的卡片。
 *    两者精度需求不同，故本模块不引入 echo 判据。
 * 2. **排除 markdown 链接/引用定义**：`[1](https://…)`（编号做链接文本）与
 *    `[1]: url`（引用式链接定义）里的 `[1]` **不是角标**。前端把 `[n]` 渲染成
 *    上标时会先于链接分词器消费掉它，不排除就会把链接拆散——故两侧用**同一条**
 *    排除式（`LINK_LIKE_SUFFIX`），判据面保持一致。
 *
 * ## 越界号（`> sectionCount` 或 `< 1`）
 *
 * **散文里的越界号两列都不进、不报错、不做最近邻猜测**（R14 §六-2 既定口径；
 * R14a 实测越界号真值 = 0，此条是**纯防御**——防映射边界错，不是防猫）。
 * 代码字面量内的号不受此限（照进 `markersInCode`）：那一列是**诊断列**，
 * 不参与前端渲染，范围过滤只会把「映射边界错了」这一种故障也一起滤掉。
 */

/** 一次解析的结果，两列都**去重升序**（消费方不必再排） */
export interface CitationMarkerScan {
  /** 散文中、落在 `1..sectionCount` 的号——前端据此渲染角标 */
  markers: number[]
  /** 代码字面量（围栏 / 内联码）内的号——**诊断列，不渲染** */
  markersInCode: number[]
}

/**
 * 角标模式：`[` + 数字 + `]`，且**后面不是** `(`（行内链接）、`[`（引用式链接）、
 * `:`（链接定义）——三种后缀都会让 `[n]` 成为 markdown 链接语法的一部分。
 */
const CITATION_PATTERN = /\[(\d+)\](?![([:])/g

/** 围栏块（``` … ```，非贪婪）。与探针 `fenceRanges` 同式 */
const FENCE_PATTERN = /```[\s\S]*?```/g

/**
 * 内联码（`` `…` ``，不跨行）。与探针 `inlineCodeRanges` 同式。
 *
 * ⚠️ **必须先算围栏、再算内联**（承重）：本式会匹配到 ``` 的**前两个反引号**
 * （空 span），不排除就会把围栏定界符当内联码。此处用**重叠即丢**实现该顺序。
 */
const INLINE_CODE_PATTERN = /`[^`\n]*`/g

/** 收集全文匹配的 `[起, 止]` 闭区间 */
function collectRanges(text: string, pattern: RegExp): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  for (const m of text.matchAll(pattern)) {
    const start = m.index
    ranges.push([start, start + m[0].length - 1])
  }
  return ranges
}

/** 内联码区间：**剔除与围栏重叠的伪匹配**（见 `INLINE_CODE_PATTERN` 的 ⚠️） */
function inlineCodeRanges(text: string, fences: Array<[number, number]>): Array<[number, number]> {
  return collectRanges(text, INLINE_CODE_PATTERN).filter(
    ([s, e]) => !fences.some(([fs, fe]) => s <= fe && e >= fs)
  )
}

function inRanges(index: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([s, e]) => index >= s && index <= e)
}

/**
 * 抽回复正文里的角标号，按「散文 / 代码字面量」分两列。
 *
 * @param replyText 回复正文（`messages.content`）——空串返回两列皆空
 * @param sectionCount 本条回复实际注入的**节数**（= `1..sectionCount` 是合法号域）。
 *   口径来源：读口按「该消息 `injected = 1` 的去重节数」取，与 `renderSections`
 *   渲染出的编号 1..n **同源**（编号的唯一真相源是 `renderOrder`，读口流水同样取它）。
 */
export function extractCitationMarkers(
  replyText: string,
  sectionCount: number
): CitationMarkerScan {
  const markers = new Set<number>()
  const markersInCode = new Set<number>()
  if (!replyText) return { markers: [], markersInCode: [] }

  const fences = collectRanges(replyText, FENCE_PATTERN)
  const inlines = inlineCodeRanges(replyText, fences)

  for (const m of replyText.matchAll(CITATION_PATTERN)) {
    const value = Number(m[1])
    if (inRanges(m.index, fences) || inRanges(m.index, inlines)) {
      markersInCode.add(value)
      continue
    }
    if (value >= 1 && value <= sectionCount) markers.add(value)
  }

  const ascending = (a: number, b: number): number => a - b
  return {
    markers: [...markers].sort(ascending),
    markersInCode: [...markersInCode].sort(ascending),
  }
}
