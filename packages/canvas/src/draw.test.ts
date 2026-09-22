import { describe, expect, it } from 'vitest'
import type { NodeRecord, Vec } from '@canvcode/core'
import { distanceToPolyline, drawBounds, drawType, normalizeDrawPoints, segmentTouchesDraw, type DrawProps } from '@canvcode/nodes'
import { Editor } from './editor.ts'
import { DrawTool, EraserTool, type ToolContext, type ToolPointer } from './tools.ts'

// フリーハンドと消しゴム（MAI-27）

const props = (points: number[], size = 4): DrawProps => ({ points, color: '#000', size, isComplete: true })

function setup() {
  const editor = new Editor({ canvasId: 'canvas:1' })
  const ctx: ToolContext = {
    editor,
    setTool: (id) => editor.session.set({ toolId: id }),
    lift: () => {},
    drop: () => {},
    setCursor: () => {},
    startEditing: () => false,
    openPortal: () => {},
    editDocument: () => false,
    createDocumentAt: () => {},
    quoteRegion: () => {},
    openCitations: () => {},
  }
  const pointer = (x: number, y: number, coalesced?: Vec[], shiftKey = false): ToolPointer => ({
    screen: { x, y },
    world: { x, y },
    button: 0,
    shiftKey,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    coalesced,
  })
  const stroke = (points: Vec[]) => {
    const tool = new DrawTool(ctx)
    tool.onPointerDown(pointer(points[0].x, points[0].y))
    for (const p of points.slice(1)) tool.onPointerMove(pointer(p.x, p.y))
    tool.onPointerUp()
  }
  const draws = () => [...editor.store.values()].filter((n) => n.typeName === 'node' && n.type === 'draw') as NodeRecord<DrawProps>[]
  return { editor, ctx, pointer, stroke, draws }
}

describe('draw geometry', () => {
  it('computes bounds from the points plus half the stroke width', () => {
    expect(drawBounds(props([0, 0, 100, 50]))).toEqual({ x: -2, y: -2, w: 104, h: 54 })
  })

  it('normalizes the points so that the bounds start at (0, 0)', () => {
    const { props: moved, offset } = normalizeDrawPoints(props([10, 20, 110, 70]))
    expect(offset).toEqual({ x: 8, y: 18 })
    expect(drawBounds(moved)).toEqual({ x: 0, y: 0, w: 104, h: 54 })
  })

  it('measures the distance to the polyline, and detects a crossing segment', () => {
    const line = props([0, 0, 100, 0])
    expect(distanceToPolyline(line.points, { x: 50, y: 10 })).toBeCloseTo(10, 9)
    expect(distanceToPolyline(line.points, { x: 110, y: 0 })).toBeCloseTo(10, 9)
    // 線をまたぐ長い線分は、端の点が遠くても触れている
    expect(segmentTouchesDraw(line, { x: 50, y: -100 }, { x: 50, y: 100 }, 1)).toBe(true)
    expect(segmentTouchesDraw(line, { x: 150, y: -100 }, { x: 150, y: 100 }, 1)).toBe(false)
  })

  it('stretches the points on resize without changing the stroke width', () => {
    const node = { props: normalizeDrawPoints(props([0, 0, 100, 50])).props } as NodeRecord<DrawProps>
    const resized = drawType.resize!(node, { w: 204, h: 54 })
    expect(resized.size).toBe(4)
    expect(drawBounds(resized)).toEqual({ x: 0, y: 0, w: 204, h: 54 })
  })
})

