import { describe, expect, it } from 'vitest'
import { applyMat, type NodeRecord } from '@canvcode/core'
import { geoType } from '@canvcode/nodes'
import {
  frameMatrix,
  handleCursor,
  handlePosition,
  normalizeAngle,
  resizeFrame,
  resizeNodes,
  rotateNodes,
  rotationDelta,
  type Frame,
} from './transform.ts'

const free = { keepAspect: false, fromCenter: false, minW: 1, minH: 1 }

function expectFrame(actual: Frame, expected: Frame) {
  for (const key of ['x', 'y', 'w', 'h', 'rotation'] as const) expect(actual[key]).toBeCloseTo(expected[key], 9)
}

function geo(fields: Partial<NodeRecord> & { w: number; h: number }): NodeRecord {
  const { w, h, ...rest } = fields
  return {
    typeName: 'node',
    id: 'node:a',
    type: 'geo',
    parentId: 'canvas:1',
    x: 0,
    y: 0,
    rotation: 0,
    index: 'a0',
    opacity: 1,
    locked: false,
    props: { ...geoType.defaultProps(), w, h },
    meta: {},
    ...rest,
  }
}

describe('resizeFrame', () => {
  const frame: Frame = { x: 100, y: 100, w: 200, h: 100, rotation: 0 }

  it('moves only the dragged corner and keeps the opposite corner fixed', () => {
    expectFrame(resizeFrame(frame, 'se', { x: 400, y: 250 }, free), { x: 100, y: 100, w: 300, h: 150, rotation: 0 })
    expectFrame(resizeFrame(frame, 'nw', { x: 50, y: 80 }, free), { x: 50, y: 80, w: 250, h: 120, rotation: 0 })
  })

  it('changes one side with an edge handle', () => {
    expectFrame(resizeFrame(frame, 'e', { x: 350, y: 999 }, free), { x: 100, y: 100, w: 250, h: 100, rotation: 0 })
    expectFrame(resizeFrame(frame, 'n', { x: 0, y: 60 }, free), { x: 100, y: 60, w: 200, h: 140, rotation: 0 })
  })

  it('keeps the aspect ratio and resizes from the center', () => {
    const r = resizeFrame(frame, 'se', { x: 500, y: 150 }, { ...free, keepAspect: true })
    expect(r.w / r.h).toBeCloseTo(2, 9)
    expect(r.w).toBeCloseTo(400, 9)
    const c = resizeFrame(frame, 'e', { x: 350, y: 150 }, { ...free, fromCenter: true })
    expectFrame(c, { x: 50, y: 100, w: 300, h: 100, rotation: 0 })
  })

  it('does not go below the minimum size or flip', () => {
    const r = resizeFrame(frame, 'se', { x: 0, y: 0 }, { ...free, minW: 20, minH: 10 })
    expectFrame(r, { x: 100, y: 100, w: 20, h: 10, rotation: 0 })
  })

  it('resizes along the rotated axes and keeps the opposite corner fixed in the world', () => {
    const rotated: Frame = { x: 0, y: 0, w: 100, h: 50, rotation: Math.PI / 2 }
    const fixedBefore = handlePosition(rotated, 'nw')
    // 90° 回した枠の「右下」は、ワールドでは左下にある。そこを 50 だけ外へ引く
    const se = handlePosition(rotated, 'se')
    const r = resizeFrame(rotated, 'se', { x: se.x - 50, y: se.y + 50 }, free)
    expect(r.w).toBeCloseTo(150, 9)
    expect(r.h).toBeCloseTo(100, 9)
    const fixedAfter = handlePosition(r, 'nw')
    expect(fixedAfter.x).toBeCloseTo(fixedBefore.x, 9)
    expect(fixedAfter.y).toBeCloseTo(fixedBefore.y, 9)
  })
})

describe('resizeNodes', () => {
  it('scales positions and sizes of several nodes inside the frame', () => {
    const a = geo({ id: 'node:a', x: 0, y: 0, w: 100, h: 100 })
    const b = geo({ id: 'node:b', x: 200, y: 100, w: 100, h: 100 })
    const oldFrame: Frame = { x: 0, y: 0, w: 300, h: 200, rotation: 0 }
    const newFrame: Frame = { x: 0, y: 0, w: 600, h: 200, rotation: 0 }
    const targets = [a, b].map((node) => ({
      node,
      type: geoType,
      frame: { x: node.x, y: node.y, w: 100, h: 100, rotation: 0 },
    }))
    const [ra, rb] = resizeNodes(targets, oldFrame, newFrame)
    expect([ra.x, ra.y, (ra.props as { w: number }).w]).toEqual([0, 0, 200])
    expect([rb.x, rb.y, (rb.props as { w: number }).w, (rb.props as { h: number }).h]).toEqual([400, 100, 200, 100])
  })

  it('swaps the axes for nodes turned by 90 degrees', () => {
    const turned = geo({ id: 'node:t', x: 100, y: 0, w: 100, h: 40, rotation: Math.PI / 2 })
    const other = geo({ id: 'node:o', x: 200, y: 0, w: 10, h: 10 })
    const targets = [turned, other].map((node) => ({
      node,
      type: geoType,
      frame: { x: node.x, y: node.y, w: (node.props as { w: number }).w, h: (node.props as { h: number }).h, rotation: node.rotation },
    }))
    const [r] = resizeNodes(targets, { x: 60, y: 0, w: 150, h: 100, rotation: 0 }, { x: 60, y: 0, w: 150, h: 200, rotation: 0 })
    // ワールドの縦を 2 倍にすると、90° 回したノードはローカルの幅が 2 倍になる
    expect((r.props as { w: number }).w).toBeCloseTo(200, 9)
    expect((r.props as { h: number }).h).toBeCloseTo(40, 9)
  })
})

describe('rotation', () => {
  it('rotates nodes around the pivot', () => {
    const node = geo({ x: 100, y: 0, w: 10, h: 10 })
    const [r] = rotateNodes([node], { x: 0, y: 0 }, Math.PI / 2)
    expect(r.x).toBeCloseTo(0, 9)
    expect(r.y).toBeCloseTo(100, 9)
    expect(r.rotation).toBeCloseTo(Math.PI / 2, 9)
  })

  it('snaps to 15 degree steps', () => {
    const pivot = { x: 0, y: 0 }
    const start = { x: 100, y: 0 }
    const pointer = { x: Math.cos(0.3), y: Math.sin(0.3) }
    expect(rotationDelta(pivot, start, pointer, true, null)).toBeCloseTo(Math.PI / 12, 9)
    // 1 つだけのときは、ノードの向きが 15° 刻みになる（元が 5° 回っていれば 10° 回す）
    const base = (5 * Math.PI) / 180
    expect(rotationDelta(pivot, start, pointer, true, base)).toBeCloseTo((10 * Math.PI) / 180, 9)
  })

  it('normalizes angles and picks cursors along the rotation', () => {
    expect(normalizeAngle(Math.PI * 3)).toBeCloseTo(-Math.PI, 9)
    expect(handleCursor('e', 0)).toBe('ew-resize')
    expect(handleCursor('e', Math.PI / 2)).toBe('ns-resize')
    expect(handleCursor('se', Math.PI / 4)).toBe('ns-resize')
  })

  it('places the frame matrix at the frame origin', () => {
    const p = applyMat(frameMatrix({ x: 10, y: 20, w: 1, h: 1, rotation: Math.PI }), { x: 1, y: 0 })
    expect(p.x).toBeCloseTo(9, 9)
    expect(p.y).toBeCloseTo(20, 9)
  })
})
