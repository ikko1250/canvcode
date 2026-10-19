import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import { builtinNodeTypes, richTextFromPlain, type AnyNodeTypeDef } from '@canvcode/nodes'
import { anchorPoint, fitScale, SCALE_ANCHORS, scaledFontSize, scaleNodeProps, type ScaleOptions } from './scale.ts'

// 選んだノードをまとめて拡大・縮小する（edit_canvas の scale）

const types = new Map(builtinNodeTypes.map((t) => [t.type, t]))

function node(type: string, props: Record<string, unknown> = {}): { node: NodeRecord; type: AnyNodeTypeDef } {
  const def = types.get(type)!
  const record: NodeRecord = {
    typeName: 'node',
    id: `node:${type}`,
    type,
    parentId: 'canvas:root',
    x: 0,
    y: 0,
    rotation: 0,
    index: 'a1',
    opacity: 1,
    locked: false,
    props: { ...def.defaultProps(), ...props },
    meta: {},
  } as NodeRecord
  return { node: record, type: def }
}

const all: ScaleOptions = { text: true, strokes: true }

function scale(type: string, props: Record<string, unknown>, s: number, options: ScaleOptions = all) {
  const { node: record, type: def } = node(type, props)
  return scaleNodeProps(record, def, def.getBounds(record), s, options)
}

describe('scaledFontSize', () => {
  it('scales, and keeps at least minFontSize unless the text was already smaller', () => {
    expect(scaledFontSize(20, 0.5)).toBe(10)
    expect(scaledFontSize(20, 0.5, 11)).toBe(11)
    expect(scaledFontSize(20, 0.5, 8)).toBe(10)
    expect(scaledFontSize(9, 0.5, 11)).toBe(9)
    expect(scaledFontSize(20, 2, 11)).toBe(40)
  })
})

describe('fitScale', () => {
  it('takes the smaller factor, ignoring axes without size', () => {
    expect(fitScale({ x: 0, y: 0, w: 200, h: 100 }, { x: 0, y: 0, w: 100, h: 100 })).toBe(0.5)
    expect(fitScale({ x: 0, y: 0, w: 0, h: 100 }, { x: 0, y: 0, w: 10, h: 300 })).toBe(3)
    expect(fitScale({ x: 0, y: 0, w: 50, h: 0 }, { x: 0, y: 0, w: 100, h: 1 })).toBe(2)
    expect(fitScale({ x: 5, y: 5, w: 0, h: 0 }, { x: 0, y: 0, w: 100, h: 100 })).toBeNull()
  })
})

describe('anchorPoint', () => {
  it('gives the nine points of a box', () => {
    const box = { x: 10, y: 20, w: 100, h: 50 }
    expect(Object.fromEntries(SCALE_ANCHORS.map((a) => [a, anchorPoint(box, a)]))).toEqual({
      'top-left': { x: 10, y: 20 },
      top: { x: 60, y: 20 },
      'top-right': { x: 110, y: 20 },
      left: { x: 10, y: 45 },
      center: { x: 60, y: 45 },
      right: { x: 110, y: 45 },
      'bottom-left': { x: 10, y: 70 },
      bottom: { x: 60, y: 70 },
      'bottom-right': { x: 110, y: 70 },
    })
  })
})

