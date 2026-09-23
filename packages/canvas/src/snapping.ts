import type { Box } from '@canvcode/core'

// 移動中の吸い付き（MAI-53）。tldraw / Figma と同じく、動かしている選択の外接矩形の
// 左・中央・右（x）と上・中央・下（y）の 6 本の線を、近くのノードの同じ線に合わせる。
// DOM にもエディタにも依存しない純粋な計算。

// 吸い付いた線（ワールド座標）。axis が 'x' なら x = position の縦線で、from〜to は y の範囲
export interface SnapGuide {
  axis: 'x' | 'y'
  position: number
  from: number
  to: number
}

export interface SnapResult {
  // 移動量に足す補正
  dx: number
  dy: number
  guides: SnapGuide[]
}

// 吸い付く距離（CSS ピクセル）。ワールドでは zoom で割る
export const SNAP_THRESHOLD_PX = 8

// 候補の数の上限（動かしている箱に近い順）
export const SNAP_CANDIDATE_LIMIT = 200

// 1 つの軸で、箱の始まり・中央・終わりの 3 本の線
function lines(start: number, size: number): [number, number, number] {
  return [start, start + size / 2, start + size]
}

// 1 つの軸で、いちばん近い線の組を探す。同じ距離なら先に見つけたものを使う
function nearest(
  moving: [number, number, number],
  candidates: readonly Box[],
  axis: 'x' | 'y',
  threshold: number,
): { delta: number; candidate: Box } | null {
  let best: { delta: number; candidate: Box } | null = null
  for (const candidate of candidates) {
    const target = axis === 'x' ? lines(candidate.x, candidate.w) : lines(candidate.y, candidate.h)
    for (const m of moving) {
      for (const t of target) {
        const delta = t - m
        if (Math.abs(delta) > threshold) continue
        if (best === null || Math.abs(delta) < Math.abs(best.delta)) best = { delta, candidate }
      }
    }
  }
  return best
}

// 補正したあとの箱の線のうち、相手の線と重なっているものの位置
function matchedLine(mine: [number, number, number], theirs: [number, number, number]): number {
  return mine.find((v) => theirs.some((t) => Math.abs(t - v) < 1e-9)) ?? mine[0]
}

// moving（すでに生の移動量を足した、選択のワールドの外接矩形）を candidates の辺・中心に吸い付ける。
// threshold はワールド座標での距離。返す dx・dy を移動量に足す
export function snapTranslation(moving: Box, candidates: readonly Box[], threshold: number): SnapResult {
  const x = nearest(lines(moving.x, moving.w), candidates, 'x', threshold)
  const y = nearest(lines(moving.y, moving.h), candidates, 'y', threshold)
  const dx = x?.delta ?? 0
  const dy = y?.delta ?? 0
  // ガイドの長さは、補正したあとの箱と相手の箱を、もう一方の軸でまとめた範囲
  const snapped = { x: moving.x + dx, y: moving.y + dy, w: moving.w, h: moving.h }
  const guides: SnapGuide[] = []
  if (x) {
    guides.push({
      axis: 'x',
      position: matchedLine(lines(snapped.x, snapped.w), lines(x.candidate.x, x.candidate.w)),
      from: Math.min(snapped.y, x.candidate.y),
      to: Math.max(snapped.y + snapped.h, x.candidate.y + x.candidate.h),
    })
  }
  if (y) {
    guides.push({
      axis: 'y',
      position: matchedLine(lines(snapped.y, snapped.h), lines(y.candidate.y, y.candidate.h)),
      from: Math.min(snapped.x, y.candidate.x),
      to: Math.max(snapped.x + snapped.w, y.candidate.x + y.candidate.w),
    })
  }
  return { dx, dy, guides }
}

// 2 つの箱の距離（重なっていれば 0）
export function boxDistance(a: Box, b: Box): number {
  const dx = Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w))
  const dy = Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h))
  return Math.hypot(dx, dy)
}

// moving に近い順に limit 個まで（同じ距離なら元の順）
export function nearestBoxes(moving: Box, boxes: readonly Box[], limit: number): Box[] {
  if (boxes.length <= limit) return [...boxes]
  return boxes
    .map((box, i) => ({ box, i, d: boxDistance(moving, box) }))
    .sort((p, q) => p.d - q.d || p.i - q.i)
    .slice(0, limit)
    .map((p) => p.box)
}

// ガイドが変わったときだけセッションを更新するための比較
export function sameGuides(a: readonly SnapGuide[], b: readonly SnapGuide[]): boolean {
  if (a.length !== b.length) return false
  return a.every((g, i) => {
    const h = b[i]
    return g.axis === h.axis && g.position === h.position && g.from === h.from && g.to === h.to
  })
}
