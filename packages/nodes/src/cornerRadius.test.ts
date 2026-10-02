import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import {
  cornerRadii,
  effectiveCornerRadii,
  hasCornerRadius,
  insideRoundedRect,
  offsetRoundedRect,
  roundedRectDistance,
  roundedRectPath,
  roundedRectPolygon,
  toCornerRadius,
} from './cornerRadius.ts'
import { canRoundCorners, geoType, type GeoProps } from './geo.ts'

// 角丸（MAI-84）

const BOX = { x: 0, y: 0, w: 200, h: 100 }

function geo(props: Partial<GeoProps>): NodeRecord<GeoProps> {
  return {
    id: 'node:1',
    typeName: 'node',
    type: 'geo',
    parentId: 'canvas:1',
    index: 'a0',
    x: 0,
    y: 0,
    rotation: 0,
    opacity: 1,
    locked: false,
    props: { ...geoType.defaultProps(), w: 200, h: 100, ...props },
  } as NodeRecord<GeoProps>
}

describe('corner radius values', () => {
  it('reads a number, four corners, and old records without a value', () => {
    expect(cornerRadii(undefined)).toEqual([0, 0, 0, 0])
    expect(cornerRadii(8)).toEqual([8, 8, 8, 8])
    expect(cornerRadii([1, 2, 3, 4])).toEqual([1, 2, 3, 4])
    // 読めない値・負の値は 0
    expect(cornerRadii('8')).toEqual([0, 0, 0, 0])
    expect(cornerRadii([-1, Number.NaN, 3])).toEqual([0, 0, 3, 0])
    expect(toCornerRadius([5, 5, 5, 5])).toBe(5)
    expect(toCornerRadius([5, 0, 5, 5])).toEqual([5, 0, 5, 5])
    expect(hasCornerRadius(undefined)).toBe(false)
    expect(hasCornerRadius([0, 0, 1, 0])).toBe(true)
  })

  it('limits the radius to half the shorter side, keeping the stored value', () => {
    expect(effectiveCornerRadii(30, 200, 100)).toEqual([30, 30, 30, 30])
    expect(effectiveCornerRadii(80, 200, 100)).toEqual([50, 50, 50, 50])
    // 4 つ別々：CSS の border-radius と同じく、隣どうしの和が辺を超えたら全体を同じ割合で縮める
    const scaled = effectiveCornerRadii([100, 0, 0, 100], 200, 100)
    expect(scaled).toEqual([50, 0, 0, 50])
    // 和が辺に収まれば、1 つの角が短い辺の半分を超えてもよい
    expect(effectiveCornerRadii([80, 20, 0, 0], 200, 100)).toEqual([80, 20, 0, 0])
  })

  it('offsets a rounded rectangle for inner / outer borders, keeping square corners square', () => {
    const outer = offsetRoundedRect(BOX, [10, 0, 10, 10], 4)
    expect(outer.box).toEqual({ x: -4, y: -4, w: 208, h: 108 })
    expect(outer.radii).toEqual([14, 0, 14, 14])
    const inner = offsetRoundedRect(BOX, [10, 0, 2, 10], -4)
    expect(inner.radii).toEqual([6, 0, 0, 6])
  })
})

