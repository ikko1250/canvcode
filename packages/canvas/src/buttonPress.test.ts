import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import type { ButtonProps } from '@canvcode/nodes'
import { Editor } from './editor.ts'
import { ButtonTool, SelectTool, type ToolContext, type ToolPointer } from './tools.ts'

// ボタン（押せるノード）：選んでいないボタンのクリックは押す（選ばない）、ドラッグは選んで動かす、選んでいればふつうに選ぶ

function setup(options: { press?: boolean; canPress?: () => boolean } = {}) {
  const editor = new Editor({ canvasId: 'canvas:1' })
  const pressed: string[] = []
  const edited: string[] = []
  const ctx: ToolContext = {
    editor,
    setTool: (id) => editor.session.set({ toolId: id }),
    lift: () => {},
    drop: () => {},
    setCursor: () => {},
    startEditing: (id) => {
      edited.push(id)
      return true
    },
    openPortal: () => {},
    editDocument: () => false,
    createDocumentAt: () => {},
    quoteRegion: () => {},
    openCitations: () => {},
    moveToCanvas: () => {},
    ...(options.press === false ? {} : { pressButton: (id: string) => void pressed.push(id) }),
    ...(options.canPress ? { canPressButton: options.canPress } : {}),
  }
  const pointer = (x: number, y: number, mods: Partial<ToolPointer> = {}): ToolPointer => ({
    screen: { x, y },
    world: { x, y },
    button: 0,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...mods,
  })
  const button = editor.makeNode('button', { x: 100, y: 100, props: { label: 'Mac 向けにする' } })
  editor.createNodes([button])
  return { editor, ctx, pointer, pressed, edited, button, tool: new SelectTool(ctx) }
}

