import { describe, expect, it } from 'vitest'
import { GEO_LABEL_DEFAULTS, geoLabelParagraphs, geoLabelStyle, geoType, withGeoLabel } from './geo.ts'
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
