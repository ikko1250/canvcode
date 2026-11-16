import {
  BULLET_GLYPHS,
  DEFAULT_LIST_STYLES,
  MAX_LIST_LEVEL,
  formatListNumber,
  listMarkers,
  listOf,
  listStyleOf,
  normalizeRichText,
  richTextFromPlain,
  sameFormat,
  type BulletStyle,
  type TextList,
  type TextListStyle,
  type TextListType,
  type TextParagraph,
  type TextRun,
  type TextRunFormat,
} from './richText.ts'

// 範囲ごとに書式を持つテキスト（richText.ts の段落と run）と、Markdown の文字の行き来。
// テキスト・付箋・図形の中の文字を、AI（MCP の edit_canvas の md・read_nodes の md）・貼り付け・コピー・箇条書きのメモで
// Markdown として読み書きする。書き方（「付箋の Markdown」）：
// - 1 行が 1 段落（空の行は空の段落）。普通の Markdown と違い、行を続けて書いても 1 つの段落にはつながない
// - 箇条書き：行の頭の「- 」「* 」「+ 」（階層ごとの既定の記号）か、記号そのもの「• 」「◦ 」「▪ 」「– 」「✓ 」。
//   番号付き：「1. 」「1) 」「(1) 」「a. 」「i. 」「① 」（書いた形の番号。数字の値は使わず、上から数え直す）。
//   リストの始まり（その階層で 1 番目になる所）は 1・a・i・① でなければリストとして読まない（「3. 」から始まる文・「vs. 」を番号にしない）。
//   英字・ローマ数字は、そのあとも、その位置で数えた番号と同じときだけリストとして読む。
//   階層は字下げで決める：前の項目より深く字下げした行は 1 段深い（2 つでも 3 つでも 4 つでも）。最初の項目の字下げは 2 つで 1 段。
//   記号のあとの空白はいくつでもよい。項目の間の空の行は読み飛ばす（項目の間の空の段落は []{} と書く）。
//   項目のすぐあとの、2 つ以上（かタブで）字下げした行は、その項目の続き（つなぐ。英数字どうしの間には空白を入れる）
// - 文字の書式：**太字**、*斜体*、~~取り消し線~~、`等幅`（フォントを monospace にする）。
//   日本語の文の中でも使えるよう、記号の前後が空白でなければ（括弧や句読点の隣でも）開け閉めできる。
//   ただし 1 つだけの * が英数字に挟まれていれば文字のまま（2*3*4、a*b*c）。_ は書式にしない（snake_case・__init__ をそのまま読む）
// - 色・大きさ・フォント・太さ・下線（Markdown にない書式）は Pandoc の書き方の [文字]{属性}：
//   color=#rrggbb、size=20（px）、font="M PLUS 1p"、weight=600、.underline（ほか .bold .italic .strike）。入れ子にしてよい
// - 見出し（# から ###）は太字にし、既定の文字の大きさの 1.6・1.35・1.15 倍にする（#### からは太字だけ）。``` で囲んだ行は等幅の段落
// - \ の後ろの記号（* _ ~ ` [ ] { } # - . など）と、リストの記号（• ① など）は、ただの文字
// 書き出すとき（richTextToMarkdown）は、読み直すと同じ段落と run になる形にする（見出し・``` は書かない）。
// 太字などを記号で書けない所（空白で始まる・終わる範囲、空の段落の書式）は [文字]{.bold} の形で、
// 読むと字下げ・続きの行とみなされる頭の空白は [空白]{} の形で書く。
// 書き出した段落を読み直して違えば、その段落は書式のある文字をすべて [文字]{属性} で書く。
// flavor 'standard'（ほかのアプリへのコピー）は普通の Markdown だけで書く（色・大きさ・フォント・太さ・下線と [ ]{ } は書かない）

// `等幅` のフォント（fonts.ts の generic family）
export const MARKDOWN_CODE_FONT = 'monospace'

// 見出しの文字の大きさ（既定の文字の大きさに掛ける。# ## ###）
const HEADING_SCALES = [1.6, 1.35, 1.15]
// 入れ子の [文字]{属性} の深さと、1 行の書式の記号（* ~）の数の上限。超えた分はただの文字
// （深い入れ子でスタックがあふれない・記号の組を探す時間が長くならないように）
const MAX_SPAN_DEPTH = 32
const MAX_DELIMITERS = 1000
// これより長く続く * はただの文字（書き出しが続けて書くのは 6 つまで）
const MAX_DELIMITER_RUN = 8
// 貼り付けで Markdown として読む文字の長さの上限（超えたら、そのままの文字として貼る）
const MAX_PASTE_MARKDOWN = 200_000
// 読めなかった指定を知らせる数の上限（超えた分は数だけ）
const MAX_ISSUES = 20

export type MarkdownFlavor = 'canvcode' | 'standard'

export interface RichMarkdownOptions {
  // ノードの既定の書式（baseFormatOf）。読むときはこれと同じ値の書式を持たず、書くときは書かない。見出しの大きさの基準
  base?: TextRunFormat
  // 読むとき：最後の改行を落とさない（貼り付け。最後の改行は、プレーンテキストと同じく新しい段落にする）
  keepTrailingNewline?: boolean
  // 読むとき：最初の行をリスト・見出しとして読まない（段落の途中に貼るとき。最初の行は、その段落の続きになる）
  inlineFirstLine?: boolean
  // 読むとき：項目のすぐあとの字下げした行を、その項目の続きとしてつなぐ（既定は true。貼り付けでは false：YAML などの行を残す）
  joinContinuation?: boolean
  // 書くとき：'standard' は普通の Markdown だけ（ほかのアプリへのコピー）。既定は 'canvcode'
  flavor?: MarkdownFlavor
}

export interface RichMarkdownParse {
  paragraphs: TextParagraph[]
  // 読めなかった書式の指定（知らない属性・値の形の誤りなど。「line 2: …」）。読めなかった指定は使わない
  issues: string[]
}

// ---- 読む ----

