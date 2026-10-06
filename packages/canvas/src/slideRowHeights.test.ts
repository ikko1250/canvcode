import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import { richTextFromPlain, type SlideLayoutProps } from '@canvcode/nodes'
import { canvasSlideLayout, canvasSlideRowHeights } from '@canvcode/slides'
import { duplicateSelection } from './clipboard.ts'
import { Editor, nodeIn } from './editor.ts'
import { slotsWithAutoRowHeight, slotsWithResizedRows } from './slideLayoutRows.ts'

// slide-layout（スライド v2）の行の高さ。自動（既定）は文字に合わせて v1 の規則で配分し、
// 行のセルの下端をリサイズすると、その行の高さ（slots の行の h）を手で決める（並べ直しと同じ 1 歩）

// 表のテンプレートを置いたスライド（3 行）
function setup(rows = 3) {
  const editor = new Editor({ canvasId: 'canvas:1' })
  const slide = editor.createSlide({ x: 960, y: 540 }, '16:9')
  editor.applySlideTemplate(slide, 'table')
  const layoutId = editor.index.childrenOf(slide).find((id) => editor.getNode(id)?.type === 'slide-layout')!
  const slots = () => (editor.getNode(layoutId)!.props as SlideLayoutProps).slots
  for (let i = 3; i < rows; i++) {
    editor.setSelection([slots().rows.at(-1)!.body])
    editor.addSlideLayoutRow()
  }
  const get = (id: string) => editor.getNode(id)!
  const cellBox = (id: string) => {
    const n = get(id)
    return { y: n.y, h: (n.props as { h: number }).h }
  }
  const heights = () => slots().rows.map((row) => cellBox(row.body).h)
  const setText = (id: string, value: string) =>
    editor.transact('edit', (tx) => {
      const cell = nodeIn(tx, id)!
      tx.put({ ...cell, props: { ...cell.props, label: value, labelParagraphs: richTextFromPlain(value) } })
    })
  // セルを選んで、選択枠の辺を動かす（画面のリサイズと同じ Editor.resizeSelection）
  const resize = (id: string, change: { top?: number; bottom?: number; right?: number }) => {
    editor.setSelection([id])
    const selection = editor.transformSelection()!
    const { frame } = selection
    const top = change.top ?? 0
    const next = { ...frame, y: frame.y + top, h: frame.h - top + (change.bottom ?? 0), w: frame.w + (change.right ?? 0) }
    const tx = editor.begin('resize')
    for (const node of editor.resizeSelection(selection, next)) tx.put(node)
    editor.finish(tx)
  }
  return { editor, slide, layoutId, slots, get, cellBox, heights, setText, resize }
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `行${i}`).join('\n')

describe('slide-layout row heights: auto', () => {
  it('keeps the uniform v1 row height while every row fits', () => {
    const { heights } = setup()
    expect(heights()).toEqual([150, 150, 150])
    const four = setup(4)
    expect(four.heights()).toEqual([131, 131, 131, 131])
  })

  it('makes the row with more text taller, and the label follows the body', () => {
    const { slots, heights, setText, cellBox } = setup(4)
    const rows = slots().rows
    setText(rows[1].body, lines(5))
    const after = heights()
    expect(after[1]).toBeGreaterThan(131)
    expect(after[0]).toBeLessThan(131)
    // 合計は 4 行の全高のパネルの行の高さ（予算 − 間隔）
    expect(after.reduce((a, b) => a + b, 0)).toBe(646 - 3 * 41)
    expect(cellBox(rows[1].label!)).toEqual(cellBox(rows[1].body))
    // 行は間隔を挟んで積む
    expect(cellBox(rows[2].body).y).toBe(cellBox(rows[1].body).y + after[1] + 41)
  })

  it('switches from the compact panel to the full panel when the text does not fit the compact one', () => {
    const { editor, slots, layoutId, setText } = setup()
    const panel = () => editor.getNode(slots().panel!)!
    const compact = canvasSlideLayout('table', 3)
    expect(panel().y).toBe(compact.panel.y)
    setText(slots().rows[0].body, lines(7))
    const full = canvasSlideLayout('table', 3, '16:9', { forceFull: true })
    expect(panel().y).toBe(full.panel.y)
    expect((panel().props as { h: number }).h).toBe(full.panel.h)
    expect(editor.getNode(layoutId)).toBeDefined()
    // 文字を戻せば compact に戻る
    setText(slots().rows[0].body, '短い')
    expect(panel().y).toBe(compact.panel.y)
  })
})

