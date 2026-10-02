import { afterEach, describe, expect, it } from 'vitest'
import {
  TEXT_FONT_SIZES,
  breakUnits,
  convertLineHeight,
  baseFormatOf,
  cssFont,
  cssLetterSpacing,
  cssLineHeight,
  decorationThickness,
  drawTextLayout,
  layoutRichText,
  layoutText,
  lineHeightOf,
  lineLeft,
  letterSpacingOf,
  lineHeightStyle,
  setNativeLetterSpacingForTest,
  stepFontSize,
  textDecorations,
  STRIKETHROUGH_OFFSET_EM,
  UNDERLINE_OFFSET_EM,
  runStyle,
  type TextStyle,
} from './layout.ts'
import { applyRunFormat, clearRunFormat, resolveFormat, toggledValue } from './richText.ts'

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

describe('letter spacing (MAI-77)', () => {
  afterEach(() => setNativeLetterSpacingForTest(undefined))
  const spaced: TextStyle = { ...style, letterSpacing: 0.1 }

  it('reads missing or broken values as 0, and writes em to the editing DOM', () => {
    expect(letterSpacingOf(undefined)).toBe(0)
    expect(letterSpacingOf('1em')).toBe(0)
    expect(letterSpacingOf(Number.NaN)).toBe(0)
    expect(letterSpacingOf(-0.05)).toBe(-0.05)
    expect(cssLetterSpacing(style)).toBe('normal')
    expect(cssLetterSpacing(spaced)).toBe('0.1em')
  })

  it('adds the spacing after every character, also after the last one (like CSS)', () => {
    // 'ab'：5.5 + 5.5、空きは 1px × 2
    expect(layoutText('ab', spaced, null).width).toBeCloseTo(13)
    expect(layoutText('日本', { ...style, letterSpacing: -0.1 }, null).width).toBeCloseTo(18)
    // 0 は今までと同じ
    expect(layoutText('ab', { ...style, letterSpacing: 0 }, null).width).toBeCloseTo(11)
  })

  it('converts em by the size of each run', () => {
    // 'ab' 10px（空き 1px）と 'cd' 20px（空き 2px）
    const line = layoutRichText([{ runs: [{ text: 'ab' }, { text: 'cd', format: { fontSize: 20 } }] }], spaced, null).lines[0]
    expect(line.segments.map((s) => [s.x, s.width])).toEqual([
      [0, 13],
      [13, 26],
    ])
    expect(line.width).toBeCloseTo(39)
  })

  it('wraps with the spacing counted', () => {
    // 全角 3 文字：空きなしなら 30px に収まるが、1px ずつ足すと 33px で収まらない
    expect(layoutText('日本語', style, 30).lines.map((l) => l.text)).toEqual(['日本語'])
    expect(layoutText('日本語', spaced, 30).lines.map((l) => l.text)).toEqual(['日本', '語'])
    expect(layoutText('日本語', spaced, 33).lines.map((l) => l.text)).toEqual(['日本語'])
  })

  it('counts a grapheme cluster as one character', () => {
    // 結合文字（e + U+0301）は 1 文字として、空きを 1 つだけ足す
    const plain = layoutText('e\u0301', style, null).width
    expect(layoutText('e\u0301', spaced, null).width).toBeCloseTo(plain + 1)
  })

  const fakeContext = (native: boolean) => {
    const calls: { text: string; x: number; spacing?: string }[] = []
    const ctx: Record<string, unknown> = {
      font: '',
      fillStyle: '',
      textAlign: 'left',
      textBaseline: 'alphabetic',
      fillText(text: string, x: number) {
        calls.push(native ? { text, x, spacing: ctx.letterSpacing as string } : { text, x })
      },
    }
    if (native) ctx.letterSpacing = '0px'
    return { ctx: ctx as unknown as CanvasRenderingContext2D, calls }
  }

  it('draws with ctx.letterSpacing when the browser has it, and restores it', () => {
    setNativeLetterSpacingForTest(true)
    const { ctx, calls } = fakeContext(true)
    const layout = layoutRichText([{ runs: [{ text: 'ab' }, { text: 'cd', format: { fontSize: 20 } }] }], spaced, null)
    drawTextLayout(ctx, layout, spaced, { x: 0, y: 0, w: 100, h: 100 }, 'top')
    expect(calls.map((c) => [c.text, c.spacing])).toEqual([
      ['ab', '1px'],
      ['cd', '2px'],
    ])
    expect(ctx.letterSpacing).toBe('0px')
  })

  it('draws character by character at the measured positions without ctx.letterSpacing', () => {
    setNativeLetterSpacingForTest(false)
    const { ctx, calls } = fakeContext(false)
    const layout = layoutRichText([{ runs: [{ text: 'ab' }, { text: 'cd', format: { fontSize: 20 } }] }], spaced, null)
    drawTextLayout(ctx, layout, spaced, { x: 0, y: 0, w: 100, h: 100 }, 'top')
    // a: 0、b: 5.5 + 1、c: 13、d: 13 + 11 + 2
    expect(calls.map((c) => [c.text, c.x])).toEqual([
      ['a', 0],
      ['b', 6.5],
      ['c', 13],
      ['d', 26],
    ])
  })
})

