import { highlightTree, tagHighlighter, tags } from '@lezer/highlight'
import { parser as pythonParser } from '@lezer/python'
import { NO_BREAK_AFTER, NO_BREAK_BEFORE } from '../text/layout.ts'

// コードカードの配置と色分け（MAI-5、MAI-31）。DOM を使わず、描画とテストで同じ計算をする。
// - 構文の色分けは Lezer の Python の文法で計算する（CodeMirror の Python モードと同じ文法）
// - 長い行はカードの幅で折り返す。インデントのある行は、折り返したあとも同じインデントを保つ（ぶら下げ）
// - タブは 4 桁ごとの位置まで空白にする

export const CODE_TAB_SIZE = 4
export const CODE_TEXT_COLOR = '#1f2328'

// 色分けの規則（CodeMirror の側の色 codeEditor.ts と合わせる）
const highlighter = tagHighlighter([
  { tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.operatorKeyword, tags.moduleKeyword], class: '#cf222e' },
  { tag: [tags.string, tags.special(tags.string), tags.escape], class: '#0a3069' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], class: '#6e7781' },
  { tag: [tags.number, tags.bool, tags.null, tags.self, tags.atom], class: '#0550ae' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.definition(tags.function(tags.variableName))], class: '#8250df' },
  { tag: [tags.className, tags.definition(tags.className)], class: '#953800' },
  { tag: [tags.meta, tags.annotation], class: '#8250df' },
])

export interface CodeMetrics {
  fontSize: number
  lineHeight: number
  // 半角 1 文字の幅（等幅フォントなので、どの半角文字も同じ）
  charWidth: number
  // 全角の文字の幅。等幅フォントに全角の字形がなく別のフォントで描かれることが多いので、ブラウザで測った値を使う。
  // 測れないとき（テスト）は半角の 2 倍
  wideWidth?: number
}

export interface CodeRun {
  text: string
  color: string
  // 行の左端（本文の左端）からの位置
  x: number
}

export interface CodeVisualLine {
  // 元の行の番号（1 から）。折り返した続きの行は null（行番号を出さない）
  lineNumber: number | null
  runs: CodeRun[]
}

export interface CodeLayout {
  lines: CodeVisualLine[]
  // 元の行の数（行番号の桁数を決めるのに使う）
  sourceLines: number
}

// 全角の文字（CJK・全角記号・絵文字など）。等幅フォントでは半角 2 文字分の幅で描かれる
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\ud83c-\ud83e][\udc00-\udfff]/

function widthOf(char: string, metrics: CodeMetrics): number {
  return WIDE.test(char) ? (metrics.wideWidth ?? metrics.charWidth * 2) : metrics.charWidth
}

// タブを空白にした行と、そのときの各文字の元の位置
function expandTabs(line: string): string {
  if (!line.includes('\t')) return line
  let out = ''
  for (const char of line) {
    if (char === '\t') out += ' '.repeat(CODE_TAB_SIZE - (out.length % CODE_TAB_SIZE))
    else out += char
  }
  return out
}

// 文字ごとの色（行ごと）。タブを広げたあとの文字の並びに合わせる
function colorize(text: string): string[][] {
  const lines = text.split('\n')
  const colors = lines.map((line) => new Array<string>(line.length).fill(CODE_TEXT_COLOR))
  const starts: number[] = []
  let offset = 0
  for (const line of lines) {
    starts.push(offset)
    offset += line.length + 1
  }
  const tree = pythonParser.parse(text)
  highlightTree(tree, highlighter, (from, to, color) => {
    // 範囲の行を探して、その行の中の文字に色を付ける
    let lineIndex = upperBound(starts, from) - 1
    for (let pos = from; pos < to; ) {
      while (lineIndex + 1 < starts.length && starts[lineIndex + 1] <= pos) lineIndex++
      const lineEnd = starts[lineIndex] + lines[lineIndex].length
      const end = Math.min(to, lineEnd)
      for (let i = pos - starts[lineIndex]; i < end - starts[lineIndex]; i++) colors[lineIndex][i] = color
      pos = lineEnd + 1
    }
  })
  // タブを広げた分、色の並びも広げる
  return lines.map((line, i) => {
    if (!line.includes('\t')) return colors[i]
    const out: string[] = []
    for (let j = 0; j < line.length; j++) {
      const count = line[j] === '\t' ? CODE_TAB_SIZE - (out.length % CODE_TAB_SIZE) : 1
      for (let k = 0; k < count; k++) out.push(colors[i][j])
    }
    return out
  })
}

