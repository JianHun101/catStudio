import { marked } from 'marked'
import DOMPurify from 'dompurify'

/** Configure marked for safe, chat-friendly rendering */
marked.setOptions({
  breaks: true,       // GFM line breaks (single \n → <br>)
  gfm: true,          // GitHub Flavored Markdown
})

/**
 * Render a raw markdown string to safe HTML.
 * The output is sanitized via DOMPurify to prevent XSS.
 */
export function renderMarkdown(raw: string): string {
  // Use the synchronous parse which returns a string in marked v5+
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
    ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'class'],
  })
}
