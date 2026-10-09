import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import { richTextFromPlain, type SlideLayoutKind, type SlideLayoutProps, type SlideLayoutSlots, type SlideRatio } from '@canvcode/nodes'
import { canvasSlideBodyFill, canvasSlideLayout, getMaxRowCount, placeCoverHeading, type CanvasBox } from '@canvcode/slides'
import { Editor } from './editor.ts'
import { arrangeSlideLayout, pruneSlideLayoutRows, slideBodyFillFor, type SlideLayoutArrangement } from './slideLayoutArrange.ts'

// slide-layout（スライド v2）の子の並べ直し。純粋な計算と、Editor がトランザクションの終わりに並べ直すこと

function node(id: string, type: string, props: Record<string, unknown>, x = 0, y = 0): NodeRecord {
  return { typeName: 'node', id, type, parentId: 'layout', x, y, rotation: 0, index: 'a0', opacity: 1, locked: false, props, meta: {} }
}
const geo = (id: string, x = 0, y = 0) => node(id, 'geo', { shape: 'rect', w: 100, h: 100 }, x, y)
const text = (id: string, x = 0, y = 0) => node(id, 'text', { paragraphs: richTextFromPlain(id), fontSize: 40, autoWidth: false, w: 300 }, x, y)
const layoutNode = (layout: SlideLayoutKind, slots: SlideLayoutSlots, ratio: SlideRatio = '16:9'): NodeRecord<SlideLayoutProps> => ({
  ...node('layout', 'slide-layout', {}),
  parentId: 'slide',
  props: { layout, w: ratio === '4:3' ? 1440 : 1920, h: 1080, slots },
})

// 表の子（タイトル・パネル・行の見出しと本文）を n 行分作る
function tableChildren(n: number): { slots: SlideLayoutSlots; children: Map<string, NodeRecord> } {
  const list = [text('title', 5, 5), geo('panel', 7, 7)]
  const rows: SlideLayoutSlots['rows'] = []
  for (let i = 0; i < n; i++) {
    list.push(geo(`label${i}`, i, i), geo(`body${i}`, i, i))
    rows.push({ label: `label${i}`, body: `body${i}` })
  }
  return { slots: { title: 'title', panel: 'panel', rows }, children: new Map(list.map((n) => [n.id, n])) }
}

const arrange = (layout: NodeRecord, children: Map<string, NodeRecord>, ratio: SlideRatio = '16:9', heights: Record<string, number> = {}) =>
  arrangeSlideLayout({ layout, children, ratio, textHeight: (n) => heights[n.id] ?? 50 })

// 並べ直しを当てたあとの子
function applied(children: Map<string, NodeRecord>, result: SlideLayoutArrangement): Map<string, NodeRecord> {
  const out = new Map(children)
  for (const u of result.updates) {
    const n = out.get(u.id)!
    out.set(u.id, { ...n, x: u.x, y: u.y, props: { ...n.props, ...u.props } })
  }
  return out
}

const at = (n: NodeRecord) => ({ x: n.x, y: n.y, ...(n.type === 'text' ? { w: (n.props as { w: number }).w } : { w: (n.props as { w: number }).w, h: (n.props as { h: number }).h }) })
const geoBox = (b: CanvasBox) => ({ x: b.x, y: b.y, w: b.w, h: b.h })
const textBox = (b: CanvasBox) => ({ x: b.x, y: b.y, w: b.w })

function expectGrid(children: Map<string, NodeRecord>, rowCount: number, ratio: SlideRatio = '16:9') {
  const boxes = canvasSlideLayout('table', rowCount, ratio)
  expect(at(children.get('title')!)).toEqual(textBox(boxes.title))
  expect(at(children.get('panel')!)).toEqual(geoBox(boxes.panel))
  for (let i = 0; i < rowCount; i++) {
    expect(at(children.get(`label${i}`)!)).toEqual(geoBox(boxes.rows[i].label!))
    expect(at(children.get(`body${i}`)!)).toEqual(geoBox(boxes.rows[i].body))
  }
}

