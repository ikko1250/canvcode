// Browser-level regression fixture: real CanvasView, DocumentEditor and CodeMirror,
// with only the network-backed file storage replaced by an in-memory source.
import { CanvasView, Editor, Workspace, type FileManager } from '@canvcode/canvas'
import { builtinNodeTypes, createCodeCardType } from '@canvcode/nodes'
import { createMarkdownCardType } from '@canvcode/nodes/markdown'

const params = new URLSearchParams(location.search)
const kind = params.get('kind') === 'markdown' ? 'markdown' : 'code'
const sizing = params.get('sizing') === 'fixed' ? 'fixed' : 'auto'
const long = params.get('long') !== '0'
const text = long ? Array.from({ length: 90 }, (_, i) => `${i + 1}: a long line of text for canvas scrolling`).join('\n') : 'one line'
const fileId = 'file:input-test'
const content = { text, version: '1' }
const listeners = new Set<(id: string) => void>()
const files = {
  get: () => content,
  text: async () => content.text,
  edit: (_id: string, value: string) => {
    content.text = value
    content.version = String(Number(content.version) + 1)
    for (const listener of listeners) listener(fileId)
  },
  flush: async () => {},
  onChange: (listener: (id: string) => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
} as unknown as FileManager
const workspace = new Workspace({
  rootCanvasId: 'canvas:input-test',
  types: [
    ...builtinNodeTypes,
    createMarkdownCardType({ embedCss: async () => '', measureCss: '' }),
    createCodeCardType({ files }),
  ],
})
workspace.applyServerFile({
  id: fileId, kind, title: 'Input test', path: kind === 'code' ? 'test.py' : 'test.md',
  size: content.text.length, mtime: 0, hash: 'test', missing: false,
})
const editor = new Editor({ workspace })
const cardId = editor.createFileCard(fileId, { x: 80, y: 70 })!
const node = editor.getNode(cardId)!
editor.transact('input fixture', (tx) => tx.put({ ...node, x: 80, y: 70, props: { ...node.props, w: 440, h: 280, sizing } }))
const container = document.querySelector<HTMLElement>('#canvas')!
const view = new CanvasView(editor, container, { files })
// Retain the actual event path for diagnosing a failed browser assertion.
const events: Array<{ type: string; target: string; reachedRoot: boolean; prevented: boolean }> = []
document.addEventListener('wheel', (event) => {
  const record = { type: 'wheel', target: (event.target as Element).className?.toString() ?? '', reachedRoot: false, prevented: false }
  events.push(record)
}, true)
view.root.addEventListener('wheel', (event) => {
  if (events.at(-1)) {
    events.at(-1)!.reachedRoot = true
    events.at(-1)!.prevented = event.defaultPrevented
  }
})

interface Fixture {
  editor: Editor
  view: CanvasView
  cardId: string
  events: typeof events
  start(): Promise<boolean>
  setSizing(value: 'auto' | 'fixed'): void
  setText(value: string): void
  resetCamera(): void
}
const fixture: Fixture = {
  editor, view, cardId, events,
  start: () => view.documentEditor!.start(cardId),
  setSizing(value) {
    const current = editor.getNode(cardId)!
    editor.transact('resize fixture', (tx) => tx.put({ ...current, props: { ...current.props, sizing: value } }))
  },
  setText: (value) => files.edit(fileId, value),
  resetCamera: () => view.setCamera({ x: 0, y: 0, zoom: 1 }),
}
Object.assign(window, { canvasInputFixture: fixture })
