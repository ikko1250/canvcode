import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import { upgradeNode } from './defineNodeType.ts'
import { GEO_DEFAULT_STROKE, geoType, type GeoProps } from './geo.ts'
import { solidPaint } from './paint.ts'
import {
  defaultDashGap,
  defaultDashLength,
  strokeInset,
  strokeOutline,
  strokeOutset,
  strokeStyleOf,
  toStrokePaint,
  type StrokeOutline,
  type StrokeStyle,
} from './stroke.ts'

// ボーダー（MAI-85）

function geo(props: Partial<GeoProps> & Record<string, unknown>, version = 3): NodeRecord<GeoProps> {
  return {
    typeName: 'node',
    id: 'g1',
    type: 'geo',
    parentId: 'c1',
    x: 0,
    y: 0,
    rotation: 0,
    index: 'a0',
    opacity: 1,
    locked: false,
    version,
    props: { ...geoType.defaultProps(), w: 100, h: 100, ...props } as GeoProps,
    meta: {},
  }
}

// 線を描いたときの状態と、パス・切り抜きの呼び出しを記録する Canvas
function recordingContext() {
  const calls: string[] = []
  const strokes: { width: number; dash: number[]; cap: string; alpha: number; style: unknown }[] = []
  const stack: Record<string, unknown>[] = []
  let dash: number[] = []
  const state = () => ({ lineWidth: ctx.lineWidth, lineCap: ctx.lineCap, globalAlpha: ctx.globalAlpha, strokeStyle: ctx.strokeStyle, dash })
  const ctx = {
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    miterLimit: 10,
    lineDashOffset: 0,
    globalAlpha: 1,
    strokeStyle: '#000000' as unknown,
    save: () => stack.push(state()),
    restore() {
      const s = stack.pop()!
      dash = s.dash as number[]
      Object.assign(ctx, { lineWidth: s.lineWidth, lineCap: s.lineCap, globalAlpha: s.globalAlpha, strokeStyle: s.strokeStyle })
    },
    setLineDash: (value: number[]) => (dash = value),
    beginPath: () => calls.push('beginPath'),
    moveTo: () => {},
    lineTo: () => calls.push('lineTo'),
    arc: () => calls.push('arc'),
    closePath: () => {},
    rect: (x: number, y: number, w: number, h: number) => calls.push(`rect ${x} ${y} ${w} ${h}`),
    ellipse: (_x: number, _y: number, rx: number, ry: number) => calls.push(`ellipse ${rx} ${ry}`),
    clip: (rule?: string) => calls.push(rule ? `clip ${rule}` : 'clip'),
    fill: () => {},
    stroke() {
      calls.push('stroke')
      strokes.push({ width: ctx.lineWidth, dash, cap: ctx.lineCap, alpha: ctx.globalAlpha, style: ctx.strokeStyle })
    },
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, strokes, raw: ctx }
}

const RECT: StrokeOutline = { kind: 'rect', box: { x: 0, y: 0, w: 100, h: 50 }, radii: [0, 0, 0, 0] }
const ELLIPSE: StrokeOutline = { kind: 'ellipse', box: { x: 0, y: 0, w: 100, h: 50 } }

function style(patch: Partial<StrokeStyle>): StrokeStyle {
  return { ...strokeStyleOf({ stroke: solidPaint('#ff0000'), strokeWidth: 4 }), ...patch }
}

