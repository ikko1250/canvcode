import { describe, expect, it } from 'vitest'
import { alignBoxes, distributeBoxes, lanesOf, meanGap, spaceBoxes, spacingOf, type ArrangeBox, type Move } from './arrange.ts'

// 整列・等間隔・間隔（MAI-54）

function box(id: string, x: number, y: number, w = 100, h = 50): ArrangeBox {
  return { id, x, y, w, h }
}

// moves を当てたあとの箱
function apply(boxes: ArrangeBox[], moves: Move[]): ArrangeBox[] {
  return boxes.map((b) => {
    const move = moves.find((m) => m.id === b.id)
    return move ? { ...b, x: b.x + move.dx, y: b.y + move.dy } : b
  })
}

describe('alignBoxes', () => {
  const boxes = [box('a', 0, 0, 100, 50), box('b', 300, 200, 50, 100), box('c', 150, 80, 20, 20)]

  it('aligns to each edge of the union bounds, moving only the axis of the edge', () => {
    const left = apply(boxes, alignBoxes(boxes, 'left'))
    expect(left.map((b) => b.x)).toEqual([0, 0, 0])
    expect(left.map((b) => b.y)).toEqual([0, 200, 80])
    const right = apply(boxes, alignBoxes(boxes, 'right'))
    expect(right.map((b) => b.x + b.w)).toEqual([350, 350, 350])
    const hcenter = apply(boxes, alignBoxes(boxes, 'hcenter'))
    expect(hcenter.map((b) => b.x + b.w / 2)).toEqual([175, 175, 175])
    const top = apply(boxes, alignBoxes(boxes, 'top'))
    expect(top.map((b) => b.y)).toEqual([0, 0, 0])
    expect(top.map((b) => b.x)).toEqual([0, 300, 150])
    const bottom = apply(boxes, alignBoxes(boxes, 'bottom'))
    expect(bottom.map((b) => b.y + b.h)).toEqual([300, 300, 300])
    const vcenter = apply(boxes, alignBoxes(boxes, 'vcenter'))
    expect(vcenter.map((b) => b.y + b.h / 2)).toEqual([150, 150, 150])
  })

  it('omits boxes that already sit on the edge and does nothing for a single box', () => {
    expect(alignBoxes(boxes, 'left').map((m) => m.id)).toEqual(['b', 'c'])
    expect(alignBoxes([boxes[0]], 'left')).toEqual([])
  })
})

describe('distributeBoxes', () => {
  it('keeps both ends and equalises the gaps between boxes of different sizes', () => {
    const boxes = [box('a', 0, 0, 100, 50), box('c', 500, 30, 60, 50), box('b', 120, 10, 20, 50), box('d', 800, 0, 200, 50)]
    const out = apply(boxes, distributeBoxes(boxes, 'x'))
    const byId = Object.fromEntries(out.map((b) => [b.id, b]))
    expect(byId.a.x).toBe(0)
    expect(byId.d.x).toBe(800)
    // 隙間：800 - 100 - (20 + 60) = 620 を 3 等分
    const gap = 620 / 3
    expect(byId.b.x).toBeCloseTo(100 + gap)
    expect(byId.c.x).toBeCloseTo(100 + gap + 20 + gap)
    // もう一方の軸は変えない
    expect(out.map((b) => b.y)).toEqual([0, 30, 10, 0])
  })

  it('works vertically and needs at least three boxes', () => {
    const boxes = [box('a', 0, 0, 50, 100), box('b', 0, 130, 50, 20), box('c', 0, 400, 50, 60)]
    const out = apply(boxes, distributeBoxes(boxes, 'y'))
    expect(out[1].y).toBeCloseTo(100 + (400 - 100 - 20) / 2)
    expect(distributeBoxes(boxes.slice(0, 2), 'y')).toEqual([])
  })
})

