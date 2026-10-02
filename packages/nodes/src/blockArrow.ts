import type { Box, Vec } from '@canvcode/core'

// ブロック矢印（塗りのある太い矢印。MAI-87）の形。図形（geo）の shape の 1 つとして持つ（geo.ts）。
// 線の矢印（arrow.ts）と違い、面として塗り・線・影・文字を長方形と同じように持つ。形は箱（w × h）の中の多角形で、
// どれも右向き（上下・左向きはノードの回転で作る）。形を作る関数は型に依存しない純粋な関数にし、描画・当たり判定・
// 矢印が止まる縁（outline）・図形の上のハンドル（packages/canvas の blockArrowHandles.ts）で同じものを使う。
// - blockArrow：右向きの矢印（軸＋矢じり）
// - blockArrowBoth：両向きの矢印（左右に矢じり）
// - blockArrowBent：L 字に曲がった矢印（左下から上へ伸び、右へ曲がって右を指す。PowerPoint の「屈折矢印」と同じ向き）。
//   弧ではなく L 字にした（多角形のままなので、当たり判定・縁・文字の箱が単純で、ほかの形と同じ道具で描ける）
// - chevron：山形（シェブロン。左に切り込み、右がとがる）
// 形のパラメータ（GeoProps の arrowShaft・arrowHeadLength・arrowHeadWidth）は、箱の長さに対する割合で持つ
// （リサイズで形が箱と一緒に伸び縮みする。Figma・PowerPoint の調整ハンドルと同じ）。基準の長さ（blockArrowRef）は
// まっすぐな形では箱の高さ（矢印の太さの向き）、曲がった矢印では短い辺。値がない・読めないときは形ごとの既定。
// 箱に収まらない値は、描くとき（blockArrowGeometry）に収める（値そのものは保つ）

export type BlockArrowShape = 'blockArrow' | 'blockArrowBoth' | 'blockArrowBent' | 'chevron'
export const BLOCK_ARROW_SHAPES: readonly BlockArrowShape[] = ['blockArrow', 'blockArrowBoth', 'blockArrowBent', 'chevron']

export function isBlockArrowShape(shape: unknown): shape is BlockArrowShape {
  return BLOCK_ARROW_SHAPES.includes(shape as BlockArrowShape)
}

// 形のパラメータ（基準の長さに対する割合）
export interface BlockArrowParams {
  // 軸の太さ
  shaft: number
  // 矢じりの長さ（シェブロンは切り込みの深さ）
  headLength: number
  // 矢じりの幅（矢じりの根もとの、軸と直角の向きの長さ）
  headWidth: number
}

// 形のパラメータを持つ props（geo）
export interface BlockArrowProps {
  arrowShaft?: number
  arrowHeadLength?: number
  arrowHeadWidth?: number
}

// 割合の上限（箱に収めるのは描くとき。保存する値はこの範囲）
export const BLOCK_ARROW_RATIO_MAX = 10

const DEFAULT_PARAMS: Record<BlockArrowShape, BlockArrowParams> = {
  blockArrow: { shaft: 0.5, headLength: 0.5, headWidth: 1 },
  blockArrowBoth: { shaft: 0.5, headLength: 0.5, headWidth: 1 },
  blockArrowBent: { shaft: 0.3, headLength: 0.3, headWidth: 0.6 },
  chevron: { shaft: 1, headLength: 0.5, headWidth: 1 },
}

// その形がハンドル・パネルで変えられるパラメータ（シェブロンは切り込みの深さだけ）
export function blockArrowParamKeys(shape: BlockArrowShape): readonly (keyof BlockArrowParams)[] {
  return shape === 'chevron' ? ['headLength'] : ['shaft', 'headLength', 'headWidth']
}

export function defaultBlockArrowParams(shape: BlockArrowShape): BlockArrowParams {
  return { ...DEFAULT_PARAMS[shape] }
}

// 新しく作るときの既定の大きさ（クリックだけで置いたとき）
export function blockArrowDefaultSize(shape: BlockArrowShape): { w: number; h: number } {
  return shape === 'blockArrowBent' ? { w: 140, h: 120 } : shape === 'chevron' ? { w: 120, h: 120 } : { w: 180, h: 100 }
}

