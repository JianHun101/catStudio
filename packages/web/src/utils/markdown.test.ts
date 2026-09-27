import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'
import type { WindowLike } from 'dompurify'
import { renderMarkdown } from './markdown'

/**
 * Tests for renderMarkdown's DOMPurify config.
 *
 * We test the config directly rather than importing renderMarkdown,
 * since DOMPurify's ESM build needs DOM globals that don't play
 * nicely with vitest's module hoisting. The config values are kept
 * in sync with markdown.ts manually — this is a config contract test.
 */

const ALLOWED_TAGS = [
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'br',
  'hr',
  'strong',
  'em',
  'del',
  's',
  'a',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'pre',
  'code',
  'blockquote',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'sup',
  'sub',
  'abbr',
  'span',
  'div',
]

const ALLOWED_ATTR = ['href', 'title', 'target', 'rel', 'class', 'align']

function makePurifier() {
  const window = new JSDOM('').window as unknown as WindowLike
  return createDOMPurify(window)
}

describe('renderMarkdown DOMPurify config', () => {
  describe('GFM table alignment (align attr)', () => {
    it('preserves align="center" on th/td elements', () => {
      const purify = makePurifier()
      const input =
        '<table><thead><tr><th align="center">Name</th></tr></thead><tbody><tr><td align="right">100</td></tr></tbody></table>'
      const output = purify.sanitize(input, { ALLOWED_TAGS, ALLOWED_ATTR })

      expect(output).toContain('align="center"')
      expect(output).toContain('align="right"')
    })

    it('strips align from non-allowed attrs if not in list', () => {
      const purify = makePurifier()
      const withoutAlign = ['href', 'title', 'target', 'rel', 'class']
      const input = '<table><tr><td align="right">data</td></tr></table>'
      const output = purify.sanitize(input, { ALLOWED_TAGS, ALLOWED_ATTR: withoutAlign })

      expect(output).not.toContain('align=')
    })

    it('does not retain align on disallowed tags', () => {
      const purify = makePurifier()
      // 'nav' is not in ALLOWED_TAGS
      const input = '<nav align="left">menu</nav>'
      const output = purify.sanitize(input, { ALLOWED_TAGS, ALLOWED_ATTR })

      // The tag itself gets stripped, so align is gone too
      expect(output).not.toContain('align=')
    })
  })

  describe('safety', () => {
    const purify = makePurifier()

    it('strips script tags', () => {
      const output = purify.sanitize('<script>alert("xss")</script>', {
        ALLOWED_TAGS,
        ALLOWED_ATTR,
      })
      expect(output).not.toContain('<script>')
      expect(output).not.toContain('alert')
    })

    it('strips onclick handlers', () => {
      const output = purify.sanitize('<div onclick="alert(1)">click</div>', {
        ALLOWED_TAGS,
        ALLOWED_ATTR,
      })
      expect(output).not.toContain('onclick')
    })

    it('preserves safe attributes (href, title)', () => {
      const output = purify.sanitize('<a href="https://example.com" title="link">text</a>', {
        ALLOWED_TAGS,
        ALLOWED_ATTR,
      })
      expect(output).toContain('href="https://example.com"')
      expect(output).toContain('title="link"')
    })

    it('strips style attribute', () => {
      const output = purify.sanitize('<span style="color:red">text</span>', {
        ALLOWED_TAGS,
        ALLOWED_ATTR,
      })
      expect(output).not.toContain('style=')
    })

    it('allows dl/dt/dd definition lists', () => {
      const output = purify.sanitize('<dl><dt>Term</dt><dd>Definition</dd></dl>', {
        ALLOWED_TAGS,
        ALLOWED_ATTR,
      })
      expect(output).toContain('<dt>Term</dt>')
      expect(output).toContain('<dd>Definition</dd>')
    })

    it('allows abbr tags', () => {
      const output = purify.sanitize('<abbr title="HTML">HTML</abbr>', {
        ALLOWED_TAGS,
        ALLOWED_ATTR,
      })
      expect(output).toContain('<abbr')
      expect(output).toContain('HTML')
    })

    it('allows target and rel on links', () => {
      const output = purify.sanitize('<a href="/" target="_blank" rel="noopener">link</a>', {
        ALLOWED_TAGS,
        ALLOWED_ATTR,
      })
      expect(output).toContain('target="_blank"')
      expect(output).toContain('rel="noopener"')
    })
  })
})

