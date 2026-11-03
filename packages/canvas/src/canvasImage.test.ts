import { describe, expect, it } from 'vitest'
import type { SlideProps } from '@canvcode/nodes'
import { IMAGE_MAX_EDGE, IMAGE_MAX_PIXELS, imageFileName, imageRegion, imageSize, selectionImageTarget } from './canvasImage.ts'
import { Editor } from './editor.ts'
import type { CanvasRefSource } from './refs.ts'

// Canvas を画像にする（MAI-89）：描く範囲と大きさ、ファイル名

function setup() {
  const editor = new Editor({ canvasId: 'canvas:1' })
  const rect = (x: number, y: number, parentId?: string, w = 400, h = 300) => {
    const node = editor.makeNode('geo', { x, y, parentId, props: { shape: 'rect', w, h } })
    editor.createNodes([node])
    return node.id
  }
  const slide = (x: number, y: number, props: Partial<SlideProps> = {}) => {
    const node = editor.makeNode('slide', { x, y, props: { ratio: '16:9', name: '', hidden: false, ...props } })
    editor.createNodes([node])
    return node.id
  }
  return { editor, rect, slide }
}

function source(fields: Partial<CanvasRefSource>): CanvasRefSource {
  return {
    canvasId: 'canvas:1',
    selectedIds: new Set(),
    lastBrush: null,
    boundsOf: () => undefined,
    nodesInBrush: () => [],
    pdfPagesIn: () => [],
    ...fields,
  }
}

describe('imageRegion', () => {
  it('draws everything in a rect', () => {
    const { editor } = setup()
    expect(imageRegion(editor, { kind: 'rect', rect: { x: 1, y: 2, w: 30, h: 40 } })).toEqual({
      box: { x: 1, y: 2, w: 30, h: 40 },
      only: null,
      print: false,
      missing: [],
    })
    expect(imageRegion(editor, { kind: 'rect', rect: { x: 0, y: 0, w: 0, h: 40 } })).toBeNull()
    expect(imageRegion(editor, { kind: 'rect', rect: { x: 0, y: 0, w: Number.NaN, h: 40 } })).toBeNull()
  })

  it('draws only the given nodes and their descendants, with a margin', () => {
    const { editor, rect } = setup()
    const a = rect(0, 0)
    const group = editor.makeNode('group', { x: 1000, y: 0, props: {} })
    editor.createNodes([group])
    const child = rect(0, 0, group.id, 200, 100)
    rect(500, 0)
    const region = imageRegion(editor, { kind: 'nodes', ids: [a, group.id, 'node:gone'] })!
    expect([...region.only!].sort()).toEqual([a, group.id, child].sort())
    expect(region.missing).toEqual(['node:gone'])
    expect(region.print).toBe(false)
    // 描く範囲（外側の線を含む inkBounds）で囲み、長い辺の 2%（8〜40）を足す
    const ink = editor.index.get(a)!.inkBounds
    const margin = (1200 + (0 - ink.x) * 2) * 0.02
    expect(ink.x).toBeLessThan(0)
    expect(region.box.x).toBeCloseTo(ink.x - margin)
    expect(region.box.w).toBeCloseTo(1200 - ink.x * 2 + margin * 2)
    expect(region.box.h).toBeCloseTo(300 - ink.y * 2 + margin * 2)
  })

  it('keeps a small margin for a small node and draws a flat line', () => {
    const { editor, rect } = setup()
    const small = rect(0, 0, undefined, 20, 10)
    const ink = editor.index.get(small)!.inkBounds
    expect(imageRegion(editor, { kind: 'nodes', ids: [small] })!.box).toEqual({ x: ink.x - 8, y: ink.y - 8, w: ink.w + 16, h: ink.h + 16 })
    const line = editor.makeNode('arrow', { x: 0, y: 500, props: { start: { x: 0, y: 0 }, end: { x: 300, y: 0 } } })
    editor.createNodes([line])
    const region = imageRegion(editor, { kind: 'nodes', ids: [line.id] })!
    expect(region.box.w).toBeGreaterThan(300)
    expect(region.box.h).toBeGreaterThan(0)
  })

  it('draws a single slide as its frame, for print', () => {
    const { editor, slide, rect } = setup()
    const s = slide(100, 200)
    const inner = rect(10, 10, s)
    for (const target of [{ kind: 'slide' as const, id: s }, { kind: 'nodes' as const, ids: [s] }]) {
      const region = imageRegion(editor, target)!
      expect(region.box).toEqual({ x: 100, y: 200, w: 1920, h: 1080 })
      expect(region.print).toBe(true)
      expect(region.slideId).toBe(s)
      expect([...region.only!].sort()).toEqual([s, inner].sort())
    }
    // 2 枚なら、ノードとして描く（印刷用ではない）
    const other = slide(3000, 200)
    expect(imageRegion(editor, { kind: 'nodes', ids: [s, other] })!.print).toBe(false)
    expect(imageRegion(editor, { kind: 'slide', id: inner })).toBeNull()
  })

  it('draws the whole canvas, or nothing when it is empty', () => {
    const { editor, rect } = setup()
    expect(imageRegion(editor, { kind: 'canvas' })).toBeNull()
    const a = rect(0, 0)
    rect(1000, 500)
    const region = imageRegion(editor, { kind: 'canvas' })!
    const ink = editor.index.get(a)!.inkBounds
    const w = 1400 - ink.x * 2
    expect(region).toMatchObject({ only: null, print: false, missing: [] })
    expect(region.box.x).toBeCloseTo(ink.x - w * 0.02)
    expect(region.box.w).toBeCloseTo(w * 1.04)
    expect(imageRegion(editor, { kind: 'nodes', ids: ['node:gone'] })).toBeNull()
  })
})

