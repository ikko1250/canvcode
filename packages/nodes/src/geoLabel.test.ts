import { describe, expect, it } from 'vitest'
import { GEO_LABEL_DEFAULTS, geoLabelBox, geoLabelLayout, geoLabelPadding, geoLabelParagraphs, geoLabelStyle, geoLabelVerticalAlign, geoType, toGeoLabelPadding, withGeoLabel, type GeoProps } from './geo.ts'
import { textOverflow } from './textOverflow.ts'
import { applyRunFormat, plainTextOf, richTextFromPlain } from './text/richText.ts'

// 図形の中の文字：テキスト・付箋と同じく段落と run で持ち、label にはプレーンテキストをそろえて持つ
describe('geo label', () => {
  const props = { ...geoType.defaultProps(), label: 'hello' }

  it('reads old shapes (label only) as plain paragraphs with the default style', () => {
    expect(plainTextOf(geoLabelParagraphs(props))).toBe('hello')
    const style = geoLabelStyle(props)
    expect(style.fontSize).toBe(GEO_LABEL_DEFAULTS.fontSize)
    expect(style.align).toBe('center')
    expect(style.lineHeight).toBe(1.35)
  })

  it('keeps label in sync with the paragraphs', () => {
    const bold = applyRunFormat(richTextFromPlain('hi there'), 0, 2, { bold: true }, undefined)
    const next = withGeoLabel(props, bold)
    expect(next.label).toBe('hi there')
    expect(geoLabelParagraphs(next)).toBe(bold)
  })

  it('falls back to label when an older app changed only label', () => {
    const next = { ...withGeoLabel(props, richTextFromPlain('old')), label: 'new' }
    expect(plainTextOf(geoLabelParagraphs(next))).toBe('new')
  })

  it('edits as rich text', () => {
    const node = { id: 'node:g', type: 'geo', props } as Parameters<NonNullable<typeof geoType.editText>>[0]
    const spec = geoType.editText!(node)
    expect(spec.rich).toBeDefined()
    expect(spec.rich!.update(richTextFromPlain('x')).label).toBe('x')
  })
})

// 文字の余白（labelPadding。スライド v2 のテンプレートのセル）。持たない図形は今までどおり四方 8
describe('geo label padding', () => {
  const base = { ...geoType.defaultProps(), w: 200, h: 100, label: 'hello' }

  it('keeps the 8px padding for shapes without labelPadding', () => {
    expect(geoLabelBox(base)).toEqual({ x: 8, y: 8, w: 184, h: 84 })
    expect(geoLabelPadding(base)).toEqual({ top: 8, right: 8, bottom: 8, left: 8 })
    // 壊れた値も 8 として読む
    expect(geoLabelBox({ ...base, labelPadding: 'x' as unknown as number })).toEqual({ x: 8, y: 8, w: 184, h: 84 })
    expect(geoLabelBox({ ...base, labelPadding: { top: -1, right: 4, bottom: Number.NaN, left: 4 } })).toEqual({ x: 4, y: 8, w: 192, h: 84 })
  })

  it('uses labelPadding for the label box (a number for all sides, or each side)', () => {
    expect(geoLabelBox({ ...base, labelPadding: 0 })).toEqual({ x: 0, y: 0, w: 200, h: 100 })
    expect(geoLabelBox({ ...base, labelPadding: { top: 12, right: 38, bottom: 12, left: 38 } })).toEqual({ x: 38, y: 12, w: 124, h: 76 })
    // 箱より大きな余白でも、文字の箱は 1 より小さくならない
    expect(geoLabelBox({ ...base, labelPadding: 150 })).toMatchObject({ w: 1, h: 1 })
  })

  it('applies the padding to the editor box and the overflow check', () => {
    const props = { ...base, labelPadding: { top: 30, right: 8, bottom: 30, left: 8 } }
    const node = { id: 'node:g', type: 'geo', props } as Parameters<NonNullable<typeof geoType.editText>>[0]
    expect(geoType.editText!(node).box).toEqual({ x: 8, y: 30, w: 184, h: 40 })
    expect(textOverflow({ ...node, props } as never)!.availableHeight).toBe(40)
  })

  it('pads the text box of a block arrow on each side', () => {
    const arrow = { ...base, shape: 'blockArrow' as const }
    const plain = geoLabelBox(arrow)
    const padded = geoLabelBox({ ...arrow, labelPadding: { top: 8, right: 8, bottom: 8, left: 18 } })
    expect(padded).toEqual({ ...plain, x: plain.x + 10, w: plain.w - 10 })
  })

  it('keeps the padding as a number when the four sides are the same', () => {
    expect(toGeoLabelPadding({ top: 12, right: 12, bottom: 12, left: 12 })).toBe(12)
    expect(toGeoLabelPadding({ top: 12, right: 16, bottom: 12, left: 16 })).toEqual({ top: 12, right: 16, bottom: 12, left: 16 })
  })
})

