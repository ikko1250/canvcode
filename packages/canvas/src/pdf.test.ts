import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import { PDF_POINT_SCALE, type PdfPageProps, type RasterImage } from '@canvcode/nodes'
import { Editor } from './editor.ts'
import { currentPdfPage, pageJumpTarget, pageNavigationTarget } from './pageNavigation.ts'
import { drawNodes, imageViewport, screenViewport, visibleIds, type Viewport } from './renderer.ts'
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

  it('lays the pages out three to a row, locked', () => {
    const { pageNodes } = setup()
    const pages = pageNodes()
    expect(pages).toHaveLength(6)
    expect(pages.every((p) => p.locked)).toBe(true)
    const w = 600 * PDF_POINT_SCALE
    expect(pages.slice(0, 3).map((p) => p.y)).toEqual([0, 0, 0])
    expect(pages[1].x).toBeCloseTo(w + 40, 6)
    // 2 行目は、1 行目の最も高いページの下
    expect(pages[3]).toMatchObject({ x: 0, y: 800 * PDF_POINT_SCALE + 40 })
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

describe('locking all pages (MAI-56)', () => {
  it('lists the pages of this canvas in page order, not those of other canvases', () => {
    const { root, pagesEditor, pageNodes } = setup()
    expect(pagesEditor.pdfPageIds()).toEqual(pageNodes().map((p) => p.id))
    // ほかの PDF のページ（File の pagesCanvasId が別の Canvas）がこの Canvas にあっても含めない
    const other = root.importPdf({ title: '別', asset: { id: 'asset:def', hash: 'def', size: 10 }, pageSizes: [{ width: 600, height: 800 }], center: { x: 500, y: 0 } })
    const stray = pagesEditor.makeNode('pdf-page', { x: 5000, y: 0, props: { assetId: 'asset:def', fileId: other.fileId, pageIndex: 0, w: 100, h: 100 } })
    pagesEditor.createNodes([stray])
    expect(pagesEditor.pdfPageIds()).toEqual(pageNodes().filter((p) => p.id !== stray.id).map((p) => p.id))
    // ページの Canvas でなければ空
    expect(root.pdfPageIds()).toEqual([])
  })

  it('unlocks and selects every page, even the ones already unlocked', () => {
    const { pagesEditor, pageNodes } = setup()
    const ids = pageNodes().map((p) => p.id)
    pagesEditor.setLocked([ids[2]], false)
    pagesEditor.setSelection([])
    pagesEditor.unlockAndSelectPdfPages()
    expect(pageNodes().every((p) => !p.locked)).toBe(true)
    expect([...pagesEditor.session.get().selectedIds].sort()).toEqual([...ids].sort())
    // 1 回の Undo で戻る（3 ページ目は外れたまま）
    pagesEditor.undo()
    expect(pageNodes().map((p) => p.locked)).toEqual([true, true, false, true, true, true])
  })

  it('locks every page and clears the selection, undoable in one step', () => {
    const { pagesEditor, pageNodes } = setup()
    pagesEditor.unlockAndSelectPdfPages()
    pagesEditor.lockPdfPages()
    expect(pageNodes().every((p) => p.locked)).toBe(true)
    expect(pagesEditor.session.get().selectedIds.size).toBe(0)
    pagesEditor.undo()
    expect(pageNodes().every((p) => !p.locked)).toBe(true)
    pagesEditor.undo()
    expect(pageNodes().every((p) => p.locked)).toBe(true)
  })
})

// 描いた文字を記録する ctx
function recordingContext() {
  const texts: string[] = []
  const state: Record<string, unknown> = { globalAlpha: 1 }
  const ctx = new Proxy(state, {
    get(target, key) {
      if (key === 'fillText') return (text: string) => texts.push(text)
      if (key === 'measureText') return (text: string) => ({ width: text.length * 6 })
      if (key in target) return target[key as string]
      return () => {}
    },
    set(target, key, value) {
      target[key as string] = value
      return true
    },
  })
  return { ctx: ctx as unknown as CanvasRenderingContext2D, texts }
}

describe('page number labels (MAI-92)', () => {
  // 画面（CanvasView.viewport）は pageNumbers を立て、画像の書き出し・サムネイル（renderRegion）は立てない
  function draw(editor: Editor, extra: Partial<Viewport>) {
    const raster: RasterImage = { image: {} as CanvasImageSource, width: 1, height: 1, level: 1 }
    const view: Viewport = {
      camera: { x: -100, y: -100, zoom: 0.25 },
      width: 2000,
      height: 2000,
      dpr: 1,
      // ページの画像がある（読み込み中の仮の表示の番号を描かない）ことにする
      images: { get: () => raster },
      assets: { get: () => undefined, load: async () => raster, renderPdfPage: async () => raster, pdfPreviewLevels: () => [] },
      ...extra,
    }
    const recorded = recordingContext()
    drawNodes(recorded.ctx, editor, visibleIds(editor, view), view)
    return recorded.texts
  }

  it('labels each imported page with its number in the PDF, only on the screen', () => {
    const { pagesEditor } = setup()
    expect(draw(pagesEditor, { pageNumbers: true })).toEqual(['1', '2', '3', '4', '5', '6'])
    expect(draw(pagesEditor, {})).toEqual([])
    expect(draw(pagesEditor, { print: true })).toEqual([])
  })

  // CanvasView が使う Viewport の組み立て：画面（viewport）は screenViewport、画像（renderRegion）は imageViewport
  it('is turned on by the screen viewport only, not by the image viewport (exports, thumbnails, render_canvas, slide PDF)', () => {
    const { pagesEditor } = setup()
    const raster: RasterImage = { image: {} as CanvasImageSource, width: 1, height: 1, level: 1 }
    const sources = {
      images: { get: () => raster },
      assets: { get: () => undefined, load: async () => raster, renderPdfPage: async () => raster, pdfPreviewLevels: () => [] },
    }
    const screen = screenViewport({ x: -100, y: -100, zoom: 0.25 }, 2000, 2000, 2, sources, { search: undefined, editingId: null })
    expect(screen.pageNumbers).toBe(true)
    expect(draw(pagesEditor, screen)).toEqual(['1', '2', '3', '4', '5', '6'])
    const box = { x: -100, y: -100, w: 8000, h: 8000 }
    for (const print of [false, true]) {
      const image = imageViewport(box, 0.25, 2000, 2000, sources, print)
      expect(image.pageNumbers).toBeFalsy()
      expect(image.search).toBeUndefined()
      expect(draw(pagesEditor, image)).toEqual([])
    }
  })
})

// グループ・フレームの中のページ（MAI-92）。「すべてのページの固定を外す」→ ページを選んで Ctrl+G でグループにしたり、
// フレームに入れたりしても、番号と移る先の対象にする
describe('pages inside groups and frames (MAI-92)', () => {
  const near = (box: { x: number; y: number; w: number; h: number }) => ({
    x: Math.round(box.x * 1e6) / 1e6,
    y: Math.round(box.y * 1e6) / 1e6,
    w: Math.round(box.w * 1e6) / 1e6,
    h: Math.round(box.h * 1e6) / 1e6,
  })

  function nest() {
    const env = setup()
    const { pagesEditor, pageNodes } = env
    const pages = pageNodes()
    const before = pages.map((p) => near(pagesEditor.index.get(p.id)!.worldBounds))
    // 3・4 ページをグループに
    pagesEditor.setLocked([pages[2].id, pages[3].id], false)
    pagesEditor.setSelection([pages[2].id, pages[3].id])
    const group = pagesEditor.groupSelected()!
    // 5 ページをフレームの中に。フレームは原点から離して置く（ページの座標はフレームからの相対になる）
    const frame = pagesEditor.makeNode('frame', { x: -500, y: 1000, props: { w: 5000, h: 3000, name: 'frame' } })
    pagesEditor.createNodes([frame])
    pagesEditor.transact('into frame', (tx) => pagesEditor.reparent(tx, [pages[4].id], frame.id))
    return { ...env, pages, before, group, frame }
  }

  it('lists the pages in a group or a frame too, in page order with their world boxes', () => {
    const { pagesEditor, pages, before, group, frame } = nest()
    expect(pagesEditor.getNode(pages[2].id)!.parentId).toBe(group)
    expect(pagesEditor.getNode(pages[4].id)!.parentId).toBe(frame.id)
    expect(pagesEditor.getNode(pages[4].id)!.x).not.toBe(pages[4].x)
    const list = pagesEditor.pdfPages()
    expect(list.map((p) => p.id)).toEqual(pages.map((p) => p.id))
    expect(list.map((p) => p.pageIndex)).toEqual([0, 1, 2, 3, 4, 5])
    expect(list.map((p) => near(p.box))).toEqual(before)
    expect(list.every((p) => p.pageCount === 6)).toBe(true)
    // フレームを動かすと、中のページの箱も動く
    pagesEditor.transact('move frame', (tx) => tx.put({ ...pagesEditor.getNode(frame.id)!, x: -400, y: 1050 }))
    expect(near(pagesEditor.pdfPages()[4].box)).toEqual({ ...before[4], x: before[4].x + 100, y: before[4].y + 50 })
  })

  it('keeps locking and selecting all pages (MAI-56) to the pages right on the canvas', () => {
    const { pagesEditor, pages } = nest()
    // グループの中の子は直接選ばない（選ぶのは今の階層のノード）ので、固定・選択の対象は Canvas の直下のページだけ
    expect(pagesEditor.pdfPageIds()).toEqual([pages[0].id, pages[1].id, pages[5].id])
  })

  it('shows the number of a page in a group or a frame, and jumps to it', () => {
    const { pagesEditor } = nest()
    const list = pagesEditor.pdfPages()
    const screen = { width: 1280, height: 720 }
    for (const pageNumber of [3, 4, 5]) {
      const box = list[pageNumber - 1].box
      const centred = { x: box.x + box.w / 2 - screen.width / 2, y: box.y + box.h / 2 - screen.height / 2, zoom: 1 }
      expect(currentPdfPage(list, centred, screen.width, screen.height)).toEqual({ page: pageNumber, count: 6 })
      const target = pageJumpTarget(list, pageNumber, { x: 0, y: 0, zoom: 0.5 }, screen.width, screen.height)
      expect(target).not.toBeNull()
      expect(currentPdfPage(list, target!, screen.width, screen.height)?.page).toBe(pageNumber)
    }
    // 次・前のページ（MAI-57）も、グループの中のページを数える
    const third = list[2].box
    expect(pageNavigationTarget(list.map((p) => p.box), { x: third.x, y: third.y, zoom: 1 }, 1280, 720, 'next', 20)).toEqual({
      x: list[3].box.x - 20,
      y: list[3].box.y - 20,
      zoom: 1,
    })
  })

  it('keeps the list until a node or a file changes', () => {
    const { pagesEditor, result, workspace } = setup()
    const first = pagesEditor.pdfPages()
    pagesEditor.session.set({ camera: { x: 500, y: 500, zoom: 2 } })
    expect(pagesEditor.pdfPages()).toBe(first)
    expect(pagesEditor.pdfPageIds()).toBe(pagesEditor.pdfPageIds())
    // ノードが変わったら作り直す（付箋を置いただけでも）
    pagesEditor.createNodes([pagesEditor.makeNode('note', { x: 0, y: 0 })])
    const second = pagesEditor.pdfPages()
    expect(second).not.toBe(first)
    expect(second).toEqual(first)
    // File が変わったら作り直す（総ページ数）
    workspace.store.transact('page count', (tx) => tx.put({ ...workspace.getFile(result.fileId)!, pageCount: 7 }))
    expect(pagesEditor.pdfPages()[0].pageCount).toBe(7)
  })
})