// ─── R14b：角标引用（`renderMarkdown` 的 markers 参数）─────────────
//
// 本组**真跑 `renderMarkdown`**（上面那组只测配置常量）：角标是「inline 扩展 →
// DOMPurify 放行 → 代码豁免」三者合起来的结果，只对配置清单测不出这条链。
// 组件侧的 hover 卡片在 `components/MessageItem.test.ts`。
describe('renderMarkdown 角标引用（R14b 验收 6）', () => {
  it('markers 内的 [n] 渲染为角标元素（sup + class + data-marker）', () => {
    const html = renderMarkdown('我采纳了 [1] 这条结论。', [1])
    expect(html).toContain('<sup class="mem-citation" data-marker="1">[1]</sup>')
    // 字面方括号仍在角标文本里（用户读到的还是 `[1]`，只是变成上标）
    expect(html).toContain('[1]')
  })

  it('markers 外的 [n] 保持字面文本（不包角标元素）', () => {
    // 越界号：注入了 1 节，回复里写了 [7]
    const html = renderMarkdown('另见 [7]。', [1])
    expect(html).not.toContain('<sup')
    expect(html).toContain('[7]')
  })

  it('不传 markers（思考块 / 折叠块 / 流式中间段的调用形态）⇒ 一个角标都不渲染', () => {
    const html = renderMarkdown('见 [1] 与 [2]。')
    expect(html).not.toContain('<sup')
    expect(html).toContain('[1]')
    expect(html).toContain('[2]')
  })

  it('空 markers 数组与不传等价', () => {
    expect(renderMarkdown('见 [1]。', [])).not.toContain('<sup')
  })

  it('代码豁免按 AST 落：围栏块内的 [n] 保持字面（inline 扩展不被调用）', () => {
    const html = renderMarkdown('示例：\n\n```js\nconst a = arr[1]\n```\n', [1])
    expect(html).not.toContain('<sup')
    // 断言落在 **AST 产物**上（`<pre><code>`），不去匹配代码文本——
    // 代码块走 highlight.js，`arr[1]` 会被拆成 `arr[<span class="hljs-number">1</span>]`
    expect(html).toContain('<pre><code')
    expect(html).toContain('hljs-number')
  })

  it('代码豁免按 AST 落：内联码内的 [n] 保持字面', () => {
    // 猫引用注入原文里的 `float[512]` 是同一机制的另一种面孔（R14a S2 实测）
    const html = renderMarkdown('列类型是 `float[512]`，见 [1]。', [1, 512])
    // 512 在 markers 里也不该被渲染成角标（它在 code token 里，扩展根本没被调用）
    expect(html).not.toContain('data-marker="512"')
    expect(html).toContain('<code>float[512]</code>')
    // 同一句里散文的 [1] 照常成角标（代码豁免不误伤正文）
    expect(html).toContain('data-marker="1"')
  })

  it('行内链接的编号文本不被吃成角标（否则链接会被拆散）', () => {
    const html = renderMarkdown('见 [1](https://example.com)。', [1])
    expect(html).not.toContain('<sup')
    expect(html).toContain('href="https://example.com"')
  })

  // ─── M4：相邻引用被引用式链接排除式误伤（票 §五 验收 2）───────────────
  it('M4 · 相邻引用 [1][2] 两个都渲染成角标（旧式下 [1] 被当引用式链接吞掉）', () => {
    const html = renderMarkdown('注入的 [1][2] 是谁', [1, 2])
    expect(html).toContain('<sup class="mem-citation" data-marker="1">[1]</sup>')
    expect(html).toContain('<sup class="mem-citation" data-marker="2">[2]</sup>')
    // 计数口径：恰好两个，不多不少
    expect(html.match(/<sup class="mem-citation"/g) ?? []).toHaveLength(2)
  })

  it('M4 · 引用式链接 [1][foo] 不吃角标、链接结构不拆散（回归面）', () => {
    const html = renderMarkdown('[1][foo]\n\n[foo]: https://example.com', [1])
    expect(html).not.toContain('<sup')
    expect(html).toContain('href="https://example.com"')
    // 承重点：链接文本仍是 `1` ⇒ `[1]` 被链接分词器消费，没被角标抢走
    expect(html).toMatch(/<a [^>]*>1<\/a>/)
  })

  it('M4 · 空 ref 与链接定义里的号同样不吃（回归面）', () => {
    expect(renderMarkdown('[1][]', [1])).not.toContain('<sup')
    expect(renderMarkdown('[1]: https://example.com', [1])).not.toContain('<sup')
  })

  it('多个号各渲染各的，且 data-marker 原样通过 DOMPurify（hover 取数键）', () => {
    const html = renderMarkdown('[1] 与 [3] 都采纳了。', [1, 2, 3])
    expect(html).toContain('data-marker="1"')
    expect(html).toContain('data-marker="3"')
    // 未采纳的 2 号不出现在正文里 ⇒ 也不该有它的角标
    expect(html).not.toContain('data-marker="2"')
  })
})
