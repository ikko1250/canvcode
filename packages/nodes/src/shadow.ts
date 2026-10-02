import type { Box } from '@canvcode/core'
import type { Outset } from './defineNodeType.ts'
import { clampOpacity } from './paint.ts'
import { addOutlinePath, type StrokeOutline } from './stroke.ts'

// シャドウ（影。MAI-86）。図形（geo）の影の形と、Canvas への描き方。
// 後のブロック矢印（MAI-87）も、同じ props の名前（ShadowProps）と drawShadows を使う。
// - 影は複数持てる（Figma の Effects と同じ）。配列の順に描く（あとのものが上）。パネルも同じ順に並べ、＋は末尾に足す
// - ドロップシャドウ（drop）：塗りの形の影を、塗りの下に描く。ずらし（x・y）・ぼかし（blur）・広がり（spread）はワールド座標の px。
//   Figma の「透明な部分の後ろに影を表示」がオフのときと同じく、形の中には影を描かない（塗りが半透明・塗りなしでも影は透けない）
// - 内側の影（inner）：形で切り抜き、形の内側に落ちる影を、塗りの上（線の下）に描く
// - ずらしはノードのローカル座標（回転した図形では、影の向きも一緒に回る。Figma と同じ）
// - ぼかしは CSS の box-shadow と同じ（ガウスの標準偏差がぼかしの半分。Canvas の shadowBlur と同じ定義）
// - 色（#rrggbb）と不透明度（0〜1）。visible が false の影は描かない（パネルの目のボタン。値は残す）
// どれも省略できる値（shadows がない・空なら影なし）なので、足しても形の版は上げない。読めない影は捨てる（shadowsOf）

export type ShadowType = 'drop' | 'inner'
export const SHADOW_TYPES: readonly ShadowType[] = ['drop', 'inner']

export interface Shadow {
  type: ShadowType
  x: number
  y: number
  blur: number
  spread: number
  color: string
  opacity: number
  // false なら描かない（ないときは表示）
  visible?: boolean
}

// 影を持つノードの props（geo、のちのブロック矢印）
export interface ShadowProps {
  shadows?: Shadow[]
}

// 新しく足す影の既定（Figma と同じ：下へ 4px、ぼかし 4px、黒の 25 %）
export function defaultShadow(type: ShadowType = 'drop'): Shadow {
  return { type, x: 0, y: 4, blur: 4, spread: 0, color: '#000000', opacity: 0.25 }
}

// パネルで打てる値の範囲（px）
export const SHADOW_OFFSET_LIMIT = 10000
export const SHADOW_BLUR_MAX = 1000
export const SHADOW_SPREAD_LIMIT = 1000

// ガウスのぼかしが届く幅（ぼかしの値に対する倍率）。標準偏差（ぼかしの半分）の 3 倍。
// これより外は 0.2 % 未満なので、描く範囲（renderOutset）はここまでにする
export const SHADOW_BLUR_REACH = 1.5

// 画面上の大きさがこれより小さいノードには影を描かない（CSS ピクセル。MAI-14 の簡略描画のしきい値 4px より少し大きい）
export const SHADOW_MIN_NODE_PX = 8
// 画面上で形の縁から届く幅がこれより小さい影は、見えないので描かない（CSS ピクセル）
const SHADOW_MIN_REACH_PX = 0.5

function finite(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

// 1 つの影として読む。読めないもの（種類・色がない）は null
export function toShadow(value: unknown): Shadow | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (!SHADOW_TYPES.includes(v.type as ShadowType) || typeof v.color !== 'string' || v.color.trim() === '') return null
  const shadow: Shadow = {
    type: v.type as ShadowType,
    x: finite(v.x, 0, -SHADOW_OFFSET_LIMIT, SHADOW_OFFSET_LIMIT),
    y: finite(v.y, 0, -SHADOW_OFFSET_LIMIT, SHADOW_OFFSET_LIMIT),
    blur: finite(v.blur, 0, 0, SHADOW_BLUR_MAX),
    spread: finite(v.spread, 0, -SHADOW_SPREAD_LIMIT, SHADOW_SPREAD_LIMIT),
    color: v.color,
    opacity: typeof v.opacity === 'number' ? clampOpacity(v.opacity) : 1,
  }
  if (v.visible === false) shadow.visible = false
  return shadow
}

