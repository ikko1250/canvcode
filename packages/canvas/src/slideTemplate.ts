import {
  CANVAS_COVER_CREDITS_STYLE,
  CANVAS_COVER_SUBTITLE_STYLE,
  CANVAS_COVER_TITLE_STYLE,
  CANVAS_SLIDE_FIGURE_STYLE,
  CANVAS_SLIDE_FONT_FAMILY,
  CANVAS_SLIDE_LABEL_STYLE,
  CANVAS_SLIDE_PANEL_STYLE,
  CANVAS_SLIDE_TITLE_STYLE,
  COLORS,
  canvasSlideBodyStyle,
  type CanvasRectStyle,
  type CanvasTextStyle,
} from '@canvcode/slides'
import { richTextFromPlain, solidPaint, type GeoProps, type SlideLayoutKind, type TextProps } from '@canvcode/nodes'

// スライド v2 のテンプレート（表紙・箇条書き・表・表＋画像）が置く子の props。DOM に依存しない純粋な関数だけを置く
// （置くのは Editor.applySlideTemplate）。
// - 見た目はテーマ（canvas-slide-theme.ts）の中立の形から作る。位置と大きさは決めない（並べ直し（slideLayoutArrange.ts）が決める）
// - title / subtitle は text、それ以外（パネル・行の見出しと本文・図の枠・credits）は geo の矩形
// - geo のセルの余白は labelPadding で持つ（v1 のセルの padding）。上下の寄せは geo の文字がいつも上下中央なので、
//   テーマの verticalAlign（セルはすべて middle）と同じになる
// - text には余白がない。表紙のタイトル・副題の左右の余白（textPaddingX）は、中央揃えなので位置には効かず、
//   折り返す幅が余白の分だけ広くなる（並べ直しが幅を見出しの領域の幅にする）
// - 箇条書きの行は 1 段（v1 の 1 段目の大きさ・字下げなし・記号なし）だけにする。text の箇条書き（MAI-78）は
//   段差が文字の大きさの 2em ごと・記号が • ◦ ▪ などで、v1 の 2・3 段目（48 / 96px の字下げ、記号「・」「－」、段ごとの大きさ）を表せない

// テンプレートの子の役割と、その子の型・props
export interface SlideTemplateChild {
  role: 'title' | 'subtitle' | 'credits' | 'panel' | 'figure' | 'label' | 'body'
  // 行の子（label / body）の行の番号（0 始まり）
  row?: number
  type: 'text' | 'geo'
  props: Partial<TextProps> | Partial<GeoProps>
}

// テンプレートの行の数（v1 の新しいスライドと同じく 3 行）
export const SLIDE_TEMPLATE_ROWS = 3

// 仮の文字
export const SLIDE_TEMPLATE_TEXT = {
  title: 'タイトル',
  subtitle: '副題',
  credits: '発表者・所属・日付',
  label: '見出し',
  body: '本文',
  figure: '画像',
} as const

// 並べ直しが決めるまでの仮の大きさ
const PLACEHOLDER_SIZE = 100

// テーマの文字の形から、text の props（幅は仮。並べ直しが決める）
export function slideTextProps(style: CanvasTextStyle, text: string): Partial<TextProps> {
  return {
    paragraphs: richTextFromPlain(text),
    fontSize: style.fontSize,
    color: style.color,
    fontFamily: style.fontFamily,
    align: style.align,
    lineHeight: { unit: 'multiplier', value: style.lineHeight },
    letterSpacing: style.letterSpacingEm,
    fontWeight: style.fontWeight,
    w: PLACEHOLDER_SIZE,
    autoWidth: false,
  }
}

