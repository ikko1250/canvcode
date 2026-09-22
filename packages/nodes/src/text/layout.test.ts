import { describe, expect, it } from 'vitest'
import { breakUnits, layoutText, type TextStyle } from './layout.ts'

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