describe('spaceBoxes', () => {
  it('keeps the first box and lays out the rest with a positive gap', () => {
    const boxes = [box('b', 500, 0, 30), box('a', 0, 0, 100), box('c', 900, 0, 50)]
    const out = apply(boxes, spaceBoxes(boxes, 'x', 10))
    const byId = Object.fromEntries(out.map((b) => [b.id, b]))
    expect(byId.a.x).toBe(0)
    expect(byId.b.x).toBe(110)
    expect(byId.c.x).toBe(150)
  })

  it('allows a negative gap (overlap) and a vertical axis', () => {
    const boxes = [box('a', 0, 0, 100, 50), box('b', 0, 300, 100, 50)]
    const out = apply(boxes, spaceBoxes(boxes, 'y', -20))
    expect(out[1].y).toBe(30)
  })

  it('spaces each row of a grid separately', () => {
    const boxes = [box('a', 0, 0), box('b', 200, 0), box('c', 0, 100), box('d', 300, 100)]
    const out = apply(boxes, spaceBoxes(boxes, 'x', 40))
    expect(out.map((b) => [b.x, b.y])).toEqual([
      [0, 0],
      [140, 0],
      [0, 100],
      [140, 100],
    ])
  })

  it('packs scattered boxes (no overlap on the other axis) into one row', () => {
    const boxes = [box('a', 0, 0), box('b', 400, 300), box('c', 200, 600)]
    const out = apply(boxes, spaceBoxes(boxes, 'x', 0))
    expect(out.map((b) => b.x)).toEqual([0, 200, 100])
    expect(lanesOf(boxes, 'x').length).toBe(1)
  })

  it('reports the mean of the current gaps', () => {
    const boxes = [box('a', 0, 0), box('b', 110, 0), box('c', 240, 0)]
    expect(meanGap(boxes, 'x')).toBe(20)
    // 縦に並んだ列はないので、縦の間隔はない
    expect(meanGap(boxes, 'y')).toBeNull()
    expect(meanGap([boxes[0]], 'x')).toBeNull()
  })
})

describe('spacingOf', () => {
  it('finds the gaps of a row', () => {
    const boxes = [box('c', 260, 10, 100, 80), box('a', 0, 0), box('b', 130, 20, 100, 50)]
    const result = spacingOf(boxes)
    expect(result.map((s) => s.axis)).toEqual(['x'])
    expect(result[0].gap).toBe(30)
    // 隙間は、隣どうしの重なりの範囲だけ
    expect(result[0].gaps).toEqual([
      { box: { x: 100, y: 20, w: 30, h: 30 }, k: 1 },
      { box: { x: 230, y: 20, w: 30, h: 50 }, k: 2 },
    ])
  })

  it('finds the gaps of a column', () => {
    const boxes = [box('a', 0, 0, 100, 50), box('b', 0, 60, 100, 50), box('c', 0, 120, 100, 50)]
    const result = spacingOf(boxes)
    expect(result.map((s) => s.axis)).toEqual(['y'])
    expect(result[0].gap).toBe(10)
    expect(result[0].gaps.map((g) => g.box)).toEqual([
      { x: 0, y: 50, w: 100, h: 10 },
      { x: 0, y: 110, w: 100, h: 10 },
    ])
  })

  it('finds both axes of a grid, with the gap index counted within each row and column', () => {
    const boxes: ArrangeBox[] = []
    for (let row = 0; row < 2; row++) for (let col = 0; col < 3; col++) boxes.push(box(`${row}-${col}`, col * 140, row * 90, 100, 50))
    const result = spacingOf(boxes)
    expect(result.map((s) => s.axis)).toEqual(['x', 'y'])
    expect(result[0].gap).toBe(40)
    expect(result[0].gaps.map((g) => g.k)).toEqual([1, 2, 1, 2])
    expect(result[1].gap).toBe(40)
    expect(result[1].gaps.map((g) => g.k)).toEqual([1, 1, 1])
  })

  it('returns nothing when the gaps are uneven, and tolerates a difference of 1', () => {
    expect(spacingOf([box('a', 0, 0), box('b', 120, 0), box('c', 260, 0)])).toEqual([])
    expect(spacingOf([box('a', 0, 0), box('b', 120, 0), box('c', 241, 0)]).map((s) => s.axis)).toEqual(['x'])
  })

  it('reports a negative gap for overlapping boxes', () => {
    const boxes = [box('a', 0, 0), box('b', 80, 0), box('c', 160, 0)]
    const result = spacingOf(boxes)
    expect(result[0].gap).toBe(-20)
    expect(result[0].gaps[0].box).toEqual({ x: 80, y: 0, w: 20, h: 50 })
  })

  it('returns nothing for scattered boxes or a single box', () => {
    expect(spacingOf([box('a', 0, 0), box('b', 200, 200), box('c', 400, 400)])).toEqual([])
    expect(spacingOf([box('a', 0, 0)])).toEqual([])
  })
})
