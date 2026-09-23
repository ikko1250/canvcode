import { unionBoxes, type Box } from '@canvcode/core'

// 整列・等間隔・間隔の指定（MAI-54）。DOM に依存しない純粋な関数だけを置く。
// 入力はノードのワールド座標の箱（group は 1 つの箱）、出力は各箱をどれだけ動かすか（moves）。
// 呼び出し側（Editor）が、ワールドでの移動量を親のローカル座標に戻して書き込む。

export interface ArrangeBox extends Box {
  id: string
}

export interface Move {
  id: string
  dx: number
  dy: number
}

export type Axis = 'x' | 'y'
export type AlignEdge = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom'

// 間隔の指定・等間隔の間隔の 1 つ（ワールド座標）。
// box は隣どうしの隙間（軸に沿った幅が間隔、もう一方は 2 つの箱の重なりの範囲）。間隔が負（重なっている）なら、幅は絶対値。
// k は列（行）の中で何番目の隙間か（1 始まり）。先頭の箱は動かないので、k 番目の隙間の位置は間隔の変化の k 倍だけ動く
export interface SpacingGap {
  box: Box
  k: number
}

export interface Spacing {
  axis: Axis
  // 今の間隔（平均。等間隔のときだけ返すので、ほぼ同じ値）
  gap: number
  gaps: SpacingGap[]
}

// 等間隔とみなす、間隔のばらつきの上限（ワールド単位）
export const SPACING_EPSILON = 1

// 軸に沿った位置と大きさ
function startOf(box: Box, axis: Axis): number {
  return axis === 'x' ? box.x : box.y
}
function sizeOf(box: Box, axis: Axis): number {
  return axis === 'x' ? box.w : box.h
}
function other(axis: Axis): Axis {
  return axis === 'x' ? 'y' : 'x'
}
// もう一方の軸で重なっている範囲（重なっていなければ null。接しているだけでも null）
function overlapOn(a: Box, b: Box, axis: Axis): { start: number; end: number } | null {
  const start = Math.max(startOf(a, axis), startOf(b, axis))
  const end = Math.min(startOf(a, axis) + sizeOf(a, axis), startOf(b, axis) + sizeOf(b, axis))
  return end > start ? { start, end } : null
}

function moveAlong(id: string, axis: Axis, delta: number): Move {
  return axis === 'x' ? { id, dx: delta, dy: 0 } : { id, dx: 0, dy: delta }
}

