import { describe, expect, it } from 'vitest'
import { Editor, Workspace } from '@canvcode/canvas'
import { builtinNodeTypes, createCodeCardType, createSlideDeckCardType } from '@canvcode/nodes'
import { createMarkdownCardType } from '@canvcode/nodes/markdown'
import { canvasUrl, fileUrl, newTabUrl, slideEditorUrl } from './newTab.ts'

const files = { get: () => null }

function setup() {
  const workspace = new Workspace({
    rootCanvasId: 'canvas:root',
    types: [
      ...builtinNodeTypes,
      createMarkdownCardType({ embedCss: async () => '', measureCss: '' }),
      createCodeCardType({ files }),
      createSlideDeckCardType(files),
    ],
  })
  const editor = new Editor({ workspace })
  const addFile = (id: string, kind: 'markdown' | 'code' | 'slides', path: string) => {
    workspace.applyServerFile({ id, kind, title: id, path, size: 0, mtime: 0, hash: 'h', missing: false })
    return editor.getNode(editor.createFileCard(id, { x: 0, y: 0 })!)!
  }
  return { workspace, editor, addFile }
}

describe('newTabUrl', () => {
  it('Portal は参照先のキャンバスの URL', () => {
    const { workspace, editor } = setup()
    const { portalId, canvasId } = editor.createPortal({ x: 0, y: 0 })
    expect(newTabUrl(workspace, editor.getNode(portalId)!, editor.canvasId)).toBe(`/c/${encodeURIComponent(canvasId)}`)
  })

  it('Markdown・Python のカードは全画面のエディタの URL', () => {
    const { workspace, editor, addFile } = setup()
    expect(newTabUrl(workspace, addFile('file:a', 'markdown', 'a.md'), editor.canvasId)).toBe('/f/file%3Aa')
    expect(newTabUrl(workspace, addFile('file:b', 'code', 'b.py'), editor.canvasId)).toBe('/f/file%3Ab')
  })

  it('スライドのデッキは、今のキャンバスに戻るスライドエディタの URL', () => {
    const { workspace, addFile } = setup()
    const deck = addFile('file:deck', 'slides', 'deck.slides.json')
    expect(newTabUrl(workspace, deck, 'canvas:root')).toBe('/slide-editor.html?deck=file%3Adeck&back=%2Fc%2Fcanvas%253Aroot')
  })

  it('開けないもの・ほかのノードは null', () => {
    const { workspace, editor, addFile } = setup()
    const card = addFile('file:gone', 'markdown', 'gone.md')
    workspace.applyServerFile({ id: 'file:gone', kind: 'markdown', title: 'file:gone', path: 'gone.md', size: 0, mtime: 0, hash: 'h', missing: true })
    expect(newTabUrl(workspace, card, editor.canvasId)).toBeNull()
    const { portalId } = editor.createPortal({ x: 0, y: 0 })
    const portal = editor.getNode(portalId)!
    expect(newTabUrl(workspace, { ...portal, props: { ...portal.props, targetId: 'canvas:missing' } }, editor.canvasId)).toBeNull()
    expect(newTabUrl(workspace, { ...portal, type: 'note' }, editor.canvasId)).toBeNull()
  })
})

describe('URL', () => {
  it('id を URL に使える形にする', () => {
    expect(canvasUrl('canvas:a b')).toBe('/c/canvas%3Aa%20b')
    expect(fileUrl('file:x/y')).toBe('/f/file%3Ax%2Fy')
    expect(slideEditorUrl('d', '/c/r?x=1')).toBe('/slide-editor.html?deck=d&back=%2Fc%2Fr%3Fx%3D1')
  })
})
