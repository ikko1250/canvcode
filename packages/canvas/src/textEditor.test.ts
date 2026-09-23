import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TextProps } from '@canvcode/nodes'
import { Editor } from './editor.ts'
import { TextEditor } from './textEditor.ts'

// 編集用の textarea の代わり（Node には DOM がない）。スタイルと値、フォーカスの有無だけ持つ
class FakeTextarea {
  style: Record<string, string> = {}
  value = ''
  spellcheck = true
  focused = false
  parent: FakeElement | null = null
  private readonly listeners = new Map<string, Array<(event: Event) => void>>()

  setAttribute(): void {}

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (!listener) return
    const callbacks = this.listeners.get(type) ?? []
    callbacks.push(typeof listener === 'function' ? listener : (event) => listener.handleEvent(event))
    this.listeners.set(type, callbacks)
  }

  dispatch(type: string, event: Partial<Event> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ type, ...event } as Event)
  }

  focus(): void {
    this.focused = true
  }

  select(): void {}

  setSelectionRange(): void {}

  remove(): void {
    this.parent?.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = null
  }
}

class FakeElement {
  children: FakeTextarea[] = []

  appendChild(node: FakeTextarea): FakeTextarea {
    node.parent = this
    this.children.push(node)
    return node
  }
}

function createTextEditor() {
  const editor = new Editor()
  const layer = new FakeElement()
  const textEditor = new TextEditor({
    getEditor: () => editor,
    layer: layer as unknown as HTMLElement,
    getDpr: () => 1,
    onChange: () => {},
  })
  return { editor, layer, textEditor }
}

describe('text editor', () => {
  const originalDocument = globalThis.document

  beforeEach(() => {
    // 文字幅の計測は canvas を作ろうとする。取れなければ概算する（layout.ts）ので、null を返す
    globalThis.document = {
      createElement: (tag: string) => (tag === 'canvas' ? { getContext: () => null } : new FakeTextarea()),
    } as unknown as Document
  })

  afterEach(() => {
    globalThis.document = originalDocument
  })

  it('changes the font size of the node being edited without ending the edit (MAI-52)', () => {
    const { editor, layer, textEditor } = createTextEditor()
    const text = editor.makeNode('text', { x: 0, y: 0, props: { text: 'hello', fontSize: 16 } })
    editor.createNodes([text])
    expect(textEditor.start(text.id)).toBe(true)
    const textarea = layer.children[0]!
    expect(textarea.focused).toBe(true)
    expect(textarea.style.font).toContain('16px')

    // 編集のトランザクションが開いたままなので、ほかから transact で変えることはできない（パレットが効かなかった原因）
    expect(() => editor.transact('text style', () => {})).toThrow(/still open/)

    const changed = textEditor.updateNode((node) => ({ ...node, props: { ...node.props, fontSize: 24 } }))
    expect(changed).toBe(true)
    // ノードにも textarea にもすぐ反映され、編集は続いている
    expect((editor.getNode(text.id)!.props as TextProps).fontSize).toBe(24)
    expect(textarea.style.font).toContain('24px')
    expect(textEditor.editingId).toBe(text.id)
    expect(layer.children).toEqual([textarea])
    expect(editor.store.activeTransaction).not.toBeNull()

    // そのあと打った文字も、変えた大きさも、終えたときに残る
    textarea.value = 'hello world'
    textarea.dispatch('input')
    textEditor.finish()
    expect(textEditor.editingId).toBeNull()
    expect(editor.store.activeTransaction).toBeNull()
    const props = editor.getNode(text.id)!.props as TextProps
    expect(props.text).toBe('hello world')
    expect(props.fontSize).toBe(24)

    // 文字の編集と大きさの変更は、まとめて 1 回の Undo になる
    expect(editor.undo()).toBe(true)
    const reverted = editor.getNode(text.id)!.props as TextProps
    expect(reverted.text).toBe('hello')
    expect(reverted.fontSize).toBe(16)
  })

  it('applies to sticky notes as well and does nothing when not editing', () => {
    const { editor, textEditor } = createTextEditor()
    const note = editor.makeNode('note', { x: 0, y: 0, props: { text: 'memo' } })
    editor.createNodes([note])
    expect(textEditor.updateNode((node) => ({ ...node, props: { ...node.props, fontSize: 32 } }))).toBe(false)

    textEditor.start(note.id)
    expect(textEditor.updateNode((node) => ({ ...node, props: { ...node.props, fontSize: 32 } }))).toBe(true)
    expect((editor.getNode(note.id)!.props as { fontSize: number }).fontSize).toBe(32)
    textEditor.finish()
    expect((editor.getNode(note.id)!.props as { fontSize: number }).fontSize).toBe(32)
  })
})
