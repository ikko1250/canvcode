import type { NodeRecord } from '@canvcode/core'
import { defineNodeType } from './defineNodeType.ts'
import { TEXT_BAR_THRESHOLD_PX, drawTextBars, drawTextLayout, layoutText, type TextLayout, type TextStyle } from './text/layout.ts'

// 矩形・楕円などの図形（MAI-7 の `geo`）
export interface GeoProps {
  shape: 'rect' | 'ellipse'
  w: number
  h: number
  fill: string
  stroke: string
  strokeWidth: number
  // 図形の中央に書く文字（MAI-24）
  label: string
}

export type GeoNode = NodeRecord<GeoProps>

export const GEO_DEFAULT_SIZE = 120

export const geoType = defineNodeType<GeoProps>({
  type: 'geo',
  version: 1,

  defaultProps: () => ({
    shape: 'rect',
    w: GEO_DEFAULT_SIZE,
    h: GEO_DEFAULT_SIZE,
    fill: '#e8eefc',
    stroke: '#3b5bdb',
    strokeWidth: 2,
    label: '',
  }),

  getBounds: (node) => ({ x: 0, y: 0, w: node.props.w, h: node.props.h }),

  hitTest(node, point, margin) {
    const { w, h, shape } = node.props
    if (shape === 'rect') {
      return point.x >= -margin && point.y >= -margin && point.x <= w + margin && point.y <= h + margin
    }
    // 楕円：中心からの正規化距離で判定する
    const rx = w / 2 + margin
    const ry = h / 2 + margin
    const dx = (point.x - w / 2) / rx
    const dy = (point.y - h / 2) / ry
    return dx * dx + dy * dy <= 1
  },

  render(ctx, node, info) {
    const { w, h, shape, fill, stroke, strokeWidth } = node.props
    ctx.beginPath()
    if (shape === 'rect') ctx.rect(0, 0, w, h)
    else ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2)
    ctx.fillStyle = fill
    ctx.fill()
    // 画面上で 0.5 ピクセル未満になる線は、見た目にほぼ影響しないので描かない（MAI-14）
    if (strokeWidth * info.zoom >= 0.5) {
      ctx.lineWidth = strokeWidth
      ctx.strokeStyle = stroke
      ctx.stroke()
    }
    if (node.props.label && !info.editing) {
      const layout = labelLayout(node.props)
      const box = labelBox(node.props)
      if (LABEL_FONT_SIZE * info.zoom < TEXT_BAR_THRESHOLD_PX) drawTextBars(ctx, layout, LABEL_STYLE, box, 'middle')
      else drawTextLayout(ctx, layout, LABEL_STYLE, box, 'middle')
    }
  },

  roughColor: (node) => node.props.fill,

  resize: (node, size) => ({ ...node.props, w: size.w, h: size.h }),
  minSize: { w: 1, h: 1 },

  editText: (node) => ({
    text: node.props.label,
    style: LABEL_STYLE,
    box: labelBox(node.props),
    autoWidth: false,
    verticalAlign: 'middle',
    update: (label) => ({ ...node.props, label }),
    deleteIfEmpty: false,
  }),
})

const LABEL_FONT_SIZE = 18
const LABEL_PADDING = 8
const LABEL_STYLE: TextStyle = { fontSize: LABEL_FONT_SIZE, lineHeight: 1.35, fontWeight: 400, color: '#1f2328', align: 'center' }

function labelBox(props: GeoProps) {
  return {
    x: LABEL_PADDING,
    y: LABEL_PADDING,
    w: Math.max(1, props.w - LABEL_PADDING * 2),
    h: Math.max(1, props.h - LABEL_PADDING * 2),
  }
}

const labelCache = new WeakMap<GeoProps, TextLayout>()

function labelLayout(props: GeoProps): TextLayout {
  let layout = labelCache.get(props)
  if (!layout) {
    layout = layoutText(props.label, LABEL_STYLE, labelBox(props).w)
    labelCache.set(props, layout)
  }
  return layout
}
