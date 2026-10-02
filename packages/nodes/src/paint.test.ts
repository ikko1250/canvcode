import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import { upgradeNode } from './defineNodeType.ts'
import { GEO_DEFAULT_FILL, geoType, type GeoProps } from './geo.ts'
import {
  colorAtPosition,
  colorWithAlpha,
  convertPaint,
  fillPreviewColor,
  fillShape,
  gradientAngle,
  gradientStop,
  linearGradient,
  normalizeColor,
  paintColors,
  paintCss,
  parseHexColor,
  radialGradient,
  solidPaint,
  toFill,
  withGradientAngle,
} from './paint.ts'

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

// グラデーション（MAI-82）
describe('gradient paint', () => {
  const stops = [gradientStop(1, '#0000ff', 0.5), gradientStop(0, '#ff0000')]

  // 作ったグラデーションと、塗るときの座標を記録する Canvas
  function gradientContext() {
    const made: { kind: string; args: number[]; stops: [number, string][] }[] = []
    const fills: { style: unknown; transform: number[] }[] = []
    let transform = [1, 0, 0, 1, 0, 0]
    const stack: number[][] = []
    const gradient = (kind: string, args: number[]) => {
      const entry = { kind, args, stops: [] as [number, string][] }
      made.push(entry)
      return { addColorStop: (offset: number, color: string) => entry.stops.push([offset, color]) }
    }
    const ctx = {
      fillStyle: '#000000' as unknown,
      globalAlpha: 1,
      save: () => stack.push(transform),
      restore: () => (transform = stack.pop()!),
      transform: (...m: number[]) => (transform = m),
      createLinearGradient: (...args: number[]) => gradient('linear', args),
      createRadialGradient: (...args: number[]) => gradient('radial', args),
      fill: () => fills.push({ style: ctx.fillStyle, transform }),
    }
    return { ctx: ctx as unknown as CanvasRenderingContext2D, made, fills }
  }

  it('reads gradients, sorting the stops and clamping the values', () => {
    const linear = toFill({ type: 'linear', start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, stops: [{ position: 2, color: '#000000' }, { position: -1, color: '#ffffff', opacity: 5 }], opacity: 0.5 })
    expect(linear).toEqual({ type: 'linear', start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, stops: [gradientStop(0, '#ffffff', 1), gradientStop(1, '#000000', 1)], opacity: 0.5 })
    expect(toFill({ type: 'radial', center: { x: 0.5, y: 0.5 }, radius: -1, stops })).toEqual({ type: 'radial', center: { x: 0.5, y: 0.5 }, radius: 0, stops: [stops[1], stops[0]], opacity: 1 })
    // 止め色が 1 つしかない・位置がないものは読めない
    expect(toFill({ type: 'linear', start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, stops: [stops[0]] }, null)).toBeNull()
    expect(toFill({ type: 'radial', center: { x: 0.5 }, radius: 1, stops }, null)).toBeNull()
  })

  it('paints a linear gradient in the box with each stop opacity', () => {
    const { ctx, made, fills } = gradientContext()
    fillShape(ctx, linearGradient(stops, { start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 } }), { x: 10, y: 20, w: 200, h: 100 })
    expect(made).toEqual([{ kind: 'linear', args: [10, 70, 210, 70], stops: [[0, '#ff0000'], [1, 'rgba(0, 0, 255, 0.5)']] }])
    expect(fills[0].transform).toEqual([1, 0, 0, 1, 0, 0])
  })

  it('paints a radial gradient in the unit box so that it becomes an ellipse in a wide box', () => {
    const { ctx, made, fills } = gradientContext()
    fillShape(ctx, radialGradient(stops, { center: { x: 0.25, y: 0.5 }, radius: 0.5 }), { x: 0, y: 0, w: 200, h: 100 })
    expect(made[0]).toMatchObject({ kind: 'radial', args: [0.25, 0.5, 0, 0.25, 0.5, 0.5] })
    expect(fills[0].transform).toEqual([200, 0, 0, 100, 0, 0])
    // 幅のない箱には塗らない
    fillShape(ctx, radialGradient(stops), { x: 0, y: 0, w: 0, h: 100 })
    expect(fills).toHaveLength(1)
  })

  it('converts between paint types starting from the current color', () => {
    const linear = convertPaint(solidPaint('#336699', 0.8), 'linear', '#ffffff') as ReturnType<typeof linearGradient>
    expect(linear).toEqual(linearGradient([gradientStop(0, '#336699', 1), gradientStop(1, '#336699', 0)], { opacity: 0.8 }))
    const radial = convertPaint(linear, 'radial', '#ffffff')
    expect(radial).toEqual(radialGradient(linear.stops, { opacity: 0.8 }))
    expect(convertPaint(radial, 'solid', '#ffffff')).toEqual(solidPaint('#336699', 0.8))
    expect(convertPaint(null, 'linear', '#e8eefc').type).toBe('linear')
    expect(convertPaint(linear, 'linear', '#ffffff')).toBe(linear)
  })

  it('measures and sets the angle in the real size of the box', () => {
    const paint = linearGradient(stops)
    expect(gradientAngle(paint, { w: 200, h: 100 })).toBe(90)
    const right = withGradientAngle(paint, 0, { w: 200, h: 100 })
    expect(right.start).toEqual({ x: 0, y: 0.5 })
    expect(right.end).toEqual({ x: 1, y: 0.5 })
    const diagonal = withGradientAngle(paint, 45, { w: 200, h: 100 })
    expect(gradientAngle(diagonal, { w: 200, h: 100 })).toBeCloseTo(45, 3)
    // 大きさを変えると、箱と一緒に伸びる（同じ割合のまま、角度は箱の形で変わる）
    expect(gradientAngle(diagonal, { w: 100, h: 100 })).toBeCloseTo(63.435, 2)
    expect(gradientAngle(withGradientAngle(paint, -90, { w: 10, h: 10 }), { w: 10, h: 10 })).toBe(270)
  })

  it('mixes the colors between stops, and lists them', () => {
    expect(colorAtPosition(stops, 0.5)).toEqual({ color: '#800080', opacity: 0.75 })
    expect(colorAtPosition(stops, -1)).toEqual({ color: '#ff0000', opacity: 1 })
    expect(paintColors(linearGradient(stops))).toEqual(['#ff0000', '#0000ff'])
    // 簡略描画の 1 色は、止め色の平均
    expect(fillPreviewColor(linearGradient([gradientStop(0, '#ff0000'), gradientStop(1, '#0000ff')]))).toBe('#800080')
    expect(fillPreviewColor(linearGradient(stops, { opacity: 0.5 }))).toBe('rgba(128, 0, 128, 0.375)')
  })

  it('makes CSS backgrounds for the swatch', () => {
    expect(paintCss(linearGradient(stops))).toBe('linear-gradient(180deg, #ff0000 0%, rgba(0, 0, 255, 0.5) 100%)')
    expect(paintCss(radialGradient(stops))).toBe('radial-gradient(50% 50% at 50% 50%, #ff0000 0%, rgba(0, 0, 255, 0.5) 100%)')
    expect(paintCss(solidPaint('#ff0000'))).toBe('#ff0000')
    expect(paintCss(null)).toBeNull()
  })

  it('renders a gradient geo and keeps its colors', () => {
    const fill = linearGradient(stops)
    expect(geoType.colors!(geo({ fill, stroke: '#00ff00' }))).toEqual(['#ff0000', '#0000ff', '#00ff00'])
    expect(geoType.roughColor!(geo({ fill }))).toBe('rgba(128, 0, 128, 0.75)')
  })
})
