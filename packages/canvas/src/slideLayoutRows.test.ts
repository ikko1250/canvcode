import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import { richTextFromPlain, solidPaint, type SlideLayoutKind, type SlideLayoutProps } from '@canvcode/nodes'
import { canvasSlideBodyFill, canvasSlideLayout } from '@canvcode/slides'
import { Editor } from './editor.ts'
import { slideLayoutMaxRows } from './slideLayoutArrange.ts'
import { emptiedCellProps, insertSlideLayoutRow, slideLayoutRowOf } from './slideLayoutRows.ts'

// slide-layout（スライド v2）の行を足す・消す。並べ直しと地の色の付け直しは、コミットフックが同じ 1 歩で行う

// スライドと、その中の slide-layout（タイトル・パネルと n 行。table なら見出しと本文、bullets なら本文だけ）
function setup(n = 3, layout: SlideLayoutKind = 'table') {
  const editor = new Editor({ canvasId: 'canvas:1' })
  const slide = editor.makeNode('slide', { x: 0, y: 0, props: { ratio: '16:9', name: 'S1', hidden: false } })
  const node = editor.makeNode('slide-layout', { x: 0, y: 0, parentId: slide.id, props: { layout, w: 1920, h: 1080, slots: { rows: [] } } })
  editor.createNodes([slide, node])
  const make = (type: string, props: object) => editor.makeNode(type, { x: 0, y: 0, parentId: node.id, props })
  const cell = (value: string, fill: string, fontSize: number) =>
    make('geo', {
      shape: 'rect',
      w: 100,
      h: 100,
      fill: solidPaint(fill),
      stroke: null,
      label: value,
      labelParagraphs: richTextFromPlain(value, { color: '#333333' }),
      labelFontSize: fontSize,
    })
  const title = make('text', { paragraphs: richTextFromPlain('題名'), fontSize: 40, autoWidth: false, w: 400 })
  const panel = make('geo', { shape: 'rect', w: 100, h: 100 })
  const children: NodeRecord[] = [title, panel]
  const rows: SlideLayoutProps['slots']['rows'] = []
  for (let i = 0; i < n; i++) {
    const body = cell(`本文${i}`, canvasSlideBodyFill(i), 30)
    if (layout === 'bullets') {
      children.push(body)
      rows.push({ body: body.id })
    } else {
      const label = cell(`見出し${i}`, '#ffffff', 28)
      children.push(label, body)
      rows.push({ label: label.id, body: body.id })
    }
  }
  editor.transact('setup', (tx) => {
    for (const child of children) tx.put(child)
    tx.put({ ...node, props: { ...node.props, slots: { title: title.id, panel: panel.id, rows } } })
  })
  const slots = () => (editor.getNode(node.id)!.props as SlideLayoutProps).slots
  const get = (id: string) => editor.getNode(id)!
  const box = (id: string) => {
    const r = get(id)
    return { x: r.x, y: r.y, w: (r.props as { w: number }).w }
  }
  return { editor, slide, layout: node, title: title.id, panel: panel.id, slots, get, box }
}

// 行数の上限（セルの文字の大きさで決まる。行はみな同じ書式なので、1 行で測る）
function maxRows(layout: SlideLayoutKind = 'table'): number {
  const { editor, slots } = setup(1, layout)
  return slideLayoutMaxRows(layout, slots().rows, (id) => (id ? (editor.getNode(id) ?? undefined) : undefined))
}

const selected = (editor: Editor) => [...editor.session.get().selectedIds]
const fillColor = (node: NodeRecord) => (node.props as { fill: { color: string } }).fill.color

describe('slide-layout rows: pure helpers', () => {
  it('finds the row of a cell and inserts a row', () => {
    const rows = [{ label: 'l0', body: 'b0' }, { body: 'b1' }]
    expect(slideLayoutRowOf(rows, 'l0')).toBe(0)
    expect(slideLayoutRowOf(rows, 'b1')).toBe(1)
    expect(slideLayoutRowOf(rows, 'x')).toBe(-1)
    expect(insertSlideLayoutRow({ title: 't', rows }, 1, { body: 'n' }).rows).toEqual([{ label: 'l0', body: 'b0' }, { body: 'n' }, { body: 'b1' }])
    expect(insertSlideLayoutRow({ rows }, 9, { body: 'n' }).rows.at(-1)).toEqual({ body: 'n' })
  })

  it('empties the text of a cell and keeps its format', () => {
    const props = { w: 10, fill: solidPaint('#fff'), label: 'abc', labelParagraphs: richTextFromPlain('a\nb', { color: '#123456' }), labelFontSize: 30 }
    expect(emptiedCellProps(props)).toEqual({ ...props, label: '', labelParagraphs: [{ runs: [{ text: '', format: { color: '#123456' } }] }] })
    const list = [{ runs: [{ text: 'x' }], list: { type: 'bullet', level: 1 } }, { runs: [{ text: 'y' }] }]
    expect(emptiedCellProps({ paragraphs: list, fontSize: 40 })).toEqual({ paragraphs: [{ runs: [{ text: '' }], list: { type: 'bullet', level: 1 } }], fontSize: 40 })
  })
})

