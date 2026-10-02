import type { Box, Vec } from '@canvcode/core'

// 塗り（MAI-81）。図形（geo）の塗りの形と、Canvas への描き方。
// 後の課題の、グラデーション（MAI-82）・画像（MAI-83）・ボーダー（MAI-85）・ブロック矢印（MAI-87）も同じ形を使う。
// - Paint は「種類（type）＋中身」。単色（solid）と、線形・円形のグラデーション（linear・radial。MAI-82）。
//   種類を足すときは、union に足して paintStyle・paintColors・fillPreviewColor・paintCss を対応させる
// - opacity は塗りの不透明度（0〜1）。種類によらず持つ（Figma と同じ）。ノードの不透明度（NodeRecord.opacity）とは別で、掛け合わせて描く
// - 塗りなしは null（Fill）。Figma のような塗りの配列（重ね塗り）にはしない：パネルで 1 つの塗りを選ぶ UI に合わせ、
//   重ねたくなったら fill を fills: Paint[] に移す版を足す（描くのは fillShape だけなので、移しやすい）

export interface SolidPaint {
  type: 'solid'
  // 色（#rrggbb。古いデータや取り込みでは CSS の色の文字列のこともある）
  color: string
  // 塗りの不透明度（0〜1）
  opacity: number
}

// グラデーションの色の止まり位置（stop）。position は始点 0 〜 終点 1、opacity はその色の不透明度（0〜1）
export interface GradientStop {
  position: number
  color: string
  opacity: number
}

// グラデーション（MAI-82）。位置は、塗る形の外接の箱（fillShape の box）に対する割合（左上 0,0 〜 右下 1,1）で持つ。
// 箱の大きさを変えれば一緒に伸び、図形を回せば（ノードのローカル座標で描くので）一緒に回る（Figma の gradientTransform を簡単にしたもの）。
// stops は position の順に並べておく（sortStops）。少なくとも 2 つ
//
// 線形：始点 start から終点 end へ。等しい色の線は、箱の実際の大きさ（px）で start→end に直角
// （向き＝角度は、箱の大きさで見た start→end の向き。gradientAngle）
export interface LinearGradientPaint {
  type: 'linear'
  start: Vec
  end: Vec
  stops: GradientStop[]
  opacity: number
}

// 円形：中心 center から、半径 radius（箱の幅・高さに対する割合）まで。
// 箱が横長なら横長の楕円になる（正方形の箱で円。楕円の図形の既定の center 0.5,0.5・radius 0.5 は図形の縁にちょうど合う）
export interface RadialGradientPaint {
  type: 'radial'
  center: Vec
  radius: number
  stops: GradientStop[]
  opacity: number
}

export type GradientPaint = LinearGradientPaint | RadialGradientPaint

export type Paint = SolidPaint | GradientPaint

export type PaintType = Paint['type']

// 塗り。null は塗りなし
export type Fill = Paint | null

export function solidPaint(color: string, opacity = 1): SolidPaint {
  return { type: 'solid', color, opacity: clampOpacity(opacity) }
}

export function clampOpacity(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1
}

export function isGradientPaint(paint: Fill | undefined): paint is GradientPaint {
  return paint?.type === 'linear' || paint?.type === 'radial'
}

export function isPaint(value: unknown): value is Paint {
  if (typeof value !== 'object' || value === null) return false
  const paint = value as { type?: unknown; color?: unknown; start?: unknown; end?: unknown; center?: unknown; radius?: unknown; stops?: unknown }
  switch (paint.type) {
    case 'solid':
      return typeof paint.color === 'string'
    case 'linear':
      return isVec(paint.start) && isVec(paint.end) && validStops(paint.stops)
    case 'radial':
      return isVec(paint.center) && typeof paint.radius === 'number' && Number.isFinite(paint.radius) && validStops(paint.stops)
    default:
      return false
  }
}

