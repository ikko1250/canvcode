import { describe, expect, it } from 'vitest'
import type { NodeRecord, Vec } from '@canvcode/core'
import { gradientStop, linearGradient, radialGradient, solidPaint, type GeoProps, type LinearGradientPaint, type RadialGradientPaint } from '@canvcode/nodes'
import { Editor } from './editor.ts'
import { addStop, gradientHandles, hitGradientHandle, moveStop, removeSelectedStop, removeStop } from './gradientHandles.ts'
import { SelectTool, selectionHandles, type ToolContext, type ToolPointer } from './tools.ts'

// グラデーションのハンドル（MAI-82）

const STOPS = [gradientStop(0, '#ff0000'), gradientStop(1, '#0000ff')]

function setup(fill = linearGradient(STOPS, { start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 } }) as GeoProps['fill'], rotation = 0) {
  const editor = new Editor({ canvasId: 'canvas:1' })
  const node = { ...editor.makeNode('geo', { x: 100, y: 100, props: { shape: 'rect', w: 200, h: 100, fill } }), rotation }
  editor.createNodes([node])
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
  const fillOf = () => (editor.getNode(node.id) as NodeRecord<GeoProps>).props.fill
  return { editor, id: node.id, tool: new SelectTool(ctx), pointer, fillOf }
}

function closeTo(actual: Vec, expected: Vec, digits = 4) {
  expect(actual.x).toBeCloseTo(expected.x, digits)
  expect(actual.y).toBeCloseTo(expected.y, digits)
}

