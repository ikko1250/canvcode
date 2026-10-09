import type { Box } from '@canvcode/core'
import { snapTranslation, type SnapGuide } from './snapping.ts'

// 移動中の間隔の吸い付きと、距離の表示。動かしている箱と、左右（上下）の隣のノード・親のフレームの内側の辺との距離を出し、
// その距離が「両隣で同じ」か「ほかの隣どうしの間隔（フレームの辺からの余白を含む）と同じ」になる所に吸い付ける（Figma と同じ）。
// DOM にもエディタにも依存しない純粋な計算。

// 距離の線（ワールド座標）。axis が 'x' なら、x = from〜to の横向きの線で、y = at の高さに引く
export interface GapGuide {
  axis: 'x' | 'y'
  from: number
  to: number
  at: number
  // ほかの間隔と同じ（強く描く）
  equal: boolean
}

type Axis = 'x' | 'y'

// 1 つの軸で見た箱：s〜e がその軸の範囲、cs〜ce がもう一方の軸の範囲。wall はフレームの内側の辺（幅 0）
interface Span {
  s: number
  e: number
  cs: number
  ce: number
  wall: boolean
}

// 隣どうしの間隔（動かす前から決まっているもの）
interface RefGap {
  gap: number
  from: number
  to: number
  at: number
}

interface AxisIndex {
  items: Span[]
  gaps: RefGap[]
}

// 動かし始めに一度だけ作る、軸ごとの相手と間隔
export interface GapIndex {
  x: AxisIndex
  y: AxisIndex
}

// 同じ間隔とみなす差（ワールド単位）
const EPSILON = 1e-6

function spanOf(box: Box, axis: Axis, wall = false): Span {
  return axis === 'x'
    ? { s: box.x, e: box.x + box.w, cs: box.y, ce: box.y + box.h, wall }
    : { s: box.y, e: box.y + box.h, cs: box.x, ce: box.x + box.w, wall }
}

// もう一方の軸で重なっている（触れているだけは重ならない）
function crossOverlaps(a: Span, b: Span): boolean {
  return Math.min(a.ce, b.ce) - Math.max(a.cs, b.cs) > EPSILON
}

// もう一方の軸での重なりの真ん中（距離の線を引く位置）
function crossMid(a: Span, b: Span): number {
  return (Math.max(a.cs, b.cs) + Math.min(a.ce, b.ce)) / 2
}

// m の前（始まり側）と後ろ（終わり側）の、いちばん近い隣
function neighbors(m: Span, items: readonly Span[]): { before: Span | null; after: Span | null } {
  let before: Span | null = null
  let after: Span | null = null
  for (const item of items) {
    if (!crossOverlaps(m, item)) continue
    if (item.e <= m.s + EPSILON) {
      if (!before || item.e > before.e) before = item
    } else if (item.s >= m.e - EPSILON) {
      if (!after || item.s < after.s) after = item
    }
  }
  return { before, after }
}

function axisIndex(boxes: readonly Box[], container: Box | null, axis: Axis): AxisIndex {
  const items = boxes.map((b) => spanOf(b, axis))
  if (container) {
    const c = spanOf(container, axis)
    items.push({ ...c, e: c.s, wall: true }, { ...c, s: c.e, wall: true })
  }
  // それぞれの箱と、その後ろのいちばん近い隣との間隔（フレームの辺どうしは除く）
  const gaps: RefGap[] = []
  for (const a of items) {
    const { after } = neighbors(a, items)
    if (!after || (a.wall && after.wall)) continue
    const gap = after.s - a.e
    if (gap > EPSILON) gaps.push({ gap, from: a.e, to: after.s, at: crossMid(a, after) })
  }
  return { items, gaps }
}

// candidates：間隔を測る相手の箱。container：親のフレームのワールドの箱（内側の辺も相手にする）
export function buildGapIndex(candidates: readonly Box[], container: Box | null): GapIndex {
  return { x: axisIndex(candidates, container, 'x'), y: axisIndex(candidates, container, 'y') }
}

