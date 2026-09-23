// 文字のレイアウトと描画（MAI-24）。テキスト・付箋・図形のラベルで共通に使う。
// 折り返しは、編集用の textarea（CSS の white-space: pre-wrap）となるべく同じ位置になるようにする。
// - 英数字は単語の区切り（空白）で折り返す。1 語が幅に収まらなければ、文字の途中で折り返す
// - 日本語などは文字ごとに折り返す
// - 行頭に来てはいけない句読点・閉じ括弧・小書きの仮名などは、前の文字とくっつけて扱う（簡単な禁則処理）。
//   CSS の line-break: strict に合わせているので、編集用の textarea にも line-break: strict を指定する

// DOM（編集用の textarea）と Canvas で同じフォントになるよう、フォント名を明示する（MAI-21）
export const TEXT_FONT_FAMILY =
  "'Noto Sans JP', 'Noto Sans CJK JP', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic UI', 'Meiryo', sans-serif"

export type TextAlign = 'left' | 'center' | 'right'

export interface TextStyle {
  fontSize: number
  // 行の高さ（fontSize に対する倍率）
  lineHeight: number
  fontWeight: 400 | 700
  color: string
  align: TextAlign
}

// テキストと付箋の文字の大きさの段階（MAI-50）。パレットの「大きく」「小さく」で、この中を行き来する
export const TEXT_FONT_SIZES = [12, 16, 20, 24, 32, 48, 64] as const

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

export interface TextLine {
  text: string
  width: number
}

export interface TextLayout {
  lines: TextLine[]
  // いちばん長い行の幅
  width: number
  height: number
  lineHeightPx: number
}

export function cssFont(style: Pick<TextStyle, 'fontSize' | 'fontWeight'>): string {
  return `${style.fontWeight} ${style.fontSize}px ${TEXT_FONT_FAMILY}`
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

// maxWidth が null なら折り返さない（段落ごとに 1 行）
export function layoutText(text: string, style: TextStyle, maxWidth: number | null): TextLayout {
  const measure = measurerFor(style)
  const lineHeightPx = style.fontSize * style.lineHeight
  const lines: TextLine[] = []
  for (const paragraph of text.split('\n')) {
    if (maxWidth === null) {
      lines.push({ text: paragraph, width: measure(paragraph) })
      continue
    }
    let line = ''
    let lineWidth = 0
    const pushLine = () => {
      // 行末の空白は幅に数えない（CSS と同じ）
      const trimmed = line.replace(/[ \t]+$/, '')
      lines.push({ text: trimmed, width: measure(trimmed) })
      line = ''
      lineWidth = 0
    }
    for (const unit of breakUnits(paragraph)) {
      const unitWidth = measure(unit.replace(/[ \t]+$/, ''))
      if (line && lineWidth + unitWidth > maxWidth) pushLine()
      if (!line && unitWidth > maxWidth) {
        // 1 語が幅に収まらない：文字の途中で折り返す
        for (const ch of unit) {
          const w = measure(line + ch)
          if (line && w > maxWidth) pushLine()
          line += ch
          lineWidth = measure(line)
        }
        continue
      }
      line += unit
      lineWidth = measure(line)
    }
    pushLine()
  }
  const width = lines.reduce((max, l) => Math.max(max, l.width), 0)
  return { lines, width, height: Math.max(1, lines.length) * lineHeightPx, lineHeightPx }
}

// ---- 描画 ----

// box（ローカル座標）の中に描く。verticalAlign が middle なら、上下の中央に置く
export function drawTextLayout(
  ctx: CanvasRenderingContext2D,
  layout: TextLayout,
  style: TextStyle,
  box: { x: number; y: number; w: number; h: number },
  verticalAlign: 'top' | 'middle',
): void {
  ctx.font = cssFont(style)
  ctx.fillStyle = style.color
  ctx.textBaseline = 'middle'
  ctx.textAlign = style.align
  const x = style.align === 'left' ? box.x : style.align === 'center' ? box.x + box.w / 2 : box.x + box.w
  const top = verticalAlign === 'middle' ? box.y + (box.h - layout.height) / 2 : box.y
  for (const [i, line] of layout.lines.entries()) {
    if (line.text) ctx.fillText(line.text, x, top + layout.lineHeightPx * (i + 0.5))
  }
  ctx.textAlign = 'left'
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
  const barH = style.fontSize * 0.6
  for (const [i, line] of layout.lines.entries()) {
    if (!line.width) continue
    const x = style.align === 'left' ? box.x : style.align === 'center' ? box.x + (box.w - line.width) / 2 : box.x + box.w - line.width
    ctx.fillRect(x, top + layout.lineHeightPx * (i + 0.5) - barH / 2, line.width, barH)
  }
}

// 画面上の文字の大きさがこれより小さければ、帯で描く（CSS ピクセル）
export const TEXT_BAR_THRESHOLD_PX = 5
