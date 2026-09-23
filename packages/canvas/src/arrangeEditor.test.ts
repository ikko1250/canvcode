import { describe, expect, it } from 'vitest'
import { makeBinding } from './bindings.ts'
import { Editor, PDF_PAGE_GAP } from './editor.ts'

// Editor の整列・等間隔・間隔（MAI-54）

function setup() {
  const editor = new Editor({ canvasId: 'canvas:1' })
  const rect = (x: number, y: number, w = 100, h = 50, parentId?: string) => {
    const node = editor.makeNode('geo', { x, y, parentId, props: { shape: 'rect', w, h } })
    editor.createNodes([node])
    return node
  }
  const worldOf = (id: string) => {
    const b = editor.index.get(id)!.worldBounds
    return { x: b.x, y: b.y, w: b.w, h: b.h }
  }
  return { editor, rect, worldOf }
}

describe('editor arrange', () => {
  it('aligns the selected nodes, excluding locked nodes and children of a selected ancestor', () => {
    const { editor, rect, worldOf } = setup()
    const a = rect(0, 0)
    const b = rect(300, 200)
    const locked = rect(900, 900)
    editor.setLocked([locked.id], true)
    const group = editor.makeNode('group', { x: 0, y: 0 })
    const c = rect(500, 100, 100, 50, group.id)
    const d = rect(650, 100, 100, 50, group.id)
    editor.createNodes([group, c, d])
    editor.setSelection([a.id, b.id, locked.id, group.id, c.id])
    expect(editor.arrangeTargets().map((t) => t.id).sort()).toEqual([a.id, b.id, group.id].sort())

    editor.alignSelection('left')
    expect(worldOf(b.id).x).toBe(0)
    expect(worldOf(group.id).x).toBe(0)
    // group は 1 つの箱として動くので、子どうしの並びは変わらない
    expect(worldOf(c.id).x).toBe(0)
    expect(worldOf(d.id).x).toBe(150)
    expect(worldOf(locked.id).x).toBe(900)
    // 1 回の Undo で戻る
    expect(editor.undo()).toBe(true)
    expect(worldOf(b.id).x).toBe(300)
    expect(worldOf(c.id).x).toBe(500)
  })

  it('writes positions back through the parent (frame) coordinates', () => {
    const { editor, rect, worldOf } = setup()
    const frame = editor.makeNode('frame', { x: 1000, y: 500, props: { w: 800, h: 400, name: 'F' } })
    editor.createNodes([frame])
    const inside = rect(100, 100, 100, 50, frame.id)
    const outside = rect(0, 0)
    editor.setSelection([inside.id, outside.id])
    editor.alignSelection('top')
    expect(worldOf(inside.id).y).toBe(0)
    expect(editor.getNode(inside.id)?.y).toBe(-500)
    expect(editor.getNode(inside.id)?.parentId).toBe(frame.id)
  })

  it('distributes three or more nodes and spaces nodes with a given gap', () => {
    const { editor, rect, worldOf } = setup()
    const a = rect(0, 0)
    const b = rect(150, 0)
    const c = rect(500, 0)
    editor.setSelection([a.id, b.id, c.id])
    editor.distributeSelection('x')
    expect(worldOf(a.id).x).toBe(0)
    expect(worldOf(b.id).x).toBe(250)
    expect(worldOf(c.id).x).toBe(500)
    expect(editor.spacingHandlesWorld().map((s) => [s.axis, s.gap])).toEqual([['x', 150]])

    editor.spaceSelection('x', 20)
    expect([a.id, b.id, c.id].map((id) => worldOf(id).x)).toEqual([0, 120, 240])
    expect(editor.defaultGap('x')).toBe(20)
    expect(editor.defaultGap('y')).toBe(0)
    expect(editor.spacingHandlesWorld()[0].gaps.length).toBe(2)
    // 等間隔と間隔の指定は、それぞれ 1 回の Undo
    editor.undo()
    expect(worldOf(b.id).x).toBe(250)
    editor.undo()
    expect(worldOf(b.id).x).toBe(150)
    expect(editor.spacingHandlesWorld()).toEqual([])
  })

  it('uses the PDF page gap as the default when only pages are selected', () => {
    const { editor } = setup()
    const page = (x: number) =>
      editor.makeNode('pdf-page', { x, y: 0, props: { assetId: 'a', fileId: 'f', pageIndex: 0, w: 100, h: 100 } })
    const p1 = page(0)
    const p2 = page(500)
    editor.createNodes([p1, p2])
    editor.setSelection([p1.id, p2.id])
    expect(editor.defaultGap('x')).toBe(PDF_PAGE_GAP)
    expect(editor.defaultGap('y')).toBe(PDF_PAGE_GAP)
  })

  it('detaches an arrow from a target that does not move with it', () => {
    const { editor, rect } = setup()
    const a = rect(0, 0)
    const b = rect(300, 0)
    const arrow = editor.makeNode('arrow', { x: 0, y: 300, props: { start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, bend: 0 } })
    editor.transact('arrow', (tx) => {
      tx.put(arrow)
      tx.put(makeBinding(arrow.id, a.id, { terminal: 'start', normalizedAnchor: { x: 0.5, y: 0.5 }, isPrecise: false }))
    })
    expect(editor.bindingsOfArrow(arrow.id).length).toBe(1)
    // a と矢印を右に揃える：矢印だけが動き、a は動かないのでつながりが外れる
    editor.setSelection([arrow.id, b.id])
    editor.alignSelection('right')
    expect(editor.bindingsOfArrow(arrow.id).length).toBe(0)
  })
})
