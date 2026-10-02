import { describe, expect, it } from 'vitest'
import type { NodeRecord, Vec } from '@canvcode/core'
import type { GeoProps } from '@canvcode/nodes'
import { Editor } from './editor.ts'
import { BLOCK_ARROW_HANDLE_MIN_INSET_PX, blockArrowHandles, hitBlockArrowHandle, withBlockArrowSizes } from './blockArrowHandles.ts'
import { GeoTool, SelectTool, type ToolContext, type ToolPointer } from './tools.ts'

// ブロック矢印の形のハンドル（MAI-87）

function setup(initial: Partial<GeoProps> = {}, rotation = 0) {
  const editor = new Editor({ canvasId: 'canvas:1' })
  const node = { ...editor.makeNode('geo', { x: 100, y: 100, props: { shape: 'blockArrow', w: 200, h: 100, ...initial } }), rotation }
  editor.createNodes([node])
  editor.history.clear(editor.canvasId)
  editor.setSelection([node.id])
  const ctx: ToolContext = {
    editor,
    setTool: () => {},
    lift: () => {},
    drop: () => {},
    setCursor: () => {},
    startEditing: () => false,
    openPortal: () => {},
    editDocument: () => false,
    createDocumentAt: () => {},
    quoteRegion: () => {},
    openCitations: () => {},
    moveToCanvas: () => {},
  }
  // カメラは原点・倍率 1 なので、画面の座標とワールド座標は同じ
  const pointer = (p: Vec): ToolPointer => ({ screen: p, world: p, button: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false })
  const props = () => (editor.getNode(node.id) as NodeRecord<GeoProps>).props
  const handle = (kind: 'shaft' | 'head') => blockArrowHandles(editor)!.handles.find((h) => h.kind === kind)!.point
  const drag = (from: Vec, to: Vec) => {
    const tool = new SelectTool(ctx)
    tool.onPointerDown(pointer(from))
    tool.onPointerMove(pointer({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }))
    tool.onPointerMove(pointer(to))
    tool.onPointerUp(pointer(to))
  }
  return { editor, id: node.id, props, handle, drag, pointer, ctx }
}

function closeTo(actual: Vec, expected: Vec, digits = 4) {
  expect(actual.x).toBeCloseTo(expected.x, digits)
  expect(actual.y).toBeCloseTo(expected.y, digits)
}

