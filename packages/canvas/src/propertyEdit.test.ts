import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import { Editor } from './editor.ts'
import { PropertyEdit, editNodes, sameValue, sharedValue, type InlineEditTarget } from './propertyEdit.ts'

// ノードのプロパティの変更（MAI-73：デザインパネル）

function setup() {
  const editor = new Editor()
  const a = editor.makeNode('geo', { x: 0, y: 0, props: { shape: 'rect', w: 100, h: 100, fill: '#ffffff' } })
  const b = editor.makeNode('geo', { x: 200, y: 0, props: { shape: 'rect', w: 100, h: 100, fill: '#000000' } })
  editor.createNodes([a, b])
  // 作った操作は履歴から消し、ここで確かめる変更だけを残す
  editor.history.clear(editor.canvasId)
  return { editor, a, b }
}

const withFill = (fill: string) => (node: NodeRecord) => ({ ...node, props: { ...node.props, fill } })
const fillOf = (editor: Editor, id: string) => (editor.getNode(id)!.props as { fill: string }).fill

describe('property edit', () => {
  it('changes several nodes in one transaction that undoes at once', () => {
    const { editor, a, b } = setup()
    expect(editNodes(editor, [a.id, b.id], withFill('#ff0000'), 'fill')).toBe(true)
    expect(fillOf(editor, a.id)).toBe('#ff0000')
    expect(fillOf(editor, b.id)).toBe('#ff0000')
    expect(editor.undo()).toBe(true)
    expect(fillOf(editor, a.id)).toBe('#ffffff')
    expect(fillOf(editor, b.id)).toBe('#000000')
    expect(editor.redo()).toBe(true)
    expect(fillOf(editor, b.id)).toBe('#ff0000')
  })

  it('merges continuous changes (a slider drag) into one undo step', () => {
    const { editor, a } = setup()
    const commits: number[] = []
    editor.store.listen((event) => {
      if (event.phase === 'commit') commits.push(event.patch.size)
    })
    const edit = new PropertyEdit(editor, [a.id], 'stroke width')
    for (const width of [3, 4, 5, 6]) edit.update((node) => ({ ...node, props: { ...node.props, strokeWidth: width } }))
    expect(edit.active).toBe(true)
    // 途中の値もストアに入っている（描き直される）
    expect((editor.getNode(a.id)!.props as { strokeWidth: number }).strokeWidth).toBe(6)
    edit.commit()
    expect(edit.active).toBe(false)
    expect(commits).toEqual([1])
    editor.undo()
    expect((editor.getNode(a.id)!.props as { strokeWidth: number }).strokeWidth).toBe(2)
    expect(editor.history.canUndo(editor.canvasId)).toBe(false)
  })

  it('restores the original values on cancel and leaves no history', () => {
    const { editor, a } = setup()
    const edit = new PropertyEdit(editor, [a.id], 'fill')
    edit.update(withFill('#123456'))
    edit.cancel()
    expect(fillOf(editor, a.id)).toBe('#ffffff')
    expect(editor.history.canUndo(editor.canvasId)).toBe(false)
    expect(editor.store.activeTransaction).toBeNull()
  })

  it('does not record anything when the value does not change', () => {
    const { editor, a } = setup()
    editNodes(editor, [a.id], (node) => node, 'noop')
    expect(editor.history.canUndo(editor.canvasId)).toBe(false)
  })

  it('applies inside the text editing transaction while the node is being edited', () => {
    const { editor, a } = setup()
    const tx = editor.begin('edit text')
    const inline: InlineEditTarget = {
      editingId: a.id,
      updateNode(update) {
        tx.put(update(editor.getNode(a.id)!))
        return true
      },
    }
    expect(editNodes(editor, [a.id], withFill('#00ff00'), 'fill', inline)).toBe(true)
    expect(fillOf(editor, a.id)).toBe('#00ff00')
    // 編集のトランザクションはまだ開いたまま
    expect(editor.store.activeTransaction).toBe(tx)
    editor.finish(tx)
    editor.undo()
    expect(fillOf(editor, a.id)).toBe('#ffffff')
  })

  it('refuses to change while another operation holds a transaction', () => {
    const { editor, a } = setup()
    const tx = editor.begin('drag')
    expect(editNodes(editor, [a.id], withFill('#00ff00'), 'fill')).toBe(false)
    tx.cancel()
    expect(fillOf(editor, a.id)).toBe('#ffffff')
  })
})

describe('shared value', () => {
  it('reports the same value or mixed', () => {
    const { a, b } = setup()
    const fill = (node: NodeRecord) => (node.props as { fill: string }).fill
    const width = (node: NodeRecord) => (node.props as { strokeWidth: number }).strokeWidth
    expect(sharedValue([a, b], width)).toEqual({ kind: 'same', value: 2 })
    expect(sharedValue([a, b], fill)).toEqual({ kind: 'mixed', values: ['#ffffff', '#000000'] })
    expect(sharedValue([], fill)).toBeNull()
  })

  it('compares objects by content', () => {
    expect(sameValue({ x: 1 }, { x: 1 })).toBe(true)
    expect(sameValue({ x: 1 }, { x: 2 })).toBe(false)
    expect(sameValue(1, '1')).toBe(false)
  })
})
