import { describe, expect, it } from 'vitest'
import {
  TEXT_FONT_SIZES,
  breakUnits,
  convertLineHeight,
  cssLineHeight,
  layoutRichText,
  layoutText,
  lineHeightOf,
  lineHeightStyle,
  stepFontSize,
  type TextStyle,
} from './layout.ts'

// Node には Canvas がないので、概算の文字幅（全角 = fontSize、半角 = 0.55 × fontSize、空白 = 0.3 × fontSize）で測る
const style: TextStyle = { fontSize: 10, lineHeight: 1.5, fontWeight: 400, color: '#000', align: 'left' }

describe('breakUnits', () => {
  it('breaks Japanese per character and English per word', () => {
    expect(breakUnits('日本語 and English')).toEqual(['日', '本', '語 ', 'and ', 'English'])
  })

  it('keeps closing punctuation with the previous character and opening brackets with the next', () => {
    expect(breakUnits('これは「引用」です。')).toEqual(['こ', 'れ', 'は', '「引', '用」', 'で', 'す。'])
    // 小書きの仮名も行頭に来ない（CSS の line-break: strict と同じ。編集用の textarea もこれに合わせる）
    expect(breakUnits('ちょっと')).toEqual(['ちょっ', 'と'])
  })
})

describe('layoutText', () => {
  it('keeps each paragraph on one line when not wrapping', () => {
    const layout = layoutText('一行目\n二行目の文', style, null)
    expect(layout.lines.map((l) => l.text)).toEqual(['一行目', '二行目の文'])
    expect(layout.width).toBe(50)
    expect(layout.height).toBe(30)
  })

  it('wraps Japanese at the character that no longer fits', () => {
    // 1 行に 4 文字（幅 40）まで
    const layout = layoutText('あいうえおかきくけこ', style, 40)
    expect(layout.lines.map((l) => l.text)).toEqual(['あいうえ', 'おかきく', 'けこ'])
  })

  it('does not start a line with a closing punctuation mark', () => {
    const layout = layoutText('あいうえ。お', style, 40)
    // 「。」は「え」とくっつくので、「え。」ごと次の行に送られる
    expect(layout.lines.map((l) => l.text)).toEqual(['あいう', 'え。お'])
  })

  it('wraps English at spaces and drops trailing spaces from the line width', () => {
    // "hello " の幅は 5×5.5 + 3 = 30.5、"hello" は 27.5
    const layout = layoutText('hello world', style, 40)
    expect(layout.lines.map((l) => l.text)).toEqual(['hello', 'world'])
    expect(layout.lines[0].width).toBeCloseTo(27.5, 9)
  })

  it('breaks a word that is longer than the line', () => {
    const layout = layoutText('abcdefghij', style, 20)
    expect(layout.lines.map((l) => l.text)).toEqual(['abc', 'def', 'ghi', 'j'])
  })

  it('keeps empty lines', () => {
    const layout = layoutText('上\n\n下', style, 100)
    expect(layout.lines.map((l) => l.text)).toEqual(['上', '', '下'])
    expect(layout.height).toBe(45)
  })
})

describe('stepFontSize (MAI-50)', () => {
  it('moves one preset up or down', () => {
    expect(stepFontSize(24, 1)).toBe(32)
    expect(stepFontSize(24, -1)).toBe(22)
  })

  it('passes through the title size of 22 between 20 and 24 (MAI-62)', () => {
    expect(stepFontSize(20, 1)).toBe(22)
    expect(stepFontSize(22, 1)).toBe(24)
    expect(stepFontSize(22, -1)).toBe(20)
  })

  it('snaps sizes that are not presets to the nearest preset in that direction', () => {
    expect(stepFontSize(18, 1)).toBe(20)
    expect(stepFontSize(18, -1)).toBe(16)
  })

  it('stays at the ends', () => {
    const largest = TEXT_FONT_SIZES[TEXT_FONT_SIZES.length - 1]
    expect(stepFontSize(largest, 1)).toBe(largest)
    expect(stepFontSize(TEXT_FONT_SIZES[0], -1)).toBe(TEXT_FONT_SIZES[0])
    expect(stepFontSize(200, 1)).toBe(200)
  })
})

