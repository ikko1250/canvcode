import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import { geoType, type GeoProps } from './geo.ts'
import { solidPaint } from './paint.ts'
import { defaultShadow, drawShadows, shadowColors, shadowOutset, shadowsOf, shouldDrawShadow, toShadow, type Shadow } from './shadow.ts'

// シャドウ（MAI-86）

function geo(props: Partial<GeoProps>): NodeRecord<GeoProps> {
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
    version: 3,
    props: { ...geoType.defaultProps(), w: 100, h: 50, ...props } as GeoProps,
    meta: {},
  }
}

const drop = (patch: Partial<Shadow> = {}): Shadow => ({ ...defaultShadow(), ...patch })

describe('shadow props', () => {
  it('reads old records as no shadows and drops unreadable shadows', () => {
    expect(shadowsOf({})).toEqual([])
    expect(shadowsOf({ shadows: 'x' })).toEqual([])
    expect(shadowsOf({ shadows: [drop(), { type: 'glow', color: '#000' }, null, { type: 'inner' }] })).toEqual([drop()])
    expect(toShadow({ type: 'inner', color: '#ff0000', blur: -3, opacity: 3, x: Number.NaN, visible: true })).toEqual({
      type: 'inner', x: 0, y: 0, blur: 0, spread: 0, color: '#ff0000', opacity: 1,
    })
    expect(toShadow({ ...drop(), visible: false })?.visible).toBe(false)
  })

  it('reaches out per side by offset, blur and spread (drop shadows only)', () => {
    expect(shadowOutset([drop({ x: 10, y: -4, blur: 4, spread: 2 })])).toEqual({ left: 0, top: 12, right: 18, bottom: 4 })
    expect(shadowOutset([drop({ type: 'inner', y: 20, blur: 10 }), drop({ visible: false, blur: 50 }), drop({ opacity: 0, blur: 50 })])).toEqual({ left: 0, top: 0, right: 0, bottom: 0 })
    expect(shadowColors([drop({ color: '#123456' }), drop({ color: '#abcdef', visible: false })])).toEqual(['#123456'])
  })

  it('combines with the outside stroke in renderOutset, and adds the colors to the used colors', () => {
    const node = geo({ strokeWidth: 4, strokeAlign: 'outside', shadows: [drop({ x: 0, y: 10, blur: 0 })] })
    expect(geoType.renderOutset!(node)).toEqual({ left: 4, top: 4, right: 4, bottom: 10 })
    expect(geoType.renderOutset!(geo({ strokeWidth: 4, strokeAlign: 'outside' }))).toBe(4)
    expect(geoType.colors!(geo({ fill: solidPaint('#ffffff'), stroke: null, shadows: [drop({ color: '#00ff00' })] }))).toEqual(['#ffffff', '#00ff00'])
  })

  it('skips shadows that are too small on screen', () => {
    expect(shouldDrawShadow(drop(), { zoom: 1, screenSize: 100 })).toBe(true)
    expect(shouldDrawShadow(drop(), { zoom: 1, screenSize: 6 })).toBe(false)
    expect(shouldDrawShadow(drop({ x: 0, y: 0.2, blur: 0.2 }), { zoom: 1 })).toBe(false)
    expect(shouldDrawShadow(drop({ visible: false }), { zoom: 1 })).toBe(false)
  })
})

// Path2D と Canvas の呼び出しを記録する
class FakePath2D {
  ops: string[] = []
  rect(x: number, y: number, w: number, h: number) {
    this.ops.push(`rect ${x},${y},${w},${h}`)
  }
  moveTo() {
    this.ops.push('moveTo')
  }
  lineTo() {}
  arc() {
    this.ops.push('arc')
  }
  ellipse(_x: number, _y: number, rx: number, ry: number) {
    this.ops.push(`ellipse ${rx},${ry}`)
  }
  closePath() {}
  addPath() {
    this.ops.push('addPath')
  }
}

