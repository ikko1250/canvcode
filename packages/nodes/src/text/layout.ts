import { DEFAULT_FONT_FAMILY, fontFamilyCss, registerTextMetricsCache, requestFontLoad } from './fonts.ts'
import { FONT_WEIGHT_BOLD, listMarkers, listOf, richTextFromPlain, type TextParagraph, type TextRunFormat } from './richText.ts'

// 文字のレイアウトと描画（MAI-24）。テキスト・付箋・図形のラベルで共通に使う。
// テキストと付箋は、範囲ごとに書式（色・大きさ）を持てる（MAI-74。richText.ts）。行の高さは、行の中の最も大きい文字に合わせる。
// 折り返しは、編集用の DOM（CSS の white-space: pre-wrap）となるべく同じ位置になるようにする。
// - 英数字は単語の区切り（空白）で折り返す。1 語が幅に収まらなければ、文字の途中で折り返す
// - 日本語などは文字ごとに折り返す
// - 行頭に来てはいけない句読点・閉じ括弧・小書きの仮名などは、前の文字とくっつけて扱う（簡単な禁則処理）。
//   CSS の line-break: strict に合わせているので、編集用の DOM にも line-break: strict を指定する

// 行間（行の高さ）はノード単位で、倍率か px（MAI-76。LineHeight）。CSS の line-height と同じく、倍率は文字ごとの大きさに掛け、px は文字の大きさによらない。
// フォントは fonts.ts（MAI-75）。テキストと付箋は範囲ごとにフォントを変えられ、ほかは既定のフォント（TEXT_FONT_FAMILY）
// 文字間（letter-spacing）はノード単位で、em（文字の大きさに対する割合。MAI-77）。CSS の letter-spacing と同じく、
// 文字（書記素）ごとに、その文字の大きさで換算した空きを文字の後ろに足す（行末の文字の後ろにも付き、行の幅・折り返しに数える）。
// Canvas2D の ctx.letterSpacing が使えれば測り・描画ともそれを使い、使えなければ、文字の数 × 空きを足して測り、文字ごとにずらして描く
// 箇条書き・番号付きリスト（MAI-78。richText.ts の TextList）の段落は、ぶら下げインデントにする：
// - 文字は左から（階層 + 1）× listIndentStep の位置から始まり、折り返した行もそこにそろう（幅はその分だけ狭くなる）
// - 記号・番号は 1 行目の文字の左の、幅 listIndentStep の溝に右寄せで置き、文字との間を listMarkerGap だけ空ける。
//   溝に収まらない（長い番号）ときは溝の左端から置き、文字の側へはみ出す（編集中の DOM の ::before と同じ。richTextDom.ts）
// - 記号・番号の大きさ・色・フォントは段落の最初の run の書式（文字間は付けない）。1 行目の行の高さには、その文字としても数える
// - 段差と空きはノードの既定の文字の大きさ（base.fontSize）に対する割合で、段落の文字の大きさによらない（階層ごとにそろう）
// - 揃え（中央・右）は、段差を除いた幅の中でそろえる。記号は 1 行目の文字の左に付いて動く
// 太字・斜体（MAI-79）は CSS の font（cssFont）の太さ・斜体で測り・描く。下線・取り消し線（MAI-79）は textDecorations で、
// 折り返した行ごと・run ごとに、その文字の色・大きさに合わせた太さと位置で引く。行末の文字間の空きと、リストの記号には引かない。
// 編集中の DOM は CSS の text-decoration を使わず、同じ textDecorations の線を重ねて描く（textEditor.ts。ブラウザごとの線の位置の違いや、
// CSS が行末の文字間・空白の下にも線を引くのを避け、Canvas と同じ見た目にする）

export type TextAlign = 'left' | 'center' | 'right'

