import { describe, expect, it } from 'vitest'
import { arrowAngle, arrowLength, arrowWithDirection, snapArrowPoint } from './arrow.ts'

// 矢印の向き（角度）と長さ、Shift で吸い付ける向き

const p = (x: number, y: number) => ({ x, y })

describe('arrow direction', () => {
  it('measures the angle like a rotation: 0° to the right, clockwise, 0–360°', () => {
    expect(arrowAngle({ start: p(0, 0), end: p(100, 0) })).toBe(0)
    // y は下向きなので、下へ向かう矢印が 90°
    expect(arrowAngle({ start: p(0, 0), end: p(0, 100) })).toBe(90)
    expect(arrowAngle({ start: p(0, 0), end: p(-100, 0) })).toBe(180)
    expect(arrowAngle({ start: p(0, 0), end: p(0, -100) })).toBe(270)
    expect(arrowAngle({ start: p(10, 10), end: p(10, 10) })).toBe(0)
    expect(arrowLength({ start: p(0, 0), end: p(30, 40) })).toBe(50)
  })

  it('turns about the middle, the start or the end', () => {
    const props = { start: p(0, 0), end: p(100, 0), bend: 20 }
    const middle = arrowWithDirection(props, 90, 100, 'middle')
    expect(middle.start).toEqual(p(50, -50))
    expect(middle.end).toEqual(p(50, 50))
    expect(middle.bend).toBe(20)
    expect(arrowWithDirection(props, 90, 100, 'start')).toMatchObject({ start: p(0, 0), end: p(0, 100) })
    expect(arrowWithDirection(props, 90, 100, 'end')).toMatchObject({ start: p(100, -100), end: p(100, 0) })
    // 長さだけ変える
    expect(arrowWithDirection(props, 0, 200, 'start')).toMatchObject({ start: p(0, 0), end: p(200, 0) })
    // 変わらなければ同じもの
    expect(arrowWithDirection(props, 0, 100, 'middle')).toBe(props)
  })

  it('snaps to 45° steps, keeping the length along the snapped line', () => {
    expect(snapArrowPoint(p(0, 0), p(100, 10))).toEqual(p(100, 0))
    expect(snapArrowPoint(p(0, 0), p(10, -100))).toEqual(p(0, -100))
    const diagonal = snapArrowPoint(p(0, 0), p(100, 90))
    expect(diagonal.x).toBeCloseTo(95, 6)
    expect(diagonal.y).toBeCloseTo(95, 6)
    expect(snapArrowPoint(p(50, 50), p(-50, 52))).toEqual(p(-50, 50))
    expect(snapArrowPoint(p(5, 5), p(5, 5))).toEqual(p(5, 5))
  })
})
