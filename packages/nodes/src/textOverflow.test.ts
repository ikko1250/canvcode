import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import { geoType, type GeoProps } from './geo.ts'
import { richTextFromPlain } from './text/richText.ts'
import { textType, type TextProps } from './text/textNode.ts'
import { textOverflow } from './textOverflow.ts'

// ノードの文字が箱からあふれるか（スライド v2）。
// Node には Canvas がないので、layout.ts の概算の文字幅（全角 = fontSize、半角 = 0.55 × fontSize）で測る。
// 図形の既定：120 × 120、余白 8 なので文字の箱は 104 × 104。文字は 18px、行の高さ 1.35（24.3px）。
// 全角なら 1 行に 5 文字（90px）入り、4 行（97.2px）まで収まる

const record = <P extends object>(type: string, props: P): NodeRecord<P> => ({
  typeName: 'node',
  id: `node:${type}`,
  type,
  parentId: 'canvas:1',
  x: 0,
  y: 0,
  rotation: 0,
  index: 'a1',
  opacity: 1,
  locked: false,
  meta: {},
  props,
})

const geo = (patch: Partial<GeoProps> = {}) => record('geo', { ...geoType.defaultProps(), ...patch })
const text = (value: string, patch: Partial<TextProps> = {}) =>
  record('text', { ...textType.defaultProps(), paragraphs: richTextFromPlain(value), ...patch })

describe('textOverflow of a shape', () => {
  it('does not overflow with a short label', () => {
    expect(textOverflow(geo({ label: 'hello' }))).toEqual({ overflows: false, contentHeight: expect.closeTo(24.3), availableHeight: 104 })
  })

  it('overflows when the wrapped label is taller than the box', () => {
    expect(textOverflow(geo({ label: 'あ'.repeat(20) }))).toMatchObject({ overflows: false, contentHeight: expect.closeTo(97.2) })
    expect(textOverflow(geo({ label: 'あ'.repeat(21) }))).toMatchObject({ overflows: true, contentHeight: expect.closeTo(121.5) })
  })

  it('moves the boundary with the line height', () => {
    const label = 'あ'.repeat(20)
    expect(textOverflow(geo({ label, labelLineHeight: { unit: 'multiplier', value: 1.6 } }))!.overflows).toBe(true)
    // 4 行 × 26px = 104px は、ちょうど収まる
    expect(textOverflow(geo({ label, labelLineHeight: { unit: 'px', value: 26 } }))!.overflows).toBe(false)
    expect(textOverflow(geo({ label, labelLineHeight: { unit: 'px', value: 27 } }))!.overflows).toBe(true)
  })

  it('moves the boundary with the font size and the letter spacing', () => {
    const label = 'あ'.repeat(20)
    // 20px なら 1 行に 5 文字のまま、行の高さが 27px になる（4 行で 108px）
    expect(textOverflow(geo({ label, labelFontSize: 20 }))!.overflows).toBe(true)
    expect(textOverflow(geo({ label, labelFontSize: 12 }))!.overflows).toBe(false)
    // 文字間 0.2em なら 1 文字 21.6px で、1 行に 4 文字（5 行になる）
    expect(textOverflow(geo({ label, labelLetterSpacing: 0.2 }))!.overflows).toBe(true)
  })

  it('counts the padding out of the box', () => {
    const label = 'あ'.repeat(20)
    // 文字の箱の高さは h − 16
    expect(textOverflow(geo({ label, h: 113.2 }))).toMatchObject({ overflows: false, availableHeight: expect.closeTo(97.2) })
    expect(textOverflow(geo({ label, h: 113 }))!.overflows).toBe(true)
    // 狭くすると折り返しが増える（幅 70 − 16 = 54 には 3 文字）
    expect(textOverflow(geo({ label: 'あ'.repeat(12), w: 70, h: 113.2 }))!.overflows).toBe(false)
    expect(textOverflow(geo({ label: 'あ'.repeat(13), w: 70, h: 113.2 }))!.overflows).toBe(true)
  })

  it('does not overflow with an empty label, even in a tiny box', () => {
    expect(textOverflow(geo({ label: '', h: 10 }))).toEqual({ overflows: false, contentHeight: 0, availableHeight: 1 })
  })
})

describe('textOverflow of a text', () => {
  // 幅 60、12px（行の高さ 16.2px）：全角なら 1 行に 5 文字
  const wrapped = (value: string) => text(value, { w: 60, autoWidth: false })

  it('has nothing to compare without a height limit, since its height follows the text', () => {
    expect(textOverflow(wrapped('あ'.repeat(10)))).toBeNull()
  })

  it('compares the wrapped height with the limit given by the caller', () => {
    expect(textOverflow(wrapped('あ'.repeat(10)), { maxHeight: 40 })).toEqual({ overflows: false, contentHeight: expect.closeTo(32.4), availableHeight: 40 })
    expect(textOverflow(wrapped('あ'.repeat(11)), { maxHeight: 40 })!.overflows).toBe(true)
  })

  it('does not overflow when empty', () => {
    expect(textOverflow(wrapped(''), { maxHeight: 5 })).toEqual({ overflows: false, contentHeight: 0, availableHeight: 5 })
  })
})

describe('textOverflow of other types', () => {
  it('returns null for nodes without text', () => {
    expect(textOverflow(record('image', { w: 100, h: 100 }), { maxHeight: 10 })).toBeNull()
  })
})
