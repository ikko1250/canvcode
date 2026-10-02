// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { plainTextOf, richTextFromPlain, type NoteProps, type TextParagraph, type TextProps } from '@canvcode/nodes'
import { Editor } from './editor.ts'
import { KEEP_TEXT_EDITING_ATTRIBUTE, TextEditor } from './textEditor.ts'
import { TEXT_CLIPBOARD_MIME } from './textClipboard.ts'

// 文字の編集モード。jsdom の DOM で、編集用の要素（contenteditable）を動かす。
// jsdom には Canvas がないので、文字幅は概算で測る（layout.ts）

function setup() {
  const editor = new Editor()
  const layer = document.createElement('div')
  document.body.append(layer)
  const textEditor = new TextEditor({ getEditor: () => editor, layer, getDpr: () => 1, onChange: () => {} })
  return { editor, layer, textEditor }
}

function makeText(editor: Editor, text: string | TextParagraph[], props: Partial<TextProps> = {}) {
  const paragraphs = typeof text === 'string' ? richTextFromPlain(text) : text
  const node = editor.makeNode('text', { x: 0, y: 0, props: { ...props, paragraphs } })
  editor.createNodes([node])
  return node
}

const propsOf = (editor: Editor, id: string) => editor.getNode(id)!.props as TextProps

function editingElement(layer: HTMLElement): HTMLDivElement {
  return layer.querySelector('[contenteditable]') as HTMLDivElement
}

// 文字の位置 offset にある DOM の点（書き出した形の DOM。段落の div の中の span の文字）
function textNodes(element: HTMLElement): Text[] {
  const out: Text[] = []
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) out.push(node as Text)
  return out
}

function setCaret(node: Node, offset: number, focusNode: Node = node, focusOffset = offset) {
  window.getSelection()!.setBaseAndExtent(node, offset, focusNode, focusOffset)
}

// ブラウザが文字を打ったのと同じように、テキストノードを変えて input を送る
function typeInto(element: HTMLElement, text: Text, offset: number, value: string) {
  const before = new InputEvent('beforeinput', { inputType: 'insertText', data: value, cancelable: true })
  setCaret(text, offset)
  element.dispatchEvent(before)
  if (before.defaultPrevented) return
  text.insertData(offset, value)
  setCaret(text, offset + value.length)
  element.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: value }))
}

function beforeInput(element: HTMLElement, inputType: string, data: string | null = null): InputEvent {
  const event = new InputEvent('beforeinput', { inputType, data, cancelable: true })
  element.dispatchEvent(event)
  return event
}