describe('addSlideLayoutRow', () => {
  it('adds a row below the selected row, copies the format with empty text, rearranges everything and selects the new body', () => {
    const { editor, slots, get, box, title, panel } = setup(3)
    const three = canvasSlideLayout('table', 3)
    expect(box(title)).toEqual({ x: three.title.x, y: three.title.y, w: three.title.w })
    const before = slots().rows
    editor.setSelection([before[0].label!])
    expect(editor.slideLayoutRowState()).toEqual({ canAdd: true, canRemove: true, manualHeight: false, rowCount: 3, maxRows: maxRows() })
    expect(editor.addSlideLayoutRow()).toBe(true)

    const rows = slots().rows
    expect(rows).toHaveLength(4)
    expect(rows[0]).toEqual(before[0])
    expect(rows.slice(2)).toEqual(before.slice(1))
    const added = rows[1]
    expect(selected(editor)).toEqual([added.body])
    // 書式は 1 行目のセルを写し、文字だけが空
    const body = get(added.body)
    const label = get(added.label!)
    expect(body.parentId).toBe(get(before[0].body).parentId)
    expect(body.props).toMatchObject({ label: '', labelParagraphs: [{ runs: [{ text: '', format: { color: '#333333' } }] }], labelFontSize: 30, stroke: null })
    expect(label.props).toMatchObject({ label: '', labelFontSize: 28, fill: solidPaint('#ffffff') })

    // 4 行の幾何で、タイトル・パネル・すべての行が並べ直される
    const four = canvasSlideLayout('table', 4)
    expect(four.title.y).not.toBe(three.title.y)
    expect(box(title)).toEqual({ x: four.title.x, y: four.title.y, w: four.title.w })
    expect(box(panel)).toEqual({ x: four.panel.x, y: four.panel.y, w: four.panel.w })
    rows.forEach((row, i) => {
      expect(box(row.body)).toEqual({ x: four.rows[i].body.x, y: four.rows[i].body.y, w: four.rows[i].body.w })
      expect(box(row.label!)).toEqual({ x: four.rows[i].label!.x, y: four.rows[i].label!.y, w: four.rows[i].label!.w })
    })
    // 地の色は行の順に付け直す（新しい 2 行目は 1 行目から写した色のまま、もとの 3 行目以降は 3 行目以降の色）
    expect(rows.map((row) => fillColor(get(row.body)))).toEqual([0, 1, 2, 3].map(canvasSlideBodyFill))
    expect(fillColor(get(before[1].body))).toBe(canvasSlideBodyFill(2))
  })

  it('appends a row at the end when the slide, the layout or a non-row child is selected', () => {
    for (const pick of ['slide', 'layout', 'title'] as const) {
      const { editor, slots, get, slide, layout, title } = setup(2)
      editor.setSelection([pick === 'slide' ? slide.id : pick === 'layout' ? layout.id : title])
      expect(editor.slideLayoutRowState()?.canRemove).toBe(false)
      expect(editor.addSlideLayoutRow()).toBe(true)
      const rows = slots().rows
      expect(rows).toHaveLength(3)
      expect(selected(editor)).toEqual([rows[2].body])
      // 最後の行（2 行目）から写し、3 行目の色に付け直す
      expect(fillColor(get(rows[2].body))).toBe(canvasSlideBodyFill(2))
    }
  })

  it('adds a body-only row for bullets', () => {
    const { editor, slots } = setup(2, 'bullets')
    editor.setSelection([slots().rows[1].body])
    expect(editor.addSlideLayoutRow()).toBe(true)
    expect(slots().rows).toHaveLength(3)
    expect(slots().rows[2].label).toBeUndefined()
  })

  it('returns false at the maximum, and does nothing for the cover or outside a slide-layout', () => {
    const max = maxRows()
    const full = setup(max)
    full.editor.setSelection([full.slots().rows[0].body])
    expect(full.editor.slideLayoutRowState()).toEqual({ canAdd: false, canRemove: true, manualHeight: false, rowCount: max, maxRows: max })
    let events = 0
    const unlisten = full.editor.store.listen(() => (events += 1))
    expect(full.editor.addSlideLayoutRow()).toBe(false)
    unlisten()
    expect(events).toBe(0)
    expect(full.slots().rows).toHaveLength(max)

    const cover = setup(0, 'title')
    cover.editor.setSelection([cover.slide.id])
    expect(cover.editor.slideLayoutRowState()).toBeNull()
    expect(cover.editor.addSlideLayoutRow()).toBe(false)
    expect(cover.slots().rows).toEqual([])

    const plain = setup(2)
    const rect = plain.editor.makeNode('geo', { x: 3000, y: 0, props: { shape: 'rect', w: 10, h: 10 } })
    plain.editor.createNodes([rect])
    plain.editor.setSelection([rect.id])
    expect(plain.editor.slideLayoutRowState()).toBeNull()
    expect(plain.editor.addSlideLayoutRow()).toBe(false)
    plain.editor.setSelection([])
    expect(plain.editor.slideLayoutRowState()).toBeNull()
  })

  it('undoes in one step', () => {
    const { editor, slots, box, title, layout } = setup(3)
    const rows = slots().rows
    const titleBefore = box(title)
    editor.setSelection([rows[2].body])
    editor.addSlideLayoutRow()
    expect(slots().rows).toHaveLength(4)
    expect(editor.undo()).toBe(true)
    expect(slots().rows).toEqual(rows)
    expect(box(title)).toEqual(titleBefore)
    expect(editor.getNode(rows[2].body)).toBeDefined()
    expect(editor.index.childrenOf(layout.id)).toHaveLength(2 + 6)
    expect(selected(editor)).toEqual([rows[2].body])
  })
})

