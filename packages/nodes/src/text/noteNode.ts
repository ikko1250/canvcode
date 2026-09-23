import type { NodeRecord } from '@canvcode/core'
import { defineNodeType } from '../defineNodeType.ts'
import { TEXT_BAR_THRESHOLD_PX, drawTextBars, drawTextLayout, layoutText, textAlignOf, type TextAlign, type TextLayout, type TextStyle } from './layout.ts'

// 付箋（MAI-7 の `note`、MAI-24）。幅は自由に変えられ、高さは文字に合わせて伸びる（MAI-34）。
// props の h は「最低の高さ」で、文字がそれより多ければ、はみ出さないところまで縦に伸びる。
// 高さは props から計算するので、前からある付箋も読み込んだときにそのまま文字に合った大きさになる。
// 文字の大きさと揃え（左・中央・右）はノード単位で変えられる（MAI-50）。align のない古い付箋は左揃え。
export interface NoteProps {
  text: string
  w: number
  h: number
  color: string
  fontSize: number
  align: TextAlign
}

export type NoteNode = NodeRecord<NoteProps>

const PADDING = 16
const LINE_HEIGHT = 1.4

export function noteStyle(props: NoteProps): TextStyle {
  return { fontSize: props.fontSize, lineHeight: LINE_HEIGHT, fontWeight: 400, color: '#2b2930', align: textAlignOf(props.align) }
}

function textWidth(props: NoteProps): number {
  return Math.max(1, props.w - PADDING * 2)
}

const layoutCache = new WeakMap<NoteProps, TextLayout>()

function noteLayout(props: NoteProps): TextLayout {
  let layout = layoutCache.get(props)
  if (!layout) {
    layout = layoutText(props.text, noteStyle(props), textWidth(props))
    layoutCache.set(props, layout)
  }
  return layout
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
  version: 1,

  defaultProps: () => ({ text: '', w: 220, h: 200, color: '#fff3bf', fontSize: 20, align: 'left' }),

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
    if (node.props.fontSize * info.zoom < TEXT_BAR_THRESHOLD_PX) drawTextBars(ctx, layout, noteStyle(node.props), textBox(node.props), 'top')
    else drawTextLayout(ctx, layout, noteStyle(node.props), textBox(node.props), 'top')
    ctx.restore()
  },

  roughColor: (node) => node.props.color,

  // 幅は指定どおりにし、高さは最低の高さとして持つ（文字が多ければ、それより縦に伸びる）
  resize: (node, size) => ({ ...node.props, w: size.w, h: size.h }),
  minSize: { w: 60, h: 60 },

  editText: (node) => ({
    text: node.props.text,
    style: noteStyle(node.props),
    box: textBox(node.props),
    autoWidth: false,
    verticalAlign: 'top',
    update: (text) => ({ ...node.props, text }),
    deleteIfEmpty: false,
  }),
})
