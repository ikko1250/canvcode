import type { NodeRecord } from '@canvcode/core'
import { defineNodeType } from '../defineNodeType.ts'
import { TEXT_BAR_THRESHOLD_PX, drawTextBars, drawTextLayout, layoutText, textAlignOf, type TextAlign, type TextLayout, type TextStyle } from './layout.ts'

// テキスト（MAI-7 の `text`、MAI-24）。プレーンテキストで、書式はノード単位。
// - autoWidth：打った分だけ幅が伸びる（クリックで作ったとき）
// - そうでなければ、幅 w で折り返す（ドラッグで作ったとき、リサイズしたとき）
export interface TextProps {
  text: string
  fontSize: number
  color: string
  align: TextAlign
  w: number
  autoWidth: boolean
}

export type TextNode = NodeRecord<TextProps>

export const TEXT_DEFAULT_FONT_SIZE = 24
const LINE_HEIGHT = 1.35
// 空のときでも、カーソルを置けるだけの幅を持たせる
const MIN_WIDTH_EM = 1

export function textStyle(props: TextProps): TextStyle {
  return { fontSize: props.fontSize, lineHeight: LINE_HEIGHT, fontWeight: 400, color: props.color, align: textAlignOf(props.align) }
}

// 同じ props のレイアウトは一度だけ計算する（レコードは書き換えないので props で引ける）
const layoutCache = new WeakMap<TextProps, TextLayout>()

export function textLayout(props: TextProps): TextLayout {
  let layout = layoutCache.get(props)
  if (!layout) {
    layout = layoutText(props.text, textStyle(props), props.autoWidth ? null : props.w)
    layoutCache.set(props, layout)
  }
  return layout
}

function textWidth(props: TextProps): number {
  return props.autoWidth ? Math.max(textLayout(props).width, props.fontSize * MIN_WIDTH_EM) : props.w
}

export const textType = defineNodeType<TextProps>({
  type: 'text',
  version: 1,

  defaultProps: () => ({
    text: '',
    fontSize: TEXT_DEFAULT_FONT_SIZE,
    color: '#1f2328',
    align: 'left',
    w: 200,
    autoWidth: true,
  }),

  getBounds: (node) => ({ x: 0, y: 0, w: textWidth(node.props), h: textLayout(node.props).height }),

  hitTest(node, point, margin) {
    const w = textWidth(node.props)
    const h = textLayout(node.props).height
    return point.x >= -margin && point.y >= -margin && point.x <= w + margin && point.y <= h + margin
  },

  render(ctx, node, info) {
    if (info.editing) return
    const layout = textLayout(node.props)
    const box = { x: 0, y: 0, w: textWidth(node.props), h: layout.height }
    if (node.props.fontSize * info.zoom < TEXT_BAR_THRESHOLD_PX) drawTextBars(ctx, layout, textStyle(node.props), box, 'top')
    else drawTextLayout(ctx, layout, textStyle(node.props), box, 'top')
  },

  roughColor: () => 'rgba(120, 120, 120, 0.45)',

  // 横に伸ばすと、その幅で折り返すようになる。文字の大きさは変えない
  resize: (node, size) => ({ ...node.props, w: size.w, autoWidth: false }),
  minSize: { w: 16, h: 1 },

  editText: (node) => ({
    text: node.props.text,
    style: textStyle(node.props),
    box: { x: 0, y: 0, w: textWidth(node.props), h: textLayout(node.props).height },
    autoWidth: node.props.autoWidth,
    verticalAlign: 'top',
    update: (text) => ({ ...node.props, text }),
    deleteIfEmpty: true,
  }),
})