describe('scaleNodeProps', () => {
  it('scales a shape: size, corners, label padding, label font, stroke, dash and shadows', () => {
    const shadow = { type: 'drop', x: 2, y: 4, blur: 8, spread: 1, color: '#000000', opacity: 0.25 }
    const r = scale(
      'geo',
      {
        w: 100,
        h: 60,
        cornerRadius: [10, 20, 0, 4],
        labelPadding: { top: 8, right: 4, bottom: 8, left: 4 },
        labelFontSize: 20,
        strokeWidth: 2,
        strokeDash: 'dashed',
        strokeDashLength: 6,
        strokeDashGap: 4,
        shadows: [shadow],
      },
      0.5,
    )
    expect(r.clamped).toBe(false)
    expect(r.textFactor).toBe(0.5)
    expect(r.props).toMatchObject({
      w: 50,
      h: 30,
      cornerRadius: [5, 10, 0, 2],
      labelPadding: { top: 4, right: 2, bottom: 4, left: 2 },
      labelFontSize: 10,
      strokeWidth: 1,
      strokeDashLength: 3,
      strokeDashGap: 2,
      shadows: [{ ...shadow, x: 1, y: 2, blur: 4, spread: 0.5 }],
    })
    expect(r.props).not.toHaveProperty('cornerRadius', undefined)
    const plain = scale('geo', { w: 100, h: 60, cornerRadius: 12, labelPadding: 8 }, 2, { text: false, strokes: false })
    expect(plain.props).toMatchObject({ w: 200, h: 120, cornerRadius: 24, labelPadding: 16, strokeWidth: 2 })
    expect(plain.props.labelFontSize).toBeUndefined()
  })

  it('stops a note at its minimum size and scales its text', () => {
    const r = scale('note', { w: 200, h: 100, sizing: 'fixed', fontSize: 20, paragraphs: richTextFromPlain('メモ') }, 0.5)
    expect(r.props).toMatchObject({ w: 100, h: 60, fontSize: 10 })
    expect(r.clamped).toBe(true)
  })

  it('keeps a note that fits its text fitted (the height follows the scaled text)', () => {
    const r = scale('note', { w: 200, h: 200, sizing: 'auto', fontSize: 20, paragraphs: richTextFromPlain('a\nb\nc') }, 2)
    expect(r.props).toMatchObject({ w: 400, fontSize: 40, sizing: 'auto' })
  })

  it('keeps the width of a text that fits its content, and scales a fixed width with its text', () => {
    const auto = scale('text', { fontSize: 20, paragraphs: richTextFromPlain('auto'), autoWidth: true, w: 200 }, 0.5)
    expect(auto.props).toMatchObject({ fontSize: 10, autoWidth: true, w: 200 })
    const fixed = scale('text', { fontSize: 20, paragraphs: richTextFromPlain('fixed'), autoWidth: false, w: 200 }, 0.5, { ...all, minFontSize: 11 })
    expect(fixed.textFactor).toBeCloseTo(0.55)
    expect(fixed.props).toMatchObject({ fontSize: 11, autoWidth: false })
    expect(fixed.props.w).toBeCloseTo(110)
    const unchanged = scale('text', { fontSize: 20, paragraphs: richTextFromPlain('same'), autoWidth: false, w: 200 }, 0.5, { text: false, strokes: true })
    expect(unchanged.textFactor).toBe(1)
    expect(unchanged.props).toMatchObject({ fontSize: 20, w: 200 })
  })

  it('scales the ends, bend, width and dash of an arrow, and the points of a drawing', () => {
    const arrow = scale('arrow', { start: { x: 0, y: 0 }, end: { x: 100, y: 40 }, bend: 30, size: 3, strokeDash: 'dashed', strokeDashLength: 8 }, 0.5)
    expect(arrow.props).toMatchObject({ start: { x: 0, y: 0 }, end: { x: 50, y: 20 }, bend: 15, size: 1.5, strokeDashLength: 4 })
    expect(arrow.props.strokeDashGap).toBeUndefined()
    const draw = scale('draw', { points: [2, 2, 10, 6, 20, 4], size: 4 }, 2)
    expect(draw.props).toMatchObject({ points: [4, 4, 20, 12, 40, 8], size: 8 })
    const thin = scale('draw', { points: [2, 2, 10, 6], size: 4 }, 2, { text: true, strokes: false })
    expect(thin.props).toMatchObject({ points: [4, 4, 20, 12], size: 4 })
  })

  it('keeps the aspect ratio of an image stopped at its minimum size', () => {
    const r = scale('image', { w: 100, h: 20 }, 0.1)
    expect(r.clamped).toBe(true)
    expect(r.props.w).toBeCloseTo(40)
    expect(r.props.h).toBeCloseTo(8)
  })
})