describe('rounded rectangle geometry', () => {
  it('measures the signed distance to the rounded edge', () => {
    const radii = cornerRadii(20)
    // 角の弧の上（45°）
    const onArc = { x: 20 - 20 * Math.SQRT1_2, y: 20 - 20 * Math.SQRT1_2 }
    expect(roundedRectDistance(BOX, radii, onArc)).toBeCloseTo(0, 6)
    // 角（丸めて切り落とした所）は外
    expect(roundedRectDistance(BOX, radii, { x: 1, y: 1 })).toBeGreaterThan(0)
    expect(insideRoundedRect(BOX, radii, { x: 1, y: 1 })).toBe(false)
    expect(insideRoundedRect(BOX, cornerRadii(0), { x: 1, y: 1 })).toBe(true)
    // 辺の上・中・外
    expect(roundedRectDistance(BOX, radii, { x: 100, y: 0 })).toBe(0)
    expect(roundedRectDistance(BOX, radii, { x: 100, y: 10 })).toBe(-10)
    expect(roundedRectDistance(BOX, radii, { x: 100, y: -3 })).toBe(3)
    // 広げて・縮めて判定する
    expect(insideRoundedRect(BOX, radii, { x: 1, y: 1 }, 10)).toBe(true)
    expect(insideRoundedRect(BOX, radii, { x: 100, y: 3 }, -4)).toBe(false)
  })

  it('approximates the outline with points on the arcs, one point for a square corner', () => {
    const polygon = roundedRectPolygon(BOX, [20, 0, 0, 0], 4)
    // 角丸の角は 5 点、角のままの角は 1 点
    expect(polygon).toHaveLength(5 + 3)
    expect(polygon[0].x).toBeCloseTo(0, 6)
    expect(polygon[0].y).toBeCloseTo(20, 6)
    expect(polygon[4].x).toBeCloseTo(20, 6)
    expect(polygon[4].y).toBeCloseTo(0, 6)
    expect(polygon.slice(5)).toEqual([{ x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }])
    for (const p of roundedRectPolygon(BOX, [20, 30, 40, 10])) {
      expect(Math.abs(roundedRectDistance(BOX, [20, 30, 40, 10], p))).toBeLessThan(1e-6)
    }
  })

  it('draws a plain rect without corners, and arcs with corners', () => {
    const calls: string[] = []
    const path = {
      moveTo: () => calls.push('moveTo'),
      lineTo: () => calls.push('lineTo'),
      arc: () => calls.push('arc'),
      closePath: () => calls.push('closePath'),
      rect: () => calls.push('rect'),
    }
    roundedRectPath(path, BOX, [0, 0, 0, 0])
    expect(calls).toEqual(['rect'])
    calls.length = 0
    roundedRectPath(path, BOX, [10, 0, 10, 0])
    expect(calls.filter((c) => c === 'arc')).toHaveLength(2)
    expect(calls.at(-1)).toBe('closePath')
  })
})

describe('geo corner radius', () => {
  it('rounds only rectangles', () => {
    expect(canRoundCorners(geo({ shape: 'rect' }))).toBe(true)
    expect(canRoundCorners(geo({ shape: 'ellipse' }))).toBe(false)
  })

  it('does not hit the cut-off corners, and keeps a hollow shape hit only on its rounded border', () => {
    const rounded = geo({ cornerRadius: 40 })
    expect(geoType.hitTest(rounded, { x: 3, y: 3 }, 0, 1)).toBe(false)
    expect(geoType.hitTest(geo({}), { x: 3, y: 3 }, 0, 1)).toBe(true)
    expect(geoType.hitTest(rounded, { x: 100, y: 50 }, 0, 1)).toBe(true)
    // 塗りなし：線（太さ 2）の上だけ当たる。角では弧の上
    const hollow = geo({ cornerRadius: 40, fill: null })
    const onArc = { x: 40 - 40 * Math.SQRT1_2, y: 40 - 40 * Math.SQRT1_2 }
    expect(geoType.hitTest(hollow, onArc, 0, 1)).toBe(true)
    expect(geoType.hitTest(hollow, { x: 3, y: 3 }, 0, 1)).toBe(false)
    expect(geoType.hitTest(hollow, { x: 100, y: 50 }, 0, 1)).toBe(false)
    // 楕円は角丸の値を使わない
    expect(geoType.hitTest(geo({ shape: 'ellipse', cornerRadius: 40 }), { x: 100, y: 1 }, 0, 1)).toBe(true)
  })

  it('stops arrows on the rounded outline, and keeps the value when resized', () => {
    const outline = geoType.outline!(geo({ cornerRadius: 10 }))
    expect(outline.length).toBeGreaterThan(4)
    expect(geoType.outline!(geo({}))).toEqual([{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }])
    expect(geoType.resize!(geo({ cornerRadius: 30 }), { w: 20, h: 20 }).cornerRadius).toBe(30)
  })
})
