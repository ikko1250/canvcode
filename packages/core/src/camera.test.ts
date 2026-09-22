import { describe, expect, it } from 'vitest'
import { MAX_ZOOM, MIN_ZOOM, fitBox, panBy, screenToWorld, worldToScreen, zoomAt } from './camera.ts'
import { applyMat, invert, multiply, transformBox, transformOf } from './geometry.ts'

describe('camera', () => {
  const camera = { x: 100, y: -50, zoom: 2 }

  it('round-trips between screen and world coordinates', () => {
    const screen = { x: 37, y: 91 }
    const world = screenToWorld(camera, screen)
    expect(world).toEqual({ x: 118.5, y: -4.5 })
    expect(worldToScreen(camera, world)).toEqual(screen)
  })

  it('keeps the anchor point fixed while zooming', () => {
    const anchor = { x: 320, y: 240 }
    const before = screenToWorld(camera, anchor)
    const next = zoomAt(camera, anchor, 3.7)
    const after = screenToWorld(next, anchor)
    expect(after.x).toBeCloseTo(before.x, 10)
    expect(after.y).toBeCloseTo(before.y, 10)
  })

  it('clamps zoom to the allowed range', () => {
    expect(zoomAt(camera, { x: 0, y: 0 }, 100).zoom).toBe(MAX_ZOOM)
    expect(zoomAt(camera, { x: 0, y: 0 }, 0.0001).zoom).toBe(MIN_ZOOM)
  })

  it('pans so that content follows the pointer', () => {
    const next = panBy(camera, 10, 20)
    expect(worldToScreen(next, { x: 100, y: -50 })).toEqual({ x: 10, y: 20 })
  })

  it('fits a box into the viewport', () => {
    const fit = fitBox({ x: 0, y: 0, w: 1000, h: 500 }, 1200, 700, 100)
    expect(fit.zoom).toBe(1)
    const center = worldToScreen(fit, { x: 500, y: 250 })
    expect(center).toEqual({ x: 600, y: 350 })
  })
})

describe('matrices', () => {
  it('inverts a rotation and translation', () => {
    const m = transformOf(10, 20, Math.PI / 3)
    const p = applyMat(multiply(invert(m), m), { x: 3, y: -7 })
    expect(p.x).toBeCloseTo(3, 10)
    expect(p.y).toBeCloseTo(-7, 10)
  })

  it('computes the bounds of a rotated box', () => {
    const bounds = transformBox(transformOf(0, 0, Math.PI / 2), { x: 0, y: 0, w: 10, h: 4 })
    expect(bounds.x).toBeCloseTo(-4, 10)
    expect(bounds.y).toBeCloseTo(0, 10)
    expect(bounds.w).toBeCloseTo(4, 10)
    expect(bounds.h).toBeCloseTo(10, 10)
  })
})
