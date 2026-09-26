/**
 * `extractCitationMarkers` 单测（R14b 验收 4）。
 *
 * 纯函数：无 DB、无 mock——判据面（哪些 `[n]` 算角标、哪些算代码字面量）就是被测量本身。
 */
import { describe, it, expect } from 'vitest'
import { extractCitationMarkers } from './citationMarkers.js'

describe('extractCitationMarkers（R14b 角标解析）', () => {
  it('验收 4a · 混标：3 节下 `[1][7]` ⇒ markers=[1]（越界号不进）', () => {
    expect(extractCitationMarkers('见 [1]，另见 [7]。', 3)).toEqual({
      markers: [1],
      markersInCode: [],
    })
  })

  it('验收 4b · 仅越界：`[7]` ⇒ 两列皆空（不报错、不做最近邻猜测）', () => {
    expect(extractCitationMarkers('只有 [7] 这一个号。', 3)).toEqual({
      markers: [],
      markersInCode: [],
    })
    // `[0]` 同属越界（号域从 1 起）
    expect(extractCitationMarkers('[0] 与 [-1] 都不是号', 3).markers).toEqual([])
  })

  it('验收 4c · 仅代码内：围栏块与内联码各一例 ⇒ markers 空、markersInCode 有值', () => {
    const fenced = '示例：\n```js\nconst a = arr[2]\n```\n'
    expect(extractCitationMarkers(fenced, 3)).toEqual({ markers: [], markersInCode: [2] })

    const inline = '列类型是 `float[512]`，不是引用。'
    expect(extractCitationMarkers(inline, 3)).toEqual({ markers: [], markersInCode: [512] })
  })

  it('验收 4d · 空文本 ⇒ 两列皆空', () => {
    expect(extractCitationMarkers('', 3)).toEqual({ markers: [], markersInCode: [] })
  })

  it('验收 4e · sectionCount=0：散文里任何号都越界 ⇒ markers 空', () => {
    expect(extractCitationMarkers('见 [1] 与 [2]。', 0)).toEqual({ markers: [], markersInCode: [] })
    // 代码列不受号域限制（诊断列，见模块头注）
    expect(extractCitationMarkers('见 `arr[1]`。', 0).markersInCode).toEqual([1])
  })

  it('散文与代码并存 ⇒ 各归各列（代码内的号不会被当成引用）', () => {
    const text = '采纳 [2]。举例如下：\n```\nlet x = a[1]\n```\n另见 [1]。'
    expect(extractCitationMarkers(text, 2)).toEqual({ markers: [1, 2], markersInCode: [1] })
  })

  it('去重 + 升序：重复号与乱序号都归一', () => {
    expect(extractCitationMarkers('[3] [1] [3] [2]', 3).markers).toEqual([1, 2, 3])
  })

  it('行内链接 / 引用式链接 / 链接定义里的号不算角标（markdown 语法，不是引用）', () => {
    // 三条都是 markdown 链接语法的一部分；前端若把 `[1]` 消费成上标，链接会当场被拆散
    const text = '[1](https://example.com) 与 [2][ref] 与\n\n[3]: https://example.com\n'
    expect(extractCitationMarkers(text, 3)).toEqual({ markers: [], markersInCode: [] })
  })

  it('围栏定界符不会被误判成内联码（先算围栏、再算内联，重叠即丢）', () => {
    // 若不排除重叠加尔，``` 的前两个反引号会配成一个空 span，把后面的正文吞进代码区
    const text = '```\n见 [1]\n```\n\n正文里的 [2] 在围栏外。'
    expect(extractCitationMarkers(text, 3)).toEqual({ markers: [2], markersInCode: [1] })
  })

  it('多位数号按数值比较（`[10]` 在 3 节下越界，在 10 节下合法）', () => {
    expect(extractCitationMarkers('见 [10]。', 3).markers).toEqual([])
    expect(extractCitationMarkers('见 [10]。', 10).markers).toEqual([10])
  })
})
