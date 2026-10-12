import { describe, expect, it } from 'vitest'
import type { NodeRecord, Vec } from '@canvcode/core'
import type { ArrowProps } from '@canvcode/nodes'
import { arrowDirectionUpdate, arrowPivot } from './arrowDirection.ts'
import { makeBinding } from './bindings.ts'
import { Editor } from './editor.ts'
import { editNodes } from './propertyEdit.ts'
import { ArrowTool, SelectTool, arrowHandles, type ToolContext, type ToolPointer } from './tools.ts'

// 矢印の向き：Shift で 45° 刻みに吸い付ける（描くとき・端を動かすとき）、デザインパネルの角度・長さ

function setup() {
  const editor = new Editor({ canvasId: 'canvas:1' })
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
  const pointer = (p: Vec, shiftKey = false): ToolPointer => ({ screen: p, world: p, button: 0, shiftKey, altKey: false, ctrlKey: false, metaKey: false })
  const shape = (x: number, y: number) => {
    const node = editor.makeNode('geo', { x, y, props: { shape: 'rect', w: 100, h: 100 } })
    editor.createNodes([node])
    return node
  }
  const freeArrow = (start: Vec, end: Vec) => {
    const node = editor.makeNode('arrow', { x: 0, y: 0, props: { start, end } })
    editor.createNodes([node])
    return node.id
  }
  const arrow = (id: string) => editor.getNode(id) as NodeRecord<ArrowProps>
  // 曲げる前の端（ワールド座標。矢印は Canvas 直下にある）
  const ends = (id: string) => {
    const node = arrow(id)
    const world = (p: Vec) => ({ x: node.x + p.x, y: node.y + p.y })
    return { start: world(node.props.start), end: world(node.props.end) }
  }
  const drawArrow = (from: Vec, to: Vec, shiftKey: boolean) => {
    const tool = new ArrowTool(ctx)
    tool.onPointerDown(pointer(from, shiftKey))
    tool.onPointerMove(pointer({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, shiftKey))
    tool.onPointerMove(pointer(to, shiftKey))
    tool.onPointerUp()
    const id = [...editor.session.get().selectedIds][0]
    return id
  }
  const dragEnd = (id: string, to: Vec, shiftKey: boolean) => {
    editor.setSelection([id])
    const from = arrowHandles(editor)!.end
    const tool = new SelectTool(ctx)
    tool.onPointerDown(pointer(from))
    tool.onPointerMove(pointer({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, shiftKey))
    tool.onPointerMove(pointer(to, shiftKey))
    tool.onPointerUp(pointer(to, shiftKey))
  }
  return { editor, shape, freeArrow, arrow, ends, drawArrow, dragEnd }
}

function closeTo(actual: Vec, expected: Vec, digits = 4) {
  expect(actual.x).toBeCloseTo(expected.x, digits)
  expect(actual.y).toBeCloseTo(expected.y, digits)
}

describe('shift snapping of arrows', () => {
  it('draws a horizontal, vertical or diagonal arrow with Shift', () => {
    const { drawArrow, ends } = setup()
    const flat = ends(drawArrow({ x: 0, y: 0 }, { x: 200, y: 15 }, true))
    closeTo(flat.start, { x: 0, y: 0 })
    closeTo(flat.end, { x: 200, y: 0 })
    const diagonal = ends(drawArrow({ x: 0, y: 0 }, { x: 100, y: 90 }, true))
    closeTo(diagonal.end, { x: 95, y: 95 })
    // Shift なしならカーソルのまま
    const free = ends(drawArrow({ x: 0, y: 0 }, { x: 200, y: 15 }, false))
    closeTo(free.end, { x: 200, y: 15 })
  })

  it('snaps a dragged end around the other end', () => {
    const { freeArrow, dragEnd, ends } = setup()
    const id = freeArrow({ x: 100, y: 100 }, { x: 300, y: 100 })
    dragEnd(id, { x: 110, y: 300 }, true)
    closeTo(ends(id).start, { x: 100, y: 100 })
    closeTo(ends(id).end, { x: 100, y: 300 })
  })

  it('still connects to a node under the snapped point, at that point so that the angle stays', () => {
    const { editor, shape, drawArrow, ends } = setup()
    const a = shape(0, 0)
    const b = shape(300, 20)
    // a の中心 (50, 50) から、少し下を指して離す → 横に吸い付き、b の (350, 50) につなぐ
    const id = drawArrow({ x: 50, y: 50 }, { x: 350, y: 70 }, true)
    const bindings = editor.bindingsOfArrow(id)
    expect(bindings.map((binding) => [binding.props.terminal, binding.toId]).sort()).toEqual([
      ['end', b.id],
      ['start', a.id],
    ])
    const end = bindings.find((binding) => binding.props.terminal === 'end')!
    expect(end.props.isPrecise).toBe(true)
    closeTo(ends(id).start, { x: 50, y: 50 })
    closeTo(ends(id).end, { x: 350, y: 50 })
  })

  it('measures the snap from the centre of a connected start', () => {
    const { shape, drawArrow, ends } = setup()
    shape(0, 0)
    // 押した点 (20, 30) ではなく、つながった a の中心 (50, 50) から吸い付ける
    const id = drawArrow({ x: 20, y: 30 }, { x: 260, y: 60 }, true)
    closeTo(ends(id).start, { x: 50, y: 50 })
    closeTo(ends(id).end, { x: 260, y: 50 })
  })
})

describe('arrow angle and length from the design panel', () => {
  it('turns a free arrow about its middle, in one undo step', () => {
    const { editor, freeArrow, arrow } = setup()
    const id = freeArrow({ x: 0, y: 0 }, { x: 100, y: 0 })
    expect(arrowPivot(editor, id)).toBe('middle')
    editNodes(editor, [id], arrowDirectionUpdate(editor, { angle: 90 }), 'angle')
    closeTo(arrow(id).props.start, { x: 50, y: -50 })
    closeTo(arrow(id).props.end, { x: 50, y: 50 })
    editNodes(editor, [id], arrowDirectionUpdate(editor, { length: 50 }), 'length')
    closeTo(arrow(id).props.start, { x: 50, y: -25 })
    closeTo(arrow(id).props.end, { x: 50, y: 25 })
    editor.undo()
    editor.undo()
    closeTo(arrow(id).props.end, { x: 100, y: 0 })
  })

  it('keeps a connected end where it is, and leaves an arrow connected at both ends', () => {
    const { editor, shape, freeArrow, arrow } = setup()
    const a = shape(0, 0)
    const b = shape(300, 0)
    const id = freeArrow({ x: 0, y: 0 }, { x: 200, y: 0 })
    editor.transact('bind', (tx) => tx.put(makeBinding(id, a.id, { terminal: 'start', normalizedAnchor: { x: 0.5, y: 0.5 }, isPrecise: false })))
    expect(arrowPivot(editor, id)).toBe('start')
    editNodes(editor, [id], arrowDirectionUpdate(editor, { angle: 90 }), 'angle')
    closeTo(arrow(id).props.start, { x: 50, y: 50 })
    closeTo(arrow(id).props.end, { x: 50, y: 50 + Math.hypot(150, 50) })

    editor.transact('bind', (tx) => tx.put(makeBinding(id, b.id, { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.5 }, isPrecise: false })))
    expect(arrowPivot(editor, id)).toBeNull()
    const before = arrow(id)
    editNodes(editor, [id], arrowDirectionUpdate(editor, { angle: 45 }), 'angle')
    expect(arrow(id)).toBe(before)
  })
})
