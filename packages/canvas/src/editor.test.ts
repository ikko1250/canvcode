import { describe, expect, it } from 'vitest'
import { Editor } from './editor.ts'

function rect(editor: Editor, x: number, y: number, w = 100, h = 100) {
  return editor.makeNode('geo', { x, y, props: { shape: 'rect', w, h } })
}

describe('editor', () => {
  it('creates nodes on top of each other in order', () => {
    const editor = new Editor()
    const a = rect(editor, 0, 0)
    editor.createNodes([a])
    const b = rect(editor, 50, 50)
    editor.createNodes([b])
    expect(a.index < b.index).toBe(true)
    expect(editor.index.allIds()).toEqual([a.id, b.id])
  })

  it('hit-tests the topmost node and respects the margin', () => {
    const editor = new Editor()
    const a = rect(editor, 0, 0)
    editor.createNodes([a])
    const b = rect(editor, 50, 50)
    editor.createNodes([b])
    expect(editor.hitTest({ x: 75, y: 75 }, 0)?.id).toBe(b.id)
    expect(editor.hitTest({ x: 25, y: 25 }, 0)?.id).toBe(a.id)
    expect(editor.hitTest({ x: 153, y: 100 }, 0)).toBeNull()
    expect(editor.hitTest({ x: 153, y: 100 }, 4)?.id).toBe(b.id)
  })

  it('hit-tests ellipses by their shape, not their bounds', () => {
    const editor = new Editor()
    const e = editor.makeNode('geo', { x: 0, y: 0, props: { shape: 'ellipse', w: 100, h: 100 } })
    editor.createNodes([e])
    expect(editor.hitTest({ x: 50, y: 50 }, 0)?.id).toBe(e.id)
    expect(editor.hitTest({ x: 3, y: 3 }, 0)).toBeNull()
  })

  it('updates the spatial index when nodes move and restores selection on undo', () => {
    const editor = new Editor()
    const a = rect(editor, 0, 0)
    editor.createNodes([a])
    editor.setSelection([a.id])
    editor.moveNodes([a.id], 500, 0)
    expect(editor.index.search({ x: 0, y: 0, w: 10, h: 10 })).toEqual([])
    expect(editor.index.search({ x: 520, y: 20, w: 10, h: 10 })).toEqual([a.id])

    editor.deleteSelected()
    expect(editor.session.get().selectedIds.size).toBe(0)
    expect(editor.undo()).toBe(true)
    expect(editor.getNode(a.id)?.x).toBe(500)
    expect([...editor.session.get().selectedIds]).toEqual([a.id])
    expect(editor.undo()).toBe(true)
    expect(editor.getNode(a.id)?.x).toBe(0)
  })

  it('keeps undo history per canvas', () => {
    const editor = new Editor({ canvasId: 'canvas:one' })
    editor.createNodes([rect(editor, 0, 0)])
    expect(editor.history.canUndo('canvas:one')).toBe(true)
    expect(editor.history.canUndo('canvas:other')).toBe(false)
  })
})
