import type { Box, Vec } from '@canvcode/core'

// 角丸（MAI-84）。長方形の角の半径と、角丸の長方形のパス・多角形・当たり判定。
// 図形（geo の矩形）のほか、ボーダーの内側/中央/外側（MAI-85）、シャドウ（MAI-86）、ブロック矢印（MAI-87）からも使えるよう、
// 図形の型に依存しない関数だけを置く。
// - 半径はワールド座標の px（Figma と同じ）。4 つの角を一緒に持つ（数値）か、別々に持つ（[左上, 右上, 右下, 左下]）
// - リサイズしても値は変えず、描くときに箱に収める（effectiveCornerRadii。CSS の border-radius と同じ縮小の規則）

// 角の半径。数値なら 4 つの角が同じ、配列なら [左上, 右上, 右下, 左下]
export type CornerRadius = number | CornerRadii
export type CornerRadii = [tl: number, tr: number, br: number, bl: number]

// 角の並び（CornerRadii の番号）
export const CORNERS = ['tl', 'tr', 'br', 'bl'] as const
export type Corner = (typeof CORNERS)[number]

// パネルで打てる半径の上限（描くときは箱に収めるので、これは入力の目安）
export const CORNER_RADIUS_MAX = 10000

function radiusOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, CORNER_RADIUS_MAX) : 0
}

// 保存してある値（古いデータでは undefined）を 4 つの角の半径にする。読めない値は 0
export function cornerRadii(value: unknown): CornerRadii {
  if (Array.isArray(value)) return [radiusOf(value[0]), radiusOf(value[1]), radiusOf(value[2]), radiusOf(value[3])]
  const r = radiusOf(value)
  return [r, r, r, r]
}

// 保存する形。4 つが同じなら数値にまとめる
export function toCornerRadius(radii: readonly number[]): CornerRadius {
  const normalized = cornerRadii(radii)
  return normalized.every((r) => r === normalized[0]) ? normalized[0] : normalized
}

// 角丸があるか
export function hasCornerRadius(value: unknown): boolean {
  return cornerRadii(value).some((r) => r > 0)
}

// 箱（幅 w・高さ h）に収めた半径。CSS の border-radius と同じく、隣り合う 2 つの角の半径の和が辺の長さを超えるなら、
// 4 つの角を同じ割合で縮める（4 つが同じなら、短い辺の半分まで）
export function effectiveCornerRadii(value: unknown, w: number, h: number): CornerRadii {
  const radii = cornerRadii(value)
  const width = Math.max(0, w)
  const height = Math.max(0, h)
  const [tl, tr, br, bl] = radii
  let f = 1
  for (const [side, a, b] of [
    [width, tl, tr],
    [height, tr, br],
    [width, br, bl],
    [height, bl, tl],
  ] as const) {
    if (a + b > side) f = Math.min(f, side / (a + b))
  }
  return f < 1 ? (radii.map((r) => r * f) as CornerRadii) : radii
}

// 半径を d だけ外へ広げた（負なら内へ縮めた）角丸の長方形。線の外側・内側の縁（MAI-85）や、シャドウの広がり（MAI-86）に使う。
// radii は収めたあとの半径。角丸のない角は角のまま（0 は 0 のまま）
export function offsetRoundedRect(box: Box, radii: CornerRadii, d: number): { box: Box; radii: CornerRadii } {
  const next = { x: box.x - d, y: box.y - d, w: Math.max(0, box.w + d * 2), h: Math.max(0, box.h + d * 2) }
  const r = radii.map((v) => (v > 0 ? Math.max(0, v + d) : 0)) as CornerRadii
  return { box: next, radii: effectiveCornerRadii(r, next.w, next.h) }
}

// パスを描ける先（CanvasRenderingContext2D と Path2D の共通部分）
type PathTarget = Pick<CanvasRenderingContext2D, 'moveTo' | 'lineTo' | 'arc' | 'closePath' | 'rect'>

