import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import createDOMPurify from 'dompurify'

/**
 * Tests for renderMarkdown's DOMPurify config.
 *
 * We test the config directly rather than importing renderMarkdown,
 * since DOMPurify's ESM build needs DOM globals that don't play
 * nicely with vitest's module hoisting. The config values are kept
 * in sync with markdown.ts manually — this is a config contract test.
 */

const ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'br', 'hr',
  'strong', 'em', 'del', 's',
  'a',
  'ul', 'ol', 'li',
  'dl', 'dt', 'dd',
  'pre', 'code',
  'blockquote',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'sup', 'sub',
  'abbr',
  'span', 'div',
]

const ALLOWED_ATTR = ['href', 'title', 'target', 'rel', 'class', 'align']

function makePurifier() {
  const window = new JSDOM('').window as unknown as Window
  return createDOMPurify(window)
}

describe('renderMarkdown DOMPurify config', () => {
  describe('GFM table alignment (align attr)', () => {
    it('preserves align="center" on th/td elements', () => {
      const purify = makePurifier()
      const input = '<table><thead><tr><th align="center">Name</th></tr></thead><tbody><tr><td align="right">100</td></tr></tbody></table>'
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
      const output = purify.sanitize('<script>alert("xss")</script>', { ALLOWED_TAGS, ALLOWED_ATTR })
      expect(output).not.toContain('<script>')
      expect(output).not.toContain('alert')
    })

    it('strips onclick handlers', () => {
      const output = purify.sanitize('<div onclick="alert(1)">click</div>', { ALLOWED_TAGS, ALLOWED_ATTR })
      expect(output).not.toContain('onclick')
    })

    it('preserves safe attributes (href, title)', () => {
      const output = purify.sanitize('<a href="https://example.com" title="link">text</a>', { ALLOWED_TAGS, ALLOWED_ATTR })
      expect(output).toContain('href="https://example.com"')
      expect(output).toContain('title="link"')
    })

    it('strips style attribute', () => {
      const output = purify.sanitize('<span style="color:red">text</span>', { ALLOWED_TAGS, ALLOWED_ATTR })
      expect(output).not.toContain('style=')
    })

    it('allows dl/dt/dd definition lists', () => {
      const output = purify.sanitize('<dl><dt>Term</dt><dd>Definition</dd></dl>', { ALLOWED_TAGS, ALLOWED_ATTR })
      expect(output).toContain('<dt>Term</dt>')
      expect(output).toContain('<dd>Definition</dd>')
    })

    it('allows abbr tags', () => {
      const output = purify.sanitize('<abbr title="HTML">HTML</abbr>', { ALLOWED_TAGS, ALLOWED_ATTR })
      expect(output).toContain('<abbr')
      expect(output).toContain('HTML')
    })

    it('allows target and rel on links', () => {
      const output = purify.sanitize('<a href="/" target="_blank" rel="noopener">link</a>', { ALLOWED_TAGS, ALLOWED_ATTR })
      expect(output).toContain('target="_blank"')
      expect(output).toContain('rel="noopener"')
    })
  })
})
