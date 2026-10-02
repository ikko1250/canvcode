import type { NodeRecord } from '@canvcode/core'
import { cornerRadii, effectiveCornerRadii, insideRoundedRect, roundedRectPath, roundedRectPolygon, type CornerRadius } from './cornerRadius.ts'
import { defineNodeType } from './defineNodeType.ts'
import { colorWithAlpha, fillPreviewColor, fillShape, paintColors, solidPaint, toFill, type Fill } from './paint.ts'
import { TEXT_BAR_THRESHOLD_PX, drawTextBars, drawTextLayout, layoutText, type TextLayout, type TextStyle } from './text/layout.ts'

// 矩形・楕円などの図形（MAI-7 の `geo`）
// 版 2（MAI-81）：塗り（fill）を色の文字列から塗り（paint.ts の Fill。種類＋中身、不透明度、塗りなしは null）にした。
// 版 1 の色の文字列は、読み込むときに単色の塗りへ移す。
// 塗りの種類（グラデーション（MAI-82）・画像（MAI-83））を足しても版は上げない（fill の形は同じ。読めない種類は toFill が既定にする）
// 角丸（MAI-84）の cornerRadius も版は上げない（足しただけの省略できる値。ないときは 0。読めない値も 0）
export interface GeoProps {
  shape: 'rect' | 'ellipse'
  w: number
  h: number
  fill: Fill
  stroke: string
  strokeWidth: number
  // 図形の中央に書く文字（MAI-24）
  label: string
  // 角の半径（MAI-84。矩形だけ）。ワールド座標の px。数値なら 4 つの角が同じ、配列なら [左上, 右上, 右下, 左下]。
  // リサイズしても値は保ち、描くときに短い辺の半分まで（4 つ別々なら CSS の border-radius と同じ縮小の規則で）に収める
  cornerRadius?: CornerRadius
}

export type GeoNode = NodeRecord<GeoProps>

export const GEO_DEFAULT_SIZE = 120
export const GEO_DEFAULT_FILL = '#e8eefc'
const ELLIPSE_OUTLINE_POINTS = 64

export const geoType = defineNodeType<GeoProps>({
  type: 'geo',
  version: 2,

  defaultProps: () => ({
    shape: 'rect',
    w: GEO_DEFAULT_SIZE,
    h: GEO_DEFAULT_SIZE,
    fill: solidPaint(GEO_DEFAULT_FILL),
    stroke: '#3b5bdb',
    strokeWidth: 2,
    label: '',
  }),

  migrate: (props, fromVersion) => (fromVersion < 2 ? { ...props, fill: toFill(props.fill, solidPaint(GEO_DEFAULT_FILL)) } : props),

  getBounds: (node) => ({ x: 0, y: 0, w: node.props.w, h: node.props.h }),

  // 塗りなしの図形は、Figma と同じく枠の線（と文字）にだけ当たる（中を押すと、下のノードを選べる）。
  // ただし線も文字もなく何も見えないときは、見失わないよう中にも当てる。選んでいる図形は中でも掴める（Editor.hitTest）
  hitTest(node, point, margin) {
    const { strokeWidth, label } = node.props
    const fill = fillOf(node.props)
    const hollow = fill === null && (strokeWidth > 0 || label !== '')
    const outer = hollow ? strokeWidth / 2 + margin : margin
    if (!insideShape(node.props, point, outer)) return false
    if (!hollow) return true
    if (label !== '' && insideBox(labelBox(node.props), point)) return true
    // 枠の線の内側の縁より内側なら当たらない
    const inner = strokeWidth / 2 + margin
    return strokeWidth > 0 && !insideShape(node.props, point, -inner)
  },

  render(ctx, node, info) {
    const { w, h, shape, stroke, strokeWidth } = node.props
    ctx.beginPath()
    // 矩形は角丸（MAI-84）のパス。半径が 0 なら rect と同じ
    if (shape === 'rect') roundedRectPath(ctx, { x: 0, y: 0, w, h }, geoCornerRadii(node.props))
    else ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2)
    // 画像の塗り（MAI-83）は、このパス（矩形・楕円・角丸）で切り抜いて描く
    fillShape(ctx, fillOf(node.props), { x: 0, y: 0, w, h }, info)
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

  // 塗りなしは、線の色を薄くして見せる
  roughColor: (node) => fillPreviewColor(fillOf(node.props)) ?? colorWithAlpha(node.props.stroke, 0.35),

  colors: (node) => [...paintColors(fillOf(node.props)), ...(node.props.strokeWidth > 0 ? [node.props.stroke] : [])],

  // 画像の塗りの Asset（MAI-83）
  assets: (node) => {
    const fill = fillOf(node.props)
    return fill?.type === 'image' ? [fill.assetId] : []
  },

  // 楕円と角丸（MAI-84）は、矢印が縁で止まるよう多角形で近似する（MAI-28）
  outline(node) {
    const { w, h, shape } = node.props
    if (shape === 'rect') return roundedRectPolygon({ x: 0, y: 0, w, h }, geoCornerRadii(node.props))
    const points = []
    for (let i = 0; i < ELLIPSE_OUTLINE_POINTS; i++) {
      const a = (i / ELLIPSE_OUTLINE_POINTS) * Math.PI * 2
      points.push({ x: w / 2 + (w / 2) * Math.cos(a), y: h / 2 + (h / 2) * Math.sin(a) })
    }
    return points
  },

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

// 塗り。版 1 のまま（移す前）のレコードが来ても描けるよう、色の文字列も読む
function fillOf(props: GeoProps): Fill {
  return typeof props.fill === 'string' ? toFill(props.fill) : props.fill
}

// 角丸を持てる図形か（MAI-84。矩形だけ）
export function canRoundCorners(node: NodeRecord): node is GeoNode {
  return node.type === 'geo' && (node.props as Partial<GeoProps>).shape === 'rect'
}

// 図形の角の半径（保存してある値。楕円は 0）
export function geoCornerRadius(props: GeoProps): CornerRadius {
  return props.shape === 'rect' ? (props.cornerRadius ?? 0) : 0
}

// 描くときの角の半径（箱に収めたもの）
export function geoCornerRadii(props: GeoProps) {
  return props.shape === 'rect' ? effectiveCornerRadii(props.cornerRadius, props.w, props.h) : cornerRadii(0)
}

// 図形の中か。grow だけ外へ広げて（負なら内へ縮めて）判定する
function insideShape(props: GeoProps, point: { x: number; y: number }, grow: number): boolean {
  const { shape, w, h } = props
  if (shape === 'rect') return insideRoundedRect({ x: 0, y: 0, w, h }, geoCornerRadii(props), point, grow)
  // 楕円：中心からの正規化距離で判定する
  const rx = w / 2 + grow
  const ry = h / 2 + grow
  if (rx <= 0 || ry <= 0) return false
  const dx = (point.x - w / 2) / rx
  const dy = (point.y - h / 2) / ry
  return dx * dx + dy * dy <= 1
}

function insideBox(box: { x: number; y: number; w: number; h: number }, point: { x: number; y: number }): boolean {
  return point.x >= box.x && point.y >= box.y && point.x <= box.x + box.w && point.y <= box.y + box.h
}

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