export interface TextStyle {
  fontSize: number
  // 行の高さ（fontSize に対する倍率。CSS の line-height: 1.35 と同じく、文字ごとにその文字の大きさに掛ける）
  lineHeight: number
  // 行の高さを px で決めるとき（CSS の line-height: 24px と同じく、文字の大きさによらない）。あれば lineHeight より優先する（MAI-76）
  fixedLineHeight?: number
  // 文字の太さ（100〜900。CSS の font-weight）
  fontWeight: number
  // 斜体（MAI-79）。なければ normal
  fontStyle?: 'normal' | 'italic'
  // 下線・取り消し線（MAI-79）。行ごと・run ごとに、文字の色・大きさに合わせて引く（textDecorations）
  underline?: boolean
  strikethrough?: boolean
  color: string
  align: TextAlign
  // フォントの名前（fonts.ts）。なければ既定のフォント（MAI-75）
  fontFamily?: string
  // 文字間（em。fontSize に対する割合で、文字ごとにその文字の大きさで換算する）。なければ 0（MAI-77）
  letterSpacing?: number
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

// 文字の太さ（CSS の font-weight）。props・書式の値を読む。持たない（古い）ノード・読めない値は 400
export const FONT_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const

export function fontWeightOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 1000 ? value : 400
}

// 文字間の範囲（em。デザインパネルで入れられる値。MAI-77）
export const LETTER_SPACING_LIMITS = { min: -0.5, max: 2 } as const

// props の文字間（em）を、TextStyle の letterSpacing にする。持たない（古い）ノード・読めない値は 0（今までと同じ見た目）
export function letterSpacingOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

// 文字 1 つの後ろに足す空き（px）。em をその文字の大きさで換算する（CSS と同じ）
export function letterSpacingPx(style: Pick<TextStyle, 'fontSize' | 'letterSpacing'>): number {
  return (style.letterSpacing ?? 0) * style.fontSize
}

