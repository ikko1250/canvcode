import type { Box, NodeRecord, Vec } from '@canvcode/core'
import { defineNodeType } from './defineNodeType.ts'
import { TEXT_BAR_THRESHOLD_PX, drawTextBars, drawTextLayout, layoutText, type TextLayout, type TextStyle } from './text/layout.ts'

// 矢印（MAI-7 の `arrow`、MAI-28）。直線と曲線（円弧）。
// - start・end・bend は「曲げる前の」形。つながっている端は、つながっている先のノードの中心（または anchor）にある
// - 実際に見えるのは、その円弧のうち clip の範囲（0〜1）。つながっている先のノードの縁で切った結果を、
//   基盤（Editor）が計算して書き込む。描画の関数はほかのノードを見ずに描ける
// - 端がどのノードにつながっているかは、Binding のレコードで持つ（MAI-7）
export interface ArrowProps {
  // 親のローカル座標（ノードの x・y からの相対）
  start: Vec
  end: Vec
  // 弦の中点から、円弧の中点までの距離。0 なら直線。正なら進む向きの右側（y が下向きの画面の座標で）に膨らむ
  bend: number
  // 見える範囲（円弧の上の位置、0〜1）
  clip: [number, number]
  color: string
  // 線の太さ（ワールド座標）
  size: number
  arrowheadStart: 'none' | 'arrow'
  arrowheadEnd: 'none' | 'arrow'
  label: string
}

export type ArrowNode = NodeRecord<ArrowProps>

export const ARROW_COLORS = ['#1f2328', '#e03131', '#1971c2', '#2f9e44', '#f08c00'] as const
export const ARROW_SIZES = [1.5, 3, 5] as const

// ---- 円弧の形 ----

export type ArcGeometry =
  | { kind: 'line'; a: Vec; b: Vec }
  | { kind: 'arc'; a: Vec; b: Vec; center: Vec; radius: number; startAngle: number; sweep: number }

// これより小さい曲がりは直線として扱う（ワールド座標）
const STRAIGHT_BEND = 0.5

export function arcGeometry(a: Vec, b: Vec, bend: number): ArcGeometry {
  const d = Math.hypot(b.x - a.x, b.y - a.y)
  if (Math.abs(bend) < STRAIGHT_BEND || d === 0) return { kind: 'line', a, b }
  const n = { x: -(b.y - a.y) / d, y: (b.x - a.x) / d }
  const p = { x: (a.x + b.x) / 2 + n.x * bend, y: (a.y + b.y) / 2 + n.y * bend }
  const center = circumcenter(a, p, b)
  if (!center) return { kind: 'line', a, b }
  const radius = Math.hypot(a.x - center.x, a.y - center.y)
  const startAngle = Math.atan2(a.y - center.y, a.x - center.x)
  const endAngle = Math.atan2(b.y - center.y, b.x - center.x)
  const midAngle = Math.atan2(p.y - center.y, p.x - center.x)
  // a から b へ、p を通る向きに回る角度
  const ccw = positiveAngle(endAngle - startAngle)
  const sweep = positiveAngle(midAngle - startAngle) < ccw ? ccw : ccw - Math.PI * 2
  return { kind: 'arc', a, b, center, radius, startAngle, sweep }
}

export function arcPoint(g: ArcGeometry, t: number): Vec {
  if (g.kind === 'line') return { x: g.a.x + (g.b.x - g.a.x) * t, y: g.a.y + (g.b.y - g.a.y) * t }
  const angle = g.startAngle + g.sweep * t
  return { x: g.center.x + g.radius * Math.cos(angle), y: g.center.y + g.radius * Math.sin(angle) }
}

// t での進む向き（長さ 1）
export function arcTangent(g: ArcGeometry, t: number): Vec {
  if (g.kind === 'line') {
    const d = Math.hypot(g.b.x - g.a.x, g.b.y - g.a.y) || 1
    return { x: (g.b.x - g.a.x) / d, y: (g.b.y - g.a.y) / d }
  }
  const angle = g.startAngle + g.sweep * t
  const s = Math.sign(g.sweep)
  return { x: -Math.sin(angle) * s, y: Math.cos(angle) * s }
}

export function arcLength(g: ArcGeometry): number {
  return g.kind === 'line' ? Math.hypot(g.b.x - g.a.x, g.b.y - g.a.y) : Math.abs(g.sweep) * g.radius
}