function isVec(value: unknown): value is Vec {
  const v = value as Partial<Vec> | null
  return typeof v === 'object' && v !== null && Number.isFinite(v.x) && Number.isFinite(v.y)
}

function validStops(value: unknown): value is GradientStop[] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.every((stop: Partial<GradientStop> | null) => typeof stop === 'object' && stop !== null && typeof stop.color === 'string' && Number.isFinite(stop.position))
  )
}

// ---- グラデーション ----

// 既定の位置：線形は上から下へ（Figma と同じ）、円形は箱の中心から縁まで
export const DEFAULT_LINEAR_START: Vec = { x: 0.5, y: 0 }
export const DEFAULT_LINEAR_END: Vec = { x: 0.5, y: 1 }
export const DEFAULT_RADIAL_CENTER: Vec = { x: 0.5, y: 0.5 }
export const DEFAULT_RADIAL_RADIUS = 0.5

export function gradientStop(position: number, color: string, opacity = 1): GradientStop {
  return { position: clamp01(position), color, opacity: clampOpacity(opacity) }
}

export function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
}

// position の順に並べる（同じ位置なら元の順）
export function sortStops(stops: readonly GradientStop[]): GradientStop[] {
  return stops
    .map((stop, i) => ({ stop, i }))
    .sort((a, b) => a.stop.position - b.stop.position || a.i - b.i)
    .map(({ stop }) => stop)
}

export function linearGradient(stops: readonly GradientStop[], options: { start?: Vec; end?: Vec; opacity?: number } = {}): LinearGradientPaint {
  return {
    type: 'linear',
    start: options.start ?? DEFAULT_LINEAR_START,
    end: options.end ?? DEFAULT_LINEAR_END,
    stops: sortStops(stops),
    opacity: clampOpacity(options.opacity ?? 1),
  }
}

export function radialGradient(stops: readonly GradientStop[], options: { center?: Vec; radius?: number; opacity?: number } = {}): RadialGradientPaint {
  return {
    type: 'radial',
    center: options.center ?? DEFAULT_RADIAL_CENTER,
    radius: Math.max(0, options.radius ?? DEFAULT_RADIAL_RADIUS),
    stops: sortStops(stops),
    opacity: clampOpacity(options.opacity ?? 1),
  }
}

// 塗りの種類を変える（パネルの「単色／線形／円形」）。今の見た目から自然に続くように：
// - 単色 → グラデーション：今の色から、同じ色の透明へ（Figma と同じ）
// - 線形 ↔ 円形：止め色はそのまま、位置は既定
// - グラデーション → 単色：最初の止め色
// - 塗りなし → fallback の色（図形の既定の色）から
export function convertPaint(current: Fill, type: PaintType, fallbackColor: string): Paint {
  if (current?.type === type) return current
  const opacity = current?.opacity ?? 1
  if (type === 'solid') {
    const color = current && isGradientPaint(current) ? current.stops[0].color : fallbackColor
    return solidPaint(color, opacity)
  }
  const stops = current && isGradientPaint(current) ? current.stops : defaultStops(current?.type === 'solid' ? current.color : fallbackColor)
  return type === 'linear' ? linearGradient(stops, { opacity }) : radialGradient(stops, { opacity })
}

function defaultStops(color: string): GradientStop[] {
  return [gradientStop(0, color, 1), gradientStop(1, color, 0)]
}

// 線形のグラデーションの向き（度。0° は左から右、時計回り。y は下向き）。
// 箱の実際の大きさ（w, h）で見た start→end の向きなので、横長の箱の 45° は箱の対角線とは限らない
export function gradientAngle(paint: LinearGradientPaint, size: { w: number; h: number }): number {
  const dx = (paint.end.x - paint.start.x) * size.w
  const dy = (paint.end.y - paint.start.y) * size.h
  if (dx === 0 && dy === 0) return 0
  return normalizeAngle((Math.atan2(dy, dx) * 180) / Math.PI)
}