// 1 つの軸で、間隔をそろえるのにいちばん近い補正（しきい値の外なら null）
function snapAxis(moving: Box, index: AxisIndex, axis: Axis, threshold: number): number | null {
  const m = spanOf(moving, axis)
  const size = m.e - m.s
  const { before, after } = neighbors(m, index.items)
  const starts: number[] = []
  // 両隣の真ん中
  if (before && after && after.s - before.e >= size) starts.push((before.e + after.s - size) / 2)
  // ほかの間隔と同じだけ、隣から離す
  for (const { gap } of index.gaps) {
    if (before) starts.push(before.e + gap)
    if (after) starts.push(after.s - gap - size)
  }
  let best: number | null = null
  for (const start of starts) {
    const delta = start - m.s
    if (Math.abs(delta) <= threshold && (best === null || Math.abs(delta) < Math.abs(best))) best = delta
  }
  return best
}

// moving（生の移動量を足した外接矩形）の間隔を吸い付ける補正。吸い付かない軸は null
export function snapGaps(moving: Box, index: GapIndex, threshold: number): { dx: number | null; dy: number | null } {
  return { dx: snapAxis(moving, index.x, 'x', threshold), dy: snapAxis(moving, index.y, 'y', threshold) }
}

// 1 つの軸の距離の線：box から前後の隣までの距離と、それと同じ間隔
function axisGuides(box: Box, index: AxisIndex, axis: Axis): GapGuide[] {
  const m = spanOf(box, axis)
  const { before, after } = neighbors(m, index.items)
  const own: GapGuide[] = []
  if (before) own.push({ axis, from: before.e, to: m.s, at: crossMid(m, before), equal: false })
  if (after) own.push({ axis, from: m.e, to: after.s, at: crossMid(m, after), equal: false })
  const length = (g: { from: number; to: number }) => g.to - g.from
  const same = (a: number, b: number) => Math.abs(a - b) < EPSILON
  // 両隣で同じ
  if (own.length === 2 && same(length(own[0]), length(own[1]))) for (const g of own) g.equal = true
  // ほかの隣どうしの間隔と同じなら、両方を強く描く
  const matched: GapGuide[] = []
  for (const g of own) {
    const refs = index.gaps.filter((r) => same(r.gap, length(g)))
    if (refs.length === 0) continue
    g.equal = true
    for (const r of refs) matched.push({ axis, from: r.from, to: r.to, at: r.at, equal: true })
  }
  return [...own.filter((g) => length(g) > EPSILON), ...matched]
}

// box（動かしたあとの外接矩形）の距離の線
export function gapGuides(box: Box, index: GapIndex): GapGuide[] {
  return [...axisGuides(box, index.x, 'x'), ...axisGuides(box, index.y, 'y')]
}

export interface MoveSnap {
  dx: number
  dy: number
  guides: SnapGuide[]
  gaps: GapGuide[]
}

// 辺・中心の吸い付き（snapTranslation）と、間隔の吸い付きを合わせる。軸ごとに補正の小さい方を使い、同じなら辺・中心を優先する。
// 線は、決まった位置で実際に合っているものだけを引き直す
export function snapMove(moving: Box, candidates: readonly Box[], index: GapIndex, threshold: number): MoveSnap {
  const edge = snapTranslation(moving, candidates, threshold)
  const gap = snapGaps(moving, index, threshold)
  const pick = (axis: Axis, edgeDelta: number, gapDelta: number | null) => {
    const hasEdge = edge.guides.some((g) => g.axis === axis)
    if (gapDelta === null) return hasEdge ? edgeDelta : 0
    return hasEdge && Math.abs(edgeDelta) <= Math.abs(gapDelta) ? edgeDelta : gapDelta
  }
  const dx = pick('x', edge.dx, gap.dx)
  const dy = pick('y', edge.dy, gap.dy)
  const snapped = { ...moving, x: moving.x + dx, y: moving.y + dy }
  return { dx, dy, guides: snapTranslation(snapped, candidates, EPSILON).guides, gaps: gapGuides(snapped, index) }
}

// 線が変わったときだけセッションを更新するための比較
export function sameGapGuides(a: readonly GapGuide[], b: readonly GapGuide[]): boolean {
  if (a.length !== b.length) return false
  return a.every((g, i) => {
    const h = b[i]
    return g.axis === h.axis && g.from === h.from && g.to === h.to && g.at === h.at && g.equal === h.equal
  })
}