describe('block arrow handles', () => {
  it('shows the shaft and head handles, kept a little inside the box', () => {
    const { editor, handle } = setup()
    // 軸の上の縁の真ん中（ローカル (75, 25)）。矢じりの根もと（(150, 0)）は箱の縁から内側へ収める
    closeTo(handle('shaft'), { x: 175, y: 125 })
    closeTo(handle('head'), { x: 250, y: 100 + BLOCK_ARROW_HANDLE_MIN_INSET_PX })
    expect(blockArrowHandles(editor)!.handles).toHaveLength(2)
  })

  it('follows the rotation, and shows one handle for a chevron', () => {
    const rotated = setup({}, Math.PI / 2)
    // ローカルの (75, 25) を原点（100, 100）を中心に 90° 回す → (75, 175)
    closeTo(rotated.handle('shaft'), { x: 75, y: 175 })
    const chevron = setup({ shape: 'chevron' })
    expect(blockArrowHandles(chevron.editor)!.handles.map((h) => h.kind)).toEqual(['head'])
    closeTo(chevron.handle('head'), { x: 150, y: 150 })
  })

  it('hides the handles for other shapes, small shapes, several shapes and text editing', () => {
    expect(blockArrowHandles(setup({ shape: 'rect' }).editor)).toBeNull()
    expect(blockArrowHandles(setup({ w: 30, h: 30 }).editor)).toBeNull()
    const editing = setup()
    editing.editor.session.set({ editingId: editing.id })
    expect(blockArrowHandles(editing.editor)).toBeNull()
    const two = setup()
    const other = two.editor.makeNode('geo', { x: 400, y: 100, props: { shape: 'blockArrow', w: 200, h: 100 } })
    two.editor.createNodes([other])
    two.editor.setSelection([two.id, other.id])
    expect(blockArrowHandles(two.editor)).toBeNull()
  })

  it('changes the shaft thickness symmetrically in one undo step, without moving the shape', () => {
    const { editor, id, props, handle, drag } = setup()
    const start = handle('shaft')
    expect(hitBlockArrowHandle(editor, { x: start.x + 2, y: start.y })).toEqual({ nodeId: id, kind: 'shaft' })
    // 上へ 10 動かすと、軸は 20 太くなる（高さ 100 に対して 0.7）
    drag(start, { x: start.x + 30, y: start.y - 10 })
    expect(props().arrowShaft).toBe(0.7)
    expect(props().arrowHeadLength).toBeUndefined()
    expect(editor.getNode(id)).toMatchObject({ x: 100, y: 100 })
    editor.undo()
    expect(props().arrowShaft).toBeUndefined()
  })

  it('changes the head length and width, limited to the box', () => {
    const { props, handle, drag } = setup({ arrowHeadWidth: 0.8 })
    const start = handle('head')
    // 左へ 20（長く）、上へ 5（上下で 10 広く）
    drag(start, { x: start.x - 20, y: start.y - 5 })
    expect(props()).toMatchObject({ arrowHeadLength: 0.7, arrowHeadWidth: 0.9 })
    // 箱より広く・長くはならない。軸より狭くもならない
    const again = handle('head')
    drag(again, { x: again.x - 500, y: again.y - 500 })
    expect(props()).toMatchObject({ arrowHeadLength: 2, arrowHeadWidth: 1 })
    const third = handle('head')
    drag(third, { x: third.x, y: third.y + 500 })
    expect(props().arrowHeadWidth).toBe(0.5)
  })

  it('changes the bent arrow shaft sideways and the chevron depth', () => {
    const bent = setup({ shape: 'blockArrowBent' })
    const shaft = bent.handle('shaft')
    bent.drag(shaft, { x: shaft.x + 10, y: shaft.y + 3 })
    // 基準は短い辺（100）。30 → 40
    expect(bent.props().arrowShaft).toBe(0.4)
    const chevron = setup({ shape: 'chevron' })
    const head = chevron.handle('head')
    chevron.drag(head, { x: head.x - 20, y: head.y })
    expect(chevron.props().arrowHeadLength).toBe(0.3)
  })

  it('cancels the drag with Escape', () => {
    const { props, handle, pointer, ctx } = setup()
    const tool = new SelectTool(ctx)
    const start = handle('shaft')
    tool.onPointerDown(pointer(start))
    tool.onPointerMove(pointer({ x: start.x, y: start.y - 10 }))
    expect(props().arrowShaft).toBe(0.7)
    expect(tool.cancel()).toBe(true)
    expect(props().arrowShaft).toBeUndefined()
  })

  it('writes ratios of the reference length, only for the values that changed', () => {
    const props = { shape: 'blockArrow', w: 300, h: 120, arrowShaft: 0.5 } as GeoProps
    expect(withBlockArrowSizes(props, { shaft: 60 })).toBe(props)
    expect(withBlockArrowSizes(props, { headLength: 40 })).toMatchObject({ arrowShaft: 0.5, arrowHeadLength: 0.3333 })
  })

  it('creates a block arrow with the shape tool, at its default size on a click', () => {
    const { editor, ctx, pointer } = setup()
    const tool = new GeoTool(ctx, 'blockArrowBoth')
    tool.onPointerDown(pointer({ x: 500, y: 500 }))
    tool.onPointerUp(pointer({ x: 500, y: 500 }))
    const [id] = editor.session.get().selectedIds
    expect(editor.getNode(id)).toMatchObject({ type: 'geo', x: 410, y: 450, props: { shape: 'blockArrowBoth', w: 180, h: 100 } })
    editor.undo()
    expect(editor.getNode(id)).toBeUndefined()
  })
})