describe('arrangeSlideLayout', () => {
  it('places a table like the v1 geometry, and moves everything when a row is added', () => {
    const three = tableChildren(3)
    const result = arrange(layoutNode('table', three.slots), three.children)
    expect(result.rowCount).toBe(3)
    expect(result.overflowRows).toBe(0)
    const placed = applied(three.children, result)
    expectGrid(placed, 3)
    // 4 行目を足すと、タイトル・パネル・すべての行が 4 行の幾何に動く（compact でなくなる）
    const four = tableChildren(4)
    for (const [id, n] of placed) four.children.set(id, n)
    expectGrid(applied(four.children, arrange(layoutNode('table', four.slots), four.children)), 4)
    expect(canvasSlideLayout('table', 3).title.y).not.toBe(canvasSlideLayout('table', 4).title.y)
  })

  it('narrows the horizontal sizes for 4:3', () => {
    const { slots, children } = tableChildren(2)
    const placed = applied(children, arrange(layoutNode('table', slots, '4:3'), children, '4:3'))
    expectGrid(placed, 2, '4:3')
    expect(placed.get('panel')!.x).toBe(150 * 0.75)
  })

  it('returns only the children that change', () => {
    const { slots, children } = tableChildren(3)
    const layout = layoutNode('table', slots)
    const placed = applied(children, arrange(layout, children))
    expect(arrange(layout, placed).updates).toEqual([])
    // 1 つだけずらすと、それだけを返す（位置だけなら props は持たない）
    placed.set('body1', { ...placed.get('body1')!, x: 0 })
    const { updates } = arrange(layout, placed)
    expect(updates).toEqual([{ id: 'body1', x: canvasSlideLayout('table', 3).rows[1].body.x, y: canvasSlideLayout('table', 3).rows[1].body.y }])
  })

  it('ignores ids that are not children, and counts only rows whose body exists', () => {
    const { slots, children } = tableChildren(2)
    slots.rows.splice(1, 0, { label: 'gone-label', body: 'gone' }, { body: '' })
    slots.figure = 'gone-figure'
    const result = arrange(layoutNode('table', slots), children)
    expect(result.rowCount).toBe(2)
    expect(result.updates.map((u) => u.id)).not.toContain('gone')
    expectGrid(applied(children, result), 2)
  })

  it('places up to the maximum rows and leaves the rest where they are', () => {
    const max = getMaxRowCount('table')
    const { slots, children } = tableChildren(max + 2)
    const result = arrange(layoutNode('table', slots), children)
    expect(result.rowCount).toBe(max)
    expect(result.overflowRows).toBe(2)
    const ids = result.updates.map((u) => u.id)
    expect(ids).not.toContain(`body${max}`)
    expect(ids).not.toContain(`label${max + 1}`)
    expectGrid(applied(children, result), max)
  })

  it('places the title and the panel for one row when there are no rows', () => {
    const { slots, children } = tableChildren(0)
    const result = arrange(layoutNode('table', slots), children)
    expect(result.rowCount).toBe(0)
    const placed = applied(children, result)
    const one = canvasSlideLayout('table', 1)
    expect(at(placed.get('title')!)).toEqual(textBox(one.title))
    expect(at(placed.get('panel')!)).toEqual(geoBox(one.panel))
  })

  it('places the figure of table-image, and the body only for bullets', () => {
    const { slots, children } = tableChildren(1)
    children.set('figure', geo('figure'))
    const placed = applied(children, arrange(layoutNode('table-image', { ...slots, figure: 'figure' }), children))
    expect(at(placed.get('figure')!)).toEqual(geoBox(canvasSlideLayout('table-image', 1).figure!))
    const bullets = applied(children, arrange(layoutNode('bullets', slots), children))
    expect(at(bullets.get('body0')!)).toEqual(geoBox(canvasSlideLayout('bullets', 1).rows[0].body))
    // bullets には見出しの箱がないので、見出しは動かさない
    expect(at(bullets.get('label0')!)).toEqual({ x: 0, y: 0, w: 100, h: 100 })
  })

  it('centers the cover heading vertically from the measured heights', () => {
    const children = new Map([text('title'), text('subtitle'), geo('credits')].map((n) => [n.id, n]))
    const slots: SlideLayoutSlots = { title: 'title', subtitle: 'subtitle', credits: 'credits', rows: [] }
    const placed = applied(children, arrange(layoutNode('title', slots), children, '16:9', { title: 120, subtitle: 60 }))
    const cover = canvasSlideLayout('title', 1, '16:9', { hasCredits: true })
    const heading = placeCoverHeading(cover, 120, 60)
    expect(at(placed.get('title')!)).toEqual(textBox(heading.title))
    expect(at(placed.get('subtitle')!)).toEqual(textBox(heading.subtitle!))
    expect(at(placed.get('credits')!)).toEqual(geoBox(cover.credits!))
    // タイトル・間隔・副題をまとめた中心が、見出しの領域の中心にある
    expect(placed.get('title')!.y + (120 + cover.subtitleGap + 60) / 2).toBeCloseTo(cover.headingCenterY)

    // credits が無ければ、credits の帯の無い表紙の幾何で置く
    const noCredits = applied(children, arrange(layoutNode('title', { title: 'title', rows: [] }), children, '16:9', { title: 120 }))
    const bare = canvasSlideLayout('title', 1, '16:9', { hasCredits: false })
    expect(at(noCredits.get('title')!)).toEqual(textBox(placeCoverHeading(bare, 120).title))
    expect(bare.headingCenterY).not.toBe(cover.headingCenterY)
  })

  it('does nothing for an unknown layout', () => {
    const { slots, children } = tableChildren(1)
    expect(arrange(layoutNode('nope' as SlideLayoutKind, slots), children).updates).toEqual([])
  })
})

