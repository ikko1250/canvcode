import { describe, expect, it } from 'vitest'
import type { NodeRecord } from '@canvcode/core'
import { NOTE_DEFAULT_FONT_SIZE, TEXT_DEFAULT_FONT_SIZE, TITLE_FONT_SIZE, textLayout, type NoteProps, type TextProps } from '@canvcode/nodes'
import { Editor } from './editor.ts'
import { NoteTool, TextTool, type ToolContext, type ToolPointer } from './tools.ts'

// テキスト・タイトル・付箋の初期の大きさ（MAI-62）

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
    moveToCanvas: () => {},
  }
  const pointer = (x: number, y: number): ToolPointer => ({
    screen: { x, y },
    world: { x, y },
    button: 0,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
  })
  const nodes = <P extends object>(type: string) => [...editor.store.values()].filter((n) => n.typeName === 'node' && n.type === type) as NodeRecord<P>[]
  return { ctx, pointer, nodes }
}

describe('text and title tools (MAI-62)', () => {
  it('creates text at the default size of 12', () => {
    const { ctx, pointer, nodes } = setup()
    const tool = new TextTool(ctx)
    expect(tool.id).toBe('text')
    tool.onPointerDown(pointer(100, 100))
    tool.onPointerUp()
    const [text] = nodes<TextProps>('text')
    expect(TEXT_DEFAULT_FONT_SIZE).toBe(12)
    expect(text.props.fontSize).toBe(12)
  })

  it('creates a title as a plain text node at 22, with the click point in the middle of the first line', () => {
    const { ctx, pointer, nodes } = setup()
    const tool = new TextTool(ctx, 'title')
    expect(tool.id).toBe('title')
    tool.onPointerDown(pointer(100, 100))
    tool.onPointerUp()
    const [title] = nodes<TextProps>('text')
    expect(TITLE_FONT_SIZE).toBe(22)
    expect(title.props.fontSize).toBe(22)
    // 行の高さ（22 × 1.35）の半分だけ上に置く
    expect(title.y).toBeCloseTo(100 - (22 * 1.35) / 2)
    expect(textLayout(title.props).lineHeightPx).toBeCloseTo(22 * 1.35)
  })

  it('creates notes at the default size of 12', () => {
    const { ctx, pointer, nodes } = setup()
    const tool = new NoteTool(ctx)
    tool.onPointerDown(pointer(100, 100))
    tool.onPointerUp()
    const [note] = nodes<NoteProps>('note')
    expect(NOTE_DEFAULT_FONT_SIZE).toBe(12)
    expect(note.props.fontSize).toBe(12)
  })
})
