import type { Box, NodeRecord, Vec } from '@canvcode/core'
import { getStroke } from 'perfect-freehand'
import { defineNodeType } from './defineNodeType.ts'

// フリーハンドの線（MAI-7 の `draw`、MAI-12、MAI-27）。
// 線をなめらかにする処理は perfect-freehand で行い、輪郭は Path2D にして使い回す。
// 筆圧は扱わない（PC のみ）。マウスの速さから、太さの変化を真似る。
export interface DrawProps {
  // 点列（ローカル座標）。[x0, y0, x1, y1, ...]
  points: number[]
  color: string
  // 線の太さ（ワールド座標）
  size: number
  // 描き終えたか。描いている間は、線の終わりを細くしない
  isComplete: boolean
}

export type DrawNode = NodeRecord<DrawProps>

export const DRAW_COLORS = ['#1f2328', '#e03131', '#1971c2', '#2f9e44', '#f08c00'] as const
export const DRAW_SIZES = [2, 4, 8] as const

// 1 本の線の輪郭（多角形の点）と、それを塗る Path2D。同じ props なら一度だけ作る
const outlineCache = new WeakMap<DrawProps, number[][]>()
const pathCache = new WeakMap<DrawProps, Path2D>()
const boundsCache = new WeakMap<DrawProps, Box>()

export function drawOutline(props: DrawProps): number[][] {
  let outline = outlineCache.get(props)
  if (!outline) {
    const input: number[][] = []
    for (let i = 0; i + 1 < props.points.length; i += 2) input.push([props.points[i], props.points[i + 1]])
    outline = getStroke(input, {
      size: props.size,
      thinning: 0.5,
      smoothing: 0.5,
      streamline: 0.5,
      simulatePressure: true,
      last: props.isComplete,
    })
    outlineCache.set(props, outline)
  }
  return outline
}

function drawPath(props: DrawProps): Path2D {
  let path = pathCache.get(props)
  if (!path) {
    path = new Path2D()
    const outline = drawOutline(props)
    if (outline.length > 0) {
      // 隣り合う点の中点を通る 2 次曲線でつなぎ、輪郭をなめらかにする（perfect-freehand の例と同じ方法）
      const [first] = outline
      path.moveTo(first[0], first[1])
      for (let i = 0; i < outline.length; i++) {
        const [x0, y0] = outline[i]
        const [x1, y1] = outline[(i + 1) % outline.length]
        path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2)
      }
      path.closePath()
    }
    pathCache.set(props, path)
  }
  return path
}

// 点列の箱を、線の太さの半分だけ広げたもの
export function drawBounds(props: DrawProps): Box {
  let box = boundsCache.get(props)
  if (!box) {
    const { points, size } = props
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (let i = 0; i + 1 < points.length; i += 2) {
      minX = Math.min(minX, points[i])
      maxX = Math.max(maxX, points[i])
      minY = Math.min(minY, points[i + 1])
      maxY = Math.max(maxY, points[i + 1])
    }
    if (minX === Infinity) minX = minY = maxX = maxY = 0
    const r = size / 2
    box = { x: minX - r, y: minY - r, w: maxX - minX + size, h: maxY - minY + size }
    boundsCache.set(props, box)
  }
  return box
}

// 点列を、箱の左上が (0, 0) になるようにずらす（リサイズできる型は、箱の原点を (0, 0) にする）。
// ずらした量を返すので、呼び出し側はその分だけノードの位置を動かす
export function normalizeDrawPoints(props: DrawProps): { props: DrawProps; offset: Vec } {
  const box = drawBounds(props)
  if (box.x === 0 && box.y === 0) return { props, offset: { x: 0, y: 0 } }
  const points = props.points.map((v, i) => (i % 2 === 0 ? v - box.x : v - box.y))
  return { props: { ...props, points }, offset: { x: box.x, y: box.y } }
}

// 点から折れ線までの距離
export function distanceToPolyline(points: number[], p: Vec): number {
  if (points.length < 2) return Infinity
  let best = Math.hypot(p.x - points[0], p.y - points[1])
  for (let i = 0; i + 3 < points.length; i += 2) {
    best = Math.min(best, distanceToSegment(p, points[i], points[i + 1], points[i + 2], points[i + 3]))
  }
  return best
}

function distanceToSegment(p: Vec, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / len2))
  return Math.hypot(p.x - (ax + t * dx), p.y - (ay + t * dy))
}

// 線分 a–b が、線（太さを含む）に触れているか（消しゴムで使う）
export function segmentTouchesDraw(props: DrawProps, a: Vec, b: Vec, margin: number): boolean {
  const reach = props.size / 2 + margin
  // 線分を reach より細かく区切って、それぞれの点で調べる
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / Math.max(reach, 0.5)))
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    if (distanceToPolyline(props.points, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }) <= reach) return true
  }
  return false
}

export const drawType = defineNodeType<DrawProps>({
  type: 'draw',
  version: 1,

  defaultProps: () => ({ points: [], color: DRAW_COLORS[0], size: DRAW_SIZES[1], isComplete: false }),

  getBounds: (node) => drawBounds(node.props),

  hitTest: (node, point, margin) => distanceToPolyline(node.props.points, point) <= node.props.size / 2 + margin,

  render(ctx, node) {
    ctx.fillStyle = node.props.color
    ctx.fill(drawPath(node.props))
  },

  roughColor: (node) => node.props.color,

  // 点列を伸ばす。線の太さは変えない
  resize(node, size) {
    const { points, size: stroke } = node.props
    const box = drawBounds(node.props)
    const r = stroke / 2
    const kx = box.w - stroke > 0 ? Math.max(size.w - stroke, 0) / (box.w - stroke) : 1
    const ky = box.h - stroke > 0 ? Math.max(size.h - stroke, 0) / (box.h - stroke) : 1
    return {
      ...node.props,
      points: points.map((v, i) => (i % 2 === 0 ? r + (v - box.x - r) * kx : r + (v - box.y - r) * ky)),
    }
  },
})
