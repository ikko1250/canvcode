import type { Box, SourceLocator } from '@canvcode/core'
import type { QuoteFigure } from '@canvcode/nodes'

// 引用（MAI-33）：PDF の範囲から文字を取り出す、Markdown の引用の行を付け直す、など。DOM を使わない部分だけをここに置く

// 引用ノートを作る前の、引用の中身
export interface QuoteDraft {
  fileId: string
  locator: SourceLocator
  quote: string
  figure: QuoteFigure | null
}

// ---- PDF ----

// PDF のページの文字の断片（PDF.js の getTextContent の 1 項目）。位置はポイントで、ページの左上が原点
export interface PdfTextItem {
  text: string
  x: number
  // 文字の上端
  y: number
  w: number
  h: number
}

export interface RegionText {
  text: string
  // 範囲の面積のうち、文字が占める割合（0〜1）。小さければ図や表とみなす
  coverage: number
}

// 文字がこれより少ない範囲は、図として切り抜く（1 行をゆったり囲んでも 0.2 ほどはあるので、それより小さく）
const FIGURE_COVERAGE = 0.15
const FIGURE_MIN_CHARS = 4

export function looksLikeFigure(region: RegionText): boolean {
  return region.coverage < FIGURE_COVERAGE || [...region.text.replace(/\s/g, '')].length < FIGURE_MIN_CHARS
}

// 範囲（ポイント）の中の文字を取り出す。範囲に半分以上かかった行の、範囲に入った部分の文字を、
// 上から順に並べる。同じ行の断片はつなぎ、行の間は、英数字どうしなら空白、日本語なら何も入れずにつなぐ。
// 行の間が大きく空いていれば、段落の区切り（改行）にする
export function textInRegion(items: PdfTextItem[], region: Box): RegionText {
  type Piece = { text: string; x: number; right: number; cy: number; h: number }
  const pieces: Piece[] = []
  let covered = 0
  for (const item of items) {
    if (!item.text || item.w <= 0 || item.h <= 0) continue
    const top = Math.max(item.y, region.y)
    const bottom = Math.min(item.y + item.h, region.y + region.h)
    if (bottom - top < item.h * 0.5) continue
    const left = Math.max(item.x, region.x)
    const right = Math.min(item.x + item.w, region.x + region.w)
    if (right <= left) continue
    const chars = [...item.text]
    // 断片の中で文字の幅は等しいとみなして、範囲に入った文字を選ぶ
    const from = Math.max(0, Math.round(((left - item.x) / item.w) * chars.length))
    const to = Math.min(chars.length, Math.round(((right - item.x) / item.w) * chars.length))
    const text = chars.slice(from, to).join('')
    if (!text) continue
    pieces.push({ text, x: left, right, cy: item.y + item.h / 2, h: item.h })
    if (text.trim()) covered += (right - left) * (bottom - top)
  }
  pieces.sort((a, b) => a.cy - b.cy || a.x - b.x)
  // 行にまとめる（上下の中心が、文字の高さの半分より近いもの）
  const lines: { pieces: Piece[]; cy: number; h: number }[] = []
  for (const piece of pieces) {
    const line = lines.at(-1)
    if (line && Math.abs(piece.cy - line.cy) < Math.max(piece.h, line.h) * 0.5) line.pieces.push(piece)
    else lines.push({ pieces: [piece], cy: piece.cy, h: piece.h })
  }
  let text = ''
  let prev: { cy: number; h: number } | null = null
  for (const line of lines) {
    // 同じ行の断片は、間が空いていれば（英数字どうしなら）空白を挟んでつなぐ
    let content = ''
    let end = -Infinity
    for (const p of line.pieces.sort((a, b) => a.x - b.x)) {
      if (content && p.x - end > p.h * 0.2 && needsSpace(content, p.text)) content += ' '
      content += p.text
      end = p.right
    }
    content = content.replace(/\s+/g, ' ').trim()
    if (!content) continue
    if (prev && text) {
      const gap = line.cy - prev.cy
      if (gap > Math.max(line.h, prev.h) * 1.9) text += '\n'
      // 行末の「-」で切れた英単語はつなぐ
      else if (/[A-Za-z]-$/.test(text) && /^[a-z]/.test(content)) text = text.slice(0, -1)
      else if (needsSpace(text, content)) text += ' '
    }
    text += content
    prev = line
  }
  const area = region.w * region.h
  return { text, coverage: area > 0 ? Math.min(1, covered / area) : 0 }
}

// 英数字（とその記号）どうしの間には空白を入れる。日本語の文字の間には入れない
function needsSpace(before: string, after: string): boolean {
  const last = [...before].at(-1) ?? ''
  const first = [...after][0] ?? ''
  return isLatin(last) && isLatin(first)
}

function isLatin(ch: string): boolean {
  return /[A-Za-z0-9.,;:!?)\]'"%-]/.test(ch) && !/[\u3000-\u9fff\uff00-\uffef]/.test(ch)
}

// ---- Markdown ----

// 引用した文字列を本文から探し、引用を始めた行（1 から）を返す。複数あれば、覚えていた行に最も近いもの。
// 見つからなければ null（「位置不明」。MAI-10 の「5. Markdown の SourceAnchor」）
export function locateQuote(text: string, quote: string, line: number): number | null {
  const needle = quote.replace(/\r\n?/g, '\n')
  const body = text.replace(/\r\n?/g, '\n')
  if (!needle.trim()) return null
  let best: number | null = null
  for (let at = body.indexOf(needle); at !== -1; at = body.indexOf(needle, at + 1)) {
    const found = lineAt(body, at)
    if (best === null || Math.abs(found - line) < Math.abs(best - line)) best = found
    if (found >= line) break
  }
  return best
}

// 本文の位置（文字の番号）が何行目か（1 から）
export function lineAt(text: string, offset: number): number {
  let line = 1
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) line++
  return line
}

// 引用した文字列の、本文の中の位置（見つからなければ null）。全画面のエディタで、その範囲を選ぶのに使う
export function quoteRange(text: string, quote: string, line: number): { from: number; to: number } | null {
  const found = locateQuote(text, quote, line)
  if (found === null) return null
  const needle = quote.replace(/\r\n?/g, '\n')
  const body = text.replace(/\r\n?/g, '\n')
  // found 行目から始まる最初の出現
  let start = 0
  for (let n = 1; n < found; n++) start = body.indexOf('\n', start) + 1
  const from = body.indexOf(needle, start)
  if (from === -1) return null
  // 改行コードが \r\n の本文でも、位置がずれないよう、元の本文での位置に直す
  return { from: originalOffset(text, from), to: originalOffset(text, from + needle.length) }
}

function originalOffset(text: string, normalized: number): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    if (n === normalized) return i
    if (text[i] === '\r' && text[i + 1] === '\n') continue
    n++
  }
  return text.length
}

// 引用ノートに見せる、出典の位置
export function locationLabel(locator: SourceLocator, line: number | null): string {
  if (locator.kind === 'pdf') return `p.${locator.pageIndex + 1}`
  if (locator.kind === 'markdown') return line === null ? '位置不明' : `${line} 行目`
  return ''
}
