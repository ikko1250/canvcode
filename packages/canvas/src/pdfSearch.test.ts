import { describe, expect, it } from 'vitest'
import { PdfSearchResults, matchRects } from './pdfSearch.ts'

describe('matchRects', () => {
  const items = [
    { text: 'デジタルトランス', x: 100, y: 10, w: 80, h: 10 },
    { text: 'フォーメーション', x: 0, y: 30, w: 80, h: 10 },
  ]

  it('cuts the part of each piece that a match covers', () => {
    expect(matchRects(items, 'トランス')).toEqual([[{ x: 140, y: 10, w: 40, h: 10 }]])
  })

  it('gives one rectangle per piece when a match crosses lines', () => {
    expect(matchRects(items, 'トランスフォー')).toEqual([[{ x: 140, y: 10, w: 40, h: 10 }, { x: 0, y: 30, w: 30, h: 10 }]])
  })

  it('orders matches from the top of the page, and from the left on the same line, not in the order of the pieces', () => {
    // スライドの PDF のように、下のテキストボックスの文字が先に書かれている
    const slide = [
      { text: 'DX 下', x: 10, y: 500, w: 40, h: 10 },
      { text: 'DX 右', x: 300, y: 101, w: 40, h: 10 },
      { text: 'DX 左', x: 10, y: 100, w: 40, h: 10 },
    ]
    expect(matchRects(slide, 'dx').map((match) => [match[0].x, match[0].y])).toEqual([[10, 100], [300, 101], [10, 500]])
  })
})

describe('PdfSearchResults', () => {
  it('numbers hits across pages, and takes the count from the located matches', () => {
    const results = new PdfSearchResults('dx', [
      { fileId: 'f', pageIndex: 0, count: 2 },
      { fileId: 'f', pageIndex: 3, count: 1 },
    ])
    expect(results.total).toBe(3)
    expect(results.hit(2)).toEqual({ fileId: 'f', pageIndex: 3, index: 0 })
    expect(results.hit(3)).toBeNull()
    const box = { x: 0, y: 0, w: 1, h: 1 }
    results.setRects('f', 0, [[box], [box], [box]])
    expect(results.total).toBe(4)
    expect(results.ordinal('f', 3, 0)).toBe(3)
    expect(results.pendingPages()).toEqual([{ fileId: 'f', pageIndex: 3, count: 1 }])
  })
})