describe('slideBodyFillFor', () => {
  const A = canvasSlideBodyFill(0)
  const B = canvasSlideBodyFill(2)
  const solid = (color: string, opacity = 1) => ({ type: 'solid', color, opacity })

  it('recolors a v1 body fill to the color of its row, keeping the opacity', () => {
    expect(A).not.toBe(B)
    expect(slideBodyFillFor(solid(A), 2)).toEqual(solid(B))
    expect(slideBodyFillFor(solid(B, 0.5), 1)).toEqual(solid(A, 0.5))
    // 大文字で書いた色も v1 の色とみなす
    expect(slideBodyFillFor(solid(B.toUpperCase()), 0)).toEqual(solid(A))
  })

  it('keeps a fill that already matches, a color the user chose, and no fill', () => {
    expect(slideBodyFillFor(solid(A), 1)).toBeNull()
    expect(slideBodyFillFor(solid(B), 5)).toBeNull()
    expect(slideBodyFillFor(solid('#ff0000'), 2)).toBeNull()
    expect(slideBodyFillFor(null, 2)).toBeNull()
    expect(slideBodyFillFor(undefined, 2)).toBeNull()
    expect(slideBodyFillFor({ type: 'linear', color: A }, 2)).toBeNull()
  })

  it('recolors the bodies by their row order when arranging', () => {
    const { slots, children } = tableChildren(3)
    // 1 行目に 3 行目以降の色、3 行目に 1・2 行目の色が付いている（並べ替えたあと）。2 行目は利用者の色
    const fills = [solid(B), solid('#123456'), solid(A)]
    for (let i = 0; i < 3; i++) {
      const n = children.get(`body${i}`)!
      children.set(n.id, { ...n, props: { ...n.props, fill: fills[i] } })
    }
    const placed = applied(children, arrange(layoutNode('table', slots), children))
    const fill = (id: string) => (placed.get(id)!.props as Record<string, unknown>).fill
    expect(fill('body0')).toEqual(solid(A))
    expect(fill('body1')).toEqual(solid('#123456'))
    expect(fill('body2')).toEqual(solid(B))
    // 見出しの色は変えない
    expect(fill('label0')).toBeUndefined()
    // 合っていれば、並べ直しても書かない
    expect(arrange(layoutNode('table', slots), placed).updates).toEqual([])
  })
})

