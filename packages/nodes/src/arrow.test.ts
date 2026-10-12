import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import { arrowDashStyle, arrowType, type ArrowProps } from './arrow.ts'

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

// stroke() のたびに、そのときの破線の模様と lineCap を記録する
function recordingContext() {
  const strokes: { dash: number[]; cap: string }[] = []
  let dash: number[] = []
  const ctx = {
    lineWidth: 0,
    strokeStyle: '',
    fillStyle: '',
    lineCap: 'butt',
    lineJoin: 'miter',
    lineDashOffset: 0,
    setLineDash: (value: number[]) => (dash = [...value]),
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    arc: () => {},
    fillRect: () => {},
    stroke: () => strokes.push({ dash, cap: ctx.lineCap }),
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, strokes, lastDash: () => dash }
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
