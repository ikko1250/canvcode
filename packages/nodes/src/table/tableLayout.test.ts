import { describe, expect, it } from 'vitest'
import { TABLE_METRICS, cellsInRect, estimateTextWidth, layoutTable } from './tableLayout.ts'

// 1 文字 10 の幅で測る
const measure = (text: string) => Array.from(text).length * 10
const PAD = TABLE_METRICS.paddingX * 2

describe('layoutTable', () => {
  it('sizes columns to their widest cell within the limits, and finds number columns', () => {
    const rows = [
      ['名前', '値', '備考'],
      ['りんご', '1,200', 'x'.repeat(100)],
      ['みかん', '-3.5', ''],
    ]
    const layout = layoutTable(rows, { header: true, measure })
    expect(layout.columns).toBe(3)
    // 名前（りんご）・値（1,200）・備考（上限で切る）
    const widths = [30 + PAD, 50 + PAD, TABLE_METRICS.maxColumn]
    expect(layout.colX).toEqual([0, widths[0], widths[0] + widths[1], widths[0] + widths[1] + widths[2]])
    expect(layout.width).toBe(layout.colX[3])
    expect(layout.height).toBe(3 * TABLE_METRICS.rowHeight)
    // 見出しの「値」は数でなくても、数の列とみなす
    expect(layout.numeric).toEqual([false, true, false])
  })

  it('treats the first row as data without a header, and measures newlines in cells as spaces', () => {
    const layout = layoutTable([['1', 'abc\ndef'], ['2', 'c']], { header: false, measure })
    expect(layout.header).toBe(false)
    expect(layout.numeric).toEqual([true, false])
    expect(layout.colX[2] - layout.colX[1]).toBe(70 + PAD)
    expect(layout.rowY).toEqual([0, 28, 56])
    expect(layout.lines).toBeNull()
    // 短い列は最小の幅
    expect(layout.colX[1]).toBe(TABLE_METRICS.minColumn)
  })

  it('handles an empty table', () => {
    const layout = layoutTable([], { header: true, measure })
    expect(layout).toMatchObject({ columns: 0, width: 0, height: 0, header: false })
  })
})

describe('layoutTable with wrap', () => {
  it('wraps long cells at the column width and keeps newlines, making rows as tall as their tallest cell', () => {
    // 2 列目は上限（320）。余白を除いて 300 の幅に、1 文字 10 なので 30 文字ずつ
    const long = 'x'.repeat(70)
    const layout = layoutTable([['名前', '備考'], ['a', long], ['b', 'one two\nthree'], ['c', '']], { header: true, measure, wrap: true })
    const lines = layout.lines!
    expect(lines[1][1]).toEqual(['x'.repeat(30), 'x'.repeat(30), 'x'.repeat(10)])
    expect(lines[2][1]).toEqual(['one two', 'three'])
    const { lineHeight, paddingY, rowHeight } = TABLE_METRICS
    expect(layout.rowY).toEqual([0, rowHeight, rowHeight + 3 * lineHeight + 2 * paddingY, rowHeight + 5 * lineHeight + 4 * paddingY, rowHeight * 2 + 5 * lineHeight + 4 * paddingY])
    expect(layout.height).toBe(layout.rowY[4])
  })

  it('breaks after a space when a word does not fit', () => {
    const words = Array.from({ length: 8 }, (_, i) => `word${i}`).join(' ')
    const layout = layoutTable([[words + ' ' + 'y'.repeat(60)]], { header: false, measure, wrap: true })
    for (const line of layout.lines![0][0]) expect(Array.from(line).length).toBeLessThanOrEqual(30)
    expect(layout.lines![0][0][0]).toBe('word0 word1 word2 word3 word4')
  })

  it('breaks Japanese text between characters instead of at an earlier space', () => {
    // 2 列目の幅は上限（余白を除いて 300、1 文字 10 なので 30 文字）
    const text = 'ab ' + 'あ'.repeat(40)
    const layout = layoutTable([['x', text]], { header: false, measure, wrap: true })
    expect(layout.lines![0][1]).toEqual(['ab ' + 'あ'.repeat(27), 'あ'.repeat(13)])
  })

  it('leaves room for the sort and filter mark in the header', () => {
    const plain = layoutTable([['ab'], ['1']], { header: true, measure })
    const marked = layoutTable([['ab'], ['1']], { header: true, measure, marks: [{ sort: 'asc' }] })
    expect(marked.colX[1]).toBeGreaterThan(plain.colX[1])
  })
})

describe('cellsInRect', () => {
  it('returns the rows and columns that a rect touches', () => {
    const rows = Array.from({ length: 100 }, (_, i) => [`${i}`, 'abcdefgh', 'x'])
    const layout = layoutTable(rows, { header: true, measure })
    const [, c1, c2, c3] = layout.colX
    const h = TABLE_METRICS.rowHeight
    expect(cellsInRect(layout, { x: 0, y: 0, w: 1, h: 1 })).toEqual({ row0: 0, row1: 1, col0: 0, col1: 1 })
    expect(cellsInRect(layout, { x: c1 + 1, y: h * 10 + 1, w: c2 - c1, h: h * 2 })).toEqual({ row0: 10, row1: 13, col0: 1, col1: 3 })
    // 表の外にはみ出す分は切る
    expect(cellsInRect(layout, { x: -50, y: -50, w: c3 + 100, h: h * 1000 })).toEqual({ row0: 0, row1: 100, col0: 0, col1: 3 })
  })
})

describe('estimateTextWidth', () => {
  it('counts wide characters as one em and others as 0.6 em', () => {
    const size = TABLE_METRICS.fontSize
    expect(estimateTextWidth('ab', false)).toBeCloseTo(1.2 * size)
    expect(estimateTextWidth('日本', false)).toBeCloseTo(2 * size)
  })
})