describe('pressing a button with the select tool', () => {
  it('clicking an unselected button presses it without selecting it', () => {
    const { editor, tool, pointer, pressed, button } = setup()
    tool.onPointerDown(pointer(110, 110))
    expect(editor.session.get().selectedIds.size).toBe(0)
    tool.onPointerUp(pointer(110, 110))
    expect(pressed).toEqual([button.id])
    expect(editor.session.get().selectedIds.size).toBe(0)
  })

  it('keeps the current selection when a button is pressed', () => {
    const { editor, tool, pointer, pressed, button } = setup()
    const note = editor.makeNode('note', { x: 400, y: 400 })
    editor.createNodes([note])
    editor.setSelection([note.id])
    tool.onPointerDown(pointer(110, 110))
    tool.onPointerUp(pointer(110, 110))
    expect(pressed).toEqual([button.id])
    expect([...editor.session.get().selectedIds]).toEqual([note.id])
  })

  it('dragging an unselected button selects and moves it instead of pressing', () => {
    const { editor, tool, pointer, pressed, button } = setup()
    tool.onPointerDown(pointer(110, 110))
    tool.onPointerMove(pointer(160, 130))
    tool.onPointerUp(pointer(160, 130))
    expect(pressed).toEqual([])
    expect([...editor.session.get().selectedIds]).toEqual([button.id])
    expect(editor.getNode(button.id)).toMatchObject({ x: 150, y: 120 })
  })

  it('a selected button is clicked like any other node, and double-click edits its label', () => {
    const { editor, tool, pointer, pressed, edited, button } = setup()
    editor.setSelection([button.id])
    tool.onPointerDown(pointer(110, 110))
    tool.onPointerUp(pointer(110, 110))
    expect(pressed).toEqual([])
    tool.onDoubleClick(pointer(110, 110))
    expect(edited).toEqual([button.id])
  })

  it('double-clicking an unselected button presses it once and does not start editing', () => {
    const { tool, pointer, pressed, edited, button } = setup()
    for (let i = 0; i < 2; i++) {
      tool.onPointerDown(pointer(110, 110))
      tool.onPointerUp(pointer(110, 110))
    }
    tool.onDoubleClick(pointer(110, 110))
    expect(pressed).toEqual([button.id])
    expect(edited).toEqual([])
  })

  it('a locked button can still be pressed (also inside a frame), and dragging on it selects a range instead of moving it', () => {
    const { editor, tool, pointer, pressed, button } = setup()
    const frame = editor.makeNode('frame', { x: 0, y: 0, props: { w: 600, h: 600 } })
    editor.createNodes([frame])
    editor.transact('into frame', (tx) => tx.put({ ...editor.getNode(button.id)!, parentId: frame.id }))
    editor.setLocked([button.id], true)
    tool.onPointerDown(pointer(110, 110))
    tool.onPointerUp(pointer(110, 110))
    expect(pressed).toEqual([button.id])
    tool.onPointerDown(pointer(112, 112))
    tool.onPointerMove(pointer(400, 400))
    tool.onPointerUp(pointer(400, 400))
    expect(pressed).toEqual([button.id])
    expect(editor.getNode(button.id)).toMatchObject({ x: 100, y: 100 })
  })

  it('a locked button on top of another node is pressed, not the node underneath selected', () => {
    const { editor, tool, pointer, pressed, button } = setup()
    const below = editor.makeNode('geo', { x: 50, y: 50, index: 'a0', props: { w: 300, h: 300 } })
    editor.createNodes([below])
    editor.transact('front', (tx) => tx.put({ ...editor.getNode(button.id)!, index: 'z0' }))
    editor.setLocked([button.id], true)
    tool.onPointerDown(pointer(110, 110))
    tool.onPointerUp(pointer(110, 110))
    expect(pressed).toEqual([button.id])
    expect(editor.session.get().selectedIds.size).toBe(0)
  })

  it('does not press when the browser cancels the pointer or a context menu opens (long press)', () => {
    const { tool, pointer, pressed } = setup()
    tool.onPointerDown(pointer(110, 110))
    tool.onPointerUp(pointer(110, 110, { cancelled: true }))
    expect(pressed).toEqual([])
    tool.onPointerDown(pointer(110, 110))
    tool.onContextMenu()
    tool.onPointerUp(pointer(110, 110))
    expect(pressed).toEqual([])
  })

  it('when buttons cannot be pressed now (Claude is off), a click selects the button', () => {
    const { editor, tool, pointer, pressed, button } = setup({ canPress: () => false })
    tool.onPointerDown(pointer(110, 110))
    tool.onPointerUp(pointer(110, 110))
    expect(pressed).toEqual([])
    expect([...editor.session.get().selectedIds]).toEqual([button.id])
  })

  it('Shift+click selects the button without pressing it', () => {
    const { editor, tool, pointer, pressed, button } = setup()
    tool.onPointerDown(pointer(110, 110, { shiftKey: true }))
    tool.onPointerUp(pointer(110, 110, { shiftKey: true }))
    expect(pressed).toEqual([])
    expect([...editor.session.get().selectedIds]).toEqual([button.id])
  })

  it('without a press handler, a button is selected like any other node', () => {
    const { editor, tool, pointer, button } = setup({ press: false })
    tool.onPointerDown(pointer(110, 110))
    tool.onPointerUp(pointer(110, 110))
    expect([...editor.session.get().selectedIds]).toEqual([button.id])
  })
})

describe('ButtonTool', () => {
  it('creates a button centered on the click and edits its label', () => {
    const { editor, ctx, pointer, edited } = setup()
    const tool = new ButtonTool(ctx)
    tool.onPointerDown(pointer(300, 300))
    tool.onPointerUp()
    const created = [...editor.store.values()].filter((n): n is NodeRecord<ButtonProps> => n.typeName === 'node' && n.type === 'button' && n.x !== 100)
    expect(created).toHaveLength(1)
    const box = editor.index.get(created[0].id)!.worldBounds
    expect(box.x + box.w / 2).toBeCloseTo(300)
    expect(box.y + box.h / 2).toBeCloseTo(300)
    expect(edited).toEqual([created[0].id])
    expect(editor.session.get().toolId).toBe('select')
  })
})
