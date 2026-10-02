import type { Box } from '@canvcode/core'
import { offsetRoundedRect, roundedRectPath, type CornerRadii } from './cornerRadius.ts'
import { clampOpacity, isPaint, solidPaint, type SolidPaint } from './paint.ts'

// ボーダー（線。MAI-85）。図形（geo）の線の形と、Canvas への描き方。
// 後のブロック矢印（MAI-87）も、同じ props の名前（StrokeProps）と strokeOutline を使う。
// - 線の色は単色の塗り（paint.ts の SolidPaint。色と不透明度）。線なしは null。グラデーション・画像の線は持たない
// - 太さ（strokeWidth）はワールド座標の px。0 も線なしと同じに見える（古いデータ）
// - 位置（strokeAlign）：形の縁の内側・中央・外側。外側の線は getBounds の箱の外へはみ出す（strokeOutset。索引・カリング・当たり判定が使う）
// - 種類（strokeDash）：実線・破線・点線。破線の長さ（strokeDashLength）と間隔（strokeDashGap）はワールド座標の px
//   （Figma と同じ。太さを変えても長さは変わらない）。点線の点の直径は太さ、間隔は点の縁どうしの間。
//   値がないとき（実線から切り替えた直後の古いデータなど）は、太さの倍率の既定（defaultDashLength など）で描く
// どれも省略できる値（ないときは中央・実線）なので、足しても形の版は上げない。色の文字列（geo の版 2 まで）は toStrokePaint で読む

export type StrokeAlign = 'inside' | 'center' | 'outside'
export type StrokeDash = 'solid' | 'dashed' | 'dotted'

export const STROKE_ALIGNS: readonly StrokeAlign[] = ['inside', 'center', 'outside']
export const STROKE_DASHES: readonly StrokeDash[] = ['solid', 'dashed', 'dotted']

// 線の色。null は線なし
export type StrokePaint = SolidPaint | null

// 線を持つノードの props（geo、のちのブロック矢印）
export interface StrokeProps {
  stroke: StrokePaint
  strokeWidth: number
  strokeAlign?: StrokeAlign
  strokeDash?: StrokeDash
  strokeDashLength?: number
  strokeDashGap?: number
}

// 描くときの線（既定と読めない値を埋めたもの）
export interface StrokeStyle {
  paint: StrokePaint
  width: number
  align: StrokeAlign
  dash: StrokeDash
  dashLength: number
  dashGap: number
}

// 破線の長さ・間隔の範囲（px）
export const STROKE_DASH_MIN = 0.5
export const STROKE_DASH_MAX = 1000

// 値がないときの破線の長さと間隔（太さの倍率。太さ 2 なら 8px と 4px）
export function defaultDashLength(width: number): number {
  return clampDash(Math.max(width, 1) * 4)
}

export function defaultDashGap(width: number): number {
  return clampDash(Math.max(width, 1) * 2)
}

export function clampDash(value: number): number {
  return Number.isFinite(value) ? Math.min(STROKE_DASH_MAX, Math.max(STROKE_DASH_MIN, value)) : STROKE_DASH_MIN
}

// 線の色として読む。色の文字列（geo の版 2 まで）は単色に、空・'none'・'transparent' は線なしにする。
// 単色でない塗り・読めないものは fallback
export function toStrokePaint(value: unknown, fallback: StrokePaint = null): StrokePaint {
  if (value === null) return null
  if (typeof value === 'string') {
    const color = value.trim()
    if (color === '' || color === 'none' || color === 'transparent') return null
    return solidPaint(color)
  }
  if (isPaint(value) && value.type === 'solid') return { ...value, opacity: clampOpacity(typeof value.opacity === 'number' ? value.opacity : 1) }
  return fallback
}

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

// props から描く線を読む。古いデータ（色の文字列・位置や種類がない）も読む
export function strokeStyleOf(props: Partial<Record<keyof StrokeProps, unknown>>): StrokeStyle {
  const width = positive(props.strokeWidth) ?? 0
  const align = STROKE_ALIGNS.includes(props.strokeAlign as StrokeAlign) ? (props.strokeAlign as StrokeAlign) : 'center'
  const dash = STROKE_DASHES.includes(props.strokeDash as StrokeDash) ? (props.strokeDash as StrokeDash) : 'solid'
  const length = positive(props.strokeDashLength)
  const gap = positive(props.strokeDashGap)
  return {
    paint: toStrokePaint(props.stroke),
    width,
    align,
    dash,
    dashLength: length === null ? defaultDashLength(width) : clampDash(length),
    dashGap: gap === null ? defaultDashGap(width) : clampDash(gap),
  }
}

// 線が見えるか（色があり、不透明度と太さが 0 でない）
export function hasVisibleStroke(style: StrokeStyle): boolean {
  return style.paint !== null && style.paint.opacity > 0 && style.width > 0
}

// 線が形の縁から外へ・内へ届く幅。外側は getBounds の箱の外へのはみ出し（索引・カリング・当たり判定）、
// 内側は塗りなしの図形の当たり判定（枠だけ当たる）に使う
export function strokeOutset(style: StrokeStyle): number {
  if (!hasVisibleStroke(style)) return 0
  return style.align === 'outside' ? style.width : style.align === 'center' ? style.width / 2 : 0
}

export function strokeInset(style: StrokeStyle): number {
  if (!hasVisibleStroke(style)) return 0
  return style.align === 'inside' ? style.width : style.align === 'center' ? style.width / 2 : 0
}

