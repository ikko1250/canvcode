import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BUNDLED_FONTS,
  DEFAULT_FONT_FAMILY,
  FONT_PRESETS,
  TEXT_FONT_FAMILY,
  isBundledFontFamily,
  fontFamilyCss,
  fontFamilyFromCss,
  fontFamilyOf,
  fontsSettled,
  requestFontLoad,
  resetTextMetrics,
  textMetricsGeneration,
} from './fonts.ts'
import { baseFormatOf, cssFont, layoutRichText, runStyle, type TextStyle } from './layout.ts'
import { noteType } from './noteNode.ts'
import { textLayout, textStyle, textType, type TextProps } from './textNode.ts'

// フォント（MAI-75）

const style: TextStyle = { fontSize: 10, lineHeight: 1.5, fontWeight: 400, color: '#000', align: 'left' }

describe('font family', () => {
  it('reads a missing or broken value as the default font (old records)', () => {
    expect(fontFamilyOf(undefined)).toBe(DEFAULT_FONT_FAMILY)
    expect(fontFamilyOf('')).toBe(DEFAULT_FONT_FAMILY)
    expect(fontFamilyOf(3)).toBe(DEFAULT_FONT_FAMILY)
    expect(fontFamilyOf('M PLUS 1p')).toBe('M PLUS 1p')
  })

  it('draws the default font with the bundled Noto Sans JP first, then the fonts of the device', () => {
    const sans = `'Noto Sans JP Variable', ${TEXT_FONT_FAMILY}`
    expect(fontFamilyCss(undefined)).toBe(sans)
    expect(fontFamilyCss('sans-serif')).toBe(sans)
    expect(cssFont(style)).toBe(`400 10px ${sans}`)
    expect(fontFamilyCss('serif')).toMatch(/^'Noto Serif JP Variable', /)
  })

  it('draws a bundled font by the name of its @font-face, and lists all the bundled fonts', () => {
    expect(fontFamilyCss('Noto Sans JP')).toMatch(/^"Noto Sans JP Variable", 'Noto Sans JP Variable', /)
    expect(fontFamilyFromCss(fontFamilyCss('Noto Serif JP'))).toBe('Noto Serif JP')
    expect(fontFamilyFromCss(fontFamilyCss('M PLUS 1 Code'))).toBe('M PLUS 1 Code')
    expect(isBundledFontFamily('Klee One')).toBe(true)
    expect(isBundledFontFamily('Hiragino Sans')).toBe(false)
    expect(FONT_PRESETS.filter((font) => font.category === 'bundled').map((font) => font.family)).toEqual(BUNDLED_FONTS.map((font) => font.family))
  })

  it('falls back to the default font after a named font, and maps the CSS back to the name', () => {
    // 端末にないフォントの代わりも、同梱の Noto Sans JP（どの端末でも同じ）
    expect(fontFamilyCss('M PLUS 1p')).toBe(`"M PLUS 1p", 'Noto Sans JP Variable', ${TEXT_FONT_FAMILY}`)
    expect(fontFamilyCss('bad"name')).toBe(`"badname", 'Noto Sans JP Variable', ${TEXT_FONT_FAMILY}`)
    for (const family of ['sans-serif', 'serif', 'monospace', 'M PLUS 1p', 'Yu Mincho']) {
      expect(fontFamilyFromCss(fontFamilyCss(family))).toBe(family)
    }
    // ブラウザは引用符を変えて返すことがある
    expect(fontFamilyFromCss(`'M PLUS 1p', sans-serif`)).toBe('M PLUS 1p')
    expect(fontFamilyFromCss('')).toBeUndefined()
  })

  it('applies the font of a run over the default of the node', () => {
    expect(runStyle({ ...style, fontFamily: 'serif' }, { color: '#f00' }).fontFamily).toBe('serif')
    expect(runStyle(style, { fontFamily: 'M PLUS 1p' }).fontFamily).toBe('M PLUS 1p')
    expect(baseFormatOf(style)).toEqual({ color: '#000', fontSize: 10, fontFamily: DEFAULT_FONT_FAMILY, fontWeight: 400, bold: false, italic: false, underline: false, strikethrough: false })
  })

  it('splits segments where the font changes', () => {
    const layout = layoutRichText([{ runs: [{ text: 'ab' }, { text: 'cd', format: { fontFamily: 'serif' } }] }], style, null)
    expect(layout.lines[0].segments.map((s) => [s.text, s.style.fontFamily])).toEqual([
      ['ab', undefined],
      ['cd', 'serif'],
    ])
  })

  it('gives new text and notes the default font and reads it into the style', () => {
    expect((textType.defaultProps() as TextProps).fontFamily).toBe(DEFAULT_FONT_FAMILY)
    expect(noteType.defaultProps().fontFamily).toBe(DEFAULT_FONT_FAMILY)
    const { fontFamily: _, ...old } = textType.defaultProps()
    expect(textStyle(old as TextProps).fontFamily).toBe(DEFAULT_FONT_FAMILY)
  })
})

describe('font loading', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lays out again after the metrics are reset', () => {
    const props = textType.defaultProps()
    const first = textLayout(props)
    expect(textLayout(props)).toBe(first)
    const generation = textMetricsGeneration()
    resetTextMetrics()
    expect(textMetricsGeneration()).toBe(generation + 1)
    expect(textLayout(props)).not.toBe(first)
  })

  it('asks the browser to load a web font that is not loaded yet, and reports it once loaded', async () => {
    let resolve!: (faces: unknown[]) => void
    const fonts = {
      check: vi.fn((font: string) => !font.includes('M PLUS')),
      load: vi.fn(() => new Promise<unknown[]>((r) => (resolve = r))),
    }
    vi.stubGlobal('document', { fonts })
    // 等幅（Web フォントを持たない）は頼まない
    requestFontLoad('monospace', `400 10px ${fontFamilyCss('monospace')}`, 'abc')
    expect(fonts.check).not.toHaveBeenCalled()
    const font = `400 10px ${fontFamilyCss('M PLUS 1p')}`
    requestFontLoad('M PLUS 1p', font, 'あいう')
    expect(fonts.load).toHaveBeenCalledWith(font, 'あいう')
    const settled = fontsSettled()
    resolve([{}])
    expect(await settled).toBe(true)
    resetTextMetrics()
    expect(await fontsSettled()).toBe(false)
  })
})