export function parseRichMarkdown(markdown: string, options: RichMarkdownOptions = {}): RichMarkdownParse {
  const issues: string[] = []
  let more = 0
  const unified = markdown.replace(/\r\n?/g, '\n')
  const lines = (options.keepTrailingNewline || !unified.endsWith('\n') ? unified : unified.slice(0, -1)).split('\n')
  const fences = new FenceCloses(lines)
  const numbering = new ListNumbering()
  const paragraphs: TextParagraph[] = []
  const push = (paragraph: TextParagraph) => {
    paragraphs.push(paragraph)
    numbering.push(paragraph)
  }
  let stack: ListFrame[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const report = (message: string) => {
      if (issues.length < MAX_ISSUES) issues.push(`line ${i + 1}: ${message}`)
      else more++
    }
    if (i === 0 && options.inlineFirstLine) {
      push({ runs: parseInline(line, report) })
      continue
    }
    const fence = FENCE_OPEN.exec(line)
    const fenceEnd = fence ? fences.after(i, fence[2]!.length) : -1
    if (fence && fenceEnd > i) {
      // 中の行は、``` の字下げの分だけ頭の空白を落とす（CommonMark と同じ）
      const indent = fence[1]!.length
      for (let k = i + 1; k < fenceEnd; k++) push({ runs: [{ text: dropSpaces(lines[k]!, indent), format: { fontFamily: MARKDOWN_CODE_FONT } }] })
      i = fenceEnd
      stack = []
      continue
    }
    const last = paragraphs.at(-1)
    const afterItem = stack.length > 0 && last !== undefined && listOf(last) !== undefined
    // 項目の間の空の行は読み飛ばす（行を空けて書いたリストも 1 つのリストにする）
    if (line === '' && afterItem) {
      let next = i + 1
      while (next < lines.length && lines[next] === '') next++
      if (next < lines.length && listItemOf(lines[next]!, numbering, stack)) {
        i = next - 1
        continue
      }
    }
    const item = listItemOf(line, numbering, stack)
    if (item) {
      stack = item.stack
      push({ runs: parseInline(item.content, report), list: item.list })
      continue
    }
    // 項目のすぐあとの字下げした行は、その項目の続き
    if (afterItem && options.joinContinuation !== false && /^(?: {2}|\t)/.test(line) && line.trim() !== '') {
      joinLine(last.runs, parseInline(trimStartSpaces(line), report))
      continue
    }
    stack = []
    const heading = headingOf(line)
    if (heading) {
      const format = markdownHeadingFormat(heading.depth, options.base)
      push({ runs: parseInline(heading.content, report).map((run) => ({ text: run.text, format: { ...format, ...run.format } })) })
      continue
    }
    push({ runs: parseInline(line, report) })
  }
  if (more > 0) issues.push(`…and ${more} more`)
  return { paragraphs: normalizeRichText(sameCaseColors(paragraphs, options.base), options.base), issues }
}

// 見出し（# の数が depth）の書式：太字と、# から ### は既定の文字の大きさの 1.6・1.35・1.15 倍（編集中に「# 」と打ったときも同じ）
export function markdownHeadingFormat(depth: number, base?: TextRunFormat): TextRunFormat {
  const scale = HEADING_SCALES[depth - 1]
  const size = scale && typeof base?.fontSize === 'number' ? Math.round(base.fontSize * scale) : undefined
  return size ? { fontWeight: 700, fontSize: size } : { fontWeight: 700 }
}

// 書式（既定に重ねた実際の値）が、# から ### の見出しの書式か（太字で、大きさが見出しの大きさ）
export function isMarkdownHeadingFormat(format: TextRunFormat, base: TextRunFormat): boolean {
  if (format.fontWeight !== 700 || typeof base.fontSize !== 'number') return false
  return HEADING_SCALES.some((_, i) => markdownHeadingFormat(i + 1, base).fontSize === format.fontSize && format.fontSize !== base.fontSize)
}