// props の影の一覧（古いデータ・読めない値は影なし。読めない影は捨てる）
export function shadowsOf(props: { shadows?: unknown }): Shadow[] {
  return Array.isArray(props.shadows) ? props.shadows.map(toShadow).filter((s): s is Shadow => s !== null) : []
}

// 描く影か（表示で、不透明度が 0 でない）
export function isShadowVisible(shadow: Shadow): boolean {
  return shadow.visible !== false && shadow.opacity > 0
}

// 影が形の縁から外へ届く幅（ローカル座標）。上下左右で違う（ずらしの分）。内側の影は外へ出ない

export function shadowOutset(shadows: readonly Shadow[]): Outset {
  const out = { left: 0, top: 0, right: 0, bottom: 0 }
  for (const shadow of shadows) {
    if (shadow.type !== 'drop' || !isShadowVisible(shadow)) continue
    const reach = shadow.spread + shadow.blur * SHADOW_BLUR_REACH
    out.left = Math.max(out.left, reach - shadow.x)
    out.right = Math.max(out.right, reach + shadow.x)
    out.top = Math.max(out.top, reach - shadow.y)
    out.bottom = Math.max(out.bottom, reach + shadow.y)
  }
  return out
}

// 影の色（「このキャンバスで使った色」に出す。見える影だけ）
export function shadowColors(shadows: readonly Shadow[]): string[] {
  return shadows.filter(isShadowVisible).map((s) => s.color)
}

// 影を描くかの判断に使う、画面の情報
export interface ShadowRenderOptions {
  // 倍率（ワールド 1 単位が画面上で何 CSS ピクセルか）
  zoom: number
  // 形の箱の画面上の大きさ（長い辺。CSS ピクセル）が SHADOW_MIN_NODE_PX 未満なら描かない
  screenSize?: number
}

// 画面上で見える影か（小さすぎるノード・縁から届く幅が小さすぎる影は省く。MAI-14）
export function shouldDrawShadow(shadow: Shadow, options: ShadowRenderOptions): boolean {
  if (!isShadowVisible(shadow)) return false
  if (options.screenSize !== undefined && options.screenSize < SHADOW_MIN_NODE_PX) return false
  const reach = Math.max(Math.abs(shadow.x), Math.abs(shadow.y)) + Math.abs(shadow.spread) + shadow.blur
  return reach * options.zoom >= SHADOW_MIN_REACH_PX
}

// type の影を、形（outline）に描く（ctx はノードのローカル座標）。ドロップシャドウは塗りの前、内側の影は塗りのあと（線の前）に呼ぶ。
// Canvas の状態・今のパスは変えない（Path2D を save / restore の中で塗る）。
// Canvas の shadowBlur・shadowOffset は ctx の変換（ズーム・dpr・回転）に影響されず、デバイスの画素で効く。そこで、
// 形を画面の左の外へずらして描き（影を落とす形そのものは見えない）、影だけを shadowOffset で元の位置＋ずらしへ戻す。
// ぼかしは変換の倍率（ズーム × dpr）を掛け、ずらしは変換の向き（回転）も掛けてデバイスの画素にする。
// 広がりは、形を広げた（内側の影は縮めた）形の影にする（角丸は offsetRoundedRect、楕円は半径を変える。任意のパスは広げない）
export function drawShadows(
  ctx: CanvasRenderingContext2D,
  shadows: readonly Shadow[],
  type: ShadowType,
  outline: StrokeOutline,
  options: ShadowRenderOptions,
): void {
  for (const shadow of shadows) {
    if (shadow.type === type && shouldDrawShadow(shadow, options)) drawShadow(ctx, shadow, outline)
  }
}

