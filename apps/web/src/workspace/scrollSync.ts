// 全画面のエディタで、本文（CodeMirror）とプレビューのスクロールを合わせる（MAI-44）。
// 描いた長さが違うので、同じ割合で動かすだけでは合わない。ブロックごとに「本文でのその行の高さ位置」と
// 「プレビューでのその要素の高さ位置」を対にした基準点（anchor）を、本文が変わったとき（と大きさが変わったとき）に
// まとめて計り、表（ScrollMap）にしておく。スクロールのたびには、その表を引いて間を直線で補うだけにする

export interface ScrollAnchor {
  // 本文（エディタ）の中の高さ位置（px。スクロールの原点からの距離）
  source: number
  // プレビューの中の高さ位置（px）
  preview: number
}

export interface ScrollMap {
  // 昇順。両端は 0 と、それぞれの最大スクロール位置
  source: number[]
  preview: number[]
}

// 基準点から表を作る。順序が崩れた点（前の点より手前に来る点）は前の点にそろえ、最大スクロール位置を超える点は捨てる。
// 基準点がなければ、両端だけの表（＝同じ割合で動かす）になる
export function buildScrollMap(anchors: ScrollAnchor[], sourceMax: number, previewMax: number): ScrollMap {
  const source = [0]
  const preview = [0]
  const maxSource = Math.max(0, sourceMax)
  const maxPreview = Math.max(0, previewMax)
  const sorted = anchors.filter((a) => Number.isFinite(a.source) && Number.isFinite(a.preview)).sort((a, b) => a.source - b.source)
  for (const anchor of sorted) {
    const s = Math.max(anchor.source, source[source.length - 1])
    const p = Math.max(anchor.preview, preview[preview.length - 1])
    if (s >= maxSource || p >= maxPreview) break
    if (s === source[source.length - 1] && p === preview[preview.length - 1]) continue
    source.push(s)
    preview.push(p)
  }
  source.push(maxSource)
  preview.push(maxPreview)
  return { source, preview }
}

// 表を引く。from の位置 x に対応する to の位置を、間を直線で補って返す
function interpolate(from: number[], to: number[], x: number): number {
  const last = from.length - 1
  if (x <= from[0]) return to[0]
  if (x >= from[last]) return to[last]
  // 二分探索で x を含む区間 [lo, lo+1] を見つける
  let lo = 0
  let hi = last
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (from[mid] <= x) lo = mid
    else hi = mid
  }
  const span = from[hi] - from[lo]
  if (span <= 0) return to[hi]
  return to[lo] + ((x - from[lo]) / span) * (to[hi] - to[lo])
}

// 本文のスクロール位置から、プレビューのスクロール位置へ
export function sourceToPreview(map: ScrollMap, sourceTop: number): number {
  return interpolate(map.source, map.preview, sourceTop)
}

// プレビューのスクロール位置から、本文のスクロール位置へ
export function previewToSource(map: ScrollMap, previewTop: number): number {
  return interpolate(map.preview, map.source, previewTop)
}