export function clampBlockArrowRatio(value: number): number {
  return Number.isFinite(value) ? Math.min(BLOCK_ARROW_RATIO_MAX, Math.max(0, value)) : 0
}

function ratio(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(BLOCK_ARROW_RATIO_MAX, value) : fallback
}

// props の形のパラメータ（ないもの・読めないものは形の既定）
export function blockArrowParams(shape: BlockArrowShape, props: BlockArrowProps): BlockArrowParams {
  const d = DEFAULT_PARAMS[shape]
  return {
    shaft: ratio(props.arrowShaft, d.shaft),
    headLength: ratio(props.arrowHeadLength, d.headLength),
    headWidth: ratio(props.arrowHeadWidth, d.headWidth),
  }
}

// パラメータの基準の長さ（px）
export function blockArrowRef(shape: BlockArrowShape, w: number, h: number): number {
  return shape === 'blockArrowBent' ? Math.min(w, h) : h
}

// 箱に収めた形（ワールドの px）
export interface BlockArrowGeometry {
  shape: BlockArrowShape
  w: number
  h: number
  // 軸の太さ・矢じりの長さ・矢じりの幅（シェブロンは headLength が切り込みの深さ。shaft・headWidth は h）
  shaft: number
  headLength: number
  headWidth: number
  // 形の縁（時計回り。ローカル座標）
  polygon: Vec[]
  // 文字を置ける箱（軸の中。余白は含まない）
  textBox: Box
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

export function blockArrowGeometry(shape: BlockArrowShape, w: number, h: number, params: BlockArrowParams): BlockArrowGeometry {
  w = Math.max(0, w)
  h = Math.max(0, h)
  const ref = blockArrowRef(shape, w, h)
  switch (shape) {
    case 'blockArrow':
    case 'blockArrowBoth': {
      const both = shape === 'blockArrowBoth'
      const headWidth = clamp(params.headWidth * ref, 0, h)
      const shaft = clamp(params.shaft * ref, 0, headWidth)
      const headLength = clamp(params.headLength * ref, 0, both ? w / 2 : w)
      const cy = h / 2
      const top = cy - shaft / 2
      const bottom = cy + shaft / 2
      const headTop = cy - headWidth / 2
      const headBottom = cy + headWidth / 2
      const back = w - headLength
      const polygon: Vec[] = both
        ? [
            { x: 0, y: cy },
            { x: headLength, y: headTop },
            { x: headLength, y: top },
            { x: back, y: top },
            { x: back, y: headTop },
            { x: w, y: cy },
            { x: back, y: headBottom },
            { x: back, y: bottom },
            { x: headLength, y: bottom },
            { x: headLength, y: headBottom },
          ]
        : [
            { x: 0, y: top },
            { x: back, y: top },
            { x: back, y: headTop },
            { x: w, y: cy },
            { x: back, y: headBottom },
            { x: back, y: bottom },
            { x: 0, y: bottom },
          ]
      const left = both ? headLength : 0
      return { shape, w, h, shaft, headLength, headWidth, polygon, textBox: { x: left, y: top, w: Math.max(0, back - left), h: shaft } }
    }
    case 'blockArrowBent': {
      // 矢じりは上端に付く（矢じりの上の縁が y = 0）。縦の軸は左端から下端まで
      const headWidth = clamp(params.headWidth * ref, 0, h)
      const shaft = clamp(params.shaft * ref, 0, headWidth)
      const headLength = clamp(params.headLength * ref, 0, w - shaft)
      const cy = headWidth / 2
      const top = cy - shaft / 2
      const bottom = cy + shaft / 2
      const back = w - headLength
      const polygon: Vec[] = [
        { x: 0, y: h },
        { x: 0, y: top },
        { x: back, y: top },
        { x: back, y: 0 },
        { x: w, y: cy },
        { x: back, y: headWidth },
        { x: back, y: bottom },
        { x: shaft, y: bottom },
        { x: shaft, y: h },
      ]
      return { shape, w, h, shaft, headLength, headWidth, polygon, textBox: { x: shaft, y: top, w: Math.max(0, back - shaft), h: shaft } }
    }
    case 'chevron': {
      const depth = clamp(params.headLength * ref, 0, w)
      const polygon: Vec[] = [
        { x: 0, y: 0 },
        { x: w - depth, y: 0 },
        { x: w, y: h / 2 },
        { x: w - depth, y: h },
        { x: 0, y: h },
        { x: depth, y: h / 2 },
      ]
      // 上下いっぱいの高さがある、切り込みととがりの間（なければ真ん中の細い箱）
      const inner = w - depth * 2
      const textBox = inner > 0 ? { x: depth, y: 0, w: inner, h } : { x: w / 2, y: 0, w: 0, h }
      return { shape, w, h, shaft: h, headLength: depth, headWidth: h, polygon, textBox }
    }
  }
}

// ---- 多角形の道具 ----

type PathTarget = Pick<CanvasRenderingContext2D, 'moveTo' | 'lineTo' | 'closePath'>

// 多角形を今のパス（Path2D にも）に足す（beginPath はしない）
export function polygonPath(path: PathTarget, polygon: readonly Vec[]): void {
  if (polygon.length === 0) return
  path.moveTo(polygon[0].x, polygon[0].y)
  for (let i = 1; i < polygon.length; i++) path.lineTo(polygon[i].x, polygon[i].y)
  path.closePath()
}

export function polygonBounds(polygon: readonly Vec[]): Box {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of polygon) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  return polygon.length === 0 ? { x: 0, y: 0, w: 0, h: 0 } : { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

// 点が多角形の中か（偶奇の規則）
export function pointInPolygon(polygon: readonly Vec[], p: Vec): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]
    const b = polygon[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

// 点から多角形の縁までの距離
export function polygonEdgeDistance(polygon: readonly Vec[], p: Vec): number {
  let best = Infinity
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j]
    const b = polygon[i]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    const t = len2 === 0 ? 0 : clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1)
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)))
  }
  return best
}

