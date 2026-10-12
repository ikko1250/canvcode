import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import { adjustOf, type SlideLayoutKind, type SlideLayoutProps, type SlideLayoutSlots } from '@canvcode/nodes'
import { canvasSlideLayout, TABLE_IMAGE_WIDTH_RANGE, type CanvasBox } from '@canvcode/slides'
import { duplicateSelection } from './clipboard.ts'
import { Editor } from './editor.ts'
import { adjustLayoutOptions, adjustWithMovedChildren, patchAdjust, tableHeightPatch } from './slideLayoutAdjust.ts'

// slide-layout（スライド v2）の手で直した配置（props.adjust）。表パネル・右図枠のドラッグと幅のリサイズが adjust になり、並べ直しがそれに従う

const geoBox = (b: CanvasBox) => ({ x: b.x, y: b.y, w: b.w, h: b.h })

describe('patchAdjust', () => {
  it('merges values, drops zeros and undefined, and clamps the table width', () => {
    const a = patchAdjust({}, { table: { dy: -40, w: 99999 } })
    expect(a).toEqual({ table: { dy: -40, w: TABLE_IMAGE_WIDTH_RANGE.max } })
    expect(patchAdjust(a, { table: { dy: 0 }, figure: { dx: 10 } })).toEqual({ table: { w: TABLE_IMAGE_WIDTH_RANGE.max }, figure: { dx: 10 } })
    expect(patchAdjust(a, { table: { dy: undefined, w: undefined } })).toEqual({})
    expect(patchAdjust(a, { title: { dx: 5, dy: -10 } })).toEqual({ ...a, title: { dx: 5, dy: -10 } })
  })

  it('turns into geometry options', () => {
    expect(adjustLayoutOptions({})).toEqual({})
    expect(adjustLayoutOptions({ table: { dy: -40, w: 800, h: 500 }, figure: { dx: 5 } })).toEqual({
      tableWidth: 800,
      tableHeight: 500,
      tableOffset: { dx: 0, dy: -40 },
      figureOffset: { dx: 5, dy: 0 },
    })
    expect(adjustLayoutOptions({ title: { dy: 30 } })).toEqual({ titleOffset: { dx: 0, dy: 30 } })
  })
})

describe('adjustWithMovedChildren for the title', () => {
  const slots: SlideLayoutSlots = { title: 'node:t', panel: 'node:p', rows: [] }
  const node = (id: string, x: number, y: number, props: Record<string, unknown>) => ({ id, x, y, parentId: 'node:l', props }) as unknown as NodeRecord
  const changes = (map: Record<string, [NodeRecord, NodeRecord]>) => (id: string) => (map[id] ? { before: map[id][0], after: map[id][1] } : undefined)

  it('turns a moved title (a text without h) into the title offset', () => {
    const next = adjustWithMovedChildren('table', slots, {}, changes({ 'node:t': [node('node:t', 150, 178, { w: 1660 }), node('node:t', 170, 148, { w: 1660 })] }), 1)
    expect(next).toEqual({ title: { dx: 20, dy: -30 } })
  })

  it('does not write a resized title, nor the part of a move that follows the table panel', () => {
    expect(adjustWithMovedChildren('table', slots, {}, changes({ 'node:t': [node('node:t', 150, 178, { w: 1660 }), node('node:t', 150, 178, { w: 1000 })] }), 1)).toBeNull()
    const both = changes({
      'node:p': [node('node:p', 150, 246, { w: 1660, h: 656 }), node('node:p', 150, 296, { w: 1660, h: 656 })],
      'node:t': [node('node:t', 150, 178, { w: 1660 }), node('node:t', 150, 228, { w: 1660 })],
    })
    expect(adjustWithMovedChildren('table', slots, {}, both, 1)).toEqual({ table: { dy: 50 } })
  })
})

describe('tableHeightPatch', () => {
  it('keeps the panel top where it is, and clamps the height by the row count', () => {
    // 表＋画像 2 行の compact のパネル（上端 350）の高さを決める：高さを決めたパネルの上端は 197 + dy
    expect(tableHeightPatch('table-image', 2, 350, 400)).toEqual({ h: 400, dy: 153 })
    expect(tableHeightPatch('table-image', 2, undefined, 10)).toEqual({ h: 260 })
    expect(tableHeightPatch('table-images', 1, 165, 300)).toEqual({ h: 300, dy: 0 })
    expect(tableHeightPatch('table', 3, 197, undefined)).toEqual({ h: undefined })
    expect(tableHeightPatch('title', 1, 0, 300)).toBeNull()
  })
})

