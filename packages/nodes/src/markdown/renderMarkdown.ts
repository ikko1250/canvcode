// 旧実装（recursive-infinite-canvas）の markdownRenderer.ts を流用している（MAI-3）。
// marked で HTML にし、KaTeX で数式を描き、DOMPurify で無害化する（MAI-9）。

import DOMPurify from 'dompurify'
import { Marked, type Token, type Tokens } from 'marked'
import katex from 'katex'
import { matchBlockMath, matchInlineMath } from './math.ts'

export interface MarkdownRenderOptions {
  maxImages?: number
  maxBlocks?: number
  // ブロックごとの先頭の要素に、元の Markdown の行（1 から）を data-line で付ける。
  // 全画面のエディタで、本文とプレビューのスクロールを合わせるのに使う（MAI-44）
  sourceLines?: boolean
}

export const SOURCE_LINE_ATTR = 'data-line'

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

function sanitizeHtml(html: string, options: { allowKaTeXStyles?: boolean; allowSourceLines?: boolean } = {}): string {
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
      ALLOWED_ATTR: [
        ...allowedAttributes,
        ...(options.allowKaTeXStyles ? ['style'] : []),
        ...(options.allowSourceLines ? [SOURCE_LINE_ATTR] : []),
      ],
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

  const kept = tokens.slice(0, cutIndex)
  const html = options.sourceLines ? renderWithSourceLines(marked, kept) : marked.parser(kept)
  return {
    html: sanitizeHtml(html, { allowKaTeXStyles: true, allowSourceLines: options.sourceLines }),
    truncated: cutIndex < tokens.length,
  }
}

// ブロックを一つずつ HTML にして、先頭のタグに data-line（そのブロックが始まる行）を付ける。
// 行は、それより前のトークンの raw に含まれる改行の数で決まる（marked のブロックの raw をつなぐと元の本文に戻る）。
// 続く text トークンは、marked が一つの段落にまとめるので、同じようにまとめて渡す
function renderWithSourceLines(marked: Marked, tokens: Token[]): string {
  let html = ''
  let line = 1
  for (let index = 0; index < tokens.length; ) {
    const token = tokens[index]
    let end = index + 1
    if (token.type === 'text') {
      while (end < tokens.length && tokens[end].type === 'text') end += 1
    }
    const group = tokens.slice(index, end)
    const fragment = marked.parser(group)
    html += token.type === 'space' ? fragment : tagFirstElement(fragment, line)
    for (const t of group) line += countNewlines(t.raw)
    index = end
  }
  return html
}

function countNewlines(text: string): number {
  let count = 0
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) count += 1
  return count
}

// 断片の先頭がタグなら、そこに data-line を差す（先頭が文字なら何もしない）
function tagFirstElement(fragment: string, line: number): string {
  const match = /^\s*<([a-zA-Z][a-zA-Z0-9]*)(?=[\s>/])/.exec(fragment)
  if (!match) return fragment
  const at = match.index + match[0].length
  return `${fragment.slice(0, at)} ${SOURCE_LINE_ATTR}="${line}"${fragment.slice(at)}`
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
