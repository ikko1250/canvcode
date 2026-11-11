import { describe, expect, it } from 'vitest'
import { richTextFromPlain, type TextProps } from '@canvcode/nodes'
import { BELOW_RIGHT_TEXT_WIDTH, Editor } from './editor.ts'
import { Workspace } from './workspace.ts'

// ノードの右下にテキストを置く（APA の引用。MAI-98）

const paragraphs = richTextFromPlain('Author, A. (2020). Title.')

describe('placeTextBelowRight', () => {
  it('右下に、決めた幅で折り返すテキストを置く。1 回の Undo で消え、選択は変えない', () => {
    const editor = new Editor()
    const card = editor.makeNode('geo', { x: 100, y: 50, props: { shape: 'rect', w: 200, h: 100 } })
    editor.createNodes([card])
    editor.setSelection([card.id])
    const id = editor.placeTextBelowRight(card.id, paragraphs, { label: 'cite' })!
    const text = editor.getNode(id)!
    expect(text).toMatchObject({ type: 'text', x: 324, y: 174 })
    expect(text.props as TextProps).toMatchObject({ paragraphs, autoWidth: false, w: BELOW_RIGHT_TEXT_WIDTH })
    expect([...editor.session.get().selectedIds]).toEqual([card.id])
    editor.undo()
    expect(editor.getNode(id)).toBeUndefined()
    expect(editor.placeTextBelowRight('node:none', paragraphs)).toBeNull()
  })

  it('前に置いたテキストがあれば、その下に置く', () => {
    const editor = new Editor()
    const card = editor.makeNode('geo', { x: 0, y: 0, props: { shape: 'rect', w: 100, h: 100 } })
    editor.createNodes([card])
    const first = editor.index.get(editor.placeTextBelowRight(card.id, paragraphs)!)!.worldBounds
    const second = editor.getNode(editor.placeTextBelowRight(card.id, paragraphs)!)!
    expect(second.x).toBe(first.x)
    expect(second.y).toBe(first.y + first.h + 24)
  })

  it('PDF のページの格子では、隣のページに重ねず、並んだページの右に置く', () => {
    const workspace = new Workspace({ rootCanvasId: 'canvas:root' })
    const root = new Editor({ workspace })
    const pdf = root.importPdf({
      title: '論文',
      asset: { id: 'asset:abc', hash: 'abc', size: 1 },
      pageSizes: Array.from({ length: 6 }, () => ({ width: 600, height: 800 })),
      center: { x: 0, y: 0 },
    })
    const pages = new Editor({ workspace, canvasId: pdf.canvasId })
    const [first] = pages.pdfPageIds()
    const id = pages.placeTextBelowRight(first!, paragraphs)!
    const box = pages.index.get(id)!.worldBounds
    const grid = pages.pdfPageIds().map((page) => pages.index.get(page)!.worldBounds)
    expect(grid.every((page) => box.x >= page.x + page.w || box.y >= page.y + page.h || box.y + box.h <= page.y)).toBe(true)
    expect(box.y).toBe(grid[0]!.y + grid[0]!.h + 24)
  })
})