// 箇条書き・番号付きリスト（MAI-78）。段差 2em・空き 0.5em（ノードの既定の 10px で 20px・5px）
describe('lists (MAI-78)', () => {
  const bullet = (level: number) => ({ type: 'bullet' as const, level })

  it('indents list paragraphs per level and hangs wrapped lines under the text, not the marker', () => {
    const layout = layoutRichText(
      [
        { runs: [{ text: 'aaaa bbbb' }], list: bullet(0) },
        { runs: [{ text: 'cc' }], list: bullet(1) },
        { runs: [{ text: 'plain' }] },
      ],
      style,
      60,
    )
    // 1 段落目は 60 - 20 = 40px で折り返す（'aaaa ' 22px + 'bbbb' 22px > 40）
    expect(layout.lines.map((l) => [l.text, l.indent])).toEqual([
      ['aaaa', 20],
      ['bbbb', 20],
      ['cc', 40],
      ['plain', 0],
    ])
    // 記号は 1 行目だけ。文字の左へ 空き + 記号の幅
    expect(layout.lines.map((l) => l.marker?.text)).toEqual(['•', undefined, '◦', undefined])
    expect(layout.lines[0].marker!.x).toBeCloseTo(-5 - 5.5)
    expect(lineLeft(layout.lines[0], 'left', { x: 0, w: 60 })).toBe(20)
    // 揃えは段差を除いた幅の中で
    expect(lineLeft(layout.lines[2], 'right', { x: 0, w: 60 })).toBe(60 - 11)
    expect(lineLeft(layout.lines[2], 'center', { x: 0, w: 60 })).toBe(40 + (20 - 11) / 2)
  })

  it('counts the indent in the width of a text that does not wrap, and puts long numbers at the left of the gutter', () => {
    const paragraphs = Array.from({ length: 10 }, (_, i) => ({ runs: [{ text: String(i) }], list: { type: 'ordered' as const, level: 0, style: 'paren-decimal' as const } }))
    const layout = layoutRichText(paragraphs, style, null)
    expect(layout.width).toBeCloseTo(20 + 5.5)
    // '(1)' は 16.5px で溝（20 - 5 = 15px）に収まらないので、溝の左端から
    expect(layout.lines[0].marker).toMatchObject({ text: '(1)', x: -20 })
    expect(layout.lines[9].marker!.text).toBe('(10)')
  })

  it('draws the marker in the format of the first run, without letter spacing', () => {
    const calls: { text: string; x: number; font: string; color: string }[] = []
    const ctx = {
      font: '',
      fillStyle: '',
      letterSpacing: '0px',
      fillText(text: string, x: number) {
        calls.push({ text, x, font: ctx.font, color: ctx.fillStyle })
      },
    }
    setNativeLetterSpacingForTest(true)
    const spacedStyle = { ...style, letterSpacing: 0.1 }
    const layout = layoutRichText([{ runs: [{ text: 'a', format: { color: '#ff0000', fontSize: 20 } }, { text: 'b' }], list: bullet(0) }], spacedStyle, null)
    drawTextLayout(ctx as unknown as CanvasRenderingContext2D, layout, spacedStyle, { x: 0, y: 0, w: 100, h: 100 }, 'top')
    expect(calls[0]).toMatchObject({ text: '•', color: '#ff0000' })
    expect(calls[0].font).toContain('20px')
    expect(calls[0].x).toBeCloseTo(20 - 5 - 11)
    expect(calls.slice(1).map((c) => [c.text, c.x])).toEqual([
      ['a', 20],
      ['b', 20 + 11 + 2],
    ])
    expect(ctx.letterSpacing).toBe('0px')
    setNativeLetterSpacingForTest(undefined)
  })
})

