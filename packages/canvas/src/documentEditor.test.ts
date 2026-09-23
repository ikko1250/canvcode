import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from './editor.ts'
import { DocumentEditor } from './documentEditor.ts'
import type { FileManager } from './files.ts'

const { createCodeEditorMock } = vi.hoisted(() => ({ createCodeEditorMock: vi.fn() }))

vi.mock('./codeEditor.ts', () => ({ createCodeEditor: createCodeEditorMock }))

class FakeElement {
  style: Record<string, string> = {}
  className = ''
  textContent = ''
  title = ''
  parent: FakeElement | null = null
  children: FakeElement[] = []
  private readonly listeners = new Map<string, Array<(event: Event) => void>>()

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (!listener) return
    const callbacks = this.listeners.get(type) ?? []
    callbacks.push(typeof listener === 'function' ? listener : (event) => listener.handleEvent(event))
    this.listeners.set(type, callbacks)
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) this.appendChild(node)
  }

  appendChild<T extends FakeElement>(node: T): T {
    node.parent = this
    this.children.push(node)
    return node
  }

  remove(): void {
    if (!this.parent) return
    this.parent.children = this.parent.children.filter((child) => child !== this)
    this.parent = null
  }

  dispatchWheel(event: FakeWheelEvent): void {
    this.dispatch('wheel', event)
  }

  dispatchPointerDown(event: FakePointerEvent): void {
    this.dispatch('pointerdown', event)
  }

  private dispatch(type: string, event: FakeWheelEvent | FakePointerEvent): void {
    let current: FakeElement | null = this
    event.target = this as unknown as EventTarget
    while (current) {
      event.currentTarget = current as unknown as EventTarget
      for (const listener of current.listeners.get(type) ?? []) listener(event as unknown as Event)
      if (event.propagationStopped) return
      current = current.parent
    }
  }
}

class FakeWheelEvent {
  readonly type = 'wheel'
  readonly bubbles = true
  readonly cancelable = true
  readonly deltaX = 0
  readonly deltaY = 120
  readonly deltaMode = 0
  target: EventTarget | null = null
  currentTarget: EventTarget | null = null
  defaultPrevented = false
  propagationStopped = false
  readonly preventedAt: EventTarget[] = []
  readonly ctrlKey: boolean
  readonly metaKey: boolean

  constructor(ctrlKey = false, metaKey = false) {
    this.ctrlKey = ctrlKey
    this.metaKey = metaKey
  }

  preventDefault(): void {
    this.defaultPrevented = true
    if (this.currentTarget) this.preventedAt.push(this.currentTarget)
  }

  stopPropagation(): void {
    this.propagationStopped = true
  }
}

class FakePointerEvent {
  readonly type = 'pointerdown'
  target: EventTarget | null = null
  currentTarget: EventTarget | null = null
  propagationStopped = false
  readonly button: number

  constructor(button: number) {
    this.button = button
  }

  stopPropagation(): void {
    this.propagationStopped = true
  }
}

function createDocumentEditor(sizing: 'auto' | 'fixed', isSpaceHeld: () => boolean = () => false) {
  const node = { id: 'card:1', type: 'code-card', props: { sizing } }
  const editor = {
    getNode: () => node,
    setSelection: vi.fn(),
    workspace: {
      referenceOf: () => ({ targetId: 'file:1' }),
      getFile: () => ({ kind: 'code', title: 'sample.py' }),
      targetStatus: () => 'ok',
    },
    index: {
      get: () => ({
        localBounds: { w: 500, h: 320 },
        worldMatrix: { a: 1, b: 0, c: 0, d: 1, e: 20, f: 30 },
      }),
    },
    session: { get: () => ({ camera: { x: 0, y: 0, zoom: 1 } }) },
  } as unknown as Editor
  const files = {
    text: vi.fn(async () => 'print(1)'),
    onChange: vi.fn(() => () => {}),
    edit: vi.fn(),
    flush: vi.fn(async () => {}),
  } as unknown as FileManager
  const root = new FakeElement()
  const layer = new FakeElement()
  root.appendChild(layer)
  const editorViewDom = new FakeElement()
  const scrollDOM = new FakeElement()
  editorViewDom.appendChild(scrollDOM)
  const codeEditor = {
    view: { dom: editorViewDom, scrollDOM },
    text: () => 'print(1)',
    replace: vi.fn(),
    selectedQuote: () => null,
    focus: vi.fn(),
    destroy: vi.fn(),
  }

  createCodeEditorMock.mockImplementation(({ parent }: { parent: FakeElement }) => {
    parent.appendChild(editorViewDom)
    return codeEditor
  })
  const canvasPointerEvents: Event[] = []
  root.addEventListener('pointerdown', (event) => canvasPointerEvents.push(event))
  const canvasWheelEvents: Event[] = []
  root.addEventListener('wheel', (event) => {
    canvasWheelEvents.push(event)
    event.preventDefault()
  })
  const documentEditor = new DocumentEditor({
    getEditor: () => editor,
    layer: layer as unknown as HTMLElement,
    files,
    isSpaceHeld,
    onChange: () => {},
    onFullscreen: () => {},
  })

  return { documentEditor, layer, scrollDOM, editorViewDom, canvasWheelEvents, canvasPointerEvents }
}

