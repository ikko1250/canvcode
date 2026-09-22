import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import { Editor } from './editor.ts'

// 入れ子（group / frame）の扱い（MAI-25）

function setup() {
  const editor = new Editor({ canvasId: 'canvas:1' })
  const rect = (x: number, y: number, w = 100, h = 50, parentId?: string) =>
    editor.makeNode('geo', { x, y, parentId, props: { shape: 'rect', w, h } })
  const worldOf = (id: string) => {
    const e = editor.index.get(id)!
    return { x: e.worldBounds.x, y: e.worldBounds.y, w: e.worldBounds.w, h: e.worldBounds.h }
  }
  return { editor, rect, worldOf }
}

function close(actual: { x: number; y: number; w: number; h: number }, expected: typeof actual) {
  for (const key of ['x', 'y', 'w', 'h'] as const) expect(actual[key]).toBeCloseTo(expected[key], 6)
}

describe('NodeIndex with nesting', () => {
  it('composes world matrices through parents and computes group bounds from children', () => {
    const { editor, rect, worldOf } = setup()
    const group = editor.makeNode('group', { x: 1000, y: 500 })
    const a = rect(0, 0, 100, 50, group.id)
    const b = rect(200, 100, 100, 50, group.id)
    editor.createNodes([group, a, b])
    close(worldOf(a.id), { x: 1000, y: 500, w: 100, h: 50 })
    close(worldOf(group.id), { x: 1000, y: 500, w: 300, h: 150 })

    // group を動かすと、子もワールドで動く
    editor.moveNodes([group.id], 10, 20)
    close(worldOf(b.id), { x: 1210, y: 620, w: 100, h: 50 })
    // 子を動かすと、group の大きさが変わる
    editor.moveNodes([b.id], 100, 0)
    close(worldOf(group.id), { x: 1010, y: 520, w: 400, h: 150 })
  })

  it('orders drawing depth-first: parent before its children, siblings by index', () => {
    const { editor, rect } = setup()
    const back = rect(0, 0)
    editor.createNodes([back])
    const frame = editor.makeNode('frame', { x: 0, y: 0 })
    editor.createNodes([frame])
    const inside = rect(10, 10, 20, 20, frame.id)
    editor.createNodes([inside])
    const front = rect(0, 0)
    editor.createNodes([front])
    expect(editor.index.sortByOrder([front.id, inside.id, back.id, frame.id])).toEqual([back.id, frame.id, inside.id, front.id])
    expect(editor.index.allIds()).toEqual([back.id, frame.id, front.id])
  })
})

