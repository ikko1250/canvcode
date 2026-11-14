import type { Box, Vec } from '@canvcode/core'
import { joinLines, needsSpace, type PdfTextItem } from './quotes.ts'

// PDF のページの上で、なぞった語を選ぶ（o メニューの「単語を調べる」。MAI-99）。DOM を使わない部分だけをここに置く。
// - ページの文字の断片（PDF.js の getTextContent）を、PDF に書かれた順（ブラウザで PDF の文字を選ぶときと同じ順。2 段組でも
//   左の段から右の段へ続く）につないで、1 つの文字列にする。行の間は、英数字どうしなら空白、日本語なら何も入れずにつなぎ、
//   行末の「-」で切れた英単語は「-」を落としてつなぐ（textInRegion と同じ）。行の間が大きく空いていれば、段落の区切り（改行）にする
// - 語は Intl.Segmenter（word）で分ける。日本語も辞書で語に分かれる
// - 押した語から今の位置の語までを、文字列の順に選ぶ（四角の範囲ではなく、文字を選ぶときと同じ動き）。行をまたいでもよい
// - 調べるときに渡す前後の文は、Intl.Segmenter（sentence）で文に分けて、選んだ所を含む文と、その前後の文を切り出す

// ページの文字をつないだもの。位置はポイントで、ページの左上が原点
export interface PdfPageText {
  text: string
  // text の 1 文字（UTF-16 の 1 単位）ごとの、ページの上の箱。足した空白・改行は null
  boxes: (Box | null)[]
  // text の 1 文字ごとの、行の番号（ハイライトを行ごとにまとめるため）
  lines: number[]
  // 語（text の中の位置。end は含まない）。文字列の順
  words: { start: number; end: number }[]
}

export interface WordSelection {
  // 選んだ語（空白はまとめて 1 つにする）
  text: string
  // 選んだ所を含む文と、その前後の文
  context: string
  // text の中の位置
  start: number
  end: number
  // ハイライトする箱（行ごとに 1 つ。ポイント）
  boxes: Box[]
}

// 前後の文の長さの上限（文字）。長い文は、選んだ所のまわりだけを残す
export const WORD_CONTEXT_MAX = 1200

type Segmenter = { segment(text: string): Iterable<{ segment: string; index: number; isWordLike?: boolean }> }

function segmenter(granularity: 'word' | 'sentence'): Segmenter | null {
  const Ctor = (Intl as unknown as { Segmenter?: new (locale: string, options: { granularity: string }) => Segmenter }).Segmenter
  return Ctor ? new Ctor('ja', { granularity }) : null
}

// 文字の幅の比（断片の文字ごと）。PDF.js は断片の幅しか返さないので、画面ではフォントで測った幅の比で断片の幅を分ける
// （等しい幅とみなすと、英語の長い行の終わりで、ハイライトが語 1 つ分ほどずれた）。渡さなければ等しい幅とみなす
export type CharWidths = (chars: readonly string[]) => number[]

// ページの文字の断片を、1 つの文字列と語にする
export function pdfPageText(items: readonly PdfTextItem[], charWidths?: CharWidths): PdfPageText {
  let text = ''
  const boxes: (Box | null)[] = []
  const lines: number[] = []
  let line = 0
  let prev: { cy: number; h: number; right: number; eol: boolean } | null = null
  const push = (chars: string, box: Box | null) => {
    for (let i = 0; i < chars.length; i++) {
      text += chars[i]
      boxes.push(box)
      lines.push(line)
    }
  }
  const pop = () => {
    text = text.slice(0, -1)
    boxes.pop()
    lines.pop()
  }
  for (const item of items) {
    if (!item.text || item.w <= 0 || item.h <= 0) {
      // 文字のない断片が行の終わりを知らせることがある
      if (item.eol && prev) prev.eol = true
      continue
    }
    const cy = item.y + item.h / 2
    if (prev) {
      const sameLine = !prev.eol && Math.abs(cy - prev.cy) < Math.max(item.h, prev.h) * 0.5
      if (sameLine) {
        // 同じ行の断片は、間が空いていれば（英数字どうしなら）空白を挟んでつなぐ
        if (item.x - prev.right > item.h * 0.2 && !/\s$/.test(text) && !/^\s/.test(item.text) && needsSpace(text, item.text)) push(' ', null)
      } else {
        line++
        while (/\s$/.test(text)) pop()
        const head = item.text.trimStart()
        if (cy - prev.cy > Math.max(item.h, prev.h) * 1.9) push('\n', null)
        // 行末の「-」で切れた英単語はつなぐ
        else if (/[A-Za-z]-$/.test(text) && /^[a-z]/.test(head)) pop()
        else if (needsSpace(text, head)) push(' ', null)
      }
    }
    // 断片の幅を、文字の幅の比で分ける（なければ等しく。textInRegion と同じ）
    const chars = [...item.text]
    const widths = charWidths?.(chars)
    const total = widths?.length === chars.length ? widths.reduce((sum, w) => sum + Math.max(0, w), 0) : 0
    let x = item.x
    chars.forEach((ch, i) => {
      const w = total > 0 ? (item.w * Math.max(0, widths![i]!)) / total : item.w / chars.length
      push(ch, { x, y: item.y, w, h: item.h })
      x += w
    })
    prev = { cy, h: item.h, right: item.x + item.w, eol: Boolean(item.eol) }
  }
  return { text, boxes, lines, words: splitWords(text) }
}

