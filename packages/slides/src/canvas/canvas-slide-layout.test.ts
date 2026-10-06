import { describe, expect, it } from 'vitest'
import {
  canvasCoverLayout,
  canvasSlideLayout,
  placeCoverHeading,
  type CanvasGridSlideBoxes,
} from './canvas-slide-layout.ts'
import { computeSlideGeometry, getMaxRowCount } from '../core/slide-layout-spec.ts'

// スライド v2 の幾何：v1（computeSlideGeometry・computeCoverGeometry・slide.css）と同じ位置になること

function rowYs(boxes: CanvasGridSlideBoxes): number[] {
  return boxes.rows.map((row) => row.body.y)
}

describe('canvasSlideLayout table', () => {
  it('places 3 rows compactly like v1', () => {
    const boxes = canvasSlideLayout('table', 3)
    expect(boxes.compact).toBe(true)
    expect(boxes.size).toEqual({ w: 1920, h: 1080 })
    expect(boxes.title.x).toBe(150)
    expect(boxes.title.y).toBe(178)
    expect(boxes.title.w).toBe(1770)
    expect(boxes.title.h).toBeCloseTo(46 * 1.18)
    expect(boxes.panel).toEqual({ x: 150, y: 246, w: 1660, h: 656 })
    expect(boxes.grid).toEqual({ x: 220, y: 310, w: 1520, h: 530 })
    expect(boxes.rowPx).toBe(150)
    expect(boxes.gapPx).toBe(40)
    expect(boxes.rows).toHaveLength(3)
    expect(boxes.rows[0]).toEqual({
      label: { x: 220, y: 310, w: 394, h: 150 },
      body: { x: 635, y: 310, w: 1105, h: 150 },
    })
    expect(rowYs(boxes)).toEqual([310, 500, 690])
    expect(boxes.figure).toBeNull()
    expect(boxes.figureContent).toBeNull()
  })

  it('moves the title and panel when the row count changes (compact)', () => {
    const two = canvasSlideLayout('table', 2)
    expect(two.compact).toBe(true)
    expect(two.title.y).toBe(273)
    expect(two.panel).toEqual({ x: 150, y: 341, w: 1660, h: 466 })
    expect(rowYs(two)).toEqual([405, 595])

    const four = canvasSlideLayout('table', 4)
    expect(four.compact).toBe(false)
    expect(four.title.y).toBe(128)
    expect(four.panel).toEqual({ x: 150, y: 197, w: 1660, h: 772 })
    expect(four.rowPx).toBe(131)
    expect(four.gapPx).toBe(41)
    expect(rowYs(four)).toEqual([261, 433, 605, 777])
  })

  it('handles the maximum row count', () => {
    const max = getMaxRowCount('table')
    expect(max).toBe(6)
    const boxes = canvasSlideLayout('table', max)
    expect(boxes.rowPx).toBe(74)
    expect(boxes.gapPx).toBe(41)
    expect(rowYs(boxes)).toEqual([261, 376, 491, 606, 721, 836])
    // 行の高さの丸めで v1 と同じく下の padding に 3px はみ出すが、パネルの内側には収まる
    const last = boxes.rows[max - 1]!
    expect(last.body.y + last.body.h).toBe(910)
    expect(last.body.y + last.body.h).toBeLessThanOrEqual(boxes.panel.y + boxes.panel.h)
  })

  it('agrees with computeSlideGeometry for every row count', () => {
    for (const layout of ['table', 'bullets', 'table-image'] as const) {
      for (let n = 1; n <= getMaxRowCount(layout); n += 1) {
        const geometry = computeSlideGeometry(layout, n)
        const boxes = canvasSlideLayout(layout, n)
        expect(boxes.title.y).toBe(geometry.titleTop)
        expect(boxes.panel.y).toBe(geometry.panelTop)
        expect(boxes.panel.h).toBe(geometry.panelHeight)
        expect(boxes.rows.every((row) => row.body.h === geometry.grid.defaultRowPx)).toBe(true)
      }
    }
  })

  it('throws beyond the maximum row count like v1', () => {
    expect(() => canvasSlideLayout('table', 7)).toThrow()
    expect(() => canvasSlideLayout('bullets', 7)).toThrow()
    expect(() => canvasSlideLayout('table-image', 7)).toThrow()
    expect(() => canvasSlideLayout('table', 0)).toThrow()
  })

  it('uses the full panel when forceFull is set', () => {
    const boxes = canvasSlideLayout('table', 3, '16:9', { forceFull: true })
    expect(boxes.compact).toBe(false)
    expect(boxes.panel.y).toBe(197)
    expect(boxes.panel.h).toBe(772)
  })
})

