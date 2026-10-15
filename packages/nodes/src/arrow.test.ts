import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import { arcPoint, arcTangent, arrowDashStyle, arrowGeometry, arrowType, type ArrowProps } from './arrow.ts'

// 矢印の線の種類（実線・破線・点線）

function arrow(props: Partial<ArrowProps> = {}): NodeRecord<ArrowProps> {
  return {
    typeName: 'node',
    id: 'node:a',
    type: 'arrow',
    version: 1,
    parentId: 'canvas:c',
    index: 'a1',
    x: 0,
    y: 0,
    rotation: 0,
    opacity: 1,
    locked: false,
    meta: {},
    props: { ...arrowType.defaultProps(), ...props },
  } as unknown as NodeRecord<ArrowProps>
}

// stroke() のたびに、そのときの破線の模様と lineCap を記録する。moveTo・lineTo で引いた線分も記録する
function recordingContext() {
  const strokes: { dash: number[]; cap: string }[] = []
  const segments: [{ x: number; y: number }, { x: number; y: number }][] = []
  let dash: number[] = []
  let at = { x: 0, y: 0 }
  const ctx = {
    lineWidth: 0,
    strokeStyle: '',
    fillStyle: '',
    lineCap: 'butt',
    lineJoin: 'miter',
    lineDashOffset: 0,
    setLineDash: (value: number[]) => (dash = [...value]),
    beginPath: () => {},
    moveTo: (x: number, y: number) => (at = { x, y }),
    lineTo: (x: number, y: number) => {
      segments.push([at, { x, y }])
      at = { x, y }
    },
    arc: () => {},
    fillRect: () => {},
    stroke: () => strokes.push({ dash, cap: ctx.lineCap }),
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, strokes, segments, lastDash: () => dash }
}

const info = { zoom: 1, devicePixelRatio: 1, detail: 'full' as const }

describe('arrow line style', () => {
  it('reads a missing or unknown dash as solid (old data), and the dash lengths from the size', () => {
    expect(arrowDashStyle(arrow().props)).toEqual({ dash: 'solid', dashLength: 12, dashGap: 6 })
    expect(arrowDashStyle(arrow({ strokeDash: 'wavy' as never }).props).dash).toBe('solid')
    // 長さ・間隔がなければ太さに比例する
    expect(arrowDashStyle(arrow({ strokeDash: 'dashed', size: 5 }).props)).toEqual({ dash: 'dashed', dashLength: 20, dashGap: 10 })
    // あればその px
    expect(arrowDashStyle(arrow({ strokeDash: 'dashed', size: 5, strokeDashLength: 7, strokeDashGap: 3 }).props)).toEqual({ dash: 'dashed', dashLength: 7, dashGap: 3 })
  })

  it('draws a solid arrow in one stroke without a dash pattern', () => {
    const { ctx, strokes } = recordingContext()
    arrowType.render(ctx, arrow(), info)
    expect(strokes).toEqual([{ dash: [], cap: 'round' }])
  })

  it('draws a dashed or dotted line, with solid arrowheads, and resets the dash afterwards', () => {
    const dashed = recordingContext()
    arrowType.render(dashed.ctx, arrow({ strokeDash: 'dashed', size: 3, arrowheadStart: 'arrow' }), info)
    expect(dashed.strokes).toEqual([
      { dash: [12, 6], cap: 'butt' },
      { dash: [], cap: 'round' },
    ])
    expect(dashed.lastDash()).toEqual([])

    // 点線は長さ 0 の破線と丸い端（間隔は点の縁どうし + 太さ）
    const dotted = recordingContext()
    arrowType.render(dotted.ctx, arrow({ strokeDash: 'dotted', size: 3, strokeDashGap: 4 }), info)
    expect(dotted.strokes[0]).toEqual({ dash: [0, 7], cap: 'round' })
    expect(dotted.lastDash()).toEqual([])
  })
})

describe('arrow end bars (寸法線)', () => {
  const close = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    expect(a.x).toBeCloseTo(b.x, 6)
    expect(a.y).toBeCloseTo(b.y, 6)
  }
  const bars = { arrowheadStart: 'bar', arrowheadEnd: 'bar' } as const

  it('draws a straight line to the end points, with a bar across each end and no arrowhead', () => {
    const { ctx, strokes, segments } = recordingContext()
    arrowType.render(ctx, arrow({ ...bars, size: 3 }), info)
    // 線・始点の線・終点の線の 3 本。長さは矢じりの開いた幅と同じ 8 + 3 × 3 = 17
    expect(segments).toHaveLength(3)
    close(segments[0][0], { x: 0, y: 0 })
    close(segments[0][1], { x: 100, y: 0 })
    close(segments[1][0], { x: 0, y: 8.5 })
    close(segments[1][1], { x: 0, y: -8.5 })
    close(segments[2][0], { x: 100, y: 8.5 })
    close(segments[2][1], { x: 100, y: -8.5 })
    expect(strokes).toEqual([{ dash: [], cap: 'round' }])
  })

  it('draws the bars solid on a dashed line', () => {
    const { ctx, strokes, segments } = recordingContext()
    arrowType.render(ctx, arrow({ ...bars, size: 3, strokeDash: 'dashed' }), info)
    expect(strokes).toEqual([
      { dash: [12, 6], cap: 'butt' },
      { dash: [], cap: 'round' },
    ])
    expect(segments).toHaveLength(3)
  })

  it('puts the bars across the tangent of a curved arrow, at the visible ends', () => {
    for (const clip of [
      [0, 1],
      [0.2, 0.8],
    ] as [number, number][]) {
      const props = arrow({ ...bars, size: 3, bend: 30, clip }).props
      const { ctx, segments } = recordingContext()
      arrowType.render(ctx, arrow(props), info)
      const g = arrowGeometry(props)
      // 曲線は arc で描くので、記録される線分は両端の線だけ
      expect(segments).toHaveLength(2)
      clip.forEach((t, i) => {
        const [a, b] = segments[i]
        close({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, arcPoint(g, t))
        expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(17, 6)
        const d = arcTangent(g, t)
        expect((b.x - a.x) * d.x + (b.y - a.y) * d.y).toBeCloseTo(0, 6)
      })
    }
  })

  it('widens the bounds by half a bar (and the whole arrowhead for arrows)', () => {
    const vertical = { start: { x: 0, y: 0 }, end: { x: 0, y: 100 }, size: 3 }
    expect(arrowType.getBounds(arrow({ ...vertical, ...bars }))).toEqual({ x: -11.5, y: -11.5, w: 23, h: 123 })
    expect(arrowType.getBounds(arrow({ ...vertical, arrowheadStart: 'arrow', arrowheadEnd: 'arrow' })).x).toBe(-20)
  })

  it('hits the bars', () => {
    expect(arrowType.hitTest(arrow({ size: 3, arrowheadEnd: 'bar' }), { x: 100, y: 8 }, 0, 1)).toBe(true)
    expect(arrowType.hitTest(arrow({ size: 3, arrowheadEnd: 'none' }), { x: 100, y: 8 }, 0, 1)).toBe(false)
  })

  it('draws an unknown end kind as an arrowhead', () => {
    const { ctx, segments } = recordingContext()
    arrowType.render(ctx, arrow({ arrowheadEnd: 'triangle' as never }), info)
    // 線と、矢じりの 2 本
    expect(segments).toHaveLength(3)
    close(segments[1][0], { x: 100, y: 0 })
    expect(segments[1][1].x).toBeLessThan(100)
  })
})
