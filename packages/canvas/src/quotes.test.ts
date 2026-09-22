import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import type { QuoteCardProps } from '@canvcode/nodes'
import { copySelection, insertPayloadWithResult, quotePayload } from './clipboard.ts'
import { Editor } from './editor.ts'
import { locateQuote, looksLikeFigure, quoteRange, textInRegion, type PdfTextItem, type QuoteDraft } from './quotes.ts'
import { Workspace } from './workspace.ts'

// 引用ノートと逆リンク（MAI-33）

function setup() {
  const workspace = new Workspace({ rootCanvasId: 'canvas:root' })
  const root = new Editor({ workspace })
  const pdf = root.importPdf({
    title: '論文',
    asset: { id: 'asset:abc', hash: 'abc', size: 1 },
    pageSizes: [{ width: 600, height: 800 }, { width: 600, height: 800 }],
    center: { x: 0, y: 0 },
  })
  const pages = new Editor({ workspace, canvasId: pdf.canvasId })
  const pageIds = pages.index.allIds()
  const draft = (pageIndex = 0, rect = { x: 0.1, y: 0.1, w: 0.3, h: 0.1 }): QuoteDraft => ({
    fileId: pdf.fileId,
    locator: { kind: 'pdf', pageIndex, rect },
    quote: '引用した文',
    figure: null,
  })
  return { workspace, root, pdf, pages, pageIds, draft }
}

describe('quote notes', () => {
  it('creates a note and its anchor in one undo step', () => {
    const { workspace, root, draft } = setup()
    const id = root.createQuoteNote(draft(), { x: 0, y: 300 })
    const note = workspace.getNode(id) as NodeRecord<QuoteCardProps>
    const anchor = workspace.getAnchor(note.props.anchorId)!
    expect(anchor).toMatchObject({ quote: '引用した文', locator: { kind: 'pdf', pageIndex: 0 } })
    expect(workspace.notesOfAnchor(anchor.id).map((n) => n.id)).toEqual([id])
    root.undo()
    expect(workspace.getNode(id)).toBeUndefined()
    expect(workspace.getAnchor(anchor.id)).toBeUndefined()
  })

  it('places the note beside the page, below other quotes there', () => {
    const { pages, pageIds, draft } = setup()
    const page = pages.index.get(pageIds[0])!.worldBounds
    const a = pages.placeQuoteBeside(pageIds[0], draft(), 100)!
    const b = pages.placeQuoteBeside(pageIds[0], draft(), 100)!
    const boxA = pages.index.get(a)!.worldBounds
    const boxB = pages.index.get(b)!.worldBounds
    expect(boxA.x).toBeGreaterThan(page.x + page.w)
    expect(boxA.y).toBe(100)
    expect(boxB.y).toBeGreaterThan(boxA.y + boxA.h)
  })

  it('removes the anchor with its last note, and keeps it while another note cites it', () => {
    const { workspace, root, draft } = setup()
    const id = root.createQuoteNote(draft(), { x: 0, y: 300 })
    const anchorId = (workspace.getNode(id)!.props as QuoteCardProps).anchorId
    root.setSelection([id])
    const [copy] = insertPayloadWithResult(root, copySelection(root)!, { offset: { x: 400, y: 0 } }).ids
    expect(workspace.notesOfAnchor(anchorId)).toHaveLength(2)
    root.deleteNodes([id])
    expect(workspace.getAnchor(anchorId)).toBeDefined()
    root.deleteNodes([copy])
    expect(workspace.getAnchor(anchorId)).toBeUndefined()
    // 元に戻すと、SourceAnchor も戻る
    root.undo()
    expect(workspace.getAnchor(anchorId)).toBeDefined()
  })

  it('pastes a copied quote as a note with a new anchor', () => {
    const { workspace, root, draft } = setup()
    const [id] = insertPayloadWithResult(root, quotePayload(draft()), { center: { x: 0, y: 0 } }).ids
    const note = workspace.getNode(id) as NodeRecord<QuoteCardProps>
    expect(note.type).toBe('quote-card')
    expect(workspace.getAnchor(note.props.anchorId)?.fileId).toBe(note.props.fileId)
  })

  it('moves a cut note with its anchor', () => {
    const { workspace, root, draft } = setup()
    const id = root.createQuoteNote(draft(), { x: 0, y: 300 })
    const anchorId = (workspace.getNode(id)!.props as QuoteCardProps).anchorId
    root.setSelection([id])
    const payload = copySelection(root)!
    root.deleteNodes([id])
    expect(workspace.getAnchor(anchorId)).toBeUndefined()
    const [moved] = insertPayloadWithResult(root, payload, { center: { x: 0, y: 0 } }).ids
    expect((workspace.getNode(moved)!.props as QuoteCardProps).anchorId).toBe(anchorId)
    expect(workspace.getAnchor(anchorId)).toBeDefined()
  })
})

