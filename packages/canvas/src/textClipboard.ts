import {
  fontFamilyCss,
  listMarkers,
  listOf,
  listStyleOf,
  normalizeRichText,
  paragraphText,
  withList,
  type TextListStyle,
  type TextParagraph,
  type TextRunFormat,
} from '@canvcode/nodes'
import { decodeBase64, encodeBase64 } from './clipboard.ts'

// 文字の編集中のコピー・貼り付け（MAI-74）。範囲ごとの書式を残すため、アプリ内の形式（段落と run の JSON）も載せる。
// 書式は既定に重ねた実際の値（resolveRichText）で載せ、貼り付け先で、その既定と同じ値を落とす。
// text/html には、ほかのアプリでも色・大きさ・フォント・太字などの装飾（MAI-79）が残るよう style を付けた HTML を載せ、アプリ内の形式も属性に入れておく。
// リストの段落（MAI-78）は、ほかのアプリでもリストになるよう ul / ol と li にする（階層は入れ子。記号の形は list-style-type で、
// CSS で表せない形（1) (1) ①）は 1. にする）。text/plain には記号・番号と、階層ごとに 2 つの空白を付ける

export const TEXT_CLIPBOARD_MIME = 'application/x-canvcode-text+json'
const HTML_ATTRIBUTE = 'data-canvcode-text'

interface TextClipboardPayload {
  kind: 'canvcode/text'
  version: 1
  paragraphs: TextParagraph[]
}

export function textClipboardData(paragraphs: readonly TextParagraph[]): { json: string; html: string; plain: string } {
  const payload: TextClipboardPayload = { kind: 'canvcode/text', version: 1, paragraphs: [...paragraphs] }
  const json = JSON.stringify(payload)
  const markers = listMarkers(paragraphs)
  return {
    json,
    html: `<div ${HTML_ATTRIBUTE}="${encodeBase64(json)}">${htmlBody(paragraphs)}</div>`,
    plain: paragraphs
      .map((paragraph, i) => {
        const list = listOf(paragraph)
        return list ? `${'  '.repeat(list.level)}${markers[i]} ${paragraphText(paragraph)}` : paragraphText(paragraph)
      })
      .join('\n'),
  }
}

const CSS_LIST_STYLES: Record<TextListStyle, string> = {
  disc: 'disc',
  circle: 'circle',
  square: 'square',
  dash: "'– '",
  check: "'✓ '",
  decimal: 'decimal',
  'decimal-paren': 'decimal',
  'paren-decimal': 'decimal',
  'lower-alpha': 'lower-alpha',
  'lower-roman': 'lower-roman',
  circled: 'decimal',
}

// 段落を p に、続いたリストの段落を入れ子の ul / ol にする
function htmlBody(paragraphs: readonly TextParagraph[]): string {
  let html = ''
  // 開いているリスト（階層ごと）と、その中で li を開いているか
  const stack: { tag: 'ul' | 'ol'; li: boolean }[] = []
  const closeTop = () => {
    const top = stack.pop()!
    html += `${top.li ? '</li>' : ''}</${top.tag}>`
  }
  for (const paragraph of paragraphs) {
    const runs = paragraph.runs.map((run) => `<span style="${styleOf(run.format)}">${escapeHtml(run.text)}</span>`).join('')
    const content = paragraphText(paragraph) === '' ? '<br>' : runs
    const list = listOf(paragraph)
    if (!list) {
      while (stack.length > 0) closeTop()
      html += `<p>${content}</p>`
      continue
    }
    const tag = list.type === 'bullet' ? 'ul' : 'ol'
    while (stack.length > list.level + 1) closeTop()
    if (stack.length === list.level + 1 && stack[list.level].tag !== tag) closeTop()
    while (stack.length < list.level + 1) {
      html += `<${tag}>`
      stack.push({ tag, li: false })
    }
    const top = stack[list.level]
    if (top.li) html += '</li>'
    html += `<li style="${escapeHtml(`list-style-type: ${CSS_LIST_STYLES[listStyleOf(list)]}`)}">${content}`
    top.li = true
  }
  while (stack.length > 0) closeTop()
  return html
}

// アプリ内の形式の文字。なければ null（プレーンテキストとして貼る）
export function parseTextClipboard(data: { json?: string; html?: string }): TextParagraph[] | null {
  try {
    if (data.json) return validPayload(JSON.parse(data.json))
    if (data.html) {
      const match = new RegExp(`${HTML_ATTRIBUTE}="([A-Za-z0-9+/=]+)"`).exec(data.html)
      if (match) return validPayload(JSON.parse(decodeBase64(match[1])))
    }
  } catch {
    // 壊れたデータは、アプリ内の形式ではないとみなす
  }
  return null
}

function validPayload(value: unknown): TextParagraph[] | null {
  const p = value as TextClipboardPayload
  if (p?.kind !== 'canvcode/text' || p.version !== 1 || !Array.isArray(p.paragraphs)) return null
  const paragraphs = p.paragraphs.filter((paragraph) => Array.isArray(paragraph?.runs))
  for (const paragraph of paragraphs) paragraph.runs = paragraph.runs.filter((run) => typeof run?.text === 'string')
  // リストの属性は読める値だけを残す（MAI-78）
  const cleaned = paragraphs.map((paragraph) => withList(paragraph, listOf(paragraph)))
  return cleaned.length > 0 ? normalizeRichText(cleaned) : null
}

function styleOf(format: TextRunFormat | undefined): string {
  const parts: string[] = []
  if (format?.color) parts.push(`color: ${format.color}`)
  if (format?.fontSize) parts.push(`font-size: ${format.fontSize}px`)
  if (format?.fontFamily) parts.push(`font-family: ${fontFamilyCss(format.fontFamily)}`)
  // 太字・斜体・下線・取り消し線（MAI-79）。載せる書式は既定に重ねた実際の値なので、false も書く（貼り付け先の既定に左右されないように）
  if (format?.bold !== undefined) parts.push(`font-weight: ${format.bold ? 700 : 400}`)
  if (format?.italic !== undefined) parts.push(`font-style: ${format.italic ? 'italic' : 'normal'}`)
  const lines = [format?.underline ? 'underline' : '', format?.strikethrough ? 'line-through' : ''].filter(Boolean)
  if (lines.length > 0) parts.push(`text-decoration: ${lines.join(' ')}`)
  return escapeHtml(parts.join('; '))
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
