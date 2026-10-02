import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_FONT_FAMILY,
  TEXT_FONT_FAMILY,
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

  it('draws the default font with the same CSS as before', () => {
    expect(fontFamilyCss(undefined)).toBe(TEXT_FONT_FAMILY)
    expect(fontFamilyCss('sans-serif')).toBe(TEXT_FONT_FAMILY)
    expect(cssFont(style)).toBe(`400 10px ${TEXT_FONT_FAMILY}`)
  })

  it('falls back to the default font after a named font, and maps the CSS back to the name', () => {
    expect(fontFamilyCss('M PLUS 1p')).toBe(`"M PLUS 1p", ${TEXT_FONT_FAMILY}`)
    expect(fontFamilyCss('bad"name')).toBe(`"badname", ${TEXT_FONT_FAMILY}`)
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
    expect(baseFormatOf(style)).toEqual({ color: '#000', fontSize: 10, fontFamily: DEFAULT_FONT_FAMILY, bold: false, italic: false, underline: false, strikethrough: false })
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
    // 既定（generic）のフォントは頼まない
    requestFontLoad('sans-serif', `400 10px ${TEXT_FONT_FAMILY}`, 'abc')
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
