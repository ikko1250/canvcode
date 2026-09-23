import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import { PDF_POINT_SCALE, type PdfPageProps } from '@canvcode/nodes'
import { Editor } from './editor.ts'
import { Workspace } from './workspace.ts'

// PDF の取り込み・固定（MAI-32）

function setup(pages = 6) {
  const workspace = new Workspace({ rootCanvasId: 'canvas:root' })
  const root = new Editor({ workspace })
  const pageSizes = Array.from({ length: pages }, (_, i) => ({ width: 600, height: i === 5 ? 400 : 800 }))
  const result = root.importPdf({ title: '論文', asset: { id: 'asset:abc', hash: 'abc', size: 1000 }, pageSizes, center: { x: 0, y: 0 } })
  const pagesEditor = new Editor({ workspace, canvasId: result.canvasId })
  const pageNodes = () =>
    pagesEditor.index
      .allIds()
      .map((id) => pagesEditor.getNode(id) as NodeRecord<PdfPageProps>)
      .sort((a, b) => a.props.pageIndex - b.props.pageIndex)
  return { workspace, root, result, pagesEditor, pageNodes }
}

describe('importing a PDF', () => {
  it('creates the PDF file, the pages canvas and its owner portal', () => {
    const { workspace, root, result } = setup()
    expect(workspace.getFile(result.fileId)).toMatchObject({ kind: 'pdf', assetId: 'asset:abc', pagesCanvasId: result.canvasId, pageCount: 6 })
    expect(workspace.getCanvas(result.canvasId)).toMatchObject({ title: '論文', parentCanvasId: 'canvas:root', ownerNodeId: result.portalId })
    expect(root.index.allIds()).toEqual([result.portalId])
    // PDF の File は、ページの Canvas として表すので、未配置やツリーの File には出さない
    expect(workspace.unplacedDocuments()).toHaveLength(0)
    expect(workspace.childFiles('canvas:root')).toHaveLength(0)
  })

  it('lays the pages out four to a row, locked', () => {
    const { pageNodes } = setup()
    const pages = pageNodes()
    expect(pages).toHaveLength(6)
    expect(pages.every((p) => p.locked)).toBe(true)
    const w = 600 * PDF_POINT_SCALE
    expect(pages.slice(0, 4).map((p) => p.y)).toEqual([0, 0, 0, 0])
    expect(pages[1].x).toBeCloseTo(w + 40, 6)
    // 2 行目は、1 行目の最も高いページの下
    expect(pages[4]).toMatchObject({ x: 0, y: 800 * PDF_POINT_SCALE + 40 })
    expect(pages[5].props.h).toBeCloseTo(400 * PDF_POINT_SCALE, 6)
  })

  it('undoes the whole import in one step', () => {
    const { workspace, root, result } = setup()
    root.undo()
    expect(workspace.getCanvas(result.canvasId)).toBeUndefined()
    expect(workspace.getFile(result.fileId)).toBeUndefined()
    expect(workspace.getNode(result.portalId)).toBeUndefined()
  })

  it('removes the PDF file with its pages canvas when deleted forever', () => {
    const { workspace, root, result } = setup()
    root.deleteNodes([result.portalId], { ownerPortals: 'trash' })
    workspace.store.transact('forever', (tx) => workspace.deleteCanvasForever(tx, result.canvasId))
    expect(workspace.getFile(result.fileId)).toBeUndefined()
  })
})

describe('portal thumbnail', () => {
  it('covers only the first page of a pages canvas (MAI-46)', () => {
    const { pagesEditor, pageNodes } = setup()
    const first = pageNodes()[0]
    // 書き込み（付箋）があっても、1 ページ目の範囲のまま
    pagesEditor.createNodes([pagesEditor.makeNode('note', { x: 3000, y: 3000 })])
    expect(pagesEditor.thumbnailBounds()).toEqual({ x: first.x, y: first.y, w: first.props.w, h: first.props.h })
  })

  it('covers all the content of an ordinary canvas', () => {
    const { root, result } = setup()
    const portal = root.index.get(result.portalId)!.worldBounds
    expect(root.thumbnailBounds()).toEqual(portal)
    const empty = new Editor({ workspace: new Workspace({ rootCanvasId: 'canvas:root' }) })
    expect(empty.thumbnailBounds()).toBeNull()
  })
})

describe('locking', () => {
  it('skips locked pages in hit tests unless asked, and unlocks them', () => {
    const { pagesEditor, pageNodes } = setup()
    const page = pageNodes()[0]
    const point = { x: 100, y: 100 }
    expect(pagesEditor.hitTest(point, 4)).toBeNull()
    expect(pagesEditor.hitTest(point, 4, { includeLocked: true })?.id).toBe(page.id)
    pagesEditor.setLocked([page.id], false)
    expect(pagesEditor.hitTest(point, 4)?.id).toBe(page.id)
    expect([...pagesEditor.session.get().selectedIds]).toEqual([page.id])
    pagesEditor.setLocked([page.id], true)
    expect(pagesEditor.getNode(page.id)!.locked).toBe(true)
    expect(pagesEditor.session.get().selectedIds.size).toBe(0)
  })

  it('lets you draw on top of a locked page without selecting it', () => {
    const { pagesEditor } = setup()
    const note = pagesEditor.makeNode('note', { x: 50, y: 50 })
    pagesEditor.createNodes([note])
    // 書き込み（付箋）は選べる。ページは選べない
    expect(pagesEditor.hitTest({ x: 60, y: 60 }, 4)?.id).toBe(note.id)
    expect(pagesEditor.nodesInBrush({ x: 0, y: 0, w: 2000, h: 2000 })).toEqual([note.id])
  })
})
