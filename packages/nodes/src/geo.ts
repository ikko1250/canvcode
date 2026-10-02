import type { Box, NodeRecord } from '@canvcode/core'
import {
  blockArrowGeometry,
  blockArrowParams,
  insidePolygon,
  isBlockArrowShape,
  polygonBounds,
  polygonMiterReach,
  polygonPath,
  type BlockArrowGeometry,
  type BlockArrowProps,
  type BlockArrowShape,
} from './blockArrow.ts'
import { cornerRadii, effectiveCornerRadii, insideRoundedRect, roundedRectPath, roundedRectPolygon, type CornerRadius } from './cornerRadius.ts'
import { defineNodeType, outsetSides } from './defineNodeType.ts'
import { colorWithAlpha, fillPreviewColor, fillShape, paintColors, solidPaint, toFill, type Fill } from './paint.ts'
import { drawShadows, shadowColors, shadowOutset, shadowsOf, type ShadowProps } from './shadow.ts'
import { hasVisibleStroke, strokeInset, strokeOutline, strokeOutset, strokeStyleOf, toStrokePaint, type StrokeOutline, type StrokeProps, type StrokeStyle } from './stroke.ts'
import { TEXT_BAR_THRESHOLD_PX, drawTextBars, drawTextLayout, layoutText, type TextLayout, type TextStyle } from './text/layout.ts'

// 矩形・楕円などの図形（MAI-7 の `geo`）
// 版 2（MAI-81）：塗り（fill）を色の文字列から塗り（paint.ts の Fill。種類＋中身、不透明度、塗りなしは null）にした。
// 版 1 の色の文字列は、読み込むときに単色の塗りへ移す。
// 塗りの種類（グラデーション（MAI-82）・画像（MAI-83））を足しても版は上げない（fill の形は同じ。読めない種類は toFill が既定にする）
// 角丸（MAI-84）の cornerRadius も版は上げない（足しただけの省略できる値。ないときは 0。読めない値も 0）
// 版 3（MAI-85）：線（stroke）を色の文字列から単色の塗り（stroke.ts の StrokePaint。色と不透明度、線なしは null）にした。
// 版 2 までの色の文字列は、読み込むときに単色へ移す。線の位置・種類・破線の長さと間隔（strokeAlign など）は省略できる値
// （ないときは中央・実線）
// シャドウ（MAI-86）の shadows も版は上げない（足しただけの省略できる値。ないときは影なし。読めない影は捨てる）
// ブロック矢印（MAI-87）は shape の種類を足しただけ（blockArrow.ts）。形のパラメータ（arrowShaft など）は省略できる値なので版は上げない。
// 新しい種類を知らない古いアプリは、楕円として描く（読めなくはならない）
export type GeoShape = 'rect' | 'ellipse' | BlockArrowShape
export const GEO_SHAPES: readonly GeoShape[] = ['rect', 'ellipse', 'blockArrow', 'blockArrowBoth', 'blockArrowBent', 'chevron']

export interface GeoProps extends StrokeProps, ShadowProps, BlockArrowProps {
  shape: GeoShape
  w: number
  h: number
  fill: Fill
  // 図形の中央に書く文字（MAI-24）
  label: string
  // 角の半径（MAI-84。矩形だけ）。ワールド座標の px。数値なら 4 つの角が同じ、配列なら [左上, 右上, 右下, 左下]。
  // リサイズしても値は保ち、描くときに短い辺の半分まで（4 つ別々なら CSS の border-radius と同じ縮小の規則で）に収める
  cornerRadius?: CornerRadius
}

export type GeoNode = NodeRecord<GeoProps>

export const GEO_DEFAULT_SIZE = 120
export const GEO_DEFAULT_FILL = '#e8eefc'
export const GEO_DEFAULT_STROKE = '#3b5bdb'
export const GEO_DEFAULT_STROKE_WIDTH = 2
const ELLIPSE_OUTLINE_POINTS = 64