// 多角形の中か。grow だけ外へ広げて（負なら内へ縮めて）判定する（角は丸く広がる。当たり判定には十分）
export function insidePolygon(polygon: readonly Vec[], p: Vec, grow = 0): boolean {
  const inside = pointInPolygon(polygon, p)
  if (grow === 0) return inside
  if (grow > 0) return inside || polygonEdgeDistance(polygon, p) <= grow
  return inside && polygonEdgeDistance(polygon, p) >= -grow
}

// 多角形の線（lineJoin miter、miterLimit）が、太さの半分の何倍まで縁から外へ届くか。
// とがった角（矢じりの先）では太さの半分より遠くまで出るので、描く範囲（renderOutset）に掛ける。
// 上限を超える角は面取り（bevel）になるので、太さの半分まで
export function polygonMiterReach(polygon: readonly Vec[], miterLimit = 10): number {
  const n = polygon.length
  if (n < 3) return 1
  // 向き（面積の符号）で、凸の角を見分ける
  let area = 0
  for (let i = 0; i < n; i++) {
    const a = polygon[i]
    const b = polygon[(i + 1) % n]
    area += a.x * b.y - b.x * a.y
  }
  let reach = 1
  for (let i = 0; i < n; i++) {
    const prev = polygon[(i + n - 1) % n]
    const p = polygon[i]
    const next = polygon[(i + 1) % n]
    const ax = prev.x - p.x
    const ay = prev.y - p.y
    const bx = next.x - p.x
    const by = next.y - p.y
    const la = Math.hypot(ax, ay)
    const lb = Math.hypot(bx, by)
    if (la === 0 || lb === 0) continue
    const cross = ax * by - ay * bx
    // 凹の角では、線の外側は縁の内側へ折れるので届かない
    if (Math.sign(cross) === Math.sign(area)) continue
    const angle = Math.acos(clamp((ax * bx + ay * by) / (la * lb), -1, 1))
    const sin = Math.sin(angle / 2)
    if (sin <= 0) continue
    const miter = 1 / sin
    if (miter <= miterLimit) reach = Math.max(reach, miter)
  }
  return reach
}