describe('stroke values', () => {
  it('reads old color strings, paints and no stroke', () => {
    expect(toStrokePaint('#ff0000')).toEqual(solidPaint('#ff0000'))
    expect(toStrokePaint('none')).toBeNull()
    expect(toStrokePaint(null)).toBeNull()
    expect(toStrokePaint({ type: 'solid', color: '#00ff00', opacity: 2 })).toEqual(solidPaint('#00ff00', 1))
    // グラデーションの線は持たない
    expect(toStrokePaint({ type: 'linear', start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, stops: [] }, solidPaint('#111111'))).toEqual(solidPaint('#111111'))
  })

  it('fills in the defaults for old records and unreadable values', () => {
    expect(strokeStyleOf({ stroke: '#3b5bdb', strokeWidth: 2 })).toEqual({
      paint: solidPaint('#3b5bdb'),
      width: 2,
      align: 'center',
      dash: 'solid',
      dashLength: defaultDashLength(2),
      dashGap: defaultDashGap(2),
    })
    const s = strokeStyleOf({ stroke: null, strokeWidth: -1, strokeAlign: 'middle', strokeDash: 'wavy', strokeDashLength: 12, strokeDashGap: 0 })
    expect(s).toMatchObject({ paint: null, width: 0, align: 'center', dash: 'solid', dashLength: 12, dashGap: defaultDashGap(0) })
  })

  it('reaches outside / inside the edge by the stroke position', () => {
    expect(strokeOutset(style({ align: 'center' }))).toBe(2)
    expect(strokeOutset(style({ align: 'outside' }))).toBe(4)
    expect(strokeOutset(style({ align: 'inside' }))).toBe(0)
    expect(strokeInset(style({ align: 'inside' }))).toBe(4)
    expect(strokeInset(style({ align: 'outside' }))).toBe(0)
    // 線なしは届かない
    expect(strokeOutset(style({ paint: null, align: 'outside' }))).toBe(0)
  })
})

describe('strokeOutline', () => {
  it('strokes the edge itself in the center', () => {
    const { ctx, calls, strokes } = recordingContext()
    strokeOutline(ctx, style({ paint: solidPaint('#ff0000', 0.5) }), RECT)
    expect(calls).toEqual(['beginPath', 'rect 0 0 100 50', 'stroke'])
    expect(strokes).toEqual([{ width: 4, dash: [], cap: 'butt', alpha: 0.5, style: '#ff0000' }])
  })

  it('clips to the shape and doubles the width inside', () => {
    const { ctx, calls, strokes } = recordingContext()
    strokeOutline(ctx, style({ align: 'inside' }), RECT)
    expect(calls).toEqual(['beginPath', 'beginPath', 'rect 0 0 100 50', 'clip', 'beginPath', 'rect 0 0 100 50', 'stroke'])
    expect(strokes[0].width).toBe(8)
  })

  it('clips outside the shape (evenodd) and doubles the width outside', () => {
    const { ctx, calls, strokes } = recordingContext()
    strokeOutline(ctx, style({ align: 'outside' }), ELLIPSE)
    expect(calls).toEqual(['beginPath', 'beginPath', 'rect -9 -9 118 68', 'ellipse 50 25', 'clip evenodd', 'beginPath', 'ellipse 50 25', 'stroke'])
    expect(strokes[0].width).toBe(8)
  })

  it('draws dashes with butt caps and dots with round caps on an offset outline', () => {
    const dashed = recordingContext()
    strokeOutline(dashed.ctx, style({ dash: 'dashed', dashLength: 10, dashGap: 5 }), RECT)
    expect(dashed.strokes[0]).toMatchObject({ dash: [10, 5], cap: 'butt' })
    // 点線の内側：太さの半分だけ内へ縮めた形を、そのままの太さで（点が半分に切れない）
    const dotted = recordingContext()
    strokeOutline(dotted.ctx, style({ dash: 'dotted', dashGap: 6, align: 'inside' }), RECT)
    expect(dotted.calls).toEqual(['beginPath', 'rect 2 2 96 46', 'stroke'])
    expect(dotted.strokes[0]).toMatchObject({ width: 4, dash: [0, 10], cap: 'round' })
    const outside = recordingContext()
    strokeOutline(outside.ctx, style({ dash: 'dotted', align: 'outside' }), ELLIPSE)
    expect(outside.calls).toEqual(['beginPath', 'ellipse 52 27', 'stroke'])
  })

  it('draws nothing without a visible stroke and restores the context', () => {
    const { ctx, calls, raw } = recordingContext()
    strokeOutline(ctx, style({ paint: null }), RECT)
    strokeOutline(ctx, style({ width: 0 }), RECT)
    strokeOutline(ctx, style({ paint: solidPaint('#ff0000', 0) }), RECT)
    expect(calls).toEqual([])
    strokeOutline(ctx, style({ dash: 'dotted', align: 'outside' }), RECT)
    expect(raw.lineCap).toBe('butt')
    expect(raw.lineWidth).toBe(1)
  })
})