// 編集中に段落の頭で打った見出しの記号（「#」〜「######」。全角の ＃ も）。見出しでなければ 0
export function headingShortcutDepth(textBeforeSpace: string): number {
  return /^[#\uff03]{1,6}$/.test(textBeforeSpace) ? textBeforeSpace.length : 0
}

// 読めなかった指定は捨てて読む
export function richTextFromMarkdown(markdown: string, options: RichMarkdownOptions = {}): TextParagraph[] {
  return parseRichMarkdown(markdown, options).paragraphs
}

// 貼り付けた文字：Markdown として読む。書式もリストもなければ、そのままの文字にする（\ などを落とさない）。
// 字下げした行は項目の続きとしてつながない（YAML・コードの行を残す）。長すぎる文字も、そのまま。最後の改行は新しい段落にする（プレーンテキストの貼り付けと同じ）
export function richTextFromPaste(text: string, options: Omit<RichMarkdownOptions, 'keepTrailingNewline' | 'flavor' | 'joinContinuation'> = {}): TextParagraph[] {
  if (text.length <= MAX_PASTE_MARKDOWN) {
    const parsed = parseRichMarkdown(text, { ...options, keepTrailingNewline: true, joinContinuation: false }).paragraphs
    if (hasRichFormatting(parsed, options.base)) return parsed
  }
  return richTextFromPlain(text)
}

// 色は大文字・小文字を区別せずに既定と比べる（同じなら既定の書き方にして、持たないようにする）
function sameCaseColors(paragraphs: TextParagraph[], base: TextRunFormat | undefined): TextParagraph[] {
  const color = base?.color?.toLowerCase()
  if (!color) return paragraphs
  for (const paragraph of paragraphs) {
    for (const run of paragraph.runs) if (run.format?.color?.toLowerCase() === color) run.format = { ...run.format, color: base!.color }
  }
  return paragraphs
}

// 前の行の続きを before に足す：英数字どうしの間には空白を入れる（日本語はそのままつなぐ）
function joinLine(before: TextRun[], after: TextRun[]): void {
  const tail = before.at(-1)?.text.at(-1) ?? ''
  const head = after[0]?.text[0] ?? ''
  if (/[!-~]/.test(tail) && /[!-~]/.test(head)) before.push({ text: ' ' })
  for (const run of after) before.push(run)
}

function trimStartSpaces(text: string): string {
  let i = 0
  while (text[i] === ' ' || text[i] === '\t') i++
  return text.slice(i)
}

function dropSpaces(text: string, count: number): string {
  let i = 0
  while (i < count && text[i] === ' ') i++
  return text.slice(i)
}

// ``` の行（言語の名前を付けてもよい）。閉じる行がなければ、ただの文字
const FENCE_OPEN = /^( {0,3})(`{3,})[^`]*$/
const FENCE_CLOSE = /^ {0,3}(`{3,})[ \t]*$/

// 閉じる ``` の行（行の番号と ` の数）。開いた行のあとで、同じ数以上の ` の閉じる行を探す
class FenceCloses {
  private readonly closes: { line: number; length: number }[] = []

  constructor(lines: readonly string[]) {
    for (const [line, text] of lines.entries()) {
      const match = text.startsWith('```') || text.startsWith(' ') ? FENCE_CLOSE.exec(text) : null
      if (match) this.closes.push({ line, length: match[1]!.length })
    }
  }

  after(line: number, length: number): number {
    let low = 0
    let high = this.closes.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (this.closes[mid]!.line <= line) low = mid + 1
      else high = mid
    }
    for (let k = low; k < this.closes.length; k++) if (this.closes[k]!.length >= length) return this.closes[k]!.line
    return -1
  }
}

// 見出し（# のあとに空白。閉じる # は落とす）
function headingOf(line: string): { depth: number; content: string } | null {
  const match = /^ {0,3}(#{1,6})(?=[ \t]|$)/.exec(line)
  if (!match) return null
  let content = trimStartSpaces(line.slice(match[0].length))
  let end = content.length
  while (end > 0 && (content[end - 1] === ' ' || content[end - 1] === '\t')) end--
  let hashes = end
  while (hashes > 0 && content[hashes - 1] === '#') hashes--
  if (hashes < end && (hashes === 0 || content[hashes - 1] === ' ' || content[hashes - 1] === '\t')) {
    end = hashes
    while (end > 0 && (content[end - 1] === ' ' || content[end - 1] === '\t')) end--
  }
  content = content.slice(0, end)
  return { depth: match[1]!.length, content }
}

// リストの項目の行：字下げ・記号・記号のあとの空白（行の終わりなら空の項目）
const LIST_ITEM = /^([ \t\u3000]*)([-*+\u2022\u25e6\u25aa\u2013\u2713]|\d{1,9}[.)]|\(\d{1,9}\)|[a-z]{1,12}\.|[\u2460-\u2473\u3251-\u325f\u32b1-\u32bf])(?:[ \t]|$)/

const BULLET_OF_GLYPH: Record<string, BulletStyle> = Object.fromEntries(Object.entries(BULLET_GLYPHS).map(([style, glyph]) => [glyph, style as BulletStyle]))

// 字下げの中の項目（階層と、その行の字下げの幅）
interface ListFrame {
  level: number
  indent: number
}

// 段落の番号を、読みながら数える（richText.ts の listNumbers と同じ数え方）。リストの始まりと英字の番号を確かめるのに使う
class ListNumbering {
  private counters: ({ type: TextListType; n: number; style: TextListStyle } | undefined)[] = []

  // この階層に type の項目を足したときの番号
  next(type: TextListType, level: number): number {
    const previous = this.counters[level]
    return previous && previous.type === type ? previous.n + 1 : 1
  }

  // この階層で続いている項目の形（なければ undefined）
  style(level: number): TextListStyle | undefined {
    return this.counters[level]?.style
  }

  push(paragraph: TextParagraph): void {
    const list = listOf(paragraph)
    if (!list) {
      this.counters = []
      return
    }
    const n = this.next(list.type, list.level)
    this.counters = this.counters.slice(0, list.level + 1)
    this.counters[list.level] = { type: list.type, n, style: listStyleOf(list) }
  }
}

function indentWidth(indent: string): number {
  let width = 0
  for (const char of indent) width += char === '\t' ? 4 : char === '\u3000' ? 2 : 1
  return width
}

function listItemOf(line: string, numbering: ListNumbering, frames: readonly ListFrame[]): { content: string; list: TextList; stack: ListFrame[] } | null {
  const match = LIST_ITEM.exec(line)
  if (!match) return null
  const indent = indentWidth(match[1]!)
  const marker = match[2]!
  // 浅い行が来たら、それより深い項目を閉じる。前の項目より深ければ 1 段深く、同じなら同じ階層
  const stack = [...frames]
  while (stack.length > 0 && indent < stack.at(-1)!.indent) stack.pop()
  const top = stack.at(-1)
  let level: number
  if (!top) level = Math.floor(indent / 2)
  else if (indent > top.indent) level = top.level + 1
  else {
    level = top.level
    stack.pop()
  }
  level = Math.min(MAX_LIST_LEVEL, level)
  const kind = markerKind(marker, level, numbering)
  if (!kind) return null
  stack.push({ level, indent })
  const style = kind.style && kind.style !== defaultStyle(kind.type, level) ? kind.style : undefined
  return { content: trimStartSpaces(line.slice(match[0].length)), list: style ? { type: kind.type, level, style } : { type: kind.type, level }, stack }
}

function defaultStyle(type: TextListType, level: number): TextListStyle {
  const cycle = DEFAULT_LIST_STYLES[type]
  return cycle[level % cycle.length]!
}

const CIRCLED = /^[\u2460-\u2473\u3251-\u325f\u32b1-\u32bf]$/

function circledValue(char: string): number {
  const code = char.codePointAt(0)!
  if (code <= 0x2473) return code - 0x2460 + 1
  if (code <= 0x325f) return code - 0x3251 + 21
  return code - 0x32b1 + 36
}

function markerKind(marker: string, level: number, numbering: ListNumbering): { type: TextListType; style?: TextListStyle } | null {
  if (marker === '-' || marker === '*' || marker === '+') return { type: 'bullet' }
  const glyph = BULLET_OF_GLYPH[marker]
  if (glyph) return { type: 'bullet', style: glyph }
  const n = numbering.next('ordered', level)
  // リストの始まりは 1 番（数字の値はほかに使わない。続く項目は 1. 1. 1. でもよい）
  const numbered = (value: number, style: TextListStyle) => (n === 1 && value !== 1 ? null : { type: 'ordered' as const, style })
  let match = /^(\d+)\.$/.exec(marker)
  if (match) return numbered(Number(match[1]), 'decimal')
  match = /^(\d+)\)$/.exec(marker)
  if (match) return numbered(Number(match[1]), 'decimal-paren')
  match = /^\((\d+)\)$/.exec(marker)
  if (match) {
    // 丸数字は 51 番からを (51) と書く
    if (n > 50 && Number(match[1]) === n && numbering.style(level) === 'circled') return { type: 'ordered', style: 'circled' }
    return numbered(Number(match[1]), 'paren-decimal')
  }
  if (CIRCLED.test(marker)) return numbered(circledValue(marker), 'circled')
  // 英字・ローマ数字は、この位置の番号をその形で書いたものと同じときだけ（a. b. …、i. ii. …）
  for (const style of ['lower-alpha', 'lower-roman'] as const) if (formatListNumber(n, style) === marker) return { type: 'ordered', style }
  return null
}

// ---- 行の中の書式 ----

type InlineNode =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'format'; format: TextRunFormat; children: InlineNode[] }

interface Delimiter {
  kind: 'delim'
  char: '*' | '~'
  // 残りの数と、もとの数（3 の倍数の決まり。CommonMark と同じ）
  length: number
  original: number
  canOpen: boolean
  canClose: boolean
}

type InlineItem = InlineNode | Delimiter

