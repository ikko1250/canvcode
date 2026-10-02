import { fontFamilyCss, normalizeRichText, paragraphText, type TextParagraph, type TextRunFormat } from '@canvcode/nodes'
import { decodeBase64, encodeBase64 } from './clipboard.ts'

// 文字の編集中のコピー・貼り付け（MAI-74）。範囲ごとの書式を残すため、アプリ内の形式（段落と run の JSON）も載せる。
// 書式は既定に重ねた実際の値（resolveRichText）で載せ、貼り付け先で、その既定と同じ値を落とす。
// text/html には、ほかのアプリでも色・大きさ・フォントが残るよう style を付けた HTML を載せ、アプリ内の形式も属性に入れておく

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
  const body = paragraphs
    .map((paragraph) => {
      const runs = paragraph.runs.map((run) => `<span style="${styleOf(run.format)}">${escapeHtml(run.text)}</span>`).join('')
      return `<p>${runs || '<br>'}</p>`
    })
    .join('')
  return {
    json,
    html: `<div ${HTML_ATTRIBUTE}="${encodeBase64(json)}">${body}</div>`,
    plain: paragraphs.map(paragraphText).join('\n'),
  }
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
  return paragraphs.length > 0 ? normalizeRichText(paragraphs) : null
}

function styleOf(format: TextRunFormat | undefined): string {
  const parts: string[] = []
  if (format?.color) parts.push(`color: ${format.color}`)
  if (format?.fontSize) parts.push(`font-size: ${format.fontSize}px`)
  if (format?.fontFamily) parts.push(`font-family: ${fontFamilyCss(format.fontFamily)}`)
  return escapeHtml(parts.join('; '))
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
