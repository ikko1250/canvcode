import { describe, expect, it } from 'vitest'
import { canvasSlideLayout } from './canvas-slide-layout.ts'
import { canvasSlideRowHeights } from './canvas-slide-rows.ts'
import { analyzeMeasuredRows } from '../core/slide-row-capacity.ts'
import { minRowPx } from '../core/slide-layout-spec.ts'

// スライド v2 の行の高さの配分：自動は v1 の行容量の規則（analyzeMeasuredRows）、手で決めた行はその高さを優先する
// （表 3 行は compact で予算 530・間隔 40・一律 150、全高で予算 646・間隔 41。表 4 行は全高で一律 131。minRowPx は 68）

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)

describe('canvasSlideRowHeights: auto', () => {
  it('keeps the uniform v1 row height when every row fits', () => {
    expect(minRowPx()).toBe(68)
    expect(canvasSlideRowHeights('table', [60, 150, 90])).toEqual({ rowHeights: [150, 150, 150], forceFull: false, classification: 'ok' })
    expect(canvasSlideRowHeights('table', [60, 60, 60, 60])).toEqual({ rowHeights: [131, 131, 131, 131], forceFull: false, classification: 'ok' })
  })

  it('makes a row with more text taller, with the v1 rebalance (partial)', () => {
    const result = canvasSlideRowHeights('table', [60, 300, 60, 60])
    expect(result.classification).toBe('partial')
    expect(result.forceFull).toBe(false)
    // 必要高さ（最小 68）に、余り（523 − 504 = 19）を等しく足す（端数は上の行から）。合計は予算から間隔を除いたもの
    expect(result.rowHeights).toEqual([73, 305, 73, 72])
    expect(sum(result.rowHeights)).toBe(646 - 3 * 41)
    // 行容量の規則（analyzeMeasuredRows）と同じ再配分
    expect(result.rowHeights).toEqual(analyzeMeasuredRows('table', 4, () => [60, 300, 60, 60]).rowHeights)
  })

  it('switches from the compact panel to the full panel when the rows do not fit the compact one', () => {
    // 3 行の compact（行に使える高さ 450）には入らないが、全高（564）には入る
    const result = canvasSlideRowHeights('table', [340, 60, 60])
    expect(result.forceFull).toBe(true)
    expect(result.classification).toBe('partial')
    expect(sum(result.rowHeights)).toBe(646 - 2 * 41)
    expect(result.rowHeights[0]).toBeGreaterThanOrEqual(340)
    // 全高でも入らなければ、v1 と同じく compact の一律の高さのまま（あふれは警告に任せる）
    expect(canvasSlideRowHeights('table', [600, 60, 60])).toEqual({ rowHeights: [150, 150, 150], forceFull: false, classification: 'over_budget' })
  })
})

describe('canvasSlideRowHeights: fixed rows', () => {
  it('keeps a fixed height and shares the rest among the auto rows', () => {
    const result = canvasSlideRowHeights('table', [60, 60, 60, 60], [undefined, 250])
    expect(result.rowHeights[1]).toBe(250)
    // 残り（523 − 250 = 273）を 3 行で分ける（端数は上の行から）
    expect(result.rowHeights).toEqual([91, 250, 91, 91])
    // 自動の行の必要高さの合計（68 + 150 + 68）が残り（273）を超えれば、高い行から縮める
    expect(canvasSlideRowHeights('table', [60, 60, 150, 60], [undefined, 250]).rowHeights).toEqual([68, 250, 137, 68])
  })

  it('switches to the full panel when a fixed row does not fit the compact one', () => {
    const result = canvasSlideRowHeights('table', [60, 60], [400])
    expect(result.forceFull).toBe(true)
    expect(result.rowHeights[0]).toBe(400)
    expect(sum(result.rowHeights)).toBe(646 - 41)
  })

  it('shrinks the tall auto rows first, then scales the fixed rows down', () => {
    // 自動の行を縮めれば入る：低い行は必要高さのまま、高い行をそろえて詰める
    const shrunk = canvasSlideRowHeights('table', [60, 300, 300, 60], [200])
    expect(shrunk.rowHeights[0]).toBe(200)
    expect(shrunk.rowHeights[3]).toBe(68)
    expect(shrunk.rowHeights[1]).toBeCloseTo(shrunk.rowHeights[2]!)
    expect(sum(shrunk.rowHeights)).toBeCloseTo(523)
    // 自動の行を最小にしても入らなければ、手で決めた行を比で縮める
    const scaled = canvasSlideRowHeights('table', [60, 60, 60, 60], [400, 300])
    expect(scaled.rowHeights.slice(2)).toEqual([68, 68])
    expect(scaled.rowHeights[0]! / scaled.rowHeights[1]!).toBeCloseTo(4 / 3)
    expect(sum(scaled.rowHeights)).toBeCloseTo(523)
  })

  it('leaves the space below when every row is fixed and short', () => {
    expect(canvasSlideRowHeights('table', [60, 60, 60, 60], [100, 100, 100, 100]).rowHeights).toEqual([100, 100, 100, 100])
    // 入らなければ比で縮める
    expect(sum(canvasSlideRowHeights('table', [60, 60, 60, 60], [200, 200, 200, 200]).rowHeights)).toBeCloseTo(523)
  })

  it('shares a fixed table panel height instead of stretching the auto row to the full panel', () => {
    // 表＋画像 2 行で、2 行目を手で 216 にしたもの：全高のパネル（行に使える高さ 648）では、自動の 1 行目が残りの 432 に伸びる
    expect(canvasSlideRowHeights('table-image', [300, 60], [undefined, 216])).toMatchObject({ rowHeights: [432, 216], forceFull: true })
    // パネルの高さを 640 にすれば（行に使える高さ 640 − 80 − 44 = 516）、1 行目は必要高さ（300）になる
    const fixed = canvasSlideRowHeights('table-image', [300, 60], [undefined, 216], { tableHeight: 640 })
    expect(fixed.rowHeights).toEqual([300, 216])
    expect(fixed.forceFull).toBe(false)
    // 自動の行だけでも、その高さの予算（474 − 間隔 82 = 392）で配る（一律の高さは v1 と同じく 1px に丸める）
    expect(canvasSlideRowHeights('table', [60, 60, 60], [], { tableHeight: 600 }).rowHeights).toEqual([131, 131, 131])
  })

  it('places the rows with their heights', () => {
    const boxes = canvasSlideLayout('table', 3, '16:9', { rowHeights: [100, 200, 150] })
    expect(boxes.rows.map((row) => [row.body.y, row.body.h])).toEqual([
      [310, 100],
      [450, 200],
      [690, 150],
    ])
    expect(boxes.rows[1]!.label).toMatchObject({ y: 450, h: 200 })
    // 数が合わなければ一律
    expect(canvasSlideLayout('table', 3, '16:9', { rowHeights: [1] }).rows.map((row) => row.body.h)).toEqual([150, 150, 150])
  })
})