export const geoType = defineNodeType<GeoProps>({
  type: 'geo',
  version: 3,

  defaultProps: () => ({
    shape: 'rect',
    w: GEO_DEFAULT_SIZE,
    h: GEO_DEFAULT_SIZE,
    fill: solidPaint(GEO_DEFAULT_FILL),
    stroke: solidPaint(GEO_DEFAULT_STROKE),
    strokeWidth: GEO_DEFAULT_STROKE_WIDTH,
    label: '',
  }),

  migrate(props, fromVersion) {
    let next = props
    if (fromVersion < 2) next = { ...next, fill: toFill(next.fill, solidPaint(GEO_DEFAULT_FILL)) }
    if (fromVersion < 3) next = { ...next, stroke: toStrokePaint(next.stroke, solidPaint(GEO_DEFAULT_STROKE)) }
    return next
  },

  getBounds: (node) => ({ x: 0, y: 0, w: node.props.w, h: node.props.h }),

  // 線の外側の半分（中央）・全部（外側）は、箱の外へはみ出して描く（MAI-85）。
  // ドロップシャドウ（MAI-86）は、ずらし・ぼかし・広がりの分だけ辺ごとにはみ出す（当たり判定には含めない。Figma と同じ）
  // ブロック矢印（MAI-87）の線は、とがった角（矢じりの先）で太さの半分より遠くまで出る（miter）
  renderOutset: (node) => {
    const arrow = blockArrowOf(node.props)
    const stroke = strokeOutset(strokeStyleOf(node.props)) * (arrow ? polygonMiterReach(arrow.polygon) : 1)
    const shadow = shadowOutset(shadowsOf(node.props))
    if (shadow.left <= stroke && shadow.top <= stroke && shadow.right <= stroke && shadow.bottom <= stroke) return stroke
    return outsetSides({
      left: Math.max(stroke, shadow.left),
      top: Math.max(stroke, shadow.top),
      right: Math.max(stroke, shadow.right),
      bottom: Math.max(stroke, shadow.bottom),
    })
  },

  // 塗りなしの図形は、Figma と同じく枠の線（と文字）にだけ当たる（中を押すと、下のノードを選べる）。
  // ただし線も文字もなく何も見えないときは、見失わないよう中にも当てる。選んでいる図形は中でも掴める（Editor.hitTest）
  // 線の位置（MAI-85）に合わせ、縁の外へはみ出した線（中央・外側）にも当て、塗りなしなら線の内側の縁より内には当てない
  hitTest(node, point, margin) {
    const { label } = node.props
    const stroke = strokeStyleOf(node.props)
    const visible = hasVisibleStroke(stroke)
    const fill = fillOf(node.props)
    const hollow = fill === null && (visible || label !== '')
    if (!insideShape(node.props, point, strokeOutset(stroke) + margin)) return false
    if (!hollow) return true
    if (label !== '' && insideBox(labelBox(node.props), point)) return true
    // 枠の線の内側の縁より内側なら当たらない
    return visible && !insideShape(node.props, point, -(strokeInset(stroke) + margin))
  },

  render(ctx, node, info) {
    const { w, h, shape } = node.props
    // 影（MAI-86）：ドロップシャドウは塗りの下、内側の影は塗りの上（線の下）。
    // 画面上で小さいノード・見えているノードが多いとき（info.noEffects）は描かない（MAI-14）
    const shadows = info.noEffects ? [] : shadowsOf(node.props)
    const shadowOptions = { zoom: info.zoom, screenSize: Math.max(w, h) * info.zoom }
    const arrow = blockArrowOf(node.props)
    if (shadows.length > 0) drawShadows(ctx, shadows, 'drop', geoOutline(node.props), shadowOptions)
    ctx.beginPath()
    // 矩形は角丸（MAI-84）のパス。半径が 0 なら rect と同じ。ブロック矢印（MAI-87）は多角形
    if (arrow) polygonPath(ctx, arrow.polygon)
    else if (shape === 'rect') roundedRectPath(ctx, { x: 0, y: 0, w, h }, geoCornerRadii(node.props))
    else ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2)
    // 画像の塗り（MAI-83）は、このパス（矩形・楕円・角丸・ブロック矢印）で切り抜いて描く。塗りの範囲（グラデーションの位置など）は箱
    fillShape(ctx, fillOf(node.props), { x: 0, y: 0, w, h }, info)
    if (shadows.length > 0) drawShadows(ctx, shadows, 'inner', geoOutline(node.props), shadowOptions)
    // 画面上で 0.5 ピクセル未満になる線は、見た目にほぼ影響しないので描かない（MAI-14）
    const stroke = strokeStyleOf(node.props)
    if (stroke.width * info.zoom >= 0.5) strokeOutline(ctx, stroke, geoOutline(node.props))
    if (node.props.label && !info.editing) {
      const layout = labelLayout(node.props)
      const box = labelBox(node.props)
      if (LABEL_FONT_SIZE * info.zoom < TEXT_BAR_THRESHOLD_PX) drawTextBars(ctx, layout, LABEL_STYLE, box, 'middle')
      else drawTextLayout(ctx, layout, LABEL_STYLE, box, 'middle')
    }
  },

  // 塗りなしは、線の色を薄くして見せる（線もなければ見せない）
  roughColor: (node) => fillPreviewColor(fillOf(node.props)) ?? roughStrokeColor(strokeStyleOf(node.props)),

  colors: (node) => {
    const stroke = strokeStyleOf(node.props)
    return [
      ...paintColors(fillOf(node.props)),
      ...(stroke.paint && stroke.width > 0 ? [stroke.paint.color] : []),
      // 影の色（MAI-86。見える影だけ）
      ...shadowColors(shadowsOf(node.props)),
    ]
  },

  // 画像の塗りの Asset（MAI-83）
  assets: (node) => {
    const fill = fillOf(node.props)
    return fill?.type === 'image' ? [fill.assetId] : []
  },

  // 楕円と角丸（MAI-84）は、矢印が縁で止まるよう多角形で近似する（MAI-28）。ブロック矢印（MAI-87）はその多角形
  outline(node) {
    const { w, h, shape } = node.props
    const arrow = blockArrowOf(node.props)
    if (arrow) return arrow.polygon
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

// 線と影を描く形（矩形は角丸のパス、楕円、ブロック矢印（MAI-87）は多角形の Path2D）。描くときだけ呼ぶ（Path2D を作る）
function geoOutline(props: GeoProps): StrokeOutline {
  const box = { x: 0, y: 0, w: props.w, h: props.h }
  const arrow = blockArrowOf(props)
  if (arrow) {
    let outline = pathOutlineCache.get(arrow)
    if (!outline) {
      const path = new Path2D()
      polygonPath(path, arrow.polygon)
      outline = { kind: 'path', path, bounds: polygonBounds(arrow.polygon) }
      pathOutlineCache.set(arrow, outline)
    }
    return outline
  }
  return props.shape === 'rect' ? { kind: 'rect', box, radii: geoCornerRadii(props) } : { kind: 'ellipse', box }
}

const pathOutlineCache = new WeakMap<BlockArrowGeometry, StrokeOutline>()
const arrowCache = new WeakMap<GeoProps, BlockArrowGeometry>()

// ブロック矢印（MAI-87）の形（箱に収めたもの）。ブロック矢印でなければ null。props ごとに覚えておく
export function blockArrowOf(props: GeoProps): BlockArrowGeometry | null {
  if (!isBlockArrowShape(props.shape)) return null
  let geometry = arrowCache.get(props)
  if (!geometry) {
    geometry = blockArrowGeometry(props.shape, props.w, props.h, blockArrowParams(props.shape, props))
    arrowCache.set(props, geometry)
  }
  return geometry
}

function roughStrokeColor(stroke: StrokeStyle): string {
  return hasVisibleStroke(stroke) ? colorWithAlpha(stroke.paint!.color, 0.35 * stroke.paint!.opacity) : 'transparent'
}

// 線を持てる図形か（MAI-85。geo のすべて。ブロック矢印（MAI-87）も geo の形なので含む）
export function hasBorder(node: NodeRecord): node is GeoNode {
  return node.type === 'geo'
}

// 影を持てる図形か（MAI-86。geo のすべて。ブロック矢印（MAI-87）も含む）
export function hasShadows(node: NodeRecord): node is GeoNode {
  return node.type === 'geo'
}

// ブロック矢印の図形か（MAI-87）
export function isBlockArrow(node: NodeRecord): node is GeoNode {
  return node.type === 'geo' && isBlockArrowShape((node.props as Partial<GeoProps>).shape)
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
  const arrow = blockArrowOf(props)
  if (arrow) return insidePolygon(arrow.polygon, point, grow)
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

// 文字の箱。ブロック矢印（MAI-87）は軸の中（両向きなら矢じりの間、シェブロンは切り込みととがりの間）に収める
function labelBox(props: GeoProps): Box {
  const arrow = blockArrowOf(props)
  if (arrow) return paddedBox(arrow.textBox, LABEL_PADDING)
  return {
    x: LABEL_PADDING,
    y: LABEL_PADDING,
    w: Math.max(1, props.w - LABEL_PADDING * 2),
    h: Math.max(1, props.h - LABEL_PADDING * 2),
  }
}

// 余白を除いた箱。縮めて 1 より小さくなる向きは、真ん中の 1 にする
function paddedBox(box: Box, padding: number): Box {
  const w = box.w - padding * 2
  const h = box.h - padding * 2
  return {
    x: w >= 1 ? box.x + padding : box.x + box.w / 2 - 0.5,
    y: h >= 1 ? box.y + padding : box.y + box.h / 2 - 0.5,
    w: Math.max(1, w),
    h: Math.max(1, h),
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
