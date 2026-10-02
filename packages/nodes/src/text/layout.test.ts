import { describe, expect, it } from 'vitest'
import { TEXT_FONT_SIZES, breakUnits, layoutRichText, layoutText, stepFontSize, type TextStyle } from './layout.ts'

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