function circumcenter(a: Vec, b: Vec, c: Vec): Vec | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y))
  if (Math.abs(d) < 1e-9) return null
  const a2 = a.x * a.x + a.y * a.y
  const b2 = b.x * b.x + b.y * b.y
  const c2 = c.x * c.x + c.y * c.y
  return {
    x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d,
    y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d,
  }
}

function positiveAngle(angle: number): number {
  const full = Math.PI * 2
  return ((angle % full) + full) % full
}

export function arrowGeometry(props: ArrowProps): ArcGeometry {
  return arcGeometry(props.start, props.end, props.bend)
}

// clip の範囲の円弧を、1 本の円弧として表した start・end・bend（つながりを外したときに使う）
export function clippedArrowShape(props: ArrowProps): Pick<ArrowProps, 'start' | 'end' | 'bend' | 'clip'> {
  const [t0, t1] = props.clip
  if (t0 === 0 && t1 === 1) return { start: props.start, end: props.end, bend: props.bend, clip: [0, 1] }
  const g = arrowGeometry(props)
  const start = arcPoint(g, t0)
  const end = arcPoint(g, t1)
  return { start, end, bend: bendThrough(start, end, arcPoint(g, (t0 + t1) / 2)), clip: [0, 1] }
}

// 弦 a–b の中点から p までの、弦に垂直な向きの距離（p を通る円弧の bend）
export function bendThrough(a: Vec, b: Vec, p: Vec): number {
  const d = Math.hypot(b.x - a.x, b.y - a.y)
  if (d === 0) return 0
  const n = { x: -(b.y - a.y) / d, y: (b.x - a.x) / d }
  return (p.x - (a.x + b.x) / 2) * n.x + (p.y - (a.y + b.y) / 2) * n.y
}

// ---- ラベル ----

const LABEL_FONT_SIZE = 18
const LABEL_MAX_WIDTH = 240
const LABEL_PADDING = 4
const LABEL_STYLE: TextStyle = { fontSize: LABEL_FONT_SIZE, lineHeight: 1.35, fontWeight: 400, color: '#1f2328', align: 'center' }

const labelLayoutCache = new WeakMap<ArrowProps, TextLayout>()

function labelLayout(props: ArrowProps): TextLayout {
  let layout = labelLayoutCache.get(props)
  if (!layout) {
    layout = layoutText(props.label, LABEL_STYLE, LABEL_MAX_WIDTH)
    labelLayoutCache.set(props, layout)
  }
  return layout
}

// ラベルの位置（見えている円弧の中点）
export function arrowLabelPoint(props: ArrowProps): Vec {
  return arcPoint(arrowGeometry(props), (props.clip[0] + props.clip[1]) / 2)
}

// ラベルの箱（文字の幅に合わせる）
function labelBox(props: ArrowProps): Box | null {
  if (!props.label) return null
  const layout = labelLayout(props)
  const c = arrowLabelPoint(props)
  const w = layout.width + LABEL_PADDING * 2
  const h = layout.height + LABEL_PADDING * 2
  return { x: c.x - w / 2, y: c.y - h / 2, w, h }
}

// 編集するときの箱（幅は最大の幅にして、打った文字が折り返しても中央に来るようにする）
function labelEditBox(props: ArrowProps): Box {
  const c = arrowLabelPoint(props)
  const h = Math.max(labelLayout(props).height, LABEL_FONT_SIZE * LABEL_STYLE.lineHeight)
  return { x: c.x - LABEL_MAX_WIDTH / 2, y: c.y - h / 2, w: LABEL_MAX_WIDTH, h }
}

// ---- 形・当たり判定・描画 ----

const SAMPLES = 32

// 見えている部分の円弧を、折れ線にしたもの
export function arrowPolyline(props: ArrowProps): Vec[] {
  const g = arrowGeometry(props)
  const [t0, t1] = props.clip
  if (g.kind === 'line') return [arcPoint(g, t0), arcPoint(g, t1)]
  const out: Vec[] = []
  for (let i = 0; i <= SAMPLES; i++) out.push(arcPoint(g, t0 + ((t1 - t0) * i) / SAMPLES))
  return out
}

function headLength(props: ArrowProps): number {
  return 8 + props.size * 3
}

const boundsCache = new WeakMap<ArrowProps, Box>()

