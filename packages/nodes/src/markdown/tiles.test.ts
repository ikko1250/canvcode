import { describe, expect, it } from 'vitest'
import { fullImageLevel, tilesInRect, visibleLocalRect } from './tiles.ts'

describe('fullImageLevel', () => {
  it('短いカードは、最も高い段階まで 1 枚で作れる', () => {
    expect(fullImageLevel(480, 600)).toBe(4)
  })

  it('長いカードは、1 辺の上限に収まる段階までにする', () => {
    // 8192 / 13858 = 0.59 なので、0.5 までは抑えられない
    expect(fullImageLevel(907, 13858)).toBe(0.5)
    expect(fullImageLevel(907, 4000)).toBe(2)
  })

  it('どの段階でも抑えられるなら、最も低い段階', () => {
    expect(fullImageLevel(900, 100000)).toBe(0.25)
  })
})

describe('tilesInRect', () => {
  it('範囲にかかるタイルを、中心に近いものから返す', () => {
    const tiles = tilesInRect(1000, 3000, { x: 0, y: 1100, w: 1000, h: 300 }, 512)
    expect(tiles.map((t) => [t.col, t.row])).toEqual([
      [0, 2],
      [1, 2],
    ])
  })

  it('右端・下端のタイルは、カードの大きさで切る', () => {
    const tiles = tilesInRect(700, 1100, { x: 0, y: 0, w: 700, h: 1100 }, 512)
    expect(tiles).toHaveLength(6)
    const last = tiles.find((t) => t.col === 1 && t.row === 2)!
    expect(last).toMatchObject({ x: 512, y: 1024, w: 188, h: 76 })
  })

  it('カードにかからない範囲では空', () => {
    expect(tilesInRect(500, 500, { x: 600, y: 0, w: 100, h: 100 })).toEqual([])
    expect(tilesInRect(500, 500, { x: 0, y: 0, w: 0, h: 0 })).toEqual([])
  })
})

describe('visibleLocalRect', () => {
  const ctxWith = (m: { a: number; b: number; c: number; d: number; e: number; f: number }, width: number, height: number) =>
    ({ getTransform: () => ({ ...m, is2D: true }), canvas: { width, height } }) as unknown as CanvasRenderingContext2D

  it('拡大して描くと、描き先に入る部分だけになる', () => {
    // 2 倍で、カードの (100, 5000) が描き先の左上に来る
    const ctx = ctxWith({ a: 2, b: 0, c: 0, d: 2, e: -200, f: -10000 }, 800, 600)
    expect(visibleLocalRect(ctx, 907, 13858)).toEqual({ x: 100, y: 5000, w: 400, h: 300 })
  })

  it('カードの箱で切る', () => {
    const ctx = ctxWith({ a: 1, b: 0, c: 0, d: 1, e: 100, f: 100 }, 800, 600)
    expect(visibleLocalRect(ctx, 300, 300)).toEqual({ x: 0, y: 0, w: 300, h: 300 })
  })

  it('回転していても、描き先の四隅を戻した範囲になる', () => {
    // 90 度回して、描き先の (600, 0) に原点を置く：ローカルの (x, y) → (600 - y, x)
    const ctx = ctxWith({ a: 0, b: 1, c: -1, d: 0, e: 600, f: 0 }, 600, 400)
    expect(visibleLocalRect(ctx, 1000, 1000)).toEqual({ x: 0, y: 0, w: 400, h: 600 })
  })

  it('行列が分からなければ null', () => {
    expect(visibleLocalRect({} as CanvasRenderingContext2D, 100, 100)).toBeNull()
  })
})
