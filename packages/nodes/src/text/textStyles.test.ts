import { describe, expect, it } from 'vitest'
import { geoLabelStyle, type GeoProps } from '../geo.ts'
import { richTextFromPlain, type TextParagraph } from './richText.ts'
import { richTextTargetOfType } from './richTextTargets.ts'
import { TEXT_STYLE_MONO_FONT, TEXT_STYLE_NAMES, TEXT_STYLE_PRESETS, applyTextStyle, textStyleOf, textStylePreset } from './textStyles.ts'

// DADS のテキストスタイル（MAI-114）

describe('DADS text styles', () => {
  it('lists every style of the DADS text style list, N and B for each size', () => {
    expect(TEXT_STYLE_PRESETS).toHaveLength(54)
    expect(new Set(TEXT_STYLE_NAMES).size).toBe(54)
    const names = (kind: string) => TEXT_STYLE_PRESETS.filter((preset) => preset.kind === kind).map((preset) => preset.name)
    expect(names('Dsp')).toEqual(['Dsp-64N-140', 'Dsp-64B-140', 'Dsp-57N-140', 'Dsp-57B-140', 'Dsp-48N-140', 'Dsp-48B-140'])
    expect(names('Std')).toHaveLength(24)
    expect(names('Std').slice(-4)).toEqual(['Std-16N-170', 'Std-16B-170', 'Std-16N-175', 'Std-16B-175'])
    expect(names('Dns')).toHaveLength(12)
    expect(names('Oln')).toEqual(['Oln-17N-100', 'Oln-17B-100', 'Oln-16N-100', 'Oln-16B-100', 'Oln-14N-100', 'Oln-14B-100'])
    expect(names('Mono')).toHaveLength(6)
    // 名前の大きさ・太さ・行間と、値が合う
    for (const preset of TEXT_STYLE_PRESETS) {
      const match = /^(Dsp|Std|Dns|Oln|Mono)-(\d+)([NB])-(\d+)$/.exec(preset.name)!
      expect(match[1]).toBe(preset.kind)
      expect(Number(match[2])).toBe(preset.fontSize)
      expect(match[3] === 'B' ? 700 : 400).toBe(preset.fontWeight)
      expect(Number(match[4]) / 100).toBe(preset.lineHeight)
    }
  })

  it('has the letter spacing of each kind and size (Std: 0, 1 % or 2 % by size)', () => {
    const spacing = (name: string) => textStylePreset(name)?.letterSpacing
    expect(spacing('Dsp-64B-140')).toBe(0)
    expect(spacing('Std-45N-140')).toBe(0)
    expect(spacing('Std-36N-140')).toBe(0.01)
    expect(spacing('Std-28B-150')).toBe(0.01)
    expect(spacing('Std-26N-150')).toBe(0.02)
    expect(spacing('Std-17N-170')).toBe(0.02)
    expect(spacing('Std-16B-175')).toBe(0.02)
    expect(spacing('Dns-14N-120')).toBe(0)
    expect(spacing('Oln-16B-100')).toBe(0.02)
    expect(spacing('Mono-16N-150')).toBe(0)
    expect(textStylePreset('Std-17N-171')).toBeUndefined()
    // フォントを決めるのは Mono だけ
    expect(TEXT_STYLE_PRESETS.filter((p) => p.fontFamily !== undefined).map((p) => p.kind)).toEqual(Array(6).fill('Mono'))
    expect(textStylePreset('Mono-14B-150')?.fontFamily).toBe(TEXT_STYLE_MONO_FONT)
  })

  it('finds the style of the values, or none', () => {
    const values = { fontSize: 17, fontWeight: 400, fontFamily: 'sans-serif', lineHeight: { unit: 'multiplier' as const, value: 1.7 }, letterSpacing: 0.02 }
    expect(textStyleOf(values)?.name).toBe('Std-17N-170')
    expect(textStyleOf({ ...values, fontWeight: 700 })?.name).toBe('Std-17B-170')
    // パネルの % の換算で出る小さな誤差は同じとみなす
    expect(textStyleOf({ ...values, letterSpacing: 0.020000001 })?.name).toBe('Std-17N-170')
    // ほかのフォントでも同じスタイル
    expect(textStyleOf({ ...values, fontFamily: 'BIZ UDPGothic' })?.name).toBe('Std-17N-170')
    expect(textStyleOf({ ...values, fontWeight: 500 })).toBeUndefined()
    expect(textStyleOf({ ...values, letterSpacing: 0 })).toBeUndefined()
    // px の行間は、どのスタイルでもない
    expect(textStyleOf({ ...values, lineHeight: { unit: 'px', value: 28.9 } })).toBeUndefined()
    // Mono は等幅のフォントのときだけ
    const mono = { fontSize: 16, fontWeight: 700, fontFamily: TEXT_STYLE_MONO_FONT, lineHeight: { unit: 'multiplier' as const, value: 1.5 }, letterSpacing: 0 }
    expect(textStyleOf(mono)?.name).toBe('Mono-16B-150')
    expect(textStyleOf({ ...mono, fontFamily: 'sans-serif' })).toBeUndefined()
  })

  it('applies a style to the whole node, clearing the per-range size and weight', () => {
    const target = richTextTargetOfType('text')!
    const paragraphs: TextParagraph[] = [{ runs: [{ text: 'ab', format: { fontSize: 30 } }, { text: 'cd', format: { fontWeight: 700, color: '#ff0000' } }] }]
    const props = applyTextStyle(target, { paragraphs, fontSize: 16, fontFamily: 'Klee One' }, textStylePreset('Std-24B-150')!) as Record<string, unknown>
    expect(props).toMatchObject({ fontSize: 24, fontWeight: 700, lineHeight: { unit: 'multiplier', value: 1.5 }, letterSpacing: 0.02, fontFamily: 'Klee One' })
    // 色は残す
    expect(props.paragraphs).toEqual([{ runs: [{ text: 'ab' }, { text: 'cd', format: { color: '#ff0000' } }] }])

    // Mono はフォントも等幅にする
    const mono = applyTextStyle(target, props, textStylePreset('Mono-14N-150')!) as Record<string, unknown>
    expect(mono).toMatchObject({ fontSize: 14, fontWeight: 400, fontFamily: TEXT_STYLE_MONO_FONT, lineHeight: { unit: 'multiplier', value: 1.5 }, letterSpacing: 0 })
  })

  it('applies the size and weight to the selected range, and the line height and spacing to the node', () => {
    const target = richTextTargetOfType('note')!
    const props = applyTextStyle(target, { paragraphs: richTextFromPlain('abcd'), fontSize: 16 }, textStylePreset('Mono-17B-150')!, { start: 1, end: 3 }) as Record<string, unknown>
    expect(props).toMatchObject({ fontSize: 16, lineHeight: { unit: 'multiplier', value: 1.5 }, letterSpacing: 0 })
    expect(props.paragraphs).toEqual([{ runs: [{ text: 'a' }, { text: 'bc', format: { fontSize: 17, fontWeight: 700, fontFamily: TEXT_STYLE_MONO_FONT } }, { text: 'd' }] }])
  })

  it('writes the label props of a shape', () => {
    const target = richTextTargetOfType('geo')!
    const props = applyTextStyle(target, { shape: 'rect', w: 100, h: 100, label: 'ab' }, textStylePreset('Dns-14B-120')!) as GeoProps
    expect(props).toMatchObject({ label: 'ab', labelFontSize: 14, labelFontWeight: 700, labelLineHeight: { unit: 'multiplier', value: 1.2 }, labelLetterSpacing: 0 })
    expect(geoLabelStyle(props)).toMatchObject({ fontSize: 14, fontWeight: 700, lineHeight: 1.2, letterSpacing: 0 })
  })
})