describe('selectionImageTarget', () => {
  const typeOf = (id: string) => (id.startsWith('node:slide') ? 'slide' : 'geo')

  it('uses the last brush while the selection has not changed since', () => {
    const brush = { rect: { x: 0, y: 0, w: 100, h: 50 }, ids: new Set(['node:a']) }
    expect(selectionImageTarget(source({ lastBrush: brush, selectedIds: new Set(['node:a']) }), typeOf)).toEqual({ kind: 'rect', rect: brush.rect })
    expect(selectionImageTarget(source({ lastBrush: brush }), typeOf)).toEqual({ kind: 'rect', rect: brush.rect })
    // 範囲選択のあとで、ほかのノードを選び直した
    expect(selectionImageTarget(source({ lastBrush: brush, selectedIds: new Set(['node:b']) }), typeOf)).toEqual({ kind: 'nodes', ids: ['node:b'] })
  })

  it('uses a single selected slide as a slide, and nothing without a selection', () => {
    expect(selectionImageTarget(source({ selectedIds: new Set(['node:slide1']) }), typeOf)).toEqual({ kind: 'slide', id: 'node:slide1' })
    expect(selectionImageTarget(source({ selectedIds: new Set(['node:slide1', 'node:slide2']) }), typeOf)).toEqual({
      kind: 'nodes',
      ids: ['node:slide1', 'node:slide2'],
    })
    expect(selectionImageTarget(source({}), typeOf)).toBeNull()
  })
})

describe('imageSize', () => {
  it('uses the given scale', () => {
    expect(imageSize({ x: 0, y: 0, w: 1200, h: 800 }, { scale: 1 })).toEqual({ width: 1200, height: 800, scale: 1, capped: false })
    expect(imageSize({ x: 0, y: 0, w: 1920, h: 1080 }, { scale: 2 })).toEqual({ width: 3840, height: 2160, scale: 2, capped: false })
  })

  it('fits the longest edge, but does not enlarge more than twice', () => {
    expect(imageSize({ x: 0, y: 0, w: 1920, h: 1080 }, { maxEdge: 1568 })).toMatchObject({ width: 1568, height: 882, capped: false })
    expect(imageSize({ x: 0, y: 0, w: 100, h: 50 }, { maxEdge: 1568 })).toEqual({ width: 200, height: 100, scale: 2, capped: false })
  })

  it('caps the longest edge and the area', () => {
    const wide = imageSize({ x: 0, y: 0, w: 10000, h: 1000 }, { scale: 2 })
    expect(wide).toMatchObject({ width: IMAGE_MAX_EDGE, capped: true })
    expect(wide.height).toBeLessThanOrEqual(820)
    const square = imageSize({ x: 0, y: 0, w: 4000, h: 4000 }, { scale: 2 })
    expect(square.capped).toBe(true)
    expect(square.width * square.height).toBeLessThanOrEqual(IMAGE_MAX_PIXELS)
    expect(square.width).toBe(4096)
    // AI の頼み方でも同じ上限
    expect(imageSize({ x: 0, y: 0, w: 4000, h: 4000 }, { maxEdge: 2576 })).toMatchObject({ width: 2576, height: 2576, capped: false })
  })
})

describe('imageFileName', () => {
  it('names the image after the canvas and the slide number', () => {
    expect(imageFileName('提案 / 2026')).toBe('提案 - 2026.png')
    expect(imageFileName('  ')).toBe('canvas.png')
    expect(imageFileName('deck', 3)).toBe('deck - 3.png')
    expect(imageFileName('deck', null)).toBe('deck.png')
  })
})