// 編集用の DOM に指定する letter-spacing。em はその要素の文字の大きさで換算されて子に継がれるので、
// 文字の大きさを持つ要素（段落・run の要素。richTextDom.ts）ごとに指定する
export function cssLetterSpacing(style: Pick<TextStyle, 'letterSpacing'>): string {
  const em = style.letterSpacing ?? 0
  return em === 0 ? 'normal' : `${em}em`
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
  // 文字の幅（リストの段差は含まない）
  width: number
  // 文字の箱の左端から、行の文字を置ける左端までの段差（リストの段落。MAI-78）。ほかは 0
  indent: number
  // リストの段落の 1 行目の記号・番号。x は行の文字の左端（揃えたあと）からの位置（負）
  marker?: TextMarker
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

export interface TextMarker {
  text: string
  x: number
  width: number
  style: TextStyle
}

export interface TextLayout {
  lines: TextLine[]
  // いちばん長い行の幅（段差を含む）
  width: number
  height: number
  // 1 行目の高さ（クリックした点を 1 行目の中ほどに置くときなどに使う）
  lineHeightPx: number
  // 最も大きい文字の大きさ（ズームアウト時に帯で描くかを決める）
  maxFontSize: number
}

// 測り・描画（Canvas）と編集用の DOM で同じ文字になるよう、太さ・斜体（MAI-79）も含めた CSS の font にする。
// 太字・斜体の書体を持たないフォントは、Canvas も DOM もブラウザが合成する（幅も同じになる）
export function cssFont(style: Pick<TextStyle, 'fontSize' | 'fontWeight' | 'fontFamily' | 'fontStyle'>): string {
  return `${style.fontStyle === 'italic' ? 'italic ' : ''}${style.fontWeight} ${style.fontSize}px ${fontFamilyCss(style.fontFamily)}`
}

// ノードの既定のスタイルから、run の書式の既定（run が持たない値）を作る（MAI-74、MAI-75、MAI-79）
export function baseFormatOf(style: TextStyle): Required<TextRunFormat> {
  return {
    color: style.color,
    fontSize: style.fontSize,
    fontFamily: style.fontFamily ?? DEFAULT_FONT_FAMILY,
    fontWeight: style.fontWeight,
    bold: style.fontWeight >= FONT_WEIGHT_BOLD,
    italic: style.fontStyle === 'italic',
    underline: style.underline ?? false,
    strikethrough: style.strikethrough ?? false,
  }
}

// リストの階層 1 つ分の段差と、記号と文字の間の空き（ノードの既定の文字の大きさに対する割合。MAI-78）
export const LIST_INDENT_EM = 2
export const LIST_MARKER_GAP_EM = 0.5

export function listIndentStep(base: Pick<TextStyle, 'fontSize'>): number {
  return base.fontSize * LIST_INDENT_EM
}

export function listMarkerGap(base: Pick<TextStyle, 'fontSize'>): number {
  return base.fontSize * LIST_MARKER_GAP_EM
}

// 段落の文字の左端までの段差（リストでなければ 0）
export function paragraphIndent(paragraph: TextParagraph, base: Pick<TextStyle, 'fontSize'>): number {
  const list = listOf(paragraph)
  return list ? (list.level + 1) * listIndentStep(base) : 0
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

// Canvas2D の ctx.letterSpacing が使えるか（Chrome 99・Firefox 115・Safari 18.4 から。MAI-77）。テストで切り替えられるように変数にする
let nativeLetterSpacing: boolean | undefined

function hasNativeLetterSpacing(ctx: { letterSpacing?: unknown } | null): boolean {
  nativeLetterSpacing ??= Boolean(ctx && typeof ctx.letterSpacing === 'string')
  return nativeLetterSpacing
}

// テスト用：ctx.letterSpacing が使えないブラウザとして振る舞わせる（undefined で元に戻す）
export function setNativeLetterSpacingForTest(value: boolean | undefined): void {
  nativeLetterSpacing = value
  widthCache.clear()
}

// 文字間を足す単位（書記素。CSS の typographic character unit に近い）の数。Intl.Segmenter がなければ符号位置で数える
const graphemeSegmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null

export function graphemesOf(text: string): string[] {
  return graphemeSegmenter ? Array.from(graphemeSegmenter.segment(text), (s) => s.segment) : [...text]
}

// フォントごとに、語の幅をキャッシュして測る。Canvas がない環境（Node でのテスト）では概算する。
// 文字間があれば、ctx.letterSpacing で測る（使えなければ、文字間なしの幅に 文字の数 × 空き を足す）
function measurerFor(style: TextStyle): Measure {
  const font = cssFont(style)
  const spacing = letterSpacingPx(style)
  const ctx = getMeasureContext()
  const native = spacing !== 0 && ctx !== null && hasNativeLetterSpacing(ctx)
  if (spacing !== 0 && !native) {
    const plain = measurerFor({ ...style, letterSpacing: 0 })
    return (text) => plain(text) + graphemesOf(text).length * spacing
  }
  const key = spacing === 0 ? font : `${font}|${spacing}px`
  let cache = widthCache.get(key)
  if (!cache) {
    cache = new Map()
    widthCache.set(key, cache)
  }
  return (text) => {
    let width = cache.get(text)
    if (width === undefined) {
      if (ctx) {
        // Web フォントなら読み込みを頼む（読み込み終えたら、キャッシュを捨てて測り直す。fonts.ts）
        requestFontLoad(style.fontFamily, font, text)
        ctx.font = font
        if (native) ctx.letterSpacing = `${spacing}px`
        width = ctx.measureText(text).width
        if (native) ctx.letterSpacing = '0px'
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
    // bold だけを持つ古い書式も読む（cleanFormat を通す前の書式）
    fontWeight: format.fontWeight ?? (format.bold === undefined ? base.fontWeight : format.bold ? 700 : 400),
    fontStyle: format.italic === undefined ? base.fontStyle : format.italic ? 'italic' : 'normal',
    underline: format.underline ?? base.underline,
    strikethrough: format.strikethrough ?? base.strikethrough,
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
  const markers = listMarkers(paragraphs)
  for (const [p, paragraph] of paragraphs.entries()) {
    const runs = paragraph.runs.length > 0 ? paragraph.runs : [{ text: '' }]
    const styles = runs.map((run) => runStyle(base, run.format))
    // リストの段落（MAI-78）：段差と、1 行目の記号
    const indent = paragraphIndent(paragraph, base)
    const markerText = markers[p]
    let marker: TextMarker | undefined
    if (markerText) {
      const style = { ...styles[0], letterSpacing: 0 }
      const width = measurerFor(style)(markerText)
      const gutter = listIndentStep(base)
      const gap = listMarkerGap(base)
      marker = { text: markerText, width, style, x: width + gap <= gutter ? -gap - width : -gutter }
    }
    const wrapWidth = maxWidth === null ? null : Math.max(0, maxWidth - indent)
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
      const first = from === 0 && marker !== undefined
      const box = lineBox(first ? [...lineStyles, marker!.style] : lineStyles, strut)
      lines.push({
        text: text.slice(from, end),
        width: segments.reduce((sum, s) => sum + s.width, 0),
        indent,
        ...(first ? { marker } : {}),
        segments,
        top,
        height: box.height,
        baseline: box.baseline,
        fontSize: Math.max(...lineStyles.map((style) => style.fontSize)),
      })
      top += box.height
    }
    if (wrapWidth === null) {
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
      if (lineEnd > lineStart && lineWidth + unitWidth > wrapWidth) {
        pushLine(lineStart, lineEnd, true)
        lineStart = lineEnd
        lineWidth = 0
      }
      if (lineEnd === lineStart && unitWidth > wrapWidth) {
        // 1 語が幅に収まらない：文字の途中で折り返す
        let at = unitStart
        for (const ch of unit) {
          const next = at + ch.length
          if (lineEnd > lineStart && measureRange(lineStart, next) > wrapWidth) {
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
  const width = lines.reduce((max, l) => Math.max(max, l.indent + l.width), 0)
  return {
    lines,
    width,
    height: lines.length > 0 ? top : lineBoxHeight(base),
    lineHeightPx: lines[0]?.height ?? lineBoxHeight(base),
    maxFontSize: lines.reduce((max, l) => Math.max(max, l.fontSize), 0) || base.fontSize,
  }
}

// ---- 描画 ----

// 下線・取り消し線（MAI-79）の太さと位置（文字の大きさに対する割合）。
// 下線は線の上端をベースラインの少し下に、取り消し線は線の中ほどを、欧文の小文字と和文の字面の間あたりに置く
export const TEXT_DECORATION_THICKNESS_EM = 1 / 15
export const UNDERLINE_OFFSET_EM = 0.12
export const STRIKETHROUGH_OFFSET_EM = 0.3

// 下線・取り消し線の 1 本（box と同じ座標。x・y は線の左上）
export interface TextDecorationLine {
  kind: 'underline' | 'strikethrough'
  x: number
  y: number
  width: number
  thickness: number
  color: string
}

export function decorationThickness(fontSize: number): number {
  return Math.max(1, fontSize * TEXT_DECORATION_THICKNESS_EM)
}

// 行ごと・run（segment）ごとの下線・取り消し線。行の最後の segment は、後ろの文字間の空き（MAI-77）を除く。
// 行末の空白は、折り返す行ではレイアウトが行に入れていない。リストの記号（marker）には引かない
export function textDecorations(
  layout: TextLayout,
  style: Pick<TextStyle, 'align'>,
  box: { x: number; y: number; w: number; h: number },
  verticalAlign: 'top' | 'middle',
): TextDecorationLine[] {
  const out: TextDecorationLine[] = []
  const top = verticalAlign === 'middle' ? box.y + (box.h - layout.height) / 2 : box.y
  for (const line of layout.lines) {
    const left = lineLeft(line, style.align, box)
    const baseline = top + line.top + line.baseline
    for (const [i, segment] of line.segments.entries()) {
      const s = segment.style
      if (!s.underline && !s.strikethrough) continue
      const width = segment.width - (i === line.segments.length - 1 ? letterSpacingPx(s) : 0)
      if (width <= 0) continue
      const thickness = decorationThickness(s.fontSize)
      const x = left + segment.x
      if (s.underline) out.push({ kind: 'underline', x, y: baseline + s.fontSize * UNDERLINE_OFFSET_EM, width, thickness, color: s.color })
      if (s.strikethrough) out.push({ kind: 'strikethrough', x, y: baseline - s.fontSize * STRIKETHROUGH_OFFSET_EM - thickness / 2, width, thickness, color: s.color })
    }
  }
  return out
}

// 行の文字の左端。リストの段落は段差を除いた幅の中でそろえる
export function lineLeft(line: Pick<TextLine, 'width' | 'indent'>, align: TextAlign, box: { x: number; w: number }): number {
  const x = box.x + line.indent
  const w = box.w - line.indent
  return align === 'left' ? x : align === 'center' ? x + (w - line.width) / 2 : x + w - line.width
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
  // 文字間（MAI-77）。ctx.letterSpacing が使えれば指定して描き、使えなければ文字ごとにずらして描く。描き終えたら戻す
  const native = hasNativeLetterSpacing(ctx)
  const previousSpacing = native ? ctx.letterSpacing : undefined
  let spacingCss = previousSpacing
  for (const line of layout.lines) {
    const x = lineLeft(line, style.align, box)
    const y = top + line.top + line.baseline
    const marker = line.marker
    if (marker) {
      // 記号・番号（MAI-78）。文字間は付けない
      const markerFont = cssFont(marker.style)
      if (markerFont !== font) ctx.font = font = markerFont
      ctx.fillStyle = marker.style.color
      if (native && spacingCss !== '0px') ctx.letterSpacing = spacingCss = '0px'
      ctx.fillText(marker.text, x + marker.x, y)
    }
    for (const segment of line.segments) {
      const segmentFont = cssFont(segment.style)
      if (segmentFont !== font) ctx.font = font = segmentFont
      ctx.fillStyle = segment.style.color
      const spacing = letterSpacingPx(segment.style)
      if (spacing === 0 || native) {
        if (native) {
          const css = `${spacing}px`
          if (css !== spacingCss) ctx.letterSpacing = spacingCss = css
        }
        ctx.fillText(segment.text, x + segment.x, y)
      } else {
        // 測り（measurerFor）と同じく、文字間なしの幅 + 前の文字の数 × 空き の位置に 1 文字ずつ描く
        const plain = measurerFor({ ...segment.style, letterSpacing: 0 })
        let before = ''
        for (const [i, ch] of graphemesOf(segment.text).entries()) {
          ctx.fillText(ch, x + segment.x + plain(before) + i * spacing, y)
          before += ch
        }
      }
    }
  }
  if (native && spacingCss !== previousSpacing) ctx.letterSpacing = previousSpacing!
  // 下線・取り消し線（MAI-79）は文字の上に描く。回していなければ、画素の境目にそろえる（編集中の DOM の線と同じくぼやけないように）
  const m = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null
  const snap = m && m.b === 0 && m.c === 0 && m.a > 0 && m.d > 0 ? m : null
  for (const decoration of textDecorations(layout, style, box, verticalAlign)) {
    ctx.fillStyle = decoration.color
    if (!snap) {
      ctx.fillRect(decoration.x, decoration.y, decoration.width, decoration.thickness)
      continue
    }
    const [x0, x1] = snapEdges(decoration.x, decoration.width, snap.a, snap.e)
    const [y0, y1] = snapEdges(decoration.y, decoration.thickness, snap.d, snap.f)
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0)
  }
}

// 位置 start・長さ size（scale・offset で画素に写す）の両端を、画素の境目にそろえる（1 画素は残す）
function snapEdges(start: number, size: number, scale: number, offset: number): [number, number] {
  const a = Math.round(start * scale + offset)
  const b = Math.max(a + 1, Math.round((start + size) * scale + offset))
  return [(a - offset) / scale, (b - offset) / scale]
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