beforeEach(() => {
  vi.stubGlobal('document', { createElement: () => new FakeElement() })
})

afterEach(() => {
  vi.unstubAllGlobals()
  createCodeEditorMock.mockReset()
})

describe('DocumentEditor host layout', () => {
  // 枠を border で描くと中身が 2px 内側へずれる。outline なら中身の位置は変わらない（MAI-55）
  it('frames the host with an outline instead of a border and keeps the header at the card header height', async () => {
    const { documentEditor, layer } = createDocumentEditor('auto')
    await documentEditor.start('card:1')

    const host = layer.children[0]
    expect(host.style.border).toBeUndefined()
    expect(host.style.outline).toBe('2px solid #2f6fed')
    expect(host.style.transform).toBe('matrix(1, 0, 0, 1, 20, 30)')
    expect(host.style.width).toBe('500px')

    const header = host.children[0]
    expect(header.style.height).toBe('36px')
    expect(header.style.boxSizing).toBe('border-box')
    documentEditor.finish()
  })
})

describe('DocumentEditor pointer handling', () => {
  it('passes middle-button and Space+left-button drags to the canvas without passing ordinary clicks', async () => {
    let spaceHeld = false
    const { documentEditor, scrollDOM, canvasPointerEvents } = createDocumentEditor('auto', () => spaceHeld)
    await documentEditor.start('card:1')

    scrollDOM.dispatchPointerDown(new FakePointerEvent(0))
    expect(canvasPointerEvents).toHaveLength(0)

    scrollDOM.dispatchPointerDown(new FakePointerEvent(1))
    expect(canvasPointerEvents).toHaveLength(1)
    expect(documentEditor.editingId).toBe('card:1')

    spaceHeld = true
    scrollDOM.dispatchPointerDown(new FakePointerEvent(0))
    expect(canvasPointerEvents).toHaveLength(2)
    expect(documentEditor.editingId).toBe('card:1')
    documentEditor.finish()
  })
})

describe('DocumentEditor wheel handling', () => {
  it('lets ordinary wheel input from an auto-height card reach the canvas', async () => {
    const { documentEditor, layer, scrollDOM, editorViewDom, canvasWheelEvents } = createDocumentEditor('auto')
    await documentEditor.start('card:1')

    const event = new FakeWheelEvent()
    scrollDOM.dispatchWheel(event)

    expect(layer.children).toHaveLength(1)
    expect(scrollDOM.style.overflow).toBe('visible')
    expect(editorViewDom.style.height).toBe('auto')
    expect(event.propagationStopped).toBe(false)
    expect(event.preventedAt[0]).toBe(layer.children[0] as unknown as EventTarget)
    expect(event.defaultPrevented).toBe(true)
    expect(canvasWheelEvents).toHaveLength(1)
    documentEditor.finish()
  })

  it('keeps ordinary wheel input inside a fixed-height card but lets zoom reach the canvas', async () => {
    const { documentEditor, scrollDOM, canvasWheelEvents } = createDocumentEditor('fixed')
    await documentEditor.start('card:1')

    const ordinary = new FakeWheelEvent()
    scrollDOM.dispatchWheel(ordinary)
    expect(ordinary.propagationStopped).toBe(true)
    expect(ordinary.defaultPrevented).toBe(false)
    expect(scrollDOM.style.overflow).toBe('')

    const zoom = new FakeWheelEvent(true)
    scrollDOM.dispatchWheel(zoom)
    expect(zoom.propagationStopped).toBe(false)
    expect(zoom.defaultPrevented).toBe(true)
    expect(canvasWheelEvents).toHaveLength(1)
    documentEditor.finish()
  })
})