describe('backlinks', () => {
  it('finds the anchors under a point on a locked page', () => {
    const { pages, pageIds, draft } = setup()
    pages.createQuoteNote(draft(0, { x: 0.1, y: 0.1, w: 0.3, h: 0.1 }), { x: 2000, y: 0 })
    const page = pages.index.get(pageIds[0])!.worldBounds
    const inside = { x: page.x + page.w * 0.2, y: page.y + page.h * 0.15 }
    const outside = { x: page.x + page.w * 0.8, y: page.y + page.h * 0.8 }
    expect(pages.citationsAt(inside)).toHaveLength(1)
    expect(pages.citationsAt(outside)).toHaveLength(0)
  })

  it('hides the regions whose notes are all in the trash', () => {
    const { workspace, root, pdf, draft } = setup()
    const { portalId, canvasId } = root.createPortal({ x: 1000, y: 0 })
    new Editor({ workspace, canvasId }).createQuoteNote(draft(), { x: 0, y: 0 })
    expect(workspace.anchorsOfFile(pdf.fileId)).toHaveLength(1)
    root.deleteNodes([portalId], { ownerPortals: 'trash' })
    expect(workspace.anchorsOfFile(pdf.fileId)).toHaveLength(0)
    expect(workspace.citations.anchorsOf(pdf.fileId)).toHaveLength(1)
  })
})

describe('text in a PDF region', () => {
  const item = (text: string, x: number, y: number, w: number, h = 10): PdfTextItem => ({ text, x, y, w, h })

  it('takes the lines inside the region and joins English words with spaces', () => {
    const items = [item('The quick brown', 0, 0, 150), item('fox jumps over', 0, 14, 140), item('outside', 0, 100, 70)]
    const region = textInRegion(items, { x: 0, y: 0, w: 200, h: 30 })
    expect(region.text).toBe('The quick brown fox jumps over')
  })

  it('joins Japanese lines without spaces and cuts partial items', () => {
    const items = [item('これは引用する文章です', 0, 0, 110), item('次の行です', 0, 14, 50)]
    // 左から 60 まで：1 行目の前半 6 文字と、2 行目
    const region = textInRegion(items, { x: 0, y: 0, w: 60, h: 30 })
    expect(region.text).toBe('これは引用す次の行です')
  })

  it('treats a region with little text as a figure', () => {
    const region = textInRegion([item('図 1', 0, 190, 30)], { x: 0, y: 0, w: 300, h: 200 })
    expect(looksLikeFigure(region)).toBe(true)
    const dense = textInRegion(
      Array.from({ length: 10 }, (_, i) => item('ぎっしり詰まった本文の行です', 0, i * 14, 280)),
      { x: 0, y: 0, w: 300, h: 140 },
    )
    expect(looksLikeFigure(dense)).toBe(false)
  })

  it('rejoins a word broken with a hyphen at the end of a line', () => {
    const items = [item('a long docu-', 0, 0, 120), item('ment here', 0, 14, 90)]
    expect(textInRegion(items, { x: 0, y: 0, w: 200, h: 30 }).text).toBe('a long document here')
  })
})

describe('markdown anchors', () => {
  it('relocates the quote after lines are added above it', () => {
    expect(locateQuote('a\nb\n引用\nc', '引用', 3)).toBe(3)
    expect(locateQuote('新しい行\n\na\nb\n引用\nc', '引用', 3)).toBe(5)
  })

  it('picks the occurrence nearest the remembered line', () => {
    const text = '引用\nx\nx\nx\nx\n引用\nx'
    expect(locateQuote(text, '引用', 6)).toBe(6)
    expect(locateQuote(text, '引用', 2)).toBe(1)
  })

  it('reports a lost quote', () => {
    expect(locateQuote('書き換えた本文', '引用', 1)).toBeNull()
  })

  it('finds the range of a multi-line quote', () => {
    const text = 'a\n一行目\n二行目\nb'
    const range = quoteRange(text, '一行目\n二行目', 2)!
    expect(text.slice(range.from, range.to)).toBe('一行目\n二行目')
  })
})
