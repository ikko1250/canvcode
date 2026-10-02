import { DEFAULT_FONT_FAMILY, fontFamilyCss, registerTextMetricsCache, requestFontLoad } from './fonts.ts'
import { richTextFromPlain, type TextParagraph, type TextRunFormat } from './richText.ts'

// 文字のレイアウトと描画（MAI-24）。テキスト・付箋・図形のラベルで共通に使う。
// テキストと付箋は、範囲ごとに書式（色・大きさ）を持てる（MAI-74。richText.ts）。行の高さは、行の中の最も大きい文字に合わせる。
// 折り返しは、編集用の DOM（CSS の white-space: pre-wrap）となるべく同じ位置になるようにする。
// - 英数字は単語の区切り（空白）で折り返す。1 語が幅に収まらなければ、文字の途中で折り返す
// - 日本語などは文字ごとに折り返す
// - 行頭に来てはいけない句読点・閉じ括弧・小書きの仮名などは、前の文字とくっつけて扱う（簡単な禁則処理）。
//   CSS の line-break: strict に合わせているので、編集用の DOM にも line-break: strict を指定する

// 行間（行の高さ）はノード単位で、倍率か px（MAI-76。LineHeight）。CSS の line-height と同じく、倍率は文字ごとの大きさに掛け、px は文字の大きさによらない。
// フォントは fonts.ts（MAI-75）。テキストと付箋は範囲ごとにフォントを変えられ、ほかは既定のフォント（TEXT_FONT_FAMILY）

export type TextAlign = 'left' | 'center' | 'right'

export interface TextStyle {
  fontSize: number
  // 行の高さ（fontSize に対する倍率。CSS の line-height: 1.35 と同じく、文字ごとにその文字の大きさに掛ける）
  lineHeight: number
  // 行の高さを px で決めるとき（CSS の line-height: 24px と同じく、文字の大きさによらない）。あれば lineHeight より優先する（MAI-76）
  fixedLineHeight?: number
  fontWeight: 400 | 700
  color: string
  align: TextAlign
  // フォントの名前（fonts.ts）。なければ既定のフォント（MAI-75）
  fontFamily?: string
}

// ノードの props に持つ行の高さ（MAI-76）。倍率（multiplier）か px。
// 持たない（古い）ノードは、型ごとの既定の倍率（テキスト 1.35、付箋 1.4）で描く
export type LineHeightUnit = 'multiplier' | 'px'

export interface LineHeight {
  unit: LineHeightUnit
  value: number
}

// 行の高さの範囲（デザインパネルで入れられる値）
export const LINE_HEIGHT_LIMITS: Record<LineHeightUnit, { min: number; max: number }> = {
  multiplier: { min: 0.5, max: 10 },
  px: { min: 1, max: 1000 },
}