// テーマの文字の形から、文字を持つ geo の矩形（セル）の props。地の色は fill（なければ塗りなし）、線はなし
export function slideCellProps(style: CanvasTextStyle, text: string): Partial<GeoProps> {
  return {
    shape: 'rect',
    w: PLACEHOLDER_SIZE,
    h: PLACEHOLDER_SIZE,
    fill: style.fill === null ? null : solidPaint(style.fill),
    stroke: null,
    strokeWidth: 0,
    label: text,
    labelParagraphs: richTextFromPlain(text),
    labelFontFamily: style.fontFamily,
    labelFontSize: style.fontSize,
    labelColor: style.color,
    labelAlign: style.align,
    labelLineHeight: { unit: 'multiplier', value: style.lineHeight },
    labelLetterSpacing: style.letterSpacingEm,
    labelFontWeight: style.fontWeight,
    labelPadding: { ...style.padding },
  }
}

// テーマの地の矩形（パネル・図の枠）の props。枠線は箱の内側に引く（v1 の border-box と同じ）
export function slideRectProps(style: CanvasRectStyle): Partial<GeoProps> {
  return {
    shape: 'rect',
    w: PLACEHOLDER_SIZE,
    h: PLACEHOLDER_SIZE,
    fill: solidPaint(style.fill),
    stroke: style.stroke === null ? null : solidPaint(style.stroke),
    strokeWidth: style.stroke === null ? 0 : style.strokeWidth,
    ...(style.stroke === null ? {} : { strokeAlign: 'inside' as const }),
    ...(style.cornerRadius > 0 ? { cornerRadius: style.cornerRadius } : {}),
    label: '',
  }
}

// 図の枠の案内の文字（枠の線の色で、本文の大きさ）
const FIGURE_HINT_STYLE: CanvasTextStyle = {
  ...canvasSlideBodyStyle(0),
  color: COLORS.figureBorder,
  fill: null,
  align: 'center',
  fontFamily: CANVAS_SLIDE_FONT_FAMILY,
}

// テンプレートの子（重なり順の奥から）。パネル・図の枠は行のセルより奥に置く
export function slideTemplateChildren(kind: SlideLayoutKind): SlideTemplateChild[] {
  const t = SLIDE_TEMPLATE_TEXT
  if (kind === 'title') {
    return [
      { role: 'title', type: 'text', props: slideTextProps(CANVAS_COVER_TITLE_STYLE, t.title) },
      { role: 'subtitle', type: 'text', props: slideTextProps(CANVAS_COVER_SUBTITLE_STYLE, t.subtitle) },
      { role: 'credits', type: 'geo', props: slideCellProps(CANVAS_COVER_CREDITS_STYLE, t.credits) },
    ]
  }
  const children: SlideTemplateChild[] = [{ role: 'panel', type: 'geo', props: slideRectProps(CANVAS_SLIDE_PANEL_STYLE) }]
  if (kind === 'table-image') {
    children.push({ role: 'figure', type: 'geo', props: slideFigureProps(SLIDE_TEMPLATE_TEXT.figure) })
  }
  children.push({ role: 'title', type: 'text', props: slideTextProps(CANVAS_SLIDE_TITLE_STYLE, t.title) })
  for (let row = 0; row < SLIDE_TEMPLATE_ROWS; row += 1) {
    if (kind !== 'bullets') children.push({ role: 'label', row, type: 'geo', props: slideCellProps(CANVAS_SLIDE_LABEL_STYLE, t.label) })
    children.push({ role: 'body', row, type: 'geo', props: slideCellProps(canvasSlideBodyStyle(row), t.body) })
  }
  return children
}

// 図の枠（地と線）に、案内の文字 text を入れた props（テンプレートの図の枠に使う）
export function slideFigureProps(text: string): Partial<GeoProps> {
  return { ...slideRectProps(CANVAS_SLIDE_FIGURE_STYLE), ...figureHint(text) }
}

// 図の枠の案内（文字の props だけ。地と線は枠のまま）
function figureHint(text: string): Partial<GeoProps> {
  const { shape: _shape, w: _w, h: _h, fill: _fill, stroke: _stroke, strokeWidth: _strokeWidth, ...label } = slideCellProps(FIGURE_HINT_STYLE, text)
  return label
}