// 線を描く形。矩形（角丸。MAI-84）と楕円は、縁から d だけずらした形も正確に作れる（点線の内側・外側に使う）。
// 任意のパス（のちのブロック矢印など）は、ずらせないので切り抜きで描く
export type StrokeOutline =
  | { kind: 'rect'; box: Box; radii: CornerRadii }
  | { kind: 'ellipse'; box: Box }
  | { kind: 'path'; path: Path2D; bounds: Box }

// 形を d だけ外へ広げた（負なら内へ縮めた）パスを、今のパスに足す（beginPath はしない）。
// 縮めて形がなくなれば false（何も足さない）。任意のパスはずらせない（d は 0 だけ）。
// シャドウ（MAI-86）も広がりの形に使う（Path2D にも足せる）
export function addOutlinePath(ctx: CanvasRenderingContext2D | Path2D, outline: StrokeOutline, d: number): boolean {
  switch (outline.kind) {
    case 'rect': {
      const { box, radii } = d === 0 ? outline : offsetRoundedRect(outline.box, outline.radii, d)
      if (box.w <= 0 || box.h <= 0) return false
      roundedRectPath(ctx, box, radii)
      return true
    }
    case 'ellipse': {
      const { x, y, w, h } = outline.box
      const rx = w / 2 + d
      const ry = h / 2 + d
      if (rx <= 0 || ry <= 0) return false
      // 楕円をずらした形は厳密には楕円ではないが、半径を d だけ変えた楕円で近似する（円なら同じ）
      ctx.moveTo(x + w / 2 + rx, y + h / 2)
      ctx.ellipse(x + w / 2, y + h / 2, rx, ry, 0, 0, Math.PI * 2)
      return true
    }
    case 'path':
      return false
  }
}

function outlineBounds(outline: StrokeOutline): Box {
  return outline.kind === 'path' ? outline.bounds : outline.box
}

// 線を描く（ctx はノードのローカル座標）。線の不透明度は globalAlpha に掛ける（ノードの不透明度はすでに掛かっている）。
// Canvas の状態は変えない（save / restore の中で描く）が、今のパスは描いた線のパスに置き換わる。
// - 中央：形の縁をそのまま、太さで描く
// - 内側：形で切り抜き、2 倍の太さで描く（縁の内側の半分だけが残る）
// - 外側：形の外（大きな矩形と形を evenodd で）で切り抜き、2 倍の太さで描く
//   切り抜きなので、角丸・楕円でも塗りの縁とぴったり合う（隙間もはみ出しもない）
// - 点線は lineCap round・長さ 0 の破線で丸い点を並べる。内側・外側は、半分に切れた点にならないよう、
//   縁から太さの半分だけずらした形を描く（任意のパスはずらせないので、切り抜きで描く）
// - 破線は lineCap butt。破線の模様は形の縁（ずらした形なら、その縁）に沿って測る
export function strokeOutline(ctx: CanvasRenderingContext2D, style: StrokeStyle, outline: StrokeOutline): void {
  if (!hasVisibleStroke(style)) return
  const { width, align, dash } = style
  ctx.save()
  ctx.globalAlpha *= style.paint!.opacity
  ctx.strokeStyle = style.paint!.color
  ctx.lineJoin = 'miter'
  ctx.miterLimit = 10
  if (dash === 'dotted') {
    ctx.lineCap = 'round'
    ctx.setLineDash([0, style.dashGap + width])
  } else if (dash === 'dashed') {
    ctx.lineCap = 'butt'
    ctx.setLineDash([style.dashLength, style.dashGap])
  } else {
    ctx.lineCap = 'butt'
    ctx.setLineDash([])
  }
  ctx.lineDashOffset = 0
  const shift = align === 'inside' ? -width / 2 : align === 'outside' ? width / 2 : 0
  ctx.beginPath()
  if (align === 'center' || (dash === 'dotted' && outline.kind !== 'path')) {
    // 中央、またはずらした形の点線
    if (addOutlinePath(ctx, outline, align === 'center' ? 0 : shift)) {
      ctx.lineWidth = width
      strokeCurrent(ctx, outline)
    }
  } else {
    if (align === 'inside') {
      clipTo(ctx, outline)
    } else {
      // 形の外：形を含む大きな矩形と形を evenodd で
      const b = outlineBounds(outline)
      const pad = width * 2 + 1
      if (outline.kind === 'path') {
        const outer = new Path2D()
        outer.rect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2)
        outer.addPath(outline.path)
        ctx.clip(outer, 'evenodd')
      } else {
        ctx.beginPath()
        ctx.rect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2)
        addOutlinePath(ctx, outline, 0)
        ctx.clip('evenodd')
      }
    }
    ctx.beginPath()
    if (outline.kind !== 'path') addOutlinePath(ctx, outline, 0)
    ctx.lineWidth = width * 2
    strokeCurrent(ctx, outline)
  }
  ctx.restore()
}

function strokeCurrent(ctx: CanvasRenderingContext2D, outline: StrokeOutline): void {
  if (outline.kind === 'path') ctx.stroke(outline.path)
  else ctx.stroke()
}

function clipTo(ctx: CanvasRenderingContext2D, outline: StrokeOutline): void {
  if (outline.kind === 'path') {
    ctx.clip(outline.path)
    return
  }
  ctx.beginPath()
  addOutlinePath(ctx, outline, 0)
  ctx.clip()
}
