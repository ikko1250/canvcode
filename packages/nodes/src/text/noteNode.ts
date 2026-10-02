import type { NodeRecord } from '@canvcode/core'
import { defineNodeType } from '../defineNodeType.ts'
import { TEXT_BAR_THRESHOLD_PX, drawTextBars, drawTextLayout, layoutRichText, lineHeightStyle, textAlignOf, type LineHeight, type TextAlign, type TextLayout, type TextStyle } from './layout.ts'
import { DEFAULT_FONT_FAMILY, fontFamilyOf, textMetricsGeneration } from './fonts.ts'
import { migratePlainTextProps, paragraphsOf, plainTextOf, richTextFromPlain, type TextParagraph } from './richText.ts'

// 付箋（MAI-7 の `note`、MAI-24）。幅は自由に変えられ、高さは文字に合わせて伸びる（MAI-34）。
// props の h は「最低の高さ」で、文字がそれより多ければ、はみ出さないところまで縦に伸びる。
// 高さは props から計算するので、前からある付箋も読み込んだときにそのまま文字に合った大きさになる。
// 文字の大きさと揃え（左・中央・右）はノード単位で変えられる（MAI-50）。align のない古い付箋は左揃え。
// 文字はテキストと同じく段落と run で持ち、範囲ごとに色・大きさを変えられる（MAI-74）。color は地の色で、文字の既定の色は NOTE_TEXT_COLOR。
// 版 1 は文字をプレーンテキスト（text）で持っていた。
// fontFamily（文字の既定のフォント。MAI-75）は版を上げずに足した。持たない古い付箋は既定のフォントで描く。
// 行の高さ（lineHeight。倍率か px。MAI-76）も版を上げずに足した。高さは文字のレイアウトから出すので、行の高さを変えると付箋も伸び縮みする
export interface NoteProps {
  paragraphs: TextParagraph[]
  w: number
  h: number
  color: string
  fontSize: number
  // フォントの名前（fonts.ts。MAI-75）。古いレコードにはない（fontFamilyOf で既定として読む）
  fontFamily: string
  align: TextAlign
  // 行の高さ（倍率か px。MAI-76）。版を上げずに足した。持たない（古い・既定のままの）ものは NOTE_DEFAULT_LINE_HEIGHT の倍率
  lineHeight?: LineHeight
}

export type NoteNode = NodeRecord<NoteProps>

const PADDING = 16
// 行の高さの既定（倍率）。行の高さを持たない付箋はこれで描く（MAI-76 より前と同じ見た目）
export const NOTE_DEFAULT_LINE_HEIGHT = 1.4
// 新しく作る付箋の文字の大きさ（MAI-62）
export const NOTE_DEFAULT_FONT_SIZE = 12
// 付箋の文字の既定の色
export const NOTE_TEXT_COLOR = '#2b2930'

export function noteStyle(props: NoteProps): TextStyle {
  return {
    fontSize: props.fontSize,
    ...lineHeightStyle(props.lineHeight, NOTE_DEFAULT_LINE_HEIGHT),
    fontWeight: 400,
    color: NOTE_TEXT_COLOR,
    align: textAlignOf(props.align),
    fontFamily: fontFamilyOf(props.fontFamily),
  }
}

function textWidth(props: NoteProps): number {
  return Math.max(1, props.w - PADDING * 2)
}

// フォントを読み込み終えて測り直すとき（textMetricsGeneration が変わる）は計算し直す（MAI-75）
const layoutCache = new WeakMap<NoteProps, { generation: number; layout: TextLayout }>()

function noteLayout(props: NoteProps): TextLayout {
  const generation = textMetricsGeneration()
  let cached = layoutCache.get(props)
  if (!cached || cached.generation !== generation) {
    cached = { generation, layout: layoutRichText(paragraphsOf(props), noteStyle(props), textWidth(props)) }
    layoutCache.set(props, cached)
  }
  return cached.layout
}

// 実際の高さ：props.h か、文字がすべて収まる高さの大きいほう
export function noteHeight(props: NoteProps): number {
  return Math.max(props.h, noteLayout(props).height + PADDING * 2)
}

function textBox(props: NoteProps) {
  return { x: PADDING, y: PADDING, w: textWidth(props), h: Math.max(1, noteHeight(props) - PADDING * 2) }
}

export const noteType = defineNodeType<NoteProps>({
  type: 'note',
  version: 2,

  defaultProps: () => ({ paragraphs: richTextFromPlain(''), w: 220, h: 200, color: '#fff3bf', fontSize: NOTE_DEFAULT_FONT_SIZE, fontFamily: DEFAULT_FONT_FAMILY, align: 'left' }),

  migrate: (props, fromVersion) => (fromVersion < 2 ? migratePlainTextProps<NoteProps>(props) : props),

  getBounds: (node) => ({ x: 0, y: 0, w: node.props.w, h: noteHeight(node.props) }),

  hitTest: (node, point, margin) =>
    point.x >= -margin && point.y >= -margin && point.x <= node.props.w + margin && point.y <= noteHeight(node.props) + margin,

  render(ctx, node, info) {
    const { w, color } = node.props
    const h = noteHeight(node.props)
    // 付箋の影と紙
    ctx.fillStyle = 'rgba(60, 50, 20, 0.12)'
    ctx.fillRect(2, 3, w, h)
    ctx.fillStyle = color
    ctx.fillRect(0, 0, w, h)
    if (info.editing) return
    // 文字は、はみ出した分を描かない
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, w, h)
    ctx.clip()
    const layout = noteLayout(node.props)
    if (layout.maxFontSize * info.zoom < TEXT_BAR_THRESHOLD_PX) drawTextBars(ctx, layout, noteStyle(node.props), textBox(node.props), 'top')
    else drawTextLayout(ctx, layout, noteStyle(node.props), textBox(node.props), 'top')
    ctx.restore()
  },

  roughColor: (node) => node.props.color,

  // 幅は指定どおりにし、高さは最低の高さとして持つ（文字が多ければ、それより縦に伸びる）
  resize: (node, size) => ({ ...node.props, w: size.w, h: size.h }),
  minSize: { w: 60, h: 60 },

  editText: (node) => ({
    text: plainTextOf(paragraphsOf(node.props)),
    style: noteStyle(node.props),
    box: textBox(node.props),
    autoWidth: false,
    verticalAlign: 'top',
    update: (text) => ({ ...node.props, paragraphs: richTextFromPlain(text) }),
    rich: { paragraphs: paragraphsOf(node.props), update: (paragraphs) => ({ ...node.props, paragraphs }) },
    deleteIfEmpty: false,
  }),
})
