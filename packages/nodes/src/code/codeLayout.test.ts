import { describe, expect, it } from 'vitest'
import { CODE_TEXT_COLOR, layoutCode, type CodeMetrics } from './codeLayout.ts'

// コードカードの配置と色分け（MAI-31）

const metrics: CodeMetrics = { fontSize: 10, lineHeight: 16, charWidth: 10 }
const text = (line: { runs: { text: string }[] }) => line.runs.map((r) => r.text).join('')

describe('layoutCode', () => {
  it('numbers each source line once, and keeps empty lines', () => {
    const layout = layoutCode('a = 1\n\nb = 2', 1000, metrics)
    expect(layout.lines.map((l) => l.lineNumber)).toEqual([1, 2, 3])
    expect(layout.sourceLines).toBe(3)
  })

  it('wraps long lines and keeps the indent on continued lines', () => {
    // 幅 100 = 10 文字。4 桁のインデントの行は、続きの行も 40 の位置から始まる
    const layout = layoutCode('    return something_long + other', 100, metrics)
    const lines = layout.lines
    expect(lines.length).toBeGreaterThan(1)
    expect(lines[0].lineNumber).toBe(1)
    expect(lines.slice(1).every((l) => l.lineNumber === null)).toBe(true)
    for (const line of lines.slice(1)) expect(line.runs[0].x).toBe(40)
    // 折り返しても、文字は欠けない
    expect(lines.map(text).join('').replace(/\s+/g, '')).toBe('returnsomething_long+other')
  })

  it('breaks after a space when it can', () => {
    const layout = layoutCode('print(aaaa bbbbbbb)', 120, metrics)
    expect(text(layout.lines[0])).toBe('print(aaaa ')
  })

  it('limits the hanging indent to half the width', () => {
    const layout = layoutCode(' '.repeat(12) + 'x'.repeat(30), 200, metrics)
    // 1 行目は元のインデントのまま。続きの行のぶら下げは、幅（200）の半分まで
    expect(layout.lines[0].runs[0].x).toBe(120)
    for (const line of layout.lines.slice(1)) expect(line.runs[0].x).toBe(100)
  })

  it('expands tabs to the next multiple of four', () => {
    const layout = layoutCode('\tx', 1000, metrics)
    expect(layout.lines[0].runs[0]).toMatchObject({ text: 'x', x: 40 })
  })

  it('colors keywords, strings, comments and numbers', () => {
    const layout = layoutCode('def f():\n    return "s"  # c\nx = 42', 1000, metrics)
    const color = (row: number, piece: string) => layout.lines[row].runs.find((r) => r.text.includes(piece))!.color
    expect(color(0, 'def')).not.toBe(CODE_TEXT_COLOR)
    expect(color(1, '"s"')).not.toBe(CODE_TEXT_COLOR)
    expect(color(1, '# c')).not.toBe(CODE_TEXT_COLOR)
    expect(color(2, '42')).not.toBe(CODE_TEXT_COLOR)
    expect(new Set([color(0, 'def'), color(1, '"s"'), color(1, '# c'), color(2, '42')]).size).toBe(4)
  })

  it('does not start a wrapped line with punctuation', () => {
    // 幅 60 = 6 桁。「あいう、」の「、」は次の行の頭に来ないよう、前の文字と一緒に送る
    const layout = layoutCode('# あい、うえ', 60, metrics)
    expect(layout.lines.slice(1).every((line) => !text(line).startsWith('、'))).toBe(true)
  })

  it('counts wide characters as two columns', () => {
    // 幅 60 = 6 桁。全角 3 文字でいっぱいになる
    const layout = layoutCode('# 日本語のコメント', 60, metrics)
    expect(text(layout.lines[0])).toBe('# 日本')
  })
})
