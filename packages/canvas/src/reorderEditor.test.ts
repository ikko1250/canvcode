import { describe, expect, it } from 'vitest'
import { Editor } from './editor.ts'

// Editor の重なり順（最前面へ・前面へ・背面へ・最背面へ）。今はフレームの中のものだけが対象

function setup() {
  const editor = new Editor({ canvasId: 'canvas:1' })
  const frame = editor.makeNode('frame', { x: 0, y: 0 })
  editor.createNodes([frame])
  const rect = (parentId = frame.id) => {
    const node = editor.makeNode('geo', { x: 10, y: 10, parentId, props: { shape: 'rect', w: 50, h: 50 } })
    editor.createNodes([node])
    return node.id
  }
  return { editor, frame: frame.id, rect }
}

describe('editor reorder', () => {
  it('moves nodes inside a frame forward, backward, to the front and to the back', () => {
    const { editor, frame, rect } = setup()
    const [a, b, c, d] = [rect(), rect(), rect(), rect()]
    editor.setSelection([b])
    editor.reorderSelection('forward')
    expect(editor.index.childrenOf(frame)).toEqual([a, c, b, d])
    editor.reorderSelection('front')
    expect(editor.index.childrenOf(frame)).toEqual([a, c, d, b])
    editor.reorderSelection('backward')
    expect(editor.index.childrenOf(frame)).toEqual([a, c, b, d])
    editor.reorderSelection('back')
    expect(editor.index.childrenOf(frame)).toEqual([b, a, c, d])

    // 1 回の操作ごとに 1 回の Undo で戻る
    editor.undo()
    expect(editor.index.childrenOf(frame)).toEqual([a, c, b, d])
  })

  it('moves a contiguous selection together and keeps the frame and its parent unchanged', () => {
    const { editor, frame, rect } = setup()
    const [a, b, c] = [rect(), rect(), rect()]
    const frameBefore = editor.getNode(frame)!
    editor.setSelection([a, b])
    editor.reorderSelection('forward')
    expect(editor.index.childrenOf(frame)).toEqual([c, a, b])
    expect(editor.getNode(frame)).toBe(frameBefore)
    expect(editor.getNode(a)!.parentId).toBe(frame)
  })

  it('only targets nodes whose parent is a frame', () => {
    const { editor, frame, rect } = setup()
    const top = rect('canvas:1')
    const other = rect('canvas:1')
    const inside = rect()
    // フレーム自身と、キャンバス直下のものは対象にしない
    editor.setSelection([top, frame])
    expect(editor.reorderTargets()).toEqual([])
    editor.reorderSelection('front')
    expect(editor.index.childrenOf('canvas:1')).toEqual([frame, top, other])

    editor.setSelection([top, inside])
    expect(editor.reorderTargets()).toEqual([inside])
  })

  it('does nothing (no history entry) when already in place', () => {
    const { editor, frame, rect } = setup()
    const a = rect()
    const b = rect()
    editor.setSelection([b])
    editor.reorderSelection('front')
    editor.reorderSelection('forward')
    expect(editor.index.childrenOf(frame)).toEqual([a, b])
    // 最後の操作は b を作ったこと。Undo すると b が消える
    editor.undo()
    expect(editor.getNode(b)).toBeUndefined()
  })
})
