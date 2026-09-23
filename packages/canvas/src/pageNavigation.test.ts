import { describe, expect, it } from 'vitest'
import { currentPageIndex, pageNavigation, pageNavigationTarget } from './pageNavigation.ts'

// ページの移動（MAI-57）。横 4 枚ずつの格子（PDF の取り込みと同じ並び）で確かめる

const W = 600
const H = 800
const GAP = 40
const MARGIN = GAP / 2
// 6 ページ：1 行目に 4 枚、2 行目に 2 枚
const pages = Array.from({ length: 6 }, (_, i) => ({ x: (i % 4) * (W + GAP), y: Math.floor(i / 4) * (H + GAP), w: W, h: H }))
const view = { width: 1000, height: 800 }
const at = (x: number, y: number, zoom = 1) => ({ x, y, zoom })

describe('currentPageIndex', () => {
  it('is the page containing the viewport centre', () => {
    // 画面の中心 = (x + 500, y + 400)
    expect(currentPageIndex(pages, at(0, 0), view.width, view.height)).toBe(0)
    expect(currentPageIndex(pages, at(W + GAP - 500 + 10, 0), view.width, view.height)).toBe(1)
    expect(currentPageIndex(pages, at(0, H + GAP - 400 + 10), view.width, view.height)).toBe(4)
  })

  it('falls back to the page whose centre is nearest, and to -1 without pages', () => {
    // 中心がページの隙間（1 枚目と 2 枚目の間）にあるとき。2 枚目の中心のほうが近い
    const gapX = W + GAP / 2 + 5 - 500
    expect(currentPageIndex(pages, at(gapX, 0), view.width, view.height)).toBe(1)
    // ずっと下（ページの外）でも、いちばん近いページ
    expect(currentPageIndex(pages, at(0, 5000), view.width, view.height)).toBe(4)
    expect(currentPageIndex([], at(0, 0), view.width, view.height)).toBe(-1)
  })

  it('respects the zoom when locating the centre', () => {
    // 倍率 0.5 なら、画面の中心はワールドで (x + 1000, y + 800)。2 枚目の中
    expect(currentPageIndex(pages, at(0, 0, 0.5), view.width, view.height)).toBe(1)
  })
})

describe('pageNavigationTarget', () => {
  it('puts the next page top-left at the viewport top-left with a margin, keeping the zoom', () => {
    // 倍率 0.75 で画面の中心は (x + 667, y + 533)。1 枚目の中
    expect(pageNavigationTarget(pages, at(-200, -100, 0.75), view.width, view.height, 'next', MARGIN)).toEqual({
      x: W + GAP - MARGIN,
      y: -MARGIN,
      zoom: 0.75,
    })
    // 4 枚目 → 5 枚目は次の行の先頭
    const onFourth = at(pages[3].x, 0)
    expect(pageNavigationTarget(pages, onFourth, view.width, view.height, 'next', MARGIN)).toEqual({ x: -MARGIN, y: H + GAP - MARGIN, zoom: 1 })
  })

  it('puts the previous page bottom-right at the viewport bottom-right', () => {
    const onSecond = at(pages[1].x, 0, 2)
    const target = pageNavigationTarget(pages, onSecond, view.width, view.height, 'prev', MARGIN)
    expect(target).toEqual({ x: W + MARGIN - view.width / 2, y: H + MARGIN - view.height / 2, zoom: 2 })
    // 移った先では、1 枚目の右下が画面の右下に来ている
    const right = target!.x + view.width / target!.zoom
    const bottom = target!.y + view.height / target!.zoom
    expect(right).toBe(pages[0].x + pages[0].w + MARGIN)
    expect(bottom).toBe(pages[0].y + pages[0].h + MARGIN)
  })

  it('returns null at the ends and without pages', () => {
    expect(pageNavigationTarget(pages, at(0, 0), view.width, view.height, 'prev', MARGIN)).toBeNull()
    expect(pageNavigationTarget(pages, at(pages[5].x, pages[5].y), view.width, view.height, 'next', MARGIN)).toBeNull()
    expect(pageNavigationTarget([], at(0, 0), view.width, view.height, 'next', MARGIN)).toBeNull()
  })
})

describe('pageNavigation', () => {
  it('reports whether a next / previous page exists', () => {
    expect(pageNavigation(pages, at(0, 0), view.width, view.height)).toEqual({ canNext: true, canPrev: false })
    expect(pageNavigation(pages, at(pages[2].x, 0), view.width, view.height)).toEqual({ canNext: true, canPrev: true })
    expect(pageNavigation(pages, at(pages[5].x, pages[5].y), view.width, view.height)).toEqual({ canNext: false, canPrev: true })
    expect(pageNavigation([], at(0, 0), view.width, view.height)).toEqual({ canNext: false, canPrev: false })
    expect(pageNavigation([pages[0]], at(0, 0), view.width, view.height)).toEqual({ canNext: false, canPrev: false })
  })
})