// props の行の高さを、TextStyle の lineHeight・fixedLineHeight にする。読めない値（壊れたデータ）は既定の倍率として扱う
export function lineHeightStyle(lineHeight: LineHeight | undefined, defaultMultiplier: number): Pick<TextStyle, 'lineHeight' | 'fixedLineHeight'> {
  const value = lineHeight?.value
  const unit = lineHeight?.unit
  if ((unit !== 'px' && unit !== 'multiplier') || typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return { lineHeight: defaultMultiplier }
  return unit === 'px' ? { lineHeight: defaultMultiplier, fixedLineHeight: value } : { lineHeight: value }
}

// style の行の高さを、props の形にする（パネルで見せる値。既定の倍率のノードは、その倍率）
export function lineHeightOf(style: Pick<TextStyle, 'lineHeight' | 'fixedLineHeight'>): LineHeight {
  return style.fixedLineHeight !== undefined ? { unit: 'px', value: style.fixedLineHeight } : { unit: 'multiplier', value: style.lineHeight }
}

// 行の高さを、見た目を変えずに別の単位へ直す。fontSize はノードの既定の文字の大きさ（行の中の文字が混ざっていれば、その既定で換算する）
export function convertLineHeight(lineHeight: LineHeight, unit: LineHeightUnit, fontSize: number): LineHeight {
  if (lineHeight.unit === unit) return lineHeight
  const value = unit === 'px' ? lineHeight.value * fontSize : lineHeight.value / fontSize
  return { unit, value: Number(value.toFixed(unit === 'px' ? 1 : 2)) }
}

// 文字 1 つ分の行の高さ（CSS の inline box の高さ。px）
export function lineBoxHeight(style: Pick<TextStyle, 'fontSize' | 'lineHeight' | 'fixedLineHeight'>): number {
  return style.fixedLineHeight ?? style.fontSize * style.lineHeight
}

// 編集用の DOM に指定する line-height（子の要素に継ぐ。倍率は文字ごとの大きさに、px はそのまま効く）
export function cssLineHeight(style: Pick<TextStyle, 'lineHeight' | 'fixedLineHeight'>): string {
  return style.fixedLineHeight !== undefined ? `${style.fixedLineHeight}px` : String(style.lineHeight)
}

// テキストと付箋の文字の大きさの段階（MAI-50）。パレットの「大きく」「小さく」で、この中を行き来する
export const TEXT_FONT_SIZES = [12, 16, 20, 22, 24, 32, 48, 64] as const

// 今の大きさから、1 段階大きい（direction が 1）か小さい（-1）大きさ。
// 段階にない大きさ（取り込んだものなど）からは、その向きで最も近い段階へ移る。端に達していればそのまま
export function stepFontSize(fontSize: number, direction: 1 | -1): number {
  if (direction === 1) return TEXT_FONT_SIZES.find((size) => size > fontSize) ?? fontSize
  return [...TEXT_FONT_SIZES].reverse().find((size) => size < fontSize) ?? fontSize
}

// 古いレコードには align がないので、なければ左揃えとして扱う（MAI-50）
export function textAlignOf(align: TextAlign | undefined): TextAlign {
  return align ?? 'left'
}

// 1 行の中の、同じ書式の文字の続き（MAI-74）
export interface TextSegment {
  text: string
  // 行の左端からの位置
  x: number
  width: number
  style: TextStyle
}

export interface TextLine {
  text: string
  width: number
  // 書式ごとの文字の続き（左から順）
  segments: TextSegment[]
  // レイアウトの上端から、行の上端までの距離と行の高さ
  top: number
  height: number
  // 行の上端から、ベースラインまでの距離
  baseline: number
  // 行の中で最も大きい文字の大きさ
  fontSize: number
}

export interface TextLayout {
  lines: TextLine[]
  // いちばん長い行の幅
  width: number
  height: number
  // 1 行目の高さ（クリックした点を 1 行目の中ほどに置くときなどに使う）
  lineHeightPx: number
  // 最も大きい文字の大きさ（ズームアウト時に帯で描くかを決める）
  maxFontSize: number
}

export function cssFont(style: Pick<TextStyle, 'fontSize' | 'fontWeight' | 'fontFamily'>): string {
  return `${style.fontWeight} ${style.fontSize}px ${fontFamilyCss(style.fontFamily)}`
}

// ノードの既定のスタイルから、run の書式の既定（run が持たない値）を作る（MAI-74、MAI-75）
export function baseFormatOf(style: TextStyle): Required<TextRunFormat> {
  return { color: style.color, fontSize: style.fontSize, fontFamily: style.fontFamily ?? DEFAULT_FONT_FAMILY }
}

// ---- 文字幅の計測 ----

type Measure = (text: string) => number

let measureContext: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null | undefined

function getMeasureContext() {
  if (measureContext !== undefined) return measureContext
  if (typeof OffscreenCanvas !== 'undefined') measureContext = new OffscreenCanvas(1, 1).getContext('2d')
  else if (typeof document !== 'undefined') measureContext = document.createElement('canvas').getContext('2d')
  else measureContext = null
  return measureContext
}

const widthCache = new Map<string, Map<string, number>>()
registerTextMetricsCache(() => widthCache.clear())

// フォントごとに、語の幅をキャッシュして測る。Canvas がない環境（Node でのテスト）では概算する
function measurerFor(style: TextStyle): Measure {
  const font = cssFont(style)
  let cache = widthCache.get(font)
  if (!cache) {
    cache = new Map()
    widthCache.set(font, cache)
  }
  const ctx = getMeasureContext()
  return (text) => {
    let width = cache.get(text)
    if (width === undefined) {
      if (ctx) {
        // Web フォントなら読み込みを頼む（読み込み終えたら、キャッシュを捨てて測り直す。fonts.ts）
        requestFontLoad(style.fontFamily, font, text)
        ctx.font = font
        width = ctx.measureText(text).width
      } else {
        width = approximateWidth(text, style.fontSize)
      }
      cache.set(text, width)
    }
    return width
  }
}

function approximateWidth(text: string, fontSize: number): number {
  let width = 0
  for (const ch of text) width += isWide(ch) ? fontSize : ch === ' ' ? fontSize * 0.3 : fontSize * 0.55
  return width
}

// フォントの上下の高さ（ベースラインから上と下。CSS ピクセル）。DOM（編集中の文字）と同じ値を使うため、Canvas から読む。
// 読めない環境（Node でのテスト、古いブラウザ）では概算する
const metricsCache = new Map<string, { ascent: number; descent: number }>()
registerTextMetricsCache(() => metricsCache.clear())

function fontMetrics(style: TextStyle): { ascent: number; descent: number } {
  const font = cssFont(style)
  let metrics = metricsCache.get(font)
  if (!metrics) {
    const ctx = getMeasureContext()
    let measured: TextMetrics | undefined
    if (ctx) {
      ctx.font = font
      measured = ctx.measureText('M')
    }
    metrics =
      measured && measured.fontBoundingBoxAscent > 0
        ? { ascent: measured.fontBoundingBoxAscent, descent: measured.fontBoundingBoxDescent }
        : { ascent: style.fontSize * 0.88, descent: style.fontSize * 0.12 }
    metricsCache.set(font, metrics)
  }
  return metrics
}

// 1 行の高さとベースラインの位置。CSS と同じく、文字ごとに行の高さ（lineBoxHeight。倍率なら fontSize × lineHeight、px ならその値）の箱を
// ベースラインにそろえて並べ、その上端から下端までを行の高さにする（箱が文字より低ければ、上下の余白は負になる。CSS と同じ）。
// strut は段落の要素自身の文字（編集中の DOM では、段落の中で最も小さい文字）
function lineBox(styles: readonly TextStyle[], strut: TextStyle): { height: number; baseline: number } {
  let above = -Infinity
  let below = -Infinity
  let aboveStyle: TextStyle = strut
  let belowStyle: TextStyle = strut
  for (const style of [...styles, strut]) {
    const { ascent, descent } = fontMetrics(style)
    const box = lineBoxHeight(style)
    const top = ascent + (box - ascent - descent) / 2
    if (top > above) {
      above = top
      aboveStyle = style
    }
    if (box - top > below) {
      below = box - top
      belowStyle = style
    }
  }
  // 1 つの書式だけなら箱の高さちょうど（足し算の誤差を出さない）
  const height = aboveStyle === belowStyle ? lineBoxHeight(aboveStyle) : above + below
  return { height, baseline: above }
}

// ---- 折り返しの単位 ----

// 行頭に来てはいけない文字（前の文字とくっつける）
export const NO_BREAK_BEFORE = new Set('、。，．,.・：；:;？！?!ー～…‥）」』】〕｝〉》〙〗］)]}ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ々〻゛゜')
// 行末に来てはいけない文字（後ろの文字とくっつける）
export const NO_BREAK_AFTER = new Set('（「『【〔｛〈《〘〖［([{')

function isWide(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

// 1 段落（改行を含まない）を、折り返してよい単位に分ける。空白は直前の単位の後ろに付ける
export function breakUnits(paragraph: string): string[] {
  const chars = [...paragraph]
  const units: string[] = []
  let current = ''
  const flush = () => {
    if (current) units.push(current)
    current = ''
  }
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    if (ch === ' ' || ch === '\t') {
      current += ch
      flush()
    } else if (isWide(ch)) {
      // 全角の文字は 1 文字ずつ。ただし行頭禁則の文字は前に、行末禁則の文字は後ろにくっつける
      if (NO_BREAK_BEFORE.has(ch) || (current && NO_BREAK_AFTER.has([...current].at(-1)!))) {
        current += ch
      } else {
        flush()
        current = ch
      }
    } else {
      // 英数字は、全角の文字の直後なら新しい単位にする（行末禁則の文字の直後は除く）
      const last = [...current].at(-1)
      if (last && isWide(last) && !NO_BREAK_AFTER.has(last)) flush()
      current += ch
    }
  }
  flush()
  return units
}

// ---- レイアウト ----

// 書式を既定に重ねた、run の文字のスタイル（MAI-74）
export function runStyle(base: TextStyle, format: TextRunFormat | undefined): TextStyle {
  if (!format) return base
  return {
    ...base,
    fontSize: format.fontSize ?? base.fontSize,
    color: format.color ?? base.color,
    fontFamily: format.fontFamily ?? base.fontFamily,
  }
}

// プレーンテキストのレイアウト（図形・矢印のラベル、引用ノートなど）。maxWidth が null なら折り返さない（段落ごとに 1 行）
export function layoutText(text: string, style: TextStyle, maxWidth: number | null): TextLayout {
  return layoutRichText(richTextFromPlain(text), style, maxWidth)
}

// 範囲ごとに書式を持つテキストのレイアウト（MAI-74）。base はノードの既定のスタイル（揃え・行の高さは base のものを使う）。
// 折り返しの単位（breakUnits）は書式をまたいで決め、幅は書式ごとに測って足す
export function layoutRichText(paragraphs: readonly TextParagraph[], base: TextStyle, maxWidth: number | null): TextLayout {
  const lines: TextLine[] = []
  let top = 0
  for (const paragraph of paragraphs) {
    const runs = paragraph.runs.length > 0 ? paragraph.runs : [{ text: '' }]
    const styles = runs.map((run) => runStyle(base, run.format))
    const text = runs.map((run) => run.text).join('')
    const starts: number[] = []
    let offset = 0
    for (const run of runs) {
      starts.push(offset)
      offset += run.text.length
    }
    // 空の段落は、編集中の DOM では段落の要素がその書式（大きさ・フォント）を持つので、strut もその書式にする（richTextDom.ts）
    const strut: TextStyle = text === '' ? styles[0] : { ...base, fontSize: Math.min(...styles.map((style) => style.fontSize)) }
    const styleAt = (at: number): TextStyle => {
      for (let i = runs.length - 1; i >= 0; i--) if (starts[i] <= at && runs[i].text.length > 0) return styles[i]
      return styles[0]
    }
    const segmentsOf = (from: number, to: number): TextSegment[] => {
      const segments: TextSegment[] = []
      let x = 0
      for (const [i, run] of runs.entries()) {
        const a = Math.max(from, starts[i])
        const b = Math.min(to, starts[i] + run.text.length)
        if (a >= b) continue
        const part = text.slice(a, b)
        const width = measurerFor(styles[i])(part)
        segments.push({ text: part, x, width, style: styles[i] })
        x += width
      }
      return segments
    }
    const measureRange = (from: number, to: number): number => segmentsOf(from, to).reduce((sum, s) => sum + s.width, 0)
    const pushLine = (from: number, to: number, trim: boolean) => {
      // 行末の空白は幅に数えない（CSS と同じ）
      let end = to
      if (trim) while (end > from && (text[end - 1] === ' ' || text[end - 1] === '\t')) end--
      const segments = segmentsOf(from, end)
      const lineStyles = segments.length > 0 ? segments.map((s) => s.style) : [styleAt(from)]
      const box = lineBox(lineStyles, strut)
      lines.push({
        text: text.slice(from, end),
        width: segments.reduce((sum, s) => sum + s.width, 0),
        segments,
        top,
        height: box.height,
        baseline: box.baseline,
        fontSize: Math.max(...lineStyles.map((style) => style.fontSize)),
      })
      top += box.height
    }
    if (maxWidth === null) {
      pushLine(0, text.length, false)
      continue
    }
    let lineStart = 0
    let lineEnd = 0
    let lineWidth = 0
    let unitStart = 0
    for (const unit of breakUnits(text)) {
      const unitEnd = unitStart + unit.length
      const unitWidth = measureRange(unitStart, unitStart + unit.replace(/[ \t]+$/, '').length)
      if (lineEnd > lineStart && lineWidth + unitWidth > maxWidth) {
        pushLine(lineStart, lineEnd, true)
        lineStart = lineEnd
        lineWidth = 0
      }
      if (lineEnd === lineStart && unitWidth > maxWidth) {
        // 1 語が幅に収まらない：文字の途中で折り返す
        let at = unitStart
        for (const ch of unit) {
          const next = at + ch.length
          if (lineEnd > lineStart && measureRange(lineStart, next) > maxWidth) {
            pushLine(lineStart, lineEnd, true)
            lineStart = lineEnd
          }
          lineEnd = next
          lineWidth = measureRange(lineStart, lineEnd)
          at = next
        }
      } else {
        lineEnd = unitEnd
        lineWidth = measureRange(lineStart, lineEnd)
      }
      unitStart = unitEnd
    }
    pushLine(lineStart, lineEnd, true)
  }
  const width = lines.reduce((max, l) => Math.max(max, l.width), 0)
  return {
    lines,
    width,
    height: lines.length > 0 ? top : lineBoxHeight(base),
    lineHeightPx: lines[0]?.height ?? lineBoxHeight(base),
    maxFontSize: lines.reduce((max, l) => Math.max(max, l.fontSize), 0) || base.fontSize,
  }
}

// ---- 描画 ----

function lineLeft(line: TextLine, align: TextAlign, box: { x: number; w: number }): number {
  return align === 'left' ? box.x : align === 'center' ? box.x + (box.w - line.width) / 2 : box.x + box.w - line.width
}

// box（ローカル座標）の中に描く。verticalAlign が middle なら、上下の中央に置く。
// 文字の色・大きさは行の中の書式ごと（segments）。style は揃えに使う
export function drawTextLayout(
  ctx: CanvasRenderingContext2D,
  layout: TextLayout,
  style: TextStyle,
  box: { x: number; y: number; w: number; h: number },
  verticalAlign: 'top' | 'middle',
): void {
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  const top = verticalAlign === 'middle' ? box.y + (box.h - layout.height) / 2 : box.y
  let font = ''
  for (const line of layout.lines) {
    const x = lineLeft(line, style.align, box)
    const y = top + line.top + line.baseline
    for (const segment of line.segments) {
      const segmentFont = cssFont(segment.style)
      if (segmentFont !== font) ctx.font = font = segmentFont
      ctx.fillStyle = segment.style.color
      ctx.fillText(segment.text, x + segment.x, y)
    }
  }
}

// ズームアウト時の簡略表示：行ごとに灰色の帯を描く（MAI-14）
export function drawTextBars(
  ctx: CanvasRenderingContext2D,
  layout: TextLayout,
  style: TextStyle,
  box: { x: number; y: number; w: number; h: number },
  verticalAlign: 'top' | 'middle',
): void {
  ctx.fillStyle = 'rgba(120, 120, 120, 0.45)'
  const top = verticalAlign === 'middle' ? box.y + (box.h - layout.height) / 2 : box.y
  for (const line of layout.lines) {
    if (!line.width) continue
    const barH = line.fontSize * 0.6
    ctx.fillRect(lineLeft(line, style.align, box), top + line.top + line.height / 2 - barH / 2, line.width, barH)
  }
}

// 画面上の文字の大きさがこれより小さければ、帯で描く（CSS ピクセル）
export const TEXT_BAR_THRESHOLD_PX = 5