describe('pruneSlideLayoutRows', () => {
  it('drops the rows whose body is gone and returns their labels that are still children', () => {
    const slots: SlideLayoutSlots = { title: 't', rows: [{ label: 'l0', body: 'b0' }, { label: 'l1', body: '' }, { label: 'l2', body: 'b2' }, { body: 'b3' }] }
    const isChild = (id: string) => ['t', 'l0', 'b0', 'l1', 'l2'].includes(id)
    expect(pruneSlideLayoutRows(slots, isChild)).toEqual({ slots: { title: 't', rows: [{ label: 'l0', body: 'b0' }] }, removedLabels: ['l1', 'l2'] })
    expect(pruneSlideLayoutRows({ rows: [{ label: 'l0', body: 'b0' }] }, isChild)).toBeNull()
  })
})

describe('editor arranges slide-layouts', () => {
  function setup(rowCount = 3) {
    const editor = new Editor({ canvasId: 'canvas:1' })
    const slide = editor.makeNode('slide', { x: 0, y: 0, props: { ratio: '16:9', name: 'S1', hidden: false } })
    const layout = editor.makeNode('slide-layout', { x: 0, y: 0, parentId: slide.id, props: { layout: 'table', w: 1920, h: 1080, slots: { rows: [] } } })
    const make = (type: string, props: object) => editor.makeNode(type, { x: 10, y: 10, parentId: layout.id, props })
    const title = make('text', { paragraphs: richTextFromPlain('題名'), fontSize: 40, autoWidth: false, w: 400 })
    const panel = make('geo', { shape: 'rect', w: 100, h: 100 })
    const rows = Array.from({ length: rowCount }, () => ({ label: make('geo', { shape: 'rect', w: 100, h: 100 }), body: make('geo', { shape: 'rect', w: 100, h: 100 }) }))
    const slots: SlideLayoutSlots = { title: title.id, panel: panel.id, rows: rows.map((r) => ({ label: r.label.id, body: r.body.id })) }
    // テンプレート（C6）の代わりに、1 回の操作で置く
    editor.createNodes([slide, { ...layout, props: { ...layout.props, slots } }, title, panel, ...rows.flatMap((r) => [r.label, r.body])], 'create template')
    const box = (id: string) => {
      const n = editor.getNode(id)!
      const p = n.props as { w: number; h: number }
      return { x: n.x, y: n.y, w: p.w, h: p.h }
    }
    const slotsOf = () => (editor.getNode(layout.id)!.props as SlideLayoutProps).slots
    return { editor, slide, layout, title, panel, rows, box, slotsOf }
  }

  it('arranges the children in the transaction that places them', () => {
    const { editor, panel, rows, box } = setup(3)
    const boxes = canvasSlideLayout('table', 3)
    expect(box(panel.id)).toEqual(geoBox(boxes.panel))
    expect(box(rows[2].body.id)).toEqual(geoBox(boxes.rows[2].body))
    // 置いたのと同じ 1 歩
    editor.undo()
    expect(editor.getNode(panel.id)).toBeUndefined()
  })

  it('closes up the rows when a body is deleted, removes its label, and undoes all in one step', () => {
    const { editor, panel, rows, box, slotsOf } = setup(3)
    const before = slotsOf()
    editor.deleteNodes([rows[1].body.id])
    expect(editor.getNode(rows[1].label.id)).toBeUndefined()
    expect(slotsOf().rows).toEqual([before.rows[0], before.rows[2]])
    const two = canvasSlideLayout('table', 2)
    expect(box(panel.id)).toEqual(geoBox(two.panel))
    expect(box(rows[2].body.id)).toEqual(geoBox(two.rows[1].body))
    expect(box(rows[2].label.id)).toEqual(geoBox(two.rows[1].label!))
    // 1 回の Undo で、本文・見出し・slots・位置が戻る
    expect(editor.undo()).toBe(true)
    expect(editor.getNode(rows[1].label.id)).toBeDefined()
    expect(editor.getNode(rows[1].body.id)).toBeDefined()
    expect(slotsOf()).toEqual(before)
    expect(box(rows[2].body.id)).toEqual(geoBox(canvasSlideLayout('table', 3).rows[2].body))
    // Redo でまた詰まる（並べ直しは二重に走らない）
    expect(editor.redo()).toBe(true)
    expect(slotsOf().rows).toEqual([before.rows[0], before.rows[2]])
    expect(box(rows[2].body.id)).toEqual(geoBox(two.rows[1].body))
    expect(editor.undo()).toBe(true)
    expect(editor.undo()).toBe(true)
    expect(editor.getNode(panel.id)).toBeUndefined()
  })

  it('puts a cell moved within the layout back in place', () => {
    const { editor, panel, rows, box } = setup(2)
    const placed = box(rows[0].body.id)
    editor.moveNodes([rows[0].body.id, rows[1].label.id], 120, 40)
    expect(box(rows[0].body.id)).toEqual(placed)
    expect(box(panel.id)).toEqual(geoBox(canvasSlideLayout('table', 2).panel))
    // 何も変わらなかった操作は、履歴に入らない
    editor.undo()
    expect(editor.getNode(panel.id)).toBeUndefined()
  })

  it('rearranges when the ratio of the slide is toggled', () => {
    const { editor, slide, panel, rows, box } = setup(2)
    editor.setSelection([slide.id])
    editor.toggleSlideRatio()
    const narrow = canvasSlideLayout('table', 2, '4:3')
    expect(box(panel.id)).toEqual(geoBox(narrow.panel))
    expect(box(rows[1].label.id)).toEqual(geoBox(narrow.rows[1].label!))
    editor.undo()
    expect(box(panel.id)).toEqual(geoBox(canvasSlideLayout('table', 2).panel))
  })

  it('runs once per transaction and does not touch unrelated changes', () => {
    const { editor, layout, rows } = setup(2)
    const commits: number[] = []
    editor.store.listen((event) => {
      if (event.phase === 'commit') commits.push(event.patch.size)
    })
    // 並べ直した結果を書いても、再び並べ直しは走らない（1 回の操作が 1 回の commit で終わる）
    editor.transact('nudge', (tx) => tx.put({ ...editor.getNode(rows[0].body.id)!, x: 0 }))
    expect(commits).toEqual([])
    const other = editor.makeNode('geo', { x: 3000, y: 0, props: { shape: 'rect', w: 10, h: 10 } })
    editor.createNodes([other])
    expect(commits).toEqual([1])
    expect(editor.getNode(layout.id)).toBeDefined()
  })

  it('arranges the cover heading when the title text changes its height', () => {
    const editor = new Editor({ canvasId: 'canvas:1' })
    const slide = editor.makeNode('slide', { x: 0, y: 0, props: { ratio: '16:9', name: '', hidden: false } })
    const layout = editor.makeNode('slide-layout', { x: 0, y: 0, parentId: slide.id, props: { layout: 'title', w: 1920, h: 1080, slots: { rows: [] } } })
    const title = editor.makeNode('text', { x: 0, y: 0, parentId: layout.id, props: { paragraphs: richTextFromPlain('題名'), fontSize: 80, autoWidth: false, w: 300 } })
    editor.createNodes([slide, { ...layout, props: { ...layout.props, slots: { title: title.id, rows: [] } } }, title])
    const cover = canvasSlideLayout('title', 1, '16:9', { hasCredits: false })
    const height = () => editor.index.get(title.id)!.localBounds.h
    const centerY = () => editor.getNode(title.id)!.y + height() / 2
    expect((editor.getNode(title.id)!.props as { w: number }).w).toBe(cover.headingArea.w)
    expect(centerY()).toBeCloseTo(cover.headingCenterY)
    const oneLine = height()
    editor.transact('edit text', (tx) => {
      const node = editor.getNode(title.id)!
      tx.put({ ...node, props: { ...node.props, paragraphs: richTextFromPlain('一行目\n二行目\n三行目') } })
    })
    expect(height()).toBeGreaterThan(oneLine)
    expect(centerY()).toBeCloseTo(cover.headingCenterY)
  })
})