function drawShadow(ctx: CanvasRenderingContext2D, shadow: Shadow, outline: StrokeOutline): void {
  const m = ctx.getTransform()
  // ローカル座標の 1 が、デバイスの何画素か（回転・反転によらない倍率）
  const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c))
  if (!(scale > 0)) return
  const bounds = outlineBounds(outline)
  // 影を落とす形を囲む箱（ローカル座標）。内側の影は、形とずらした穴を囲む大きな矩形
  const reach = Math.abs(shadow.x) + Math.abs(shadow.y) + Math.abs(shadow.spread) + shadow.blur * SHADOW_BLUR_REACH * 2 + 1
  const caster = shadow.type === 'drop' ? expand(bounds, Math.max(0, shadow.spread)) : expand(bounds, reach)
  // 形を左へずらす幅（デバイスの画素）：ずらした形の右端が画面の左端より左になるように
  const shift = Math.ceil(Math.max(0, deviceMaxX(m, caster))) + 1

  // 形で切り抜く：ドロップシャドウは形の外（形の中に影を描かない）、内側の影は形の中
  const clip = new Path2D()
  if (shadow.type === 'drop') {
    const outer = expand(bounds, reach)
    clip.rect(outer.x, outer.y, outer.w, outer.h)
  }
  if (!addShape(clip, outline, 0)) return
  // 影を落とす形：ドロップシャドウは広げた形（縮めて形がなくなれば影なし）。
  // 内側の影は、大きな矩形に縮めた形の穴をあけたもの。穴の縁の影が形の内側に落ちる（縮めて穴がなくなれば、形の中がすべて影）
  const casterPath = new Path2D()
  if (shadow.type === 'drop') {
    if (!addShape(casterPath, outline, shadow.spread)) return
  } else {
    casterPath.rect(caster.x, caster.y, caster.w, caster.h)
    addShape(casterPath, outline, -shadow.spread)
  }

  ctx.save()
  ctx.globalAlpha *= shadow.opacity
  ctx.clip(clip, shadow.type === 'drop' ? 'evenodd' : 'nonzero')
  ctx.setTransform(m.a, m.b, m.c, m.d, m.e - shift, m.f)
  ctx.shadowColor = shadow.color
  ctx.shadowBlur = shadow.blur * scale
  ctx.shadowOffsetX = shift + m.a * shadow.x + m.c * shadow.y
  ctx.shadowOffsetY = m.b * shadow.x + m.d * shadow.y
  ctx.fillStyle = '#000000'
  ctx.fill(casterPath, shadow.type === 'drop' ? 'nonzero' : 'evenodd')
  ctx.restore()
}

// 形を d だけ広げた（負なら縮めた）パスを足す。任意のパスは広げられないので、そのまま足す
function addShape(path: Path2D, outline: StrokeOutline, d: number): boolean {
  if (outline.kind !== 'path') return addOutlinePath(path, outline, d)
  path.addPath(outline.path)
  return true
}

function outlineBounds(outline: StrokeOutline): Box {
  return outline.kind === 'path' ? outline.bounds : outline.box
}

function expand(box: Box, d: number): Box {
  return { x: box.x - d, y: box.y - d, w: box.w + d * 2, h: box.h + d * 2 }
}

// 箱の 4 つの角をデバイスの座標にしたときの、右端
function deviceMaxX(m: DOMMatrix, box: Box): number {
  let max = -Infinity
  for (const [x, y] of [
    [box.x, box.y],
    [box.x + box.w, box.y],
    [box.x, box.y + box.h],
    [box.x + box.w, box.y + box.h],
  ]) {
    max = Math.max(max, m.a * x + m.c * y + m.e)
  }
  return max
}