// 太字・斜体・下線・取り消し線（MAI-79）
describe('bold, italic, underline and strikethrough', () => {
  const box = { x: 0, y: 0, w: 100, h: 100 }

  it('puts the weight and the style into the CSS font', () => {
    const bold = runStyle(style, { bold: true, italic: true })
    expect(bold).toMatchObject({ fontWeight: 700, fontStyle: 'italic' })
    expect(cssFont(bold)).toMatch(/^italic 700 10px /)
    expect(cssFont(style)).toMatch(/^400 10px /)
    // 既定（ノード）はどれもオフ。run が false を持てば既定の値を打ち消す
    expect(baseFormatOf(style)).toMatchObject({ bold: false, italic: false, underline: false, strikethrough: false })
    expect(runStyle({ ...style, fontWeight: 700 }, { bold: false }).fontWeight).toBe(400)
  })

  it('keeps only the formats that differ from the default, and toggles a mixed range on', () => {
    const base = baseFormatOf(style)
    const on = applyRunFormat([{ runs: [{ text: 'abc' }] }], 0, 2, { bold: true }, base)
    expect(on).toEqual([{ runs: [{ text: 'ab', format: { fontWeight: 700 } }, { text: 'c' }] }])
    expect(applyRunFormat(on, 0, 3, { bold: false }, base)).toEqual([{ runs: [{ text: 'abc' }] }])
    expect(toggledValue([true, false])).toBe(true)
    expect(toggledValue([true, true])).toBe(false)
    expect(toggledValue([])).toBe(true)
  })

  it('keeps the weight as fontWeight, and bold follows the weight', () => {
    const style = { fontSize: 10, lineHeight: 1.2, fontWeight: 400, color: '#000', align: 'left' } as const
    const base = baseFormatOf(style)
    // 太さは範囲ごとに持ち、太字の切り替えは 700 / 400 の太さにする（それまでの太さより優先する）
    const light = applyRunFormat([{ runs: [{ text: 'abc' }] }], 0, 3, { fontWeight: 300 }, base)
    expect(light).toEqual([{ runs: [{ text: 'abc', format: { fontWeight: 300 } }] }])
    expect(runStyle(style, light[0].runs[0].format).fontWeight).toBe(300)
    expect(applyRunFormat(light, 0, 3, { bold: true }, base)).toEqual([{ runs: [{ text: 'abc', format: { fontWeight: 700 } }] }])
    // 太字としての表示は、太さが 600 以上か
    expect(resolveFormat(base, { fontWeight: 800 }).bold).toBe(true)
    expect(resolveFormat(base, { fontWeight: 500 }).bold).toBe(false)
    // ノードの既定の太さ
    expect(baseFormatOf({ ...style, fontWeight: 900 })).toMatchObject({ fontWeight: 900, bold: true })
    expect(cssFont(runStyle(style, { fontWeight: 300 }))).toMatch(/^300 10px /)
    // 太さを外すと、古い bold も外れる
    expect(clearRunFormat([{ runs: [{ text: 'a', format: { bold: true, italic: true } }] }], 'fontWeight')).toEqual([{ runs: [{ text: 'a', format: { italic: true } }] }])
  })

  it('draws the lines per wrapped line and per run, in the size and color of the run', () => {
    // 'aa' + 'aa bbbb'（18px）は 40px で 'bbbb' の前で折り返す（半角 0.55em、空白 0.3em）
    const layout = layoutRichText(
      [{ runs: [{ text: 'aa', format: { underline: true, color: '#f00' } }, { text: 'aa bbbb', format: { underline: true, fontSize: 18 } }] }],
      style,
      40,
    )
    expect(layout.lines.length).toBe(2)
    const lines = textDecorations(layout, style, box, 'top')
    expect(lines.map((l) => [l.kind, l.color])).toEqual([
      ['underline', '#f00'],
      ['underline', '#000'],
      ['underline', '#000'],
    ])
    const [first, second, third] = lines
    // 1 行目：2 つの run が続けて並ぶ。行末の空白には引かない
    expect(first.x).toBe(0)
    expect(first.width).toBeCloseTo(11)
    expect(second.x).toBeCloseTo(11)
    expect(second.width).toBeCloseTo(19.8)
    expect(first.thickness).toBe(decorationThickness(10))
    expect(second.thickness).toBeCloseTo(18 / 15)
    expect(second.y).toBeCloseTo(layout.lines[0].baseline + 18 * UNDERLINE_OFFSET_EM)
    // 2 行目
    expect(third.y).toBeCloseTo(layout.lines[1].top + layout.lines[1].baseline + 18 * UNDERLINE_OFFSET_EM)
    expect(third.width).toBeCloseTo(39.6)
  })

  it('places the strikethrough through the middle of the letters, and skips the trailing letter spacing and list markers', () => {
    const spaced = { ...style, letterSpacing: 0.1, align: 'center' as const }
    const layout = layoutRichText([{ runs: [{ text: 'ab', format: { strikethrough: true } }], list: { type: 'bullet', level: 0 } }], spaced, null)
    const [line] = textDecorations(layout, spaced, box, 'top')
    const thickness = decorationThickness(10)
    expect(line.kind).toBe('strikethrough')
    expect(line.y + thickness / 2).toBeCloseTo(layout.lines[0].baseline - 10 * STRIKETHROUGH_OFFSET_EM)
    // 文字の幅 11 + 文字間 2 のうち、最後の文字の後ろの空き（1）を除く。記号の溝（20px）の右から
    expect(line.width).toBeCloseTo(12)
    expect(line.x).toBeCloseTo(lineLeft(layout.lines[0], 'center', box))
    expect(line.x).toBeGreaterThan(20)
  })

  it('draws the lines over the text in drawTextLayout', () => {
    const rects: [number, number, number, number, string][] = []
    const ctx = {
      font: '',
      fillStyle: '',
      fillText() {},
      fillRect(x: number, y: number, w: number, h: number) {
        rects.push([x, y, w, h, ctx.fillStyle])
      },
    }
    setNativeLetterSpacingForTest(false)
    const layout = layoutRichText([{ runs: [{ text: 'ab', format: { underline: true, strikethrough: true, color: '#00f' } }] }], style, null)
    drawTextLayout(ctx as unknown as CanvasRenderingContext2D, layout, style, box, 'top')
    expect(rects.length).toBe(2)
    expect(rects.every((r) => r[4] === '#00f' && r[2] > 10)).toBe(true)
    setNativeLetterSpacingForTest(undefined)
  })
})