describe('slide-layout row heights: manual', () => {
  it('writes the row height when the bottom edge of a cell is resized, and undoes it in one step', () => {
    const { editor, slots, heights, resize, cellBox } = setup(4)
    const row = slots().rows[1]
    resize(row.body, { bottom: 120 })
    expect(slots().rows[1].h).toBe(251)
    // 手で決めた行はその高さ、残りを自動の行で分ける
    expect(heights()).toEqual(canvasSlideRowHeights('table', [0, 0, 0, 0], [undefined, 251]).rowHeights)
    expect(heights()[1]).toBe(251)
    expect(cellBox(row.label!).h).toBe(251)
    // 見出しの下端でも同じ
    resize(row.label!, { bottom: -51 })
    expect(slots().rows[1].h).toBe(200)
    editor.undo()
    expect(slots().rows[1].h).toBe(251)
    editor.undo()
    expect(slots().rows[1].h).toBeUndefined()
    expect(heights()).toEqual([131, 131, 131, 131])
  })

  it('ignores resizing the top, left or right edge (the cell goes back)', () => {
    const { slots, heights, resize } = setup(4)
    const row = slots().rows[2]
    resize(row.body, { top: -60 })
    resize(row.body, { right: 80 })
    expect(slots().rows[2].h).toBeUndefined()
    expect(heights()).toEqual([131, 131, 131, 131])
  })

  it('squeezes the auto rows to the minimum, then scales the manual rows to fit', () => {
    const { slots, heights, resize } = setup(4)
    resize(slots().rows[0].body, { bottom: 300 })
    expect(slots().rows[0].h).toBe(431)
    // 自動の行を最小（68）にしても入らないので、手で決めた行を残り（523 − 68 × 3）に縮める。手で決めた高さはそのまま持つ
    expect(heights()).toEqual([319, 68, 68, 68])
    expect(heights().reduce((a, b) => a + b, 0)).toBeCloseTo(523)
  })

  it('keeps the heights when rows are added, removed or duplicated', () => {
    const { editor, slots, resize, get, slide } = setup(3)
    resize(slots().rows[1].body, { bottom: 50 })
    expect(slots().rows.map((r) => r.h)).toEqual([undefined, 200, undefined])
    // 足した行は自動。手で決めた行はその行についていく
    editor.setSelection([slots().rows[0].body])
    editor.addSlideLayoutRow()
    expect(slots().rows.map((r) => r.h)).toEqual([undefined, undefined, 200, undefined])
    // スライドを複製すると、行の高さも写る
    editor.setSelection([slide])
    const [copy] = duplicateSelection(editor, { x: 0, y: 2000 })
    const copyLayout = editor.index.childrenOf(copy).map((id) => get(id)).find((n) => n.type === 'slide-layout')!
    const copied = (copyLayout.props as SlideLayoutProps).slots
    expect(copied.rows.map((r) => r.h)).toEqual([undefined, undefined, 200, undefined])
    expect((get(copied.rows[2].body).props as { h: number }).h).toBe(200)
    // 行を消すと、その行の高さも消える
    editor.setSelection([slots().rows[2].body])
    editor.removeSlideLayoutRow()
    expect(slots().rows.map((r) => r.h)).toEqual([undefined, undefined, undefined])
  })

  it('resets the row height to auto from the selected cell', () => {
    const { editor, slots, heights, resize } = setup(4)
    editor.setSelection([slots().rows[1].body])
    expect(editor.slideLayoutRowState()?.manualHeight).toBe(false)
    expect(editor.resetSlideLayoutRowHeight()).toBe(false)
    resize(slots().rows[1].body, { bottom: 100 })
    expect(editor.slideLayoutRowState()?.manualHeight).toBe(true)
    // 同じ行の見出しを選んでいても出す
    editor.setSelection([slots().rows[1].label!])
    expect(editor.slideLayoutRowState()?.manualHeight).toBe(true)
    expect(editor.resetSlideLayoutRowHeight()).toBe(true)
    expect(slots().rows[1].h).toBeUndefined()
    expect(heights()).toEqual([131, 131, 131, 131])
    expect(editor.slideLayoutRowState()?.manualHeight).toBe(false)
    editor.undo()
    expect(slots().rows[1].h).toBe(231)
  })
})

describe('slide-layout row heights: pure helpers', () => {
  const cell = (id: string, y: number, h: number, parentId = 'layout'): NodeRecord => ({
    typeName: 'node',
    id,
    type: 'geo',
    parentId,
    x: 0,
    y,
    rotation: 0,
    index: 'a0',
    opacity: 1,
    locked: false,
    props: { w: 100, h },
    meta: {},
  })

  it('writes h only for a bottom-edge resize, the taller of the label and the body', () => {
    const slots = { rows: [{ label: 'l0', body: 'b0' }, { body: 'b1', h: 90 }] }
    const changes = new Map([
      ['l0', { before: cell('l0', 10, 100), after: cell('l0', 10, 140.4) }],
      ['b0', { before: cell('b0', 10, 100), after: cell('b0', 10, 160) }],
    ])
    expect(slotsWithResizedRows(slots, (id) => changes.get(id))?.rows).toEqual([{ label: 'l0', body: 'b0', h: 160 }, { body: 'b1', h: 90 }])
    // 上端を動かした・高さが変わらない・外へ出した
    const moved = new Map([['b1', { before: cell('b1', 10, 90), after: cell('b1', 0, 120) }]])
    expect(slotsWithResizedRows(slots, (id) => moved.get(id))).toBeNull()
    const same = new Map([['b0', { before: cell('b0', 10, 100), after: cell('b0', 10, 100) }]])
    expect(slotsWithResizedRows(slots, (id) => same.get(id))).toBeNull()
    const out = new Map([['b0', { before: cell('b0', 10, 100), after: cell('b0', 10, 150, 'other') }]])
    expect(slotsWithResizedRows(slots, (id) => out.get(id))).toBeNull()
    expect(slotsWithAutoRowHeight(slots, 1).rows).toEqual([{ label: 'l0', body: 'b0' }, { body: 'b1' }])
  })
})