// \ のあとで文字のまま書ける記号（ASCII の記号と、行の頭でリストの記号になる文字）
function isEscapable(char: string | undefined): boolean {
  if (char === undefined) return false
  return /^[!-/:-@[-`{-~]$/.test(char) || char in BULLET_OF_GLYPH || CIRCLED.test(char)
}

function isSpace(char: string): boolean {
  return /^\s$/u.test(char)
}

function isAsciiWord(char: string): boolean {
  return /^[A-Za-z0-9]$/.test(char)
}

// i の前・j の位置の文字（サロゲートペアも 1 文字。端なら空白とみなす）
function charBefore(text: string, i: number): string {
  if (i <= 0) return ' '
  const low = text.charCodeAt(i - 1)
  if (low >= 0xdc00 && low <= 0xdfff && i >= 2) return text.slice(i - 2, i)
  return text[i - 1]!
}

function charAt(text: string, j: number): string {
  if (j >= text.length) return ' '
  return String.fromCodePoint(text.codePointAt(j)!)
}

// 記号の開け閉めの決まり。後ろが空白でなければ開け、前が空白でなければ閉じる（日本語の句読点・括弧の隣でもよい）。
// 1 つだけの * は、英数字に挟まれていれば開け閉めしない（2*3*4、a*b*c はそのまま。**10**x の ** は書式）
function flanking(char: Delimiter['char'], length: number, before: string, after: string): Pick<Delimiter, 'canOpen' | 'canClose'> {
  const inWord = char === '*' && length === 1 && isAsciiWord(before) && isAsciiWord(after)
  return { canOpen: !isSpace(after) && !inWord, canClose: !isSpace(before) && !inWord }
}

function runLength(text: string, i: number, char: string): number {
  let n = 0
  while (text[i + n] === char) n++
  return n
}

// ` の組：from から先で、ちょうど n 個の ` が続く所。見つからなかった n は覚えておき、2 回目からは探さない（長い行で時間がかからないように）
class Backticks {
  private readonly missing = new Map<number, number>()
  private readonly text: string

  constructor(text: string) {
    this.text = text
  }

  closer(from: number, n: number): number {
    const after = this.missing.get(n)
    if (after !== undefined && from >= after) return -1
    const text = this.text
    for (let i = from; i < text.length; ) {
      if (text[i] !== '`') {
        i++
        continue
      }
      const length = runLength(text, i, '`')
      if (length === n) return i
      i += length
    }
    this.missing.set(n, Math.min(from, after ?? from))
    return -1
  }
}

// 行の中の [ と、対応する ] の位置（\ の後ろ・` の中は数えない。入れ子の [文字]{属性} の属性は飛ばす）。1 回で全部を求める
function bracketPairs(text: string, backticks: Backticks, braces: Braces): Map<number, number> {
  const pairs = new Map<number, number>()
  const open: number[] = []
  for (let k = 0; k < text.length; k++) {
    const char = text[k]
    if (char === '\\' && isEscapable(text[k + 1])) {
      k++
    } else if (char === '`') {
      const n = runLength(text, k, '`')
      const end = backticks.closer(k + n, n)
      k = end < 0 ? k + n - 1 : end + n - 1
    } else if (char === '[') {
      open.push(k)
    } else if (char === ']' && open.length > 0) {
      pairs.set(open.pop()!, k)
      if (open.length > 0 && text[k + 1] === '{') {
        const end = braces.end(k + 1)
        if (end > 0) k = end
      }
    }
  }
  return pairs
}

// { を閉じる }。閉じる } がなかった位置を覚えておき、それより後ろからは探さない（] { の多い長い行で時間がかからないように）
class Braces {
  private failedFrom = Number.POSITIVE_INFINITY
  private readonly text: string

  constructor(text: string) {
    this.text = text
  }

  end(open: number): number {
    if (open >= this.failedFrom) return -1
    const end = attributesEnd(this.text, open)
    if (end < 0) this.failedFrom = open
    return end
  }
}

// open の { を閉じる }（引用符の中は飛ばす。なければ -1）
function attributesEnd(text: string, open: number): number {
  let quote: string | null = null
  for (let k = open + 1; k < text.length; k++) {
    const char = text[k]
    if (quote) {
      if (char === '\\') k++
      else if (char === quote) quote = null
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '}') {
      return k
    }
  }
  return -1
}

function parseInline(text: string, report: (message: string) => void): TextRun[] {
  const runs = flatten(parseInlineNodes(text, report, 0))
  return runs.length > 0 ? runs : [{ text: '' }]
}

// 書式の木を run の並びにする（深い入れ子でもスタックを使わないよう、自分で積む）
function flatten(nodes: readonly InlineNode[]): TextRun[] {
  const out: TextRun[] = []
  const stack: { nodes: readonly InlineNode[]; index: number; format: TextRunFormat | undefined }[] = [{ nodes, index: 0, format: undefined }]
  while (stack.length > 0) {
    const top = stack.at(-1)!
    if (top.index >= top.nodes.length) {
      stack.pop()
      continue
    }
    const node = top.nodes[top.index++]!
    if (node.kind === 'text') out.push(top.format ? { text: node.text, format: top.format } : { text: node.text })
    else if (node.kind === 'code') out.push({ text: node.text, format: { ...top.format, fontFamily: MARKDOWN_CODE_FONT } })
    else {
      const inner = { ...top.format, ...node.format }
      // 中身のない [ ]{…} も、その書式の空の run にする（空の段落の書式）
      if (node.children.length === 0) out.push({ text: '', format: inner })
      stack.push({ nodes: node.children, index: 0, format: inner })
    }
  }
  return out
}

function parseInlineNodes(text: string, report: (message: string) => void, depth: number): InlineNode[] {
  const backticks = new Backticks(text)
  const braces = new Braces(text)
  const pairs = text.includes('[') ? bracketPairs(text, backticks, braces) : new Map<number, number>()
  const items: InlineItem[] = []
  let buffer = ''
  let delimiters = 0
  const flush = () => {
    if (buffer) items.push({ kind: 'text', text: buffer })
    buffer = ''
  }
  for (let i = 0; i < text.length; ) {
    const char = text[i]!
    if (char === '\\' && isEscapable(text[i + 1])) {
      buffer += text[i + 1]
      i += 2
      continue
    }
    if (char === '`') {
      const n = runLength(text, i, '`')
      const end = backticks.closer(i + n, n)
      if (end < 0) {
        buffer += text.slice(i, i + n)
        i += n
        continue
      }
      flush()
      items.push({ kind: 'code', text: codeContent(text.slice(i + n, end)) })
      i = end + n
      continue
    }
    if (char === '[') {
      const span = depth < MAX_SPAN_DEPTH ? spanAt(text, i, pairs, braces, report, depth) : null
      if (span) {
        flush()
        items.push(span.node)
        i = span.end
        continue
      }
      buffer += char
      i++
      continue
    }
    if (char === '*' || char === '~') {
      const n = runLength(text, i, char)
      // 取り消し線は ~~ だけ（~ 1 つや 3 つは文字のまま）。長すぎる * の並びも文字のまま
      if ((char === '~' && n !== 2) || n > MAX_DELIMITER_RUN) {
        buffer += text.slice(i, i + n)
        i += n
        continue
      }
      flush()
      items.push({ kind: 'delim', char, length: n, original: n, ...flanking(char, n, charBefore(text, i), charAt(text, i + n)) })
      delimiters++
      i += n
      continue
    }
    buffer += char
    i++
  }
  flush()
  return delimiters <= MAX_DELIMITERS ? processEmphasis(items) : items.map(asNode)
}