describe('removeSlideLayoutRow', () => {
  it('removes the row of the selected cell and closes up the rows', () => {
    const { editor, slots, get, box, title } = setup(4)
    const before = slots().rows
    editor.setSelection([before[1].label!])
    expect(editor.removeSlideLayoutRow()).toBe(true)
    expect(slots().rows).toEqual([before[0], before[2], before[3]])
    expect(editor.getNode(before[1].body)).toBeUndefined()
    expect(editor.getNode(before[1].label!)).toBeUndefined()
    // その位置に来た行の本文を選ぶ
    expect(selected(editor)).toEqual([before[2].body])
    const three = canvasSlideLayout('table', 3)
    expect(box(title)).toEqual({ x: three.title.x, y: three.title.y, w: three.title.w })
    expect(box(before[2].body)).toEqual({ x: three.rows[1].body.x, y: three.rows[1].body.y, w: three.rows[1].body.w })
    // 地の色も詰めた順に付け直す（3 行目だったものが 2 行目に）
    expect(fillColor(get(before[2].body))).toBe(canvasSlideBodyFill(1))
    expect(fillColor(get(before[3].body))).toBe(canvasSlideBodyFill(2))

    // 最後の行を消すと、1 つ上の行の本文を選ぶ
    editor.setSelection([before[3].body])
    expect(editor.removeSlideLayoutRow()).toBe(true)
    expect(selected(editor)).toEqual([before[2].body])
  })

  it('does not remove the last row, nor without a selected cell', () => {
    const one = setup(1)
    one.editor.setSelection([one.slots().rows[0].body])
    expect(one.editor.slideLayoutRowState()).toEqual({ canAdd: true, canRemove: false, manualHeight: false, rowCount: 1, maxRows: maxRows() })
    expect(one.editor.removeSlideLayoutRow()).toBe(false)
    expect(one.slots().rows).toHaveLength(1)

    const two = setup(2)
    two.editor.setSelection([two.slide.id])
    expect(two.editor.removeSlideLayoutRow()).toBe(false)
    two.editor.setSelection([two.title])
    expect(two.editor.removeSlideLayoutRow()).toBe(false)
    expect(two.slots().rows).toHaveLength(2)
  })

  it('undoes in one step', () => {
    const { editor, slots, get, box, title } = setup(3)
    const rows = slots().rows
    const titleBefore = box(title)
    const fills = rows.map((row) => fillColor(get(row.body)))
    editor.setSelection([rows[0].body])
    editor.removeSlideLayoutRow()
    expect(editor.undo()).toBe(true)
    expect(slots().rows).toEqual(rows)
    expect(box(title)).toEqual(titleBefore)
    expect(rows.map((row) => fillColor(get(row.body)))).toEqual(fills)
    expect(selected(editor)).toEqual([rows[0].body])
  })
})