describe('canvasSlideLayout bullets', () => {
  it('has body cells only, spanning the panel content width', () => {
    const boxes = canvasSlideLayout('bullets', 3)
    expect(boxes.panel).toEqual({ x: 150, y: 246, w: 1660, h: 656 })
    expect(boxes.rows.map((row) => row.label)).toEqual([null, null, null])
    expect(boxes.rows[1]!.body).toEqual({ x: 220, y: 500, w: 1520, h: 150 })
    expect(canvasSlideLayout('bullets', 4).rows[3]!.body).toEqual({ x: 220, y: 777, w: 1520, h: 131 })
  })
})

describe('canvasSlideLayout table-image', () => {
  it('uses the approved compact overrides for 2 and 3 rows', () => {
    const two = canvasSlideLayout('table-image', 2)
    expect(two.compact).toBe(true)
    expect(two.rowPx).toBe(170)
    expect(two.gapPx).toBe(46)
    expect(two.title.y).toBe(282)
    expect(two.panel).toEqual({ x: 150, y: 350, w: 680, h: 466 })
    expect(two.grid).toEqual({ x: 190, y: 390, w: 600, h: 386 })
    expect(two.rows[1]).toEqual({
      label: { x: 190, y: 606, w: 200, h: 170 },
      body: { x: 410, y: 606, w: 380, h: 170 },
    })

    const three = canvasSlideLayout('table-image', 3)
    expect(three.rowPx).toBe(162)
    expect(three.gapPx).toBe(45)
    expect(three.title.y).toBe(187)
    expect(three.panel.y).toBe(255)
    expect(rowYs(three)).toEqual([295, 502, 709])
  })

  it('places 4 rows in the full panel and the figure on the right', () => {
    const four = canvasSlideLayout('table-image', 4)
    expect(four.compact).toBe(false)
    expect(four.title.y).toBe(128)
    expect(four.panel).toEqual({ x: 150, y: 197, w: 680, h: 772 })
    expect(four.rowPx).toBe(140)
    expect(four.gapPx).toBe(44)
    expect(four.figure).toEqual({ x: 850, y: 197, w: 960, h: 772 })
    expect(four.figureContent).toEqual({ x: 871, y: 218, w: 918, h: 730 })
  })
})

describe('canvasSlideLayout title', () => {
  it('returns the heading area and the credits band with credits', () => {
    const cover = canvasSlideLayout('title', 0, '16:9', { hasCredits: true })
    expect(cover.headingArea).toEqual({ x: 150, y: 0, w: 1660, h: 860 })
    expect(cover.headingCenterY).toBe(430)
    expect(cover.subtitleGap).toBe(28)
    expect(cover.credits).toEqual({ x: 150, y: 800, w: 1660, h: 180 })
  })

  it('centers the heading on the whole slide without credits', () => {
    const cover = canvasCoverLayout(false)
    expect(cover.headingArea).toEqual({ x: 150, y: 0, w: 1660, h: 1080 })
    expect(cover.headingCenterY).toBe(540)
    expect(cover.credits).toBeNull()
  })

  it('places the title and subtitle around the heading center', () => {
    const cover = canvasCoverLayout(true)
    const withSubtitle = placeCoverHeading(cover, 80, 56)
    expect(withSubtitle.title).toEqual({ x: 150, y: 348, w: 1660, h: 80 })
    expect(withSubtitle.subtitle).toEqual({ x: 150, y: 456, w: 1660, h: 56 })

    const titleOnly = placeCoverHeading(canvasCoverLayout(false), 80)
    expect(titleOnly.title.y).toBe(500)
    expect(titleOnly.subtitle).toBeNull()
  })
})

describe('canvasSlideLayout 4:3', () => {
  it('scales only horizontal dimensions by 1440/1920', () => {
    const wide = canvasSlideLayout('table', 3)
    const narrow = canvasSlideLayout('table', 3, '4:3')
    expect(narrow.size).toEqual({ w: 1440, h: 1080 })
    expect(narrow.panel).toEqual({ x: 112.5, y: 246, w: 1245, h: 656 })
    expect(narrow.rows[0]).toEqual({
      label: { x: 165, y: 310, w: 295.5, h: 150 },
      body: { x: 476.25, y: 310, w: 828.75, h: 150 },
    })
    expect(narrow.title.w).toBe(1327.5)
    expect(narrow.title.y).toBe(wide.title.y)
    expect(narrow.title.h).toBe(wide.title.h)
    expect(narrow.rowPx).toBe(wide.rowPx)
  })

  it('scales the figure and the cover boxes too', () => {
    const boxes = canvasSlideLayout('table-image', 2, '4:3')
    expect(boxes.figure).toEqual({ x: 637.5, y: 197, w: 720, h: 772 })
    // 右端は v1 の内容の右端（150 + 1660 = 1810）を 4:3 に縮めた位置
    expect(boxes.figure!.x + boxes.figure!.w).toBe(1810 * 0.75)

    const cover = canvasCoverLayout(true, '4:3')
    expect(cover.headingArea).toEqual({ x: 112.5, y: 0, w: 1245, h: 860 })
    expect(cover.credits).toEqual({ x: 112.5, y: 800, w: 1245, h: 180 })
  })
})
