import type { NodeRecord } from '@canvcode/core'
import { defineNodeType } from './defineNodeType.ts'

// 矩形・楕円などの図形（MAI-7 の `geo`）
export interface GeoProps {
  shape: 'rect' | 'ellipse'
  w: number
  h: number
  fill: string
  stroke: string
  strokeWidth: number
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
  },

  roughColor: (node) => node.props.fill,

  resize: (node, size) => ({ ...node.props, w: size.w, h: size.h }),
  minSize: { w: 1, h: 1 },
})
