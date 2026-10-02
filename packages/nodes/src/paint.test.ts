import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import { upgradeNode } from './defineNodeType.ts'
import { GEO_DEFAULT_FILL, geoType, type GeoProps } from './geo.ts'
import { colorWithAlpha, fillPreviewColor, fillShape, normalizeColor, paintColors, parseHexColor, solidPaint, toFill } from './paint.ts'

// 塗り（MAI-81）

function geo(props: Partial<GeoProps> & Record<string, unknown>, version = 2): NodeRecord<GeoProps> {
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
    props: { ...geoType.defaultProps(), ...props } as GeoProps,
    meta: {},
  }
}

// fill() のときの fillStyle と globalAlpha を記録する、最小限の Canvas
function fakeContext() {
  const fills: { style: unknown; alpha: number }[] = []
  const stack: { fillStyle: unknown; globalAlpha: number }[] = []
  const ctx = {
    fillStyle: '#000000' as unknown,
    globalAlpha: 1,
    save() {
      stack.push({ fillStyle: ctx.fillStyle, globalAlpha: ctx.globalAlpha })
    },
    restore() {
      Object.assign(ctx, stack.pop())
    },
    fill() {
      fills.push({ style: ctx.fillStyle, alpha: ctx.globalAlpha })
    },
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, fills, raw: ctx }
}

describe('paint', () => {
  it('reads old color strings and paints', () => {
    expect(toFill('#ff0000')).toEqual({ type: 'solid', color: '#ff0000', opacity: 1 })
    expect(toFill('transparent')).toBeNull()
    expect(toFill('')).toBeNull()
    expect(toFill(null)).toBeNull()
    expect(toFill({ type: 'solid', color: '#00ff00', opacity: 3 })).toEqual(solidPaint('#00ff00', 1))
    expect(toFill({ type: 'solid', color: '#00ff00' })).toEqual(solidPaint('#00ff00'))
    // 知らない種類は fallback
    expect(toFill({ type: 'hologram' }, solidPaint('#111111'))).toEqual(solidPaint('#111111'))
  })

  it('fills the current path with the paint opacity on top of the node opacity', () => {
    const { ctx, fills, raw } = fakeContext()
    raw.globalAlpha = 0.5
    fillShape(ctx, solidPaint('#336699', 0.4), { x: 0, y: 0, w: 10, h: 10 })
    expect(fills).toEqual([{ style: '#336699', alpha: 0.2 }])
    // 元に戻す
    expect(raw.globalAlpha).toBe(0.5)
    fillShape(ctx, null, { x: 0, y: 0, w: 10, h: 10 })
    fillShape(ctx, solidPaint('#336699', 0), { x: 0, y: 0, w: 10, h: 10 })
    expect(fills).toHaveLength(1)
  })

  it('makes preview colors and lists the colors of a fill', () => {
    expect(fillPreviewColor(solidPaint('#ff0000'))).toBe('#ff0000')
    expect(fillPreviewColor(solidPaint('#ff0000', 0.5))).toBe('rgba(255, 0, 0, 0.5)')
    expect(fillPreviewColor(null)).toBeNull()
    expect(paintColors(solidPaint('#abcdef'))).toEqual(['#abcdef'])
    expect(paintColors(null)).toEqual([])
  })

  it('parses and normalizes hex colors', () => {
    expect(parseHexColor('#ABC')).toEqual({ r: 170, g: 187, b: 204, a: 1 })
    expect(parseHexColor('#ff000080')?.a).toBeCloseTo(0.502, 3)
    expect(parseHexColor('red')).toBeNull()
    expect(normalizeColor('#ABC')).toBe('#aabbcc')
    expect(normalizeColor(' red ')).toBe('red')
    expect(colorWithAlpha('red', 0.5)).toBe('red')
    expect(colorWithAlpha('#000000', 1)).toBe('#000000')
  })
})

