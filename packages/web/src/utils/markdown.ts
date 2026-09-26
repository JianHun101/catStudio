import { marked, type MarkedOptions, type Tokens } from 'marked'
import hljs from 'highlight.js'
import DOMPurify from 'dompurify'

/** Configure marked for safe, chat-friendly rendering */
marked.setOptions({
  breaks: true, // GFM line breaks (single \n → <br>)
  gfm: true, // GitHub Flavored Markdown
})

/**
 * 本模块挂在 marked options 上的**私有键**（R14b）。
 *
 * marked 的 `MarkedOptions` 没有索引签名，故这里显式声明形状、读时窄化一次。
 * 走 options 而**不是模块级可变变量**：`marked.parse` 是同步的，但把「本次渲染的
 * 合法号集」藏进模块状态，会让「谁在渲染什么」在代码上不可见、并发/嵌套渲染时静默串味。
 */
interface CitationRenderOptions {
  /** 本次渲染视为合法角标的号集（缺省/空 ⇒ `[n]` 一律保持字面） */
  citationMarkers?: readonly number[]
}

const EMPTY_MARKERS: readonly number[] = []

/** 从扩展 tokenizer 的 `this.lexer` 上取本次渲染的合法号集（拿不到即空集） */
function citationMarkersFromLexer(lexer: unknown): readonly number[] {
  const options = (lexer as { options?: Record<string, unknown> } | undefined)?.options
  const value = options?.citationMarkers
  return Array.isArray(value) ? (value as readonly number[]) : EMPTY_MARKERS
}

/**
 * 角标 token（R14b）：被指示语要求标注的 `[n]` 渲染成 `<sup>` + `data-marker`。
 *
 * ## 为什么走 marked 的 inline 扩展（= 代码豁免的**实现机制**）
 *
 * 围栏块与内联码在 marked 里是**独立 token 类型**（`code` / `codespan`），
 * 自定义 inline tokenizer **不会被调用**——「代码块 / 内联码里的 `[1]` 不渲染成角标」
 * 因此是 AST 层的天然结果，不是靠正则绕开代码区间的巧合。
 *
 * ## 两个边界
 *
 * · **非本次合法号一律 `return undefined`**：交回默认 tokenizer，`[7]` 越界号与
 *   未注入位置的号原样保持字面文本（`renderMarkdown` 无 markers 时即全字面）。
 * · **`[n](` / `[n][` / `[n]:` 不认**：那是行内链接 / 引用式链接 / 链接定义，
 *   `[1]` 只是链接文本。本条与后端 `citationMarkers.ts` 的 `CITATION_PATTERN`
 *   是**同一条排除式**——两侧判据面必须一致，否则后端说有角标、前端渲染不出来。
 */
marked.use({
  extensions: [
    {
      name: 'citation',
      level: 'inline',
      start(src: string): number {
        return src.indexOf('[')
      },
      tokenizer(
        this: unknown,
        src: string
      ): { type: string; raw: string; marker: number } | undefined {
        const m = /^\[(\d+)\](?![([:])/.exec(src)
        if (!m) return undefined
        const marker = Number(m[1])
        const allowed = citationMarkersFromLexer((this as { lexer?: unknown }).lexer)
        if (!allowed.includes(marker)) return undefined
        return { type: 'citation', raw: m[0], marker }
      },
      // `Tokens.Generic` 带索引签名，故 `token.marker` 是 any——取样在 tokenizer 里已
      // 由正则钉成数字（`/^\[(\d+)\]/`），此处只做字符串插值
      renderer(token: Tokens.Generic): string {
        return `<sup class="mem-citation" data-marker="${token.marker}">[${token.marker}]</sup>`
      },
    },
  ],
})

// Inject syntax highlighting via marked's extension system
marked.use({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }): string {
      try {
        if (lang && hljs.getLanguage(lang)) {
          const result = hljs.highlight(text, { language: lang })
          return `<pre><code class="hljs language-${lang}">${result.value}</code></pre>`
        }
        const result = hljs.highlightAuto(text)
        return `<pre><code class="hljs">${result.value}</code></pre>`
      } catch {
        return `<pre><code>${text}</code></pre>`
      }
    },
  },
})

/**
 * Render a raw markdown string to safe HTML with syntax highlighting.
 * The output is sanitized via DOMPurify to prevent XSS.
 *
 * @param markers 本条回复采纳的角标号（R14b）——**可选**，缺省即「没有角标」：
 *   思考块、折叠块、流式中间段的调用点都不传，正文里的 `[n]` 保持字面。
 *   只有承载 `memory-refs` 数据的正文（`MessageItem` 的 `bodyHtml`）传它。
 */
export function renderMarkdown(raw: string, markers?: readonly number[]): string {
  const options: MarkedOptions & CitationRenderOptions = {
    async: false,
    citationMarkers: markers && markers.length > 0 ? markers : EMPTY_MARKERS,
  }
  const html = marked.parse(raw, options) as string
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
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
    ],
    // ⚠️ `data-marker`（R14b 角标的 hover 取数键）**不在这张表里**，靠的是
    // DOMPurify 的 `ALLOW_DATA_ATTR`（缺省 true）——`data-*` 在 `ALLOWED_ATTR`
    // 之前判，故显式列 ALLOWED_ATTR 不会把它关掉。实测：本配置下
    // `<sup class="mem-citation" data-marker="1">` 原样通过；置
    // `ALLOW_DATA_ATTR: false` 则 `data-marker` 被剥（角标会渲染但 hover 失效）。
    // 契约测试钉在 `markdown.test.ts` 的角标组。
    ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'class', 'align'],
  })
}