// 軸に沿って並べる（同じ位置なら、もう一方の軸、最後に id で決める。結果が入力の順に依らないように）
function sortAlong<T extends ArrangeBox>(boxes: T[], axis: Axis): T[] {
  const o = other(axis)
  return [...boxes].sort(
    (a, b) => startOf(a, axis) - startOf(b, axis) || startOf(a, o) - startOf(b, o) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
}

// ---- 行・列の判定 ----

// 箱を「行」（axis が x のとき）または「列」（axis が y のとき）に分ける。ルール：
// 1. もう一方の軸（行なら y）の位置で並べ、前の行の範囲（行に入れた箱の y の範囲の和）と重なる箱を同じ行に入れる。
//    重ならなければ新しい行を始める（接しているだけなら別の行）
// 2. 各行の中では、軸に沿って（行なら x で）並べる
// 1 行だけなら、単に x で並べたものになる。PDF のページのような格子は、行にも列にも分けられる。
// どの箱も重ならず 1 つずつの行になってしまうとき（散らばっているとき）は、全体を 1 つの行として軸に沿って並べる
// （「詰める」で 1 列にまとめられるように）
export function lanesOf<T extends ArrangeBox>(boxes: T[], axis: Axis): T[][] {
  const lanes = strictLanesOf(boxes, axis)
  if (lanes.every((lane) => lane.length === 1) && boxes.length > 1) return [sortAlong(boxes, axis)]
  return lanes
}

// lanesOf の、散らばった箱を 1 つにまとめる例外なしの版
function strictLanesOf<T extends ArrangeBox>(boxes: T[], axis: Axis): T[][] {
  const o = other(axis)
  const lanes: { members: T[]; start: number; end: number }[] = []
  for (const box of sortAlong(boxes, o)) {
    const start = startOf(box, o)
    const end = start + sizeOf(box, o)
    const current = lanes.at(-1)
    if (current && start < current.end && end > current.start) {
      current.members.push(box)
      current.start = Math.min(current.start, start)
      current.end = Math.max(current.end, end)
    } else {
      lanes.push({ members: [box], start, end })
    }
  }
  return lanes.map((lane) => sortAlong(lane.members, axis))
}

// 行（列）の中の隣どうしの隙間（軸に沿った幅。負なら重なっている）
function gapsOfLane(lane: ArrangeBox[], axis: Axis): number[] {
  const out: number[] = []
  for (let i = 1; i < lane.length; i++) {
    const prev = lane[i - 1]
    out.push(startOf(lane[i], axis) - (startOf(prev, axis) + sizeOf(prev, axis)))
  }
  return out
}

// ---- 整列 ----

// 全体を囲む箱の辺（中央）に、各箱の辺（中央）を合わせる。2 つ以上のときだけ
export function alignBoxes(boxes: ArrangeBox[], edge: AlignEdge): Move[] {
  if (boxes.length < 2) return []
  const bounds = unionBoxes(boxes)!
  return boxes.flatMap((box) => {
    let dx = 0
    let dy = 0
    switch (edge) {
      case 'left':
        dx = bounds.x - box.x
        break
      case 'hcenter':
        dx = bounds.x + bounds.w / 2 - (box.x + box.w / 2)
        break
      case 'right':
        dx = bounds.x + bounds.w - (box.x + box.w)
        break
      case 'top':
        dy = bounds.y - box.y
        break
      case 'vcenter':
        dy = bounds.y + bounds.h / 2 - (box.y + box.h / 2)
        break
      case 'bottom':
        dy = bounds.y + bounds.h - (box.y + box.h)
        break
    }
    return dx !== 0 || dy !== 0 ? [{ id: box.id, dx, dy }] : []
  })
}

// ---- 等間隔 ----

// 軸に沿って並べ、両端の箱はそのままに、間の隙間を等しくする。3 つ以上のときだけ。
// 行（列）には分けず、全体を 1 列として並べる（Figma の Distribute と同じ。もう一方の軸の位置は変えない）
export function distributeBoxes(boxes: ArrangeBox[], axis: Axis): Move[] {
  if (boxes.length < 3) return []
  const sorted = sortAlong(boxes, axis)
  const first = sorted[0]
  const last = sorted.at(-1)!
  const innerSize = sorted.slice(1, -1).reduce((sum, box) => sum + sizeOf(box, axis), 0)
  const gap = (startOf(last, axis) - (startOf(first, axis) + sizeOf(first, axis)) - innerSize) / (sorted.length - 1)
  // 最後の箱は動かさない（計算の誤差で動かないように、並べる対象から外す）
  return layOut(sorted.slice(0, -1), axis, gap)
}

// ---- 間隔の指定 ----

// 各行（列）の先頭の箱はそのままに、あとの箱を gap の間隔で並べる。2 つ以上のときだけ。負の間隔（重ねる）もよい
export function spaceBoxes(boxes: ArrangeBox[], axis: Axis, gap: number): Move[] {
  if (boxes.length < 2) return []
  return lanesOf(boxes, axis).flatMap((lane) => layOut(lane, axis, gap))
}

// 並べた箱を、先頭はそのままに gap の間隔で置いたときの移動量
function layOut(sorted: ArrangeBox[], axis: Axis, gap: number): Move[] {
  const moves: Move[] = []
  let cursor = startOf(sorted[0], axis) + sizeOf(sorted[0], axis)
  for (const box of sorted.slice(1)) {
    const delta = cursor + gap - startOf(box, axis)
    if (delta !== 0) moves.push(moveAlong(box.id, axis, delta))
    cursor += gap + sizeOf(box, axis)
  }
  return moves
}

// 今の間隔（各行（列）の隙間の平均）。この軸に沿った行（列）がなく隙間もなければ null
// （散らばった箱を 1 つにまとめる例外は使わない。横に並んだ箱の縦の間隔が、重なりの分の負の値にならないように）
export function meanGap(boxes: ArrangeBox[], axis: Axis): number | null {
  if (boxes.length < 2) return null
  const gaps = strictLanesOf(boxes, axis).flatMap((lane) => gapsOfLane(lane, axis))
  if (gaps.length === 0) return null
  return gaps.reduce((a, b) => a + b, 0) / gaps.length
}

// ---- 間隔のハンドル ----

// 箱が等間隔に並んでいる軸と、その隙間。ハンドル（ピンクの棒）を出すための計算。
// 軸ごとに、行（列）に分けて（lanesOf）：
// - 行の中の隣どうしは、もう一方の軸で重なっていること（接しているだけでは行にならない）
// - 隙間が 1 つ以上あり、すべての隙間（行をまたいでも）が SPACING_EPSILON の範囲で等しいこと
// を満たすときだけ返す。等しくなければ、まずパレットの「詰める」で揃えてもらう。
// 行の判定の都合で、散らばった箱を 1 つの行にまとめる lanesOf の例外は、ここでは重なりの条件で外れる
export function spacingOf(boxes: ArrangeBox[]): Spacing[] {
  if (boxes.length < 2) return []
  const out: Spacing[] = []
  for (const axis of ['x', 'y'] as const) {
    const o = other(axis)
    const gaps: SpacingGap[] = []
    const values: number[] = []
    let ok = true
    for (const lane of lanesOf(boxes, axis)) {
      for (let i = 1; i < lane.length && ok; i++) {
        const prev = lane[i - 1]
        const next = lane[i]
        const overlap = overlapOn(prev, next, o)
        if (!overlap) {
          ok = false
          break
        }
        const prevEnd = startOf(prev, axis) + sizeOf(prev, axis)
        const gap = startOf(next, axis) - prevEnd
        values.push(gap)
        const along = { start: Math.min(prevEnd, startOf(next, axis)), size: Math.abs(gap) }
        gaps.push({
          box:
            axis === 'x'
              ? { x: along.start, y: overlap.start, w: along.size, h: overlap.end - overlap.start }
              : { x: overlap.start, y: along.start, w: overlap.end - overlap.start, h: along.size },
          k: i,
        })
      }
      if (!ok) break
    }
    if (!ok || values.length === 0) continue
    const min = Math.min(...values)
    const max = Math.max(...values)
    if (max - min > SPACING_EPSILON) continue
    out.push({ axis, gap: values.reduce((a, b) => a + b, 0) / values.length, gaps })
  }
  return out
}