function arrowBounds(props: ArrowProps): Box {
  let box = boundsCache.get(props)
  if (!box) {
    const points = arrowPolyline(props)
    // 矢じりと線の太さの分だけ広げる
    const pad = (props.arrowheadStart !== 'none' || props.arrowheadEnd !== 'none' ? headLength(props) : 0) + props.size
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const p of points) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
    box = { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 }
    const label = labelBox(props)
    if (label) {
      const x = Math.min(box.x, label.x)
      const y = Math.min(box.y, label.y)
      box = { x, y, w: Math.max(box.x + box.w, label.x + label.w) - x, h: Math.max(box.y + box.h, label.y + label.h) - y }
    }
    boundsCache.set(props, box)
  }
  return box
}

function distanceToSegment(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

export function distanceToArrow(props: ArrowProps, p: Vec): number {
  const points = arrowPolyline(props)
  let best = Infinity
  for (let i = 0; i + 1 < points.length; i++) best = Math.min(best, distanceToSegment(p, points[i], points[i + 1]))
  return best
}

function drawHead(ctx: CanvasRenderingContext2D, tip: Vec, direction: Vec, length: number): void {
  // 開いた矢じり（tldraw の 'arrow' と同じ形）。30° ずつ開く
  const angle = Math.PI / 6
  const back = { x: -direction.x, y: -direction.y }
  for (const sign of [1, -1]) {
    const c = Math.cos(angle * sign)
    const s = Math.sin(angle * sign)
    ctx.moveTo(tip.x, tip.y)
    ctx.lineTo(tip.x + (back.x * c - back.y * s) * length, tip.y + (back.x * s + back.y * c) * length)
  }
}

export const arrowType = defineNodeType<ArrowProps>({
  type: 'arrow',
  version: 1,

  defaultProps: () => ({
    start: { x: 0, y: 0 },
    end: { x: 100, y: 0 },
    bend: 0,
    clip: [0, 1],
    color: ARROW_COLORS[0],
    size: ARROW_SIZES[1],
    arrowheadStart: 'none',
    arrowheadEnd: 'arrow',
    label: '',
  }),

  getBounds: (node) => arrowBounds(node.props),

  hitTest(node, point, margin) {
    const label = labelBox(node.props)
    if (label && point.x >= label.x && point.y >= label.y && point.x <= label.x + label.w && point.y <= label.y + label.h) {
      return true
    }
    return distanceToArrow(node.props, point) <= node.props.size / 2 + margin
  },

  render(ctx, node, info) {
    const props = node.props
    const g = arrowGeometry(props)
    const [t0, t1] = props.clip
    ctx.lineWidth = props.size
    ctx.strokeStyle = props.color
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    if (g.kind === 'line') {
      const a = arcPoint(g, t0)
      const b = arcPoint(g, t1)
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
    } else {
      const from = g.startAngle + g.sweep * t0
      const to = g.startAngle + g.sweep * t1
      ctx.arc(g.center.x, g.center.y, g.radius, from, to, g.sweep < 0)
    }
    const length = Math.min(headLength(props), arcLength(g) * (t1 - t0) * 0.5)
    if (props.arrowheadEnd !== 'none') drawHead(ctx, arcPoint(g, t1), arcTangent(g, t1), length)
    if (props.arrowheadStart !== 'none') {
      const d = arcTangent(g, t0)
      drawHead(ctx, arcPoint(g, t0), { x: -d.x, y: -d.y }, length)
    }
    ctx.stroke()

    const label = labelBox(props)
    if (label && !info.editing) {
      // 文字の後ろは白く抜いて、線と重ならないようにする
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(label.x, label.y, label.w, label.h)
      const layout = labelLayout(props)
      const inner = { x: label.x + LABEL_PADDING, y: label.y + LABEL_PADDING, w: label.w - LABEL_PADDING * 2, h: label.h - LABEL_PADDING * 2 }
      if (LABEL_FONT_SIZE * info.zoom < TEXT_BAR_THRESHOLD_PX) drawTextBars(ctx, layout, LABEL_STYLE, inner, 'middle')
      else drawTextLayout(ctx, layout, LABEL_STYLE, inner, 'middle')
    }
  },

  roughColor: (node) => node.props.color,
  // 矢印は端の点で形を変える（リサイズや回転のハンドルは出さない）
  canRotate: false,
  canBind: false,

  editText: (node) => ({
    text: node.props.label,
    style: LABEL_STYLE,
    box: labelEditBox(node.props),
    autoWidth: false,
    verticalAlign: 'middle',
    update: (label) => ({ ...node.props, label }),
    deleteIfEmpty: false,
  }),
})