describe('geo fill (version 2)', () => {
  it('migrates the version 1 color string to a solid paint', () => {
    const old = geo({ fill: '#ffc9c9' as never }, 1)
    const upgraded = upgradeNode(geoType, old) as NodeRecord<GeoProps>
    expect(upgraded.version).toBe(2)
    expect(upgraded.props.fill).toEqual(solidPaint('#ffc9c9'))
    // 版 1 で fill を持たないものは既定の色
    const { fill: _, ...noFill } = geo({}, 1).props
    expect((upgradeNode(geoType, { ...geo({}, 1), props: noFill as GeoProps }) as NodeRecord<GeoProps>).props.fill).toEqual(solidPaint(GEO_DEFAULT_FILL))
    // 今の版はそのまま
    const current = geo({ fill: null })
    expect(upgradeNode(geoType, current)).toBe(current)
  })

  it('renders the fill with its opacity and skips it when there is no fill', () => {
    const { ctx, fills } = fakeContext()
    const calls: string[] = []
    const full = Object.assign(ctx, {
      beginPath: () => calls.push('beginPath'),
      rect: () => calls.push('rect'),
      ellipse: () => calls.push('ellipse'),
      stroke: () => calls.push('stroke'),
      lineWidth: 0,
      strokeStyle: '',
    })
    geoType.render(full, geo({ fill: solidPaint('#ff0000', 0.25) }), { zoom: 1, devicePixelRatio: 1, detail: 'full' })
    expect(fills).toEqual([{ style: '#ff0000', alpha: 0.25 }])
    geoType.render(full, geo({ shape: 'ellipse', fill: null }), { zoom: 1, devicePixelRatio: 1, detail: 'full' })
    expect(fills).toHaveLength(1)
    expect(calls.filter((c) => c === 'stroke')).toHaveLength(2)
    // 移す前の色の文字列でも描ける
    geoType.render(full, geo({ fill: '#00ff00' as never }), { zoom: 1, devicePixelRatio: 1, detail: 'full' })
    expect(fills[1]).toEqual({ style: '#00ff00', alpha: 1 })
  })

  it('hits a filled shape inside, and a shape without fill only on its outline and label', () => {
    const filled = geo({ w: 100, h: 100, strokeWidth: 2 })
    expect(geoType.hitTest(filled, { x: 50, y: 50 }, 0, 1)).toBe(true)
    const hollow = geo({ w: 100, h: 100, strokeWidth: 2, fill: null })
    expect(geoType.hitTest(hollow, { x: 50, y: 50 }, 0, 1)).toBe(false)
    expect(geoType.hitTest(hollow, { x: 0.5, y: 50 }, 0, 1)).toBe(true)
    expect(geoType.hitTest(hollow, { x: 3.5, y: 50 }, 3, 1)).toBe(true)
    expect(geoType.hitTest(hollow, { x: 4.5, y: 50 }, 3, 1)).toBe(false)
    expect(geoType.hitTest(hollow, { x: -3, y: 50 }, 3, 1)).toBe(true)
    // 文字があれば、文字の箱にも当たる
    expect(geoType.hitTest({ ...hollow, props: { ...hollow.props, label: 'a' } }, { x: 50, y: 50 }, 0, 1)).toBe(true)
    // 楕円
    const ellipse = geo({ shape: 'ellipse', w: 100, h: 100, strokeWidth: 2, fill: null })
    expect(geoType.hitTest(ellipse, { x: 50, y: 50 }, 0, 1)).toBe(false)
    expect(geoType.hitTest(ellipse, { x: 50, y: 0.5 }, 0, 1)).toBe(true)
    expect(geoType.hitTest(ellipse, { x: 2, y: 2 }, 0, 1)).toBe(false)
    // 線も文字もない（何も見えない）ときは、見失わないよう中にも当たる
    const invisible = geo({ w: 100, h: 100, strokeWidth: 0, fill: null })
    expect(geoType.hitTest(invisible, { x: 50, y: 50 }, 0, 1)).toBe(true)
  })

  it('lists its colors and uses the stroke for the rough color when there is no fill', () => {
    expect(geoType.colors!(geo({ fill: solidPaint('#ff0000'), stroke: '#0000ff' }))).toEqual(['#ff0000', '#0000ff'])
    expect(geoType.colors!(geo({ fill: null, stroke: '#0000ff', strokeWidth: 0 }))).toEqual([])
    expect(geoType.roughColor!(geo({ fill: solidPaint('#ff0000', 0.5) }))).toBe('rgba(255, 0, 0, 0.5)')
    expect(geoType.roughColor!(geo({ fill: null, stroke: '#0000ff' }))).toBe('rgba(0, 0, 255, 0.35)')
  })
})