// ` の中の文字。前後の両方に空白があれば 1 つずつ落とす（CommonMark と同じ。空白だけなら落とさない）
function codeContent(text: string): string {
  return text.length >= 2 && text.startsWith(' ') && text.endsWith(' ') && text.trim() !== '' ? text.slice(1, -1) : text
}

// 記号の組を、内側から順に書式にする（CommonMark の process emphasis を簡単にしたもの）
function processEmphasis(items: InlineItem[]): InlineNode[] {
  let i = 0
  while (i < items.length) {
    const closer = items[i]!
    if (closer.kind !== 'delim' || !closer.canClose || closer.length === 0) {
      i++
      continue
    }
    let j = i - 1
    for (; j >= 0; j--) {
      const opener = items[j]!
      if (opener.kind === 'delim' && opener.char === closer.char && opener.canOpen && opener.length > 0 && pairable(opener, closer)) break
    }
    if (j < 0) {
      i++
      continue
    }
    const opener = items[j] as Delimiter
    const use = closer.char === '~' ? 2 : opener.length >= 2 && closer.length >= 2 ? 2 : 1
    const format: TextRunFormat = closer.char === '~' ? { strikethrough: true } : use === 2 ? { fontWeight: 700 } : { italic: true }
    const children = items.slice(j + 1, i).map(asNode)
    opener.length -= use
    closer.length -= use
    items.splice(j + 1, i - j - 1, { kind: 'format', format, children })
    i = j + 2
    if (opener.length === 0) {
      items.splice(j, 1)
      i--
    }
    if (closer.length === 0) items.splice(i, 1)
  }
  return items.map(asNode)
}

// 開け閉めの両方ができる記号は、組の長さの和が 3 の倍数なら組にしない（両方が 3 の倍数なら組にする）
function pairable(opener: Delimiter, closer: Delimiter): boolean {
  if (closer.char === '~') return opener.length === 2 && closer.length === 2
  if (!(opener.canClose || closer.canOpen)) return true
  const sum = opener.original + closer.original
  return sum % 3 !== 0 || (opener.original % 3 === 0 && closer.original % 3 === 0)
}

function asNode(item: InlineItem): InlineNode {
  return item.kind === 'delim' ? { kind: 'text', text: item.char.repeat(item.length) } : item
}

