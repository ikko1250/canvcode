// 旧実装（recursive-infinite-canvas）の markdownRenderer.ts を流用している（MAI-3）。
// marked で HTML にし、KaTeX で数式を描き、DOMPurify で無害化する（MAI-9）。

import DOMPurify from 'dompurify'
import { Marked, type Tokens } from 'marked'
import katex from 'katex'
import { matchBlockMath, matchInlineMath } from './math.ts'

export interface MarkdownRenderOptions {
  maxImages?: number
  maxBlocks?: number
}

export interface MarkdownRenderResult {
  html: string
  truncated: boolean
}

const allowedTags = [
  'a',
  'abbr',
  'b',
  'blockquote',
  'br',
  'caption',
  'code',
  'col',
  'colgroup',
  'del',
  'details',
  'div',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'input',
  'ins',
  'kbd',
  'li',
  'mark',
  'ol',
  'p',
  'pre',
  'q',
  's',
  'small',
  'span',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
] as const

const allowedAttributes = [
  'align',
  'alt',
  'checked',
  'class',
  'colspan',
  'disabled',
  'height',
  'href',
  'rel',
  'rowspan',
  'src',
  'target',
  'title',
  'type',
  'width',
] as const

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function isSafeUrl(value: string, allowImageData = false): boolean {
  const trimmed = value.trim()
  if (/^(https?:\/\/|mailto:)/i.test(trimmed)) return true
  return allowImageData && /^data:image\//i.test(trimmed)
}

function renderMath(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, {
      throwOnError: false,
      displayMode,
      output: 'html',
      strict: 'ignore',
    })
  } catch {
    return `<code class="markdown-math-error">${escapeHtml(tex)}</code>`
  }
}

function mathExtension() {
  return {
    extensions: [
      {
        name: 'math-block',
        level: 'block' as const,
        start(src: string) {
          const match = src.match(/(?:\$\$|\\\[)/m)
          return match?.index
        },
        tokenizer(src: string) {
          const match = matchBlockMath(src)
          if (!match) {
            const opener = src.startsWith('$$') || src.startsWith('\\[')
            if (!opener) return undefined
            const lineEnd = src.indexOf('\n')
            const raw = lineEnd < 0 ? src : src.slice(0, lineEnd)
            return {
              type: 'math-block',
              raw,
              text: raw,
              unclosed: true,
            }
          }
          return {
            type: 'math-block',
            raw: match.raw,
            text: match.tex,
          }
        },
        renderer(token: Tokens.Generic) {
          if (token.unclosed) {
            return `<div class="markdown-math-unclosed">${escapeHtml(String(token.text ?? ''))}</div>`
          }
          return `<div class="markdown-math-block">${renderMath(String(token.text ?? ''), true)}</div>`
        },
      },
      {
        name: 'math-inline',
        level: 'inline' as const,
        start(src: string) {
          const match = src.match(/\$|\\\(/)
          return match?.index
        },
        tokenizer(src: string) {
          const match = matchInlineMath(src)
          if (!match) {
            if (!src.startsWith('\\(')) return undefined
            const lineEnd = src.indexOf('\n')
            const raw = lineEnd < 0 ? src : src.slice(0, lineEnd)
            return {
              type: 'math-inline',
              raw,
              text: raw,
              unclosed: true,
            }
          }
          return {
            type: 'math-inline',
            raw: match.raw,
            text: match.tex,
          }
        },
        renderer(token: Tokens.Generic) {
          if (token.unclosed) {
            return `<span class="markdown-math-unclosed">${escapeHtml(String(token.text ?? ''))}</span>`
          }
          return `<span class="markdown-math-inline">${renderMath(String(token.text ?? ''), false)}</span>`
        },
      },
    ],
  }
}

function sanitizeHtml(html: string, options: { allowKaTeXStyles?: boolean } = {}): string {
  if (typeof window === 'undefined') return html

  const purifier = DOMPurify(window)
  if (options.allowKaTeXStyles) {
    purifier.addHook('uponSanitizeAttribute', (node, data) => {
      if (data.attrName !== 'style') return
      const element = node as Element
      const isInsideKaTeX =
        element.classList?.contains('katex') === true || element.closest?.('.katex') !== null
      if (!isInsideKaTeX) data.keepAttr = false
    })
  }

  try {
    return purifier.sanitize(html, {
      ALLOWED_TAGS: [...allowedTags],
      ALLOWED_ATTR: options.allowKaTeXStyles
        ? [...allowedAttributes, 'style']
        : [...allowedAttributes],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
    })
  } finally {
    purifier.removeAllHooks()
  }
}

export function renderMarkdown(
  source: string,
  options: MarkdownRenderOptions = {},
): MarkdownRenderResult {
  let renderedImages = 0
  const maxImages = options.maxImages ?? Number.POSITIVE_INFINITY
  const marked = new Marked({ gfm: true, breaks: false })

  marked.use({
    ...mathExtension(),
    renderer: {
      link({ href, title, tokens }: Tokens.Link) {
        if (!isSafeUrl(href)) return this.parser.parseInline(tokens)
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
        return `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer"${titleAttr}>${this.parser.parseInline(tokens)}</a>`
      },
      html({ text }: Tokens.HTML | Tokens.Tag) {
        // Remove inline styles from user-authored HTML before the final pass
        // selectively preserves KaTeX's generated layout styles.
        return sanitizeHtml(text)
      },
      image({ href, title, text }: Tokens.Image) {
        if (!isSafeUrl(href, true) || renderedImages >= maxImages) return escapeHtml(text)
        renderedImages += 1
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : ''
        return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}" loading="lazy" decoding="async"${titleAttr}>`
      },
    },
  })

  const tokens = marked.lexer(source)
  const maxBlocks = options.maxBlocks ?? Number.POSITIVE_INFINITY
  let blockCount = 0
  let cutIndex = tokens.length
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].type === 'space') continue
    blockCount += 1
    if (blockCount > maxBlocks) {
      cutIndex = index
      break
    }
  }

  const html = marked.parser(tokens.slice(0, cutIndex))
  return {
    html: sanitizeHtml(html, { allowKaTeXStyles: true }),
    truncated: cutIndex < tokens.length,
  }
}

export function renderMarkdownToSafeHtml(
  source: string,
  options: MarkdownRenderOptions = {},
): string {
  return renderMarkdown(source, options).html
}

export function containsHtmlTag(source: string): boolean {
  return /<\/?[A-Za-z][^>]*>/.test(source)
}