describe('grouping', () => {
  it('groups and ungroups without moving anything in the world', () => {
    const { editor, rect, worldOf } = setup()
    const a = { ...rect(100, 100), rotation: Math.PI / 6 }
    const b = rect(400, 200)
    editor.createNodes([a, b])
    const before = [worldOf(a.id), worldOf(b.id)]
    editor.setSelection([a.id, b.id])
    const groupId = editor.groupSelected()!
    expect(editor.getNode(a.id)!.parentId).toBe(groupId)
    expect([...editor.session.get().selectedIds]).toEqual([groupId])
    close(worldOf(a.id), before[0])

    // group ごと回して動かしてから解除しても、ワールドでの位置と向きはそのまま残る
    editor.moveNodes([groupId], 50, 0)
    const moved = [worldOf(a.id), worldOf(b.id)]
    editor.ungroupSelected()
    expect(editor.getNode(groupId)).toBeUndefined()
    expect(editor.getNode(a.id)!.parentId).toBe('canvas:1')
    close(worldOf(a.id), moved[0])
    close(worldOf(b.id), moved[1])
    expect(editor.getNode(a.id)!.rotation).toBeCloseTo(Math.PI / 6, 9)
  })

  it('deletes descendants with their parent, and undo brings them back', () => {
    const { editor, rect } = setup()
    const a = rect(0, 0)
    const b = rect(200, 0)
    editor.createNodes([a, b])
    editor.setSelection([a.id, b.id])
    const groupId = editor.groupSelected()!
    editor.deleteSelected()
    expect(editor.index.size).toBe(0)
    editor.undo()
    expect(editor.getNode(a.id)!.parentId).toBe(groupId)
    expect(editor.index.childrenOf(groupId)).toHaveLength(2)
  })

  it('removes a group once its last child is gone', () => {
    const { editor, rect } = setup()
    const a = rect(0, 0)
    const b = rect(200, 0)
    editor.createNodes([a, b])
    editor.setSelection([a.id, b.id])
    const groupId = editor.groupSelected()!
    editor.deleteNodes([a.id, b.id])
    expect(editor.getNode(groupId)).toBeUndefined()
  })

  it('selects the whole group first, and its children after focusing it', () => {
    const { editor, rect } = setup()
    const a = rect(0, 0)
    const b = rect(200, 0)
    editor.createNodes([a, b])
    editor.setSelection([a.id, b.id])
    const groupId = editor.groupSelected()!
    expect(editor.selectableFor(a.id)).toBe(groupId)
    editor.focusGroup(groupId)
    expect(editor.selectableFor(a.id)).toBe(a.id)
  })

  it('resizes a group by scaling its children', () => {
    const { editor, rect, worldOf } = setup()
    const a = rect(0, 0, 100, 100)
    const b = rect(200, 0, 100, 100)
    editor.createNodes([a, b])
    editor.setSelection([a.id, b.id])
    editor.groupSelected()
    const selection = editor.transformSelection()!
    // 横に 2 倍（300 → 600）
    const nodes = editor.resizeSelection(selection, { ...selection.frame, w: 600 })
    editor.transact('resize', (tx) => nodes.forEach((n) => tx.put(n)))
    close(worldOf(a.id), { x: 0, y: 0, w: 200, h: 100 })
    close(worldOf(b.id), { x: 400, y: 0, w: 200, h: 100 })
  })

  it('rotates nested nodes around the pivot in world space', () => {
    const { editor, rect } = setup()
    const group = editor.makeNode('group', { x: 100, y: 0 })
    const a = rect(0, 0, 10, 10, group.id)
    editor.createNodes([group, a])
    editor.focusGroup(group.id)
    editor.setSelection([a.id])
    const selection = editor.transformSelection()!
    const [rotated] = editor.rotateSelection(selection, { x: 100, y: 0 }, Math.PI / 2)
    editor.transact('rotate', (tx) => tx.put(rotated as NodeRecord))
    const world = editor.toWorld(editor.getNode(a.id)!)
    expect(world.x).toBeCloseTo(100, 9)
    expect(world.y).toBeCloseTo(0, 9)
    expect(world.rotation).toBeCloseTo(Math.PI / 2, 9)
  })
})

describe('frames', () => {
  it('reparents a node into a frame and out again without moving it', () => {
    const { editor, rect, worldOf } = setup()
    const frame = { ...editor.makeNode('frame', { x: 500, y: 500, props: { w: 400, h: 300, name: 'F' } }), rotation: 0.3 }
    const a = rect(600, 600, 50, 50)
    editor.createNodes([frame, a])
    const before = worldOf(a.id)
    expect(editor.frameAt({ x: 700, y: 700 })).toBe(frame.id)
    editor.transact('into', (tx) => editor.reparent(tx, [a.id], frame.id))
    expect(editor.getNode(a.id)!.parentId).toBe(frame.id)
    close(worldOf(a.id), before)
    editor.transact('out', (tx) => editor.reparent(tx, [a.id], 'canvas:1'))
    close(worldOf(a.id), before)
  })

  it('does not put a frame inside itself', () => {
    const { editor } = setup()
    const outer = editor.makeNode('frame', { x: 0, y: 0, props: { w: 400, h: 400, name: 'A' } })
    editor.createNodes([outer])
    const inner = editor.makeNode('frame', { x: 10, y: 10, parentId: outer.id, props: { w: 100, h: 100, name: 'B' } })
    editor.createNodes([inner])
    editor.transact('cycle', (tx) => editor.reparent(tx, [outer.id], inner.id))
    expect(editor.getNode(outer.id)!.parentId).toBe('canvas:1')
  })

  it('selects touching nodes with a brush, but a frame only when fully inside', () => {
    const { editor, rect } = setup()
    const frame = editor.makeNode('frame', { x: 0, y: 0, props: { w: 500, h: 500, name: 'F' } })
    editor.createNodes([frame])
    const inside = rect(100, 100, 50, 50, frame.id)
    const outside = rect(800, 0, 50, 50)
    editor.createNodes([inside, outside])
    // フレームの中で、inside にだけ少し触れる枠
    expect(editor.nodesInBrush({ x: 140, y: 140, w: 100, h: 100 })).toEqual([inside.id])
    // フレームを丸ごと囲む枠
    expect(new Set(editor.nodesInBrush({ x: -10, y: -10, w: 600, h: 600 }))).toEqual(new Set([frame.id, inside.id]))
  })
})