// {} の中が属性のつもりで書いたものか（[0-9]{3} のような文字を、崩れた属性として知らせないように）
function looksLikeAttributes(body: string): boolean {
  return body.includes('=') || /^\s*[.#]/.test(body)
}

// i から始まる [文字]{属性}（そうでなければ null）
function spanAt(text: string, i: number, pairs: ReadonlyMap<number, number>, braces: Braces, report: (message: string) => void, depth: number): { node: InlineNode; end: number } | null {
  const close = pairs.get(i)
  if (close === undefined || text[close + 1] !== '{') return null
  const end = braces.end(close + 1)
  if (end < 0) {
    if (looksLikeAttributes(text.slice(close + 2, close + 202))) report(`${JSON.stringify(text.slice(i, i + 60))} is not a [text]{attributes} span: missing }`)
    return null
  }
  const body = text.slice(close + 2, end)
  const attributes = parseAttributes(body)
  if (!attributes.ok) {
    if (looksLikeAttributes(body)) report(`${JSON.stringify(text.slice(i, end + 1))} is not a [text]{attributes} span: ${attributes.error}`)
    return null
  }
  for (const problem of attributes.problems) report(problem)
  return { node: { kind: 'format', format: attributes.format, children: parseInlineNodes(text.slice(i + 1, close), report, depth + 1) }, end: end + 1 }
}

const ATTRIBUTE_HELP = 'use color=#rrggbb, size=<px>, font="<name>", weight=<100-900>, .bold, .italic, .underline, .strike'

type ParsedAttributes = { ok: true; format: TextRunFormat; problems: string[] } | { ok: false; error: string }

// {} の中：空白で区切った .名前・key=値（値は "…" か '…' で囲んでもよい）。形が崩れていれば ok: false（[…]{…} として読まない）。
// 知らない名前・読めない値は problems に入れて使わない
function parseAttributes(body: string): ParsedAttributes {
  const format: TextRunFormat = {}
  const problems: string[] = []
  const token = /\s*(?:\.([\w-]+)|#([\w-]+)|([\w-]+)=(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s"'}]+)))/y
  let at = 0
  while (at < body.length) {
    if (body.slice(at).trim() === '') break
    token.lastIndex = at
    const match = token.exec(body)
    if (!match) return { ok: false, error: `cannot read ${JSON.stringify(body.slice(at).trim())} (${ATTRIBUTE_HELP})` }
    at = token.lastIndex
    const [, className, id, key, double, single, bare] = match
    if (id !== undefined) {
      problems.push(`#${id}: ids are not used`)
      continue
    }
    if (className !== undefined) {
      if (!applyClass(format, className)) problems.push(`.${className} is not a known class (${ATTRIBUTE_HELP})`)
      continue
    }
    const value = (double ?? single)?.replace(/\\(.)/g, '$1') ?? bare!
    const problem = applyAttribute(format, key!, value)
    if (problem) problems.push(problem)
  }
  return { ok: true, format, problems }
}

function applyClass(format: TextRunFormat, name: string): boolean {
  switch (name) {
    case 'bold':
      format.fontWeight = 700
      return true
    case 'italic':
      format.italic = true
      return true
    case 'underline':
      format.underline = true
      return true
    case 'strike':
    case 'strikethrough':
      format.strikethrough = true
      return true
    default:
      return false
  }
}

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const FUNCTION_COLOR = /^(?:rgb|rgba|hsl|hsla)\([^()]*\)$/i

function applyAttribute(format: TextRunFormat, key: string, value: string): string | null {
  switch (key) {
    case 'color':
    case 'colour':
      if (!HEX_COLOR.test(value) && !FUNCTION_COLOR.test(value)) return `${key}=${value}: expected a hex colour like #e03131`
      format.color = value
      return null
    case 'size': {
      const size = /^[0-9.eE+-]+(?:px)?$/.test(value) ? Number(value.replace(/px$/, '')) : Number.NaN
      if (!(Number.isFinite(size) && size > 0)) return `size=${value}: expected a font size in px`
      format.fontSize = size
      return null
    }
    case 'font':
      format.fontFamily = value
      return null
    case 'weight': {
      const weight = value === 'bold' ? 700 : value === 'normal' ? 400 : /^[0-9.]+$/.test(value) ? Number(value) : Number.NaN
      if (!(weight >= 1 && weight <= 1000)) return `weight=${value}: expected 1-1000 (or bold / normal)`
      format.fontWeight = weight
      return null
    }
    default:
      return `${key}= is not a known attribute (${ATTRIBUTE_HELP})`
  }
}

// ---- 書く ----

// 段落を Markdown にする。flavor 'canvcode'（既定）なら、読み直す（parseRichMarkdown に同じ base を渡す）と、同じ段落と run になる
export function richTextToMarkdown(paragraphs: readonly TextParagraph[], options: RichMarkdownOptions = {}): string {
  const standard = options.flavor === 'standard'
  const normalized = normalizeRichText(
    paragraphs.map((paragraph) => withoutDefaultOffs(paragraph, options.base)),
    options.base,
  )
  const markers = listMarkers(normalized)
  const indents = listIndents(normalized, markers)
  const isList = (i: number) => i >= 0 && i < normalized.length && listOf(normalized[i]!) !== undefined
  const blank = normalized.map((paragraph) => listOf(paragraph) === undefined && paragraph.runs.length === 1 && paragraph.runs[0]!.text === '' && !paragraph.runs[0]!.format)
  // 空の段落の並びの前と後ろの段落（空の段落が多くても 1 回で数える）
  const before: number[] = []
  for (let i = 0, last = -1; i < normalized.length; i++) {
    before.push(last)
    if (!blank[i]) last = i
  }
  const after: number[] = new Array<number>(normalized.length)
  for (let i = normalized.length - 1, next = normalized.length; i >= 0; i--) {
    after[i] = next
    if (!blank[i]) next = i
  }
  const lines = normalized.map((paragraph, i) => {
    const inline = paragraphInline(paragraph.runs, standard)
    const list = listOf(paragraph)
    if (list) {
      const marker = list.type === 'bullet' ? bulletMarker(list) : markers[i]!
      return `${' '.repeat(indents[i]!)}${marker}${inline === '' ? '' : ` ${standard ? inline : spanLeadingSpaces(inline)}`}`
    }
    if (standard) return escapeBlockStart(inline, true)
    // 項目の間の空の段落は []{}（空の行は読み飛ばすので）
    if (blank[i]) return isList(before[i]!) && isList(after[i]!) ? '[]{}' : ''
    // 項目のすぐあとの、空白で始まる段落は、頭の空白を [空白]{} にする（項目の続きと読まないように）
    return isList(i - 1) ? escapeBlockStart(spanLeadingSpaces(inline)) : escapeBlockStart(inline)
  })
  // 2 つ目からの段落の最後が空なら、読むときに落とす最後の改行の分を足す（ほかのアプリへのコピーでは足さない）
  const trailing = !standard && normalized.length > 1 && lines.at(-1) === '' ? '\n' : ''
  return lines.join('\n') + trailing
}

// 斜体・下線・取り消し線の false は、ノードの既定（ふつうはどれも false）と同じなので持たない（書けないので落とす）
function withoutDefaultOffs(paragraph: TextParagraph, base: TextRunFormat | undefined): TextParagraph {
  return {
    ...paragraph,
    runs: paragraph.runs.map((run) => {
      if (!run.format) return run
      const format = { ...run.format }
      for (const key of ['italic', 'underline', 'strikethrough'] as const) if (format[key] === false && base?.[key] !== true) delete format[key]
      return Object.keys(format).length > 0 ? { text: run.text, format } : { text: run.text }
    }),
  }
}

// ほかのアプリへ渡す文字（コピーの text/plain）：太字・斜体・取り消し線・等幅・リストがあれば普通の Markdown（flavor 'standard'）。
// なければ null（プレーンテキストを渡す）。色・大きさ・フォント・下線は渡さない（アプリの中の貼り付けには、別の形式で書式ごと渡す）
export function standardMarkdownOf(paragraphs: readonly TextParagraph[], base?: TextRunFormat): string | null {
  const normalized = normalizeRichText(paragraphs, base)
  const formatted = normalized.some(
    (paragraph) => listOf(paragraph) !== undefined || paragraph.runs.some((run) => run.text !== '' && (marksOf(run.format).length > 0 || run.format?.fontFamily === MARKDOWN_CODE_FONT)),
  )
  return formatted ? richTextToMarkdown(normalized, { base, flavor: 'standard' }) : null
}

// 書式（既定から変えたもの）かリストを持つか。持たなければ、プレーンテキストと同じ。空の文字の書式（空の段落で打つ文字の書式）は数えない
export function hasRichFormatting(paragraphs: readonly TextParagraph[], base?: TextRunFormat): boolean {
  return normalizeRichText(paragraphs, base).some((paragraph) => listOf(paragraph) !== undefined || paragraph.runs.some((run) => run.format !== undefined && run.text !== ''))
}

function bulletMarker(list: TextList): string {
  const style = list.style
  return !style || style === defaultStyle('bullet', list.level) ? '-' : BULLET_GLYPHS[style as BulletStyle]
}

// リストの段落の字下げ：親（前にある 1 段浅い項目）の文字の頭にそろえる（CommonMark でも入れ子になる）。親がなければ階層 × 2
function listIndents(paragraphs: readonly TextParagraph[], markers: readonly (string | null)[]): number[] {
  const indents: number[] = []
  const markerWidth = (i: number) => {
    const list = listOf(paragraphs[i]!)!
    return [...(list.type === 'bullet' ? bulletMarker(list) : markers[i]!)].length
  }
  // 階層ごとの、いちばん近い前の項目（リストが途切れたら忘れる）
  let latest: (number | undefined)[] = []
  for (const [i, paragraph] of paragraphs.entries()) {
    const list = listOf(paragraph)
    if (!list) {
      indents.push(0)
      latest = []
      continue
    }
    let parent: number | undefined
    for (let level = list.level - 1; level >= 0 && parent === undefined; level--) parent = latest[level]
    indents.push(parent === undefined ? list.level * 2 : indents[parent]! + markerWidth(parent) + 1)
    latest = latest.slice(0, list.level)
    latest[list.level] = i
  }
  return indents
}

// 頭の空白（スペース・タブ）を [空白]{} にする（字下げ・項目の続きと読まないように）
function spanLeadingSpaces(inline: string): string {
  const spaces = inline.length - trimStartSpaces(inline).length
  return spaces === 0 ? inline : `[${inline.slice(0, spaces)}]{}${inline.slice(spaces)}`
}

// リストでない段落の頭が、リスト・見出しの記号に見えるなら、\ を付けて文字にする。
// standard（ほかのアプリの Markdown）なら、引用（>）と区切り線・見出しの下線（--- ===）に見える行も
function escapeBlockStart(line: string, standard = false): string {
  const match = /^([ \t\u3000]*)(.*)$/s.exec(line)!
  const [, indent, rest] = match
  const escaped = (() => {
    if (standard && (rest!.startsWith('>') || /^(?:-[ \t]*){2,}$|^=+[ \t]*$/.test(rest!))) return `\\${rest}`
    if (/^[-*+](?:[ \t]|$)/.test(rest!) || /^[\u2022\u25e6\u25aa\u2013\u2713\u2460-\u2473\u3251-\u325f\u32b1-\u32bf](?:[ \t]|$)/.test(rest!)) return `\\${rest}`
    if (/^\(\d{1,9}\)(?:[ \t]|$)/.test(rest!)) return `\\${rest}`
    // 英字は、番号になりうるもの（2 文字までの英字か、ローマ数字。702 番まで）だけ
    const numbered = /^(\d{1,9}|[a-z]{1,2}|[ivxlcdm]{1,12})([.)])(?=[ \t]|$)/.exec(rest!)
    if (numbered && (numbered[2] === '.' || /^\d/.test(numbered[1]!))) return `${numbered[1]}\\${rest!.slice(numbered[1]!.length)}`
    if (/^#{1,6}(?:[ \t]|$)/.test(rest!)) return `\\${rest}`
    return rest!
  })()
  return indent + escaped
}

type Mark = 'bold' | 'italic' | 'strike'
const DELIMITERS: Record<Mark, string> = { bold: '**', italic: '*', strike: '~~' }

// run の文字を、空白（前・後ろ）と中身に分けたもの
interface Segment {
  text: string
  space: boolean
  format: TextRunFormat | undefined
}

function paragraphInline(runs: readonly TextRun[], standard: boolean): string {
  const clean = runs.map((run) => ({ ...run, text: run.text.replace(/[\r\n]/g, ' ') }))
  if (clean.length === 1 && clean[0]!.text === '') return clean[0]!.format && !standard ? spanMarkdown('', attributesOf(clean[0]!.format, ALL_MARKS)) : ''
  const delimited = delimitedInline(clean, standard)
  if (standard) return delimited
  // 読み直して同じになるかを確かめる。違えば、書式のある文字をすべて [文字]{属性} で書く
  if (sameRuns(parseInline(delimited, () => {}), clean)) return delimited
  return spanOnlyInline(clean)
}

function sameRuns(a: readonly TextRun[], b: readonly TextRun[]): boolean {
  const na = normalizeRichText([{ runs: [...a] }])[0]!.runs
  const nb = normalizeRichText([{ runs: [...b] }])[0]!.runs
  return na.length === nb.length && na.every((run, i) => run.text === nb[i]!.text && sameFormat(run.format, nb[i]!.format))
}

function marksOf(format: TextRunFormat | undefined): Mark[] {
  const marks: Mark[] = []
  if (format?.fontWeight === 700) marks.push('bold')
  if (format?.italic === true) marks.push('italic')
  if (format?.strikethrough === true) marks.push('strike')
  return marks
}

const ALL_MARKS: readonly Mark[] = ['bold', 'italic', 'strike']

// 分けるのは太字・斜体・取り消し線を持つ run だけ（記号の内側が空白で始まる・終わると閉じられないため）
function splitSpaces(run: TextRun): Segment[] {
  const text = run.text
  let start = 0
  while (start < text.length && isSpace(text[start]!)) start++
  if (start === text.length) return [{ text, space: true, format: run.format }]
  if (marksOf(run.format).length === 0) return [{ text, space: false, format: run.format }]
  let end = text.length
  while (end > start && isSpace(text[end - 1]!)) end--
  const out: Segment[] = []
  if (start > 0) out.push({ text: text.slice(0, start), space: true, format: run.format })
  out.push({ text: text.slice(start, end), space: false, format: run.format })
  if (end < text.length) out.push({ text: text.slice(end), space: true, format: run.format })
  return out
}

// **・*・~~ を使う書き方。記号は続く run の間は開けたままにし、長く続くものを外側にする
function delimitedInline(runs: readonly TextRun[], standard: boolean): string {
  const segments = runs.flatMap(splitSpaces)
  const marks = segments.map((segment) => marksOf(segment.format))
  const has = (i: number, mark: Mark) => marks[i]!.includes(mark)
  // 空白の部分の書式を記号で書けるのは、前と後ろに同じ書式の空白でない文字が続くときだけ（記号の内側が空白で始まる・終わると閉じられない）
  const delimiters = segments.map((segment, i) => {
    if (!segment.space) return marks[i]!
    return marks[i]!.filter((mark) => {
      let before = false
      for (let j = i - 1; j >= 0 && has(j, mark); j--) {
        if (!segments[j]!.space) {
          before = true
          break
        }
      }
      let after = false
      for (let k = i + 1; k < segments.length && has(k, mark); k++) {
        if (!segments[k]!.space) {
          after = true
          break
        }
      }
      return before && after
    })
  })
  const extent = (i: number, mark: Mark) => {
    let k = i
    while (k < segments.length && delimiters[k]!.includes(mark)) k++
    return k - i
  }
  let out = ''
  const stack: Mark[] = []
  for (const [i, segment] of segments.entries()) {
    const want = delimiters[i]!
    let keep = 0
    while (keep < stack.length && want.includes(stack[keep]!)) keep++
    while (stack.length > keep) out += DELIMITERS[stack.pop()!]
    const open = want.filter((mark) => !stack.includes(mark)).sort((a, b) => extent(i, b) - extent(i, a))
    for (const mark of open) {
      out += DELIMITERS[mark]
      stack.push(mark)
    }
    // 記号で書けなかった太字などは、属性（.bold など）として書く（standard では書かない）
    const rest = standard ? [] : marks[i]!.filter((mark) => !want.includes(mark))
    out += segmentMarkdown(segment, rest, false, standard)
  }
  while (stack.length > 0) out += DELIMITERS[stack.pop()!]
  return out
}

// 書式のある文字をすべて [文字]{属性} で書く（記号の組み合わせで読み違えないように。文字の中の [ ] もすべて \ を付ける）
function spanOnlyInline(runs: readonly TextRun[]): string {
  return runs.map((run) => segmentMarkdown({ text: run.text, space: false, format: run.format }, ALL_MARKS, true, false)).join('')
}

// 1 つの部分。classes は記号で書けなかった太字などで、属性（.bold など）として書く。code は等幅の文字（`…` で書けるなら）。
// standard では属性を書かない（[ ]{ } は普通の Markdown にない）
function segmentMarkdown(segment: Segment, classes: readonly Mark[], escapeBrackets: boolean, standard: boolean): string {
  const format = segment.format
  const code = format?.fontFamily === MARKDOWN_CODE_FONT && canBeCode(segment.text)
  const attributes = standard ? [] : attributesOf(format, classes, code)
  const inner = code ? `\`${segment.text}\`` : escapeText(segment.text, attributes.length > 0 || escapeBrackets, standard)
  return attributes.length > 0 ? spanMarkdown(inner, attributes, true) : inner
}

function canBeCode(text: string): boolean {
  return text !== '' && !text.includes('`') && !isSpace(text[0]!) && !isSpace(text.at(-1)!)
}

function spanMarkdown(inner: string, attributes: readonly string[], escaped = false): string {
  return `[${escaped ? inner : escapeText(inner, true)}]{${attributes.join(' ')}}`
}

// [文字]{属性} の属性（太字・斜体・取り消し線は classes にあるときだけ。code なら等幅のフォントは `…` で書くので入れない）
function attributesOf(format: TextRunFormat | undefined, classes: readonly Mark[], code = false): string[] {
  if (!format) return []
  const out: string[] = []
  if (format.color !== undefined) out.push(`color=${attributeValue(format.color)}`)
  if (format.fontSize !== undefined) out.push(`size=${String(format.fontSize)}`)
  if (format.fontFamily !== undefined && !code) out.push(`font=${attributeValue(format.fontFamily)}`)
  if (format.fontWeight !== undefined && format.fontWeight !== 700) out.push(`weight=${format.fontWeight}`)
  if (format.fontWeight === 700 && classes.includes('bold')) out.push('.bold')
  if (format.italic === true && classes.includes('italic')) out.push('.italic')
  if (format.underline === true) out.push('.underline')
  if (format.strikethrough === true && classes.includes('strike')) out.push('.strike')
  return out
}

function attributeValue(value: string): string {
  return /^[\w#.-]+$/.test(value) ? value : `"${value.replace(/["\\]/g, '\\$&')}"`
}

// 文字の中の記号に \ を付ける。brackets なら [ ] すべて（[文字]{属性} の中）、そうでなければ ]{ の ] だけ。
// underscores なら、英数字に挟まれていない _ も（ほかのアプリの Markdown は _ を書式として読む）
function escapeText(text: string, brackets: boolean, underscores = false): string {
  let out = ''
  const chars = [...text]
  for (const [i, char] of chars.entries()) {
    const after = chars[i + 1]
    if (char === '*' || char === '~' || char === '`') out += `\\${char}`
    else if (char === '_' && underscores && !(isAsciiWord(chars[i - 1] ?? ' ') && isAsciiWord(after ?? ' '))) out += '\\_'
    else if (char === '\\') out += isEscapable(after) || after === undefined ? '\\\\' : '\\'
    else if (char === '[' && brackets) out += '\\['
    else if (char === ']' && (brackets || after === '{')) out += '\\]'
    else out += char
  }
  return out
}

// ---- 編集中の入力 ----

// 編集中に、閉じる記号を打って書式にする所（**太字** など。テキストの編集で、打った文字を書式に変える）。
// start〜end が記号を含む全体、innerStart〜innerEnd が書式を当てる中身（段落の頭からの位置）
export interface MarkdownShortcut {
  start: number
  innerStart: number
  innerEnd: number
  end: number
  format: TextRunFormat
}

const SHORTCUTS: { delimiter: string; format: TextRunFormat }[] = [
  { delimiter: '**', format: { fontWeight: 700 } },
  { delimiter: '~~', format: { strikethrough: true } },
  { delimiter: '*', format: { italic: true } },
  { delimiter: '`', format: { fontFamily: MARKDOWN_CODE_FONT } },
]

// text は段落の頭から、いま打った文字（閉じる記号の最後の 1 文字）までの文字。書式にできなければ null。
// 中身は空白で始まらず・終わらず、記号の文字を含まない。記号が \ のあとにあれば変えない。
// 1 つだけの * は英数字の後ろでは開かない（2*3 と打っている途中で変えない）。[文字]{属性} は、属性がすべて読めるときだけ
export function markdownShortcutAt(text: string): MarkdownShortcut | null {
  const end = text.length
  for (const { delimiter, format } of SHORTCUTS) {
    const shortcut = delimitedShortcut(text, delimiter)
    if (shortcut) return { ...shortcut, end, format: { ...format } }
  }
  return spanShortcut(text)
}

function delimitedShortcut(text: string, delimiter: string): Omit<MarkdownShortcut, 'end' | 'format'> | null {
  const char = delimiter[0]!
  const closeStart = text.length - delimiter.length
  if (closeStart < 1 || !text.endsWith(delimiter) || text[closeStart - 1] === char) return null
  // 中身は記号の文字を含まないので、開く記号は、閉じる記号の前でいちばん近い記号の文字
  const last = text.lastIndexOf(char, closeStart - 1)
  if (last < 0) return null
  const start = last - delimiter.length + 1
  if (start < 0 || text.slice(start, last + 1) !== delimiter || text[start - 1] === char || text[start - 1] === '\\') return null
  const inner = text.slice(last + 1, closeStart)
  // `等幅` の中は、前後の両方の空白を 1 つずつ落とす（読むときと同じ）。ほかは空白で始まる・終わる中身を書式にしない
  if (char === '`') {
    if (inner.trim() === '') return null
    const content = codeContent(inner)
    const offset = content.length === inner.length ? 0 : 1
    return { start, innerStart: last + 1 + offset, innerEnd: last + 1 + offset + content.length }
  }
  if (inner === '' || isSpace(inner[0]!) || isSpace(inner.at(-1)!) || inner.endsWith('\\')) return null
  if (delimiter === '*' && isAsciiWord(charBefore(text, start))) return null
  return { start, innerStart: last + 1, innerEnd: closeStart }
}

function spanShortcut(text: string): MarkdownShortcut | null {
  if (!text.endsWith('}')) return null
  const brace = text.lastIndexOf('{')
  if (brace < 1 || text[brace - 1] !== ']' || text[brace - 2] === '\\') return null
  const open = text.lastIndexOf('[', brace - 2)
  if (open < 0 || text[open - 1] === '\\') return null
  const inner = text.slice(open + 1, brace - 1)
  if (inner === '' || inner.includes(']')) return null
  const attributes = parseAttributes(text.slice(brace + 1, -1))
  if (!attributes.ok || attributes.problems.length > 0 || Object.keys(attributes.format).length === 0) return null
  return { start: open, innerStart: open + 1, innerEnd: brace - 1, end: text.length, format: attributes.format }
}