function recordingContext(transform = { a: 2, b: 0, c: 0, d: 2, e: 10, f: 20 }) {
  const fills: { path: string[]; rule: string; shadow: Record<string, unknown>; alpha: number; transform: number[]; clip: string[]; clipRule: string }[] = []
  let clip: { path: string[]; rule: string } = { path: [], rule: '' }
  let matrix = { ...transform }
  const ctx = {
    globalAlpha: 1,
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    fillStyle: '',
    getTransform: () => ({ ...matrix }),
    setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => (matrix = { a, b, c, d, e, f }),
    save() {},
    restore() {
      matrix = { ...transform }
      ctx.globalAlpha = 1
    },
    clip: (path: FakePath2D, rule = 'nonzero') => (clip = { path: path.ops, rule }),
    fill(path: FakePath2D, rule = 'nonzero') {
      fills.push({
        path: path.ops,
        rule,
        shadow: { color: ctx.shadowColor, blur: ctx.shadowBlur, x: ctx.shadowOffsetX, y: ctx.shadowOffsetY },
        alpha: ctx.globalAlpha,
        transform: Object.values(matrix),
        clip: clip.path,
        clipRule: clip.rule,
      })
    },
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, fills }
}

describe('drawShadows', () => {
  const original = (globalThis as { Path2D?: unknown }).Path2D
  beforeEach(() => {
    ;(globalThis as { Path2D?: unknown }).Path2D = FakePath2D
  })
  afterEach(() => {
    ;(globalThis as { Path2D?: unknown }).Path2D = original
  })
  const box = { x: 0, y: 0, w: 100, h: 50 }
  const rect = { kind: 'rect' as const, box, radii: [0, 0, 0, 0] as [number, number, number, number] }

  it('draws a drop shadow of the spread shape moved off screen, converting blur and offset to device pixels', () => {
    const { ctx, fills } = recordingContext()
    drawShadows(ctx, [drop({ x: 3, y: 4, blur: 5, spread: 2, color: '#ff0000', opacity: 0.5 })], 'drop', rect, { zoom: 2 })
    expect(fills).toHaveLength(1)
    const [fill] = fills
    // 広げた形（2 だけ外へ）
    expect(fill.path).toEqual(['rect -2,-2,104,54'])
    // 形の外で切り抜く（形の中に影を描かない）
    expect(fill.clipRule).toBe('evenodd')
    expect(fill.clip[1]).toBe('rect 0,0,100,50')
    // 形の右端（デバイスの x = 10 + 102 × 2 = 214）より左へずらし、影だけを戻す
    const shift = 215
    expect(fill.transform).toEqual([2, 0, 0, 2, 10 - shift, 20])
    expect(fill.shadow).toEqual({ color: '#ff0000', blur: 10, x: shift + 6, y: 8 })
    expect(fill.alpha).toBe(0.5)
  })

  it('rotates the offset with the node', () => {
    // 90 度回転：ローカルの +x はデバイスの +y
    const { ctx, fills } = recordingContext({ a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 })
    drawShadows(ctx, [drop({ x: 5, y: 0, blur: 2 })], 'drop', rect, { zoom: 1 })
    const shift = fills[0].transform[4] === 0 ? 0 : -fills[0].transform[4]
    expect(fills[0].shadow).toMatchObject({ x: shift, y: 5, blur: 2 })
  })

  it('draws an inner shadow inside the shape, from a large rect with a shrunk hole', () => {
    const { ctx, fills } = recordingContext({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })
    const shadows = [drop({ blur: 4 }), drop({ type: 'inner', x: 0, y: 2, blur: 4, spread: 3 })]
    drawShadows(ctx, shadows, 'inner', { kind: 'ellipse', box }, { zoom: 1 })
    expect(fills).toHaveLength(1)
    expect(fills[0].rule).toBe('evenodd')
    expect(fills[0].clipRule).toBe('nonzero')
    expect(fills[0].clip).toEqual(['moveTo', 'ellipse 50,25'])
    expect(fills[0].path.slice(1)).toEqual(['moveTo', 'ellipse 47,22'])
  })

  it('skips hidden shadows, other types, small nodes and shadows that vanish by a negative spread', () => {
    const { ctx, fills } = recordingContext()
    drawShadows(ctx, [drop({ visible: false }), drop({ type: 'inner' })], 'drop', rect, { zoom: 1 })
    drawShadows(ctx, [drop()], 'drop', rect, { zoom: 1, screenSize: 4 })
    drawShadows(ctx, [drop({ spread: -30 })], 'drop', rect, { zoom: 1 })
    expect(fills).toHaveLength(0)
  })
})
