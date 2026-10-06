import { describe, expect, it } from 'vitest'
import { GEO_LABEL_DEFAULTS, geoLabelBox, geoLabelPadding, geoLabelParagraphs, geoLabelStyle, geoType, withGeoLabel } from './geo.ts'
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
})
