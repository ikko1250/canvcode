import { describe, expect, it } from 'vitest'
import type { NodeRecord, Vec } from '@canvcode/core'
import { gradientStop, linearGradient, type CornerRadius, type GeoProps } from '@canvcode/nodes'
import { Editor } from './editor.ts'
import { CORNER_HANDLE_MIN_INSET_PX, cornerHandles, hitCornerHandle, withCornerRadius } from './cornerHandles.ts'
import { SelectTool, selectionHandles, type ToolContext, type ToolPointer } from './tools.ts'
import { hitHandle } from './transform.ts'

// 角丸のハンドル（MAI-84）

function setup(props: Partial<GeoProps> = {}, rotation = 0) {
  const editor = new Editor({ canvasId: 'canvas:1' })
  const node = { ...editor.makeNode('geo', { x: 100, y: 100, props: { shape: 'rect', w: 200, h: 100, ...props } }), rotation }
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
  const pointer = (p: Vec, mods: Partial<ToolPointer> = {}): ToolPointer => ({
    screen: p,
    world: p,
    button: 0,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...mods,
  })
  const radius = () => (editor.getNode(node.id) as NodeRecord<GeoProps>).props.cornerRadius
  const tool = new SelectTool(ctx)
  // ポインタを図形の上に置く（角丸のハンドルは、そのときだけ出る）
  const bounds = editor.index.get(node.id)!.worldBounds
  tool.onPointerMove(pointer({ x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 }))
  return { editor, id: node.id, tool, pointer, radius }
}

function closeTo(actual: Vec, expected: Vec, digits = 4) {
  expect(actual.x).toBeCloseTo(expected.x, digits)
  expect(actual.y).toBeCloseTo(expected.y, digits)
}

describe('corner radius handles', () => {
  it('shows the handles only while the pointer is over the selected shape', () => {
    const { editor, id, tool, pointer } = setup()
    expect(editor.session.get().cornerHandlesId).toBe(id)
    expect(cornerHandles(editor)).not.toBeNull()
    tool.onPointerMove(pointer({ x: 500, y: 500 }))
    expect(cornerHandles(editor)).toBeNull()
    // 縁のすぐ外（ハンドルをつかめる幅）までは出したまま
    tool.onPointerMove(pointer({ x: 303, y: 150 }))
    expect(cornerHandles(editor)).not.toBeNull()
  })

  it('shows a handle inside each corner, at least a little away from the corner', () => {
    const { editor } = setup()
    const handles = cornerHandles(editor)!
    const m = CORNER_HANDLE_MIN_INSET_PX
    closeTo(handles.points[0], { x: 100 + m, y: 100 + m })
    closeTo(handles.points[1], { x: 300 - m, y: 100 + m })
    closeTo(handles.points[2], { x: 300 - m, y: 200 - m })
    closeTo(handles.points[3], { x: 100 + m, y: 200 - m })
    // リサイズのハンドル・辺とは重ならない（角の内側のハンドルの位置は、選択枠のハンドルに当たらない）
    const selection = selectionHandles(editor)!
    for (const point of handles.points) expect(hitHandle(selection.handles, point)).toBeNull()
  })

  it('places the handle at the radius, and follows the rotation', () => {
    const { editor } = setup({ cornerRadius: [30, 0, 0, 0] }, Math.PI / 2)
    const handles = cornerHandles(editor)!
    // ローカルの (30, 30) を原点（100, 100）を中心に 90° 回す → (70, 130)
    closeTo(handles.points[0], { x: 70, y: 130 })
  })

  it('hides the handles for ellipses, several shapes, small shapes, text editing and gradient editing', () => {
    expect(cornerHandles(setup({ shape: 'ellipse' }).editor)).toBeNull()
    expect(cornerHandles(setup({ w: 40, h: 40 }).editor)).toBeNull()
    const zoomedOut = setup()
    zoomedOut.editor.session.set({ camera: { x: 0, y: 0, zoom: 0.25 } })
    expect(cornerHandles(zoomedOut.editor)).toBeNull()
    const editing = setup()
    editing.editor.session.set({ editingId: editing.id })
    expect(cornerHandles(editing.editor)).toBeNull()
    const gradient = setup({ fill: linearGradient([gradientStop(0, '#ff0000'), gradientStop(1, '#0000ff')]) })
    gradient.editor.session.set({ paintEditing: { nodeId: gradient.id, stop: 0 } })
    expect(cornerHandles(gradient.editor)).toBeNull()
    const two = setup()
    const other = two.editor.makeNode('geo', { x: 400, y: 100, props: { shape: 'rect', w: 200, h: 100 } })
    two.editor.createNodes([other])
    two.editor.setSelection([two.id, other.id])
    expect(cornerHandles(two.editor)).toBeNull()
  })

  it('drags all corners along the diagonal in one undo step, without moving the shape', () => {
    const { editor, id, tool, pointer, radius } = setup()
    const start = cornerHandles(editor)!.points[0]
    expect(hitCornerHandle(editor, { x: start.x + 2, y: start.y + 1 })).toEqual({ nodeId: id, corner: 0 })
    tool.onPointerDown(pointer(start))
    tool.onPointerMove(pointer({ x: start.x + 10, y: start.y + 10 }))
    tool.onPointerMove(pointer({ x: start.x + 20, y: start.y + 20 }))
    tool.onPointerUp(pointer({ x: start.x + 20, y: start.y + 20 }))
    // 動かした量（対角線に沿って 20）だけ半径が増える。つかんだ位置では跳ねない
    expect(radius()).toBe(20)
    expect(editor.getNode(id)).toMatchObject({ x: 100, y: 100 })
    editor.undo()
    expect(radius()).toBeUndefined()
  })

  it('limits the radius to half the shorter side, and changes one corner with Alt', () => {
    const { editor, tool, pointer, radius } = setup({ cornerRadius: 10 })
    const start = cornerHandles(editor)!.points[2]
    tool.onPointerDown(pointer(start))
    tool.onPointerMove(pointer({ x: start.x - 500, y: start.y - 500 }))
    tool.onPointerUp(pointer({ x: start.x - 500, y: start.y - 500 }))
    expect(radius()).toBe(50)
    const again = cornerHandles(editor)!.points[2]
    tool.onPointerDown(pointer(again))
    tool.onPointerMove(pointer({ x: again.x + 30, y: again.y + 30 }, { altKey: true }))
    tool.onPointerUp(pointer({ x: again.x + 30, y: again.y + 30 }))
    expect(radius()).toEqual([50, 50, 20, 50])
  })

  it('cancels the drag with Escape', () => {
    const { editor, tool, pointer, radius } = setup({ cornerRadius: 10 })
    const start = cornerHandles(editor)!.points[0]
    tool.onPointerDown(pointer(start))
    tool.onPointerMove(pointer({ x: start.x + 20, y: start.y + 20 }))
    expect(radius()).toBe(30)
    expect(tool.cancel()).toBe(true)
    expect(radius()).toBe(10)
  })

  it('writes one corner keeping the others, merging equal corners into a number', () => {
    const props = { shape: 'rect', w: 100, h: 100, cornerRadius: 8 as CornerRadius } as GeoProps
    expect(withCornerRadius(props, 1, 4, true).cornerRadius).toEqual([8, 4, 8, 8])
    expect(withCornerRadius({ ...props, cornerRadius: [8, 4, 8, 8] }, 1, 8, true).cornerRadius).toBe(8)
    expect(withCornerRadius(props, 1, 4, false).cornerRadius).toBe(4)
  })
})