// 文字の縦の揃え（labelVerticalAlign。MAI-115）。持たない図形は今までどおり上下の中央
describe('geo label vertical align', () => {
  const base: GeoProps = { ...geoType.defaultProps(), w: 200, h: 100, label: 'hello', fill: null, stroke: null, strokeWidth: 0 }
  const node = (props: GeoProps) => ({ id: 'node:g', type: 'geo', props }) as Parameters<NonNullable<typeof geoType.editText>>[0]

  // 描いた 1 行目のベースラインの y
  function drawnBaseline(props: GeoProps): number {
    const ys: number[] = []
    const ctx = {
      font: '',
      fillStyle: '',
      beginPath() {},
      rect() {},
      fillText(_text: string, _x: number, y: number) {
        ys.push(y)
      },
    }
    geoType.render(ctx as unknown as CanvasRenderingContext2D, node(props), { zoom: 1, devicePixelRatio: 1, detail: 'full' })
    return ys[0]
  }

  it('reads middle for shapes without labelVerticalAlign, and for unknown values', () => {
    expect(geoLabelVerticalAlign(base)).toBe('middle')
    expect(geoLabelVerticalAlign({ ...base, labelVerticalAlign: 'bottom' })).toBe('bottom')
    expect(geoLabelVerticalAlign({ ...base, labelVerticalAlign: 'baseline' as never })).toBe('middle')
  })

  it('draws the label at the top, the middle or the bottom of the padded box, and edits it with the same align', () => {
    const box = geoLabelBox(base)
    const layout = geoLabelLayout(base)
    const baseline = layout.lines[0].baseline
    expect(drawnBaseline(base)).toBeCloseTo(box.y + (box.h - layout.height) / 2 + baseline)
    expect(drawnBaseline({ ...base, labelVerticalAlign: 'top' })).toBeCloseTo(box.y + baseline)
    expect(drawnBaseline({ ...base, labelVerticalAlign: 'bottom' })).toBeCloseTo(box.y + box.h - layout.height + baseline)
    // 余白を変えれば、その内側で揃える（DADS の通知バナー：上 24・下 32）
    const banner = { ...base, labelVerticalAlign: 'bottom' as const, labelPadding: { top: 24, right: 24, bottom: 32, left: 24 } }
    expect(drawnBaseline(banner)).toBeCloseTo(100 - 32 - layout.height + baseline)
    expect(geoType.editText!(node(base)).verticalAlign).toBe('middle')
    expect(geoType.editText!(node(banner)).verticalAlign).toBe('bottom')
  })

  it('does not change whether the label overflows', () => {
    const long = { ...base, h: 40, label: 'あ'.repeat(30) }
    for (const labelVerticalAlign of ['top', 'middle', 'bottom'] as const) {
      expect(textOverflow({ ...node(long), props: { ...long, labelVerticalAlign } } as never)).toEqual(textOverflow(node(long) as never))
    }
    expect(textOverflow(node(long) as never)!.overflows).toBe(true)
  })
})