describe('gradient handles', () => {
  it('shows the handles only while the fill is being edited, and hides the resize handles then', () => {
    const { editor, id } = setup()
    expect(gradientHandles(editor)).toBeNull()
    expect(selectionHandles(editor)).not.toBeNull()
    editor.session.set({ paintEditing: { nodeId: id, stop: 0 } })
    const handles = gradientHandles(editor)!
    closeTo(handles.start, { x: 100, y: 150 })
    closeTo(handles.end, { x: 300, y: 150 })
    expect(handles.stops.map((s) => s.point.x)).toEqual([100, 300])
    expect(selectionHandles(editor)).toBeNull()
    // 選び方が変わったら出さない
    editor.setSelection([])
    expect(gradientHandles(editor)).toBeNull()
  })

  it('does not show handles for a solid fill', () => {
    const { editor, id } = setup(solidPaint('#ff0000'))
    editor.session.set({ paintEditing: { nodeId: id, stop: 0 } })
    expect(gradientHandles(editor)).toBeNull()
    expect(selectionHandles(editor)).not.toBeNull()
  })

  it('follows the rotation of the shape', () => {
    const { editor, id } = setup(undefined, Math.PI / 2)
    editor.session.set({ paintEditing: { nodeId: id, stop: 0 } })
    const handles = gradientHandles(editor)!
    // ノードの原点（100, 100）を中心に 90° 回る：ローカルの (0, 50) → (50, 0) 戻して (50, 100)、(200, 50) → (-50, 200) → (50, 300)
    closeTo(handles.start, { x: 50, y: 100 })
    closeTo(handles.end, { x: 50, y: 300 })
  })

  it('shows the center and the radius of a radial gradient', () => {
    const { editor, id } = setup(radialGradient(STOPS, { center: { x: 0.5, y: 0.5 }, radius: 0.25 }))
    editor.session.set({ paintEditing: { nodeId: id, stop: 1 } })
    const handles = gradientHandles(editor)!
    closeTo(handles.start, { x: 200, y: 150 })
    closeTo(handles.end, { x: 250, y: 150 })
    expect(handles.selectedStop).toBe(1)
  })

  it('drags the end point in one undo step', () => {
    const { editor, id, tool, pointer, fillOf } = setup()
    editor.session.set({ paintEditing: { nodeId: id, stop: 0 } })
    expect(hitGradientHandle(editor, { x: 302, y: 151 })?.hit).toEqual({ handle: 'end' })
    tool.onPointerDown(pointer({ x: 300, y: 150 }))
    tool.onPointerMove(pointer({ x: 250, y: 180 }))
    tool.onPointerMove(pointer({ x: 200, y: 200 }))
    tool.onPointerUp(pointer({ x: 200, y: 200 }))
    expect((fillOf() as LinearGradientPaint).end).toEqual({ x: 0.5, y: 1 })
    // ノードは動いていない
    expect(editor.getNode(id)).toMatchObject({ x: 100, y: 100 })
    editor.undo()
    expect((fillOf() as LinearGradientPaint).end).toEqual({ x: 1, y: 0.5 })
  })

  it('snaps the direction to 15 degrees with Shift', () => {
    const { editor, id, tool, pointer, fillOf } = setup()
    editor.session.set({ paintEditing: { nodeId: id, stop: 0 } })
    tool.onPointerDown(pointer({ x: 300, y: 150 }))
    tool.onPointerMove(pointer({ x: 290, y: 153 }, { shiftKey: true }))
    tool.onPointerUp(pointer({ x: 290, y: 153 }))
    expect((fillOf() as LinearGradientPaint).end.y).toBeCloseTo(0.5, 4)
  })

  it('moves the center and the radius of a radial gradient', () => {
    const { editor, id, tool, pointer, fillOf } = setup(radialGradient(STOPS, { radius: 0.25 }))
    editor.session.set({ paintEditing: { nodeId: id, stop: 0 } })
    tool.onPointerDown(pointer({ x: 250, y: 150 }))
    tool.onPointerMove(pointer({ x: 300, y: 150 }))
    tool.onPointerUp(pointer({ x: 300, y: 150 }))
    expect((fillOf() as RadialGradientPaint).radius).toBeCloseTo(0.5, 4)
    tool.onPointerDown(pointer({ x: 200, y: 150 }))
    tool.onPointerMove(pointer({ x: 150, y: 125 }))
    tool.onPointerUp(pointer({ x: 150, y: 125 }))
    expect((fillOf() as RadialGradientPaint).center).toEqual({ x: 0.25, y: 0.25 })
  })

  it('adds a stop by clicking the line, moves it, selects it, and removes it with Delete', () => {
    const { editor, id, tool, pointer, fillOf } = setup()
    editor.session.set({ paintEditing: { nodeId: id, stop: 0 } })
    tool.onPointerDown(pointer({ x: 200, y: 150 }))
    tool.onPointerMove(pointer({ x: 250, y: 160 }))
    tool.onPointerUp(pointer({ x: 250, y: 160 }))
    const stops = (fillOf() as LinearGradientPaint).stops
    expect(stops).toHaveLength(3)
    // 足した位置の色（赤と青の真ん中）で、動かした先（0.75）にある
    expect(stops[1]).toEqual({ position: 0.75, color: '#800080', opacity: 1 })
    expect(editor.session.get().paintEditing).toEqual({ nodeId: id, stop: 1 })
    // 足して動かすまでが Undo 1 回
    editor.undo()
    expect((fillOf() as LinearGradientPaint).stops).toHaveLength(2)
    editor.redo()
    // 止め色を、もう一方の止め色を越えて動かすと、並べ直して選び直す
    tool.onPointerDown(pointer({ x: 250, y: 150 }))
    tool.onPointerMove(pointer({ x: 120, y: 150 }))
    tool.onPointerUp(pointer({ x: 120, y: 150 }))
    expect((fillOf() as LinearGradientPaint).stops.map((s) => s.position)).toEqual([0, 0.1, 1])
    expect(editor.session.get().paintEditing?.stop).toBe(1)
    expect(removeSelectedStop(editor)).toBe(true)
    expect((fillOf() as LinearGradientPaint).stops.map((s) => s.position)).toEqual([0, 1])
    // 2 つより少なくはしない
    expect(removeSelectedStop(editor)).toBe(false)
  })

  it('cancels a drag with Esc', () => {
    const { editor, id, tool, pointer, fillOf } = setup()
    editor.session.set({ paintEditing: { nodeId: id, stop: 0 } })
    tool.onPointerDown(pointer({ x: 100, y: 150 }))
    tool.onPointerMove(pointer({ x: 150, y: 120 }))
    expect(tool.cancel()).toBe(true)
    expect((fillOf() as LinearGradientPaint).start).toEqual({ x: 0, y: 0.5 })
  })
})

describe('stop helpers', () => {
  it('moves, adds and removes stops keeping them in order', () => {
    const stops = [gradientStop(0, '#000000'), gradientStop(0.5, '#808080'), gradientStop(1, '#ffffff')]
    expect(moveStop(stops, 0, 0.75)).toEqual({ stops: [stops[1], { ...stops[0], position: 0.75 }, stops[2]], index: 1 })
    const added = addStop(stops, 0.25)
    expect(added.index).toBe(1)
    expect(added.stops[1]).toEqual({ position: 0.25, color: '#404040', opacity: 1 })
    expect(removeStop(stops, 2)).toEqual({ stops: stops.slice(0, 2), index: 1 })
    expect(removeStop(stops.slice(0, 2), 0)).toBeNull()
  })
})