function clipboardEvent(type: 'copy' | 'cut' | 'paste', data: Record<string, string> = {}) {
  const event = new Event(type, { cancelable: true, bubbles: true }) as ClipboardEvent
  const store = { ...data }
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (mime: string) => store[mime] ?? '', setData: (mime: string, value: string) => void (store[mime] = value) },
  })
  return { event, store }
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('text editor', () => {
  it('changes the font size of the node being edited without ending the edit (MAI-52)', () => {
    const { editor, layer, textEditor } = setup()
    const text = makeText(editor, 'hello', { fontSize: 16 })
    expect(textEditor.start(text.id)).toBe(true)
    const element = editingElement(layer)
    expect(document.activeElement).toBe(element)
    expect(element.style.font).toContain('16px')

    // 編集のトランザクションが開いたままなので、ほかから transact で変えることはできない（パレットが効かなかった原因）
    expect(() => editor.transact('text style', () => {})).toThrow(/still open/)

    const changed = textEditor.updateNode((node) => ({ ...node, props: { ...node.props, fontSize: 24 } }))
    expect(changed).toBe(true)
    // ノードにも編集用の要素にもすぐ反映され、編集は続いている
    expect(propsOf(editor, text.id).fontSize).toBe(24)
    expect(element.style.font).toContain('24px')
    expect(textEditor.editingId).toBe(text.id)
    expect(editingElement(layer)).toBe(element)
    expect(editor.store.activeTransaction).not.toBeNull()

    // そのあと打った文字も、変えた大きさも、終えたときに残る
    typeInto(element, textNodes(element)[0], 5, ' world')
    textEditor.finish()
    expect(textEditor.editingId).toBeNull()
    expect(editor.store.activeTransaction).toBeNull()
    expect(plainTextOf(propsOf(editor, text.id).paragraphs)).toBe('hello world')
    expect(propsOf(editor, text.id).fontSize).toBe(24)

    // 文字の編集と大きさの変更は、まとめて 1 回の Undo になる
    expect(editor.undo()).toBe(true)
    expect(plainTextOf(propsOf(editor, text.id).paragraphs)).toBe('hello')
    expect(propsOf(editor, text.id).fontSize).toBe(16)
  })

  it('applies to sticky notes as well and does nothing when not editing', () => {
    const { editor, textEditor } = setup()
    const note = editor.makeNode('note', { x: 0, y: 0, props: { paragraphs: richTextFromPlain('memo') } })
    editor.createNodes([note])
    expect(textEditor.updateNode((node) => ({ ...node, props: { ...node.props, fontSize: 32 } }))).toBe(false)

    textEditor.start(note.id)
    expect(textEditor.updateNode((node) => ({ ...node, props: { ...node.props, fontSize: 32 } }))).toBe(true)
    expect((editor.getNode(note.id)!.props as NoteProps).fontSize).toBe(32)
    textEditor.finish()
    expect((editor.getNode(note.id)!.props as NoteProps).fontSize).toBe(32)
  })

  it('keeps editing when another app takes the window focus, and restores the caret on return (MAI-70)', () => {
    const { editor, layer, textEditor } = setup()
    const text = makeText(editor, 'hello world', { fontSize: 16 })
    textEditor.start(text.id)
    const element = editingElement(layer)
    const [node] = textNodes(element)
    setCaret(node, 2, node, 5)
    document.dispatchEvent(new Event('selectionchange'))

    // 窓ごとフォーカスを失った（Shift+Space で別アプリの窓が出た）
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    element.blur()
    expect(textEditor.editingId).toBe(text.id)
    expect(editingElement(layer)).toBe(element)
    expect(editor.store.activeTransaction).not.toBeNull()

    // 窓に戻ると、フォーカスとカーソルが戻る
    window.dispatchEvent(new Event('focus'))
    expect(document.activeElement).toBe(element)
    const selection = window.getSelection()!
    expect([selection.anchorOffset, selection.focusOffset]).toEqual([2, 5])
    expect(textEditor.selectedRange()).toEqual({ start: 2, end: 5 })
    expect(textEditor.editingId).toBe(text.id)

    textEditor.finish()
    expect(textEditor.editingId).toBeNull()
  })

  it('ends editing when focus moves within the page', () => {
    const { editor, layer, textEditor } = setup()
    const text = makeText(editor, 'hello', { fontSize: 16 })
    textEditor.start(text.id)
    const element = editingElement(layer)

    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    element.blur()
    expect(textEditor.editingId).toBeNull()
    expect(layer.children).toHaveLength(0)
    expect(editor.store.activeTransaction).toBeNull()
  })

  it('stops waiting for the window focus once editing ends another way', () => {
    const { editor, layer, textEditor } = setup()
    const text = makeText(editor, 'hello', { fontSize: 16 })
    textEditor.start(text.id)
    const element = editingElement(layer)

    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    element.blur()
    expect(() => textEditor.finish()).not.toThrow()
    expect(textEditor.editingId).toBeNull()

    // あとで窓に戻っても何もしない
    expect(() => window.dispatchEvent(new Event('focus'))).not.toThrow()
    expect(document.activeElement).not.toBe(element)
    expect(textEditor.editingId).toBeNull()
  })

  it('deletes an empty text when editing ends', () => {
    const { editor, textEditor } = setup()
    const text = makeText(editor, '')
    textEditor.start(text.id)
    textEditor.finish()
    expect(editor.getNode(text.id)).toBeUndefined()
  })
})

