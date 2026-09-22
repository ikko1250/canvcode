import type { NodeRecord } from '@canvcode/core'
import { defineNodeType } from '../defineNodeType.ts'
import { TEXT_BAR_THRESHOLD_PX, drawTextBars, drawTextLayout, layoutText, type TextLayout, type TextStyle } from './layout.ts'

// 付箋（MAI-7 の `note`、MAI-24）。縦横の大きさを自由に変えられる（旧実装の wide note と同じ）。
export interface NoteProps {
  text: string
  w: number
  h: number
  color: string
  fontSize: number
}

export type NoteNode = NodeRecord<NoteProps>

const PADDING = 16
const LINE_HEIGHT = 1.4

function noteStyle(props: NoteProps): TextStyle {
  return { fontSize: props.fontSize, lineHeight: LINE_HEIGHT, fontWeight: 400, color: '#2b2930', align: 'left' }
}

function textBox(props: NoteProps) {
  return { x: PADDING, y: PADDING, w: Math.max(1, props.w - PADDING * 2), h: Math.max(1, props.h - PADDING * 2) }
}

const layoutCache = new WeakMap<NoteProps, TextLayout>()

function noteLayout(props: NoteProps): TextLayout {
  let layout = layoutCache.get(props)
  if (!layout) {
    layout = layoutText(props.text, noteStyle(props), textBox(props).w)
    layoutCache.set(props, layout)
  }
  return layout
}

export const noteType = defineNodeType<NoteProps>({
  type: 'note',
  version: 1,

  defaultProps: () => ({ text: '', w: 220, h: 200, color: '#fff3bf', fontSize: 20 }),

  getBounds: (node) => ({ x: 0, y: 0, w: node.props.w, h: node.props.h }),

  hitTest: (node, point, margin) =>
    point.x >= -margin && point.y >= -margin && point.x <= node.props.w + margin && point.y <= node.props.h + margin,

  render(ctx, node, info) {
    const { w, h, color } = node.props
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
