import { describe, expect, it } from 'vitest'
import {
  blockArrowGeometry,
  blockArrowParams,
  defaultBlockArrowParams,
  insidePolygon,
  polygonBounds,
  polygonEdgeDistance,
  polygonMiterReach,
} from './blockArrow.ts'
import { blockArrowOf, geoType, type GeoProps } from './geo.ts'
import { solidPaint } from './paint.ts'

// ブロック矢印（MAI-87）

const geo = (props: Partial<GeoProps>) => ({
  ...geoType.defaultProps(),
  ...props,
})

const node = (props: Partial<GeoProps>) =>
  ({ id: 'node:a', typeName: 'node', type: 'geo', x: 0, y: 0, rotation: 0, opacity: 1, parentId: 'canvas:1', index: 'a1', locked: false, props: geo(props) }) as never

describe('block arrow geometry', () => {
  it('builds a right arrow from ratios of the height, inside the box', () => {
    const g = blockArrowGeometry('blockArrow', 200, 100, defaultBlockArrowParams('blockArrow'))
    expect([g.shaft, g.headLength, g.headWidth]).toEqual([50, 50, 100])
    expect(g.polygon).toEqual([
      { x: 0, y: 25 },
      { x: 150, y: 25 },
      { x: 150, y: 0 },
      { x: 200, y: 50 },
      { x: 150, y: 100 },
      { x: 150, y: 75 },
      { x: 0, y: 75 },
    ])
    expect(polygonBounds(g.polygon)).toEqual({ x: 0, y: 0, w: 200, h: 100 })
    // 文字の箱は軸の中
    expect(g.textBox).toEqual({ x: 0, y: 25, w: 150, h: 50 })
  })

  it('clamps the values to the box (head length to the width, shaft to the head width)', () => {
    const g = blockArrowGeometry('blockArrow', 40, 100, { shaft: 2, headLength: 3, headWidth: 1.5 })
    expect([g.shaft, g.headLength, g.headWidth]).toEqual([100, 40, 100])
    const both = blockArrowGeometry('blockArrowBoth', 60, 100, { shaft: 0.5, headLength: 1, headWidth: 1 })
    expect(both.headLength).toBe(30)
    expect(both.polygon).toHaveLength(10)
    expect(both.textBox.w).toBe(0)
  })

  it('builds a bent (L) arrow and a chevron', () => {
    const bent = blockArrowGeometry('blockArrowBent', 200, 100, { shaft: 0.3, headLength: 0.3, headWidth: 0.6 })
    // 基準は短い辺（100）
    expect([bent.shaft, bent.headLength, bent.headWidth]).toEqual([30, 30, 60])
    expect(polygonBounds(bent.polygon)).toEqual({ x: 0, y: 0, w: 200, h: 100 })
    expect(insidePolygon(bent.polygon, { x: 10, y: 90 })).toBe(true)
    expect(insidePolygon(bent.polygon, { x: 100, y: 90 })).toBe(false)
    expect(insidePolygon(bent.polygon, { x: 190, y: 30 })).toBe(true)
    const chevron = blockArrowGeometry('chevron', 200, 100, defaultBlockArrowParams('chevron'))
    expect(chevron.headLength).toBe(50)
    // 切り込みの中は外
    expect(insidePolygon(chevron.polygon, { x: 20, y: 50 })).toBe(false)
    expect(insidePolygon(chevron.polygon, { x: 100, y: 50 })).toBe(true)
    expect(chevron.textBox).toEqual({ x: 50, y: 0, w: 100, h: 100 })
  })

  it('reads missing or broken params as the shape defaults', () => {
    expect(blockArrowParams('blockArrow', {})).toEqual({ shaft: 0.5, headLength: 0.5, headWidth: 1 })
    expect(blockArrowParams('blockArrow', { arrowShaft: -1, arrowHeadLength: Number.NaN, arrowHeadWidth: 0.8 })).toEqual({ shaft: 0.5, headLength: 0.5, headWidth: 0.8 })
  })

  it('measures distances, grows the inside test, and the miter reach of sharp corners', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]
    expect(polygonEdgeDistance(square, { x: 5, y: 2 })).toBe(2)
    expect(insidePolygon(square, { x: 12, y: 5 }, 2)).toBe(true)
    expect(insidePolygon(square, { x: 5, y: 2 }, -3)).toBe(false)
    expect(polygonMiterReach(square)).toBeCloseTo(Math.SQRT2)
    // 右向きの矢印は、矢じりの根もとの角（45°）がいちばん遠くまで出る
    const g = blockArrowGeometry('blockArrow', 200, 100, defaultBlockArrowParams('blockArrow'))
    expect(polygonMiterReach(g.polygon)).toBeCloseTo(1 / Math.sin(Math.PI / 8))
    // 上限（10）を超える角は面取りになるので数えない
    const sharp = blockArrowGeometry('blockArrow', 200, 100, { shaft: 0.5, headLength: 0.01, headWidth: 1 })
    expect(polygonMiterReach(sharp.polygon)).toBeLessThanOrEqual(10)
  })
})

describe('geo block arrow shapes', () => {
  it('hits only the arrow, and only the edge when it has no fill', () => {
    const filled = node({ shape: 'blockArrow', w: 200, h: 100 })
    expect(geoType.hitTest!(filled, { x: 20, y: 50 }, 0, 1)).toBe(true)
    // 軸の上（矢じりの外）は当たらない
    expect(geoType.hitTest!(filled, { x: 20, y: 10 }, 0, 1)).toBe(false)
    const hollow = node({ shape: 'blockArrow', w: 200, h: 100, fill: null })
    expect(geoType.hitTest!(hollow, { x: 20, y: 50 }, 0, 1)).toBe(false)
    expect(geoType.hitTest!(hollow, { x: 20, y: 25 }, 0, 1)).toBe(true)
  })

  it('stops bound arrows at the arrow outline and draws over the box at the sharp tip', () => {
    const n = node({ shape: 'blockArrow', w: 200, h: 100, stroke: solidPaint('#000000'), strokeWidth: 4 })
    expect(geoType.outline!(n)).toHaveLength(7)
    // 中央の線（外へ 2px）が、矢じりの角では miter の分だけ外へ出る
    expect(geoType.renderOutset!(n)).toBeCloseTo(2 / Math.sin(Math.PI / 8))
    expect(blockArrowOf(geo({ shape: 'rect' }))).toBeNull()
  })

  it('keeps the label inside the shaft', () => {
    const n = node({ shape: 'blockArrow', w: 200, h: 100, label: 'hi' })
    const edit = geoType.editText!(n)!
    expect(edit.box).toEqual({ x: 8, y: 33, w: 134, h: 34 })
  })
})