describe('rich text editing (MAI-74)', () => {
  it('formats the selected range and shows it with spans', () => {
    const { editor, layer, textEditor } = setup()
    const text = makeText(editor, 'hello world', { fontSize: 16, color: '#000000' })
    textEditor.start(text.id)
    const element = editingElement(layer)
    const [node] = textNodes(element)
    setCaret(node, 6, node, 11)
    expect(textEditor.selectedRange()).toEqual({ start: 6, end: 11 })

    expect(textEditor.formatRange({ color: '#ff0000', fontSize: 32 })).toBe(true)
    expect(propsOf(editor, text.id).paragraphs).toEqual([
      { runs: [{ text: 'hello ' }, { text: 'world', format: { color: '#ff0000', fontSize: 32 } }] },
    ])
    const spans = element.querySelectorAll('span')
    expect([...spans].map((s) => s.textContent)).toEqual(['hello ', 'world'])
    expect(spans[1].style.fontSize).toBe('32px')
    expect(spans[1].style.color).toBe('rgb(255, 0, 0)')
    // 範囲はそのまま
    expect(textEditor.selectedRange()).toEqual({ start: 6, end: 11 })

    // 既定と同じ値に戻すと、範囲ごとの値は持たない
    textEditor.formatRange({ color: '#000000', fontSize: undefined })
    expect(propsOf(editor, text.id).paragraphs).toEqual([{ runs: [{ text: 'hello world' }] }])
    textEditor.finish()
  })

  it('continues the format of the previous character when typing, and reads it back from the DOM', () => {
    const { editor, layer, textEditor } = setup()
    const red = { color: '#ff0000' }
    const text = makeText(editor, [{ runs: [{ text: 'ab', format: red }, { text: 'cd' }] }])
    textEditor.start(text.id)
    const element = editingElement(layer)
    // カーソルは run の境目では前の run の終わりに置く
    const [ab] = textNodes(element)
    typeInto(element, ab, 2, 'X')
    expect(propsOf(editor, text.id).paragraphs).toEqual([{ runs: [{ text: 'abX', format: red }, { text: 'cd' }] }])
    textEditor.finish()
  })

  it('splits a paragraph on Enter, carrying the format into the new paragraph', () => {
    const { editor, layer, textEditor } = setup()
    const red = { color: '#ff0000' }
    const text = makeText(editor, [{ runs: [{ text: 'red', format: red }] }])
    textEditor.start(text.id)
    const element = editingElement(layer)
    expect(beforeInput(element, 'insertParagraph').defaultPrevented).toBe(true)
    expect(propsOf(editor, text.id).paragraphs).toEqual([{ runs: [{ text: 'red', format: red }] }, { runs: [{ text: '', format: red }] }])
    // 空の段落は <br> を持ち、div に書式がある。そこに打った文字は、その書式になる
    const empty = element.children[1] as HTMLElement
    expect(empty.querySelector('br')).not.toBeNull()
    empty.replaceChildren(document.createTextNode('next'))
    setCaret(empty.firstChild!, 4)
    element.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'next' }))
    expect(propsOf(editor, text.id).paragraphs).toEqual([{ runs: [{ text: 'red', format: red }] }, { runs: [{ text: 'next', format: red }] }])
    // 書き出した形に整える
    expect(element.children[1].querySelector('span')?.textContent).toBe('next')

    // 段落の頭での Backspace は、段落をつなぐ
    setCaret(textNodes(element)[1], 0)
    expect(beforeInput(element, 'deleteContentBackward').defaultPrevented).toBe(true)
    expect(propsOf(editor, text.id).paragraphs).toEqual([{ runs: [{ text: 'rednext', format: red }] }])
    textEditor.finish()
  })

  it('replaces a selected range with typed text in the format of its first character', () => {
    const { editor, layer, textEditor } = setup()
    const red = { color: '#ff0000' }
    const text = makeText(editor, [{ runs: [{ text: 'ab' }, { text: 'cd', format: red }] }, { runs: [{ text: 'ef' }] }])
    textEditor.start(text.id)
    const element = editingElement(layer)
    const nodes = textNodes(element)
    setCaret(nodes[1], 0, nodes[2], 1)
    expect(beforeInput(element, 'insertText', 'Z').defaultPrevented).toBe(true)
    expect(propsOf(editor, text.id).paragraphs).toEqual([{ runs: [{ text: 'ab' }, { text: 'Z', format: red }, { text: 'f' }] }])
    expect(textEditor.selectedRange()).toBeNull()
    textEditor.finish()
  })

  it('does not rewrite the DOM while composing with an IME, and tidies it up afterwards', () => {
    const { editor, layer, textEditor } = setup()
    const text = makeText(editor, '')
    textEditor.start(text.id)
    const element = editingElement(layer)
    element.dispatchEvent(new CompositionEvent('compositionstart'))
    // 変換中：ブラウザが空の段落に文字を入れる（<br> は消える）
    const paragraph = element.children[0] as HTMLElement
    const composing = document.createTextNode('にほん')
    paragraph.replaceChildren(composing)
    setCaret(composing, 3)
    element.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: 'にほん', isComposing: true }))
    // ノードには入るが、DOM はそのまま（変換中のテキストノードを置き換えない）
    expect(plainTextOf(propsOf(editor, text.id).paragraphs)).toBe('にほん')
    expect(paragraph.firstChild).toBe(composing)

    composing.data = '日本'
    setCaret(composing, 2)
    element.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: '日本', isComposing: true }))
    element.dispatchEvent(new CompositionEvent('compositionend', { data: '日本' }))
    expect(plainTextOf(propsOf(editor, text.id).paragraphs)).toBe('日本')
    expect(element.children[0].querySelector('span')?.textContent).toBe('日本')
    expect(textEditor.selectedRange()).toBeNull()
    textEditor.finish()
    expect(plainTextOf(propsOf(editor, text.id).paragraphs)).toBe('日本')
  })

  it('copies and pastes text with its formats', () => {
    const { editor, layer, textEditor } = setup()
    const text = makeText(editor, [{ runs: [{ text: 'big', format: { fontSize: 40 } }, { text: ' red', format: { color: '#ff0000' } }] }], {
      fontSize: 16,
      color: '#000000',
    })
    textEditor.start(text.id)
    const element = editingElement(layer)
    const nodes = textNodes(element)
    setCaret(nodes[0], 1, nodes[1], 2)
    const copy = clipboardEvent('copy')
    element.dispatchEvent(copy.event)
    expect(copy.event.defaultPrevented).toBe(true)
    expect(copy.store['text/plain']).toBe('ig r')
    expect(copy.store[TEXT_CLIPBOARD_MIME]).toBeTruthy()
    expect(copy.store['text/html']).toContain('font-size: 40px')
    textEditor.finish()

    // 既定の違う別のテキストに貼る：見た目（実際の値）が同じになるように書式を持つ
    const other = makeText(editor, 'x', { fontSize: 40, color: '#00ff00' })
    textEditor.start(other.id)
    const otherElement = editingElement(layer)
    setCaret(textNodes(otherElement)[0], 1)
    const paste = clipboardEvent('paste', copy.store)
    otherElement.dispatchEvent(paste.event)
    expect(paste.event.defaultPrevented).toBe(true)
    expect(propsOf(editor, other.id).paragraphs).toEqual([
      {
        runs: [
          { text: 'x' },
          { text: 'ig', format: { color: '#000000' } },
          { text: ' r', format: { color: '#ff0000', fontSize: 16 } },
        ],
      },
    ])
    textEditor.finish()
  })

  it('pastes plain text in the format at the caret, and cuts the selection', () => {
    const { editor, layer, textEditor } = setup()
    const red = { color: '#ff0000' }
    const text = makeText(editor, [{ runs: [{ text: 'ab', format: red }, { text: 'cd' }] }])
    textEditor.start(text.id)
    const element = editingElement(layer)
    setCaret(textNodes(element)[0], 2)
    element.dispatchEvent(clipboardEvent('paste', { 'text/plain': '1\n2' }).event)
    expect(propsOf(editor, text.id).paragraphs).toEqual([{ runs: [{ text: 'ab1', format: red }] }, { runs: [{ text: '2', format: red }, { text: 'cd' }] }])

    const nodes = textNodes(element)
    setCaret(nodes[0], 0, nodes[0], 2)
    const cut = clipboardEvent('cut')
    element.dispatchEvent(cut.event)
    expect(cut.store['text/plain']).toBe('ab')
    expect(plainTextOf(propsOf(editor, text.id).paragraphs)).toBe('1\n2cd')
    textEditor.finish()
  })

  it('undoes and redoes edits made while editing', () => {
    const { editor, layer, textEditor } = setup()
    const text = makeText(editor, 'ab')
    textEditor.start(text.id)
    const element = editingElement(layer)
    beforeInput(element, 'insertParagraph')
    expect(plainTextOf(propsOf(editor, text.id).paragraphs)).toBe('ab\n')
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, cancelable: true }))
    expect(plainTextOf(propsOf(editor, text.id).paragraphs)).toBe('ab')
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, cancelable: true }))
    expect(plainTextOf(propsOf(editor, text.id).paragraphs)).toBe('ab\n')
    textEditor.finish()
  })

  it('keeps editing while the focus is in the design panel, and formats the remembered range', () => {
    const { editor, layer, textEditor } = setup()
    const text = makeText(editor, 'hello world', { color: '#000000' })
    const panel = document.createElement('aside')
    panel.setAttribute(KEEP_TEXT_EDITING_ATTRIBUTE, '')
    const input = document.createElement('input')
    panel.append(input)
    document.body.append(panel)
    const outside = document.createElement('input')
    document.body.append(outside)

    textEditor.start(text.id)
    const element = editingElement(layer)
    const [node] = textNodes(element)
    setCaret(node, 0, node, 5)
    document.dispatchEvent(new Event('selectionchange'))
    const listener = vi.fn()
    textEditor.subscribeSelection(listener)

    input.focus()
    expect(textEditor.editingId).toBe(text.id)
    expect(textEditor.selectedRange()).toEqual({ start: 0, end: 5 })
    expect(textEditor.getSelectionSnapshot()).toEqual({ nodeId: text.id, start: 0, end: 5 })
    // パネルからの変更（updateNode）は、覚えている範囲に当てられる
    textEditor.formatRange({ color: '#ff0000' })
    expect(propsOf(editor, text.id).paragraphs).toEqual([{ runs: [{ text: 'hello', format: { color: '#ff0000' } }, { text: ' world' }] }])

    // 値を入れ終えたら、文字にフォーカスと範囲を戻す
    expect(textEditor.focus()).toBe(true)
    expect(document.activeElement).toBe(element)
    expect(textEditor.selectedRange()).toEqual({ start: 0, end: 5 })

    // パネルの外にフォーカスが移ったら、編集を終える
    input.focus()
    outside.focus()
    expect(textEditor.editingId).toBeNull()
    expect(listener).toHaveBeenCalled()
  })

  it('edits shape labels as plain text', () => {
    const { editor, layer, textEditor } = setup()
    const geo = editor.makeNode('geo', { x: 0, y: 0, props: { shape: 'rect', w: 100, h: 100, label: 'a' } })
    editor.createNodes([geo])
    textEditor.start(geo.id)
    const element = editingElement(layer)
    expect(textEditor.formatRange({ color: '#ff0000' }, { start: 0, end: 1 })).toBe(false)
    typeInto(element, textNodes(element)[0], 1, 'b')
    beforeInput(element, 'insertParagraph')
    textEditor.finish()
    expect((editor.getNode(geo.id)!.props as { label: string }).label).toBe('ab\n')
  })
})
