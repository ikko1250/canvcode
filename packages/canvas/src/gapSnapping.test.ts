import { describe, expect, it } from 'vitest'
import type { Box } from '@canvcode/core'
import { buildGapIndex, gapGuides, sameGapGuides, snapGaps, snapMove } from './gapSnapping.ts'

// 移動中の間隔の吸い付きと距離の線

const box = (x: number, y: number, w = 100, h = 100): Box => ({ x, y, w, h })

describe('snapGaps', () => {
  it('両隣の真ん中に吸い付く', () => {
    const index = buildGapIndex([box(0, 0), box(400, 0)], null)
    // 真ん中は x=200（両側 100）。x=205 なら -5 補正する
    expect(snapGaps(box(205, 0), index, 8)).toEqual({ dx: -5, dy: null })
  })

  it('しきい値の外なら吸い付かない', () => {
    const index = buildGapIndex([box(0, 0), box(400, 0)], null)
    expect(snapGaps(box(220, 0), index, 8)).toEqual({ dx: null, dy: null })
  })

  it('フレームの右の辺からの余白を、ほかの箱の左の辺からの余白にそろえる', () => {
    // フレーム 0〜1000。左の箱は左の辺から 100。動かしている箱（幅 300）の右の余白が 100 になるのは x=600
    const frame = box(0, 0, 1000, 600)
    const index = buildGapIndex([box(100, 100, 300, 300)], frame)
    const snap = snapGaps(box(594, 150, 300, 300), index, 8)
    expect(snap.dx).toBe(6)
  })

  it('ほかの隣どうしの間隔と同じだけ、隣から離す', () => {
    // 上の段の間隔は 50。下の段の箱の右に、50 離して置く
    const index = buildGapIndex([box(0, 0), box(150, 0), box(0, 300)], null)
    expect(snapGaps(box(153, 300), index, 8).dx).toBe(-3)
  })

  it('もう一方の軸で重なっていない箱は隣にしない', () => {
    const index = buildGapIndex([box(0, 0), box(400, 500)], null)
    expect(snapGaps(box(205, 200), index, 8)).toEqual({ dx: null, dy: null })
  })
})

describe('gapGuides', () => {
  it('前後の隣までの距離を出し、両隣で同じなら強く描く', () => {
    const index = buildGapIndex([box(0, 0), box(400, 0)], null)
    expect(gapGuides(box(200, 0), index)).toEqual([
      { axis: 'x', from: 100, to: 200, at: 50, equal: true },
      { axis: 'x', from: 300, to: 400, at: 50, equal: true },
    ])
    expect(gapGuides(box(210, 0), index).every((g) => !g.equal)).toBe(true)
  })

  it('フレームの内側の辺までの距離も出し、同じ余白の線も強く描く', () => {
    const frame = box(0, 0, 1000, 600)
    const index = buildGapIndex([box(100, 100, 300, 300)], frame)
    const guides = gapGuides(box(600, 120, 300, 300), index)
    // 右の辺までの 100 と、左の箱の左の余白 100 が強く描かれる
    expect(guides).toContainEqual({ axis: 'x', from: 900, to: 1000, at: 270, equal: true })
    expect(guides).toContainEqual({ axis: 'x', from: 0, to: 100, at: 250, equal: true })
    // 左の箱までの 200 と、上下の辺までの距離（120・180）は薄い
    expect(guides).toContainEqual({ axis: 'x', from: 400, to: 600, at: 260, equal: false })
    expect(guides).toContainEqual({ axis: 'y', from: 0, to: 120, at: 750, equal: false })
    expect(guides).toContainEqual({ axis: 'y', from: 420, to: 600, at: 750, equal: false })
  })

  it('sameGapGuides は中身で比べる', () => {
    const index = buildGapIndex([box(0, 0), box(400, 0)], null)
    expect(sameGapGuides(gapGuides(box(200, 0), index), gapGuides(box(200, 0), index))).toBe(true)
    expect(sameGapGuides(gapGuides(box(200, 0), index), gapGuides(box(210, 0), index))).toBe(false)
  })
})

describe('snapMove', () => {
  it('辺・中心と間隔のうち、補正の小さい方を使う', () => {
    // 間隔なら x=200（-6）、辺なら右の箱の左の辺 x=450 に右端を合わせる x=350 は遠い。下の箱の左の辺 x=204 なら -2
    const candidates = [box(0, 0), box(400, 0), box(204, 300)]
    const index = buildGapIndex(candidates, null)
    const snap = snapMove(box(206, 0), candidates, index, 8)
    expect(snap.dx).toBe(-2)
    expect(snap.guides).toContainEqual({ axis: 'x', position: 204, from: 0, to: 400 })
    // 間隔では吸い付かなかったので、両隣の距離は強く描かない
    expect(snap.gaps.filter((g) => g.axis === 'x').every((g) => !g.equal)).toBe(true)
  })

  it('間隔の方が近ければ間隔に吸い付き、辺の線は合っているものだけ残す', () => {
    const candidates = [box(0, 0), box(400, 0), box(190, 300)]
    const index = buildGapIndex(candidates, null)
    const snap = snapMove(box(197, 0), candidates, index, 8)
    expect(snap.dx).toBe(3)
    expect(snap.guides.some((g) => g.axis === 'x')).toBe(false)
    expect(snap.gaps.filter((g) => g.axis === 'x' && g.equal)).toHaveLength(2)
  })
})
