import { describe, expect, it } from 'vitest'
import {
  DRAW_DEFAULT_COLOR,
  DRAW_DEFAULT_OPACITY,
  DRAW_OPACITY_STOPS,
  drawOpacityAngleFromPoint,
  drawOpacityFromAngle,
  drawOpacityToAngle,
  snapDrawOpacity,
} from './draw.ts'

// フリーハンドの透過率（MAI-49）

describe('snapDrawOpacity', () => {
  it('snaps to the nearest of 100 / 75 / 50 / 25 / 0 %', () => {
    expect(snapDrawOpacity(0.9)).toBe(1)
    expect(snapDrawOpacity(0.8)).toBe(0.75)
    expect(snapDrawOpacity(0.6)).toBe(0.5)
    expect(snapDrawOpacity(0.4)).toBe(0.5)
    expect(snapDrawOpacity(0.3)).toBe(0.25)
    expect(snapDrawOpacity(0.1)).toBe(0)
    for (const stop of DRAW_OPACITY_STOPS) expect(snapDrawOpacity(stop)).toBe(stop)
  })

  it('keeps the value free while the modifier is held, still clamped to 0..1', () => {
    expect(snapDrawOpacity(0.63, true)).toBe(0.63)
    expect(snapDrawOpacity(1.4, true)).toBe(1)
    expect(snapDrawOpacity(-0.2, true)).toBe(0)
  })

  it('clamps out-of-range values before snapping, and falls back to the default for NaN', () => {
    expect(snapDrawOpacity(7)).toBe(1)
    expect(snapDrawOpacity(-3)).toBe(0)
    expect(snapDrawOpacity(Number.NaN)).toBe(DRAW_DEFAULT_OPACITY)
  })

  it('defaults to red at 50%', () => {
    expect(DRAW_DEFAULT_COLOR).toBe('#e03131')
    expect(DRAW_DEFAULT_OPACITY).toBe(0.5)
  })
})

describe('ring angles', () => {
  it('puts 0% at the lower left, 50% at the top and 100% at the lower right', () => {
    expect(drawOpacityToAngle(0)).toBe(-150)
    expect(drawOpacityToAngle(0.5)).toBe(0)
    expect(drawOpacityToAngle(1)).toBe(150)
  })

  it('maps angles back to opacity, and clamps the gap at the bottom to the nearer end', () => {
    for (const stop of DRAW_OPACITY_STOPS) expect(drawOpacityFromAngle(drawOpacityToAngle(stop))).toBeCloseTo(stop, 9)
    expect(drawOpacityFromAngle(-170)).toBe(0)
    expect(drawOpacityFromAngle(170)).toBe(1)
    // 一回り以上した角度も同じ
    expect(drawOpacityFromAngle(360)).toBeCloseTo(0.5, 9)
    expect(drawOpacityFromAngle(-360 + 75)).toBeCloseTo(0.75, 9)
  })

  it('measures the angle clockwise from the top of the ring', () => {
    expect(drawOpacityAngleFromPoint(0, -10)).toBeCloseTo(0, 9)
    expect(drawOpacityAngleFromPoint(10, 0)).toBeCloseTo(90, 9)
    expect(drawOpacityAngleFromPoint(0, 10)).toBeCloseTo(180, 9)
    expect(drawOpacityAngleFromPoint(-10, 0)).toBeCloseTo(-90, 9)
  })
})
