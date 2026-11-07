import { describe, expect, it } from 'vitest'
import {
  currentPageIndex,
  currentPdfPage,
  PAGE_JUMP_TOP_MARGIN_PX,
  pageJumpTarget,
  pageNavigation,
  pageNavigationTarget,
  parsePageNumber,
} from './pageNavigation.ts'

// ページの移動（MAI-57）。横 4 枚ずつの格子で確かめる

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

describe('currentPdfPage (MAI-92)', () => {
  const entries = pages.map((box, pageIndex) => ({ box, pageIndex, pageCount: 6 }))

  it('is the number in the PDF (from 1) of the page at the viewport centre, out of the page count', () => {
    expect(currentPdfPage(entries, at(0, 0), view.width, view.height)).toEqual({ page: 1, count: 6 })
    expect(currentPdfPage(entries, at(pages[5].x, pages[5].y), view.width, view.height)).toEqual({ page: 6, count: 6 })
    expect(currentPdfPage([], at(0, 0), view.width, view.height)).toBeNull()
  })

  it('uses the page number, not the position in the list, when a page in between is deleted', () => {
    // 2 ページ目を消した。3 ページ目は、並びの 2 番目だが番号は 3。総ページ数は PDF のページ数のまま
    const remaining = entries.filter((entry) => entry.pageIndex !== 1)
    expect(currentPdfPage(remaining, at(pages[2].x, 0), view.width, view.height)).toEqual({ page: 3, count: 6 })
  })

  it('counts the pages on the canvas when the PDF page count is unknown', () => {
    const unknown = entries.slice(0, 4).map(({ box, pageIndex }) => ({ box, pageIndex }))
    expect(currentPdfPage(unknown, at(pages[1].x, 0), view.width, view.height)).toEqual({ page: 2, count: 4 })
  })
})

describe('parsePageNumber (MAI-92)', () => {
  it('reads a page number from 1 to the page count, in full-width digits too, ignoring spaces', () => {
    expect(parsePageNumber('5', 6)).toBe(5)
    expect(parsePageNumber(' 6 ', 6)).toBe(6)
    expect(parsePageNumber('１', 6)).toBe(1)
    expect(parsePageNumber('　０３　', 6)).toBe(3)
  })

  it('is null outside the range and for anything but a whole number', () => {
    for (const text of ['0', '7', '', ' ', '-1', '2.5', '1e1', 'p.3', 'abc']) expect(parsePageNumber(text, 6)).toBeNull()
  })
})

describe('pageJumpTarget (MAI-92)', () => {
  const entries = pages.map((box, pageIndex) => ({ box, pageIndex, pageCount: 6 }))

  const jump = (list: typeof entries, pageNumber: number, camera = at(0, 0), size = view) => pageJumpTarget(list, pageNumber, camera, size.width, size.height)

  it('centres the page on the screen when it fits with the margins, keeping the zoom', () => {
    expect(PAGE_JUMP_TOP_MARGIN_PX).toBe(56)
    // 倍率 0.5：ページの高さ 400 + 余白 56 × 2 は画面の高さ 800 に収まる。5 ページ目（x 0〜600・y 840〜1640）の中心が画面の中心に
    expect(jump(entries, 5, at(3000, 3000, 0.5))).toEqual({ x: 300 - 500 / 0.5, y: 1240 - 400 / 0.5, zoom: 0.5 })
  })

  it('puts the top of the page below the top bar when it does not fit, still centred across', () => {
    // 倍率 1：ページの高さ 800 は余白と合わせて画面に収まらない。上端を画面の上から 56px に
    expect(jump(entries, 5, at(3000, 3000, 1))).toEqual({ x: 300 - 500, y: 840 - 56, zoom: 1 })
    expect(jump(entries, 2, at(0, 0, 2))).toEqual({ x: W + GAP + 300 - 250, y: -56 / 2, zoom: 2 })
    // 余白は指定できる
    expect(pageJumpTarget(entries, 2, at(0, 0, 2), view.width, view.height, 0)).toEqual({ x: W + GAP + 300 - 250, y: 0, zoom: 2 })
  })

  it('finds the page by its number, not by its position in the list, when a page in between is deleted', () => {
    const remaining = entries.filter((entry) => entry.pageIndex !== 1)
    expect(jump(remaining, 3)).toEqual({ x: pages[2].x + 300 - 500, y: -56, zoom: 1 })
  })

  it('is null for a deleted page and for numbers outside the PDF', () => {
    const remaining = entries.filter((entry) => entry.pageIndex !== 1)
    expect(jump(remaining, 2)).toBeNull()
    expect(jump(entries, 0)).toBeNull()
    expect(jump(entries, 7)).toBeNull()
    expect(jump([], 1)).toBeNull()
  })

  // 移ったあとの今のページ（画面の下の札）は、入れた番号と同じになる。全体が見えるくらいの縮小・中くらい・ページが画面より
  // 大きい拡大の倍率と、いろいろな画面の大きさで確かめる。ページは取り込んだときと同じ横 3 枚の格子（横長のページを 1 枚含む）
  it('always lands with the viewport centre on the page with that number', () => {
    const PW = 816
    const PH = 1056
    const grid = Array.from({ length: 12 }, (_, i) => {
      const landscape = i === 7
      return { box: { x: (i % 3) * (PW + GAP), y: Math.floor(i / 3) * (PH + GAP), w: PW, h: landscape ? PW * 0.75 : PH }, pageIndex: i, pageCount: 12 }
    })
    // 6 ページ目を消したもの
    const withDeleted = grid.filter((entry) => entry.pageIndex !== 5)
    const zooms = [0.05, 0.12, 0.25, 0.45, 0.8, 1, 2, 4]
    const screens = [
      { width: 1280, height: 720 },
      { width: 1000, height: 800 },
      { width: 375, height: 667 },
      { width: 2560, height: 1440 },
      { width: 300, height: 80 },
    ]
    for (const list of [grid, withDeleted]) {
      for (const zoom of zooms) {
        for (const screen of screens) {
          for (const { pageIndex } of list) {
            const target = pageJumpTarget(list, pageIndex + 1, at(-5000, 7000, zoom), screen.width, screen.height)!
            expect(target.zoom).toBe(zoom)
            expect(currentPdfPage(list, target, screen.width, screen.height)?.page, `page ${pageIndex + 1} at zoom ${zoom} on ${screen.width}×${screen.height}`).toBe(pageIndex + 1)
          }
        }
      }
    }
  })
})