export function normalizeAngle(degrees: number): number {
  const a = ((degrees % 360) + 360) % 360
  // 丸めの誤差で 359.9999… や -0 にならないように
  const rounded = Math.round(a * 1000) / 1000
  return rounded === 360 ? 0 : rounded + 0
}

// 線形のグラデーションを angle（度）に向ける。始点と終点の真ん中はそのままに、箱を覆う長さ（CSS の linear-gradient と同じ。
// 箱の大きさで見て |w cos| + |h sin|）にする
export function withGradientAngle(paint: LinearGradientPaint, angle: number, size: { w: number; h: number }): LinearGradientPaint {
  const w = Math.max(size.w, 1e-6)
  const h = Math.max(size.h, 1e-6)
  const rad = (angle * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const half = (Math.abs(w * cos) + Math.abs(h * sin)) / 2
  const mid = { x: ((paint.start.x + paint.end.x) / 2) * w, y: ((paint.start.y + paint.end.y) / 2) * h }
  const round = (v: number) => Math.round(v * 1e6) / 1e6
  const rel = (x: number, y: number): Vec => ({ x: round(x / w), y: round(y / h) })
  return { ...paint, start: rel(mid.x - cos * half, mid.y - sin * half), end: rel(mid.x + cos * half, mid.y + sin * half) }
}

// 位置 t（0〜1）での色（止め色の間を線形に混ぜる）。新しい止め色を足すときの色に使う
export function colorAtPosition(stops: readonly GradientStop[], t: number): { color: string; opacity: number } {
  const sorted = sortStops(stops)
  if (sorted.length === 0) return { color: '#000000', opacity: 1 }
  if (t <= sorted[0].position) return { color: sorted[0].color, opacity: sorted[0].opacity }
  const last = sorted[sorted.length - 1]
  if (t >= last.position) return { color: last.color, opacity: last.opacity }
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]
    const b = sorted[i]
    if (t > b.position) continue
    const k = b.position === a.position ? 0 : (t - a.position) / (b.position - a.position)
    const ca = parseHexColor(a.color)
    const cb = parseHexColor(b.color)
    const opacity = Math.round((a.opacity + (b.opacity - a.opacity) * k) * 1000) / 1000
    if (!ca || !cb) return { color: k < 0.5 ? a.color : b.color, opacity }
    const mix = (x: number, y: number) => x + (y - x) * k
    return { color: rgbToHex({ r: mix(ca.r, cb.r), g: mix(ca.g, cb.g), b: mix(ca.b, cb.b) }), opacity }
  }
  return { color: last.color, opacity: last.opacity }
}

// 塗りとして読む。色の文字列（版 1 の geo の fill）は単色の塗りに、空・'none'・'transparent' は塗りなしにする。
// 読めないもの（知らない種類など）は fallback
export function toFill(value: unknown, fallback: Fill = null): Fill {
  if (value === null) return null
  if (typeof value === 'string') {
    const color = value.trim()
    if (color === '' || color === 'none' || color === 'transparent') return null
    return solidPaint(color)
  }
  if (isPaint(value)) {
    const opacity = clampOpacity(typeof value.opacity === 'number' ? value.opacity : 1)
    if (value.type === 'solid') return { ...value, opacity }
    const stops = sortStops(value.stops.map((stop) => gradientStop(stop.position, stop.color, typeof stop.opacity === 'number' ? stop.opacity : 1)))
    return value.type === 'linear' ? { ...value, stops, opacity } : { ...value, radius: Math.max(0, value.radius), stops, opacity }
  }
  return fallback
}