function upperBound(sorted: number[], value: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] <= value) lo = mid + 1
    else hi = mid
  }
  return lo
}

// ぶら下げのインデントは、本文の幅の半分までにする（深いインデントでも、1 行に書ける幅を残す）
const MAX_HANGING_RATIO = 0.5

export function layoutCode(text: string, width: number, metrics: CodeMetrics): CodeLayout {
  const sourceLines = text.split('\n')
  const colors = colorize(text)
  const out: CodeVisualLine[] = []
  for (const [index, raw] of sourceLines.entries()) {
    const line = expandTabs(raw)
    const lineColors = colors[index]
    const chars = [...line]
    // 文字（サロゲートペアは 1 文字として扱う）ごとの色と幅
    const charColors: string[] = []
    let unit = 0
    for (const char of chars) {
      charColors.push(lineColors[unit] ?? CODE_TEXT_COLOR)
      unit += char.length
    }
    const indentChars = chars.length - line.trimStart().length
    const hanging = Math.min(indentChars * metrics.charWidth, width * MAX_HANGING_RATIO)
    let start = 0
    let first = true
    if (chars.length === 0) out.push({ lineNumber: index + 1, runs: [] })
    while (start < chars.length) {
      const offsetX = first ? 0 : hanging
      const available = Math.max(metrics.charWidth, width - offsetX)
      // この行に入る文字の終わりを探す
      let end = start
      let used = 0
      while (end < chars.length && used + widthOf(chars[end], metrics) <= available + 0.01) {
        used += widthOf(chars[end], metrics)
        end++
      }
      if (end === start) end = start + 1
      // 半角の語の途中で切ることになるなら、できれば空白の後ろで切る（全角の文字は、どこで切ってもよい）
      if (end < chars.length && isWordChar(chars[end - 1]) && isWordChar(chars[end])) {
        let space = end
        while (space > start + 1 && chars[space - 1] !== ' ') space--
        // インデントの空白で切ると、空白だけの行ができてしまうので、文字のあとの空白だけを使う
        const hasText = chars.slice(start, space).some((c) => c !== ' ')
        if (hasText && space > start + 1 && space > start + (end - start) / 3) end = space
      }
      // 禁則：句読点や閉じ括弧を次の行の頭にしない。開き括弧を行の終わりにしない（テキストノードと同じ規則）
      while (end < chars.length && end > start + 1 && (NO_BREAK_BEFORE.has(chars[end]) || NO_BREAK_AFTER.has(chars[end - 1]))) end--
      // 折り返した続きの行は、行頭の空白を飛ばす（インデントはぶら下げで付ける）
      let from = start
      if (!first) while (from < end - 1 && chars[from] === ' ') from++
      out.push({ lineNumber: first ? index + 1 : null, runs: runsOf(chars, charColors, from, end, offsetX, metrics) })
      start = end
      first = false
    }
  }
  return { lines: out, sourceLines: sourceLines.length }
}

function isWordChar(char: string): boolean {
  return char !== ' ' && !WIDE.test(char)
}

// 同じ色の文字をまとめて、描く単位にする。空白は描かずに位置だけ進める
function runsOf(chars: string[], colors: string[], from: number, to: number, x0: number, metrics: CodeMetrics): CodeRun[] {
  const runs: CodeRun[] = []
  let x = x0
  let i = from
  while (i < to) {
    while (i < to && chars[i] === ' ') {
      x += metrics.charWidth
      i++
    }
    if (i >= to) break
    const color = colors[i]
    let text = ''
    const runX = x
    while (i < to && colors[i] === color) {
      text += chars[i]
      x += widthOf(chars[i], metrics)
      i++
    }
    // 空白だけの並びは描かなくてよい
    if (text.trim()) runs.push({ text, color, x: runX })
  }
  return runs
}