describe('geo border (version 3)', () => {
  it('migrates the color string to a solid paint', () => {
    const old = geo({ stroke: '#e03131' as never, strokeWidth: 3 }, 2)
    const upgraded = upgradeNode(geoType, old) as NodeRecord<GeoProps>
    expect(upgraded.version).toBe(3)
    expect(upgraded.props.stroke).toEqual(solidPaint('#e03131'))
    expect(upgraded.props.strokeWidth).toBe(3)
    expect((upgradeNode(geoType, geo({ stroke: 'transparent' as never }, 2)) as NodeRecord<GeoProps>).props.stroke).toBeNull()
    const { stroke: _, ...noStroke } = geo({}, 1).props
    expect((upgradeNode(geoType, { ...geo({}, 1), props: noStroke as GeoProps }) as NodeRecord<GeoProps>).props.stroke).toEqual(solidPaint(GEO_DEFAULT_STROKE))
  })

  it('reaches outside its box by the outer part of the stroke', () => {
    expect(geoType.renderOutset!(geo({ strokeWidth: 4 }))).toBe(2)
    expect(geoType.renderOutset!(geo({ strokeWidth: 4, strokeAlign: 'outside' }))).toBe(4)
    expect(geoType.renderOutset!(geo({ strokeWidth: 4, strokeAlign: 'inside' }))).toBe(0)
    expect(geoType.renderOutset!(geo({ stroke: null, strokeWidth: 4, strokeAlign: 'outside' }))).toBe(0)
  })

  it('hits the stroke where it is drawn', () => {
    // 外側の線：箱の外の線にも当たる。塗りなしなら、縁のすぐ内側には当たらない
    const outside = geo({ fill: null, strokeWidth: 10, strokeAlign: 'outside' })
    expect(geoType.hitTest(outside, { x: -8, y: 50 }, 0, 1)).toBe(true)
    expect(geoType.hitTest(outside, { x: -12, y: 50 }, 0, 1)).toBe(false)
    expect(geoType.hitTest(outside, { x: 3, y: 50 }, 0, 1)).toBe(false)
    // 内側の線：箱の外には当たらず、内側の太さの分だけ当たる
    const inside = geo({ fill: null, strokeWidth: 10, strokeAlign: 'inside' })
    expect(geoType.hitTest(inside, { x: -2, y: 50 }, 0, 1)).toBe(false)
    expect(geoType.hitTest(inside, { x: 8, y: 50 }, 0, 1)).toBe(true)
    expect(geoType.hitTest(inside, { x: 12, y: 50 }, 0, 1)).toBe(false)
    // 塗りがあれば、外側の線と中に当たる
    const filled = geo({ strokeWidth: 10, strokeAlign: 'outside' })
    expect(geoType.hitTest(filled, { x: -8, y: 50 }, 0, 1)).toBe(true)
    expect(geoType.hitTest(filled, { x: 50, y: 50 }, 0, 1)).toBe(true)
    // 線なしで塗りなし・文字なし：見失わないよう中に当たる
    expect(geoType.hitTest(geo({ fill: null, stroke: null }), { x: 50, y: 50 }, 0, 1)).toBe(true)
  })

  it('lists the stroke color and uses it for the rough color', () => {
    expect(geoType.colors!(geo({ fill: null, stroke: solidPaint('#0000ff', 0.5) }))).toEqual(['#0000ff'])
    expect(geoType.colors!(geo({ fill: null, stroke: null }))).toEqual([])
    expect(geoType.roughColor!(geo({ fill: null, stroke: solidPaint('#0000ff', 0.5) }))).toBe('rgba(0, 0, 255, 0.175)')
    expect(geoType.roughColor!(geo({ fill: null, stroke: null }))).toBe('transparent')
  })

  it('skips strokes thinner than half a screen pixel', () => {
    const { ctx, calls } = recordingContext()
    geoType.render(ctx, geo({ fill: null, strokeWidth: 2 }), { zoom: 0.2, devicePixelRatio: 1, detail: 'full' })
    expect(calls).not.toContain('stroke')
    geoType.render(ctx, geo({ fill: null, strokeWidth: 2, strokeAlign: 'inside' }), { zoom: 1, devicePixelRatio: 1, detail: 'full' })
    expect(calls).toContain('clip')
  })
})
