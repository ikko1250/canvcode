import { describe, expect, it } from 'vitest'
import { adjustOf, type SlideLayoutKind, type SlideLayoutProps, type SlideLayoutSlots } from '@canvcode/nodes'
import { canvasSlideLayout, TABLE_IMAGE_WIDTH_RANGE, type CanvasBox } from '@canvcode/slides'
import { duplicateSelection } from './clipboard.ts'
import { Editor } from './editor.ts'
import { adjustLayoutOptions, patchAdjust } from './slideLayoutAdjust.ts'

// slide-layout（スライド v2）の手で直した配置（props.adjust）。表パネル・右図枠のドラッグと幅のリサイズが adjust になり、並べ直しがそれに従う

const geoBox = (b: CanvasBox) => ({ x: b.x, y: b.y, w: b.w, h: b.h })

describe('patchAdjust', () => {
  it('merges values, drops zeros and undefined, and clamps the table width', () => {
    const a = patchAdjust({}, { table: { dy: -40, w: 99999 } })
    expect(a).toEqual({ table: { dy: -40, w: TABLE_IMAGE_WIDTH_RANGE.max } })
    expect(patchAdjust(a, { table: { dy: 0 }, figure: { dx: 10 } })).toEqual({ table: { w: TABLE_IMAGE_WIDTH_RANGE.max }, figure: { dx: 10 } })
    expect(patchAdjust(a, { table: { dy: undefined, w: undefined } })).toEqual({})
  })

  it('turns into geometry options', () => {
    expect(adjustLayoutOptions({})).toEqual({})
    expect(adjustLayoutOptions({ table: { dy: -40, w: 800 }, figure: { dx: 5 } })).toEqual({
      tableWidth: 800,
      tableOffset: { dx: 0, dy: -40 },
      figureOffset: { dx: 5, dy: 0 },
    })
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