// 今の Canvas のパスを、塗りで塗る（ctx はノードのローカル座標）。box は塗る形の外接の箱（グラデーション・画像の位置に使う）。
// 塗りの不透明度は globalAlpha に掛ける（ノードの不透明度はすでに掛かっている）。パスはそのまま残る（あとで線を描ける）
export function fillShape(ctx: CanvasRenderingContext2D, fill: Fill, box: Box): void {
  if (!fill || fill.opacity <= 0) return
  // 幅・高さのない箱には、グラデーションの位置が決まらない
  if (isGradientPaint(fill) && (box.w <= 0 || box.h <= 0)) return
  ctx.save()
  ctx.globalAlpha *= fill.opacity
  // パスはすでに今の座標で決まっているので、座標を変えても塗る形は変わらない（塗りの模様の座標だけが変わる）
  const m = paintTransform(fill, box)
  if (m) ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5])
  ctx.fillStyle = paintStyle(ctx, fill, box)
  ctx.fill()
  ctx.restore()
}

// paintStyle の模様を描く座標（今の座標からの行列 [a, b, c, d, e, f]）。null なら今の座標のまま。
// 円形のグラデーションは、箱を 1×1 にした座標で作る（横長の箱で楕円になる）
export function paintTransform(paint: Paint, box: Box): [number, number, number, number, number, number] | null {
  if (paint.type !== 'radial') return null
  return [box.w, 0, 0, box.h, box.x, box.y]
}

// Canvas の fillStyle（strokeStyle）にする値。不透明度（paint.opacity）は含めない（fillShape が globalAlpha で掛ける）。
// 止め色の不透明度は含める。グラデーションは paintTransform の座標で作る（線形は今の座標、円形は箱を 1×1 にした座標）
export function paintStyle(ctx: CanvasRenderingContext2D, paint: Paint, box: Box): string | CanvasGradient | CanvasPattern {
  switch (paint.type) {
    case 'solid':
      return paint.color
    case 'linear': {
      const at = (p: Vec) => ({ x: box.x + p.x * box.w, y: box.y + p.y * box.h })
      const a = at(paint.start)
      let b = at(paint.end)
      // 始点と終点が重なると、Canvas は何も塗らない。最後の止め色で塗れるよう、少しだけずらす
      if (a.x === b.x && a.y === b.y) b = { x: a.x, y: a.y + 1e-3 }
      const gradient = ctx.createLinearGradient(a.x, a.y, b.x, b.y)
      addStops(gradient, paint.stops)
      return gradient
    }
    case 'radial': {
      const gradient = ctx.createRadialGradient(paint.center.x, paint.center.y, 0, paint.center.x, paint.center.y, Math.max(paint.radius, 1e-6))
      addStops(gradient, paint.stops)
      return gradient
    }
  }
}

function addStops(gradient: CanvasGradient, stops: readonly GradientStop[]): void {
  for (const stop of sortStops(stops)) {
    try {
      gradient.addColorStop(clamp01(stop.position), colorWithAlpha(stop.color, stop.opacity))
    } catch {
      // 読めない色は飛ばす
    }
  }
}

// 塗りを 1 色で表すとき（ズームアウト時の簡略描画・パネルの見本）の CSS の色。不透明度も入れる。塗りなしは null
export function fillPreviewColor(fill: Fill): string | null {
  if (!fill) return null
  switch (fill.type) {
    case 'solid':
      return colorWithAlpha(fill.color, fill.opacity)
    case 'linear':
    case 'radial':
      return averageStopColor(fill)
  }
}

// グラデーションを 1 色で表す：止め色を、隣の止め色までの幅の重みで平均する（不透明度も）
function averageStopColor(paint: GradientPaint): string {
  const stops = sortStops(paint.stops)
  let r = 0
  let g = 0
  let b = 0
  let a = 0
  let total = 0
  stops.forEach((stop, i) => {
    const left = i === 0 ? stop.position : (stop.position - stops[i - 1].position) / 2
    const right = i === stops.length - 1 ? 1 - stop.position : (stops[i + 1].position - stop.position) / 2
    const weight = Math.max(left + right, 1e-6)
    const rgba = parseHexColor(stop.color) ?? { r: 0, g: 0, b: 0, a: 1 }
    r += rgba.r * weight
    g += rgba.g * weight
    b += rgba.b * weight
    a += rgba.a * clampOpacity(stop.opacity) * weight
    total += weight
  })
  const alpha = Math.round((a / total) * clampOpacity(paint.opacity) * 1000) / 1000
  const rgb = { r: Math.round(r / total), g: Math.round(g / total), b: Math.round(b / total) }
  return alpha >= 1 ? rgbToHex(rgb) : `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`
}