describe('editor keeps the slide-layout adjust', () => {
  function setup(kind: SlideLayoutKind = 'table-image', ratio: '16:9' | '4:3' = '16:9') {
    const editor = new Editor({ canvasId: 'canvas:1' })
    const w = ratio === '4:3' ? 1440 : 1920
    const slide = editor.makeNode('slide', { x: 0, y: 0, props: { ratio, name: 'S1', hidden: false } })
    const layout = editor.makeNode('slide-layout', { x: 0, y: 0, parentId: slide.id, props: { layout: kind, w, h: 1080, slots: { rows: [] } } })
    const rect = () => editor.makeNode('geo', { x: 10, y: 10, parentId: layout.id, props: { shape: 'rect', w: 100, h: 100 } })
    const panel = rect()
    const figure = rect()
    const rows = Array.from({ length: 2 }, () => ({ label: rect(), body: rect() }))
    const slots: SlideLayoutSlots = {
      panel: panel.id,
      ...(kind === 'table-image' ? { figure: figure.id } : {}),
      rows: rows.map((r) => ({ label: r.label.id, body: r.body.id })),
    }
    const children = [panel, ...(kind === 'table-image' ? [figure] : []), ...rows.flatMap((r) => [r.label, r.body])]
    editor.createNodes([slide, { ...layout, props: { ...layout.props, slots } }, ...children], 'create template')
    const box = (id: string) => {
      const n = editor.getNode(id)!
      const p = n.props as { w: number; h: number }
      return { x: n.x, y: n.y, w: p.w, h: p.h }
    }
    const adjust = () => adjustOf((editor.getNode(layout.id)!.props as SlideLayoutProps).adjust)
    return { editor, layout, panel, figure, rows, box, adjust }
  }

  it('keeps a dragged table panel where it was dropped, with its rows', () => {
    const { editor, panel, rows, box, adjust } = setup()
    editor.moveNodes([panel.id], 30, -60)
    expect(adjust()).toEqual({ table: { dx: 30, dy: -60 } })
    const moved = canvasSlideLayout('table-image', 2, '16:9', { tableOffset: { dx: 30, dy: -60 } })
    expect(box(panel.id)).toEqual(geoBox(moved.panel))
    expect(box(rows[0].body.id)).toEqual(geoBox(moved.rows[0].body))
    // 1 回の Undo で、配置も子の位置も戻る
    editor.undo()
    expect(adjust()).toEqual({})
    expect(box(panel.id)).toEqual(geoBox(canvasSlideLayout('table-image', 2).panel))
  })

  it('moves the panel and its selected cells together by the panel delta', () => {
    const { editor, panel, rows, box, adjust } = setup()
    editor.moveNodes([panel.id, rows[0].label.id, rows[0].body.id], 0, -40)
    expect(adjust()).toEqual({ table: { dy: -40 } })
    expect(box(rows[0].body.id)).toEqual(geoBox(canvasSlideLayout('table-image', 2, '16:9', { tableOffset: { dx: 0, dy: -40 } }).rows[0].body))
  })

  it('keeps a dragged figure frame apart from the table', () => {
    const { editor, panel, figure, box, adjust } = setup()
    editor.moveNodes([figure.id], 0, 25)
    expect(adjust()).toEqual({ figure: { dy: 25 } })
    expect(box(figure.id)).toEqual(geoBox(canvasSlideLayout('table-image', 2, '16:9', { figureOffset: { dx: 0, dy: 25 } }).figure!))
    expect(box(panel.id)).toEqual(geoBox(canvasSlideLayout('table-image', 2).panel))
  })

  it('turns a resize of the right edge of the table panel into the table width, and narrows the figure', () => {
    const { editor, panel, figure, rows, box, adjust } = setup()
    editor.transact('resize', (tx) => {
      const n = editor.getNode(panel.id)!
      tx.put({ ...n, props: { ...n.props, w: (n.props as { w: number }).w + 120 } })
    })
    expect(adjust()).toEqual({ table: { w: 800 } })
    const wide = canvasSlideLayout('table-image', 2, '16:9', { tableWidth: 800 })
    expect(box(panel.id)).toEqual(geoBox(wide.panel))
    expect(box(figure.id)).toEqual(geoBox(wide.figure!))
    expect(box(rows[0].body.id).w).toBe(wide.rows[0].body.w)
    const plain = canvasSlideLayout('table-image', 2)
    expect(wide.figure!.x + wide.figure!.w).toBe(plain.figure!.x + plain.figure!.w)
  })

  it('does not change the width of a full-width table panel', () => {
    const { editor, panel, box, adjust } = setup('table')
    editor.transact('resize', (tx) => {
      const n = editor.getNode(panel.id)!
      tx.put({ ...n, props: { ...n.props, w: 500 } })
    })
    expect(adjust()).toEqual({})
    expect(box(panel.id)).toEqual(geoBox(canvasSlideLayout('table', 2).panel))
  })

  it('turns a resize of the bottom edge of the table panel into the panel height, with its top kept', () => {
    const { editor, panel, rows, box, adjust } = setup()
    const before = box(panel.id)
    expect(before).toEqual(geoBox(canvasSlideLayout('table-image', 2).panel))
    editor.transact('resize', (tx) => {
      const n = editor.getNode(panel.id)!
      tx.put({ ...n, props: { ...n.props, h: 400 } })
    })
    // compact のパネル（上端 350）の上端を残す：高さを決めたパネルは 197 + dy に置く
    expect(adjust()).toEqual({ table: { h: 400, dy: before.y - 197 } })
    const fixed = canvasSlideLayout('table-image', 2, '16:9', { tableHeight: 400, tableOffset: { dx: 0, dy: before.y - 197 } })
    expect(box(panel.id)).toEqual({ ...before, h: 400 })
    expect(box(panel.id)).toEqual(geoBox(fixed.panel))
    // 行はパネルの中で配り直す（引き伸ばさない）
    expect(box(rows[1].body.id)).toEqual(geoBox(fixed.rows[1].body))
    expect(box(rows[1].body.id).y + box(rows[1].body.id).h).toBe(before.y + 400 - 40)
    // 1 回の Undo で戻る
    editor.undo()
    expect(adjust()).toEqual({})
    expect(box(panel.id)).toEqual(before)
  })

  it('keeps the bottom edge when the top edge of the table panel is resized, and clamps the height', () => {
    const { editor, panel, box, adjust } = setup()
    const before = box(panel.id)
    const bottom = before.y + before.h
    editor.transact('resize', (tx) => {
      const n = editor.getNode(panel.id)!
      tx.put({ ...n, y: n.y + 100, props: { ...n.props, h: before.h - 100 } })
    })
    expect(adjust()).toEqual({ table: { h: before.h - 100, dy: before.y + 100 - 197 } })
    expect(box(panel.id).y + box(panel.id).h).toBe(bottom)
    // 行が入らない高さにはしない（2 行の下限 260）。縮めた端の方で止まる
    editor.transact('resize', (tx) => {
      const n = editor.getNode(panel.id)!
      tx.put({ ...n, y: bottom - 20, props: { ...n.props, h: 20 } })
    })
    expect(box(panel.id)).toMatchObject({ y: bottom - 260, h: 260 })
    expect(adjust().table?.h).toBe(260)
  })

  it('changes the height of a full-width table panel too', () => {
    const { editor, panel, box, adjust } = setup('table')
    const before = box(panel.id)
    editor.transact('resize', (tx) => {
      const n = editor.getNode(panel.id)!
      tx.put({ ...n, props: { ...n.props, h: 600 } })
    })
    expect(adjust()).toEqual({ table: { h: 600, dy: before.y - 197 } })
    expect(box(panel.id)).toEqual({ ...before, h: 600 })
  })

  it('stores a 4:3 drag in 1920-wide units', () => {
    const { editor, panel, adjust } = setup('table-image', '4:3')
    editor.moveNodes([panel.id], 30, 0)
    expect(adjust()).toEqual({ table: { dx: 40 } })
  })

  it('keeps the adjust when the slide is duplicated', () => {
    const { editor, layout, panel } = setup()
    editor.moveNodes([panel.id], 0, -50)
    const slideId = editor.getNode(layout.id)!.parentId!
    editor.setSelection([slideId])
    const [copy] = duplicateSelection(editor, { x: 0, y: 2000 })
    const copyLayout = editor.index.childrenOf(copy).map((id) => editor.getNode(id)!).find((n) => n.type === 'slide-layout')!
    expect(copyLayout.id).not.toBe(layout.id)
    expect(adjustOf((copyLayout.props as SlideLayoutProps).adjust)).toEqual({ table: { dy: -50 } })
  })
})
