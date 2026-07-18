import { marked } from 'marked'
import hljs from 'highlight.js'
import DOMPurify from 'dompurify'

/** Configure marked for safe, chat-friendly rendering */
marked.setOptions({
  breaks: true,       // GFM line breaks (single \n → <br>)
  gfm: true,          // GitHub Flavored Markdown
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
 */
export function renderMarkdown(raw: string): string {
  const html = marked.parse(raw, { async: false }) as string
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
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
    ],
    ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'class', 'align'],
  })
}