// 塗りの見本（パネル）に使う CSS の background。グラデーションは CSS のグラデーションにする（向き・中心は箱の割合で近い形に）。
// size は見本に見せる図形の大きさ（線形の角度を合わせる）。不透明度も入れる。塗りなしは null
export function paintCss(fill: Fill, size: { w: number; h: number } = { w: 1, h: 1 }): string | null {
  if (!fill) return null
  if (fill.type === 'solid') return colorWithAlpha(fill.color, fill.opacity)
  const stops = sortStops(fill.stops)
    .map((stop) => `${colorWithAlpha(stop.color, clampOpacity(stop.opacity) * fill.opacity)} ${Math.round(stop.position * 1000) / 10}%`)
    .join(', ')
  if (fill.type === 'linear') {
    // CSS の角度は 0deg が上向き・時計回り
    return `linear-gradient(${normalizeAngle(gradientAngle(fill, size) + 90)}deg, ${stops})`
  }
  const pct = (v: number) => `${Math.round(v * 1000) / 10}%`
  return `radial-gradient(${pct(fill.radius)} ${pct(fill.radius)} at ${pct(fill.center.x)} ${pct(fill.center.y)}, ${stops})`
}

// 塗りに使っている色（「このキャンバスで使った色」の一覧に出す。グラデーションなら止め色）
export function paintColors(fill: Fill): string[] {
  if (!fill) return []
  switch (fill.type) {
    case 'solid':
      return [fill.color]
    case 'linear':
    case 'radial':
      return fill.stops.map((stop) => stop.color)
  }
}

// ---- 色 ----

export interface Rgba {
  r: number
  g: number
  b: number
  // 0〜1
  a: number
}

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

// #rgb・#rgba・#rrggbb・#rrggbbaa を読む。それ以外（rgb() や色の名前）は null
export function parseHexColor(color: string): Rgba | null {
  const match = HEX.exec(color.trim())
  if (!match) return null
  let hex = match[1]
  if (hex.length <= 4) hex = [...hex].map((c) => c + c).join('')
  const value = (i: number) => parseInt(hex.slice(i, i + 2), 16)
  return { r: value(0), g: value(2), b: value(4), a: hex.length === 8 ? Math.round((value(6) / 255) * 1000) / 1000 : 1 }
}

// #rrggbb（小文字）。a は入れない
export function rgbToHex({ r, g, b }: { r: number; g: number; b: number }): string {
  const part = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

// 色の比べ方をそろえる（#ABC → #aabbcc）。16 進で書いていない色は、前後の空白を除いてそのまま
export function normalizeColor(color: string): string {
  const rgba = parseHexColor(color)
  if (!rgba) return color.trim()
  return rgba.a < 1 ? `${rgbToHex(rgba)}${Math.round(rgba.a * 255).toString(16).padStart(2, '0')}` : rgbToHex(rgba)
}

// 色に不透明度を掛けた CSS の色。16 進で読めない色で 1 未満なら、そのまま返す（呼ぶ側で globalAlpha を使う）
export function colorWithAlpha(color: string, alpha: number): string {
  if (alpha >= 1) return color
  const rgba = parseHexColor(color)
  if (!rgba) return color
  return `rgba(${rgba.r}, ${rgba.g}, ${rgba.b}, ${Math.round(rgba.a * clampOpacity(alpha) * 1000) / 1000})`
}