describe('draw tool', () => {
  it('creates one normalized, complete stroke per drag, as one undo step', () => {
    const { editor, stroke, draws } = setup()
    stroke([
      { x: 100, y: 100 },
      { x: 150, y: 120 },
      { x: 200, y: 100 },
    ])
    const [node] = draws()
    expect(node.props.isComplete).toBe(true)
    expect(node.props.points).toHaveLength(6)
    const box = editor.index.get(node.id)!.worldBounds
    expect(box.x).toBeCloseTo(98, 9)
    expect(box.y).toBeCloseTo(98, 9)
    expect(editor.getType(node).getBounds(node)).toMatchObject({ x: 0, y: 0 })
    editor.undo()
    expect(draws()).toHaveLength(0)
  })

  it('uses coalesced pointer positions and drops points closer than a pixel', () => {
    const { ctx, pointer, draws } = setup()
    const tool = new DrawTool(ctx)
    tool.onPointerDown(pointer(0, 0))
    tool.onPointerMove(pointer(30, 0, [{ x: 10, y: 0 }, { x: 10.2, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }]))
    tool.onPointerUp()
    expect(draws()[0].props.points).toHaveLength(8)
  })

  it('draws a straight line while Shift is held, and goes back to freehand when released', () => {
    const { ctx, pointer, draws } = setup()
    const collinear = (points: number[], from: number, to: number) => {
      // from〜to の点が、from と to を結ぶ直線の上にあるか
      const [ax, ay, bx, by] = [points[from], points[from + 1], points[to], points[to + 1]]
      for (let i = from; i <= to; i += 2) {
        const cross = (bx - ax) * (points[i + 1] - ay) - (by - ay) * (points[i] - ax)
        if (Math.abs(cross) > 1e-6 * Math.hypot(bx - ax, by - ay)) return false
      }
      return true
    }
    // 最初から Shift：途中でどう動かしても、始点から終点までの直線になる
    const tool = new DrawTool(ctx)
    tool.onPointerDown({ ...pointer(0, 0), shiftKey: true })
    tool.onPointerMove(pointer(50, 80, undefined, true))
    tool.onPointerMove(pointer(100, 0, undefined, true))
    tool.onPointerUp()
    const line = draws()[0].props.points
    expect(collinear(line, 0, line.length - 2)).toBe(true)
    // 点は一定の間隔で並ぶ（100px を 4px ずつ）
    expect(line.length / 2).toBe(26)

    // 途中で Shift：それまでのフリーハンドは残り、押したときの点から直線になる。離すとフリーハンドに戻る
    tool.onPointerDown(pointer(0, 200))
    tool.onPointerMove(pointer(20, 230))
    tool.onPointerMove(pointer(40, 200))
    tool.onPointerMove(pointer(90, 260, undefined, true))
    tool.onPointerMove(pointer(140, 200, undefined, true))
    tool.onPointerMove(pointer(160, 230))
    tool.onPointerUp()
    const mixed = draws()[1].props.points
    const box = draws()[1]
    // 描き終えると点列はずれるので、ワールド座標に戻して比べる
    const world = (i: number) => ({ x: box.x + mixed[i], y: box.y + mixed[i + 1] })
    expect(world(2)).toEqual({ x: 20, y: 230 })
    expect(world(4)).toEqual({ x: 40, y: 200 })
    expect(collinear(mixed, 4, mixed.length - 4)).toBe(true)
    expect(world(mixed.length - 4)).toEqual({ x: 140, y: 200 })
    expect(world(mixed.length - 2)).toEqual({ x: 160, y: 230 })
  })

  it('draws into a frame when started over it, and cancels with Esc', () => {
    const { editor, ctx, pointer, stroke, draws } = setup()
    const frame = editor.makeNode('frame', { x: 0, y: 0, props: { w: 400, h: 400, name: 'F' } })
    editor.createNodes([frame])
    stroke([
      { x: 50, y: 50 },
      { x: 80, y: 60 },
    ])
    expect(draws()[0].parentId).toBe(frame.id)

    const tool = new DrawTool(ctx)
    tool.onPointerDown(pointer(500, 500))
    tool.onPointerMove(pointer(600, 600))
    expect(tool.cancel()).toBe(true)
    expect(draws()).toHaveLength(1)
  })
})

describe('eraser', () => {
  it('erases only freehand strokes touched by the drag, as one undo step', () => {
    const { editor, ctx, pointer, stroke, draws } = setup()
    stroke([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ])
    stroke([
      { x: 0, y: 100 },
      { x: 100, y: 100 },
    ])
    const rect = editor.makeNode('geo', { x: 0, y: 190, props: { shape: 'rect', w: 100, h: 20 } })
    editor.createNodes([rect])

    const eraser = new EraserTool(ctx)
    // 上から下へなぞる。2 本の線と矩形をまたぐ
    eraser.onPointerDown(pointer(50, -20))
    eraser.onPointerMove(pointer(50, 220))
    eraser.onPointerUp()
    expect(draws()).toHaveLength(0)
    expect(editor.getNode(rect.id)).toBeDefined()
    editor.undo()
    expect(draws()).toHaveLength(2)
  })

  it('erases a stroke inside a group by itself, and the group goes when empty', () => {
    const { editor, ctx, pointer, stroke, draws } = setup()
    stroke([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ])
    stroke([
      { x: 0, y: 100 },
      { x: 100, y: 100 },
    ])
    editor.setSelection(draws().map((n) => n.id))
    const groupId = editor.groupSelected()!
    const eraser = new EraserTool(ctx)
    eraser.onPointerDown(pointer(50, -10))
    eraser.onPointerMove(pointer(50, 10))
    eraser.onPointerUp()
    expect(draws()).toHaveLength(1)
    expect(draws()[0].parentId).toBe(groupId)

    eraser.onPointerDown(pointer(50, 90))
    eraser.onPointerMove(pointer(50, 110))
    eraser.onPointerUp()
    expect(editor.getNode(groupId)).toBeUndefined()
  })

  it('restores the strokes when cancelled, and leaves no history when nothing was erased', () => {
    const { editor, ctx, pointer, stroke, draws } = setup()
    stroke([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ])
    const eraser = new EraserTool(ctx)
    eraser.onPointerDown(pointer(50, -10))
    eraser.onPointerMove(pointer(50, 10))
    expect(draws()).toHaveLength(0)
    eraser.cancel()
    expect(draws()).toHaveLength(1)

    eraser.onPointerDown(pointer(500, 500))
    eraser.onPointerUp()
    // 何も消さなかったドラッグは履歴に残らないので、Undo は線を描いたことを取り消す
    editor.undo()
    expect(draws()).toHaveLength(0)
  })
})