// 角丸の長方形のパスを足す（beginPath はしない）。radii は収めたあとの半径（effectiveCornerRadii）。
// 左上の角の終わりから時計回りに描く。角丸がなければ rect と同じ
export function roundedRectPath(path: PathTarget, box: Box, radii: CornerRadii): void {
  const { x, y, w, h } = box
  const [tl, tr, br, bl] = radii
  if (tl <= 0 && tr <= 0 && br <= 0 && bl <= 0) {
    path.rect(x, y, w, h)
    return
  }
  path.moveTo(x + tl, y)
  path.lineTo(x + w - tr, y)
  if (tr > 0) path.arc(x + w - tr, y + tr, tr, -Math.PI / 2, 0)
  path.lineTo(x + w, y + h - br)
  if (br > 0) path.arc(x + w - br, y + h - br, br, 0, Math.PI / 2)
  path.lineTo(x + bl, y + h)
  if (bl > 0) path.arc(x + bl, y + h - bl, bl, Math.PI / 2, Math.PI)
  path.lineTo(x, y + tl)
  if (tl > 0) path.arc(x + tl, y + tl, tl, Math.PI, (Math.PI * 3) / 2)
  path.closePath()
}

// 角の弧の中心と、弧の始まりの角度（左上から時計回り）
function cornerArcs(box: Box, radii: CornerRadii): { center: Vec; r: number; start: number; corner: Vec }[] {
  const { x, y, w, h } = box
  const [tl, tr, br, bl] = radii
  return [
    { center: { x: x + tl, y: y + tl }, r: tl, start: Math.PI, corner: { x, y } },
    { center: { x: x + w - tr, y: y + tr }, r: tr, start: -Math.PI / 2, corner: { x: x + w, y } },
    { center: { x: x + w - br, y: y + h - br }, r: br, start: 0, corner: { x: x + w, y: y + h } },
    { center: { x: x + bl, y: y + h - bl }, r: bl, start: Math.PI / 2, corner: { x, y: y + h } },
  ]
}

// 角丸の長方形を近似する多角形（左上の角から時計回り）。角丸のない角は 1 点。
// 矢印の端を止める縁（outline）やホバーの輪郭に使う。segments は 1 つの角の弧を何本の線分にするか
export function roundedRectPolygon(box: Box, radii: CornerRadii, segments = 8): Vec[] {
  const points: Vec[] = []
  for (const { center, r, start, corner } of cornerArcs(box, radii)) {
    if (r <= 0) {
      points.push(corner)
      continue
    }
    for (let i = 0; i <= segments; i++) {
      const a = start + (i / segments) * (Math.PI / 2)
      points.push({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) })
    }
  }
  return points
}

// 点から角丸の長方形の縁までの符号付きの距離（外が正、中が負）。radii は収めたあとの半径。
// 箱の距離と、点が角の弧の区画（角から半径の正方形）にあればその弧の距離の、大きい方。
// 箱の距離は縦横の大きい方（角丸のない角は、広げても角のまま。今までの矩形の当たり判定と同じ）
export function roundedRectDistance(box: Box, radii: CornerRadii, point: Vec): number {
  const { x, y, w, h } = box
  // 箱の符号付きの距離
  const dx = Math.max(x - point.x, point.x - (x + w))
  const dy = Math.max(y - point.y, point.y - (y + h))
  let d = Math.max(dx, dy)
  for (const { center, r, corner } of cornerArcs(box, radii)) {
    if (r <= 0) continue
    // 角の区画：角と弧の中心の間（外側へは際限なく）
    const inX = corner.x < center.x ? point.x < center.x : point.x > center.x
    const inY = corner.y < center.y ? point.y < center.y : point.y > center.y
    if (inX && inY) d = Math.max(d, Math.hypot(point.x - center.x, point.y - center.y) - r)
  }
  return d
}

// 点が角丸の長方形の中か。grow だけ外へ広げて（負なら内へ縮めて）判定する
export function insideRoundedRect(box: Box, radii: CornerRadii, point: Vec, grow = 0): boolean {
  return roundedRectDistance(box, radii, point) <= grow
}