function splitWords(text: string): { start: number; end: number }[] {
  const words: { start: number; end: number }[] = []
  const seg = segmenter('word')
  if (!seg) {
    // Intl.Segmenter のない環境：空白で分ける
    for (const match of text.matchAll(/\S+/g)) words.push({ start: match.index, end: match.index + match[0].length })
    return words
  }
  for (const { segment, index, isWordLike } of seg.segment(text)) {
    // 語のほか、記号だけのもの（「%」「＝」など）も選べるようにする。空白と区切りの記号（句読点・括弧）は語にしない
    if (isWordLike || /[^\s\p{P}]/u.test(segment)) words.push({ start: index, end: index + segment.length })
  }
  return words
}

// ページの上の点（ポイント）にある語の番号。語の上でなければ、上下のいちばん近い行の中で、左右のいちばん近い語
// （行の右の空いた所なら、その行の最後の語。行の間なら近い行）。語がなければ -1
export function wordIndexAt(page: PdfPageText, point: Vec): number {
  let best = -1
  let bestDy = Infinity
  let bestDx = Infinity
  page.words.forEach((word, index) => {
    for (let i = word.start; i < word.end; i++) {
      const box = page.boxes[i]
      if (!box) continue
      const dx = Math.max(box.x - point.x, 0, point.x - (box.x + box.w))
      const dy = Math.max(box.y - point.y, 0, point.y - (box.y + box.h))
      if (dy < bestDy - 1e-6 || (dy <= bestDy + 1e-6 && dx < bestDx)) {
        bestDy = dy
        bestDx = dx
        best = index
      }
    }
  })
  return best
}

// a 番目の語から b 番目の語まで（どちらが先でもよい）を選ぶ
export function selectWords(page: PdfPageText, a: number, b: number): WordSelection | null {
  const first = page.words[Math.min(a, b)]
  const last = page.words[Math.max(a, b)]
  if (!first || !last) return null
  const start = first.start
  const end = last.end
  return {
    // 改行（段落の区切り）は、英数字どうしなら空白に、日本語なら何も入れずにつなぐ（MAI-103）
    text: joinLines(page.text.slice(start, end)),
    context: sentencesAround(page.text, start, end),
    start,
    end,
    boxes: lineBoxes(page, start, end),
  }
}

// text の start〜end を含む文と、その前後の文（1 つずつ）。長ければ、選んだ所のまわりの maxLength 文字ほどにする
export function sentencesAround(text: string, start: number, end: number, maxLength = WORD_CONTEXT_MAX): string {
  const seg = segmenter('sentence')
  let from = 0
  let to = text.length
  if (seg) {
    const bounds = [...seg.segment(text)].map(({ index, segment }) => ({ start: index, end: index + segment.length }))
    const firstIndex = bounds.findIndex((s) => s.end > start)
    const lastIndex = bounds.findLastIndex((s) => s.start < end)
    if (firstIndex >= 0 && lastIndex >= 0) {
      from = bounds[Math.max(0, firstIndex - 1)]!.start
      to = bounds[Math.min(bounds.length - 1, lastIndex + 1)]!.end
    }
  }
  if (to - from > maxLength) {
    const room = Math.max(0, maxLength - (end - start))
    from = Math.max(from, start - Math.ceil(room / 2))
    to = Math.min(to, from + Math.max(maxLength, end - start))
  }
  return text.slice(from, to).replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()
}

// start〜end の文字の箱を、行ごとに 1 つにまとめる
function lineBoxes(page: PdfPageText, start: number, end: number): Box[] {
  const byLine = new Map<number, Box>()
  for (let i = start; i < end; i++) {
    const box = page.boxes[i]
    if (!box) continue
    const line = page.lines[i]!
    const current = byLine.get(line)
    if (!current) {
      byLine.set(line, { ...box })
      continue
    }
    const x = Math.min(current.x, box.x)
    const y = Math.min(current.y, box.y)
    const right = Math.max(current.x + current.w, box.x + box.w)
    const bottom = Math.max(current.y + current.h, box.y + box.h)
    byLine.set(line, { x, y, w: right - x, h: bottom - y })
  }
  return [...byLine.values()]
}
