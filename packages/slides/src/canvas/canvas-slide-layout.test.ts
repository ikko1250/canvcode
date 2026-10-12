import { describe, expect, it } from 'vitest'
import {
  canvasCoverLayout,
  canvasSlideLayout,
  placeCoverHeading,
  type CanvasGridSlideBoxes,
} from './canvas-slide-layout.ts'
import { computeSlideGeometry, getMaxRowCount, tablePanelHeightRange } from '../core/slide-layout-spec.ts'

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
    expect(boxes.title.w).toBe(1660)
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

describe('canvasSlideLayout table with a fixed panel height', () => {
  it('drops the compact rule and puts the panel at the full-panel top', () => {
    const boxes = canvasSlideLayout('table', 3, '16:9', { tableHeight: 600 })
    expect(boxes.compact).toBe(false)
    expect(boxes.title.y).toBe(128)
    expect(boxes.panel).toEqual({ x: 150, y: 197, w: 1660, h: 600 })
    // 予算 474（padding 64 + 62 を除く）・間隔 41
    expect(boxes.grid.h).toBe(474)
    expect(boxes.rowPx).toBe(131)
    expect(canvasSlideLayout('bullets', 3, '16:9', { tableHeight: 600 }).panel.h).toBe(600)
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
  it('widens the table and narrows the figure with its right edge kept', () => {
    const wide = canvasSlideLayout('table-image', 4, '16:9', { tableWidth: 800 })
    expect(wide.panel).toEqual({ x: 150, y: 197, w: 800, h: 772 })
    expect(wide.grid.w).toBe(720)
    expect(wide.rows[0]!.body.w).toBe(500)
    expect(wide.figure).toEqual({ x: 970, y: 197, w: 840, h: 772 })
    expect(wide.figureContent).toEqual({ x: 991, y: 218, w: 798, h: 730 })
    // 範囲の外は範囲に収める
    expect(canvasSlideLayout('table-image', 4, '16:9', { tableWidth: 10 }).panel.w).toBe(400)
    expect(canvasSlideLayout('table-image', 4, '16:9', { tableWidth: 5000 }).panel.w).toBe(1400)
  })

  it('moves the table with its rows, and the figure on its own', () => {
    const plain = canvasSlideLayout('table-image', 2)
    const moved = canvasSlideLayout('table-image', 2, '16:9', { tableOffset: { dx: 10, dy: -50 }, figureOffset: { dx: 0, dy: 30 } })
    expect(moved.panel).toEqual({ ...plain.panel, x: 160, y: 300 })
    expect(moved.rows[1]!.body).toEqual({ ...plain.rows[1]!.body, x: plain.rows[1]!.body.x + 10, y: plain.rows[1]!.body.y - 50 })
    expect(moved.figure).toEqual({ ...plain.figure!, y: plain.figure!.y + 30 })
    // タイトルは表パネルの縦のずらし量に付いて動く（横は動かない）
    expect(moved.title).toEqual({ ...plain.title, y: plain.title.y - 50 })
  })

  it('moves the title by its own offset on top of the table offset, and stops it at the top edge', () => {
    const plain = canvasSlideLayout('table', 3)
    const moved = canvasSlideLayout('table', 3, '16:9', { tableOffset: { dx: 40, dy: 20 }, titleOffset: { dx: 5, dy: -10 } })
    expect(moved.title).toEqual({ ...plain.title, x: plain.title.x + 5, y: plain.title.y + 10 })
    const up = canvasSlideLayout('table', 3, '16:9', { tableOffset: { dx: 0, dy: -1000 } })
    expect(up.title.y).toBe(0)
  })

  it('scales the width and the offset in 4:3', () => {
    const narrow = canvasSlideLayout('table-image', 4, '4:3', { tableWidth: 800, tableOffset: { dx: 40, dy: 0 } })
    expect(narrow.panel).toEqual({ x: 142.5, y: 197, w: 600, h: 772 })
  })

  it('gives the table panel a fixed height from the top of the figure, and shares it among the rows', () => {
    const short = canvasSlideLayout('table-image', 2, '16:9', { tableHeight: 500 })
    expect(short.compact).toBe(false)
    expect(short.title.y).toBe(128)
    expect(short.panel).toEqual({ x: 150, y: 197, w: 680, h: 500 })
    // 予算 420（padding 40 × 2 を除く）・間隔 44（全高と同じ）を 2 行で分ける
    expect(short.grid.h).toBe(420)
    expect(short.gapPx).toBe(44)
    expect(short.rowPx).toBe(188)
    expect(rowYs(short)).toEqual([237, 469])
    // 図の枠は変えない。ずらす量は高さを決めたパネルの上端（197）から
    expect(short.figure).toEqual(canvasSlideLayout('table-image', 2).figure)
    expect(canvasSlideLayout('table-image', 2, '16:9', { tableHeight: 500, tableOffset: { dx: 0, dy: 60 } }).panel.y).toBe(257)
    // forceFull より優先する
    expect(canvasSlideLayout('table-image', 2, '16:9', { tableHeight: 500, forceFull: true }).panel.h).toBe(500)
  })

  it('keeps a fixed table height within room for every row and the slide bottom', () => {
    // 2 行：行の最小（68）× 2 ＋ 間隔 44 ＋ padding 80。上限はスライドの下端まで（1080 − 197）
    expect(tablePanelHeightRange('table-image', 2)).toEqual({ min: 260, max: 883 })
    expect(canvasSlideLayout('table-image', 2, '16:9', { tableHeight: 10 }).panel.h).toBe(260)
    expect(canvasSlideLayout('table-image', 2, '16:9', { tableHeight: 5000 }).panel.h).toBe(883)
  })
})

describe('canvasSlideLayout table-images', () => {
  it('places the full-width table at the v1 geometry and the two figures below it', () => {
    const one = canvasSlideLayout('table-images', 1)
    expect(one.title.y).toBe(96)
    expect(one.panel).toEqual({ x: 150, y: 165, w: 1660, h: 213 })
    expect(one.rows[0]).toEqual({
      label: { x: 220, y: 197, w: 394, h: 150 },
      body: { x: 635, y: 197, w: 1105, h: 150 },
    })
    // 2 列（820px・間隔 20px）。上端はパネルの下から 20px、下端は表＋画像の図の枠の下端（969）
    expect(one.figure).toEqual({ x: 150, y: 398, w: 820, h: 571 })
    expect(one.figure2).toEqual({ x: 990, y: 398, w: 820, h: 571 })
    expect(one.figureContent).toBeNull()
    // 行を足すと、パネルが伸びて図が低くなる
    const two = canvasSlideLayout('table-images', 2)
    expect(two.panel.h).toBe(403)
    expect(two.figure).toEqual({ x: 150, y: 588, w: 820, h: 381 })
    expect(canvasSlideLayout('table', 2).figure2).toBeNull()
  })

  it('makes the figures lower as the table panel with a fixed height grows', () => {
    const tall = canvasSlideLayout('table-images', 1, '16:9', { tableHeight: 300 })
    expect(tall.panel).toEqual({ x: 150, y: 165, w: 1660, h: 300 })
    expect(tall.rows[0]!.body.h).toBe(237)
    expect(tall.figure).toEqual({ x: 150, y: 485, w: 820, h: 484 })
    // 図の領域（915 − パネルの高さ）が 300 残る高さまで
    expect(tablePanelHeightRange('table-images', 1).max).toBe(615)
    expect(canvasSlideLayout('table-images', 1, '16:9', { tableHeight: 2000 }).panel.h).toBe(615)
  })

  it('scales the figures in 4:3', () => {
    const narrow = canvasSlideLayout('table-images', 1, '4:3')
    expect(narrow.figure2).toEqual({ x: 742.5, y: 398, w: 615, h: 571 })
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

describe('canvasSlideLayout title width', () => {
  it('matches the panel width (150〜1810, same as the cover title) on every layout', () => {
    const cover = canvasCoverLayout(false)
    for (const layout of ['table', 'bullets', 'table-image', 'table-images'] as const) {
      const boxes = canvasSlideLayout(layout, 2)
      expect(boxes.title.x).toBe(150)
      expect(boxes.title.w).toBe(1660)
      expect(boxes.title.x).toBe(cover.headingArea.x)
      expect(boxes.title.w).toBe(cover.headingArea.w)
    }
    // table-image：左表パネルの左端〜右図枠の右端
    const image = canvasSlideLayout('table-image', 2)
    expect(image.title.x + image.title.w).toBe(image.figure!.x + image.figure!.w)
    expect(image.title.x).toBe(image.panel.x)
  })

  it('does not follow the horizontal offsets and widths of the panel', () => {
    const boxes = canvasSlideLayout('table-image', 2, '16:9', { tableWidth: 900, tableOffset: { dx: 40, dy: 10 }, figureOffset: { dx: 30, dy: 0 } })
    expect(boxes.title.x).toBe(150)
    expect(boxes.title.w).toBe(1660)
  })
})

describe('canvasSlideLayout two-line title (titleExtraPx)', () => {
  const extra = 46 * 1.18

  it('grows a full-panel title upward, keeping its bottom and the panel', () => {
    const one = canvasSlideLayout('table', 4)
    const two = canvasSlideLayout('table', 4, '16:9', { titleExtraPx: extra })
    expect(two.title.y).toBeCloseTo(128 - extra)
    expect(two.title.h).toBeCloseTo(one.title.h + extra)
    expect(two.title.y + two.title.h).toBeCloseTo(one.title.y + one.title.h)
    expect(two.panel).toEqual(one.panel)
    expect(two.rows).toEqual(one.rows)
  })

  it('re-centers the title and the panel together for a compact table or bullets', () => {
    for (const layout of ['table', 'bullets'] as const) {
      const one = canvasSlideLayout(layout, 2)
      const two = canvasSlideLayout(layout, 2, '16:9', { titleExtraPx: 60 })
      expect(two.compact).toBe(true)
      // パネルは増えた分の半分だけ下がり、タイトルは半分だけ上がる
      expect(two.panel.y).toBe(one.panel.y + 30)
      expect(two.title.y).toBe(one.title.y - 30)
      expect(two.panel.y - (two.title.y + two.title.h)).toBeCloseTo(one.panel.y - (one.title.y + one.title.h))
      expect(rowYs(two)).toEqual(rowYs(one).map((y) => y + 30))
      // タイトルとパネルのまとまりが上下中央にある
      expect(two.title.y + (two.panel.y + two.panel.h - two.title.y) / 2).toBeCloseTo(540, 0)
    }
  })

  it('grows the title of table-image and table-images upward without moving the panel or the figures', () => {
    for (const [layout, rows] of [['table-image', 2], ['table-image', 4], ['table-images', 1]] as const) {
      const one = canvasSlideLayout(layout, rows)
      const two = canvasSlideLayout(layout, rows, '16:9', { titleExtraPx: extra })
      expect(two.title.y).toBeCloseTo(one.title.y - extra)
      expect(two.title.y + two.title.h).toBeCloseTo(one.title.y + one.title.h)
      expect(two.panel).toEqual(one.panel)
      expect(two.figure).toEqual(one.figure)
      expect(two.figure2).toEqual(one.figure2)
    }
  })

  it('keeps the title inside the slide, and ignores invalid values', () => {
    expect(canvasSlideLayout('table-images', 1, '16:9', { titleExtraPx: 500 }).title.y).toBe(0)
    expect(canvasSlideLayout('table', 4, '16:9', { titleExtraPx: 500 }).title.y).toBe(0)
    const one = canvasSlideLayout('table', 2)
    expect(canvasSlideLayout('table', 2, '16:9', { titleExtraPx: -10 })).toEqual(one)
    expect(canvasSlideLayout('table', 2, '16:9', { titleExtraPx: Number.NaN })).toEqual(one)
  })

  it('does not change the maximum row counts', () => {
    expect(computeSlideGeometry('table', 6, { titleExtraPx: extra }).grid.defaultRowPx).toBe(computeSlideGeometry('table', 6).grid.defaultRowPx)
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
    expect(narrow.title.w).toBe(1245)
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