describe('layoutRichText (MAI-74)', () => {
  const red = { color: '#ff0000' }

  it('splits each line into segments per format', () => {
    const layout = layoutRichText([{ runs: [{ text: 'ab' }, { text: 'cd', format: { ...red, fontSize: 20 } }] }], style, null)
    const [line] = layout.lines
    expect(line.text).toBe('abcd')
    expect(line.segments.map((s) => [s.text, s.x, s.width, s.style.fontSize, s.style.color])).toEqual([
      ['ab', 0, 11, 10, '#000'],
      ['cd', 11, 22, 20, '#ff0000'],
    ])
    expect(line.width).toBe(33)
    // 行の高さは、行の中の最も大きい文字に合わせる
    expect(line.height).toBeCloseTo(30)
    expect(layout.maxFontSize).toBe(20)
  })

  it('wraps across runs and measures each line by its own characters', () => {
    // 1 行目は大きい文字（幅 20）が 2 つ、2 行目は小さい文字だけ
    const layout = layoutRichText(
      [{ runs: [{ text: 'あい', format: { fontSize: 20 } }, { text: 'うえおか' }] }],
      style,
      40,
    )
    expect(layout.lines.map((l) => l.text)).toEqual(['あい', 'うえおか'])
    expect(layout.lines[0].height).toBeCloseTo(30)
    expect(layout.lines[1].height).toBeCloseTo(15)
    expect(layout.lines[1].top).toBeCloseTo(30)
    expect(layout.height).toBeCloseTo(45)
  })

  it('keeps the height of an empty paragraph from its format', () => {
    const layout = layoutRichText([{ runs: [{ text: 'a' }] }, { runs: [{ text: '', format: { fontSize: 40 } }] }], style, null)
    expect(layout.lines.map((l) => l.height)).toEqual([15, 60])
  })

  it('lays out plain text exactly as before', () => {
    const layout = layoutText('上\n\n下', style, 100)
    expect(layout.lines.map((l) => [l.top, l.height])).toEqual([
      [0, 15],
      [15, 15],
      [30, 15],
    ])
    expect(layout.lineHeightPx).toBe(15)
  })
})

describe('line height (MAI-76)', () => {
  // 24px 固定の行の高さ
  const fixed: TextStyle = { ...style, fixedLineHeight: 24 }

  it('reads the line height of props, falling back to the default multiplier for old or broken records', () => {
    expect(lineHeightStyle(undefined, 1.35)).toEqual({ lineHeight: 1.35 })
    expect(lineHeightStyle({ unit: 'multiplier', value: 2 }, 1.35)).toEqual({ lineHeight: 2 })
    expect(lineHeightStyle({ unit: 'px', value: 24 }, 1.35)).toEqual({ lineHeight: 1.35, fixedLineHeight: 24 })
    expect(lineHeightStyle({ unit: 'px', value: 0 }, 1.4)).toEqual({ lineHeight: 1.4 })
    expect(lineHeightStyle({ unit: 'em', value: 2 } as never, 1.4)).toEqual({ lineHeight: 1.4 })
    expect(lineHeightOf(fixed)).toEqual({ unit: 'px', value: 24 })
    expect(lineHeightOf(style)).toEqual({ unit: 'multiplier', value: 1.5 })
  })

  it('writes the same line height to the editing DOM (CSS line-height)', () => {
    expect(cssLineHeight(style)).toBe('1.5')
    expect(cssLineHeight(fixed)).toBe('24px')
  })

  it('converts between a multiplier and pixels without changing the look', () => {
    expect(convertLineHeight({ unit: 'multiplier', value: 1.35 }, 'px', 12)).toEqual({ unit: 'px', value: 16.2 })
    expect(convertLineHeight({ unit: 'px', value: 30 }, 'multiplier', 20)).toEqual({ unit: 'multiplier', value: 1.5 })
    expect(convertLineHeight({ unit: 'px', value: 30 }, 'px', 20)).toEqual({ unit: 'px', value: 30 })
  })

  it('uses a fixed pixel height for every line, also for an empty text', () => {
    const layout = layoutText('a\n\nb', fixed, null)
    expect(layout.lines.map((l) => [l.top, l.height])).toEqual([
      [0, 24],
      [24, 24],
      [48, 24],
    ])
    expect(layoutRichText([], fixed, null).height).toBe(24)
    expect(layoutRichText([], { ...style, lineHeight: 2 }, null).height).toBe(20)
  })

  it('applies a multiplier per character size, like CSS line-height: <number>', () => {
    // 10px の文字と 20px の文字：箱はそれぞれ 15 と 30。大きい文字の箱が小さい文字の箱を含むので、行の高さは 30
    const line = layoutRichText([{ runs: [{ text: 'ab' }, { text: 'cd', format: { fontSize: 20 } }] }], { ...style, lineHeight: 1.5 }, null).lines[0]
    expect(line.height).toBeCloseTo(30)
  })

  it('applies pixels to every character size alike, like CSS line-height: <length>', () => {
    // 箱はどちらも 24px。概算の上下の高さ（上 0.88、下 0.12 × fontSize）でベースラインにそろえると、
    // 10px：上 8.8 + 7 = 15.8、下 8.2。20px：上 17.6 + 2 = 19.6、下 4.4。行は 19.6 + 8.2
    const line = layoutRichText([{ runs: [{ text: 'ab' }, { text: 'cd', format: { fontSize: 20 } }] }], fixed, null).lines[0]
    expect(line.height).toBeCloseTo(27.8)
    expect(line.baseline).toBeCloseTo(19.6)
    // 文字より低い行の高さも、CSS と同じく文字を重ねて詰める
    const tight = layoutRichText([{ runs: [{ text: 'ab', format: { fontSize: 20 } }] }], { ...style, fixedLineHeight: 10 }, null).lines[0]
    expect(tight.height).toBe(10)
    expect(tight.baseline).toBeCloseTo(17.6 - 5)
  })
})
